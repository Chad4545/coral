import { join } from 'node:path';
import { z } from 'zod';

import { MAX_PROCESS_INCARNATION_LENGTH, type ProcessIncarnation } from '../infra/node-process.js';
import type { StoragePort, TimePort } from '../infra/port-types.js';
import { nowIsoString } from '../infra/time.js';
import {
  type ShutdownObligationAbandonmentReceipt,
  type ShutdownObligationSubject,
  createShutdownObligationAbandonmentReceiptParser,
  shutdownObligationSubjects,
} from '../obligation/shutdown-abandonment.js';
import type { ShutdownMode, ShutdownReason } from './shutdown.js';
import type { ShutdownUndischarged, SuccessorRecoveryEvidence, UndischargedRemainder } from './shutdown-settlement.js';

const SHUTDOWN_ABANDONMENT_STATUS_VERSION = 1;
const SHUTDOWN_REMAINDER_VERSION = 1;
const MAX_SHUTDOWN_REMAINDER_RECORDS = 32;
const durableShutdownObligationSubjectSchema = z.enum(shutdownObligationSubjects);
const durableShutdownObligationAbandonmentReceiptSchema = createShutdownObligationAbandonmentReceiptParser(
  durableShutdownObligationSubjectSchema,
);
const shutdownAbandonmentStatusSchema = z
  .object({
    version: z.literal(SHUTDOWN_ABANDONMENT_STATUS_VERSION),
    entries: z.array(durableShutdownObligationAbandonmentReceiptSchema).readonly(),
  })
  .strict();

export type ShutdownAbandonmentStatus = z.infer<typeof shutdownAbandonmentStatusSchema>;

export type ShutdownAbandonmentStatusRead =
  | Readonly<{ kind: 'available'; path: string; status: ShutdownAbandonmentStatus }>
  | Readonly<{ kind: 'absent'; path: string }>
  | Readonly<{ kind: 'unreadable'; path: string; detail: string }>;

type ShutdownAbandonmentRuntime = Readonly<{
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'writeAtomicDurableSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
}>;

export function shutdownAbandonmentStatusPath(runDir: string): string {
  return join(runDir, 'shutdown-abandonment-status.v1.json');
}

