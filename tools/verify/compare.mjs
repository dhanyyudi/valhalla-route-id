#!/usr/bin/env node
/**
 * Native-versus-WASM comparison runner: native reference versus browser WASM, byte-for-byte.
 *
 * Both halves answer the *same* corpus lines (`tools/verify/corpus.jsonl`) on the *same* graph:
 * the pinned `native-reference` binary reads the build work directory's tiles inside the pinned
 * build image, the WASM runtime reads the published release through `tools/serve-dataset.mjs`.
 *
 * The rule is exact equality of the returned JSON after one textual normalisation, applied
 * identically to both sides:
 *
 *  1. A failure becomes an error envelope. Native prints `{"nativeError":N}` for a Valhalla
 *     exception; the SDK throws a `RoutingError` carrying the same code in `nativeCode`, which
 *     is serialised back to `{"nativeError":N}` so that two engines agreeing there is no route
 *     compare EQUAL. A failure with no native code (`sdkError`) is a different kind of
 *     mismatch and never compares equal to a native error line.
 *  2. Both sides are serialised through `JSON.stringify` of the parsed value. This does not
 *     sort keys, does not touch numbers, and does not drop fields; it only normalises the
 *     spelling of numerically equal numbers (Valhalla writes integral doubles as `0.0`,
 *     JavaScript writes `0`). A route that differs in a single manoeuvre, a single coordinate
 *     in the encoded shape, or a single cost is still a difference.
 *
 * There is no numeric tolerance, no key reordering and no "close enough" path. On any
 * difference the runner prints the first differing region with both sides' context, records it
 * in the report, and exits non-zero.
 *
 * Two optional inputs turn a difference into a diagnosis without ever softening a verdict:
 *
 * - `tools/verify/native-sdk-normalised.jsonl` — the pinned native binary's answers to the
 *   requests after the SDK host's own rewrite (`corpus.mjs --sdk-normalised`). If native answers
 *   the rewritten request exactly as the WASM half did, the engines agree and only the request
 *   differed.
 * - `tools/verify/wasm-deadline-lifted.jsonl` — the same WASM runtime driven without the host's
 *   per-operation deadline (`tools/verify/long-run.mjs`). If it answers as native does, the host
 *   deadline, not the engine, is what stopped the case.
 *
 * Neither is allowed to soften the headline: the classification in `normalise.mjs` fails closed,
 * so a difference with no control verdict is reported as *unclassified* and the zero-disagreement
 * sentence is withheld rather than asserted without evidence.
 *
 * Every compared half is also guarded by provenance (`tools/verify/provenance.mjs`): the corpus
 * sha256 it answers is recorded beside it and checked before anything is compared, so a corpus
 * edit can never be silently compared against the previous corpus's output.
 *
 * Usage: node tools/verify/compare.mjs <release> [--reuse-wasm]
 * `--reuse-wasm` rebuilds the report from the already recorded `tools/verify/wasm.jsonl`.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRouter } from 'valhalla-server/node';
import { serveDataset } from '../serve-dataset.mjs';
import { assertAligned, NORMALISED_CORPUS_PATH } from './corpus.mjs';
import { canonicalJson, classifyDifferences, differenceContext, firstDifference, normaliseRoutingError, summarise } from './normalise.mjs';
import { outputProblem, readProvenance, recordOutput } from './provenance.mjs';

/**
 * The two largest tiles in this release are 48,442,160 B and 37,395,280 B, both Jakarta-area.
 * The SDK's default `memoryBudgetBytes` is 32 MiB, so with the default `initialize()` refuses
 * this dataset outright — `INVALID_REQUEST: Memory budget must fit the largest individual tile
 * in this dataset.` — an SDK-side gate that has nothing to do with routing correctness. 96 MiB
 * covers the largest tile with room to spare and stays inside the SDK's 128 MiB ceiling.
 */
