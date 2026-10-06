/**
 * Injected-defect benchmark for the Mihakk RULE engine (src/batch-engine.mjs).
 *
 * ALL DATA IS SYNTHETIC AND NONRELIGIOUS: ordinary English sentences about
 * libraries, workshops and forms. No Quran text or translation is used. Only
 * the numeric verse-ID index (ayah counts) from src/quran-index.mjs is used to
 * build valid row identifiers.
 *
 * Deterministic: seeded PRNG (mulberry32), no network, no clock in output.
 * Run from project/:  node scripts/benchmark-injected.mjs   (prints JSON)
 *
 * What it measures: for each injected defect type, whether the rule engine
 * emits a finding with a relevant code on the injected row/verse, plus false
 * alarms on untouched rows, compared with a naive spreadsheet-style baseline.
 * It does NOT measure semantic accuracy, AI models, reviewer time, or any
 * religious correctness.
 */
import { auditBatch, BATCH_SCHEMA_VERSION } from '../src/batch-engine.mjs';
import { SURAH_AYAH_COUNTS } from '../src/quran-index.mjs';

const SEED = 20261005;
const N_PER_TYPE = 10;
const SCOPE = { type: 'selected', surahs: [18, 19, 20] };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- synthetic nonreligious sentence templates ----------
const SLOTS = {
  place: ['library', 'museum', 'workshop', 'garage', 'bakery', 'post office', 'sports hall', 'print shop', 'school canteen', 'bike shop'],
  day: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  hour: ['noon', 'six in the evening', 'nine in the morning', 'midnight', 'four in the afternoon'],
  item: ['spare keys', 'paper forms', 'folding chairs', 'paint cans', 'printer cartridges', 'umbrellas', 'cleaning cloths'],
  room: ['back room', 'basement', 'storage closet', 'upper shelf', 'side office', 'garden shed'],
  group: ['visitors', 'staff members', 'drivers', 'students', 'volunteers', 'tenants'],
  doc: ['visitor log', 'delivery sheet', 'safety form', 'rental form', 'loan register'],
};
const NUM_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

// Each template: base text; light/moderate harmless paraphrases; optional
// defect variants. {x} placeholders are filled from slots.
const TEMPLATES = [
  { id: 'NEG1', text: 'The {place} does not open on {day} before {hour}.',
    light: 'The {place} is not open on {day} before {hour}.',
    moderate: 'On {day}, nobody can enter the {place} until {hour}.',
    negRemoved: 'The {place} does open on {day} before {hour}.' },
  { id: 'NEG2', text: 'The {item} are not stored in the {room} after {hour}.',
    light: 'The {item} are not kept in the {room} after {hour}.',
    moderate: 'After {hour}, nobody leaves the {item} inside the {room}.',
    negRemoved: 'The {item} are stored in the {room} after {hour}.' },
  { id: 'AFF1', text: 'The {place} opens on {day} and closes at {hour}.',
    light: 'The {place} opens on {day} and shuts at {hour}.',
    moderate: 'Every {day} the {place} welcomes people until it shuts at {hour}.',
    negAdded: 'The {place} does not open on {day} and closes at {hour}.' },
  { id: 'AFF2', text: 'The {group} return the {item} to the {room} every {day}.',
    light: 'The {group} bring the {item} back to the {room} every {day}.',
    moderate: 'Each {day}, the {item} go back into the {room}, carried by the {group}.',
    negAdded: 'The {group} do not return the {item} to the {room} every {day}.' },
  { id: 'Q_ALL', text: 'All {group} sign the {doc} at the front desk on {day}.',
    light: 'All {group} sign the {doc} at the reception desk on {day}.',
    moderate: 'On {day}, every one of the {group} puts a signature on the {doc} at reception.',
    subst: 'Some {group} sign the {doc} at the front desk on {day}.', substKind: 'all->some' },
  { id: 'Q_ALWAYS', text: 'The {group} always lock the {room} on {day} evenings.',
    light: 'The {group} always secure the {room} on {day} evenings.',
    moderate: 'Every {day} evening, the {room} is locked by the {group} without exception.',
    subst: 'The {group} never lock the {room} on {day} evenings.', substKind: 'always->never (negation-list word)' },
  { id: 'Q_PERMIT', text: 'The {group} are permitted to use the {room} on {day}.',
    light: 'The {group} are allowed to use the {room} on {day}.',
    moderate: 'Using the {room} on {day} is something the {group} may do.',
    subst: 'The {group} are forbidden to use the {room} on {day}.', substKind: 'permitted->forbidden' },
  { id: 'Q_MUST', text: 'The {group} must sign the {doc} on {day}.',
    light: 'The {group} have to sign the {doc} on {day}.',
    moderate: 'Signing the {doc} on {day} is required of the {group}.',
    subst: 'The {group} may sign the {doc} on {day}.', substKind: 'must->may' },
  { id: 'Q_BEFORE', text: 'The {group} collect the {item} before {hour} on {day}.',
    light: 'The {group} pick up the {item} before {hour} on {day}.',
    moderate: 'On {day}, the {item} are picked up by the {group} ahead of {hour}.',
    subst: 'The {group} collect the {item} after {hour} on {day}.', substKind: 'before->after' },
  { id: 'NUMW', text: 'The {place} keeps {num} {item} in the {room}.',
    light: 'The {place} stores {num} {item} in the {room}.',
    moderate: 'In the {room} of the {place} there are {num} {item}.',
    numChanged: 'The {place} keeps {numOther} {item} in the {room}.' },
  { id: 'NUMD', text: 'The {doc} has {n} pages and one cover sheet.',
    light: 'The {doc} contains {n} pages and one cover sheet.',
    moderate: 'There are {n} pages plus a single cover sheet in the {doc}.',
    numChanged: 'The {doc} has {nOther} pages and one cover sheet.' },
];

