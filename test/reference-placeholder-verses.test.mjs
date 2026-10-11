import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createReferenceClient } from "../public/modules/reference-api.mjs";

// P2-02: a live reference verse whose whole text is a verse number or a note anchor must not abort the fetch of its surah.
// All texts are synthetic and non-religious; the verse numbers only choose which prefix pattern applies.
const book = { id: 1947, title: "Synthetic book", language: "en" };
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });
const clientWith = fetchImpl => createReferenceClient({ fetchImpl, cryptoImpl: webcrypto, now: () => new Date("2026-10-11T00:00:00.000Z"), delay: async () => {} });
const fetchSurah2 = async (items, ayahs = items.map(item => item.ayah_number)) =>
  clientWith(async () => jsonResponse(items)).fetchReferenceForRows({ book, rows: ayahs.map(ayah => ({ surah: 2, ayah })) });

test("verses that are only a number or a note anchor keep the source text and do not abort the surah", async () => {
  const items = [
    { ayah_number: 1, translation_text: "(1) A reference text." },
    { ayah_number: 2, translation_text: "2." },
    { ayah_number: 3, translation_text: "<sup>1</sup>" },
    { ayah_number: 4, translation_text: "(2:4)" },
    { ayah_number: 5, translation_text: "[2:5]" },
    { ayah_number: 6, translation_text: "(6)" },
    { ayah_number: 7, translation_text: "[1]" },
    { ayah_number: 8, translation_text: "8. <sup>1</sup>" },
    { ayah_number: 9, translation_text: "<sup>1</sup><div class=\"foot-notes\">1. A note.</div>" },
  ];
  const result = await fetchSurah2(items);
  assert.equal(result.rows.length, 9);
  const text = new Map(result.rows.map(row => [row.ayah, row]));
  assert.equal(text.get(1).translation, "A reference text.");
  assert.equal(text.get(1).normalization.versePrefixRemoved, true);
  assert.equal(text.get(1).normalization.keptUnstrippedBecauseEmpty, undefined);
  assert.equal(text.get(2).translation, "2.");
  assert.equal(text.get(3).translation, "1");
  assert.equal(text.get(4).translation, "(2:4)");
  assert.equal(text.get(5).translation, "[2:5]");
  assert.equal(text.get(6).translation, "(6)");
  assert.equal(text.get(7).translation, "[1]");
  assert.equal(text.get(8).translation, "8. 1");
  assert.equal(text.get(9).translation, "1");
  assert.deepEqual(text.get(9).footnotes, ["1. A note."]);
  for (const ayah of [2, 3, 4, 5, 6, 7, 8, 9]) {
    const row = text.get(ayah);
    assert.deepEqual(row.normalization, { versePrefixRemoved: false, noteAnchorsRemoved: 0, keptUnstrippedBecauseEmpty: true }, `verse ${ayah}`);
    assert.equal(row.sha256, row.normalizedSha256);
    assert.notEqual(row.sha256, "");
    assert.equal(row.verificationStatus, "verified");
  }
  assert.equal(result.metadata.normalization.keptUnstrippedRows, 8);
  assert.match(result.metadata.normalization.note, /عدد الآيات التي نصها رقم أو علامة حاشية فقط: 8/);
  assert.equal(result.metadata.partialCoverage, false);
  assert.deepEqual(result.metadata.missingRequestedIds, []);
});

test("a normal surah keeps the earlier normalisation record shape and the earlier metadata note", async () => {
  const result = await fetchSurah2([
    { ayah_number: 1, translation_text: "1. The clerk<sup>1</sup> opens the door." },
    { ayah_number: 2, translation_text: "(2:2) The clerk closes the window." },
    { ayah_number: 3, translation_text: "A plain verse." },
  ]);
  assert.deepEqual(result.rows.map(row => row.translation), ["The clerk opens the door.", "The clerk closes the window.", "A plain verse."]);
  assert.deepEqual(result.rows.map(row => Object.keys(row.normalization)), [
    ["versePrefixRemoved", "noteAnchorsRemoved"], ["versePrefixRemoved", "noteAnchorsRemoved"], ["versePrefixRemoved", "noteAnchorsRemoved"],
  ]);
  assert.equal("keptUnstrippedRows" in result.metadata.normalization, false);
  assert.deepEqual(Object.keys(result.metadata.normalization), ["versePrefixRows", "noteAnchorsRemoved", "note"]);
  assert.equal(result.metadata.normalization.versePrefixRows, 2);
  assert.equal(result.metadata.normalization.noteAnchorsRemoved, 1);
  assert.doesNotMatch(result.metadata.normalization.note, /رقم أو علامة حاشية فقط/);
});

test("a verse that has no text at all, or only a footnote block, is still rejected", async () => {
  for (const text of ["", "   ", "<div class=\"foot-notes\">1. Only a note.</div>", "<script>1</script>"]) {
    await assert.rejects(fetchSurah2([{ ayah_number: 1, translation_text: "(1) Fine." }, { ayah_number: 2, translation_text: text }]),
      { code: "INVALID_REFERENCE_RESPONSE" }, JSON.stringify(text));
  }
});

test("powers and units next to a number are still kept as before when a verse is only a quantity", async () => {
  const result = await fetchSurah2([{ ayah_number: 1, translation_text: "10<sup>5</sup>" }]);
  assert.equal(result.rows[0].translation, "10^5");
  assert.equal(result.rows[0].normalization.quantitySuperscriptsPreserved, 1);
  assert.equal(result.rows[0].normalization.keptUnstrippedBecauseEmpty, undefined);
});
