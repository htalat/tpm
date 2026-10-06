import { AdoPrHost, AzureBoardsTracker } from './azure';
import { GitHubIssuesTracker, GitHubPrHost } from './github';
import { createSourceResolver, type SourceResolver, type Tracker } from './source';

/** The real trackers and PR hosts (gh / az CLIs). */
export function createDefaultIntegrations(): { trackers: Record<string, Tracker>; sources: SourceResolver } {
  const trackers: Record<string, Tracker> = {
    github: new GitHubIssuesTracker(),
    'azure-boards': new AzureBoardsTracker(),
  };
  return {
    trackers,
    sources: createSourceResolver({ trackers, hosts: { github: new GitHubPrHost(), ado: new AdoPrHost() } }),
  };
}
