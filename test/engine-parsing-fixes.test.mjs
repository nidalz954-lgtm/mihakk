import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBatch } from '../src/batch-engine.mjs';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { createReferenceClient } from '../public/modules/reference-api.mjs';
import { getEligibleContextRows } from '../public/modules/context-risk.mjs';
import { redactLiveReferenceText } from '../public/modules/export-redaction.mjs';

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
test('BUG-06: one marker fewer with negation in both texts abstains with the complete original inventory', () => {
  const reference = 'The clerk does not open the door and does not close the window.';
  const candidate = 'The clerk does not open the door and does close the window.';
  const report = pair(reference, candidate);
  assert.equal(codes(report).includes('potential_negation_change'), false, 'presence code must stay reserved for presence differences');
  const finding = report.findings.find((entry) => entry.code === 'negation_comparison_abstain');
  assert.ok(finding, 'count-only difference must be reported');
  assert.equal(finding.type, 'evidence');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.evidence.countOnly, true);
  assert.equal(finding.evidence.candidateNegationCount, 1);
  assert.equal(finding.evidence.referenceNegationCount, 2);
  assert.equal(finding.evidence.scopeEvaluated, false);
  assert.equal(finding.evidence.inventoryOnly, true);
  assert.equal('removedNegations' in finding.evidence, false, 'reference-side text is never listed outside redacted keys');
  assert.equal(finding.spans.length, 3);
  const span = finding.spans.filter(item => item.role === 'reference').at(-1);
  assert.equal(span.role, 'reference');
  assert.equal(span.change, undefined, 'inventory does not infer which logical scope was removed');
  assert.equal(reference.slice(span.start, span.end), 'not');
  assert.equal(span.start, reference.lastIndexOf('not'), 'the unpaired (second) marker is the highlighted one');
  assert.equal(report.rows[0].status, 'abstain');
  assert.equal(report.rows[0].negationReview.state, 'abstain');
  assert.equal(report.summary.negationAbstainRows, 1);
  assert.equal(report.summary.comparisonFindingCount, 0);
  assert.equal(report.summary.negationCountChangeRows, 1);
});

test('BUG-06: one marker more in the candidate abstains without claiming added meaning', () => {
  const reference = 'The clerk does not open the door and does close the window.';
  const candidate = 'The clerk does not open the door and does not close the window.';
  const report = pair(reference, candidate);
  const finding = report.findings.find((entry) => entry.code === 'negation_comparison_abstain');
  assert.ok(finding);
  assert.equal(finding.severity, 'info');
  const span = finding.spans.filter(item => item.role === 'candidate').at(-1);
  assert.equal(span.role, 'candidate');
  assert.equal(span.change, undefined);
  assert.equal(candidate.slice(span.start, span.end), 'not');
  assert.equal(span.start, candidate.lastIndexOf('not'));
  assert.deepEqual(finding.evidence.candidateNegations, ['not', 'not']);
  assert.equal(report.rows[0].negationReview.scopeEvaluated, false);
  assert.equal(report.rows[0].status, 'abstain');
});

test('BUG-06: Arabic negation counts are compared too', () => {
  const reference = 'لا يفتح الموظف الباب ولا يغلق النافذة.';
  const candidate = 'لا يفتح الموظف الباب ويغلق النافذة.';
  const report = pair(reference, candidate, 'ar');
  const finding = report.findings.find((entry) => entry.code === 'negation_comparison_abstain');
  assert.ok(finding);
  assert.equal(finding.evidence.candidateNegationCount, 1);
  assert.equal(finding.evidence.referenceNegationCount, 2);
  const span = finding.spans.filter(item => item.role === 'reference').at(-1);
  assert.equal(reference.slice(span.start, span.end), 'ولا');
  assert.equal(finding.severity, 'info');
});

