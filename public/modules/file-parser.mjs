// Local-only import. No translation contents are sent over the network.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_TEXT = 20000;
const normalize = value => String(value ?? '').trim().toLowerCase().replace(/[\s_\-\u0640]/g, '').replace(/[أإآ]/g, 'ا');
const aliases = {
  surah: ['surah', 'sura', 'chapter', 'chapternumber', 'surahnumber', 'سورة', 'السورة', 'رقمالسورة'],
  ayah: ['ayah', 'aya', 'verse', 'versenumber', 'ayahnumber', 'آية', 'الآية', 'رقمالآية'],
  translation: ['translation', 'text', 'translatedtext', 'translationtext', 'ترجمة', 'الترجمة', 'النص', 'نصالترجمة'],
  verseId: ['id', 'verseid', 'ayahid', 'versekey', 'ayahkey', 'معرف', 'معرفالآية'],
};
const aliasSets = Object.fromEntries(Object.entries(aliases).map(([key, values]) => [key, new Set(values.map(normalize))]));

// The Arabic comma is only ever chosen for a file that visibly has the surah/ayah/translation layout (see detectDelimiter).
const ARABIC_COMMA = '\u060C';
const DELIMITER_CANDIDATES = [',', '\t', ';', '|', ARABIC_COMMA];
const DELIMITER_SAMPLE_ROWS = 10;
const isBlankRecord = record => record.every(value => !String(value ?? '').trim());
// A first row that is recognisably a header (two or more known column roles) or a headerless "surah, ayah, text" row.
function looksLikeTableStart(cells) {
  const roles = Object.values(aliasSets).filter(set => cells.some(value => set.has(normalize(value)))).length;
  if (roles >= 2) return true;
  return cells.length >= 3 && /^\d+$/.test(asciiDigits(cells[0])) && /^[\d\u0660-\u0669\u06F0-\u06F9-]+$/.test(String(cells[1] ?? '').trim());
}
// Chooses the delimiter whose cell count is the same over the first rows, reading quotes the way the parser does.
// Header and data rows both count, so a delimiter that only occurs inside free text (commas in a sentence) is not
// consistent and loses. Ties go to a delimiter that fits a known column layout, then to the wider table, then to the
// order , tab ; | . When nothing is consistent the old first-line count decides, so malformed files fail as they did.
function detectDelimiter(text) {
  const eligible = [];
  DELIMITER_CANDIDATES.forEach((candidate, priority) => {
    let sample;
    try { sample = parseDelimited(text, candidate, 40).filter(record => !isBlankRecord(record)).slice(0, DELIMITER_SAMPLE_ROWS); }
    catch { return; }
    const width = sample[0]?.length ?? 0;
    if (width < 2 || sample.some(record => record.length !== width)) return;
    const fitsLayout = looksLikeTableStart(sample[0]);
    if (candidate === ARABIC_COMMA && !fitsLayout) return;
    eligible.push({candidate, priority, width, fitsLayout});
  });
  if (eligible.length) {
    eligible.sort((a, b) => Number(b.fitsLayout) - Number(a.fitsLayout) || b.width - a.width || a.priority - b.priority);
    return eligible[0].candidate;
  }
  const line = text.split(/\r\n|\n|\r/).find(value => value.trim()) ?? '';
  return [',', '\t', ';', '|'].sort((a, b) => line.split(b).length - line.split(a).length)[0];
}

export function parseDelimited(text, delimiter, sampleRows = Infinity) {
  text = String(text).replace(/^\uFEFF/, '');
  if (!delimiter) delimiter = detectDelimiter(text);
  const records = [];
  let record = [], field = '', quoted = false, endedQuote = false;
  const finishField = () => { record.push(field); field = ''; endedQuote = false; };
  const finishRow = () => {
    finishField();
    records.push(record); record = [];
    if (records.length > MAX_ROWS + 1) throw new Error('الملف يتجاوز الحد المسموح: 20,000 صف.');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; endedQuote = true; }
      } else field += c;
    } else if (c === '"' && !field && !endedQuote) quoted = true;
    else if (c === '"') throw new Error('علامة اقتباس داخل خلية CSV غير مقتبسة؛ احفظ الملف بصيغة CSV سليمة.');
    else if (c === delimiter) finishField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      finishRow();
      // Delimiter detection only needs the first rows; a normal parse reads everything.
      if (records.length >= sampleRows) return records;
    } else {
      if (endedQuote && !/\s/.test(c)) throw new Error('بنية CSV غير صحيحة بعد إغلاق علامات الاقتباس.');
      if (!endedQuote) field += c;
    }
    if (field.length > MAX_TEXT) throw new Error('إحدى الخلايا طويلة جدًا (الحد 20,000 حرف).');
  }
  if (quoted) throw new Error('ملف CSV يحتوي علامة اقتباس غير مغلقة.');
  if (field || record.length || endedQuote) finishRow();
  return records;
}

