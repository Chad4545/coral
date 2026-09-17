import { formatError } from '../infra/error-format.js';
import type { TimePort } from '../infra/port-types.js';
import { isAbortError } from '../runtime/abort.js';

export type Settlement =
  | Readonly<{ kind: 'discharged' }>
  | Readonly<{
      kind: 'declined';
      cause: 'rejected' | 'timed-out' | 'budget-exhausted' | 'unconfirmed' | 'aborted';
      detail: string;
      error?: unknown;
    }>;

export type SettlementConfirmation = Readonly<{ confirmed: true }> | Readonly<{ confirmed: false; detail: string }>;

export type SettlementHold<Reason, Exit> = Readonly<{
  reason: Reason;
  exit: Exit;
  retryAfter?: Promise<void>;
}>;

export type SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit> = Readonly<{
  label: string;
  task: (signal: AbortSignal) => Promise<SettlementConfirmation>;
  retainedAuthority: () => RetainedAuthorityContribution;
  remainder: Remainder;
  hold?: (settlement: Extract<Settlement, { kind: 'declined' }>) => SettlementHold<Reason, Exit>;
}>;

export type SettlementAuthorityPreparation =
  | Readonly<{ confirmed: true; token: object }>
  | Readonly<{ confirmed: false; detail: string }>;

export type SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit> = Readonly<{
  label: string;
  prepare: (signal: AbortSignal) => Promise<SettlementAuthorityPreparation>;
  commit: (token: object, signal: AbortSignal) => Promise<SettlementConfirmation>;
  retainedAuthority: () => RetainedAuthorityContribution;
  hold?: (settlement: Extract<Settlement, { kind: 'declined' }>) => SettlementHold<Reason, Exit>;
}>;

export type SettledSettlementDisposition = Readonly<{ disposition: 'settled' }>;

export type DelegatedSettlementDisposition<Failure, Acceptance> = Readonly<{
  disposition: 'delegated';
  undischarged: readonly Failure[];
  acceptance: Acceptance;
}>;

export type UnacceptedSettlementDisposition<Failure> = Readonly<{
  disposition: 'unaccepted';
  undischarged: readonly Failure[];
}>;

export interface HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition> {
  readonly disposition: 'held';
  readonly reason: Reason;
  readonly exit: Exit;
  readonly retryAfter: Promise<void>;
  readonly undischarged: readonly Failure[];
  readonly retainedAuthority: RetainedAuthority;
  readonly retry: () => Promise<Disposition>;
}

export interface TransferPendingSettlementDisposition<
  Reason,
  Exit,
  Failure,
  RetainedAuthority,
  Acceptance,
  Disposition,
> {
  readonly disposition: 'transfer-pending';
  readonly reason: Reason;
  readonly exit: Exit;
  readonly retryAfter: Promise<void>;
  readonly undischarged: readonly Failure[];
  readonly acceptance: Acceptance;
  readonly boundaryFailure: Failure;
  readonly retainedAuthority: RetainedAuthority;
  readonly retry: () => Promise<Disposition>;
}

export type SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance> =
  | SettledSettlementDisposition
  | DelegatedSettlementDisposition<Failure, Acceptance>
  | UnacceptedSettlementDisposition<Failure>
  | TransferPendingSettlementDisposition<
      Reason,
      Exit,
      Failure,
      RetainedAuthority,
      Acceptance,
      SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>
    >
  | HeldSettlementDisposition<
      Reason,
      Exit,
      Failure,
      RetainedAuthority,
      SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>
    >;

export class SettlementGate<
  Reason,
  Exit,
  Failure,
  RetainedAuthority,
  Acceptance,
  Disposition = SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>,
