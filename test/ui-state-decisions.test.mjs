import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {auditBatch, generateDemoRows, generateDemoReferenceRows} from '../public/modules/batch-engine.mjs';
import {decisionFingerprintInput, csvCell} from '../public/modules/ui-helpers.mjs';
import {buildReviewDossier, caseProgress, caseResolution, isUnresolvedCase} from '../public/modules/dossier.mjs';
import {createRunManifest, appendRunHistory, mergeRunHistory, parseRunHistory, stringifyRunHistory, RUN_HISTORY_LIMIT} from '../public/modules/run-manifest.mjs';
import {
  reviewIdentityInput, fileAwareDecisionInput, savedDecisionNotice, STORAGE_UNAVAILABLE_NOTE, STORE_REPAIRED_NOTE, parseDecisionStore, loadDecisionStore, applyStoredDecisions, buildDecisionStore, localDateStamp, rowsInDeclaredScope,
  hiddenControlFlags, joinRowTexts, buildReviewCsvLines, CSV_HEADER, decisionProgressText, unappliedDecisionsNote, teamSoloDecisionNotice, MAX_KEPT_UNAPPLIED_DECISIONS,
} from '../public/modules/review-state.mjs';

// Synthetic, non-religious demo text only (the engine's built-in teaching rows).
const SCOPE = {type:'selected', surahs:[1, 112, 113, 114]};
const REFERENCE = {title:'مرجع تعليمي', sourceKind:'synthetic-teaching', language:'en', verificationStatus:'verified', edition:'مثال'};
function audit({rows = generateDemoRows(), referenceRows = generateDemoReferenceRows(), scope = SCOPE, reference = REFERENCE, synthetic = true} = {}) {
  const report = auditBatch({rows, referenceRows, scope, metadata:{candidate:{name:'x.csv', language:'en', synthetic}, reference, analysisMode:'structural-and-lexical-rules'}});
  Object.assign(report.provenance.reference, reference);
  return report;
}
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function fingerprints(report) {
  const candidateSha256 = report.provenance.candidate.sha256 || await sha(JSON.stringify(report.rows.map(row => [row.surah,row.ayah,row.translation])));
  return Object.fromEntries(await Promise.all(report.findings.map(async finding => [finding.id, await sha(fileAwareDecisionInput(finding,candidateSha256))])));
}
class FakeStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); this.failWrites = false; this.blocked = false; }
  getItem(key) { if (this.blocked) throw new Error('blocked'); return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { if (this.blocked || this.failWrites) throw new Error('quota'); this.map.set(key, String(value)); }
  removeItem(key) { if (this.blocked) throw new Error('blocked'); this.map.delete(key); }
}
const n = value => new Intl.NumberFormat('ar').format(value); // digit shape follows the ICU locale data of the runtime
const decision = (value, note = 'سبب القرار', savedAt = '2026-10-07T10:00:00.000Z') => ({decision:value, note, savedAt});

test('editing one verse keeps unchanged text-case decisions; file-wide decisions require the exact file', async () => {
  const first = audit(), fpFirst = await fingerprints(first);
  const byCode = code => first.findings.find(finding => finding.code === code);
  const chosen = [byCode('potential_negation_change'), byCode('empty_translation'), byCode('missing_verses')];
  assert.ok(chosen.every(Boolean));
  const decisions = {[chosen[0].id]:decision('accept'), [chosen[1].id]:decision('reject'), [chosen[2].id]:decision('refer')};
  const store = buildDecisionStore(decisions, fpFirst);
  assert.equal(Object.keys(store).length, 3);

  // Same file, same review: all three apply.
  const same = applyStoredDecisions(store, fpFirst);
  assert.equal(same.appliedCount, 3);
  assert.equal(same.unappliedCount, 0);

  // Change ONE decided verse in the candidate (112:2): its evidence changes, the file as a whole changes.
  const rows = generateDemoRows().map(row => row.surah === 112 && row.ayah === 2 ? {...row, translation:`${row.translation} (corrected)`} : row);
  const second = audit({rows}), fpSecond = await fingerprints(second);
  assert.deepEqual(reviewIdentityInput(second), reviewIdentityInput(first), 'review identity must not depend on the file content');
  const idByCode = code => second.findings.find(finding => finding.code === code)?.id;
  const applied = applyStoredDecisions(store, fpSecond);
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.unappliedCount, 2);
  assert.equal(applied.decisions[idByCode('empty_translation')].decision, 'reject');
  assert.equal(applied.decisions[idByCode('missing_verses')], undefined, 'an absent-verse decision is bound to the entire candidate file');
  assert.equal(applied.decisions[idByCode('potential_negation_change')], undefined, 'the changed case must not inherit the old decision');
  assert.ok(unappliedDecisionsNote(applied.unappliedCount).startsWith(`قرارات محفوظة سابقًا لم تُطبَّق: ${n(2)}،`));

  // Saving again keeps the unapplied decision, so restoring the original evidence restores it.
  const after = buildDecisionStore(applied.decisions, fpSecond, applied.unapplied);
  assert.equal(Object.keys(after).length, 3);
  assert.equal(applyStoredDecisions(after, fpFirst).appliedCount, 3);
});

