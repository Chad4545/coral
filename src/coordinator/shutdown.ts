import type { Server, ServerResponse } from 'node:http';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import { formatError } from '../infra/error-format.js';
import {
  terminateProcessIncarnationProbes,
  type ProcessIncarnationProbeCleanupDisposition,
} from '../infra/node-process.js';
import { createJoinableSettlementTask, type SettlementConfirmation } from '../obligation/settlement.js';
import type { Runtime } from '../runtime/ports.js';
import type { IpcListener } from '../transport/ipc/server.js';
import type { ShutdownObligationSubject } from '../obligation/shutdown-abandonment.js';
import type { StoreServicesRef } from './composition/store-services-ref.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type {
  ChildTerminationDisposition,
  LaunchTerminationFn,
  PendingLaunchSettlementDisposition,
} from './live/admission.js';
import type { IdleTimer } from './live/idle.js';
import type {
  ProviderHostCleanupObligations,
  ProviderHostLifecycle,
  ProviderHostQuiescenceReceipt,
} from './live/provider-hosts/index.js';
import type { KbDaemonSupervisor } from './live/kb-daemon-supervisor.js';
import type { ProviderProxyAuthorityRegistry, ProviderProxySetAuthority } from './live/provider-proxy/authority.js';
import type { RuntimeComponentRegistry } from './runtime-components/registry.js';
import type { ProviderOperationReconcilerStopDisposition } from './services/provider-operation-reconciler.js';
import {
  createShutdownSettlementLedger,
  type ProcessExitRemainder,
  type ProcessExitRemainderAcceptance,
  type ShutdownAuthorityReleaseBoundary,
  type ShutdownObligation,
  type ShutdownRetainedAuthorityContribution,
  type ShutdownSequenceDisposition,
  type ShutdownSettlementLedger,
} from './shutdown-settlement.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;

export type ShutdownMode = 'handoff' | 'hard';

const SHUTDOWN_REASONS = [
  'replaced',
  'sigterm',
  'sigint',
  'handoff',
  'provider-proxy-lifecycle-fatal',
  'idle',
  'test-teardown',
] as const;

export type ShutdownReason = (typeof SHUTDOWN_REASONS)[number];

const shutdownReasons: ReadonlySet<string> = new Set(SHUTDOWN_REASONS);

export function isShutdownReason(reason: string): reason is ShutdownReason {
  return shutdownReasons.has(reason);
}

export function shutdownModeFromReason(reason: ShutdownReason): ShutdownMode {
  if (reason === 'replaced' || reason === 'sigterm' || reason === 'provider-proxy-lifecycle-fatal') return 'handoff';
  return 'hard';
}

export type LifecycleWiringState = {
  ownershipCheckerTeardown: (() => void) | null;
};

