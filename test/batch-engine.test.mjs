import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBatch, generateDemoRows, generateDemoReferenceRows } from '../src/batch-engine.mjs';
import {
  SURAH_AYAH_COUNTS, TOTAL_AYAHS, expectedVerseIds, normalizeScope,
  strictInteger, isValidVerseId, verseOrdinal,
} from '../src/quran-index.mjs';

const selected = { type: 'selected', surahs: [112] };
const completeRows = (scope = selected) => expectedVerseIds(scope).map((verseId, index) => {
  const [surah, ayah] = verseId.split(':').map(Number);
  return { surah, ayah, translation: `Sample record ${verseId}: the procedure does not accept an unchecked item.`, rowNumber: index + 2 };
});
const metadata = {
  candidate: { name: 'Synthetic test', language: 'en', synthetic: true },
  reference: { title: 'Synthetic comparison', edition: 'test-1', verificationStatus: 'verified', language: 'en', licenseNote: 'Verified synthetic test fixture, not a religious source.' },
};
const codes = (report) => report.findings.map((finding) => finding.code);

function authoredPair(reference,candidate,language='en',extra={}) {
  return auditBatch({
    rows:[{surah:112,ayah:1,translation:candidate}],
    referenceRows:[{surah:112,ayah:1,translation:reference}],
    scope:{type:'provided'},
    metadata:{candidate:{language,synthetic:true},reference:{...metadata.reference,language,...extra}},
  });
}

test('changed written numbers and Arabic/Persian digit amounts remain high-priority potential evidence',()=>{
  for(const [reference,candidate,language] of [
    ['The room has seven chairs.','The room has six chairs.','en'],
    ['في القاعة ثلاثة مقاعد.','في القاعة أربعة مقاعد.','ar'],
    ['في القاعة ١٢ مقعدا.','في القاعة ۱۳ مقعدا.','ar'],
  ]) {
    const report=authoredPair(reference,candidate,language);
    const finding=report.rows[0].findings.find(f=>f.code==='potential_numeric_change');
    assert.ok(finding);
    assert.equal(finding.severity,'high');
    assert.equal(finding.evidence.potentialOnly,true);
    assert.equal(finding.evidence.inventoryOnly,true);
    for(const span of finding.spans)assert.equal((span.role==='candidate'?candidate:reference).slice(span.start,span.end),span.text);
    assert.equal(report.summary.numericChangeRows,1);
  }
});

test('supported written/digit and SI/time conversions compare exactly without numeric-change claims',()=>{
  for(const [reference,candidate,language] of [
    ['There are one hundred and five chairs.','There are 105 chairs.','en'],
    ['There are twenty-one chairs.','There are 21 chairs.','en'],
    ['There are one thousand two hundred chairs.','There are 1200 chairs.','en'],
    ['المسافة ١٠٠٠ متر.','المسافة ١ كيلومتر.','ar'],
    ['Use 0.1 kg.','Use 100 g.','en'],
    ['Use 1 mL.','Use 0.001 L.','en'],
    ['Use 1-kg bags.','Use 1000-g bags.','en'],
    ['Wait 60 seconds.','Wait 1 minute.','en'],
    ['The share is 50%.','The share is 50 percent.','en'],
    ['القياس ١٫٥ متر.','القياس 1.5 متر.','ar'],
    ['العدد ١٬٠٠٠.','العدد 1000.','ar'],
  ]) {
    const report=authoredPair(reference,candidate,language);
    assert.equal(report.rows[0].numericReview.state,'equivalent',`${reference} / ${candidate}`);
    assert.equal(codes(report).includes('potential_numeric_change'),false);
  }
});

test('decimal distinctions beyond binary floating precision and unit dimensions remain visible',()=>{
  const tiny=authoredPair('Use 100 g.','Use 0.100000000000000000001 kg.');
  assert.ok(codes(tiny).includes('potential_numeric_change'));
  const dimension=authoredPair('The sample is 2 m.','The sample is 2 g.');
  assert.ok(codes(dimension).includes('potential_numeric_change'));
  const percent=authoredPair('The share is 50%.','The share is 0.5.');
  assert.ok(codes(percent).includes('potential_numeric_change'));
  const signed=authoredPair('The reading is -2.5 m.','The reading is 2.5 m.');
  assert.ok(codes(signed).includes('potential_numeric_change'));
});

