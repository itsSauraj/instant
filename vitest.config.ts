import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "components/room/composer-format.ts"],
      // The ruflo coverage hooks read these; lcov also feeds any future CI.
      reporter: ["text-summary", "lcov", "json-summary"],
    },
  },
});
