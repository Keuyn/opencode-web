import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    // The HTTP server (server.ts) owns the port and mounts Vite in middleware mode.
    middlewareMode: true,
  },
  build: {
    outDir: "dist",
  },
})
