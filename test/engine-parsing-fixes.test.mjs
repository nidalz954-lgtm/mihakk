import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBatch } from '../src/batch-engine.mjs';
import { readFile } from 'node:fs/promises';
import { getEligibleContextRows } from '../public/modules/context-risk.mjs';

// Engine and parsing fixes from the 2026-10-07 live check (BUG-06, BUG-02, BUG-07, BUG-08, BUG-33, BUG-34, BUG-32).
// All texts are authored NONRELIGIOUS sentences; they are not Quran translations.

const pair = (reference, candidate, language = 'en', { verified = true } = {}) => auditBatch({
  rows: [{ surah: 112, ayah: 1, translation: candidate }],
  referenceRows: [{ surah: 112, ayah: 1, translation: reference }],
  scope: { type: 'provided' },
  metadata: {
    candidate: { name: 'Authored synthetic pair', language, synthetic: true },
    reference: { title: 'Synthetic comparison', edition: 'test-1', verificationStatus: verified ? 'verified' : 'unverified', language, licenseNote: 'Authored synthetic test fixture.' },
  },
});
const codes = (report) => report.findings.map((finding) => finding.code);

test('the committed public copy of the engine is byte-identical to src/batch-engine.mjs', async () => {
  const [source, copy] = await Promise.all([readFile(new URL('../src/batch-engine.mjs', import.meta.url)), readFile(new URL('../public/modules/batch-engine.mjs', import.meta.url))]);
  assert.ok(source.equals(copy));
});

// ---------------------------------------------------------------- BUG-06
test('BUG-06: one marker fewer in the candidate is a medium count-only signal with the removed marker highlighted', () => {
  const reference = 'The clerk does not open the door and does not close the window.';
  const candidate = 'The clerk does not open the door and does close the window.';
  const report = pair(reference, candidate);
  assert.equal(codes(report).includes('potential_negation_change'), false, 'presence code must stay reserved for presence differences');
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_count_change');
  assert.ok(finding, 'count-only difference must be reported');
  assert.equal(finding.type, 'comparison');
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.evidence.countOnly, true);
  assert.equal(finding.evidence.candidateNegationCount, 1);
  assert.equal(finding.evidence.referenceNegationCount, 2);
  assert.deepEqual(finding.evidence.removedNegations, ['not']);
  assert.deepEqual(finding.evidence.addedNegations, []);
  assert.equal(finding.spans.length, 1);
  const [span] = finding.spans;
  assert.equal(span.role, 'reference');
  assert.equal(span.change, 'removed');
  assert.equal(reference.slice(span.start, span.end), 'not');
  assert.equal(span.start, reference.lastIndexOf('not'), 'the unpaired (second) marker is the highlighted one');
  assert.equal(report.rows[0].status, 'needs_review');
  assert.equal(report.summary.negationCountChangeRows, 1);
});

test('BUG-06: one marker more in the candidate highlights the added marker', () => {
  const reference = 'The clerk does not open the door and does close the window.';
  const candidate = 'The clerk does not open the door and does not close the window.';
  const report = pair(reference, candidate);
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_count_change');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
  const [span] = finding.spans;
  assert.equal(span.role, 'candidate');
  assert.equal(span.change, 'added');
  assert.equal(candidate.slice(span.start, span.end), 'not');
  assert.equal(span.start, candidate.lastIndexOf('not'));
  assert.deepEqual(finding.evidence.addedNegations, ['not']);
});

test('BUG-06: Arabic negation counts are compared too', () => {
  const reference = 'لا يفتح الموظف الباب ولا يغلق النافذة.';
  const candidate = 'لا يفتح الموظف الباب ويغلق النافذة.';
  const report = pair(reference, candidate, 'ar');
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_count_change');
  assert.ok(finding);
  assert.equal(finding.evidence.candidateNegationCount, 1);
  assert.equal(finding.evidence.referenceNegationCount, 2);
  assert.equal(reference.slice(finding.spans[0].start, finding.spans[0].end), 'ولا');
});

test('BUG-06: presence differences keep their original high-priority code and shape', () => {
  const report = pair('The clerk opens the door.', 'The clerk does not open the door.');
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_change');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.evidence.countOnly, undefined);
  assert.equal(codes(report).includes('potential_negation_count_change'), false);
  assert.ok(finding.spans.every((span) => span.change === undefined), 'existing presence spans are unchanged');
});

test('BUG-06: equal negation counts, and different words with the same count, raise no negation signal', () => {
  assert.equal(codes(pair('The clerk does not open the door and does not close the window.', 'The clerk does not open the door and does not shut the window.')).some((code) => code.startsWith('potential_negation')), false);
  assert.equal(codes(pair('The clerk does not open the door.', 'The clerk will never open the door.')).some((code) => code.startsWith('potential_negation')), false);
});

