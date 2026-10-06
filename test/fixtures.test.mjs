import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateFullFixtureRows, mutateFullFixtureRows, encodeFixtureCSV, encodeNestedFixtureXML, FIXTURE_PREFIX, DEFAULT_FIXTURE_DIRECTORY } from '../scripts/generate-qa-fixtures.mjs';
import { parseDelimited, rowsFromMatrix, parseTranslationFile, inspectTranslationFile } from '../public/modules/file-parser.mjs';
import { auditBatch } from '../public/modules/batch-engine.mjs';

test('full software fixture has 6236 unique IDs and explicitly nonreligious text', () => {
  const rows = generateFullFixtureRows();
  assert.equal(rows.length, 6236);
  assert.equal(new Set(rows.map((row) => `${row.surah}:${row.ayah}`)).size, 6236);
  assert.ok(rows.every((row) => row.translation.startsWith(FIXTURE_PREFIX)));
  assert.deepEqual([rows[0].surah, rows[0].ayah, rows.at(-1).surah, rows.at(-1).ayah], [1, 1, 114, 6]);
});

test('mutations are reproducible and do not alter originals or hide full-file faults', () => {
  const original = generateFullFixtureRows();
  const mutated = mutateFullFixtureRows(original);
  assert.equal(original.length, 6236);
  assert.equal(mutated.length, 6237);
  assert.ok(original.find((row) => row.surah === 5 && row.ayah === 1).translation.startsWith(FIXTURE_PREFIX));
  const report = auditBatch({ rows: mutated, scope: 'full', metadata: { candidate: { synthetic: true } } });
  assert.deepEqual([report.summary.missingVerses, report.summary.duplicateRows, report.summary.invalidRows, report.summary.emptyRows], [1, 1, 1, 1]);
  assert.ok(report.summary.outOfOrderRows >= 1);
  assert.equal(report.summary.structuralComplete, false);
  assert.equal(report.provenance.analysis.trainedModelExecuted, false);
});

test('CSV escaped multiline quotes and semicolon unicode-digit roundtrips preserve all 6236 rows', () => {
  const rows = generateFullFixtureRows();
  for (const options of [{}, { delimiter: ';', headers: ['سورة', 'آية', 'ترجمة'], unicode: true }]) {
    const parsed = rowsFromMatrix(parseDelimited(encodeFixtureCSV(rows, options))).rows;
    assert.equal(parsed.length, 6236);
    assert.deepEqual(parsed.map(({ surah, ayah, translation }) => [surah, ayah, translation]), rows.map(({ surah, ayah, translation }) => [String(surah), String(ayah), translation]));
  }
});

test('nested XML fixture explicitly declares synthetic source and includes one verse container per ID', () => {
  const xml = encodeNestedFixtureXML(generateFullFixtureRows());
  assert.match(xml, /synthetic="true" religious-text="false"/);
  assert.equal((xml.match(/<verse>/g) ?? []).length, 6236);
  assert.equal((xml.match(/<ayah>/g) ?? []).length, 6236);
  assert.equal((xml.match(/<surah index=/g) ?? []).length, 114);
  assert.match(xml, /red &amp; blue/);
  assert.doesNotMatch(xml, /<!DOCTYPE|<!ENTITY/);
  // This checks fixture encoding, not DOMParser XML interpretation. Browser QA
  // must perform the real parser/import roundtrip and record its own evidence.
});

test('saved genuine XLSX and manually mapped unknown-header CSV use actual app parser', async (context) => {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(DEFAULT_FIXTURE_DIRECTORY, 'roundtrip-performance.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return context.skip('Generate QA fixtures first; saved-file roundtrip is not silently fabricated.'); throw error; }
  for (const name of ['04-full-genuine.xlsx', '06-full-unknown-headers.csv']) {
    const bytes = await readFile(join(DEFAULT_FIXTURE_DIRECTORY, name));
    const file = new File([bytes], name);
    const options = name.endsWith('headers.csv') ? { mapping: { surah: 0, ayah: 1, translation: 2 } } : {};
    if (options.mapping) {
      assert.deepEqual((await inspectTranslationFile(file)).headers, ['ChapterCode', 'VerseCode', 'Words']);
      await assert.rejects(parseTranslationFile(file), /الأعمدة/);
    } else assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'XLSX must be a genuine ZIP/OpenXML file.');
    const parsed = await parseTranslationFile(file, options);
    assert.equal(parsed.rows.length, 6236);
    assert.ok(parsed.rows.every((row) => row.translation.startsWith(FIXTURE_PREFIX)));
    assert.equal(parsed.sha256, manifest.files.find((item) => item.fileName === name).sha256);
    assert.equal(parsed.rows.find((row) => row.surah === '2' && row.ayah === '6').translation, generateFullFixtureRows().find((row) => row.surah === 2 && row.ayah === 6).translation);
  }
});

test('saved performance report does not mislabel XML or software fixtures as domain validation', async (context) => {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(DEFAULT_FIXTURE_DIRECTORY, 'roundtrip-performance.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return context.skip('Generate QA fixtures first.'); throw error; }
  assert.equal(manifest.files.length, 6);
  assert.equal(manifest.files.filter((item) => item.assertionStatus === 'passed').length, 5);
  assert.equal(manifest.files.find((item) => item.fileName.endsWith('.xml')).assertionStatus, 'not-executed');
  assert.equal(manifest.reference.verificationStatus, 'unverified');
  assert.equal(manifest.performanceEnvironment.modelInferencePerformed, false);
  assert.equal(manifest.religiousText, false);
  assert.ok(manifest.files.filter((item) => item.assertionStatus === 'passed').every((item) => Number.isFinite(item.parseMS) && Number.isFinite(item.auditMS) && item.fullTextExactMatches === item.expectedRows));
});