// Blank lines before the header row (an exported title gap, a stray newline) are skipped and counted; a file made only
// of blank rows keeps its old error.
function leadingBlankRows(matrix) {
  let count = 0;
  while (count < matrix.length && isBlankRecord(matrix[count] ?? [])) count++;
  return count === matrix.length ? 0 : count;
}

const withoutLeadingBlankRows = matrix => matrix.slice(leadingBlankRows(matrix));

export function rowsFromMatrix(matrix, mapping) {
  if (!matrix.length) throw new Error('الملف فارغ.');
  const lead = leadingBlankRows(matrix);
  if (lead) matrix = matrix.slice(lead);
  const first = matrix[0].map(value => String(value ?? '').trim());
  const indexes = {};
  for (const [key, values] of Object.entries(aliasSets)) {
    const explicit = mapping?.[key];
    // Explicit separate identifiers are authoritative. An unrelated `id` column
    // must not replace them unless the user also deliberately maps verseId.
    if (key === 'verseId' && explicit == null && mapping?.surah != null && mapping?.ayah != null) { indexes[key] = -1; continue; }
    if (explicit == null && first.filter(value => values.has(normalize(value))).length > 1) throw new Error(`عناوين أعمدة ملتبسة للحقل ${key}؛ استخدم عمودًا واحدًا واضحًا.`);
    indexes[key] = Number.isInteger(explicit) ? explicit : typeof explicit === 'string' ? first.indexOf(explicit) : first.findIndex(value => values.has(normalize(value)));
  }
  if (mapping && Object.values(indexes).some(index => index >= first.length || index < -1)) throw new Error('رقم عمود الربط خارج أعمدة الملف.');
  let offset = 1;
  const warnings = [];
  if (lead) warnings.push(`تم تجاوز ${lead} من الصفوف الفارغة قبل صف العناوين.`);
  // Auto-detected separate surah and ayah columns win over a plain `id` column (a row counter or database key)
  // unless that column really holds surah:ayah values.
  if (mapping?.verseId == null && indexes.verseId >= 0 && indexes.surah >= 0 && indexes.ayah >= 0) {
    const sample = matrix.slice(1, 51).map(row => asciiDigits(row?.[indexes.verseId] ?? '').trim()).filter(Boolean);
    if (!sample.some(value => /^\d{1,3}[:/.]\d+/.test(value))) {
      indexes.verseId = -1;
      warnings.push('تم تجاهل عمود المعرّف لأن قيمه ليست بصيغة سورة:آية، واعتُمد عمودا السورة والآية.');
    }
  }
  if (indexes.translation < 0 || (indexes.verseId < 0 && (indexes.surah < 0 || indexes.ayah < 0))) {
    // Headerless surah|ayah|translation is accepted; never silently guess column order with a header.
    if (first.length >= 3 && /^\d+$/.test(asciiDigits(first[0])) && /^[\d\u0660-\u0669\u06F0-\u06F9-]+$/.test(first[1])) {
      Object.assign(indexes, {surah: 0, ayah: 1, translation: 2, verseId: -1}); offset = 0;
      warnings.push('ملف بلا عناوين: تم تفسير الأعمدة بالترتيب سورة، آية، ترجمة.');
    } else throw new Error('لم أتعرف على الأعمدة. استخدم surah,ayah,translation أو سورة،آية،ترجمة؛ ويُقبل verse_id,translation.');
  }
  const rows = [];
  for (let i = offset; i < matrix.length; i++) {
    const item = matrix[i];
    if (item.every(value => !String(value ?? '').trim())) continue;
    if (item.length !== first.length) throw new Error(`عدد الخلايا في الصف ${i + 1 + lead} لا يطابق عناوين الأعمدة. قد يكون هناك فاصل غير مقتبس داخل النص.`);
    if (item.length > 128) throw new Error('عدد أعمدة الملف يتجاوز 128.');
    let surah = item[indexes.surah], ayah = item[indexes.ayah];
    if (indexes.verseId >= 0) {
      const id = asciiDigits(item[indexes.verseId]).trim();
      const match = id.match(/^(\d{1,3})[:/.](.+)$/);
      if (match && ((indexes.surah >= 0 && asciiDigits(surah) && asciiDigits(surah) !== match[1]) || (indexes.ayah >= 0 && asciiDigits(ayah) && asciiDigits(ayah) !== match[2]))) throw new Error(`المعرّف المركب يتعارض مع رقمي السورة والآية في الصف ${i + 1 + lead}.`);
      surah = match?.[1] ?? ''; ayah = match?.[2] ?? id;
    }
    const originalTranslation = item[indexes.translation];
    // Preserve a numeric/boolean spreadsheet value for the structural type check.
    // Revision evidence must preserve spaces, punctuation and combining marks exactly.
    const translation = originalTranslation ?? '';
    if (typeof translation === 'string' && translation.length > MAX_TEXT) throw new Error(`النص في الصف ${i + 1 + lead} يتجاوز 20,000 حرف.`);
    rows.push({surah: asciiDigits(surah), ayah: asciiDigits(ayah), translation, rowNumber: i + 1 + lead});
  }
  if (!rows.length) throw new Error('لا توجد صفوف بيانات قابلة للفحص.');
  if (rows.length > MAX_ROWS) throw new Error('الملف يتجاوز 20,000 صف.');
  return {rows, headers: offset ? first : ['surah', 'ayah', 'translation'], warnings};
}

