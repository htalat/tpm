// Builds the fixture tree, then the webServer command starts tpm serve.
// Runs inside the webServer command (not globalSetup) because playwright
// probes the server's readiness URL before globalSetup executes.
import globalSetup from "./setup.ts";
globalSetup();
console.log("e2e fixture tree ready");