test('ambiguous syntax, unsupported cardinal compositions and units abstain instead of inventing quantity changes',()=>{
  for(const [reference,candidate,language] of [
    ['Use 1,000 g.','Use 1000 g.','en'],
    ['Use 1/2 litre.','Use 0.5 litre.','en'],
    ['Use .5 litre.','Use 0.5 litre.','en'],
    ['Use 3-5 items.','Use 4 items.','en'],
    ['Meet at 12:30.','Meet at 13:30.','en'],
    ['Use 2 pounds.','Use 1 kg.','en'],
    ['Use 20 °C.','Use 68 °F.','en'],
    ['Use 10 km/h.','Use 20 km/h.','en'],
    ['Use 1.2.3 kg.','Use 123 kg.','en'],
    ['Use 10 M.','Use 10 m.','en'],
    ['Use 10 square metres.','Use 10 m.','en'],
    ['Use 10 m2.','Use 10 m.','en'],
    ['The count is at least 10.','The count is 11.','en'],
    ['The count is one million.','The count is 1000000.','en'],
    ['Use half a litre.','Use 0.5 litre.','en'],
    ['There are 2 and 3 items.','There are 5 items.','en'],
    ['The count is 1e3.','The count is 1000.','en'],
    ['في القاعة خمسة وعشرون مقعدا.','في القاعة 25 مقعدا.','ar'],
    ['في القاعة أحد عشر مقعدا.','في القاعة 11 مقعدا.','ar'],
    ['العدد ١٬٠٠.','العدد 100.','ar'],
  ]) {
    const report=authoredPair(reference,candidate,language),row=report.rows[0];
    assert.equal(row.numericReview.state,'abstain',`${reference} / ${candidate}`);
    assert.ok(codes(report).includes('numeric_comparison_abstain'));
    assert.equal(codes(report).includes('potential_numeric_change'),false);
    const finding=row.findings.find(f=>f.code==='numeric_comparison_abstain');
    assert.equal(finding.type,'evidence');
    assert.equal(finding.severity,'info');
    for(const span of finding.spans)assert.equal((span.role==='candidate'?candidate:reference).slice(span.start,span.end),span.text);
  }
});

test('numeric abstention alone prevents no_signal even with a declared verified fixture',()=>{
  const report=authoredPair('The inventory record contains 1,000 items for today.','The inventory record contains 1000 items for today.');
  assert.equal(report.rows[0].numericReview.state,'abstain');
  assert.equal(report.rows[0].comparisonStatus,'compared');
  assert.equal(report.rows[0].status,'abstain');
  assert.equal(report.summary.noSignalRows,0);
});

test('changed bounded quantity syntax with the same numeral bypasses unchanged-inventory shortcut and abstains',()=>{
  const report=authoredPair('The package must weigh less than 44 kg.','The package must weigh more than 44 kg.');
  assert.equal(report.rows[0].numericReview.state,'abstain');
  assert.ok(codes(report).includes('numeric_comparison_abstain'));
  assert.equal(codes(report).includes('potential_numeric_change'),false);
  assert.equal(report.rows[0].status,'abstain');
});

test('unsupported Unicode decimal alphabets abstain with exact original spans rather than vanish from numeric inventory',()=>{
  for(const [reference,candidate] of [['There are ３ items.','There are ４ items.'],['There are ３ items.','There are 3 items.'],['There are 𝟛 items.','There are 𝟜 items.']]) {
    const report=authoredPair(reference,candidate);
    assert.equal(report.rows[0].numericReview.state,'abstain');
    const finding=report.rows[0].findings.find(f=>f.code==='numeric_comparison_abstain');
    assert.ok(finding.evidence.reasons.some(r=>r.reason==='unicode_numeral_alphabet_not_supported'));
    for(const span of finding.spans)assert.equal((span.role==='candidate'?candidate:reference).slice(span.start,span.end),span.text);
  }
});

test('approximation before a universal English marker cannot become an equivalent scope claim',()=>{
  const report=authoredPair('All visitors sign the form.','Almost all visitors sign the form.');
  assert.equal(report.rows[0].qualifierReview.state,'abstain');
  assert.ok(codes(report).includes('qualifier_comparison_abstain'));
  assert.equal(codes(report).includes('potential_qualifier_change'),false);
  assert.equal(report.rows[0].status,'abstain');
});

test('quantity inventories do not claim entity binding or detect reordered assignments',()=>{
  const report=authoredPair('There are 3 chairs and 4 desks.','There are 4 chairs and 3 desks.');
  assert.equal(report.rows[0].numericReview.state,'equivalent');
  assert.equal(report.rows[0].numericReview.inventoryOnly,true);
  assert.match(report.rows[0].numericReview.method,/no meaning or entity binding/);
  assert.equal(codes(report).includes('potential_numeric_change'),false);
});

test('unchanged colon identifiers preserve existing negation evidence without numeric guesses',()=>{
  const report=authoredPair('The process 112:2 does not accept an unchecked item.','The process 112:2 does accept an unchecked item.');
  assert.equal(report.rows[0].numericReview.state,'unchanged');
  assert.ok(codes(report).includes('potential_negation_change'));
  assert.equal(codes(report).includes('numeric_comparison_abstain'),false);
});

test('letter-prefixed identifiers are outside numeric quantities and digit-prefixed ambiguous identifiers abstain',()=>{
  assert.equal(authoredPair('Code A12 is listed.','Code A13 is listed.').rows[0].numericReview.state,'none');
  const report=authoredPair('There are 12A seats.','There are 12 seats.');
  assert.equal(report.rows[0].numericReview.state,'abstain');
});

test('English qualifier families expose potential changes with exact spans and human review limits',()=>{
  for(const [reference,candidate] of [
    ['All visitors sign the form.','Some visitors sign the form.'],
    ['The worker must wear gloves.','The worker may wear gloves.'],
    ['Entry is permitted today.','Entry is forbidden today.'],
    ['Submit before lunch.','Submit after lunch.'],
  ]) {
    const report=authoredPair(reference,candidate);
    const finding=report.rows[0].findings.find(f=>f.code==='potential_qualifier_change');
    assert.ok(finding);
    assert.equal(finding.severity,'high');
    assert.equal(finding.evidence.inventoryOnly,true);
    for(const span of finding.spans)assert.equal((span.role==='candidate'?candidate:reference).slice(span.start,span.end),span.text);
    assert.equal(report.summary.qualifierChangeRows,1);
  }
});

