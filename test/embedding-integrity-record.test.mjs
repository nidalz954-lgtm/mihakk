import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMBEDDING_WEIGHT, enrichReportWithAI, cancelSemanticAnalysis } from '../public/modules/semantic-ai.mjs';
import { aiExecutionState } from '../public/modules/dossier.mjs';

// P2-04: an integrity refusal (or any failure) of the E5 weight file must leave a weight-integrity record in the saved report,
// like the NLI path does with contextWeightIntegrity. SYNTHETIC bytes and mocked workers only; no model is downloaded here.
const refused = (observed = 'a'.repeat(64)) => ({
  method: 'sha256-streaming-before-session', declaredSha256: EMBEDDING_WEIGHT.sha256, observedSha256: observed, weightVerified: false, status: 'mismatch', bytes: 1234, elapsedMS: 5, note: 'x',
});
function embeddingReport(count = 2) {
  const rows = Array.from({ length: count }, (_, index) => ({ key: `r${index + 1}`, rowNumber: index + 1, verseId: `1:${index + 1}`, status: 'no_signal', translation: `candidate ${index}`, reference: { translation: `reference ${index}`, provenance: { url: 'https://example.invalid/ref' } }, comparisonStatus: 'compared', findingIds: [], findings: [] }));
  return { rows, findings: [], summary: {}, provenance: { analysis: { requestedMode: 'embedding-requested', limitations: [] } } };
}
// What app.js does with a failed embedding run (its catch block), so the test follows the real saved-report path.
async function runLikeApp(report) {
  try { return await enrichReportWithAI(report); }
  catch (error) { report.provenance.analysis.modelError = error.message; return report; }
}
function withWorker(handler, body) {
  return async () => {
    const oldWorker = globalThis.Worker;
    globalThis.Worker = class {
      postMessage(message) { queueMicrotask(() => handler(message, data => this.onmessage({ data }))); }
      terminate() {}
    };
    try { await body(); } finally { cancelSemanticAnalysis(); globalThis.Worker = oldWorker; }
  };
}

test('P2-04 a refused E5 weight file leaves a mismatch record in the report and the run still fails closed', withWorker(
  ({ id, action }, reply) => reply({ id, event: 'error', errorKind: 'integrity', technicalDetails: 'x', weightIntegrity: refused(), message: 'لم يكتمل الذكاء الاصطناعي: رُفض ملف النموذج لأن بصمته لا تطابق البصمة المثبتة. لا تُعد النتائج البنيوية تحليلًا ذكيًا.' }),
  async () => {
    const report = embeddingReport(2);
    await assert.rejects(() => enrichReportWithAI(report), error => {
      assert.match(error.message, /بصمته لا تطابق/);
      assert.equal(error.weightIntegrity.status, 'mismatch');
      return true;
    });
    const saved = await runLikeApp(embeddingReport(2));
    const record = saved.provenance.analysis.embeddingWeightIntegrity;
    assert.equal(record.status, 'mismatch');
    assert.equal(record.weightVerified, false);
    assert.equal(record.declaredSha256, EMBEDDING_WEIGHT.sha256);
    assert.equal(record.observedSha256, 'a'.repeat(64));
    assert.equal(saved.provenance.analysis.trainedModelExecuted, undefined, 'no model result is claimed');
    assert.match(saved.provenance.analysis.modelError, /بصمته لا تطابق/);
    assert.equal(aiExecutionState(saved).state, 'failed');
  },
));

test('P2-04 the record is re-derived on this side: a worker cannot report verified for a different hash', withWorker(
  ({ id }, reply) => reply({ id, event: 'error', weightIntegrity: { ...refused('b'.repeat(64)), weightVerified: true, status: 'verified' }, message: 'لم يكتمل الذكاء الاصطناعي: خطأ.' }),
  async () => {
    const saved = await runLikeApp(embeddingReport(1));
    assert.equal(saved.provenance.analysis.embeddingWeightIntegrity.status, 'mismatch');
    assert.equal(saved.provenance.analysis.embeddingWeightIntegrity.weightVerified, false);
  },
));

test('P2-04 a failure before the weight file was read records declared_not_verified, never verified', withWorker(
  ({ id }, reply) => reply({ id, event: 'error', weightIntegrity: { weightVerified: false, observedSha256: null, bytes: null }, message: 'لم يكتمل الذكاء الاصطناعي: تعذّر تنزيل ملفات النموذج.' }),
  async () => {
    const saved = await runLikeApp(embeddingReport(1));
    assert.equal(saved.provenance.analysis.embeddingWeightIntegrity.status, 'declared_not_verified');
    assert.equal(saved.provenance.analysis.embeddingWeightIntegrity.weightVerified, false);
    assert.equal(saved.provenance.analysis.embeddingWeightIntegrity.observedSha256, null);
  },
));

test('P2-04 a worker that sends no integrity data (older worker, cancel) adds no record and nothing breaks', withWorker(
  ({ id }, reply) => reply({ id, event: 'error', message: 'لم يكتمل الذكاء الاصطناعي: خطأ عام.' }),
  async () => {
    const saved = await runLikeApp(embeddingReport(1));
    assert.equal('embeddingWeightIntegrity' in saved.provenance.analysis, false);
    assert.match(saved.provenance.analysis.modelError, /خطأ عام/);
  },
));

test('P2-04 a failure after the weights loaded and some pairs finished keeps the verified record of the load', withWorker(
  ({ id, action, payload }, reply) => {
    if (action === 'load') { reply({ id, event: 'result', result: { ready: true, weightIntegrity: { weightVerified: true, observedSha256: EMBEDDING_WEIGHT.sha256, bytes: EMBEDDING_WEIGHT.bytes } } }); return; }
    reply({ id, event: 'chunk', results: [{ key: payload.inputs[0].key, similarity: 0.95, candidateTokens: 4, referenceTokens: 4, candidateTruncated: false, referenceTruncated: false }] });
    reply({ id, event: 'error', weightIntegrity: { weightVerified: true, observedSha256: EMBEDDING_WEIGHT.sha256, bytes: EMBEDDING_WEIGHT.bytes }, message: 'لم يكتمل الذكاء الاصطناعي: نفدت ذاكرة المتصفح.' });
  },
  async () => {
    const output = await enrichReportWithAI(embeddingReport(2));
    assert.equal(output.provenance.analysis.semanticProcessedRows, 1);
    assert.equal(output.provenance.analysis.embeddingWeightIntegrity.status, 'verified');
  },
));

test('P2-04 the E5 worker adds its integrity summary to every error event', async () => {
  const source = await readFile(new URL('../public/modules/semantic-worker.mjs', import.meta.url), 'utf8');
  assert.match(source, /event: 'error',[^\n]*weightIntegrity: guard\.summary\(pin\)/);
});
