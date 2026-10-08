import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditBatch } from '../public/modules/batch-engine.mjs';
import { inspectContextPairForLanguage, MULTILINGUAL_CONTEXT_LANGUAGES } from '../public/modules/context-language.mjs';
import {
  NLI_MODEL, MULTILINGUAL_NLI_MODEL, CONTEXT_THRESHOLDS, decodeNliLogits, aggregateContextScores,
  getEligibleContextRows, appendContextResults, runContextRisk, cancelContextRisk, contextModelKeyOf,
} from '../public/modules/context-risk.mjs';
import { createRunManifest } from '../public/modules/run-manifest.mjs';

// Authored NONRELIGIOUS sentences and injected probabilities: protocol and gating only, not trained inference or accuracy.
const contradict = { contradiction: 0.8, entailment: 0.1, neutral: 0.1 };

test('language abstention counters follow an injected risk and removal without losing the rule limit (protocol only)',()=>{
  const source=report({candidateLanguage:'fr',referenceLanguage:'fr',candidate:'Le magasin est ouvert lundi.',reference:'Le magasin est fermé lundi.'});
  assert.equal(source.rows[0].status,'abstain');
  const result=aggregateContextScores(contradict,contradict,{key:source.rows[0].key,model:MULTILINGUAL_NLI_MODEL.id,revision:MULTILINGUAL_NLI_MODEL.revision,modelCalls:2,pairTokens:20,usedPairTokens:20,referenceTokens:9,candidateTokens:9,truncated:false});
  const enriched=appendContextResults(source,[result],{actualInference:true,completed:true},'multilingual');
  assert.equal(enriched.rows[0].status,'needs_review');
  assert.equal(enriched.summary.languageLimits.rowsLimited,1);
  assert.equal(enriched.summary.languageLimits.rowsAbstained,0);
  const rerun=appendContextResults(enriched,[],{actualInference:false,completed:false},'multilingual');
  assert.equal(rerun.rows[0].status,'abstain');
  assert.equal(rerun.summary.languageLimits.rowsAbstained,1);
});
function input({ candidateLanguage = 'ar', referenceLanguage = 'ar', candidate = 'المكتبة مغلقة يوم الاثنين.', reference = 'المكتبة مفتوحة يوم الاثنين.', mode = 'context-multi-requested' } = {}) {
  return {
    rows: [{ surah: 112, ayah: 1, translation: candidate, rowNumber: 2 }],
    referenceRows: [{ surah: 112, ayah: 1, translation: reference }],
    scope: { type: 'provided' },
    metadata: { candidate: { name: 'Authored synthetic pair', language: candidateLanguage }, reference: { language: referenceLanguage, verificationStatus: 'verified', sourceKind: 'synthetic-teaching', title: 'NONRELIGIOUS authored fixture' }, analysisMode: mode },
  };
}
const report = (options) => auditBatch(input(options));
const multiResult = (key, extra = {}) => aggregateContextScores(contradict, contradict, { key, modelCalls: 2, pairTokens: 20, usedPairTokens: 20, truncated: false, model: MULTILINGUAL_NLI_MODEL.id, revision: MULTILINGUAL_NLI_MODEL.revision, ...extra });

test('multilingual model is pinned with weight provenance, same uncalibrated thresholds and explicit limits', () => {
  assert.match(MULTILINGUAL_NLI_MODEL.revision, /^[a-f0-9]{40}$/);
  assert.match(MULTILINGUAL_NLI_MODEL.weightSha256, /^[a-f0-9]{64}$/);
  assert.equal(MULTILINGUAL_NLI_MODEL.dtype, 'q8');
  assert.equal(MULTILINGUAL_NLI_MODEL.maxTokens, 512);
  assert.equal(MULTILINGUAL_NLI_MODEL.religiousDomainValidated, false);
  assert.match(MULTILINGUAL_NLI_MODEL.license, /MIT/);
  assert.match(MULTILINGUAL_NLI_MODEL.trainingDataNote, /CC BY-NC/);
  for (const language of ['ar', 'en', 'fr', 'id', 'tr', 'ru', 'es', 'ur']) assert.ok(MULTILINGUAL_CONTEXT_LANGUAGES.includes(language), language);
  assert.equal(CONTEXT_THRESHOLDS.calibrated, false);
});

test('the upstream label order (entailment, neutral, contradiction) is decoded from config, not assumed', () => {
  const decoded = decodeNliLogits([0, 0, 5], { 0: 'entailment', 1: 'neutral', 2: 'contradiction' });
  assert.ok(decoded.contradiction > 0.9);
});

test('same-language Arabic or French pairs are eligible for the multilingual model and never for the English model', () => {
  assert.equal(getEligibleContextRows(report(), 'multilingual').length, 1);
  assert.equal(getEligibleContextRows(report(), 'en').length, 0);
  assert.equal(getEligibleContextRows(report({ candidateLanguage: 'fr', referenceLanguage: 'fr', candidate: 'La bibliothèque est fermée lundi.', reference: 'La bibliothèque est ouverte lundi.' }), 'multilingual').length, 1);
});