test('bounded qualifier aliases suppress no existing negation or lexical evidence',()=>{
  for(const [reference,candidate] of [
    ['Every visitor signs.','Each visitor signs.'],
    ['The worker is required to wear gloves.','The worker must wear gloves.'],
    ['Entry is allowed.','Entry is permitted.'],
    ['Entry is not permitted.','Entry is forbidden.'],
  ]) {
    const report=authoredPair(reference,candidate);
    assert.equal(report.rows[0].qualifierReview.state,'equivalent');
    assert.equal(codes(report).includes('potential_qualifier_change'),false);
  }
  assert.ok(codes(authoredPair('Entry is not permitted.','Entry is forbidden.')).includes('potential_negation_change'));
});

test('ambiguous English marker scope, epistemic uses and idioms explicitly abstain',()=>{
  for(const [reference,candidate] of [
    ['Not all visitors sign.','Some visitors sign.'],
    ['The worker must have left.','The worker may have left.'],
    ['The meeting is in May.','The meeting is in June.'],
    ['Submit not before lunch.','Submit after lunch.'],
    ['The office may not open.','The office must open.'],
    ['Entry is not forbidden.','Entry is permitted.'],
    ['All but 2 visitors sign.','Some visitors sign.'],
    ['In all, 2 forms arrived.','In total, 2 forms arrived.'],
    ['Follow the day after day procedure.','Follow the daily procedure.'],
    ['Before lunch and after training, sign in.','After lunch and before training, sign in.'],
  ]) {
    const report=authoredPair(reference,candidate);
    assert.equal(report.rows[0].qualifierReview.state,'abstain',`${reference} / ${candidate}`);
    assert.ok(codes(report).includes('qualifier_comparison_abstain'));
    assert.equal(codes(report).includes('potential_qualifier_change'),false);
  }
});

test('Arabic marker families are explicitly unsupported rather than inferred from English',()=>{
  const report=authoredPair('يجب أن يقرأ الموظف الدليل.','يمكن أن يقرأ الموظف الدليل.','ar');
  assert.equal(report.rows[0].qualifierReview.state,'unsupported');
  assert.equal(codes(report).includes('potential_qualifier_change'),false);
});

test('new transparent layers preserve reference, language, duplicate and invalid-row gates',()=>{
  const unverified=authoredPair('The room has seven chairs.','The room has six chairs.','en',{verificationStatus:'unverified'});
  assert.ok(codes(unverified).includes('potential_numeric_change'));
  assert.equal(unverified.rows[0].comparisonStatus,'abstain');
  assert.equal(unverified.summary.comparedRows,0);
  const cross=auditBatch({rows:[{surah:112,ayah:1,translation:'The room has 6 chairs.'}],referenceRows:[{surah:112,ayah:1,translation:'في القاعة 7 مقاعد.'}],scope:{type:'provided'},metadata:{candidate:{language:'en'},reference:{language:'ar',verificationStatus:'verified'}}});
  assert.equal(cross.rows[0].numericReview.state,'not_compared');
  assert.equal(cross.rows[0].qualifierReview.state,'not_compared');
  const duplicate=auditBatch({rows:[{surah:112,ayah:1,translation:'All 6 visitors sign.'},{surah:112,ayah:1,translation:'Some 7 visitors sign.'}],referenceRows:[{surah:112,ayah:1,translation:'All 8 visitors sign.'}],scope:{type:'provided'},metadata});
  for(const row of duplicate.rows)assert.equal(row.numericReview.state,'not_compared');
  assert.equal(codes(duplicate).includes('potential_numeric_change'),false);
});

test('lexical differences stay reviewable, retain all spans and serialize with low priority',()=>{
  const reference='The technician shall start the equipment only after inspecting it.';
  const candidate='A staff member begins operating the machine when the check is complete.';
  const report=authoredPair(reference,candidate);
  const lexical=report.rows[0].findings.find(f=>f.code==='lexical_difference');
  assert.ok(lexical);
  assert.equal(lexical.severity,'low');
  assert.equal(report.rows[0].status,'needs_review');
  assert.equal(report.summary.lexicalDifferenceRows,1);
  assert.ok(JSON.parse(JSON.stringify(report)).findings.some(f=>f.id===lexical.id));
  for(const span of lexical.spans)assert.equal((span.role==='candidate'?candidate:reference).slice(span.start,span.end),span.text);
});

test('attached Arabic conjunctions preserve negation evidence and source offsets', () => {
  for (const marker of ['ولا','فلا','ولم','فلم','ولن','فلن','وليس','فليس']) {
    const translation = 'المكتبة ' + marker + ' تفتح اليوم';
    const report = auditBatch({rows:[{surah:112,ayah:1,translation}],referenceRows:[{surah:112,ayah:1,translation:'المكتبة تفتح اليوم'}],scope:selected,metadata:{candidate:{language:'ar'},reference:{language:'ar'}}});
    const finding = report.findings.find(x => x.code === 'potential_negation_change');
    assert.ok(finding, marker);
    const span = finding.spans.find(x => x.role === 'candidate');
    assert.equal(translation.slice(span.start,span.end), marker);
  }
});