interface ShutdownRuntimeState {
  setLifecycle(state: 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped'): void;
  readonly components: RuntimeComponentRegistry;
}

type RunShutdownSequenceContext = {
  reason: ShutdownReason;
  state: LifecycleWiringState;
  teardownRecoveryCoordinator: () => Promise<void>;
  runtimeState: ShutdownRuntimeState;
  idleTimer: IdleTimer;
  closeServerFn: (server: Server) => Promise<void>;
  closeIpcServerFn?: (listener: IpcListener) => Promise<void>;
  waitForInflightDrain: (
    idleTimer: IdleTimer,
    timeoutMs: number,
    time: Pick<Runtime['time'], 'clearInterval' | 'now' | 'setInterval'>,
  ) => Promise<void>;
  server: Server;
  ipcServer?: IpcListener;
  streamResponses: Set<ServerResponse>;
  runtime: Runtime;
  markJobsAsErrorFn: (message: string, signal: AbortSignal) => void | Promise<void>;
  providerHostManager: ProviderHostLifecycle;
  providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  stopProviderOperationReconciler?: () => ProviderOperationReconcilerStopDisposition;
  kbDaemonSupervisor?: KbDaemonSupervisor;
  storeServicesRef: StoreServicesRef;
  terminateAllFn: LaunchTerminationFn;
  handoffQuiescePorts: () => readonly HandoffQuiescePort[];
  handoffDrainBudgetMs?: number;
  disposeLifecycleReactor: () => void | Promise<void>;
  hooks: { onShutdown(mode: ShutdownMode, signal: AbortSignal): Promise<void> };
  discussStores: Map<string, DiscussSessionStore>;
  stopStoreEpochSweepFn?: () => Promise<void>;
  log: (message: string) => void;
  isShutdownObligationAbandoned?: (subject: ShutdownObligationSubject) => boolean;
  acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
};

type UnresolvedChildProcess = Extract<
  ChildTerminationDisposition,
  { kind: 'children-unresolved-at-deadline' }
>['processes'][number];

function unresolvedChildProcessDetail(process: UnresolvedChildProcess): string {
  switch (process.kind) {
    case 'ownership-retained':
      return `pid ${process.pid}: ${process.reason}`;
    case 'signal-refused':
      return `pid ${process.pid}: ${process.reason}`;
    case 'signal-delivered-escalation-unavailable':
      return `pid ${process.pid}: ${process.signal} delivered, escalation ${process.reason}`;
    case 'signal-failed':
      return `pid ${process.pid}: ${process.signal} ${process.reason}`;
    case 'target-unobservable':
    case 'target-alive':
      return `pid ${process.pid}: ${process.kind} ${process.stage}`;
  }
}

function pendingLaunchSettlementConfirmation(disposition: PendingLaunchSettlementDisposition): SettlementConfirmation {
  if (disposition.kind === 'all-pending-launches-settled') return { confirmed: true };
  const retainedLaunches = disposition.retainedLaunches
    .map((launch) => `${launch.provider}:${launch.jobDir} awaiting wrapper identity`)
    .join('; ');
  return {
    confirmed: false,
    detail:
      `${disposition.pendingLaunches} pending launch(es) remain owned by ${disposition.owner}` +
      `${retainedLaunches.length === 0 ? '' : ` (${retainedLaunches})`}.`,
  };
}

function childTerminationConfirmation(disposition: ChildTerminationDisposition): SettlementConfirmation {
  if (disposition.kind === 'all-children-observed-absent') return { confirmed: true };
  const observations = disposition.processes.map(unresolvedChildProcessDetail).join('; ');
  const retainedProcesses = disposition.retainedProcesses
    .map((process) => `${process.provider}:${process.jobDir} pgid ${process.containment.processGroupId}`)
    .join('; ');
  return {
    confirmed: false,
    detail:
      `${disposition.cleanupHandles} cleanup handle(s) remain owned by ${disposition.owner}` +
      `${observations.length === 0 && retainedProcesses.length === 0 ? '' : ` (${[observations, retainedProcesses].filter(Boolean).join('; ')})`}.`,
  };
}

async function reapProviderProxySets(
  sets: readonly ProviderProxySetAuthority[],
  acquisitionHolds: ProviderHostQuiescenceReceipt['acquisitionCleanupHolds'],
  signal: AbortSignal,
): Promise<SettlementConfirmation> {
  const setOutcomes = Promise.allSettled(sets.map((set) => set.stopAndReap(signal)));
  const acquisitionOutcomes = Promise.allSettled(acquisitionHolds.map((hold) => hold.recoveryCapability.retry(signal)));
  const [outcomes, holdOutcomes] = await Promise.all([setOutcomes, acquisitionOutcomes]);
  const unconfirmed = outcomes.flatMap((outcome, index) => {
    const proxy = sets[index].proxyInstanceId;
    if (outcome.status === 'rejected') return [`${proxy}: ${formatError(outcome.reason)}`];
    return 'unconfirmed' in outcome.value ? [`${proxy}: ${outcome.value.unconfirmed}`] : [];
  });
  const unconfirmedHolds = holdOutcomes.flatMap((outcome, index) => {
    const hold = acquisitionHolds[index];
    const label = acquisitionCleanupHoldLabel(hold);
    if (outcome.status === 'rejected') return [label + ': ' + formatError(outcome.reason)];
    return outcome.value.kind === 'held' ? [label + ': ' + outcome.value.reason] : [];
  });
  const failures = [...unconfirmed, ...unconfirmedHolds];
  return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
}

function acquisitionCleanupHoldLabel(
  hold: ProviderHostQuiescenceReceipt['acquisitionCleanupHolds'][number],
  prefix = '',
): string {
  if (hold.kind !== 'provider_proxy_acquisition_held') return `${prefix}acquisition ${hold.target}`;
  if ('guardianIdentity' in hold) return `${prefix}acquisition guardian pid ${hold.guardianIdentity.pid}`;
  if (hold.recoverySubject.kind === 'spawned-process-group') {
    return `${prefix}acquisition process group ${hold.recoverySubject.processGroupId}`;
  }
  return `${prefix}acquisition unattributable process group (exit: provider-proxy acquisition abandonment)`;
}

async function releaseIpcSocket(
  ipcServer: IpcListener | undefined,
  closeIpcServerFn: ((listener: IpcListener) => Promise<void>) | undefined,
): Promise<void> {
  if (ipcServer === undefined || closeIpcServerFn === undefined) return;
  await closeIpcServerFn(ipcServer);
}

type AuthorityReleaseOutcome = Readonly<{ ok: true } | { ok: false; error: unknown }>;

type AuthorityReleaseCapability = {
  readonly label: string;
  readonly release: () => void | Promise<void>;
  state:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'in-flight'; settlement: Promise<AuthorityReleaseOutcome> }>
    | Readonly<{ kind: 'settled' }>;
};

function startAuthorityRelease(capability: AuthorityReleaseCapability): Promise<AuthorityReleaseOutcome> {
  if (capability.state.kind === 'settled') return Promise.resolve({ ok: true });
  if (capability.state.kind === 'in-flight') return capability.state.settlement;
  const release = Promise.resolve().then(capability.release);
  const settlement = release.then<AuthorityReleaseOutcome, AuthorityReleaseOutcome>(
    () => {
      capability.state = { kind: 'settled' };
      return { ok: true };
    },
    (error: unknown) => {
      capability.state = { kind: 'pending' };
      return { ok: false, error };
    },
  );
  capability.state = { kind: 'in-flight', settlement };
  return settlement;
}

async function settleAuthorityReleases(
  capabilities: readonly AuthorityReleaseCapability[],
): Promise<SettlementConfirmation> {
  const outcomes = await Promise.all(capabilities.map(startAuthorityRelease));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.ok ? [] : [`${capabilities[index].label}: ${formatError(outcome.error)}`],
  );
  return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
}

function confirmedTask(task: () => unknown | Promise<unknown>): Promise<SettlementConfirmation> {
  return Promise.resolve()
    .then(task)
    .then(() => ({ confirmed: true }));
}

function cleanupContribution(
  label: string,
  extra: ShutdownRetainedAuthorityContribution = {},
): ShutdownRetainedAuthorityContribution {
  return { ...extra, cleanupObligations: [label, ...(extra.cleanupObligations ?? [])] };
}

function closingHostDetail(closing: ProviderHostCleanupObligations['closingHosts'][number]): string {
  const containment = closing.containment;
  const exit =
    'kind' in closing && closing.kind === 'provider-server-shutdown-held'
      ? closing.operatorExit.kind
      : 'closing settlement';
  return containment === null
    ? `${closing.label} containment unconfirmed; exit=${exit}`
    : `${closing.label} pid ${containment.pid} pgid ${containment.processGroupId}; exit=${exit}`;
}

