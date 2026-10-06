import { BENCHMARK_CASES, BENCHMARK_DATASET } from './benchmark-fixtures.mjs';
import { auditBatch } from './batch-engine.mjs';
import { inspectContextPair, CONTEXT_LANGUAGE_GUARD, inspectContextPairForLanguage, MULTILINGUAL_LANGUAGE_GUARD, MULTILINGUAL_CONTEXT_LANGUAGES } from './context-language.mjs';

/** Pinned official ONNX derivative; no claim of Quran-domain accuracy. */
export const NLI_MODEL = Object.freeze({
  id: 'Xenova/nli-deberta-v3-small',
  revision: '6bc2a55c7c0f7e2bc68de60bb248e523e2612abb',
  runtime: 'Transformers.js 3.8.1',
  dtype: 'q8',
  modelDownloadMB: 172,
  weightFile: 'onnx/model_quantized.onnx',
  weightSha256: '4edae6adf6ef735d3983a052113e8a235da2e9ac6a6cadf33f3fc088117e6051',
  maxTokens: 512,
  language: 'en',
  license: 'Apache-2.0',
  licenseURL: 'https://huggingface.co/cross-encoder/nli-deberta-v3-small',
  modelCardURL: 'https://huggingface.co/Xenova/nli-deberta-v3-small',
  configURL: 'https://huggingface.co/Xenova/nli-deberta-v3-small/blob/6bc2a55c7c0f7e2bc68de60bb248e523e2612abb/config.json',
  revisionURL: 'https://huggingface.co/Xenova/nli-deberta-v3-small/commit/6bc2a55c7c0f7e2bc68de60bb248e523e2612abb',
  trainedOn: ['SNLI', 'MultiNLI'],
  religiousDomainValidated: false,
  use: 'Experimental English pairwise contextual review signal; no certification or automatic approval.',
});

/** Pinned ONNX derivative of a multilingual NLI cross-encoder. Same thresholds as the English model; no tuning on evaluation data. */
export const MULTILINGUAL_NLI_MODEL = Object.freeze({
  id: 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7',
  revision: '0864ced79bf1ef851bfaf9dd9de0aa54d735d9d0',
  runtime: 'Transformers.js 3.8.1',
  dtype: 'q8',
  modelDownloadMB: 339,
  weightFile: 'onnx/model_quantized.onnx',
  weightSha256: 'ccb655bf617edf1d3b0ccdc5b4576a4322e28cee5ce9ab8cd21af4b1f13e6836',
  maxTokens: 512,
  language: 'multilingual',
  languages: MULTILINGUAL_CONTEXT_LANGUAGES,
  license: 'MIT (upstream MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7); the ONNX repository declares no separate license',
  licenseURL: 'https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7',
  modelCardURL: 'https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7',
  configURL: 'https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/blob/0864ced79bf1ef851bfaf9dd9de0aa54d735d9d0/config.json',
  revisionURL: 'https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/commit/0864ced79bf1ef851bfaf9dd9de0aa54d735d9d0',
  trainedOn: ['multilingual-NLI-26lang-2mil7 (machine-translated)', 'XNLI', 'MultiNLI', 'ANLI (CC BY-NC 4.0)', 'FEVER-NLI', 'LingNLI', 'WANLI'],
  trainingDataNote: 'Training data includes facebook/anli under CC BY-NC 4.0; non-commercial terms may apply and must be reviewed before any commercial deployment.',
  religiousDomainValidated: false,
  use: 'Experimental same-language pairwise contextual review signal (two texts in the same declared language); no cross-language comparison, no certification or automatic approval.',
});
export const CONTEXT_MODELS = Object.freeze({ en: NLI_MODEL, multilingual: MULTILINGUAL_NLI_MODEL });
export function contextModelSpec(key) { return CONTEXT_MODELS[key] ?? NLI_MODEL; }
/** Which context model a report was run with; reports from earlier versions are English. */
export function contextModelKeyOf(report) {
  const analysis = report?.provenance?.analysis ?? {};
  if (analysis.contextModel?.id === MULTILINGUAL_NLI_MODEL.id) return 'multilingual';
  if (!analysis.contextModel && String(analysis.analysisMode ?? analysis.mode ?? '').startsWith('context-multi')) return 'multilingual';
  return 'en';
}
export function knownContextModel(id, revision) { return Object.values(CONTEXT_MODELS).find((model) => model.id === id && model.revision === revision) ?? null; }