> {
  settled(): SettledSettlementDisposition {
    return { disposition: 'settled' };
  }

  delegated(
    value: Omit<DelegatedSettlementDisposition<Failure, Acceptance>, 'disposition'>,
  ): DelegatedSettlementDisposition<Failure, Acceptance> {
    return { disposition: 'delegated', ...value };
  }

  unaccepted(
    value: Omit<UnacceptedSettlementDisposition<Failure>, 'disposition'>,
  ): UnacceptedSettlementDisposition<Failure> {
    return { disposition: 'unaccepted', ...value };
  }

  held(
    value: Omit<HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition>, 'disposition'>,
  ): HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition> {
    return { disposition: 'held', ...value };
  }

  transferPending(
    value: Omit<
      TransferPendingSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance, Disposition>,
      'disposition'
    >,
  ): TransferPendingSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance, Disposition> {
    return { disposition: 'transfer-pending', ...value };
  }
}

export type RemainderSettlementRole = 'blocking' | 'delegable' | 'successor';

export type DeclinedSettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit> = Readonly<{
  obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>;
  settlement: Extract<Settlement, { kind: 'declined' }>;
}>;

type ObligationState = Readonly<{ kind: 'pending' }> | Readonly<{ kind: 'settled'; settlement: Settlement }>;

type SettlementAttempt<T> = Readonly<{
  abort: AbortController;
  outcome: Promise<T>;
}>;

type BoundaryAttemptState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'preparing'; attempt: SettlementAttempt<SettlementAuthorityPreparation> }>
  | Readonly<{ kind: 'prepared'; token: object }>
  | Readonly<{ kind: 'committing'; token: object; attempt: SettlementAttempt<SettlementConfirmation> }>;

type BoundaryPreparationAttempt =
  | Readonly<{ kind: 'prepared'; settlement: Extract<Settlement, { kind: 'discharged' }>; token: object }>
  | Readonly<{ kind: 'declined'; settlement: Extract<Settlement, { kind: 'declined' }> }>;

type RemainderAcceptanceState<Acceptance, Failure> =
  | Readonly<{ kind: 'unattempted' }>
  | Readonly<{ kind: 'accepted'; acceptance: Acceptance }>
  | Readonly<{ kind: 'failed'; failure: Failure }>;

const BOUNDARY_TRANSFER_ATTEMPT_LIMIT = 3;

type GateResolution<Acceptance, Disposition> =
  | Readonly<{ kind: 'initial' }>
  | Readonly<{
      kind: 'held';
      boundaryFailure: Extract<Settlement, { kind: 'declined' }> | null;
      retry?: () => Promise<Disposition>;
    }>
  | Readonly<{
      kind: 'terminal';
      boundaryFailure: Extract<Settlement, { kind: 'declined' }> | null;
    }>
  | Readonly<{
      kind: 'transfer-pending';
      acceptance: Acceptance;
      failure: Extract<Settlement, { kind: 'declined' }>;
    }>;

export type SettlementLedgerOptions<
  Remainder,
  RetainedAuthorityContribution,
  RetainedAuthority,
  Reason,
  Exit,
  Acceptance,
  Failure,
> = Readonly<{
  budgetMs: number;
  time: Pick<TimePort, 'monotonicNow' | 'sleep'>;
  log: (message: string) => void;
  pollMs: number;
  remainderRole: (remainder: Remainder) => RemainderSettlementRole;
  boundaryRemainder: Remainder;
  acceptDelegatedRemainder?: (
    declined: readonly DeclinedSettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>[],
  ) => Acceptance | null;
  acceptedUndischarged: (acceptance: Acceptance) => readonly Failure[];
  acceptanceFailureLabel: string;
  failure: (label: string, remainder: Remainder, settlement: Extract<Settlement, { kind: 'declined' }>) => Failure;
  foldRetainedAuthority: (contributions: readonly RetainedAuthorityContribution[]) => RetainedAuthority;
  defaultHold: () => SettlementHold<Reason, Exit>;
}>;

type JoinableOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;

export type JoinableSettlementTask<T> = Readonly<{
  start(): void;
  run(): Promise<T>;
  settlement(): Promise<void> | null;
}>;

