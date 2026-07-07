/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The SPA mounts at /app (the SSR pages keep / until parity). In dev, vite
// serves the SPA and proxies data routes to a running `tpm serve`; in prod,
// `vite build` emits web/dist and tpm serve ships it statically at /app.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/app/",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7777",
      "/events": "http://127.0.0.1:7777",
      "/t": "http://127.0.0.1:7777",
    },
  },
  build: { outDir: "dist" },
  // Vitest owns src/ unit tests only — e2e/*.spec.ts belongs to playwright,
  // whose test() throws if vitest imports it.
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
