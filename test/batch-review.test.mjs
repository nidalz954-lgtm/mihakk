import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {runBatchReview} from '../public/modules/batch-review.mjs';
import {auditBatch, generateDemoRows, generateDemoReferenceRows} from '../public/modules/batch-engine.mjs';
import {expectedVerseIds} from '../public/modules/quran-index.mjs';

class NodeWorkerBridge {
  constructor(url, options) {
    this.worker = new Worker(url, options);
    this.listeners = new Map();
    this.terminateCalls = 0;
    this.exited = new Promise(resolve => this.worker.once('exit', resolve));
    this.worker.on('message', data => this.emit('message', {data}));
    this.worker.on('error', error => this.emit('error', {error, message: error.message, preventDefault() {}}));
    this.worker.on('messageerror', () => this.emit('messageerror', {}));
  }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  postMessage(value) { this.worker.postMessage(value); }
  terminate() { this.terminateCalls += 1; return this.worker.terminate(); }
  emit(type, event) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, set) => count + set.size, 0); }
}

class FaultWorker {
  constructor(onPost = () => {}) { this.listeners = new Map(); this.onPost = onPost; this.terminateCalls = 0; this.postCalls = 0; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  postMessage(value) { this.postCalls += 1; this.onPost(value, this); }
  terminate() { this.terminateCalls += 1; }
  emit(type, event) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, set) => count + set.size, 0); }
}

const demo = () => ({
  rows: generateDemoRows(), referenceRows: generateDemoReferenceRows(), scope: {type: 'selected', surahs: [1, 112, 113, 114]},
  metadata: {candidate: {name: 'Synthetic worker test', language: 'en', synthetic: true}, reference: {title: 'Authored non-religious teaching fixture', language: 'en', verificationStatus: 'verified', synthetic: true}},
});
const withoutTimestamp = report => { const {generatedAt, ...rest} = report; assert.ok(Number.isFinite(Date.parse(generatedAt))); return rest; };

test('real local worker returns exactly the engine report, then terminates and removes listeners', async () => {
  const input = demo(), expected = auditBatch(input), progress = [];
  let worker;
  const actual = await runBatchReview(input, {workerFactory: (url, options) => worker = new NodeWorkerBridge(url, options), onProgress: value => progress.push(value)});
  assert.deepEqual(withoutTimestamp(actual), withoutTimestamp(expected));
  assert.deepEqual(progress.map(p => p.status), ['starting', 'running', 'complete']);
  assert.equal(Object.hasOwn(progress[1], 'progress'), false);
  assert.equal(actual.provenance.analysis.trainedModelExecuted, false);
  assert.equal(worker.terminateCalls, 1);
  assert.equal(worker.listenerCount, 0);
  await worker.exited;
});

test('a completed 6,236-row authored workload keeps the main event loop available during the real audit', async t => {
  const text = 'An authored classroom sample accompanies an illustration for this local timing exercise. '.repeat(3);
  const referenceRows = expectedVerseIds({type: 'full'}).map((id, index) => {
    const [surah, ayah] = id.split(':').map(Number);
    return {surah, ayah, translation: text, rowNumber: index + 2};
  });
  const rows = referenceRows.map(row => ({...row}));
  referenceRows[20].translation = 'The classroom has five desks.';
  rows[20].translation = 'The classroom has six desks.';
  const input = {...demo(), rows, referenceRows, scope: {type: 'full'}};
  const before = performance.now(), expected = auditBatch(input), synchronousMS = performance.now() - before;
  let worker, running = false, heartbeatDuringAudit = 0;
  const timer = setInterval(() => { if (running) heartbeatDuringAudit += 1; }, 5);
  const start = performance.now();
  let actual;
  try {
    actual = await runBatchReview(input, {
      workerFactory: (url, options) => worker = new NodeWorkerBridge(url, options),
      onProgress: value => { if (value.status === 'running') running = true; if (value.status === 'complete') running = false; },
    });
  } finally { clearInterval(timer); }
  const workerWallMS = performance.now() - start;
  assert.deepEqual(withoutTimestamp(actual), withoutTimestamp(expected));
  assert.equal(actual.rows.length, 6236);
  assert.ok(heartbeatDuringAudit > 0, 'the main event loop must advance while auditBatch executes in the worker');
  assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
  await worker.exited;
  t.diagnostic(`Authored non-religious 6236 rows: direct=${synchronousMS.toFixed(1)}ms, worker wall=${workerWallMS.toFixed(1)}ms, main heartbeat ticks during audit=${heartbeatDuringAudit}; Node bridge, not browser acceptance.`);
});

test('abort before start creates no worker or progress event', async () => {
  const controller = new AbortController(); controller.abort();
  let created = false, progressed = false;
  await assert.rejects(runBatchReview(demo(), {signal: controller.signal, workerFactory: () => { created = true; }, onProgress: () => { progressed = true; }}), {name: 'AbortError'});
  assert.equal(created, false); assert.equal(progressed, false);
});