function fill(template, slots) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in slots)) throw new Error(`Missing slot ${key}`);
    return slots[key];
  });
}

function buildBase(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const rows = [];
  let i = 0;
  for (const surah of SCOPE.surahs) {
    for (let ayah = 1; ayah <= SURAH_AYAH_COUNTS[surah - 1]; ayah += 1) {
      const template = TEMPLATES[i % TEMPLATES.length]; // balanced families
      i += 1;
      const numIndex = 1 + Math.floor(rand() * (NUM_WORDS.length - 1));
      const n = 10 + Math.floor(rand() * 80);
      const slots = {
        place: pick(SLOTS.place), day: pick(SLOTS.day), hour: pick(SLOTS.hour), item: pick(SLOTS.item),
        room: pick(SLOTS.room), group: pick(SLOTS.group), doc: pick(SLOTS.doc),
        num: NUM_WORDS[numIndex], numOther: NUM_WORDS[numIndex - 1], n: String(n), nOther: String(n - 1),
      };
      rows.push({ surah, ayah, verseId: `${surah}:${ayah}`, template, slots, translation: fill(template.text, slots) });
    }
  }
  return rows;
}

// ---------- injections ----------
const STRUCTURAL = new Set(['missing_row', 'duplicate_verse_id', 'out_of_order', 'invalid_verse_id', 'empty_translation', 'merged_two_verses']);
const DEFECTS = [
  { type: 'missing_row', relevant: ['missing_verses'] },
  { type: 'duplicate_verse_id', relevant: ['duplicate_verse'] },
  { type: 'out_of_order', relevant: ['out_of_order'] },
  { type: 'invalid_verse_id', relevant: ['invalid_verse_id'] },
  { type: 'empty_translation', relevant: ['empty_translation'] },
  { type: 'merged_two_verses', relevant: ['suspected_merged_range'] },
  { type: 'negation_removed', field: 'negRemoved', relevant: ['potential_negation_change', 'lexical_difference'] },
  { type: 'negation_added', field: 'negAdded', relevant: ['potential_negation_change', 'lexical_difference'] },
  { type: 'word_substitution_into_negation_word', field: 'subst', filter: (t) => t.id === 'Q_ALWAYS', relevant: ['potential_negation_change', 'lexical_difference'] },
  { type: 'critical_word_substitution', field: 'subst', filter: (t) => t.id !== 'Q_ALWAYS', relevant: ['potential_negation_change', 'lexical_difference'] },
  { type: 'number_changed', field: 'numChanged', relevant: ['potential_negation_change', 'lexical_difference'] },
  { type: 'harmless_paraphrase_light', field: 'light', harmless: true, relevant: ['potential_negation_change', 'lexical_difference'] },
  { type: 'harmless_paraphrase_moderate', field: 'moderate', harmless: true, relevant: ['potential_negation_change', 'lexical_difference'] },
];

