import test from 'node:test';
import assert from 'node:assert/strict';
import {
  can, createManagerWorkspace, addMember, removeMember, assignCases, assignCase, isVisible, canDecide,
  buildTaskPackage, parsePackage, acceptTask, buildSubmission, acceptSubmission, setVerdict, buildReview,
  mergeReview, importPackage, teamSummary, approvedDecisions, restoreWorkspace, exportTeam, cleanName, MAX_PACKAGE_BYTES,
} from '../public/modules/team-workflow.mjs';
import {buildReviewDossier} from '../public/modules/dossier.mjs';

const RUN = 'a'.repeat(64);
const OTHER_RUN = 'b'.repeat(64);
const fp = n => n.toString(16).padStart(64, '0');
const CASES = [
  {fingerprint:fp(1), severity:'high', surah:1}, {fingerprint:fp(2), severity:'high', surah:1},
  {fingerprint:fp(3), severity:'medium', surah:112}, {fingerprint:fp(4), severity:'low', surah:113},
  {fingerprint:fp(5), severity:'critical', surah:114}, {fingerprint:fp(6), severity:'medium', surah:114},
];
const roundTrip = pkg => { const parsed = parsePackage(JSON.stringify(pkg)); assert.ok(parsed.value, parsed.error?.message); return parsed.value; };

function team() {
  let {workspace:ws} = createManagerWorkspace({runKey:RUN, managerName:'نضال', runInfo:{candidateName:'file.csv', candidateSha256:'c'.repeat(64), scope:{type:'provided'}}});
  const sup = addMember(ws, {name:'سارة', role:'supervisor'}); ws = sup.workspace;
  const r1 = addMember(ws, {name:'أحمد', role:'reviewer', supervisorId:sup.member.id}); ws = r1.workspace;
  const r2 = addMember(ws, {name:'مريم', role:'reviewer', supervisorId:sup.member.id}); ws = r2.workspace;
  return {ws, sup:sup.member, r1:r1.member, r2:r2.member};
}

test('returned high priority survives manager merge and refreshed supervisor task', () => {
  let {ws:manager, sup} = team();
  manager = assignCases(manager, CASES).workspace;
  const key = fp(1), reviewerId = manager.records[key].reviewerId;
  const pkg = buildTaskPackage(manager, sup.id).package;
  const review = {...pkg, kind:'review', from:{memberId:sup.id,name:sup.name}, items:[{fingerprint:key,reviewerId,decision:'reject',note:'سبب المدقق',verdict:'returned',verdictNote:'راجع الدليل',verdictAt:'2026-10-05T11:00:00Z'}]};
  const merged = mergeReview(manager, review);
  assert.equal(merged.accepted,1);
  assert.equal(merged.workspace.records[key].severity,'high');
  let supervisor = acceptTask(buildTaskPackage(merged.workspace,sup.id).package, {runKey:RUN}).workspace;
  supervisor.records[key].stage='submitted';
  assert.equal(setVerdict(supervisor,key,'approved','').error.code,'NOTE_REQUIRED');
  assert.ok(setVerdict(supervisor,key,'approved','اطلعت على الدليل').workspace);
});

test('imported approvals cannot bypass high-priority supervisor note or downgrade local severity', () => {
  let {ws:manager,sup} = team();
  manager = assignCases(manager, CASES).workspace;
  for (const key of [fp(1),fp(5)]) {
    const pkg = {...buildTaskPackage(manager,sup.id).package, kind:'review', from:{memberId:sup.id,name:sup.name}, items:[{fingerprint:key,reviewerId:manager.records[key].reviewerId,severity:'low',decision:'reject',note:'سبب المدقق',verdict:'approved',verdictNote:'',verdictAt:'2026-10-05T11:00:00Z'}]};
    const blocked = mergeReview(manager,pkg);
    assert.equal(blocked.accepted,0);
    assert.equal(blocked.rejected.length,1);
    assert.equal(blocked.workspace.records[key].stage,'assigned');
    pkg.items[0].verdictNote='تحققت من سياق التنبيه';
    const accepted = mergeReview(manager,pkg);
    assert.equal(accepted.accepted,1);
    assert.equal(accepted.workspace.records[key].severity,manager.records[key].severity);
  }
});

