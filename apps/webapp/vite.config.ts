import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
