/** Original, NONRELIGIOUS full-index QA files. Never use as Quran translations. */
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, symlink, realpath, lstat, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SURAH_AYAH_COUNTS } from '../public/modules/quran-index.mjs';
import { auditBatch } from '../public/modules/batch-engine.mjs';
import { parseTranslationFile, inspectTranslationFile } from '../public/modules/file-parser.mjs';
import { getEligibleContextRows, BENCHMARK_CASES } from '../public/modules/context-risk.mjs';

export const FIXTURE_PREFIX = 'SYNTHETIC TRAINING TEXT. ';
export const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(new URL('../../outputs/rebuild-qa/fixtures/', import.meta.url));
const BUNDLED_MODULES = process.env.MIHAKK_XLSX_AUTHOR_MODULES || ''; // local XLSX-authoring runtime (path removed from public source)
const contextualCases = ['role-1', 'scope-1', 'negative-1', 'omission-1', 'paraphrase-3'];
const key = (row) => `${row.surah}:${row.ayah}`;

export function generateFullFixtureRows() {
  const rows = SURAH_AYAH_COUNTS.flatMap((count, index) => Array.from({ length: count }, (_, offset) => ({
    surah: index + 1, ayah: offset + 1,
    translation: `${FIXTURE_PREFIX}Archive shelf ${index + 1}:${offset + 1} contains three folders.`,
  })));
  for (let index = 0; index < contextualCases.length; index += 1) {
    const fixture = BENCHMARK_CASES.find((item) => item.id === contextualCases[index]);
    rows.find((row) => key(row) === `2:${index + 1}`).translation = FIXTURE_PREFIX + fixture.premise;
  }
  rows.find((row) => key(row) === '2:6').translation = `${FIXTURE_PREFIX}The label reads "Research, notes".\nThe box is red & blue.`;
  return rows;
}

export function mutateFullFixtureRows(original) {
  const rows = structuredClone(original).filter((row) => key(row) !== '1:3');
  const left = rows.findIndex((row) => key(row) === '1:5');
  const right = rows.findIndex((row) => key(row) === '1:6');
  [rows[left], rows[right]] = [rows[right], rows[left]];
  rows.find((row) => key(row) === '5:1').translation = '';
  const duplicateIndex = rows.findIndex((row) => key(row) === '112:2');
  rows.splice(duplicateIndex + 1, 0, structuredClone(rows[duplicateIndex]));
  rows.push({ surah: 115, ayah: 1, translation: `${FIXTURE_PREFIX}This deliberately invalid identifier tests the bounds check.` });
  for (let index = 0; index < contextualCases.length; index += 1) {
    const fixture = BENCHMARK_CASES.find((item) => item.id === contextualCases[index]);
    rows.find((row) => key(row) === `2:${index + 1}`).translation = FIXTURE_PREFIX + fixture.hypothesis;
  }
  return rows;
}

