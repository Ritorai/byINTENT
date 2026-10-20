import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// papertrade's edge rejects requests with a foreign Origin header, so the app
// talks to it through a same-origin /pt proxy (vite in dev, server.mjs in prod).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // trigger API: point at a locally running server.mjs (default :3000) with
      //   TRIGGER_API=http://localhost:3000 npx vite
      // without it, /api answers 503 and the Triggers tab shows "offline"
      "/api": process.env.TRIGGER_API
        ? { target: process.env.TRIGGER_API, changeOrigin: false }
        : {
            target: "http://127.0.0.1:9",
            configure: (proxy) =>
              proxy.on("error", (_e, _req, res) => {
                if ("writeHead" in res && !res.headersSent) {
                  res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
                  res.end(JSON.stringify({ error: "api_unavailable" }));
                }
              }),
          },
      "/pt": {
        target: "https://exchange.papertrade.xyz",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pt/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
    },
  },
});
