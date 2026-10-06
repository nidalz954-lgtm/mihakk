/**
 * Team review workflow (manager → reviewer → supervisor), DOM-free.
 * Exchange files carry fingerprints, stages and reviewer notes only — never translation or reference text.
 * Names are self-declared and files are unsigned: this records accountability, not authenticated identity.
 * Supervisor approval is a review step, never publication authorization.
 */
export const TEAM_FORMAT = 'mihakk-team';
export const TEAM_VERSION = 1;
export const WORKSPACE_SCHEMA = 'mihakk-team-workspace/1';
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
export const MAX_ITEMS = 20000;
export const MAX_MEMBERS = 50;
export const MANAGER_ID = 'manager';

export const ROLE_LABELS = {manager:'مدير', supervisor:'مشرف', reviewer:'مدقق'};
export const STAGES = ['unassigned','assigned','submitted','approved','returned'];
export const STAGE_LABELS = {unassigned:'غير موزعة', assigned:'عند المدقق', submitted:'بانتظار المشرف', approved:'وافق عليها المشرف', returned:'مُعادة للمدقق'};
export const STRATEGIES = {balanced:'توزيع متوازن حسب الأولوية', surah:'كل سورة لمدقق واحد'};

const DECISIONS = new Set(['accept','reject','refer']);
const VERDICTS = new Set(['approved','returned']);
const KINDS = new Set(['task','submission','review']);
const HEX64 = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[a-f0-9]{16}$/;
const MEMBER_ID = /^(manager|m-[a-f0-9]{8})$/;
const SEVERITY_RANK = {critical:0, high:1, medium:2, low:3, info:4};

const PERMISSIONS = {
  manager: new Set(['team.edit','assign','task.export','package.import','view.all','supervise.direct']),
  supervisor: new Set(['package.import','supervise','review.export','view.team']),
  reviewer: new Set(['decide','submission.export','view.own']),
};

/** Whether a role may perform an action. Unknown roles may do nothing. */
export function can(role, action) { return PERMISSIONS[role]?.has(action) === true; }

const fail = (code, message, extra = {}) => ({error:{code, message, ...extra}});

/** Single-line display text: strips control and bidi-override characters that could disguise a name. */
export function cleanName(value, max = 80) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Multi-line note: keeps line breaks, strips other control and bidi-override characters. */
export function cleanNote(value, max = 1000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
}
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const validTime = value => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
const timeOf = value => validTime(value) ? Date.parse(value) : -Infinity;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return [...values].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const activeMembers = (ws, role) => ws.members.filter(m => !m.removed && (!role || m.role === role));
const memberById = (ws, id) => id === MANAGER_ID ? {id:MANAGER_ID, name:ws.managerName, role:'manager'} : ws.members.find(m => m.id === id);
/** Reviewers whose submissions this workspace owner may judge. */
export function supervisedReviewers(ws) {
  if (ws.role === 'supervisor') return activeMembers(ws, 'reviewer').filter(m => m.supervisorId === ws.memberId);
  if (ws.role === 'manager') return activeMembers(ws, 'reviewer').filter(m => m.supervisorId === MANAGER_ID);
  return [];
}
const supervises = (ws, reviewerId) => supervisedReviewers(ws).some(m => m.id === reviewerId);

/** Case descriptor used for assignment: only structural and comparison findings need a human decision. */
export function caseFromFinding(finding, fingerprint) {
  const raw = Number(String(finding.verseIds?.[0] ?? '').split(':')[0]) || Number(finding.evidence?.surah) || 0;
  // Invalid verse ids (e.g. surah 115) are grouped as 'no surah', never as a surah.
  return {fingerprint, severity:finding.severity, surah:Number.isInteger(raw) && raw >= 1 && raw <= 114 ? raw : 0};
}
export const isTeamCase = finding => ['structural','comparison'].includes(finding?.type);

export function createManagerWorkspace({runKey, managerName, runInfo = {}, now = new Date().toISOString()}) {
  if (!HEX64.test(String(runKey))) return fail('NO_RUN', 'شغّل الفحص أولًا؛ الفريق يرتبط بنتيجة فحص محددة.');
  const name = cleanName(managerName);
  if (!name) return fail('NAME_REQUIRED', 'اكتب اسمك قبل إنشاء الفريق.');
  return {workspace:{schema:WORKSPACE_SCHEMA, projectId:randomHex(8), runKey, runInfo:sanitizeRunInfo(runInfo), role:'manager', memberId:MANAGER_ID, name, managerName:name, members:[], records:{}, createdAt:now}};
}

