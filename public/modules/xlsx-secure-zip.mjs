// XLSX preflight and verified streaming decompression. Never give the vendor
// inflater unverified bytes or trust a ZIP header as the actual output length.
export const XLSX_ZIP_LIMITS = Object.freeze({entries: 2000, entryBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, ratio: 2000});
const invalid = () => { throw new Error('ملف XLSX ليس أرشيف Excel صالحًا أو يحتوي أحجامًا غير متسقة. أعد حفظه بصيغة XLSX في Excel أو LibreOffice.'); };
const unsupported = () => { throw new Error('أرشيف XLSX من نوع ZIP64 أو مشفّر غير مدعوم لحدود الأمان. أعد حفظه بصيغة XLSX في Excel أو LibreOffice.'); };
const budgetError = () => { throw new Error('ملف Excel المضغوط أكبر من حدود الأمان بعد فك الضغط.'); };
function limitsWith(overrides = {}) {
  return Object.fromEntries(Object.entries(XLSX_ZIP_LIMITS).map(([key, value]) => {
    const limit = overrides[key] ?? value;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > value) throw new Error('حدود فحص Excel غير صالحة.');
    return [key, limit];
  }));
}

export function inspectZipEntries(buffer, overrides) {
  const limits = limitsWith(overrides), bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const bounds = (offset, length, limit = bytes.length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= limit;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) invalid();
  const disk = view.getUint16(end + 4, true), directoryDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true), entries = view.getUint16(end + 10, true);
  const directoryBytes = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true);
  if (disk || directoryDisk || entries === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) unsupported();
  if (!entries || diskEntries !== entries || !bounds(directoryOffset, directoryBytes, end) || directoryOffset + directoryBytes !== end) invalid();
  if (entries > limits.entries) budgetError();
  function checkExtras(offset, length) {
    const limit = offset + length;
    while (offset < limit) {
      if (!bounds(offset, 4, limit)) invalid();
      const id = view.getUint16(offset, true), size = view.getUint16(offset + 2, true);
      if (!bounds(offset + 4, size, limit)) invalid();
      if (id === 1) unsupported();
      offset += 4 + size;
    }
  }
  let total = 0, cursor = directoryOffset;
  const ranges = [], result = [], names = new Set();
  for (let index = 0; index < entries; index++) {
    if (!bounds(cursor, 46, end) || view.getUint32(cursor, true) !== 0x02014b50) invalid();
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true), raw = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if ((flags & 0x2041) || compressed === 0xffffffff || raw === 0xffffffff || localOffset === 0xffffffff || view.getUint16(cursor + 34, true)) unsupported();
    if (!nameLength || ![0, 8].includes(method) || !bounds(cursor, 46 + nameLength + extra + comment, end)) invalid();
    checkExtras(cursor + 46 + nameLength, extra);
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    let name;
    try { name = new TextDecoder('utf-8', {fatal: true}).decode(nameBytes); } catch { invalid(); }
    if (!name || /[\\\u0000]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) invalid();
    names.add(name);
    total += raw;
    if (total > limits.totalBytes || raw > limits.entryBytes || (compressed && raw / compressed > limits.ratio)) budgetError();
    if (!bounds(localOffset, 30, directoryOffset) || view.getUint32(localOffset, true) !== 0x04034b50) invalid();
    const localFlags = view.getUint16(localOffset + 6, true), localMethod = view.getUint16(localOffset + 8, true);
    const localCRC = view.getUint32(localOffset + 14, true), localCompressed = view.getUint32(localOffset + 18, true), localRaw = view.getUint32(localOffset + 22, true);
    const localName = view.getUint16(localOffset + 26, true), localExtra = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localName + localExtra;
    if (localFlags !== flags || localMethod !== method || localName !== nameLength || !bounds(localOffset, 30 + localName + localExtra, directoryOffset)) invalid();
    checkExtras(localOffset + 30 + localName, localExtra);
    for (let i = 0; i < nameLength; i++) if (bytes[localOffset + 30 + i] !== nameBytes[i]) invalid();
    // A descriptor may legally leave zero local fields. This is safe here:
    // the bounded native stream validates actual length and CRC before rebuild.
    const matches = (local, central) => local === central || ((flags & 8) && local === 0);
    if (!matches(localCompressed, compressed) || !matches(localRaw, raw) || !matches(localCRC, crc) || !bounds(dataOffset, compressed, directoryOffset)) invalid();
    if (method === 0 && compressed !== raw) invalid();
    if (method === 8 && (!compressed || (!raw && (compressed !== 2 || bytes[dataOffset] !== 3 || bytes[dataOffset + 1] !== 0)))) invalid();
    let dataEnd = dataOffset + compressed;
    if (flags & 8) {
      const descriptor = dataEnd + (bounds(dataEnd, 4, directoryOffset) && view.getUint32(dataEnd, true) === 0x08074b50 ? 4 : 0);
      if (!bounds(descriptor, 12, directoryOffset) || view.getUint32(descriptor, true) !== crc || view.getUint32(descriptor + 4, true) !== compressed || view.getUint32(descriptor + 8, true) !== raw) invalid();
      dataEnd = descriptor + 12;
    }
    ranges.push([localOffset, dataEnd]);
    result.push({name, nameBytes, flags, method, crc, compressed, raw, dataOffset});
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) invalid();
  return {entries: result, totalBytes: total, limits};
}