test('permissions are role-bound', () => {
  assert.equal(can('manager', 'assign'), true);
  assert.equal(can('reviewer', 'assign'), false);
  assert.equal(can('supervisor', 'decide'), false);
  assert.equal(can('reviewer', 'decide'), true);
  assert.equal(can('guest', 'decide'), false);
});

test('manager workspace needs a run and a name; names are cleaned of bidi overrides', () => {
  assert.equal(createManagerWorkspace({runKey:'x', managerName:'a'}).error.code, 'NO_RUN');
  assert.equal(createManagerWorkspace({runKey:RUN, managerName:'  '}).error.code, 'NAME_REQUIRED');
  assert.equal(cleanName('a‮b\u0007c'), 'a b c');
});

test('members: duplicates, unknown supervisor and non-manager edits are refused', () => {
  const {ws, sup} = team();
  assert.equal(addMember(ws, {name:'أحمد', role:'reviewer'}).error.code, 'DUPLICATE');
  assert.equal(addMember(ws, {name:'جديد', role:'reviewer', supervisorId:'m-deadbeef'}).error.code, 'SUPERVISOR');
  assert.equal(addMember(ws, {name:'جديد', role:'admin'}).error.code, 'ROLE');
  assert.equal(addMember({...ws, role:'reviewer'}, {name:'x', role:'reviewer'}).error.code, 'FORBIDDEN');
  assert.equal(removeMember(ws, sup.id).error.code, 'HAS_REVIEWERS');
});

test('balanced assignment spreads priorities evenly; surah strategy keeps a surah together', () => {
  const {ws, r1, r2} = team();
  const balanced = assignCases(ws, CASES, {strategy:'balanced'}).workspace;
  const count = id => Object.values(balanced.records).filter(r => r.reviewerId === id).length;
  assert.equal(count(r1.id), 3); assert.equal(count(r2.id), 3);
  const highs = [fp(1), fp(2), fp(5)].map(f => balanced.records[f].reviewerId);
  assert.ok(highs.includes(r1.id) && highs.includes(r2.id), 'high-priority cases are shared');
  const bySurah = assignCases(ws, CASES, {strategy:'surah'}).workspace;
  assert.equal(bySurah.records[fp(1)].reviewerId, bySurah.records[fp(2)].reviewerId);
  assert.equal(bySurah.records[fp(5)].reviewerId, bySurah.records[fp(6)].reviewerId);
  assert.equal(assignCases(balanced, CASES).error.code, 'NOTHING');
  assert.equal(assignCases(createManagerWorkspace({runKey:RUN, managerName:'م'}).workspace, CASES).error.code, 'NO_REVIEWERS');
});