test('every conjugation of ليس and its attached-conjunction forms is a negation marker (regression from the real-text stress test)', () => {
  for (const marker of ['لست','لسنا','لستم','لستما','لستن','ليسا','ليستا','ليسوا','لسن','ولسنا','فلسنا','وليسوا','فليسوا']) {
    const translation = 'نحن ' + marker + ' من أهل المدينة';
    const report = auditBatch({rows:[{surah:112,ayah:1,translation}],referenceRows:[{surah:112,ayah:1,translation:'نحن من أهل المدينة'}],scope:selected,metadata:{candidate:{language:'ar'},reference:{language:'ar'}}});
    const finding = report.findings.find(x => x.code === 'potential_negation_change');
    assert.ok(finding, marker);
    const span = finding.spans.find(x => x.role === 'candidate');
    assert.equal(translation.slice(span.start,span.end), marker);
  }
  const same = auditBatch({rows:[{surah:112,ayah:1,translation:'لسنا من أهل المدينة'}],referenceRows:[{surah:112,ayah:1,translation:'ليسوا من أهل المدينة'}],scope:selected,metadata:{candidate:{language:'ar'},reference:{language:'ar'}}});
  assert.equal(same.findings.some(x => x.code === 'potential_negation_change'), false, 'negation on both sides is not a change');
});

test('vocalized Arabic negation is detected with original evidence offsets', () => {
  const translation = 'المكتبة لَا تفتح اليوم';
  const report = auditBatch({ rows: [{surah:112, ayah:1, translation}], referenceRows: [{surah:112, ayah:1, translation:'المكتبة تفتح اليوم'}], scope:selected, metadata:{candidate:{language:'ar'},reference:{language:'ar'}} });
  const finding = report.findings.find((f) => f.code === 'potential_negation_change');
  assert.ok(finding);
  const span = finding.spans.find((s) => s.role === 'candidate');
  assert.equal(span.text, 'لَا');
  assert.equal(translation.slice(span.start, span.end), 'لَا');
});

test('Arabic vocalization and tatweel alone do not create lexical alerts', () => {
  const report = auditBatch({ rows: [{surah:112,ayah:1,translation:'المَكْتَبَة لَا تَفْتَحُ اليـوم'}], referenceRows:[{surah:112,ayah:1,translation:'المكتبة لا تفتح اليوم'}],scope:selected,metadata:{candidate:{language:'ar'},reference:{language:'ar'}} });
  assert.equal(codes(report).includes('lexical_difference'),false);
  assert.equal(codes(report).includes('potential_negation_change'),false);
});

test('non-Arabic accents are preserved by lexical token normalization', () => {
  const report = auditBatch({rows:[{surah:112,ayah:1,translation:'côté été résumé'}],referenceRows:[{surah:112,ayah:1,translation:'cote ete resume'}],scope:selected,metadata:{candidate:{language:'fr'},reference:{language:'fr'}}});
  assert.ok(codes(report).includes('lexical_difference'));
});

test('numeric index has exactly 114 chapters and 6,236 unique canonical IDs', () => {
  assert.equal(SURAH_AYAH_COUNTS.length, 114);
  assert.equal(TOTAL_AYAHS, 6236);
  const ids = expectedVerseIds();
  assert.equal(ids.length, 6236);
  assert.equal(new Set(ids).size, 6236);
  assert.equal(ids[0], '1:1');
  assert.equal(ids.at(-1), '114:6');
  assert.equal(verseOrdinal(1, 7), 7);
  assert.equal(verseOrdinal(2, 1), 8);
  assert.equal(verseOrdinal(114, 6), 6236);
  assert.equal(verseOrdinal(114, 7), null);
  assert.equal(isValidVerseId(9, 129), true);
  assert.equal(isValidVerseId(9, 130), false);
});

test('complete 6,236-row file really audits every row without inventing a semantic certification', () => {
  const rows = completeRows('full');
  const report = auditBatch({ rows, referenceRows: rows, metadata, scope: 'full' });
  assert.equal(report.summary.totalRows, 6236);
  assert.equal(report.summary.coveredVerses, 6236);
  assert.equal(report.summary.missingVerses, 0);
  assert.equal(report.summary.structuralComplete, true);
  assert.equal(report.summary.comparedRows, 6236);
  assert.equal(report.summary.noSignalRows, 6236);
  assert.equal(report.summary.certification, 'none');
  assert.equal(report.provenance.analysis.trainedModelExecuted, false);
  assert.match(report.provenance.reference.authority, /not independently authenticated/);
});

test('complete structurally valid file without references abstains on every row', () => {
  const rows = completeRows();
  const report = auditBatch({ rows, scope: selected });
  assert.equal(report.summary.structuralComplete, true);
  assert.equal(report.summary.referenceMissingRows, 4);
  assert.equal(report.summary.abstainRows, 4);
  assert.equal(report.summary.noSignalRows, 0);
  assert.ok(report.rows.every((row) => row.comparisonStatus === 'abstain'));
  assert.ok(report.rows.every((row) => row.comparisonReason === 'missing_reference'));
});