function sanitizeRunInfo(info) {
  if (!info || typeof info !== 'object') info = {};
  const scope = info?.scope && typeof info.scope === 'object' ? {type:cleanName(typeof info.scope.type === 'string' ? info.scope.type : '', 20), surahs:Array.isArray(info.scope.surahs) ? info.scope.surahs.filter(Number.isInteger).slice(0, 114) : undefined} : null;
  return {candidateName:cleanName(info?.candidateName ?? '', 160), candidateSha256:matches(HEX64, info?.candidateSha256) ? info.candidateSha256 : null, referenceTitle:cleanName(info?.referenceTitle ?? '', 160), analysis:cleanName(info?.analysis ?? '', 80), scope};
}

export function addMember(ws, {name, role, supervisorId = MANAGER_ID}) {
  if (!can(ws.role, 'team.edit')) return fail('FORBIDDEN', 'المدير وحده يضيف أعضاء الفريق.');
  const clean = cleanName(name);
  if (!clean) return fail('NAME_REQUIRED', 'اكتب اسم العضو.');
  if (!['reviewer','supervisor'].includes(role)) return fail('ROLE', 'اختر دور العضو: مدقق أو مشرف.');
  if (activeMembers(ws).length >= MAX_MEMBERS) return fail('LIMIT', `الحد ${MAX_MEMBERS} عضوًا في الفريق.`);
  const taken = [ws.managerName, ...activeMembers(ws).map(m => m.name)].some(existing => existing.toLocaleLowerCase() === clean.toLocaleLowerCase());
  if (taken) return fail('DUPLICATE', 'هذا الاسم مستعمل في الفريق. أضف ما يميزه حتى لا تختلط القرارات.');
  if (role === 'reviewer' && supervisorId !== MANAGER_ID && !activeMembers(ws, 'supervisor').some(m => m.id === supervisorId)) return fail('SUPERVISOR', 'اختر مشرفًا موجودًا في الفريق، أو المدير نفسه.');
  const member = {id:`m-${randomHex(4)}`, name:clean, role, supervisorId:role === 'reviewer' ? supervisorId : null};
  const next = structuredClone(ws);
  next.members.push(member);
  return {workspace:next, member};
}

/** Removing keeps the member for history; their open cases return to unassigned. Approved cases keep their record. */
export function removeMember(ws, memberId) {
  if (!can(ws.role, 'team.edit')) return fail('FORBIDDEN', 'المدير وحده يعدّل الفريق.');
  const member = ws.members.find(m => m.id === memberId && !m.removed);
  if (!member) return fail('NOT_FOUND', 'العضو غير موجود.');
  if (member.role === 'supervisor' && activeMembers(ws, 'reviewer').some(m => m.supervisorId === memberId)) return fail('HAS_REVIEWERS', 'لهذا المشرف مدققون. أزلهم أو انقلهم أولًا.');
  const next = structuredClone(ws);
  next.members.find(m => m.id === memberId).removed = true;
  let released = 0;
  for (const [fingerprint, record] of Object.entries(next.records)) {
    if (record.reviewerId === memberId && record.stage !== 'approved') { delete next.records[fingerprint]; released++; }
  }
  return {workspace:next, released};
}

export const stageOf = (ws, fingerprint) => ws?.records?.[fingerprint]?.stage ?? 'unassigned';

/**
 * Assigns unassigned cases among active reviewers.
 * balanced: highest severity first, each case to the least-loaded reviewer (equal mix of priorities).
 * surah: whole surahs stay with one reviewer, largest groups first.
 */
export function assignCases(ws, cases, {strategy = 'balanced'} = {}) {
  if (!can(ws.role, 'assign')) return fail('FORBIDDEN', 'المدير وحده يوزّع الحالات.');
  const reviewers = activeMembers(ws, 'reviewer');
  if (!reviewers.length) return fail('NO_REVIEWERS', 'أضف مدققًا واحدًا على الأقل قبل التوزيع.');
  if (!STRATEGIES[strategy]) return fail('STRATEGY', 'طريقة توزيع غير معروفة.');
  const pending = cases.filter(c => HEX64.test(c.fingerprint) && stageOf(ws, c.fingerprint) === 'unassigned');
  if (!pending.length) return fail('NOTHING', 'لا توجد حالات غير موزعة.');
  const next = structuredClone(ws);
  const load = new Map(reviewers.map(r => [r.id, 0]));
  for (const record of Object.values(next.records)) if (load.has(record.reviewerId) && record.stage !== 'approved') load.set(record.reviewerId, load.get(record.reviewerId) + 1);
  const lightest = () => reviewers.reduce((best, r) => load.get(r.id) < load.get(best.id) ? r : best, reviewers[0]);
  const give = (c, reviewer) => { next.records[c.fingerprint] = {stage:'assigned', reviewerId:reviewer.id, surah:Number.isInteger(c.surah) ? c.surah : 0, severity:c.severity}; load.set(reviewer.id, load.get(reviewer.id) + 1); };
  if (strategy === 'balanced') {
    const ordered = [...pending].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) || a.surah - b.surah || a.fingerprint.localeCompare(b.fingerprint));
    for (const c of ordered) give(c, lightest());
  } else {
    const groups = new Map();
    for (const c of pending) { const key = Number.isInteger(c.surah) ? c.surah : 0; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c); }
    const holder = surah => Object.values(next.records).find(r => r.surah === surah && surah && load.has(r.reviewerId))?.reviewerId;
    for (const [surah, group] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])) {
      const preferred = reviewers.find(r => r.id === holder(surah)) ?? lightest();
      for (const c of group) give(c, preferred);
    }
  }
  return {workspace:next, assigned:pending.length};
}

