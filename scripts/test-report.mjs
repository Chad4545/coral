import { isAbsolute, relative } from 'node:path';

const SLOWEST_LIMIT = 10;
const DEFAULT_HEADROOM_RATIO = 1.5;

/**
 * @typedef {{ durationMs: number; timeoutMs: number | undefined; file: string; fullName: string }} CaseDuration
 * @typedef {{ durationMs: number; file: string }} FileDuration
 */

/**
 * Per-case and per-file durations from a vitest JSON report, slowest first.
 *
 * A case vitest reports without a numeric `duration` (skipped, or ended with the worker) has no
 * measured cost and is therefore absent rather than zero; the same holds for a file whose
 * `startTime`/`endTime` pair is incomplete.
 *
 * A case's own budget arrives on `meta.timeout`, put there by `vitest/setup.ts`. It is absent for a
 * case that ran without that setup file, and such a case is unjudgeable rather than unbudgeted.
 *
 * @param {Record<string, unknown>} report parsed vitest JSON report
 * @param {string} root paths are reported relative to this directory when they are absolute
 * @returns {{ cases: CaseDuration[]; files: FileDuration[] }}
 */
export function collectDurations(report, root) {
  const cases = [];
  const files = [];

  for (const fileResult of report?.testResults ?? []) {
    const file = displayPath(String(fileResult?.name ?? ''), root);
    if (typeof fileResult?.startTime === 'number' && typeof fileResult?.endTime === 'number') {
      files.push({ durationMs: Math.round(fileResult.endTime - fileResult.startTime), file });
    }
    for (const assertion of fileResult?.assertionResults ?? []) {
      if (typeof assertion?.duration !== 'number') {
        continue;
      }
      const timeoutMs = assertion?.meta?.timeout;
      cases.push({
        durationMs: Math.round(assertion.duration),
        timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
        file,
        fullName: String(assertion?.fullName ?? assertion?.title ?? ''),
      });
    }
  }

  return { cases: slowestFirst(cases), files: slowestFirst(files) };
}

/**
 * @param {{ cases: CaseDuration[]; files: FileDuration[] }} durations
 * @param {number} limit
 * @returns {string}
 */
export function formatDurations({ cases, files }, limit = SLOWEST_LIMIT) {
  return [
    `slowest cases (${Math.min(limit, cases.length)} of ${cases.length}):`,
    ...cases.slice(0, limit).map((entry) => `  ${describeCase(entry)}`),
    `slowest files (${Math.min(limit, files.length)} of ${files.length}):`,
    ...files.slice(0, limit).map((entry) => `  ${entry.durationMs} ${entry.file}`),
  ].join('\n');
}

/** @param {CaseDuration} entry */
export function describeCase(entry) {
  return `${entry.durationMs}/${entry.timeoutMs ?? '?'} ${entry.file} :: ${entry.fullName}`;
}

/**
 * The ratio a case's own budget must exceed its duration by.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export function headroomRatio(raw) {
  if (raw === undefined || raw === '') {
    return DEFAULT_HEADROOM_RATIO;
  }
  const ratio = Number(raw);
  if (!Number.isFinite(ratio) || ratio < 1) {
    throw new Error(`CORAL_HEADROOM_RATIO must be a finite number at least 1, not '${raw}'.`);
  }
  return ratio;
}

/**
 * Cases whose own budget leaves them less than `ratio` of margin, cases whose budget the report did not
 * carry, and cases their budget does not bound at all. The three are disjoint, and neither of the last
 * two may be read as having passed this gate: one was measured against nothing, the other against a
 * budget that cannot be exceeded.
 *
 * A retried case is judged on the sum of its attempts: `result.duration` is taken from before vitest's
 * retry loop to after it (@vitest/runner 4.0.18, read 2026-09-17), and the report carries that one number.
 *
 * @param {CaseDuration[]} cases
 * @param {{ ratio: number }} thresholds
 * @returns {{ withoutHeadroom: CaseDuration[]; unjudged: CaseDuration[]; unbounded: CaseDuration[] }}
 */
export function casesWithoutHeadroom(cases, { ratio }) {
  const withoutHeadroom = [];
  const unjudged = [];
  const unbounded = [];
  for (const entry of cases) {
    // A zero or non-finite budget disables vitest's timer, so the case has no margin to measure.
    if (entry.timeoutMs === undefined) {
      unjudged.push(entry);
    } else if (entry.timeoutMs === 0 || !Number.isFinite(entry.timeoutMs)) {
      unbounded.push(entry);
    } else if (entry.durationMs * ratio > entry.timeoutMs) {
      withoutHeadroom.push(entry);
    }
  }
  return { withoutHeadroom, unjudged, unbounded };
}

function displayPath(name, root) {
  return isAbsolute(name) ? relative(root, name) : name;
}

function slowestFirst(entries) {
  return [...entries].sort((left, right) => right.durationMs - left.durationMs);
}