test('BUG-05: review identity separates scope, languages and reference identity, not file hashes', () => {
  const base = audit();
  assert.notDeepEqual(reviewIdentityInput(audit({scope:{type:'selected', surahs:[112]}})), reviewIdentityInput(base));
  assert.notDeepEqual(reviewIdentityInput(audit({reference:{...REFERENCE, title:'مرجع آخر'}})), reviewIdentityInput(base));
  assert.notDeepEqual(reviewIdentityInput(audit({reference:{...REFERENCE, edition:'طبعة أخرى'}})), reviewIdentityInput(base));
  assert.ok(!JSON.stringify(reviewIdentityInput(base)).includes('sha256'));
  assert.ok(!('candidate' in reviewIdentityInput(base)) && !('reference' in reviewIdentityInput(base)));
});

test('BUG-05: old-format, corrupt and invalid stores never crash and never apply invalid decisions', () => {
  const fp = 'a'.repeat(64);
  assert.deepEqual(parseDecisionStore(null), {entries:{}, corrupt:false});
  assert.equal(parseDecisionStore('{broken json').corrupt, true);
  assert.equal(parseDecisionStore('[1,2]').corrupt, true);
  assert.equal(parseDecisionStore('"text"').corrupt, true);
  const mixed = JSON.stringify({[fp]:decision('accept'), ['b'.repeat(64)]:{decision:'accept', note:'   '}, ['c'.repeat(64)]:{decision:'maybe', note:'x'}, 'not-a-fingerprint':decision('reject')});
  assert.deepEqual(Object.keys(parseDecisionStore(mixed).entries), [fp]);
});

test('BUG-05: a store from the previous file-hash key is merged once and removed so a withdrawn decision cannot return', () => {
  const fpA = 'a'.repeat(64), fpB = 'b'.repeat(64);
  const storage = new FakeStorage({'mihakk:decisions:v2:old': JSON.stringify({[fpA]:decision('accept'), [fpB]:decision('reject')})});
  const loaded = loadDecisionStore(storage, {key:'mihakk:decisions:v3:new', legacyKey:'mihakk:decisions:v2:old'});
  assert.equal(loaded.migrated, 2);
  assert.deepEqual(Object.keys(loaded.entries).sort(), [fpA, fpB]);
  assert.equal(storage.getItem('mihakk:decisions:v2:old'), null);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem('mihakk:decisions:v3:new'))).sort(), [fpA, fpB]);
  // Withdraw one, reload: it stays withdrawn.
  storage.setItem('mihakk:decisions:v3:new', JSON.stringify({[fpA]:decision('accept')}));
  assert.deepEqual(Object.keys(loadDecisionStore(storage, {key:'mihakk:decisions:v3:new', legacyKey:'mihakk:decisions:v2:old'}).entries), [fpA]);
  // If the new store cannot be written, the old one is kept.
  const failing = new FakeStorage({'mihakk:decisions:v2:old': JSON.stringify({[fpA]:decision('accept')})});
  failing.failWrites = true;
  const kept = loadDecisionStore(failing, {key:'k', legacyKey:'mihakk:decisions:v2:old'});
  assert.equal(kept.migrated, 0);
  assert.ok(failing.getItem('mihakk:decisions:v2:old'));
  assert.equal(Object.keys(kept.entries).length, 1);
});