/** A retry may start a new attempt only after the preceding attempt has settled. */
export function createJoinableSettlementTask<T>(task: () => T | Promise<T>): JoinableSettlementTask<T> {
  let state:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'in-flight'; outcome: Promise<JoinableOutcome<T>> }>
    | Readonly<{ kind: 'settled'; value: T }> = { kind: 'pending' };

  const start = (): Promise<JoinableOutcome<T>> => {
    if (state.kind === 'settled') return Promise.resolve<JoinableOutcome<T>>({ ok: true, value: state.value });
    if (state.kind === 'in-flight') return state.outcome;
    const outcome = Promise.resolve()
      .then(task)
      .then<JoinableOutcome<T>, JoinableOutcome<T>>(
        (value) => {
          state = { kind: 'settled', value };
          return { ok: true, value };
        },
        (error: unknown) => {
          state = { kind: 'pending' };
          return { ok: false, error };
        },
      );
    state = { kind: 'in-flight', outcome };
    return outcome;
  };

  return {
    start: () => {
      void start();
    },
    run: async () => {
      const outcome = await start();
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    },
    settlement: () =>
      state.kind === 'in-flight'
        ? state.outcome.then(() => undefined)
        : state.kind === 'settled'
          ? Promise.resolve()
          : null,
  };
}

function startSettlementAttempt<T>(task: (signal: AbortSignal) => Promise<T>): SettlementAttempt<T> {
  const abort = new AbortController();
  return {
    abort,
    outcome: Promise.resolve().then(() => task(abort.signal)),
  };
}

type AttemptSettlement<T> =
  | Readonly<{ settlement: Settlement; kind: 'completed'; value?: T }>
  | Readonly<{
      settlement: Extract<Settlement, { kind: 'declined' }> & Readonly<{ cause: 'timed-out' }>;
      kind: 'in-flight';
    }>;

async function settleAttempt<T>(
  label: string,
  attempt: SettlementAttempt<T>,
  confirmation: (value: T) => SettlementConfirmation,
  remainingBudget: () => number,
  time: Pick<TimePort, 'sleep'>,
  log: (message: string) => void,
): Promise<AttemptSettlement<T>> {
  const budget = remainingBudget();
  if (budget <= 0) {
    const settlement = {
      kind: 'declined',
      cause: 'budget-exhausted',
      detail: 'no drain budget remained',
    } as const;
    log(`${label}: skipped (drain budget exhausted)\n`);
    return { kind: 'completed', settlement };
  }

  const timedOut = Symbol('timedOut');
  const timeoutAbort = new AbortController();
  try {
    const result = await Promise.race<T | typeof timedOut>([
      attempt.outcome,
      time.sleep(budget, { signal: timeoutAbort.signal }).then(() => timedOut),
    ]);
    if (result === timedOut) {
      attempt.abort.abort();
      const settlement = {
        kind: 'declined',
        cause: 'timed-out',
        detail: `exceeded ${budget}ms`,
      } as const;
      log(`${label}: exceeded drain budget after ${budget}ms\n`);
      return { kind: 'in-flight', settlement };
    }
    const confirmed = confirmation(result);
    if (!confirmed.confirmed) {
      const settlement = { kind: 'declined', cause: 'unconfirmed', detail: confirmed.detail } as const;
      log(`${label} settlement unconfirmed: ${confirmed.detail}\n`);
      return { kind: 'completed', settlement, value: result };
    }
    return { kind: 'completed', settlement: { kind: 'discharged' }, value: result };
  } catch (error: unknown) {
    const settlement = {
      kind: 'declined',
      cause: isAbortError(error) ? 'aborted' : 'rejected',
      detail: formatError(error),
      error,
    } as const;
    log(`${label} settlement failed: ${formatError(error)}\n`);
    return { kind: 'completed', settlement };
  } finally {
    timeoutAbort.abort();
  }
}