// ---------------------------------------------------------------- BUG-02
test('BUG-02: a changed French sentence without a digit is an abstention, never "no_signal"', () => {
  for (const [reference, candidate] of [
    ['Il mange trois pommes dans le jardin.', 'Il mange cinq pommes dans le jardin.'],
    ['Il ne mange pas de pommes dans le jardin ce matin.', 'Il mange des pommes dans le jardin ce matin.'],
  ]) {
    const report = pair(reference, candidate, 'fr');
    const [row] = report.rows;
    assert.equal(row.status, 'abstain');
    assert.equal(row.comparisonStatus, 'compared', 'stays model-eligible: the row was compared, only the word-level meaning checks are missing');
    assert.equal(row.comparisonReason, 'language_checks_unsupported');
    assert.equal(row.qualifierReview.state, 'abstain');
    assert.equal(report.summary.noSignalRows, 0);
    assert.equal(report.summary.abstainRows, 1);
    assert.deepEqual(report.summary.languageLimits, { language: 'fr', negationChecked: false, quantifierChecked: false, writtenNumbersChecked: false, digitsChecked: true, rowsLimited: 1 });
    const limited = report.findings.filter((finding) => finding.code === 'language_checks_limited');
    assert.equal(limited.length, 1, 'exactly one report-level finding');
    assert.equal(limited[0].type, 'evidence');
    assert.equal(limited[0].severity, 'info');
    assert.match(limited[0].message, /لا يعني أن هذه الفحوص جرت/);
    assert.equal(limited[0].evidence.rowsLimited, 1);
    assert.equal(limited[0].evidence.rowsAbstained, 1);
    assert.deepEqual(limited[0].rowNumbers, []);
  }
});

test('BUG-02: the abstained row is still eligible for the multilingual model', () => {
  const report = pair('La bibliothèque est ouverte lundi.', 'La bibliothèque est fermée lundi.', 'fr');
  assert.equal(report.rows[0].status, 'abstain');
  assert.equal(getEligibleContextRows(report, 'multilingual').length, 1);
});

test('BUG-02: unchanged words in an unsupported language stay clear, and no limits finding appears', () => {
  const report = pair('Il mange trois pommes.', 'IL MANGE TROIS POMMES !', 'fr');
  assert.equal(report.rows[0].status, 'no_signal');
  assert.equal(report.summary.languageLimits.rowsLimited, 0);
  assert.equal(codes(report).includes('language_checks_limited'), false);
});

test('BUG-02: digits are still compared in an unsupported language and win over the abstention', () => {
  const report = pair('Il mange 3 pommes dans le jardin.', 'Il mange 5 pommes dans le jardin.', 'fr');
  assert.equal(report.rows[0].status, 'needs_review');
  assert.ok(codes(report).includes('potential_numeric_change'));
  assert.equal(report.summary.languageLimits.digitsChecked, true);
  assert.equal(report.findings.find((finding) => finding.code === 'language_checks_limited').evidence.rowsAbstained, 0);
});

test('BUG-02: an unverified reference keeps its own abstention reason', () => {
  const report = pair('Il mange trois pommes dans le jardin.', 'Il mange cinq pommes dans le jardin.', 'fr', { verified: false });
  assert.equal(report.rows[0].status, 'abstain');
  assert.equal(report.rows[0].comparisonStatus, 'abstain');
  assert.equal(report.rows[0].comparisonReason, 'unverified_reference');
  assert.equal(report.summary.languageLimits.rowsLimited, 1);
});

test('BUG-02: English and Arabic behave exactly as before and only report their static limits', () => {
  const english = pair('The clerk opens the door.', 'The clerk closes the door.', 'en');
  assert.equal(codes(english).includes('language_checks_limited'), false);
  assert.deepEqual(english.summary.languageLimits, { language: 'en', negationChecked: true, quantifierChecked: true, writtenNumbersChecked: true, digitsChecked: true, rowsLimited: 0 });
  assert.notEqual(english.rows[0].comparisonReason, 'language_checks_unsupported');

  const arabic = pair('يجب أن يقرأ الموظف الدليل.', 'يمكن أن يقرأ الموظف الدليل.', 'ar');
  assert.equal(arabic.rows[0].qualifierReview.state, 'unsupported', 'Arabic qualifier handling is unchanged');
  assert.equal(codes(arabic).includes('language_checks_limited'), false);
  assert.equal(arabic.rows[0].comparisonReason, null);
  assert.deepEqual(arabic.summary.languageLimits, { language: 'ar', negationChecked: true, quantifierChecked: false, writtenNumbersChecked: true, digitsChecked: true, rowsLimited: 0 });

  const undeclared = pair('The clerk opens the door.', 'The clerk closes the door.', '');
  assert.equal(undeclared.summary.languageLimits.rowsLimited, 0);
  assert.equal(undeclared.summary.languageLimits.language, '');
});

test('BUG-02: the report stays additive (same schema version, no field removed)', () => {
  const report = pair('Il mange trois pommes.', 'Il mange cinq pommes.', 'fr');
  assert.equal(report.schemaVersion, 'mihakk-batch/1');
  for (const key of ['totalRows', 'comparedRows', 'lexicalComparedRows', 'abstainRows', 'noSignalRows', 'needsReviewRows', 'qualifierAbstainRows', 'numericAbstainRows', 'certification']) assert.ok(key in report.summary, key);
  assert.equal(report.summary.certification, 'none');
});
