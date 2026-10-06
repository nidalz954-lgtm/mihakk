import test from 'node:test';import assert from 'node:assert/strict';import {compareRevisions as compareAsync,bindDecision,reconcileDecisions,exportReport} from '../public/modules/revision-review.mjs';
const row=(ayah,translation,rowNumber=ayah+1)=>({surah:1,ayah,translation,rowNumber});
const meta={identity:'Synthetic museum draft',edition:'local-test',language:'en',rightsNote:'Nonreligious invented text'};
const input=(candidate,baseline)=>({schemaVersion:1,candidate,baseline,scope:[{surah:1,fromAyah:1,toAyah:10}],candidateMeta:{...meta},baselineMeta:{...meta},sameTranslationAssertion:true,options:{methodVersion:'revision-v1',normalization:'raw-only'}});
for(const [name,a,b] of [['punctuation','Open?','Open.'],['case','Archive','archive'],['vocalization','بَاب','باب'],['NFC','é','e\u0301'],['nested brackets','The [old [blue]] desk','The [new [blue]] desk'],['malformed brackets','Desk [blue','Desk blue'],['hidden control','blue\u200F desk','blue desk'],['mixed edit','Green chair!','Blue chair?']])test(name+' remains raw text_change with reconstructable span',async()=>{const r=(await compareAsync(input([row(1,a)],[row(1,b)]))).records[0];assert.equal(r.state,'text_change');const d=r.rawDiff;assert.equal(b.slice(0,d.oldSpan[0])+d.newText+b.slice(d.oldSpan[1]),a);assert.equal(a.slice(...d.newSpan),d.newText);if(name==='NFC')assert.equal(r.flags.unicodeNormalizationEquivalent,true);if(name==='hidden control')assert.equal(r.flags.hiddenControlChanged,true);});
test('identical and both-side ledger exact coordinates',async()=>{const r=await compareAsync(input([row(1,'Archive\nblue shelf',670)],[row(1,'Archive\nblue shelf',55)]));assert.equal(r.records[0].state,'identical_raw');assert.deepEqual(r.ledger.candidate,[{inputIndex:0,rowNumber:670,state:'identical_raw',recordKey:'1:1'}]);});
for(const side of ['candidate','baseline'])for(const same of [true,false])test(side+' duplicate '+same,async()=>{const i=input([row(1,'museum')],[row(1,'museum')]);i[side].push(row(1,same?'museum':'different',99));const r=await compareAsync(i);assert.equal(r.records.length,1);assert.equal(r.records[0].state,'ambiguous_duplicate');assert.equal(r.records[0][side+'Rows'].length,2);assert.equal(r.ledger[side].length,2);});
test('union add/remove, scope and invalid rows never dropped',async()=>{const i=input([row(1,'new'),row(3,''),row(4,17),row(11,'outside'),{surah:115,ayah:1,translation:'invalid',rowNumber:77},row(5,'bad-coordinate',0)],[row(2,'old'),row(3,'valid'),row(4,'valid')]);const r=await compareAsync(i);assert.equal(r.ledger.candidate.length,6);assert.equal(r.ledger.baseline.length,3);assert.equal(r.counts.scopedUnionIds,5);assert.equal(r.records.find(x=>x.id==='1:1').state,'added_id');assert.equal(r.records.find(x=>x.id==='1:2').state,'removed_id');assert.equal(r.ledger.candidate[3].state,'out_of_scope');assert.equal(r.counts.states.invalid_row,4);});
test('decision persistence and correction lifecycle',async()=>{const i=input([row(1,'Archive is closed.')],[row(1,'Archive is open.')]);const r=await compareAsync(i),a=r.records[0];const d=bindDecision(a,{evidenceFingerprint:a.evidenceFingerprint,contextFingerprint:a.contextFingerprint,decision:'needs_revision',reason:'Check draft edit'});assert.equal(reconcileDecisions([d],await compareAsync(i))[0].status,'active');i.candidate[0].translation='Archive is open.';const fresh=await compareAsync(i);assert.equal(fresh.records[0].state,'identical_raw');assert.equal(reconcileDecisions([d],fresh)[0].status,'stale');assert.equal(bindDecision(fresh.records[0],d).error.code,'INVALID_DECISION');});
for(const field of ['metadata','scope','row','options','otherRow'])test('decision invalidation on '+field,async()=>{const i=input([row(1,'a'),row(2,'b')],[row(1,'a'),row(2,'b')]);const r=await compareAsync(i),rec=r.records[0],d=bindDecision(rec,{...rec,decision:'reviewed',reason:'Synthetic check'});if(field==='metadata')i.baselineMeta.edition='new';if(field==='scope')i.scope[0].toAyah=9;if(field==='row')i.baseline[0].rowNumber=99;if(field==='otherRow')i.candidate[1].translation='changed';if(field==='options'){i.options.extra=true;assert.equal((await compareAsync(i)).error.code,'INVALID_OPTIONS');return;}assert.equal(reconcileDecisions([d],await compareAsync(i))[0].status,'stale');});
test('safe baseline redaction handles rawDiff, duplicates, invalid rows',async()=>{const i=input([row(1,'candidate'),row(2,'candidate'),row(3,'candidate')],[row(1,'SECRET_A'),row(2,'SECRET_B'),row(2,'SECRET_C'),row(3,'SECRET_D',0),{surah:999,ayah:1,rowNumber:12,translation:'SECRET_E'}]);const r=await compareAsync(i),safe=JSON.stringify(exportReport(r));for(const s of ['SECRET_A','SECRET_B','SECRET_C','SECRET_D','SECRET_E'])assert.equal(safe.includes(s),false);assert.equal(JSON.stringify(exportReport(r,{includeReferenceText:true})).includes('SECRET_C'),true);assert.equal(JSON.stringify(r).includes('SECRET_C'),true);});
test('deterministic reruns and shuffled coordinates',async()=>{const i=input([row(2,'b',30),row(1,'a',22)],[row(1,'a',3),row(2,'b',4)]);const r=await compareAsync(i);assert.equal(JSON.stringify(r),JSON.stringify(await compareAsync(i)));const j=structuredClone(i);j.candidate.reverse();const s=await compareAsync(j);assert.deepEqual(s.records.map(x=>x.candidateRows),r.records.map(x=>x.candidateRows));assert.notEqual(s.contextFingerprint,r.contextFingerprint);});
for(const [name,mutate,code] of [['declaration',i=>i.sameTranslationAssertion=false,'MODE_REQUIRES_DECLARATION'],['scope overlap',i=>i.scope.push({surah:1,fromAyah:2,toAyah:3}),'INVALID_SCOPE'],['unknown option',i=>i.options.magic=true,'INVALID_OPTIONS'],['huge text',i=>i.candidate[0].translation='x'.repeat(20001),'TEXT_LIMIT'],['huge rows',i=>i.candidate=Array(20001).fill(row(1,'x')),'ROW_LIMIT'],['unknown key',i=>i.extra=1,'INVALID_INPUT'],['bad meta',i=>delete i.baselineMeta.identity,'INVALID_METADATA'],['big JSON',i=>i.candidateMeta.rightsNote='x'.repeat(10485761),'INPUT_LIMIT']])test('reject '+name,async()=>{const i=input([row(1,'x')],[row(1,'x')]);mutate(i);assert.equal((await compareAsync(i)).error.code,code);});
test('report snapshot survives caller mutation and truthy export cannot disclose',async()=>{const i=input([row(1,'candidate')],[row(1,'SECRET')]);const r=await compareAsync(i);i.baseline[0].translation='MUTATED';assert.equal(r.records[0].baselineEvidence[0].translation,'SECRET');assert.equal(JSON.stringify(exportReport(r,{includeReferenceText:'true'})).includes('SECRET'),false);});
test('independent attack regression: malformed decision entries return structured error',async()=>{const r=await compareAsync(input([row(1,'a')],[row(1,'b')]));for(const d of [null,42,'string',[],{}, {recordKey:'1:1'}])assert.equal(reconcileDecisions([d],r).error.code,'INVALID_RECONCILIATION');});
test('independent redaction regression: malformed raw coordinates never leak into exported rows or ledger',async()=>{const i=input([row(1,'candidate')],[row(1,'baseline')]);i.baseline[0].rowNumber={secret:'BASELINE_COORDINATE_SECRET'};i.baseline.push({surah:999,ayah:1,translation:'SECRET_INVALID',rowNumber:['BASELINE_ARRAY_SECRET']});const r=await compareAsync(i);assert.equal(r.records.find(q=>q.id==='1:1').state,'invalid_row');assert.equal(r.ledger.baseline[0].rowNumber,null);assert.deepEqual(r.records.find(q=>q.id==='1:1').baselineRows,[null]);const safe=JSON.stringify(exportReport(r));for(const secret of ['BASELINE_COORDINATE_SECRET','BASELINE_ARRAY_SECRET','SECRET_INVALID'])assert.equal(safe.includes(secret),false);assert.equal(JSON.stringify(exportReport(r,{includeReferenceText:true})).includes('BASELINE_COORDINATE_SECRET'),true);});

