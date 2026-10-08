// Shared helpers for the two browser model workers (context NLI and the E5 embedding).
// Pure ES module: no dependency, no network host of its own, no storage of its own.
//  1. Streaming SHA-256 + a verifying response, so model weights are compared with their pinned
//     hash BEFORE the inference session is created (BUG-09).
//  2. One monotonic, bytes-weighted download-progress aggregator (BUG-26).
//  3. Simple Arabic text for raw runtime errors; the original text is kept separately (BUG-40).
//  4. Bounded retry with HTTP Range resume for the one big weight download (BUG-27).

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Incremental SHA-256 (the WebCrypto digest cannot be fed in chunks, and a 339 MB model must not be held twice in memory). */
export class Sha256 {
  constructor() {
    this.state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.tail = new Uint8Array(64);
    this.tailLength = 0;
    this.length = 0;
    this.words = new Uint32Array(64);
    this.finished = false;
  }
  block(bytes, offset) {
    const w = this.words;
    for (let i = 0, j = offset; i < 16; i += 1, j += 4) w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const s = this.state;
    let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    s[0] += a; s[1] += b; s[2] += c; s[3] += d; s[4] += e; s[5] += f; s[6] += g; s[7] += h;
  }
  update(data) {
    if (this.finished) throw new Error('SHA-256 already finalised.');
    const bytes = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const length = bytes.length;
    this.length += length;
    let offset = 0;
    if (this.tailLength > 0) {
      const take = Math.min(64 - this.tailLength, length);
      this.tail.set(bytes.subarray(0, take), this.tailLength);
      this.tailLength += take;
      offset = take;
      if (this.tailLength === 64) { this.block(this.tail, 0); this.tailLength = 0; }
    }
    while (offset + 64 <= length) { this.block(bytes, offset); offset += 64; }
    if (offset < length) { this.tail.set(bytes.subarray(offset), 0); this.tailLength = length - offset; }
    return this;
  }
  digestHex() {
    if (!this.finished) {
      const bitsHigh = Math.floor(this.length / 536870912);
      const bitsLow = (this.length % 536870912) * 8;
      const padding = new Uint8Array((this.tailLength < 56 ? 56 : 120) - this.tailLength + 8);
      padding[0] = 0x80;
      const view = new DataView(padding.buffer);
      view.setUint32(padding.length - 8, bitsHigh, false);
      view.setUint32(padding.length - 4, bitsLow >>> 0, false);
      const total = this.length;
      this.update(padding);
      this.length = total;
      this.finished = true;
    }
    return Array.from(this.state, (word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
  }
}
export function sha256Hex(bytes) { return new Sha256().update(bytes).digestHex(); }

export class WeightIntegrityError extends Error {
  constructor(code, details = {}) {
    super(code === 'mismatch'
      ? 'رُفض ملف النموذج لأن بصمته لا تطابق البصمة المثبتة، فلم يُشغَّل ولم تُستعمل أي نتيجة منه. حُذفت النسخة المحفوظة في المتصفح؛ أعد المحاولة ليُنزَّل الملف من جديد'
      : 'تعذّر التحقق من بصمة ملف النموذج، فلم يُشغَّل');
    this.name = 'WeightIntegrityError';
    this.code = code === 'mismatch' ? 'weight_integrity_mismatch' : 'weight_not_verified';
    this.details = details;
  }
}

const HEX64 = /^[a-f0-9]{64}$/;
const requestUrl = (input) => typeof input === 'string' ? input : input instanceof URL ? input.href : typeof input?.url === 'string' ? input.url : String(input);
const clock = () => globalThis.performance?.now?.() ?? Date.now();

/** Public, additive provenance record. "verified" appears only when the observed hash equals the pinned one. */
export function normalizeWeightIntegrity(declaredSha256, raw) {
  const observed = typeof raw?.observedSha256 === 'string' && HEX64.test(raw.observedSha256) ? raw.observedSha256 : null;
  const verified = raw?.weightVerified === true && observed !== null && observed === declaredSha256;
  const status = verified ? 'verified' : observed !== null && observed !== declaredSha256 ? 'mismatch' : 'declared_not_verified';
  return {
    method: 'sha256-streaming-before-session',
    declaredSha256,
    observedSha256: observed,
    weightVerified: verified,
    status,
    bytes: Number.isSafeInteger(raw?.bytes) && raw.bytes >= 0 ? raw.bytes : null,
    ...(Number.isFinite(raw?.elapsedMS) ? { elapsedMS: Math.round(raw.elapsedMS) } : {}),
    note: verified ? 'The downloaded or cached weight file was hashed in the browser and equals the pinned SHA-256 before the inference session was created.' : 'The SHA-256 is only declared in this report; it was not confirmed against the loaded weight file.',
  };
}

/**
 * Guard for the pinned weight files. `pins` = [{url, sha256, bytes?, label?}].
 *  - `cache` is an `env.customCache` for transformers.js: Cache Storage hits are hashed while they are read;
 *    a mismatch deletes the entry and fails the read, so no session is created.
 *  - `installFetch()` wraps the worker's fetch for the pinned URLs only (fresh downloads are hashed while read).
 * Hashing runs in the same pass that transformers.js already makes over the bytes: no second copy in memory.
 */
export function createWeightGuard({ pins, cacheName = 'transformers-cache', scope = globalThis, fetchWeights = null } = {}) {
  const byUrl = new Map(pins.map((pin) => [pin.url, pin]));
  const results = new Map();
  let cachePromise = null;
  let failure = null;
  const openCache = () => cachePromise ??= (async () => {
    try { return typeof scope.caches === 'undefined' ? null : await scope.caches.open(cacheName); } catch { return null; }
  })();

  async function verifying(response, pin, source, evict) {
    const hasher = new Sha256();
    const started = clock();
    let bytes = 0;
    const settle = async () => {
      const observed = hasher.digestHex();
      const record = { observedSha256: observed, bytes, elapsedMS: clock() - started, source, completedAt: new Date().toISOString() };
      if (observed === pin.sha256 && (!pin.bytes || bytes === pin.bytes)) {
        results.set(pin.url, { ...record, weightVerified: true });
        return;
      }
      results.set(pin.url, { ...record, weightVerified: false });
      try { await evict?.(); } catch { /* the entry is rejected either way */ }
      failure = new WeightIntegrityError('mismatch', { url: pin.url, declaredSha256: pin.sha256, observedSha256: observed, bytes, expectedBytes: pin.bytes ?? null });
      throw failure;
    };
    const init = { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) };
    if (typeof TransformStream === 'function' && response.body) {
      const stream = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) { hasher.update(chunk); bytes += chunk.byteLength; controller.enqueue(chunk); },
        flush: settle,
      }));
      return new Response(stream, init);
    }
    // Very old engines without TransformStream: hash the buffered bytes, same rule.
    const buffer = new Uint8Array(await response.arrayBuffer());
    hasher.update(buffer); bytes = buffer.byteLength;
    await settle();
    return new Response(buffer, init);
  }

  const cache = {
    async match(key, ...rest) {
      const url = requestUrl(key);
      const real = await openCache();
      const hit = real ? await real.match(key, ...rest) : undefined;
      const pin = byUrl.get(url);
      if (!hit || !pin) return hit;
      return verifying(hit, pin, 'cache', () => real.delete(key));
    },
    async put(key, response, ...rest) {
      const real = await openCache();
      if (real) await real.put(key, response, ...rest);
    },
  };

  function installFetch() {
    if (typeof scope.fetch !== 'function' || scope.fetch.__mihakkWeightGuard) return;
    const original = scope.fetch.bind(scope);
    const guarded = async (input, init) => {
      const pin = byUrl.get(requestUrl(input));
      if (!pin || String(init?.method ?? input?.method ?? 'GET').toUpperCase() !== 'GET') return original(input, init);
      const response = await (fetchWeights ? fetchWeights(original, input, init, pin) : original(input, init));
      if (!response.ok || !response.body) return response;
      return verifying(response, pin, 'download', null);
    };
    guarded.__mihakkWeightGuard = true;
    scope.fetch = guarded;
  }

  return {
    cache,
    installFetch,
    get failure() { return failure; },
    clearFailure() { failure = null; },
    result(pin) { return results.get(pin.url) ?? null; },
    summary(pin) { return normalizeWeightIntegrity(pin.sha256, results.get(pin.url)); },
    /** Fail closed: after the model object exists, its weights must have been hashed and equal to the pin. */
    assertVerified(pin) {
      if (failure) throw failure;
      const record = results.get(pin.url);
      if (!record || record.weightVerified !== true) throw new WeightIntegrityError('not_verified', { url: pin.url, declaredSha256: pin.sha256 });
    },
  };
}

