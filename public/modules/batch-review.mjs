const WORKER_URL = new URL('./batch-review-worker.mjs', import.meta.url);

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('أُلغي الفحص البنيوي المحلي؛ لم تُنشأ نتيجة جديدة.', 'AbortError');
  const error = new Error('أُلغي الفحص البنيوي المحلي؛ لم تُنشأ نتيجة جديدة.');
  error.name = 'AbortError';
  return error;
}

function reviewError(message, code, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.name = 'BatchReviewError';
  error.code = code;
  return error;
}

function defaultWorkerFactory(url, options) {
  if (typeof globalThis.Worker !== 'function') {
    throw reviewError('هذا المتصفح لا يدعم عامل الفحص المحلي. استخدم متصفحًا يدعم Web Workers؛ لم يُنفّذ الفحص.', 'BATCH_WORKER_UNAVAILABLE');
  }
  return new globalThis.Worker(url, options);
}

/**
 * Run the existing auditBatch in a separate local module worker. The returned
 * report is the worker's structured-cloned engine result, with no new fields.
 * There is deliberately no synchronous fallback: cancellation must be able to
 * stop the audit, and a large file must not occupy the page's main thread.
 * Progress names the stage; "running" has no invented completion percentage.
 * workerFactory is an injection seam for tests and must use the Web Worker API.
 */
export async function runBatchReview(input, {signal, onProgress, workerFactory = defaultWorkerFactory} = {}) {
  if (signal?.aborted) throw abortError();
  if (onProgress != null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function.');
  if (typeof workerFactory !== 'function') throw new TypeError('workerFactory must be a function.');

  return new Promise((resolve, reject) => {
    let worker, settled = false, abortAttached = false, pageHideAttached = false;
    const attached = [];
    const page = typeof globalThis.document !== 'undefined'
      && typeof globalThis.addEventListener === 'function'
      && typeof globalThis.removeEventListener === 'function' ? globalThis : null;

    const cleanup = () => {
      for (const [type, listener] of attached) {
        try { worker.removeEventListener(type, listener); } catch { /* Continue terminating if a host listener failed. */ }
      }
      if (abortAttached) signal.removeEventListener('abort', onAbort);
      if (pageHideAttached) page.removeEventListener('pagehide', onAbort);
      if (worker && typeof worker.terminate === 'function') {
        try {
          const termination = worker.terminate();
          if (termination?.catch) termination.catch(() => {});
        } catch { /* The worker may already have stopped. */ }
      }
    };
    const finish = (error, report) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(report);
    };
    const onAbort = () => finish(abortError());
    const progress = value => {
      if (settled) return;
      try { onProgress?.(value); } catch (error) { finish(error); }
    };
    const protocolError = () => finish(reviewError('تعذّر قراءة نتيجة عامل الفحص المحلي؛ لم تُقبل نتيجة غير مكتملة.', 'BATCH_WORKER_PROTOCOL'));
    const onMessage = event => {
      if (settled) return;
      if (signal?.aborted) { onAbort(); return; }
      const data = event.data;
      if (!data || typeof data !== 'object') { protocolError(); return; }
      if (data.type === 'progress' && data.value?.phase === 'structural' && data.value.status === 'running') {
        progress({phase: 'structural', status: 'running'});
      } else if (data.type === 'result') {
        const report = data.report;
        if (!report || typeof report !== 'object' || typeof report.schemaVersion !== 'string'
          || !Array.isArray(report.rows) || !Array.isArray(report.findings) || !report.summary || typeof report.summary !== 'object') {
          protocolError(); return;
        }
        progress({phase: 'structural', status: 'complete', progress: 100});
        finish(null, report);
      } else if (data.type === 'error') {
        finish(reviewError('تعذّر إتمام الفحص البنيوي المحلي؛ راجع الملف ثم أعد المحاولة.', 'BATCH_REVIEW_FAILED', data.error));
      } else protocolError();
    };
    const onWorkerError = event => {
      event.preventDefault?.();
      finish(reviewError('تعذّر تشغيل عامل الفحص المحلي؛ لم تكتمل نتيجة الفحص. أعد المحاولة.', 'BATCH_WORKER_FAILED', event.error ?? {message: event.message}));
    };
    const onMessageError = () => finish(reviewError('تعذّر نقل نتيجة الفحص المحلي إلى الصفحة؛ لم تُقبل نتيجة جديدة.', 'BATCH_RESULT_UNREADABLE'));

    try {
      worker = workerFactory(WORKER_URL, {type: 'module', name: 'mihakk-batch-review'});
      if (!worker || ['postMessage', 'terminate', 'addEventListener', 'removeEventListener'].some(method => typeof worker[method] !== 'function')) {
        throw reviewError('تعذّر بدء عامل الفحص المحلي؛ واجهة العامل غير متاحة.', 'BATCH_WORKER_UNAVAILABLE');
      }
      for (const [type, listener] of [['message', onMessage], ['error', onWorkerError], ['messageerror', onMessageError]]) {
        worker.addEventListener(type, listener);
        attached.push([type, listener]);
      }
      if (signal) { signal.addEventListener('abort', onAbort, {once: true}); abortAttached = true; }
      if (page) { page.addEventListener('pagehide', onAbort, {once: true}); pageHideAttached = true; }
      if (signal?.aborted) { onAbort(); return; }
      progress({phase: 'structural', status: 'starting', progress: 0});
      if (!settled) worker.postMessage({type: 'run', input});
    } catch (error) {
      finish(error?.name === 'BatchReviewError' ? error : reviewError('تعذّر بدء الفحص المحلي أو نقل الملف إلى العامل؛ لم يُنفّذ الفحص.', 'BATCH_WORKER_START_FAILED', error));
    }
  });
}