test('production raw comparison preserves whitespace and UTF-16 spans', async () => {
  for (const [before, after] of [['Museum', ' Museum '], ['Museum\n', 'Museum\r\n'], ['Desk 😀 blue', 'Desk 😁 blue']]) {
    const report = await compareAsync(input([row(1, after)], [row(1, before)]));
    const record = report.records[0];
    assert.equal(record.state, 'text_change');
    assert.equal(record.candidateText, after);
    assert.equal(record.baselineText, before);
    assert.equal(before.slice(0, record.rawDiff.oldSpan[0]) + record.rawDiff.newText + before.slice(record.rawDiff.oldSpan[1]), after);
  }
});

test('production numeric-string and Arabic-digit IDs group without changing evidence', async () => {
  const raw = {surah: '١', ayah: '۲', rowNumber: '٣', translation: 'Museum opens.'};
  const report = await compareAsync(input([raw], [row(2, 'Museum opens.', 30)]));
  assert.equal(report.records[0].recordKey, '1:2');
  assert.equal(report.records[0].state, 'identical_raw');
  assert.deepEqual(report.records[0].candidateEvidence[0], raw);
  assert.deepEqual(report.records[0].candidateRows, [3]);
  const duplicate = await compareAsync(input([raw, row(2, 'Museum opens.', 4)], [row(2, 'Museum opens.')]));
  assert.equal(duplicate.records[0].state, 'ambiguous_duplicate');
});

