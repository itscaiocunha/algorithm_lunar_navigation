# Lunar Navigator — frontend

React 19 + TypeScript (strict) + Vite + Tailwind CSS v4.

| Biblioteca | Uso |
|---|---|
| **deck.gl** | Mapa analítico 2D: camadas raster (relevo, iluminação, mapa anual), grade lat/lon, picos, picking por clique — tudo no plano polar estereográfico (km), via `OrthographicView` |
| **React Three Fiber** + drei | Vista 3D do relevo LOLA com a iluminação aplicada como textura e a direção do Sol |
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
│   └── view.ts             # estado de câmera 2D, utilitário cx
└── components/
    ├── InstantView.tsx     # iluminação num instante (mapa / comparar / 3D)
    ├── AnnualView.tsx      # Picos da Luz Eterna
    ├── MethodologyView.tsx # como funciona, validação, limitações
    ├── MapView2D.tsx       # deck.gl
    ├── Terrain3D.tsx       # React Three Fiber
    ├── LoadingNarrative.tsx, PointCard.tsx, ServerOffline.tsx, ui.tsx
```