test('BUG-25: a corrupt store is repaired with valid JSON instead of switching persistence off', () => {
  const storage = new FakeStorage({k:'{broken json'});
  const loaded = loadDecisionStore(storage, {key:'k'});
  assert.equal(loaded.repaired, true);
  assert.deepEqual(loaded.entries, {});
  assert.equal(storage.getItem('k'), '{}');
  const array = new FakeStorage({k:'[]'});
  assert.equal(loadDecisionStore(array, {key:'k'}).repaired, true);
  assert.equal(array.getItem('k'), '{}');
  // Blocked storage throws, and the caller reports "storage unavailable" (never silently continues).
  const blocked = new FakeStorage(); blocked.blocked = true;
  assert.throws(() => loadDecisionStore(blocked, {key:'k'}));
});

test('BUG-22: withdrawing a decision removes it from the store; unapplied earlier decisions are bounded', () => {
  const fp = {f1:'1'.repeat(64), f2:'2'.repeat(64)};
  const decisions = {f1:decision('accept'), f2:decision('reject')};
  assert.equal(Object.keys(buildDecisionStore(decisions, fp)).length, 2);
  delete decisions.f2;
  assert.deepEqual(Object.keys(buildDecisionStore(decisions, fp)), [fp.f1]);
  const many = Object.fromEntries(Array.from({length:MAX_KEPT_UNAPPLIED_DECISIONS + 40}, (_, index) => [index.toString(16).padStart(64, '0'), decision('refer', 'ملاحظة', `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`)]));
  const kept = buildDecisionStore(decisions, fp, many);
  assert.equal(Object.keys(kept).length, MAX_KEPT_UNAPPLIED_DECISIONS + 1);
  assert.ok(fp.f1 in kept, 'current decisions are never dropped by the bound');
});

test('BUG-23/24: one definition of unresolved drives the dossier, the progress line and the CSV', () => {
  const report = audit(), cases = report.findings.filter(finding => ['structural', 'comparison'].includes(finding.type));
  const [accepted, closed, referred] = cases;
  const decisions = {[accepted.id]:decision('accept'), [closed.id]:decision('reject'), [referred.id]:decision('refer')};
  const progress = caseProgress(report.findings, decisions);
  assert.equal(progress.cases, cases.length);
  assert.equal(progress.resolved, 2);
  assert.equal(progress.referred, 1);
  assert.equal(progress.unresolved, cases.length - 2);
  const dossier = buildReviewDossier(report, decisions);
  assert.equal(dossier.counts.unresolved, progress.unresolved);
  assert.equal(dossier.counts.resolved, progress.resolved);
  assert.equal(dossier.counts.referred, progress.referred);
  assert.equal(dossier.publicationAuthorized, false);
  assert.equal(dossier.certificate, false);
  assert.match(dossier.gates.find(gate => gate.id === 'case_resolution').detail, new RegExp(`غير محسومة|غير محسومتان`));
  // Only reject and accept resolve; refer and no decision do not.
  assert.equal(caseResolution(accepted, decisions), 'resolved_needs_correction');
  assert.equal(caseResolution(closed, decisions), 'resolved_closed');
  assert.equal(caseResolution(referred, decisions), 'unresolved_referred');
  assert.equal(isUnresolvedCase(referred, decisions), true);
  assert.equal(isUnresolvedCase(cases.at(-1), decisions), true);
  assert.equal(caseResolution({type:'evidence', id:'x'}, {}), 'evidence_signal_not_counted');
  // The CSV states the same per-row state, and its unresolved rows equal the dossier count.
  const lines = buildReviewCsvLines({report, decisions, candidateSha256:'0'.repeat(64), notice:'n', synthetic:true});
  const column = CSV_HEADER.indexOf('resolution_state');
  const unresolvedRows = lines.slice(1).filter(line => ['unresolved', 'unresolved_referred'].includes(line[column])).length;
  assert.equal(unresolvedRows, dossier.counts.unresolved);
  // BUG-24: the visible counter says "N من M محسومة" with the same figures.
  assert.ok(decisionProgressText(progress).includes(`${n(2)} من ${n(cases.length)} محسومة`));
  assert.ok(decisionProgressText(progress).includes(`منها ${n(1)} إحالة لم تُغلق`));
  assert.match(decisionProgressText(caseProgress([], {})), /لا توجد حالات فحص/);
});

