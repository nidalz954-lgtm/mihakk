import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createStaticHandler} from '../src/static-app.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

test('every local asset referenced by the landing page exists and is relative', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const refs = [...html.matchAll(/(?:src|href|poster)="([^"#][^"]*)"/g)].map(match => match[1]).filter(ref => !/^(?:https?:|data:|mailto:)/.test(ref));
  assert.ok(refs.length > 10);
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^\//, `${ref} must be relative for sub-path hosting`);
    assert.ok(existsSync(publicDir + ref.split(/[?#]/)[0]), `${ref} is missing from public/`);
  }
});

test('landing ids are unique and the tool markup is still present', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  for (const id of ['landing', 'step-1', 'demo-button', 'run-audit', 'finding-dialog']) assert.ok(ids.includes(id), id);
  assert.match(html, /body data-view="landing"/);
});

test('mp4 is served with byte ranges; other files are whole with a length', async () => {
  const server = createServer(createStaticHandler());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const whole = await fetch(`${base}/media/mihakk-loop.mp4`);
    const size = Number(whole.headers.get('content-length'));
    assert.equal(whole.status, 200); assert.equal(whole.headers.get('content-type'), 'video/mp4'); assert.ok(size > 0);
    await whole.arrayBuffer();
    const part = await fetch(`${base}/media/mihakk-loop.mp4`, {headers: {Range: 'bytes=10-19'}});
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 10-19/${size}`); assert.equal((await part.arrayBuffer()).byteLength, 10);
    const suffix = await fetch(`${base}/media/mihakk-loop.mp4`, {headers: {Range: 'bytes=-5'}});
    assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 5);
    const beyond = await fetch(`${base}/media/mihakk-loop.mp4`, {headers: {Range: `bytes=${size + 10}-`}});
    assert.equal(beyond.status, 416); await beyond.arrayBuffer();
    const page = await fetch(`${base}/site.css`, {headers: {Range: 'bytes=0-9'}});
    assert.equal(page.status, 200); assert.equal(page.headers.get('accept-ranges'), null); await page.arrayBuffer();
    const image = await fetch(`${base}/media/shots/03-queue.webp`);
    assert.equal(image.headers.get('content-type'), 'image/webp'); await image.arrayBuffer();
  } finally { await new Promise(resolve => server.close(resolve)); }
});