test('cross-language pairs (for example a translation against Arabic text) and unknown languages are never sent', () => {
  assert.equal(getEligibleContextRows(report({ candidateLanguage: 'en', referenceLanguage: 'ar', candidate: 'The library is closed on Monday.' }), 'multilingual').length, 0);
  assert.equal(getEligibleContextRows(report({ candidateLanguage: 'unknown', referenceLanguage: 'unknown' }), 'multilingual').length, 0);
  assert.equal(getEligibleContextRows(report({ candidateLanguage: 'ar', referenceLanguage: '' }), 'multilingual').length, 0);
});

test('letters outside the declared language script are blocked before inference and disclosed', async () => {
  const check = inspectContextPairForLanguage('fr', 'La bibliothèque est ouverte.', 'المكتبة مفتوحة.');
  assert.equal(check.compatible, false);
  assert.equal(check.candidate.reason, 'letters_outside_declared_script');
  const blocked = report({ candidateLanguage: 'fr', referenceLanguage: 'fr', candidate: 'المكتبة مغلقة.', reference: 'La bibliothèque est ouverte lundi.' });
  assert.equal(getEligibleContextRows(blocked, 'multilingual').length, 0);
  const output = await runContextRisk(blocked, undefined, { model: 'multilingual' });
  assert.equal(output.provenance.analysis.contextProcessedRows, 0);
  assert.equal(output.rows[0].contextNotEligibleReason, 'declared_language_script_incompatible');
  assert.ok(output.findings.some((finding) => finding.code === 'context_language_mismatch'));
});

test('multilingual results are accepted only from the multilingual model; English-model scores cannot fill a multilingual run', () => {
  const base = report();
  const key = base.rows[0].key;
  const english = aggregateContextScores(contradict, contradict, { key, modelCalls: 2, pairTokens: 20, usedPairTokens: 20, truncated: false });
  assert.equal(english.model, NLI_MODEL.id);
  const rejected = appendContextResults(base, [english], { actualInference: true, completed: true }, 'multilingual');
  assert.equal(rejected.provenance.analysis.contextProcessedRows, 0);
  const accepted = appendContextResults(base, [multiResult(key)], { actualInference: true, completed: true }, 'multilingual');
  assert.equal(accepted.provenance.analysis.contextProcessedRows, 1);
  assert.equal(accepted.provenance.analysis.contextModel.id, MULTILINGUAL_NLI_MODEL.id);
  assert.equal(contextModelKeyOf(accepted), 'multilingual');
  assert.ok(accepted.findings.some((finding) => finding.code === 'context_contradiction' && finding.evidence.model.id === MULTILINGUAL_NLI_MODEL.id));
  assert.ok(accepted.provenance.analysis.limitations.some((line) => /never compared with the Arabic Quran text/.test(line)));
  assert.equal(accepted.rows[0].status, 'needs_review');
});

test('the worker is asked for the multilingual model and receives the declared language with each pair (mock protocol)', async () => {
  const oldWorker = globalThis.Worker;
  let message;
  globalThis.Worker = class {
    postMessage(data) {
      message = data;
      queueMicrotask(() => {
        this.onmessage({ data: { id: data.id, event: 'chunk', results: [multiResult(data.inputs[0].key)] } });
        this.onmessage({ data: { id: data.id, event: 'result', execution: { actualInference: true, completed: true, model: MULTILINGUAL_NLI_MODEL.id } } });
      });
    }
    terminate() {}
  };
  try {
    const output = await runContextRisk(report(), undefined, { model: 'multilingual' });
    assert.equal(message.model, 'multilingual');
    assert.equal(message.inputs[0].language, 'ar');
    assert.equal(output.provenance.analysis.contextCompleted, true);
    assert.equal(output.summary.contextProcessedRows, 1);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

test('run manifest records the multilingual model as pinned, not unknown, and counts its processed pairs', async () => {
  const source = input();
  const base = auditBatch(source);
  const enriched = appendContextResults(base, [multiResult(base.rows[0].key)], { actualInference: true, completed: true }, 'multilingual');
  const manifest = await createRunManifest({ report: enriched, input: source });
  assert.equal(manifest.layers.context.model.id, MULTILINGUAL_NLI_MODEL.id);
  assert.equal(manifest.layers.context.model.revision, MULTILINGUAL_NLI_MODEL.revision);
  assert.equal(manifest.layers.context.processed, 1);
  assert.equal(manifest.layers.context.state, 'complete');
});

test('worker loads the model selected per request and checks the declared-language script gate', async () => {
  const source = await readFile(new URL('../public/modules/context-risk-worker.mjs', import.meta.url), 'utf8');
  assert.match(source, /CONTEXT_MODELS\[modelKey\]/);
  assert.match(source, /inspectContextPairForLanguage\(input\.language/);
  assert.match(source, /max_length:\s*spec\.maxTokens/);
});
