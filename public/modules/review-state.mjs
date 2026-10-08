/** DOM-free review-state helpers shared by app.js and tests: decision store, CSV records, dates. Nothing here touches the network. */
import {caseResolution} from './dossier.mjs';
import {decisionFingerprintInput} from './ui-helpers.mjs';

export const DECISION_STORE_PREFIX = 'mihakk:decisions:v3:';
export const LEGACY_DECISION_STORE_PREFIX = 'mihakk:decisions:v2:';
/** Earlier decisions whose evidence is not in the current run stay stored, so restoring the evidence restores them; the pile is bounded. */
export const MAX_KEPT_UNAPPLIED_DECISIONS = 500;
const DECISIONS = ['accept', 'reject', 'refer'];
const FINGERPRINT = /^[a-f0-9]{64}$/;
const isPlain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Stable identity of a review: scope, languages and reference identity. File hashes are deliberately absent;
 * the per-case evidence fingerprint decides whether a saved decision still applies.
 */
export function reviewIdentityInput(report) {
  const reference = report?.provenance?.reference ?? {}, candidate = report?.provenance?.candidate ?? {};
  return {schema:report?.schemaVersion, scope:report?.scope, language:candidate.language, sourceKind:reference.sourceKind, book:reference.bookId, sourceTitle:reference.fullTitle || reference.title, edition:reference.edition, referenceLanguage:reference.language, author:reference.author || reference.translator || null, publisher:reference.publisher || null};
}

/** File-wide and duplicate-row summaries lack the complete text needed to identify a reviewed file. */
export function fileAwareDecisionInput(finding, candidateSha256) {
  const evidence = decisionFingerprintInput(finding);
  if (finding.type !== 'structural' || (finding.rowNumbers?.length && finding.code !== 'duplicate_verse')) return evidence;
  if (!FINGERPRINT.test(candidateSha256 ?? '')) throw new Error('Missing candidate fingerprint for file-wide decision');
  return JSON.stringify({policy:'file-wide-structural/v1', candidateSha256, evidence});
}

/** Same validity rule the store has always used for a saved decision. */
export function isValidSavedDecision(entry) {
  return isPlain(entry) && DECISIONS.includes(entry.decision) && typeof entry.note === 'string' && Boolean(entry.note.trim());
}

/** Parse a stored decisions object. Unreadable text is reported as corrupt, never silently treated as "persistence off". */
export function parseDecisionStore(raw) {
  if (raw == null || raw === '') return {entries:{}, corrupt:false};
  let data;
  try { data = JSON.parse(raw); } catch { return {entries:{}, corrupt:true}; }
  if (!isPlain(data)) return {entries:{}, corrupt:true};
  const entries = {};
  for (const [fingerprint, entry] of Object.entries(data)) if (FINGERPRINT.test(fingerprint) && isValidSavedDecision(entry)) entries[fingerprint] = entry;
  return {entries, corrupt:false};
}

/**
 * Load the store for this review identity. A store left by the previous (file-hash) key format is merged once and removed,
 * so a withdrawn decision cannot come back from it. A corrupt store is overwritten with valid JSON.
 * Throws when storage itself is inaccessible; callers treat that as "storage unavailable".
 */
export function loadDecisionStore(storage, {key, legacyKey = '', legacyFingerprintMap = {}}) {
  const current = parseDecisionStore(storage.getItem(key));
  const legacyRaw = legacyKey ? storage.getItem(legacyKey) : null;
  const legacy = legacyRaw == null ? {entries:{}, corrupt:false} : parseDecisionStore(legacyRaw);
  // Only the v2 key is bound to this exact file. Unbound old v3 structural entries stay unapplied.
  const legacyEntries = Object.fromEntries(Object.entries(legacy.entries).map(([fingerprint, entry]) => [legacyFingerprintMap[fingerprint] || fingerprint, entry]));
  const entries = {...legacyEntries, ...current.entries};
  const result = {entries, repaired:false, migrated:0};
  if (current.corrupt) { try { storage.setItem(key, JSON.stringify(entries)); result.repaired = true; } catch { /* Reported by the caller as a failed repair on the next save. */ } }
  if (legacyRaw != null) {
    try { storage.setItem(key, JSON.stringify(entries)); storage.removeItem(legacyKey); result.migrated = Object.keys(legacy.entries).length; } catch { /* Keep the old store until the new one can be written. */ }
  }
  return result;
}

/** Split stored decisions into those whose evidence fingerprint matches a current finding and those that do not. */
export function applyStoredDecisions(entries, fingerprintByFindingId) {
  const idsByFingerprint = new Map();
  for (const [id, fingerprint] of Object.entries(fingerprintByFindingId ?? {})) {
    if (!idsByFingerprint.has(fingerprint)) idsByFingerprint.set(fingerprint, []);
    idsByFingerprint.get(fingerprint).push(id);
  }
  const decisions = {}, unapplied = {};
  for (const [fingerprint, entry] of Object.entries(entries ?? {})) {
    const ids = idsByFingerprint.get(fingerprint);
    if (ids) for (const id of ids) decisions[id] = entry; else unapplied[fingerprint] = entry;
  }
  return {decisions, unapplied, appliedCount:Object.keys(decisions).length, unappliedCount:Object.keys(unapplied).length};
}