export function asciiDigits(value) {
  return String(value ?? '').trim().replace(/[\u0660-\u0669]/g, c => String(c.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, c => String(c.charCodeAt(0) - 0x6f0));
}

export function parseXML(text, Parser = globalThis.DOMParser) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML يحتوي تعريف كيانات غير مسموح به؛ استخدم ملفًا دون DOCTYPE/ENTITY.');
  if (!Parser) throw new Error('قراءة XML تتطلب متصفحًا حديثًا.');
  const document = new Parser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('ملف XML غير صالح.');
  const elements = [...document.querySelectorAll('aya, ayah, verse')].filter(element => !element.parentElement?.closest('aya, ayah, verse'));
  if (!elements.length) throw new Error('لم أعثر على عناصر aya أو ayah أو verse في XML.');
  if (elements.length > MAX_ROWS) throw new Error('ملف XML يتجاوز 20,000 صف.');
  const matrix = [['surah', 'ayah', 'translation']];
  for (const element of elements) {
    const parent = element.closest('sura, surah, chapter');
    const surah = element.getAttribute('surah') ?? element.getAttribute('sura') ?? parent?.getAttribute('index') ?? parent?.getAttribute('id') ?? parent?.getAttribute('number') ?? element.querySelector('surah, chapter')?.textContent;
    const ayah = element.getAttribute('ayah') ?? element.getAttribute('aya') ?? element.getAttribute('number') ?? element.getAttribute('index') ?? element.getAttribute('id') ?? element.querySelector('ayah, aya, ayah_number, number')?.textContent;
    const translation = element.getAttribute('translation') ?? element.getAttribute('text') ?? element.querySelector('translation, text')?.textContent ?? element.textContent;
    matrix.push([surah, ayah, translation]);
  }
  const parsed = rowsFromMatrix(matrix);
  // A bare list of aya elements has no surah to read; say so once instead of letting every row fail later.
  const withoutSurah = parsed.rows.filter(row => !row.surah).length;
  if (withoutSurah) parsed.warnings.push(`${withoutSurah} من ${parsed.rows.length} عنصرًا في XML بلا رقم سورة (لا سمة surah ولا عنصر sura/surah/chapter يحيط بها)، فلن تُطابق أي آية. أضف رقم السورة ثم أعد الرفع.`);
  return parsed;
}

export {validateZipBudget} from './xlsx-secure-zip.mjs';

function abortImport(signal) {
  if (signal?.aborted) throw new DOMException('أُلغي استيراد الملف.', 'AbortError');
}

