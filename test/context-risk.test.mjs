import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditBatch } from '../public/modules/batch-engine.mjs';
import { inspectContextPair, inspectContextScript } from '../public/modules/context-language.mjs';
import {
  NLI_MODEL, CONTEXT_THRESHOLDS, BENCHMARK_CASES, BENCHMARK_DATASET,
  decodeNliLogits, aggregateContextScores, classifyContextResult,
  getEligibleContextRows, appendContextResults, runContextRisk, cancelContextRisk,
  evaluateBenchmark, evaluateLexicalBaseline, summarizeBenchmarkResults,
} from '../public/modules/context-risk.mjs';

// Injected probabilities and mocked worker messages test protocol/arithmetic,
// NOT trained inference, benchmark performance, or religious correctness.
const entail = { contradiction: 0.04, entailment: 0.9, neutral: 0.06 };
const contradict = { contradiction: 0.8, entailment: 0.1, neutral: 0.1 };
const uncertain = { contradiction: 0.05, entailment: 0.05, neutral: 0.9 };
function report({ verified = true, candidateLanguage = 'en', referenceLanguage = 'en', candidate = 'Bob approves Alice.', reference = 'Alice approves Bob.' } = {}) {
  return auditBatch({
    rows: [{ surah: 112, ayah: 1, translation: candidate, rowNumber: 8 }],
    referenceRows: [{ surah: 112, ayah: 1, translation: reference, sourceURL: 'https://example.org/edition/112/1', rawSha256: 'a'.repeat(64), normalizedSha256: 'b'.repeat(64) }],
    scope: { type: 'provided' },
    metadata: { candidate: { name: 'Authored synthetic pair', language: candidateLanguage }, reference: { language: referenceLanguage, verificationStatus: verified ? 'verified' : 'unverified', sourceKind: 'synthetic-teaching', title: 'NONRELIGIOUS authored fixture', edition: 'development-only', licenseNote: 'MIT' } },
  });
}
function rawResult(key, forward = contradict, reverse = contradict, extra = {}) {
  return aggregateContextScores(forward, reverse, {
    key, modelCalls: 2, pairTokens: 19, usedPairTokens: 19, referenceTokens: 8,
    candidateTokens: 8, truncated: false, inferredAt: '2026-10-03T00:00:00.000Z', ...extra,
  });
}

test('model is pinned with official weight provenance and explicit domain limitation', () => {
  assert.match(NLI_MODEL.revision, /^[a-f0-9]{40}$/);
  assert.match(NLI_MODEL.weightSha256, /^[a-f0-9]{64}$/);
  assert.equal(NLI_MODEL.dtype, 'q8');
  assert.equal(NLI_MODEL.modelDownloadMB, 172);
  assert.equal(NLI_MODEL.maxTokens, 512);
  assert.equal(NLI_MODEL.language, 'en');
  assert.equal(NLI_MODEL.license, 'Apache-2.0');
  assert.equal(NLI_MODEL.religiousDomainValidated, false);
  assert.equal(CONTEXT_THRESHOLDS.calibrated, false);
});

test('softmax uses actual label mapping rather than assumed logit order', () => {
  const decoded = decodeNliLogits([1002, 1001, 1000], { 0: 'NEUTRAL', 1: 'CONTRADICTION', 2: 'ENTAILMENT' });
  assert.ok(decoded.neutral > decoded.contradiction && decoded.contradiction > decoded.entailment);
  assert.ok(Math.abs(decoded.neutral + decoded.contradiction + decoded.entailment - 1) < 1e-12);
});

test('unknown labels, duplicate labels, malformed and nonfinite logits reject', () => {
  assert.throws(() => decodeNliLogits([1, 2, 3], { 0: 'LABEL_0', 1: 'LABEL_1', 2: 'LABEL_2' }));
  assert.throws(() => decodeNliLogits([1, 2, 3], { 0: 'neutral', 1: 'neutral', 2: 'entailment' }));
  assert.throws(() => decodeNliLogits([1, 2], { 0: 'contradiction', 1: 'entailment', 2: 'neutral' }));
  assert.throws(() => decodeNliLogits([Infinity, 2, 3], { 0: 'contradiction', 1: 'entailment', 2: 'neutral' }));
});

