import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.d.ts", "src/test-support/**"],
    },
  },
});
