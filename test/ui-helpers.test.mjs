import test from 'node:test';
import assert from 'node:assert/strict';
import {textDirection, csvCell, decisionFingerprintInput, arabicCount, humanRecordKey, revisionRecordLabel, sortFindingsByPriority, reviewQueueBreakdown} from '../public/modules/ui-helpers.mjs';

test('queue breakdown retains low wording signals and separates informational evidence', () => {
  const findings = [{code:'lexical_difference',severity:'low'},{code:'potential_numeric_change',severity:'high'},{code:'numeric_comparison_abstain',severity:'info'},{code:'out_of_order',severity:'medium'}];
  const original = JSON.stringify(findings);
  assert.deepEqual(reviewQueueBreakdown(findings), {total:4,priority:2,wording:1,low:1,information:1});
  assert.equal(JSON.stringify(findings),original);
  assert.deepEqual(reviewQueueBreakdown([]), {total:0,priority:0,wording:0,low:0,information:0});
});

test('review and print priorities preserve stable evidence order without changing the report', () => {
  const evidence=[{id:'m1',severity:'medium'},{id:'h1',severity:'high'},{id:'i1',severity:'info'},{id:'c1',severity:'critical'},{id:'h2',severity:'high'},{id:'l1',severity:'low'},{id:'m2',severity:'medium'}];
  const original=JSON.stringify(evidence);
  assert.deepEqual(sortFindingsByPriority(evidence).map(x=>x.id),['c1','h1','h2','m1','m2','l1','i1']);
  assert.equal(JSON.stringify(evidence),original);
});

test('text direction follows the declared language instead of forcing English', () => {
  assert.deepEqual(textDirection('ar'), {lang:'ar', dir:'rtl'});
  assert.deepEqual(textDirection('ur'), {lang:'ur', dir:'rtl'});
  assert.deepEqual(textDirection('en-US'), {lang:'en', dir:'ltr'});
  assert.deepEqual(textDirection('fr'), {lang:'fr', dir:'ltr'});
  assert.deepEqual(textDirection('unknown'), {lang:'', dir:'auto'});
  assert.deepEqual(textDirection(undefined), {lang:'', dir:'auto'});
});

test('CSV cells neutralise ASCII and full-width formula prefixes', () => {
  for (const value of ['=1+1', '+cmd', '-2+3', '@me', ' =x', '﻿=x', '＝SUM(1)', '＋x', '－x', '＠x', '−x', '　=x', '\tx', '\rx'])
    assert.ok(csvCell(value).startsWith(`"'`), JSON.stringify(value));
  assert.equal(csvCell('plain text'), '"plain text"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '""');
});

test('decision fingerprints ignore rerun timestamps but keep evidence content', () => {
  const finding = (inferredAt, retrievedAt, contradiction = 0.8) => ({code:'context_contradiction', type:'comparison', severity:'high', verseIds:['2:1'], rowNumbers:[3], spans:[], evidence:{scores:{contradiction, inferredAt}, referenceProvenance:{retrievedAt, bookId:1947}}});
  assert.equal(decisionFingerprintInput(finding('2026-10-04T05:00:00Z','2026-10-04T05:00:00Z')), decisionFingerprintInput(finding('2026-10-05T09:00:00Z','2026-10-05T09:00:00Z')));
  assert.notEqual(decisionFingerprintInput(finding('t','t',0.8)), decisionFingerprintInput(finding('t','t',0.9)));
});

test('Arabic counts select singular, dual, few and many forms',()=>{
 const forms={one:'حالة',two:'حالتان',few:'حالات',other:'حالة'};
 assert.match(arabicCount(1,forms),/حالة$/);assert.match(arabicCount(2,forms),/حالتان$/);assert.match(arabicCount(5,forms),/حالات$/);assert.match(arabicCount(12,forms),/حالة$/);
});
test('revision keys expose one-based input positions without changing valid verse IDs',()=>{
 assert.equal(humanRecordKey('candidate:0'),'سجل غير صالح رقم 1 في النسخة الحالية');assert.equal(humanRecordKey('baseline:9'),'سجل غير صالح رقم 10 في النسخة السابقة');assert.equal(humanRecordKey('112:2'),'112:2');
});

test('revision records are labelled by verse id or the real spreadsheet row, never the internal input index', () => {
  assert.equal(revisionRecordLabel({id:'2:3',recordKey:'2:3',candidateRows:[11],baselineRows:[10]}),'2:3');
  assert.equal(revisionRecordLabel({id:null,recordKey:'candidate:6237',candidateRows:[6239],baselineRows:[]}),'صف 6239 في النسخة الحالية');
  assert.equal(revisionRecordLabel({id:null,recordKey:'baseline:6236',candidateRows:[],baselineRows:[6238]}),'صف 6238 في النسخة السابقة');
  assert.equal(revisionRecordLabel({id:null,recordKey:'candidate:4',candidateRows:[null]}),'سجل غير صالح رقم 5 في النسخة الحالية');
});