/** Manual (re)assignment. A case waiting for or holding a supervisor verdict cannot move. */
export function assignCase(ws, caseInfo, reviewerId) {
  if (!can(ws.role, 'assign')) return fail('FORBIDDEN', 'المدير وحده يوزّع الحالات.');
  const stage = stageOf(ws, caseInfo.fingerprint);
  if (['submitted','approved'].includes(stage)) return fail('LOCKED', 'الحالة عند المشرف أو معتمدة؛ لا تُنقل الآن.');
  const next = structuredClone(ws);
  if (!reviewerId) { delete next.records[caseInfo.fingerprint]; return {workspace:next}; }
  if (!activeMembers(ws, 'reviewer').some(m => m.id === reviewerId)) return fail('NOT_REVIEWER', 'اختر مدققًا من الفريق.');
  const previous = ws.records[caseInfo.fingerprint];
  next.records[caseInfo.fingerprint] = {stage:'assigned', reviewerId, surah:Number.isInteger(caseInfo.surah) ? caseInfo.surah : 0, severity:caseInfo.severity ?? previous?.severity, ...(previous?.reviewerId === reviewerId && previous.stage === 'returned' ? {stage:'returned', verdictNote:previous.verdictNote, verdictByName:previous.verdictByName} : {})};
  return {workspace:next};
}

/** Which cases this workspace owner should see. Without a team everything is visible. */
export function isVisible(ws, fingerprint) {
  if (!ws || ws.role === 'manager') return true;
  const record = ws.records[fingerprint];
  if (!record) return false;
  if (ws.role === 'reviewer') return record.reviewerId === ws.memberId;
  return supervises(ws, record.reviewerId);
}

/** Reviewer may edit an own case until it is submitted; it reopens only when returned. */
export function canDecide(ws, fingerprint) {
  if (!ws) return true;
  if (ws.role !== 'reviewer') return false;
  const record = ws.records[fingerprint];
  return record?.reviewerId === ws.memberId && ['assigned','returned'].includes(record.stage);
}

function envelope(ws, kind, now) {
  return {format:TEAM_FORMAT, version:TEAM_VERSION, kind, projectId:ws.projectId, runKey:ws.runKey, runInfo:ws.runInfo, createdAt:now, from:{memberId:ws.memberId, name:ws.name, role:ws.role}, managerName:ws.managerName,
    notice:'ملف عمل لفريق مراجعة. لا يحتوي نص الترجمة أو المرجع. الأسماء يكتبها أصحابها؛ موافقة المشرف مراجعة داخلية وليست إذن نشر.'};
}

/** Manager → member: team snapshot and the cases this member works on. */
export function buildTaskPackage(ws, memberId, now = new Date().toISOString()) {
  if (!can(ws.role, 'task.export')) return fail('FORBIDDEN', 'المدير وحده يصدر ملفات المهام.');
  const member = activeMembers(ws).find(m => m.id === memberId);
  if (!member) return fail('NOT_FOUND', 'العضو غير موجود في الفريق.');
  const reviewers = member.role === 'reviewer' ? [member] : activeMembers(ws, 'reviewer').filter(r => r.supervisorId === member.id);
  const ids = new Set(reviewers.map(r => r.id));
  const records = Object.fromEntries(Object.entries(ws.records).filter(([, r]) => ids.has(r.reviewerId)).map(([fp, r]) => [fp, member.role === 'reviewer' ? {stage:r.stage, reviewerId:r.reviewerId, surah:r.surah, ...(r.stage === 'returned' ? {verdictNote:r.verdictNote, verdictByName:r.verdictByName} : {})} : {...r}]));
  if (!Object.keys(records).length) return fail('EMPTY', member.role === 'reviewer' ? 'لم توزَّع حالات على هذا المدقق بعد.' : 'لا توجد حالات لمدققي هذا المشرف بعد.');
  const supervisor = member.role === 'reviewer' && member.supervisorId !== MANAGER_ID ? ws.members.find(m => m.id === member.supervisorId) : null;
  const members = [member, ...(supervisor ? [supervisor] : []), ...(member.role === 'supervisor' ? reviewers : [])].map(({id, name, role, supervisorId}) => ({id, name, role, supervisorId}));
  return {package:{...envelope(ws, 'task', now), to:{memberId:member.id, name:member.name, role:member.role, supervisorId:member.supervisorId}, members, records}};
}