const DEFAULT_BACKOFF_MS = Object.freeze([1500, 4000, 9000, 15000]);
const PROGRESS_RESET_BYTES = 4 * 1048576; // a connection that moved this much before it was cut gets a fresh retry budget
const RANGE_REFUSED = 'The server did not honour the Range request; resuming the model download was stopped.';
const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAbort = (error) => error?.name === 'AbortError';

/**
 * Wrapper for the one big weight download: when the connection is cut after some bytes (CDNs drop long HTTP/2 streams on slow links),
 * the rest is requested with `Range: bytes=<received>-` instead of starting over. Bounded (`maxRetries`), never loops forever.
 * The pinned SHA-256 of the finished stream is still checked by the weight guard, so a wrongly spliced file can never run.
 * Use as `fetchWeights` of createWeightGuard.
 */
export function createResumableFetch({ maxRetries = 4, backoffMS = DEFAULT_BACKOFF_MS, sleep = waitFor, onRetry = null } = {}) {
  // Chromium turns an error raised inside a constructed Response body into a bare "TypeError: Failed to fetch" for some consumers,
  // so the real reason (retries spent / server refused Range) is also kept here for the worker to report.
  let lastFailure = null;
  async function fetchResumable(original, input, init) {
    const first = await original(input, init);
    const total = Number(first.headers.get('content-length'));
    const resumable = first.ok && first.status === 200 && first.body && !first.headers.get('content-encoding') && Number.isSafeInteger(total) && total > 0;
    if (!resumable) return first;
    let reader = first.body.getReader();
    let received = 0;
    let sinceReopen = 0;
    let attempt = 0;
    let resumes = 0;
    const base = init?.headers ?? (typeof input === 'object' ? input?.headers : undefined);

    // Returns a reader positioned at `received`, or throws when the retry budget is spent or the server cannot resume.
    async function reopen(cause) {
      if (sinceReopen >= PROGRESS_RESET_BYTES) attempt = 0;
      sinceReopen = 0;
      for (;;) {
        // Bounded twice: per stall (maxRetries) and in total (4 x maxRetries), so a hostile or broken server cannot loop us forever.
        if (attempt >= maxRetries || resumes >= maxRetries * 4) throw cause;
        attempt += 1;
        resumes += 1;
        onRetry?.({ attempt, maxRetries, received, total, error: cause });
        await sleep(backoffMS[Math.min(attempt - 1, backoffMS.length - 1)] ?? 0);
        const headers = new Headers(base);
        headers.set('Range', `bytes=${received}-`);
        let response;
        try { response = await original(input, { ...init, headers }); } catch (error) { if (isAbort(error)) throw error; cause = error; continue; }
        if (response.status !== 206 || !response.body) { response.body?.cancel?.().catch(() => {}); throw new Error(RANGE_REFUSED); }
        const range = /^bytes (\d+)-(\d+)?\/(\d+|\*)$/i.exec(response.headers.get('content-range') ?? '');
        const length = Number(response.headers.get('content-length'));
        // Content-Range is the proof of the offset; where the CDN does not expose it, the length must at least equal the missing tail.
        const offsetOk = range ? Number(range[1]) === received && (range[3] === '*' || Number(range[3]) === total) : length === total - received;
        if (!offsetOk) { response.body.cancel().catch(() => {}); throw new Error(RANGE_REFUSED); }
        return response.body.getReader();
      }
    }

    const body = new ReadableStream({
      async pull(controller) {
        for (;;) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              if (received >= total) { controller.close(); return; }
              throw new TypeError('network error: the model download ended before all bytes arrived');
            }
            received += value.byteLength;
            sinceReopen += value.byteLength;
            controller.enqueue(value);
            return;
          } catch (error) {
            // Nothing received yet, or the caller aborted: not a "resume" situation, surface the original failure.
            if (isAbort(error) || received === 0) { lastFailure = isAbort(error) ? null : error; controller.error(error); return; }
            try { reader = await reopen(error); } catch (final) { lastFailure = final; controller.error(final); return; }
          }
        }
      },
      cancel(reason) { return reader.cancel(reason).catch(() => {}); },
    });
    return new Response(body, { status: first.status, statusText: first.statusText, headers: new Headers(first.headers) });
  }
  Object.defineProperties(fetchResumable, {
    failure: { get: () => lastFailure },
    clearFailure: { value: () => { lastFailure = null; } },
  });
  return fetchResumable;
}