test('BUG-06: live-reference export redaction removes every reference-side fragment of the count evidence', () => {
  const report = auditBatch({
    rows: [{ surah: 112, ayah: 1, translation: 'The clerk neither opens the door and closes the window.' }],
    referenceRows: [{ surah: 112, ayah: 1, translation: 'The clerk neither opens the door nor closes the window.' }],
    scope: { type: 'provided' },
    metadata: { candidate: { language: 'en' }, reference: { title: 'Live', edition: 'x', verificationStatus: 'verified', language: 'en', sourceKind: 'quranpedia-api' } },
  });
  assert.ok(report.findings.some((finding) => finding.code === 'negation_comparison_abstain'));
  const exported = JSON.stringify(redactLiveReferenceText(report));
  assert.equal(exported.includes('"nor"'), false);
  assert.equal(exported.includes('nor closes'), false);
  assert.ok(exported.includes('negation_comparison_abstain'));
});

test('BUG-06: presence differences keep their original high-priority code and shape', () => {
  const report = pair('The clerk opens the door.', 'The clerk does not open the door.');
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_change');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.evidence.countOnly, undefined);
  assert.equal(finding.evidence.scopeEvaluated, false);
  assert.equal(codes(report).includes('potential_negation_count_change'), false);
  assert.equal(codes(report).includes('negation_comparison_abstain'), false);
  assert.ok(finding.spans.every((span) => span.change === undefined), 'existing presence spans are unchanged');
});

test('BUG-06: equal negation counts, and different words with the same count, raise no negation signal', () => {
  assert.equal(codes(pair('The clerk does not open the door and does not close the window.', 'The clerk does not open the door and does not shut the window.')).some((code) => code.startsWith('potential_negation')), false);
  assert.equal(codes(pair('The clerk does not open the door.', 'The clerk will never open the door.')).some((code) => code.startsWith('potential_negation')), false);
});

test('BUG-06: legitimate consolidation and quoted-word edits produce only count abstention, never a negation verdict', () => {
  for (const [reference, candidate] of [
    ['The lamp is not green and the lamp is not blue.', 'The lamp is not green or blue.'],
    ['Neither the green lamp nor the blue lamp is active.', 'The green lamp and the blue lamp are not active.'],
    ['The label says "not", but the switch is not active.', 'The label says "ready", but the switch is not active.'],
  ]) {
    const report = pair(reference, candidate);
    const finding = report.findings.find(item => item.code === 'negation_comparison_abstain');
    assert.ok(finding);
    assert.equal(finding.type, 'evidence');
    assert.equal(finding.severity, 'info');
    assert.equal(finding.evidence.scopeEvaluated, false);
    assert.equal(codes(report).some(code => code.startsWith('potential_negation')), false);
    assert.ok(finding.spans.every(span => (span.role === 'candidate' ? candidate : reference).slice(span.start, span.end) === span.text));
  }
});

