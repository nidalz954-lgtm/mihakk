import {pipeline, env} from '../vendor/transformers-3.8.1.mjs';
import {MODEL, cosineSimilarity} from './semantic-ai.mjs';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';
let extractor;
let queue = Promise.resolve();
const notify = (id, progress) => postMessage({id, event: 'progress', progress});
async function load(id) {
  if (!extractor) extractor = await pipeline('feature-extraction', MODEL.id, {revision: MODEL.revision, dtype: MODEL.dtype, device: 'wasm', progress_callback: progress => notify(id, progress)});
  return {ready: true, model: MODEL};
}
async function embedding(text) {
  const value = `query: ${text}`;
  const ids = extractor.tokenizer(value, {truncation: false});
  const tokenCount = ids.input_ids.size;
  const output = await extractor(value, {pooling: 'mean', normalize: true, truncation: true, max_length: MODEL.maxTokens});
  return {vector: Array.from(output.data), tokens: tokenCount, truncated: tokenCount > MODEL.maxTokens};
}
async function execute({id, action, payload}) {
  try {
    if (action === 'load') { postMessage({id,event:'result',result:await load(id)}); return; }
    if (action !== 'compare') throw new Error('عملية النموذج غير معروفة.');
    await load(id);
    const results = [];
    for (const input of payload.inputs) {
      const a = await embedding(input.candidate), b = await embedding(input.reference);
      results.push({key: input.key, similarity: cosineSimilarity(a.vector, b.vector), candidateTokens: a.tokens, referenceTokens: b.tokens, candidateTruncated: a.truncated, referenceTruncated: b.truncated});
      notify(id, {status: 'inference', done: results.length, total: payload.inputs.length, progress: results.length / payload.inputs.length * 100});
    }
    postMessage({id,event:'result',result:results});
  } catch (error) { postMessage({id,event:'error',message:`لم يكتمل الذكاء الاصطناعي: ${error.message}. لا تُعد النتائج البنيوية تحليلًا ذكيًا.`}); }
}
onmessage = ({data}) => { queue = queue.then(() => execute(data)); };
