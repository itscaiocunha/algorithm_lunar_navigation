import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Em desenvolvimento (npm run dev) as chamadas /api vão para o FastAPI na porta 8000.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/docs': 'http://127.0.0.1:8000',
      '/openapi.json': 'http://127.0.0.1:8000',
    },
  },
  build: {
    chunkSizeWarningLimit: 2000, // deck.gl + three são grandes por natureza
  },
  test: {
    environment: 'node',
  },
})