/** Parses an exchange file with size, shape and identifier checks. Never trusts its content beyond that. */
export function parsePackage(text, byteLength = typeof text === 'string' ? new TextEncoder().encode(text).length : 0) {
  if (typeof text !== 'string' || !text.trim()) return fail('EMPTY_FILE', 'الملف فارغ.');
  if (byteLength > MAX_PACKAGE_BYTES) return fail('TOO_LARGE', 'ملف الفريق أكبر من 2 MB؛ هذا ليس ملف عمل من مِحَكّ.');
  let value;
  try { value = JSON.parse(text); } catch { return fail('INVALID_JSON', 'تعذّرت قراءة الملف؛ قد يكون تالفًا أو ليس ملف فريق من مِحَكّ.'); }
  if (!value || typeof value !== 'object' || value.format !== TEAM_FORMAT) return fail('NOT_TEAM_FILE', 'هذا ليس ملف فريق من مِحَكّ.');
  if (value.version !== TEAM_VERSION) return fail('VERSION', 'إصدار ملف الفريق غير مدعوم.');
  if (!KINDS.has(value.kind)) return fail('KIND', 'نوع ملف الفريق غير معروف.');
  if (!matches(PROJECT_ID, value.projectId) || !matches(HEX64, value.runKey)) return fail('IDS', 'معرّفات الملف غير صالحة.');
  if (!value.from || typeof value.from !== 'object' || !matches(MEMBER_ID, value.from.memberId)) return fail('FROM', 'مرسل الملف غير صالح.');
  const items = value.kind === 'task' ? Object.keys(value.records ?? {}) : value.items;
  if (value.kind === 'task' ? !value.records || typeof value.records !== 'object' || Array.isArray(value.records) : !Array.isArray(items)) return fail('SHAPE', 'محتوى الملف ناقص.');
  if (items.length > MAX_ITEMS) return fail('TOO_MANY', 'عدد الحالات في الملف يتجاوز الحد.');
  if (value.kind !== 'task' && !items.every(item => item && typeof item === 'object' && !Array.isArray(item))) return fail('SHAPE', 'محتوى الملف ناقص أو تالف.');
  return {value};
}

function runMismatch(pkg, runKey) {
  if (pkg.runKey === runKey) return null;
  const info = sanitizeRunInfo(pkg.runInfo);
  const scope = info.scope?.type === 'full' ? 'القرآن كاملًا' : info.scope?.type === 'selected' ? `سور: ${(info.scope.surahs ?? []).join('، ')}` : 'الصفوف المرفوعة';
  return fail('RUN_MISMATCH', `هذا الملف لفحص مختلف. افتح الملف «${info.candidateName || 'غير مسمى'}»${info.candidateSha256 ? ` (بصمته تبدأ ${info.candidateSha256.slice(0, 12)})` : ''} بنطاق «${scope}» ومرجع «${info.referenceTitle || 'بلا مرجع'}» وطريقة «${info.analysis || 'غير مسجلة'}»، ثم أعد الفحص وافتح الملف.`, {runInfo:info});
}

function validMember(m) {
  return m && typeof m === 'object' && matches(MEMBER_ID, m.id) && m.id !== MANAGER_ID && ['reviewer','supervisor'].includes(m.role) && cleanName(m.name) && (m.role === 'supervisor' ? m.supervisorId == null : matches(MEMBER_ID, m.supervisorId));
}