test('selected scope normalizes Arabic/Persian digits, sorts, and deduplicates chapter choices', () => {
  assert.deepEqual(normalizeScope({ type: 'selected', surahs: ['۱۱۴', '١١٢', 114] }), {
    type: 'selected', surahs: [112, 114], expectedVerses: 10,
  });
  assert.equal(strictInteger(' ٢٨٦ '), 286);
  assert.equal(strictInteger('۲۸۶'), 286);
  for (const invalid of ['2.5', '2e2', '', 'two', Infinity, 2.5, false, {}, null]) {
    assert.equal(strictInteger(invalid), null);
  }
  assert.throws(() => normalizeScope({ type: 'selected', surahs: [] }), /at least one/);
  assert.throws(() => normalizeScope({ type: 'selected', surahs: [115] }), /1 to 114/);
  assert.throws(() => normalizeScope({ type: 'unknown' }), /Unknown/);
});

test('missing IDs are grouped into exact consecutive ranges without fabricating source rows', () => {
  const rows = completeRows({ type: 'selected', surahs: [1] }).filter((row) => ![2, 3, 6].includes(row.ayah));
  const report = auditBatch({ rows, scope: { type: 'selected', surahs: [1] } });
  assert.equal(report.summary.missingVerses, 3);
  const missing = report.findings.find((finding) => finding.code === 'missing_verses');
  assert.deepEqual(missing.verseIds, ['1:2', '1:3', '1:6']);
  assert.deepEqual(missing.evidence.ranges, [{ start: 2, end: 3 }, { start: 6, end: 6 }]);
  assert.deepEqual(missing.rowNumbers, []);
  assert.equal(report.summary.coveragePercent, 57.14);
  assert.equal(report.rows.length, 4);
});

test('duplicate IDs flag every copy, do not inflate coverage, and prevent arbitrary comparison', () => {
  const rows = completeRows();
  rows.splice(1, 0, { ...rows[0], translation: 'Conflicting synthetic duplicate', rowNumber: 20 });
  const report = auditBatch({ rows, referenceRows: completeRows(), scope: selected, metadata });
  assert.equal(report.summary.coveredVerses, 4);
  assert.equal(report.summary.duplicateRows, 1);
  assert.equal(report.summary.duplicateVerseIds, 1);
  const duplicate = report.findings.find((finding) => finding.code === 'duplicate_verse');
  assert.deepEqual(duplicate.rowNumbers, [2, 20]);
  assert.equal(duplicate.evidence.conflictingText, true);
  assert.equal(report.summary.comparedRows, 3);
  assert.ok(report.rows.slice(0, 2).every((row) => row.status === 'needs_review' && row.comparisonReason === 'duplicate_candidate'));
});

test('sorting faults preserve original source row numbers and adjacent evidence', () => {
  const rows = completeRows();
  [rows[1], rows[2]] = [rows[2], rows[1]];
  const report = auditBatch({ rows, scope: selected });
  const disorder = report.findings.find((finding) => finding.code === 'out_of_order');
  assert.equal(report.summary.outOfOrderRows, 1);
  assert.deepEqual(disorder.rowNumbers, [3]);
  assert.equal(disorder.evidence.previousVerseId, '112:3');
  assert.equal(disorder.evidence.previousRowNumber, 4);
  assert.equal(report.summary.structuralComplete, false);
});

test('verse bounds reject zero, negative, fractional, chapter 115, and unnumbered basmala IDs', () => {
  const rows = [
    { surah: 0, ayah: 1 }, { surah: 112, ayah: 0 },
    { surah: 112, ayah: -1 }, { surah: 112, ayah: 1.5 },
    { surah: 115, ayah: 1 }, { surah: 112, ayah: 5 },
  ].map((row) => ({ ...row, translation: 'Synthetic placeholder' }));
  const report = auditBatch({ rows, scope: selected });
  assert.equal(report.summary.invalidRows, 6);
  assert.equal(report.summary.coveredVerses, 0);
  assert.equal(report.summary.missingVerses, 4);
  assert.ok(report.rows.every((row) => row.status === 'needs_review' && row.verseId === null));
});

test('Arabic numerals in candidate IDs are normalized without losing the original identifiers', () => {
  const report = auditBatch({ rows: [{ surah: '١١٢', ayah: '۲', translation: 'Synthetic placeholder' }], scope: selected });
  assert.equal(report.rows[0].verseId, '112:2');
  assert.equal(report.rows[0].rawSurah, '١١٢');
  assert.equal(report.rows[0].rawAyah, '۲');
  assert.equal(report.summary.invalidRows, 0);
});

test('merged ranges receive a dedicated review signal and do not falsely cover individual verses', () => {
  const report = auditBatch({ rows: [{ surah: 112, ayah: '٢–٣', translation: 'Synthetic combined passage' }], scope: selected });
  assert.equal(report.summary.suspectedMergedRows, 1);
  assert.equal(report.summary.coveredVerses, 0);
  const range = report.findings.find((finding) => finding.code === 'suspected_merged_range');
  assert.deepEqual(range.evidence.range, { start: 2, end: 3 });
  assert.equal(range.evidence.validRange, true);
  assert.equal(range.spans[0].text, '٢–٣');
});

