import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

/**
 * Tracing uses the OpenTelemetry API only. Without a registered SDK every
 * span is a no-op; register @opentelemetry/sdk-node in the app entrypoint to
 * export spans (see docs/architecture.md).
 */
const tracer = trace.getTracer('durable-orchestrator', '0.1.0');

export async function withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}