/** Member opens a task from the manager. Keeps local progress that the manager has not seen yet. */
export function acceptTask(pkg, {runKey, existing = null}) {
  if (pkg.kind !== 'task') return fail('KIND', 'هذا ليس ملف مهمة من المدير.');
  const mismatch = runMismatch(pkg, runKey); if (mismatch) return mismatch;
  if (pkg.from.memberId !== MANAGER_ID) return fail('FROM', 'ملف المهمة يصدر من المدير فقط.');
  const members = Array.isArray(pkg.members) ? pkg.members.slice(0, MAX_MEMBERS) : [];
  if (!members.every(validMember)) return fail('MEMBERS', 'قائمة الفريق في الملف غير صالحة.');
  const to = members.find(m => m.id === pkg.to?.memberId);
  if (!to || to.role !== pkg.to.role) return fail('TO', 'الملف لا يحدد عضوًا صالحًا.');
  const clean = members.map(m => ({id:m.id, name:cleanName(m.name), role:m.role, supervisorId:m.role === 'reviewer' ? m.supervisorId : null}));
  const ws = {schema:WORKSPACE_SCHEMA, projectId:pkg.projectId, runKey, runInfo:sanitizeRunInfo(pkg.runInfo), role:to.role, memberId:to.id, name:cleanName(to.name), managerName:cleanName(pkg.managerName) || 'المدير', members:clean, records:{}, createdAt:validTime(pkg.createdAt) ? pkg.createdAt : null};
  const allowed = new Set(to.role === 'reviewer' ? [to.id] : clean.filter(m => m.role === 'reviewer' && m.supervisorId === to.id).map(m => m.id));
  for (const [fingerprint, record] of Object.entries(pkg.records)) {
    if (!HEX64.test(fingerprint) || !record || typeof record !== 'object' || !allowed.has(record.reviewerId) || !STAGES.includes(record.stage) || record.stage === 'unassigned') return fail('RECORDS', 'في الملف حالة لا تخص هذا العضو؛ لم يُطبق الملف.');
    ws.records[fingerprint] = {stage:record.stage, reviewerId:record.reviewerId, surah:Number.isInteger(record.surah) ? record.surah : 0, ...(typeof record.severity === 'string' ? {severity:record.severity.slice(0, 12)} : {})};
    if (record.stage === 'returned') Object.assign(ws.records[fingerprint], {verdictNote:cleanNote(record.verdictNote), verdictByName:cleanName(record.verdictByName ?? ''), verdictAt:validTime(record.verdictAt) ? record.verdictAt : null});
    if (to.role === 'supervisor' && DECISIONS.has(record.decision)) Object.assign(ws.records[fingerprint], {decision:record.decision, note:cleanNote(record.note), decidedAt:validTime(record.decidedAt) ? record.decidedAt : null, reviewerName:cleanName(record.reviewerName ?? ''), ...(VERDICTS.has(record.verdict) ? {verdict:record.verdict, verdictNote:cleanNote(record.verdictNote), verdictBy:matches(MEMBER_ID, record.verdictBy) ? record.verdictBy : null, verdictByName:cleanName(record.verdictByName ?? ''), verdictAt:validTime(record.verdictAt) ? record.verdictAt : null} : {})});
  }
  if (existing && existing.projectId === ws.projectId && existing.memberId === ws.memberId) {
    for (const [fingerprint, local] of Object.entries(existing.records ?? {})) {
      const incoming = ws.records[fingerprint];
      if (!incoming) continue;
      // The manager has not received the submission yet: keep it locked as submitted.
      if (to.role === 'reviewer' && local.stage === 'submitted' && incoming.stage === 'assigned') incoming.stage = 'submitted';
      // A supervisor keeps own verdicts and received submissions the manager does not know yet.
      if (to.role === 'supervisor' && local.reviewerId === incoming.reviewerId && ['submitted','approved','returned'].includes(local.stage) && local.decision && !(incoming.decision && incoming.verdictAt && local.verdictAt && incoming.verdictAt >= local.verdictAt)) ws.records[fingerprint] = {...incoming, ...local};
    }
  }
  return {workspace:ws, replaced:Boolean(existing && existing.projectId !== ws.projectId)};
}

/** Reviewer → supervisor: decisions on own open cases. Marks them submitted locally. */
export function buildSubmission(ws, decisionsByFingerprint, now = new Date().toISOString()) {
  if (!can(ws.role, 'submission.export')) return fail('FORBIDDEN', 'المدقق وحده يسلّم قراراته.');
  const items = [];
  for (const [fingerprint, record] of Object.entries(ws.records)) {
    if (record.reviewerId !== ws.memberId || !['assigned','returned'].includes(record.stage)) continue;
    const decision = decisionsByFingerprint[fingerprint];
    const note = cleanNote(decision?.note);
    if (!DECISIONS.has(decision?.decision) || !note) continue;
    items.push({fingerprint, decision:decision.decision, note, decidedAt:validTime(decision.savedAt) ? decision.savedAt : now});
  }
  if (!items.length) return fail('NOTHING', 'لا توجد قرارات جديدة جاهزة للتسليم. افتح حالاتك وسجّل القرار والسبب أولًا.');
  const next = structuredClone(ws);
  for (const item of items) Object.assign(next.records[item.fingerprint], {stage:'submitted', submittedAt:now});
  const member = ws.members.find(m => m.id === ws.memberId);
  return {workspace:next, package:{...envelope(ws, 'submission', now), supervisorId:member?.supervisorId ?? MANAGER_ID, items}, count:items.length};
}