function providerCleanupConfirmation(
  cleanup: SettlementConfirmation,
  closingHosts: ProviderHostCleanupObligations['closingHosts'],
  representationReleaseHolds: ProviderHostCleanupObligations['representationReleaseHolds'],
): SettlementConfirmation {
  if (!cleanup.confirmed) return cleanup;
  const pending = [
    ...closingHosts.map(closingHostDetail),
    ...representationReleaseHolds.map(
      (hold) =>
        `${hold.label}: ${hold.pendingOperations.join(', ') || 'capsule retirement'}; ` +
        `disposition=${hold.disposition.kind}; exit=${hold.exit}`,
    ),
  ];
  return pending.length === 0 ? cleanup : { confirmed: false, detail: pending.join('; ') };
}

type ShutdownAbandonmentCheck = (subject: ShutdownObligationSubject) => boolean;

type OpeningShutdownObligationsContext = Pick<
  RunShutdownSequenceContext,
  | 'closeServerFn'
  | 'idleTimer'
  | 'reason'
  | 'runtime'
  | 'server'
  | 'state'
  | 'streamResponses'
  | 'teardownRecoveryCoordinator'
  | 'waitForInflightDrain'
> & {
  readonly kbDaemonSupervisor: RunShutdownSequenceContext['kbDaemonSupervisor'];
  readonly ledger: ShutdownSettlementLedger;
  readonly shutdownObligationAbandoned: ShutdownAbandonmentCheck;
};

type OpeningShutdownObligationBatches = Readonly<{
  connectionDrain: readonly ShutdownObligation[];
  buildTeardownObligations(): readonly ShutdownObligation[];
}>;

function buildOpeningShutdownObligations({
  closeServerFn,
  idleTimer,
  kbDaemonSupervisor,
  ledger,
  reason,
  runtime,
  server,
  state,
  streamResponses,
  teardownRecoveryCoordinator,
  waitForInflightDrain,
  shutdownObligationAbandoned,
}: OpeningShutdownObligationsContext): OpeningShutdownObligationBatches {
  const serverClose = createJoinableSettlementTask(() => closeServerFn(server));
  serverClose.start();

  const connectionDrain: readonly ShutdownObligation[] = [
    {
      label: 'inflight drain',
      task: () => confirmedTask(() => waitForInflightDrain(idleTimer, ledger.remainingBudgetMs(), runtime.time)),
      retainedAuthority: () => cleanupContribution('inflight drain'),
      remainder: { owner: 'process-exit' },
    },
    {
      label: 'server connection close',
      task: () => confirmedTask(() => server.closeAllConnections()),
      retainedAuthority: () => cleanupContribution('server connection close'),
      remainder: { owner: 'process-exit' },
    },
  ];
  const buildTeardownObligations = (): readonly ShutdownObligation[] => {
    let ownershipCheckerTeardownFn: (() => void) | null = null;
    let ownershipCheckerTeardownCaptured = false;
    const obligations: ShutdownObligation[] = [
      ...[...streamResponses].map((stream, index): ShutdownObligation => {
        const label = `stream response close ${index + 1}`;
        return {
          label,
          task: () => confirmedTask(() => stream.end()),
          retainedAuthority: () => cleanupContribution(label),
          remainder: { owner: 'process-exit' },
        };
      }),
      {
        label: 'server close',
        task: () => confirmedTask(serverClose.run),
        retainedAuthority: () => cleanupContribution('server close'),
        remainder: { owner: 'process-exit' },
      },
      {
        label: 'recovery coordinator teardown',
        task: () =>
          shutdownObligationAbandoned('recovery-coordinator-teardown')
            ? Promise.resolve({ confirmed: true })
            : confirmedTask(teardownRecoveryCoordinator),
        retainedAuthority: () => cleanupContribution('recovery coordinator teardown'),
        remainder: { owner: 'process-exit' },
      },
      {
        label: 'ownership checker teardown',
        task: () =>
          confirmedTask(() => {
            if (!ownershipCheckerTeardownCaptured) {
              ownershipCheckerTeardownFn = state.ownershipCheckerTeardown;
              ownershipCheckerTeardownCaptured = true;
            }
            ownershipCheckerTeardownFn?.();
            state.ownershipCheckerTeardown = null;
          }),
        retainedAuthority: () => cleanupContribution('ownership checker teardown'),
        remainder: { owner: 'process-exit' },
      },
    ];

    if (kbDaemonSupervisor !== undefined) {
      let kbDaemonHold: Awaited<ReturnType<KbDaemonSupervisor['dispose']>> | null = null;
      obligations.push({
        label: 'kb child shutdown',
        task: async (signal) => {
          if (shutdownObligationAbandoned('kb-child-shutdown')) return { confirmed: true };
          kbDaemonHold = await kbDaemonSupervisor.dispose(reason, { signal });
          return kbDaemonHold.kind === 'confirmed-absent'
            ? { confirmed: true }
            : { confirmed: false, detail: kbDaemonHold.reason };
        },
        retainedAuthority: () => cleanupContribution('kb child shutdown'),
        remainder: { owner: 'process-exit' },
        hold: () =>
          kbDaemonHold?.kind === 'holding'
            ? {
                reason: 'kb-daemon-shutdown-unsettled',
                exit: kbDaemonHold.exit,
                retryAfter: kbDaemonHold.retryAfter,
              }
            : {
                reason: 'required-shutdown-step-unsettled',
                exit: 'shutdown-budget-exhaustion',
              },
      });
    }

    return obligations;
  };

  return { connectionDrain, buildTeardownObligations };
}

type ProviderCleanupController = Readonly<{
  clearAcquisitionCleanupHolds(): void;
  current(): ProviderHostCleanupObligations;
  hold: NonNullable<ShutdownObligation['hold']>;
  refresh(receipt?: ProviderHostQuiescenceReceipt): void;
  retainedAuthority(label: string): ShutdownRetainedAuthorityContribution;
}>;