const MEMORY_BUDGET_BYTES = 100663296;
/** Node's server router aborts an operation after `routeTimeoutMs` (default 30 s, maximum 300 s). Long-distance routes on a 2 GB graph need the maximum. */
const ROUTE_TIMEOUT_MS = 300000;
/** Port for the local release server; must not collide with `tools/smoke` (8789) or the default (8788). */
const PORT = 8790;
const CORPUS_PATH = join('tools', 'verify', 'corpus.jsonl');
const NAMES_PATH = join('tools', 'verify', 'corpus-names.json');
const NATIVE_PATH = join('tools', 'verify', 'native.jsonl');
const NATIVE_INSPECT_PATH = join('tools', 'verify', 'native-inspect.json');
/** Optional control output: the pinned native binary's answers to `corpus-sdk-normalised.jsonl`. */
const NORMALISED_NATIVE_PATH = join('tools', 'verify', 'native-sdk-normalised.jsonl');
/** Optional engine-level answers from `long-run.mjs` (same runtime, host deadline lifted). */
const LIFTED_PATH = join('tools', 'verify', 'wasm-deadline-lifted.jsonl');
const WASM_PATH = join('tools', 'verify', 'wasm.jsonl');
const REPORT_DIR = join('docs', 'datasets');

const readLines = path => {
  const text = readFileSync(path, 'utf8');
  return text.length ? text.replace(/\n$/, '').split('\n') : [];
};
const sha256 = text => createHash('sha256').update(text).digest('hex');
const short = hash => hash.slice(0, 12);
const utcNow = () => `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`;

/**
 * Run every corpus case through the WASM router and normalise the outcome.
 *
 * Each case is appended to `tools/verify/wasm.jsonl` as soon as it finishes, so the evidence
 * accumulates while a long run is still going and a later `--reuse-wasm` pass can rebuild the
 * report without re-routing anything.
 *
 * @returns {Promise<Array<{ text: string, value: unknown, error?: unknown, ms: number }>>}
 */
async function runWasm(router, corpus, onProgress) {
  writeFileSync(WASM_PATH, '');
  const results = [];
  for (const [index, line] of corpus.entries()) {
    const started = Date.now();
    let entry;
    try {
      const result = await router.route(JSON.parse(line));
      const text = canonicalJson(result.native);
      entry = { text, value: result.native, ms: Date.now() - started };
      onProgress?.(index, 'ok', result.native, text);
    } catch (error) {
      const normalised = normaliseRoutingError(error);
      const text = canonicalJson(normalised);
      entry = { text, value: normalised, error, ms: Date.now() - started };
      onProgress?.(index, error?.nativeCode !== undefined ? 'native-error' : 'sdk-error', normalised, text, error);
    }
    appendFileSync(WASM_PATH, `${entry.text}\n`);
    results.push(entry);
  }
  return results;
}

/** Markdown table row cells must not contain pipes or newlines. */
const cell = value => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');

