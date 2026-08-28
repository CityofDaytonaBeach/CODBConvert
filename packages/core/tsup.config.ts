import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    model: "src/model.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
