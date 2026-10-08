/**
 * Read-only Quranpedia integration. Only book/surah identifiers leave the browser.
 * Retrieved text stays in the caller's session memory; this module writes no cache,
 * cookies, localStorage, files, or corpus mirror.
 */
import { isValidVerseId } from './quran-index.mjs';
const API_BASE = "https://api.quranpedia.net/v1";
const POLICY_URL = "https://api.quranpedia.net/";
const LICENSE_URL = "https://api.quranpedia.net/dumps/LICENSE.md";
const PROVENANCE_NOTE = "تم التحقق من وصول النص من واجهة Quranpedia البرمجية. هذا تحقق من المصدر والنقل، وليس اعتمادًا شرعيًا أو لغويًا للترجمة.";
const MAX_RESPONSE_CHARS = 4_000_000;
// Object identity is bound to this live client, not to a forgeable uploaded JSON flag.
const liveRetrievalResults = new WeakSet();
export const isLiveRetrievalResult = value => Boolean(value && liveRetrievalResults.has(value));

export class ReferenceSourceError extends Error {
  constructor(message, code = "REFERENCE_UNAVAILABLE", options) {
    super(message, options);
    this.name = "ReferenceSourceError";
    this.code = code;
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new DOMException("تم إلغاء جلب المرجع.", "AbortError");
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    assertNotAborted(signal);
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("تم إلغاء جلب المرجع.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function decodeEntities(text) {
  const names = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip);/giu, (whole, entity) => {
    if (entity.startsWith("#")) {
      const number = entity.slice(0, 2).toLowerCase() === "#x"
        ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : "";
    }
    return names[entity.toLowerCase()] ?? whole;
  });
}

function normalizePlain(text) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").replace(/\s+/gu, " ").trim();
}

function plainFromHtml(html, preserveInline = false) {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,noscript,iframe,object,embed").forEach((node) => node.remove());
    doc.querySelectorAll("br").forEach((node) => node.replaceWith(doc.createTextNode(" ")));
    return normalizePlain(doc.body.textContent ?? "");
  }
  // In non-DOM runtimes return plain text only; never reinsert this as HTML.
  // In a quantity row, inline formatting must not split a base from its power.
  // The browser's textContent already preserves that adjacency.
  if (preserveInline) html = html.replace(/<\/?(?:a|b|em|i|span|strong)\b[^>]*>/giu, '');
  return normalizePlain(decodeEntities(html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")));
}

// Some books prefix every verse with its own number ("3. ", "(2:3)", "[2:3]") and mark notes with <sup>1</sup> anchors.
// These are presentation markers, not translation text; left in, each one reads as a changed number (BUG-07).
// A <sup> is removed only when it holds nothing but a note number or symbol.
// Bare digits directly attached to a number or a supported unit may be powers;
// preserve these as ^N rather than deleting them or concatenating 10 + 5 as 105.
// Explicit note links/roles still identify presentation markers in that context.
const NOTE_ANCHOR = /^\s*(?:[[(]\s*)?(?:\d{1,3}[a-z]?|[*†‡])?(?:\s*[\])])?\s*$/iu;
const EXPLICIT_NOTE = /\b(?:class|role)\s*=\s*["'][^"']*\b(?:footnote(?:-ref)?|noteref|doc-noteref)\b[^"']*["']|\bhref\s*=\s*["']#(?:fn|footnote|note)[\w:-]*["']/iu;
const POWER_BASE = /(?:\p{Nd}|(?:^|[\s(])(?:mm|cm|m|km|mg|g|kg|ml|mL|l|L|s))$/u;
function quantitySuperscript(text, preceding, markup) {
  const exponent = text.trim();
  return /^[+\-−]?\p{Nd}{1,3}$/u.test(exponent) && POWER_BASE.test(preceding) && !EXPLICIT_NOTE.test(markup)
    ? `^${exponent}` : null;
}
function precedingInlineText(node) {
  let text = '', current = node;
  while (current?.parentNode && current.parentNode.nodeName !== 'BODY') {
    for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === 8) continue;
      if (/^(?:BR|DIV|P|LI|SECTION|ARTICLE)$/u.test(sibling.nodeName)) return ` ${text}`;
      text = (sibling.nodeType === 1 ? precedingInlineHtml(sibling.outerHTML) : sibling.textContent ?? '') + text;
      if (text.length >= 128) return text.slice(-128);
    }
    if (/^(?:DIV|P|LI|SECTION|ARTICLE)$/u.test(current.parentNode.nodeName)) return text;
    current = current.parentNode;
  }
  for (let sibling = current?.previousSibling; sibling; sibling = sibling.previousSibling) {
    if (sibling.nodeType === 8) continue;
    if (/^(?:BR|DIV|P|LI|SECTION|ARTICLE)$/u.test(sibling.nodeName)) return ` ${text}`;
    text = (sibling.nodeType === 1 ? precedingInlineHtml(sibling.outerHTML) : sibling.textContent ?? '') + text;
    if (text.length >= 128) return text.slice(-128);
  }
  return text;
}
function precedingInlineHtml(html) {
  // Only context next to the superscript is needed; bound each temporary slice.
  return decodeEntities(html.slice(-1024)
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<\/?(?:br|div|p|li|section|article)\b[^>]*>/giu, ' ')
    .replace(/<[^>]*>/gu, ''));
}
function stripVersePrefix(body, surah, ayah) {
  // Only the number of the verse being requested is removed: a decimal such as "2.5 units" or another number is never touched.
  for (const pattern of [
    new RegExp(`^\\(\\s*${surah}\\s*:\\s*${ayah}\\s*\\)\\s*`, "u"),
    new RegExp(`^\\[\\s*${surah}\\s*:\\s*${ayah}\\s*\\]\\s*`, "u"),
    new RegExp(`^\\(${ayah}\\)\\s*`, "u"),
    new RegExp(`^${ayah}\\.(?!\\d)\\s*`, "u"),
  ]) if (pattern.test(body)) return { body: body.replace(pattern, ""), removed: true };
  return { body, removed: false };
}

