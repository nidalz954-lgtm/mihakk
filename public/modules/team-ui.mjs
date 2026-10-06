import {
  ROLE_LABELS, STAGES, STAGE_LABELS, STRATEGIES, MANAGER_ID, createManagerWorkspace, addMember, removeMember, assignCases, assignCase,
  isVisible, canDecide, buildTaskPackage, parsePackage, importPackage, buildSubmission, setVerdict, buildReview,
  teamSummary, approvedDecisions, restoreWorkspace, exportTeam, caseFromFinding, isTeamCase, supervisedReviewers, stageOf, cleanName,
} from './team-workflow.mjs';

/** First-strong isolation so Latin names, digits or brackets never reorder the Arabic sentence. */
const iso = value => `\u2068${value}\u2069`;

const decisionLabels = {accept:'تحتاج تصحيحًا', reject:'أغلق المراجع التنبيه', refer:'إحالة لمتخصص'};
const make = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = String(text); if (cls) el.className = cls; return el; };
const add = (parent, tag, text, cls) => { const el = make(tag, text, cls); parent.append(el); return el; };
const el = id => document.getElementById(id);
const formatter = new Intl.NumberFormat('ar');
const number = value => formatter.format(Number(value) || 0);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const safeFile = name => String(name).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'member';

function button(parent, text, cls = 'button secondary', id) { const b = add(parent, 'button', text, cls); b.type = 'button'; if (id) b.id = id; return b; }
function fileInput(parent, label, id, multiple = false) {
  const wrap = add(parent, 'label', null, 'team-file');
  wrap.htmlFor = id;
  add(wrap, 'span', label);
  const input = add(wrap, 'input'); input.type = 'file'; input.id = id; input.accept = '.json,application/json'; input.multiple = multiple;
  return input;
}