export const CONTEXT_THRESHOLDS = Object.freeze({
  contradiction: 0.65,
  entailment: 0.55,
  entailmentGap: 0.45,
  lowEntailment: 0.30,
  calibrated: false,
  selectedBeforeDevelopmentEvaluation: true,
});

const KNOWN_LABELS = ['contradiction', 'entailment', 'neutral'];
const MAX_CONTEXT_ROWS = 20000;
let worker;
let sequence = 0;
const pending = new Map();

function languageBase(value) {
  const language = String(value ?? '').trim().toLowerCase();
  if (language === 'english') return 'en';
  if (language === 'arabic' || language === 'العربية') return 'ar';
  return language.split(/[-_]/)[0];
}
function english(value) {
  const language = String(value ?? '').trim().toLowerCase();
  return language === 'english' || /^en(?:[-_].*)?$/.test(language);
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function nowMS() { return globalThis.performance?.now?.() ?? Date.now(); }

export function getDeclaredEnglishContextRows(report) {
  if (!Array.isArray(report?.rows) || !english(report.provenance?.candidate?.language)) return [];
  const keyCounts = new Map();
  for (const row of report.rows) keyCounts.set(row.key, (keyCounts.get(row.key) ?? 0) + 1);
  return report.rows.filter((row) => {
    const referenceLanguage = row.reference?.provenance?.language || report.provenance?.reference?.language;
    return typeof row.key === 'string' && keyCounts.get(row.key) === 1 && row.verseId && row.reference && english(referenceLanguage)
      && (row.comparisonStatus === 'compared' || row.comparisonReason === 'unverified_reference')
      && nonempty(row.translation) && nonempty(row.reference.translation)
      && row.translation !== row.reference.translation;
  });
}

/** Same-language pairs for the multilingual model: candidate and reference declare the same supported language. */
export function getDeclaredMultilingualContextRows(report) {
  if (!Array.isArray(report?.rows)) return [];
  const candidateLanguage = languageBase(report.provenance?.candidate?.language);
  if (!MULTILINGUAL_CONTEXT_LANGUAGES.includes(candidateLanguage)) return [];
  const keyCounts = new Map();
  for (const row of report.rows) keyCounts.set(row.key, (keyCounts.get(row.key) ?? 0) + 1);
  return report.rows.filter((row) => {
    const referenceLanguage = languageBase(row.reference?.provenance?.language || report.provenance?.reference?.language);
    return typeof row.key === 'string' && keyCounts.get(row.key) === 1 && row.verseId && row.reference && referenceLanguage === candidateLanguage
      && (row.comparisonStatus === 'compared' || row.comparisonReason === 'unverified_reference')
      && nonempty(row.translation) && nonempty(row.reference.translation)
      && row.translation !== row.reference.translation;
  });
}
export function getDeclaredContextRows(report, key = contextModelKeyOf(report)) {
  return key === 'multilingual' ? getDeclaredMultilingualContextRows(report) : getDeclaredEnglishContextRows(report);
}
export function contextScriptCheck(report, row, key = contextModelKeyOf(report)) {
  return key === 'multilingual'
    ? inspectContextPairForLanguage(languageBase(report.provenance?.candidate?.language), row.reference.translation, row.translation)
    : inspectContextPair(row.reference.translation, row.translation);
}
export function getEligibleContextRows(report, key = contextModelKeyOf(report)) {
  return getDeclaredContextRows(report, key).filter(row => contextScriptCheck(report, row, key).compatible);
}

/** Softmax maps model-config labels dynamically; never assume class order. */
export function decodeNliLogits(logits, id2label) {
  if (!logits || logits.length !== 3 || !id2label || typeof id2label !== 'object') {
    throw new Error('The NLI model must expose three logits and its id2label configuration.');
  }
  const values = Array.from(logits, Number);
  if (values.some((value) => !Number.isFinite(value))) throw new Error('NLI logits are not finite.');
  const labels = values.map((_, index) => String(id2label[index] ?? '').trim().toLowerCase());
  if (new Set(labels).size !== 3 || labels.some((label) => !KNOWN_LABELS.includes(label))) {
    throw new Error('The model label mapping is not contradiction / entailment / neutral.');
  }
  const maximum = Math.max(...values);
  const exponents = values.map((value) => Math.exp(value - maximum));
  const sum = exponents.reduce((total, value) => total + value, 0);
  return Object.fromEntries(labels.map((label, index) => [label, exponents[index] / sum]));
}

export function aggregateContextScores(forward, reverse, metadata = {}) {
  for (const direction of [forward, reverse]) {
    if (!direction || KNOWN_LABELS.some((label) => !Number.isFinite(direction[label]) || direction[label] < 0 || direction[label] > 1)) {
      throw new Error('Invalid directional NLI probabilities.');
    }
    if (Math.abs(KNOWN_LABELS.reduce((sum, label) => sum + direction[label], 0) - 1) > 0.001) {
      throw new Error('Directional NLI probabilities must sum to one.');
    }
  }
  return {
    ...metadata,
    forward: { ...forward, premise: 'reference', hypothesis: 'candidate' },
    reverse: { ...reverse, premise: 'candidate', hypothesis: 'reference' },
    contradiction: Math.max(forward.contradiction, reverse.contradiction),
    entailment: Math.min(forward.entailment, reverse.entailment),
    neutral: Math.max(forward.neutral, reverse.neutral),
    entailmentGap: Math.abs(forward.entailment - reverse.entailment),
    model: knownContextModel(metadata.model, metadata.revision)?.id ?? NLI_MODEL.id,
    revision: knownContextModel(metadata.model, metadata.revision)?.revision ?? NLI_MODEL.revision,
    uncalibrated: true,
    scoreIsAccuracy: false,
    noApproval: true,
  };
}

export function classifyContextResult(result) {
  if (!result || ['contradiction', 'entailment', 'entailmentGap'].some((field) => !Number.isFinite(result[field]) || result[field] < 0 || result[field] > 1)) {
    return { outcome: 'abstain', reason: 'invalid_or_missing_result', thresholds: CONTEXT_THRESHOLDS };
  }
  if (result.truncated) return { outcome: 'abstain', reason: 'input_truncated', thresholds: CONTEXT_THRESHOLDS };
  if (result.contradiction >= CONTEXT_THRESHOLDS.contradiction) {
    return { outcome: 'risk', reason: 'potential_contextual_contradiction', thresholds: CONTEXT_THRESHOLDS };
  }
  if (result.entailmentGap >= CONTEXT_THRESHOLDS.entailmentGap && result.entailment < CONTEXT_THRESHOLDS.lowEntailment) {
    return { outcome: 'risk', reason: 'potential_information_change', thresholds: CONTEXT_THRESHOLDS };
  }
  if (result.entailment >= CONTEXT_THRESHOLDS.entailment) {
    return { outcome: 'no_signal', reason: 'no_context_signal_at_experimental_threshold', thresholds: CONTEXT_THRESHOLDS };
  }
  return { outcome: 'abstain', reason: 'insufficient_context_or_model_confidence', thresholds: CONTEXT_THRESHOLDS };
}

function ensureWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw new Error('تشغيل المؤشر السياقي يتطلب متصفحًا يدعم Web Workers.');
  worker = new Worker(new URL('./context-risk-worker.mjs', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.event === 'progress') { job.onProgress?.(data.progress); return; }
    if (data.event === 'chunk') {
      for (const item of data.results ?? []) job.partial.set(item.key, item);
      return;
    }
    pending.delete(data.id);
    clearTimeout(job.timer);
    if (data.event === 'error') {
      const error = new Error(data.message || 'تعذر تشغيل المؤشر السياقي.');
      error.partialResults = [...job.partial.values()];
      error.execution = data.execution ?? {};
      error.actualInference = error.partialResults.length > 0 || error.execution.actualInference === true;
      job.reject(error);
    } else {
      job.resolve({ results: [...job.partial.values()], execution: data.execution });
    }
  };
  worker.onerror = () => cancelContextRisk('تعذر بدء نموذج المقارنة السياقية. الفحص البنيوي محفوظ.');
  return worker;
}