test('full cycle: task → decide → submit → return → fix → approve → merge → dossier', () => {
  let {ws:manager, sup, r1, r2} = team();
  manager = assignCases(manager, CASES).workspace;
  const r1Cases = Object.entries(manager.records).filter(([, r]) => r.reviewerId === r1.id).map(([f]) => f);

  // Reviewer opens the task and sees only own cases.
  let reviewer = acceptTask(roundTrip(buildTaskPackage(manager, r1.id).package), {runKey:RUN}).workspace;
  assert.equal(reviewer.role, 'reviewer');
  assert.equal(CASES.filter(c => isVisible(reviewer, c.fingerprint)).length, 3);
  const foreign = CASES.find(c => !r1Cases.includes(c.fingerprint)).fingerprint;
  assert.equal(canDecide(reviewer, foreign), false, 'reviewer cannot decide on another reviewer case');
  assert.equal(canDecide(reviewer, r1Cases[0]), true);

  assert.equal(buildSubmission(reviewer, {}).error.code, 'NOTHING');
  const decisions = Object.fromEntries(r1Cases.map(f => [f, {decision:'reject', note:'سبب واضح', savedAt:'2026-10-05T10:00:00.000Z'}]));
  decisions[foreign] = {decision:'reject', note:'محاولة خارج الصلاحية'};
  const submission = buildSubmission(reviewer, decisions, '2026-10-05T10:30:00.000Z');
  assert.equal(submission.count, 3, 'foreign decision is not exported');
  reviewer = submission.workspace;
  assert.equal(canDecide(reviewer, r1Cases[0]), false, 'locked after submission');

  // Supervisor opens own task, receives the submission.
  let supervisor = acceptTask(roundTrip(buildTaskPackage(manager, sup.id).package), {runKey:RUN}).workspace;
  assert.equal(CASES.filter(c => isVisible(supervisor, c.fingerprint)).length, 6);
  const received = acceptSubmission(supervisor, roundTrip(submission.package));
  assert.equal(received.accepted, 3); assert.equal(received.rejected.length, 0);
  supervisor = received.workspace;
  assert.equal(setVerdict(supervisor, r1Cases[0], 'returned', '').error.code, 'NOTE_REQUIRED');
  supervisor = setVerdict(supervisor, r1Cases[0], 'returned', 'راجع السياق', '2026-10-05T11:00:00.000Z').workspace;
  supervisor = setVerdict(supervisor, r1Cases[1], 'approved', 'موافق', '2026-10-05T11:00:00.000Z').workspace;
  supervisor = setVerdict(supervisor, r1Cases[2], 'approved', 'موافق', '2026-10-05T11:00:00.000Z').workspace;
  const review = buildReview(supervisor);
  assert.equal(review.count, 3);

  // Reviewer reads the return directly from the supervisor file.
  const back = importPackage(reviewer, roundTrip(review.package), {runKey:RUN});
  assert.equal(back.accepted, 3);
  reviewer = back.workspace;
  assert.equal(canDecide(reviewer, r1Cases[0]), true, 'returned case reopens');
  assert.equal(canDecide(reviewer, r1Cases[1]), false, 'approved case stays locked');
  assert.equal(reviewer.records[r1Cases[0]].verdictNote, 'راجع السياق');

  // Manager merges.
  const merged = mergeReview(manager, roundTrip(review.package));
  assert.equal(merged.accepted, 3);
  manager = merged.workspace;
  assert.equal(Object.keys(approvedDecisions(manager)).length, 2);

  // Fix and resubmit only the returned case, approve it, merge again.
  const fix = buildSubmission(reviewer, {[r1Cases[0]]:{decision:'accept', note:'يحتاج تصحيحًا بعد المراجعة'}}, '2026-10-05T11:30:00.000Z');
  assert.equal(fix.count, 1);
  supervisor = acceptSubmission(supervisor, roundTrip(fix.package)).workspace;
  assert.equal(supervisor.records[r1Cases[0]].stage, 'submitted');
  supervisor = setVerdict(supervisor, r1Cases[0], 'approved', '', '2026-10-05T12:00:00.000Z').workspace;
  manager = mergeReview(manager, roundTrip(buildReview(supervisor).package)).workspace;
  const approved = approvedDecisions(manager);
  assert.equal(approved[r1Cases[0]].decision, 'accept');
  assert.equal(approved[r1Cases[0]].approvedBy, 'سارة');

  const summary = teamSummary(manager, CASES.map(c => c.fingerprint));
  assert.deepEqual(summary.stages, {unassigned:0, assigned:3, submitted:0, approved:3, returned:0});

  // Dossier stays on hold until every case is approved, and never authorizes publication.
  const report = {rows:[], findings:[], summary:{}, provenance:{reference:{}, candidate:{}}};
  const dossier = buildReviewDossier(report, {}, {team:{role:'manager', ...summary}});
  const gate = dossier.gates.find(g => g.id === 'team_oversight');
  assert.equal(gate.status, 'hold');
  assert.equal(dossier.publicationAuthorized, false);
  assert.equal(dossier.gates.at(-1).id, 'expert_signoff');
  const reviewerDossier = buildReviewDossier(report, {}, {team:{role:'reviewer', total:0, stages:{}}});
  assert.equal(reviewerDossier.gates.find(g => g.id === 'team_oversight').status, 'hold');
  const done = buildReviewDossier(report, {}, {team:{role:'manager', total:2, stages:{approved:2}}});
  assert.equal(done.gates.find(g => g.id === 'team_oversight').status, 'recorded');
});

