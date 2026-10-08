import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { auditBatch } from '../public/modules/batch-engine.mjs';
import {
  Sha256, sha256Hex, WeightIntegrityError, normalizeWeightIntegrity, createWeightGuard, createProgressAggregator, describeModelError,
} from '../public/modules/model-runtime.mjs';
import {
  NLI_MODEL, MULTILINGUAL_NLI_MODEL, CONTEXT_WEIGHT_BYTES, contextWeightPin, aggregateContextScores,
  appendContextResults, runContextRisk, cancelContextRisk,
} from '../public/modules/context-risk.mjs';
import { MODEL as EMBEDDING_MODEL, EMBEDDING_WEIGHT, embeddingWeightPin, enrichReportWithAI, cancelSemanticAnalysis } from '../public/modules/semantic-ai.mjs';
import { aiExecutionState } from '../public/modules/dossier.mjs';
import { createRunManifest } from '../public/modules/run-manifest.mjs';

// Everything below uses SYNTHETIC bytes and mocked workers: it tests the protocol and the integrity logic,
// not real model downloads and not inference. Real-browser evidence is recorded separately in the patch report.
const nodeSha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('streaming SHA-256 equals node:crypto for every small length and for random chunking', () => {
  for (let length = 0; length <= 200; length += 1) {
    const bytes = randomBytes(length);
    assert.equal(sha256Hex(bytes), nodeSha(bytes), `length ${length}`);
  }
  const big = randomBytes(3_000_017);
  const hasher = new Sha256();
  for (let offset = 0; offset < big.length;) {
    const size = Math.min(big.length - offset, 1 + Math.floor(Math.random() * 90_000));
    hasher.update(big.subarray(offset, offset + size));
    offset += size;
  }
  assert.equal(hasher.digestHex(), nodeSha(big));
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// ---- BUG-09: weights are compared with the pinned hash before a session can exist ----------------------------------

const WEIGHT_URL = 'https://huggingface.co/Example/model/resolve/0123456789abcdef0123456789abcdef01234567/onnx/model_quantized.onnx';
function fakeCaches(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { deletes: [], puts: [] };
  const cache = {
    async match(key) {
      const entry = store.get(typeof key === 'string' ? key : key.url);
      return entry ? new Response(entry.slice(), { status: 200, headers: { 'content-length': String(entry.length) } }) : undefined;
    },
    async put(key, response) { calls.puts.push(key); store.set(typeof key === 'string' ? key : key.url, new Uint8Array(await response.arrayBuffer())); },
    async delete(key) { calls.deletes.push(key); return store.delete(typeof key === 'string' ? key : key.url); },
  };
  return { caches: { open: async () => cache }, store, calls };
}
async function drain(response) { return new Uint8Array(await response.arrayBuffer()); }
/** The same sequence transformers.js 3.8.1 performs: cache.match, else fetch, read everything, then cache.put. */
async function loadLikeTransformers(guard, scope, url) {
  const hit = await guard.cache.match(url);
  if (hit) return drain(hit);
  const response = await scope.fetch(url);
  const bytes = await drain(response);
  await guard.cache.put(url, new Response(bytes, { headers: response.headers }));
  return bytes;
}
function setup({ weights = randomBytes(2_000_000), cached = null, served = weights } = {}) {
  const pin = { url: WEIGHT_URL, sha256: nodeSha(weights), bytes: weights.length };
  const env = fakeCaches(cached ? { [WEIGHT_URL]: cached } : {});
  const network = { requests: 0 };
  const scope = { caches: env.caches, fetch: async () => { network.requests += 1; return new Response(served.slice(), { status: 200, headers: { 'content-length': String(served.length) } }); } };
  const guard = createWeightGuard({ pins: [pin], scope });
  guard.installFetch();
  return { pin, env, scope, guard, network, weights };
}

test('BUG-09 clean cached weights pass: observed hash equals the pin, recorded as verified', async () => {
  const weights = randomBytes(1_500_000);
  const { guard, pin, network, scope } = setup({ weights, cached: weights });
  const bytes = await loadLikeTransformers(guard, scope, WEIGHT_URL);
  assert.equal(nodeSha(bytes), pin.sha256);
  guard.assertVerified(pin);
  const summary = guard.summary(pin);
  assert.equal(summary.weightVerified, true);
  assert.equal(summary.status, 'verified');
  assert.equal(summary.observedSha256, pin.sha256);
  assert.equal(summary.bytes, weights.length);
  assert.equal(network.requests, 0);
});

for (const [name, corrupt] of [
  ['one flipped byte', (copy) => { copy[Math.floor(copy.length / 2)] ^= 0xff; }],
  ['a flipped 64 KiB block', (copy) => { for (let i = 700_000; i < 700_000 + 65_536; i += 1) copy[i] ^= 0xff; }],
]) {
  test(`BUG-09 cached weights with ${name} are refused, evicted and reported with an Arabic message`, async () => {
    const weights = randomBytes(1_500_000);
    const bad = Uint8Array.from(weights);
    corrupt(bad);
    const { guard, pin, env, scope } = setup({ weights, cached: bad });
    await assert.rejects(() => loadLikeTransformers(guard, scope, WEIGHT_URL), (error) => {
      assert.equal(error.name, 'WeightIntegrityError');
      assert.equal(error.code, 'weight_integrity_mismatch');
      assert.match(error.message, /[؀-ۿ]/);
      assert.doesNotMatch(error.message, /[A-Za-z]{5,}/);
      return true;
    });
    assert.deepEqual(env.calls.deletes, [WEIGHT_URL]);
    assert.equal(env.store.has(WEIGHT_URL), false);
    assert.throws(() => guard.assertVerified(pin), WeightIntegrityError);
    const summary = guard.summary(pin);
    assert.equal(summary.weightVerified, false);
    assert.equal(summary.status, 'mismatch');
    assert.notEqual(summary.observedSha256, pin.sha256);
    assert.equal(summary.declaredSha256, pin.sha256);
    // The failure is also what the worker reports, even if the library wrapped the stream error.
    assert.equal(guard.failure?.code, 'weight_integrity_mismatch');
  });
}

test('BUG-09 after eviction the next run downloads again and passes (hit, miss, fresh download, hit)', async () => {
  const weights = randomBytes(1_200_000);
  const bad = Uint8Array.from(weights);
  bad[10] ^= 1;
  const { guard, pin, env, scope, network } = setup({ weights, cached: bad });
  await assert.rejects(() => loadLikeTransformers(guard, scope, WEIGHT_URL), /WeightIntegrity|بصمة/);
  assert.equal(network.requests, 0);
  guard.clearFailure();
  const second = await loadLikeTransformers(guard, scope, WEIGHT_URL);
  assert.equal(network.requests, 1);
  assert.equal(nodeSha(second), pin.sha256);
  assert.equal(env.store.has(WEIGHT_URL), true);
  guard.assertVerified(pin);
  const third = await loadLikeTransformers(guard, scope, WEIGHT_URL);
  assert.equal(network.requests, 1);
  assert.equal(nodeSha(third), pin.sha256);
});

for (const buffered of [false, true]) {
  test(`BUG-09 a swallowed ${buffered ? 'buffered' : 'null-body'} cache refusal stays mismatched until the next attempt`, async () => {
    const weights = randomBytes(17_003);
    const { guard, pin, env, scope, network } = setup({ weights });
    env.store.set(WEIGHT_URL, new Uint8Array(0));
    if (!buffered) {
      const cache = await env.caches.open();
      const originalMatch = cache.match.bind(cache);
      cache.match = async (key, ...rest) => env.store.get(WEIGHT_URL)?.length === 0
        ? new Response(null, { status: 200, headers: { 'content-length': '0' } })
        : originalMatch(key, ...rest);
      assert.equal((await cache.match(WEIGHT_URL)).body, null, 'reproduces the verifier empty-cache response');
    }
    const savedTransformStream = globalThis.TransformStream;
    if (buffered) globalThis.TransformStream = undefined;
    let cacheError;
    try {
      // transformers.js 3.8.1 treats a cache lookup exception as a miss and falls back to fetch.
      await assert.rejects(async () => {
        let hit;
        try { hit = await guard.cache.match(WEIGHT_URL); } catch (error) { cacheError = error; }
        if (hit) return drain(hit);
        const response = await scope.fetch(WEIGHT_URL);
        const bytes = await drain(response);
        await guard.cache.put(WEIGHT_URL, new Response(bytes));
        return bytes;
      }, error => error === cacheError && error.code === 'weight_integrity_mismatch');
    } finally { globalThis.TransformStream = savedTransformStream; }
    assert.deepEqual(env.calls.deletes, [WEIGHT_URL]);
    assert.equal(env.store.has(WEIGHT_URL), false);
    assert.equal(network.requests, 0, 'no verified replacement overwrites a refused attempt');
    assert.equal(env.calls.puts.length, 0);
    assert.throws(() => guard.assertVerified(pin), error => error === cacheError);
    const failed = guard.summary(pin);
    assert.deepEqual([failed.status, failed.weightVerified, failed.bytes], ['mismatch', false, 0]);
    assert.equal(failed.observedSha256, nodeSha(new Uint8Array(0)));
    const report = appendContextResults(contextReport(), [], {
      actualInference: false, modelCalls: 0, completed: false, error: cacheError.message, weightIntegrity: failed,
    });
    assert.equal(report.provenance.analysis.contextWeightIntegrity.status, 'mismatch');
    assert.equal(report.provenance.analysis.contextWeightIntegrity.weightVerified, false);
    assert.equal(aiExecutionState(report).state, 'failed');

    guard.clearFailure();
    const retry = await loadLikeTransformers(guard, scope, WEIGHT_URL);
    assert.equal(network.requests, 1);
    assert.equal(nodeSha(retry), pin.sha256);
    guard.assertVerified(pin);
    assert.equal(guard.summary(pin).status, 'verified', 'a new attempt may verify a clean replacement');
    assert.equal(env.store.has(WEIGHT_URL), true);
  });
}

test('BUG-09 a tampered fresh download never reaches the session and is never written to the cache', async () => {
  const weights = randomBytes(1_000_000);
  const served = Uint8Array.from(weights);
  served[served.length - 1] ^= 0x10;
  const { guard, pin, env, scope } = setup({ weights, served });
  await assert.rejects(() => loadLikeTransformers(guard, scope, WEIGHT_URL), (error) => error.name === 'WeightIntegrityError');
  assert.equal(env.calls.puts.length, 0);
  assert.equal(env.store.has(WEIGHT_URL), false);
  assert.equal(guard.summary(pin).status, 'mismatch');
});

test('BUG-09 a truncated stream (right prefix, wrong length) is refused', async () => {
  const weights = randomBytes(900_000);
  const { guard, scope } = setup({ weights, served: weights.subarray(0, 600_000) });
  await assert.rejects(() => loadLikeTransformers(guard, scope, WEIGHT_URL), (error) => error.name === 'WeightIntegrityError');
});

test('BUG-09 fail closed: nothing hashed means the model is not allowed to run', () => {
  const pin = { url: WEIGHT_URL, sha256: 'a'.repeat(64), bytes: 10 };
  const guard = createWeightGuard({ pins: [pin], scope: {} });
  assert.throws(() => guard.assertVerified(pin), (error) => error.code === 'weight_not_verified' && /[؀-ۿ]/.test(error.message));
  const summary = guard.summary(pin);
  assert.equal(summary.weightVerified, false);
  assert.equal(summary.status, 'declared_not_verified');
  assert.equal(summary.observedSha256, null);
});

test('BUG-09 unpinned files (tokenizer, config, other hosts) are passed through untouched', async () => {
  const { guard, scope } = setup();
  const original = new Response('{"a":1}');
  scope.fetch = async () => original;
  const other = createWeightGuard({ pins: [{ url: WEIGHT_URL, sha256: 'b'.repeat(64) }], scope });
  other.installFetch();
  assert.equal(await scope.fetch('https://huggingface.co/Example/model/resolve/x/config.json'), original);
  assert.equal(await guard.cache.match('https://huggingface.co/Example/model/resolve/x/config.json'), undefined);
});

test('BUG-09 buffered fallback (no TransformStream) applies the same rule', async () => {
  const weights = randomBytes(300_000);
  const good = setup({ weights, cached: weights });
  const bad = setup({ weights, cached: Uint8Array.from(weights, (value, index) => index === 5 ? value ^ 1 : value) });
  const saved = globalThis.TransformStream;
  globalThis.TransformStream = undefined;
  try {
    assert.equal(nodeSha(await loadLikeTransformers(good.guard, good.scope, WEIGHT_URL)), good.pin.sha256);
    good.guard.assertVerified(good.pin);
    await assert.rejects(() => loadLikeTransformers(bad.guard, bad.scope, WEIGHT_URL), (error) => error.name === 'WeightIntegrityError');
    assert.equal(bad.env.store.has(WEIGHT_URL), false);
  } finally { globalThis.TransformStream = saved; }
});

test('BUG-09 large synthetic weights are verified chunk by chunk with the same result as one-shot hashing', async () => {
  const weights = randomBytes(24 * 1024 * 1024 + 13);
  const { guard, pin, scope } = setup({ weights, cached: weights });
  const hit = await guard.cache.match(WEIGHT_URL);
  let seen = 0;
  const reader = hit.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; seen += value.length; }
  assert.equal(seen, weights.length);
  assert.equal(guard.summary(pin).observedSha256, nodeSha(weights));
  assert.equal(scope.fetch.__mihakkWeightGuard, true);
});

test('BUG-09 pins: declared hashes, sizes and URLs for the three models (E5 pinned at its revision)', () => {
  for (const spec of [NLI_MODEL, MULTILINGUAL_NLI_MODEL]) {
    const pin = contextWeightPin(spec);
    assert.equal(pin.sha256, spec.weightSha256);
    assert.equal(pin.url, `https://huggingface.co/${spec.id}/resolve/${spec.revision}/onnx/model_quantized.onnx`);
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 100_000_000);
    assert.equal(CONTEXT_WEIGHT_BYTES[spec.id], pin.bytes);
  }
  assert.match(EMBEDDING_WEIGHT.sha256, /^[a-f0-9]{64}$/);
  assert.equal(embeddingWeightPin().url, `https://huggingface.co/${EMBEDDING_MODEL.id}/resolve/${EMBEDDING_MODEL.revision}/${EMBEDDING_WEIGHT.file}`);
  assert.equal(embeddingWeightPin().bytes, EMBEDDING_WEIGHT.bytes);
  assert.equal(EMBEDDING_WEIGHT.sha256, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193');
});

test('BUG-09 the frozen model specs are byte-identical to the base build (they are part of the evidence fingerprint)', () => {
  const digest = (value) => nodeSha(Buffer.from(JSON.stringify(value)));
  assert.equal(digest(NLI_MODEL), '6dea5e6f60c44c57ef98c9d04155bfa6b420b8767d3d80f3180732988d5e7c4e');
  assert.equal(digest(MULTILINGUAL_NLI_MODEL), '045b81b6738103a4897d2d9aa14afbd687037edd587a5a9769a8b543db1fb245');
  assert.equal(digest(EMBEDDING_MODEL), '53d8e967f0f94897481ad59ec6cb7d6fc4eacb9e59f12dc6e08d45fb9e838356');
});

test('BUG-09 the report says "declared" unless the worker proved the hash (forged flags do not count)', () => {
  const declared = 'c'.repeat(64);
  assert.deepEqual([normalizeWeightIntegrity(declared, undefined).status, normalizeWeightIntegrity(declared, undefined).weightVerified], ['declared_not_verified', false]);
  assert.equal(normalizeWeightIntegrity(declared, { weightVerified: true, observedSha256: 'd'.repeat(64) }).weightVerified, false);
  assert.equal(normalizeWeightIntegrity(declared, { weightVerified: true, observedSha256: 'd'.repeat(64) }).status, 'mismatch');
  assert.equal(normalizeWeightIntegrity(declared, { weightVerified: true }).weightVerified, false);
  const verified = normalizeWeightIntegrity(declared, { weightVerified: true, observedSha256: declared, bytes: 7, elapsedMS: 12.4 });
  assert.deepEqual([verified.weightVerified, verified.status, verified.bytes, verified.elapsedMS], [true, 'verified', 7, 12]);
});

// ---- report fields (additive) -------------------------------------------------------------------------------------

const contradict = { contradiction: 0.8, entailment: 0.1, neutral: 0.1 };
function contextReport() {
  return auditBatch({
    rows: [{ surah: 112, ayah: 1, translation: 'Bob approves Alice.', rowNumber: 8 }],
    referenceRows: [{ surah: 112, ayah: 1, translation: 'Alice approves Bob.', sourceURL: 'https://example.org/edition/112/1', rawSha256: 'a'.repeat(64), normalizedSha256: 'b'.repeat(64) }],
    scope: { type: 'provided' },
    metadata: { candidate: { name: 'Authored synthetic pair', language: 'en' }, reference: { language: 'en', verificationStatus: 'verified', sourceKind: 'synthetic-teaching', title: 'NONRELIGIOUS authored fixture' } },
  });
}
const rawResult = (key) => aggregateContextScores(contradict, contradict, { key, modelCalls: 2, pairTokens: 19, usedPairTokens: 19, referenceTokens: 8, candidateTokens: 8, truncated: false, inferredAt: '2026-10-03T00:00:00.000Z' });

test('BUG-09 context report: contextWeightIntegrity is additive, "declared" without proof, "verified" with it', async () => {
  const source = contextReport();
  const pin = contextWeightPin(NLI_MODEL);
  const withoutProof = appendContextResults(source, [rawResult(source.rows[0].key)], { actualInference: true, completed: true });
  assert.equal(withoutProof.provenance.analysis.contextWeightIntegrity.weightVerified, false);
  assert.equal(withoutProof.provenance.analysis.contextWeightIntegrity.status, 'declared_not_verified');
  assert.equal(withoutProof.provenance.analysis.contextModel.weightSha256, pin.sha256, 'the existing declared field is untouched');
  const proof = { observedSha256: pin.sha256, weightVerified: true, bytes: pin.bytes, elapsedMS: 1800 };
  const verified = appendContextResults(source, [rawResult(source.rows[0].key)], { actualInference: true, completed: true, weightIntegrity: proof });
  assert.equal(verified.provenance.analysis.contextWeightIntegrity.status, 'verified');
  assert.equal(verified.provenance.analysis.contextWeightIntegrity.observedSha256, pin.sha256);
  assert.equal('weightIntegrity' in verified.provenance.analysis.contextExecution, false, 'one copy only');
  const manifest = await createRunManifest({ report: verified, input: { rows: [{ surah: 112, ayah: 1, translation: 'Bob approves Alice.' }], referenceRows: [{ surah: 112, ayah: 1, translation: 'Alice approves Bob.' }], scope: { type: 'provided' }, metadata: {} } });
  assert.equal(manifest.layers.context.state, 'complete');
  assert.equal(manifest.layers.context.executionVerification, 'recorded-report-state-only');
});

test('BUG-09 a refused (mismatching) model is a failed AI run: the dossier gate is a hold, never complete', async () => {
  const oldWorker = globalThis.Worker;
  const mismatch = normalizeWeightIntegrity(NLI_MODEL.weightSha256, { weightVerified: false, observedSha256: 'e'.repeat(64), bytes: 5 });
  globalThis.Worker = class {
    postMessage({ id }) {
      queueMicrotask(() => this.onmessage({ data: { id, event: 'error', errorKind: 'integrity', technicalDetails: 'sha256 mismatch', message: 'لم يكتمل المؤشر السياقي: رُفض ملف النموذج لأن بصمته لا تطابق البصمة المثبتة. المقارنات المكتملة فقط محفوظة', execution: { actualInference: false, modelCalls: 0, completed: false, weightIntegrity: mismatch } } }));
    }
    terminate() {}
  };
  try {
    const output = await runContextRisk(contextReport());
    const analysis = output.provenance.analysis;
    assert.equal(analysis.contextCompleted, false);
    assert.equal(analysis.contextWeightIntegrity.status, 'mismatch');
    assert.equal(analysis.contextWeightIntegrity.weightVerified, false);
    assert.match(analysis.contextError, /بصمته لا تطابق/);
    assert.equal(aiExecutionState(output).state, 'failed');
    assert.equal(output.summary.contextProcessedRows, 0);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

// ---- BUG-26: one monotonic, bytes-weighted download percentage -----------------------------------------------------

function transformersLikeEvents({ weightBytes = 172_440_643, steps = 40 } = {}) {
  const events = [];
  const small = [['tokenizer.json', 2_400_000], ['tokenizer_config.json', 1_200], ['config.json', 900], ['special_tokens_map.json', 300]];
  for (const [file, total] of small) {
    events.push({ status: 'initiate', file }, { status: 'download', file }, { status: 'progress', file, progress: 100, loaded: total, total }, { status: 'done', file });
  }
  const file = 'onnx/model_quantized.onnx';
  events.push({ status: 'initiate', file }, { status: 'download', file });
  for (let step = 1; step <= steps; step += 1) events.push({ status: 'progress', file, progress: step / steps * 100, loaded: Math.round(weightBytes * step / steps), total: weightBytes });
  events.push({ status: 'done', file }, { status: 'ready', task: 'text-classification', model: 'x' });
  return events;
}

test('BUG-26 raw per-file events do go backwards (the bug), the aggregate never does', () => {
  const events = transformersLikeEvents();
  const raw = events.filter((event) => event.status === 'progress').map((event) => event.progress);
  assert.ok(raw.some((value, index) => index > 0 && value < raw[index - 1]), 'raw sequence contains 100 -> small value');
  const aggregator = createProgressAggregator({ expectedBytes: 172_440_643 });
  const shown = [aggregator.start()];
  for (const event of events) shown.push(aggregator.push(event));
  shown.push(aggregator.finish());
  const values = shown.filter(Boolean).map((event) => event.progress);
  assert.equal(values[0], 0);
  for (let index = 1; index < values.length; index += 1) assert.ok(values[index] >= values[index - 1], `${values[index - 1]} -> ${values[index]}`);
  assert.equal(values.at(-1), 100);
  assert.ok(values.slice(0, -1).every((value) => value < 100), 'no 100% before the model is really there');
  const early = shown.filter(Boolean).find((event) => event.loaded > 2_000_000);
  assert.ok(early.progress < 2, `finishing the small files must not look like a finished download (${early.progress}%)`);
});

test('BUG-26 events carry megabytes done/total and an Arabic message for the UI', () => {
  const aggregator = createProgressAggregator({ expectedBytes: 172_440_643 });
  aggregator.start();
  const last = transformersLikeEvents().map((event) => aggregator.push(event)).filter(Boolean).at(-1);
  assert.equal(last.status, 'progress');
  assert.equal(last.aggregated, true);
  assert.ok(last.totalMB > 160 && last.totalMB < 180);
  assert.ok(last.loadedMB <= last.totalMB);
  assert.match(last.message, /ميغابايت/);
});

test('BUG-26 cache hit (one file read quickly) and unknown totals stay monotonic and below 100 until finish()', () => {
  const aggregator = createProgressAggregator({ expectedBytes: 0 });
  const values = [];
  for (const event of [
    { status: 'progress', file: 'a', loaded: 10, total: 0 }, { status: 'progress', file: 'a', loaded: 50, total: 100 }, { status: 'progress', file: 'a', loaded: 20, total: 100 },
    { status: 'progress', file: 'b', loaded: 5, total: 5 }, { status: 'progress', file: 'a', loaded: 100, total: 100 },
  ]) { const out = aggregator.push(event); if (out) values.push(out.progress); }
  for (let index = 1; index < values.length; index += 1) assert.ok(values[index] >= values[index - 1]);
  assert.ok(values.every((value) => value <= 99));
  assert.equal(aggregator.finish().progress, 100);
  assert.equal(aggregator.push({ status: 'ready' }), null);
});

// ---- BUG-40: failure releases the worker, simple Arabic messages ---------------------------------------------------

test('BUG-40 raw ONNX / browser errors become simple Arabic; the original text is kept separately', () => {
  const onnx = "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.";
  const mapped = describeModelError(new Error(onnx));
  assert.equal(mapped.kind, 'corrupt_model');
  assert.match(mapped.message, /امسح بيانات الموقع/);
  assert.doesNotMatch(mapped.message, /ERROR_CODE|protobuf|session/i);
  assert.equal(mapped.technicalDetails, onnx);
  assert.equal(describeModelError('TypeError: Failed to fetch').kind, 'network');
  assert.equal(describeModelError(new Error('RangeError: Array buffer allocation failed')).kind, 'memory');
  assert.equal(describeModelError(new Error('Could not locate file: "https://huggingface.co/x".')).kind, 'server');
  assert.equal(describeModelError(new Error('Failed to fetch dynamically imported module: ort-wasm-simd-threaded.jsep.mjs')).kind, 'network');
  assert.equal(describeModelError(new Error('CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d')).kind, 'runtime');
  const unknown = describeModelError(new Error('something odd 0x1f'));
  assert.equal(unknown.kind, 'unknown');
  assert.doesNotMatch(unknown.message, /[A-Za-z]{4,}/);
  assert.equal(describeModelError(12345678).kind, 'unknown');
  assert.deepEqual(describeModelError(new Error('طلب مقارنة سياقية غير صالح.')), { kind: 'app', message: 'طلب مقارنة سياقية غير صالح', technicalDetails: null });
  assert.equal(describeModelError(new WeightIntegrityError('mismatch')).kind, 'integrity');
});

test('model errors describe self-hosted runtime access and recognised allocation failures honestly', () => {
  for (const raw of [
    'Aborted(OOM). Build with -sASSERTIONS for more info.',
    'Aborted( OOM )',
    'RuntimeError: failed to allocate a buffer',
    'FAILED TO ALLOCATE 172440643 BYTES',
  ]) {
    const mapped = describeModelError(new Error(raw));
    assert.equal(mapped.kind, 'memory', raw);
    assert.match(mapped.message, /ذاكرة المتصفح/);
    assert.doesNotMatch(mapped.message, /OOM|allocate|ASSERTIONS/i);
    assert.equal(mapped.technicalDetails, raw);
  }
  const network = describeModelError(new Error('TypeError: Failed to fetch'));
  assert.equal(network.kind, 'network');
  assert.match(network.message, /Hugging Face/);
  assert.match(network.message, /ملفات هذا الموقع/);
  assert.doesNotMatch(network.message, /jsDelivr/i);
  const runtime = describeModelError(new Error('CompileError: WebAssembly.instantiate(): expected magic word'));
  assert.equal(runtime.kind, 'runtime');
  assert.match(runtime.message, /ملفات المشغّل على هذا الموقع/);
  assert.doesNotMatch(runtime.message, /jsDelivr/i);
});

test('BUG-40 context mode: a failed run terminates the worker and the next run starts a new one; technical details are kept', async () => {
  const oldWorker = globalThis.Worker;
  let created = 0;
  let terminated = 0;
  globalThis.Worker = class {
    constructor() { created += 1; }
    postMessage({ id }) {
      queueMicrotask(() => this.onmessage({ data: { id, event: 'error', errorKind: 'corrupt_model', technicalDetails: "Can't create a session. ERROR_CODE: 7", message: 'لم يكتمل المؤشر السياقي: ملف النموذج المحفوظ تالف أو غير صالح؛ امسح بيانات الموقع. المقارنات المكتملة فقط محفوظة', execution: { actualInference: false, modelCalls: 0, completed: false } } }));
    }
    terminate() { terminated += 1; }
  };
  try {
    const first = await runContextRisk(contextReport());
    assert.equal(terminated, 1, 'worker released after the failure');
    assert.match(first.provenance.analysis.contextError, /امسح بيانات الموقع/);
    assert.doesNotMatch(first.provenance.analysis.contextError, /ERROR_CODE/);
    assert.equal(first.provenance.analysis.contextExecution.technicalDetails, "Can't create a session. ERROR_CODE: 7");
    await runContextRisk(contextReport());
    assert.equal(created, 2, 'a fresh worker per failed attempt');
    assert.equal(terminated, 2);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

test('BUG-40 context mode: a successful run still keeps the worker warm for reuse (no behaviour change)', async () => {
  const oldWorker = globalThis.Worker;
  let created = 0;
  let terminated = 0;
  globalThis.Worker = class {
    constructor() { created += 1; }
    postMessage({ id, inputs }) {
      queueMicrotask(() => {
        this.onmessage({ data: { id, event: 'chunk', results: [rawResult(inputs[0].key)] } });
        this.onmessage({ data: { id, event: 'result', execution: { actualInference: true, modelCalls: 2, completed: true } } });
      });
    }
    terminate() { terminated += 1; }
  };
  try {
    await runContextRisk(contextReport());
    await runContextRisk(contextReport());
    assert.equal(created, 1);
    assert.equal(terminated, 0);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

// ---- BUG-46 (and BUG-40 for the embedding worker): partial results are kept ----------------------------------------

function embeddingReport(count = 3) {
  const rows = Array.from({ length: count }, (_, index) => ({ key: `r${index + 1}`, rowNumber: index + 1, verseId: `1:${index + 1}`, status: 'no_signal', translation: `candidate ${index}`, reference: { translation: `reference ${index}`, provenance: { url: 'https://example.org' } }, comparisonStatus: 'compared', findings: [], findingIds: [] }));
  return { rows, findings: [], summary: {}, provenance: { analysis: { limitations: [] } } };
}
const similarityOf = (key, similarity = 0.95) => ({ key, similarity, candidateTokens: 4, referenceTokens: 4, candidateTruncated: false, referenceTruncated: false });

test('BUG-46 cancelling the embedding mode keeps the pairs that finished and records the cancelled/partial state', async () => {
  const oldWorker = globalThis.Worker;
  let terminated = 0;
  globalThis.Worker = class {
    postMessage({ id, action, payload }) {
      queueMicrotask(() => {
        if (action === 'load') { this.onmessage({ data: { id, event: 'result', result: { ready: true, weightIntegrity: { weightVerified: true, observedSha256: EMBEDDING_WEIGHT.sha256, bytes: EMBEDDING_WEIGHT.bytes } } } }); return; }
        this.onmessage({ data: { id, event: 'chunk', results: [similarityOf(payload.inputs[0].key)] } });
        this.onmessage({ data: { id, event: 'chunk', results: [similarityOf(payload.inputs[1].key, 0.2)] } });
        cancelSemanticAnalysis(); // what app.js does when the user presses "cancel"
      });
    }
    terminate() { terminated += 1; }
  };
  try {
    const output = await enrichReportWithAI(embeddingReport(3));
    const analysis = output.provenance.analysis;
    assert.equal(analysis.semanticProcessedRows, 2);
    assert.equal(analysis.semanticEligibleRows, 3);
    assert.equal(analysis.semanticRemainingRows, 1);
    assert.equal(analysis.trainedModelExecuted, true);
    assert.equal(analysis.execution.cancelled, true);
    assert.equal(analysis.execution.completed, false);
    assert.equal(analysis.execution.actualInference, true);
    assert.match(analysis.execution.error, /أُلغي/);
    assert.equal(analysis.embeddingWeightIntegrity.status, 'verified');
    assert.equal(output.rows[1].findings.some((finding) => finding.code === 'semantic_distance'), true, 'the finished low-similarity pair is kept as a review signal');
    assert.equal(output.rows[2].semantic, undefined, 'the pair that did not finish stays unprocessed');
    // The dossier gate must not read "complete": app.js adds aiCancelled for a user cancel.
    output.provenance.analysis.requestedMode = 'embedding-requested';
    output.provenance.analysis.aiCancelled = true;
    assert.equal(aiExecutionState(output).state, 'cancelled');
    assert.equal(aiExecutionState(output).processed, 2);
    const failedOnly = structuredClone(output);
    failedOnly.provenance.analysis.aiCancelled = false;
    failedOnly.provenance.analysis.execution.cancelled = false;
    assert.equal(aiExecutionState(failedOnly).state, 'failed');
    assert.equal(aiExecutionState(failedOnly).processed, 2, 'the failed run still retains its completed pairs');
    assert.equal(terminated, 1);
  } finally { cancelSemanticAnalysis(); globalThis.Worker = oldWorker; }
});

test('BUG-46 cancelling before any pair finished still rejects as before (nothing to keep)', async () => {
  const oldWorker = globalThis.Worker;
  globalThis.Worker = class {
    postMessage({ id, action }) {
      queueMicrotask(() => { if (action === 'load') this.onmessage({ data: { id, event: 'result', result: { ready: true } } }); else cancelSemanticAnalysis(); });
    }
    terminate() {}
  };
  try {
    await assert.rejects(() => enrichReportWithAI(embeddingReport(2)), /أُلغي التحليل الذكي/);
  } finally { cancelSemanticAnalysis(); globalThis.Worker = oldWorker; }
});

test('BUG-40/46 embedding failure after some pairs: results kept, worker released, Arabic message with technical details apart', async () => {
  const oldWorker = globalThis.Worker;
  let terminated = 0;
  globalThis.Worker = class {
    postMessage({ id, action, payload }) {
      queueMicrotask(() => {
        if (action === 'load') { this.onmessage({ data: { id, event: 'result', result: { ready: true } } }); return; }
        this.onmessage({ data: { id, event: 'chunk', results: [similarityOf(payload.inputs[0].key)] } });
        this.onmessage({ data: { id, event: 'error', technicalDetails: 'RangeError: Array buffer allocation failed', message: 'لم يكتمل الذكاء الاصطناعي: نفدت ذاكرة المتصفح أثناء تشغيل النموذج. لا تُعد النتائج البنيوية تحليلًا ذكيًا.' } });
      });
    }
    terminate() { terminated += 1; }
  };
  try {
    const output = await enrichReportWithAI(embeddingReport(2));
    const analysis = output.provenance.analysis;
    assert.equal(analysis.semanticProcessedRows, 1);
    assert.equal(analysis.execution.completed, false);
    assert.equal(analysis.execution.cancelled, false);
    assert.match(analysis.execution.error, /نفدت ذاكرة المتصفح/);
    assert.equal(analysis.execution.technicalDetails, 'RangeError: Array buffer allocation failed');
    assert.equal(analysis.embeddingWeightIntegrity.status, 'declared_not_verified');
    assert.equal(terminated, 1);
    const gate=aiExecutionState({ ...output, provenance: { analysis: { ...analysis, requestedMode: 'embedding-requested' } } });
    assert.equal(gate.state, 'failed');
    assert.equal(gate.processed, 1);
    assert.match(gate.error, /نفدت ذاكرة المتصفح/);
  } finally { cancelSemanticAnalysis(); globalThis.Worker = oldWorker; }
});

test('BUG-46 a complete embedding run is unchanged: completed true, one worker kept warm', async () => {
  const oldWorker = globalThis.Worker;
  let terminated = 0;
  globalThis.Worker = class {
    postMessage({ id, action, payload }) {
      queueMicrotask(() => {
        if (action === 'load') { this.onmessage({ data: { id, event: 'result', result: { ready: true } } }); return; }
        const results = payload.inputs.map((input) => similarityOf(input.key));
        for (const item of results) this.onmessage({ data: { id, event: 'chunk', results: [item] } });
        this.onmessage({ data: { id, event: 'result', result: results } });
      });
    }
    terminate() { terminated += 1; }
  };
  try {
    const output = await enrichReportWithAI(embeddingReport(2));
    assert.equal(output.provenance.analysis.semanticProcessedRows, 2);
    assert.equal(output.provenance.analysis.execution.completed, true);
    assert.equal('cancelled' in output.provenance.analysis.execution, false);
    assert.equal(terminated, 0);
  } finally { cancelSemanticAnalysis(); globalThis.Worker = oldWorker; }
});