function requestPairs(inputs, onProgress, modelKey = 'en') {
  if (!Array.isArray(inputs) || inputs.length > MAX_CONTEXT_ROWS) return Promise.reject(new Error('Context pair count exceeds the supported limit.'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    try {
      const instance = ensureWorker();
      const timer = setTimeout(() => cancelContextRisk('انتهت مهلة المؤشر السياقي؛ حُفظت المقارنات التي اكتملت.'), 3600000);
      pending.set(id, { resolve, reject, onProgress, timer, partial: new Map() });
      instance.postMessage({ id, action: 'compare', inputs, model: modelKey });
    } catch (error) {
      const job = pending.get(id);
      if (job) { clearTimeout(job.timer); pending.delete(id); }
      reject(error);
    }
  });
}

export function cancelContextRisk(message = 'أُلغي المؤشر السياقي؛ حُفظت المقارنات التي اكتملت.') {
  worker?.terminate();
  worker = undefined;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    const error = new Error(message);
    error.name = 'ContextRiskCancelledError';
    error.partialResults = [...job.partial.values()];
    error.actualInference = error.partialResults.length > 0;
    job.reject(error);
  }
  pending.clear();
}

function validExecutedResult(result, spec = NLI_MODEL) {
  try {
    if (result?.model !== spec.id || result?.revision !== spec.revision || result?.modelCalls !== 2) return false;
    aggregateContextScores(result.forward, result.reverse);
    return true;
  } catch { return false; }
}