test('empty translations including format-control-only strings are reviewable structural defects', () => {
  const rows = completeRows();
  rows[0].translation = ' \t\n ';
  rows[1].translation = '\u200b\u200f';
  rows[2].translation = 123;
  const report = auditBatch({ rows, scope: selected });
  assert.equal(report.summary.emptyRows, 3);
  assert.ok(codes(report).includes('invalid_translation_type'));
  assert.equal(report.summary.coveredVerses, 4, 'ID coverage is distinct from usable text completeness');
  assert.equal(report.summary.structuralComplete, false);
});

test('valid rows outside selected scope are visible but never increase expected-scope coverage', () => {
  const rows = [...completeRows(), { surah: 113, ayah: 1, translation: 'Synthetic outside scope' }];
  const report = auditBatch({ rows, scope: selected });
  assert.equal(report.summary.coveredVerses, 4);
  assert.equal(report.summary.outOfScopeRows, 1);
  assert.equal(report.rows.at(-1).comparisonReason, 'out_of_scope');
});

test('partial reference coverage leaves unmatched rows in explicit abstention', () => {
  const rows = completeRows();
  const report = auditBatch({ rows, referenceRows: [rows[0]], scope: selected, metadata });
  assert.equal(report.summary.comparedRows, 1);
  assert.equal(report.summary.referenceMissingRows, 3);
  assert.equal(report.summary.abstainRows, 3);
  assert.equal(report.rows[0].status, 'no_signal');
  assert.equal(report.rows[1].reference, null);
});

test('duplicate reference IDs abstain even when both references have identical text', () => {
  const rows = completeRows();
  const report = auditBatch({ rows, referenceRows: [...rows, { ...rows[0], rowNumber: 30 }], scope: selected, metadata });
  assert.equal(report.summary.referenceAmbiguousRows, 1);
  assert.equal(report.rows[0].status, 'abstain');
  assert.equal(report.rows[0].reference, null);
  assert.ok(codes(report).includes('reference_integrity'));
  const ambiguous = report.findings.find((finding) => finding.code === 'ambiguous_reference');
  assert.deepEqual(ambiguous.evidence.referenceRowNumbers, [2, 30]);
});

test('empty and invalid reference rows are reported and do not authorize comparisons', () => {
  const rows = completeRows();
  const references = [{ ...rows[0], translation: ' ' }, { ...rows[1], surah: 115 }];
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata });
  assert.equal(report.summary.referenceIntegrity.emptyRows, 1);
  assert.equal(report.summary.referenceIntegrity.invalidRows, 1);
  assert.equal(report.summary.comparedRows, 0);
  assert.equal(report.rows[0].comparisonReason, 'empty_reference');
});

test('negation removal produces a potential review signal with exact reference span, not a verdict', () => {
  const references = completeRows();
  const rows = completeRows();
  rows[0].translation = rows[0].translation.replace('does not accept', 'does accept');
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata });
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_change');
  assert.ok(finding);
  assert.equal(finding.evidence.potentialOnly, true);
  assert.equal(finding.evidence.humanReviewRequired, true);
  assert.deepEqual(finding.evidence.referenceNegations, ['not']);
  assert.equal(finding.spans[0].role, 'reference');
  assert.equal(references[0].translation.slice(finding.spans[0].start, finding.spans[0].end), 'not');
  assert.equal(report.rows[0].status, 'needs_review');
});

test('negation addition handles curly-apostrophe contractions and retains candidate offsets', () => {
  const references = completeRows();
  references[0].translation = 'Synthetic sample process allows any unchecked action.';
  const rows = completeRows();
  rows[0].translation = 'Synthetic sample process doesn’t allow any unchecked action.';
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata });
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_change');
  assert.deepEqual(finding.evidence.candidateNegations, ['doesn’t']);
  const span = finding.spans.find((entry) => entry.role === 'candidate');
  assert.equal(rows[0].translation.slice(span.start, span.end), 'doesn’t');
});

test('legitimate-looking paraphrase is clearly a lexical review signal rather than religious error', () => {
  const references = completeRows();
  const rows = completeRows();
  rows[0].translation = 'Synthetic paraphrase: unverified records must undergo independent validation.';
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata });
  const finding = report.findings.find((entry) => entry.code === 'lexical_difference');
  assert.ok(finding);
  assert.equal(finding.evidence.potentialOnly, true);
  assert.match(finding.reason, /not semantic equivalence/);
  assert.equal(finding.evidence.referenceProvenance.verificationStatus, 'verified');
  assert.ok(finding.spans.every((span) => (span.role === 'candidate' ? rows[0].translation : references[0].translation).slice(span.start, span.end) === span.text));
});

test('case and punctuation changes do not produce fabricated lexical differences', () => {
  const rows = completeRows();
  const references = completeRows();
  rows[0].translation = references[0].translation.toUpperCase().replace('.', '!');
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata });
  assert.equal(report.summary.comparisonFindingCount, 0);
  assert.equal(report.rows[0].status, 'no_signal');
});

test('declared cross-language references abstain instead of treating low lexical overlap as mistranslation', () => {
  const rows = completeRows();
  const report = auditBatch({ rows, referenceRows: rows, scope: selected, metadata: { ...metadata, reference: { ...metadata.reference, language: 'ar' } } });
  assert.equal(report.summary.comparedRows, 0);
  assert.equal(report.summary.abstainRows, 4);
  assert.equal(report.summary.comparisonFindingCount, 0);
  assert.equal(report.rows[0].comparisonReason, 'language_mismatch');
});