/** Team panel for step 3. All state changes go through team-workflow.mjs and are persisted per run. */
/** Show a validation message next to the field and link it for assistive technology. */
function markInvalid(input, message) {
  const id = (input.id || 'team-field') + '-error';
  let note = document.getElementById(id);
  if (!note) { note = document.createElement('p'); note.className = 'field-error'; note.id = id; note.setAttribute('role', 'alert'); const holder = input.closest('.field'); if (holder) holder.append(note); else input.after(note); }
  note.textContent = message; input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', id); input.focus();
  input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); note.remove(); }, {once:true});
}
export function createTeamWorkspace({getState, notify, download, onChange}) {
  let ws = null, runKey = '', runInfo = {}, pendingOnly = false, activeFingerprint = null, lastResult = '', lastError = false, pendingTask = null;
  const PREVIEW_KEY = 'mihakk:team-preview:v1';
  let preview = false;
  try { preview = localStorage.getItem(PREVIEW_KEY) === 'on'; } catch { preview = false; }
  function setPreview(on) {
    preview = on;
    try { on ? localStorage.setItem(PREVIEW_KEY, 'on') : localStorage.removeItem(PREVIEW_KEY); } catch { /* Per-page only without storage. */ }
    early.hidden = !preview;
    render();
    el('team-title')?.focus({preventScroll:true});
  }
  const panel = make('section', null, 'card team-card'); panel.id = 'team-panel'; panel.setAttribute('aria-labelledby', 'team-title'); panel.hidden = true;
  // Below the case list on every screen size, so the first cases stay visible at the jury's 1280x720.
  el('step-3').querySelector('.results-card').after(panel);
  const chip = make('span', null, 'team-role-chip'); chip.id = 'team-role-chip'; chip.hidden = true;
  document.querySelector('.header-actions').prepend(chip);
  const content = make('div'); panel.append(content);
  // One persistent live region: re-created regions are often not announced by screen readers.
  const result = make('p', '', 'team-result'); result.id = 'team-result'; result.setAttribute('aria-live', 'polite'); panel.append(result);

  // Step 1 entry for members: open the task first, see exactly which file and settings to use.
  const early = make('section', null, 'card team-early'); early.id = 'team-early';
  add(early, 'h2', 'وصلك ملف مهمة من مدير فريق؟');
  add(early, 'p', 'افتحه هنا أولًا. سنعرض لك الملف والإعدادات المطلوبة، ثم يُطبق تلقائيًا بعد الفحص.', 'team-note');
  const earlyInput = fileInput(early, 'فتح ملف المهمة', 'team-task-early');
  const earlyInfo = add(early, 'div', null, 'team-early-info'); earlyInfo.id = 'team-early-info'; earlyInfo.setAttribute('aria-live', 'polite');
  el('step-1').querySelector('.intake-guide')?.append(early);
  early.hidden = !preview;
  earlyInput.onchange = async () => {
    const file = earlyInput.files[0]; earlyInput.value = ''; earlyInfo.replaceChildren();
    if (!file) return;
    let parsed;
    try { parsed = file.size > 2 * 1024 * 1024 ? {error:{message:'ملف الفريق أكبر من 2 MB.'}} : parsePackage(await file.text(), file.size); }
    catch { parsed = {error:{message:'تعذّرت قراءة الملف.'}}; }
    if (!parsed.error && parsed.value.kind !== 'task') parsed = {error:{message:'هذا ليس ملف مهمة. ملفات التسليم والموافقة تُفتح من لوحة الفريق بعد الفحص.'}};
    if (parsed.error) { add(earlyInfo, 'p', `${file.name}: ${parsed.error.message}`, 'parse-warning'); return; }
    pendingTask = parsed.value;
    const info = pendingTask.runInfo ?? {}, scope = info.scope ?? {};
    add(earlyInfo, 'strong', `ملف مهمة لـ${iso(cleanName(pendingTask.to?.name ?? '—'))} من ${iso(cleanName(pendingTask.managerName ?? 'المدير'))}`);
    const list = add(earlyInfo, 'ul');
    add(list, 'li', `الملف: ${iso(cleanName(info.candidateName ?? '') || 'غير مسمى')}`);
    if (typeof info.candidateSha256 === 'string') { const li = add(list, 'li', 'بصمته تبدأ: '); add(li, 'bdi', info.candidateSha256.slice(0, 12)).dir = 'ltr'; }
    add(list, 'li', `النطاق: ${scope.type === 'full' ? 'القرآن كاملًا' : scope.type === 'selected' ? `سور ${(scope.surahs ?? []).join('، ')}` : 'الصفوف المرفوعة فقط'}`);
    add(list, 'li', `المرجع: ${iso(cleanName(info.referenceTitle ?? '') || 'بلا مرجع')}`);
    add(list, 'li', `طريقة الفحص: ${/context/.test(info.analysis) ? 'مع المؤشر السياقي' : /embedding/.test(info.analysis) ? 'مع نموذج التشابه' : 'بنية وفروق لفظية بلا نموذج'}`);
    add(earlyInfo, 'p', 'ارفع هذا الملف بالإعدادات نفسها وشغّل الفحص؛ تُفتح مهمتك تلقائيًا في قائمة المراجعة.', 'field-hint');
    if (runKey) applyPending();
  };
  function applyPending() {
    if (!pendingTask || !runKey) return;
    const task = pendingTask;
    if (ws?.role === 'manager') { pendingTask = null; lastResult = 'أنت المدير في هذا المتصفح. ملف المهمة يُفتح في متصفح العضو.'; lastError = true; render(); return; }
    const outcome = importPackage(ws, task, {runKey});
    if (outcome.error?.code === 'RUN_MISMATCH') { lastResult = outcome.error.message; lastError = true; render(); notify(outcome.error.message, true); return; }
    pendingTask = null;
    show(outcome, r => `فُتح ملف المهمة. دورك: ${ROLE_LABELS[r.workspace.role]} (${iso(r.workspace.name)}). عدد الحالات الظاهرة لك: ${number(Object.keys(r.workspace.records).length)}.`);
  }

  const storageKey = () => `mihakk:team:v1:${runKey}`;
  const fingerprintOf = finding => getState().decisionFingerprints?.[finding.id];
  const cases = () => (getState().report?.findings ?? []).filter(isTeamCase).map(f => ({finding:f, fingerprint:fingerprintOf(f)})).filter(c => c.fingerprint);
  const caseFingerprints = () => cases().map(c => c.fingerprint);
  const memberName = id => id === MANAGER_ID ? ws.managerName : ws.members.find(m => m.id === id)?.name ?? '—';

  function persist() {
    if (!runKey) return;
    try { ws ? localStorage.setItem(storageKey(), JSON.stringify(ws)) : localStorage.removeItem(storageKey()); }
    catch { lastResult = 'التخزين المحلي غير متاح؛ عمل الفريق محفوظ لهذه الصفحة فقط. نزّل ملفاتك قبل الإغلاق.'; }
  }
  function commit(next, message, error = false) {
    if (next) ws = next;
    persist();
    if (message != null) { lastResult = message; lastError = error; }
    render();
    onChange();
    if (message) notify(message, error);
  }
  function show(result, success) {
    if (result.error) { lastResult = result.error.message; lastError = true; render(); notify(result.error.message, true); return false; }
    commit(result.workspace, success(result));
    return true;
  }
  const save = (filename, value) => download(filename, JSON.stringify(value, null, 2), 'application/json;charset=utf-8');

  async function readPackages(input) {
    const files = [...input.files]; input.value = '';
    for (const file of files) {
      try { await readPackage(file); }
      catch { lastResult = `${file.name}: تعذّرت معالجة الملف؛ لم يتغير شيء.`; lastError = true; notify(lastResult, true); render(); }
    }
  }
  async function readPackage(file) {
    {
      if (file.size > 2 * 1024 * 1024) { lastResult = `${file.name}: ملف الفريق أكبر من 2 MB.`; lastError = true; notify(lastResult, true); render(); return; }
      const parsed = parsePackage(await file.text(), file.size);
      if (parsed.error) { lastResult = `${file.name}: ${parsed.error.message}`; lastError = true; notify(lastResult, true); render(); return; }
      if (parsed.value.kind === 'task' && ws && ws.projectId !== parsed.value.projectId && !confirm('ملف المهمة لفريق آخر. سيُستبدل عمل الفريق الحالي في هذا المتصفح. متابعة؟')) return;
      if (parsed.value.kind === 'task' && ws && ws.role !== 'manager' && ws.projectId === parsed.value.projectId && ws.memberId !== parsed.value.to?.memberId && !confirm(`ملف المهمة هذا لعضو آخر (${cleanName(parsed.value.to?.name ?? '—')}). سيتغير دورك في هذا المتصفح. متابعة؟`)) return;
      if (parsed.value.kind === 'task' && ws?.role === 'manager') { lastResult = 'أنت المدير في هذا المتصفح. ملف المهمة يُفتح في متصفح العضو.'; lastError = true; notify(lastResult, true); render(); return; }
      const result = importPackage(ws, parsed.value, {runKey});
      show(result, r => {
        if (parsed.value.kind === 'task') return `فُتح ملف المهمة. دورك: ${ROLE_LABELS[r.workspace.role]} (${iso(r.workspace.name)}). عدد الحالات الظاهرة لك: ${number(Object.keys(r.workspace.records).length)}.`;
        const rejected = r.rejected?.length ? ` المرفوض: ${number(r.rejected.length)} (${[...new Set(r.rejected.map(x => x.reason))].join('، ')}).` : '';
        const skipped = r.skipped ? ` المتروك: ${number(r.skipped)} (وافق عليه المشرف سابقًا، أو ملف أقدم من المسجل).` : '';
        return `${file.name}: عدد الحالات المقبولة ${number(r.accepted)}.${rejected}${skipped}`;
      });
    }
  }

  function stageBar(parent, summary) {
    const bar = add(parent, 'div', null, 'team-stages'); bar.id = 'team-summary';
    for (const stage of STAGES) {
      const item = add(bar, 'div', null, 'team-stage'); item.dataset.stage = stage;
      add(item, 'strong', number(summary.stages[stage]));
      add(item, 'span', STAGE_LABELS[stage]);
    }
    const track = add(parent, 'div', null, 'team-progress'); track.setAttribute('aria-hidden', 'true');
    for (const stage of STAGES) { const part = add(track, 'i'); part.dataset.stage = stage; part.style.flexGrow = String(summary.stages[stage]); }
  }

  /** Collapsed roadmap card: visible work, not active until the person opts into the preview. */
  function renderRoadmap() {
    const panel = content;
    const head = add(panel, 'div', null, 'team-roadmap-head');
    const title = add(head, 'h2', 'فريق المراجعة'); title.id = 'team-title'; title.tabIndex = -1;
    add(head, 'span', 'المرحلة الثانية من التطوير · غير مفعّلة افتراضيًا', 'team-stage-tag');
    add(panel, 'p', 'للجهات التي تراجع كفريق: المدير يوزّع الحالات، المدقق يقرر في حالاته فقط، المشرف يوافق أو يعيد مع ملاحظة. العمل الفردي الحالي لا يتغير.', 'team-note');
    const open = button(panel, 'تفعيل المعاينة التجريبية', 'button plain small', 'team-preview-on');
    open.onclick = () => setPreview(true);
    add(panel, 'p', 'معاينة تعمل على هذا الجهاز ومختبرة آليًا، ولم تُجرَّب بعد مع فريق حقيقي.', 'field-hint');
  }

  function renderNone() {
    const panel = content;
    const title = add(panel, 'h2', 'فريق المراجعة'); title.id = 'team-title'; title.tabIndex = -1;
    add(panel, 'span', 'معاينة تجريبية · المرحلة الثانية', 'team-stage-tag');
    add(panel, 'p', 'تعمل وحدك الآن. للعمل كفريق: المدير يوزّع الحالات، المدقق يقرر، المشرف يوافق أو يعيد. تنتقل بينكم ملفات صغيرة لا تحتوي نص الترجمة.', 'team-note');
    const row = add(panel, 'div', null, 'team-start'); row.id = 'team-start';
    const field = add(row, 'div', null, 'field');
    add(field, 'label', 'اسمك').htmlFor = 'team-my-name';
    const name = add(field, 'input'); name.id = 'team-my-name'; name.maxLength = 80; name.placeholder = 'كما سيظهر لفريقك';
    button(row, 'أنشئ فريقًا كمدير', 'button secondary', 'team-create').onclick = () => {
      const result = createManagerWorkspace({runKey, managerName:name.value, runInfo});
      if (result.error) { notify(result.error.message, true); markInvalid(name, result.error.message); return; }
      commit(result.workspace, 'أُنشئ الفريق. أضف المدققين والمشرفين ثم وزّع الحالات.');
    };
    const input = fileInput(row, 'فتح ملف مهمة من المدير', 'team-task-file');
    input.onchange = () => readPackages(input);
    add(panel, 'p', 'الأسماء يكتبها أصحابها ولا تثبت هوية. موافقة المشرف خطوة مراجعة داخلية، وليست إذن نشر.', 'field-hint');
    button(panel, 'إخفاء المعاينة', 'text-button', 'team-preview-off').onclick = () => setPreview(false);
  }

  function identity(text) {
    const panel = content;
    const head = add(panel, 'div', null, 'team-identity');
    const title = add(head, 'h2', 'فريق المراجعة'); title.id = 'team-title'; title.tabIndex = -1;
    add(head, 'p', text);
    return head;
  }

  function renderManager() {
    const panel = content;
    const head = identity(`أنت المدير: ${iso(ws.name)}`);
    const code = add(head, 'small', 'رمز المشروع ', 'team-code'); add(code, 'bdi', ws.projectId.slice(0, 8)).dir = 'ltr';
    const end = button(head, 'إنهاء وضع الفريق', 'text-button', 'team-end');
    end.onclick = () => { if (confirm('سيُحذف عمل الفريق من هذا المتصفح (الأعضاء والتوزيع والاعتمادات). نزّل التقرير أولًا إن احتجته. متابعة؟')) { ws = null; commit(null, 'انتهى وضع الفريق في هذا المتصفح. عدت للعمل وحدك.'); } };
    const summary = teamSummary(ws, caseFingerprints());
    stageBar(panel, summary);
    const steps = add(panel, 'ol', null, 'team-steps');
    for (const text of ['أضف الأعضاء', 'وزّع الحالات', 'نزّل ملف المهمة لكل عضو وأرسله', 'استلم ملفات الموافقة وادمجها']) add(steps, 'li', text);

    const table = add(panel, 'table', null, 'team-members'); table.id = 'team-members';
    const headRow = add(add(table, 'thead'), 'tr');
    const headers = ['الاسم', 'الدور', 'المشرف', 'الحالات', 'وافق عليها المشرف', 'ملف المهمة', 'إزالة'];
    for (const text of headers) add(headRow, 'th', text).scope = 'col';
    const body = add(table, 'tbody');
    if (!summary.members.length) { const row = add(body, 'tr'); const cell = add(row, 'td', 'لا أعضاء بعد. أضف مدققًا واحدًا على الأقل، ومشرفًا إن أردت مراجعة على مرحلتين.'); cell.colSpan = 7; }
    for (const member of summary.members) {
      const row = add(body, 'tr');
      const cells = [add(row, 'td', member.name), add(row, 'td', ROLE_LABELS[member.role]), add(row, 'td', member.role === 'reviewer' ? memberName(member.supervisorId) : '—'), add(row, 'td', number(member.total)), add(row, 'td', number(member.approved))];
      cells[0].dir = 'auto';
      const taskCell = add(row, 'td'); const removeCellRef = [];
      cells.push(taskCell);
      cells.forEach((cell, index) => { cell.dataset.label = headers[index]; });
      const task = button(taskCell, 'ملف المهمة ↓', 'button plain small'); task.dataset.taskMember = member.id;
      task.disabled = !member.total; if (!member.total) task.title = 'وزّع حالات أولًا';
      task.onclick = () => { const result = buildTaskPackage(ws, member.id); if (result.error) { notify(result.error.message, true); return; } save(`mihakk-task-${safeFile(member.name)}-${stamp()}.json`, result.package); notify(`نُزّل ملف المهمة الخاص بـ${member.name}. أرسل الملف إلى العضو؛ يفتحه بعد فحص ملف الترجمة نفسه بالإعدادات نفسها.`); };
      const removeCell = add(row, 'td'); removeCell.dataset.label = 'إزالة';
      const remove = button(removeCell, 'إزالة', 'text-button'); remove.dataset.removeMember = member.id; remove.setAttribute('aria-label', `إزالة ${member.name}`);
      remove.onclick = () => { if (!confirm(`إزالة ${member.name}؟ حالاته غير المعتمدة تعود غير موزعة.`)) return; show(removeMember(ws, member.id), r => `أُزيل ${member.name} من الفريق. عدد الحالات التي عادت غير موزعة: ${number(r.released)}.`); };
    }

    const form = add(panel, 'div', null, 'team-form');
    const nameField = add(form, 'div', null, 'field'); add(nameField, 'label', 'اسم العضو').htmlFor = 'team-add-name';
    const name = add(nameField, 'input'); name.id = 'team-add-name'; name.maxLength = 80;
    const roleField = add(form, 'div', null, 'field'); add(roleField, 'label', 'الدور').htmlFor = 'team-add-role';
    const role = add(roleField, 'select'); role.id = 'team-add-role';
    for (const [value, label] of [['reviewer', 'مدقق'], ['supervisor', 'مشرف']]) { const o = add(role, 'option', label); o.value = value; }
    const supField = add(form, 'div', null, 'field'); add(supField, 'label', 'مشرف هذا العضو').htmlFor = 'team-add-supervisor';
    const sup = add(supField, 'select'); sup.id = 'team-add-supervisor';
    add(sup, 'option', `المدير نفسه (${ws.name})`).value = MANAGER_ID;
    for (const m of ws.members.filter(m => m.role === 'supervisor' && !m.removed)) add(sup, 'option', m.name).value = m.id;
    role.onchange = () => { supField.hidden = role.value !== 'reviewer'; };
    button(form, 'أضف العضو', 'button secondary', 'team-add-member').onclick = () => {
      const result = addMember(ws, {name:name.value, role:role.value, supervisorId:sup.value});
      if (result.error) { notify(result.error.message, true); markInvalid(name, result.error.message); return; }
      commit(result.workspace, `أُضيف ${result.member.name} (${ROLE_LABELS[result.member.role]}).`);
      el('team-add-name')?.focus();
    };

    const assign = add(panel, 'div', null, 'team-assign');
    const strategyField = add(assign, 'div', null, 'field'); add(strategyField, 'label', 'طريقة التوزيع').htmlFor = 'team-assign-strategy';
    const strategy = add(strategyField, 'select'); strategy.id = 'team-assign-strategy';
    for (const [value, label] of Object.entries(STRATEGIES)) add(strategy, 'option', label).value = value;
    const go = button(assign, `وزّع الحالات غير الموزعة (${number(summary.stages.unassigned)})`, 'button primary', 'team-assign');
    go.disabled = !summary.stages.unassigned;
    go.onclick = () => {
      show(assignCases(ws, cases().map(c => caseFromFinding(c.finding, c.fingerprint)), {strategy:strategy.value}), r => `اكتمل التوزيع. عدد الحالات الموزعة: ${number(r.assigned)}. نزّل ملف المهمة لكل عضو.`);
      // The panel re-renders; keep keyboard focus inside it instead of falling to the page body.
      setTimeout(() => { const title = document.getElementById('team-title'); if (title) { title.tabIndex = -1; title.focus(); } }, 0);
    };

    const imports = add(panel, 'div', null, 'team-imports');
    const input = fileInput(imports, 'استلام ملف موافقة من مشرف، أو تسليم من مدقق تابع لك مباشرة', 'team-import-file', true);
    input.onchange = () => readPackages(input);
  }

  function renderReviewer() {
    const panel = content;
    const me = ws.members.find(m => m.id === ws.memberId);
    identity(`أنت المدقق: ${iso(ws.name)} · المشرف: ${iso(memberName(me?.supervisorId))} · المدير: ${iso(ws.managerName)}`);
    const own = Object.entries(ws.records).filter(([, r]) => r.reviewerId === ws.memberId);
    const decisions = getState().decisions;
    const byFp = Object.fromEntries(cases().map(c => [c.fingerprint, decisions[c.finding.id]]));
    const ready = own.filter(([fp, r]) => ['assigned', 'returned'].includes(r.stage) && byFp[fp]?.note?.trim()).length;
    const stats = add(panel, 'div', null, 'team-stages');
    for (const [label, value, stage] of [['حالاتك', own.length, 'assigned'], ['جاهزة للتسليم', ready, 'submitted'], ['مُعادة إليك', own.filter(([, r]) => r.stage === 'returned').length, 'returned'], ['بانتظار المشرف', own.filter(([, r]) => r.stage === 'submitted').length, 'submitted'], ['وافق عليها المشرف', own.filter(([, r]) => r.stage === 'approved').length, 'approved']]) {
      const item = add(stats, 'div', null, 'team-stage'); item.dataset.stage = stage; add(item, 'strong', number(value)); add(item, 'span', label);
    }
    const actions = add(panel, 'div', null, 'team-assign');
    const submit = button(actions, `نزّل ملف التسليم (${number(ready)}) ثم أرسله للمشرف ↓`, 'button primary', 'team-submit');
    submit.disabled = !ready;
    submit.onclick = () => {
      const result = buildSubmission(ws, byFp);
      if (result.error) { notify(result.error.message, true); return; }
      save(`mihakk-submission-${safeFile(ws.name)}-${stamp()}.json`, result.package);
      commit(result.workspace, `نُزّل ملف التسليم (عدد القرارات: ${number(result.count)}). أرسله إلى المشرف. الحالات المسلّمة مقفلة إلا إذا أُعيدت. إن لم ترسل الملف لن يصل شيء للمشرف.`);
    };
    const input = fileInput(actions, 'تحديث ملف المهمة، أو ملف موافقة من المشرف', 'team-task-file');
    input.onchange = () => readPackages(input);
  }

  function renderSupervisor() {
    const panel = content;
    const reviewers = supervisedReviewers(ws);
    identity(`أنت المشرف: ${iso(ws.name)} · المدققون التابعون لك: ${reviewers.map(r => iso(r.name)).join('، ') || 'لا أحد'}`);
    const mine = Object.values(ws.records).filter(r => reviewers.some(x => x.id === r.reviewerId));
    const stats = add(panel, 'div', null, 'team-stages');
    for (const [label, value, stage] of [['بانتظار قرارك', mine.filter(r => r.stage === 'submitted').length, 'submitted'], ['وافقت عليها', mine.filter(r => r.stage === 'approved').length, 'approved'], ['أعدتها', mine.filter(r => r.stage === 'returned').length, 'returned'], ['لم تصل بعد', mine.filter(r => r.stage === 'assigned').length, 'assigned']]) {
      const item = add(stats, 'div', null, 'team-stage'); item.dataset.stage = stage; add(item, 'strong', number(value)); add(item, 'span', label);
    }
    const actions = add(panel, 'div', null, 'team-assign');
    const input = fileInput(actions, 'استلام ملفات التسليم من المدققين', 'team-submission-file', true);
    input.onchange = () => readPackages(input);
    const check = add(actions, 'label', null, 'check-row');
    const box = add(check, 'input'); box.type = 'checkbox'; box.id = 'team-pending-only'; box.checked = pendingOnly;
    add(check, 'span', 'اعرض فقط ما ينتظر قراري');
    box.onchange = () => { pendingOnly = box.checked; onChange(); };
    const verdicts = mine.filter(r => ['approved', 'returned'].includes(r.stage) && r.verdict).length;
    const exportButton = button(actions, `نزّل ملف الموافقة للمدير (${number(verdicts)}) ↓`, 'button primary', 'team-export-review');
    exportButton.disabled = !verdicts;
    exportButton.onclick = () => { const result = buildReview(ws); if (result.error) { notify(result.error.message, true); return; } save(`mihakk-review-${safeFile(ws.name)}-${stamp()}.json`, result.package); notify(`نُزّل ملف الموافقة (عدد القرارات: ${number(result.count)}). أرسله إلى المدير، وأرسل نسخة إلى المدقق إن وُجدت حالات مُعادة.`); };
  }

  function render() {
    const focusedId = panel.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset?.taskMember : null;
    content.replaceChildren();
    panel.dataset.role = ws?.role ?? (preview ? 'none' : 'roadmap');
    panel.hidden = !runKey;
    chip.hidden = !ws;
    chip.textContent = ws ? `${ROLE_LABELS[ws.role]} · ${ws.name}` : '';
    if (!runKey) return;
    if (!ws && !preview) renderRoadmap();
    else if (!ws) renderNone();
    else if (ws.role === 'manager') renderManager();
    else if (ws.role === 'reviewer') renderReviewer();
    else renderSupervisor();
    result.textContent = lastResult; result.hidden = !lastResult; result.classList.toggle('error', lastError);
    result.setAttribute('role', lastError ? 'alert' : 'status');
    // Rebuilding the panel must not throw keyboard users back to the top of the page.
    if (focusedId) (el(focusedId) ?? panel.querySelector(`[data-task-member="${focusedId}"]`) ?? el('team-title'))?.focus({preventScroll:true});
    else if (focusedId === '') el('team-title')?.focus({preventScroll:true});
  }

  /** Dialog section for the active finding. Returns whether the decision buttons apply to this viewer. */
  function decorate(finding, container) {
    activeFingerprint = fingerprintOf(finding);
    // Outside a team everyone decides; inside a team only reviewers decide, on assigned cases.
    if (!ws || !isTeamCase(finding) || !activeFingerprint) return {canDecide:!ws};
    const record = ws.records[activeFingerprint];
    const section = add(container, 'section', null, 'team-case'); section.id = 'team-case';
    add(section, 'h3', 'الفريق');
    const stage = stageOf(ws, activeFingerprint);
    add(section, 'p', `المرحلة: ${STAGE_LABELS[stage]}${record?.reviewerId ? ` · المدقق: ${memberName(record.reviewerId)}` : ''}`);
    if (record?.stage === 'returned' && record.verdictNote) add(section, 'p', `ملاحظة الإعادة (${record.verdictByName || 'المشرف'}): ${record.verdictNote}`, 'team-returned-note');
    if (record?.decision && ws.role !== 'reviewer') {
      const decided = add(section, 'p', `قرار المدقق: ${decisionLabels[record.decision]} — ${record.note}`, 'team-decision');
      decided.dir = 'auto';
      if (record.decidedAt) add(section, 'small', `${record.reviewerName || memberName(record.reviewerId)} · ${new Date(record.decidedAt).toLocaleString('ar')}`);
    }
    if (record?.verdict && ws.role !== 'reviewer' && record.stage !== 'returned') add(section, 'p', `قرار المشرف: ${STAGE_LABELS[record.verdict]}${record.verdictNote ? ` — ${record.verdictNote}` : ''} (${iso(record.verdictByName)})`);

    if (ws.role === 'manager') {
      add(section, 'p', 'في وضع الفريق يسجّل المدقق القرار؛ دورك التوزيع والمتابعة والدمج.', 'field-hint');
      const field = add(section, 'div', null, 'field'); add(field, 'label', 'المدقق المسؤول').htmlFor = 'team-reassign';
      const select = add(field, 'select'); select.id = 'team-reassign';
      add(select, 'option', 'غير موزعة').value = '';
      for (const m of ws.members.filter(m => m.role === 'reviewer' && !m.removed)) add(select, 'option', m.name).value = m.id;
      select.value = record?.reviewerId ?? '';
      select.disabled = ['submitted', 'approved'].includes(stage);
      if (select.disabled) add(field, 'p', 'الحالة عند المشرف أو معتمدة؛ لا تُنقل الآن.', 'field-hint');
      select.onchange = () => show(assignCase(ws, caseFromFinding(finding, activeFingerprint), select.value), () => select.value ? `نُقلت الحالة إلى ${memberName(select.value)}. نزّل له ملف مهمة محدثًا.` : 'أصبحت الحالة غير موزعة.');
    }
    const supervising = (ws.role === 'supervisor' || ws.role === 'manager') && record && supervisedReviewers(ws).some(m => m.id === record.reviewerId);
    if (supervising && record.decision && ['submitted', 'approved', 'returned'].includes(record.stage)) {
      const label = add(section, 'label', record.decision === 'reject' && ['high', 'critical'].includes(record.severity) ? 'سببك (إلزامي: إغلاق تنبيه عالي الأولوية، أو إعادة)' : 'ملاحظتك (إلزامية عند الإعادة)'); label.htmlFor = 'team-verdict-note';
      const note = add(section, 'textarea'); note.id = 'team-verdict-note'; note.rows = 2; note.maxLength = 1000; note.value = record.stage === 'returned' ? record.verdictNote ?? '' : '';
      const row = add(section, 'div', null, 'decision-buttons team-verdicts'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'قرار المشرف');
      let chosen = record.stage === 'submitted' ? null : record.stage;
      const status = add(section, 'p', '', 'team-verdict-state'); status.setAttribute('role', 'status');
      const saveButton = make('button', 'حفظ قرار المشرف', 'button primary'); saveButton.type = 'button'; saveButton.id = 'team-save-verdict'; saveButton.disabled = !chosen;
      for (const [value, text] of [['approved', 'موافقة'], ['returned', 'إعادة للمدقق']]) {
        const b = button(row, text, ''); b.dataset.verdict = value; b.setAttribute('aria-pressed', String(chosen === value));
        b.onclick = () => { chosen = value; row.querySelectorAll('[data-verdict]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.verdict === value))); saveButton.disabled = false; status.textContent = value === 'returned' ? 'اكتب للمدقق ما يجب مراجعته.' : ''; };
      }
      section.append(saveButton);
      saveButton.onclick = () => {
        const result = setVerdict(ws, activeFingerprint, chosen, note.value);
        if (result.error) { status.textContent = result.error.message; note.focus(); return; }
        commit(result.workspace, null);
        status.textContent = chosen === 'approved' ? 'حُفظت موافقتك. أضفها لملف الموافقة للمدير.' : 'حُفظت الإعادة مع ملاحظتك.';
      };
    } else if (ws.role === 'supervisor' && record?.stage === 'assigned') add(section, 'p', 'لم يصل قرار المدقق بعد.', 'field-hint');
    if (ws.role === 'reviewer' && !canDecide(ws, activeFingerprint)) add(section, 'p', stage === 'submitted' ? 'سُلّمت للمشرف؛ تُفتح إن أعادها.' : stage === 'approved' ? 'وافق عليها المشرف؛ لا تُعدّل.' : 'هذه الحالة ليست موزعة عليك.', 'field-hint');
    return {canDecide:ws.role === 'reviewer' && canDecide(ws, activeFingerprint)};
  }

  return {
    load(key, info) {
      runKey = key || ''; runInfo = info || {}; lastResult = ''; pendingOnly = false;
      try { ws = runKey ? restoreWorkspace(localStorage.getItem(storageKey()), runKey) : null; } catch { ws = null; }
      render();
      applyPending();
    },
    invalidate() { runKey = ''; ws = null; lastResult = ''; render(); },
    refresh: () => render(),
    active: () => Boolean(ws),
    role: () => ws?.role ?? null,
    visible(finding) {
      if (!ws || ws.role === 'manager') return true;
      const fingerprint = fingerprintOf(finding);
      if (!isTeamCase(finding) || !fingerprint || !isVisible(ws, fingerprint)) return false;
      return !(pendingOnly && ws.role === 'supervisor' && stageOf(ws, fingerprint) !== 'submitted');
    },
    canDecide(finding) { if (!ws) return true; const fingerprint = fingerprintOf(finding); return isTeamCase(finding) && Boolean(fingerprint) && canDecide(ws, fingerprint); },
    badge(finding) {
      if (!ws || !isTeamCase(finding)) return null;
      const fingerprint = fingerprintOf(finding); if (!fingerprint) return null;
      const stage = stageOf(ws, fingerprint);
      const wrap = make('span', null, 'team-badges');
      const badge = add(wrap, 'span', STAGE_LABELS[stage], 'badge team-stage-badge'); badge.dataset.stage = stage;
      const record = ws.records[fingerprint];
      if (record && ws.role !== 'reviewer') add(wrap, 'span', memberName(record.reviewerId), 'team-assignee').dir = 'auto';
      return wrap;
    },
    decorate,
    /** Decisions that drive this viewer's dossier and exports, keyed by finding id. */
    effectiveDecisions(decisions) {
      if (!ws) return decisions;
      if (ws.role === 'supervisor') return {};
      const byId = Object.fromEntries(cases().map(c => [c.fingerprint, c.finding.id]));
      if (ws.role === 'manager') return Object.fromEntries(Object.entries(approvedDecisions(ws)).filter(([fp]) => byId[fp]).map(([fp, d]) => [byId[fp], d]));
      return Object.fromEntries(Object.entries(decisions).filter(([id]) => { const c = cases().find(x => x.finding.id === id); return c && isVisible(ws, c.fingerprint); }));
    },
    dossierTeam() { if (!ws) return null; const summary = teamSummary(ws, caseFingerprints()); return {role:ws.role, total:summary.total, stages:summary.stages}; },
    exported() { return exportTeam(ws, caseFingerprints()); },
  };
}