/** Pure report transformation. Injected test scores do not claim real execution. */
export function appendContextResults(report, results = [], execution = {}, modelKey = contextModelKeyOf(report)) {
  const enriched = structuredClone(report);
  const spec = contextModelSpec(modelKey);
  const multilingual = spec === MULTILINGUAL_NLI_MODEL;
  const guard = multilingual ? MULTILINGUAL_LANGUAGE_GUARD : CONTEXT_LANGUAGE_GUARD;
  const blockedReason = multilingual ? 'declared_language_script_incompatible' : 'declared_english_script_incompatible';
  const eligible = getEligibleContextRows(report, modelKey);
  const eligibleKeys = new Set(eligible.map((row) => row.key));
  const scriptChecks = new Map(getDeclaredContextRows(report, modelKey).map(row => [row.key, contextScriptCheck(report, row, modelKey)]));
  const languageBlockedKeys = new Set([...scriptChecks].filter(([, check]) => !check.compatible).map(([key]) => key));
  const rowsByKey = new Map(enriched.rows.map((row) => [row.key, row]));
  const accepted = new Map();
  const realExecution = execution.actualInference === true;
  for (const result of results) {
    if (!eligibleKeys.has(result.key) || accepted.has(result.key) || !validExecutedResult(result, spec)) continue;
    accepted.set(result.key, result);
  }
  // Running again replaces context findings instead of duplicating their IDs.
  for (const row of enriched.rows) {
    row.findings = row.findings.filter((finding) => !String(finding.id).startsWith('context-'));
    row.findingIds = row.findingIds.filter((id) => !String(id).startsWith('context-'));
    delete row.nli;
    delete row.contextLanguageGuard;
    delete row.contextNotEligibleReason;
    if (scriptChecks.has(row.key)) row.contextLanguageGuard = scriptChecks.get(row.key);
    if (languageBlockedKeys.has(row.key)) row.contextNotEligibleReason = blockedReason;
    row.contextStatus = eligibleKeys.has(row.key) ? 'not_processed' : 'not_eligible';
    const otherReview = row.findings.some((finding) => finding.type === 'structural' || finding.type === 'comparison');
    // Rule abstentions (numeric or qualifier syntax) must survive the context step; they are not "no signal".
    const ruleAbstained = row.numericReview?.state === 'abstain' || row.qualifierReview?.state === 'abstain';
    row.status = otherReview ? 'needs_review' : row.comparisonStatus === 'abstain' || ruleAbstained ? 'abstain' : 'no_signal';
  }
  enriched.findings = enriched.findings.filter((finding) => !String(finding.id).startsWith('context-'));
  for (const key of languageBlockedKeys) {
    const row = rowsByKey.get(key);
    row.contextStatus = 'abstain';
    const finding = {
      id: `context-language-${key}`, code: 'context_language_mismatch', type: 'evidence', severity: 'info',
      message: multilingual ? 'لم يُرسل هذا الزوج إلى النموذج متعدد اللغات: حروف أحد النصين لا تطابق خط اللغة المعلنة. راجع لغة النصين.' : 'لم يُرسل هذا الزوج إلى النموذج الإنجليزي: الحروف لا تجتاز حاجز الكتابة اللاتينية المحافظ. راجع لغة النصين.',
      reason: multilingual ? 'The declared language is insufficient when letters fall outside its script or are absent. This is a conservative script gate, not language identification.' : 'User-declared English is insufficient when letters are outside Latin script or absent. This is a conservative script gate, not language identification.',
      rowNumbers: [row.rowNumber], verseIds: [row.verseId], spans: [],
      evidence: { method: guard.method, languageGuard: row.contextLanguageGuard, actualInference: false, humanReviewRequired: true, sourceAuthorityChanged: false },
    };
    row.findings.push(finding); row.findingIds.push(finding.id); enriched.findings.push(finding);
    if (!row.findings.some(item => item.type === 'structural' || item.type === 'comparison')) row.status = 'abstain';
  }
  for (const [key, rawResult] of accepted) {
    const row = rowsByKey.get(key);
    const scores = aggregateContextScores(rawResult.forward, rawResult.reverse, rawResult);
    const classification = classifyContextResult(scores);
    const unverified = row.reference.provenance?.verificationStatus !== 'verified' || row.comparisonStatus !== 'compared';
    row.nli = {
      ...scores, classification, actuallyInferred: realExecution,
      experimentalUnverifiedReference: unverified,
      referenceAuthorityChanged: false,
    };
    row.contextStatus = realExecution ? classification.outcome : 'not_processed';
    let code;
    let message;
    if (classification.outcome === 'risk') {
      code = classification.reason === 'potential_information_change' ? 'context_information_change' : 'context_contradiction';
      message = 'مؤشر اختلاف سياقي يحتاج خبيرًا؛ راجع الأدوار أو النفي أو المعلومات في النصين.';
    } else if (classification.reason === 'input_truncated') {
      code = 'context_input_truncated';
      message = 'المقارنة السياقية مقتطعة بسبب حد النموذج؛ يلزم قراءة النصين كاملين.';
    } else if (classification.outcome === 'abstain') {
      code = 'context_uncertain';
      message = 'لا يكفي السياق أو ثقة النموذج للمقارنة؛ امتنع المؤشر السياقي وأحِل إلى المراجع.';
    }
    if (code) {
      const finding = {
        id: `context-${key}`, code,
        type: classification.outcome === 'risk' || scores.truncated ? 'comparison' : 'evidence',
        severity: classification.outcome === 'risk' ? 'high' : scores.truncated ? 'medium' : 'info',
        message,
        reason: multilingual ? 'Experimental bidirectional multilingual NLI on two texts in the same declared language. Not a theological ruling, a correctness probability, or source authentication.' : 'Experimental bidirectional English NLI on paired text. Not a theological ruling, a correctness probability, or source authentication.',
        rowNumbers: [row.rowNumber], verseIds: [row.verseId], spans: [],
        evidence: {
          method: 'paired-tokenizer bidirectional natural-language inference',
          model: spec, scores: row.nli,
          candidateExcerpt: row.translation,
          referenceExcerpt: row.reference.translation,
          referenceProvenance: row.reference.provenance,
          sourceURL: row.reference.sourceURL || row.reference.provenance?.url || '',
          thresholds: CONTEXT_THRESHOLDS,
          calibrated: false, humanReviewRequired: true, potentialOnly: true,
        },
      };
      row.findings.push(finding);
      row.findingIds.push(finding.id);
      enriched.findings.push(finding);
    }
    // A context score cannot turn an unverified source into approval/no_signal.
    const hasReview = row.findings.some((finding) => finding.type === 'structural' || finding.type === 'comparison');
    row.status = hasReview ? 'needs_review' : unverified || classification.outcome === 'abstain' ? 'abstain' : row.status;
  }
  const processed = realExecution ? accepted.size : 0;
  const unverifiedRows = [...accepted.keys()].filter((key) => rowsByKey.get(key).nli.experimentalUnverifiedReference).length;
  enriched.provenance.analysis = {
    ...enriched.provenance.analysis,
    mode: processed ? 'structural-lexical-and-contextual-nli' : (enriched.provenance.analysis.semanticProcessedRows ?? 0) > 0 ? 'structural-lexical-and-local-embedding' : 'structural-and-lexical-rules',
    trainedModelExecuted: (Boolean(enriched.provenance.analysis.trainedModelExecuted) && !enriched.provenance.analysis.contextModel) || (enriched.provenance.analysis.semanticProcessedRows ?? 0) > 0 || processed > 0,
    contextModel: spec,
    contextProcessedRows: processed,
    contextEligibleRows: eligible.length,
    contextRemainingRows: Math.max(0, eligible.length - processed),
    contextLanguageBlockedRows: languageBlockedKeys.size,
    contextLanguageGuard: guard,
    contextCompleted: execution.completed === true && processed === eligible.length,
    experimentalComparisonWithUnverifiedReferenceCount: realExecution ? unverifiedRows : 0,
    contextExecution: execution,
    contextError: execution.error ?? null,
    limitations: [...new Set([...(enriched.provenance.analysis.limitations ?? []),
      ...(multilingual ? ['Multilingual NLI was trained largely on machine-translated general NLI data, not validated on Quran translations in any language.', 'Only two texts in the same declared language are compared; a translation is never compared with the Arabic Quran text.', MULTILINGUAL_NLI_MODEL.trainingDataNote] : ['English NLI was trained on SNLI/MultiNLI, not validated on Quran translations.']),
      guard.limitation,
      'The contradiction/entailment/neutral probabilities and thresholds are uncalibrated review signals, not translation accuracy.',
      'An experimental comparison to a user-provided unverified reference does not authenticate that source or grant approval.',
      'The 512-token limit applies to both texts combined, including model special tokens; truncation forces contextual abstention.',
    ])],
  };
  enriched.summary = {
    ...enriched.summary,
    findingsCount: enriched.findings.length,
    comparisonFindingCount: enriched.findings.filter((finding) => finding.type === 'comparison').length,
    needsReviewRows: enriched.rows.filter((row) => row.status === 'needs_review').length,
    noSignalRows: enriched.rows.filter((row) => row.status === 'no_signal').length,
    abstainRows: enriched.rows.filter((row) => row.status === 'abstain').length,
    contextProcessedRows: processed, contextEligibleRows: eligible.length,
    contextAbstainRows: (realExecution ? [...accepted.keys()].filter((key) => rowsByKey.get(key).nli.classification.outcome === 'abstain').length : 0) + languageBlockedKeys.size,
    contextLanguageBlockedRows: languageBlockedKeys.size,
    contextRemainingRows: Math.max(0, eligible.length - processed),
  };
  return enriched;
}