test('bidirectional aggregation retains direction and detects information asymmetry', () => {
  const forward = { contradiction: 0.02, entailment: 0.92, neutral: 0.06 };
  const reverse = { contradiction: 0.03, entailment: 0.1, neutral: 0.87 };
  const result = aggregateContextScores(forward, reverse);
  assert.equal(result.contradiction, 0.03);
  assert.equal(result.entailment, 0.1);
  assert.equal(result.neutral, 0.87);
  assert.ok(Math.abs(result.entailmentGap - 0.82) < 1e-12);
  assert.equal(result.forward.premise, 'reference');
  assert.equal(result.reverse.premise, 'candidate');
  assert.equal(classifyContextResult(result).reason, 'potential_information_change');
  assert.equal(result.scoreIsAccuracy, false);
  assert.equal(result.noApproval, true);
});

test('invalid probabilities reject even when finite', () => {
  assert.throws(() => aggregateContextScores({ contradiction: -0.1, entailment: 1, neutral: 0.1 }, entail));
  assert.throws(() => aggregateContextScores({ contradiction: 0.1, entailment: 0.1, neutral: 0.1 }, entail));
  assert.equal(classifyContextResult({ contradiction: 2, entailment: 0, entailmentGap: 0 }).outcome, 'abstain');
  assert.equal(classifyContextResult(null).outcome, 'abstain');
});

test('neutral abstains, experimental entailment gives no signal, truncation overrides risk', () => {
  assert.equal(classifyContextResult(aggregateContextScores(uncertain, uncertain)).outcome, 'abstain');
  assert.equal(classifyContextResult(aggregateContextScores(entail, entail)).outcome, 'no_signal');
  assert.equal(classifyContextResult(aggregateContextScores(contradict, contradict)).outcome, 'risk');
  assert.equal(classifyContextResult(aggregateContextScores(contradict, contradict, { truncated: true })).reason, 'input_truncated');
});

test('all changed valid English pairs eligible including current lexical no_signal', () => {
  const source = report();
  assert.equal(source.rows[0].status, 'no_signal');
  assert.equal(source.rows[0].findings.length, 0);
  assert.equal(getEligibleContextRows(source).length, 1);
  assert.equal(getEligibleContextRows(report({ verified: false })).length, 1);
  assert.equal(getEligibleContextRows(report({ candidateLanguage: 'en-US', referenceLanguage: 'English' })).length, 1);
});

test('identical, missing, duplicate, invalid, empty and cross-language pairs ineligible', () => {
  assert.equal(getEligibleContextRows(report({ candidate: 'Alice approves Bob.' })).length, 0);
  assert.equal(getEligibleContextRows(report({ candidateLanguage: 'ar' })).length, 0);
  assert.equal(getEligibleContextRows(report({ referenceLanguage: 'fr' })).length, 0);
  for (const reason of ['missing_reference', 'ambiguous_reference', 'duplicate_candidate', 'empty_translation', 'language_mismatch', 'invalid_verse_id']) {
    const source = report();
    source.rows[0].comparisonStatus = 'abstain';
    source.rows[0].comparisonReason = reason;
    assert.equal(getEligibleContextRows(source).length, 0, reason);
  }
  const duplicateKeys = report();
  duplicateKeys.rows.push(structuredClone(duplicateKeys.rows[0]));
  assert.equal(getEligibleContextRows(duplicateKeys).length, 0);
  const invalid = report();
  invalid.rows[0].verseId = null;
  assert.equal(getEligibleContextRows(invalid).length, 0);
  assert.equal(getEligibleContextRows(report({ candidate: ' ' })).length, 0);
});

