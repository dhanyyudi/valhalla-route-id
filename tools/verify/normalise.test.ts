// @vitest-environment node
//
// Focused unit coverage for the comparison rule. The 3.8 GB Indonesia graph is not
// needed here: these tests pin the properties that decide every verdict — error normalisation,
// sidecar alignment, corpus shape and exact (non-tolerant) equality of the returned JSON — plus
// the two provenance guards: the verdict classification must fail **closed**
// when the SDK-normalised control output is missing, and a recorded output must be refused when
// it was stamped against a different corpus.
import { describe, expect, it } from 'vitest';
import { RoutingError } from 'valhalla-server/node';
import { assertAligned, buildCorpus, sdkNormalised } from './corpus.mjs';
import { canonicalJson, classifyDifferences, differenceContext, firstDifference, normaliseRoutingError, summarise } from './normalise.mjs';
import { outputFacts, sha256, staleOutputReason } from './provenance.mjs';

const trip = (overrides = {}) => ({
  trip: {
    locations: [{ type: 'break', lat: -6.1754, lon: 106.8272, original_index: 0 }, { type: 'break', lat: -6.9175, lon: 107.6191, original_index: 1 }],
    legs: [{ maneuvers: [{ type: 2, instruction: 'Drive south.', time: 9.604, length: 0.053, cost: 11.765 }], summary: { time: 809.691, length: 11.327, cost: 2047.033 }, shape: 'vi|wJwjkwjE|\\O@eJiEDwB' }],
    summary: { time: 809.691, length: 11.327, cost: 2047.033 },
    status_message: 'Found route between points',
    status: 0,
    units: 'kilometers',
    language: 'en-US',
  },
  ...overrides,
});

describe('normaliseRoutingError', () => {
  it('serialises an SDK error carrying a native code as the native envelope', () => {
    const error = new RoutingError('NO_ROUTE', 'Valhalla error 442.', { nativeCode: 442 });
    expect(normaliseRoutingError(error)).toEqual({ nativeError: 442 });
    // The whole point: both engines agreeing there is no route must compare EQUAL.
    expect(canonicalJson(normaliseRoutingError(error))).toBe('{"nativeError":442}');
  });

  it('keeps native codes other than NO_ROUTE and LOCATION_NOT_FOUND', () => {
    expect(normaliseRoutingError(new RoutingError('LOCATION_NOT_FOUND', 'Valhalla error 171.', { nativeCode: 171 }))).toEqual({ nativeError: 171 });
    expect(normaliseRoutingError(new RoutingError('NATIVE', 'Valhalla error 110.', { nativeCode: 110 }))).toEqual({ nativeError: 110 });
  });

  it('reports an SDK-level gate as a distinct kind of failure, never as agreement', () => {
    const gated = normaliseRoutingError(new RoutingError('OUTSIDE_COVERAGE', 'A location is outside this dataset’s coverage.'));
    expect(gated).toEqual({ sdkError: { code: 'OUTSIDE_COVERAGE', message: 'A location is outside this dataset’s coverage.' } });
    expect(gated).not.toEqual({ nativeError: 442 });
    expect(canonicalJson(gated)).not.toBe('{"nativeError":442}');
  });

  it('tolerates a non-integer or missing nativeCode and still names the SDK category', () => {
    expect(normaliseRoutingError({ code: 'TIMEOUT', message: 'slow', nativeCode: undefined })).toEqual({ sdkError: { code: 'TIMEOUT', message: 'slow' } });
    expect(normaliseRoutingError({ code: 'TIMEOUT', message: 'slow', nativeCode: 1.5 })).toEqual({ sdkError: { code: 'TIMEOUT', message: 'slow' } });
    expect(normaliseRoutingError(new Error('boom'))).toEqual({ sdkError: { code: 'UNKNOWN', message: 'boom' } });
    expect(normaliseRoutingError(undefined)).toEqual({ sdkError: { code: 'UNKNOWN', message: 'undefined' } });
  });
});