export async function runContextRisk(report, onProgress, { model: modelKey = 'en' } = {}) {
  const key = CONTEXT_MODELS[modelKey] ? modelKey : 'en';
  const eligible = getEligibleContextRows(report, key);
  if (!eligible.length) {
    return appendContextResults(report, [], { actualInference: false, completed: true, reason: key === 'multilingual' ? 'No different, valid pairs in the same declared supported language that pass the script gate. No model was downloaded or inferred.' : 'No different, valid, declared-English pairs compatible with the conservative Latin-script gate. No model was downloaded or inferred.' }, key);
  }
  const language = languageBase(report.provenance?.candidate?.language);
  const started = nowMS();
  try {
    const response = await requestPairs(eligible.map((row) => ({ key: row.key, premise: row.reference.translation, hypothesis: row.translation, language })), onProgress, key);
    return appendContextResults(report, response.results, { ...response.execution, elapsedMS: Math.round(nowMS() - started), actualInference: response.results.length > 0, completed: response.results.length === eligible.length }, key);
  } catch (error) {
    onProgress?.({ status: 'context-error', message: error.message });
    return appendContextResults(report, error.partialResults ?? [], {
      ...error.execution,
      actualInference: error.actualInference === true, completed: false,
      cancelled: error.name === 'ContextRiskCancelledError',
      error: error.message, elapsedMS: Math.round(nowMS() - started),
      inferredAt: (error.partialResults?.length ?? 0) > 0 ? new Date().toISOString() : null,
    }, key);
  }
}

