import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {deflateRawSync} from 'node:zlib';
import {parseDelimited, rowsFromMatrix, parseTranslationFile, inspectTranslationFile, asciiDigits, validateZipBudget, parseXML} from '../public/modules/file-parser.mjs';
import * as XLSX from '../public/vendor/xlsx-0.20.3.mjs';
import {verifiedStoredZip, crc32, inspectZipEntries} from '../public/modules/xlsx-secure-zip.mjs';
test('quoted CSV newlines commas escaped quotation marks', () => {
  assert.deepEqual(parseDelimited('surah,ayah,translation\r\n1,1,"A, B\nC ""D"""\r\n'), [['surah','ayah','translation'],['1','1','A, B\nC "D"']]);
});
test('unclosed CSV rejected', () => assert.throws(() => parseDelimited('a,b\n1,"oops'), /اقتباس/));
test('invalid CSV closing rejected', () => assert.throws(() => parseDelimited('a,b\n1,"oops"x'), /بنية/));
test('Arabic aliases and unicode digits', () => {
  assert.deepEqual(rowsFromMatrix([['سورة','آية','ترجمة'],['١','۲','hello']]).rows[0], {surah:'1',ayah:'2',translation:'hello',rowNumber:2});
});
test('headerless pipe rows and ranges preserved', () => {
  const data = rowsFromMatrix(parseDelimited('1|1|Text\n1|2-3|Merged'));
  assert.equal(data.rows.length,2); assert.equal(data.rows[1].ayah,'2-3'); assert.equal(data.warnings.length,1);
});
test('verse id mapping', () => assert.equal(rowsFromMatrix([['verse_id','translation'],['١:٢','hello']]).rows[0].ayah,'2'));
test('a plain id column (row key) does not override separate surah and ayah columns', () => {
  const result = rowsFromMatrix([['id','sura','aya','translation','footnotes'],['101','1','1','The parcel arrived',''],['102','1','2','The door was open','']]);
  assert.deepEqual(result.rows.map(row => [row.surah, row.ayah]), [['1','1'],['1','2']]);
  assert.ok(result.warnings.some(warning => /تم تجاهل عمود المعرّف/.test(warning)));
  // An id column that really holds surah:ayah is still honoured and cross-checked.
  assert.equal(rowsFromMatrix([['id','sura','aya','translation'],['1:2','1','2','x']]).rows[0].ayah, '2');
});
test('manual separate identifiers ignore an incidental id column', () => {
  const result = rowsFromMatrix([['chapter_num','verse_num','body','id'],['1','1','The parcel arrived','123']], {surah:0,ayah:1,translation:2});
  assert.deepEqual(result.rows[0], {surah:'1',ayah:'1',translation:'The parcel arrived',rowNumber:2});
});
test('explicit composite mapping still checks conflicts with separate identifiers', () => {
  assert.throws(() => rowsFromMatrix([['chapter_num','verse_num','body','id'],['1','1','Text','2:1']], {surah:0,ayah:1,translation:2,verseId:3}), /يتعارض/);
  assert.equal(rowsFromMatrix([['body','custom_id'],['Text','1:2']], {translation:0,verseId:1}).rows[0].ayah,'2');
});
test('do not silently guess headers', () => assert.throws(() => rowsFromMatrix([['a','b','c'],['1','1','x']]), /الأعمدة/));
test('blank translation retained for audit; blank row skipped', () => assert.equal(rowsFromMatrix([['surah','ayah','translation'],['1','1',''],['','','']]).rows.length,1));
test('CSV file parsed and SHA recorded', async () => {
  const data = await parseTranslationFile(new File(['surah,ayah,translation\n1,1,Hello'], 'data.csv'));
  assert.equal(data.rows[0].translation,'Hello'); assert.match(data.sha256,/^[a-f0-9]{64}$/);
});
test('revision input preserves raw boundary spaces and combining marks',async()=>{
  const text='  اَلْمَتْحَفُ.  ';
  const parsed=await parseTranslationFile(new File([`surah,ayah,translation\n112,1,"${text}"`],'raw.csv'));
  assert.equal(parsed.rows[0].translation,text);
});
test('XLSX actual local library roundtrip', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['سورة','آية','ترجمة'],[1,1,'Hello']]), 'Translation');
  const buffer = XLSX.write(workbook, {type:'array',bookType:'xlsx'});
  const data = await parseTranslationFile(new File([buffer],'review.xlsx'));
  assert.equal(data.rows[0].translation,'Hello'); assert.deepEqual(data.sheetNames,['Translation']);
});
test('unsupported format fails', async () => assert.rejects(parseTranslationFile(new File(['x'],'bad.xlsm')), /الصيغ/));
test('XML entities rejected before parsing', () => assert.throws(() => parseXML('<!DOCTYPE x []><x/>'), /كيانات/));
test('fake zip rejected', () => assert.throws(() => validateZipBudget(new ArrayBuffer(100)), /صالح/));
test('empty file fails', async () => assert.rejects(parseTranslationFile(new File([],'empty.csv')), /غير فارغ/));
test('bad UTF8 rejected', async () => assert.rejects(parseTranslationFile(new File([new Uint8Array([255,255])],'bad.csv')), /UTF-8/));
test('both unicode digit families', () => assert.equal(asciiDigits('١٢۳۴'),'1234'));
test('surplus CSV fields must not silently discard translation words', () => assert.throws(() => rowsFromMatrix(parseDelimited('surah,ayah,translation\n112,1,Main,LOST')), /عدد الخلايا/));
test('ambiguous duplicate translation headers fail', () => assert.throws(() => rowsFromMatrix([['surah','ayah','translation','text'],['1','1','a','b']]), /ملتبسة/));
test('contradictory composite and separate verse IDs fail', () => assert.throws(() => rowsFromMatrix([['surah','ayah','verse_id','translation'],['1','1','2:1','a']]), /يتعارض/));
test('bare quotes inside unquoted cells fail', () => assert.throws(() => parseDelimited('a,b\n1,a"b'), /اقتباس/));
test('unknown columns preview then deliberate user mapping preserves content', async () => { const file=new File(['ChapterCode,VerseCode,Words\n112,1,An educational phrase'],'map.csv');const preview=await inspectTranslationFile(file);assert.deepEqual(preview.headers,['ChapterCode','VerseCode','Words']);const parsed=await parseTranslationFile(file,{mapping:{surah:0,ayah:1,translation:2}});assert.equal(parsed.rows[0].translation,'An educational phrase');});
test('numeric spreadsheet text remains numeric for structural type checks',async()=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['surah','ayah','translation'],[112,1,123]]),'Sheet');const result=await parseTranslationFile(new File([XLSX.write(book,{type:'array',bookType:'xlsx'})],'numeric.xlsx'));assert.equal(result.rows[0].translation,123);});

