# Set up from zero

This guide takes a new Mac to a working agent factory. Each step ends with
something you can check; the last step is `npm run doctor`.

## 1. Prerequisites

| Tool                    | Why                                   | Check              |
| ----------------------- | ------------------------------------- | ------------------ |
| Node.js ≥ 22.12         | runs every process                    | `node -v`          |
| PostgreSQL ≥ 14         | all durable state (or Docker)         | `psql --version`   |
| git                     | agent and review clones               | `git --version`    |
| GitHub CLI              | issues, PRs, labels (`gh auth login`) | `gh auth status`   |
| Claude Code             | the author agent and reviewer         | `claude --version` |
| Xcode 15+ / Swift 5.10+ | the menu bar app (optional)           | `swift --version`  |

Optional: Copilot CLI (second reviewer), Azure CLI with the `azure-devops`
extension (Azure Boards / Azure Repos).

Claude Code runs non-interactively, so the tools it needs must be allowed in
`~/.claude/settings.json` (`permissions.allow`): at least `Bash(git:*)`,
`Bash(gh:*)`, `Read`, `Edit`, `Write` (and `Bash(az:*)` for Azure DevOps).

## 2. Database

With Docker:

```bash
docker compose up -d postgres            # creates durable and durable_test
```

Or a local PostgreSQL:

```bash
createdb durable && createdb durable_test
```

## 3. Install and configure

```bash
git clone https://github.com/htalat/tpm.git && cd tpm
npm install
cp .env.example .env                     # set DATABASE_URL and TEST_DATABASE_URL
npm run db:migrate
npm run db:migrate -- --test
npm run check                            # optional: full test suite against your database
```

## 4. Add a repository

Clone the repository the agents will work in, in a separate place (the
agents use this clone; keep your own working copy elsewhere):

```bash
gh repo clone <owner>/<repo> ~/Developer/agent-checkouts/<repo>
cp agent-runner.config.example.json agent-runner.config.json   # set name, path, defaultBranch
npm run agent-runner -- labels           # creates the tpm:agent:* labels
```

For Azure DevOps, start from `agent-runner.config.ado.example.json` instead.

## 5. Optional: let agents review and merge

Set `"factory": true` for the repository in `agent-runner.config.json`, then
add `.tpm/agent-policy.yml` to the repository through a pull request that you
merge yourself (see [agent-runner.md](agent-runner.md#policy-tpmagent-policyyml-in-the-repo-read-from-the-default-branch)).
Without a policy file the agents still review, but a human merges everything.

## 6. Check everything

```bash
npm run doctor
```

Fix every ✘. Warnings (⚠) are advice — for example "the API is not answering"
just means the factory is not started yet.

## 7. Start the factory

```bash
npm run menubar                          # builds apps/menubar/build/Factory.app
apps/menubar/build.sh --install && open ~/Applications/Factory.app
```

The app starts the API, the orchestrator and the agent-runner (sync + worker),
and restarts them if they crash. Without the app, run each in a terminal:
`npm run api`, `npm run orchestrator`, `npm run agent-runner -- sync`,
`npm run agent-runner -- worker`.

## 8. First run

Open an issue that asks for a small documentation change and add the label
`tpm:agent:ready`. Within a minute the menu bar shows the run; follow it live
with `npm run cli -- events`.
