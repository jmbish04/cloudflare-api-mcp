import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

/**
 * The popup is the only built surface. `root` is `src/`, so the entry at
 * `src/popup/popup.html` lands at `dist/popup/popup.html` — the exact path
 * `manifest.json` already names as `default_popup`, which therefore needs no change.
 *
 * `scripts/copy-static.mjs` then copies the manifest, the icons and the unbuilt
 * background and content scripts into `dist/`, which is the folder to load unpacked.
 */
export default defineConfig({
  root: resolve(__dirname, "src"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/popup.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
});
