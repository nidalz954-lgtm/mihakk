import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { QURAN_DISPLAY, parseQuranDisplay, loadQuranText } from '../public/modules/quran-text.mjs';
import { SURAH_AYAH_COUNTS } from '../public/modules/quran-index.mjs';

const fileURL = new URL('../public/data/quran-hafs-quranpedia.json', import.meta.url);

test('bundled Quran display file matches its pinned SHA-256, source and dump version', async () => {
  const bytes = await readFile(fileURL);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), QURAN_DISPLAY.sha256);
  const data = JSON.parse(bytes.toString('utf8'));
  assert.equal(data.schema, 'mihakk-quran-display/1');
  assert.equal(data.mushafId, 1);
  assert.equal(data.dumpVersion, QURAN_DISPLAY.dumpVersion);
  assert.equal(data.gzSha256, QURAN_DISPLAY.dumpSha256);
  assert.match(data.description, /مجمع الملك فهد/);
  assert.equal(QURAN_DISPLAY.displayOnly, true);
});

test('all 114 surahs and 6,236 verses follow the pinned Kufan index, with no invisible format marks', async () => {
  const quran = await parseQuranDisplay(await readFile(fileURL, 'utf8'));
  let total = 0;
  for (let surah = 1; surah <= 114; surah += 1) for (let ayah = 1; ayah <= SURAH_AYAH_COUNTS[surah - 1]; ayah += 1) {
    const verse = quran.verse(surah, ayah);
    assert.ok(verse && verse.trim(), `${surah}:${ayah}`);
    assert.doesNotMatch(verse, /﻿/);
    total += 1;
  }
  assert.equal(total, 6236);
  assert.equal(quran.verse(1, 8), null);
  assert.equal(quran.verse(115, 1), null);
  assert.match(quran.surahName(1), /الفاتحة/);
  assert.match(quran.verse(112, 1), /قُلْ/);
});

test('a modified file is refused rather than displayed', async () => {
  const text = await readFile(fileURL, 'utf8');
  await assert.rejects(parseQuranDisplay(text.replace('قُلْ', 'قل')), /بصمة/);
  await assert.rejects(parseQuranDisplay(''), /بصمة/);
});

test('loader reports HTTP failure honestly and can retry after a failure', async () => {
  let calls = 0;
  await assert.rejects(loadQuranText(async () => { calls += 1; return { ok: false, status: 404 }; }), /HTTP 404/);
  const text = await readFile(fileURL, 'utf8');
  const quran = await loadQuranText(async () => { calls += 1; return { ok: true, text: async () => text }; });
  assert.equal(calls, 2);
  assert.ok(quran.verse(2, 255));
});

test('the case window shows the verse only as reading context, never as a comparison input', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /quranBox\(\$\('detail-content'\),row\)/);
  assert.match(app, /البرنامج لا يقارن الترجمة بهذا النص آليًا/);
  // Demo or synthetic rows show a test-position note, never real mushaf text beside non-translation text.
  assert.match(app, /state\.demo\|\|state\.report\?\.provenance\?\.candidate\?\.synthetic===true\|\|\/\^SYNTHETIC TRAINING TEXT\//);
  assert.match(app, /موضع اختباري: نص هذا الصف اصطناعي وليس ترجمة لهذه الآية/);
  const engine = await readFile(new URL('../src/batch-engine.mjs', import.meta.url), 'utf8');
  const context = await readFile(new URL('../public/modules/context-risk.mjs', import.meta.url), 'utf8');
  for (const source of [engine, context]) assert.doesNotMatch(source, /quran-text|quran-hafs/);
});