test('refusals: wrong run, foreign reviewer, self review, tampered cases, older verdicts', () => {
  let {ws:manager, sup, r1} = team();
  manager = assignCases(manager, CASES).workspace;
  const task = roundTrip(buildTaskPackage(manager, r1.id).package);
  const mismatch = acceptTask(task, {runKey:OTHER_RUN});
  assert.equal(mismatch.error.code, 'RUN_MISMATCH');
  assert.match(mismatch.error.message, /file\.csv/);

  // A task that lists a case of another reviewer is rejected whole.
  const tampered = structuredClone(task);
  tampered.records[fp(99)] = {stage:'assigned', reviewerId:'m-00000000'};
  assert.equal(acceptTask(tampered, {runKey:RUN}).error.code, 'RECORDS');

  let reviewer = acceptTask(task, {runKey:RUN}).workspace;
  const own = Object.keys(reviewer.records);
  const submission = buildSubmission(reviewer, Object.fromEntries(own.map(f => [f, {decision:'reject', note:'ok'}]))).package;

  // Submission edited to include a case not assigned to this reviewer.
  const forged = structuredClone(submission);
  forged.items.push({fingerprint:CASES.find(c => !own.includes(c.fingerprint)).fingerprint, decision:'reject', note:'x'});
  let supervisor = acceptTask(roundTrip(buildTaskPackage(manager, sup.id).package), {runKey:RUN}).workspace;
  const partial = acceptSubmission(supervisor, roundTrip(forged));
  assert.equal(partial.accepted, own.length);
  assert.equal(partial.rejected.length, 1);

  // The manager cannot take a submission that belongs to a supervisor's reviewer.
  assert.equal(acceptSubmission(manager, roundTrip(submission)).error.code, 'NOT_YOURS');
  // A supervisor cannot review a file that claims to come from themselves.
  const self = {...structuredClone(submission), from:{memberId:sup.id, name:'سارة', role:'reviewer'}};
  assert.equal(acceptSubmission(supervisor, self).error.code, 'SELF_REVIEW');
  // Reviewer cannot judge.
  assert.equal(setVerdict(reviewer, own[0], 'approved').error.code, 'FORBIDDEN');

  // Older verdict never overwrites a newer one.
  supervisor = partial.workspace;
  supervisor = setVerdict(supervisor, own[0], 'approved', 'موافق', '2026-10-05T09:00:00.000Z').workspace;
  const older = roundTrip(buildReview(supervisor).package);
  const newer = structuredClone(older); newer.items[0].verdict = 'returned'; newer.items[0].verdictNote = 'لاحقًا'; newer.items[0].verdictAt = '2026-10-05T15:00:00.000Z';
  manager = mergeReview(manager, newer).workspace;
  const result = mergeReview(manager, older);
  assert.equal(result.skipped, 1);
  assert.equal(result.workspace.records[own[0]].stage, 'returned');

  // A review from a non-supervisor is refused.
  const fake = {...structuredClone(older), from:{memberId:r1.id, name:'أحمد', role:'supervisor'}};
  assert.equal(mergeReview(manager, fake).error.code, 'NOT_SUPERVISOR');
});

test('manager supervises reviewers assigned directly to the manager', () => {
  let {workspace:ws} = createManagerWorkspace({runKey:RUN, managerName:'نضال'});
  const added = addMember(ws, {name:'علي', role:'reviewer'}); ws = assignCases(added.workspace, CASES.slice(0, 2)).workspace;
  const reviewer = acceptTask(roundTrip(buildTaskPackage(ws, added.member.id).package), {runKey:RUN}).workspace;
  const sub = buildSubmission(reviewer, {[fp(1)]:{decision:'refer', note:'سؤال للمختص'}});
  const got = importPackage(ws, roundTrip(sub.package), {runKey:RUN});
  assert.equal(got.accepted, 1);
  const verdict = setVerdict(got.workspace, fp(1), 'approved', 'موافق');
  assert.equal(verdict.workspace.records[fp(1)].verdictByName, 'نضال');
  assert.equal(buildReview(verdict.workspace).error.code, 'FORBIDDEN', 'manager merges directly instead of exporting');
});

