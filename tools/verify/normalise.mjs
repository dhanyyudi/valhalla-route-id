/**
 * Normalisation helpers shared by the comparison runner and its unit test.
 *
 * These functions are deliberately small and total: the whole native-versus-WASM verdict is
 * `canonicalJson(...)` equality, so anything that could hide a difference (sorting keys,
 * rounding numbers, dropping fields, tolerating "close" values) must not live here.
 */

/** Error envelope the native reference prints for a Valhalla exception (see native/reference.cpp). */
export const NATIVE_ERROR_FIELD = 'nativeError';

/**
 * Serialise one WASM-side failure the same way the native half reports its own failures.
 *
 * The native reference catches `valhalla_exception_t` and prints `{"nativeError":N}`. The SDK
 * throws a `RoutingError` that carries the identical Valhalla code in `nativeCode`, so a case
 * where both engines refuse to route (for example an unreachable island pair) must compare
 * EQUAL rather than showing a false difference between `{"nativeError":442}` and an SDK error
 * object.
 *
 * Only a failure with no native code at all — an SDK-level gate, such as a request the SDK
 * refuses before native ever sees it, or a transport failure — is reported as `sdkError`,
 * which is a distinct kind of mismatch and never equal to a native error line.
 *
 * @param {{ code?: unknown, message?: unknown, nativeCode?: unknown }|null|undefined} error SDK `RoutingError`, or anything thrown
 * @returns {{ nativeError: number } | { sdkError: { code: string, message: string } }}
 */
export function normaliseRoutingError(error) {
  const nativeCode = error?.nativeCode;
  if (typeof nativeCode === 'number' && Number.isInteger(nativeCode)) return { [NATIVE_ERROR_FIELD]: nativeCode };
  const code = typeof error?.code === 'string' && error.code ? error.code : 'UNKNOWN';
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error);
  return { sdkError: { code, message } };
}

/**
 * Canonical JSON text for a parsed value.
 *
 * `JSON.stringify` preserves insertion order, so a response whose keys are emitted in a
 * different order, holds a different value, or is missing a field produces different text and
 * fails the comparison. It only normalises the *spelling* of numerically equal numbers: the
 * native serializer writes integral doubles as `0.0` where JavaScript writes `0`.
 */
export const canonicalJson = value => JSON.stringify(value);

/** Canonical JSON text for a raw JSON line. Throws on invalid JSON instead of silently passing. */
export const canonicaliseLine = line => canonicalJson(JSON.parse(line));

/**
 * Index of the first differing code unit, or -1 when the two strings are identical.
 * @returns {number}
 */
export function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) if (left[index] !== right[index]) return index;
  return left.length === right.length ? -1 : limit;
}

/**
 * Printable excerpt around a differing offset, for a human reading the report.
 * @param {string} text
 * @param {number} index offset reported by {@link firstDifference}
 * @param {number} radius code units of context on each side
 */
export function differenceContext(text, index, radius = 80) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const ellipsis = { start: start > 0 ? '…' : '', end: end < text.length ? '…' : '' };
  return `${ellipsis.start}${text.slice(start, end)}${ellipsis.end}`;
}

/**
 * One-line human summary of a compared value, for the report table.
 * @param {unknown} value parsed response, error envelope or `null` when the side produced nothing
 */
export function summarise(value) {
  if (value === null || value === undefined) return 'no output';
  if (typeof value !== 'object') return typeof value;
  const record = value;
  if (typeof record[NATIVE_ERROR_FIELD] === 'number') return `nativeError ${record[NATIVE_ERROR_FIELD]}`;
  if (record.sdkError) return `sdkError ${record.sdkError.code}`;
  const trip = record.trip;
  if (!trip || typeof trip !== 'object') return `keys: ${Object.keys(record).sort().join(', ') || 'none'}`;
  if (typeof trip.status !== 'number') return `trip without status (${String(trip.status_message ?? '')})`;
  if (trip.status !== 0) return `status ${trip.status}: ${String(trip.status_message ?? '')}`;
  const summary = trip.summary ?? {};
  const legs = Array.isArray(trip.legs) ? trip.legs : [];
  const maneuvers = legs.reduce((total, leg) => total + (Array.isArray(leg.maneuvers) ? leg.maneuvers.length : 0), 0);
  const shape = legs.reduce((total, leg) => total + (typeof leg.shape === 'string' ? leg.shape.length : 0), 0);
  const shapeKind = legs.length && Array.isArray(legs[0].shape) ? 'geojson' : 'polyline';
  const value_ = (key) => (typeof summary[key] === 'number' ? Number(summary[key].toFixed(3)) : summary[key]);
  return `status 0: ${value_('length')} km, ${value_('time')} s, cost ${value_('cost')}, ${maneuvers} maneuvers, ${shapeKind} shape ${shape} chars`;
}

