import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    model: "src/model.ts",
    "binary-flow": "src/binary-flow.ts",
    api: "src/api.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
