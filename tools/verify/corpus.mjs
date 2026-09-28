#!/usr/bin/env node
/**
 * Generate the native-versus-WASM verification corpus (Task 8).
 *
 * Two files are written, and they must stay aligned by index:
 *
 * - `tools/verify/corpus.jsonl` — one **pure Valhalla request** per line. These lines are fed
 *   verbatim to the pinned native binary (`native-reference <config> <corpus.jsonl>`), which
 *   parses each line as an API request, so nothing that is not part of the Valhalla request
 *   schema may appear in them (a `name` field, for instance, would be ignored at best and
 *   rejected at worst).
 * - `tools/verify/corpus-names.json` — a JSON array of case names, aligned by index with the
 *   corpus lines, used only for reporting. `tools/verify/compare.mjs` asserts the two lengths
 *   match before comparing anything, so a misalignment fails loudly instead of silently
 *   comparing the wrong pair.
 *
 * Every case pins `directions_options.language` to `en-US`. Native Valhalla hoists
 * `directions_options` children to the top level (`src/worker.cc`) and only accepts a language it
 * has a compiled locale for, otherwise falling back to `en-US`; this fork's SDK host resolves the
 * request language from `directions_options.language` and otherwise sends `id-ID`
 * (`packages/valhalla-core/src/profiles.ts`). Neither build ships an `id-ID` locale — the WASM
 * runtime contains only `en-US` — so the SDK's default is inert today and both halves would
 * answer in English anyway. The corpus pins the language explicitly rather than depending on
 * that silent fallback, and the measured behaviour is recorded in the verification report.
 *
 * Usage: node tools/verify/corpus.mjs [release] [--sdk-normalised]
 *
 * The corpus is unchanged by the Task 8 fix round; `--sdk-normalised` should be re-run whenever
 * `sdkNormalised` changes, because the control output must answer the request the current SDK
 * actually sends.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Release the Task 8 corpus was built against; also the default for the CLI argument. */
export const DEFAULT_RELEASE = 'indonesia-260926-eab7ae90e4197185';
export const CORPUS_PATH = join('tools', 'verify', 'corpus.jsonl');
export const NAMES_PATH = join('tools', 'verify', 'corpus-names.json');
/** Control corpus: the same cases after the SDK host's own request normalisation. */
export const NORMALISED_CORPUS_PATH = join('tools', 'verify', 'corpus-sdk-normalised.jsonl');

const P = {
  jakarta: [-6.1754, 106.8272], bandung: [-6.9175, 107.6191], surabaya: [-7.2575, 112.7521],
  malang: [-7.9666, 112.6326], denpasar: [-8.6705, 115.2126], medan: [3.5952, 98.6722],
  merak: [-5.9318, 105.9964], bakauheni: [-5.8706, 105.7538], outside: [1.3521, 103.8198],
};
const loc = ([lat, lon]) => ({ lat, lon });
/** Language pin shared by every case; see the header comment. */
const language = { directions_options: { language: 'en-US' } };
const request = (name, payload) => ({ name, payload: { ...payload, ...language } });

/**
 * The corpus, in order. Names are reporting labels only; they never reach the native binary.
 * Payloads are exactly what a Valhalla client sends, with the shared language pin added.
 */
export const CASES = [
  request('jakarta-bandung-auto', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'auto' }),
  request('jakarta-bandung-motorcycle', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'motorcycle' }),
  request('jakarta-bandung-motor-scooter', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'motor_scooter' }),
  request('jakarta-bandung-bicycle', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'bicycle' }),
  request('jakarta-bandung-pedestrian', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'pedestrian' }),
  request('surabaya-malang-truck', {
    locations: [loc(P.surabaya), loc(P.malang)], costing: 'truck',
    costing_options: { truck: { height: 4.1, width: 2.6, length: 12, weight: 20, axle_load: 9 } },
  }),
  request('merak-bakauheni-ferry', { locations: [loc(P.merak), loc(P.bakauheni)], costing: 'auto' }),
  // The brief's label for this pair; it is Denpasar (Bali) to Medan (Sumatra), not a loop.
  request('denpasar-loop-motorcycle', { locations: [loc(P.denpasar), loc(P.medan)], costing: 'motorcycle' }),
  request('depart-0700', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'auto', date_time: { type: 1, value: '2026-09-28T07:00' } }),
  request('arrive-1700', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'auto', date_time: { type: 2, value: '2026-09-28T17:00' } }),
  request('no-tolls', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'auto', costing_options: { auto: { use_tolls: 0, use_highways: 0.2 } } }),
  request('waypoints-three', { locations: [loc(P.jakarta), loc(P.bandung), loc(P.surabaya)], costing: 'auto' }),
  request('shape-geojson', { locations: [loc(P.jakarta), loc(P.bandung)], costing: 'auto', shape_format: 'geojson' }),
  request('preferred-side-opposite', { locations: [{ ...loc(P.jakarta), preferred_side: 'opposite' }, loc(P.bandung)], costing: 'auto' }),
  request('outside-coverage', { locations: [loc(P.jakarta), loc(P.outside)], costing: 'auto' }),
  request('disconnected-island', { locations: [loc(P.jakarta), loc(P.medan)], costing: 'auto' }),
];

