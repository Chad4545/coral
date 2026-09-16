import { isRecord } from '../infra/json.js';

/**
 * A lifecycle refusal rides a **success** envelope — a JSON-RPC `response` result and an HTTP 503 body —
 * so a caller decoding results by shape sees a body no domain schema accepts unless it rejects this first.
 */
export const lifecycleRefusalResult = {
  code: 'backend_shutting_down',
  message: 'Backend shutting down',
} as const;

/**
 * Matches on `code` alone: a newer server may add fields to the body, and a reader that required the exact
 * body would fail to recognize the refusal it already understands.
 */
export function isLifecycleRefusalResult(value: unknown): value is { readonly code: 'backend_shutting_down' } {
  return isRecord(value) && value.code === lifecycleRefusalResult.code;
}
