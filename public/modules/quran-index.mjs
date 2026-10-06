/**
 * Numeric verse index only: no Quran text or translation is bundled here.
 * Standard Kufic numbering, commonly used in the Hafs Medina mushaf.
 * Source verified against Tanzil metadata v1.0 on 2026-10-03:
 * https://tanzil.net/res/text/metadata/quran-data.xml
 * https://tanzil.net/docs/Quran_Metadata
 * Unnumbered opening basmalas are not separate rows in this 6,236-verse index.
 * Other counting conventions require a separate index and must not be silently
 * interpreted as errors in the religious text.
 */
export const SURAH_AYAH_COUNTS = Object.freeze([
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128,
  111, 110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30,
  73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18,
  45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12,
  30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36,
  25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11,
  8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
]);

export const TOTAL_AYAHS = SURAH_AYAH_COUNTS.reduce((sum, count) => sum + count, 0);
export const INDEX_PROVENANCE = Object.freeze({
  title: 'Tanzil Quran metadata',
  edition: '1.0',
  url: 'https://tanzil.net/docs/Quran_Metadata',
  dataUrl: 'https://tanzil.net/res/text/metadata/quran-data.xml',
  verificationStatus: 'verified',
  verifiedOn: '2026-10-03',
  countingConvention: 'Kufic verse numbering / common Hafs Medina index',
  totalSurahs: 114,
  totalVerses: TOTAL_AYAHS,
  basmalaPolicy: 'Unnumbered opening basmalas are not separate verse IDs.',
  containsReligiousText: false,
});

export function normalizeDigits(value) {
  return String(value ?? '')
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

export function strictInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = normalizeDigits(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

export function isValidVerseId(surah, ayah) {
  return Number.isInteger(surah) && surah >= 1 && surah <= 114
    && Number.isInteger(ayah) && ayah >= 1 && ayah <= SURAH_AYAH_COUNTS[surah - 1];
}

export function verseOrdinal(surah, ayah) {
  if (!isValidVerseId(surah, ayah)) return null;
  let total = ayah;
  for (let index = 0; index < surah - 1; index += 1) total += SURAH_AYAH_COUNTS[index];
  return total;
}

export function normalizeScope(scope = { type: 'full' }) {
  if (scope === 'full' || scope == null) scope = { type: 'full' };
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('Scope must be "full", {type:"provided"}, or {type:"selected",surahs:[...]}.');
  }
  const type = scope.type ?? (Array.isArray(scope.surahs) ? 'selected' : 'full');
  if (!['full', 'selected', 'provided'].includes(type)) throw new TypeError('Unknown audit scope type.');
  let surahs;
  if (type === 'provided') {
    // The audit resolves the observed surahs and unique valid IDs from rows.
    // There is deliberately no implied requirement for complete surahs here.
    surahs = [];
  } else if (type === 'full') {
    surahs = Array.from({ length: 114 }, (_, index) => index + 1);
  } else {
    if (!Array.isArray(scope.surahs) || scope.surahs.length === 0) {
      throw new TypeError('Selected scope requires at least one complete surah.');
    }
    surahs = [...new Set(scope.surahs.map(strictInteger))];
    if (surahs.some((surah) => surah == null || surah < 1 || surah > 114)) {
      throw new RangeError('Selected surah numbers must be integers from 1 to 114.');
    }
    surahs.sort((left, right) => left - right);
  }
  return { type, surahs, expectedVerses: surahs.reduce((sum, surah) => sum + SURAH_AYAH_COUNTS[surah - 1], 0) };
}

export function expectedVerseIds(scope = { type: 'full' }) {
  const normalized = normalizeScope(scope);
  return normalized.surahs.flatMap((surah) => Array.from(
    { length: SURAH_AYAH_COUNTS[surah - 1] }, (_, index) => `${surah}:${index + 1}`,
  ));
}