// Deliberately malformed headers use tiny authored payloads. A failed preflight
// must not invoke the vendor decompressor or allocate the forged oversized size.
function zipBudgetFixture({centralRaw, localRaw, descriptor = false, placeholders = false, extra = Buffer.alloc(0), method = 8, text = 'The parcel arrived.', entryName = 'xl/worksheets/sheet1.xml'} = {}) {
  const payload = Buffer.from(text), compressed = method === 8 ? deflateRawSync(payload) : payload;
  const name = Buffer.from(entryName);
  const flags = descriptor ? 8 : 0;
  const local = Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);
  const crc = crc32(payload);local.writeUInt32LE(placeholders ? 0 : crc,14);
  local.writeUInt32LE(placeholders ? 0 : compressed.length,18);local.writeUInt32LE(placeholders ? 0 : localRaw ?? payload.length,22);local.writeUInt16LE(name.length,26);
  const trailing = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
  if (descriptor) {trailing.writeUInt32LE(0x08074b50);trailing.writeUInt32LE(crc,4);trailing.writeUInt32LE(compressed.length,8);trailing.writeUInt32LE(centralRaw ?? payload.length,12);}
  const directory = Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(flags,8);directory.writeUInt16LE(method,10);
  directory.writeUInt32LE(crc,16);
  directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(centralRaw ?? payload.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt16LE(extra.length,30);
  const directoryOffset = local.length + name.length + compressed.length + trailing.length;
  const end = Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(directory.length+name.length+extra.length,12);end.writeUInt32LE(directoryOffset,16);
  const buffer = Buffer.concat([local,name,compressed,trailing,directory,name,extra,end]);
  return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);
}
test('XLSX compressed roundtrip remains accepted by structural ZIP preflight', async () => {
  const book = XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['surah','ayah','translation'],[1,1,'Compressed parcel test.']]),'Sheet');
  const bytes = XLSX.write(book,{type:'array',bookType:'xlsx',compression:true});
  const result = await parseTranslationFile(new File([bytes],'compressed.xlsx'));
  assert.equal(result.rows[0].translation,'Compressed parcel test.');
});
test('XLSX conflicting local oversized size rejected before decompression', () => {
  assert.throws(() => validateZipBudget(zipBudgetFixture({centralRaw:1,localRaw:51*1024*1024})), /غير متسقة/);
});
test('XLSX zero descriptor placeholders are accepted only after actual size and CRC verification', async () => {
  const fixture = zipBudgetFixture({descriptor:true,placeholders:true});
  assert.doesNotThrow(() => validateZipBudget(fixture));
  const stored = await verifiedStoredZip(fixture);
  assert.equal(inspectZipEntries(stored).entries[0].method,0);
  await assert.rejects(verifiedStoredZip(zipBudgetFixture({descriptor:true,placeholders:true,centralRaw:1})), /حدود الأمان/);
});
test('XLSX matching bounded sizes and signed descriptor are accepted', () => {
  assert.doesNotThrow(() => validateZipBudget(zipBudgetFixture({descriptor:true})));
});
test('XLSX ZIP64 extra override rejected even with small ordinary sizes', () => {
  const extra = Buffer.alloc(12);extra.writeUInt16LE(1);extra.writeUInt16LE(8,2);extra.writeBigUInt64LE(51n*1024n*1024n,4);
  assert.throws(() => validateZipBudget(zipBudgetFixture({extra})), /ZIP64/);
});
test('XLSX nonempty Deflate payload cannot declare zero raw size', () => {
  assert.throws(() => validateZipBudget(zipBudgetFixture({centralRaw:0,localRaw:0})), /غير متسقة/);
  assert.doesNotThrow(() => validateZipBudget(zipBudgetFixture({text:''})));
});
test('XLSX signature-shaped stored payload does not masquerade as directory', () => {
  assert.doesNotThrow(() => validateZipBudget(zipBudgetFixture({method:0,text:'Safe authored bytes PK\u0001\u0002 in a stored entry.'})));
});
test('XLSX central directory bounds and truncation rejected before vendor read', () => {
  const bytes = new Uint8Array(zipBudgetFixture()), changed = bytes.slice();
  new DataView(changed.buffer).setUint32(changed.length-6,changed.length+500,true);
  assert.throws(() => validateZipBudget(changed.buffer), /صالح/);
  assert.throws(() => validateZipBudget(bytes.slice(0,-1).buffer), /صالح/);
});

