import { formatError } from '../infra/error-format.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { TimePort } from '../infra/port-types.js';
import {
  SettlementLedger,
  type DeclinedSettlementObligation,
  type RemainderSettlementRole,
  type Settlement,
  type SettlementAuthorityReleaseBoundary,
  type SettlementDisposition,
  type SettlementHold,
  type SettlementObligation,
} from '../obligation/settlement.js';
import type { ShutdownObligationSubject } from '../obligation/shutdown-abandonment.js';

export type SuccessorRecoveryEvidence =
  | Readonly<{
      kind: 'durable-cli-runtime';
      jobId: string;
      pid: number;
      leaderIncarnation: ProcessIncarnation;
    }>
  | Readonly<{ kind: 'startup-store-recovery' }>
  | Readonly<{ kind: 'startup-liveness-recovery' }>;

export type UndischargedRemainder =
  | Readonly<{ owner: 'process-exit' }>
  | Readonly<{ owner: 'successor-recovery'; evidence: SuccessorRecoveryEvidence }>;

export type ShutdownHoldReason =
  | 'kb-daemon-shutdown-unsettled'
  | 'process-incarnation-probes-unsettled'
  | 'lifecycle-reactor-disposal-unsettled'
  | 'provider-operation-mutations-unsettled'
  | 'required-shutdown-step-unsettled';

export type ShutdownHoldExit =
  | 'kb-daemon-process-close'
  | 'process-incarnation-probe-settlement'
  | 'lifecycle-reactor-disposal-settlement'
  | 'store-epoch-sweep-settlement'
  | 'admitted-provider-operation-mutation-settlement'
  | 'provider-operation-mutation-admission-availability'
  | 'provider-proxy-set-release-retry'
  | 'shutdown-budget-exhaustion'
  | 'authority-release-settlement';

export type ShutdownOperatorAction =
  | Readonly<{
      kind: 'retained-job-containment';
      jobId: string;
      provider: string;
      jobDir: string;
      actionCommand: string;
    }>
  | Readonly<{
      kind: 'provider-proxy-set-containment';
      proxyInstanceId: string;
      inspectCommand: 'coral-cli backend status';
      actionCommand: 'coral-cli backend provider-proxy-set abandon <set-token>';
    }>
  | Readonly<{
      kind: 'shutdown-obligation-abandonment';
      subject: ShutdownObligationSubject;
      inspectCommand: 'coral-cli backend shutdown-recovery status';
      actionCommand: `coral-cli backend shutdown-recovery abandon ${ShutdownObligationSubject}`;
    }>;

export type ShutdownRetainedAuthority = Readonly<{
  ipcSocket: boolean;
  providerControlProxyInstanceIds: readonly string[];
  cleanupObligations: readonly string[];
  operatorActions: readonly ShutdownOperatorAction[];
}>;

export type ShutdownUndischarged = Readonly<{
  label: string;
  remainder: UndischargedRemainder;
  settlement: Readonly<Pick<Extract<Settlement, { kind: 'declined' }>, 'cause' | 'detail'>>;
}>;

export type ProcessExitRemainder = Readonly<{
  undischarged: readonly ShutdownUndischarged[];
}>;

export type ProcessExitRemainderAcceptance =
  | Readonly<{ kind: 'accepted'; remainder: ProcessExitRemainder; requestExit: (exitCode: number) => void }>
  | Readonly<{ kind: 'refused'; detail: string }>;

type AcceptedProcessExitRemainder = Extract<ProcessExitRemainderAcceptance, { kind: 'accepted' }>;

export type ShutdownSequenceDisposition = SettlementDisposition<
  ShutdownHoldReason,
  ShutdownHoldExit,
  ShutdownUndischarged,
  ShutdownRetainedAuthority,
  AcceptedProcessExitRemainder
>;

export type ShutdownRetainedAuthorityContribution = Readonly<{
  ipcSocket?: boolean;
  providerControlProxyInstanceIds?: readonly string[];
  cleanupObligations?: readonly string[];
}>;

export type ShutdownHold = SettlementHold<ShutdownHoldReason, ShutdownHoldExit>;

export type ShutdownObligation = SettlementObligation<
  UndischargedRemainder,
  ShutdownRetainedAuthorityContribution,
  ShutdownHoldReason,
  ShutdownHoldExit
