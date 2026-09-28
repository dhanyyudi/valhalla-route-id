#!/usr/bin/env node
/**
 * Record provenance for a verification output produced out of band.
 *
 * `tools/verify/compare.mjs` stamps the WASM half itself, because it writes it. The native half is
 * produced by the pinned binary on the build host, so its stamp is a separate, explicit step —
 * run this once the output is back in the working tree, and the comparison runner will refuse to
 * use it against any requests other than the ones it actually answered.
 *
 * Usage:
 *   node tools/verify/stamp.mjs <output.jsonl> [more.jsonl ...] [--source=<text>] [--requests=<corpus.jsonl>]
 *
 * `--requests` defaults to `tools/verify/corpus.jsonl`; pass
 * `--requests=tools/verify/corpus-sdk-normalised.jsonl` when stamping the control output, which
 * answers the SDK-rewritten requests rather than the committed corpus.
 *
 * Refuses an output whose line count does not match the request file, so a truncated or extended
 * file cannot be stamped by accident.
 */
import { existsSync, readFileSync } from 'node:fs';
import { CORPUS_PATH, NORMALISED_CORPUS_PATH } from './corpus.mjs';
import { countLines, recordOutput, sha256 } from './provenance.mjs';

const args = process.argv.slice(2);
const targets = args.filter(argument => !argument.startsWith('--'));
const source = args.find(argument => argument.startsWith('--source='))?.slice('--source='.length) ?? 'stamp.mjs';
const requestPath = args.find(argument => argument.startsWith('--requests='))?.slice('--requests='.length) ?? CORPUS_PATH;
if (!targets.length) throw new Error('usage: node tools/verify/stamp.mjs <output.jsonl> [...] [--source=<text>] [--requests=<file.jsonl>]');

const requestText = readFileSync(requestPath, 'utf8');
const requestLines = countLines(requestText);
const corpusText = readFileSync(CORPUS_PATH, 'utf8');
for (const target of targets) {
  if (!existsSync(target)) throw new Error(`${target} does not exist; nothing to stamp.`);
  const text = readFileSync(target, 'utf8');
  const lines = countLines(text);
  if (lines !== requestLines) throw new Error(`${target} has ${lines} line(s) for the ${requestLines}-line ${requestPath}; it cannot answer those requests.`);
  const record = recordOutput({ outputPath: target, text, requestPath, requestText, corpusPath: CORPUS_PATH, corpusText, source });
  console.log(`${target}: ${record.lines} lines, sha256 ${sha256(text).slice(0, 12)}, answers ${requestPath} ${record.request.sha256.slice(0, 12)}, aligned with corpus ${record.corpus.sha256.slice(0, 12)} (source: ${source})`);
}