test('production coordinates never coerce booleans, fractional or unsafe integers', async () => {
  const report = await compareAsync(input([
    {surah: true, ayah: 1, rowNumber: 1, translation: 'Museum'},
    {surah: 1, ayah: '1.0', rowNumber: 2, translation: 'Museum'},
    {surah: 1, ayah: Number.MAX_SAFE_INTEGER + 1, rowNumber: 3, translation: 'Museum'},
    row(2, 'Museum', true),
  ], []));
  assert.equal(report.counts.states.invalid_row, 4);
  assert.equal(report.ledger.candidate.length, 4);
  assert.equal(report.records.find(record => record.id === '1:2').candidateRows[0], null);
});

test('production JSON gate rejects cycles, unsupported types and excessive nesting', async () => {
  const cycle = input([], []); cycle.candidate.push(cycle);
  const deep = input([], []); let cursor = {}; deep.candidate.push(cursor);
  for (let i = 0; i < 70; i++) { cursor.next = {}; cursor = cursor.next; }
  for (const bad of [cycle, deep, {...input([], []), extra: NaN}, {...input([], []), extra: new Date()}, {...input([], []), extra: 1n}, {...input([], []), extra: undefined}]) {
    assert.equal((await compareAsync(bad)).error.code, 'INVALID_JSON');
  }
});

test('production takes snapshot before WebCrypto yields to caller mutation', async () => {
  const fixture = input([row(1, 'Candidate')], [row(1, 'BASELINE_BEFORE_YIELD')]);
  const pending = compareAsync(fixture);
  fixture.baseline[0].translation = 'MUTATED_DURING_HASH';
  const report = await pending;
  assert.equal(report.records[0].baselineText, 'BASELINE_BEFORE_YIELD');
});

test('production canonical JSON and WebCrypto SHA-256 match independent Node crypto', async () => {
  const {createHash} = await import('node:crypto');
  const {canonical} = await import('../public/modules/revision-review.mjs');
  assert.equal(canonical({b: [1, 'باب'], a: {z: 2, x: 'é'}}), '{"a":{"x":"é","z":2},"b":[1,"باب"]}');
  const fixture = input([row(1, 'Museum')], [row(1, 'Museum')]);
  const report = await compareAsync(fixture);
  const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
  assert.equal(report.contextFingerprint, sha(fixture));
  assert.equal(report.inputDigests.candidate, sha(fixture.candidate));
  const {reportFingerprint, ...unsignedReport} = report;
  assert.equal(reportFingerprint, sha(unsignedReport));
});

test('production maximum 20000 rows is retained, not truncated', async () => {
  const report = await compareAsync(input(Array.from({length: 20000}, (_, index) => row(1, 'Museum', index + 1)), [row(1, 'Museum')]));
  assert.equal(report.ledger.candidate.length, 20000);
  assert.equal(report.records[0].candidateRows.length, 20000);
  assert.equal(report.records[0].state, 'ambiguous_duplicate');
  assert.equal(report.coverage.candidate.abstainedRows, 20000);
});

test('production coverage separates observed IDs, abstention and outside-scope rows', async () => {
  const report = await compareAsync(input([row(1, 'Museum'), row(2, ''), row(3, 'A'), row(3, 'B'), row(11, 'Outside')], [row(1, 'Museum'), row(4, 'Old')]));
  assert.deepEqual(report.coverage.candidate, {readRows: 5, withinScopeRows: 4, observedScopedIds: 3, unobservedExpectedIds: 7, abstainedRows: 3, outOfScopeRows: 1});
  assert.equal(report.coverage.expectedScopedIds, 10);
  assert.equal(report.coverage.eligibleMatchedRecords, 1);
});