function cell(value, delimiter) {
  const text = String(value);
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function unicodeDigits(value, zero) { return String(value).replace(/\d/g, (digit) => String.fromCharCode(zero + Number(digit))); }

export function encodeFixtureCSV(rows, { delimiter = ',', headers = ['surah', 'ayah', 'translation'], unicode = false } = {}) {
  const matrix = [headers, ...rows.map((row) => [
    unicode ? unicodeDigits(row.surah, 0x0660) : row.surah,
    unicode ? unicodeDigits(row.ayah, 0x06f0) : row.ayah,
    row.translation,
  ])];
  return '\uFEFF' + matrix.map((row) => row.map((value) => cell(value, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

const xmlEscape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function encodeNestedFixtureXML(rows) {
  let current;
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<review-fixture synthetic="true" religious-text="false">'];
  for (const row of rows) {
    if (current !== row.surah) {
      if (current != null) parts.push('</surah>');
      parts.push(`<surah index="${xmlEscape(row.surah)}">`);
      current = row.surah;
    }
    parts.push(`<verse><ayah>${xmlEscape(row.ayah)}</ayah><translation>${xmlEscape(row.translation)}</translation></verse>`);
  }
  if (current != null) parts.push('</surah>');
  parts.push('</review-fixture>');
  return parts.join('\n');
}

async function authorXlsx(outputDir, rows) {
  // Resolve only the bundled public Artifact Tool entry; do not inspect internals.
  const runtimeRoot = join(outputDir, '.qa-runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const link = join(runtimeRoot, 'node_modules');
  if (!BUNDLED_MODULES) throw new Error('XLSX fixture authoring needs a local runtime: set MIHAKK_XLSX_AUTHOR_MODULES to its node_modules folder.');
  try { await symlink(BUNDLED_MODULES, link, 'junction'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assert.equal((await realpath(link)).toLowerCase(), (await realpath(BUNDLED_MODULES)).toLowerCase(), 'Dependency junction must resolve to the verified bundled runtime.');
  const bundledRequire = createRequire(join(runtimeRoot, 'loader.cjs'));
  const { Workbook, SpreadsheetFile } = await import(pathToFileURL(bundledRequire.resolve('@oai/artifact-tool')).href);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('SyntheticFixture');
  sheet.showGridLines = false;
  const matrix = [['surah', 'ayah', 'translation'], ...rows.map((row) => [row.surah, row.ayah, row.translation])];
  sheet.getRange(`A1:C${matrix.length}`).values = matrix;
  sheet.getRange(`A1:C${matrix.length}`).format.font = { name: 'Arial', size: 10 };
  sheet.getRange('A1:C1').format = { fill: '#243B53', font: { name: 'Arial', size: 10, color: '#FFFFFF', bold: true }, rowHeight: 24 };
  sheet.getRange(`A2:B${matrix.length}`).setNumberFormat('0');
  sheet.getRange(`A1:B${matrix.length}`).format.columnWidth = 9;
  sheet.getRange(`C1:C${matrix.length}`).format.columnWidth = 100;
  sheet.getRange(`C2:C${matrix.length}`).format.wrapText = true;
  sheet.getRange(`A2:C${matrix.length}`).format.rowHeight = 34;
  sheet.freezePanes.freezeRows(1);
  workbook.recalculate();
  const inspected = await workbook.inspect({ kind: 'table', range: 'SyntheticFixture!A1:C8', include: 'values,formulas', tableMaxRows: 8, tableMaxCols: 3, maxChars: 2500 });
  const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!', options: { useRegex: true, maxResults: 20 }, maxChars: 1000 });
  const preview = await workbook.render({ sheetName: 'SyntheticFixture', range: 'A1:C8', scale: 1, format: 'png' });
  await writeFile(join(outputDir, '04-full-genuine-preview.png'), new Uint8Array(await preview.arrayBuffer()));
  await (await SpreadsheetFile.exportXlsx(workbook)).save(join(outputDir, '04-full-genuine.xlsx'));
  // Remove only the verified temporary junction, NEVER its dependency target.
  // Nonrecursive rmdir on a Windows junction removes the link itself.
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await rmdir(link);
  await rmdir(runtimeRoot);
  return { engine: '@oai/artifact-tool bundled authoring; actual application SheetJS importer roundtrip', inspect: inspected.ndjson, formulaErrorScan: errors.ndjson, preview: '04-full-genuine-preview.png' };
}

const metadataFor = (name) => ({ candidate: { name, language: 'en', synthetic: true }, reference: { title: 'NONRELIGIOUS authored full-index QA reference', edition: 'qa-fixture-1', language: 'en', verificationStatus: 'unverified', sourceKind: 'user-upload', licenseNote: 'MIT. Authored software fixture; not a Quran translation.' } });
function summaryOf(report) {
  const fields = ['totalRows', 'expectedVerses', 'coveredVerses', 'missingVerses', 'duplicateRows', 'invalidRows', 'emptyRows', 'outOfOrderRows', 'structuralComplete', 'comparedRows', 'lexicalComparedRows', 'unverifiedReferenceRows', 'needsReviewRows', 'noSignalRows', 'abstainRows'];
  return Object.fromEntries(fields.map((field) => [field, report.summary[field]]));
}

export async function generateQAFixtures({ outputDir = DEFAULT_FIXTURE_DIRECTORY } = {}) {
  outputDir = resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  const original = generateFullFixtureRows();
  const mutated = mutateFullFixtureRows(original);
  const specs = [
    { name: '01-full-valid6236.csv', rows: original, content: encodeFixtureCSV(original), expectedRows: 6236 },
    { name: '02-full-mutated.csv', rows: mutated, content: encodeFixtureCSV(mutated), expectedRows: 6237 },
    { name: '03-full-semicolon-arabic-digits.csv', rows: original, content: encodeFixtureCSV(original, { delimiter: ';', headers: ['سورة', 'آية', 'ترجمة'], unicode: true }), expectedRows: 6236 },
    { name: '04-full-genuine.xlsx', rows: original, expectedRows: 6236 },
    { name: '05-full-nested.xml', rows: original, content: encodeNestedFixtureXML(original), expectedRows: 6236, browserRequired: true },
    { name: '06-full-unknown-headers.csv', rows: original, content: encodeFixtureCSV(original, { headers: ['ChapterCode', 'VerseCode', 'Words'] }), expectedRows: 6236, mapping: { surah: 0, ayah: 1, translation: 2 } },
  ];
  for (const spec of specs) if (spec.content != null) await writeFile(join(outputDir, spec.name), spec.content, 'utf8');
  await writeFile(join(outputDir, 'reference-full-synthetic.csv'), encodeFixtureCSV(original), 'utf8');
  const xlsxAuthoring = await authorXlsx(outputDir, original);
  const referenceFile = new File([await readFile(join(outputDir, 'reference-full-synthetic.csv'))], 'reference-full-synthetic.csv');
  const parsedReference = await parseTranslationFile(referenceFile);
  assert.equal(parsedReference.rows.length, 6236);
  const results = [];
  for (const spec of specs) {
    const bytes = await readFile(join(outputDir, spec.name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = { fileName: spec.name, absolutePath: join(outputDir, spec.name), bytes: bytes.length, sha256, expectedRows: spec.expectedRows, synthetic: true, religiousText: false, mapping: spec.mapping ?? null };
    if (spec.browserRequired) {
      results.push({ ...result, parseStatus: 'browser-required', assertionStatus: 'not-executed', reason: 'Node has no DOMParser. No fake XML parsing or substitute parser was used. Root must upload this file through the actual browser.', generatedVerseElements: (spec.content.match(/<verse>/g) ?? []).length });
      continue;
    }
    const file = new File([bytes], spec.name);
    if (spec.mapping) {
      const preview = await inspectTranslationFile(file);
      assert.deepEqual(preview.headers, ['ChapterCode', 'VerseCode', 'Words']);
      await assert.rejects(parseTranslationFile(file), /الأعمدة/);
      result.unmappedRejected = true;
    }
    const parseStarted = performance.now();
    const parsed = await parseTranslationFile(file, spec.mapping ? { mapping: spec.mapping } : {});
    result.parseMS = Number((performance.now() - parseStarted).toFixed(3));
    assert.equal(parsed.sha256, sha256);
    assert.equal(parsed.rows.length, spec.expectedRows);
    for (let index = 0; index < parsed.rows.length; index += 1) {
      const actual = parsed.rows[index];
      const expected = spec.rows[index];
      assert.equal(actual.surah, String(expected.surah));
      assert.equal(actual.ayah, String(expected.ayah));
      assert.equal(actual.translation, expected.translation);
    }
    const auditStarted = performance.now();
    const report = auditBatch({ rows: parsed.rows, referenceRows: parsedReference.rows, scope: { type: 'full' }, metadata: metadataFor(spec.name) });
    result.auditMS = Number((performance.now() - auditStarted).toFixed(3));
    assert.equal(report.summary.totalRows, spec.expectedRows);
    assert.equal(report.provenance.analysis.trainedModelExecuted, false);
    assert.equal(report.summary.noSignalRows, 0, 'Unverified source must not yield approval-like clean status.');
    if (spec.name === '02-full-mutated.csv') {
      assert.equal(report.summary.missingVerses, 1);
      assert.equal(report.summary.duplicateRows, 1);
      assert.equal(report.summary.invalidRows, 1);
      assert.equal(report.summary.emptyRows, 1);
      assert.ok(report.summary.outOfOrderRows >= 1);
      assert.equal(report.summary.structuralComplete, false);
      assert.equal(getEligibleContextRows(report).length, contextualCases.length);
      const scopeRow = report.rows.find((row) => row.verseId === '2:2');
      assert.equal(scopeRow.findings.filter((finding) => finding.type === 'comparison').length, 0, 'Literal rules miss same-word negation-scope swap by design.');
      result.contextPairs = getEligibleContextRows(report).map((row) => ({ verseId: row.verseId, candidate: row.translation, reference: row.reference.translation, comparisonReason: row.comparisonReason }));
    } else {
      assert.equal(report.summary.structuralComplete, true);
      assert.equal(report.summary.coveredVerses, 6236);
      assert.equal(report.summary.abstainRows, 6236);
    }
    results.push({ ...result, parseStatus: 'actual-application-parser', assertionStatus: 'passed', parsedRows: parsed.rows.length, fullTextExactMatches: parsed.rows.length, summary: summaryOf(report) });
  }
  const manifest = {
    schemaVersion: 'mihakk-qa-fixtures/1', generatedAt: new Date().toISOString(),
    authoring: 'Original nonreligious authored test text using numeric verse identifiers only.',
    license: 'MIT', synthetic: true, religiousText: false,
    performanceEnvironment: { runtime: process.version, platform: process.platform, architecture: process.arch, engine: 'actual public/modules/file-parser + public/modules/batch-engine in Node', modelInferencePerformed: false },
    limitations: ['Six full-index software fixtures do not constitute six real Quran-translation audits.', 'Node timing is a single local run, not browser timing or a user-study.', 'Nested XML roundtrip requires the browser and is not marked passed here.', 'Source is intentionally user-upload unverified; no scholarly/source certification or independent expert approval.'],
    reference: { fileName: 'reference-full-synthetic.csv', absolutePath: join(outputDir, 'reference-full-synthetic.csv'), sha256: parsedReference.sha256, rows: parsedReference.rows.length, verificationStatus: 'unverified', language: 'en' },
    mutations: [
      { type: 'missing', verseId: '1:3' }, { type: 'out_of_order', verseIds: ['1:5', '1:6'] },
      { type: 'empty', verseId: '5:1' }, { type: 'duplicate', verseId: '112:2' }, { type: 'invalid', rawId: '115:1' },
      ...contextualCases.map((id, index) => ({ type: 'contextual_change', verseId: `2:${index + 1}`, developmentFixtureId: id })),
    ], xlsxAuthoring, files: results,
  };
  await writeFile(join(outputDir, 'roundtrip-performance.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = await generateQAFixtures();
  console.log(JSON.stringify({ outputDir: DEFAULT_FIXTURE_DIRECTORY, passed: output.files.filter((file) => file.assertionStatus === 'passed').length, browserRequired: output.files.filter((file) => file.parseStatus === 'browser-required').length, files: output.files.map(({ fileName, expectedRows, bytes, parseMS, auditMS, assertionStatus }) => ({ fileName, expectedRows, bytes, parseMS, auditMS, assertionStatus })) }, null, 2));
}
