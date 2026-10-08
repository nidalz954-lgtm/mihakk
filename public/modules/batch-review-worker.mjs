import {auditBatch} from './batch-engine.mjs';

// The Node branch only provides a real-worker bridge for local automated tests.
// In a browser all messages remain between this page and its same-origin worker.
const browserWorker = typeof globalThis.postMessage === 'function' && typeof globalThis.document === 'undefined';
const port = browserWorker ? null : (await import('node:worker_threads')).parentPort;
if (!browserWorker && !port) throw new Error('Batch review must run inside a worker.');
const send = value => browserWorker ? globalThis.postMessage(value) : port.postMessage(value);

const receive = data => {
  try {
    if (data?.type !== 'run') throw new TypeError('Invalid batch worker request.');
    send({type: 'progress', value: {phase: 'structural', status: 'running'}});
    const report = auditBatch(data.input);
    send({type: 'result', report});
  } catch (error) {
    send({type: 'error', error: {name: String(error?.name ?? 'Error'), message: String(error?.message ?? 'Batch review failed.')}});
  }
};
if (browserWorker) globalThis.onmessage = event => receive(event.data);
else port.on('message', receive);
