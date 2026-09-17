# The shutdown-abandonment offer is dead inside the coordinator

**What is wrong.** After #363 no current-build shutdown producer offers an abandonment action:
`foldRetainedAuthority` (`src/coordinator/shutdown-settlement.ts`) always yields `operatorActions: []`, so
`abandonShutdownObligation` (`src/coordinator/lifecycle.ts`) can never find a
`shutdown-obligation-abandonment` offer, `state.operatorAbandonedShutdownObligations` can never gain a
member, and every `shutdownObligationAbandoned(<subject>)` early return in `src/coordinator/shutdown.ts`
(one per abandonable obligation plus the boundary's prepare/commit branches) is unreachable in
production. `ShutdownOperatorAction`'s producer-side members with their `actionCommand` literals survive
only as the wire type a newer CLI reads from an older daemon.

**Why it was left.** The CLI command, its schemas, and the IPC route are kept on purpose as the
mixed-version override (`docs/design-rationale.md` §12.6): a new CLI must still be able to abandon a
held drain on an older daemon that legitimately offered it. Deleting the coordinator-side lookup and the
dead branches is a separate, self-contained deletion that #363's review chose not to fold into a branch
already at eighty-plus files; design-philosophy §10 says an unreachable path is a liability, not an
exception, so it should not stay long.

**What closing it requires.** Delete `ShutdownOperatorAction`'s producer members and the
`operatorActions` field of `ShutdownRetainedAuthority`, `operatorAbandonedShutdownObligations`,
`isShutdownObligationAbandoned`, and every `shutdownObligationAbandoned(...)` branch in `shutdown.ts`;
have `abandonShutdownObligation` answer `not-held` when no shutdown is live and `not-offered` otherwise
with no lookup; keep the IPC method, the CLI command and the durable
`shutdown-abandonment-status.v1.json` family byte-for-byte (an older daemon still writes it). Move the
reader-side action type to the CLI/IPC contract module. Rework the abandonment tests in
`tests/unit/coordinator/shutdown-budget.test.ts` to assert `not-offered` rather than a discharged
obligation.

**Interactions.** `docs/todo/shutdown-remainder-has-no-reader.md` (Track B decides what `backend
status` shows for a drain, which is where an offer would have to reappear if one is ever justified).
