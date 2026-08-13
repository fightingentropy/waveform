import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), cloudflare()],
  legacy: {
    skipWebSocketTokenCheck: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    hmr: {
      protocol: "ws",
      host: "127.0.0.1",
      port: 5175,
      clientPort: 5175,
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@spotify/shared": fileURLToPath(new URL("./packages/shared/src", import.meta.url)),
    },
  },
});