test('actual Deflate output cannot exceed a small matching declared size', async () => {
  // A 4 KiB authored string, not a large expansion archive. Both headers lie
  // consistently; streaming output verification must still reject it.
  const fixture = zipBudgetFixture({text:'a'.repeat(4096),centralRaw:16,localRaw:16});
  assert.ok(fixture.byteLength < 512);
  assert.doesNotThrow(() => validateZipBudget(fixture));
  await assert.rejects(verifiedStoredZip(fixture), /حدود الأمان/);
  await assert.rejects(parseTranslationFile(new File([fixture],'dishonest.xlsx')), /حدود الأمان/);
});
test('actual Deflate output shorter than declared is never accepted padded or truncated', async () => {
  const fixture = zipBudgetFixture({text:'Safe small text.',centralRaw:32,localRaw:32});
  await assert.rejects(verifiedStoredZip(fixture), /الفعلي.*مقتطع/);
});
test('actual entry and cumulative budgets may be lowered for safe fixture tests', async () => {
  const fixture = zipBudgetFixture({text:'a'.repeat(256)});
  await assert.rejects(verifiedStoredZip(fixture,{limits:{entryBytes:128}}), /حدود الأمان/);
  await assert.rejects(verifiedStoredZip(fixture,{limits:{totalBytes:128}}), /حدود الأمان/);
  const stored = await verifiedStoredZip(fixture,{limits:{entryBytes:256,totalBytes:256}});
  assert.equal(inspectZipEntries(stored).totalBytes,256);
  await assert.rejects(verifiedStoredZip(fixture,{limits:{entryBytes:51*1024*1024}}), /حدود.*غير صالحة/);
});
test('CRC32 checks actual stored and compressed bytes', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  for (const method of [0,8]) {
    const fixture = zipBudgetFixture({method}), view = new DataView(fixture);
    const directory = view.getUint32(fixture.byteLength-6,true);
    view.setUint32(14,0,true);view.setUint32(directory+16,0,true);
    assert.doesNotThrow(() => validateZipBudget(fixture));
    await assert.rejects(verifiedStoredZip(fixture), /CRC32/);
  }
});
test('incomplete and trailing Deflate inputs rejected by native decoder', async () => {
  for (const suffix of ['truncated','trailing']) {
    const fixture = zipBudgetFixture(), bytes = new Uint8Array(fixture), view = new DataView(fixture);
    const entry = inspectZipEntries(fixture).entries[0];
    // Keep ZIP offsets and lengths structurally intact; corrupt only the final
    // compressed byte, using an incomplete block or an early final block.
    if (suffix === 'truncated') bytes[entry.dataOffset + entry.compressed-1] = 255;
    else { bytes[entry.dataOffset] = 3; bytes[entry.dataOffset+1] = 0; }
    await assert.rejects(verifiedStoredZip(fixture), /غير مكتملة|حدود الأمان|الفعلي|CRC32/);
  }
});
function exampleBook() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['ChapterCode','VerseCode','Words'],[112,1,'  Raw phrase.  ']]),'First');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['surah','ayah','translation'],[112,2,true]]),'Second');
  return new File([XLSX.write(book,{type:'array',bookType:'xlsx',compression:true})],'two-sheets.xlsx');
}
test('real worker supports worksheet selection preview manual mapping raw spaces and boolean values', async () => {
  const file = exampleBook(), progress=[];
  const preview = await inspectTranslationFile(file,{onProgress:p=>progress.push(p)});
  assert.deepEqual(preview.sheetNames,['First','Second']);assert.deepEqual(preview.headers,['ChapterCode','VerseCode','Words']);
  assert.equal(preview.sample[0][2],'  Raw phrase.  ');
  const result = await parseTranslationFile(file,{mapping:{surah:0,ayah:1,translation:2}});
  assert.equal(result.rows[0].translation,'  Raw phrase.  ');assert.equal(result.warnings.length,1);
  const selected = await parseTranslationFile(file,{sheetName:'Second'});
  assert.equal(selected.rows[0].translation,true);assert.equal(selected.warnings.length,0);
  assert.ok(progress.some(p=>p.phase==='checking-zip'));assert.ok(progress.some(p=>p.phase==='decompressing'));assert.ok(progress.some(p=>p.phase==='reading-sheet'));
});
test('real worker cancellation rejects AbortError and never returns partial rows', async () => {
  const controller = new AbortController();let started=false;
  await assert.rejects(parseTranslationFile(exampleBook(),{signal:controller.signal,onProgress:p=>{ if(p.phase==='checking-zip'){started=true;controller.abort();} }}), {name:'AbortError'});
  assert.equal(started,true);
  const cancelled = new AbortController();cancelled.abort();
  await assert.rejects(inspectTranslationFile(exampleBook(),{signal:cancelled.signal}),{name:'AbortError'});
});
test('real worker deadline rejects TimeoutError before a late result', async () => {
  await assert.rejects(parseTranslationFile(exampleBook(),{xlsxTimeoutMs:1}),{name:'TimeoutError'});
  await assert.rejects(parseTranslationFile(exampleBook(),{xlsxTimeoutMs:120001}),/مهلة.*غير صالحة/);
});
test('safe compressed import fails closed when native decoding is unavailable', async () => {
  const saved = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    await assert.rejects(verifiedStoredZip(zipBudgetFixture()),/لا يدعم.*الآمن/);
  } finally { globalThis.DecompressionStream = saved; }
});
test('worker progress callback errors reject cleanly', async () => {
  await assert.rejects(parseTranslationFile(exampleBook(),{onProgress:()=>{throw new Error('UI observer failed');}}),/UI observer failed/);
});
test('worker enforces text and column limits before preview crosses into UI', async () => {
  for (const matrix of [
    [['surah','ayah','translation','extra'],[112,1,'Fine','x'.repeat(20001)]],
    [['surah','ayah','translation',...Array(126).fill('extra')],[112,1,'Fine',...Array(126).fill('')]],
  ]) {
    const b = XLSX.utils.book_new();XLSX.utils.book_append_sheet(b,XLSX.utils.aoa_to_sheet(matrix),'Sheet');
    const file = new File([XLSX.write(b,{type:'array',bookType:'xlsx',compression:true})],'limit.xlsx');
    await assert.rejects(inspectTranslationFile(file),/20,000 حرف|128 عمود/);
  }
});
test('unsafe archive member names rejected without extracting anything', async () => {
  for (const entryName of ['../outside.xml','/absolute.xml','xl/../outside.xml','xl\\sheet.xml','C:/drive.xml']) {
    await assert.rejects(verifiedStoredZip(zipBudgetFixture({entryName})),/صالح/);
  }
});
test('missing requested worksheet fails in real worker', async () => {
  await assert.rejects(parseTranslationFile(exampleBook(),{sheetName:'Missing'}),/ورقة.*غير موجودة/);
});
test('actual file buffer must match advertised bytes', async () => {
  await assert.rejects(parseTranslationFile({name:'tiny.csv',size:1,arrayBuffer:async()=>new ArrayBuffer(2)}),/حجم.*لا يطابق/);
});
