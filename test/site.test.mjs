import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
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

// Exercise the landing-layer banner correction with the same notice/focus events as app.js.
// This tests scrolling behavior; responsive layout and real browser focus still need visual QA.
async function bannerHarness({top = 20, bottom = 60, invalidFocus = false, reducedMotion = false} = {}) {
  const code = await readFile(new URL('../public/site.js', import.meta.url), 'utf8');
  const timers = new Map(), listeners = new Map(), observers = [];
  let nextTimer = 0, reveals = 0;
  const notice = {hidden: false, getBoundingClientRect: () => ({top, bottom}), scrollIntoView: () => reveals++};
  const header = {offsetHeight: 76, getBoundingClientRect: () => ({bottom: 76})};
  const document = {
    title: 'Miḥakk', body: {dataset: {}},
    documentElement: {style: {setProperty() {}}, classList: {add() {}}},
    activeElement: {matches: () => invalidFocus},
    querySelector: selector => selector === '.app-header' ? header : selector === '#notice' ? notice : null,
    querySelectorAll: () => [], getElementById: () => null
  };
  runInNewContext(code, {
    document, location: {hash: '#tool'}, window: {}, innerHeight: 800,
    matchMedia: query => ({matches: query.includes('prefers-reduced-motion') && reducedMotion, addEventListener() {}}),
    scrollTo() {}, requestAnimationFrame: callback => callback(),
    addEventListener: (name, callback) => { const set = listeners.get(name) || []; set.push(callback); listeners.set(name, set); },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe(target) { observers.push({target, callback: this.callback}); } }
  });
  return {
    notify: () => observers.find(observer => observer.target === notice).callback(),
    event: (name, event = {}) => listeners.get(name)?.forEach(callback => callback(event)),
    settle: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
    get reveals() { return reveals; }, document, notice
  };
}

test('a covered fresh tool notice is revealed with or without reduced motion', async () => {
  for (const reducedMotion of [false, true]) {
    const harness = await bannerHarness({reducedMotion});
    harness.notify(); harness.settle();
    assert.equal(harness.reveals, 1);
  }
});

test('banner correction preserves invalid-field focus and a reader far down the results', async () => {
  for (const options of [{invalidFocus: true}, {top: -1000, bottom: -950}, {top: 100, bottom: 150}]) {
    const harness = await bannerHarness(options);
    harness.notify(); harness.settle();
    assert.equal(harness.reveals, 0, JSON.stringify(options));
  }
});

test('reader interaction cancels pending banner scroll while a new message can still be revealed', async () => {
  for (const [name, event] of [['wheel', {}], ['touchstart', {}], ['pointerdown', {}], ['keydown', {key: 'Tab'}], ['keydown', {key: 'PageDown'}]]) {
    const harness = await bannerHarness();
    harness.notify(); harness.event(name, event); harness.event('scroll'); harness.settle();
    assert.equal(harness.reveals, 0, name);
    harness.notify(); harness.settle();
    assert.equal(harness.reveals, 1, 'a later independent message is still visible');
  }
});

test('banner correction waits for programmatic scrolling and skips hidden, modal or landing views', async () => {
  const moving = await bannerHarness();
  moving.notify(); moving.event('scroll'); moving.settle();
  assert.equal(moving.reveals, 1);
  for (const change of [harness => { harness.notice.hidden = true; }, harness => { harness.document.body.dataset.view = 'landing'; }, harness => { harness.document.querySelector = selector => selector === '#finding-dialog' ? {open: true} : null; }]) {
    const harness = await bannerHarness();
    harness.notify(); change(harness); harness.settle();
    assert.equal(harness.reveals, 0);
  }
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
