import { AutoTokenizer, AutoModelForSequenceClassification, env } from '../vendor/transformers-3.8.1.mjs';
import { NLI_MODEL, CONTEXT_MODELS, decodeNliLogits, aggregateContextScores } from './context-risk.mjs';
import { inspectContextPair, inspectContextPairForLanguage } from './context-language.mjs';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';

// One tokenizer/model pair per pinned model id; switching models never reuses another model's tokenizer.
const loaded = new Map();
let tokenizer;
let model;
let spec = NLI_MODEL;
let queue = Promise.resolve();
const send = (message) => globalThis.postMessage(message);
// Browser network errors are English and vague; say what happened in Arabic.
const reasonAr = (message) => /Failed to fetch|NetworkError|Load failed|network/i.test(String(message)) ? 'تعذّر تنزيل ملفات النموذج؛ تحقّق من الاتصال بالإنترنت أو من حجب Hugging Face وjsDelivr' : String(message).replace(/[.。]+$/, '');

async function loadModel(id) {
  const options = {
    revision: spec.revision,
    progress_callback: (progress) => send({ id, event: 'progress', progress: { ...progress, phase: 'loading-context-model' } }),
  };
  if (!loaded.has(spec.id)) {
    const loadedTokenizer = await AutoTokenizer.from_pretrained(spec.id, options);
    const loadedModel = await AutoModelForSequenceClassification.from_pretrained(spec.id, { ...options, dtype: spec.dtype, device: 'wasm' });
    loaded.set(spec.id, { tokenizer: loadedTokenizer, model: loadedModel });
  }
  ({ tokenizer, model } = loaded.get(spec.id));
  // Validate labels from the actual loaded model configuration, not our constant.
  decodeNliLogits([0, 0, 0], model.config.id2label);
}

function tokenCount(value) {
  const size = value.input_ids?.size;
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('لم يُرجع tokenizer عدد توكنات صالحًا.');
  return size;
}

/** Both strings are encoded as a real sentence pair, with one combined limit. */
async function inferDirection(premise, hypothesis) {
  const complete = tokenizer(premise, { text_pair: hypothesis, truncation: false, padding: false });
  const fullTokenCount = tokenCount(complete);
  const inputs = tokenizer(premise, { text_pair: hypothesis, truncation: true, max_length: spec.maxTokens, padding: false });
  const usedTokenCount = tokenCount(inputs);
  if (usedTokenCount > spec.maxTokens) throw new Error('لم يلتزم tokenizer بحد 512 توكن للزوج.');
  const output = await model(inputs);
  if (!output.logits?.data || output.logits.data.length !== 3) throw new Error('شكل خرج نموذج NLI غير متوقع.');
  return {
    ...decodeNliLogits(output.logits.data, model.config.id2label),
    pairTokens: fullTokenCount, usedPairTokens: usedTokenCount,
    truncated: fullTokenCount > usedTokenCount,
  };
}

async function execute({ id, action, inputs, model: modelKey = 'en' }) {
  let modelCalls = 0;
  spec = CONTEXT_MODELS[modelKey] ?? NLI_MODEL;
  const multilingual = spec !== NLI_MODEL;
  try {
    if (action !== 'compare' || !Array.isArray(inputs) || inputs.length > 20000) throw new Error('طلب مقارنة سياقية غير صالح.');
    for (const input of inputs) {
      if (!input || typeof input.key !== 'string' || !input.key || typeof input.premise !== 'string' || typeof input.hypothesis !== 'string' || !input.premise.trim() || !input.hypothesis.trim() || input.premise.length > 20000 || input.hypothesis.length > 20000) {
        throw new Error('أحد أزواج النصوص غير صالح أو يتجاوز حد الطول.');
      }
      if (multilingual ? !inspectContextPairForLanguage(input.language, input.premise, input.hypothesis).compatible : !inspectContextPair(input.premise, input.hypothesis).compatible) {
        throw new Error(multilingual ? 'النص لا يطابق خط اللغة المعلنة للنموذج متعدد اللغات؛ لم يُحمّل النموذج لهذا الطلب.' : 'النص لا يجتاز حاجز الكتابة اللاتينية المحافظ للنموذج الإنجليزي؛ لم يُحمّل النموذج لهذا الطلب.');
      }
    }
    if (inputs.length) await loadModel(id);
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const forward = await inferDirection(input.premise, input.hypothesis);
      modelCalls += 1;
      const reverse = await inferDirection(input.hypothesis, input.premise);
      modelCalls += 1;
      const result = aggregateContextScores(forward, reverse, {
        key: input.key,
        referenceTokens: tokenCount(tokenizer(input.premise, { truncation: false, add_special_tokens: false })),
        candidateTokens: tokenCount(tokenizer(input.hypothesis, { truncation: false, add_special_tokens: false })),
        pairTokens: Math.max(forward.pairTokens, reverse.pairTokens),
        usedPairTokens: Math.max(forward.usedPairTokens, reverse.usedPairTokens),
        truncated: forward.truncated || reverse.truncated,
        modelCalls: 2, inferredAt: new Date().toISOString(), model: spec.id, revision: spec.revision,
      });
      // A complete pair is handed off before processing the next pair. This
      // makes partial reports real and recoverable on cancellation/failure.
      send({ id, event: 'chunk', results: [result] });
      send({ id, event: 'progress', progress: { status: 'context-inference', done: index + 1, total: inputs.length, progress: (index + 1) / inputs.length * 100 } });
    }
    send({ id, event: 'result', execution: {
      device: 'wasm-cpu-worker', model: spec.id, revision: spec.revision,
      actualInference: inputs.length > 0, modelCalls, completed: true,
      inferredAt: inputs.length ? new Date().toISOString() : null,
    } });
  } catch (error) {
    send({ id, event: 'error', execution: { actualInference: modelCalls > 0, modelCalls, completed: false, model: spec.id, revision: spec.revision }, message: `لم يكتمل المؤشر السياقي: ${reasonAr(error.message)}. المقارنات المكتملة فقط محفوظة؛ لا تُعد النتائج حكمًا دينيًا.` });
  }
}

globalThis.onmessage = ({ data }) => { queue = queue.then(() => execute(data)); };
