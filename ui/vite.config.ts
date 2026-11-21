import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The UI is a client-only app served from the micros3 binary on the UI
// port. In development, `pnpm dev` proxies /api to a running micros3.
export default defineConfig({
  plugins: [react()],
  build: {
    // Never inline assets as data: URLs; every asset is a file served
    // from the binary, so the CSP can stay at 'self'.
    assetsInlineLimit: 0,
    // No source maps in the embedded build: they would only grow the binary.
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.MICROS3_UI_PORT ?? "3924"}`,
    },
  },
})
