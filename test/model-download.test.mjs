import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createResumableFetch, createWeightGuard, createProgressAggregator, describeModelError, describeRetry } from '../public/modules/model-runtime.mjs';

// BUG-27: bounded retry with HTTP Range resume for the one big model file.
// The "server" below is synthetic: it cuts the connection after N bytes exactly like a CDN dropping an HTTP/2 stream.
const URL_OF_WEIGHTS = 'https://huggingface.co/Example/model/resolve/0123456789abcdef0123456789abcdef01234567/onnx/model_quantized.onnx';
const nodeSha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fakeServer(bytes, { cuts = [], honourRange = true, corruptResume = false, offset = 0, rangeStartShift = 0 } = {}) {
  const requests = [];
  async function serve(input, init) {
    const index = requests.length;
    const range = /^bytes=(\d+)-$/.exec(new Headers(init?.headers).get('range') ?? '');
    requests.push({ url: String(input), range: range ? Number(range[1]) : null });
    const start = range && honourRange ? Number(range[1]) : 0;
    const payload = Uint8Array.from(bytes.subarray(start));
    if (range && corruptResume) payload[0] ^= 0xff;
    const cutAfter = cuts[index];
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (cutAfter !== undefined && sent >= cutAfter) { controller.error(new TypeError('network error')); return; }
        if (sent >= payload.length) { controller.close(); return; }
        const size = Math.min(65_536, payload.length - sent, cutAfter === undefined ? Infinity : cutAfter - sent);
        controller.enqueue(payload.subarray(sent, sent + size));
        sent += size;
      },
    });
    if (range && honourRange) {
      return new Response(body, { status: 206, headers: { 'content-length': String(payload.length), 'content-range': `bytes ${start + rangeStartShift}-${bytes.length - 1}/${bytes.length}` } });
    }
    return new Response(body, { status: 200, headers: { 'content-length': String(bytes.length) } });
  }
  return { serve, requests };
}
const noWait = { sleep: async () => {}, backoffMS: [1, 1, 1, 1] };
async function guardedDownload(weights, serverOptions, resumeOptions = {}) {
  const server = fakeServer(weights, serverOptions);
  const retries = [];
  const scope = { fetch: server.serve, caches: undefined };
  const resumable = createResumableFetch({ ...noWait, ...resumeOptions, onRetry: (info) => retries.push(info) });
  const guard = createWeightGuard({ pins: [{ url: URL_OF_WEIGHTS, sha256: nodeSha(weights), bytes: weights.length }], scope, fetchWeights: resumable });
  guard.installFetch();
  return { guard, server, retries, scope, resumable, pin: { url: URL_OF_WEIGHTS, sha256: nodeSha(weights), bytes: weights.length } };
}
async function read(response) { return new Uint8Array(await response.arrayBuffer()); }

test('BUG-27 a connection cut mid-stream resumes from the received byte and the file still verifies', async () => {
  const weights = randomBytes(1_000_000);
  const { guard, server, retries, scope, pin } = await guardedDownload(weights, { cuts: [400_000] });
  const bytes = await read(await scope.fetch(URL_OF_WEIGHTS));
  assert.equal(nodeSha(bytes), nodeSha(weights));
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[1].range, 400_000, 'the second request asks for exactly the missing tail');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].received, 400_000);
  guard.assertVerified(pin);
});

test('BUG-27 several cuts in a row are survived while they stay within the retry bound', async () => {
  const weights = randomBytes(900_000);
  const { server, scope } = await guardedDownload(weights, { cuts: [100_000, 200_000, 150_000] });
  const bytes = await read(await scope.fetch(URL_OF_WEIGHTS));
  assert.equal(nodeSha(bytes), nodeSha(weights));
  assert.equal(server.requests.length, 4);
  assert.deepEqual(server.requests.map((request) => request.range), [null, 100_000, 300_000, 450_000]);
});

test('BUG-27 retries are bounded: after the limit the original network failure surfaces (no endless loop)', async () => {
  const weights = randomBytes(500_000);
  const { server, scope } = await guardedDownload(weights, { cuts: [50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000] }, { maxRetries: 2 });
  await assert.rejects(async () => read(await scope.fetch(URL_OF_WEIGHTS)), /network error/);
  assert.equal(server.requests.length, 3, 'one request plus two retries');
});

test('BUG-27 a server that ignores Range, or answers from another offset, is a failure and never a spliced file', async () => {
  const weights = randomBytes(400_000);
  const ignored = await guardedDownload(weights, { cuts: [100_000], honourRange: false });
  await assert.rejects(async () => read(await ignored.scope.fetch(URL_OF_WEIGHTS)), /did not honour/);
  const shifted = await guardedDownload(weights, { cuts: [100_000], rangeStartShift: 7 });
  await assert.rejects(async () => read(await shifted.scope.fetch(URL_OF_WEIGHTS)), /did not honour/);
});

test('BUG-27 resumed bytes that differ from the pinned file are caught by the SHA-256 check', async () => {
  const weights = randomBytes(600_000);
  const { scope, guard, pin } = await guardedDownload(weights, { cuts: [200_000], corruptResume: true });
  await assert.rejects(async () => read(await scope.fetch(URL_OF_WEIGHTS)), (error) => error.name === 'WeightIntegrityError');
  assert.throws(() => guard.assertVerified(pin));
});