test('BUG-35: a finding that covers several rows exports the text of every row and still neutralises formulas', () => {
  const rows = generateDemoRows().map(row => row.rowNumber === 23 ? {...row, translation:'=HYPERLINK("http://example.invalid","x")'} : row);
  const report = audit({rows});
  const duplicate = report.findings.find(finding => finding.code === 'duplicate_verse');
  assert.deepEqual(duplicate.rowNumbers, [12, 23]);
  const lines = buildReviewCsvLines({report, decisions:{}, candidateSha256:'f'.repeat(64), notice:'n', synthetic:true});
  const record = lines.find(line => line[0] === duplicate.id);
  const text = record[CSV_HEADER.indexOf('candidate_text')];
  const texts = [12, 23].map(number => report.rows.find(row => row.rowNumber === number).translation);
  for (const value of texts) assert.ok(text.includes(value), `missing ${value}`);
  assert.ok(text.startsWith(texts[0]));
  assert.equal(record[CSV_HEADER.indexOf('row_numbers')], '12;23');
  // The cell is still protected by csvCell when the first row begins like a formula.
  assert.ok(csvCell(joinRowTexts(['=1+1', 'x'])).startsWith('"\'='));
  assert.equal(joinRowTexts(['only']), 'only');
  assert.equal(joinRowTexts([]), '');
  assert.ok(joinRowTexts(['x'.repeat(20000), 'y'.repeat(20000)]).length < 31000);
});

test('BUG-35: the CSV keeps its first 20 columns in order, adds a synthetic flag and never claims publication', () => {
  assert.deepEqual(CSV_HEADER.slice(0, 20), ['finding_id','code','type','severity','verse_ids','row_numbers','message','candidate_text','reference_text','source','source_edition','source_url','reference_verification','decision','reviewer_note','decision_time','candidate_sha256','scope','generated_at','notice']);
  const demo = buildReviewCsvLines({report:audit(), decisions:{}, candidateSha256:'0'.repeat(64), notice:'n', synthetic:true});
  const real = buildReviewCsvLines({report:audit({synthetic:false}), decisions:{}, candidateSha256:'0'.repeat(64), notice:'n', synthetic:false});
  const flag = CSV_HEADER.indexOf('synthetic_demo_data'), published = CSV_HEADER.indexOf('publication_authorized');
  assert.ok(demo.slice(1).every(line => line.length === CSV_HEADER.length && line[flag] === 'true' && line[published] === 'false'));
  assert.ok(real.slice(1).every(line => line.length === CSV_HEADER.length && line[flag] === 'false' && line[published] === 'false'));
  // No findings: the explanatory row still has every column.
  const empty = {...audit(), findings:[]};
  const lines = buildReviewCsvLines({report:empty, decisions:{}, candidateSha256:'', notice:'n', synthetic:true});
  assert.equal(lines.length, 2);
  assert.equal(lines[1].length, CSV_HEADER.length);
  assert.equal(lines[1][flag], 'true');
});

test('BUG-35: live Quranpedia reference text is never written to the CSV', () => {
  const live = {...REFERENCE, sourceKind:'quranpedia-api', verificationStatus:'verified'};
  const report = audit({reference:live});
  Object.assign(report.provenance.reference, live);
  const lines = buildReviewCsvLines({report, decisions:{}, candidateSha256:'0'.repeat(64), notice:'n'});
  const column = CSV_HEADER.indexOf('reference_text');
  assert.ok(lines.slice(1).every(line => line[column] === 'Reference text omitted; consult source URL' || line[column] === ''));
  const referenceTexts = generateDemoReferenceRows().map(row => row.translation);
  assert.ok(lines.slice(1).every(line => referenceTexts.every(text => !String(line[column]).includes(text))));
});

