import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {auditBatch, generateDemoRows, generateDemoReferenceRows} from '../public/modules/batch-engine.mjs';
import {
  csvCell, searchMatches, findingSearchText, normalizeSearchText, modelFailureNotice, plainModelError, createOperationProgress,
} from '../public/modules/ui-helpers.mjs';
import {buildReviewDossier, caseProgress} from '../public/modules/dossier.mjs';
import {describeModelError} from '../public/modules/model-runtime.mjs';
import {
  fileAwareDecisionInput, applyStoredDecisions, buildDecisionStore, decisionProgressText, decisionMetricCaption, savedDecisionNotice,
  hasUnsavedDraft, runNoticeParts, stampSavedDecision, isFromDifferentFileContent, countDecisionsFromDifferentFile, decisionOrigin,
  differentFileDecisionsNote, FROM_DIFFERENT_FILE_LABEL, STORAGE_UNAVAILABLE_NOTE,
} from '../public/modules/review-state.mjs';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const hasArabic = text => /[؀-ۿ]/.test(text);

// ---- P1-01: every finding code the engine can emit has a plain Arabic title ---------------------------------------------

test('P1-01: every finding code in the engine and model modules has an Arabic title in app.js (no raw code, no English)', async () => {
  const sources = await Promise.all(['../src/batch-engine.mjs', '../public/modules/semantic-ai.mjs', '../public/modules/context-risk.mjs'].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  const codes = new Set(sources.flatMap(text => [...text.matchAll(/code:\s*'([a-z]+(?:_[a-z]+)+)'/g)].map(match => match[1])));
  codes.add('semantic_input_truncated'); codes.add('semantic_distance'); // chosen by a conditional expression in semantic-ai.mjs
  const tableText = [app.match(/const labels = \{[^\n]+\};/)?.[0], app.match(/Object\.assign\(labels,\{[^\n]+\}\);/)?.[0]].join('\n');
  const labels = Object.fromEntries([...tableText.matchAll(/([a-z]+(?:_[a-z]+)+):'([^']*)'/g)].map(match => [match[1], match[2]]));
  assert.ok(codes.size >= 20, 'the source scan found the codes');
  for (const code of codes) {
    assert.ok(labels[code], `no title for ${code}`);
    assert.ok(hasArabic(labels[code]), `title of ${code} is not Arabic`);
    assert.doesNotMatch(labels[code], /[A-Za-z]{3,}/, `title of ${code} contains English`);
  }
  // The negation-count signal, in its current (negation_comparison_abstain) and earlier (potential_negation_count_change) form.
  assert.match(labels.negation_comparison_abstain, /النفي/);
  assert.match(labels.potential_negation_count_change, /النفي/);
});

test('P1-01: a real negation-count pair gets an Arabic title and an Arabic message, and the type filter names are Arabic', () => {
  const report = auditBatch({
    rows: [{surah: 112, ayah: 1, translation: 'SYNTHETIC He did not open the gate and did not close the window.'}],
    referenceRows: [{surah: 112, ayah: 1, translation: 'SYNTHETIC He did not open the gate and closed the window.'}],
    scope: {type: 'selected', surahs: [112]},
    metadata: {candidate: {name: 'x.csv', language: 'en'}, reference: {title: 'T', sourceKind: 'user-upload', language: 'en', verificationStatus: 'unverified'}, analysisMode: 'structural-and-lexical-rules'},
  });
  const finding = report.findings.find(item => item.code === 'negation_comparison_abstain');
  assert.ok(finding, 'the pair produces the negation-count signal');
  assert.ok(hasArabic(finding.message));
  const typeLabels = app.match(/const typeLabels = \{([^}]+)\}/)[1];
  assert.match(typeLabels, new RegExp(`${finding.type}:'[^']*[\\u0600-\\u06FF]`));
});

// ---- P1-04: the CSV builder neutralises formulas behind invisible characters -------------------------------------------

test('P1-04: formulas behind invisible characters, with every marker and several characters in a row, are neutralised', () => {
  const invisible = ['؜', '͏', '᠎', 'ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '︀', '️', '\u{E0100}', '\u{E01EF}', '\u{E0001}', '\u{E0041}', '\u{E007F}',
    '\u0001', '\u0008', '\u000B', '\u001F', '\u007F', '\u0080', '\u009F', '‎', '‏', '‪', '‭', '‮', '⁦', '⁧', '⁩',
    '​', '‌', '‍', '⁠', '﻿', '­', ' ', ' ', ' ', '　', '؀', '۝', '឴', '⁡', '\u{1D173}', '̀', 'ً'];
  for (const prefix of invisible) for (const marker of ['=', '+', '-', '@', '＝', '＋', '－', '＠', '−']) for (const value of [`${prefix}${marker}1+1`, ` ${prefix}${prefix}${marker}SUM(1)`]) {
    assert.ok(csvCell(value).startsWith(`"'`), JSON.stringify(value));
  }
  for (const ordinary of ['؜نص', 'x؜=1', 'abc-1', '١٢٣', 'a,b']) assert.ok(!csvCell(ordinary).startsWith(`"'`), JSON.stringify(ordinary));
});

// ---- P1-05: language-limited rows never read as "covered" or "0 unresolved" -------------------------------------------

function frenchReport() {
  const rows = [[112, 1, 'Le chat regarde la lampe rouge.'], [112, 2, 'Le chien attend trois pommes ici.'], [112, 3, 'La voisine ne prépare pas le dîner.'], [112, 4, 'Notre professeur garde la fenêtre ouverte.']].map(([surah, ayah, translation]) => ({surah, ayah, translation}));
  const referenceRows = [[112, 1, 'Le chat regarde la lampe rouge.'], [112, 2, 'Le chien attend cinq pommes ici.'], [112, 3, 'La voisine prépare le dîner.'], [112, 4, 'Notre professeur garde la fenêtre fermée.']].map(([surah, ayah, translation]) => ({surah, ayah, translation, allowNoSignal: true, trustedSourceProvenance: true}));
  return auditBatch({rows, referenceRows, scope: {type: 'selected', surahs: [112]}, metadata: {candidate: {name: 'x.csv', language: 'fr'}, reference: {title: 'T', sourceKind: 'quranpedia-api', language: 'fr', verificationStatus: 'verified', edition: 'e', author: 'a', publisher: 'p', licenseNote: 'l'}, analysisMode: 'structural-and-lexical-rules'}});
}

test('P1-05: rows that abstained because of language limits make the coverage and decision items limited, never a plain check', () => {
  const report = frenchReport();
  assert.ok(report.summary.languageLimits.rowsLimited > 0, 'the French run has language-limited rows');
  assert.equal(caseProgress(report.findings, {}).cases, 0, 'they are not counted as cases (so a plain "0 unresolved" would be wrong)');
  const dossier = buildReviewDossier(report, {});
  const gate = id => dossier.gates.find(item => item.id === id);
  for (const id of ['source_coverage', 'case_resolution']) {
    assert.equal(gate(id).status, 'limited', id);
    assert.match(gate(id).detail, /«الفرنسية»/, id);
    assert.match(gate(id).detail, /ليس «لا إشارة»|وليس «لا إشارة»/, id);
  }
  assert.match(gate('case_resolution').detail, /لا يشمل الصفوف الممتنعة بسبب لغة الترجمة/);
  assert.equal(dossier.counts.languageLimitedRows, report.summary.languageLimits.rowsLimited);
  assert.equal(dossier.publicationAuthorized, false);
  assert.equal(dossier.certificate, false);
  assert.ok(['needs_work', 'ready_for_expert_review'].includes(dossier.status), 'the status vocabulary is unchanged');
});

test('P1-05: a limited run never softens a hold, and an English run keeps the plain items', () => {
  const english = auditBatch({rows: generateDemoRows(), referenceRows: generateDemoReferenceRows(), scope: {type: 'selected', surahs: [1, 112, 113, 114]}, metadata: {candidate: {name: 'x.csv', language: 'en', synthetic: true}, reference: {title: 'مرجع تعليمي', sourceKind: 'synthetic-teaching', language: 'en', verificationStatus: 'verified', edition: 'مثال'}, analysisMode: 'structural-and-lexical-rules'}});
  const dossier = buildReviewDossier(english, {});
  assert.notEqual(dossier.gates.find(item => item.id === 'case_resolution').status, 'limited');
  assert.equal('languageLimitedRows' in dossier.counts, false, 'no new field when there are no language limits');
  const report = frenchReport();
  report.findings.push({id: 'x', code: 'empty_translation', type: 'structural', severity: 'high', message: 'm', rowNumbers: [2], verseIds: ['112:1'], spans: [], evidence: {}});
  assert.equal(buildReviewDossier(report, {}).gates.find(item => item.id === 'case_resolution').status, 'hold');
});

test('P1-05: the results-step decision line and the metric caption say the rows are abstentions, not that nothing needs reading', () => {
  const none = caseProgress([], {});
  assert.equal(decisionProgressText(none), 'لا توجد حالات فحص (بنيوية أو مقارنة) تحتاج حسماً.', 'unchanged without language limits');
  assert.equal(decisionMetricCaption(none), 'لا حالات فحص تحتاج حسماً');
  assert.equal(decisionProgressText(none, {languageLimitedRows: 0}), decisionProgressText(none));
  const limited = decisionProgressText(none, {languageLimitedRows: 4});
  assert.match(limited, /لا يعني أن الصفوف سليمة/);
  assert.match(limited, /بسبب لغة الترجمة/);
  assert.doesNotMatch(limited, /^لا توجد حالات فحص/);
  assert.match(decisionMetricCaption(none, {languageLimitedRows: 4}), /ممتنعة بسبب اللغة/);
  const cases = caseProgress([{id: 'a', type: 'structural'}], {});
  assert.match(decisionProgressText(cases, {languageLimitedRows: 2}), /القرارات: .* غير محسومة.*لا يشمل ذلك/);
  assert.match(app, /decisionProgressText\(progress,\{languageLimitedRows:limitedRows\}\)/);
  assert.match(app, /decisionMetricCaption\(progress,\{languageLimitedRows:limitedRows\}\)/);
});

// ---- P1-06: draft, storage wording, run notice -------------------------------------------------------------------------

test('P1-06(a): a withdrawn reason is not an unsaved draft, a new choice or an edited reason still is', () => {
  const saved = {decision: 'accept', note: 'سبب'};
  assert.equal(hasUnsavedDraft({note: 'سبب', draftDecision: null, saved: null, withdrawnNote: 'سبب'}), false, 'withdrawn, nothing changed');
  assert.equal(hasUnsavedDraft({note: 'سبب', draftDecision: 'reject', saved: null, withdrawnNote: 'سبب'}), true, 'chose again');
  assert.equal(hasUnsavedDraft({note: 'سبب جديد', draftDecision: null, saved: null, withdrawnNote: 'سبب'}), true, 'edited');
  assert.equal(hasUnsavedDraft({note: 'سبب', draftDecision: null, saved: null, withdrawnNote: null}), true, 'an ordinary typed reason is a draft');
  assert.equal(hasUnsavedDraft({note: 'سبب', draftDecision: 'accept', saved}), false, 'identical to the saved decision');
  assert.equal(hasUnsavedDraft({note: '  ', draftDecision: null, saved: null}), false);
  assert.match(app, /hasUnsavedDraft\(\{note,draftDecision:state\.draftDecision,saved,withdrawnNote:state\.withdrawnNotes\[key\]\}\)/);
  assert.match(app, /state\.withdrawnNotes\[draftKey\(finding\)\]=\$\('decision-note'\)\.value\.trim\(\)/);
  assert.match(app, /ولا يُستعاد بعد إغلاقها/);
});

test('P1-06(b)(c): session-only wording whenever storage failed, and the warning clears after a later successful write (source and helper)', () => {
  assert.match(savedDecisionNotice({saved: {}, storageFailed: true}), /لهذه الجلسة فقط/);
  assert.match(savedDecisionNotice({saved: {}, storageIssue: STORAGE_UNAVAILABLE_NOTE}), /لهذه الجلسة فقط/);
  assert.equal(savedDecisionNotice({saved: {}}), 'قرارك محفوظ في هذا المتصفح.');
  assert.match(app, /if\(state\.storageIssue===STORAGE_UNAVAILABLE_NOTE\)state\.storageIssue=''/);
});

test('P1-06(d): the end-of-run notice of a stopped run keeps the storage warning and drops reference messages', () => {
  assert.deepEqual(runNoticeParts({cancelled: true, referenceError: 'r', referenceWarning: 'w', aiError: 'a', revisionWarning: 'v', storageIssue: 's'}), ['a', 'v', 's']);
  assert.deepEqual(runNoticeParts({cancelled: false, referenceError: 'r', referenceWarning: 'w', aiError: 'a', revisionWarning: 'v', storageIssue: 's'}), ['r', 'w', 'a', 'v', 's']);
  assert.deepEqual(runNoticeParts({cancelled: true}), []);
  assert.deepEqual(runNoticeParts({}), []);
});

// ---- P1-03: decisions carried to a file with different content are marked ------------------------------------------------

test('P1-03: a file-wide decision never follows a different candidate file, and a carried text decision is stamped and marked', async () => {
  const run = rows => auditBatch({rows, referenceRows: generateDemoReferenceRows(), scope: {type: 'selected', surahs: [1, 112, 113, 114]}, metadata: {candidate: {name: 'x.csv', language: 'en', synthetic: true}, reference: {title: 'مرجع تعليمي', sourceKind: 'synthetic-teaching', language: 'en', verificationStatus: 'verified', edition: 'مثال'}, analysisMode: 'structural-and-lexical-rules'}});
  const fingerprints = async (report, candidateSha) => Object.fromEntries(await Promise.all(report.findings.map(async finding => [finding.id, await sha(fileAwareDecisionInput(finding, candidateSha))])));
  const rowsA = generateDemoRows();
  const reportA = run(rowsA), shaA = await sha(JSON.stringify(rowsA));
  const missing = reportA.findings.find(finding => finding.code === 'missing_verses');
  const text = reportA.findings.find(finding => finding.code === 'potential_negation_change');
  assert.ok(missing && text);
  const fingerprintsA = await fingerprints(reportA, shaA);
  const candidateA = {fileName: 'a.csv', sha256: shaA};
  const decisions = {
    [missing.id]: stampSavedDecision({decision: 'reject', note: 'سبب النقص', savedAt: '2026-10-08T10:00:00.000Z'}, candidateA),
    [text.id]: stampSavedDecision({decision: 'accept', note: 'سبب النص', savedAt: '2026-10-08T10:00:00.000Z'}, candidateA),
  };
  const store = buildDecisionStore(decisions, fingerprintsA);
  // File B: an unrelated verse changed. The text case keeps its evidence; the file-wide case does not follow the file.
  const rowsB = generateDemoRows().map(row => row.surah === 1 && row.ayah === 1 ? {...row, translation: `${row.translation} (edited)`} : row);
  const reportB = run(rowsB), shaB = await sha(JSON.stringify(rowsB));
  assert.notEqual(shaA, shaB);
  const applied = applyStoredDecisions(store, await fingerprints(reportB, shaB));
  const idB = code => reportB.findings.find(finding => finding.code === code)?.id;
  assert.equal(applied.decisions[idB('missing_verses')], undefined, 'the missing-verses decision is bound to the exact candidate file');
  assert.equal(applied.unappliedCount, 1);
  const carried = applied.decisions[idB('potential_negation_change')];
  assert.equal(carried?.decision, 'accept', 'a text decision with identical evidence is applied by design');
  assert.equal(isFromDifferentFileContent(carried, shaB), true, 'and it is marked as made on another file content');
  assert.equal(isFromDifferentFileContent(carried, shaA), false, 'not marked on the file it was made on');
  assert.equal(countDecisionsFromDifferentFile(applied.decisions, shaB), 1);
  assert.equal(decisionOrigin(carried).fileName, 'a.csv');
  assert.match(differentFileDecisionsNote(1), /من نسخة أخرى من الملف/);
  assert.equal(differentFileDecisionsNote(0), '');
  const notice = savedDecisionNotice({saved: carried, carried: true, fileName: 'a.csv'});
  assert.ok(notice.includes(FROM_DIFFERENT_FILE_LABEL) && notice.includes('a.csv') && notice.includes('حفظ القرار'));
  assert.equal(savedDecisionNotice({saved: carried}), 'قرارك محفوظ في هذا المتصفح.', 'no mark without the carried flag');
});

test('P1-03: decisions saved before the file stamp existed, or with a malformed stamp, are never claimed to come from another file', () => {
  const old = {decision: 'accept', note: 'x', savedAt: '2026-10-07T00:00:00.000Z'};
  const goodSha = 'a'.repeat(64), otherSha = 'b'.repeat(64);
  assert.equal(isFromDifferentFileContent(old, otherSha), false);
  assert.equal(isFromDifferentFileContent({...old, candidateSha256: 'zz'}, otherSha), false);
  assert.equal(isFromDifferentFileContent({...old, candidateSha256: goodSha}, ''), false, 'unknown current file');
  assert.equal(isFromDifferentFileContent({...old, candidateSha256: goodSha}, otherSha), true);
  assert.deepEqual(stampSavedDecision({decision: 'reject', note: 'n', savedAt: 't'}, {fileName: 'f', sha256: 'bad'}), {decision: 'reject', note: 'n', savedAt: 't'}, 'no stamp without a valid hash');
  assert.equal(stampSavedDecision({decision: 'reject', note: 'n', savedAt: 't'}, {fileName: 'f'.repeat(500), sha256: goodSha}).candidateFileName.length, 200);
  assert.match(app, /stampSavedDecision\(\{decision:state\.draftDecision,note:\$\('decision-note'\)\.value\.trim\(\),savedAt:new Date\(\)\.toISOString\(\)\},state\.candidate\)/);
  assert.match(app, /decisionsFromDifferentFileContent:countDecisionsFromDifferentFile\(currentDecisions\(\),state\.candidate\?\.sha256\)/);
  assert.match(app, /badge\(FROM_DIFFERENT_FILE_LABEL,\{carried:'different-file'\}\)/);
});

// ---- P1-02: a partial or incomplete model run is never a green notice ------------------------------------------------------

test('P1-02: an incomplete run without error text, a run with fewer finished pairs than eligible ones, and a failure are all reported', () => {
  const noError = modelFailureNotice({semanticProcessedRows: 3, semanticEligibleRows: 8, execution: {completed: false}}, 'embedding');
  assert.match(noError, /لم يكتمل نموذج التشابه/);
  assert.match(noError, /حُفظت ٣ من ٨ مقارنة مكتملة|حُفظت 3 من 8 مقارنة مكتملة/);
  assert.doesNotMatch(noError, /تعذّر استكمال/);
  const fewer = modelFailureNotice({contextProcessedRows: 2, contextEligibleRows: 5, contextExecution: {completed: true}}, 'context');
  assert.match(fewer, /لم يكتمل المؤشر السياقي/);
  const flagged = modelFailureNotice({contextProcessedRows: 5, contextEligibleRows: 5, contextCompleted: false, contextExecution: {completed: true}}, 'context-multi');
  assert.match(flagged, /سجل التنفيذ يصرّح بأنه غير مكتمل/);
  const zero = modelFailureNotice({semanticProcessedRows: 0, semanticEligibleRows: 4, execution: {completed: false}}, 'embedding');
  assert.match(zero, /لم تكتمل أي مقارنة بالنموذج/);
  const failed = modelFailureNotice({semanticProcessedRows: 1, semanticEligibleRows: 4, execution: {completed: false, error: 'انقطع الاتصال أثناء تنزيل النموذج.'}}, 'embedding');
  assert.match(failed, /^تعذّر استكمال نموذج التشابه: انقطع الاتصال أثناء تنزيل النموذج\. /);
  assert.doesNotMatch(failed, /\.\./);
  // Nothing to report: complete runs, runs with no pairs, and a stop requested by the user (handled by its own sentence).
  assert.equal(modelFailureNotice({semanticProcessedRows: 4, semanticEligibleRows: 4, execution: {completed: true}}, 'embedding'), null);
  assert.equal(modelFailureNotice({semanticProcessedRows: 0, semanticEligibleRows: 0, execution: {completed: true}}, 'embedding'), null);
  assert.equal(modelFailureNotice({contextProcessedRows: 0, contextEligibleRows: 0}, 'context'), null);
  assert.equal(modelFailureNotice({semanticProcessedRows: 1, semanticEligibleRows: 4, execution: {completed: false, cancelled: true}}, 'embedding', {cancelledByUser: true}), null);
});

test('P1-02: an English runtime message never reaches the Arabic notice; the raw text is kept additively as technical details', () => {
  assert.equal(plainModelError('انقطع الاتصال'), 'انقطع الاتصال');
  assert.equal(plainModelError("Failed to construct 'Worker': Script at 'x' cannot be accessed"), 'تعذّر تشغيل النموذج في هذا المتصفح');
  assert.equal(plainModelError(undefined), 'تعذّر تشغيل النموذج في هذا المتصفح');
  const notice = modelFailureNotice({semanticProcessedRows: 0, semanticEligibleRows: 2, execution: {completed: false, error: 'RuntimeError: memory access out of bounds'}}, 'embedding');
  assert.doesNotMatch(notice, /RuntimeError|memory access/);
  assert.match(notice, /تعذّر تشغيل النموذج في هذا المتصفح/);
  assert.match(app, /report\.provenance\.analysis\.modelTechnicalDetails=raw/);
  assert.match(app, /plainModelError\(error\.message\)/);
  const worker = describeModelError(new Error('Something unforeseen'));
  assert.ok(hasArabic(worker.message) && worker.technicalDetails === 'Something unforeseen', 'the worker already separates the Arabic sentence from the raw text');
});

test('P1-02: the dossier model gate prints a failure reason with a single full stop', () => {
  const report = auditBatch({rows: generateDemoRows(), referenceRows: generateDemoReferenceRows(), scope: {type: 'selected', surahs: [1, 112, 113, 114]}, metadata: {candidate: {name: 'x.csv', language: 'en', synthetic: true}, reference: {title: 'مرجع تعليمي', sourceKind: 'synthetic-teaching', language: 'en', verificationStatus: 'verified', edition: 'مثال'}, analysisMode: 'embedding-requested'}});
  report.provenance.analysis.modelError = 'تعذّر تنزيل ملفات النموذج.';
  const gate = buildReviewDossier(report, {}).gates.find(item => item.id === 'ai_execution');
  assert.equal(gate.status, 'hold');
  assert.doesNotMatch(gate.detail, /\.\./);
  assert.match(gate.detail, /تعذّر تنزيل ملفات النموذج\. لا تعامل غياب الإشارات/);
});

// ---- P1-07: progress, messages, hints ---------------------------------------------------------------------------------------

test('P1-07: a download-then-inference event stream never moves the visible bar backwards and shows every worker message', () => {
  const source = app.match(/function aiProgress\(progress\)\{[^\n]+\}/)?.[0];
  assert.ok(source);
  const progress = createOperationProgress(), seen = [];
  const callback = new Function('showProgress', 'number', `${source};return aiProgress;`)((message, value) => seen.push({message, value: progress.next(value)}), value => String(value));
  progress.next(40); // the audit itself had already reached this point
  const stream = [
    {status: 'progress', progress: 0, message: 'جارٍ تحميل النموذج المحلي… 0 من 118 ميغابايت'},
    {status: 'progress', progress: 7.3, message: 'جارٍ تحميل النموذج المحلي… 9 من 118 ميغابايت'},
    {status: 'progress', progress: 99, message: 'انقطع الاتصال أثناء تنزيل النموذج؛ يُستأنف التنزيل من الموضع نفسه (المحاولة 1 من 3)'},
    {status: 'progress', progress: 12, message: 'جارٍ تحميل النموذج المحلي… 14 من 118 ميغابايت'},
    {status: 'progress', progress: 100, message: 'جارٍ تحميل النموذج المحلي… 118 من 118 ميغابايت'},
    {status: 'inference', done: 1, total: 8, progress: 12.5}, {status: 'inference', done: 8, total: 8, progress: 100},
    {status: 'context-inference', done: 2, total: 8, progress: 25},
  ];
  for (const event of stream) callback(event);
  callback(3); // a bare number is the oldest event shape
  assert.deepEqual(seen.slice(0, 5).map(item => item.message), stream.slice(0, 5).map(item => item.message), 'worker messages, including the resume notice, are shown as sent');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].value >= seen[i - 1].value, `bar moved back at event ${i}: ${seen[i - 1].value} -> ${seen[i].value}`);
  assert.ok(seen.every(item => item.value < 100), 'never 100% while work runs');
  assert.ok(seen[0].value >= 40, 'the first model event does not fall back below the audit stage');
});