function createProviderCleanupController({
  providerHostManager,
  providerProxyAuthority,
}: {
  readonly providerHostManager: RunShutdownSequenceContext['providerHostManager'];
  readonly providerProxyAuthority: RunShutdownSequenceContext['providerProxyAuthority'];
}): ProviderCleanupController {
  let providerCleanup: ProviderHostCleanupObligations = {
    liveProxySets: providerProxyAuthority?.liveSets() ?? [],
    acquisitionCleanupHolds: [],
    closingHosts: [],
    representationReleaseHolds: [],
  };
  const refresh = (receipt?: ProviderHostQuiescenceReceipt): void => {
    const snapshot = providerHostManager.cleanupObligations?.() ?? receipt;
    if (snapshot === undefined) return;
    providerCleanup = {
      ...snapshot,
      representationReleaseHolds: 'representationReleaseHolds' in snapshot ? snapshot.representationReleaseHolds : [],
    };
  };
  const retainedAuthority = (label: string): ShutdownRetainedAuthorityContribution => {
    refresh();
    const providerControlProxyInstanceIds = providerCleanup.liveProxySets.map(({ proxyInstanceId }) => proxyInstanceId);
    const acquisitionLabels = providerCleanup.acquisitionCleanupHolds.map((hold) =>
      acquisitionCleanupHoldLabel(hold, 'provider '),
    );
    const representationReleaseLabels = providerCleanup.representationReleaseHolds.flatMap((hold) => [
      hold.label,
      ...hold.pendingOperations,
    ]);
    return cleanupContribution(label, {
      providerControlProxyInstanceIds,
      cleanupObligations: [
        ...acquisitionLabels,
        ...representationReleaseLabels,
        ...providerCleanup.closingHosts.map(closingHostDetail),
      ],
    });
  };
  const hold = () => {
    refresh();
    const representationReleaseRetryPending = providerCleanup.representationReleaseHolds.some(
      ({ disposition }) => disposition.kind !== 'fatal-successor-pending',
    );
    const cleanupSettlements = [
      ...providerCleanup.closingHosts.map(({ settlement }) => settlement),
      ...providerCleanup.representationReleaseHolds.map(({ settlement }) => settlement),
    ];
    return {
      reason: 'required-shutdown-step-unsettled' as const,
      exit: representationReleaseRetryPending
        ? ('provider-proxy-set-release-retry' as const)
        : ('shutdown-budget-exhaustion' as const),
      ...(cleanupSettlements.length === 0
        ? {}
        : { retryAfter: Promise.allSettled(cleanupSettlements).then(() => undefined) }),
    };
  };

  return {
    clearAcquisitionCleanupHolds(): void {
      providerCleanup = { ...providerCleanup, acquisitionCleanupHolds: [] };
    },
    current: (): ProviderHostCleanupObligations => providerCleanup,
    hold,
    refresh,
    retainedAuthority,
  };
}

type ProviderOperationMutationDrainContext = {
  readonly ledger: ShutdownSettlementLedger;
  readonly providerProxyAuthority: RunShutdownSequenceContext['providerProxyAuthority'];
  readonly providerRecoveryObligation: ShutdownObligation;
  readonly shutdownObligationAbandoned: ShutdownAbandonmentCheck;
  readonly stopProviderOperationReconciler: RunShutdownSequenceContext['stopProviderOperationReconciler'];
};

function buildProviderOperationMutationDrainObligation({
  ledger,
  providerProxyAuthority,
  providerRecoveryObligation,
  shutdownObligationAbandoned,
  stopProviderOperationReconciler,
}: ProviderOperationMutationDrainContext): ShutdownObligation {
  let drain: ProviderOperationReconcilerStopDisposition | null = null;
  let hold: Extract<ProviderOperationReconcilerStopDisposition, { kind: 'holding' }> | null = null;
  return {
    label: 'provider operation mutation drain',
    task: async () => {
      if (shutdownObligationAbandoned('provider-operation-mutation-drain')) return { confirmed: true };
      if (!ledger.isDischarged(providerRecoveryObligation)) {
        return {
          confirmed: false,
          detail: 'provider operation mutation admission remains open while provider recovery is held',
        };
      }
      if (drain === null) {
        drain = stopProviderOperationReconciler?.() ?? { kind: 'drained' as const };
        hold = drain.kind === 'holding' ? drain : null;
      }
      if (drain.kind === 'holding') {
        await drain.retryAfter;
        drain = stopProviderOperationReconciler?.() ?? { kind: 'drained' as const };
      }
      hold = drain.kind === 'holding' ? drain : null;
      return drain.kind === 'drained'
        ? { confirmed: true }
        : {
            confirmed: false,
            detail: `provider operation mutations remain admitted; exit=${drain.exit}`,
          };
    },
    retainedAuthority: () =>
      cleanupContribution('provider operation mutation drain', {
        ipcSocket: true,
        providerControlProxyInstanceIds:
          providerProxyAuthority?.liveSets().map(({ proxyInstanceId }) => proxyInstanceId) ?? [],
        cleanupObligations: hold?.pendingMutations ?? [],
      }),
    remainder: { owner: 'process-exit' },
    hold: () =>
      hold === null
        ? {
            reason: 'required-shutdown-step-unsettled',
            exit: 'shutdown-budget-exhaustion',
          }
        : {
            reason: 'provider-operation-mutations-unsettled',
            exit: hold.exit,
            retryAfter: hold.retryAfter,
          },
  };
}

type ModeShutdownConsequences = Readonly<{
  obligations: readonly ShutdownObligation[];
  providerOperationMutationDrain: ShutdownObligation;
}>;

type HardShutdownConsequencesContext = Pick<
  RunShutdownSequenceContext,
  'markJobsAsErrorFn' | 'providerHostManager' | 'storeServicesRef' | 'terminateAllFn'
> & {
  readonly ledger: ShutdownSettlementLedger;
  readonly providerCleanup: ProviderCleanupController;
  readonly providerProxyAuthority: RunShutdownSequenceContext['providerProxyAuthority'];
  readonly shutdownObligationAbandoned: ShutdownAbandonmentCheck;
  readonly stopProviderOperationReconciler: RunShutdownSequenceContext['stopProviderOperationReconciler'];
};