async function main() {
  const release = process.argv[2];
  if (!release) throw new Error('usage: node tools/verify/compare.mjs <release> [--reuse-wasm]');
  // `--reuse-wasm` rebuilds the comparison and the report from the already written
  // `tools/verify/wasm.jsonl` instead of routing again, which keeps a report-only fix cheap.
  const reuseWasm = process.argv.includes('--reuse-wasm');
  const releaseDir = join('public', 'datasets', release);

  // --- inputs -----------------------------------------------------------------------------
  const corpusText = readFileSync(CORPUS_PATH, 'utf8');
  const corpus = readLines(CORPUS_PATH);
  const names = assertAligned(corpus, JSON.parse(readFileSync(NAMES_PATH, 'utf8')));
  // Provenance before anything else: the halves are aligned by line index, so a native output
  // recorded against a different corpus would be compared, case by case, with the wrong requests.
  // Refusing here is the whole point — a stale pair must fail loudly, never compare confidently.
  const nativeText = existsSync(NATIVE_PATH) ? readFileSync(NATIVE_PATH, 'utf8') : null;
  const nativeProblem = outputProblem({ outputPath: NATIVE_PATH, text: nativeText, requestPath: CORPUS_PATH, requestText: corpusText, corpusPath: CORPUS_PATH, corpusText });
  if (nativeProblem) {
    throw new Error(`${nativeProblem}. Produce the native half on the build host and stamp it with \`node tools/verify/stamp.mjs ${NATIVE_PATH}\` before comparing.`);
  }
  const nativeLines = readLines(NATIVE_PATH);
  // The native half normalises failures itself; we only reject a file that cannot be a JSONL of responses.
  const nativeRaw = corpus.map((_, index) => nativeLines[index] ?? null);
  if (nativeLines.length !== corpus.length) {
    console.error(`WARNING: ${NATIVE_PATH} has ${nativeLines.length} lines for ${corpus.length} cases; missing cases are reported as differences.`);
  }

  // --- WASM half --------------------------------------------------------------------------
  let wasm;
  let startup = null;
  if (reuseWasm) {
    const problem = outputProblem({ outputPath: WASM_PATH, text: existsSync(WASM_PATH) ? readFileSync(WASM_PATH, 'utf8') : null, requestPath: CORPUS_PATH, requestText: corpusText, corpusPath: CORPUS_PATH, corpusText });
    if (problem) throw new Error(`--reuse-wasm: ${problem}; route again, or stamp it with \`node tools/verify/stamp.mjs ${WASM_PATH}\` if you know it answers the current corpus.`);
    const lines = readLines(WASM_PATH);
    if (lines.length !== corpus.length) throw new Error(`--reuse-wasm: ${WASM_PATH} has ${lines.length} lines for ${corpus.length} cases.`);
    console.log(`reusing ${WASM_PATH}`);
    wasm = lines.map((text, index) => ({ text, value: JSON.parse(text), ms: null, reused: true, name: names[index] }));
  } else {
    const server = await serveDataset({ root: releaseDir, port: PORT });
    const router = await createRouter({
      manifestUrl: `${server.url}/manifest.json`,
      transport: 'indexed-tar',
      memoryBudgetBytes: MEMORY_BUDGET_BYTES,
      routeTimeoutMs: ROUTE_TIMEOUT_MS,
    });
    // Prove the budget took effect where the router was created instead of trusting the option:
    // the SDK echoes the effective value in its startup result.
    if (router.startup?.memoryBudgetBytes !== MEMORY_BUDGET_BYTES) {
      throw new Error(`Router started with memoryBudgetBytes ${router.startup?.memoryBudgetBytes}, expected ${MEMORY_BUDGET_BYTES}.`);
    }
    startup = router.startup;
    try {
      wasm = await runWasm(router, corpus, (index, kind, value, text, error) => {
        const extra = kind === 'ok' ? '' : ` [${error?.code}${error?.nativeCode !== undefined ? ` nativeCode ${error.nativeCode}` : ''}]`;
        console.log(`  ${String(index + 1).padStart(2)}/${corpus.length} ${names[index]} — ${kind}${extra} (${text.length} bytes)`);
      });
    } finally {
      await router.dispose();
      await server.close();
    }
  }

  // --- comparison -------------------------------------------------------------------------
  // Optional control: the pinned native binary's answers to the SDK-normalised requests
  // (`corpus.mjs --sdk-normalised`, produced on the build host). It never changes a verdict or
  // the exit code; it only says whether a difference is the SDK rewriting the request or the two
  // engines genuinely disagreeing. A control that is missing, truncated or recorded against a
  // different corpus is unusable, and the classification then reports the affected differences as
  // *unclassified* instead of asserting the zero-disagreement sentence without evidence.
  const controlText = existsSync(NORMALISED_NATIVE_PATH) ? readFileSync(NORMALISED_NATIVE_PATH, 'utf8') : null;
  // The control answers the *rewritten* requests, so its own request file is checked too: a
  // regenerated control corpus with a stale control output would otherwise be classified against
  // requests the SDK no longer sends.
  const normalisedCorpusText = existsSync(NORMALISED_CORPUS_PATH) ? readFileSync(NORMALISED_CORPUS_PATH, 'utf8') : null;
  const controlProblem = normalisedCorpusText === null
    ? `${join('tools', 'verify', 'corpus-sdk-normalised.jsonl')} is missing; generate it with \`node tools/verify/corpus.mjs <release> --sdk-normalised\``
    : outputProblem({ outputPath: NORMALISED_NATIVE_PATH, text: controlText, requestPath: NORMALISED_CORPUS_PATH, requestText: normalisedCorpusText, corpusPath: CORPUS_PATH, corpusText });
  const control = controlProblem === null ? readLines(NORMALISED_NATIVE_PATH) : null;
  const controlNote = controlProblem === null ? null
    : `The SDK-normalised control output (\`${NORMALISED_NATIVE_PATH}\`) is unusable for this run (${controlProblem})`;
  if (controlProblem) console.error(`WARNING: ${controlNote}; differing cases without a control verdict are reported as unclassified.`);
  // Optional engine-level answers for cases the host deadline could not finish (`long-run.mjs`).
  const liftedProblem = outputProblem({ outputPath: LIFTED_PATH, text: existsSync(LIFTED_PATH) ? readFileSync(LIFTED_PATH, 'utf8') : null, requestPath: CORPUS_PATH, requestText: corpusText, corpusPath: CORPUS_PATH, corpusText });
  const lifted = liftedProblem === null ? readLines(LIFTED_PATH).map(text => (text === 'null' ? null : text)) : null;
  if (liftedProblem && existsSync(LIFTED_PATH)) console.error(`WARNING: ${LIFTED_PATH} is unusable for this run (${liftedProblem}); the deadline-lifted diagnosis is skipped.`);

  const rows = corpus.map((_, index) => {
    const nativeText = nativeRaw[index];
    const wasmEntry = wasm[index];
    let nativeValue = null;
    let nativeCanonical = null;
    let nativeError = null;
    if (nativeText !== null) {
      try {
        const parsed = JSON.parse(nativeText);
        nativeValue = parsed;
        nativeCanonical = canonicalJson(parsed);
      } catch (error) {
        nativeError = `native line is not JSON: ${error.message}`;
      }
    }
    const identical = nativeCanonical !== null && nativeCanonical === wasmEntry.text;
    const offset = nativeCanonical === null ? -1 : firstDifference(nativeCanonical, wasmEntry.text);
    // Control verdict for this case, when the control output is available.
    let controlCanonical = null;
    let controlIdentical = null;
    let controlOffset = -1;
    if (control) {
      controlCanonical = canonicalJson(JSON.parse(control[index]));
      controlIdentical = controlCanonical === wasmEntry.text;
      controlOffset = firstDifference(controlCanonical, wasmEntry.text);
    }
    return {
      name: names[index],
      request: corpus[index],
      nativeText,
      nativeCanonical,
      nativeValue,
      nativeError,
      wasmText: wasmEntry.text,
      wasmValue: wasmEntry.value,
      wasmError: wasmEntry.error,
      wasmMs: wasmEntry.ms,
      identical,
      offset,
      controlCanonical,
      controlIdentical,
      controlOffset,
      // Engine-level answer for this case from a deadline-lifted run, when one was recorded.
      liftedText: lifted?.[index] ?? null,
      // `null` (not `false`) when no lifted answer exists: "nobody ran this without the deadline"
      // and "the deadline-lifted run disagreed" are different facts, and the classification must
      // not read the absence of evidence as a disagreement.
      liftedIdentical: lifted?.[index] == null || nativeCanonical === null ? null : lifted[index] === nativeCanonical,
      liftedOffset: lifted?.[index] != null && nativeCanonical !== null ? firstDifference(nativeCanonical, lifted[index]) : -1,
      // Informational only: the raw native line differs from its canonical form in the spelling
      // of integral doubles (`0.0` versus `0`). Never used to decide the verdict.
      nativeRawCanonical: nativeCanonical !== null && nativeText === nativeCanonical,
      sha: identical ? short(sha256(nativeCanonical)) : null,
    };
  });
  const differing = rows.filter(row => !row.identical);
  const missingNative = rows.filter(row => row.nativeText === null);
  const sdkGated = rows.filter(row => row.wasmValue?.sdkError);
  const nativeErrorRows = rows.filter(row => typeof row.nativeValue?.nativeError === 'number');
  // The classification fails closed: see `classifyDifferences`. A differing case whose WASM answer
  // is byte-identical to native's answer for the same SDK-normalised request is a request-rewrite
  // difference; a case with no control verdict is *unclassified*, and the zero-disagreement
  // sentence is withheld rather than asserted from missing evidence.
  const verdict = classifyDifferences(differing, { controlAvailable: control !== null, controlNote });
  const { byNormalisation, bySdkGate, byDeadline, unclassified } = verdict;

  const wasmText = `${rows.map(row => row.wasmText).join('\n')}\n`;
  writeFileSync(WASM_PATH, wasmText);
  // Record which corpus this half answers, so `--reuse-wasm` (and any later reader) can tell
  // whether the recorded output still belongs to the committed corpus.
  recordOutput({ outputPath: WASM_PATH, text: wasmText, requestPath: CORPUS_PATH, requestText: corpusText, corpusPath: CORPUS_PATH, corpusText, source: reuseWasm ? 'reused wasm.jsonl (provenance re-checked)' : `compare.mjs (memoryBudgetBytes ${MEMORY_BUDGET_BYTES})` });

  // --- report -----------------------------------------------------------------------------
  const baseline = rows.find(row => row.name === 'jakarta-bandung-auto');
  const effects = [
    ['shape-geojson', '`shape_format: "geojson"` — in Valhalla 3.8.3 only the matrix and OSRM serializers consult this option, not the trip serializer'],
    ['preferred-side-opposite', '`preferred_side: "opposite"` on the origin — honoured by loki\'s side filter when the snapped edge has a side of street'],
    ['no-tolls', '`costing_options.auto.use_tolls: 0, use_highways: 0.2`'],
    ['depart-0700', '`date_time.type: 1` (depart at 2026-09-28T07:00)'],
    ['arrive-1700', '`date_time.type: 2` (arrive by 2026-09-28T17:00)'],
  ].map(([name, label]) => {
    const row = rows.find(candidate => candidate.name === name);
    if (!row) return { label, effect: 'case missing from the corpus' };
    if (row.nativeCanonical === null) return { label, effect: 'no native output' };
    const unchanged = baseline ? row.nativeCanonical === baseline.nativeCanonical : false;
    return {
      label,
      effect: unchanged
        ? 'accepted by both engines, byte-identical response to the plain `auto` case — no effect here'
        : 'accepted by both engines, response differs from the plain `auto` case',
    };
  });

  const report = [
    `# Verification — ${release}`,
    '',
    `Native-versus-WASM comparison of ${rows.length} requests on the published Indonesia graph:`,
    `**${rows.length - differing.length} identical, ${differing.length} different** (exit code ${differing.length === 0 ? 0 : 1}).`,
    '',
    '## What was compared',
    '',
    `- Corpus: \`${CORPUS_PATH}\` (${rows.length} pure Valhalla requests, sha256 \`${short(sha256(readFileSync(CORPUS_PATH, 'utf8')))}\`),`,
    `  case names in \`${NAMES_PATH}\` (sidecar alignment asserted at runtime).`,
    `- Alignment: the halves are lined up by index, so each recorded output is stamped with the`,
    `  corpus sha256 it answers (\`tools/verify/provenance.json\`, written by \`compare.mjs\` for the`,
    `  half it runs and by \`tools/verify/stamp.mjs\` for the native half) and the runner refuses to`,
    `  compare a pair whose stamp does not match the committed corpus. Native half stamped`,
    `  \`${(readProvenance().outputs[NATIVE_PATH]?.corpus?.sha256 ?? 'unknown').slice(0, 12)}\`; this half is stamped as it is written.`,
    `- Native half: the pinned \`native-reference\` binary (\`native/reference.cpp\`) inside the`,
    `  \`valhalla-browser-build:latest\` image, reading the build work directory tiles:`,
    '  `docker run --rm --user 1000:1000 -v "$PWD:/work" -w /work valhalla-browser-build \\`',
    '  `build/native/native-reference build/osm-2h8ekft8/native-config.json tools/verify/corpus.jsonl`.',
    `  Output \`${NATIVE_PATH}\` (${nativeLines.length} lines, sha256 \`${short(sha256(readFileSync(NATIVE_PATH, 'utf8')))}\`).`,
    `- WASM half: \`${release}\` served by \`tools/serve-dataset.mjs\` on port ${PORT} and routed through`,
    '  `valhalla-server/node` with `transport: "indexed-tar"`,',
    `  \`memoryBudgetBytes: ${MEMORY_BUDGET_BYTES}\` (96 MiB — the largest tile in this release is 48,442,160 B,`,
    '  and the SDK default of 32 MiB refuses to initialize against this dataset at all) and',
    `  \`routeTimeoutMs: ${ROUTE_TIMEOUT_MS}\`. Output \`${WASM_PATH}\` (sha256 \`${short(sha256(readFileSync(WASM_PATH, 'utf8')))}\`).`,
    `  ${reuseWasm ? 'This report was rebuilt with `--reuse-wasm` from that recorded output.' : `Routing the ${rows.length} cases took ${(rows.reduce((total, row) => total + (row.wasmMs ?? 0), 0) / 1000).toFixed(1)} s of WASM wall time.`}`,
    ...(startup ? [
      `  Startup identity: release \`${startup.release}\`, costings \`${startup.supportedCostings.join(', ')}\`,`,
      `  \`memoryBudgetBytes\` ${startup.memoryBudgetBytes}, WASM memory ${startup.wasmMemory.initialMiB}/${startup.wasmMemory.maximumMiB} MiB,`,
      `  config sha256 \`${short(startup.configSha256)}\`, effective config sha256 \`${short(startup.effectiveConfigSha256)}\`.`,
    ] : []),
    `- SDK build: \`pnpm run build:sdk\` was re-run after \`packages/valhalla-core/src/profiles.ts\` stopped`,
    `  forcing \`radius\`/\`minimum_reachability\` onto every location, so this run measures the fixed host`,
    `  (a first attempt against the stale \`dist\` bundle still reproduced the old forced-default answers).`,
    `- Native graph audit (\`native-reference <config> --inspect\`): \`${existsSync(NATIVE_INSPECT_PATH) ? readFileSync(NATIVE_INSPECT_PATH, 'utf8').trim() : 'not recorded'}\`.`,
    '',
    '### The equality rule',
    '',
    'Both sides are serialised with `JSON.stringify` of the parsed response and compared as text.',
    'The comparison does **not** sort or reorder keys, does not touch numbers, and does not drop',
    'fields; a route that differs by one manoeuvre, one coordinate in the encoded shape, or one',
    'cost is a difference. The only normalisations are:',
    '',
    '1. a failure becomes `{"nativeError":N}` on both sides — the SDK throws a `RoutingError`',
    '   carrying the same Valhalla code in `nativeCode`, and an SDK-level failure with no native',
    '   code is reported as `sdkError` instead, never as agreement; and',
    '2. numerically equal numbers may be spelled differently (`0.0` natively, `0` in JavaScript).',
    `   ${rows.filter(row => row.nativeRawCanonical).length} of ${rows.length} raw native lines already equalled their canonical form.`,
    '',
    ...(rows.some(row => !row.nativeRawCanonical) ? [
      'For example, the raw native line and its canonical form first diverge here:',
      '',
      '```',
      ...(() => {
        const row = rows.find(candidate => !candidate.nativeRawCanonical && candidate.nativeCanonical);
        const offset = firstDifference(row.nativeText, row.nativeCanonical);
        return [`native raw: ${differenceContext(row.nativeText, offset, 40)}`, `canonical:  ${differenceContext(row.nativeCanonical, offset, 40)}`];
      })(),
      '```',
      '',
    ] : []),
    '### Expected non-zero outcomes',
    '',
    'A case where both engines refuse to route is agreement, not a failure: the corpus deliberately',
    'includes pairs that may have no road connection. Both sides reporting `nativeError` is a pass;',
    `only a disagreement is a difference. This run had ${nativeErrorRows.length} case(s) where native reported an error.`,
    '',
    ...(differing.length ? [
      '### Why the differing cases differ',
      '',
      `Of ${differing.length} differing case(s): ${verdict.headline}`,
      '',
      `- ${byNormalisation.length} are explained by the SDK rewriting the request. The SDK host`,
      '  (`packages/valhalla-core/src/profiles.ts`) resolves the costing, pins `units` to kilometres',
      '  and resolves the language before the WASM engine sees it — and, since the correlation-default fix,',
      '  leaves each location\'s `radius` and `minimum_reachability` exactly as the caller sent them,',
      `  so native\'s own correlation defaults apply. \`${NORMALISED_NATIVE_PATH}\` records the pinned native`,
      `  binary's answers to those same rewritten requests (generated from \`${join('tools', 'verify', 'corpus-sdk-normalised.jsonl')}\`);`,
      '  for such a case the native answer for the rewritten request is byte-identical to the WASM',
      '  answer, so the engines agree and only the request differs.',
      `- ${verdict.disagreementStatement}`,
      `- ${bySdkGate.length} are SDK-level failures with no engine answer at all (a host gate such as the`,
      '  operation deadline or a resource limit), reported as `sdkError` rather than as agreement.',
      ...(byDeadline.length ? [
        `  Of those, ${byDeadline.length} were re-run through the same WASM engine with the host deadline`,
        `  lifted (\`${LIFTED_PATH}\`, produced by \`tools/verify/long-run.mjs\`): the engine then answered`,
        '  byte-identically to native, so the route itself is correct and only the host could not wait',
        '  for it. The cases are still counted as differences here — the product path did not produce',
        '  the native answer — and the deadline is a finding for the browser product, not for the engine.',
      ] : []),
      '',
    ] : []),
    '## Per-case results',
    '',
    '| # | Case | Native | WASM | Verdict |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row, index) => `| ${index + 1} | \`${row.name}\` | ${cell(summarise(row.nativeValue) + (row.nativeError ? ` (${row.nativeError})` : ''))} | ${cell(summarise(row.wasmValue))} | ${row.identical ? `identical \`${row.sha}\`` : `**different** at byte ${row.offset}`} |`),
    '',
    '## Field findings',
    '',
    'These cases exist to settle whether `shape_format` and `preferred_side` are accepted, and what',
    'they actually do. "Effect on the response" compares the case against the plain `auto` request',
    '(`jakarta-bandung-auto`) on the same coordinates, using the native output.',
    '',
    '| Case | Field | Effect on the response |',
    '| --- | --- | --- |',
    ...effects.map(effect => `| — | ${effect.label} | ${cell(effect.effect)} |`),
    '',
    ...(differing.length ? [
      '## Differences',
      '',
      ...differing.flatMap(row => [
        `### \`${row.name}\``,
        '',
        `Request: \`${row.request}\``,
        '',
        '```',
        `native: ${row.nativeCanonical === null ? (row.nativeError ?? 'missing') : differenceContext(row.nativeCanonical, row.offset, 120)}`,
        `wasm:   ${differenceContext(row.wasmText, row.offset, 120)}`,
        '```',
        '',
        `- native: ${summarise(row.nativeValue)}${row.nativeError ? ` — ${row.nativeError}` : ''}`,
        `- wasm:   ${summarise(row.wasmValue)}${row.wasmError ? ` — ${row.wasmError.code}${row.wasmError.nativeCode !== undefined ? ` (nativeCode ${row.wasmError.nativeCode})` : ''}: ${row.wasmError.message}` : ''}`,
        `- first differing byte: ${row.offset} (native ${row.nativeCanonical?.length ?? 0} bytes, wasm ${row.wasmText.length} bytes)`,
        ...(row.wasmValue?.sdkError ? [
          '- SDK-normalisation control: not applicable — the WASM half produced no engine answer at all',
          '  (the SDK host stopped the operation before the engine returned), so there is nothing to',
          '  compare against the rewritten request.',
        ] : row.controlIdentical === null ? ['- SDK-normalisation control: not available for this run, so this difference is unclassified.'] : row.controlIdentical ? [
          `- SDK-normalisation control: **the engines agree**. Native, given the same request the SDK`,
          '  actually sends (the caller\'s locations unchanged plus `units` and the resolved language),',
          `  answers \`${summarise(row.wasmValue)}\` —`,
          '  byte-identical to the WASM answer. The difference is the SDK host rewriting the request,',
          '  not an engine or loader disagreement.',
        ] : [
          '- SDK-normalisation control: **still different**. Native and WASM disagree on the identical',
          `  normalised request too (first differing byte ${row.controlOffset} of native`,
          `  \`${summarise(JSON.parse(row.controlCanonical))}\`), so this is a genuine engine/loader disagreement.`,
        ]),
        ...(row.wasmValue?.sdkError ? (row.liftedText === null ? [
          '- Deadline-lifted engine run: not recorded for this case.',
        ] : row.liftedIdentical ? [
          '- Deadline-lifted engine run: **the engines agree**. The same WASM runtime, driven without the',
          `  host's per-operation deadline, answers \`${summarise(JSON.parse(row.liftedText))}\` — byte-identical`,
          `  to native. The host deadline (${ROUTE_TIMEOUT_MS / 1000} s), not the engine, is what stopped this case.`,
        ] : [
          `- Deadline-lifted engine run: **still different** at byte ${row.liftedOffset} — a genuine engine or loader disagreement.`,
        ]) : []),
        '',
      ]),
    ] : ['## Differences', '', 'None. Every corpus case produced identical JSON on both runtimes.', '']),
    '## Limitations',
    '',
    '- Every corpus request pins `directions_options.language` to `en-US`. Native Valhalla only',
    '  accepts a language it has a compiled locale for; this fork\'s SDK host otherwise sends',
    '  `id-ID` (`packages/valhalla-core/src/profiles.ts`), and the WASM runtime in this release ships',
    '  only the `en-US` locale, so the SDK default silently falls back to English. The corpus pins',
    '  the language explicitly instead of relying on that fallback; the pin is inert today, and',
    '  Indonesian narration is not available from this runtime build at all.',
    '- A handful of long-distance routes share one WASM session, so tile-cache state differs from a',
    '  cold single-request run. Routing output does not depend on cache state; only timing does.',
    '- The WASM half measures the **packaged** SDK (`packages/valhalla-server/dist`, bundled from',
    '  `packages/valhalla-core/src`), not the TypeScript sources. `pnpm run build:sdk` must be re-run',
    '  before this corpus whenever the core changes, or the comparison silently measures the',
    '  previous build — which is how the first attempt at this re-run still saw the old forced',
    '  correlation defaults after `profiles.ts` had been fixed.',
    '- This is a `route` action corpus. `isochrone`, `optimized_route` and `matrix` are exported by',
    '  the runtime but are not covered here.',
    '',
    `Generated ${utcNow()} by \`node tools/verify/compare.mjs ${release}\`.`,
    '',
  ].join('\n');

  const reportPath = join(REPORT_DIR, `${release}-verification.md`);
  writeFileSync(reportPath, `${report}\n`);

  for (const row of differing) {
    console.log(`\nDIFFERENCE ${row.name} at byte ${row.offset}`);
    console.log(`  native: ${row.nativeCanonical === null ? (row.nativeError ?? 'missing') : differenceContext(row.nativeCanonical, row.offset, 60)}`);
    console.log(`  wasm:   ${differenceContext(row.wasmText, row.offset, 60)}`);
    if (row.controlIdentical !== null) console.log(`  control (native on the SDK-normalised request): ${row.controlIdentical ? 'identical — the SDK rewrote the request' : 'still different'}`);
  }
  console.log(`\n${rows.length} cases: ${rows.length - differing.length} identical, ${differing.length} different`);
  if (differing.length) {
    console.log(`  of the differing: ${byNormalisation.length} explained by SDK request normalisation, ${verdict.verified} genuine engine disagreement(s), ${bySdkGate.length} SDK-level gate(s)${unclassified.length ? `, ${unclassified.length} unclassified` : ''}`);
    console.log(`  ${verdict.headline}`);
    // Fail closed: without a usable control verdict the classification cannot claim agreement,
    // and this line says so out loud rather than leaving it to a careful reader.
    if (verdict.unclassifiedNote) console.log(`  ${verdict.unclassifiedNote}`);
  }
  console.log(`report: ${reportPath}`);
  if (missingNative.length) console.log(`missing native output for: ${missingNative.map(row => row.name).join(', ')}`);
  if (sdkGated.length) console.log(`SDK-gated (no native code) cases: ${sdkGated.map(row => row.name).join(', ')}`);
  process.exitCode = differing.length === 0 ? 0 : 1;
}

await main();
