import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: {
    // Boardfish 4: route /api/* to the local ai-proxy (Ronan + Nano Banana bridge).
    // Start the proxy separately with `cd ai-proxy && npm start` (or `npm run dev` for watch).
    proxy: {
      '/api': {
        target: process.env.VITE_AI_PROXY_URL ?? 'http://127.0.0.1:5174',
        changeOrigin: true,
      },
    },
  },
})
