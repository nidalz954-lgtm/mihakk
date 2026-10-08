/** Small DOM-free helpers shared by app.js and tests. */
const RTL_LANGUAGES = new Set(['ar','ur','fa','he','ps','sd','ug','yi','dv','ku']);

/** Higher priorities first; retain source order within a priority without mutating the report. */
export function sortFindingsByPriority(findings) {
  const rank = {critical:0, high:1, medium:2, low:3, info:4};
  return [...findings].sort((a,b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
}

/** Keep every signal; describe the visible workload without calling all wording differences errors. */
export function reviewQueueBreakdown(findings) {
  return {
    total: findings.length,
    priority: findings.filter(item => ['critical', 'high', 'medium'].includes(item.severity)).length,
    wording: findings.filter(item => item.code === 'lexical_difference').length,
    low: findings.filter(item => item.severity === 'low').length,
    information: findings.filter(item => item.severity === 'info' || !item.severity).length,
  };
}

/** Text direction for a declared language; unknown text lets the browser decide. */
export function textDirection(language) {
  const base = String(language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!base || base === 'unknown') return {lang:'', dir:'auto'};
  return {lang:base, dir:RTL_LANGUAGES.has(base) ? 'rtl' : 'ltr'};
}

// ASCII and full-width spreadsheet formula prefixes, after optional spaces or a BOM.
const FORMULA_PREFIX = /^[\s﻿　]*[=+\-@＝＋－＠−]/;
export function csvCell(value) {
  let text = String(value ?? '');
  if (FORMULA_PREFIX.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g,'""')}"`;
}

// Timestamps change on every rerun; they are provenance, not evidence content.
const VOLATILE_KEYS = new Set(['inferredAt','retrievedAt','elapsedMS','generatedAt','createdAt','exportedAt','savedAt']);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE_KEYS.has(key)).map(([key, item]) => [key, stable(item)]));
}
/** Serialized evidence that a saved decision is bound to. */
export function decisionFingerprintInput(finding) {
  return JSON.stringify(stable({code:finding.code,type:finding.type,severity:finding.severity,verseIds:finding.verseIds,rowNumbers:finding.rowNumbers,spans:finding.spans,evidence:finding.evidence}));
}

/** Arabic noun forms selected using the standard Arabic plural rules. */
export function arabicCount(value, forms) {
  const n = Math.max(0, Number(value) || 0);
  const category = new Intl.PluralRules('ar').select(n);
  const noun = forms[category] || forms.other || forms.many || forms.one;
  return new Intl.NumberFormat('ar').format(n) + ' ' + noun;
}
/** Fallback when only an internal key is known: it is an input position, not a spreadsheet row. */
export function humanRecordKey(key) {
  const match = /^(candidate|baseline):(\d+)$/.exec(String(key));
  return match ? 'سجل غير صالح رقم ' + (Number(match[2]) + 1) + (match[1] === 'candidate' ? ' في النسخة الحالية' : ' في النسخة السابقة') : String(key || 'الملف');
}
/** Label a revision record by verse id, or by its real spreadsheet row when the row has no valid id. */
export function revisionRecordLabel(record) {
  if (record?.id) return record.id;
  const side = /^baseline:/.test(String(record?.recordKey)) ? 'baseline' : 'candidate';
  const row = (side === 'baseline' ? record?.baselineRows : record?.candidateRows)?.find(value => Number.isSafeInteger(value));
  return row ? 'صف ' + row + (side === 'candidate' ? ' في النسخة الحالية' : ' في النسخة السابقة') : humanRecordKey(record?.recordKey);
}

