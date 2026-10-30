# Lunar Navigator — frontend

React 19 + TypeScript (strict) + Vite + Tailwind CSS v4.

| Biblioteca | Uso |
|---|---|
| **deck.gl** | Mapa analítico 2D: camadas raster (relevo, iluminação, mapa anual), grade lat/lon, picos, picking por clique — tudo no plano polar estereográfico (km), via `OrthographicView` |
| **React Three Fiber** + drei | Relevo 3D do DEM inteiro com **quadtree LOD** (`QuadtreeTerrain.tsx`): tiles por erro em espaço de tela, frustum culling, saias, expurgo LRU com orçamento de 128 MB e render sob demanda. Curvatura lunar no vertex shader (`onBeforeCompile`), com normais corrigidas e clique contra a superfície curvada |
| **Tailwind v4** | Design system (tema em `src/index.css`) |
| lucide-react | Ícones |
| vitest | Testes da geometria (`src/lib/geo.test.ts`) |

## Comandos

```powershell
npm install          # uma vez
npm run dev          # http://localhost:5173 — /api vai para o FastAPI em :8000 (proxy)
npm run build        # gera dist/, servido pelo FastAPI em http://127.0.0.1:8000
npx vitest run       # testes
npx oxlint           # lint
```

Em desenvolvimento, rode o backend em paralelo: `python scripts\servidor.py --sem-navegador`.

## Estrutura

```
src/
├── App.tsx                 # cabeçalho, abas, carregamento inicial
├── lib/
│   ├── api.ts              # cliente tipado da API (espelha service.py)
│   ├── geo.ts              # projeção polar estereográfica (mesmas fórmulas de terrain.py)
│   ├── quadtree.ts         # seleção de tiles por erro de tela (pura, testada)
│   ├── curvature.ts        # plano estereográfico → esfera: GLSL injetado + mesma conta na CPU
│   ├── frameBuffer.ts      # buffer de pré-carregamento da animação (ordem, concorrência, janela deslizante)
│   ├── frameCompose.ts     # quadro (nibbles Sol/Terra) → RGBA num buffer reaproveitado
│   ├── overlay.ts          # quadro animado no fragment shader dos tiles (uma textura só)
│   ├── timeline.ts         # janela, interpolação das efemérides, estados e eventos no ponto
│   ├── layers.ts           # hachura da Terra e Zona de Ouro a partir das frações
│   ├── presets.ts          # catálogo de alvos de missão (com origem e validação)
│   └── view.ts             # estado de câmera 2D, utilitário cx
├── hooks/
│   ├── useAnimationBuffer.ts # esteira de download dos quadros (FrameBuffer no ciclo de vida do React)
│   ├── usePlayback.ts      # relógio (requestAnimationFrame) que só consome o buffer; buffering automático
│   └── useAnimation.ts     # janela + buffer + relógio + céu + quadro composto
└── components/
    ├── InstantView.tsx     # iluminação num instante (mapa / comparar / 3D)
    ├── TimelinePlayer.tsx  # play/pause/stop, velocidade, scrubber com buffer, LOS/AOS e faixas do ponto
    ├── AnimatedSky.tsx     # Sol, Terra e luz animados a 60 fps (lê o relógio por ref)
    ├── AnnualView.tsx      # Picos da Luz Eterna
    ├── MethodologyView.tsx # como funciona, validação, limitações
    ├── MapView2D.tsx       # deck.gl
    ├── TerrainLOD3D.tsx    # React Three Fiber: cena 3D do DEM inteiro
    ├── QuadtreeTerrain.tsx # quadtree LOD: carregamento, ancestrais, saias, expurgo
    ├── Terrain3D.tsx       # malha da área de ±30 km (aba anual)
    ├── LoadingNarrative.tsx, PointCard.tsx, ServerOffline.tsx, ui.tsx
```