function buildHardShutdownConsequences({
  ledger,
  markJobsAsErrorFn,
  providerCleanup,
  providerHostManager,
  providerProxyAuthority,
  shutdownObligationAbandoned,
  stopProviderOperationReconciler,
  storeServicesRef,
  terminateAllFn,
}: HardShutdownConsequencesContext): ModeShutdownConsequences {
  let storeServicesAvailable = false;
  const storeServicesCheck: ShutdownObligation = {
    label: 'store services availability check',
    task: () =>
      confirmedTask(() => {
        storeServicesAvailable = storeServicesRef.tryGet() !== null;
      }),
    retainedAuthority: () => cleanupContribution('store services availability check'),
    remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
  };
  const providerHostShutdown: ShutdownObligation = {
    label: 'provider host shutdown',
    task: async (signal) => {
      if (shutdownObligationAbandoned('provider-host-shutdown')) return { confirmed: true };
      let receipt: ProviderHostQuiescenceReceipt | undefined;
      try {
        receipt = await providerHostManager.shutdown(signal);
      } finally {
        providerCleanup.refresh(receipt);
      }
      const snapshot = providerCleanup.current();
      const cleanup = await reapProviderProxySets(snapshot.liveProxySets, snapshot.acquisitionCleanupHolds, signal);
      providerCleanup.refresh();
      if (cleanup.confirmed) providerCleanup.clearAcquisitionCleanupHolds();
      const refreshed = providerCleanup.current();
      return providerCleanupConfirmation(cleanup, refreshed.closingHosts, refreshed.representationReleaseHolds);
    },
    retainedAuthority: () => {
      const retained = providerCleanup.retainedAuthority('provider host shutdown');
      return cleanupContribution('provider host shutdown', {
        ...retained,
        cleanupObligations: retained.cleanupObligations?.filter((label) => label !== 'provider host shutdown'),
      });
    },
    remainder: { owner: 'process-exit' },
    hold: providerCleanup.hold,
  };
  const providerOperationMutationDrain = buildProviderOperationMutationDrainObligation({
    ledger,
    providerProxyAuthority,
    providerRecoveryObligation: providerHostShutdown,
    shutdownObligationAbandoned,
    stopProviderOperationReconciler,
  });
  const pendingLaunchSettlement: ShutdownObligation = {
    label: 'pending launch settlement',
    task: async (signal) => {
      if (shutdownObligationAbandoned('child-termination')) return { confirmed: true };
      const disposition = await terminateAllFn('pending-launch-settlement', signal);
      if (
        disposition.kind === 'all-children-observed-absent' ||
        disposition.kind === 'children-unresolved-at-deadline'
      ) {
        throw new Error(`Pending launch settlement returned child termination disposition ${disposition.kind}.`);
      }
      return pendingLaunchSettlementConfirmation(disposition);
    },
    retainedAuthority: () => cleanupContribution('pending launch settlement'),
    remainder: { owner: 'process-exit' },
  };
  const childTermination: ShutdownObligation = {
    label: 'child termination',
    task: async (signal) => {
      if (shutdownObligationAbandoned('child-termination')) return { confirmed: true };
      const disposition = await terminateAllFn('registered-child-termination', signal);
      if (
        disposition.kind === 'all-pending-launches-settled' ||
        disposition.kind === 'pending-launches-unresolved-at-deadline'
      ) {
        throw new Error(`Child termination returned pending launch disposition ${disposition.kind}.`);
      }
      return childTerminationConfirmation(disposition);
    },
    retainedAuthority: () => cleanupContribution('child termination'),
    remainder: { owner: 'process-exit' },
  };
  const crashedJobTerminalization: ShutdownObligation = {
    label: 'crashed job terminalization',
    task: (signal) => {
      if (!ledger.isDischarged(storeServicesCheck)) {
        return Promise.resolve({ confirmed: false, detail: 'terminalization awaits the store availability check' });
      }
      if (!storeServicesAvailable) return Promise.resolve({ confirmed: true });
      if (
        !ledger.isDischarged(providerHostShutdown) ||
        !ledger.isDischarged(providerOperationMutationDrain) ||
        !ledger.isDischarged(pendingLaunchSettlement) ||
        !ledger.isDischarged(childTermination)
      ) {
        return Promise.resolve({
          confirmed: false,
          detail: 'terminalization awaits provider-host recovery, mutation drain, and child containment discharge',
        });
      }
      return confirmedTask(() => markJobsAsErrorFn('Backend shutting down', signal));
    },
    retainedAuthority: () => cleanupContribution('crashed job terminalization'),
    remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-liveness-recovery' } },
  };

  return {
    obligations: [
      storeServicesCheck,
      providerHostShutdown,
      providerOperationMutationDrain,
      pendingLaunchSettlement,
      childTermination,
      crashedJobTerminalization,
    ],
    providerOperationMutationDrain,
  };
}

type HandoffShutdownConsequencesContext = Pick<
  RunShutdownSequenceContext,
  'handoffQuiescePorts' | 'providerHostManager'
> & {
  readonly ledger: ShutdownSettlementLedger;
  readonly providerCleanup: ProviderCleanupController;
  readonly providerProxyAuthority: RunShutdownSequenceContext['providerProxyAuthority'];
  readonly shutdownObligationAbandoned: ShutdownAbandonmentCheck;
  readonly stopProviderOperationReconciler: RunShutdownSequenceContext['stopProviderOperationReconciler'];
};

