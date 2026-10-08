import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { parseDelimited, rowsFromMatrix, parseTranslationFile, inspectTranslationFile, parseXML } from '../public/modules/file-parser.mjs';
import * as XLSX from '../public/vendor/xlsx-0.20.3.mjs';
import { crc32 } from '../public/modules/xlsx-secure-zip.mjs';

// File parsing fixes from the 2026-10-07 live check (BUG-08, BUG-33, BUG-34).
// Authored placeholder sentences only; they are not Quran translations.
const ARABIC_COMMA = String.fromCharCode(0x060c);
const sentence = (n) => `Authored sentence ${n}, with a comma, and another comma.`;
const parse = (text, name = 'upload.csv', options = {}) => parseTranslationFile(new File([text], name), options);
const plain = (result) => result.rows.map((row) => [row.surah, row.ayah, row.translation]);

// ---------------------------------------------------------------- BUG-08
test('BUG-08: headerless pipe files parse with quoted or unquoted commas inside the text', async () => {
  const quoted = [1, 2, 3].map((n) => `1|${n}|"${sentence(n)}"`).join('\n');
  const unquoted = [1, 2, 3].map((n) => `1|${n}|${sentence(n)}`).join('\n');
  for (const text of [quoted, unquoted]) {
    const result = await parse(text);
    assert.deepEqual(plain(result), [1, 2, 3].map((n) => ['1', String(n), sentence(n)]));
    assert.equal(result.warnings.length, 1, 'only the headerless-order warning');
  }
});

test('BUG-08: headerless semicolon and tab files parse with commas inside the text', async () => {
  for (const [delimiter, name] of [[';', 'semi.csv'], ['\t', 'tabbed.txt'], ['\t', 'tabbed.csv']]) {
    const quoted = [1, 2, 3].map((n) => `2${delimiter}${n}${delimiter}"${sentence(n)}"`).join('\n');
    assert.deepEqual(plain(await parse(quoted, name)), [1, 2, 3].map((n) => ['2', String(n), sentence(n)]));
    const bare = [1, 2, 3].map((n) => `2${delimiter}${n}${delimiter}${sentence(n)}`).join('\n');
    assert.deepEqual(plain(await parse(bare, name)), [1, 2, 3].map((n) => ['2', String(n), sentence(n)]));
  }
});

test('BUG-08: headed pipe, semicolon and tab files with commas in the text parse', async () => {
  for (const delimiter of ['|', ';', '\t']) {
    const text = [`surah${delimiter}ayah${delimiter}translation`, ...[1, 2].map((n) => `3${delimiter}${n}${delimiter}${sentence(n)}`)].join('\n');
    assert.deepEqual(plain(await parse(text)), [1, 2].map((n) => ['3', String(n), sentence(n)]));
  }
});

test('BUG-08: comma files keep working, including quoted commas, quoted pipes and quoted semicolons', async () => {
  const text = ['surah,ayah,translation', '4,1,"One; two; three | four, five"', '4,2,"Six | seven; eight, nine"', '4,3,Plain words'].join('\n');
  assert.deepEqual(plain(await parse(text)), [['4', '1', 'One; two; three | four, five'], ['4', '2', 'Six | seven; eight, nine'], ['4', '3', 'Plain words']]);
  // A single headerless row: the comma layout wins over many semicolons in the sentence.
  assert.deepEqual(plain(await parse('5,1,One; two; three; four; five')), [['5', '1', 'One; two; three; four; five']]);
});

test('BUG-08: malformed files still fail with the same messages instead of being silently re-read', () => {
  assert.throws(() => rowsFromMatrix(parseDelimited('surah,ayah,translation\n112,1,Main,LOST')), /عدد الخلايا/);
  assert.throws(() => parseDelimited('a,b\n1,a"b'), /اقتباس/);
  assert.throws(() => parseDelimited('a,b\n1,"oops'), /اقتباس/);
  // An explicit delimiter is never second-guessed, and a sample limit only shortens the read.
  assert.deepEqual(parseDelimited('a|b,c\n1|2,3', '|'), [['a', 'b,c'], ['1', '2,3']]);
  assert.equal(parseDelimited('a,b\n1,2\n3,4\n5,6', ',', 2).length, 2);
});

// ---------------------------------------------------------------- BUG-33
test('BUG-33: a header written with the Arabic comma is accepted', async () => {
  const text = [`سورة${ARABIC_COMMA}آية${ARABIC_COMMA}ترجمة`, `1${ARABIC_COMMA}1${ARABIC_COMMA}"${sentence(1)}"`, `1${ARABIC_COMMA}2${ARABIC_COMMA}Plain words`].join('\n');
  const result = await parse(text);
  assert.deepEqual(plain(result), [['1', '1', sentence(1)], ['1', '2', 'Plain words']]);
  assert.deepEqual(result.headers, ['سورة', 'آية', 'ترجمة']);
});

test('BUG-33: Arabic commas inside the text of an ordinary comma file never become the delimiter', async () => {
  const body = `بسم${ARABIC_COMMA} الله${ARABIC_COMMA} الرحمن`;
  const text = ['surah,ayah,translation', `1,1,${body}`, `1,2,${body}`].join('\n');
  assert.deepEqual(plain(await parse(text)), [['1', '1', body], ['1', '2', body]]);
  // An unrecognised layout is not guessed with the Arabic comma either.
  await assert.rejects(parse(`a${ARABIC_COMMA}b${ARABIC_COMMA}c\n1${ARABIC_COMMA}2${ARABIC_COMMA}3\n`), /الأعمدة/);
});