test('BUG-27 without a Content-Length, or with zero bytes received, nothing is resumed', async () => {
  const weights = randomBytes(300_000);
  const early = await guardedDownload(weights, { cuts: [0] });
  await assert.rejects(async () => read(await early.scope.fetch(URL_OF_WEIGHTS)), /network error/);
  assert.equal(early.server.requests.length, 1);
});

test('BUG-27 an uninterrupted download is untouched: one request, no retry callback', async () => {
  const weights = randomBytes(700_000);
  const { server, retries, scope } = await guardedDownload(weights, {});
  assert.equal(nodeSha(await read(await scope.fetch(URL_OF_WEIGHTS))), nodeSha(weights));
  assert.equal(server.requests.length, 1);
  assert.equal(retries.length, 0);
});

test('BUG-27 the progress aggregator can carry a retry notice without moving the bar backwards', () => {
  const aggregator = createProgressAggregator({ expectedBytes: 1000 });
  aggregator.start();
  const before = aggregator.push({ status: 'progress', file: 'm', loaded: 600, total: 1000 });
  const notice = aggregator.notice('انقطع الاتصال؛ تُستأنف المحاولة 1 من 4');
  assert.equal(notice.progress, before.progress);
  assert.equal(notice.message, 'انقطع الاتصال؛ تُستأنف المحاولة 1 من 4');
  assert.ok(aggregator.push({ status: 'progress', file: 'm', loaded: 700, total: 1000 }).progress >= notice.progress);
});

test('BUG-27 both workers install the resumable fetch for the weight file only', async () => {
  for (const name of ['context-risk-worker.mjs', 'semantic-worker.mjs']) {
    const source = await readFile(new URL(`../public/modules/${name}`, import.meta.url), 'utf8');
    assert.match(source, /createResumableFetch/, name);
    assert.match(source, /fetchWeights/, name);
  }
});

test('BUG-27 a connection that moved real data before it was cut gets a fresh retry budget (slow links, several cuts)', async () => {
  const weights = randomBytes(13 * 1048576);
  const cut = 4.2 * 1048576;
  const { server, scope, pin, guard } = await guardedDownload(weights, { cuts: [cut, cut, cut] }, { maxRetries: 1 });
  assert.equal(nodeSha(await read(await scope.fetch(URL_OF_WEIGHTS))), nodeSha(weights));
  assert.equal(server.requests.length, 4, 'three cuts survived although maxRetries is 1, because each connection moved more than 4 MiB');
  guard.assertVerified(pin);
});

test('BUG-27 an aborted request is never retried, and a non-200 or encoded answer is passed through untouched', async () => {
  const weights = randomBytes(200_000);
  let calls = 0;
  const abortingFetch = createResumableFetch({ ...noWait });
  const aborted = await abortingFetch(async () => {
    calls += 1;
    return new Response(new ReadableStream({ pull(controller) { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } }), { status: 200, headers: { 'content-length': '200000' } });
  }, URL_OF_WEIGHTS, {}, {});
  await assert.rejects(async () => read(aborted), /aborted/);
  assert.equal(calls, 1);
  const notFound = await abortingFetch(async () => new Response('missing', { status: 404 }), URL_OF_WEIGHTS, {}, {});
  assert.equal(notFound.status, 404);
  const encoded = await abortingFetch(async () => new Response(weights, { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '200000' } }), URL_OF_WEIGHTS, {}, {});
  assert.equal((await read(encoded)).length, 200_000);
});

test('BUG-27 the user sees simple Arabic for a refused resume and for a retry notice; the English text stays in technicalDetails', () => {
  const refused = describeModelError(new Error('The server did not honour the Range request; resuming the model download was stopped.'));
  assert.equal(refused.kind, 'network');
  assert.match(refused.message, /[؀-ۿ]/);
  assert.match(refused.technicalDetails, /did not honour/);
  const line = describeRetry({ attempt: 2, maxRetries: 4, received: 52_428_800 });
  assert.match(line, /50 ميغابايت/);
  assert.match(line, /2 من 4/);
});

test('BUG-27 the real reason a resume stopped stays readable on the fetch wrapper (Chromium reports body errors as a bare "Failed to fetch")', async () => {
  const weights = randomBytes(400_000);
  const refused = await guardedDownload(weights, { cuts: [100_000], honourRange: false });
  await assert.rejects(async () => read(await refused.scope.fetch(URL_OF_WEIGHTS)));
  assert.match(refused.resumable.failure.message, /did not honour/);
  refused.resumable.clearFailure();
  assert.equal(refused.resumable.failure, null);
  const spent = await guardedDownload(weights, { cuts: [50_000, 50_000, 50_000] }, { maxRetries: 1 });
  await assert.rejects(async () => read(await spent.scope.fetch(URL_OF_WEIGHTS)));
  assert.match(describeModelError(spent.resumable.failure).message, /[؀-ۿ]/);
  assert.equal(describeModelError(spent.resumable.failure).kind, 'network');
  const clean = await guardedDownload(weights, {});
  await read(await clean.scope.fetch(URL_OF_WEIGHTS));
  assert.equal(clean.resumable.failure, null);
});
