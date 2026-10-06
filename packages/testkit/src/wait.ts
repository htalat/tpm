export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${opts.message ?? 'condition'}${last ? `: ${(last as Error).message}` : ''}`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