test('BUG-33: verse_key, verse-key and ayah_key columns are read as the composite verse id', () => {
  for (const header of ['verse_key', 'verse-key', 'Verse Key', 'ayah_key']) {
    const result = rowsFromMatrix([[header, 'translation'], ['2:255', 'Authored text one'], ['3:7', 'Authored text two']]);
    assert.deepEqual(result.rows.map((row) => [row.surah, row.ayah]), [['2', '255'], ['3', '7']]);
  }
  // Two competing id columns are still reported as ambiguous instead of guessed.
  assert.throws(() => rowsFromMatrix([['verse_id', 'verse_key', 'translation'], ['1:1', '1:1', 'x']]), /ملتبسة/);
});

test('BUG-33: blank lines before the header are skipped, reported, and keep the real file line numbers', async () => {
  const text = '\n\nsurah,ayah,translation\n1,1,Authored one\n1,2,Authored two\n';
  const result = await parse(text);
  assert.deepEqual(result.rows.map((row) => row.rowNumber), [4, 5]);
  assert.ok(result.warnings.some((warning) => /تم تجاوز 2 من الصفوف الفارغة/.test(warning)));
  const preview = await inspectTranslationFile(new File([text], 'blank-first.csv'));
  assert.deepEqual(preview.headers, ['surah', 'ayah', 'translation']);
  assert.deepEqual(preview.sample[0], ['1', '1', 'Authored one']);
  // A file of nothing but blank lines keeps its old error, and a title row before the header is still not guessed.
  await assert.rejects(parse('\n\n\n'), /الأعمدة/);
  await assert.rejects(parse('My own title\nsurah,ayah,translation\n1,1,x\n'), /الأعمدة/);
  // Errors about a later row name the real file line.
  await assert.rejects(parse('\nsurah,ayah,translation\n1,1,x\n1,2,y,z\n'), /الصف 4 /);
});

// ---------------------------------------------------------------- BUG-34
// A minimal stored (uncompressed) ZIP that passes the structural preflight but is not an Excel workbook.
function storedZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [entryName, content] of entries) {
    const name = Buffer.from(entryName), data = Buffer.from(content), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const buffer = Buffer.concat([...locals, directory, end]);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test('BUG-34: an archive the Excel reader rejects gives the Arabic message, never the raw English vendor error', async () => {
  const many = Array.from({ length: 50 }, (_, index) => [`parts/part-${index}.txt`, `Authored part ${index}`]);
  for (const entries of [[['notes.txt', 'Authored note']], many]) {
    const file = new File([storedZip(entries)], 'not-a-workbook.xlsx');
    for (const read of [() => parseTranslationFile(file), () => inspectTranslationFile(file)]) {
      await assert.rejects(read(), (error) => /ليس أرشيف Excel صالحًا/.test(error.message) && !/Unsupported ZIP/.test(error.message));
    }
  }
});

function notesFirstBook() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Notes about this file'], ['Authored remark']]), 'Notes');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['surah', 'ayah', 'translation'], [1, 1, 'Authored one']]), 'Data');
  return new File([XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true })], 'notes-first.xlsx');
}

test('BUG-34: a multi-sheet workbook whose first sheet is not recognised names that sheet and the sheet count', async () => {
  await assert.rejects(parseTranslationFile(notesFirstBook()), (error) => /لم أتعرف على الأعمدة/.test(error.message) && /2 أوراق/.test(error.message) && /«Notes»/.test(error.message));
  // Choosing the sheet works and carries no sheet warning.
  const selected = await parseTranslationFile(notesFirstBook(), { sheetName: 'Data' });
  assert.deepEqual(plain(selected), [['1', '1', 'Authored one']]);
  assert.equal(selected.warnings.length, 0);
  // A single-sheet workbook with unrecognised columns keeps the plain message.
  const single = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(single, XLSX.utils.aoa_to_sheet([['a', 'b', 'c'], [1, 1, 'x']]), 'Only');
  await assert.rejects(parseTranslationFile(new File([XLSX.write(single, { type: 'array', bookType: 'xlsx' })], 'single.xlsx')), (error) => /لم أتعرف على الأعمدة/.test(error.message) && !/أوراق/.test(error.message));
});

// Minimal DOM stand-in: the real parser needs a browser, but the surah check only needs these members.
function fakeXml(elements) {
  const make = ({ attrs = {}, text = '' }) => ({ parentElement: null, closest: () => null, getAttribute: (name) => attrs[name] ?? null, querySelector: () => null, textContent: text });
  const document = { querySelector: () => null, querySelectorAll: () => elements.map(make) };
  return class { parseFromString() { return document; } };
}

test('BUG-34: XML elements without any surah are reported once instead of failing later in silence', () => {
  const missing = parseXML('<root/>', fakeXml([{ attrs: { ayah: '1' }, text: 'Authored one' }, { attrs: { ayah: '2' }, text: 'Authored two' }]));
  assert.equal(missing.rows.length, 2);
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0], /2 من 2 عنصرًا في XML بلا رقم سورة/);
  const complete = parseXML('<root/>', fakeXml([{ attrs: { sura: '1', ayah: '1' }, text: 'Authored one' }]));
  assert.deepEqual(complete.warnings, []);
});
