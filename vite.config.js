import { defineConfig } from "vite";

export default defineConfig({
  base: "/PDFTOJPGCURSOR/",
  build: {
    outDir: "docs"
  },
  server: {
    port: 5173,
    strictPort: false,
    open: false
  }
});