test('unsupported languages never run English negation heuristics', () => {
  const rows = completeRows();
  const references = completeRows();
  rows[0].translation = 'no synthetic reference words remain';
  references[0].translation = 'synthetic reference words remain';
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata: { ...metadata, candidate: { language: 'es' }, reference: { language: 'es' } } });
  assert.ok(!codes(report).includes('potential_negation_change'));
});

test('user verification provenance is preserved but never impersonates independent authentication', () => {
  const rows = completeRows();
  const report = auditBatch({ rows, referenceRows: rows, scope: selected, metadata: { ...metadata, reference: { title: 'User file', edition: 'edition-2', url: 'https://example.org/reference', verificationStatus: 'verified', licenseNote: 'User statement' } } });
  assert.equal(report.rows[0].reference.provenance.edition, 'edition-2');
  assert.equal(report.provenance.reference.verificationStatus, 'verified');
  assert.match(report.provenance.reference.authority, /not independently authenticated/);
  assert.ok(!codes(report).includes('unverified_reference'));
});

test('unverified identical references can never yield no_signal or count as verified comparisons', () => {
  const rows = completeRows();
  const report = auditBatch({ rows, referenceRows: rows, scope: selected, metadata: { ...metadata, reference: { ...metadata.reference, verificationStatus: 'unverified' } } });
  assert.equal(report.summary.comparedRows, 0);
  assert.equal(report.summary.lexicalComparedRows, 4);
  assert.equal(report.summary.unverifiedReferenceRows, 4);
  assert.equal(report.summary.abstainRows, 4);
  assert.equal(report.summary.noSignalRows, 0);
  assert.ok(report.rows.every((row) => row.comparisonStatus === 'abstain' && row.comparisonReason === 'unverified_reference'));
});

test('unverified references can expose literal differences while comparison remains abstained', () => {
  const references = completeRows();
  const rows = completeRows();
  rows[0].translation = rows[0].translation.replace('does not accept', 'does accept');
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata: { ...metadata, reference: { ...metadata.reference, verificationStatus: 'unverified' } } });
  assert.equal(report.rows[0].status, 'needs_review');
  assert.equal(report.rows[0].comparisonStatus, 'abstain');
  assert.equal(report.rows[0].comparisonReason, 'unverified_reference');
  const finding = report.findings.find((entry) => entry.code === 'potential_negation_change');
  assert.equal(finding.evidence.referenceProvenance.verificationStatus, 'unverified');
  assert.equal(report.summary.comparedRows, 0);
});

test('retrieved API provenance preserves global and per-row hashes, URLs, versions, and dates', () => {
  const rows = completeRows();
  const references = rows.map((row) => ({ ...row, sourceURL: `https://quranpedia.net/api/verse/${row.surah}/${row.ayah}`, retrievedAt: '2026-10-03T12:00:00.000Z', rawSha256: 'raw-row-hash', normalizedSha256: 'normalized-row-hash' }));
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata: { ...metadata, reference: { ...metadata.reference, sourceKind: 'quranpedia-api', retrievedAt: '2026-10-03T11:59:00.000Z', rawSha256: 'raw-file-hash', normalizedSha256: 'normalized-file-hash', version: 'recorded-api-version' } } });
  assert.equal(report.provenance.reference.rawSha256, 'raw-file-hash');
  assert.equal(report.provenance.reference.normalizedSha256, 'normalized-file-hash');
  assert.equal(report.provenance.reference.version, 'recorded-api-version');
  assert.match(report.provenance.reference.authority, /Retrieved Quranpedia API/);
  assert.match(report.provenance.reference.authority, /not scholarly certification/);
  assert.equal(report.rows[0].reference.rawSha256, 'raw-row-hash');
  assert.equal(report.rows[0].reference.provenance.rawSha256, 'raw-row-hash');
  assert.equal(report.rows[0].reference.normalizedSha256, 'normalized-row-hash');
  assert.equal(report.rows[0].reference.sourceURL, 'https://quranpedia.net/api/verse/112/1');
  assert.equal(report.rows[0].reference.retrievedAt, '2026-10-03T12:00:00.000Z');
});

test('per-row unverified source cannot inherit a verified global declaration', () => {
  const rows = completeRows();
  const references = rows.map((row, index) => ({ ...row, ...(index === 0 ? { verificationStatus: 'unverified' } : {}) }));
  const report = auditBatch({ rows, referenceRows: references, scope: selected, metadata });
  assert.equal(report.rows[0].comparisonStatus, 'abstain');
  assert.equal(report.rows[0].status, 'abstain');
  assert.equal(report.summary.comparedRows, 3);
  assert.equal(report.summary.unverifiedReferenceRows, 1);
  assert.ok(codes(report).includes('unverified_reference'));
});

test('report serializes, has unique finding IDs, and never mutates the supplied source rows', () => {
  const rows = completeRows();
  const original = JSON.stringify(rows);
  const report = auditBatch({ rows, referenceRows: rows, scope: selected, metadata });
  assert.equal(JSON.stringify(rows), original);
  const restored = JSON.parse(JSON.stringify(report));
  assert.equal(restored.schemaVersion, 'mihakk-batch/1');
  assert.equal(new Set(restored.findings.map((finding) => finding.id)).size, restored.findings.length);
  assert.equal(new Set(restored.rows.map((row) => row.key)).size, rows.length);
});