test('P1-07: no jsDelivr in app.js or in the NLI/E5 error hints', () => {
  assert.doesNotMatch(app, /jsdelivr/i);
  for (const error of [new TypeError('Failed to fetch'), new Error('Aborted(OOM). Build with -sASSERTIONS'), new Error('failed to allocate a buffer'), new Error('x')]) {
    assert.doesNotMatch(describeModelError(error).message, /jsdelivr/i);
  }
  assert.equal(describeModelError(new Error('Aborted(OOM). Build with -sASSERTIONS')).kind, 'memory');
});

// ---- P1-08: one mushaf error line, whole-number search, no legend for blank text --------------------------------------------

test('P1-08: numbers in the search match whole numbers; ids, titles and free text keep working', () => {
  const finding = (verseIds, rowNumbers, title = '') => ({code: 'lexical_difference', message: 'رسالة', verseIds, rowNumbers, spans: [{text: 'merciful'}], evidence: {}, title});
  const text = f => findingSearchText(f, {title: f.title || 'اختلاف في الصياغة', location: f.verseIds[0] || ''});
  const matches = (f, query) => searchMatches(text(f), normalizeSearchText(query));
  const surah2 = finding(['2:3'], [5]), surah20 = finding(['20:3'], [15]), surah112 = finding(['112:3'], [11]), row1 = finding(['5:1'], [1]);
  assert.equal(matches(surah2, 'سورة 2'), true);
  assert.equal(matches(surah20, 'سورة 2'), false, 'surah 20 is not surah 2');
  assert.equal(matches(surah112, 'سورة 2'), false);
  assert.equal(matches(surah20, 'سورة 20'), true);
  assert.equal(matches(row1, 'صف 1'), true);
  assert.equal(matches(surah112, 'صف 1'), false, 'row 11 is not row 1');
  assert.equal(matches(surah20, 'صف 1'), false, 'row 15 is not row 1');
  assert.equal(matches(surah2, '2:3'), true);
  assert.equal(matches(surah112, '2:3'), false, 'verse 112:3 is not verse 2:3');
  assert.equal(matches(surah112, '112:3'), true);
  assert.equal(matches(finding(['112:30'], [11]), '112:3'), false);
  assert.equal(matches(surah2, 'سورة ٢'), true, 'Arabic-Indic digits still match');
  assert.equal(matches(surah2, 'اختلاف'), true);
  assert.equal(matches(surah2, 'merciful'), true);
  assert.equal(matches(surah2, 'lexical_difference'), true);
  assert.equal(matches(surah2, ''), true);
  assert.equal(searchMatches('abc 12 def', '12'), true);
  assert.equal(searchMatches('abc 123 def', '12'), false);
  assert.equal(searchMatches('abc 123 def', '23'), false);
  assert.equal(searchMatches('x12', '12'), true, 'a digit next to a letter is a boundary');
  assert.equal(searchMatches('112:', '112:'), true, 'a query that ends in punctuation is not forced to a boundary');
  assert.match(app, /searchMatches\(searchTextOf\(f\),query\)/);
});

test('P1-08: the missing-verse box shows one error line and one retry; the mark legend needs a visible highlighted word', () => {
  const box = app.slice(app.indexOf('function quranMissingBox'), app.indexOf('/** Names the defective rows'));
  assert.match(box, /quran-error-line/);
  assert.match(box, /for\(const item of items\)item\.verse\.hidden=true/);
  assert.doesNotMatch(box, /for\(const item of items\)\{item\.verse\.textContent=`تعذّر عرض/, 'no per-verse error text');
  assert.equal((box.match(/quranRetry\(box,load\)/g) || []).length, 1);
  assert.match(box, /box\.querySelector\('\.quran-error-line'\)\?\.remove\(\)/, 'a retry clears the line');
  assert.match(app, /\[\.\.\.\$\('detail-content'\)\.querySelectorAll\('mark'\)\]\.some\(mark=>mark\.textContent\.trim\(\)\)/);
});