/* ---- Display and message helpers (2026-10-07 tool fixes). Pure and DOM-free; app.js only wires them. ---- */
const LANGUAGE_NAMES = Object.freeze({ar:'العربية', en:'الإنجليزية', fr:'الفرنسية', id:'الإندونيسية', tr:'التركية', ru:'الروسية', es:'الإسبانية', ur:'الأردية'});
const ROW_FORMS = {zero:'صف', one:'صف', two:'صف', few:'صفوف', many:'صفًا', other:'صف'};
const MISSING_POSITION_FORMS = {zero:'موضع ناقص', one:'موضع ناقص', two:'موضعان ناقصان', few:'مواضع ناقصة', many:'موضعًا ناقصًا', other:'موضع ناقص'};
const countFormat = new Intl.NumberFormat('ar');

/** Arabic name of a declared language code; the code itself when it is not one of the tool's languages. */
export function languageName(code) {
  const base = String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[base] || (base && base !== 'unknown' ? base : 'غير معروفة');
}

/**
 * Explains, from summary.languageLimits (added by the engine), that negation, quantifier and written-number
 * checks did not run for the candidate language. Tolerates older reports: returns null when the data is absent or rowsLimited is 0.
 */
export function languageLimitsNotice(limits) {
  const rows = Math.max(0, Math.trunc(Number(limits?.rowsLimited)) || 0);
  if (!limits || typeof limits !== 'object' || !rows) return null;
  const skipped = [];
  if (limits.negationChecked === false) skipped.push({short: 'النفي', long: 'النفي'});
  if (limits.quantifierChecked === false) skipped.push({short: 'الكمّ والإلزام', long: 'الكمّ والإلزام (كل، بعض، يجب)'});
  if (limits.writtenNumbersChecked === false) skipped.push({short: 'الأعداد المكتوبة', long: 'الأعداد المكتوبة بالحروف'});
  const name = languageName(limits.language);
  const subject = skipped.length ? `فحص ${skipped.map(item => item.long).join(' و')} لا يعمل` : 'بعض فحوص المعنى لا تعمل';
  const digits = limits.digitsChecked === false ? '' : ' يبقى فحص الأرقام الرقمية والفرق اللفظي عاملين.';
  return {
    rows,
    language: name,
    short: `${arabicCount(rows, ROW_FORMS)} اختلف نصها بلغة «${name}»${skipped.length ? ` ولم يُفحص فيها ${skipped.map(item => item.short).join(' و')}` : ''}، فهي امتناع وليست «لا إشارة»`,
    long: `${subject} للغة «${name}»؛ هذه الفحوص مبنية للغات محددة فقط.${digits} عدد الصفوف التي اختلف نصها ولم تُفحص معانيها بهذه الفحوص: ${countFormat.format(rows)}. بقيت امتناعًا وليست «لا إشارة»، فاقرأها بنفسك.`,
  };
}

/** Title for findings whose fixed label would contradict their evidence; null means use the standard label. */
export function findingTitleOverride(finding) {
  const evidence = finding?.evidence || {};
  if (finding?.code === 'reference_coverage') {
    if (evidence.languagesDiffer) return 'امتنعت المقارنة النصية كلها: لغة المرجع المعلنة لا تطابق لغة الترجمة';
    if (Number(evidence.unverifiedRows) > 0 || Number(evidence.ambiguousRows) > 0) return 'مواضع لم تكتمل مقارنتها بالمرجع';
  }
  return null;
}

