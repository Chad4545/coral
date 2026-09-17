import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  readShutdownAbandonmentStatus,
  readShutdownRemainderStatus,
  recordShutdownObligationAbandonment,
  recordShutdownRemainder,
} from '#src/coordinator/shutdown-abandonment.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { shutdownObligationSubjects } from '#src/obligation/shutdown-abandonment.js';

const legacyShutdownObligationSubjects = [
  'recovery-coordinator-teardown',
  'kb-child-shutdown',
  'provider-operation-mutation-drain',
  'provider-host-shutdown',
  'child-termination',
  'app-server-handoff-quiesce',
  'provider-host-drain-for-handoff',
  'process-incarnation-probe-shutdown',
  'lifecycle-reactor-dispose',
  'provider-control-and-ipc-authority-release',
] as const;
const legacyShutdownObligationAbandonmentReceiptSchema = z
  .object({
    subject: z.enum(legacyShutdownObligationSubjects),
    instanceId: z.string().min(1),
    recordedAt: z.string().datetime(),
    disposition: z.literal('abandoned-unconfirmed'),
    detail: z.string().min(1),
    statusPath: z.string().min(1),
  })
  .strict();
const legacyShutdownAbandonmentStatusSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(legacyShutdownObligationAbandonmentReceiptSchema).readonly(),
  })
  .strict();

function storageWith(
  initial: string | null,
  publish: boolean = true,
): Pick<StoragePort, 'existsSync' | 'readFileSync' | 'writeAtomicDurableSync'> & {
  readPublished(): string | null;
} {
  let value = initial;
  return {
    existsSync: () => value !== null,
    readFileSync: () => {
      if (value === null) throw new Error('missing');
      return value;
    },
    writeAtomicDurableSync: vi.fn((_path, data) => {
      if (!publish) return false;
      value = String(data);
      return true;
    }),
    readPublished: () => value,
  };
}