test('CSV reference disclosure separates authored teaching, recorded provenance and verified live retrieval', () => {
  const cases = [
    ['synthetic-teaching', 'verified', 'authored_teaching_only'],
    ['quranpedia-api', 'verified', 'retrieved_from_source_not_scholarly_verified'],
    ['quranpedia-api', 'unverified', 'not_verified'],
    ['user-upload', 'verified', 'provenance_recorded_not_scholarly_verified'],
    ['user-upload', 'unverified', 'not_verified'],
  ];
  for (const [sourceKind, verificationStatus, expected] of cases) {
    const source = {title:'Authored non-religious control', sourceKind, verificationStatus};
    const report = {
      rows:[{rowNumber:2, translation:'An authored classroom example.', reference:{translation:'A different authored classroom example.', provenance:source}}],
      findings:[{id:'control', code:'lexical_difference', type:'comparison', severity:'low', rowNumbers:[2], verseIds:['1:1'], message:'Compare this authored sample.'}],
      provenance:{candidate:{synthetic:true}, reference:{...source, verificationStatus:'verified'}}, scope:{type:'provided'}, generatedAt:'2026-10-08T00:00:00.000Z',
    };
    const lines = buildReviewCsvLines({report});
    assert.deepEqual(lines[0], CSV_HEADER);
    assert.equal(lines[1].length, CSV_HEADER.length);
    assert.equal(lines[1][CSV_HEADER.indexOf('reference_verification')], expected, `${sourceKind}/${verificationStatus}`);
    assert.equal(lines[1][CSV_HEADER.indexOf('publication_authorized')], 'false');
    assert.equal(lines[1][CSV_HEADER.indexOf('reference_text')], sourceKind === 'quranpedia-api' ? 'Reference text omitted; consult source URL' : report.rows[0].reference.translation);
  }
});

test('BUG-45: invisible and bidi control characters are flagged in the CSV and never stripped', () => {
  assert.equal(hiddenControlFlags('plain text'), '');
  assert.equal(hiddenControlFlags('a‮b⁧c​d​'), 'bidi_control=U+202E:1,U+2067:1;zero_width=U+200B:2');
  assert.equal(hiddenControlFlags('x\u0007y'), 'control_char=U+0007:1');
  assert.equal(hiddenControlFlags('line\nbreak\tand tab'), '');
  const poisoned = 'safe ‮txt‬ ​end';
  const rows = generateDemoRows().map(row => row.rowNumber === 4 ? {...row, translation:poisoned} : row);
  const report = audit({rows});
  const finding = report.findings.find(item => (item.rowNumbers || []).includes(4));
  const line = buildReviewCsvLines({report, decisions:{}, candidateSha256:'0'.repeat(64), notice:'n'}).find(entry => entry[0] === finding.id);
  assert.equal(line[CSV_HEADER.indexOf('candidate_text')], poisoned, 'the translation text itself is exported unchanged');
  assert.match(line[CSV_HEADER.indexOf('hidden_control_chars')], /bidi_control=.*U\+202E:1/);
  assert.match(line[CSV_HEADER.indexOf('hidden_control_chars')], /zero_width=U\+200B:1/);
  // A zero-width character in front of a formula marker no longer slips past the formula guard.
  for (const value of ['​=1+1', '‮+cmd', '‏-2', '⁠@x']) assert.ok(csvCell(value).startsWith(`"'`), JSON.stringify(value));
  assert.equal(csvCell('​plain'), '"​plain"');
});

