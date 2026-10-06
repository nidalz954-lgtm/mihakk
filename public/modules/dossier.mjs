import {arabicCount} from './ui-helpers.mjs';
import {knownAttribution} from './trust-protocol.mjs';

/** What actually happened to the optional model run. A partial, cancelled or failed run is never completion. */
export function aiExecutionState(report) {
  const analysis = report?.provenance?.analysis ?? {};
  const requestedMode = String(analysis.requestedMode ?? '');
  const requested = /-requested$/.test(requestedMode) || Boolean(analysis.contextModel || analysis.model || analysis.modelError || analysis.aiCancelled || analysis.aiSkippedReason);
  if (!requested) return {state:'not_requested', kind:null, processed:0, eligible:0, abstentions:0, truncated:0, error:null};
  const kind = analysis.contextModel || requestedMode.startsWith('context') ? 'context' : 'embedding';
  const processed = Number(kind === 'context' ? analysis.contextProcessedRows : analysis.semanticProcessedRows) || 0;
  const eligible = Number(kind === 'context' ? analysis.contextEligibleRows : analysis.semanticEligibleRows) || 0;
  const cancelled = analysis.aiCancelled === true || analysis.contextExecution?.cancelled === true;
  const error = analysis.modelError || analysis.contextError || null;
  const findings = report?.findings ?? [];
  const abstentions = findings.filter(f => f.code === 'context_uncertain').length;
  const truncated = findings.filter(f => ['context_input_truncated','semantic_input_truncated'].includes(f.code)).length;
  const base = {kind, processed, eligible, abstentions, truncated, error};
  if (analysis.aiSkippedReason) return {...base, state:'not_run', error:analysis.aiSkippedReason};
  if (cancelled) return {...base, state:'cancelled'};
  if (error) return {...base, state:'failed'};
  if (!eligible && !processed) return {...base, state:'no_pairs'};
  if (!processed) return {...base, state:'failed'};
  if (processed < eligible) return {...base, state:'partial'};
  if (kind === 'context' && (analysis.contextCompleted === false || analysis.contextExecution?.completed === false)) return {...base, state:'inconsistent'};
  if (kind === 'embedding' && (analysis.execution?.actualInference !== true || analysis.execution?.completed === false)) return {...base, state:'inconsistent'};
  if (truncated) return {...base, state:'truncated'};
  return {...base, state:'complete'};
}

function aiGate(ai) {
  const name = ai.kind === 'context' ? 'المؤشر السياقي' : 'نموذج التشابه';
  const counted = `${ai.processed} من ${ai.eligible}`;
  const abstained = ai.abstentions ? ` امتنع النموذج في ${ai.abstentions} زوجًا ويبقى قرارها للمراجع.` : '';
  const gate = {
    not_requested:['recorded','لم يُطلب نموذج لغوي؛ اعتمد الفحص على البنية والفروق اللفظية فقط.'],
    no_pairs:['limited',`طُلب ${name} ولا توجد أزواج مؤهلة له (مثل اختلاف لغة المرجع أو عدم معرفتها)؛ لم يُنفذ أي استدلال.`],
    complete:['recorded',`اكتمل ${name} على ${counted} زوجًا مؤهلًا. النتائج إشارات غير معايرة وليست حكمًا على المعنى.${abstained}`],
    truncated:['limited',`اكتمل ${name} على ${counted} زوجًا، لكن ${ai.truncated} زوجًا تجاوز حد النموذج فامتنع عن ترجيحه.${abstained}`],
    partial:['hold',`لم يكتمل ${name}: ${counted} فقط. المواضع الباقية بلا تحليل؛ أعد التشغيل أو أفصح عن الامتناع.`],
    inconsistent:['hold',`عدادات ${name} تسجل ${counted}، لكن حالة التنفيذ تصرح بأنه غير مكتمل. راجع سجل التنفيذ أو أعد التشغيل قبل الاعتماد على النتيجة.`],
    cancelled:['hold',`أُوقف ${name} عند ${counted}. المواضع الباقية لم تُحلل؛ أعد التشغيل أو أفصح عن الامتناع.`],
    failed:['hold',`تعذّر إكمال ${name} (${counted})${ai.error ? `: ${ai.error}` : ''}. لا تعامل غياب الإشارات كنتيجة.`],
    not_run:['hold',`طُلب ${name} ولم يُشغّل: ${ai.error}`],
  }[ai.state];
  return {id:'ai_execution',label:'تنفيذ التحليل الذكي الاختياري',status:gate[0],state:ai.state,detail:gate[1]};
}