test('declared English with Arabic, Cyrillic, CJK or mixed-script letters is excluded before inference', async () => {
  for (const candidate of ['هذا نص عربي.', 'Текст на русском.', '中文文本', 'Alice قرأت the book.', '123 😀']) {
    const source = report({ candidate });
    assert.equal(getEligibleContextRows(source).length, 0, candidate);
    const output = await runContextRisk(source);
    assert.equal(output.summary.contextProcessedRows, 0);
    assert.equal(output.summary.contextLanguageBlockedRows, 1);
    assert.equal(output.summary.contextAbstainRows, 1);
    assert.equal(output.rows[0].contextStatus, 'abstain');
    assert.equal(output.rows[0].contextLanguageGuard.detectsEnglish, false);
    assert.equal(output.rows[0].nli, undefined);
    assert.ok(output.rows[0].findings.some(item => item.code === 'context_language_mismatch'));
    assert.equal(output.provenance.analysis.trainedModelExecuted, false);
    assert.equal(source.rows[0].translation, candidate);
    const forged = appendContextResults(source, [rawResult(source.rows[0].key)], { actualInference: true, completed: true });
    assert.equal(forged.summary.contextProcessedRows, 0);
    assert.equal(forged.rows[0].nli, undefined);
    const rerun = appendContextResults(output);
    assert.equal(rerun.rows[0].findings.filter(item => item.code === 'context_language_mismatch').length, 1);
  }
});

test('script guard allows Latin accents and symbols, preserves text, and never claims to identify English', () => {
  for (const text of ['Alice reads ٢ books.', 'A café serves tea — 25%.', '😀 Bob reads a book.', 'Le chat dort.']) {
    const before = text;
    assert.equal(inspectContextScript(text).compatible, true);
    assert.equal(inspectContextScript(text).detectsEnglish, false);
    assert.equal(text, before);
  }
  assert.equal(inspectContextPair('Alice reads a book.', 'Аlice reads a book.').compatible, false);
  assert.equal(inspectContextPair('هذا عربي.', 'Alice reads a book.').compatible, false);
  assert.equal(getEligibleContextRows(report({ candidate: 'Le chat dort.', reference: 'Le chien dort.' })).length, 1);
  // Latin compatibility does not establish language: the user remains responsible for the declaration.
});

test('risk append is immutable, serializable, contextual review not approval', () => {
  const source = report();
  const output = appendContextResults(source, [rawResult(source.rows[0].key)], { actualInference: false });
  assert.equal(source.rows[0].nli, undefined);
  assert.equal(output.rows[0].status, 'needs_review');
  assert.equal(output.rows[0].findings[0].code, 'context_contradiction');
  assert.equal(output.rows[0].nli.actuallyInferred, false);
  assert.equal(output.provenance.analysis.trainedModelExecuted, false);
  assert.equal(output.summary.contextProcessedRows, 0);
  assert.equal(output.rows[0].nli.classification.outcome, 'risk');
  assert.equal(output.rows[0].findings[0].evidence.calibrated, false);
  assert.equal(output.rows[0].findings[0].evidence.humanReviewRequired, true);
  assert.doesNotThrow(() => JSON.stringify(output));
});

test('unverified user baseline cannot become no_signal or receive source authority from NLI', () => {
  const source = report({ verified: false });
  const output = appendContextResults(source, [rawResult(source.rows[0].key, entail, entail)], { actualInference: true, completed: true });
  assert.equal(output.rows[0].status, 'abstain');
  assert.equal(output.rows[0].comparisonReason, 'unverified_reference');
  assert.equal(output.rows[0].nli.classification.outcome, 'no_signal');
  assert.equal(output.rows[0].nli.referenceAuthorityChanged, false);
  assert.equal(output.rows[0].nli.experimentalUnverifiedReference, true);
  assert.equal(output.provenance.reference.verificationStatus, 'unverified');
  assert.equal(output.provenance.analysis.experimentalComparisonWithUnverifiedReferenceCount, 1);
  assert.deepEqual(output.rows[0].reference, source.rows[0].reference);
});

test('unverified contextual risk creates review rather than religious judgment', () => {
  const source = report({ verified: false });
  const output = appendContextResults(source, [rawResult(source.rows[0].key)], { actualInference: true });
  assert.equal(output.rows[0].status, 'needs_review');
  assert.equal(output.rows[0].reference.provenance.verificationStatus, 'unverified');
  assert.equal(output.rows[0].nli.noApproval, true);
});