function emptyCounts() { return { TP: 0, FP: 0, FN: 0, TN: 0, knownAbstentions: 0, unknownCases: 0, unknownAbstentions: 0, missingCases: 0, safeNoSignalCases: 0, riskCaseAbstentions: 0 }; }
function finishCounts(counts) {
  const division = (number, denominator) => denominator ? number / denominator : null;
  return { ...counts,
    precision: division(counts.TP, counts.TP + counts.FP),
    recall: division(counts.TP, counts.TP + counts.FN),
    f1: division(2 * counts.TP, 2 * counts.TP + counts.FP + counts.FN),
    safeSpecificity: division(counts.TN, counts.TN + counts.FP),
    evaluatedKnownCases: counts.TP + counts.FP + counts.FN + counts.TN,
    knownAbstentionRate: division(counts.knownAbstentions, counts.TP + counts.FP + counts.FN + counts.TN),
    classificationNote: 'Risk-case abstention counts as FN. Safe-case abstention counts as non-risk TN and is also disclosed in knownAbstentions. Missing safe cases do not count as TN.',
  };
}

export function summarizeBenchmarkResults(cases) {
  const total = emptyCounts();
  const byType = {};
  for (const item of cases) {
    const local = byType[item.type] ??= emptyCounts();
    for (const counts of [total, local]) {
      if (!item.result) counts.missingCases += 1;
      if (item.expectedRisk == null) {
        counts.unknownCases += 1;
        if (item.result && item.predictedOutcome === 'abstain') counts.unknownAbstentions += 1;
      } else if (item.expectedRisk) {
        if (item.predictedRisk) counts.TP += 1;
        else counts.FN += 1;
      } else if (item.result) {
        if (item.predictedRisk) counts.FP += 1;
        else counts.TN += 1;
      }
      if (item.expectedRisk != null && item.predictedOutcome === 'abstain' && item.result) counts.knownAbstentions += 1;
      if (item.expectedRisk === true && item.predictedOutcome === 'abstain' && item.result) counts.riskCaseAbstentions += 1;
      if (item.expectedRisk === false && item.predictedOutcome === 'no_signal' && item.result) counts.safeNoSignalCases += 1;
    }
  }
  return { ...finishCounts(total), byType: Object.fromEntries(Object.entries(byType).map(([type, counts]) => [type, finishCounts(counts)])) };
}

