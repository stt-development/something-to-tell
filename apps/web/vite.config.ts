import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true
  },
  test: {
    environment: "jsdom",
    // Browser specs are owned by Playwright and must not execute inside JSDOM.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: "./src/test/setupTests.ts"
  }
});