test('BUG-39: file names use the local calendar day, not the UTC day', () => {
  assert.equal(localDateStamp(new Date(2026, 9, 8, 1, 30)), '2026-10-08');
  assert.equal(localDateStamp(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  const script = "import('./public/modules/review-state.mjs').then(m=>{const d=new Date('2026-10-07T22:30:00Z');console.log(m.localDateStamp(d)+'|'+d.toISOString().slice(0,10));})";
  const out = execFileSync(process.execPath, ['-e', script], {cwd:new URL('../', import.meta.url), env:{...process.env, TZ:'Asia/Riyadh'}}).toString().trim();
  // In Riyadh (UTC+3) 22:30Z on 7 October is 01:30 on 8 October: the old UTC-based name would say 2026-10-07.
  assert.equal(out, '2026-10-08|2026-10-07');
});

test('BUG-39: rows outside the declared scope are never sent to a live reference fetch', () => {
  const rows = [{surah:1, ayah:1, translation:'a', rowNumber:1}, {surah:2, ayah:1, translation:'b', rowNumber:2}, {surah:3, ayah:1, translation:'c', rowNumber:3}, {surah:200, ayah:1, translation:'bad', rowNumber:4}];
  const scoped = auditBatch({rows, scope:{type:'selected', surahs:[1]}, metadata:{candidate:{name:'x', language:'en'}}});
  assert.deepEqual(rowsInDeclaredScope(scoped.rows).map(row => row.verseId), ['1:1']);
  const provided = auditBatch({rows, scope:{type:'provided'}, metadata:{candidate:{name:'x', language:'en'}}});
  assert.deepEqual(rowsInDeclaredScope(provided.rows).map(row => row.verseId), ['1:1', '2:1', '3:1']);
  const full = auditBatch({rows, scope:{type:'full'}, metadata:{candidate:{name:'x', language:'en'}}});
  assert.equal(rowsInDeclaredScope(full.rows).length, 3);
});

test('BUG-39: run history written by two tabs is merged, not overwritten', async () => {
  const report = audit();
  const make = async (offset, rows = generateDemoRows()) => {
    const manifest = await createRunManifest({report, input:{rows, referenceRows:generateDemoReferenceRows(), scope:SCOPE, metadata:{candidate:{name:'x', language:'en'}, reference:REFERENCE, analysisMode:'structural-and-lexical-rules'}}});
    return {...manifest, runId:crypto.randomUUID(), createdAt:new Date(Date.UTC(2026, 9, 7, 10, 0, offset)).toISOString()};
  };
  const [a, b, c] = [await make(1), await make(2), await make(3)];
  const tabA = appendRunHistory([], a);                 // tab A ran once
  const tabB = appendRunHistory(appendRunHistory([], b), c); // tab B ran twice
  const stored = parseRunHistory(stringifyRunHistory(tabB));
  const merged = mergeRunHistory(stored, appendRunHistory(tabA, a));
  assert.deepEqual(merged.map(run => run.runId), [a.runId, b.runId, c.runId]);
  assert.equal(mergeRunHistory(merged, merged).length, 3, 'merging is idempotent');
  assert.throws(() => mergeRunHistory(null, []), TypeError);
  let long = [];
  for (let index = 0; index < RUN_HISTORY_LIMIT + 3; index++) long = mergeRunHistory(long, [await make(10 + index)]);
  assert.equal(long.length, RUN_HISTORY_LIMIT);
  assert.deepEqual(mergeRunHistory([{runId:'SECRET'}, null], tabA).map(run => run.runId), [a.runId]);
});

test('BUG-11: the team notice appears only when solo decisions would be hidden', () => {
  assert.equal(teamSoloDecisionNotice(0), '');
  assert.ok(teamSoloDecisionNotice(2).startsWith(`قراراتك الفردية المحفوظة (${n(2)}) لن تُحتسب في وضع الفريق`));
  assert.match(teamSoloDecisionNotice(2), /تعود عند «إنهاء وضع الفريق»/);
});

test('a file-wide decision never applies to a different file with identical missing-verse evidence', async () => {
  const first=audit(), firstMap=await fingerprints(first), finding=first.findings.find(item=>item.code==='missing_verses');
  const store=buildDecisionStore({[finding.id]:decision('reject')},firstMap);
  const changed=audit({rows:generateDemoRows().map(row=>({...row,translation:row.translation?`Distinct file: ${row.translation}`:''}))});
  const changedMap=await fingerprints(changed), restored=applyStoredDecisions(store,changedMap);
  assert.equal(restored.appliedCount,0);assert.equal(restored.unappliedCount,1);
  assert.equal(applyStoredDecisions(store,firstMap).appliedCount,1);
  assert.throws(()=>fileAwareDecisionInput(finding,''),/Missing candidate fingerprint/);
});

test('exact-file v2 migration rekeys structural evidence; unbound old v3 evidence stays unapplied', () => {
  const old='a'.repeat(64), bound='b'.repeat(64), d=decision('reject');
  const legacy=new FakeStorage({old:JSON.stringify({[old]:d})});
  const loaded=loadDecisionStore(legacy,{key:'current',legacyKey:'old',legacyFingerprintMap:{[old]:bound}});
  assert.equal(applyStoredDecisions(loaded.entries,{case:bound}).appliedCount,1);
  assert.equal(legacy.getItem('old'),null);
  const current=new FakeStorage({current:JSON.stringify({[old]:d})});
  const preserved=loadDecisionStore(current,{key:'current',legacyKey:'absent',legacyFingerprintMap:{[old]:bound}});
  assert.equal(applyStoredDecisions(preserved.entries,{case:bound}).appliedCount,0);
  assert.equal(applyStoredDecisions(preserved.entries,{case:bound}).unappliedCount,1);
});

test('the actual app save path reports quota failure and clears the unavailable warning after recovery', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const source=app.match(/function persistDecisions\(\)\{[\s\S]*?\n\}/)?.[0];assert.ok(source);
  const persist=new Function('state','localStorage','buildDecisionStore','STORAGE_UNAVAILABLE_NOTE','loadDecisionStore','applyStoredDecisions',`${source};return persistDecisions();`);
  const fp='a'.repeat(64), state={decisionKey:'key',decisions:{case:decision('reject')},decisionFingerprints:{case:fp},unappliedDecisions:{},storageIssue:'',storageFailed:false};
  const storage=new FakeStorage();storage.failWrites=true;
  assert.equal(persist(state,storage,buildDecisionStore,STORAGE_UNAVAILABLE_NOTE,loadDecisionStore,applyStoredDecisions),false);
  assert.equal(state.storageFailed,true);assert.equal(state.storageIssue,STORAGE_UNAVAILABLE_NOTE);
  assert.match(savedDecisionNotice({saved:state.decisions.case,...state}),/لهذه الجلسة فقط/);
  storage.failWrites=false;assert.equal(persist(state,storage,buildDecisionStore,STORAGE_UNAVAILABLE_NOTE,loadDecisionStore,applyStoredDecisions),true);
  assert.equal(state.storageFailed,false);assert.equal(state.storageIssue,'');
  assert.deepEqual(JSON.parse(storage.getItem('key'))[fp],state.decisions.case);
  assert.equal(savedDecisionNotice({saved:state.decisions.case,...state}),'قرارك محفوظ في هذا المتصفح.');
  state.storageIssue=STORE_REPAIRED_NOTE;assert.equal(persist(state,storage,buildDecisionStore,STORAGE_UNAVAILABLE_NOTE,loadDecisionStore,applyStoredDecisions),true);
  assert.equal(state.storageIssue,STORE_REPAIRED_NOTE,'a successful save does not erase a different historical warning');
  assert.equal(savedDecisionNotice({draft:{note:'unsaved'},saved:state.decisions.case,storageFailed:true}),'استُعيدت مسودتك التي لم تُحفظ؛ اضغط «حفظ القرار» لتثبيتها.');
});

test('initially blocked storage keeps the exact-file evidence key so a later save can recover', async () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const source=app.match(/async function setupDecisionStorage\(report\)\{[\s\S]*?\n\}/)?.[0];assert.ok(source);
  const report=audit(), candidateSha256=await sha(JSON.stringify(report.rows));
  const state={candidate:{sha256:candidateSha256}}, storage=new FakeStorage();storage.blocked=true;
  const setup=new Function('state','localStorage','digest','$','reviewIdentityInput','fileAwareDecisionInput','decisionFingerprintInput','loadDecisionStore','applyStoredDecisions','DECISION_STORE_PREFIX','LEGACY_DECISION_STORE_PREFIX','STORAGE_UNAVAILABLE_NOTE','STORE_REPAIRED_NOTE',`${source};return setupDecisionStorage;`)(state,storage,sha,()=>({value:'none'}),reviewIdentityInput,fileAwareDecisionInput,decisionFingerprintInput,loadDecisionStore,applyStoredDecisions,'mihakk:decisions:v3:','mihakk:decisions:v2:',STORAGE_UNAVAILABLE_NOTE,STORE_REPAIRED_NOTE);
  await setup(report);assert.equal(state.storageFailed,true);assert.equal(state.storageIssue,STORAGE_UNAVAILABLE_NOTE);
  assert.match(state.decisionKey,/^mihakk:decisions:v3:[a-f0-9]{64}$/);assert.match(state.runKey,/^[a-f0-9]{64}$/);
  const finding=report.findings.find(item=>item.code==='missing_verses');assert.match(state.decisionFingerprints[finding.id],/^[a-f0-9]{64}$/);
  storage.blocked=false;state.decisions[finding.id]=decision('refer');
  const persistSource=app.match(/function persistDecisions\(\)\{[\s\S]*?\n\}/)[0];
  const persist=new Function('state','localStorage','buildDecisionStore','STORAGE_UNAVAILABLE_NOTE','loadDecisionStore','applyStoredDecisions',`${persistSource};return persistDecisions();`);
  assert.equal(persist(state,storage,buildDecisionStore,STORAGE_UNAVAILABLE_NOTE,loadDecisionStore,applyStoredDecisions),true);
  assert.equal(state.storageIssue,'');assert.equal(state.storageFailed,false);
  assert.equal(Object.keys(parseDecisionStore(storage.getItem(state.decisionKey)).entries).length,1);
});