export function readShutdownAbandonmentStatus(
  runtime: Pick<ShutdownAbandonmentRuntime, 'storage' | 'runDir'>,
): ShutdownAbandonmentStatusRead {
  const path = shutdownAbandonmentStatusPath(runtime.runDir);
  if (!runtime.storage.existsSync(path)) return { kind: 'absent', path };
  try {
    const parsed = shutdownAbandonmentStatusSchema.safeParse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')));
    return parsed.success
      ? { kind: 'available', path, status: parsed.data }
      : { kind: 'unreadable', path, detail: parsed.error.message };
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recordShutdownObligationAbandonment(
  runtime: ShutdownAbandonmentRuntime,
  input: Readonly<{ subject: ShutdownObligationSubject; instanceId: string; detail: string }>,
):
  | Readonly<{ kind: 'recorded'; receipt: ShutdownObligationAbandonmentReceipt }>
  | Readonly<{ kind: 'refused'; detail: string }> {
  const current = readShutdownAbandonmentStatus(runtime);
  if (current.kind === 'unreadable') {
    return { kind: 'refused', detail: `existing status is unreadable: ${current.detail}` };
  }
  const path = current.path;
  const receipt: ShutdownObligationAbandonmentReceipt = {
    subject: input.subject,
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    disposition: 'abandoned-unconfirmed',
    detail: input.detail,
    statusPath: path,
  };
  const entries = current.kind === 'available' ? current.status.entries : [];
  const status: ShutdownAbandonmentStatus = {
    version: SHUTDOWN_ABANDONMENT_STATUS_VERSION,
    entries: [
      ...entries.filter((entry) => entry.instanceId !== input.instanceId || entry.subject !== input.subject),
      receipt,
    ],
  };
  try {
    const published = runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return published
      ? { kind: 'recorded', receipt }
      : { kind: 'refused', detail: 'atomic durable status publication was not confirmed' };
  } catch (error: unknown) {
    return { kind: 'refused', detail: error instanceof Error ? error.message : String(error) };
  }
}

type ShutdownRemainderRuntime = Readonly<{
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'writeAtomicDurableSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
}>;

const settlementCauseSchema = z.enum(['rejected', 'timed-out', 'budget-exhausted', 'unconfirmed', 'aborted']);
const durableProcessIncarnationSchema = z
  .string()
  .min(1)
  .max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>;
const successorRecoveryEvidenceSchema: z.ZodType<SuccessorRecoveryEvidence> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('durable-cli-runtime'),
      jobId: z.string(),
      pid: z.number().int().positive(),
      leaderIncarnation: durableProcessIncarnationSchema,
    })
    .passthrough(),
  z.object({ kind: z.literal('startup-store-recovery') }).passthrough(),
  z.object({ kind: z.literal('startup-liveness-recovery') }).passthrough(),
]);
const undischargedRemainderSchema: z.ZodType<UndischargedRemainder> = z.discriminatedUnion('owner', [
  z.object({ owner: z.literal('process-exit') }).passthrough(),
  z
    .object({
      owner: z.literal('successor-recovery'),
      evidence: successorRecoveryEvidenceSchema,
    })
    .passthrough(),
]);
const shutdownRemainderEntrySchema: z.ZodType<ShutdownUndischarged> = z
  .object({
    label: z.string(),
    remainder: undischargedRemainderSchema,
    settlement: z
      .object({
        cause: settlementCauseSchema,
        detail: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
const shutdownRemainderRecordEnvelopeSchema = z
  .object({
    instanceId: z.string().min(1),
    recordedAt: z.string().datetime(),
    reason: z.string().min(1),
    mode: z.enum(['handoff', 'hard']),
    exitCode: z.number().int().nonnegative(),
    entries: z.array(z.unknown()).readonly(),
  })
  .passthrough();
const shutdownRemainderStatusEnvelopeSchema = z
  .object({
    version: z.literal(SHUTDOWN_REMAINDER_VERSION),
    records: z.array(z.unknown()).readonly(),
  })
  .passthrough();

export type ShutdownRemainderRecord = Readonly<{
  instanceId: string;
  recordedAt: string;
  reason: string;
  mode: ShutdownMode;
  exitCode: number;
  entries: readonly ShutdownUndischarged[];
}>;

export type ShutdownRemainderStatus = Readonly<{
  version: typeof SHUTDOWN_REMAINDER_VERSION;
  records: readonly ShutdownRemainderRecord[];
}>;

export type ShutdownRemainderStatusRead =
  | Readonly<{ kind: 'available'; path: string; status: ShutdownRemainderStatus; skippedEntries: number }>
  | Readonly<{ kind: 'absent'; path: string }>
  | Readonly<{ kind: 'unreadable'; path: string; detail: string }>;

export type ShutdownRemainderRecordInput = Readonly<{
  instanceId: string;
  reason: ShutdownReason;
  mode: ShutdownMode;
  exitCode: number;
  undischarged: readonly ShutdownUndischarged[];
}>;

type ReadableShutdownRemainderDocument = Readonly<{
  document: Omit<z.infer<typeof shutdownRemainderStatusEnvelopeSchema>, 'records'> & {
    records: readonly z.infer<typeof shutdownRemainderRecordEnvelopeSchema>[];
  };
  status: ShutdownRemainderStatus;
  skippedEntries: number;
}>;

function decodeShutdownRemainderDocument(
  value: unknown,
):
  | Readonly<{ kind: 'readable'; value: ReadableShutdownRemainderDocument }>
  | Readonly<{ kind: 'unreadable'; detail: string }> {
  const envelope = shutdownRemainderStatusEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { kind: 'unreadable', detail: envelope.error.message };

  const rawRecords: z.infer<typeof shutdownRemainderRecordEnvelopeSchema>[] = [];
  const records: ShutdownRemainderRecord[] = [];
  let skippedEntries = 0;
  for (const rawRecord of envelope.data.records) {
    const parsedRecord = shutdownRemainderRecordEnvelopeSchema.safeParse(rawRecord);
    if (!parsedRecord.success) return { kind: 'unreadable', detail: parsedRecord.error.message };
    rawRecords.push(parsedRecord.data);

    const entries: ShutdownUndischarged[] = [];
    for (const rawEntry of parsedRecord.data.entries) {
      const parsedEntry = shutdownRemainderEntrySchema.safeParse(rawEntry);
      if (parsedEntry.success) entries.push(parsedEntry.data);
      else skippedEntries += 1;
    }
    records.push({
      instanceId: parsedRecord.data.instanceId,
      recordedAt: parsedRecord.data.recordedAt,
      reason: parsedRecord.data.reason,
      mode: parsedRecord.data.mode,
      exitCode: parsedRecord.data.exitCode,
      entries,
    });
  }

  return {
    kind: 'readable',
    value: {
      document: { ...envelope.data, records: rawRecords },
      status: { version: SHUTDOWN_REMAINDER_VERSION, records },
      skippedEntries,
    },
  };
}

export function shutdownRemainderPath(runDir: string): string {
  return join(runDir, `shutdown-remainder.v${SHUTDOWN_REMAINDER_VERSION}.json`);
}

export function readShutdownRemainderStatus(
  runtime: Pick<ShutdownRemainderRuntime, 'storage' | 'runDir'>,
): ShutdownRemainderStatusRead {
  const path = shutdownRemainderPath(runtime.runDir);
  if (!runtime.storage.existsSync(path)) return { kind: 'absent', path };
  try {
    const decoded = decodeShutdownRemainderDocument(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')));
    return decoded.kind === 'readable'
      ? {
          kind: 'available',
          path,
          status: decoded.value.status,
          skippedEntries: decoded.value.skippedEntries,
        }
      : { kind: 'unreadable', path, detail: decoded.detail };
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recordShutdownRemainder(
  runtime: ShutdownRemainderRuntime,
  input: ShutdownRemainderRecordInput,
): boolean {
  const path = shutdownRemainderPath(runtime.runDir);
  let document: ReadableShutdownRemainderDocument['document'] = {
    version: SHUTDOWN_REMAINDER_VERSION,
    records: [],
  };
  if (runtime.storage.existsSync(path)) {
    try {
      const decoded = decodeShutdownRemainderDocument(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')));
      if (decoded.kind === 'unreadable') return false;
      document = decoded.value.document;
    } catch {
      return false;
    }
  }

  const record: ShutdownRemainderRecord = {
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    reason: input.reason,
    mode: input.mode,
    exitCode: input.exitCode,
    entries: input.undischarged,
  };
  const records = [...document.records.filter((existing) => existing.instanceId !== input.instanceId), record].slice(
    -MAX_SHUTDOWN_REMAINDER_RECORDS,
  );
  return runtime.storage.writeAtomicDurableSync(
    path,
    `${JSON.stringify({ ...document, version: SHUTDOWN_REMAINDER_VERSION, records }, null, 2)}\n`,
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
}
