import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createStaticHandler, CSP } from '../src/static-app.mjs';

// BUG-37 / P2-05: the ONNX Runtime files of all three model workers (NLI, E5 and the on-device listening one) are served by this site,
// byte-pinned, instead of being fetched from a CDN without SRI. With no worker left on a CDN, the CSP names no CDN host.
// The pins equal the SHA-256 list that jsDelivr publishes for @huggingface/transformers@3.8.1 (dist/ort-wasm-simd-threaded.jsep.*).
const PINS = {
  'ort-wasm-simd-threaded.jsep.mjs': { sha256: '08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9', bytes: 44484 },
  'ort-wasm-simd-threaded.jsep.wasm': { sha256: 'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39', bytes: 21596019 },
};
const MODULES = new URL('../public/modules/', import.meta.url);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('BUG-37 the self-hosted ONNX Runtime files are byte-identical to the pinned @huggingface/transformers@3.8.1 files', async () => {
  let total = 0;
  for (const [name, pin] of Object.entries(PINS)) {
    const bytes = await readFile(new URL(`../public/vendor/ort/${name}`, import.meta.url));
    assert.equal(bytes.length, pin.bytes, name);
    assert.equal(sha(bytes), pin.sha256, name);
    total += bytes.length;
  }
  assert.ok(total < 40 * 1048576, `the self-hosted runtime stays below 40 MB (is ${(total / 1048576).toFixed(1)} MB)`);
});

test('BUG-37 the context, E5 and on-device listening workers load the runtime from their own site; no CDN host remains in them', async () => {
  for (const name of ['context-risk-worker.mjs', 'semantic-worker.mjs', 'speech-worker.mjs']) {
    const source = await readFile(new URL(name, MODULES), 'utf8');
    assert.match(source, /wasmPaths = new URL\('\.\.\/vendor\/ort\/', import\.meta\.url\)\.href/, name);
    assert.doesNotMatch(source, /jsdelivr/i, name);
  }
});

test('P2-05 no module, page or policy names jsDelivr any more: the CSP lists no CDN host', async () => {
  const names = (await readdir(MODULES)).filter((name) => name.endsWith('.mjs'));
  for (const name of names) assert.doesNotMatch(await readFile(new URL(name, MODULES), 'utf8'), /jsdelivr/i, name);
  for (const page of ['../public/app.js', '../public/index.html', '../public/model-check.html']) assert.doesNotMatch(await readFile(new URL(page, import.meta.url), 'utf8'), /jsdelivr/i, page);
  assert.doesNotMatch(CSP, /jsdelivr/i);
  assert.match(CSP, /script-src 'self' 'wasm-unsafe-eval';/, 'the local WASM still compiles under the same policy');
  assert.ok(CSP.includes("connect-src 'self' https://api.quranpedia.net https://huggingface.co https://*.huggingface.co https://*.hf.co;"), 'only the reference API and Hugging Face remain as outside hosts');
});

test('BUG-37 the static server delivers the runtime with usable content types and the pinned bytes', async () => {
  const server = createServer(createStaticHandler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [name, pin] of Object.entries(PINS)) {
      const response = await fetch(`${base}/vendor/ort/${name}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type'), name.endsWith('.wasm') ? /^application\/wasm/ : /javascript/, name);
      assert.equal(sha(Buffer.from(await response.arrayBuffer())), pin.sha256, name);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('BUG-37 the notices name both runtime files with their hashes and the licence', async () => {
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const [name, pin] of Object.entries(PINS)) {
    assert.ok(notices.includes(name) && notices.includes(pin.sha256), name);
  }
  assert.match(notices, /public\/vendor\/ort\//);
  assert.ok((await stat(new URL('../public/vendor/ONNXRUNTIME-LICENSE.txt', import.meta.url))).size > 0);
});