/** Supervisor (or manager for directly supervised reviewers) receives a reviewer submission. */
export function acceptSubmission(ws, pkg, now = new Date().toISOString()) {
  if (pkg.kind !== 'submission') return fail('KIND', 'هذا ليس ملف تسليم من مدقق.');
  if (!can(ws.role, 'supervise') && !can(ws.role, 'supervise.direct')) return fail('FORBIDDEN', 'يستلم التسليمات المشرف أو المدير.');
  if (pkg.projectId !== ws.projectId) return fail('PROJECT', 'هذا التسليم لفريق آخر.');
  const mismatch = runMismatch(pkg, ws.runKey); if (mismatch) return mismatch;
  if (pkg.from.memberId === ws.memberId) return fail('SELF_REVIEW', 'لا يعتمد أحد قراره بنفسه.');
  const reviewer = activeMembers(ws, 'reviewer').find(m => m.id === pkg.from.memberId);
  if (!reviewer) return fail('NOT_REVIEWER', 'مرسل الملف ليس مدققًا في هذا الفريق.');
  if (!supervises(ws, reviewer.id)) return fail('NOT_YOURS', ws.role === 'manager' ? `المدقق ${reviewer.name} تابع لمشرف؛ يُرسل تسليمه إلى مشرفه.` : `المدقق ${reviewer.name} ليس تابعًا لك.`);
  const next = structuredClone(ws);
  const rejected = [];
  let accepted = 0, skipped = 0;
  for (const item of pkg.items) {
    const fingerprint = item?.fingerprint;
    const record = HEX64.test(String(fingerprint)) ? next.records[fingerprint] : null;
    if (!record || record.reviewerId !== reviewer.id) { rejected.push({fingerprint, reason:'حالة غير موزعة لهذا المدقق'}); continue; }
    const note = cleanNote(item.note);
    if (!DECISIONS.has(item.decision) || !note) { rejected.push({fingerprint, reason:'قرار أو سبب غير صالح'}); continue; }
    // Reopening the same or an older file never undoes a later submission or verdict.
    // Compares times from the same reviewer's clock only, so device clock skew cannot block a real resubmission.
    if (record.stage === 'approved' || timeOf(pkg.createdAt) <= timeOf(record.submittedAt)) { skipped++; continue; }
    next.records[fingerprint] = {stage:'submitted', reviewerId:reviewer.id, surah:record.surah ?? 0, severity:record.severity, decision:item.decision, note, decidedAt:validTime(item.decidedAt) ? item.decidedAt : now, reviewerName:reviewer.name, receivedAt:now, submittedAt:validTime(pkg.createdAt) ? pkg.createdAt : now};
    accepted++;
  }
  return {workspace:next, accepted, skipped, rejected, reviewerName:reviewer.name};
}

/** Supervisor verdict on a received decision. A return requires a note for the reviewer. */
export function setVerdict(ws, fingerprint, verdict, note, now = new Date().toISOString()) {
  if (!can(ws.role, 'supervise') && !can(ws.role, 'supervise.direct')) return fail('FORBIDDEN', 'الموافقة أو الإعادة للمشرف.');
  const record = ws.records[fingerprint];
  if (!record || !supervises(ws, record.reviewerId)) return fail('NOT_YOURS', 'هذه الحالة ليست لأحد مدققيك.');
  if (!['submitted','approved','returned'].includes(record.stage) || !DECISIONS.has(record.decision)) return fail('NO_DECISION', 'لم يصل قرار المدقق لهذه الحالة بعد.');
  if (!VERDICTS.has(verdict)) return fail('VERDICT', 'اختر اعتمادًا أو إعادة.');
  const clean = cleanNote(note);
  if (verdict === 'returned' && !clean) return fail('NOTE_REQUIRED', 'اكتب ملاحظة للمدقق توضح سبب الإعادة.');
  if (verdict === 'approved' && record.decision === 'reject' && ['high','critical'].includes(record.severity) && !clean) return fail('NOTE_REQUIRED', 'إغلاق تنبيه عالي الأولوية يحتاج سببًا منك أيضًا، لا موافقة صامتة.');
  const next = structuredClone(ws);
  Object.assign(next.records[fingerprint], {stage:verdict, verdict, verdictNote:clean, verdictBy:ws.memberId, verdictByName:ws.name, verdictAt:now});
  return {workspace:next};
}