export function validateZipBudget(buffer, limits) { inspectZipEntries(buffer, limits); }

const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function updateCRC(crc, bytes) { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; }
export function crc32(bytes) { return (updateCRC(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }

export async function verifiedStoredZip(buffer, options = {}) {
  const {entries, limits} = inspectZipEntries(buffer, options.limits), bytes = new Uint8Array(buffer);
  const start = performance.now(), timeoutMs = options.timeoutMs ?? 30000;
  let actualTotal = 0;
  const check = () => {
    if (options.signal?.aborted) throw new DOMException('أُلغي استيراد Excel.', 'AbortError');
    if (performance.now() - start > timeoutMs) throw new DOMException('استغرق استيراد Excel أكثر من المهلة المسموحة.', 'TimeoutError');
  };
  const verified = [];
  for (let index = 0; index < entries.length; index++) {
    check();
    const entry = entries[index], payload = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
    let content, length = 0, crc = 0xffffffff;
    if (entry.method === 0) {
      content = payload;
      for (let offset = 0; offset < payload.length; offset += 65536) { check(); crc = updateCRC(crc, payload.subarray(offset, offset + 65536)); }
      length = content.length;
    } else {
      let decompressor;
      try { decompressor = new DecompressionStream('deflate-raw'); }
      catch { throw new Error('المتصفح لا يدعم فك Excel الآمن. استخدم متصفحًا حديثًا أو احفظ الورقة بصيغة CSV UTF-8.'); }
      // Small input writes bound the native decompressor's work per write;
      // do not feed an entire compressed entry in one transform operation.
      let inputOffset = 0;
      const input = new ReadableStream({pull(controller) {
        check();
        if (inputOffset === payload.length) { controller.close(); return; }
        const end = Math.min(payload.length, inputOffset + 256);
        controller.enqueue(payload.subarray(inputOffset, end)); inputOffset = end;
      }});
      const reader = input.pipeThrough(decompressor).getReader();
      content = new Uint8Array(entry.raw);
      try {
        for (;;) {
          check();
          const {done, value} = await reader.read();
          if (done) break;
          if (length + value.length > entry.raw || length + value.length > limits.entryBytes || actualTotal + length + value.length > limits.totalBytes) budgetError();
          content.set(value, length); length += value.length; crc = updateCRC(crc, value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        if (error.name === 'AbortError' || error.name === 'TimeoutError' || /حدود الأمان/.test(error.message)) throw error;
        throw new Error('بيانات الضغط داخل XLSX غير مكتملة أو غير صالحة. أعد حفظ الملف بصيغة XLSX.');
      } finally { reader.releaseLock(); }
    }
    check();
    if (length !== entry.raw) throw new Error('حجم بيانات XLSX الفعلي لا يطابق الحجم المعلن؛ رُفض الملف دون قبول خرج مقتطع.');
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error('فشل تحقق CRC32 لبيانات XLSX؛ الملف تالف أو غير متسق.');
    actualTotal += length;
    if (actualTotal > limits.totalBytes) budgetError();
    verified.push({...entry, content});
    options.onProgress?.({phase: 'decompressing', completed: index + 1, total: entries.length, message: 'التحقق من محتويات Excel وفك الضغط بحدود آمنة'});
  }
  check();
  // A new archive with method=stored and verified sizes/CRCs removes the vendor
  // library's own Deflate path. No source text is altered.
  const total = verified.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.content.length + 46 + e.nameBytes.length, 22);
  const output = new Uint8Array(total), view = new DataView(output.buffer);
  let offset = 0;
  for (const e of verified) {
    check(); e.localOffset = offset;
    view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 0x800, true);
    view.setUint32(offset + 14, e.crc, true); view.setUint32(offset + 18, e.content.length, true); view.setUint32(offset + 22, e.content.length, true); view.setUint16(offset + 26, e.nameBytes.length, true);
    output.set(e.nameBytes, offset + 30); output.set(e.content, offset + 30 + e.nameBytes.length);
    offset += 30 + e.nameBytes.length + e.content.length;
  }
  const directoryOffset = offset;
  for (const e of verified) {
    check(); view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true); view.setUint16(offset + 8, 0x800, true);
    view.setUint32(offset + 16, e.crc, true); view.setUint32(offset + 20, e.content.length, true); view.setUint32(offset + 24, e.content.length, true); view.setUint16(offset + 28, e.nameBytes.length, true); view.setUint32(offset + 42, e.localOffset, true);
    output.set(e.nameBytes, offset + 46); offset += 46 + e.nameBytes.length;
  }
  view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, verified.length, true); view.setUint16(offset + 10, verified.length, true); view.setUint32(offset + 12, offset - directoryOffset, true); view.setUint32(offset + 16, directoryOffset, true);
  return output.buffer;
}