test('BUG-06: reordered clauses and contracted single negation do not invent a count difference', () => {
  for (const [reference, candidate] of [
    ['The lamp is not green.', 'The lamp is not green.'],
    ['The lamp is not green and the door is not open.', 'The door is not open and the lamp is not green.'],
    ['The lamp does not glow.', 'The lamp doesn’t glow.'],
  ]) {
    const report = pair(reference, candidate);
    assert.equal(codes(report).includes('negation_comparison_abstain'), false);
    assert.equal(codes(report).some(code => code.startsWith('potential_negation')), false);
    assert.equal(report.rows[0].negationReview.scopeEvaluated, false);
  }
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
    assert.equal(row.languageReview.state, 'abstain');
    assert.equal(row.qualifierReview.state, 'unsupported', 'unsupported language does not impersonate a qualifier-scope analysis');
    assert.equal(report.summary.noSignalRows, 0);
    assert.equal(report.summary.abstainRows, 1);
    assert.deepEqual(report.summary.languageLimits, { language: 'fr', negationChecked: false, quantifierChecked: false, writtenNumbersChecked: false, digitsChecked: true, rowsLimited: 1, rowsAbstained: 1 });
    assert.equal(report.summary.unsupportedRuleLanguageRows, 1);
    assert.ok(codes(report).includes('language_rule_abstain'));
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

test('BUG-02: literal or normalised equality cannot imply unsupported linguistic rules ran', () => {
  for (const candidate of ['Il mange trois pommes.', 'IL MANGE TROIS POMMES !']) {
    const report = pair('Il mange trois pommes.', candidate, 'fr');
    assert.equal(report.rows[0].status, 'abstain');
    assert.equal(report.rows[0].comparisonStatus, 'compared');
    assert.equal(report.rows[0].languageReview.scopeEvaluated, false);
    assert.equal(report.summary.languageLimits.rowsLimited, 1);
    assert.equal(report.summary.languageLimits.rowsAbstained, 1);
    assert.ok(codes(report).includes('language_checks_limited'));
    assert.ok(codes(report).includes('language_rule_abstain'));
    assert.equal(report.summary.comparisonFindingCount, 0);
    assert.equal(report.rows[0].reference.translation, 'Il mange trois pommes.');
  }
});

test('BUG-02: digits are still compared in an unsupported language and win over the abstention', () => {
  const report = pair('Il mange 3 pommes dans le jardin.', 'Il mange 5 pommes dans le jardin.', 'fr');
  assert.equal(report.rows[0].status, 'needs_review');
  assert.ok(codes(report).includes('potential_numeric_change'));
  assert.equal(report.summary.languageLimits.digitsChecked, true);
  assert.equal(report.summary.languageLimits.rowsAbstained, 0);
  assert.equal(report.rows[0].languageReview.state, 'abstain');
  assert.equal(report.findings.find((finding) => finding.code === 'language_checks_limited').evidence.rowsAbstained, 0);
});

test('BUG-02: an unverified reference keeps its own abstention reason', () => {
  const report = pair('Il mange trois pommes dans le jardin.', 'Il mange cinq pommes dans le jardin.', 'fr', { verified: false });
  assert.equal(report.rows[0].status, 'abstain');
  assert.equal(report.rows[0].comparisonStatus, 'abstain');
  assert.equal(report.rows[0].comparisonReason, 'unverified_reference');
  assert.equal(report.summary.languageLimits.rowsLimited, 1);
  assert.equal(report.summary.languageLimits.rowsAbstained, 1);
  assert.equal(report.rows[0].languageReview.state, 'abstain');
});

test('BUG-02: English and Arabic behave exactly as before and only report their static limits', () => {
  const english = pair('The clerk opens the door.', 'The clerk closes the door.', 'en');
  assert.equal(codes(english).includes('language_checks_limited'), false);
  assert.deepEqual(english.summary.languageLimits, { language: 'en', negationChecked: true, quantifierChecked: true, writtenNumbersChecked: true, digitsChecked: true, rowsLimited: 0, rowsAbstained: 0 });
  assert.notEqual(english.rows[0].comparisonReason, 'language_checks_unsupported');

  const arabic = pair('يجب أن يقرأ الموظف الدليل.', 'يمكن أن يقرأ الموظف الدليل.', 'ar');
  assert.equal(arabic.rows[0].qualifierReview.state, 'unsupported', 'Arabic qualifier handling is unchanged');
  assert.equal(codes(arabic).includes('language_checks_limited'), false);
  assert.equal(arabic.rows[0].comparisonReason, null);
  assert.deepEqual(arabic.summary.languageLimits, { language: 'ar', negationChecked: true, quantifierChecked: false, writtenNumbersChecked: true, digitsChecked: true, rowsLimited: 0, rowsAbstained: 0 });

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

test('BUG-02: comparison gates preserve source data and never claim a language-rule run', () => {
  const rows = [{surah:112,ayah:1,translation:'La lampe est verte.'}, {surah:112,ayah:1,translation:'Une copie.'}];
  const report = auditBatch({rows,referenceRows:[rows[0]],scope:{type:'provided'},metadata:{candidate:{language:'fr'},reference:{language:'fr',verificationStatus:'verified'}}});
  assert.ok(codes(report).includes('duplicate_verse'));
  assert.equal(report.summary.lexicalComparedRows, 0);
  assert.equal(report.summary.languageLimits.rowsLimited, 0);
  assert.equal(report.rows[0].languageReview.state, 'not_compared');
  assert.equal(report.rows[0].negationReview.state, 'not_compared');
  assert.equal(report.rows[0].comparisonReason, 'duplicate_candidate');
  const unverified = pair('La lampe est verte.', 'La lampe est verte.', 'fr', {verified:false});
  assert.equal(unverified.rows[0].comparisonStatus, 'abstain');
  assert.equal(unverified.rows[0].comparisonReason, 'unverified_reference');
  assert.equal(unverified.rows[0].status, 'abstain');
  assert.equal(unverified.summary.languageLimits.rowsLimited, 1);
});

// ---------------------------------------------------------------- BUG-07
// Synthetic response shapes only (no copyrighted translation text): leading verse numbers and note anchors.
const timestamp = '2026-10-07T00:00:00.000Z';
const jsonResponse = (data) => new Response(JSON.stringify(data), { status: 200 });
async function fetchShapes(items, { surah = 2, rows } = {}) {
  const client = createReferenceClient({
    fetchImpl: async () => jsonResponse(items), cryptoImpl: webcrypto, now: () => new Date(timestamp), delay: async () => {},
  });
  return client.fetchReferenceForRows({ book: { id: 1948, title: 'Synthetic shape book', language: 'en' }, rows: rows ?? items.map((item) => ({ surah, ayah: item.ayah_number })) });
}

test('BUG-07: a leading "N." verse number is removed, raw and normalised hashes are both recorded', async () => {
  const raw = '3. The clerk opens the door.';
  const result = await fetchShapes([{ ayah_number: 3, translation_text: raw }]);
  const [row] = result.rows;
  assert.equal(row.translation, 'The clerk opens the door.');
  assert.equal(row.rawSha256, createHash('sha256').update(raw).digest('hex'), 'raw hash covers the retrieved text unchanged');
  assert.equal(row.normalizedSha256, createHash('sha256').update('The clerk opens the door.').digest('hex'));
  assert.notEqual(row.rawSha256, row.normalizedSha256);
  assert.deepEqual(row.normalization, { versePrefixRemoved: true, noteAnchorsRemoved: 0 });
  assert.equal(result.metadata.normalization.versePrefixRows, 1);
  assert.equal(result.metadata.retention, 'session-memory-only');
});

test('BUG-07: "(S:A)" and "[S:A]" prefixes and numeric <sup> anchors are removed; letter text in <sup> is kept', async () => {
  const result = await fetchShapes([
    { ayah_number: 3, translation_text: "<div class='t'><span>(2:3)</span> The clerk<sup>1</sup> opens the door<sup>2</sup>.</div><div class='foot-notes'>1. A note. 2. Another note.</div>" },
    { ayah_number: 4, translation_text: '<div><span>[2:4]</span> The clerk closes the window.</div>' },
    { ayah_number: 5, translation_text: '<div>On the 5<sup>th</sup> day the clerk rests.</div>' },
  ]);
  const byAyah = Object.fromEntries(result.rows.map((row) => [row.ayah, row]));
  assert.equal(byAyah[3].translation, 'The clerk opens the door.');
  assert.equal(/[0-9]/.test(byAyah[3].translation), false);
  assert.deepEqual(byAyah[3].footnotes, ['1. A note. 2. Another note.']);
  assert.deepEqual(byAyah[3].normalization, { versePrefixRemoved: true, noteAnchorsRemoved: 2 });
  assert.equal(byAyah[4].translation, 'The clerk closes the window.');
  assert.match(byAyah[5].translation, /5\s?th day/);
  assert.equal(byAyah[5].normalization.noteAnchorsRemoved, 0);
  assert.equal(result.metadata.normalization.versePrefixRows, 2);
  assert.equal(result.metadata.normalization.noteAnchorsRemoved, 2);
});

test('BUG-07: only the requested verse number is removed; decimals and other numbers stay', async () => {
  const result = await fetchShapes([
    { ayah_number: 2, translation_text: '2.5 litres of water remain.' },
    { ayah_number: 5, translation_text: '3. The clerk waits.' },
    { ayah_number: 6, translation_text: '(2:9) The clerk waits.' },
    { ayah_number: 7, translation_text: 'The clerk waits 7. times' },
  ]);
  const byAyah = Object.fromEntries(result.rows.map((row) => [row.ayah, row]));
  assert.equal(byAyah[2].translation, '2.5 litres of water remain.');
  assert.equal(byAyah[5].translation, '3. The clerk waits.');
  assert.equal(byAyah[6].translation, '(2:9) The clerk waits.');
  assert.equal(byAyah[7].translation, 'The clerk waits 7. times');
  assert.equal(result.metadata.normalization.versePrefixRows, 0);
});

test('BUG-07: prefixed live references no longer make every row a numeric change, and real numeric changes still show', async () => {
  const ayat = [1, 2, 3, 4, 5, 6];
  const bodies = ['The clerk opens the door.', 'The clerk closes the window.', 'The clerk reads the page.', 'The clerk writes the note.', 'The clerk carries the box.', 'The clerk counts three chairs.'];
  const result = await fetchShapes(ayat.map((ayah, index) => ({ ayah_number: ayah, translation_text: `${ayah}. ${bodies[index]}` })));
  const report = auditBatch({
    rows: ayat.map((ayah, index) => ({ surah: 2, ayah, translation: index === 5 ? 'The clerk counts five chairs.' : bodies[index] })),
    referenceRows: result.rows,
    scope: { type: 'provided' },
    metadata: { candidate: { language: 'en' }, reference: { ...result.metadata, language: 'en' } },
  });
  const numeric = report.findings.filter((finding) => finding.code === 'potential_numeric_change');
  assert.equal(numeric.length, 1, 'only the genuinely changed number is flagged');
  assert.deepEqual(numeric[0].verseIds, ['2:6']);
});

// ---------------------------------------------------------------- BUG-32
const numericCodes = (report) => report.findings.filter((finding) => /numeric/.test(finding.code)).map((finding) => finding.code);

test('BUG-32: "a thousand" against "a hundred" is a numeric change, not only an abstention', () => {
  const report = pair('They may live a thousand years.', 'They may live a hundred years.');
  assert.ok(codes(report).includes('potential_numeric_change'));
  assert.ok(!codes(report).includes('numeric_comparison_abstain'));
  const finding = report.findings.find((item) => item.code === 'potential_numeric_change');
  assert.equal(report.rows[0].status, 'needs_review');
  assert.deepEqual(finding.evidence.referenceQuantities.map((quantity) => quantity.numerator), ['1000']);
  assert.deepEqual(finding.evidence.candidateQuantities.map((quantity) => quantity.numerator), ['100']);
  assert.deepEqual(finding.spans.map((span) => span.text).sort(), ['a hundred', 'a thousand']);
});

test('BUG-32: "a hundred" equals "one hundred" and "100"; compound and bounded forms still abstain', () => {
  for (const other of ['They waited one hundred years.', 'They waited 100 years.', 'They waited a hundred years.']) {
    assert.deepEqual(numericCodes(pair('They waited a hundred years.', other)), [], other);
  }
  assert.deepEqual(numericCodes(pair('They waited a thousand years.', 'They waited 1000 years.')), []);
  // Not exact quantities: the article rule must not turn these into confident numbers.
  for (const text of ['They waited about a hundred years.', 'They waited at least a hundred years.', 'They waited more than a hundred years.', 'They waited a hundred and five years.', 'They waited a hundred thousand years.']) {
    const report = pair(text, 'They waited seven years.');
    assert.ok(!codes(report).includes('potential_numeric_change'), text);
    assert.ok(codes(report).includes('numeric_comparison_abstain'), text);
  }
});

test('article scales retain changed bounds and approximations in the raw numeric signature', () => {
  for (const [reference, candidate] of [
    ['They counted at least a hundred chairs.', 'They counted a hundred chairs.'],
    ['They counted at least a hundred chairs.', 'They counted at most a hundred chairs.'],
    ['They counted more than a thousand chairs.', 'They counted less than a thousand chairs.'],
    ['They counted about a hundred chairs.', 'They counted a hundred chairs.'],
  ]) {
    const report = pair(reference, candidate);
    assert.equal(report.rows[0].numericReview.state, 'abstain', `${reference} / ${candidate}`);
    assert.equal(report.rows[0].status, 'abstain');
    assert.ok(codes(report).includes('numeric_comparison_abstain'));
    assert.equal(codes(report).includes('potential_numeric_change'), false);
    const finding = report.findings.find(item => item.code === 'numeric_comparison_abstain');
    assert.ok(finding.evidence.reasons.some(item => /bounded_quantity_not_exact|approximate_quantity_not_exact/.test(item.reason)));
    for (const span of finding.spans) assert.equal((span.role === 'candidate' ? candidate : reference).slice(span.start, span.end), span.text);
  }
  assert.equal(pair('They counted a hundred chairs.', 'They counted a hundred chairs.').rows[0].numericReview.state, 'unchanged');
});

test('preserved powers remain unsupported numeric syntax rather than separate exact quantities', () => {
  for (const [reference, candidate] of [
    ['10^5 samples remain.', '10 samples remain.'],
    ['10^5 samples remain.', '10^6 samples remain.'],
    ['The area is 50 m^2 wide.', 'The area is 50 m wide.'],
  ]) {
    const report = pair(reference, candidate);
    assert.equal(report.rows[0].numericReview.state, 'abstain');
    assert.ok(codes(report).includes('numeric_comparison_abstain'));
    assert.equal(codes(report).includes('potential_numeric_change'), false);
    const reasons = report.rows[0].numericReview.reasons;
    assert.ok(reasons.some(item => /numeric_power_not_supported|compound_or_power_unit_not_supported/.test(item.reason)));
  }
});

test('BUG-32: the machine-readable limitations list the verified blind spots of the rule families', () => {
  const report = pair('He arrived on Monday.', 'He arrived on Sunday.');
  const text = report.provenance.analysis.limitations.join('\n');
  assert.match(text, /not bound to the entities/);
  assert.match(text, /nothing/i);
  assert.match(text, /Arabic.*hundreds/i);
  assert.match(text, /Arabic.*quantifier/i);
  assert.match(text, /declared language is not verified/i);
  // Existing entries stay in place.
  assert.ok(report.provenance.analysis.limitations.some((line) => /No signal does not certify accuracy/.test(line)));
});

test('BUG-32: the verified blind spots really are blind (kept honest by this test)', () => {
  // Quantities are compared as a set, not bound to the things counted.
  assert.equal(pair('Five men and seven women came.', 'Seven men and five women came.').rows[0].status, 'no_signal');
  // Negating pronouns are outside the negation list.
  assert.equal(pair('Something was left in the room.', 'Nothing was left in the room.').rows[0].status, 'no_signal');
  // Arabic compound hundreds and quantifiers are not interpreted: at most a generic lexical difference.
  assert.ok(!codes(pair('جاء ثلاثمائة رجل', 'جاء أربعمائة رجل', 'ar')).includes('potential_numeric_change'));
  assert.ok(!codes(pair('جاء كل الرجال', 'جاء بعض الرجال', 'ar')).includes('potential_qualifier_change'));
  assert.equal(pair('هو حاضر في البيت', 'هو غير حاضر في البيت', 'ar').rows[0].status, 'no_signal');
});
