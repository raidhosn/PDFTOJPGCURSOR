import { defineConfig } from "vite";

export default defineConfig({
  base: "/PDFTOJPGCURSOR/",
  server: {
    port: 5173,
    strictPort: false,
    open: false
  }
});

