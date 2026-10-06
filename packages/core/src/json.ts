import { DomainError } from './errors';

export const MAX_PAYLOAD_BYTES = 256 * 1024;

const encoder = new TextEncoder();

export function jsonByteSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value ?? null)).length;
}

export function assertPayloadSize(field: string, value: unknown, limit = MAX_PAYLOAD_BYTES): void {
  const size = jsonByteSize(value);
  if (size > limit) {
    throw new DomainError('PAYLOAD_TOO_LARGE', `${field} is ${size} bytes; limit is ${limit}`, {
      field,
      size,
      limit,
    });
  }
}