test('synthetic demonstration exercises real structural and lexical defects without Quran text', () => {
  const rows = generateDemoRows();
  const references = generateDemoReferenceRows();
  assert.equal(references.length, 22);
  assert.ok(rows.every((row) => row.translation === '' || row.translation.startsWith('SYNTHETIC TRAINING TEXT')));
  const report = auditBatch({ rows, referenceRows: references, scope: { type: 'selected', surahs: [1, 112, 113, 114] }, metadata });
  for (const code of ['missing_verses', 'duplicate_verse', 'empty_translation', 'invalid_verse_id', 'out_of_order', 'suspected_merged_range', 'potential_negation_change']) {
    assert.ok(codes(report).includes(code), `demo must exercise ${code}`);
  }
  assert.equal(report.summary.expectedVerses, 22);
  assert.equal(report.summary.missingVerses, 1);
  assert.equal(report.provenance.candidate.synthetic, true);
});

test('invalid external input fails explicitly and empty files remain incomplete', () => {
  assert.throws(() => auditBatch(), /rows must be an array/);
  assert.throws(() => auditBatch({ rows: [], referenceRows: {} }), /referenceRows/);
  assert.throws(() => auditBatch({ rows: [], metadata: null }), /metadata/);
  const report = auditBatch({ rows: [], scope: selected });
  assert.equal(report.summary.missingVerses, 4);
  assert.equal(report.summary.coveragePercent, 0);
  assert.equal(report.summary.structuralComplete, false);
});

test('provided scope audits partial declared rows without fabricating missing-surah findings', () => {
  const rows = [
    { surah: 1, ayah: 2, translation: 'Synthetic partial row one' },
    { surah: 1, ayah: 6, translation: 'Synthetic partial row two' },
    { surah: 112, ayah: 4, translation: 'Synthetic partial row three' },
  ];
  const report = auditBatch({ rows, scope: { type: 'provided' } });
  assert.deepEqual(report.scope, { type: 'provided', surahs: [1, 112], expectedVerses: 3 });
  assert.equal(report.summary.coveredVerses, 3);
  assert.equal(report.summary.missingVerses, 0);
  assert.equal(report.summary.coveragePercent, 100);
  assert.equal(report.coverageIsDeclaredRows, true);
  assert.equal(report.completenessAssertion, 'provided-rows-only');
  assert.equal(report.summary.completenessAssertion, 'provided-rows-only');
  assert.match(report.scopeDefinition, /no complete-surah or full-Quran assertion/);
  assert.equal(report.summary.structuralComplete, true);
  assert.equal(report.summary.abstainRows, 3);
  assert.ok(!codes(report).includes('missing_verses'));
});

test('provided scope handles empty input with zero expected IDs, zero coverage, and no completeness claim', () => {
  const report = auditBatch({ rows: [], scope: { type: 'provided' } });
  assert.equal(report.scope.expectedVerses, 0);
  assert.equal(report.summary.coveragePercent, 0);
  assert.equal(report.summary.structuralComplete, false);
  assert.equal(report.summary.missingVerses, 0);
  assert.deepEqual(report.scope.surahs, []);
  assert.equal(report.completenessAssertion, 'provided-rows-only');
});

test('provided scope excludes invalid and merged IDs from its declaration without hiding their defects', () => {
  const rows = [
    { surah: 115, ayah: 1, translation: 'Synthetic invalid row' },
    { surah: 112, ayah: '1-3', translation: 'Synthetic merged row' },
  ];
  const report = auditBatch({ rows, scope: { type: 'provided' } });
  assert.equal(report.scope.expectedVerses, 0);
  assert.equal(report.summary.invalidRows, 2);
  assert.equal(report.summary.suspectedMergedRows, 1);
  assert.equal(report.summary.coveragePercent, 0);
  assert.equal(report.summary.structuralComplete, false);
  assert.equal(report.summary.needsReviewRows, 2);
});

test('provided duplicates count one expected ID but flag every copy', () => {
  const rows = [
    { surah: 112, ayah: 1, translation: 'Synthetic one' },
    { surah: 112, ayah: 1, translation: 'Synthetic conflicting duplicate' },
  ];
  const report = auditBatch({ rows, scope: { type: 'provided' } });
  assert.equal(report.scope.expectedVerses, 1);
  assert.equal(report.summary.coveredVerses, 1);
  assert.equal(report.summary.duplicateRows, 1);
  assert.equal(report.summary.structuralComplete, false);
  assert.equal(report.summary.needsReviewRows, 2);
});

test('provided mode does not change explicit full or selected gap detection', () => {
  const rows = [{ surah: 112, ayah: 1, translation: 'Synthetic single row' }];
  const provided = auditBatch({ rows, scope: { type: 'provided' } });
  const partial = auditBatch({ rows, scope: selected });
  const full = auditBatch({ rows, scope: 'full' });
  assert.equal(provided.summary.missingVerses, 0);
  assert.equal(partial.summary.missingVerses, 3);
  assert.equal(full.summary.missingVerses, 6235);
  assert.equal(partial.coverageIsDeclaredRows, false);
  assert.equal(full.completenessAssertion, 'full-index');
});
