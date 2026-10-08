import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createReferenceClient, isLiveRetrievalResult } from "../public/modules/reference-api.mjs";

const book = { id: 1947, title: "Saheeh International", language: "en" };
const timestamp = "2026-10-03T14:00:00.000Z";
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function clientWith(fetchImpl, extra = {}) {
  return createReferenceClient({ fetchImpl, cryptoImpl: webcrypto, now: () => new Date(timestamp), delay: async () => {}, ...extra });
}

test("official book listing normalizes titles and filters other languages/invalid IDs", async () => {
  let request;
  const client = clientWith(async (url, options) => {
    request = { url, options };
    return jsonResponse([
      { id: 1947, name: "Full title", short_name: "<b>Saheeh</b>", language: { code: "en" }, card: "A &amp; B" },
      { id: 1947, name: "Duplicate", language: { code: "en" } },
      { id: 1949, name: "French", language: { code: "fr" } },
      { id: "../../evil", name: "Invalid", language: { code: "en" } }
    ]);
  });
  const books = await client.listReferenceBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].title, "Saheeh");
  assert.equal(books[0].description, "A & B");
  assert.equal(request.url, "https://api.quranpedia.net/v1/translation-books/en");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.body, undefined);
  await assert.rejects(client.listReferenceBooks("../en"), { code: "INVALID_REFERENCE_LANGUAGE" });
});

test("surah retrieval deduplicates requests, spaces them, and never transmits uploaded text", async () => {
  const requests = [];
  const waits = [];
  const progress = [];
  const client = clientWith(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse([{ ayah_number: 1, translation_text: "(1) A reference text." }]);
  }, { delay: async (ms) => waits.push(ms) });
  const result = await client.fetchReferenceForRows({ book, rows: [{ surah: 1, ayah: 1, rowNumber: 3, translation: "PRIVATE ORIGINAL" }, { surah: 1, ayah: 1, rowNumber: 4 }, { surah: 112, ayah: 1, rowNumber: 8 }], onProgress: (value) => progress.push(value) });
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [550]);
  assert.equal(requests[0].url, "https://api.quranpedia.net/v1/translation/1947/1");
  assert.equal(requests[1].url, "https://api.quranpedia.net/v1/translation/1947/112");
  assert.ok(requests.every((request) => !request.url.includes("PRIVATE") && request.options.body === undefined));
  assert.equal(result.rows.length,2); // Source records are unique, even when the candidate is duplicated.
  assert.deepEqual(result.rows.map((row) => row.rowNumber), [1,1]);
  assert.ok(result.rows.every((row) => row.sha256.length === 64 && row.retrievalSha256.length === 64 && row.sourceURL && row.retrievedAt === timestamp));
  assert.ok(result.rows.every((row) => row.normalizedSha256 === row.sha256 && row.rawSha256 === row.retrievalSha256));
  assert.equal(result.metadata.sourceKind, "quranpedia-api");
  assert.equal(result.metadata.coverageCount, 2);
  assert.equal(result.metadata.retention, "session-memory-only");
  assert.equal(isLiveRetrievalResult(result),true);
  assert.equal(isLiveRetrievalResult(JSON.parse(JSON.stringify(result))),false);
  assert.match(result.metadata.verificationNote, /ليس اعتمادًا/);
  assert.equal(progress.at(-1).completed, 2);
});
test('redirected official requests cannot claim official transport',async()=>{const client=clientWith(async()=>({ok:true,status:200,redirected:true,url:'https://unrelated.example/fake',text:async()=>JSON.stringify([{ayah_number:1,translation_text:'Forged text'}])}));await assert.rejects(client.fetchReferenceForRows({book,rows:[{surah:112,ayah:1}]}),{code:'REFERENCE_ORIGIN_MISMATCH'});});

test("reference footnotes stay separate from verse text, preserve lexical brackets, and scripts disappear", async () => {
  const client = clientWith(async () => jsonResponse([{ ayah_number: 1, translation_text: '(1) Say &quot;One [who is]&quot;[2011]<br/><div class="foot-notes">[2011] Note &amp; explanation.</div><script>alert(1)</script>' }]));
  const result = await client.fetchReferenceForRows({ book, rows: [{ surah: 112, ayah: 1 }] });
  assert.equal(result.rows[0].translation, 'Say "One [who is]"');
  assert.deepEqual(result.rows[0].footnotes, ["[2011] Note & explanation."]);
  assert.notEqual(result.rows[0].sha256, result.rows[0].retrievalSha256);
});

test('reference normalization preserves attached number and unit superscripts without retaining note anchors', async () => {
  const cases = [
    ['10<sup>5</sup> samples remain.', '10^5 samples remain.', 1, 0],
    ['The area is 50 m<sup>2</sup> wide.', 'The area is 50 m^2 wide.', 1, 0],
    ['The area is 50 <b>m</b><sup>2</sup> wide.', 'The area is 50 m^2 wide.', 1, 0],
    ['10<span><sup>5</sup></span> samples remain.', '10^5 samples remain.', 1, 0],
    ['10<sup><a href="#fn5">5</a></sup> samples remain.', '10 samples remain.', 0, 1],
    ['10<a href="#note5"><sup>5</sup></a> samples remain.', '10 samples remain.', 0, 1],
    ['50 m<sup role="doc-noteref">2</sup> wide.', '50 m wide.', 0, 1],
    ['The room<sup>2</sup> is open.', 'The room is open.', 0, 1],
    ['10 <sup>5</sup> samples remain.', '10 samples remain.', 0, 1],
    ['10<br/><sup>5</sup> samples remain.', '10 samples remain.', 0, 1],
    ['10<span><br/></span><sup>5</sup> samples remain.', '10 samples remain.', 0, 1],
    ['50 m<sup>(2)</sup> wide.', '50 m wide.', 0, 1],
  ];
  for (const [raw, expected, powers, notes] of cases) {
    const client = clientWith(async () => jsonResponse([{ ayah_number: 1, translation_text: raw }]));
    const {rows: [row]} = await client.fetchReferenceForRows({book, rows: [{surah:112, ayah:1}]});
    assert.equal(row.translation, expected, raw);
    assert.equal(row.normalization.quantitySuperscriptsPreserved ?? 0, powers, raw);
    assert.equal(row.normalization.noteAnchorsRemoved, notes, raw);
    assert.notEqual(row.rawSha256, row.normalizedSha256, raw);
  }
});