async function readXLSXInWorker(buffer, options) {
  abortImport(options.signal);
  const timeoutMs = options.xlsxTimeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('مهلة استيراد Excel غير صالحة.');
  let worker, nodeWorker = false;
  const url = new URL('./xlsx-worker.mjs', import.meta.url);
  if (typeof globalThis.Worker === 'function') worker = new Worker(url, {type: 'module'});
  else if (typeof process !== 'undefined' && process.versions?.node) {
    const {Worker} = await import('node:worker_threads');
    abortImport(options.signal);
    worker = new Worker(url); nodeWorker = true;
  } else throw new Error('المتصفح لا يدعم استيراد Excel في عامل منفصل. استخدم متصفحًا حديثًا أو CSV UTF-8.');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      // Terminate even when the vendor parser is synchronously busy.
      const terminated = worker.terminate();
      if (terminated?.catch) terminated.catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new DOMException('أُلغي استيراد Excel.', 'AbortError'));
    const timer = setTimeout(() => finish(new DOMException('استغرق استيراد Excel أكثر من المهلة المسموحة. جرّب ملفًا أصغر أو CSV UTF-8.', 'TimeoutError')), timeoutMs);
    const message = data => {
      if (settled) return;
      if (data.kind === 'progress') {
        // A UI progress callback cannot compromise validation or leave workers alive.
        try { options.onProgress?.(data.value); } catch (error) { finish(error); }
      } else if (data.kind === 'result') finish(null, data.value);
      else if (data.kind === 'error') { const error = new Error(data.message); error.name = data.name || 'Error'; finish(error); }
    };
    if (nodeWorker) {
      worker.on('message', message); worker.on('error', error => finish(error));
      worker.on('exit', code => { if (!settled) finish(new Error(`تعذرت قراءة Excel في العامل المنفصل (${code}).`)); });
    } else {
      worker.onmessage = event => message(event.data);
      worker.onerror = event => finish(new Error(event.message || 'تعذرت قراءة Excel في العامل المنفصل.'));
      worker.onmessageerror = () => finish(new Error('تعذر نقل نتيجة Excel من العامل المنفصل.'));
    }
    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted) { onAbort(); return; }
    try { worker.postMessage({buffer, sheetName: options.sheetName}, [buffer]); }
    catch (error) { finish(error); }
  });
}

export async function parseTranslationFile(file, options = {}) {
  if (!file || !Number.isFinite(file.size) || file.size === 0) throw new Error('اختر ملفًا غير فارغ.');
  if (file.size > MAX_FILE_BYTES) throw new Error('الحد الأقصى لحجم الملف 25 ميغابايت.');
  const format = String(file.name ?? '').split('.').pop().toLowerCase();
  if (!['csv', 'tsv', 'txt', 'xml', 'xlsx'].includes(format)) throw new Error('الصيغ المدعومة: CSV، TSV، TXT، XML، XLSX.');
  abortImport(options.signal);
  const buffer = await file.arrayBuffer();
  abortImport(options.signal);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== file.size || buffer.byteLength > MAX_FILE_BYTES) throw new Error('حجم بيانات الملف لا يطابق الحجم المعلن أو يتجاوز 25 ميغابايت.');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(c => c.toString(16).padStart(2, '0')).join('');
  abortImport(options.signal);
  let parsed, sheetNames = [];
  if (format === 'xlsx') {
    const result = await readXLSXInWorker(buffer, options);
    const {matrix, sheetName} = result;
    sheetNames = result.sheetNames;
    abortImport(options.signal);
    if (options.preview) { const shown = withoutLeadingBlankRows(matrix); return {matrix: shown, headers: shown[0] ?? [], sample: shown.slice(1,4), fileName:file.name, format, sha256, sheetNames}; }
    try { parsed = rowsFromMatrix(matrix, options.mapping); }
    catch (error) {
      // Only the first sheet is read; when its columns are not recognised, say which sheet it was and that others exist.
      if (sheetNames.length > 1 && !options.sheetName && /لم أتعرف على الأعمدة|عناوين أعمدة/.test(error.message)) {
        throw new Error(`${error.message} يحتوي الملف ${sheetNames.length} أوراق، وقد قُرئت الورقة الأولى «${sheetName}» فقط؛ إن كانت الترجمة في ورقة أخرى فانقلها إلى الورقة الأولى أو احفظها في ملف مستقل.`);
      }
      throw error;
    }
    if (sheetNames.length > 1 && !options.sheetName) parsed.warnings.push(`تمت قراءة الورقة الأولى «${sheetName}» فقط. انقل بيانات الترجمة إليها أو اختر ملفًا بورقة واحدة.`);
  } else {
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(buffer); }
    catch { throw new Error('الملف النصي ليس UTF-8. احفظه بترميز UTF-8 ثم ارفعه مجددًا.'); }
    if (format === 'xml') parsed = parseXML(text);
    else {
      const matrix = parseDelimited(text, format === 'tsv' ? '\t' : undefined);
      if (options.preview) { const shown = withoutLeadingBlankRows(matrix); return {matrix:shown,headers:shown[0]??[],sample:shown.slice(1,4),fileName:file.name,format,sha256,sheetNames}; }
      parsed = rowsFromMatrix(matrix,options.mapping);
    }
  }
  return {...parsed, fileName: file.name, format, sha256, sheetNames};
}
export const inspectTranslationFile = (file, options = {}) => parseTranslationFile(file, {...options, preview: true});