/** Supervisor → manager: decisions with verdicts. */
export function buildReview(ws, now = new Date().toISOString()) {
  if (!can(ws.role, 'review.export')) return fail('FORBIDDEN', 'المشرف وحده يصدر ملف الاعتماد.');
  const items = Object.entries(ws.records).filter(([, r]) => VERDICTS.has(r.verdict) && r.stage === r.verdict && supervises(ws, r.reviewerId)).map(([fingerprint, r]) => ({fingerprint, reviewerId:r.reviewerId, decision:r.decision, note:r.note, decidedAt:r.decidedAt, verdict:r.verdict, verdictNote:r.verdictNote ?? '', verdictAt:r.verdictAt}));
  if (!items.length) return fail('NOTHING', 'لا توجد أحكام لتسليمها للمدير بعد. اعتمد أو أعد حالة واحدة على الأقل.');
  return {package:{...envelope(ws, 'review', now), items}, count:items.length};
}

/** Manager merges a supervisor's verdicts. Older verdicts never overwrite newer ones. */
export function mergeReview(ws, pkg) {
  if (pkg.kind !== 'review') return fail('KIND', 'هذا ليس ملف اعتماد من مشرف.');
  if (!can(ws.role, 'package.import') || ws.role !== 'manager') return fail('FORBIDDEN', 'المدير وحده يدمج ملفات الاعتماد.');
  if (pkg.projectId !== ws.projectId) return fail('PROJECT', 'ملف الاعتماد لفريق آخر.');
  const mismatch = runMismatch(pkg, ws.runKey); if (mismatch) return mismatch;
  const supervisor = activeMembers(ws, 'supervisor').find(m => m.id === pkg.from.memberId);
  if (!supervisor) return fail('NOT_SUPERVISOR', 'مرسل الملف ليس مشرفًا في هذا الفريق.');
  const next = structuredClone(ws);
  const rejected = [];
  let accepted = 0, skipped = 0;
  for (const item of pkg.items) {
    const fingerprint = item?.fingerprint;
    const record = HEX64.test(String(fingerprint)) ? next.records[fingerprint] : null;
    const reviewer = record && activeMembers(ws, 'reviewer').find(m => m.id === record.reviewerId);
    if (!record || item.reviewerId !== record.reviewerId || !reviewer) { rejected.push({fingerprint, reason:'الحالة غير موزعة لهذا المدقق'}); continue; }
    if (reviewer.supervisorId !== supervisor.id) { rejected.push({fingerprint, reason:'المدقق ليس تابعًا لهذا المشرف'}); continue; }
    const note = cleanNote(item.note), verdictNote = cleanNote(item.verdictNote);
    if (!DECISIONS.has(item.decision) || !note || !VERDICTS.has(item.verdict) || (item.verdict === 'returned' && !verdictNote) || !validTime(item.verdictAt)) { rejected.push({fingerprint, reason:'قرار أو حكم غير صالح'}); continue; }
    if (item.verdict === 'approved' && item.decision === 'reject' && ['high','critical'].includes(record.severity) && !verdictNote) { rejected.push({fingerprint, reason:'إغلاق تنبيه عالي الأولوية يحتاج سبب المشرف'}); continue; }
    if (timeOf(record.verdictAt) > timeOf(item.verdictAt)) { skipped++; continue; }
    next.records[fingerprint] = {stage:item.verdict, reviewerId:record.reviewerId, surah:record.surah ?? 0, severity:record.severity, decision:item.decision, note, decidedAt:validTime(item.decidedAt) ? item.decidedAt : null, reviewerName:reviewer.name, verdict:item.verdict, verdictNote, verdictBy:supervisor.id, verdictByName:supervisor.name, verdictAt:item.verdictAt};
    accepted++;
  }
  return {workspace:next, accepted, skipped, rejected, supervisorName:supervisor.name};
}

