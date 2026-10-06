/** Local revision comparison. Raw differences and decisions never certify meaning or rights. */
export const REVISION_METHOD_VERSION = 'revision-v1';
export const REVISION_LIMITS = Object.freeze({rowsPerSide: 20000, textUnits: 20000, inputBytes: 10 * 1024 * 1024, reasonUnits: 5000});
const encoder = new TextEncoder();
const decisions = new Set(['reviewed', 'needs_revision', 'deferred']);
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = (code, message) => ({schemaVersion: 1, methodVersion: REVISION_METHOD_VERSION, error: {code, message}, certificate: false, publicationAuthorized: false});
const keys = (value, allowed) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

// Numeric coordinates may arrive from CSV as strings; raw row evidence stays unchanged.
function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/[\u0660-\u0669]/g, c => String(c.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, c => String(c.charCodeAt(0) - 0x6f0));
  if (!/^\d+$/.test(digits)) return null;
  const number = Number(digits);
  return Number.isSafeInteger(number) ? number : null;
}
const coordinate = value => integer(value) > 0 ? integer(value) : null;
const idOf = row => {
  const surah = integer(row?.surah), ayah = integer(row?.ayah);
  return surah >= 1 && surah <= 114 && ayah > 0 ? `${surah}:${ayah}` : null;
};
const validRow = row => idOf(row) !== null && coordinate(row?.rowNumber) !== null && typeof row?.translation === 'string' && row.translation.trim().length > 0;
const hidden = text => Array.from(text).filter(c => /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u.test(c)).join('');

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function jsonSnapshot(value) {
  const seen = new Set();
  const inspect = (item, depth = 0) => {
    if (depth > 64) throw new TypeError('JSON nesting exceeds 64 levels');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (typeof item !== 'object' || seen.has(item)) throw new TypeError('Only finite serializable JSON values are accepted');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Only plain JSON objects are accepted');
    seen.add(item);
    if (Array.isArray(item)) for (let i = 0; i < item.length; i++) inspect(item[i], depth + 1);
    else for (const key of Object.keys(item)) inspect(item[key], depth + 1);
    seen.delete(item);
  };
  inspect(value);
  const text = JSON.stringify(value);
  if (encoder.encode(text).byteLength > REVISION_LIMITS.inputBytes) return failure('INPUT_LIMIT', 'JSON exceeds 10 MiB');
  return {input: JSON.parse(text)};
}