/** Review completion checks, not a certificate of translation correctness. */
export function buildReviewDossier(report, decisions = {}, {revisionReview = null, runManifest = null, team = null} = {}) {
  if (!report?.rows || !report?.findings) throw new Error('لم يُنشأ تقرير فحص بعد.');
  const inspectionCases = report.findings.filter(f => ['structural','comparison'].includes(f.type));
  const unresolved = inspectionCases.filter(f => !['accept','reject'].includes(decisions[f.id]?.value ?? decisions[f.id]?.decision));
  const referred = inspectionCases.filter(f => (decisions[f.id]?.value ?? decisions[f.id]?.decision) === 'refer');
  const accepted = inspectionCases.filter(f => (decisions[f.id]?.value ?? decisions[f.id]?.decision) === 'accept');
  // Accepting a signal means it needs correction. Resolving a signal is never correcting the source file.
  const reference = report.provenance?.reference ?? {};
  const candidate = report.provenance?.candidate ?? {};
  const identityFields = [reference.title, knownAttribution(reference.author) || knownAttribution(reference.translator), reference.publisher, reference.edition, reference.licenseNote];
  const identityRecorded = identityFields.every(v=>Boolean(knownAttribution(v)));
  const unknownEdition = !knownAttribution(reference.edition);
  const sourceCoverage = report.rows.filter(r => r.verseId && !r.findings.some(f => ['empty_translation','duplicate_verse','out_of_scope'].includes(f.code)) && !r.reference).length;
  const languageAbstentions = report.rows.filter(r => r.comparisonReason === 'language_mismatch').length;
  const ai = aiExecutionState(report);
  const gates = [
    {id:'scope',label:'نطاق الفحص المعلن',status:report.scope?.type === 'provided' ? 'limited' : 'recorded',detail:report.scope?.type === 'provided' ? 'هذه عينة جزئية؛ لا يثبت التقرير اكتمال سورة أو القرآن.' : 'اكتمال المعرّفات يُقاس داخل النطاق المعلن فقط.'},
    {id:'structure',label:'سلامة بنية الملف ونظافة النص (أرقام وتكرار وترتيب وشوائب)',status:report.summary?.structuralFindingCount ? 'hold' : 'passed',detail:report.summary?.structuralFindingCount ? 'أصلح العيوب البنيوية في الملف ثم أعد رفعه وفحصه؛ تسجيل قرار لا يصلح النص.' : 'لم ترصد قواعد البنية خللًا داخل النطاق؛ لا يثبت هذا سلامة المعنى.'},
    {id:'source_identity',label:'هوية المصدر والطبعة والحقوق',status:identityRecorded ? 'recorded' : 'hold',detail:unknownEdition ? 'طبعة المرجع غير معلنة أو غير موثّقة. أضف دليل الطبعة قبل الاعتماد البشري.' : identityRecorded ? 'بيانات الكتاب والمؤلف والناشر مسجلة؛ لم نعتمد نسبتها علميًا.' : 'أكمل بيانات الكتاب والمؤلف أو المترجم والناشر والحقوق قبل الاعتماد البشري.'},
    {id:'source_authentication',label:'التحقق المستقل من هوية المرجع',status:'required',detail:'يوثق الجلب الحي وصول النص من المزود. يجب على المختص التحقق من هوية المؤلف والطبعة؛ لا تصادق بصمة الملف أو إقرار المستخدم على ذلك.'},
    {id:'source_coverage',label:'تغطية الدليل',status:sourceCoverage || languageAbstentions ? 'hold' : 'recorded',detail:languageAbstentions ? `${languageAbstentions} صف له نص مرجعي لكن المقارنة ممتنعة بسبب اختلاف اللغة. ${sourceCoverage} صف بلا نص مقابل؛ الفحص البنيوي لا يثبت إجراء مقارنة.` : sourceCoverage ? `${sourceCoverage} صف بلا نص مرجعي مقابل؛ يجب توفير الدليل أو الإفصاح عن الامتناع.` : 'نصوص المقارنة المقابلة متاحة للصفوف المؤهلة؛ توافرها لا يثبت صحة المعنى.'},
    aiGate(ai),
    {id:'case_resolution',label:'قرارات المراجعة',status:unresolved.length ? 'hold' : 'recorded',detail:`${arabicCount(unresolved.length,{one:'حالة معلقة',two:'حالتان معلقتان',few:'حالات معلقة',other:'حالة معلقة'})}، منها ${referred.length} إحالة لم تُغلق.`},
    {id:'corrections',label:'التصحيحات وإعادة الفحص',status:accepted.length ? 'hold' : 'recorded',detail:accepted.length ? `${arabicCount(accepted.length,{one:'إشارة',two:'إشارتان',few:'إشارات',other:'إشارة'})} قبلها المراجع وتحتاج تصحيحًا في الملف وإعادة فحص؛ لا يعني قبول الإشارة قبول الترجمة.` : 'لا توجد إشارة مقبولة تستدعي إصلاحًا مسجلًا في هذه الجولة.'},
    {id:'expert_signoff',label:'اعتماد المختص خارج الأداة',status:'required',detail:'لا يصدر مِحَكّ اعتمادًا علميًا أو إذن نشر. يتولى المختص والناشر ذلك وفق إجراءاتهم.'},
  ];
  if(runManifest){
    const inconsistent=Object.values(runManifest.layers??{}).some(layer=>layer.state==='inconsistent');
    gates.splice(-1,0,{id:'run_integrity',label:'اتساق سجل التغطية والتنفيذ',status:inconsistent?'hold':'recorded',detail:inconsistent?'توجد بيانات تنفيذ غير متسقة في سجل التغطية. راجع العدادات والدليل أو أعد الفحص.':'سجل التغطية مرتبط ببصمات هذا الفحص؛ لا يثبت صحة المعنى أو حدوث استدلال خارج الدليل المسجل.'});
  }
  if(revisionReview){
    const incomplete=revisionReview.status==='not_processed'||Boolean(revisionReview.error)||!Array.isArray(revisionReview.records);
    const changed=(revisionReview.records??[]).filter(record=>record.state!=='identical_raw');
    const invalid=changed.filter(record=>['invalid_row','ambiguous_duplicate'].includes(record.state));
    const notes=revisionReview.review?.decisions??[];
    const unresolvedChanges=changed.filter(record=>!notes.some(note=>note.recordKey===record.recordKey&&note.status==='active'&&note.decision==='reviewed'&&typeof note.reason==='string'&&note.reason.trim()&&note.evidenceFingerprint===record.evidenceFingerprint&&note.contextFingerprint===record.contextFingerprint));
    gates.splice(-1,0,{id:'revision_followup',label:'متابعة تغيّر النسخ والقرارات السابقة',status:incomplete||invalid.length||unresolvedChanges.length?'hold':'recorded',detail:incomplete?'اختير أساس للمقارنة لكن مقارنة النسخ لم تكتمل. أعد الفحص؛ لا يُعد غياب نتيجة المقارنة إغلاقًا للتغييرات.':invalid.length?`${invalid.length} موضع مكرر أو غير صالح يمنع مقارنة النسخ؛ أصلح الملف وأعد رفعه.`:unresolvedChanges.length?`${unresolvedChanges.length} تغيّر خام يحتاج قراءة وقرارًا جديدًا مع السبب. القرارات القديمة غير الصالحة لا تُغلقه.`:'تغيّرات النسخ لها قرارات مرتبطة بالدليل الحالي؛ هذه متابعة عمل وليست اعتمادًا للمعنى.'});
  }
  if(team){
    // Inside a team only the manager merges; a case counts only after a supervisor approved it.
    const stages=team.stages??{},total=Number(team.total)||0,approved=Number(stages.approved)||0;
    const status=team.role!=='manager'||approved<total?'hold':'recorded';
    const detail=team.role!=='manager'?'هذا ملف عمل ضمن فريق. الدمج وملف المتابعة النهائي عند المدير.':approved<total?`${approved} من ${total} حالة وافق عليها مشرف. غير موزعة ${Number(stages.unassigned)||0}، عند المدققين ${Number(stages.assigned)||0}، بانتظار المشرف ${Number(stages.submitted)||0}، مُعادة ${Number(stages.returned)||0}.`:'وافق مشرف على كل الحالات داخل الفريق. الأسماء يكتبها أصحابها، وموافقة المشرف مراجعة داخلية وليست إذن نشر.';
    gates.splice(-1,0,{id:'team_oversight',label:'موافقة المشرفين داخل الفريق',status,detail});
  }
  return {schemaVersion:'mihakk-review-dossier/1',createdAt:new Date().toISOString(),candidate,scope:report.scope,reference,...(team?{team:{role:team.role,total:Number(team.total)||0,stages:team.stages??{}}}:{}),counts:{cases:inspectionCases.length,unresolved:unresolved.length,referred:referred.length,acceptedSignals:accepted.length,modelAbstentions:ai.abstentions},aiExecution:ai,gates,status:gates.some(g=>g.status==='hold')?'needs_work':'ready_for_expert_review',publicationAuthorized:false,certificate:false,synthetic:candidate.synthetic === true,claim:'مخرج متابعة للمراجعة؛ ليس شهادة صحة ترجمة أو إذن نشر.'};
}
