import {verifiedStoredZip} from './xlsx-secure-zip.mjs';

const browser = typeof globalThis.postMessage === 'function' && typeof globalThis.document === 'undefined';
const port = browser ? null : (await import('node:worker_threads')).parentPort;
if (!browser && !port) throw new Error('Excel parsing must run inside a worker.');
const send = value => browser ? globalThis.postMessage(value) : port.postMessage(value);
const receive = async ({buffer, sheetName}) => {
  try {
    send({kind: 'progress', value: {phase: 'checking-zip', completed: 0, total: 1, message: 'التحقق من بنية ملف Excel'}});
    const verified = await verifiedStoredZip(buffer, {onProgress: value => send({kind: 'progress', value})});
    send({kind: 'progress', value: {phase: 'reading-sheet', completed: 0, total: 1, message: 'قراءة ورقة Excel في عامل منفصل'}});
    const XLSX = await import('../vendor/xlsx-0.20.3.mjs');
    const workbook = XLSX.read(verified, {type: 'array', cellFormula: false, cellHTML: false, cellNF: false, sheetRows: 20002});
    const sheetNames = workbook.SheetNames;
    if (!Array.isArray(sheetNames) || !sheetNames.length) throw new Error('لا توجد ورقة Excel قابلة للقراءة.');
    const selected = sheetName ?? sheetNames[0], sheet = workbook.Sheets[selected];
    if (!sheet) throw new Error('ورقة Excel المطلوبة غير موجودة.');
    for (const ref of [sheet['!fullref'], sheet['!ref']]) {
      if (!ref) continue;
      const range = XLSX.utils.decode_range(ref);
      if (range.e.r >= 20001 || range.e.c >= 128) throw new Error('ورقة Excel تتجاوز 20,000 صف أو 128 عمودًا.');
    }
    const matrix = XLSX.utils.sheet_to_json(sheet, {header: 1, defval: '', blankrows: true});
    if (matrix.length > 20001 || matrix.some(row => row.length > 128)) throw new Error('ورقة Excel تتجاوز 20,000 صف أو 128 عمودًا.');
    // Preview also crosses the worker boundary. Enforce the text budget before
    // cloning it into the UI, including headers and unmapped columns.
    if (matrix.some(row => row.some(cell => typeof cell === 'string' && cell.length > 20000))) throw new Error('إحدى خلايا Excel طويلة جدًا (الحد 20,000 حرف).');
    send({kind: 'result', value: {matrix, sheetNames, sheetName: selected}});
  } catch (error) { send({kind: 'error', message: error.message, name: error.name}); }
};
if (browser) globalThis.onmessage = event => receive(event.data);
else port.on('message', receive);