test('abort while the real worker begins a large audit stops it without accepting a report', async () => {
  const controller = new AbortController(); let worker, sawRunning = false, sawComplete = false;
  const text = 'The authored classroom exercise does not permit an unchecked action. '.repeat(35);
  const rows = expectedVerseIds({type: 'full'}).map(id => { const [surah, ayah] = id.split(':').map(Number); return {surah, ayah, translation: text}; });
  await assert.rejects(runBatchReview({rows, scope: {type: 'full'}, metadata: {candidate: {language: 'en', synthetic: true}}}, {
    signal: controller.signal, workerFactory: (url, options) => worker = new NodeWorkerBridge(url, options),
    onProgress: value => { if (value.status === 'running') { sawRunning = true; controller.abort(); } if (value.status === 'complete') sawComplete = true; },
  }), {name: 'AbortError'});
  assert.equal(sawRunning, true); assert.equal(sawComplete, false);
  assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
  await worker.exited;
});

test('real worker engine validation failure rejects clearly and releases the worker', async () => {
  let worker;
  await assert.rejects(runBatchReview({rows: null}, {workerFactory: (url, options) => worker = new NodeWorkerBridge(url, options)}), error => {
    assert.equal(error.code, 'BATCH_REVIEW_FAILED');
    assert.match(error.message, /تعذّر إتمام الفحص/);
    assert.equal(error.cause.name, 'TypeError');
    return true;
  });
  assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
  await worker.exited;
});

test('worker runtime failure rejects and ignores later events after cleanup', async () => {
  const worker = new FaultWorker((input, self) => queueMicrotask(() => self.emit('error', {message: 'Local module failed', preventDefault() {}})));
  let progressed = 0;
  await assert.rejects(runBatchReview(demo(), {workerFactory: () => worker, onProgress: () => { progressed += 1; }}), {code: 'BATCH_WORKER_FAILED'});
  worker.emit('message', {data: {type: 'result', report: auditBatch(demo())}});
  assert.equal(progressed, 1); assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
});

test('an unreadable or malformed worker result never resolves a fake success', async () => {
  for (const response of [{event: 'messageerror', value: {}}, {event: 'message', value: {data: {type: 'result', report: {}}}}]) {
    const worker = new FaultWorker((input, self) => queueMicrotask(() => self.emit(response.event, response.value)));
    await assert.rejects(runBatchReview(demo(), {workerFactory: () => worker}), error => /^BATCH_(RESULT_UNREADABLE|WORKER_PROTOCOL)$/.test(error.code));
    assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
  }
});

test('uncloneable input rejects and releases the real local worker', async () => {
  let worker;
  await assert.rejects(runBatchReview({rows: [], uncloneable: () => {}}, {workerFactory: (url, options) => worker = new NodeWorkerBridge(url, options)}), {code: 'BATCH_WORKER_START_FAILED'});
  assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
  await worker.exited;
});

test('a throwing progress callback or abort during starting releases the worker before postMessage', async () => {
  const worker = new FaultWorker(), failure = new Error('UI progress failed');
  await assert.rejects(runBatchReview(demo(), {workerFactory: () => worker, onProgress: () => { throw failure; }}), error => error === failure);
  assert.equal(worker.postCalls, 0); assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
  const second = new FaultWorker(), controller = new AbortController();
  await assert.rejects(runBatchReview(demo(), {workerFactory: () => second, signal: controller.signal, onProgress: () => controller.abort()}), {name: 'AbortError'});
  assert.equal(second.postCalls, 0); assert.equal(second.terminateCalls, 1); assert.equal(second.listenerCount, 0);
});

test('pagehide cancels the active worker and removes the page lifecycle listener', async () => {
  const original = Object.fromEntries(['document', 'addEventListener', 'removeEventListener'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const pageListeners = new Map();
  Object.defineProperty(globalThis, 'document', {value: {}, configurable: true});
  Object.defineProperty(globalThis, 'addEventListener', {value: (type, callback) => pageListeners.set(type, callback), configurable: true});
  Object.defineProperty(globalThis, 'removeEventListener', {value: (type, callback) => { if (pageListeners.get(type) === callback) pageListeners.delete(type); }, configurable: true});
  const worker = new FaultWorker();
  try {
    const pending = runBatchReview(demo(), {workerFactory: () => worker});
    assert.ok(pageListeners.has('pagehide'));
    pageListeners.get('pagehide')();
    await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(pageListeners.size, 0); assert.equal(worker.terminateCalls, 1); assert.equal(worker.listenerCount, 0);
  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('without Web Worker support the default path rejects instead of blocking the page', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {value: undefined, configurable: true});
  try { await assert.rejects(runBatchReview(demo()), {code: 'BATCH_WORKER_UNAVAILABLE'}); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker; }
});
