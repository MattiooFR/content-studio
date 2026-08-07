import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/setup.global.ts"],
    testTimeout: 15000,
    fileParallelism: false, // une seule db de test, pas d'accès concurrents entre fichiers
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
