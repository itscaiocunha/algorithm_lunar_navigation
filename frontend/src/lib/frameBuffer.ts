// Buffer de pré-carregamento da animação: separa o DOWNLOAD dos quadros da RENDERIZAÇÃO.
//
// - Cada quadro tem um índice fixo na linha do tempo e é guardado por índice: uma resposta que
//   chega fora de ordem (14 h antes de 12 h) cai no seu lugar — não há "última resposta vence".
// - Busca em ordem a partir do cursor (o que vai tocar primeiro chega primeiro), com no máximo
//   `concurrency` requisições abertas: a API não é estrangulada.
// - Janela deslizante [cursor − behind, cursor + ahead]: o que sai dela é cancelado (AbortController)
//   ou descartado da memória. Um dia lunar inteiro a 4 h são 178 quadros; só ~50 ficam na RAM.
// - Falhas são repetidas com espera crescente; depois de `maxRetries`, o quadro é marcado como falho.

export interface FrameBufferOptions<T> {
  fetchFrame: (index: number, signal: AbortSignal) => Promise<T>
  ahead: number
  behind: number
  concurrency: number
  maxRetries?: number
  retryDelayMs?: number
  onChange?: () => void
}

export class FrameBuffer<T> {
  readonly total: number
  private readonly opts: Required<FrameBufferOptions<T>>
  private readonly frames = new Map<number, T>()
  private readonly inflight = new Map<number, AbortController>()
  private readonly failures = new Map<number, number>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private cursor = 0
  private running = false

  constructor(total: number, opts: FrameBufferOptions<T>) {
    this.total = total
    this.opts = { maxRetries: 3, retryDelayMs: 500, onChange: () => undefined, ...opts }
  }

  /** Começa (ou retoma, após `stop`) a buscar quadros a partir do cursor. */
  start() {
    this.running = true
    this.pump()
  }

  /** Cancela tudo e libera a memória. */
  stop() {
    this.running = false
    for (const ctrl of this.inflight.values()) ctrl.abort()
    this.inflight.clear()
    this.frames.clear()
    this.failures.clear()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  get(i: number): T | undefined { return this.frames.get(i) }
  has(i: number): boolean { return this.frames.has(i) }
  failed(i: number): boolean { return (this.failures.get(i) ?? 0) >= this.opts.maxRetries }
  get pending(): number { return this.inflight.size }
  get position(): number { return this.cursor }

  /** Índices em memória (para a barra de "carregado" do scrubber). */
  loaded(): number[] { return [...this.frames.keys()].sort((a, b) => a - b) }

  /** Primeiro índice a partir do cursor que ainda NÃO está no buffer (= total se tudo à frente chegou). */
  bufferedUntil(): number {
    let i = this.cursor
    while (i < this.total && this.frames.has(i)) i++
    return i
  }

  /** Move o cursor (play ou scrubber): cancela/descarta o que saiu da janela e reprioriza a fila. */
  setCursor(index: number) {
    this.cursor = Math.max(0, Math.min(this.total - 1, Math.floor(index)))
    for (const [i, ctrl] of this.inflight) if (!this.inWindow(i)) { ctrl.abort(); this.inflight.delete(i) }
    for (const i of this.frames.keys()) if (!this.inWindow(i)) this.frames.delete(i)
    this.pump()
  }

  private inWindow(i: number) {
    return i >= this.cursor - this.opts.behind && i <= this.cursor + this.opts.ahead
  }

  private next(): number | null {
    const end = Math.min(this.total - 1, this.cursor + this.opts.ahead)
    for (let i = this.cursor; i <= end; i++) {
      if (!this.frames.has(i) && !this.inflight.has(i) && !this.failed(i)) return i
    }
    return null
  }

  private pump() {
    if (!this.running) return
    while (this.inflight.size < this.opts.concurrency) {
      const i = this.next()
      if (i === null) return
      this.load(i)
    }
  }

  private load(i: number) {
    const ctrl = new AbortController()
    this.inflight.set(i, ctrl)
    this.opts.fetchFrame(i, ctrl.signal).then((frame) => {
      if (ctrl.signal.aborted || !this.running) return
      if (this.inWindow(i)) this.frames.set(i, frame)
      this.failures.delete(i)
    }).catch(() => {
      if (ctrl.signal.aborted || !this.running) return
      const n = (this.failures.get(i) ?? 0) + 1
      this.failures.set(i, n)
      if (n < this.opts.maxRetries && !this.retryTimer) {
        // espera crescente: servidor ocupado ou rede instável não viram uma rajada de repetições
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump() }, this.opts.retryDelayMs * n)
      }
    }).finally(() => {
      if (this.inflight.get(i) === ctrl) this.inflight.delete(i)
      if (!this.running) return
      this.opts.onChange()
      if (!this.retryTimer) this.pump()
    })
  }
}
