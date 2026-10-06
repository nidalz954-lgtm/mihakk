/**
 * Local speech capture for the guide: record from the microphone until the speaker pauses,
 * then transcribe in a worker with a small Whisper model. Audio never leaves the device.
 */

export const LOCAL_SPEECH_MB = 77;
const SAMPLE_RATE = 16000;
const MAX_MS = 12000;        // hard stop for one question
const SILENCE_MS = 1400;     // pause that ends the question once speech was heard
const NO_SPEECH_MS = 6000;   // give up if nothing louder than room noise arrives
const SPEECH_LEVEL = 0.025;  // RMS above which we count the input as speech

let worker = null, nextId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./speech-worker.mjs', import.meta.url), {type: 'module'});
  worker.onmessage = ({data}) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.event === 'progress') { job.onProgress?.(data.progress); return; }
    pending.delete(data.id);
    if (data.event === 'result') job.resolve(data.result); else job.reject(new Error(data.message));
  };
  worker.onerror = event => { for (const job of pending.values()) job.reject(new Error(event.message || 'worker failed')); pending.clear(); worker = null; };
  return worker;
}

function call(action, audio, onProgress) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject, onProgress});
    getWorker().postMessage({id, action, audio}, audio ? [audio.buffer] : []);
  });
}

/** Download (or reuse the cached) model. `onProgress` receives a 0–100 number. */
export function prepareLocalSpeech(onProgress) {
  const files = new Map();
  return call('load', null, progress => {
    if (progress?.file && typeof progress.loaded === 'number' && progress.total) files.set(progress.file, [progress.loaded, progress.total]);
    let loaded = 0, total = 0;
    for (const [l, t] of files.values()) { loaded += l; total += t; }
    if (total) onProgress?.(Math.min(100, Math.round(loaded / total * 100)));
  });
}

/**
 * Record one spoken question. Resolves with a 16 kHz mono Float32Array, or null when no speech
 * was heard. `controller.stop()` ends the recording early; `onLevel` gets the live input level.
 */
export async function recordQuestion({controller = {}, onLevel} = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  let heardSpeech = false;
  const finished = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start();
  const started = performance.now();
  let lastLoud = started;
  const samples = new Float32Array(analyser.fftSize);
  await new Promise(resolve => {
    const stop = () => { clearInterval(timer); resolve(); };
    controller.stop = stop;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      const level = Math.sqrt(sum / samples.length);
      onLevel?.(level);
      const now = performance.now();
      if (level > SPEECH_LEVEL) { heardSpeech = true; lastLoud = now; }
      if (now - started > MAX_MS || (heardSpeech && now - lastLoud > SILENCE_MS) || (!heardSpeech && now - started > NO_SPEECH_MS)) stop();
    }, 100);
  });
  recorder.stop();
  await finished;
  stream.getTracks().forEach(track => track.stop());
  await context.close();
  if (!heardSpeech || !chunks.length) return null;
  return decodeTo16k(new Blob(chunks, {type: recorder.mimeType}));
}

async function decodeTo16k(blob) {
  const decoder = new AudioContext({sampleRate: SAMPLE_RATE});
  try {
    const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
    return new Float32Array(buffer.getChannelData(0));
  } finally { await decoder.close(); }
}

/** Transcribe 16 kHz mono audio to Arabic text. */
export async function transcribe(audio, onProgress) {
  const result = await call('transcribe', audio, onProgress);
  return result.text;
}