/**
 * Classify the differing rows of a comparison run, **fail closed**.
 *
 * The runner's headline claim — that no genuine engine/loader disagreement remains — is only as
 * good as the evidence behind it, and that evidence is the SDK-normalised control output: the
 * pinned native binary's answers to the exact requests the SDK host sends. A differing row whose
 * control verdict is missing (`controlIdentical === null`, because the control file is absent,
 * misaligned or stale) is therefore never counted as agreement. It lands in `unclassified`, and
 * `zeroDisagreementProven` stays false, so the zero-disagreement sentence cannot be printed from
 * absent evidence. The same rule covers the opposite failure mode: a row whose WASM half produced
 * no engine answer at all (`sdkError`) is a classification of its own, named as unverified rather
 * than counted as agreement.
 *
 * @param {Array<{ name?: string, wasmValue?: any, controlIdentical?: boolean|null, liftedIdentical?: boolean|null }>} differing
 *   rows whose native and WASM text differ. `liftedIdentical` is `null` — never `false` — when no
 *   deadline-lifted run recorded an answer for the row, because "nobody ran this without the
 *   deadline" and "the lifted run disagreed" are different facts.
 * @param {{ controlAvailable?: boolean, controlNote?: string }} [options]
 *   `controlAvailable` is true only when the control output was present, fresh and aligned;
 *   `controlNote` explains its absence in the report and on the console.
 */
export function classifyDifferences(differing, { controlAvailable = false, controlNote = 'the SDK-normalised control output was not available for this run' } = {}) {
  const bySdkGate = differing.filter(row => Boolean(row.wasmValue?.sdkError));
  const byNormalisation = differing.filter(row => row.controlIdentical === true);
  const byEngine = differing.filter(row => !row.wasmValue?.sdkError && row.controlIdentical === false);
  // Strictly unknown: the control could not answer for this row at all.
  const unclassified = differing.filter(row => !row.wasmValue?.sdkError && row.controlIdentical === null);
  // SDK-gated rows the deadline-lifted engine run proved identical to native, and the (never yet
  // observed) opposite: an engine-level run that still disagrees, which is a verified disagreement.
  const byDeadline = bySdkGate.filter(row => row.liftedIdentical === true);
  const byLiftedDisagreement = bySdkGate.filter(row => row.liftedIdentical === false);
  const verified = byEngine.length + byLiftedDisagreement.length;
  const unverifiedGates = bySdkGate.length - byDeadline.length - byLiftedDisagreement.length;
  const unverified = unclassified.length + unverifiedGates;
  // Both conditions matter: a control verdict for every differing row, and a control that was
  // actually available. Without the control, no difference can be shown to be only a request
  // rewrite, so the conclusion is unproven even when nothing is strictly unclassified.
  const zeroDisagreementProven = controlAvailable && unclassified.length === 0 && verified === 0;

  const unverifiedParts = [];
  if (unclassified.length) unverifiedParts.push(`${unclassified.length} with no control verdict`);
  if (unverifiedGates) unverifiedParts.push(`${unverifiedGates} with no engine answer`);
  const headline = `${verified} verified disagreement(s) (${byNormalisation.length} reproduced byte-for-byte on the rewritten request; ${unverified} unverified${unverifiedParts.length ? ` — ${unverifiedParts.join(', ')}` : ''}).`;

  const unclassifiedNote = controlAvailable ? null
    : `${controlNote}. ${unclassified.length} of the ${differing.length} difference(s) are unclassified: ${unclassified.length === 0
      ? 'every difference here produced no engine answer at all, which is unverified rather than agreement'
      : 'no control verdict is available for them'}. The zero-disagreement conclusion does not apply to this run.`;

  const disagreementStatement = verified > 0
    ? `${verified} remain genuine engine/loader disagreements: native and WASM differ even on the identical normalised request. These block publication.`
    : zeroDisagreementProven
      ? '0 remain genuine engine/loader disagreements — the two engines agreed byte-for-byte on every request they were both given. Any such case would block publication.'
      : `${unclassifiedNote} That is a missing classification, not an agreement.`;

  return { byNormalisation, byEngine, bySdkGate, byDeadline, byLiftedDisagreement, unclassified, verified, unverified, controlAvailable, zeroDisagreementProven, headline, disagreementStatement, unclassifiedNote };
}
