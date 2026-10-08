import {pipeline, env} from '../vendor/transformers-3.8.1.mjs';
import {MODEL, cosineSimilarity, embeddingWeightPin} from './semantic-ai.mjs';
import {createWeightGuard, createResumableFetch, createProgressAggregator, describeModelError, describeRetry} from './model-runtime.mjs';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';
// The weight file is hashed (SHA-256) while transformers.js reads it and compared with the pin before the session is created.
const pin = embeddingWeightPin();
// A cut connection (CDNs drop long HTTP/2 streams on slow links) is resumed with an HTTP Range request, a few times at most.
let announceRetry = null;
const resumable = createResumableFetch({onRetry: info => announceRetry?.(info)});
const guard = createWeightGuard({pins: [pin], fetchWeights: resumable});
env.useCustomCache = true;
env.customCache = guard.cache;
guard.installFetch();
let extractor;
let queue = Promise.resolve();
const notify = (id, progress) => postMessage({id, event: 'progress', progress});
async function load(id) {
  if (!extractor) {
    // One monotonic, bytes-weighted percentage instead of the per-file 0-100 events.
    const aggregator = createProgressAggregator({expectedBytes: pin.bytes});
    const forward = event => { if (event) notify(id, event); };
    announceRetry = info => forward(aggregator.notice(describeRetry(info)));
    forward(aggregator.start());
    const created = await pipeline('feature-extraction', MODEL.id, {revision: MODEL.revision, dtype: MODEL.dtype, device: 'wasm', progress_callback: progress => forward(aggregator.push(progress))});
    announceRetry = null;
    guard.assertVerified(pin); // fail closed: never run weights that were not hashed and equal to the pin
    extractor = created;
    forward(aggregator.finish());
  }
  return {ready: true, model: MODEL, weightIntegrity: guard.summary(pin)};
}
async function embedding(text) {
  const value = `query: ${text}`;
  const ids = extractor.tokenizer(value, {truncation: false});
  const tokenCount = ids.input_ids.size;
  const output = await extractor(value, {pooling: 'mean', normalize: true, truncation: true, max_length: MODEL.maxTokens});
  return {vector: Array.from(output.data), tokens: tokenCount, truncated: tokenCount > MODEL.maxTokens};
}
async function execute({id, action, payload}) {
  guard.clearFailure();
  resumable.clearFailure();
  try {
    if (action === 'load') { postMessage({id,event:'result',result:await load(id)}); return; }
    if (action !== 'compare') throw new Error('عملية النموذج غير معروفة.');
    await load(id);
    const results = [];
    for (const input of payload.inputs) {
      const a = await embedding(input.candidate), b = await embedding(input.reference);
      const item = {key: input.key, similarity: cosineSimilarity(a.vector, b.vector), candidateTokens: a.tokens, referenceTokens: b.tokens, candidateTruncated: a.truncated, referenceTruncated: b.truncated};
      results.push(item);
      // A finished pair is handed off before the next one, so cancel/failure keeps the completed comparisons.
      postMessage({id, event: 'chunk', results: [item]});
      notify(id, {status: 'inference', done: results.length, total: payload.inputs.length, progress: results.length / payload.inputs.length * 100});
    }
    postMessage({id,event:'result',result:results});
  } catch (error) {
    // Raw runtime text (often English) stays in technicalDetails; the notice is simple Arabic.
    const described = describeModelError(guard.failure ?? resumable.failure ?? error);
    postMessage({id, event: 'error', errorKind: described.kind, technicalDetails: described.technicalDetails, message: `لم يكتمل الذكاء الاصطناعي: ${described.message}. لا تُعد النتائج البنيوية تحليلًا ذكيًا.`});
  }
}
onmessage = ({data}) => { queue = queue.then(() => execute(data)); };