/** One line for the download notice while a cut download is resumed. */
export function describeRetry({ attempt, maxRetries, received } = {}) {
  const megabytes = Math.round((received ?? 0) / 1048576 * 10) / 10;
  return `انقطع الاتصال أثناء تنزيل النموذج بعد ${megabytes} ميغابايت؛ يُستأنف التنزيل من الموضع نفسه (المحاولة ${attempt} من ${maxRetries})`;
}

/** One monotonic, bytes-weighted download percentage for all files of a model (transformers.js reports each file from 0 to 100). */
export function createProgressAggregator({ expectedBytes = 0 } = {}) {
  const files = new Map();
  let shown = 0;
  let lastKey = '';
  const megabytes = (bytes) => Math.round(bytes / 1048576 * 10) / 10;
  function snapshot(final) {
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) { loaded += file.loaded; total += file.total; }
    const denominator = Math.max(expectedBytes, total, 1);
    // Never reaches 100 until the caller says the model is really there; never goes down.
    shown = Math.max(shown, final ? 100 : Math.min(99, Math.floor(loaded / denominator * 1000) / 10));
    const totalBytes = Math.max(expectedBytes, total);
    const loadedMB = megabytes(Math.min(loaded, totalBytes || loaded));
    const totalMB = megabytes(totalBytes);
    return {
      status: 'progress', progress: shown, loaded, total: totalBytes, loadedMB, totalMB, aggregated: true,
      message: totalMB ? `جارٍ تحميل النموذج المحلي… ${loadedMB} من ${totalMB} ميغابايت` : 'جارٍ تحميل النموذج المحلي…',
    };
  }
  function emit(final = false, force = false) {
    const event = snapshot(final);
    const key = `${event.progress}|${event.loadedMB}`;
    if (!force && key === lastKey) return null;
    lastKey = key;
    return event;
  }
  return {
    /** First event, so the user sees "0 MB" immediately. */
    start() { return emit(false, true); },
    /** Feed a raw transformers.js progress event; returns an aggregated event to forward, or null to stay silent. */
    push(raw) {
      if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string') return null;
      const file = files.get(raw.file) ?? { loaded: 0, total: 0 };
      files.set(raw.file, file);
      if (raw.status === 'progress') {
        const total = Number.isFinite(raw.total) && raw.total > 0 ? raw.total : file.total;
        const loaded = Number.isFinite(raw.loaded) && raw.loaded >= 0 ? raw.loaded : file.loaded;
        file.total = Math.max(file.total, total, loaded);
        file.loaded = Math.min(Math.max(file.loaded, loaded), file.total);
      } else if (raw.status === 'done') {
        file.total = Math.max(file.total, file.loaded);
        file.loaded = file.total;
      } else if (raw.status !== 'initiate' && raw.status !== 'download') return null;
      return emit(false);
    },
    finish() { return emit(true, true); },
    /** A status message that rides on the current progress without moving the bar (used for "resuming the download"). */
    notice(message) { return { ...snapshot(false), message }; },
  };
}