test('reassignment and removal respect the stage', () => {
  let {ws:manager, sup, r1, r2} = team();
  manager = assignCases(manager, CASES).workspace;
  const target = Object.entries(manager.records).find(([, r]) => r.reviewerId === r1.id)[0];
  const moved = assignCase(manager, {fingerprint:target, surah:1}, r2.id).workspace;
  assert.equal(moved.records[target].reviewerId, r2.id);
  const locked = structuredClone(moved); locked.records[target].stage = 'submitted';
  assert.equal(assignCase(locked, {fingerprint:target}, r1.id).error.code, 'LOCKED');
  const removed = removeMember(moved, r2.id);
  assert.ok(removed.released >= 1);
  assert.equal(Object.values(removed.workspace.records).some(r => r.reviewerId === r2.id), false);
  assert.ok(removed.workspace.members.find(m => m.id === r2.id).removed);
  assert.equal(addMember(removed.workspace, {name:'مريم', role:'reviewer', supervisorId:sup.id}).error, undefined, 'removed name can be reused');
});

test('parser rejects oversized, corrupted and foreign files', () => {
  assert.equal(parsePackage('').error.code, 'EMPTY_FILE');
  assert.equal(parsePackage('{oops').error.code, 'INVALID_JSON');
  assert.equal(parsePackage('{"format":"other"}').error.code, 'NOT_TEAM_FILE');
  assert.equal(parsePackage('{}', MAX_PACKAGE_BYTES + 1).error.code, 'TOO_LARGE');
  assert.equal(parsePackage(JSON.stringify({format:'mihakk-team', version:2})).error.code, 'VERSION');
  assert.equal(parsePackage(JSON.stringify({format:'mihakk-team', version:1, kind:'task', projectId:'zz', runKey:RUN, from:{memberId:'manager'}, records:{}})).error.code, 'IDS');
  assert.equal(importPackage(null, {kind:'submission'}).error.code, 'NO_TEAM');
});

test('exchange files and exports never carry translation text; storage restore is strict', () => {
  let {ws:manager, r1} = team();
  manager = assignCases(manager, CASES).workspace;
  const task = JSON.stringify(buildTaskPackage(manager, r1.id).package);
  assert.doesNotMatch(task, /translation/i);
  const exported = exportTeam(manager, CASES.map(c => c.fingerprint));
  assert.equal(exported.publicationAuthorized, false);
  assert.equal(exported.certificate, false);
  assert.equal(restoreWorkspace(JSON.stringify(manager), RUN).projectId, manager.projectId);
  assert.equal(restoreWorkspace(JSON.stringify(manager), OTHER_RUN), null);
  assert.equal(restoreWorkspace('not json', RUN), null);
});

test('invalid verse ids never become a surah group', async () => {
  const {caseFromFinding} = await import('../public/modules/team-workflow.mjs');
  assert.equal(caseFromFinding({verseIds:['115:1'], severity:'high'}, fp(1)).surah, 0);
  assert.equal(caseFromFinding({verseIds:['2:255'], severity:'high'}, fp(1)).surah, 2);
  assert.equal(caseFromFinding({evidence:{surah:114}, severity:'low'}, fp(1)).surah, 114);
});

// Findings from the independent security review (2026-10-05).
function cycle() {
  let {ws:manager, sup, r1, r2} = team();
  manager = assignCases(manager, CASES).workspace;
  const own = Object.keys(manager.records).filter(f => manager.records[f].reviewerId === r1.id);
  let reviewer = acceptTask(roundTrip(buildTaskPackage(manager, r1.id).package), {runKey:RUN}).workspace;
  let supervisor = acceptTask(roundTrip(buildTaskPackage(manager, sup.id).package), {runKey:RUN}).workspace;
  return {manager, reviewer, supervisor, own, sup, r1, r2};
}

test('a case moved to another reviewer is not stuck with the old reviewer at the supervisor', () => {
  let {manager, reviewer, supervisor, own, sup, r2} = cycle();
  const sub = buildSubmission(reviewer, {[own[0]]:{decision:'reject', note:'سبب'}}, '2026-10-05T10:00:00.000Z');
  supervisor = acceptSubmission(supervisor, roundTrip(sub.package)).workspace;
  manager = assignCase(manager, {fingerprint:own[0], surah:1}, r2.id).workspace;
  supervisor = acceptTask(roundTrip(buildTaskPackage(manager, sup.id).package), {runKey:RUN, existing:supervisor}).workspace;
  assert.equal(supervisor.records[own[0]].reviewerId, r2.id);
  const other = acceptTask(roundTrip(buildTaskPackage(manager, r2.id).package), {runKey:RUN}).workspace;
  const sub2 = buildSubmission(other, {[own[0]]:{decision:'refer', note:'إحالة'}}, '2026-10-05T11:00:00.000Z');
  assert.equal(acceptSubmission(supervisor, roundTrip(sub2.package)).accepted, 1);
});

