// Single source of truth for the task status state machine.
//
// Before this module, legality lived in per-verb deny lists inside mutate.ts
// (`refusal: ["done", "dropped"]`) — and the generic paths (`tpm status`,
// reopen, pull) passed empty lists, so any status could move anywhere,
// including done -> in-progress. This table is the allow-list every status
// write now shares. The README's state diagram documents the machine; this
// file enforces it — change them together.
//
// Shape of the machine:
//   - `open` is pre-deliverable: it can enter the queue (ready), start
//     directly (in-progress), block, or close — but never jump straight to a
//     needs-* state, which would imply a deliverable already in flight.
//   - The queue / in-flight statuses (ready, in-progress, rework,
//     review, closing) are fully connected: the operator, the
//     agent, and the PR-signal poller all legitimately move tasks between
//     any pair (e.g. a reverted `ready` task whose PR merges flips straight
//     to closing; a closing straggler with CI red flips to
//     rework).
//   - `blocked` re-enters via open / ready / in-progress, or closes. The
//     poller skips blocked tasks, so needs-* targets aren't reachable here.
//   - Terminals (done, dropped) have exactly one exit: reopen to `open`.
//     Cross-terminal moves (done <-> dropped) are refused.

export const VALID_STATUSES = [
  "open",
  "ready",
  "in-progress",
  "rework",
  "closing",
  "review",
  "blocked",
  "done",
  "dropped",
] as const;
export type Status = typeof VALID_STATUSES[number];

function allExcept(s: Status): readonly Status[] {
  return VALID_STATUSES.filter(x => x !== s);
}

export const TRANSITIONS: Record<Status, readonly Status[]> = {
  open: ["ready", "in-progress", "blocked", "done", "dropped"],
  ready: allExcept("ready"),
  "in-progress": allExcept("in-progress"),
  "rework": allExcept("rework"),
  "review": allExcept("review"),
  "closing": allExcept("closing"),
  blocked: ["open", "ready", "in-progress", "done", "dropped"],
  done: ["open"],
  dropped: ["open"],
};

export function isStatus(s: string): s is Status {
  return (VALID_STATUSES as readonly string[]).includes(s);
}

// Unknown / empty `from` (missing or hand-mangled frontmatter) is a repair
// path: any valid target is allowed, matching the old deny-list behavior.
// An identity move is a caller-level no-op, never a table question.
export function canTransition(from: string, to: Status): boolean {
  if (!isStatus(from)) return true;
  return TRANSITIONS[from].includes(to);
}

export function legalTargets(from: string): readonly Status[] {
  return isStatus(from) ? TRANSITIONS[from] : VALID_STATUSES;
}

export function assertTransition(slug: string, from: string, to: Status): void {
  if (canTransition(from, to)) return;
  const legal = legalTargets(from);
  const hint = from === "done" || from === "dropped"
    ? `${from} is terminal — \`tpm reopen\` is the only exit.`
    : `Legal targets from "${from}": ${legal.join(", ")}.`;
  throw new Error(`Cannot transition ${slug} from "${from}" to "${to}". ${hint}`);
}
