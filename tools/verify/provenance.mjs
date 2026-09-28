/**
 * Provenance guards for the Task 8 comparison runner: *which requests does a recorded output
 * answer?*
 *
 * `tools/verify/native.jsonl` is produced out of band (the pinned binary inside the build image on
 * the build host) and `tools/verify/wasm.jsonl` can be reused with `--reuse-wasm`, so either can
 * outlive the requests it was produced from. Both halves are aligned by line index, so editing the
 * corpus without re-running a half compares each half's answer against the *wrong request* —
 * confidently, silently and meaninglessly. Nothing about the output files themselves reveals that,
 * so each one is stamped with
 *
 * - the sha256 of the request file it answers (`tools/verify/corpus.jsonl`, or
 *   `tools/verify/corpus-sdk-normalised.jsonl` for the control output), and
 * - the sha256 of the corpus it is index-aligned with, which catches an output that was produced
 *   from a request file the corpus no longer generates,
 *
 * and both are checked before anything is compared.
 *
 * The record lives in `tools/verify/provenance.json` (regenerable evidence, gitignored, written by
 * `compare.mjs` for the half it runs and by `stamp.mjs` for the half produced out of band). It is
 * deliberately *not* committed: it describes files that are themselves never committed, and a
 * committed stamp would go stale the moment either side is re-run.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROVENANCE_PATH = join('tools', 'verify', 'provenance.json');

export const sha256 = text => createHash('sha256').update(text).digest('hex');
/** Line count of a JSONL file, ignoring a single trailing newline. */
export const countLines = text => (text.length ? text.replace(/\n$/, '').split('\n').length : 0);

/**
 * Everything the provenance record stores about one output file.
 *
 * `sha256` is taken over the text as UTF-8, so it equals the file's on-disk hash for any valid
 * UTF-8 JSONL (`sha256sum` agrees); the byte length is deliberately not recorded, because
 * `String#length` counts UTF-16 code units and would misreport a file holding multi-byte
 * characters.
 */
export const outputFacts = text => ({ sha256: sha256(text), lines: countLines(text) });

/**
 * Why a recorded output may not be compared against the current requests, or `null` when it may.
 *
 * Pure — this is the whole staleness rule, so the unit test can exercise every branch without
 * touching the filesystem.
 *
 * @param {{ sha256?: string, lines?: number, request?: { path?: string, sha256?: string }|null, corpus?: { path?: string, sha256?: string }|null }|undefined} recorded
 *   entry from the provenance file
 * @param {{ name: string, sha256: string, lines: number, requestPath: string, requestSha256: string, corpusPath: string, corpusSha256: string }} current
 *   what is on disk now
 * @returns {string|null} human-readable reason, or `null` when the output is current
 */
export function staleOutputReason(recorded, current) {
  if (!recorded) return `${current.name} has no provenance record`;
  if (recorded.request?.sha256 !== current.requestSha256)
    return `${current.name} answers requests with sha256 ${recorded.request?.sha256 ?? '(none)'} but ${current.requestPath} is now ${current.requestSha256}`;
  if (recorded.corpus?.sha256 !== current.corpusSha256)
    return `${current.name} was recorded against ${current.corpusPath} sha256 ${recorded.corpus?.sha256 ?? '(none)'}, but the corpus is now ${current.corpusSha256}`;
  if (recorded.lines !== current.lines) return `${current.name} was recorded with ${recorded.lines} line(s) but now has ${current.lines}`;
  if (recorded.sha256 !== current.sha256) return `${current.name} was recorded as sha256 ${recorded.sha256} but is now ${current.sha256}`;
  return null;
}

/** Read the provenance file; a missing file is an empty record rather than an error. */
export function readProvenance(path = PROVENANCE_PATH) {
  if (!existsSync(path)) return { outputs: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return { outputs: parsed.outputs ?? {} };
}

/**
 * Record one output file against the requests it answers and the corpus it is aligned with.
 * Returns the stored facts.
 */
export function recordOutput({ outputPath, text, requestPath, requestText, corpusPath, corpusText, source, provenancePath = PROVENANCE_PATH, recordedAt = new Date().toISOString() }) {
  const file = readProvenance(provenancePath);
  const facts = {
    ...outputFacts(text),
    request: { path: requestPath, sha256: sha256(requestText) },
    corpus: { path: corpusPath, sha256: sha256(corpusText), lines: countLines(corpusText) },
    source,
    recordedAt,
  };
  file.outputs[outputPath] = facts;
  writeFileSync(provenancePath, `${JSON.stringify(file, null, 2)}\n`);
  return facts;
}

/**
 * Why `outputPath` may not be compared against the current requests, or `null` when it may.
 * `text === null` means the output file is absent.
 */
export function outputProblem({ outputPath, text, requestPath, requestText, corpusPath, corpusText, provenancePath = PROVENANCE_PATH }) {
  if (text === null) return `${outputPath} is missing; produce it before comparing`;
  const recorded = readProvenance(provenancePath).outputs[outputPath];
  return staleOutputReason(recorded, {
    name: outputPath,
    ...outputFacts(text),
    requestPath,
    requestSha256: sha256(requestText),
    corpusPath,
    corpusSha256: sha256(corpusText),
  });
}