test('production cancellation before hashing and during progress never returns successful partial report', async () => {
  const before = new AbortController(); before.abort();
  assert.equal((await compareAsync(input([], []), {signal: before.signal})).error.code, 'CANCELLED');
  const during = new AbortController();
  const fixture = input(Array.from({length: 100}, (_, index) => row(index + 1, 'Museum')), []);
  fixture.scope = [{surah: 1, fromAyah: 1, toAyah: 100}];
  const report = await compareAsync(fixture, {
    signal: during.signal,
    onProgress: progress => { if (progress.completed >= 64) during.abort(); },
  });
  assert.equal(report.error.code, 'CANCELLED');
  assert.equal(report.records, undefined);
  assert.equal(report.certificate, false);
});

test('production current decisions become stale on other-row change and recover only on exact restoration', async () => {
  const fixture = input([row(1, 'Museum'), row(2, 'Library')], [row(1, 'Museum'), row(2, 'Library')]);
  const original = await compareAsync(fixture), record = original.records[0];
  const decision = bindDecision(record, {...record, decision: 'reviewed', reason: 'Synthetic reviewer note'});
  fixture.candidate[1].translation = 'Library changed';
  const stale = reconcileDecisions([decision], await compareAsync(fixture));
  assert.equal(stale[0].status, 'stale');
  assert.equal(stale[0].staleReason, 'context_changed');
  fixture.candidate[1].translation = 'Library';
  const restored = reconcileDecisions(stale, await compareAsync(fixture));
  assert.equal(restored[0].status, 'active');
  assert.equal(restored[0].staleReason, undefined);
});

test('production missing record and invalid decision notes cannot silently become reviewed', async () => {
  const fixture = input([row(1, 'Museum')], [row(1, 'Museum')]);
  const original = await compareAsync(fixture), record = original.records[0];
  for (const reason of ['', '   ', 'x'.repeat(5001)]) assert.equal(bindDecision(record, {...record, decision: 'reviewed', reason}).error.code, 'INVALID_DECISION');
  const decision = bindDecision(record, {...record, decision: 'deferred', reason: 'Await reviewer'});
  const missing = await compareAsync(input([], []));
  assert.equal(reconcileDecisions([decision], missing)[0].staleReason, 'missing_record');
  assert.equal(reconcileDecisions([{...decision, evidenceFingerprint: 'fake'}], original).error.code, 'INVALID_RECONCILIATION');
});

test('production export invalid inputs and nullable options remain structured and do not mutate report', async () => {
  const report = await compareAsync(input([row(1, 'Candidate')], [row(1, 'PRIVATE_BASELINE')]));
  assert.equal(JSON.stringify(exportReport(report, null)).includes('PRIVATE_BASELINE'), false);
  assert.equal(exportReport(null).error.code, 'INVALID_REPORT');
  assert.equal(exportReport(undefined).error.code, 'INVALID_REPORT');
  const cycle = {}; cycle.self = cycle;
  assert.equal(exportReport(cycle).error.code, 'INVALID_REPORT');
  assert.equal(report.records[0].baselineText, 'PRIVATE_BASELINE');
  assert.equal(report.certificate, false);
  assert.equal(report.publicationAuthorized, false);
});

test('production full 6236-ID synthetic rerun retains coverage and deterministic fingerprints', async () => {
  const {SURAH_AYAH_COUNTS} = await import('../src/quran-index.mjs');
  const rows = [];
  const scope = SURAH_AYAH_COUNTS.map((count, index) => {
    for (let ayah = 1; ayah <= count; ayah++) rows.push({surah: index + 1, ayah, rowNumber: rows.length + 2, translation: 'Synthetic museum exhibit text; no religious content.'});
    return {surah: index + 1, fromAyah: 1, toAyah: count};
  });
  const fixture = {...input(rows, rows), scope};
  const first = await compareAsync(fixture), second = await compareAsync(fixture);
  assert.equal(first.coverage.expectedScopedIds, 6236);
  assert.equal(first.coverage.eligibleMatchedRecords, 6236);
  assert.equal(first.coverage.candidate.unobservedExpectedIds, 0);
  assert.equal(first.counts.states.identical_raw, 6236);
  assert.equal(first.ledger.baseline.length, 6236);
  assert.equal(first.reportFingerprint, second.reportFingerprint);
  assert.equal(first.contextFingerprint, second.contextFingerprint);
});

test('production malformed report records never crash reconciliation or export', async () => {
  const report = await compareAsync(input([row(1, 'Museum')], [row(1, 'Museum')]));
  for (const badRecords of [[null], [42], [{}], [{...report.records[0], contextFingerprint: 'wrong'}]]) {
    const malformed = {...report, records: badRecords};
    assert.equal(reconcileDecisions([], malformed).error.code, 'INVALID_RECONCILIATION');
    assert.equal(exportReport(malformed).error.code, 'INVALID_REPORT');
  }
});