function buildHandoffShutdownConsequences({
  handoffQuiescePorts,
  ledger,
  providerCleanup,
  providerHostManager,
  providerProxyAuthority,
  shutdownObligationAbandoned,
  stopProviderOperationReconciler,
}: HandoffShutdownConsequencesContext): ModeShutdownConsequences {
  const appServerHandoffQuiesce: ShutdownObligation = {
    label: 'app-server handoff quiesce',
    task: async () => {
      if (shutdownObligationAbandoned('app-server-handoff-quiesce')) return { confirmed: true };
      const outcomes = await Promise.allSettled(
        handoffQuiescePorts().map((port) => port.quiesceAppServerJobsForHandoff()),
      );
      const failures = outcomes.flatMap((outcome, index) =>
        outcome.status === 'rejected' ? [`port ${index + 1}: ${formatError(outcome.reason)}`] : [],
      );
      return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
    },
    retainedAuthority: () => cleanupContribution('app-server handoff quiesce'),
    remainder: { owner: 'process-exit' },
  };
  const providerHostDrain: ShutdownObligation = {
    label: 'provider host drain for handoff',
    task: async (signal) => {
      if (shutdownObligationAbandoned('provider-host-drain-for-handoff')) return { confirmed: true };
      let receipt: ProviderHostQuiescenceReceipt | undefined;
      try {
        receipt = await providerHostManager.drainForHandoff(signal);
      } finally {
        providerCleanup.refresh(receipt);
      }
      const cleanup = await reapProviderProxySets([], providerCleanup.current().acquisitionCleanupHolds, signal);
      providerCleanup.refresh();
      if (cleanup.confirmed) providerCleanup.clearAcquisitionCleanupHolds();
      const refreshed = providerCleanup.current();
      return providerCleanupConfirmation(cleanup, refreshed.closingHosts, refreshed.representationReleaseHolds);
    },
    retainedAuthority: () => {
      const retained = providerCleanup.retainedAuthority('provider host drain for handoff');
      return cleanupContribution('provider host drain for handoff', {
        ...retained,
        cleanupObligations: retained.cleanupObligations?.filter((label) => label !== 'provider host drain for handoff'),
      });
    },
    remainder: { owner: 'process-exit' },
    hold: providerCleanup.hold,
  };
  const providerOperationMutationDrain = buildProviderOperationMutationDrainObligation({
    ledger,
    providerProxyAuthority,
    providerRecoveryObligation: providerHostDrain,
    shutdownObligationAbandoned,
    stopProviderOperationReconciler,
  });

  return {
    obligations: [appServerHandoffQuiesce, providerHostDrain, providerOperationMutationDrain],
    providerOperationMutationDrain,
  };
}

type ClosingShutdownObligationsContext = Pick<
  RunShutdownSequenceContext,
  'discussStores' | 'disposeLifecycleReactor' | 'hooks' | 'log' | 'runtimeState'
> & {
  readonly ledger: ShutdownSettlementLedger;
  readonly mode: ShutdownMode;
  readonly providerOperationMutationDrain: ShutdownObligation;
  readonly shutdownObligationAbandoned: ShutdownAbandonmentCheck;
};

type ClosingShutdownObligationBatches = Readonly<{
  lifecycle: readonly ShutdownObligation[];
  buildStoreAndFinalizerObligations(): readonly ShutdownObligation[];
}>;

function buildClosingShutdownObligations({
  discussStores,
  disposeLifecycleReactor,
  hooks,
  ledger,
  log,
  mode,
  providerOperationMutationDrain,
  runtimeState,
  shutdownObligationAbandoned,
}: ClosingShutdownObligationsContext): ClosingShutdownObligationBatches {
  const lifecycle: readonly ShutdownObligation[] = [
    {
      label: 'components disposeAll',
      task: (signal) =>
        ledger.isDischarged(providerOperationMutationDrain)
          ? confirmedTask(() => runtimeState.components.disposeAll(signal))
          : Promise.resolve({
              confirmed: false,
              detail: 'component disposal awaits provider operation mutation drain',
            }),
      retainedAuthority: () => cleanupContribution('components disposeAll'),
      remainder: { owner: 'process-exit' },
    },
    {
      label: 'hooks.onShutdown',
      task: (signal) => confirmedTask(() => hooks.onShutdown(mode, signal)),
      retainedAuthority: () => cleanupContribution('hooks.onShutdown'),
      remainder: { owner: 'process-exit' },
    },
  ];
  const buildStoreAndFinalizerObligations = (): readonly ShutdownObligation[] => {
    const obligations: ShutdownObligation[] = [...discussStores].map(([source, store]): ShutdownObligation => {
      const label = `discuss store '${source}' dispose`;
      return {
        label,
        task: () => confirmedTask(() => store.dispose()),
        retainedAuthority: () => cleanupContribution(label),
        remainder: { owner: 'process-exit' },
      };
    });

    let probeRetryAfter: Promise<void> | null = null;
    obligations.push({
      label: 'process incarnation probe shutdown',
      task: async (signal) => {
        if (shutdownObligationAbandoned('process-incarnation-probe-shutdown')) return { confirmed: true };
        const disposition: ProcessIncarnationProbeCleanupDisposition = await terminateProcessIncarnationProbes(signal);
        if (disposition.disposition === 'settled') {
          probeRetryAfter = null;
          return { confirmed: true };
        }
        probeRetryAfter = disposition.untilSettled;
        const detail = disposition.unsettled
          .map((hold) =>
            'key' in hold
              ? `probe ${hold.key}: ${hold.reason}; exit=${hold.exit}`
              : `pid ${hold.pid ?? 'unknown'}: ${hold.reason}; exit=${hold.exit}`,
          )
          .join('; ');
        log(`process incarnation probe shutdown held (${detail})\n`);
        return { confirmed: false, detail };
      },
      retainedAuthority: () => cleanupContribution('process incarnation probe shutdown'),
      remainder: { owner: 'process-exit' },
      hold: () =>
        probeRetryAfter === null
          ? {
              reason: 'required-shutdown-step-unsettled',
              exit: 'shutdown-budget-exhaustion',
            }
          : {
              reason: 'process-incarnation-probes-unsettled',
              exit: 'process-incarnation-probe-settlement',
              retryAfter: probeRetryAfter,
            },
    });

    const reactorDisposal = createJoinableSettlementTask(disposeLifecycleReactor);
    obligations.push({
      label: 'lifecycle reactor dispose',
      task: () =>
        shutdownObligationAbandoned('lifecycle-reactor-dispose')
          ? Promise.resolve({ confirmed: true })
          : confirmedTask(reactorDisposal.run),
      retainedAuthority: () => cleanupContribution('lifecycle reactor dispose'),
      remainder: { owner: 'process-exit' },
      hold: () => {
        const settlement = reactorDisposal.settlement();
        return settlement === null
          ? {
              reason: 'required-shutdown-step-unsettled',
              exit: 'shutdown-budget-exhaustion',
            }
          : {
              reason: 'lifecycle-reactor-disposal-unsettled',
              exit: 'lifecycle-reactor-disposal-settlement',
              retryAfter: settlement,
            };
      },
    });

    return obligations;
  };

  return { lifecycle, buildStoreAndFinalizerObligations };
}

