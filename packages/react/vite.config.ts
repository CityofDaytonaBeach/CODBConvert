import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ["@codb/core", "@codb/pdf", "@codb/image", "@codb/office"],
  },
  build: {
    rollupOptions: {
      // @napi-rs/canvas is a Node-only native (prebuilt .node) dependency used
      // behind an `isNode()` guard. Externalize so Rollup never tries to parse
      // its platform binary in the browser bundle. It is never evaluated in a
      // browser, so there is no runtime impact.
      external: [/^@napi-rs\/canvas/],
    },
  },
});
