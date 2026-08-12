import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-only convenience: `npm run web:dev` proxies API/WS calls to the
    // real orchestrator backend (npm start, port 4771) so the dashboard can
    // be iterated on with hot reload without rebuilding web/dist each time.
    // Production use is always the built static bundle served directly by
    // src/ui/server.ts — this proxy is never involved there.
    proxy: {
      "/api": "http://127.0.0.1:4771",
      "/ws": { target: "ws://127.0.0.1:4771", ws: true },
    },
  },
})
