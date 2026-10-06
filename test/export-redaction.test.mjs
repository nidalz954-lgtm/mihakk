import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBatch } from '../src/batch-engine.mjs';
import { redactLiveReferenceText } from '../public/modules/export-redaction.mjs';

// Synthetic, non-religious text. Reference sentences contain distinctive words that must never reach a live export.
const reference = [
  { surah: 1, ayah: 1, translation: 'ZEPHYR all 3 lanterns must be lit before dawn.' },
  { surah: 1, ayah: 2, translation: 'QUOKKA the 12 boxes may stay closed after noon.' },
  { surah: 1, ayah: 3, translation: 'MARIGOLD the library is open on Monday.' },
];
const candidate = [
  { surah: 1, ayah: 1, translation: 'Some 4 lanterns may be lit after dawn.' },
  { surah: 1, ayah: 2, translation: 'The 20 boxes must stay closed before noon.' },
  { surah: 1, ayah: 3, translation: 'The library is not open on Monday.' },
];
const live = { title: 'Live source', sourceKind: 'quranpedia-api', verificationStatus: 'verified', language: 'en', retrievedAt: '2026-10-06T06:00:00.000Z', url: 'https://api.quranpedia.net/v1/book/1947' };

function liveReport() {
  return auditBatch({ rows: candidate, referenceRows: reference, scope: { type: 'provided' }, metadata: { candidate: { name: 'Synthetic', language: 'en' }, reference: live } });
}

test('live reference text never appears anywhere in the redacted export (rows, numeric/qualifier reviews, findings, spans)', () => {
  const report = liveReport();
  const before = JSON.stringify(report);
  // The engine itself carries reference fragments in review evidence; the export must remove all of them.
  assert.match(before, /ZEPHYR|QUOKKA|MARIGOLD/);
  const exported = JSON.stringify(redactLiveReferenceText(report));
  for (const word of ['ZEPHYR', 'QUOKKA', 'MARIGOLD', 'lit before dawn', '12 boxes']) assert.ok(!exported.includes(word), `leaked: ${word}`);
  assert.match(exported, /Live reference text omitted/);
  // Candidate text, locators and review results stay.
  assert.match(exported, /Some 4 lanterns may be lit after dawn/);
  assert.match(exported, /api\.quranpedia\.net/);
  assert.ok(redactLiveReferenceText(report).findings.length === report.findings.length);
});

test('redaction does not mutate the in-memory report', () => {
  const report = liveReport();
  const snapshot = JSON.stringify(report);
  redactLiveReferenceText(report);
  assert.equal(JSON.stringify(report), snapshot);
});

test('user-uploaded references are exported unchanged (the user owns that text)', () => {
  const report = auditBatch({ rows: candidate, referenceRows: reference, scope: { type: 'provided' }, metadata: { candidate: { language: 'en' }, reference: { ...live, sourceKind: 'user-upload', verificationStatus: 'unverified' } } });
  assert.equal(JSON.stringify(redactLiveReferenceText(report)), JSON.stringify(report));
});
