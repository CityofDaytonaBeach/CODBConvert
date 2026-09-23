import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    model: "src/model.ts",
    "binary-flow": "src/binary-flow.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
