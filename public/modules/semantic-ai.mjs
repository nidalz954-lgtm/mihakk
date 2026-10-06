export const MODEL = Object.freeze({id: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', runtime: 'Transformers.js 3.8.1', dtype: 'q8', dimensions: 384, maxTokens: 512, license: 'MIT', modelDownloadMB: 118});
let worker, ready = false, sequence = 0;
const pending = new Map();
function ensureWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw new Error('المتصفح لا يدعم تشغيل النموذج محليًا.');
  worker = new Worker(new URL('./semantic-worker.mjs', import.meta.url), {type: 'module'});
  worker.onmessage = ({data}) => {
    const job = pending.get(data.id); if (!job) return;
    if (data.event === 'progress') { job.progress?.(data.progress); return; }
    pending.delete(data.id); clearTimeout(job.timer);
    data.event === 'error' ? job.reject(new Error(data.message)) : job.resolve(data.result);
  };
  worker.onerror = () => cancelSemanticAnalysis('تعذّر بدء النموذج في هذا المتصفح. جرّب Chrome أو Edge حديثًا.');
  return worker;
}
function request(action, payload, progress, timeoutMS = 600000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    try {
      const instance = ensureWorker();
      const timer = setTimeout(() => cancelSemanticAnalysis('انتهت مهلة النموذج. يمكنك متابعة الفحص البنيوي وإعادة المحاولة لاحقًا.'), timeoutMS);
      pending.set(id, {resolve, reject, progress, timer}); instance.postMessage({id, action, payload});
    } catch (error) { reject(error); }
  });
}
export function cancelSemanticAnalysis(message = 'أُلغي التحليل الذكي؛ نتائج الفحص البنيوي محفوظة.') {
  worker?.terminate(); worker = undefined; ready = false;
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(message)); }
  pending.clear();
}
export async function loadSemanticModel(onProgress) {
  if (!ready) { await request('load', {}, onProgress); ready = true; }
  return MODEL;
}
export function cosineSimilarity(a, b) {
  if (a.length !== b.length || !a.length) throw new Error('Embedding dimensions differ.');
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
  return an && bn ? Math.max(-1, Math.min(1, dot / Math.sqrt(an * bn))) : 0;
}
export function appendSemanticResults(report, results, execution = {}) {
  const enriched = structuredClone(report);
  const actualInference = execution.actualInference === true;
  const eligibleKeys = new Set(report.rows.filter(row => row.reference && row.comparisonStatus === 'compared' && row.translation !== row.reference.translation).map(row => row.key));
  let processed = 0;
  const seen = new Set();
  for (const result of results) {
    const row = enriched.rows.find(item => item.key === result.key);
    if (!actualInference || !eligibleKeys.has(result.key) || !row?.reference || row.comparisonStatus !== 'compared' || !Number.isFinite(result.similarity) || result.similarity < -1 || result.similarity > 1 || seen.has(result.key)) continue;
    seen.add(result.key);
    processed++;
    row.semantic = {cosineSimilarity: result.similarity, model: MODEL.id, revision: MODEL.revision, candidateTokens: result.candidateTokens, referenceTokens: result.referenceTokens, candidateTruncated: result.candidateTruncated, referenceTruncated: result.referenceTruncated, scoreIsAccuracy: false};
    // Uncalibrated ranking signal, never remove a structural or negation flag.
    if (result.similarity < 0.8 || result.candidateTruncated || result.referenceTruncated) {
      const finding = {
        id: `semantic-${row.key}`, code: result.candidateTruncated || result.referenceTruncated ? 'semantic_input_truncated' : 'semantic_distance', type: 'comparison', severity: 'medium',
        message: result.candidateTruncated || result.referenceTruncated ? 'النص أطول من حد النموذج؛ المقارنة الذكية جزئية وتتطلب قراءة النص كاملًا.' : 'النموذج رصد تباعدًا يستحق المقارنة البشرية؛ ليس حكمًا بصحة الترجمة.',
        reason: 'Uncalibrated multilingual embedding triage; neither theological judgment nor approval.', rowNumbers: [row.rowNumber], verseIds: [row.verseId], spans: [],
        evidence: {...row.semantic, threshold: 0.8, calibrated: false, humanReviewRequired: true, sourceURL: row.reference.provenance?.url},
      };
      row.findingIds.push(finding.id); row.findings.push(finding); row.status = 'needs_review'; enriched.findings.push(finding);
    }
  }
  const eligible = eligibleKeys.size;
  enriched.provenance.analysis = {...enriched.provenance.analysis, mode: 'structural-lexical-and-local-embedding', trainedModelExecuted: processed > 0, model: MODEL, semanticProcessedRows: processed, semanticEligibleRows: eligible, semanticRemainingRows: Math.max(0, eligible - processed), execution, limitations: [...enriched.provenance.analysis.limitations, 'Semantic cosine is an uncalibrated triage score, not accuracy or a religious ruling. Inputs beyond 512 tokens are marked truncated. Identical reference strings do not need model inference.']};
  enriched.summary = {...enriched.summary, findingsCount: enriched.findings.length, comparisonFindingCount: enriched.findings.filter(f => f.type === 'comparison').length, needsReviewRows: enriched.rows.filter(r => r.status === 'needs_review').length, noSignalRows: enriched.rows.filter(r => r.status === 'no_signal').length, abstainRows: enriched.rows.filter(r => r.status === 'abstain').length, semanticProcessedRows: processed, semanticEligibleRows: eligible};
  return enriched;
}
export async function enrichReportWithAI(report, onProgress) {
  const inputs = report.rows.filter(row => row.reference && row.comparisonStatus === 'compared' && row.translation !== row.reference.translation).map(row => ({key: row.key, candidate: row.translation, reference: row.reference.translation}));
  if (!inputs.length) return appendSemanticResults(report, [], {actualInference:false, completed:true, reason: 'No eligible different same-language reference pairs; no model inference.'});
  await loadSemanticModel(onProgress);
  const started = performance.now();
  const results = await request('compare', {inputs}, onProgress, 3600000);
  return appendSemanticResults(report, results, {actualInference:results.length > 0, completed:results.length === inputs.length, device: 'wasm-cpu-worker', elapsedMS: Math.round(performance.now() - started), inferredAt: new Date().toISOString()});
}
