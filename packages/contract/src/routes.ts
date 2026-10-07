import { z, type ZodType } from 'zod';
import {
  ClaimRequestSchema,
  CompleteRequestSchema,
  CreateTaskRequestSchema,
  FailRequestSchema,
  LeaseRequestSchema,
  RegisterWorkerRequestSchema,
  ResolveStepRequestSchema,
  SignalRequestSchema,
} from '@durable/core';
import * as S from './schemas';

export type Auth = 'admin' | 'worker' | 'none';

export interface RouteDef {
  method: 'GET' | 'POST';
  /** Fastify-style path (`:id`); the OpenAPI document uses `{id}`. */
  path: string;
  summary: string;
  tag: string;
  auth: Auth;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  /** Success statuses (all share `response`). */
  status: number[];
  response: ZodType;
  /** Not JSON (e.g. server-sent events). */
  contentType?: string;
}

const Id = z.object({ id: z.uuid() });
const StepKey = z.object({ id: z.uuid(), key: z.string().min(1).max(200) });
const Empty = z.object({}).default({});

/** Every v1 route. Server, OpenAPI document and typed client all read this table. */
export const routes = {
  listWorkflows: {
    method: 'GET',
    path: '/v1/workflows',
    summary: 'Registered workflow definitions',
    tag: 'tasks',
    auth: 'admin',
    status: [200],
    response: z.object({ workflows: z.array(S.Workflow) }),
  },
  createTask: {
    method: 'POST',
    path: '/v1/tasks',
    summary: 'Create a task (send `Idempotency-Key` to make it idempotent)',
    tag: 'tasks',
    auth: 'admin',
    body: CreateTaskRequestSchema,
    status: [200, 201],
    response: z.object({ task: S.Task, created: z.boolean() }),
  },
  listTasks: {
    method: 'GET',
    path: '/v1/tasks',
    summary: 'Top-level tasks, newest first',
    tag: 'tasks',
    auth: 'admin',
    query: z.object({
      status: z.string().max(32).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
    }),
    status: [200],
    response: z.object({ tasks: z.array(S.Task) }),
  },
  getTask: {
    method: 'GET',
    path: '/v1/tasks/:id',
    summary: 'A task with steps, attempts, children, events, timers, artifacts',
    tag: 'tasks',
    auth: 'admin',
    params: Id,
    status: [200],
    response: S.TaskDetail,
  },
  getTaskHistory: {
    method: 'GET',
    path: '/v1/tasks/:id/history',
    summary: 'Durable, append-only history',
    tag: 'tasks',
    auth: 'admin',
    params: Id,
    status: [200],
    response: z.object({ history: z.array(S.HistoryEvent) }),
  },
  cancelTask: {
    method: 'POST',
    path: '/v1/tasks/:id/cancel',
    summary: 'Cancel a task and its children',
    tag: 'tasks',
    auth: 'admin',
    params: Id,
    body: z.object({ reason: z.string().max(1000).optional() }).default({}),
    status: [200],
    response: z.object({ task: S.Task, alreadyCancelled: z.boolean() }),
  },
  pauseTask: {
    method: 'POST',
    path: '/v1/tasks/:id/pause',
    summary: 'Pause (no new work is claimed)',
    tag: 'tasks',
    auth: 'admin',
    params: Id,
    body: Empty,
    status: [200],
    response: z.object({ task: S.Task }),
  },
  resumeTask: {
    method: 'POST',
    path: '/v1/tasks/:id/resume',
    summary: 'Resume a paused task',
    tag: 'tasks',
    auth: 'admin',
    params: Id,
    body: Empty,
    status: [200],
    response: z.object({ task: S.Task }),
  },
  signalTask: {
    method: 'POST',
    path: '/v1/tasks/:id/signals',
    summary: 'Deliver an external event (deduplicated by deduplicationKey)',
    tag: 'tasks',
    auth: 'admin',
    params: Id,
    body: SignalRequestSchema,
    status: [200, 202],
    response: z.object({ eventId: z.uuid(), duplicate: z.boolean() }),
  },
  resolveStep: {
    method: 'POST',
    path: '/v1/tasks/:id/steps/:key/resolve',
    summary: 'Operator decision for a BLOCKED step',
    tag: 'tasks',
    auth: 'admin',
    params: StepKey,
    body: ResolveStepRequestSchema,
    status: [200],
    response: z.object({ step: S.Step }),
  },

  registerWorker: {
    method: 'POST',
    path: '/v1/workers/register',
    summary: 'Register a worker and its capabilities',
    tag: 'workers',
    auth: 'worker',
    body: RegisterWorkerRequestSchema,
    status: [201],
    response: z.object({ workerId: z.uuid() }),
  },
  claim: {
    method: 'POST',
    path: '/v1/workers/claim',
    summary: 'Claim work (leases)',
    tag: 'workers',
    auth: 'worker',
    body: ClaimRequestSchema,
    status: [200],
    response: z.object({ items: z.array(S.WorkItem) }),
  },
  heartbeat: {
    method: 'POST',
    path: '/v1/attempts/:id/heartbeat',
    summary: 'Extend a lease; reports cancellation',
    tag: 'workers',
    auth: 'worker',
    params: Id,
    body: LeaseRequestSchema,
    status: [200],
    response: S.HeartbeatResponse,
  },
  complete: {
    method: 'POST',
    path: '/v1/attempts/:id/complete',
    summary: 'Complete an attempt (idempotent per token)',
    tag: 'workers',
    auth: 'worker',
    params: Id,
    body: CompleteRequestSchema,
    status: [200],
    response: S.CompletionResponse,
  },
  fail: {
    method: 'POST',
    path: '/v1/attempts/:id/fail',
    summary: 'Fail an attempt with a category',
    tag: 'workers',
    auth: 'worker',
    params: Id,
    body: FailRequestSchema,
    status: [200],
    response: S.CompletionResponse,
  },

  listAgentRuns: {
    method: 'GET',
    path: '/v1/agent-runs',
    summary: 'Agent runs with current step, needs-you reason and cost',
    tag: 'agent-runs',
    auth: 'admin',
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    status: [200],
    response: S.AgentRunList,
  },
  getAgentRun: {
    method: 'GET',
    path: '/v1/agent-runs/:id',
    summary: 'One run with its history',
    tag: 'agent-runs',
    auth: 'admin',
    params: Id,
    status: [200],
    response: S.AgentRunDetail,
  },
  approveAgentRun: {
    method: 'POST',
    path: '/v1/agent-runs/:id/approve',
    summary: 'Approve (adds the approve label to the PR)',
    tag: 'agent-runs',
    auth: 'admin',
    params: Id,
    body: Empty,
    status: [200],
    response: S.Ok,
  },
  retryAgentRun: {
    method: 'POST',
    path: '/v1/agent-runs/:id/retry',
    summary: 'Put the item back in the queue',
    tag: 'agent-runs',
    auth: 'admin',
    params: Id,
    body: Empty,
    status: [200],
    response: S.Ok,
  },
  cancelAgentRun: {
    method: 'POST',
    path: '/v1/agent-runs/:id/cancel',
    summary: 'Cancel the run and tell the tracker',
    tag: 'agent-runs',
    auth: 'admin',
    params: Id,
    body: Empty,
    status: [200],
    response: S.Ok,
  },

  events: {
    method: 'GET',
    path: '/v1/events',
    summary:
      'Server-sent events: one LiveEvent per committed change. After (re)connecting, fetch a snapshot.',
    tag: 'events',
    auth: 'admin',
    query: z.object({ taskId: z.uuid().optional(), taskType: z.string().max(128).optional() }),
    status: [200],
    response: S.LiveEvent,
    contentType: 'text/event-stream',
  },
} as const satisfies Record<string, RouteDef>;

export type Routes = typeof routes;
export type RouteId = keyof Routes;
export type ResponseOf<K extends RouteId> = z.output<Routes[K]['response']>;

type Out<T> = T extends ZodType ? z.output<T> : undefined;
/** Parsed, validated route input (no transport details). */
export interface RouteInputBase<K extends RouteId> {
  params: Routes[K] extends { params: infer P } ? Out<P> : undefined;
  query: Routes[K] extends { query: infer Q } ? Out<Q> : undefined;
  body: Routes[K] extends { body: infer B } ? Out<B> : undefined;
}
/** How a package registers handlers for contract routes without depending on the HTTP server. */
export type RegisterRoute = <K extends RouteId>(
  id: K,
  handler: (input: RouteInputBase<K>) => Promise<ResponseOf<K> | void>,
) => void;