export function evaluateLexicalBaseline(cases = BENCHMARK_CASES) {
  const outputs = cases.map((item) => {
    const report = auditBatch({
      rows: [{ surah: 112, ayah: 1, translation: item.hypothesis }],
      referenceRows: [{ surah: 112, ayah: 1, translation: item.premise }],
      scope: { type: 'provided' },
      metadata: { candidate: { language: 'en', synthetic: true }, reference: { language: 'en', verificationStatus: 'verified', sourceKind: 'synthetic-teaching', title: BENCHMARK_DATASET.label } },
    });
    const findings = report.rows[0].findings.filter((finding) => finding.type === 'comparison');
    return { ...item, result: { findings: findings.map((finding) => finding.code) }, predictedRisk: findings.length > 0, predictedOutcome: findings.length ? 'risk' : 'no_signal' };
  });
  return { method: 'current-transparent-lexical-rules', cases: outputs, metrics: summarizeBenchmarkResults(outputs), trainedModelExecuted: false };
}

export async function evaluateBenchmark(onProgress) {
  const started = nowMS();
  let response;
  let error = null;
  try {
    response = await requestPairs(BENCHMARK_CASES.map((item) => ({ key: item.id, premise: item.premise, hypothesis: item.hypothesis })), onProgress);
  } catch (caught) {
    error = caught.message;
    response = { results: caught.partialResults ?? [], execution: { ...caught.execution, actualInference: caught.actualInference === true, cancelled: caught.name === 'ContextRiskCancelledError' } };
  }
  const results = new Map(response.results.filter(validExecutedResult).map((result) => [result.key, result]));
  const cases = BENCHMARK_CASES.map((item) => {
    const rawResult = results.get(item.id);
    const result = rawResult ? aggregateContextScores(rawResult.forward, rawResult.reverse, rawResult) : null;
    const classification = classifyContextResult(result);
    return { ...item, result, classification, predictedRisk: classification.outcome === 'risk', predictedOutcome: classification.outcome };
  });
  return {
    schemaVersion: 'mihakk-context-benchmark/1', model: NLI_MODEL, dataset: BENCHMARK_DATASET,
    completed: results.size === BENCHMARK_CASES.length,
    trainedModelExecuted: results.size > 0 && response.execution?.actualInference === true,
    processedCases: results.size, expectedCases: BENCHMARK_CASES.length,
    inferredAt: results.size ? response.execution?.inferredAt ?? new Date().toISOString() : null,
    elapsedMS: Math.round(nowMS() - started), error,
    execution: response.execution,
    cases, metrics: summarizeBenchmarkResults(cases),
    baseline: evaluateLexicalBaseline(), thresholds: CONTEXT_THRESHOLDS,
    limitations: ['This is a visible development fixture, not a held-out benchmark, independent expert judgment, user-usefulness study, or religious validation.', 'All misses, false alerts, unknowns and incomplete cases remain in the result.'],
  };
}

export { BENCHMARK_CASES, BENCHMARK_DATASET };