test('uncertain/truncated rows abstain or retain existing structural and lexical findings', () => {
  const source = report();
  const uncertainReport = appendContextResults(source, [rawResult(source.rows[0].key, uncertain, uncertain)]);
  assert.equal(uncertainReport.rows[0].status, 'abstain');
  assert.equal(uncertainReport.rows[0].findings[0].code, 'context_uncertain');
  assert.equal(uncertainReport.summary.contextAbstainRows, 0);
  const actuallyUncertain = appendContextResults(source, [rawResult(source.rows[0].key, uncertain, uncertain)], {actualInference:true, completed:true});
  assert.equal(actuallyUncertain.summary.contextAbstainRows, 1);
  const truncated = appendContextResults(source, [rawResult(source.rows[0].key, contradict, contradict, { truncated: true, pairTokens: 800, usedPairTokens: 512 })]);
  assert.equal(truncated.rows[0].nli.classification.outcome, 'abstain');
  assert.equal(truncated.rows[0].findings[0].code, 'context_input_truncated');
  const negation = report({ candidate: 'Alice does not approve Bob.', reference: 'Alice approves Bob.' });
  const output = appendContextResults(negation, [rawResult(negation.rows[0].key, entail, entail)]);
  assert.equal(output.rows[0].status, 'needs_review');
  assert.ok(output.rows[0].findings.some((finding) => finding.code === 'potential_negation_change'));
});

test('rerun replaces findings and removes stale context scores and status', () => {
  const source = report();
  const first = appendContextResults(source, [rawResult(source.rows[0].key)], { actualInference: true, completed: true });
  const second = appendContextResults(first, [rawResult(source.rows[0].key)], { actualInference: true, completed: true });
  assert.equal(second.rows[0].findings.filter((finding) => finding.id.startsWith('context-')).length, 1);
  const cleared = appendContextResults(second, []);
  assert.equal(cleared.rows[0].nli, undefined);
  assert.equal(cleared.rows[0].status, 'no_signal');
  assert.equal(cleared.summary.contextProcessedRows, 0);
  assert.equal(cleared.provenance.analysis.trainedModelExecuted, false);
  assert.equal(cleared.provenance.analysis.mode, 'structural-and-lexical-rules');
});

test('wrong-model, nonfinite, unpaired, unrelated and repeated results never inflate coverage', () => {
  const source = report();
  const key = source.rows[0].key;
  const result = rawResult(key);
  const output = appendContextResults(source, [
    { ...result, model: 'another-model' }, { ...result, revision: 'main' },
    { ...result, modelCalls: 1 }, { ...result, forward: { ...contradict, neutral: NaN } },
    { ...result, key: 'absent' }, result, result,
  ], { actualInference: true, completed: true });
  assert.equal(output.summary.contextProcessedRows, 1);
  assert.equal(output.summary.contextRemainingRows, 0);
  assert.equal(output.provenance.analysis.contextCompleted, true);
});

test('partial coverage has explicit not_processed status on every remaining eligible row', () => {
  const source = report();
  source.rows.push({ ...structuredClone(source.rows[0]), key: 'second', verseId: '112:2', rowNumber: 9 });
  const output = appendContextResults(source, [rawResult(source.rows[0].key)], { actualInference: true, completed: false });
  assert.equal(output.rows[0].contextStatus, 'risk');
  assert.equal(output.rows[1].contextStatus, 'not_processed');
  assert.equal(output.rows[1].nli, undefined);
  assert.equal(output.summary.contextProcessedRows, 1);
  assert.equal(output.summary.contextRemainingRows, 1);
  const unexecuted = appendContextResults(source, [rawResult(source.rows[0].key)]);
  assert.equal(unexecuted.rows[0].contextStatus, 'not_processed');
});

test('18 visible nonreligious cases balanced with explicit unknowns and no independent validation', () => {
  assert.equal(BENCHMARK_CASES.length, 18);
  assert.equal(new Set(BENCHMARK_CASES.map((item) => item.id)).size, 18);
  assert.equal(BENCHMARK_CASES.filter((item) => item.expectedRisk === true).length, 8);
  assert.equal(BENCHMARK_CASES.filter((item) => item.expectedRisk === false).length, 8);
  assert.equal(BENCHMARK_CASES.filter((item) => item.expectedRisk == null).length, 2);
  assert.equal(BENCHMARK_DATASET.religiousText, false);
  assert.equal(BENCHMARK_DATASET.independentDomainValidation, false);
  assert.equal(BENCHMARK_DATASET.developmentFixture, true);
});