type AuthorityReleaseBoundaryContext = {
  readonly closeIpcServerFn: RunShutdownSequenceContext['closeIpcServerFn'];
  readonly ipcServer: RunShutdownSequenceContext['ipcServer'];
  readonly providerCleanup: ProviderCleanupController;
  readonly providerProxyAuthority: RunShutdownSequenceContext['providerProxyAuthority'];
  readonly shutdownObligationAbandoned: ShutdownAbandonmentCheck;
  readonly time: Runtime['time'];
};

function buildAuthorityReleaseBoundary({
  closeIpcServerFn,
  ipcServer,
  providerCleanup,
  providerProxyAuthority,
  shutdownObligationAbandoned,
  time,
}: AuthorityReleaseBoundaryContext): ShutdownAuthorityReleaseBoundary {
  const providerReleaseCapabilities = new Map<
    ProviderProxySetAuthority,
    Readonly<{ heartbeat: AuthorityReleaseCapability; control: AuthorityReleaseCapability }>
  >();
  let authorityReleaseGeneration = 0;
  const synchronizeProviderReleaseCapabilities = (): void => {
    const sets = new Set([...(providerProxyAuthority?.liveSets() ?? []), ...providerCleanup.current().liveProxySets]);
    let changed = false;
    for (const set of sets) {
      if (providerReleaseCapabilities.has(set)) continue;
      providerReleaseCapabilities.set(set, {
        heartbeat: {
          label: `heartbeats ${set.proxyInstanceId}`,
          release: () => set.stopHeartbeats(),
          state: { kind: 'pending' },
        },
        control: {
          label: `control ${set.proxyInstanceId}`,
          release: () => set.initiateControlClose(),
          state: { kind: 'pending' },
        },
      });
      changed = true;
    }
    if (changed) authorityReleaseGeneration += 1;
  };
  const ipcReleaseCapability: AuthorityReleaseCapability | null =
    ipcServer === undefined || closeIpcServerFn === undefined
      ? null
      : {
          label: 'IPC socket',
          release: () => releaseIpcSocket(ipcServer, closeIpcServerFn),
          state: { kind: 'pending' },
        };
  const authorityReleaseSettlements = (): readonly Promise<AuthorityReleaseOutcome>[] => {
    const capabilities = [...providerReleaseCapabilities.values()].flatMap(({ heartbeat, control }) => [
      heartbeat,
      control,
    ]);
    if (ipcReleaseCapability !== null) capabilities.push(ipcReleaseCapability);
    return capabilities.flatMap((capability) =>
      capability.state.kind === 'in-flight' ? [capability.state.settlement] : [],
    );
  };
  type AuthorityReleaseSnapshot = Readonly<{
    generation: number;
    heartbeats: readonly AuthorityReleaseCapability[];
    controls: readonly AuthorityReleaseCapability[];
    ipc: AuthorityReleaseCapability | null;
  }>;
  const authorityReleaseSnapshots = new WeakMap<object, AuthorityReleaseSnapshot>();
  const snapshotAuthorityRelease = (): AuthorityReleaseSnapshot => {
    const releases = [...providerReleaseCapabilities.values()];
    return {
      generation: authorityReleaseGeneration,
      heartbeats: releases.map(({ heartbeat }) => heartbeat),
      controls: releases.map(({ control }) => control),
      ipc: ipcReleaseCapability,
    };
  };
  const sameCapabilities = (
    left: readonly AuthorityReleaseCapability[],
    right: readonly AuthorityReleaseCapability[],
  ): boolean => left.length === right.length && left.every((capability, index) => capability === right[index]);

  return {
    label: 'provider control and IPC authority release',
    prepare: () => {
      if (shutdownObligationAbandoned('provider-control-and-ipc-authority-release')) {
        const token = Object.freeze({});
        authorityReleaseSnapshots.set(token, snapshotAuthorityRelease());
        return Promise.resolve({ confirmed: true, token });
      }
      synchronizeProviderReleaseCapabilities();
      const token = Object.freeze({});
      authorityReleaseSnapshots.set(token, snapshotAuthorityRelease());
      return Promise.resolve({ confirmed: true, token });
    },
    commit: (token) => {
      if (shutdownObligationAbandoned('provider-control-and-ipc-authority-release')) {
        return Promise.resolve({ confirmed: true });
      }
      synchronizeProviderReleaseCapabilities();
      const prepared = authorityReleaseSnapshots.get(token);
      const current = snapshotAuthorityRelease();
      if (
        prepared === undefined ||
        prepared.generation !== current.generation ||
        !sameCapabilities(prepared.heartbeats, current.heartbeats) ||
        !sameCapabilities(prepared.controls, current.controls) ||
        prepared.ipc !== current.ipc
      ) {
        return Promise.resolve({ confirmed: false, detail: 'authority capabilities changed after preparation' });
      }
      return settleAuthorityReleases([...prepared.heartbeats, ...prepared.controls]).then((providerControl) => {
        if (!providerControl.confirmed) return providerControl;
        return prepared.ipc === null ? { confirmed: true as const } : settleAuthorityReleases([prepared.ipc]);
      });
    },
    retainedAuthority: () => {
      providerCleanup.refresh();
      synchronizeProviderReleaseCapabilities();
      const retainedProviderIds = [
        ...new Set(
          [...providerReleaseCapabilities.entries()].flatMap(([set, release]) =>
            release.heartbeat.state.kind === 'settled' && release.control.state.kind === 'settled'
              ? []
              : [set.proxyInstanceId],
          ),
        ),
      ];
      return cleanupContribution('provider control and IPC authority release', {
        ipcSocket: ipcReleaseCapability !== null && ipcReleaseCapability.state.kind !== 'settled',
        providerControlProxyInstanceIds: retainedProviderIds,
      });
    },
    hold: (settlement) => {
      const inFlight = authorityReleaseSettlements();
      return settlement.cause === 'timed-out' && inFlight.length > 0
        ? {
            reason: 'required-shutdown-step-unsettled',
            exit: 'authority-release-settlement',
            retryAfter: Promise.race([Promise.all(inFlight), time.sleep(SHUTDOWN_POLL_MS)]).then(() => undefined),
          }
        : {
            reason: 'required-shutdown-step-unsettled',
            exit: 'shutdown-budget-exhaustion',
          };
    },
  };
}

