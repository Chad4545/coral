import { z } from 'zod';

import { MAX_PROCESS_INCARNATION_LENGTH, type ProcessIncarnation } from './node-process.js';

export const persistedNonEmptyStringSchema = z.string().min(1);

/** A durable root may not derive from `processIncarnationSchema` in src/infra/node-process.ts (see
 *  tests/invariants/durable-schema-independence.test.ts). */
export const persistedProcessIncarnationSchema = z
  .string()
  .min(1)
  .max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>;
