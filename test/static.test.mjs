import {createServer} from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createStaticHandler} from '../src/static-app.mjs';
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
test('public app serves browser modules and excludes all corpus APIs', async () => {
  const server = createServer(createStaticHandler()); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await fetch(`${base}/`); assert.equal(html.status,200); assert.match(html.headers.get('content-security-policy'),/wasm-unsafe-eval/);
    const module = await fetch(`${base}/modules/file-parser.mjs`); assert.equal(module.status,200); assert.match(module.headers.get('content-type'),/javascript/);
    for (const path of ['/api/verses','/api/review','/.env','/../data/verses.json']) assert.notEqual((await fetch(`${base}${path}`)).status,200);
    assert.equal((await fetch(base,{method:'POST',body:'secret'})).status,405);
    assert.equal(html.headers.get('permissions-policy'),'camera=(), microphone=(self), geolocation=()');
    const health = await (await fetch(`${base}/health`)).json(); assert.equal(health.bundledReligiousCorpus,false); assert.equal(health.bundledQuranText.purpose,'display-only'); assert.equal(health.version,packageVersion);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('static pages carry a meta CSP that mirrors the server policy for hosts without headers (GitHub Pages) and use relative links', async () => {
  const { readFile } = await import('node:fs/promises');
  const { CSP } = await import('../src/static-app.mjs');
  const expected = CSP.replace(" frame-ancestors 'none';", '');
  for (const page of ['index.html', 'model-check.html']) {
    const html = await readFile(new URL('../public/' + page, import.meta.url), 'utf8');
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(meta, page + ' has a meta CSP');
    assert.equal(meta[1], expected, page + ' meta CSP mirrors the server policy');
    assert.doesNotMatch(html, /href="\/"/, page + ' has no root-absolute link that escapes a Pages sub-path');
  }
});
