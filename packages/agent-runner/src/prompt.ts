import type { RepoConfig } from './config';
import type { SourceTask } from './source';

/** Execution prompt (adapted from tpm). The tracker, not the prompt, carries status. */
function prInstruction(task: SourceTask, repo: RepoConfig, branch: string): string {
  if (repo.host === 'ado' && repo.ado) {
    const a = repo.ado;
    const link = repo.tracker === 'azure-boards' ? ` --work-items ${task.number}` : '';
    return `Open the pull request in Azure Repos with: \`az repos pr create --org https://dev.azure.com/${a.organization} --project "${a.project}" --repository "${a.repository}" --source-branch ${branch} --target-branch ${repo.defaultBranch}${link} --title "<title>" --description "<what and why>"\`.`;
  }
  const closes = repo.tracker === 'github' ? `"Closes #${task.number}"` : `a link to ${task.url}`;
  return `Open a pull request against \`${repo.defaultBranch}\` (\`gh pr create\`) whose body contains ${closes}.`;
}

export function buildPrompt(
  task: SourceTask,
  repo: RepoConfig,
  branch: string,
  round: number,
  feedback: string | null = null,
): string {
  return `You are running in non-interactive mode. Nobody will answer questions. If you must choose between asking and acting, act: take the smaller, safer change.

# Task
${task.title}

Source: ${task.url} (${task.ref})

${task.body.trim() || '(no description)'}

# Rules
- Work in this checkout only. Start from a fresh default branch: \`git checkout ${repo.defaultBranch} && git pull --ff-only\`. If the tree is dirty or the pull does not fast-forward, stop and explain why in your final message.
- Use exactly this branch name: \`${branch}\`.${round > 1 ? ' It already has an open pull request: check it out, address the feedback below, commit and push to the same branch. A round without new commits counts as failed.' : ''}
- Commit your change and push the branch. ${prInstruction(task, repo, branch)}
- Do not change labels or tags on the item; the orchestrator does that.
- If the task is unclear or impossible, do not open a pull request; explain why in your final message.
${feedback ? `\n# Feedback on the pull request (round ${round})\n${feedback}\n` : ''}${repo.instructions ? `\n# Repository instructions\n${repo.instructions}\n` : ''}`;
}
