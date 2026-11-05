import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    modulePreload: { polyfill: false }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});