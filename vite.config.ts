import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// onnxruntime-web loads .wasm files at runtime. We tell Vite not to try
// bundling them and instead serve them as-is (copied via public/ort or CDN).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/data": {
        target: `http://${process.env.DATA_API_HOST ?? "127.0.0.1"}:${process.env.DATA_API_PORT ?? "8787"}`,
        changeOrigin: true,
      },
      "/api/ai": {
        target: `http://${process.env.DATA_API_HOST ?? "127.0.0.1"}:${process.env.DATA_API_PORT ?? "8787"}`,
        changeOrigin: true,
      },
      "/api/mipi": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
      "/api/detect": {
        target: "http://127.0.0.1:8766",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/detect/, ""),
      },
    },
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
});
