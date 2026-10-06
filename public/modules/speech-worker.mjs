import {pipeline, env} from '../vendor/transformers-3.8.1.mjs';

/**
 * Local speech-to-text for the on-page guide. The model is downloaded once and cached by the
 * browser; recorded audio is transcribed here and never sent anywhere.
 */
export const SPEECH_MODEL = {id: 'onnx-community/whisper-base', revision: '1846881b6b3a3024392c1eea3ad983695bc23925', dtype: 'q8', approxMB: 77};

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';

let transcriber = null;
let queue = Promise.resolve();
const notify = (id, progress) => postMessage({id, event: 'progress', progress});

async function load(id) {
  if (!transcriber) transcriber = await pipeline('automatic-speech-recognition', SPEECH_MODEL.id, {revision: SPEECH_MODEL.revision, dtype: SPEECH_MODEL.dtype, device: 'wasm', progress_callback: progress => notify(id, progress)});
}

async function execute({id, action, audio}) {
  try {
    await load(id);
    if (action === 'load') { postMessage({id, event: 'result', result: {ready: true}}); return; }
    if (action !== 'transcribe') throw new Error('unknown action');
    const output = await transcriber(audio, {language: 'arabic', task: 'transcribe', chunk_length_s: 30});
    postMessage({id, event: 'result', result: {text: String(output?.text || '').trim()}});
  } catch (error) {
    postMessage({id, event: 'error', message: String(error?.message || error)});
  }
}

onmessage = ({data}) => { queue = queue.then(() => execute(data)); };