const ARABIC_LETTER = /[؀-ۿ]/;
/**
 * Simple Arabic for a raw runtime error. Our own Arabic messages pass through unchanged;
 * the original (usually English) text is returned separately as technicalDetails.
 */
export function describeModelError(raw) {
  const text = String(raw?.message ?? raw ?? '').replace(/\s+/g, ' ').trim();
  const technicalDetails = text.slice(0, 600);
  const done = (kind, message, details = technicalDetails) => ({ kind, message, technicalDetails: details || null });
  if (raw?.name === 'WeightIntegrityError') return done('integrity', raw.message);
  if (ARABIC_LETTER.test(text) && !/ERROR_CODE|protobuf/i.test(text)) return done('app', text.replace(/[.。]+$/, ''), null);
  if (/Can't create a session|ERROR_CODE|protobuf|parsing failed|INVALID_PROTOBUF|Invalid (?:model|ONNX)|Failed to load model|Deserialize|ModelProto/i.test(text)) return done('corrupt_model', 'ملف النموذج المحفوظ تالف أو غير صالح؛ امسح بيانات الموقع في المتصفح (التخزين المؤقت) ثم أعد المحاولة ليُنزَّل من جديد');
  if (/out of memory|Array buffer allocation failed|memory access out of bounds|Cannot allocate|allocation failed|Invalid typed array length|Aborted\(.*memory/i.test(text)) return done('memory', 'نفدت ذاكرة المتصفح أثناء تشغيل النموذج؛ أغلق التبويبات الأخرى وأعد المحاولة، أو تابع دون نموذج');
  if (/did not honour the Range/i.test(text)) return done('network', 'انقطع تنزيل ملف النموذج ولم يقبل الخادم استئنافه من الموضع نفسه؛ أعد المحاولة');
  if (/Failed to fetch|NetworkError|Load failed|network|ERR_(?:HTTP2|CONNECTION|NETWORK|INTERNET|TIMED)|timed? ?out/i.test(text)) return done('network', 'تعذّر تنزيل ملفات النموذج؛ تحقّق من الاتصال بالإنترنت أو من حجب Hugging Face وjsDelivr');
  if (/Could not locate file|Unauthorized|Forbidden|Bad gateway|Service unavailable|Gateway timeout|Internal server error|Bad request|Request timeout/i.test(text)) return done('server', 'ردّ خادم ملفات النموذج بخطأ؛ أعد المحاولة لاحقًا');
  if (/wasm|WebAssembly|ort-wasm|dynamically imported module|Failed to resolve module|Cross-Origin|import\(\)/i.test(text)) return done('runtime', 'تعذّر تحميل مشغّل النموذج في هذا المتصفح؛ جرّب Chrome أو Edge حديثًا أو تحقّق من حجب jsDelivr');
  return done('unknown', 'تعذّر تشغيل النموذج المحلي في هذا المتصفح');
}