describe('shutdown abandonment status', () => {
  it('keeps every record written to the abandonment family readable by the legacy v1 parser', () => {
    const storage = storageWith(null);

    for (const subject of shutdownObligationSubjects) {
      expect(
        recordShutdownObligationAbandonment(
          { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
          { subject, instanceId: `${subject}-instance`, detail: 'completion unconfirmed' },
        ).kind,
      ).toBe('recorded');
      expect(() =>
        legacyShutdownAbandonmentStatusSchema.parse(JSON.parse(storage.readPublished() ?? '')),
      ).not.toThrow();
    }
  });

  it('reads durable receipts for every canonical shutdown-obligation subject', () => {
    const entries = shutdownObligationSubjects.map((subject) => ({
      subject,
      instanceId: `${subject}-instance`,
      recordedAt: '2026-09-07T00:00:00.000Z',
      disposition: 'abandoned-unconfirmed',
      detail: 'completion unconfirmed',
      statusPath: '/run/shutdown-abandonment-status.v1.json',
    }));
    const storage = storageWith(JSON.stringify({ version: 1, entries }));

    expect(readShutdownAbandonmentStatus({ storage, runDir: '/run' })).toEqual({
      kind: 'available',
      path: '/run/shutdown-abandonment-status.v1.json',
      status: { version: 1, entries },
    });
  });

  it('publishes abandoned-unconfirmed status before returning the receipt', () => {
    const storage = storageWith(null);
    const recorded = recordShutdownObligationAbandonment(
      { storage, time: { now: () => 1_725_000_000_000 }, runDir: '/run' },
      {
        subject: 'app-server-handoff-quiesce',
        instanceId: 'current-instance',
        detail: 'App-server write completion was not observed; the write may or may not have landed.',
      },
    );

    expect(recorded).toMatchObject({
      kind: 'recorded',
      receipt: {
        subject: 'app-server-handoff-quiesce',
        instanceId: 'current-instance',
        disposition: 'abandoned-unconfirmed',
        statusPath: '/run/shutdown-abandonment-status.v1.json',
      },
    });
    expect(readShutdownAbandonmentStatus({ storage, runDir: '/run' })).toMatchObject({
      kind: 'available',
      status: {
        entries: [
          expect.objectContaining({
            subject: 'app-server-handoff-quiesce',
            instanceId: 'current-instance',
            disposition: 'abandoned-unconfirmed',
          }),
        ],
      },
    });
  });

  it('refuses abandonment when existing durable status is unreadable', () => {
    const storage = storageWith('{not-json');

    expect(
      recordShutdownObligationAbandonment(
        { storage, time: { now: () => 0 }, runDir: '/run' },
        {
          subject: 'app-server-handoff-quiesce',
          instanceId: 'current-instance',
          detail: 'completion unconfirmed',
        },
      ),
    ).toMatchObject({ kind: 'refused', detail: expect.stringContaining('existing status is unreadable') });
    expect(storage.writeAtomicDurableSync).not.toHaveBeenCalled();
  });

  it('refuses abandonment when atomic durable publication is not confirmed', () => {
    const storage = storageWith(null, false);

    expect(
      recordShutdownObligationAbandonment(
        { storage, time: { now: () => 0 }, runDir: '/run' },
        {
          subject: 'app-server-handoff-quiesce',
          instanceId: 'current-instance',
          detail: 'completion unconfirmed',
        },
      ),
    ).toEqual({ kind: 'refused', detail: 'atomic durable status publication was not confirmed' });
  });

  it('retains another instance only as visible status, not current acceptance state', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        entries: [
          {
            subject: 'app-server-handoff-quiesce',
            instanceId: 'stale-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            disposition: 'abandoned-unconfirmed',
            detail: 'completion unconfirmed',
            statusPath: '/run/shutdown-abandonment-status.v1.json',
          },
        ],
      }),
    );

    const recorded = recordShutdownObligationAbandonment(
      { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
      {
        subject: 'app-server-handoff-quiesce',
        instanceId: 'current-instance',
        detail: 'completion unconfirmed',
      },
    );

    expect(recorded).toMatchObject({ kind: 'recorded', receipt: { instanceId: 'current-instance' } });
    const read = readShutdownAbandonmentStatus({ storage, runDir: '/run' });
    expect(read).toMatchObject({
      kind: 'available',
      status: {
        entries: [
          expect.objectContaining({ instanceId: 'stale-instance' }),
          expect.objectContaining({ instanceId: 'current-instance' }),
        ],
      },
    });
  });
});

