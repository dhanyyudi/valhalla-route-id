#!/usr/bin/env node
/**
 * Engine-level comparison for corpus cases the SDK host cannot finish in time.
 *
 * `compare.mjs` is the product path: it goes through `valhalla-server/node`, which applies the
 * SDK host's request normalisation and a hard per-operation deadline (`routeTimeoutMs`, maximum
 * 300 s). Long pedestrian and bicycle routes across Java exceed that deadline on this graph, and
 * the host reports `TIMEOUT` without ever producing an engine answer.
 *
 * This tool answers the question the product path cannot: *does the WASM engine agree with the
 * pinned native binary?* It drives the SDK's own worker entry point
 * (`valhalla-server/dist/node-worker.js`, the file `valhalla-server/node` spawns internally)
 * directly, with the same runtime, loader and dataset, and without the host admission deadline or
 * the host request rewrite. Every case is sent exactly as `corpus.jsonl` writes it, so the answer
 * is comparable with `native.jsonl` byte for byte.
 *
 * It writes `tools/verify/wasm-deadline-lifted.jsonl`, one canonical JSON answer per corpus line,
 * aligned by index, which `compare.mjs` reads as a diagnostic for cases its own run reported as an
 * SDK-level failure. It never changes a verdict or an exit code.
 *
 * Usage: node tools/verify/long-run.mjs <release> [case-name ...]
 * Requires a built SDK: `pnpm run build:sdk`.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { serveDataset } from '../serve-dataset.mjs';
import { assertAligned } from './corpus.mjs';
import { canonicalJson } from './normalise.mjs';

const PORT = 8792;
const MEMORY_BUDGET_BYTES = 100663296;
const CORPUS_PATH = join('tools', 'verify', 'corpus.jsonl');
const NAMES_PATH = join('tools', 'verify', 'corpus-names.json');
const OUT_PATH = join('tools', 'verify', 'wasm-deadline-lifted.jsonl');
const WORKER_PATH = join('packages', 'valhalla-server', 'dist', 'node-worker.js');

/** Cases the product path is expected to hit the deadline on; the default target set. */
const DEFAULT_TARGETS = ['jakarta-bandung-bicycle', 'jakarta-bandung-pedestrian', 'waypoints-three'];

const readLines = path => readFileSync(path, 'utf8').replace(/\n$/, '').split('\n');

/**
 * Minimal client for the SDK's worker-thread protocol
 * (packages/valhalla-server/src/thread-protocol.ts): `{id, type}` in, `{id, type, result|error}` out.
 */
function connectWorker() {
  // `tools/verify/` is two levels below the repository root, where the built SDK lives.
  const worker = new Worker(new URL(`../../${WORKER_PATH}`, import.meta.url));
  const pending = new Map();
  let sequence = 0;
  worker.on('message', message => {
    if (message.type === 'progress') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === 'error') entry.reject(Object.assign(new Error(message.error.message), message.error));
    else entry.resolve(message.result);
  });
  worker.on('error', error => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });
  return {
    send: message => new Promise((resolve, reject) => { pending.set(message.id, { resolve, reject }); worker.postMessage(message); }),
    nextId: () => ++sequence,
    close: () => worker.terminate(),
  };
}

async function main() {
  const release = process.argv[2];
  if (!release || release.startsWith('--')) throw new Error('usage: node tools/verify/long-run.mjs <release> [case-name ...]');
  const targets = process.argv.slice(3).filter(name => !name.startsWith('--'));
  if (!existsSync(WORKER_PATH)) throw new Error(`${WORKER_PATH} is missing; run \`pnpm run build:sdk\` first.`);

  const corpus = readLines(CORPUS_PATH);
  const names = assertAligned(corpus, JSON.parse(readFileSync(NAMES_PATH, 'utf8')));
  const selected = targets.length ? targets : DEFAULT_TARGETS;
  for (const name of selected) if (!names.includes(name)) throw new Error(`Unknown corpus case ${name}.`);

  const server = await serveDataset({ root: join('public', 'datasets', release), port: PORT });
  const worker = connectWorker();
  const started = Date.now();
  await worker.send({
    id: worker.nextId(),
    type: 'initialize',
    options: { manifestUrl: `${server.url}/manifest.json`, transport: 'indexed-tar', memoryBudgetBytes: MEMORY_BUDGET_BYTES },
  });
  console.log(`initialized in ${((Date.now() - started) / 1000).toFixed(1)}s against ${release} (no host deadline)`);

  // Start from whatever is already recorded so a long run can be extended case by case.
  const recorded = existsSync(OUT_PATH) ? readLines(OUT_PATH) : [];
  const answers = corpus.map((_, index) => recorded[index] ?? null);
  for (const name of selected) {
    const index = names.indexOf(name);
    const begin = Date.now();
    console.log(`start ${name} at ${new Date().toISOString()}`);
    try {
      const result = await worker.send({ id: worker.nextId(), type: 'route', request: JSON.parse(corpus[index]) });
      answers[index] = canonicalJson(result.native);
      console.log(`done  ${name} in ${((Date.now() - begin) / 1000).toFixed(1)}s (${answers[index].length} bytes)`);
    } catch (error) {
      answers[index] = canonicalJson({ sdkError: { code: error.code ?? 'UNKNOWN', message: error.message } });
      console.log(`fail  ${name} after ${((Date.now() - begin) / 1000).toFixed(1)}s code=${error.code} nativeCode=${error.nativeCode}`);
    }
    // Persist what is known; unrun cases keep a null placeholder so the file stays aligned.
    writeFileSync(OUT_PATH, `${answers.map(answer => answer ?? 'null').join('\n')}\n`);
  }

  await worker.close();
  await server.close();
  const filled = answers.filter(Boolean).length;
  console.log(`wrote ${filled}/${corpus.length} deadline-lifted answers to ${OUT_PATH}`);
}

await main();