/** Field names that must never appear in a corpus line: the native binary parses the line as a request. */
const FORBIDDEN = ['name', 'case', 'label', 'note'];

/**
 * The request this fork's SDK host actually sends to the WASM engine.
 *
 * This mirrors `validateRequest` in `packages/valhalla-core/src/profiles.ts`: the caller's
 * locations are passed through unchanged, `costing` gets the SDK's `auto` default, `units` is
 * forced to kilometres, and the language comes from `directions_options.language` or defaults to
 * `id-ID`. It deliberately does **not** write `radius` or `minimum_reachability` any more: the
 * validator forwards those only when the caller sent them, so native's own defaults apply — see
 * the Task 8 review's fix 2 and the change note on `validateRequest`.
 *
 * The comparison runner uses this as a **control**: when a corpus case differs, running the pinned
 * native binary on this rewritten request shows whether the difference is the SDK's request
 * normalisation or a genuine engine disagreement.
 *
 * @param {Record<string, any>} request a corpus request
 */
export function sdkNormalised(request) {
  const costing = request.costing === undefined ? 'auto' : request.costing;
  return {
    ...request,
    locations: request.locations.map(point => ({ ...point, lat: point.lat, lon: point.lon })),
    costing,
    units: 'kilometers',
    language: request.directions_options && typeof request.directions_options.language === 'string' ? request.directions_options.language : 'id-ID',
  };
}

/**
 * Build corpus text and sidecar names, asserting the invariants the runner later relies on.
 * @returns {{ corpus: string, names: string[], lines: string[] }}
 */
export function buildCorpus(cases = CASES) {
  const lines = cases.map(entry => {
    const line = JSON.stringify(entry.payload);
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed.locations) || parsed.locations.length < 2) throw new Error(`${entry.name}: expected at least two locations.`);
    for (const field of FORBIDDEN) {
      if (Object.hasOwn(parsed, field)) throw new Error(`${entry.name}: corpus lines must be pure Valhalla requests, found "${field}".`);
    }
    return line;
  });
  const names = cases.map(entry => entry.name);
  if (names.length !== lines.length) throw new Error(`Corpus/name length mismatch: ${lines.length} lines, ${names.length} names.`);
  if (new Set(names).size !== names.length) throw new Error('Duplicate case names would make the report ambiguous.');
  return { corpus: `${lines.join('\n')}\n`, names, lines };
}

/** SHA-256 of the corpus bytes, recorded in the verification report. */
export const corpusSha256 = (corpus) => createHash('sha256').update(corpus).digest('hex');

/**
 * Assert that a corpus and its sidecar are aligned by index.
 *
 * The comparison runner calls this before it looks at any result: a shortened corpus or a stale
 * sidecar would otherwise compare case 5's native output against case 6's WASM output and report
 * a confident, meaningless verdict.
 *
 * @param {string[]} lines corpus lines, in file order
 * @param {unknown} names parsed sidecar contents
 */
export function assertAligned(lines, names) {
  if (!Array.isArray(names)) throw new Error(`${NAMES_PATH} must be a JSON array of case names.`);
  if (names.length !== lines.length) throw new Error(`Sidecar misalignment: ${lines.length} corpus lines but ${names.length} names in ${NAMES_PATH}.`);
  if (names.some(name => typeof name !== 'string' || !name)) throw new Error(`${NAMES_PATH} must contain non-empty strings.`);
  return names;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = process.argv[2] ?? DEFAULT_RELEASE;
  const manifestPath = join('public', 'datasets', release, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`No release manifest at ${manifestPath}; build or sync the release before generating the corpus.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { corpus, names, lines } = buildCorpus(CASES);
  mkdirSync(dirname(CORPUS_PATH), { recursive: true });
  writeFileSync(CORPUS_PATH, corpus);
  writeFileSync(NAMES_PATH, `${JSON.stringify(names, null, 2)}\n`);
  console.log(`wrote ${names.length} cases to ${CORPUS_PATH} (sha256 ${corpusSha256(corpus)})`);
  console.log(`wrote ${names.length} names to ${NAMES_PATH} for ${release} (${manifest.tiles ? Object.keys(manifest.tiles).length : '?'} tiles, costings ${manifest.costings?.join(', ')})`);

  // Control corpus: the same cases as the SDK host rewrites them before they reach the WASM
  // engine. Run it through the pinned native binary on the build host and the comparison runner
  // will use the result to separate "the SDK changed the request" from "the engines disagree".
  if (process.argv.includes('--sdk-normalised')) {
    const control = `${lines.map(line => JSON.stringify(sdkNormalised(JSON.parse(line)))).join('\n')}\n`;
    writeFileSync(NORMALISED_CORPUS_PATH, control);
    console.log(`wrote ${names.length} SDK-normalised cases to ${NORMALISED_CORPUS_PATH} (sha256 ${corpusSha256(control)})`);
  }
}