test('reopening an old submission does not erase a later return', () => {
  let {reviewer, supervisor, own} = cycle();
  const sub = buildSubmission(reviewer, {[own[0]]:{decision:'reject', note:'سبب'}}, '2026-10-05T10:00:00.000Z');
  supervisor = acceptSubmission(supervisor, roundTrip(sub.package)).workspace;
  supervisor = setVerdict(supervisor, own[0], 'returned', 'راجع', '2026-10-05T10:30:00.000Z').workspace;
  const again = acceptSubmission(supervisor, roundTrip(sub.package));
  assert.equal(again.skipped, 1);
  assert.equal(again.workspace.records[own[0]].stage, 'returned');
});

test('an old review file does not reopen a case the reviewer already resubmitted', () => {
  let {reviewer, supervisor, own} = cycle();
  let sub = buildSubmission(reviewer, {[own[0]]:{decision:'reject', note:'سبب'}}, '2026-10-05T10:00:00.000Z');
  reviewer = sub.workspace;
  supervisor = acceptSubmission(supervisor, roundTrip(sub.package)).workspace;
  supervisor = setVerdict(supervisor, own[0], 'returned', 'راجع', '2026-10-05T10:30:00.000Z').workspace;
  const review = roundTrip(buildReview(supervisor).package);
  reviewer = importPackage(reviewer, review, {runKey:RUN}).workspace;
  assert.equal(reviewer.records[own[0]].stage, 'returned');
  reviewer = buildSubmission(reviewer, {[own[0]]:{decision:'accept', note:'صححت'}}, '2026-10-05T11:00:00.000Z').workspace;
  const replay = importPackage(reviewer, review, {runKey:RUN});
  assert.equal(replay.skipped, 1);
  assert.equal(replay.workspace.records[own[0]].stage, 'submitted');
});

test('crafted values never throw; they are refused with a message', () => {
  const evil = JSON.stringify({format:'mihakk-team', version:1, kind:'submission', projectId:{toString:1}, runKey:RUN, from:{memberId:'manager'}, items:[]});
  assert.equal(parsePackage(evil).error.code, 'IDS');
  const evilFrom = JSON.stringify({format:'mihakk-team', version:1, kind:'submission', projectId:'0123456789abcdef', runKey:RUN, from:{memberId:{toString:1}}, items:[]});
  assert.equal(parsePackage(evilFrom).error.code, 'FROM');
  const badItems = JSON.stringify({format:'mihakk-team', version:1, kind:'submission', projectId:'0123456789abcdef', runKey:RUN, from:{memberId:'m-00000000'}, items:[null, 3]});
  assert.equal(parsePackage(badItems).error.code, 'SHAPE');
  const {ws} = team();
  const pkg = {format:'mihakk-team', version:1, kind:'review', projectId:ws.projectId, runKey:OTHER_RUN, runInfo:{scope:{type:{toString:1}}}, from:{memberId:'m-00000000'}, items:[]};
  assert.equal(importPackage(ws, pkg, {runKey:RUN}).error.code, 'RUN_MISMATCH');
});

test('closing a high-priority alert needs a supervisor reason', () => {
  let {reviewer, supervisor, own} = cycle();
  const high = own.find(f => ['high','critical'].includes(supervisor.records[f].severity));
  const sub = buildSubmission(reviewer, {[high]:{decision:'reject', note:'لا مشكلة'}}, '2026-10-05T10:00:00.000Z');
  supervisor = acceptSubmission(supervisor, roundTrip(sub.package)).workspace;
  assert.equal(setVerdict(supervisor, high, 'approved', '').error.code, 'NOTE_REQUIRED');
  assert.ok(setVerdict(supervisor, high, 'approved', 'راجعت النصين ولا تعارض').workspace);
});