async function digest(value) {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto SHA-256 is unavailable; use a secure origin or localhost');
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function rawDiff(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return {prefixLength: prefix, oldSpan: [prefix, before.length - suffix], newSpan: [prefix, after.length - suffix], oldText: before.slice(prefix, before.length - suffix), newText: after.slice(prefix, after.length - suffix)};
}

/** Async only because SHA-256 uses browser WebCrypto. signal cancels without claiming partial success. */
export async function compareRevisions(rawInput, {signal, onProgress} = {}) {
  if (signal?.aborted) return failure('CANCELLED', 'Revision comparison was cancelled');
  let snapshot;
  try { snapshot = jsonSnapshot(rawInput); } catch { return failure('INVALID_JSON', 'Input must be finite plain JSON without cycles or excessive nesting'); }
  if (snapshot.error) return snapshot;
  const input = snapshot.input;
  if (!keys(input, ['schemaVersion', 'candidate', 'baseline', 'scope', 'candidateMeta', 'baselineMeta', 'sameTranslationAssertion', 'options']) || input.schemaVersion !== 1) return failure('INVALID_INPUT', 'Invalid schema or unknown input key');
  if (input.sameTranslationAssertion !== true) return failure('MODE_REQUIRES_DECLARATION', 'Declare comparison of revisions of the same translation');
  if (!keys(input.options, ['methodVersion', 'normalization']) || input.options.methodVersion !== REVISION_METHOD_VERSION || input.options.normalization !== 'raw-only') return failure('INVALID_OPTIONS', 'Only revision-v1 raw-only is supported');
  for (const side of ['candidate', 'baseline']) {
    if (!Array.isArray(input[side]) || input[side].length > REVISION_LIMITS.rowsPerSide) return failure('ROW_LIMIT', 'Each side requires at most 20000 rows');
    if (input[side].some(row => typeof row?.translation === 'string' && row.translation.length > REVISION_LIMITS.textUnits)) return failure('TEXT_LIMIT', 'Text exceeds 20000 UTF-16 units');
    const metadata = input[`${side}Meta`];
    if (!keys(metadata, ['identity', 'edition', 'language', 'rightsNote']) || ['identity', 'edition', 'language', 'rightsNote'].some(key => typeof metadata[key] !== 'string')) return failure('INVALID_METADATA', 'Metadata requires four declared string fields');
  }
  if (!Array.isArray(input.scope) || !input.scope.length || input.scope.length > 20000) return failure('INVALID_SCOPE', 'Explicit nonempty interval scope required');
  // Scope coordinates must be numeric integers, not inferred from uploaded rows.
  let expectedIds = 0;
  const intervals = [];
  for (const interval of input.scope) {
    if (!keys(interval, ['surah', 'fromAyah', 'toAyah']) || !Number.isSafeInteger(interval.surah) || interval.surah < 1 || interval.surah > 114 || !Number.isSafeInteger(interval.fromAyah) || interval.fromAyah < 1 || !Number.isSafeInteger(interval.toAyah) || interval.toAyah < interval.fromAyah) return failure('INVALID_SCOPE', 'Invalid scope interval');
    expectedIds += interval.toAyah - interval.fromAyah + 1;
    if (!Number.isSafeInteger(expectedIds)) return failure('INVALID_SCOPE', 'Scope coverage exceeds safe integer range');
    intervals.push(interval);
  }
  intervals.sort((a, b) => a.surah - b.surah || a.fromAyah - b.fromAyah);
  for (let i = 1; i < intervals.length; i++) if (intervals[i].surah === intervals[i - 1].surah && intervals[i].fromAyah <= intervals[i - 1].toAyah) return failure('INVALID_SCOPE', 'Overlapping scope intervals');
  const bySurah = new Map();
  for (const interval of intervals) {
    if (!bySurah.has(interval.surah)) bySurah.set(interval.surah, []);
    bySurah.get(interval.surah).push(interval);
  }
  const inside = row => (bySurah.get(integer(row?.surah)) || []).some(interval => integer(row?.ayah) >= interval.fromAyah && integer(row?.ayah) <= interval.toAyah);
  try {
    const [contextFingerprint, candidateDigest, baselineDigest] = await Promise.all([digest(input), digest(input.candidate), digest(input.baseline)]);
    if (signal?.aborted) return failure('CANCELLED', 'Revision comparison was cancelled');
    const groups = new Map(), records = [], ledger = {candidate: [], baseline: []};
    for (const side of ['candidate', 'baseline']) input[side].forEach((row, inputIndex) => {
      const entry = {inputIndex, rowNumber: coordinate(row?.rowNumber), state: null, recordKey: null};
      ledger[side].push(entry);
      const id = idOf(row);
      if (id === null) {
        const recordKey = `${side}:${inputIndex}`;
        Object.assign(entry, {state: 'invalid_row', recordKey});
        records.push({recordKey, id: null, state: 'invalid_row', candidateRows: side === 'candidate' ? [coordinate(row?.rowNumber)] : [], baselineRows: side === 'baseline' ? [coordinate(row?.rowNumber)] : [], candidateEvidence: side === 'candidate' ? [row] : [], baselineEvidence: side === 'baseline' ? [row] : [], reason: 'invalid_id'});
        return;
      }
      if (!inside(row)) { entry.state = 'out_of_scope'; return; }
      if (!groups.has(id)) groups.set(id, {candidate: [], baseline: []});
      groups.get(id)[side].push({row, inputIndex});
    });
    const ordered = [...groups].sort((a, b) => { const x = a[0].split(':').map(Number), y = b[0].split(':').map(Number); return x[0] - y[0] || x[1] - y[1]; });
    for (const [id, group] of ordered) {
      const candidate = group.candidate, baseline = group.baseline;
      const state = candidate.length > 1 || baseline.length > 1 ? 'ambiguous_duplicate' : [...candidate, ...baseline].some(item => !validRow(item.row)) ? 'invalid_row' : !baseline.length ? 'added_id' : !candidate.length ? 'removed_id' : candidate[0].row.translation === baseline[0].row.translation ? 'identical_raw' : 'text_change';
      const record = {recordKey: id, id, state, candidateRows: candidate.map(item => coordinate(item.row.rowNumber)), baselineRows: baseline.map(item => coordinate(item.row.rowNumber)), candidateEvidence: candidate.map(item => item.row), baselineEvidence: baseline.map(item => item.row), flags: {hiddenControlChanged: false, unicodeNormalizationEquivalent: false}};
      if (candidate.length === 1 && typeof candidate[0].row.translation === 'string') record.candidateText = candidate[0].row.translation;
      if (baseline.length === 1 && typeof baseline[0].row.translation === 'string') record.baselineText = baseline[0].row.translation;
      if (state === 'text_change') {
        record.rawDiff = rawDiff(record.baselineText, record.candidateText);
        record.flags = {hiddenControlChanged: hidden(record.baselineText) !== hidden(record.candidateText), unicodeNormalizationEquivalent: record.baselineText.normalize('NFC') === record.candidateText.normalize('NFC')};
      }
      for (const side of ['candidate', 'baseline']) for (const item of group[side]) Object.assign(ledger[side][item.inputIndex], {state, recordKey: id});
      records.push(record);
    }
    // Small digest batches avoid queuing 20,000 simultaneous browser crypto operations.
    for (let offset = 0; offset < records.length; offset += 64) {
      if (signal?.aborted) return failure('CANCELLED', 'Revision comparison was cancelled');
      await Promise.all(records.slice(offset, offset + 64).map(async record => {
        record.evidenceFingerprint = await digest({record, scope: input.scope, candidateMeta: input.candidateMeta, baselineMeta: input.baselineMeta, options: input.options});
        record.contextFingerprint = contextFingerprint;
      }));
      if (typeof onProgress === 'function') onProgress({completed: Math.min(offset + 64, records.length), total: records.length});
    }
    if (signal?.aborted) return failure('CANCELLED', 'Revision comparison was cancelled');
    const states = {};
    for (const record of records) states[record.state] = (states[record.state] ?? 0) + 1;
    const coverage = {};
    for (const side of ['candidate', 'baseline']) {
      const entries = ledger[side];
      const observedIds = new Set(entries.filter(entry => entry.recordKey && !entry.recordKey.startsWith(`${side}:`)).map(entry => entry.recordKey));
      coverage[side] = {readRows: entries.length, withinScopeRows: entries.filter(entry => entry.state !== 'out_of_scope' && !entry.recordKey?.startsWith(`${side}:`)).length, observedScopedIds: observedIds.size, unobservedExpectedIds: expectedIds - observedIds.size, abstainedRows: entries.filter(entry => ['invalid_row', 'ambiguous_duplicate'].includes(entry.state)).length, outOfScopeRows: entries.filter(entry => entry.state === 'out_of_scope').length};
    }
    const report = {schemaVersion: 1, methodVersion: REVISION_METHOD_VERSION, inputDigests: {candidate: candidateDigest, baseline: baselineDigest}, contextFingerprint, scope: input.scope, metadata: {candidate: input.candidateMeta, baseline: input.baselineMeta}, records, ledger, counts: {records: records.length, scopedUnionIds: groups.size, candidateRows: ledger.candidate.length, baselineRows: ledger.baseline.length, states}, coverage: {expectedScopedIds: expectedIds, eligibleMatchedRecords: (states.identical_raw ?? 0) + (states.text_change ?? 0), ...coverage}, warnings: ['Source identity and rights are user declarations, not verified.'], limitations: ['Raw change is not a meaning error.', 'Ayah maxima are not validated against a Quran index; use structural audit separately.', 'A contiguous replacement span is not a minimal edit script; offsets are UTF-16 units.', 'Decisions reopen on any context change.', 'Hidden control list: U+200B..200F,202A..202E,2060..2069,FEFF.'], certificate: false, publicationAuthorized: false};
    report.reportFingerprint = await digest(report);
    return signal?.aborted ? failure('CANCELLED', 'Revision comparison was cancelled') : report;
  } catch (error) {
    return failure('COMPARISON_FAILED', error?.message || 'Revision comparison failed');
  }
}

function validDecision(decision) {
  return keys(decision, ['recordKey', 'evidenceFingerprint', 'contextFingerprint', 'decision', 'reason', 'status', 'staleReason']) && typeof decision.recordKey === 'string' && fingerprint(decision.evidenceFingerprint) && fingerprint(decision.contextFingerprint) && decisions.has(decision.decision) && typeof decision.reason === 'string' && decision.reason.trim().length > 0 && decision.reason.length <= REVISION_LIMITS.reasonUnits;
}

function validReportRecords(report) {
  return fingerprint(report?.contextFingerprint) && Array.isArray(report?.records) && report.records.every(record => record && typeof record === 'object' && !Array.isArray(record) && typeof record.recordKey === 'string' && fingerprint(record.evidenceFingerprint) && record.contextFingerprint === report.contextFingerprint);
}

export function bindDecision(record, decision) {
  if (typeof record?.recordKey !== 'string' || !fingerprint(record?.evidenceFingerprint) || !fingerprint(record?.contextFingerprint) || !decision || !decisions.has(decision.decision) || typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > REVISION_LIMITS.reasonUnits || decision.evidenceFingerprint !== record.evidenceFingerprint || decision.contextFingerprint !== record.contextFingerprint) return failure('INVALID_DECISION', 'A reason and current evidence/context fingerprints are required');
  return {recordKey: record.recordKey, evidenceFingerprint: record.evidenceFingerprint, contextFingerprint: record.contextFingerprint, decision: decision.decision, reason: decision.reason};
}

export function reconcileDecisions(previousDecisions, newReport) {
  if (!Array.isArray(previousDecisions) || previousDecisions.some(decision => !validDecision(decision)) || newReport?.error || !validReportRecords(newReport)) return failure('INVALID_RECONCILIATION', 'Requires valid decisions and a successful report');
  const current = new Map(newReport.records.map(record => [record.recordKey, record]));
  return previousDecisions.map(decision => {
    const record = current.get(decision.recordKey);
    const staleReason = !record ? 'missing_record' : decision.evidenceFingerprint !== record.evidenceFingerprint ? 'evidence_changed' : decision.contextFingerprint !== newReport.contextFingerprint ? 'context_changed' : null;
    // Remove previous stale labels when exactly the old context is restored.
    const {status, staleReason: previousReason, ...bound} = decision;
    return {...bound, status: staleReason ? 'stale' : 'active', ...(staleReason ? {staleReason} : {})};
  });
}

/** Default export redacts every baseline evidence object, including malformed coordinates. */
export function exportReport(report, options = {}) {
  const includeReferenceText = options?.includeReferenceText === true;
  let copy;
  try { copy = JSON.parse(JSON.stringify(report)); } catch { return failure('INVALID_REPORT', 'Report must be serializable JSON'); }
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) return failure('INVALID_REPORT', 'Report object required');
  if (!copy.error && !validReportRecords(copy)) return failure('INVALID_REPORT', 'Successful report records must bind to their declared context');
  if (!includeReferenceText && Array.isArray(copy.records)) for (const record of copy.records) {
    delete record.baselineText;
    delete record.baselineEvidence;
    if (record.rawDiff) delete record.rawDiff.oldText;
  }
  copy.referenceTextIncluded = includeReferenceText;
  return copy;
}