describe('shutdown remainder status', () => {
  it('publishes every structured ledger disposition with its shutdown metadata', () => {
    const storage = storageWith(null);

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
        {
          instanceId: 'current-instance',
          reason: 'provider-proxy-lifecycle-fatal',
          mode: 'handoff',
          exitCode: 1,
          undischarged: [
            {
              label: 'pending durable launch settlement',
              remainder: { owner: 'process-exit' },
              settlement: { cause: 'timed-out', detail: 'launch settlement did not finish' },
            },
            {
              label: 'store services availability check',
              remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
              settlement: { cause: 'unconfirmed', detail: 'store availability was not confirmed' },
            },
          ],
        },
      ),
    ).toBe(true);

    expect(storage.writeAtomicDurableSync).toHaveBeenCalledOnce();
    expect(storage.writeAtomicDurableSync).toHaveBeenCalledWith(
      '/run/shutdown-remainder.v1.json',
      `${JSON.stringify(
        {
          version: 1,
          records: [
            {
              instanceId: 'current-instance',
              recordedAt: '2026-09-07T00:00:00.000Z',
              reason: 'provider-proxy-lifecycle-fatal',
              mode: 'handoff',
              exitCode: 1,
              entries: [
                {
                  label: 'pending durable launch settlement',
                  remainder: { owner: 'process-exit' },
                  settlement: { cause: 'timed-out', detail: 'launch settlement did not finish' },
                },
                {
                  label: 'store services availability check',
                  remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
                  settlement: { cause: 'unconfirmed', detail: 'store availability was not confirmed' },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  });

  it('skips an unknown successor evidence kind without rejecting readable entries', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        records: [
          {
            instanceId: 'future-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            reason: 'provider-proxy-lifecycle-fatal',
            mode: 'handoff',
            exitCode: 1,
            entries: [
              {
                label: 'known loss',
                remainder: { owner: 'process-exit' },
                settlement: { cause: 'timed-out', detail: 'known detail' },
              },
              {
                label: 'future successor',
                remainder: {
                  owner: 'successor-recovery',
                  evidence: { kind: 'future-recovery', durableKey: 'future-key' },
                },
                settlement: { cause: 'unconfirmed', detail: 'future recovery owns this' },
              },
            ],
          },
        ],
      }),
    );

    expect(readShutdownRemainderStatus({ storage, runDir: '/run' })).toEqual({
      kind: 'available',
      path: '/run/shutdown-remainder.v1.json',
      status: {
        version: 1,
        records: [
          {
            instanceId: 'future-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            reason: 'provider-proxy-lifecycle-fatal',
            mode: 'handoff',
            exitCode: 1,
            entries: [
              {
                label: 'known loss',
                remainder: { owner: 'process-exit' },
                settlement: { cause: 'timed-out', detail: 'known detail' },
              },
            ],
          },
        ],
      },
      skippedEntries: 1,
    });
  });

  it('counts every malformed entry while retaining the rest of the record', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        records: [
          {
            instanceId: 'malformed-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            reason: 'sigterm',
            mode: 'handoff',
            exitCode: 1,
            entries: [
              {
                label: 'known loss',
                remainder: { owner: 'process-exit' },
                settlement: { cause: 'rejected', detail: 'known detail' },
              },
              { label: 'missing settlement', remainder: { owner: 'process-exit' } },
              'not-an-entry',
            ],
          },
        ],
      }),
    );

    const read = readShutdownRemainderStatus({ storage, runDir: '/run' });
    expect(read).toMatchObject({ kind: 'available', skippedEntries: 2 });
    if (read.kind !== 'available') throw new Error('expected readable remainder status');
    expect(read.status.records[0]?.entries).toHaveLength(1);
  });

  it('replaces an instance before retaining only the latest 32 whole records', () => {
    const storage = storageWith(null);
    let now = 1_788_739_200_000;
    const runtime = { storage, time: { now: () => now++ }, runDir: '/run' };
    const write = (instanceId: string, exitCode: number, entryCount = 1) =>
      recordShutdownRemainder(runtime, {
        instanceId,
        reason: 'sigterm',
        mode: 'handoff',
        exitCode,
        undischarged: Array.from({ length: entryCount }, (_, index) => ({
          label: `${instanceId} loss`,
          remainder: { owner: 'process-exit' },
          settlement: { cause: 'unconfirmed', detail: `${instanceId} detail ${index}` },
        })),
      });

    for (let index = 0; index < 32; index += 1) expect(write(`instance-${index}`, 1)).toBe(true);
    expect(write('instance-31', 2, 40)).toBe(true);
    let read = readShutdownRemainderStatus({ storage, runDir: '/run' });
    if (read.kind !== 'available') throw new Error('expected readable remainder status');
    expect(read.status.records).toHaveLength(32);
    expect(read.status.records[0]?.instanceId).toBe('instance-0');
    expect(read.status.records.at(-1)).toMatchObject({ instanceId: 'instance-31', exitCode: 2 });
    expect(read.status.records.at(-1)?.entries).toHaveLength(40);

    expect(write('instance-32', 1)).toBe(true);
    read = readShutdownRemainderStatus({ storage, runDir: '/run' });
    if (read.kind !== 'available') throw new Error('expected readable remainder status');
    expect(read.status.records).toHaveLength(32);
    expect(read.status.records[0]?.instanceId).toBe('instance-1');
    expect(read.status.records.at(-1)?.instanceId).toBe('instance-32');
    expect(read.status.records.find(({ instanceId }) => instanceId === 'instance-31')?.entries).toHaveLength(40);
  });
});