/** What to write back: every current decision plus the bounded pile of earlier, unapplied ones. */
export function buildDecisionStore(decisions, fingerprintByFindingId, unapplied = {}, {limit = MAX_KEPT_UNAPPLIED_DECISIONS} = {}) {
  const current = {};
  for (const [id, decision] of Object.entries(decisions ?? {})) { const fingerprint = fingerprintByFindingId?.[id]; if (fingerprint) current[fingerprint] = decision; }
  const kept = Object.entries(unapplied ?? {}).filter(([fingerprint]) => !(fingerprint in current))
    .sort((a, b) => String(b[1]?.savedAt ?? '').localeCompare(String(a[1]?.savedAt ?? ''))).slice(0, limit);
  return {...Object.fromEntries(kept), ...current};
}

/** The date of the user's own day (not the UTC day) for file names. */
export function localDateStamp(date = new Date()) {
  const two = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** Valid verse rows of a preliminary audit that lie inside the declared scope: only these may be fetched from a live source. */
export function rowsInDeclaredScope(auditRows) {
  return (auditRows ?? []).filter(row => row.verseId && !(row.findings ?? []).some(finding => finding.code === 'out_of_scope'));
}

/**
 * JSON text of an export. Small reports stay indented for people; very large ones (a full-Quran run is ~17 MB indented)
 * are written compact. Key order and content are identical either way.
 */
export const PRETTY_JSON_LIMIT = 2_000_000;
export function serializeReportJSON(report, {prettyLimit = PRETTY_JSON_LIMIT} = {}) {
  const compact = JSON.stringify(report);
  return compact.length > prettyLimit ? compact : JSON.stringify(report, null, 2);
}

/* ---- CSV ---- */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/gu;
const ZERO_WIDTH = /[­͏᠎​-‍⁠-⁤﻿￹-￻\u{e0000}-\u{e007f}]/gu;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const codePointLabel = character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
/** "bidi_control=U+202E:1;zero_width=U+200B:2" for invisible or direction-changing characters; empty when none. The text itself is never altered. */
export function hiddenControlFlags(text) {
  const value = String(text ?? ''), parts = [];
  for (const [name, pattern] of [['bidi_control', BIDI], ['zero_width', ZERO_WIDTH], ['control_char', CONTROL]]) {
    const counts = new Map();
    for (const match of value.matchAll(pattern)) counts.set(codePointLabel(match[0]), (counts.get(codePointLabel(match[0])) ?? 0) + 1);
    if (counts.size) parts.push(`${name}=${[...counts].map(([label, count]) => `${label}:${count}`).join(',')}`);
  }
  return parts.join(';');
}

const ROW_SEPARATOR = ' ‖ ';
const MAX_CSV_CELL_TEXT = 30000;
/** Texts of all rows a finding covers, in row order, so a duplicated or multi-row case is not reduced to its first row. */
export function joinRowTexts(texts) {
  const list = texts.map(text => String(text ?? ''));
  if (list.length <= 1) return list[0] ?? '';
  const joined = list.join(ROW_SEPARATOR);
  return joined.length <= MAX_CSV_CELL_TEXT ? joined : `${joined.slice(0, MAX_CSV_CELL_TEXT)} … [اقتُطع للتوافق مع برامج الجداول؛ النص الكامل في تقرير JSON]`;
}

export const CSV_HEADER = ['finding_id','code','type','severity','verse_ids','row_numbers','message','candidate_text','reference_text','source','source_edition','source_url','reference_verification','decision','reviewer_note','decision_time','candidate_sha256','scope','generated_at','notice','resolution_state','hidden_control_chars','synthetic_demo_data','publication_authorized'];

/** A recorded teaching or uploaded source must never inherit a claim of live retrieval. */
function referenceVerificationDisclosure(source) {
  if (source.sourceKind === 'synthetic-teaching') return 'authored_teaching_only';
  if (source.verificationStatus !== 'verified') return 'not_verified';
  return source.sourceKind === 'quranpedia-api' ? 'retrieved_from_source_not_scholarly_verified' : 'provenance_recorded_not_scholarly_verified';
}

/**
 * Review table for the CSV export. The first 20 columns keep their original order and meaning; later columns are additions.
 * Reference text of a live Quranpedia source is never written.
 */
export function buildReviewCsvLines({report, decisions = {}, candidateSha256 = '', notice = '', synthetic = false}) {
  const flag = synthetic === true || report?.provenance?.candidate?.synthetic === true ? 'true' : 'false';
  const lines = [CSV_HEADER];
  const scope = JSON.stringify(report.scope);
  for (const finding of report.findings) {
    const rowNumbers = finding.rowNumbers || [];
    const rows = report.rows.filter(row => rowNumbers.includes(row.rowNumber));
    const first = rows[0];
    const source = first?.reference?.provenance || finding.evidence?.referenceProvenance || report.provenance.reference;
    const decision = decisions[finding.id] || {};
    const live = source.sourceKind === 'quranpedia-api';
    const referenceTexts = [...new Set(rows.map(row => row.reference?.translation).filter(text => text != null))];
    const candidateText = joinRowTexts(rows.map(row => row.translation));
    lines.push([finding.id, finding.code, finding.type, finding.severity, (finding.verseIds || []).join(';'), rowNumbers.join(';'), finding.message, candidateText, live ? 'Reference text omitted; consult source URL' : joinRowTexts(referenceTexts), source.title, source.edition, first?.reference?.sourceURL || source.sourceURL || source.url, referenceVerificationDisclosure(source), decision.decision, decision.note, decision.savedAt, candidateSha256, scope, report.generatedAt, notice, caseResolution(finding, decisions), hiddenControlFlags(rows.map(row => row.translation).join('')), flag, 'false']);
  }
  if (!report.findings.length) lines.push(['','','','','','','لم تظهر إشارات ضمن نطاق الفحص؛ النتيجة ليست اعتماداً.','','',report.provenance.reference.title,'','','','','','','',scope,report.generatedAt,notice,'','',flag,'false']);
  return lines;
}

/* ---- Arabic status lines (plain, no over-claiming) ---- */
const arabicNumber = value => new Intl.NumberFormat('ar').format(Number(value) || 0);
export const STORAGE_UNAVAILABLE_NOTE = 'التخزين المحلي غير متاح؛ قراراتك لن تبقى بعد إغلاق الصفحة. نزّل تقريرك قبل الإغلاق.';
export const STORE_REPAIRED_NOTE = 'كان مخزن القرارات المحلي لهذه المراجعة تالفًا فأُعيد إنشاؤه؛ لم يمكن قراءة ما كان فيه.';

/** The case dialog must distinguish a saved decision from one held only in this page. */
export function savedDecisionNotice({draft, saved, storageFailed = false, storageIssue = ''} = {}) {
  if (draft) return 'استُعيدت مسودتك التي لم تُحفظ؛ اضغط «حفظ القرار» لتثبيتها.';
  if (!saved) return '';
  return storageFailed || storageIssue === STORAGE_UNAVAILABLE_NOTE
    ? 'القرار محفوظ لهذه الجلسة فقط؛ التخزين المحلي غير متاح. نزّل التقرير قبل إغلاق الصفحة.'
    : 'قرارك محفوظ في هذا المتصفح.';
}

/** "N من M محسومة" for the results step; the figures come from caseProgress, the same helper the dossier counts use. */
export function decisionProgressText(progress) {
  if (!progress?.cases) return 'لا توجد حالات فحص (بنيوية أو مقارنة) تحتاج حسماً.';
  const referred = progress.referred ? ` (منها ${arabicNumber(progress.referred)} إحالة لم تُغلق)` : '';
  const evidence = progress.evidenceSignals ? ` إشارات حالة الدليل (${arabicNumber(progress.evidenceSignals)}) لا تُعد حالات فحص.` : '';
  return `القرارات: ${arabicNumber(progress.resolved)} من ${arabicNumber(progress.cases)} محسومة · ${arabicNumber(progress.unresolved)} غير محسومة${referred}. المحسوم هو «تحتاج تصحيحاً» أو «إغلاق التنبيه» مع سبب.${evidence}`;
}

/** Caption under the signals metric card: the same unresolved count as the dossier. */
export function decisionMetricCaption(progress) {
  return progress?.cases ? `غير محسومة: ${arabicNumber(progress.unresolved)} من ${arabicNumber(progress.cases)} حالة فحص` : 'لا حالات فحص تحتاج حسماً';
}

/** Shown when earlier saved decisions exist whose evidence is not in this run. */
export function unappliedDecisionsNote(count) {
  return count > 0 ? `قرارات محفوظة سابقًا لم تُطبَّق: ${arabicNumber(count)}، لأن دليل الحالة تغيّر أو لم تعد الحالة ضمن هذا التشغيل. تبقى محفوظة وتعود إن عاد الدليل كما كان.` : '';
}

/** Creating a team workspace hides solo decisions from the counts; say so when there are any. */
export function teamSoloDecisionNotice(count) {
  return count > 0 ? `قراراتك الفردية المحفوظة (${arabicNumber(count)}) لن تُحتسب في وضع الفريق: ستظهر أعدادها صفرًا مؤقتًا في الشارات والملخص والملف. تبقى محفوظة وتعود عند «إنهاء وضع الفريق».` : '';
}
