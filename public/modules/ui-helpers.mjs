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

// ASCII and full-width spreadsheet formula prefixes, after optional spaces, a BOM or invisible zero-width / direction controls.
const FORMULA_PREFIX = /^[\s\uFEFF\u3000\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]*[=+\-@＝＋－＠−]/;
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
