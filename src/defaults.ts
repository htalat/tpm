export const PROJECT_TEMPLATE = `---
name: {{name}}
slug: {{slug}}
status: active
created: {{date}}
repo:
  remote: {{repo_remote}}
  local: {{repo_local}}
tags: []
---

# {{name}}

## Goal
<!-- Why this project exists. What does success look like? -->

## Context
<!-- Background, links, stakeholders -->

## Notes
<!-- Living notes, decisions, open questions -->
`;

export const TASK_TEMPLATE = `---
title: {{title}}
slug: {{slug}}
project: {{project}}
status: open
type: pr
created: {{date}}
closed:
prs: []
tags: []
---

# {{title}}

## Context
<!-- Why this task. What we know. Constraints. -->

## Plan
<!-- Approach, steps, what "done" looks like -->

## Log
- {{date}}: created

## Outcome
<!-- Filled when closed: what shipped, what changed, what we learned -->
`;