/** Authority release must remain behind the settlement ledger's no-successor gate. */
export async function runShutdownSequence({
  reason,
  state,
  teardownRecoveryCoordinator,
  runtimeState,
  idleTimer,
  closeServerFn,
  closeIpcServerFn,
  waitForInflightDrain,
  server,
  ipcServer,
  streamResponses,
  runtime,
  markJobsAsErrorFn,
  providerHostManager,
  providerProxyAuthority,
  stopProviderOperationReconciler,
  kbDaemonSupervisor,
  storeServicesRef,
  terminateAllFn,
  handoffQuiescePorts,
  handoffDrainBudgetMs,
  disposeLifecycleReactor,
  hooks,
  discussStores,
  stopStoreEpochSweepFn,
  log,
  isShutdownObligationAbandoned,
  acceptProcessExitRemainder,
}: RunShutdownSequenceContext): Promise<ShutdownSequenceDisposition> {
  const mode = shutdownModeFromReason(reason);
  const budgetMs = mode === 'handoff' ? (handoffDrainBudgetMs ?? HANDOFF_DRAIN_TIMEOUT_MS) : SHUTDOWN_DRAIN_TIMEOUT_MS;
  const ledger = createShutdownSettlementLedger({
    budgetMs,
    time: runtime.time,
    log,
    pollMs: SHUTDOWN_POLL_MS,
    ...(acceptProcessExitRemainder === undefined ? {} : { acceptProcessExitRemainder }),
  });
  const shutdownObligationAbandoned: ShutdownAbandonmentCheck = (subject) =>
    isShutdownObligationAbandoned?.(subject) === true;
  log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
  runtimeState.setLifecycle('draining');
  idleTimer.stopWatching();
  if (stopStoreEpochSweepFn !== undefined) {
    const storeEpochSweepCancellation = createJoinableSettlementTask(stopStoreEpochSweepFn);
    void (await ledger.run({
      label: 'store epoch sweep cancellation',
      task: () => confirmedTask(storeEpochSweepCancellation.run),
      retainedAuthority: () => cleanupContribution('store epoch sweep cancellation'),
      remainder: { owner: 'process-exit' },
      hold: () => {
        const settlement = storeEpochSweepCancellation.settlement();
        return settlement === null
          ? {
              reason: 'required-shutdown-step-unsettled',
              exit: 'store-epoch-sweep-settlement',
            }
          : {
              reason: 'required-shutdown-step-unsettled',
              exit: 'store-epoch-sweep-settlement',
              retryAfter: settlement,
            };
      },
    }));
  }

  const openingObligations = buildOpeningShutdownObligations({
    closeServerFn,
    idleTimer,
    kbDaemonSupervisor,
    ledger,
    reason,
    runtime,
    server,
    state,
    streamResponses,
    teardownRecoveryCoordinator,
    waitForInflightDrain,
    shutdownObligationAbandoned,
  });
  for (const obligation of openingObligations.connectionDrain) {
    void (await ledger.run(obligation));
  }
  for (const obligation of openingObligations.buildTeardownObligations()) {
    void (await ledger.run(obligation));
  }

  const providerCleanup = createProviderCleanupController({ providerHostManager, providerProxyAuthority });
  const modeConsequences =
    mode === 'hard'
      ? buildHardShutdownConsequences({
          ledger,
          markJobsAsErrorFn,
          providerCleanup,
          providerHostManager,
          providerProxyAuthority,
          shutdownObligationAbandoned,
          stopProviderOperationReconciler,
          storeServicesRef,
          terminateAllFn,
        })
      : buildHandoffShutdownConsequences({
          handoffQuiescePorts,
          ledger,
          providerCleanup,
          providerHostManager,
          providerProxyAuthority,
          shutdownObligationAbandoned,
          stopProviderOperationReconciler,
        });
  for (const obligation of modeConsequences.obligations) {
    void (await ledger.run(obligation));
  }

  const closingObligations = buildClosingShutdownObligations({
    discussStores,
    disposeLifecycleReactor,
    hooks,
    ledger,
    log,
    mode,
    providerOperationMutationDrain: modeConsequences.providerOperationMutationDrain,
    runtimeState,
    shutdownObligationAbandoned,
  });
  for (const obligation of closingObligations.lifecycle) {
    void (await ledger.run(obligation));
  }
  for (const obligation of closingObligations.buildStoreAndFinalizerObligations()) {
    void (await ledger.run(obligation));
  }

  const authorityRelease = buildAuthorityReleaseBoundary({
    closeIpcServerFn,
    ipcServer,
    providerCleanup,
    providerProxyAuthority,
    shutdownObligationAbandoned,
    time: runtime.time,
  });

  return ledger.gate(authorityRelease);
}