function splitTranslation(html, surah, ayah) {
  let body;
  let footnotes;
  let anchorsRemoved = 0;
  let powersPreserved = 0;
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    footnotes = [...doc.querySelectorAll(".foot-notes,.footnotes")].map((node) => plainFromHtml(node.innerHTML));
    doc.querySelectorAll(".foot-notes,.footnotes").forEach((node) => node.remove());
    doc.querySelectorAll("sup").forEach((node) => {
      const markup = node.outerHTML + (node.closest('a')?.outerHTML ?? '');
      const power = quantitySuperscript(node.textContent ?? '', precedingInlineText(node), markup);
      if (power) { node.replaceWith(doc.createTextNode(power)); powersPreserved += 1; }
      else if (NOTE_ANCHOR.test(node.textContent ?? "")) { node.remove(); anchorsRemoved += 1; }
    });
    body = plainFromHtml(doc.body.innerHTML);
  } else {
    footnotes = [];
    body = html.replace(/<div\b[^>]*class\s*=\s*["'][^"']*\b(?:foot-notes|footnotes)\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/giu, (_match, content) => {
      footnotes.push(plainFromHtml(content));
      return " ";
    });
    body = body.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup\s*>/giu, (whole, inner, offset) => {
      const preceding = body.slice(0, offset);
      const linked = preceding.match(/<a\b[^>]*>[^<]*$/iu)?.[0] ?? '';
      const text = plainFromHtml(inner);
      const power = quantitySuperscript(text, precedingInlineHtml(preceding), whole + linked);
      if (power) { powersPreserved += 1; return power; }
      if (!NOTE_ANCHOR.test(text)) return whole;
      anchorsRemoved += 1;
      return "";
    });
    body = plainFromHtml(body, powersPreserved > 0);
  }
  // API verse numbers and note anchors are presentation markers, not verse text.
  const prefix = stripVersePrefix(body, surah, ayah);
  body = prefix.body.replace(/\[\d+\]/gu, () => { anchorsRemoved += 1; return ""; });
  return { translation: normalizePlain(body), footnotes: footnotes.filter(Boolean), normalization: { versePrefixRemoved: prefix.removed, noteAnchorsRemoved: anchorsRemoved, ...(powersPreserved ? { quantitySuperscriptsPreserved: powersPreserved } : {}) } };
}

function validInteger(value, min, max) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function validLanguage(value) {
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(value)) {
    throw new ReferenceSourceError("رمز لغة المرجع غير صالح.", "INVALID_REFERENCE_LANGUAGE");
  }
  return value;
}