function choosePositions(rand, eligible, n, total, base) {
  // Distinct, non-adjacent positions (gap >= 3), never first/last row.
  // Stratified: rotate across template families so every sub-kind is sampled.
  const pool = eligible.filter((index) => index > 1 && index < total - 2);
  const groups = new Map();
  for (const index of pool) {
    const id = base[index].template.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(index);
  }
  const groupIds = [...groups.keys()];
  const chosen = [];
  const guard = new Set();
  let attempts = 0;
  while (chosen.length < n && attempts < 100000) {
    attempts += 1;
    const group = groups.get(groupIds[chosen.length % groupIds.length]);
    const index = group[Math.floor(rand() * group.length)];
    if (guard.has(index)) continue;
    chosen.push(index);
    for (let d = -3; d <= 3; d += 1) guard.add(index + d);
  }
  return chosen.sort((a, b) => a - b);
}

function cloneRows(base) { return base.map((row) => ({ surah: row.surah, ayah: row.ayah, translation: row.translation, _base: row })); }

function inject(defect, base, rand) {
  const total = base.length;
  const eligible = base.map((row, index) => ({ row, index }))
    .filter(({ row }) => !defect.field || (row.template[defect.field] && (!defect.filter || defect.filter(row.template))))
    .map(({ index }) => index);
  const positions = choosePositions(rand, eligible, N_PER_TYPE, total, base);
  const rows = cloneRows(base);
  const injections = positions.map((index) => ({ index, verseId: base[index].verseId, affectedVerseIds: [base[index].verseId] }));
  const t = defect.type;
  // Apply from the end so earlier indices stay valid.
  for (const inj of [...injections].reverse()) {
    const i = inj.index;
    const b = base[i];
    if (t === 'missing_row') { rows.splice(i, 1); inj.detail = 'row deleted'; }
    else if (t === 'duplicate_verse_id') { rows.splice(i + 1, 0, { ...rows[i], _dup: true }); inj.detail = 'exact copy inserted after row'; }
    else if (t === 'out_of_order') {
      [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
      inj.affectedVerseIds.push(base[i + 1].verseId); inj.detail = `swapped with ${base[i + 1].verseId}`;
    } else if (t === 'invalid_verse_id') { rows[i] = { ...rows[i], surah: 115, _invalid: true }; inj.detail = `surah ${b.surah}->115 (typo)`; inj.invalidRow = true; }
    else if (t === 'empty_translation') { rows[i] = { ...rows[i], translation: '' }; inj.detail = 'translation emptied'; }
    else if (t === 'merged_two_verses') {
      const next = base[i + 1];
      rows.splice(i, 2, { surah: b.surah, ayah: `${b.ayah}-${next.ayah}`, translation: `${b.translation} ${next.translation}`, _merged: true, _base: b });
      inj.affectedVerseIds.push(next.verseId); inj.detail = `${b.verseId} + ${next.verseId} merged into ayah "${b.ayah}-${next.ayah}"`;
    } else {
      const text = fill(b.template[defect.field], b.slots);
      rows[i] = { ...rows[i], translation: text };
      inj.detail = `${b.template.id}${b.template.substKind && defect.field === 'subst' ? ` (${b.template.substKind})` : ''}`;
      inj.subKind = defect.field === 'subst' ? b.template.substKind : b.template.id;
      inj.reference = b.translation; inj.candidate = text;
    }
  }
  // Tag injected rows (for row-number based matching) and number rows like a CSV (header = row 1).
  const finalRows = rows.map((row, index) => ({ ...row, rowNumber: index + 2 }));
  for (const inj of injections) {
    inj.rowNumbers = finalRows.filter((row) => row._base && inj.affectedVerseIds.includes(row._base.verseId)).map((row) => row.rowNumber);
  }
  return { rows: finalRows, injections };
}

const METADATA = {
  candidate: { name: 'SYNTHETIC benchmark candidate (nonreligious English)', language: 'en', synthetic: true },
  reference: {
    title: 'SYNTHETIC benchmark reference (nonreligious English)', edition: 'benchmark-2026-10-05', language: 'en',
    sourceKind: 'synthetic-benchmark', verificationStatus: 'verified',
    licenseNote: 'Authored synthetic test data; "verified" is declared only so the engine runs its normal compared path. Not a religious source.',
  },
};

function strip(rows) { return rows.map(({ surah, ayah, translation, rowNumber }) => ({ surah, ayah, translation, rowNumber })); }

function runEngine(rows, referenceRows) {
  return auditBatch({ rows: strip(rows), referenceRows, scope: SCOPE, metadata: METADATA });
}

const ROW_CODES = new Set(['missing_verses', 'duplicate_verse', 'out_of_order', 'invalid_verse_id', 'empty_translation', 'suspected_merged_range', 'out_of_scope', 'invalid_translation_type', 'potential_negation_change', 'lexical_difference', 'ambiguous_reference']);

function findingsTouching(report, verseIds, rowNumbers) {
  return report.findings.filter((f) => ROW_CODES.has(f.code)
    && (f.verseIds.some((id) => verseIds.includes(id)) || f.rowNumbers.some((n) => rowNumbers.includes(n))));
}

// Naive spreadsheet baseline: lookup by "surah:ayah" key; flag when EXACT() differs or lookup fails.
// Variant A: candidate -> reference only (one VLOOKUP column).
// Variant B: A plus reverse lookup reference -> candidate (catches IDs absent from the candidate).
function naiveBaseline(rows, referenceRows) {
  const ref = new Map(referenceRows.map((r) => [`${r.surah}:${r.ayah}`, r.translation]));
  const candKeys = new Set(rows.map((r) => `${r.surah}:${r.ayah}`));
  const flaggedRows = new Set();
  for (const r of rows) {
    const key = `${r.surah}:${r.ayah}`;
    if (!ref.has(key) || ref.get(key) !== r.translation) flaggedRows.add(r.rowNumber);
  }
  const missingKeys = [...ref.keys()].filter((key) => !candKeys.has(key));
  return { flaggedRows, missingKeys };
}

function evaluate(defect, base, rand, referenceRows) {
  const { rows, injections } = inject(defect, base, rand);
  const report = runEngine(rows, referenceRows);
  const naive = naiveBaseline(rows, referenceRows);
  const codeCounts = {};
  let detected = 0; let naiveA = 0; let naiveB = 0; let anyFinding = 0;
  const cases = injections.map((inj) => {
    const touching = findingsTouching(report, inj.affectedVerseIds, inj.rowNumbers);
    const codes = [...new Set(touching.map((f) => f.code))].sort();
    for (const code of codes) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
    const hit = codes.some((code) => defect.relevant.includes(code));
    if (hit) detected += 1;
    if (codes.length) anyFinding += 1;
    const nA = inj.rowNumbers.some((n) => naive.flaggedRows.has(n));
    const nB = nA || inj.affectedVerseIds.some((id) => naive.missingKeys.includes(id));
    if (nA) naiveA += 1; if (nB) naiveB += 1;
    const statuses = rows.filter((row) => inj.rowNumbers.includes(row.rowNumber))
      .map((row) => report.rows.find((r) => r.rowNumber === row.rowNumber)?.status);
    return { verseId: inj.verseId, detail: inj.detail, subKind: inj.subKind, ...(inj.reference ? { reference: inj.reference, candidate: inj.candidate } : {}),
      engineCodes: codes, engineDetected: hit, rowStatuses: statuses, naiveA: nA, naiveB: nB };
  });
  // False alarms: row-level findings / needs_review rows outside every injection's affected IDs and rows.
  const affectedIds = new Set(injections.flatMap((inj) => inj.affectedVerseIds));
  const affectedRowNumbers = new Set(injections.flatMap((inj) => inj.rowNumbers));
  const untouched = report.rows.filter((r) => !affectedRowNumbers.has(r.rowNumber) && !(r.verseId && affectedIds.has(r.verseId)));
  const falseAlarmRows = untouched.filter((r) => r.status === 'needs_review').map((r) => r.verseId ?? `row ${r.rowNumber}`);
  const falseAlarmFindings = report.findings.filter((f) => ROW_CODES.has(f.code)
    && !f.verseIds.some((id) => affectedIds.has(id)) && !f.rowNumbers.some((n) => affectedRowNumbers.has(n))).map((f) => f.code);
  const naiveNoise = untouched.filter((r) => naive.flaggedRows.has(r.rowNumber)).length;
  const subKindBreakdown = {};
  for (const c of cases) if (c.subKind) {
    const s = (subKindBreakdown[c.subKind] ??= { injected: 0, engineFlagged: 0 });
    s.injected += 1; if (defect.harmless ? c.engineCodes.length : c.engineDetected) s.engineFlagged += 1;
  }
  const n = injections.length;
  return {
    type: defect.type, structural: STRUCTURAL.has(defect.type), harmless: Boolean(defect.harmless),
    relevantCodes: defect.relevant, injected: n,
    engine: defect.harmless
      ? { flagged: anyFinding, flagRate: Number((anyFinding / n).toFixed(3)), codesFired: codeCounts }
      : { detected, recall: Number((detected / n).toFixed(3)), codesFired: codeCounts },
    naiveBaseline: defect.harmless
      ? { flaggedA: naiveA, flaggedB: naiveB }
      : { detectedA: naiveA, detectedB: naiveB },
    untouchedRows: untouched.length,
    engineFalseAlarmRows: falseAlarmRows.length, engineFalseAlarmFindingCodes: falseAlarmFindings,
    naiveNoiseOnUntouchedRows: naiveNoise,
    summaryCounts: { totalRows: report.summary.totalRows, needsReviewRows: report.summary.needsReviewRows, noSignalRows: report.summary.noSignalRows, abstainRows: report.summary.abstainRows },
    ...(Object.keys(subKindBreakdown).length ? { subKindBreakdown } : {}),
    cases,
  };
}

function main() {
  const rand = mulberry32(SEED);
  const base = buildBase(rand);
  const referenceRows = base.map((row, index) => ({ surah: row.surah, ayah: row.ayah, translation: row.translation, rowNumber: index + 2 }));

  // 1) Clean run: candidate identical to reference.
  const cleanRows = cloneRows(base).map((row, index) => ({ ...row, rowNumber: index + 2 }));
  const clean = runEngine(cleanRows, referenceRows);
  const cleanRowCodes = clean.findings.filter((f) => ROW_CODES.has(f.code)).map((f) => f.code);
  const cleanResult = {
    totalRows: clean.summary.totalRows, expectedVerses: clean.summary.expectedVerses,
    needsReviewRows: clean.summary.needsReviewRows, noSignalRows: clean.summary.noSignalRows, abstainRows: clean.summary.abstainRows,
    rowLevelFindings: cleanRowCodes.length, allFindingCodes: clean.findings.map((f) => f.code),
  };

  // 2) One separate run per defect type (no interference between types).
  const results = DEFECTS.map((defect) => evaluate(defect, base, rand, referenceRows));

  // 3) Whole-file paraphrase runs with NO defects: a different translator
  // rarely matches the reference word for word. Measures noise of each method.
  const wholeFileParaphrase = ['light', 'moderate'].map((level) => {
    const rows = base.map((row, index) => ({ surah: row.surah, ayah: row.ayah, translation: fill(row.template[level], row.slots), rowNumber: index + 2 }));
    const report = runEngine(rows, referenceRows);
    const naive = naiveBaseline(rows, referenceRows);
    const codes = {};
    for (const f of report.findings) if (ROW_CODES.has(f.code)) codes[f.code] = (codes[f.code] ?? 0) + 1;
    return { level, rows: rows.length, defectsInjected: 0,
      engineNeedsReviewRows: report.summary.needsReviewRows, engineNoSignalRows: report.summary.noSignalRows, engineCodes: codes,
      naiveFlaggedRows: naive.flaggedRows.size };
  });

  const output = {
    benchmark: 'mihakk-injected-defects',
    dataset: 'SYNTHETIC nonreligious English sentences authored for this benchmark; NOT Quran text, NOT translations of Quran meanings',
    engine: 'src/batch-engine.mjs (rules only; no AI model executed)', schemaVersion: BATCH_SCHEMA_VERSION,
    seed: SEED, nPerType: N_PER_TYPE, scope: SCOPE, scopeRows: base.length,
    templateFamilies: TEMPLATES.map((t) => t.id),
    detectionRule: 'A defect counts as detected when the engine emits a finding whose code is in relevantCodes and which references an affected verse ID or row number. Each type is injected in its own run of the full scope file.',
    falseAlarmRule: 'Untouched rows = rows not affected by any injection in that run; a false alarm is an untouched row with status needs_review.',
    naiveBaselineRule: 'A: per candidate row, look up reference by surah:ayah; flag if lookup fails or EXACT text differs. B: A plus reverse lookup of every reference ID absent from the candidate file.',
    referenceDeclaration: METADATA.reference,
    cleanRun: cleanResult,
    wholeFileParaphrase,
    results,
    totals: {
      engineFalseAlarmRowsAcrossRuns: results.reduce((s, r) => s + r.engineFalseAlarmRows, 0),
      untouchedRowsAcrossRuns: results.reduce((s, r) => s + r.untouchedRows, 0),
      naiveNoiseAcrossRuns: results.reduce((s, r) => s + r.naiveNoiseOnUntouchedRows, 0),
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