test('a duplicate-verse decision is never reused after its duplicated texts change', async () => {
  const first=audit(), fpFirst=await fingerprints(first), finding=first.findings.find(item=>item.code==='duplicate_verse');assert.ok(finding);
  const store=buildDecisionStore({[finding.id]:decision('reject')},fpFirst);
  const changed=audit({rows:generateDemoRows().map(row=>finding.verseIds.includes(`${row.surah}:${row.ayah}`)?{...row,translation:`Changed duplicate ${row.translation}`}:row)});
  const result=applyStoredDecisions(store,await fingerprints(changed));assert.equal(result.appliedCount,0);assert.equal(result.unappliedCount,1);
});

test('recovery merges unread prior decisions, honors session overrides and never restores withdrawn cases', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),source=app.match(/function persistDecisions\(\)\{[\s\S]*?\n\}/)[0];
  const persist=new Function('state','localStorage','buildDecisionStore','STORAGE_UNAVAILABLE_NOTE','loadDecisionStore','applyStoredDecisions',`${source};return persistDecisions();`);
  const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64);
  const storage=new FakeStorage({key:JSON.stringify({[a]:decision('refer','old A'),[b]:decision('reject','old B'),[c]:decision('refer','withdrawn C'),[d]:decision('refer','older unapplied')})});
  const state={decisionKey:'key',legacyDecisionKey:'',decisionStoreNeedsReload:true,legacyFingerprintMap:{},decisions:{A:decision('accept','new A')},decisionFingerprints:{A:a,B:b,C:c},unappliedDecisions:{},withdrawnFingerprints:[c],storageFailed:true,storageIssue:STORAGE_UNAVAILABLE_NOTE};
  assert.equal(persist(state,storage,buildDecisionStore,STORAGE_UNAVAILABLE_NOTE,loadDecisionStore,applyStoredDecisions),true);
  const saved=JSON.parse(storage.getItem('key'));assert.equal(saved[a].note,'new A');assert.equal(saved[b].note,'old B');assert.equal(saved[c],undefined);assert.equal(saved[d].note,'older unapplied');
  assert.equal(state.decisions.B.decision,'reject');assert.equal(state.unappliedCount,1);assert.equal(state.decisionStoreNeedsReload,false);assert.equal(state.storageIssue,'');
});