/** Diacritics and Arabic-Indic digits are ignored so a typed query matches the visible text. */
export function normalizeSearchText(value) {
  return String(value ?? '')
    .replace(/[\u0660-\u0669]/g, digit => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
    .replace(/[\u06F0-\u06F9]/g, digit => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .toLocaleLowerCase();
}

/** Everything a reviewer can see about a case: title, location label, surah number, row number, ids and the highlighted words. */
export function findingSearchText(finding, {title = '', location = ''} = {}) {
  const ids = finding?.verseIds || [];
  const rows = finding?.rowNumbers || [];
  const evidence = finding?.evidence || {};
  const surahs = new Set(ids.map(id => String(id).split(':')[0]));
  if (evidence.surah != null) surahs.add(String(evidence.surah));
  const pair = evidence.surah != null && evidence.ayah != null ? `${evidence.surah}:${evidence.ayah}` : '';
  return normalizeSearchText([
    finding?.message, finding?.code, title, location, ids.join(' '), pair,
    rows.map(row => `${row} صف ${row}`).join(' '),
    [...surahs].map(surah => `${surah} سورة ${surah}`).join(' '),
    (finding?.spans || []).map(span => span?.text ?? '').join(' '),
  ].filter(part => part != null).join(' '));
}

/** Extra clauses for the results sentence: structural problems that have no file row (missing verses and similar). */
export function rowlessFindingsText(summary, findings = []) {
  const parts = [];
  const missing = Math.max(0, Number(summary?.missingVerses) || 0);
  if (missing) parts.push(`${arabicCount(missing, MISSING_POSITION_FORMS)} في الملف (آيات لا صف لها)`);
  const rowless = findings.filter(item => item?.type === 'structural' && item.code !== 'missing_verses' && !(item.rowNumbers || []).length).length;
  if (rowless) parts.push(`${arabicCount(rowless, {zero: 'حالة بنيوية', one: 'حالة بنيوية', two: 'حالتان بنيويتان', few: 'حالات بنيوية', many: 'حالة بنيوية', other: 'حالة بنيوية'})} بلا صف`);
  if (findings.some(item => item?.code === 'reference_integrity')) parts.push('خلل في صفوف الملف المرفوع للمرجع');
  return parts.length ? ' · ' + parts.join(' · ') : '';
}

/** Bidirectional control characters can make a file name read backwards; they are removed from what is displayed, never from what is stored. */
export function displayFileName(name) {
  return String(name ?? '').replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

/** Remove trailing full stops so a caller can append its own punctuation without doubling it. */
export function withoutFinalStop(text) {
  return String(text ?? '').replace(/[\s.\u3002\u06D4]+$/u, '').trim();
}

/** The sentence shown after a user stop, chosen from what really happened (never claims results that do not exist). */
export function stopMessage({referenceFailed = false, aiRequested = false, aiProcessed = 0, aiEligible = 0, lexicalCompared = 0} = {}) {
  const done = Math.max(0, Number(aiProcessed) || 0);
  const total = Math.max(done, Number(aiEligible) || 0);
  const parts = [];
  if (referenceFailed) parts.push(aiRequested ? 'أُوقف جلب المرجع بطلبك، فلم يبدأ التحليل الذكي.' : 'أُوقف جلب المرجع بطلبك.');
  else if (aiRequested) parts.push(done > 0
    ? `أُوقف التحليل الذكي بطلبك بعد ${countFormat.format(done)} من ${countFormat.format(total)} مقارنة بالنموذج؛ حُفظت المقارنات المكتملة وبقي الباقي بلا تحليل ذكي.`
    : 'أُوقف التحليل الذكي بطلبك قبل اكتمال أي مقارنة بالنموذج؛ لا توجد مؤشرات نموذجية.');
  else parts.push('أُوقفت العملية بطلبك.');
  parts.push(Number(lexicalCompared) > 0 ? 'نتائج الفحص البنيوي والمقارنة اللفظية محفوظة.' : 'الفحص البنيوي وحده محفوظ؛ لم تُجرَ مقارنة بمرجع.');
  return parts.join(' ');
}

/** The honest reason an embedding run does nothing with an uploaded reference (it is user-declared, so no pair is eligible). */
export function unverifiedEmbeddingNote() {
  return 'المرجع المرفوع بيانات قدّمها المستخدم وغير موثّقة المصدر، فلا يُجري نموذج التشابه أي مقارنة معه. اختر مؤشراً سياقياً (يعمل مع المرجع المرفوع بوصفه تجريبياً) أو مرجعاً حياً من Quranpedia.';
}

/** Short Arabic status word for a dossier checklist row, read by screen readers instead of an unlabeled glyph. */
export function checklistStatusWord(status) {
  if (status === 'recorded' || status === 'passed') return 'تم';
  if (status === 'hold') return 'يحتاج متابعة';
  if (status === 'limited') return 'محدود';
  if (status === 'required') return 'مطلوب خارج الأداة';
  return 'لم يكتمل';
}

/** The first few missing verse ids of a missing-verses case, for showing their mushaf text. */
export function missingVersePreview(verseIds, limit = 5) {
  const ids = [...new Set((verseIds || []).map(String).filter(id => /^\d{1,3}:\d{1,3}$/.test(id)))];
  return {shown: ids.slice(0, limit), hiddenCount: Math.max(0, ids.length - limit), total: ids.length};
}

/**
 * Which uploaded reference rows are defective, found with the same rules as the engine (invalid id, empty text, repeated id).
 * `strict` and `isValid` are strictInteger and isValidVerseId from quran-index.mjs, passed in to keep this module dependency-free.
 */
export function referenceDefects(rows, {strict, isValid} = {}) {
  const invalid = [], empty = [], seen = new Map();
  if (typeof strict !== 'function' || typeof isValid !== 'function') return {invalid, empty, duplicates: []};
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const given = Number(row?.rowNumber);
    const rowNumber = Number.isSafeInteger(given) && given > 0 ? given : index + 1;
    const surah = strict(row?.surah), ayah = strict(row?.ayah);
    if (!isValid(surah, ayah)) { invalid.push({rowNumber, surah: row?.surah ?? '', ayah: row?.ayah ?? ''}); return; }
    const verseId = `${surah}:${ayah}`;
    if (!seen.has(verseId)) seen.set(verseId, []);
    seen.get(verseId).push(rowNumber);
    if (!String(row?.translation ?? '').replace(/[​-‏‪-‮⁠-⁤﻿]/g, '').trim()) empty.push({rowNumber, verseId});
  });
  const duplicates = [...seen].filter(([, numbers]) => numbers.length > 1).map(([verseId, rowNumbers]) => ({verseId, rowNumbers}));
  return {invalid, empty, duplicates};
}

/** Plain Arabic lines naming the defective reference rows (at most `cap` per kind). */
export function referenceDefectLines(defects, cap = 8) {
  const more = (list) => (list.length > cap ? `، و${countFormat.format(list.length - cap)} أخرى` : '');
  const cut = (value) => String(value ?? '').slice(0, 30);
  const lines = [];
  if (defects?.invalid?.length) lines.push(`صفوف المرجع ذات المعرّف غير الصالح (${countFormat.format(defects.invalid.length)}): ${defects.invalid.slice(0, cap).map(item => `صف ${item.rowNumber} (سورة «${cut(item.surah)}»، آية «${cut(item.ayah)}»)`).join('، ')}${more(defects.invalid)}`);
  if (defects?.empty?.length) lines.push(`صفوف المرجع ذات النص الفارغ (${countFormat.format(defects.empty.length)}): ${defects.empty.slice(0, cap).map(item => `صف ${item.rowNumber} (${item.verseId})`).join('، ')}${more(defects.empty)}`);
  if (defects?.duplicates?.length) lines.push(`معرّفات مكررة في المرجع (${countFormat.format(defects.duplicates.length)}): ${defects.duplicates.slice(0, cap).map(item => `${item.verseId} في الصفوف ${item.rowNumbers.join(' و')}`).join('، ')}${more(defects.duplicates)}`);
  return lines;
}

/** Text for a cell that held a non-text value (number, boolean, object): it is not empty, it is the wrong type. */
export function nonTextCellNote(receivedType) {
  const types = {number: 'رقم', boolean: 'قيمة منطقية', object: 'كائن أو قائمة', bigint: 'رقم كبير', symbol: 'رمز', function: 'دالة'};
  return `خلية الترجمة ليست نصًا: النوع المستلم «${types[receivedType] || receivedType || 'غير معروف'}»، ولم يُحوَّل إلى نص.`;
}
