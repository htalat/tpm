import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tryDaemon } from "./daemon_client.ts";

// tryDaemon's contract: forward when a daemon answers 200 with a
// CommandResult; return null (→ caller executes locally) for every other
// outcome — no daemon, older daemon (404), different tree (409), garbage.

function serverOn(handler: (body: string) => { status: number; body: string }): Promise<{ server: Server; base: string }> {
  return new Promise(resolvePromise => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", c => { raw += c; });
      req.on("end", () => {
        const r = handler(raw);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolvePromise({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test("tryDaemon: forwards argv + actor + root and returns the CommandResult", async () => {
  let seen: Record<string, unknown> | null = null;
  const { server, base } = await serverOn(body => {
    seen = JSON.parse(body);
    return { status: 200, body: JSON.stringify({ ok: true, stdout: "from daemon", stderr: "" }) };
  });
  try {
    const r = await tryDaemon(["ready", "demo/001"], base);
    assert.deepEqual(r, { ok: true, stdout: "from daemon", stderr: "" });
    assert.deepEqual(seen!.argv, ["ready", "demo/001"]);
    assert.equal(typeof seen!.root, "string");
    assert.equal(typeof seen!.actor, "string");
  } finally {
    server.close();
  }
});

test("tryDaemon: 404 (older daemon) and 409 (different tree) fall back to null", async () => {
  for (const status of [404, 409]) {
    const { server, base } = await serverOn(() => ({ status, body: "{}" }));
    try {
      assert.equal(await tryDaemon(["ready", "x"], base), null);
    } finally {
      server.close();
    }
  }
});

test("tryDaemon: no listener and malformed payloads fall back to null", async () => {
  assert.equal(await tryDaemon(["ready", "x"], "http://127.0.0.1:1"), null);
  const { server, base } = await serverOn(() => ({ status: 200, body: '{"weird": true}' }));
  try {
    assert.equal(await tryDaemon(["ready", "x"], base), null);
  } finally {
    server.close();
  }
});

test("tryDaemon: TPM_NO_DAEMON forces local execution", async () => {
  process.env.TPM_NO_DAEMON = "1";
  try {
    assert.equal(await tryDaemon(["ready", "x"], "http://127.0.0.1:1"), null);
  } finally {
    delete process.env.TPM_NO_DAEMON;
  }
});
