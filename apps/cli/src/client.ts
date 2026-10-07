/** The CLI and the demo use the typed v1 client from @durable/contract. */
export { ApiError, ApiUnavailable, createClient, type ApiClient } from '@durable/contract';

/** For operational endpoints that are not part of the versioned contract (/ready, /health). */
export async function isReady(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}