test('benchmark confusion includes risk abstention/missing as FN and separately reports unknowns', () => {
  const metrics = summarizeBenchmarkResults([
    { type: 'risk', expectedRisk: true, result: {}, predictedRisk: true, predictedOutcome: 'risk' },
    { type: 'risk', expectedRisk: true, result: {}, predictedRisk: false, predictedOutcome: 'abstain' },
    { type: 'risk', expectedRisk: true, result: null, predictedRisk: false, predictedOutcome: 'abstain' },
    { type: 'safe', expectedRisk: false, result: {}, predictedRisk: true, predictedOutcome: 'risk' },
    { type: 'safe', expectedRisk: false, result: {}, predictedRisk: false, predictedOutcome: 'no_signal' },
    { type: 'safe', expectedRisk: false, result: {}, predictedRisk: false, predictedOutcome: 'abstain' },
    { type: 'safe', expectedRisk: false, result: null, predictedRisk: false, predictedOutcome: 'abstain' },
    { type: 'unknown', expectedRisk: null, result: {}, predictedRisk: false, predictedOutcome: 'abstain' },
  ]);
  assert.deepEqual([metrics.TP, metrics.FP, metrics.FN, metrics.TN], [1, 1, 2, 2]);
  assert.equal(metrics.knownAbstentions, 2);
  assert.equal(metrics.riskCaseAbstentions, 1);
  assert.equal(metrics.safeNoSignalCases, 1);
  assert.equal(metrics.unknownCases, 1);
  assert.equal(metrics.unknownAbstentions, 1);
  assert.equal(metrics.missingCases, 2);
  assert.equal(metrics.byType.risk.FN, 2);
  assert.equal(metrics.recall, 1 / 3);
});

test('literal baseline exposes same-vocabulary relational and negation-scope misses', () => {
  const baseline = evaluateLexicalBaseline();
  assert.equal(baseline.trainedModelExecuted, false);
  assert.equal(baseline.cases.find((item) => item.id === 'scope-1').predictedRisk, false);
  assert.equal(baseline.cases.find((item) => item.id === 'role-1').predictedRisk, false);
  assert.equal(baseline.cases.find((item) => item.id === 'negative-1').predictedRisk, true);
  assert.ok(baseline.metrics.FN > 0);
  assert.equal(baseline.cases.length, 18);
});

