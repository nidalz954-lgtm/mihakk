import { isValidVerseId, strictInteger } from './quran-index.mjs';

const PROTOCOL_VERSION = 'mihakk-reference-trust/1';
const OFFICIAL_ORIGIN = 'https://api.quranpedia.net';
const SYNTHETIC_PREFIX = 'SYNTHETIC TRAINING TEXT';
const SHA256 = /^[a-f\d]{64}$/iu;
const TRANSPORT_LIMITATION = 'هذه فحوص اتساق للبيانات والروابط والبصمات. لا تثبت بمفردها حدوث الجلب أو هوية المؤلف أو صحة الترجمة؛ يتولى عميل الجلب الحي التحقق من الاتصال HTTPS بالمصدر الرسمي.';

function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function officialURL(value) {
  try {
    const url = new URL(string(value));
    return url.origin === OFFICIAL_ORIGIN && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
export function knownAttribution(value) {
  const text = string(value);
  if (!text || /(?:unknown|not\s+(?:known|provided|declared|supplied)|unavailable|غير\s+(?:معلوم|معروف|متاح|معلن|موثق)|غير\s+معلنة|مجهول)/iu.test(text) || /^unchecked$/iu.test(text)) return '';
  return text;
}
function bibliographicStatus(metadata) {
  const author = knownAttribution(metadata.author) || knownAttribution(metadata.translator);
  const publisher = knownAttribution(metadata.publisher);
  const edition = knownAttribution(metadata.edition);
  return {
    authorStatus: author ? 'recorded-unchecked' : 'unknown',
    publisherStatus: publisher ? 'recorded-unchecked' : 'unknown',
    editionStatus: edition ? 'recorded-unchecked' : 'unknown',
    author: author || null, publisher: publisher || null, publisherEdition: edition || null,
    bibliographicNote: 'وجود اسم أو طبعة في البيانات ليس مصادقة على نسبتها؛ عند غيابها تعرض «غير معلومة» ولا يستبدل وقت الجلب بتاريخ الطبعة.'
  };
}

/**
 * Check provenance self-consistency without network or persistent storage.
 * No uploaded declaration can promote itself into independently verified source
 * authority. Official retrieval may be eligible for difference inspection, while
 * scholarly approval stays unknown. A consistent forged JSON cannot be detected
 * solely from this payload; live transport must be bound by the retrieval client.
 */
export async function verifyReferenceProvenance({ rows = [], metadata = {}, cryptoImpl = globalThis.crypto } = {}) {
  if (!Array.isArray(rows) || rows.length > 20_000) throw new TypeError('Reference rows must be an array of at most 20,000 entries.');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('Reference metadata must be an object.');
  const checkedRows = rows.map(row => ({ ...(row && typeof row === 'object' ? row : {}) }));
  const sourceKind = string(metadata.sourceKind) || 'user-upload';
  const checks = [];
  const check = (scope, code, status, message, details = {}) => checks.push({ scope, code, status, message, ...details });
  const idCounts = new Map();
  for (const row of checkedRows) {
    const surah = strictInteger(row.surah), ayah = strictInteger(row.ayah);
    if (isValidVerseId(surah, ayah)) {
      const id = `${surah}:${ayah}`;
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
  }
  for (let index = 0; index < checkedRows.length; index += 1) {
    const row = checkedRows[index];
    const surah = strictInteger(row.surah), ayah = strictInteger(row.ayah);
    const verseId = `${surah}:${ayah}`;
    const validId = isValidVerseId(surah, ayah);
    const uniqueId = validId && idCounts.get(verseId) === 1;
    const validText = typeof row.translation === 'string' && Boolean(row.translation.trim());
    row.canCompareText = Boolean(uniqueId && validText);
    // This module has no connection evidence. A live retrieval client must bind
    // actual transport separately before any source-trusted outcome is possible.
    row.trustedSourceProvenance = false;
    row.allowNoSignal = false;
    if (!validId) check('row', 'comparison_id_invalid', 'fail', 'لا يصلح موضع الصف لتكوين زوج نصي في فهرس العد المعلن.', { rowNumber: row.rowNumber ?? index + 1, verseId });
    else if (!uniqueId) check('row', 'comparison_id_duplicate', 'fail', 'موضع المرجع مكرر؛ لا يمكن اختيار نص مرجعي واحد لهذا الزوج.', { rowNumber: row.rowNumber ?? index + 1, verseId });
    if (!validText) check('row', 'comparison_text_empty', 'fail', 'لا يوجد متن صالح للمقارنة النصية.', { rowNumber: row.rowNumber ?? index + 1, verseId });
  }
  const info = bibliographicStatus(metadata);
  for (const field of ['author', 'publisher', 'edition']) {
    if (info[`${field}Status`] === 'unknown') check('metadata', `${field}_unknown`, 'warning', `${field === 'author' ? 'هوية المؤلف أو المترجم' : field === 'publisher' ? 'الناشر' : 'طبعة الناشر'} غير معلومة من البيانات المتاحة.`);
  }
  const normalizedMetadata = {
    ...metadata, sourceKind, ...info,
    verificationStatus: 'unverified', scholarlyVerificationStatus: 'unknown', scholarlyApproval: 'none',
    transportVerifiedByThisProtocol: false,
    trustedSourceProvenance: false,
    trustProtocolVersion: PROTOCOL_VERSION, trustLimitations: TRANSPORT_LIMITATION,
    verificationNote: 'يُفصل تحقق النقل واتساق الملف عن سلطة المرجع والاعتماد العلمي.'
  };
  function result(recordedProvenanceConsistent) {
    const canCompareText = checkedRows.some(row => row.canCompareText);
    normalizedMetadata.recordedProvenanceConsistent = recordedProvenanceConsistent;
    normalizedMetadata.trustSummary = {
      ...normalizedMetadata.trustSummary,
      inspectableRows: checkedRows.filter(row => row.canCompareText).length
    };
    return { rows: checkedRows, metadata: normalizedMetadata, checks, canCompareText, eligibleForComparison: canCompareText, recordedProvenanceConsistent, trustedSourceProvenance: false };
  }

  const cachedHashes = new Map();
  async function hash(text) {
    if (typeof cryptoImpl?.subtle?.digest !== 'function') return null;
    if (!cachedHashes.has(text)) cachedHashes.set(text, Promise.resolve().then(() => cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(text))).then(buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')).catch(() => null));
    return cachedHashes.get(text);
  }

  if (sourceKind === 'synthetic-teaching') {
    const synthetic = metadata.synthetic === true && checkedRows.length > 0 && checkedRows.every(row => typeof row.translation === 'string' && row.translation.startsWith(SYNTHETIC_PREFIX));
    normalizedMetadata.verificationStatus = synthetic ? 'verified' : 'unverified';
    normalizedMetadata.authorityStatus = synthetic ? 'authored-teaching-only' : 'unverified-teaching-claim';
    normalizedMetadata.rightsStatus = 'teaching-authorship-declared';
    normalizedMetadata.verificationNote = 'التحقق هنا من وسم مثال برمجي اصطناعي؛ يصنّف للتعليم فقط وليس مرجعًا دينيًا معتمدًا أو دليل دقة علمية، ولا يثبت الوسم وحده أصل المحتوى.';
    check('metadata', synthetic ? 'synthetic_teaching_consistent' : 'synthetic_teaching_invalid', synthetic ? 'pass' : 'fail', synthetic ? 'جميع الصفوف موسومة كمثال تعليمي اصطناعي.' : 'يلزم تصريح synthetic=true وأن يبدأ كل متن بالوسم التعليمي؛ لم يُعتمد أي صف كمرجع ديني.');
    for (const row of checkedRows) {
      row.verificationStatus = synthetic ? 'verified' : 'unverified';
      row.sourceKind = sourceKind;
      row.authorityStatus = normalizedMetadata.authorityStatus;
      row.scholarlyVerificationStatus = 'unknown';
      row.scholarlyApproval = 'none';
      row.recordedProvenanceConsistent = synthetic;
      row.comparisonEligibility = row.canCompareText ? synthetic ? 'teaching-inspection-only' : 'experimental-text-comparison-only' : 'not-eligible';
    }
    normalizedMetadata.trustSummary = { eligibleRows: synthetic ? checkedRows.length : 0, ineligibleRows: synthetic ? 0 : checkedRows.length };
    return result(synthetic);
  }

  if (sourceKind !== 'quranpedia-api') {
    normalizedMetadata.authorityStatus = 'user-declared';
    normalizedMetadata.rightsStatus = 'user-declared-unchecked';
    normalizedMetadata.verificationNote = 'مرجع مرفوع بإقرار المستخدم؛ يمكن مشاهدة فروقه الحرفية، ولا يتحول إلى مصدر متحقق بمجرد خانة تأكيد أو رابط مكتوب.';
    check('metadata', 'uploaded_source_not_authenticated', 'warning', 'إقرار المستخدم محفوظ كمعلومة، ولا يمنح verified أو شهادة سلطة المرجع.');
    for (const row of checkedRows) {
      row.verificationStatus = 'unverified'; row.sourceKind = sourceKind;
      row.authorityStatus = 'user-declared'; row.scholarlyVerificationStatus = 'unknown'; row.scholarlyApproval = 'none';
      row.recordedProvenanceConsistent = false;
      row.comparisonEligibility = row.canCompareText ? 'experimental-text-comparison-only' : 'not-eligible';
    }
    normalizedMetadata.trustSummary = { eligibleRows: 0, ineligibleRows: checkedRows.length };
    return result(false);
  }

  const bookId = strictInteger(metadata.bookId);
  const metadataURL = officialURL(metadata.url);
  const metadataPathValid = bookId > 0 && metadataURL?.pathname === `/v1/book/${bookId}`;
  const metadataTimeValid = validTimestamp(metadata.retrievedAt);
  const metadataClaimValid = metadata.verificationStatus === 'verified';
  const globalValid = Boolean(metadataPathValid && metadataTimeValid && metadataClaimValid);
  if (!metadataPathValid) check('metadata', 'official_book_locator_invalid', 'fail', 'رابط سجل الكتاب لا يطابق HTTPS والنطاق الرسمي ومعرّف الكتاب.');
  if (!metadataTimeValid) check('metadata', 'retrieval_time_invalid', 'fail', 'وقت الجلب غير موجود أو ليس توقيت ISO صالحًا.');
  if (!metadataClaimValid) check('metadata', 'retrieval_not_recorded', 'fail', 'لم يسجل عميل المصدر نتيجة جلب قابلة للفحص.');
  if (typeof cryptoImpl?.subtle?.digest !== 'function') check('metadata', 'hash_recomputation_unavailable', 'fail', 'تعذر إعادة حساب بصمة المتن في هذا السياق.');
  check('metadata', 'source_authority_not_certified', 'warning', 'الجلب من خدمة مسموحة واتساق البصمات يثبتان مسارًا قابلًا للتتبع فقط؛ السلطة العلمية وصحة الترجمة لم تعتمدا.');
  check('metadata', 'raw_hash_limit', 'warning', 'عند غياب الرد الخام يمكن فحص شكل بصمته فقط؛ بصمة يحسبها العميل لا تصادق بذاتها على المؤلف أو النقل.');
  let eligibleRows = 0;
  for (let index = 0; index < checkedRows.length; index += 1) {
    const row = checkedRows[index];
    const surah = strictInteger(row.surah), ayah = strictInteger(row.ayah);
    const verseId = `${surah}:${ayah}`;
    const failures = [];
    const fail = (code, message) => {
      failures.push(code);
      check('row', code, 'fail', message, { rowNumber: row.rowNumber ?? index + 1, verseId });
    };
    if (!globalValid) failures.push('invalid_global_provenance');
    if (!isValidVerseId(surah, ayah)) fail('reference_verse_id_invalid', 'معرّف الآية غير صالح لفهرس العد المعلن.');
    if (isValidVerseId(surah, ayah) && idCounts.get(verseId) !== 1) fail('reference_verse_id_duplicate', 'الموضع المرجعي مكرر؛ يلزم نص واحد لكل زوج.');
    if (strictInteger(row.bookId) !== bookId) fail('reference_book_id_mismatch', 'معرّف كتاب الصف لا يطابق سجل الكتاب.');
    if (string(row.locator) !== verseId) fail('reference_locator_mismatch', 'موضع الصف لا يطابق رقم السورة والآية.');
    const url = officialURL(row.sourceURL);
    if (!url || ![`/v1/translation/${bookId}/${surah}`, `/v1/translation/${bookId}/${surah}/${ayah}`].includes(url.pathname)) fail('reference_source_url_invalid', 'رابط النص لا يطابق الكتاب والسورة والآية على المصدر الرسمي.');
    if (!validTimestamp(row.retrievedAt)) fail('reference_retrieval_time_invalid', 'وقت جلب الصف غير صالح.');
    if (row.verificationStatus !== 'verified') fail('reference_row_not_verified', 'الصف لم يسجل تحقق نقل صالحًا.');
    if (row.sourceKind && row.sourceKind !== sourceKind) fail('reference_source_kind_mismatch', 'نوع مصدر الصف لا يطابق المصدر العام.');
    const normalizedSha256 = string(row.normalizedSha256 || row.sha256);
    const rawSha256 = string(row.rawSha256 || row.retrievalSha256);
    let normalizedHashRecomputed = false;
    if (!SHA256.test(normalizedSha256)) fail('normalized_hash_invalid', 'بصمة المتن ليست SHA256 صالح الشكل.');
    if (!SHA256.test(rawSha256)) fail('raw_hash_invalid', 'بصمة الرد الخام ليست SHA256 صالح الشكل.');
    if (typeof row.translation !== 'string' || !row.translation.trim()) fail('reference_text_empty', 'متن الترجمة غير موجود.');
    else if (SHA256.test(normalizedSha256)) {
      const expected = await hash(row.translation);
      normalizedHashRecomputed = expected !== null;
      if (!expected || expected !== normalizedSha256.toLowerCase()) fail('normalized_hash_mismatch', 'المتن الحالي لا يطابق البصمة المسجلة أو تعذر إعادة حسابها.');
    }
    const rawText = typeof row.rawText === 'string' ? row.rawText : typeof row.rawTranslation === 'string' ? row.rawTranslation : null;
    row.rawHashVerification = rawText === null ? 'format-only' : 'not-recomputed';
    if (rawText !== null && SHA256.test(rawSha256)) {
      const expected = await hash(rawText);
      row.rawHashVerification = expected === null ? 'unavailable' : 'recomputed';
      if (!expected || expected !== rawSha256.toLowerCase()) fail('raw_hash_mismatch', 'الرد الخام المتاح لا يطابق البصمة المسجلة.');
    }
    const eligible = failures.length === 0;
    if (eligible) eligibleRows += 1;
    row.verificationStatus = eligible ? 'verified' : 'unverified';
    row.sourceKind = sourceKind;
    row.normalizedSha256 = normalizedSha256; row.rawSha256 = rawSha256;
    row.authorityStatus = eligible ? 'recorded-official-retrieval-only' : 'provenance-check-failed';
    row.scholarlyVerificationStatus = 'unknown'; row.scholarlyApproval = 'none';
    row.transportVerifiedByThisProtocol = false;
    row.recordedProvenanceConsistent = eligible;
    row.comparisonEligibility = row.canCompareText ? eligible ? 'source-difference-inspection-only' : 'experimental-text-comparison-only' : 'not-eligible';
    row.provenanceChecks = { protocolVersion: PROTOCOL_VERSION, failures, normalizedHashRecomputed, rawHashVerification: row.rawHashVerification, noScholarlyCertification: true };
  }
  normalizedMetadata.verificationStatus = eligibleRows > 0 ? 'verified' : 'unverified';
  normalizedMetadata.authorityStatus = 'recorded-official-retrieval-only';
  normalizedMetadata.rightsStatus = 'provider-policy-use-only';
  normalizedMetadata.verificationNote = 'روابط وبصمات ومواضع جلب رسمي مسجلة ومتسقة؛ لم تصادق هذه الوظيفة على الاتصال أو هوية المترجم أو طبعة الناشر أو صحة المعنى.';
  normalizedMetadata.trustSummary = { eligibleRows, ineligibleRows: checkedRows.length - eligibleRows, partial: eligibleRows > 0 && eligibleRows < checkedRows.length };
  return result(eligibleRows > 0);
}
