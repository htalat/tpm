# Factory menu bar app (macOS)

A native SwiftUI menu bar app for the tpm software factory.

- **Supervises the factory**: starts the API, orchestrator, agent-runner sync
  and worker (`node --import tsx …` with your login-shell PATH), restarts a
  crashed component (max 5 per minute), and stops all of them when the app
  quits. Logs: `data/logs/menubar-<component>.log`.
- **Status at a glance**: the icon shows how many runs need you. The menu lists
  _Needs you_ (approve, failed, needs a human, blocked), _Running_ (current step
  and progress) and _Recent_ (merged / closed), with cost per run and a 24-hour
  summary.
- **Actions**: Approve & merge (adds `tpm:agent:approve` to the PR, exactly as
  you would), Retry (adds `tpm:agent:ready`), Cancel (cancels the run and labels
  the issue failed), Dismiss (hides an item on this Mac), open issue / PR, and a
  History window with the run's durable history.
- **Notifications**: approval needed, needs a human, failed, merged — each once.
  Clicking opens the PR.

The app talks only to the factory REST API (`GET /agent-runs`, `POST
/agent-runs/:id/approve|retry|cancel`); it never touches PostgreSQL or `gh`.

## Build and run

```bash
apps/menubar/build.sh            # -> apps/menubar/build/Factory.app
apps/menubar/build.sh --install  # also copies it to ~/Applications
open apps/menubar/build/Factory.app
```

Settings (environment or `defaults write com.htalat.tpm.factory <key> <value>`):

| Key / env                    | Default                              |
| ---------------------------- | ------------------------------------ |
| `repoPath` / `FACTORY_REPO`  | `~/Developer/tpm-2`                  |
| `apiURL` / `FACTORY_API_URL` | `http://127.0.0.1:3000`              |
| `autoStart`                  | `true` (start the factory at launch) |
| `API_TOKEN` (env)            | bearer token if the API requires one |

## Tests

```bash
cd apps/menubar && swift test
```

`Tests/FactoryKitTests/Fixtures/*.json` are written from the real API by the
TypeScript integration test (`UPDATE_FIXTURES=1 npm run test:integration -- factory`),
so a contract change breaks the Swift decoding tests.

Debug: `FactoryMenu --snapshot menu.png` renders the menu with live data into a PNG.
