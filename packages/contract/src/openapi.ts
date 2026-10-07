import { z } from 'zod';
import { routes, type RouteDef } from './routes';
import * as S from './schemas';

/** OpenAPI 3.1 for the v1 API, generated from the route table and the zod schemas. */
const COMPONENTS = [
  S.ErrorBody,
  S.StepError,
  S.Task,
  S.Step,
  S.Attempt,
  S.ChildTask,
  S.TaskEvent,
  S.Timer,
  S.Artifact,
  S.HistoryEvent,
  S.TaskDetail,
  S.Workflow,
  S.WorkItem,
  S.HeartbeatResponse,
  S.CompletionResponse,
  S.AgentRun,
  S.AgentRunsOverview,
  S.AgentRunList,
  S.AgentRunDetail,
  S.Ok,
  S.LiveEvent,
];

const idOf = (s: z.ZodType) => (z.globalRegistry.get(s) as { id?: string } | undefined)?.id;

/** JSON Schema for one zod schema; named sub-schemas become refs into #/components/schemas. */
export function jsonSchemaOf(s: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const j = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  const defs = (j.$defs ?? {}) as Record<string, unknown>;
  const id = idOf(s);
  // A named schema may come back as {$ref: '#/$defs/<id>'} plus the definition: take the definition.
  const body = (j.$ref && id && defs[id] ? defs[id] : j) as Record<string, unknown>;
  const copy = { ...body };
  delete copy.$schema;
  delete copy.$defs;
  return JSON.parse(JSON.stringify(copy).replace(/"#\/\$defs\/([^"]+)"/g, '"#/components/schemas/$1"'));
}

/** OpenAPI 3.1 for the v1 API, generated from the route table and the zod schemas. */
export function buildOpenApi(version = '1.0.0'): Record<string, unknown> {
  const toSchema = jsonSchemaOf;
  const components: Record<string, unknown> = {};
  for (const s of COMPONENTS) {
    const id = idOf(s);
    if (id) components[id] = jsonSchemaOf(s, 'output');
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const [operationId, raw] of Object.entries(routes)) {
    const r = raw as RouteDef;
    const path = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const parameters: unknown[] = [];
    for (const [where, schema] of [
      ['path', r.params],
      ['query', r.query],
    ] as const) {
      if (!schema) continue;
      const js = toSchema(schema, 'input') as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, prop] of Object.entries(js.properties ?? {})) {
        parameters.push({
          name,
          in: where,
          required: where === 'path' || (js.required ?? []).includes(name),
          schema: prop,
        });
      }
    }
    if (operationId === 'createTask')
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', maxLength: 256 },
      });
    const ok = {
      description: 'OK',
      content: { [r.contentType ?? 'application/json']: { schema: toSchema(r.response, 'output') } },
    };
    const responses: Record<string, unknown> = Object.fromEntries(r.status.map((s) => [String(s), ok]));
    responses.default = {
      description: 'Error',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
    paths[path] ??= {};
    paths[path][r.method.toLowerCase()] = {
      operationId,
      summary: r.summary,
      tags: [r.tag],
      ...(r.auth === 'none'
        ? {}
        : { security: [{ [r.auth === 'worker' ? 'workerToken' : 'adminToken']: [] }] }),
      ...(parameters.length ? { parameters } : {}),
      ...(r.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toSchema(r.body, 'input') } },
            },
          }
        : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'durable — task orchestration and agent factory API',
      version,
      description:
        'v1. Fields may be added; nothing is renamed or removed without /v2. Operational endpoints (/health, /ready, /metrics) are not versioned.',
    },
    servers: [{ url: 'http://127.0.0.1:3000' }],
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        adminToken: { type: 'http', scheme: 'bearer', description: 'API_TOKEN (optional on loopback)' },
        workerToken: { type: 'http', scheme: 'bearer', description: 'WORKER_TOKEN (optional on loopback)' },
      },
    },
  };
}