test("invalid rows fail before any external request", async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return jsonResponse([]); });
  await assert.rejects(client.fetchReferenceForRows({ book, rows: [{ surah: 115, ayah: 1 }] }), { code: "INVALID_REFERENCE_ROWS" });
  await assert.rejects(client.fetchReferenceForRows({ book, rows: [{ surah: true, ayah: 1 }] }), { code: "INVALID_REFERENCE_ROWS" });
  await assert.rejects(client.fetchReferenceForRows({ book: { ...book, id: "1947/112" }, rows: [{ surah: 1, ayah: 1 }] }), { code: "INVALID_REFERENCE_BOOK" });
  assert.equal(calls, 0);
});

test("missing coverage remains an explicit per-position abstention; malformed duplicates fail", async () => {
  let payload = [{ ayah_number: 1, translation_text: "Reference." }];
  const client = clientWith(async () => jsonResponse(payload));
  const missing = await client.fetchReferenceForRows({ book, rows: [{ surah: 112, ayah: 1 },{surah:112,ayah:2}] });
  assert.equal(missing.rows.length,1);
  assert.deepEqual(missing.metadata.missingRequestedIds,['112:2']);
  assert.equal(missing.metadata.partialCoverage,true);
  payload = [{ ayah_number: 1, translation_text: "A" }, { ayah_number: 1, translation_text: "B" }];
  await assert.rejects(client.fetchReferenceForRows({ book, rows: [{ surah: 112, ayah: 1 }] }), { code: "INVALID_REFERENCE_RESPONSE" });
  payload = { text: "Unsupported shape" };
  await assert.rejects(client.fetchReferenceForRows({ book, rows: [{ surah: 112, ayah: 1 }] }), { code: "INVALID_REFERENCE_RESPONSE" });
});

test('book identity comes from the provider while an absent edition stays unknown', async () => {
  const client=clientWith(async()=>jsonResponse({id:1947,name:'Full book title',language:{code:'en'},author:{ar_name:'Named institution'},translator:null,nasher:'Publisher',edition:'',publish_year:null}));
  const details=await client.fetchReferenceBookMetadata(book);
  assert.equal(details.author,'Named institution');
  assert.equal(details.translator,null);
  assert.equal(details.publisher,'Publisher');
  assert.match(details.edition,/غير معلنة/);
  assert.equal(details.bibliographicSha256.length,64);
  await assert.rejects(client.fetchReferenceBookMetadata({...book,id:20}),{code:'INVALID_REFERENCE_RESPONSE'});
});

test('one invalid candidate ID does not block reference retrieval for valid rows',async()=>{
  const result=await clientWith(async()=>jsonResponse([{ayah_number:1,translation_text:'Text.'}])).fetchReferenceForRows({book,rows:[{surah:115,ayah:1},{surah:112,ayah:5},{surah:112,ayah:1}]});
  assert.equal(result.rows.length,1);
  assert.equal(result.metadata.skippedRows.length,2);
  assert.equal(result.metadata.coverageCount,1);
});

test("429 retries honor a short Retry-After and remain bounded", async () => {
  let calls = 0;
  const waits = [];
  const client = clientWith(async () => {
    calls += 1;
    return calls < 3 ? jsonResponse({}, 429, { "retry-after": "2" }) : jsonResponse([{ ayah_number: 1, translation_text: "A" }]);
  }, { delay: async (ms) => waits.push(ms) });
  await client.fetchReferenceForRows({ book, rows: [{ surah: 112, ayah: 1 }] });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
  const limited = clientWith(async () => jsonResponse({}, 429, { "retry-after": "60" }));
  await assert.rejects(limited.listReferenceBooks(), { code: "REFERENCE_RATE_LIMIT" });
});

test("HTTP, JSON and network failures report unavailable provenance", async () => {
  await assert.rejects(clientWith(async () => jsonResponse({}, 503)).listReferenceBooks(), { code: "REFERENCE_UNAVAILABLE" });
  await assert.rejects(clientWith(async () => new Response("not JSON")).listReferenceBooks(), { code: "INVALID_REFERENCE_RESPONSE" });
  await assert.rejects(clientWith(async () => { throw new TypeError("network error"); }).listReferenceBooks(), { code: "REFERENCE_UNAVAILABLE" });
});

test("cancellation stops before fetch and during in-flight fetch", async () => {
  const first = new AbortController();
  first.abort();
  let calls = 0;
  await assert.rejects(clientWith(async () => { calls += 1; return jsonResponse([]); }).fetchReferenceForRows({ book, rows: [{ surah: 1, ayah: 1 }], signal: first.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = clientWith(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))).fetchReferenceForRows({ book, rows: [{ surah: 1, ayah: 1 }], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("per-request timeout aborts stalled retrieval", async () => {
  const client = clientWith(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })), { timeoutMs: 10 });
  await assert.rejects(client.listReferenceBooks(), { code: "REFERENCE_TIMEOUT" });
});
