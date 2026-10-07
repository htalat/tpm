import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApi, routes } from '@durable/contract';

describe('API contract', () => {
  it('docs/openapi.json is up to date (run: npm run cli -- openapi docs/openapi.json)', () => {
    const committed = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
    expect(committed).toEqual(buildOpenApi());
  });

  it('every route is versioned and every named $ref resolves', () => {
    for (const r of Object.values(routes)) expect(r.path.startsWith('/v1/')).toBe(true);
    const doc = buildOpenApi() as { components: { schemas: Record<string, unknown> } };
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(refs.filter((r) => !doc.components.schemas[r])).toEqual([]);
  });
});