describe('exact comparison', () => {
  it('accepts a round trip of the same route text', () => {
    const line = JSON.stringify(trip());
    expect(canonicalJson(JSON.parse(line))).toBe(line);
  });

  it('catches a silently different route that no summary change would reveal', () => {
    // One character of the encoded shape and one bearing differ; length, time and cost are equal.
    const mutated = trip();
    mutated.trip.legs[0].shape = 'vi|wJwjkwjE|\\O@eJiEDwC';
    const left = canonicalJson(trip());
    const right = canonicalJson(mutated);
    expect(left).not.toBe(right);
    expect(firstDifference(left, right)).toBeGreaterThan(0);
    expect(differenceContext(left, firstDifference(left, right), 8)).toContain('DwB');
  });

  it('catches a differing cost, a missing key and a reordered object', () => {
    const base = canonicalJson(trip());
    const cost = trip();
    cost.trip.summary.cost = 2047.034;
    expect(canonicalJson(cost)).not.toBe(base);
    const missing = trip();
    // `language` is a required member of the helper's inferred type, so delete it through a
    // partial view; the case is that a removed key changes the compared text.
    delete (missing.trip as Partial<typeof missing.trip>).language;
    expect(canonicalJson(missing)).not.toBe(base);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
    expect(canonicalJson({ b: 1, a: 2 })).not.toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('compares identical doubles equal and differing doubles different, with no tolerance', () => {
    // The only spelling difference the runner tolerates: an integral double printed as `0.0`.
    expect(canonicalJson(JSON.parse('{"time":0.0,"length":0.0}'))).toBe('{"time":0,"length":0}');
    expect(canonicalJson(JSON.parse('{"time":11.327}'))).toBe(canonicalJson(JSON.parse('{"time":11.327}')));
    expect(canonicalJson(JSON.parse('{"time":11.327}'))).not.toBe(canonicalJson(JSON.parse('{"time":11.327000001}')));
  });

  it('reports the first differing offset and the end of a shared prefix', () => {
    expect(firstDifference('abc', 'abc')).toBe(-1);
    expect(firstDifference('abc', 'abd')).toBe(2);
    expect(firstDifference('abc', 'abcd')).toBe(3);
    expect(firstDifference('', 'x')).toBe(0);
    expect(differenceContext('0123456789', 5, 2)).toBe('…3456…');
  });
});

describe('sidecar alignment', () => {
  it('accepts a sidecar whose length matches the corpus', () => {
    expect(assertAligned(['{"locations":[]}', '{}'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('fails loudly when the sidecar and the corpus disagree', () => {
    expect(() => assertAligned(['{}', '{}'], ['a'])).toThrow(/Sidecar misalignment/);
    expect(() => assertAligned(['{}'], { names: ['a'] })).toThrow(/JSON array/);
    expect(() => assertAligned(['{}'], [''])).toThrow(/non-empty strings/);
  });
});

describe('corpus', () => {
  it('is pure Valhalla requests with no reporting field, aligned with its names', () => {
    const { lines, names } = buildCorpus();
    expect(lines.length).toBeGreaterThan(0);
    expect(names).toHaveLength(lines.length);
    expect(new Set(names).size).toBe(names.length);
    for (const line of lines) {
      const request = JSON.parse(line);
      expect(request).not.toHaveProperty('name');
      expect(Array.isArray(request.locations)).toBe(true);
      expect(request.locations.length).toBeGreaterThanOrEqual(2);
      // The shared language pin: without it the SDK host answers in Indonesian while native
      // answers in English (see the corpus module header).
      expect(request.directions_options.language).toBe('en-US');
    }
  });

  it('refuses a payload that carries a reporting field', () => {
    const payload = { locations: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }], note: 'why' };
    expect(() => buildCorpus([{ name: 'bad', payload }])).toThrow(/pure Valhalla requests/);
  });

  it('mirrors the SDK host request normalisation', () => {
    const normalised = sdkNormalised({ locations: [{ lat: -6.1754, lon: 106.8272, preferred_side: 'opposite' }], costing: 'truck' });
    expect(normalised.locations[0]).toEqual({ lat: -6.1754, lon: 106.8272, preferred_side: 'opposite' });
    // The SDK host stopped forcing correlation defaults (the correlation-default fix): the control
    // must mirror what the SDK really sends, or every classification it produces is worthless.
    expect(normalised.locations[0]).not.toHaveProperty('radius');
    expect(normalised.locations[0]).not.toHaveProperty('minimum_reachability');
    expect(normalised.costing).toBe('truck');
    expect(normalised.units).toBe('kilometers');
    expect(normalised.language).toBe('id-ID');
    expect(sdkNormalised({ locations: [], directions_options: { language: 'en-US' } }).language).toBe('en-US');
    // The default costing the SDK applies is mirrored too.
    expect(sdkNormalised({ locations: [] }).costing).toBe('auto');
  });

  it('forwards the correlation fields a caller supplied, and only those', () => {
    const normalised = sdkNormalised({
      locations: [{ lat: 0, lon: 0, radius: 500, minimum_reachability: 50 }, { lat: 1, lon: 1 }],
    });
    expect(normalised.locations[0]).toEqual({ lat: 0, lon: 0, radius: 500, minimum_reachability: 50 });
    expect(normalised.locations[1]).toEqual({ lat: 1, lon: 1 });
  });
});

describe('summarise', () => {
  it('describes a successful trip, a native error and an SDK gate distinctly', () => {
    expect(summarise(trip())).toBe('status 0: 11.327 km, 809.691 s, cost 2047.033, 1 maneuvers, polyline shape 22 chars');
    expect(summarise({ nativeError: 442 })).toBe('nativeError 442');
    expect(summarise({ sdkError: { code: 'OUTSIDE_COVERAGE', message: 'x' } })).toBe('sdkError OUTSIDE_COVERAGE');
    expect(summarise(null)).toBe('no output');
  });
});

// Regression coverage for the fail-closed rule. The control output that proves a difference is
// only a request rewrite is gitignored, so a fresh clone — or a re-run that skips the extra
// build-host step — reaches the classification with no control at all. The old runner then
// computed "0 genuine disagreements" from an empty bucket and printed the zero-disagreement
// sentence as if the evidence were present. These tests pin the fail-closed rule: a row with no
// control verdict is *unclassified*, and the sentence is withheld.
describe('classifyDifferences (fail closed)', () => {
  const rewritten = { name: 'jakarta-bandung-motorcycle', controlIdentical: true, wasmValue: { nativeError: 442 } };
  const gate = { name: 'jakarta-bandung-bicycle', controlIdentical: null, wasmValue: { sdkError: { code: 'TIMEOUT' } } };
  const noControlVerdict = { name: 'surabaya-malang-truck', controlIdentical: null, wasmValue: { trip: {} } };
  const controlNote = 'the SDK-normalised control output (`tools/verify/native-sdk-normalised.jsonl`) is unusable for this run (it has no provenance record)';

  it('states zero disagreements only with a control verdict for every difference', () => {
    const verdict = classifyDifferences([rewritten], { controlAvailable: true });
    expect(verdict.byNormalisation).toHaveLength(1);
    expect(verdict.byEngine).toHaveLength(0);
    expect(verdict.verified).toBe(0);
    expect(verdict.unclassified).toHaveLength(0);
    expect(verdict.zeroDisagreementProven).toBe(true);
    expect(verdict.disagreementStatement).toContain('0 remain genuine engine/loader disagreements');
    expect(verdict.unclassifiedNote).toBeNull();
  });

  it('marks a row with controlIdentical === null as unclassified and suppresses the sentence', () => {
    const verdict = classifyDifferences([noControlVerdict, gate], { controlAvailable: false, controlNote });
    expect(verdict.unclassified).toEqual([noControlVerdict]);
    expect(verdict.byNormalisation).toHaveLength(0);
    expect(verdict.verified).toBe(0);
    expect(verdict.zeroDisagreementProven).toBe(false);
    // The publication-deciding sentence must not appear anywhere in what the runner prints.
    expect(verdict.disagreementStatement).not.toContain('0 remain genuine engine/loader disagreements');
    expect(verdict.disagreementStatement).not.toContain('agreed byte-for-byte');
    expect(verdict.disagreementStatement).toContain('unclassified');
    expect(verdict.unclassifiedNote).toContain('1 of the 2 difference(s) are unclassified');
    expect(verdict.unclassifiedNote).toContain('The zero-disagreement conclusion does not apply to this run');
  });

  it('reproduces the reviewer\'s no-control run: three unclassified differences, bucket sum preserved', () => {
    const rows = [
      { name: 'jakarta-bandung-motorcycle', controlIdentical: null, wasmValue: { nativeError: 442 } },
      { name: 'surabaya-malang-truck', controlIdentical: null, wasmValue: { trip: {} } },
      { name: 'outside-coverage', controlIdentical: null, wasmValue: { nativeError: 442 } },
      { name: 'jakarta-bandung-bicycle', controlIdentical: null, wasmValue: { sdkError: { code: 'TIMEOUT' } } },
      { name: 'jakarta-bandung-pedestrian', controlIdentical: null, wasmValue: { sdkError: { code: 'TIMEOUT' } } },
    ];
    const verdict = classifyDifferences(rows, { controlAvailable: false, controlNote });
    expect(verdict.unclassified).toHaveLength(3);
    expect(verdict.bySdkGate).toHaveLength(2);
    expect(verdict.verified).toBe(0);
    expect(verdict.zeroDisagreementProven).toBe(false);
    expect(verdict.headline).toBe('0 verified disagreement(s) (0 reproduced byte-for-byte on the rewritten request; 5 unverified — 3 with no control verdict, 2 with no engine answer).');
  });

  it('withholds the sentence even when nothing is strictly unclassified but no control was available', () => {
    const verdict = classifyDifferences([gate], { controlAvailable: false, controlNote });
    expect(verdict.unclassified).toHaveLength(0);
    expect(verdict.bySdkGate).toHaveLength(1);
    expect(verdict.zeroDisagreementProven).toBe(false);
    expect(verdict.disagreementStatement).not.toContain('agreed byte-for-byte');
    expect(verdict.disagreementStatement).toContain('The zero-disagreement conclusion does not apply to this run');
    expect(verdict.unclassifiedNote).toContain('produced no engine answer at all, which is unverified rather than agreement');
  });

  it('still counts a proven engine disagreement as blocking publication', () => {
    const verdict = classifyDifferences([{ name: 'x', controlIdentical: false, wasmValue: { trip: {} } }], { controlAvailable: true });
    expect(verdict.verified).toBe(1);
    expect(verdict.disagreementStatement).toContain('block publication');
    expect(verdict.zeroDisagreementProven).toBe(false);
  });

  it('does not read a missing deadline-lifted answer as a disagreement', () => {
    // `liftedIdentical` is null when no deadline-lifted run was recorded, and false only when one
    // ran and disagreed. Treating the absence of evidence as a disagreement would invent a
    // blocking finding out of a file that does not exist.
    const noLiftedRun = { name: 'jakarta-bandung-bicycle', controlIdentical: null, wasmValue: { sdkError: { code: 'TIMEOUT' } }, liftedIdentical: null };
    const verdict = classifyDifferences([noLiftedRun], { controlAvailable: true, controlNote });
    expect(verdict.byLiftedDisagreement).toHaveLength(0);
    expect(verdict.byDeadline).toHaveLength(0);
    expect(verdict.verified).toBe(0);
    expect(verdict.unverified).toBe(1);
    expect(verdict.zeroDisagreementProven).toBe(true);
  });

  it('keeps a deadline-lifted agreement a difference, and a lifted disagreement a verified one', () => {
    const lifted = { name: 'bicycle', controlIdentical: false, wasmValue: { sdkError: { code: 'TIMEOUT' } }, liftedIdentical: true };
    const stillDifferent = { name: 'pedestrian', controlIdentical: false, wasmValue: { sdkError: { code: 'TIMEOUT' } }, liftedIdentical: false };
    const agreeing = classifyDifferences([lifted], { controlAvailable: true });
    expect(agreeing.byDeadline).toEqual([lifted]);
    expect(agreeing.verified).toBe(0);
    expect(agreeing.zeroDisagreementProven).toBe(true);
    const disagreeing = classifyDifferences([stillDifferent], { controlAvailable: true });
    expect(disagreeing.verified).toBe(1);
    expect(disagreeing.disagreementStatement).toContain('block publication');
  });
});

// Regression coverage for the provenance guard: alignment is by line index, so a corpus edit
// that keeps the line count would otherwise compare each recorded half against the wrong request.
describe('output provenance', () => {
  const corpus = '{"locations":[{"lat":1,"lon":1},{"lat":2,"lon":2}]}\n{"locations":[{"lat":3,"lon":3},{"lat":4,"lon":4}]}\n';
  const edited = '{"locations":[{"lat":9,"lon":9},{"lat":2,"lon":2}]}\n{"locations":[{"lat":3,"lon":3},{"lat":4,"lon":4}]}\n';
  const rewritten = '{"locations":[{"lat":1,"lon":1},{"lat":2,"lon":2}],"units":"kilometers"}\n{"locations":[{"lat":3,"lon":3},{"lat":4,"lon":4}],"units":"kilometers"}\n';
  const output = '{"trip":{"summary":{"length":1}}}\n{"trip":{"summary":{"length":2}}}\n';
  const current = (corpusText: string, outputText: string, requestText = corpusText) => ({
    name: 'tools/verify/native.jsonl', ...outputFacts(outputText),
    requestPath: 'tools/verify/corpus.jsonl', requestSha256: sha256(requestText),
    corpusPath: 'tools/verify/corpus.jsonl', corpusSha256: sha256(corpusText),
  });
  const stamp = (corpusText: string, outputText: string, requestText = corpusText) => ({
    ...outputFacts(outputText),
    request: { path: 'tools/verify/corpus.jsonl', sha256: sha256(requestText) },
    corpus: { path: 'tools/verify/corpus.jsonl', sha256: sha256(corpusText), lines: 2 },
  });

  it('accepts an output stamped against the requests it answers', () => {
    expect(staleOutputReason(stamp(corpus, output), current(corpus, output))).toBeNull();
  });

  it('refuses a same-length corpus edit with the old output', () => {
    expect(staleOutputReason(stamp(corpus, output), current(edited, output)))
      .toMatch(/answers requests with sha256 [0-9a-f]{12,} but .*corpus\.jsonl is now [0-9a-f]{12,}/);
  });

  it('refuses a control output that answers a rewritten corpus the current one no longer generates', () => {
    // The case this guard exists for: `corpus-sdk-normalised.jsonl` is regenerated, the control
    // output is not, and every "the SDK rewrote the request" verdict would be about a request the
    // SDK no longer sends.
    expect(staleOutputReason(stamp(corpus, output, rewritten), current(corpus, output, corpus)))
      .toMatch(/answers requests with sha256 [0-9a-f]{12,} but .*corpus\.jsonl is now [0-9a-f]{12,}/);
  });

  it('refuses an output whose request file is current but whose corpus alignment is not', () => {
    expect(staleOutputReason(stamp(corpus, output, rewritten), current(edited, output, rewritten)))
      .toMatch(/was recorded against .*corpus\.jsonl sha256 [0-9a-f]{12,}, but the corpus is now [0-9a-f]{12,}/);
  });

  it('refuses an unstamped output and one whose bytes changed after stamping', () => {
    expect(staleOutputReason(undefined, current(corpus, output))).toMatch(/has no provenance record/);
    expect(staleOutputReason(stamp(corpus, output), current(corpus, output.replace('"length":2', '"length":3'))))
      .toMatch(/was recorded as sha256 [0-9a-f]{12,} but is now/);
  });

  it('refuses an output whose line count no longer matches the stamp', () => {
    expect(staleOutputReason({ ...stamp(corpus, output), lines: 1 }, current(corpus, output))).toMatch(/was recorded with 1 line\(s\) but now has 2/);
  });
});