function retryDelay(response, now) {
  const header = response.headers?.get?.("retry-after");
  const seconds = header && /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) : null;
  const date = seconds === null && header ? Date.parse(header) : NaN;
  const requested = seconds !== null ? seconds * 1000 : Number.isFinite(date) ? date - now().getTime() : 1500;
  // A longer Retry-After cannot be honored safely by a bounded interactive retry.
  if (requested > 10_000) return null;
  return Math.max(1000, requested);
}

export function createReferenceClient({ fetchImpl = (...args) => globalThis.fetch(...args), now = () => new Date(), delay = pause, cryptoImpl = globalThis.crypto, timeoutMs = 20_000 } = {}) {
  async function getJson(url, { signal, onRetry } = {}) {
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      assertNotAborted(signal);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let data;
      try {
        response = await fetchImpl(url, { method: "GET", signal: controller.signal, credentials: "omit", cache: "no-store", redirect:'error', headers: { Accept: "application/json" } });
        assertNotAborted(signal);
        if (response.redirected || (response.url && response.url !== url)) throw new ReferenceSourceError('لم يصل الرد من رابط واجهة Quranpedia المطلوب؛ امتنع توثيق النقل.', 'REFERENCE_ORIGIN_MISMATCH');
        if (response.status !== 429 && !response.ok) {
          throw new ReferenceSourceError(`تعذر جلب المرجع من واجهة Quranpedia (HTTP ${response.status}).`);
        }
        if (response.status !== 429) {
          const text = await response.text();
          assertNotAborted(signal);
          if (text.length > MAX_RESPONSE_CHARS) throw new ReferenceSourceError("تجاوز رد المرجع الحجم المسموح.", "INVALID_REFERENCE_RESPONSE");
          try { data = JSON.parse(text); }
          catch { throw new ReferenceSourceError("رد المرجع ليس JSON صالحًا.", "INVALID_REFERENCE_RESPONSE"); }
        }
      } catch (error) {
        assertNotAborted(signal);
        if (controller.signal.aborted) throw new ReferenceSourceError("انتهت مهلة الاتصال بواجهة Quranpedia. يمكن إعادة المحاولة.", "REFERENCE_TIMEOUT", { cause: error });
        if (error instanceof ReferenceSourceError) throw error;
        throw new ReferenceSourceError("تعذر الاتصال بواجهة Quranpedia. لم تُستبدل الأدلة ببيانات تخمينية.", "REFERENCE_UNAVAILABLE", { cause: error });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
      if (response.status !== 429) return data;
      const wait = retryDelay(response, now);
      if (attempt === 2 || wait === null) throw new ReferenceSourceError("بلغ المصدر حد الطلبات. أعد المحاولة لاحقًا.", "REFERENCE_RATE_LIMIT");
      onRetry?.({ attempt: attempt + 1, waitMs: wait });
      await delay(wait, signal);
    }
    throw new ReferenceSourceError("تعذر جلب المرجع.");
  }

  async function hash(text) {
    if (!cryptoImpl?.subtle) throw new ReferenceSourceError("يلزم تشغيل آمن HTTPS أو localhost لحساب بصمة الدليل.", "REFERENCE_HASH_UNAVAILABLE");
    const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function listReferenceBooks(language = "en") {
    validLanguage(language);
    const data = await getJson(`${API_BASE}/translation-books/${language}`);
    if (!Array.isArray(data)) throw new ReferenceSourceError("صيغة قائمة المراجع غير متوقعة.", "INVALID_REFERENCE_RESPONSE");
    const books = [];
    const seen = new Set();
    for (const item of data) {
      const id = validInteger(item?.id, 1, 1_000_000_000);
      if (!id || seen.has(id) || item?.language?.code !== language || typeof item?.name !== "string") continue;
      const title = plainFromHtml(item.short_name || item.name);
      if (!title) continue;
      seen.add(id);
      books.push({ id, title, fullTitle:plainFromHtml(item.name), language, description: plainFromHtml(typeof item.card === "string" ? item.card : ""), sourceURL: `${API_BASE}/book/${id}`, provider: "Quranpedia.net", edition: "طبعة الكتاب غير معلنة في قائمة المصدر" });
    }
    return books;
  }

  async function fetchReferenceBookMetadata(book, {signal} = {}) {
    const id = validInteger(book?.id, 1, 1_000_000_000);
    const language = validLanguage(book?.language ?? 'en');
    if (!id) throw new ReferenceSourceError('معرّف الكتاب غير صالح.', 'INVALID_REFERENCE_BOOK');
    const sourceURL = `${API_BASE}/book/${id}`;
    const data = await getJson(sourceURL, {signal});
    if (data?.id !== id || data?.language?.code !== language || typeof data.name !== 'string') throw new ReferenceSourceError('سجل الكتاب لا يطابق معرّف المرجع أو لغته.', 'INVALID_REFERENCE_RESPONSE');
    const person = value => typeof value === 'string' ? plainFromHtml(value) : value && typeof value === 'object' ? plainFromHtml(value.full_name || value.ar_name || value.name || '') : '';
    return {...book, title:plainFromHtml(data.short_name || data.name), fullTitle:plainFromHtml(data.name), author:person(data.author) || null, translator:person(data.translator) || null, publisher:typeof data.nasher === 'string' ? plainFromHtml(data.nasher) || null : null, edition:typeof data.edition === 'string' && data.edition.trim() ? plainFromHtml(data.edition) : 'طبعة الكتاب غير معلنة في سجل المصدر', publicationYear:data.publish_year ?? null, bibliographicURL:sourceURL, bibliographicRetrievedAt:now().toISOString(), bibliographicSha256:await hash(JSON.stringify(data)), bibliographicStatus:'recorded-from-provider-not-independently-certified'};
  }

  async function fetchReferenceForRows({ book, rows, onProgress, signal } = {}) {
    const bookId = validInteger(book?.id, 1, 1_000_000_000);
    if (!bookId || typeof book?.title !== "string" || !book.title.trim()) throw new ReferenceSourceError("اختر كتابًا من قائمة المراجع الرسمية.", "INVALID_REFERENCE_BOOK");
    const language = validLanguage(book.language ?? "en");
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20_000) throw new ReferenceSourceError("لا توجد صفوف صالحة لجلب المرجع.", "INVALID_REFERENCE_ROWS");
    const skippedRows = [];
    const wantedInput = rows.flatMap((row, index) => {
      const surah = validInteger(row?.surah, 1, 114);
      const ayah = validInteger(row?.ayah, 1, 286);
      if (!surah || !ayah || !isValidVerseId(surah,ayah)) { skippedRows.push({rowNumber:row?.rowNumber ?? index+1,surah:row?.surah,ayah:row?.ayah,reason:'invalid-verse-id'}); return []; }
      return [{ surah, ayah, rowNumber: row.rowNumber ?? index + 1 }];
    });
    const wanted = [...new Map(wantedInput.map(row=>[`${row.surah}:${row.ayah}`,row])).values()];
    if (!wanted.length) throw new ReferenceSourceError('لا توجد معرّفات آيات صالحة لجلب المرجع.', 'INVALID_REFERENCE_ROWS');
    const surahs = [...new Set(wanted.map((row) => row.surah))].sort((a, b) => a - b);
    const retrieved = new Map();
    const batches = [];
    const normalizationTotals = { versePrefixRows: 0, noteAnchorsRemoved: 0 };
    for (let index = 0; index < surahs.length; index += 1) {
      assertNotAborted(signal);
      if (index > 0) await delay(550, signal);
      const surah = surahs[index];
      const sourceURL = `${API_BASE}/translation/${bookId}/${surah}`;
      onProgress?.({ phase: "fetching", completed: index, total: surahs.length, surah });
      const data = await getJson(sourceURL, { signal, onRetry: (retry) => onProgress?.({ phase: "retrying", completed: index, total: surahs.length, surah, ...retry }) });
      if (!Array.isArray(data) || data.length === 0 || data.length > 286) throw new ReferenceSourceError("لم يُرجع المصدر نصوص السورة بالشكل المتوقع.", "INVALID_REFERENCE_RESPONSE");
      const retrievedAt = now().toISOString();
      const batchSha256 = await hash(JSON.stringify(data));
      const batchSeen = new Set();
      for (const item of data) {
        const ayah = validInteger(item?.ayah_number, 1, 286);
        if (!ayah || batchSeen.has(ayah) || typeof item.translation_text !== "string" || !item.translation_text.trim()) {
          throw new ReferenceSourceError("يحتوي رد المصدر معرّفات أو نصوصًا غير صالحة.", "INVALID_REFERENCE_RESPONSE");
        }
        batchSeen.add(ayah);
        const { translation, footnotes, normalization } = splitTranslation(item.translation_text, surah, ayah);
        normalizationTotals.versePrefixRows += normalization.versePrefixRemoved ? 1 : 0;
        normalizationTotals.noteAnchorsRemoved += normalization.noteAnchorsRemoved;
        if (!translation) throw new ReferenceSourceError("متن الترجمة المرجعية فارغ.", "INVALID_REFERENCE_RESPONSE");
        const sha256 = await hash(translation);
        const retrievalSha256 = await hash(item.translation_text);
        retrieved.set(`${surah}:${ayah}`, { surah, ayah, translation, footnotes, normalization, sourceURL, retrievedAt, sha256, normalizedSha256: sha256, retrievalSha256, rawSha256: retrievalSha256, batchSha256, locator: `${surah}:${ayah}`, bookId, verificationStatus: "verified", verificationNote: PROVENANCE_NOTE });
      }
      batches.push({ surah, sourceURL, retrievedAt, sha256: batchSha256 });
      onProgress?.({ phase: "complete", completed: index + 1, total: surahs.length, surah });
    }
    assertNotAborted(signal);
    const missingRequestedIds = [];
    const resultRows = wanted.flatMap((row) => {
      const reference = retrieved.get(`${row.surah}:${row.ayah}`);
      if (!reference) { missingRequestedIds.push(`${row.surah}:${row.ayah}`); return []; }
      return [{ ...reference, rowNumber: reference.ayah }];
    });
    const result = {
      rows: resultRows,
      metadata: {
        title: plainFromHtml(book.title), language, edition: plainFromHtml(book.edition || "طبعة الكتاب غير معلنة في رد المصدر"),
        fullTitle:plainFromHtml(book.fullTitle || book.title), author:book.author || null, translator:book.translator || null, publisher:book.publisher || null, publicationYear:book.publicationYear ?? null, bibliographicURL:book.bibliographicURL || null, bibliographicRetrievedAt:book.bibliographicRetrievedAt || null, bibliographicSha256:book.bibliographicSha256 || null,
        url: `${API_BASE}/book/${bookId}`, sourceURL: `${API_BASE}/translation/${bookId}`, provider: "Quranpedia.net", bookId,
        version: "Quranpedia API v1 — وقت الجلب وبصمة كل نص مرفقان", retrievedAt: now().toISOString(),
        verificationStatus: "verified", verificationNote: PROVENANCE_NOTE, sourceKind: "quranpedia-api", referenceKind: "quranpedia-live", publicationReady: false,
        licenseNote: "استخدام حي داخل التطبيق وفق سياسة Quranpedia؛ تبقى حقوق الترجمات لأصحابها. لا ينشر مِحَكّ corpus أو نسخة قاعدة بيانات.",
        policyURL: POLICY_URL, licenseURL: LICENSE_URL, retention: "session-memory-only", footnoteHandling: "الحواشي منفصلة عن المتن ولا تدخل حساب التشابه.",
        normalization: { ...normalizationTotals, note: "حُذف رقم الآية من بداية النص وأرقام الحواشي قبل المقارنة حتى لا تُعد أرقامًا مختلفة؛ بصمة الرد الخام وبصمة المتن بعد المعالجة محفوظتان لكل صف." },
        coverageCount:resultRows.length, requestedCount:wanted.length, missingRequestedIds, skippedRows, partialCoverage:missingRequestedIds.length>0, batches
      }
    };
    liveRetrievalResults.add(result);
    return result;
  }
  return { listReferenceBooks, fetchReferenceBookMetadata, fetchReferenceForRows };
}

const client = createReferenceClient();
export const listReferenceBooks = (...args) => client.listReferenceBooks(...args);
export const fetchReferenceBookMetadata = (...args) => client.fetchReferenceBookMetadata(...args);
export const fetchReferenceForRows = (...args) => client.fetchReferenceForRows(...args);
