import { defineConfig } from "@playwright/test";
import { E2E_HOME } from "./e2e/setup";

// E2E: the built SPA served by a real `tpm serve` over a throwaway tree
// (built in e2e/setup.ts). Run `npm run build` first — the server ships
// web/dist. Specs mutate fixture tasks, so they run serially against the
// one shared server.
const PORT = 7791;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    colorScheme: "dark",
  },
  webServer: {
    command: `node e2e/prepare.ts && node ../src/core/cli.ts serve --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/vocab`,
    reuseExistingServer: false,
    env: { HOME: E2E_HOME, USERPROFILE: E2E_HOME },
  },
});
