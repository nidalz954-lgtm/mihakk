import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBatch, textHygieneIssues } from '../src/batch-engine.mjs';
import { redactLiveReferenceText } from '../public/modules/export-redaction.mjs';

// Synthetic, non-religious text. Mirrors contamination found on 2026-10-06 in real provider data
// (Arabic text inside an English field) and seeded in the real-text stress test (HTML, invisible controls, look-alike letters).
const kinds = (text, language = 'en') => textHygieneIssues(text, language).issues.map((issue) => issue.kind);

test('clean Latin-script text, ordinary punctuation and a single honorific ligature raise no hygiene issue', () => {
  assert.deepEqual(kinds('The lanterns were lit before dawn, and the market opened at noon.'), []);
  assert.deepEqual(kinds('Le marché ouvre à midi; les lanternes brillent.', 'fr'), []);
  assert.deepEqual(kinds('The messenger \ufdfa spoke.'), []);
  assert.deepEqual(kinds('Prices < 5 and > 2 are fine.'), []);
});

test('markup, hidden controls, directional marks, Arabic text in English and look-alike letters are each named', () => {
  assert.deepEqual(kinds('<i>The river flows</i> east.'), ['markup']);
  assert.deepEqual(kinds('Bread &amp; salt.'), ['markup']);
  assert.deepEqual(kinds('The river\u200b flows east.'), ['hidden_controls']);
  assert.deepEqual(kinds('The river \u202eflows east.'), ['hidden_controls']);
  assert.deepEqual(kinds('The ri\u00adver flows east.'), ['hidden_controls']); // soft hyphen
  for (const hidden of ['\u034f', '\u180e', '\ufff9', '\u{e0041}']) assert.deepEqual(kinds('The ri' + hidden + 'ver flows east.'), ['hidden_controls'], hidden.codePointAt(0).toString(16));
  assert.deepEqual(kinds('The ri\u200fver flows east.'), ['directional_marks']);
  assert.deepEqual(kinds('مرحبا بكم The river flows east.'), ['foreign_script']);
  assert.deepEqual(kinds('The \u0430pple orchard.'), ['mixed_script_word']); // Cyrillic a inside a Latin word
  assert.deepEqual(kinds('The \u039frchard gate.'), ['mixed_script_word']); // Greek Omicron
  const evidence = textHygieneIssues('The \u0430pple orchard.', 'en').issues[0];
  assert.deepEqual(evidence.examples, ['U+0430']);
});

test('Arabic-script languages may use joiners and direction marks legitimately; hidden zero-width space is still reported', () => {
  assert.deepEqual(kinds('می\u200cخواهم کتاب را بخوانم', 'ur'), []);
  assert.deepEqual(kinds('النص\u200f العربي', 'ar'), []);
  assert.deepEqual(kinds('النص\u200b العربي', 'ar'), ['hidden_controls']);
});

test('a contaminated candidate row needs review; a contaminated reference row is disclosed as evidence and survives live export redaction', () => {
  const report = auditBatch({
    rows: [
      { surah: 1, ayah: 1, translation: '<b>The lanterns</b> were lit.' },
      { surah: 1, ayah: 2, translation: 'The boxes stay closed.' },
      { surah: 1, ayah: 3, translation: 'The library opens on Monday.' },
    ],
    referenceRows: [
      { surah: 1, ayah: 1, translation: 'The lanterns were lit.' },
      { surah: 1, ayah: 2, translation: 'مرحبا بكم جميعا The boxes stay closed.' },
      { surah: 1, ayah: 3, translation: 'The library opens on Monday.' },
    ],
    scope: { type: 'provided' },
    metadata: { candidate: { name: 'Synthetic', language: 'en' }, reference: { title: 'Live source', sourceKind: 'quranpedia-api', verificationStatus: 'verified', language: 'en' } },
  });
  const byVerse = (id) => report.rows.find((row) => row.verseId === id);
  assert.ok(byVerse('1:1').findings.some((finding) => finding.code === 'text_hygiene'));
  assert.equal(byVerse('1:1').status, 'needs_review');
  const referenceFinding = byVerse('1:2').findings.find((finding) => finding.code === 'reference_text_hygiene');
  assert.ok(referenceFinding);
  assert.equal(referenceFinding.type, 'evidence');
  assert.equal(byVerse('1:3').findings.length, 0);
  assert.equal(report.summary.textHygieneRows, 1);
  assert.equal(report.summary.referenceHygieneRows, 1);
  const exported = JSON.stringify(redactLiveReferenceText(report));
  assert.ok(!exported.includes('مرحبا بكم'), 'live reference text must not leak through hygiene spans');
  assert.match(exported, /reference_text_hygiene/);
});
