import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// onnxruntime-web loads .wasm files at runtime. We tell Vite not to try
// bundling them and instead serve them as-is (copied via public/ort or CDN).
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
});