/** Reviewer reads the verdicts of their own supervisor: returned cases reopen, approved cases stay locked. */
export function applyReviewToReviewer(ws, pkg) {
  if (pkg.kind !== 'review' || ws.role !== 'reviewer') return fail('KIND', 'هذا ليس ملف اعتماد من مشرفك.');
  if (pkg.projectId !== ws.projectId) return fail('PROJECT', 'ملف الاعتماد لفريق آخر.');
  const mismatch = runMismatch(pkg, ws.runKey); if (mismatch) return mismatch;
  const me = ws.members.find(m => m.id === ws.memberId);
  if (!me || pkg.from.memberId !== me.supervisorId) return fail('NOT_YOUR_SUPERVISOR', 'هذا الملف ليس من مشرفك.');
  const next = structuredClone(ws);
  let accepted = 0, skipped = 0;
  for (const item of pkg.items) {
    if (item?.reviewerId !== ws.memberId) { skipped++; continue; }
    const record = HEX64.test(String(item.fingerprint)) ? next.records[item.fingerprint] : null;
    if (!record || !VERDICTS.has(item.verdict) || (item.verdict === 'returned' && !cleanNote(item.verdictNote)) || !validTime(item.verdictAt)) { skipped++; continue; }
    // Same-clock comparison: a verdict not newer than the one already applied changes nothing.
    if (timeOf(item.verdictAt) <= timeOf(record.verdictAt)) { skipped++; continue; }
    Object.assign(record, {stage:item.verdict, verdictNote:cleanNote(item.verdictNote), verdictByName:cleanName(pkg.from.name ?? ''), verdictAt:item.verdictAt});
    accepted++;
  }
  return {workspace:next, accepted, skipped, rejected:[]};
}

/** Routes any exchange file to the action allowed for this role. */
export function importPackage(ws, pkg, {runKey, now} = {}) {
  if (pkg.kind === 'task') return acceptTask(pkg, {runKey, existing:ws});
  if (!ws) return fail('NO_TEAM', 'افتح ملف المهمة من المدير أولًا.');
  if (pkg.kind === 'submission') return acceptSubmission(ws, pkg, now);
  if (pkg.kind === 'review') return ws.role === 'reviewer' ? applyReviewToReviewer(ws, pkg) : mergeReview(ws, pkg);
  return fail('KIND', 'نوع ملف غير معروف.');
}

/** Stage counts over the given case fingerprints, plus per-member load. */
export function teamSummary(ws, fingerprints) {
  const stages = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  const visible = fingerprints.filter(fp => isVisible(ws, fp));
  for (const fp of visible) stages[stageOf(ws, fp)]++;
  const members = ws.members.filter(m => !m.removed).map(m => {
    const own = Object.values(ws.records).filter(r => m.role === 'reviewer' ? r.reviewerId === m.id : ws.members.some(x => x.id === r.reviewerId && x.supervisorId === m.id));
    return {id:m.id, name:m.name, role:m.role, supervisorId:m.supervisorId, total:own.length, approved:own.filter(r => r.stage === 'approved').length, submitted:own.filter(r => r.stage === 'submitted').length, returned:own.filter(r => r.stage === 'returned').length};
  });
  return {total:visible.length, stages, members};
}

/** Decisions that count toward the final dossier: supervisor-approved only. */
export function approvedDecisions(ws) {
  return Object.fromEntries(Object.entries(ws.records).filter(([, r]) => r.stage === 'approved' && DECISIONS.has(r.decision)).map(([fp, r]) => [fp, {decision:r.decision, note:r.note, savedAt:r.decidedAt, reviewerName:r.reviewerName, approvedBy:r.verdictByName, approvedAt:r.verdictAt}]));
}

/** Restores a stored workspace, rejecting anything malformed or for another run. */
export function restoreWorkspace(text, runKey) {
  try {
    if (typeof text !== 'string' || text.length > MAX_PACKAGE_BYTES * 2) return null;
    const ws = JSON.parse(text);
    if (ws?.schema !== WORKSPACE_SCHEMA || ws.runKey !== runKey || !PROJECT_ID.test(ws.projectId) || !['manager','supervisor','reviewer'].includes(ws.role) || !Array.isArray(ws.members) || !ws.records || typeof ws.records !== 'object') return null;
    return ws;
  } catch { return null; }
}

/** Export summary embedded in the JSON report. */
export function exportTeam(ws, fingerprints) {
  if (!ws) return null;
  const summary = teamSummary(ws, fingerprints);
  return {schema:'mihakk-team-review/1', projectId:ws.projectId, viewerRole:ws.role, viewerName:ws.name, managerName:ws.managerName, members:summary.members, stages:summary.stages, total:summary.total,
    records:Object.fromEntries(Object.entries(ws.records).map(([fp, r]) => [fp, {stage:r.stage, reviewerName:r.reviewerName ?? memberById(ws, r.reviewerId)?.name ?? null, decision:r.decision ?? null, note:r.note ?? null, verdictByName:r.verdictByName ?? null, verdictNote:r.verdictNote ?? null, verdictAt:r.verdictAt ?? null}])),
    identityNote:'Names are self-declared; exchange files are unsigned. Supervisor approval is an internal review step.', publicationAuthorized:false, certificate:false};
}
