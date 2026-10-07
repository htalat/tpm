# Engine demonstrations

These run the durable engine on its own (no coding agents), to see the
failure model in action.

The example workflows are not part of the production registry. A process
registers them only when `EXAMPLE_WORKFLOWS=1` is set. `npm run dev`, the
durability demo, the chaos test and the Docker `app` profile set it
themselves; set it yourself when you start `npm run api` and
`npm run orchestrator` by hand for these experiments.

## Durability demo (all processes killed, twice)

```bash
npm run demo:durability                      # uses DATABASE_URL, API on :3100
npm run demo:durability -- --sleep-ms 60000  # longer timer
```

It starts real processes and prints each step with a ✔/✘ check:

1–5. start API, orchestrator, two general workers and a payments worker; submit
`durability-demo`; steps complete.
6–8. SIGKILL the worker holding a slow item; its lease expires; another worker
recovers it.
8b. the payments worker charges, then crashes before reporting (`CRASH_AT=AFTER_SIDE_EFFECT`);
the engine classifies AMBIGUOUS; the restarted worker reconciles instead of
charging again.
9–13. the workflow enters a durable timer; **every** process is killed; the demo
waits past `fire_at`; the timer is still SCHEDULED; restart; it fires.
14–18. approval step; kill everything again; restart; send the approval twice
with the same deduplication key; execution continues.
19–21. the unreliable step fails twice with persisted backoff and completes. 22. full durable history is printed.
23–25. checks: duplicate signal caused one transition; the dead worker's stale
completion is rejected with `409 LEASE_LOST`; no step has two completed
attempts; the charge and publish effects each happened once.

Process logs go to `data/logs/demo-*.log`. The same demo runs as
`tests/e2e/durability-demo.test.ts`.

### Manual crash experiments

```bash
npm run dev                                  # terminal 1
npm run cli -- task create example-sleep '{"sleepMs":60000}'
# Ctrl-C terminal 1 (or kill -9 the pids it printed), wait > 60 s, run npm run dev again
npm run cli -- task history <task-id>        # timer.fired with latency > 0, task completed

CRASH_AT=AFTER_SIDE_EFFECT WORKER_CAPABILITIES=side-effect WORKER_NAME=payments npm run worker
```

## Example workflows

| Type                   | Shows                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `example-sequence`     | A → B → C                                                                           |
| `example-parallel`     | A → (B1, B2, B3) → aggregate                                                        |
| `example-retry`        | fails twice, succeeds on attempt 3 (`task history` shows the backoff)               |
| `example-sleep`        | A → durable sleep (default 60 s) → B; kill everything during the wait               |
| `example-approval`     | generate → wait for `approval` → publish                                            |
| `example-agent`        | request → mock AI agent (artifact) → summarize                                      |
| `company-research`     | 1 agent step per company, at most 10 in flight, approval, report                    |
| `saga-order`           | reserve → charge → ship fails → refund → release                                    |
| `parent-with-children` | map of child workflows + a single child task                                        |
| `durability-demo`      | everything above in one run; used by the demo                                       |
| `chaos`                | 80 idempotent side effects + duplicate events; used by the chaos test               |
| `agent-run`            | one coding-agent run for one GitHub issue ([docs/agent-runner.md](agent-runner.md)) |

`agent-run` is always registered. The others need `EXAMPLE_WORKFLOWS=1`.

Workers: `compute`/`echo`/`aggregate` (deterministic), `flaky` (deterministic
failure injection), `slow` (heartbeats), `side-effect`/`charge`/`reserve`/…
(idempotent external effects with reconcile), `agent` (mock LLM),
`chaos-effect`.

---

Start them with `npm run cli -- task create <type> '<json input>'` while
`npm run dev` (API, orchestrator, example workers) is running, and follow them
with `npm run cli -- events` or `npm run cli -- task history <id>`.