/** Boundary exhaustion must terminate without rerunning registered obligations. */
export class SettlementLedger<
  Remainder,
  RetainedAuthorityContribution,
  RetainedAuthority,
  Reason,
  Exit,
  Acceptance,
  Failure,
> {
  private readonly dispositions = new SettlementGate<Reason, Exit, Failure, RetainedAuthority, Acceptance>();
  private readonly entries = new Map<
    SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
    ObligationState
  >();
  private readonly obligationAttempts = new Map<
    SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
    SettlementAttempt<SettlementConfirmation>
  >();
  private readonly boundaryAttempts = new WeakMap<
    SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    BoundaryAttemptState
  >();
  private readonly boundaryTransferAttemptsStarted = new WeakMap<
    SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    number
  >();
  private readonly options: SettlementLedgerOptions<
    Remainder,
    RetainedAuthorityContribution,
    RetainedAuthority,
    Reason,
    Exit,
    Acceptance,
    Failure
  >;
  private deadlineMonotonicMs: bigint;
  private remainderAcceptance: RemainderAcceptanceState<Acceptance, Failure> = { kind: 'unattempted' };

  constructor(
    options: SettlementLedgerOptions<
      Remainder,
      RetainedAuthorityContribution,
      RetainedAuthority,
      Reason,
      Exit,
      Acceptance,
      Failure
    >,
  ) {
    this.options = options;
    this.deadlineMonotonicMs = options.time.monotonicNow() + BigInt(options.budgetMs);
  }

  private register(obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>): void {
    if (!this.entries.has(obligation)) this.entries.set(obligation, { kind: 'pending' });
  }

  private remainingBudget = (): number =>
    Math.max(0, Number(this.deadlineMonotonicMs - this.options.time.monotonicNow()));

  remainingBudgetMs(): number {
    return this.remainingBudget();
  }

  isDischarged(obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>): boolean {
    const state = this.entries.get(obligation);
    return state?.kind === 'settled' && state.settlement.kind === 'discharged';
  }

  async run(
    obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<Settlement> {
    this.register(obligation);
    const prior = this.entries.get(obligation);
    if (prior?.kind === 'settled') return prior.settlement;
    if (this.remainingBudget() <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
        detail: 'no drain budget remained',
      } as const;
      this.options.log(`${obligation.label}: skipped (drain budget exhausted)\n`);
      this.entries.set(obligation, { kind: 'settled', settlement });
      return settlement;
    }
    let attempt = this.obligationAttempts.get(obligation);
    if (attempt === undefined) {
      attempt = startSettlementAttempt(obligation.task);
      this.obligationAttempts.set(obligation, attempt);
      const trackedAttempt = attempt;
      void trackedAttempt.outcome.then(
        (confirmation) => {
          if (this.obligationAttempts.get(obligation) !== trackedAttempt) return;
          this.obligationAttempts.delete(obligation);
          this.entries.set(obligation, {
            kind: 'settled',
            settlement: confirmation.confirmed
              ? { kind: 'discharged' }
              : { kind: 'declined', cause: 'unconfirmed', detail: confirmation.detail },
          });
        },
        (error: unknown) => {
          if (this.obligationAttempts.get(obligation) !== trackedAttempt) return;
          this.obligationAttempts.delete(obligation);
          this.entries.set(obligation, {
            kind: 'settled',
            settlement: {
              kind: 'declined',
              cause: isAbortError(error) ? 'aborted' : 'rejected',
              detail: formatError(error),
              error,
            },
          });
        },
      );
    }
    const result = await settleAttempt(
      obligation.label,
      attempt,
      (confirmation) => confirmation,
      this.remainingBudget,
      this.options.time,
      this.options.log,
    );
    if (result.kind === 'in-flight' && this.obligationAttempts.get(obligation) !== attempt) {
      const settled = this.entries.get(obligation);
      if (settled?.kind === 'settled') return settled.settlement;
    }
    this.entries.set(obligation, { kind: 'settled', settlement: result.settlement });
    return result.settlement;
  }

  private declinedEntries(): readonly DeclinedSettlementObligation<
    Remainder,
    RetainedAuthorityContribution,
    Reason,
    Exit
  >[] {
    return [...this.entries].flatMap(([obligation, state]) =>
      state.kind === 'settled' && state.settlement.kind === 'declined'
        ? [{ obligation, settlement: state.settlement }]
        : [],
    );
  }

  private acceptDelegatedRemainder(
    declined: readonly DeclinedSettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>[],
  ): Acceptance | null {
    return this.options.acceptDelegatedRemainder?.(declined) ?? null;
  }

  private async prepareBoundary(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    budgetMs: number | null,
  ): Promise<BoundaryPreparationAttempt> {
    if (budgetMs !== null) {
      this.deadlineMonotonicMs = this.options.time.monotonicNow() + BigInt(budgetMs);
    }
    const state = this.boundaryAttempts.get(boundary) ?? { kind: 'idle' };
    if (state.kind === 'prepared' || state.kind === 'committing') {
      return { kind: 'prepared', settlement: { kind: 'discharged' }, token: state.token };
    }
    if (this.remainingBudget() <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
        detail: 'no drain budget remained',
      } as const;
      this.options.log(`${boundary.label}: skipped (drain budget exhausted)\n`);
      return { kind: 'declined', settlement };
    }
    const attempt = state.kind === 'preparing' ? state.attempt : startSettlementAttempt(boundary.prepare);
    this.boundaryAttempts.set(boundary, { kind: 'preparing', attempt });
    const result = await settleAttempt(
      boundary.label,
      attempt,
      (preparation) => (preparation.confirmed ? { confirmed: true } : { confirmed: false, detail: preparation.detail }),
      this.remainingBudget,
      this.options.time,
      this.options.log,
    );
    if (result.kind === 'in-flight') return { kind: 'declined', settlement: result.settlement };
    if (result.settlement.kind === 'declined') {
      if (this.boundaryAttempts.get(boundary)?.kind === 'preparing') {
        this.boundaryAttempts.set(boundary, { kind: 'idle' });
      }
      return { kind: 'declined', settlement: result.settlement };
    }
    if (result.value === undefined || !result.value.confirmed) {
      throw new Error('authority preparation discharged without a token');
    }
    this.boundaryAttempts.set(boundary, { kind: 'prepared', token: result.value.token });
    return { kind: 'prepared', settlement: result.settlement, token: result.value.token };
  }

  private async commitBoundary(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    token: object,
    budgetMs: number | null,
  ): Promise<Settlement> {
    if (budgetMs !== null) {
      this.deadlineMonotonicMs = this.options.time.monotonicNow() + BigInt(budgetMs);
    }
    if (this.remainingBudget() <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
        detail: 'no drain budget remained',
      } as const;
      this.options.log(`${boundary.label}: skipped (drain budget exhausted)\n`);
      return settlement;
    }
    const state = this.boundaryAttempts.get(boundary) ?? { kind: 'idle' };
    const commitToken = state.kind === 'committing' ? state.token : token;
    const attempt =
      state.kind === 'committing'
        ? state.attempt
        : startSettlementAttempt((signal) => boundary.commit(commitToken, signal));
    this.boundaryAttempts.set(boundary, { kind: 'committing', token: commitToken, attempt });
    const result = await settleAttempt(
      boundary.label,
      attempt,
      (confirmation) => confirmation,
      this.remainingBudget,
      this.options.time,
      this.options.log,
    );
    if (result.kind === 'completed' && this.boundaryAttempts.get(boundary)?.kind === 'committing') {
      this.boundaryAttempts.set(boundary, { kind: 'idle' });
    }
    return result.settlement;
  }

  private retainedAuthority(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    delegatedRemainderAccepted: boolean,
  ): RetainedAuthority {
    const contributions = [...this.entries]
      .filter(
        ([, state]) =>
          (state.kind !== 'settled' || state.settlement.kind !== 'discharged') && !delegatedRemainderAccepted,
      )
      .map(([obligation]) => obligation.retainedAuthority());
    return this.options.foldRetainedAuthority([...contributions, boundary.retainedAuthority()]);
  }

  private verifyRemainderAcceptance(): void {
    if (this.remainderAcceptance.kind !== 'unattempted') return;
    const declined = this.declinedEntries();
    if (this.options.acceptDelegatedRemainder === undefined && declined.length === 0) return;
    const acceptance = this.acceptDelegatedRemainder(declined);
    if (acceptance !== null) {
      this.remainderAcceptance = { kind: 'accepted', acceptance };
      return;
    }
    this.remainderAcceptance = {
      kind: 'failed',
      failure: this.options.failure(this.options.acceptanceFailureLabel, this.options.boundaryRemainder, {
        kind: 'declined',
        cause: 'unconfirmed',
        detail: 'process-exit remainder acceptance was not verified',
      }),
    };
  }

  private acceptedRemainder(): Acceptance | null {
    return this.remainderAcceptance.kind === 'accepted' ? this.remainderAcceptance.acceptance : null;
  }

  private namedLosses(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    boundaryFailure: Extract<Settlement, { kind: 'declined' }> | null,
  ): readonly Failure[] {
    if (this.remainderAcceptance.kind === 'accepted' && boundaryFailure === null) {
      return this.options.acceptedUndischarged(this.remainderAcceptance.acceptance);
    }
    const obligationFailures =
      this.remainderAcceptance.kind === 'accepted'
        ? this.options.acceptedUndischarged(this.remainderAcceptance.acceptance)
        : this.declinedEntries().map(({ obligation, settlement }) =>
            this.options.failure(obligation.label, obligation.remainder, settlement),
          );
    return [
      ...obligationFailures,
      ...(this.remainderAcceptance.kind === 'failed' ? [this.remainderAcceptance.failure] : []),
      ...(boundaryFailure === null
        ? []
        : [this.options.failure(boundary.label, this.options.boundaryRemainder, boundaryFailure)]),
    ];
  }

  private hasAcceptedLosses(): boolean {
    return (
      this.remainderAcceptance.kind === 'accepted' &&
      this.options.acceptedUndischarged(this.remainderAcceptance.acceptance).length > 0
    );
  }

  private async attemptBoundaryTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    budgetMs: number | null,
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    const attemptsStarted = (this.boundaryTransferAttemptsStarted.get(boundary) ?? 0) + 1;
    this.boundaryTransferAttemptsStarted.set(boundary, attemptsStarted);

    const preparation = await this.prepareBoundary(boundary, budgetMs);
    if (preparation.kind === 'declined') {
      const acceptance = this.acceptedRemainder();
      return acceptance !== null && this.hasAcceptedLosses()
        ? this.gate(boundary, { kind: 'transfer-pending', acceptance, failure: preparation.settlement })
        : this.gate(boundary, {
            kind: 'held',
            boundaryFailure: preparation.settlement,
            retry: () => this.retryCleanTransfer(boundary),
          });
    }

    this.verifyRemainderAcceptance();
    const commit = await this.commitBoundary(boundary, preparation.token, budgetMs);
    if (commit.kind === 'discharged') {
      return this.gate(boundary, { kind: 'terminal', boundaryFailure: null });
    }
    const acceptance = this.acceptedRemainder();
    return acceptance !== null && this.hasAcceptedLosses()
      ? this.gate(boundary, { kind: 'transfer-pending', acceptance, failure: commit })
      : this.gate(boundary, {
          kind: 'held',
          boundaryFailure: commit,
          retry: () => this.retryCleanTransfer(boundary),
        });
  }

  private retryAcceptedTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    const attemptBudgetMs = Math.max(1, Math.floor(this.options.budgetMs / 2));
    return this.attemptBoundaryTransfer(boundary, attemptBudgetMs);
  }

  private retryCleanTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    const attemptBudgetMs = Math.max(1, Math.floor(this.options.budgetMs / 2));
    return this.attemptBoundaryTransfer(boundary, attemptBudgetMs);
  }

  private createHeldDisposition(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    resolution: Extract<
      GateResolution<Acceptance, SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>>,
      { kind: 'held' }
    >,
  ): HeldSettlementDisposition<
    Reason,
    Exit,
    Failure,
    RetainedAuthority,
    SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>
  > {
    const declined = this.declinedEntries();
    const primary =
      declined.find(({ obligation }) => this.options.remainderRole(obligation.remainder) === 'blocking') ??
      declined.find(({ obligation }) => this.options.remainderRole(obligation.remainder) === 'successor') ??
      declined[0];
    const hold =
      resolution.boundaryFailure !== null
        ? (boundary.hold?.(resolution.boundaryFailure) ?? this.options.defaultHold())
        : (primary?.obligation.hold?.(primary.settlement) ?? this.options.defaultHold());
    return this.dispositions.held({
      reason: hold.reason,
      exit: hold.exit,
      retryAfter: hold.retryAfter ?? this.options.time.sleep(this.options.pollMs),
      undischarged: this.namedLosses(boundary, resolution.boundaryFailure),
      retainedAuthority: this.retainedAuthority(boundary, false),
      retry: resolution.retry ?? (() => this.retryCleanTransfer(boundary)),
    });
  }

  private createTransferPendingDisposition(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    resolution: Extract<
      GateResolution<Acceptance, SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>>,
      { kind: 'transfer-pending' }
    >,
  ): TransferPendingSettlementDisposition<
    Reason,
    Exit,
    Failure,
    RetainedAuthority,
    Acceptance,
    SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>
  > {
    const hold = boundary.hold?.(resolution.failure) ?? this.options.defaultHold();
    return this.dispositions.transferPending({
      reason: hold.reason,
      exit: hold.exit,
      retryAfter: hold.retryAfter ?? this.options.time.sleep(this.options.pollMs),
      undischarged: this.options.acceptedUndischarged(resolution.acceptance),
      acceptance: resolution.acceptance,
      boundaryFailure: this.options.failure(boundary.label, this.options.boundaryRemainder, resolution.failure),
      retainedAuthority: this.retainedAuthority(boundary, true),
      retry: () => this.retryAcceptedTransfer(boundary),
    });
  }

  private async settleInitially(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    return this.attemptBoundaryTransfer(boundary, null);
  }

  async gate(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    resolution: GateResolution<
      Acceptance,
      SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>
    > = { kind: 'initial' },
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    const boundaryAttemptsStarted = this.boundaryTransferAttemptsStarted.get(boundary) ?? 0;
    if (boundaryAttemptsStarted >= BOUNDARY_TRANSFER_ATTEMPT_LIMIT) {
      if (resolution.kind === 'held' && resolution.boundaryFailure !== null) {
        return this.gate(boundary, { kind: 'terminal', boundaryFailure: resolution.boundaryFailure });
      }
      if (resolution.kind === 'transfer-pending') {
        return this.gate(boundary, { kind: 'terminal', boundaryFailure: resolution.failure });
      }
    }
    if (resolution.kind === 'held') {
      return this.createHeldDisposition(boundary, resolution);
    }
    if (resolution.kind === 'terminal') {
      const undischarged = this.namedLosses(boundary, resolution.boundaryFailure);
      if (undischarged.length === 0) return this.dispositions.settled();
      const acceptance = this.acceptedRemainder();
      return acceptance === null
        ? this.dispositions.unaccepted({ undischarged })
        : this.dispositions.delegated({ undischarged, acceptance });
    }
    if (resolution.kind === 'transfer-pending') {
      return this.createTransferPendingDisposition(boundary, resolution);
    }
    return this.settleInitially(boundary);
  }
}
