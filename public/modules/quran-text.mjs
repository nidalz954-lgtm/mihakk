import { SURAH_AYAH_COUNTS, isValidVerseId } from './quran-index.mjs';

/**
 * Approved Quran text shown beside each case so the reviewer reads the verse itself.
 * DISPLAY ONLY: the app never compares a translation with this text automatically.
 * Source: Quranpedia open data (an approved source in the challenge reference package),
 * mushaf id 1 «مصحف حفص — موافق لطبعة مجمع الملك فهد», dump version 2026-10-06.
 * The file is pinned by SHA-256; a different file is refused rather than displayed.
 */
export const QURAN_DISPLAY = Object.freeze({
  file: '../data/quran-hafs-quranpedia.json',
  sha256: 'c414b5e5d4ae38bb99cf9c66ea44cb2b1a7aaa7053c2a5c4fa155cab17d15de8',
  source: 'الموسوعة القرآنية quranpedia.net',
  sourceURL: 'https://quranpedia.net',
  name: 'مصحف حفص — موافق لطبعة مجمع الملك فهد لطباعة المصحف الشريف',
  dumpVersion: '2026-10-06',
  dumpSha256: '18ecddb19fbab73f38b9f869cf4ca1f33796edcfdf055fa53985992c12c02c4d',
  displayOnly: true,
});

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Validates the pinned file and returns a read-only verse lookup. */
export async function parseQuranDisplay(text) {
  if (typeof text !== 'string' || await sha256Hex(text) !== QURAN_DISPLAY.sha256) throw new Error('بصمة ملف نص المصحف لا تطابق البصمة المثبتة، فلن يُعرض النص');
  const data = JSON.parse(text);
  const valid = data?.schema === 'mihakk-quran-display/1' && Array.isArray(data.verses) && data.verses.length === 114
    && data.verses.every((surah, index) => Array.isArray(surah) && surah.length === SURAH_AYAH_COUNTS[index] && surah.every((verse) => typeof verse === 'string' && verse.trim()));
  if (!valid) throw new Error('بنية ملف نص المصحف غير صالحة');
  return Object.freeze({
    meta: Object.freeze({ ...QURAN_DISPLAY, description: data.description, riwaya: data.riwaya, counting: data.counting, license: data.license }),
    verse(surah, ayah) { return isValidVerseId(surah, ayah) ? data.verses[surah - 1][ayah - 1] : null; },
    surahName(surah) { return Number.isInteger(surah) && surah >= 1 && surah <= 114 ? data.surahNames?.[surah - 1] ?? null : null; },
  });
}

/** A request that never answers must not leave the case window on "loading" forever. */
export const QURAN_LOAD_TIMEOUT_MS = 20000;

let loading;
/** Loads once per page; a failed or timed-out load can be retried on the next case. */
export function loadQuranText(fetchImpl = globalThis.fetch, { timeoutMS = QURAN_LOAD_TIMEOUT_MS } = {}) {
  if (!loading) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error(`انتهت مهلة تحميل ملف نص المصحف (${Math.round(timeoutMS / 1000)} ثانية)`));
      }, timeoutMS);
    });
    const load = Promise.resolve()
      .then(() => fetchImpl(new URL(QURAN_DISPLAY.file, import.meta.url), controller ? { signal: controller.signal } : undefined))
      .catch(() => { throw new Error('تعذّر الاتصال لتحميل ملف نص المصحف'); })
      .then((response) => { if (!response.ok) throw new Error(`تعذّر تنزيل ملف نص المصحف (HTTP ${response.status})`); return response.text(); })
      .then(parseQuranDisplay);
    loading = Promise.race([load, timeout])
      .finally(() => clearTimeout(timer))
      .catch((error) => { loading = undefined; throw error; });
  }
  return loading;
}