test('no eligible pairs performs no worker creation/download and no trained claim', async () => {
  const oldWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { throw new Error('must not instantiate'); } };
  try {
    const output = await runContextRisk(report({ candidate: 'Alice approves Bob.' }));
    assert.equal(output.provenance.analysis.trainedModelExecuted, false);
    assert.equal(output.summary.contextEligibleRows, 0);
    assert.equal(output.summary.contextProcessedRows, 0);
    assert.equal(output.provenance.analysis.contextCompleted, true);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

test('unsupported runtime returns honest incomplete benchmark and counts all missing risk cases', async () => {
  const oldWorker = globalThis.Worker;
  globalThis.Worker = undefined;
  try {
    const output = await evaluateBenchmark();
    assert.equal(output.completed, false);
    assert.equal(output.trainedModelExecuted, false);
    assert.equal(output.processedCases, 0);
    assert.equal(output.metrics.FN, 8);
    assert.equal(output.metrics.TN, 0);
    assert.equal(output.metrics.missingCases, 18);
    assert.equal(output.metrics.unknownAbstentions, 0);
    assert.equal(output.cases.length, 18);
    assert.match(output.error, /Web Workers/);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

test('worker protocol preserves completed chunk after later error (mock protocol, not inference)', async () => {
  const oldWorker = globalThis.Worker;
  globalThis.Worker = class {
    postMessage({ id, inputs }) {
      queueMicrotask(() => {
        this.onmessage({ data: { id, event: 'chunk', results: [rawResult(inputs[0].key)] } });
        this.onmessage({ data: { id, event: 'error', message: 'Mock failure on subsequent pair', execution: { actualInference: true, modelCalls: 3 } } });
      });
    }
    terminate() {}
  };
  try {
    const source = report();
    const output = await runContextRisk(source);
    assert.equal(output.summary.contextProcessedRows, 1);
    assert.equal(output.rows[0].nli.modelCalls, 2);
    assert.equal(output.provenance.analysis.contextCompleted, false);
    assert.match(output.provenance.analysis.contextError, /Mock failure/);
    assert.equal(output.provenance.analysis.contextExecution.modelCalls, 3);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

test('worker protocol cancellation retains completed chunks (mock protocol only)', async () => {
  const oldWorker = globalThis.Worker;
  let terminateCalls = 0;
  globalThis.Worker = class {
    postMessage({ id, inputs }) {
      queueMicrotask(() => {
        this.onmessage({ data: { id, event: 'chunk', results: [rawResult(inputs[0].key)] } });
        cancelContextRisk('Mock user cancellation');
      });
    }
    terminate() { terminateCalls += 1; }
  };
  try {
    const output = await runContextRisk(report());
    assert.equal(terminateCalls, 1);
    assert.equal(output.summary.contextProcessedRows, 1);
    assert.equal(output.provenance.analysis.contextExecution.cancelled, true);
    assert.equal(output.provenance.analysis.contextCompleted, false);
  } finally { cancelContextRisk(); globalThis.Worker = oldWorker; }
});

test('worker source encodes true text_pair in both directions and uses actual config labels', async () => {
  const source = await readFile(new URL('../public/modules/context-risk-worker.mjs', import.meta.url), 'utf8');
  assert.match(source, /text_pair:\s*hypothesis/);
  assert.match(source, /inferDirection\(input\.premise, input\.hypothesis\)/);
  assert.match(source, /inferDirection\(input\.hypothesis, input\.premise\)/);
  assert.match(source, /model\.config\.id2label/);
  assert.match(source, /max_length:\s*spec\.maxTokens/);
  assert.match(source, /event:\s*'chunk'/);
  assert.doesNotMatch(source, /pipeline\(['"]text-classification/);
});

test('uploaded reference with unknown or undeclared language never feeds English NLI', async () => {
  assert.equal(getEligibleContextRows(report({ referenceLanguage: 'unknown' })).length, 0);
  assert.equal(getEligibleContextRows(report({ referenceLanguage: '' })).length, 0);
  const output = await runContextRisk(report({ referenceLanguage: 'unknown' }));
  assert.equal(output.provenance.analysis.contextProcessedRows, 0);
  assert.equal(output.provenance.analysis.contextEligibleRows, 0);
  assert.equal(output.provenance.analysis.trainedModelExecuted, false);
});

test('rule abstentions (numeric/qualifier syntax) stay abstain after the context step, never no_signal', async () => {
  const { auditBatch: audit } = await import('../src/batch-engine.mjs');
  for (const [candidate, reference, language = 'en'] of [
    ['About 3 boxes are here.', 'About 4 boxes are here.'],
    ['May the shop open.', 'May the shop open early.'],
    ['The clerk does not say the room is not ready.', 'The clerk does not say the room is ready.'],
    ['Le magasin est ouvert.', 'Le magasin est ouvert.', 'fr']
  ]) {
    const source = audit({ rows: [{ surah: 1, ayah: 1, translation: candidate }], referenceRows: [{ surah: 1, ayah: 1, translation: reference }], scope: { type: 'provided' }, metadata: { candidate: { language }, reference: { sourceKind: 'synthetic-teaching', verificationStatus: 'verified', language, title: 'synthetic' } } });
    assert.equal(source.rows[0].status, 'abstain', candidate);
    const output = appendContextResults(source, [], { actualInference: false, completed: true });
    assert.equal(output.rows[0].status, 'abstain', candidate);
    assert.equal(output.summary.noSignalRows, 0, candidate);
  }
});

test('injected entailment and a later empty rerun cannot erase a negation-scope abstention (protocol only)', () => {
  const source=report({candidate:'The clerk does not say the room is not ready.',reference:'The clerk does not say the room is ready.'});
  assert.equal(source.rows[0].status,'abstain');
  const enriched=appendContextResults(source,[rawResult(source.rows[0].key,entail,entail)],{actualInference:true,completed:true});
  assert.equal(enriched.rows[0].nli.classification.outcome,'no_signal');
  assert.equal(enriched.rows[0].status,'abstain');
  assert.equal(enriched.rows[0].negationReview.state,'abstain');
  const rerun=appendContextResults(enriched,[],{actualInference:false,completed:false});
  assert.equal(rerun.rows[0].status,'abstain');
  assert.ok(rerun.rows[0].findings.some(f=>f.code==='negation_comparison_abstain'));
});