>;

export type ShutdownAuthorityReleaseBoundary = SettlementAuthorityReleaseBoundary<
  ShutdownRetainedAuthorityContribution,
  ShutdownHoldReason,
  ShutdownHoldExit
>;

export type ShutdownSettlementLedger = SettlementLedger<
  UndischargedRemainder,
  ShutdownRetainedAuthorityContribution,
  ShutdownRetainedAuthority,
  ShutdownHoldReason,
  ShutdownHoldExit,
  AcceptedProcessExitRemainder,
  ShutdownUndischarged
>;

export type ShutdownSettlementLedgerOptions = Readonly<{
  budgetMs: number;
  time: Pick<TimePort, 'monotonicNow' | 'sleep'>;
  log: (message: string) => void;
  pollMs: number;
  acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
}>;

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function foldRetainedAuthority(
  contributions: readonly ShutdownRetainedAuthorityContribution[],
): ShutdownRetainedAuthority {
  return {
    ipcSocket: contributions.some(({ ipcSocket }) => ipcSocket === true),
    providerControlProxyInstanceIds: unique(
      contributions.flatMap(({ providerControlProxyInstanceIds }) => providerControlProxyInstanceIds ?? []),
    ),
    cleanupObligations: unique(contributions.flatMap(({ cleanupObligations }) => cleanupObligations ?? [])),
    operatorActions: [],
  };
}

function defaultHold(): ShutdownHold {
  return {
    reason: 'required-shutdown-step-unsettled',
    exit: 'shutdown-budget-exhaustion',
  };
}

function declinedFailure(
  label: string,
  remainder: UndischargedRemainder,
  settlement: Extract<Settlement, { kind: 'declined' }>,
): ShutdownUndischarged {
  return {
    label,
    remainder,
    settlement: { cause: settlement.cause, detail: settlement.detail },
  };
}

function remainderRole(remainder: UndischargedRemainder): RemainderSettlementRole {
  switch (remainder.owner) {
    case 'process-exit':
      return 'delegable';
    case 'successor-recovery':
      return 'successor';
  }
}

function acceptProcessExitRemainder(
  declined: readonly DeclinedSettlementObligation<
    UndischargedRemainder,
    ShutdownRetainedAuthorityContribution,
    ShutdownHoldReason,
    ShutdownHoldExit
  >[],
  accept: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance,
  log: (message: string) => void,
): AcceptedProcessExitRemainder | null {
  const undischarged = declined.map(({ obligation, settlement }) =>
    declinedFailure(obligation.label, obligation.remainder, settlement),
  );
  const remainder: ProcessExitRemainder = { undischarged };
  try {
    const acceptance = accept(remainder);
    if (acceptance.kind === 'accepted') {
      if (acceptance.remainder === remainder) return acceptance;
      log('process-exit remainder acceptance did not identify the offered remainder\n');
      return null;
    }
    log(`process-exit remainder acceptance refused: ${acceptance.detail}\n`);
  } catch (error: unknown) {
    log(`process-exit remainder acceptance failed: ${formatError(error)}\n`);
  }
  return null;
}

export function createShutdownSettlementLedger(options: ShutdownSettlementLedgerOptions): ShutdownSettlementLedger {
  const accept = options.acceptProcessExitRemainder;
  return new SettlementLedger<
    UndischargedRemainder,
    ShutdownRetainedAuthorityContribution,
    ShutdownRetainedAuthority,
    ShutdownHoldReason,
    ShutdownHoldExit,
    AcceptedProcessExitRemainder,
    ShutdownUndischarged
  >({
    budgetMs: options.budgetMs,
    time: options.time,
    log: options.log,
    pollMs: options.pollMs,
    remainderRole,
    boundaryRemainder: { owner: 'process-exit' },
    ...(accept === undefined
      ? {}
      : {
          acceptDelegatedRemainder: (declined) => acceptProcessExitRemainder(declined, accept, options.log),
        }),
    acceptedUndischarged: (acceptance) => acceptance.remainder.undischarged,
    acceptanceFailureLabel: 'process-exit-remainder-acceptance',
    failure: declinedFailure,
    foldRetainedAuthority,
    defaultHold,
  });
}
