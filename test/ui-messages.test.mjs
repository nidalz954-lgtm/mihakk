import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  languageName, languageLimitsNotice, findingTitleOverride, normalizeSearchText, findingSearchText, rowlessFindingsText,
  displayFileName, withoutFinalStop, stopMessage, unverifiedEmbeddingNote, checklistStatusWord, missingVersePreview,
  nonTextCellNote, referenceDefects, referenceDefectLines,
} from '../public/modules/ui-helpers.mjs';
import { QURAN_DISPLAY, QURAN_LOAD_TIMEOUT_MS, loadQuranText } from '../public/modules/quran-text.mjs';
import { strictInteger, isValidVerseId } from '../src/quran-index.mjs';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

// ---- BUG-02 (UI side): the language-limits line --------------------------------------------------

test('BUG-02: a French run with limited rows explains which checks did not run and that the rows are abstentions, not "no signal"', () => {
  const notice = languageLimitsNotice({ language: 'fr', negationChecked: false, quantifierChecked: false, writtenNumbersChecked: false, digitsChecked: true, rowsLimited: 3 });
  assert.ok(notice);
  assert.equal(notice.rows, 3);
  for (const part of ['النفي', 'الكمّ والإلزام', 'الأعداد المكتوبة بالحروف', '«الفرنسية»', 'امتنا', 'ليست «لا إشارة»', 'الأرقام الرقمية']) assert.ok(notice.long.includes(part), part);
  assert.match(notice.short, /3 صفوف|٣ صفوف/);
  assert.match(notice.short, /«الفرنسية»/);
  assert.match(notice.short, /امتناع/);
});

test('BUG-02: only the checks that really did not run are named, and old or empty reports render nothing', () => {
  const arabic = languageLimitsNotice({ language: 'ar', negationChecked: true, quantifierChecked: false, writtenNumbersChecked: true, digitsChecked: true, rowsLimited: 1 });
  assert.match(arabic.long, /الكمّ والإلزام/);
  assert.doesNotMatch(arabic.long, /النفي|الأعداد المكتوبة/);
  assert.equal(languageLimitsNotice(undefined), null);
  assert.equal(languageLimitsNotice(null), null);
  assert.equal(languageLimitsNotice({}), null);
  assert.equal(languageLimitsNotice({ language: 'fr', rowsLimited: 0 }), null);
  assert.equal(languageLimitsNotice({ language: 'fr', rowsLimited: -4 }), null);
  assert.equal(languageName('fr'), 'الفرنسية');
  assert.equal(languageName('pt-BR'), 'pt');
  assert.equal(languageName('unknown'), 'غير معروفة');
});

test('BUG-02: app.js renders the language line in the results sentence and in #report-context, and labels the finding code', () => {
  assert.match(app, /languageLimitsNotice\(summary\.languageLimits\)/);
  assert.match(app, /append\(\$\('report-context'\),'p',limits\.long,'context-note warning'\)/);
  assert.match(app, /\$\{limitsShort\(summary\)\}/);
  assert.match(app, /language_checks_limited:'[^']+'/);
});

// ---- BUG-04: the "uncalibrated, not an accuracy figure" caption --------------------------------------

test('BUG-04: the uncalibrated-probability caption is printed for every model table, including uploaded references', () => {
  const body = app.slice(app.indexOf('function renderModelEvidence'), app.indexOf('function updateDecisionButtons'));
  // A statement of its own, directly after the table and outside the experimental-reference ternary.
  assert.match(body, /\n    append\(block,'p','الاحتمالات إشارات غير معايرة وليست نسبة دقة','evidence-note'\);\n/);
  assert.ok(body.indexOf('الاحتمالات إشارات غير معايرة وليست نسبة دقة') > body.indexOf("'model-scores'"));
  assert.ok(body.indexOf('الاحتمالات إشارات غير معايرة وليست نسبة دقة') < body.indexOf('result.experimentalUnverifiedReference?'));
  assert.match(body, /result\.experimentalUnverifiedReference\?'المقارنة تجريبية مع ملف قدّمه المستخدم/);
});

// ---- BUG-12: screen readers ------------------------------------------------------------------------

test('BUG-12: the finding row button is named by its content, and the saved decision carries a spoken prefix', () => {
  const rowCode = app.slice(app.indexOf('function renderFindings'), app.indexOf('function quoteBox'));
  assert.doesNotMatch(rowCode, /item\.setAttribute\('aria-label'/);
  assert.match(rowCode, /decision\.prepend\(srOnly\('القرار المحفوظ: '\)\)/);
  assert.match(css, /\.sr-only\{position:absolute!important/);
});

// ---- BUG-20: search ----------------------------------------------------------------------------------

test('BUG-20: search finds an invalid-surah case by number, "سورة N", surah:ayah, row number, visible title and location', () => {
  const invalid = { id: 'f1', code: 'invalid_verse_id', type: 'structural', message: 'رقم السورة أو الآية غير صالح وفق ترقيم العد الكوفي المحدد.', verseIds: [], rowNumbers: [7], spans: [], evidence: { surah: 115, ayah: 1 } };
  const text = findingSearchText(invalid, { title: 'رقم سورة أو آية غير صالح', location: 'سورة 115' });
  for (const query of ['115', 'سورة 115', '115:1', 'صف 7', '7', 'رقم سورة أو آية غير صالح', 'invalid_verse_id']) assert.ok(text.includes(normalizeSearchText(query)), query);
  assert.ok(!text.includes(normalizeSearchText('999')));
});

test('BUG-20: the visible title with its shadda and Arabic-Indic digits in the query still match', () => {
  const duplicate = { id: 'f2', code: 'duplicate_verse', type: 'structural', message: 'تكرر معرّف الآية في أكثر من صف.', verseIds: ['2:5'], rowNumbers: [4, 9], spans: [], evidence: { verseId: '2:5' } };
  const text = findingSearchText(duplicate, { title: 'تكرار معرّف آية', location: '2:5' });
  assert.ok(text.includes(normalizeSearchText('تكرار معرف آية')));
  assert.ok(text.includes(normalizeSearchText('٢:٥')));
  assert.ok(text.includes(normalizeSearchText('صف ٩')));
  assert.ok(text.includes('سورة 2'));
});

test('BUG-20: a spans text keeps working and app.js uses the shared helper with a per-finding cache', () => {
  const finding = { code: 'lexical_difference', message: 'm', verseIds: ['1:1'], rowNumbers: [1], spans: [{ text: 'merciful' }], evidence: {} };
  assert.ok(findingSearchText(finding, { title: 't', location: '1:1' }).includes('merciful'));
  assert.match(app, /const matchesQuery=!query\|\|searchTextOf\(f\)\.includes\(query\)/);
  assert.match(app, /normalizeSearchText\(\$\('findings-search'\)\.value\.trim\(\)\)/);
});

// ---- BUG-21: the results sentence -------------------------------------------------------------------

test('BUG-21: missing positions and row-less structural findings are stated next to "0 rows need follow-up"', () => {
  const summary = { missingVerses: 6194 };
  const findings = [{ type: 'structural', code: 'missing_verses', rowNumbers: [] }, { type: 'evidence', code: 'reference_integrity', rowNumbers: [] }, { type: 'structural', code: 'invalid_verse_id', rowNumbers: [3] }];
  const text = rowlessFindingsText(summary, findings);
  assert.match(text, /^ · /);
  assert.match(text, /6.?194 موضعًا ناقصًا/);
  assert.match(text, /آيات لا صف لها/);
  assert.match(text, /خلل في صفوف الملف المرفوع للمرجع/);
  assert.equal(rowlessFindingsText({ missingVerses: 0 }, [{ type: 'structural', code: 'invalid_verse_id', rowNumbers: [3] }]), '');
  assert.match(rowlessFindingsText({ missingVerses: 2 }, []), /موضعان ناقصان/);
  assert.match(rowlessFindingsText({}, [{ type: 'structural', code: 'x', rowNumbers: [] }]), /حالة بنيوية بلا صف/);
  assert.match(app, /\$\{rowlessFindingsText\(summary,report\.findings\)\}/);
});

// ---- BUG-28: embedding mode with an uploaded reference ----------------------------------------------------

test('BUG-28: the embedding note gives the true reason (user-declared, unverified reference), not the reference language', () => {
  const note = unverifiedEmbeddingNote();
  assert.match(note, /قدّمها المستخدم/);
  assert.match(note, /غير موثّقة/);
  assert.match(note, /لا يُجري نموذج التشابه أي مقارنة/);
  assert.doesNotMatch(note, /لغة المرجع/);
  assert.match(app, /aiMode==='embedding'&&referenceMode==='upload'&&!state\.demo\?`لم يُشغَّل نموذج التشابه: \$\{unverifiedEmbeddingNote\(\)\}/);
  assert.match(app, /\$\('ai-mode'\)\.value==='embedding'&&\$\('reference-mode'\)\.value==='upload'&&!state\.demo\?` \$\{unverifiedEmbeddingNote\(\)\}`/);
});

// ---- BUG-29: neutral titles --------------------------------------------------------------------------------

test('BUG-29: titles no longer contradict the case body', () => {
  assert.equal(findingTitleOverride({ code: 'reference_coverage', evidence: { languagesDiffer: true } }), 'امتنعت المقارنة النصية كلها: لغة المرجع المعلنة لا تطابق لغة الترجمة');
  assert.equal(findingTitleOverride({ code: 'reference_coverage', evidence: { unverifiedRows: 5 } }), 'مواضع لم تكتمل مقارنتها بالمرجع');
  assert.equal(findingTitleOverride({ code: 'reference_coverage', evidence: { ambiguousRows: 1 } }), 'مواضع لم تكتمل مقارنتها بالمرجع');
  assert.equal(findingTitleOverride({ code: 'reference_coverage', evidence: { missingRows: 4 } }), null);
  assert.equal(findingTitleOverride({ code: 'lexical_difference' }), null);
  assert.equal(findingTitleOverride(undefined), null);
  const labels = app.match(/const labels = \{[^\n]*\};/)[0];
  assert.match(labels, /non_text_translation:/, 'the old key stays for old reports');
  assert.match(app, /Object\.assign\(labels,\{context_language_mismatch:'امتناع قبل النموذج بسبب كتابة النص'/);
  assert.match(app, /invalid_translation_type:'قيمة ترجمة غير نصية'/);
  assert.doesNotMatch(app.replace(labels, ''), /امتناع قبل النموذج الإنجليزي/);
  assert.match(app, /زوج امتنع قبل النموذج بسبب كتابة النص/);
});

test('BUG-29: a non-text cell is described as the wrong type, not as empty', () => {
  assert.match(nonTextCellNote('number'), /ليست نصًا/);
  assert.match(nonTextCellNote('number'), /«رقم»/);
  assert.match(nonTextCellNote('boolean'), /«قيمة منطقية»/);
  assert.doesNotMatch(nonTextCellNote('number'), /فارغ/);
  assert.match(app, /function candidateEmptyNote\(row\)/);
});

// ---- BUG-30: raw offending value and defective reference rows --------------------------------------------

test('BUG-30: defective uploaded reference rows are named with their row numbers and raw values', () => {
  const rows = [
    { rowNumber: 1, surah: '1', ayah: '1', translation: 'a' },
    { rowNumber: 2, surah: '1', ayah: '2-3', translation: 'b' },
    { rowNumber: 3, surah: '1', ayah: '4', translation: '   ' },
    { rowNumber: 4, surah: '1', ayah: '5', translation: 'c' },
    { rowNumber: 5, surah: '1', ayah: '5', translation: 'd' },
    { rowNumber: 6, surah: '115', ayah: '1', translation: 'e' },
  ];
  const defects = referenceDefects(rows, { strict: strictInteger, isValid: isValidVerseId });
  assert.deepEqual(defects.invalid.map((item) => item.rowNumber), [2, 6]);
  assert.equal(defects.invalid[0].ayah, '2-3');
  assert.deepEqual(defects.empty, [{ rowNumber: 3, verseId: '1:4' }]);
  assert.deepEqual(defects.duplicates, [{ verseId: '1:5', rowNumbers: [4, 5] }]);
  const lines = referenceDefectLines(defects);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /صف 2 \(سورة «1»، آية «2-3»\)/);
  assert.match(lines[1], /صف 3 \(1:4\)/);
  assert.match(lines[2], /1:5 في الصفوف 4 و5/);
  assert.deepEqual(referenceDefects(rows), { invalid: [], empty: [], duplicates: [] }, 'no validators, no claims');
  const many = Array.from({ length: 12 }, (_, index) => ({ rowNumber: index + 1, surah: 'x', ayah: 'y', translation: 't' }));
  assert.match(referenceDefectLines(referenceDefects(many, { strict: strictInteger, isValid: isValidVerseId }))[0], /، و4 أخرى/);
});

test('BUG-30: app.js shows the raw uploaded id for rows without a valid id and the hint says the whole text comparison abstains', () => {
  assert.match(app, /\$\{row\.verseId\|\|rawIdLabel\(row\)\}/);
  assert.match(app, /function rawIdLabel\(row\)/);
  assert.match(app, /referenceIntegrityLines\(block,finding\)/);
  assert.match(html, /امتنعت المقارنة النصية كلها \(الأرقام والنفي والكلمات المؤثرة والفرق اللفظي\)/);
});

// ---- BUG-31: stop and failure messages ---------------------------------------------------------------------

test('BUG-31: a stop during the reference fetch with AI off never claims saved lexical or smart results', () => {
  const message = stopMessage({ referenceFailed: true, aiRequested: false, aiProcessed: 0, aiEligible: 0, lexicalCompared: 0 });
  assert.match(message, /أُوقف جلب المرجع بطلبك/);
  assert.match(message, /الفحص البنيوي وحده محفوظ/);
  assert.doesNotMatch(message, /اللفظي/);
  assert.doesNotMatch(message, /التحليل الذكي/);
});

test('BUG-31: the stop sentence follows the real state and never says "0 of 0"', () => {
  assert.match(stopMessage({ referenceFailed: true, aiRequested: true }), /فلم يبدأ التحليل الذكي/);
  const none = stopMessage({ aiRequested: true, aiProcessed: 0, aiEligible: 0, lexicalCompared: 12 });
  assert.match(none, /قبل اكتمال أي مقارنة بالنموذج/);
  assert.match(none, /المقارنة اللفظية محفوظة/);
  assert.doesNotMatch(none, /0 من 0|٠ من ٠/);
  const partial = stopMessage({ aiRequested: true, aiProcessed: 3, aiEligible: 8, lexicalCompared: 8 });
  assert.match(partial, /بعد 3 من 8 مقارنة بالنموذج/);
  assert.match(partial, /حُفظت المقارنات المكتملة/);
  assert.match(stopMessage({}), /أُوقفت العملية بطلبك/);
});

test('BUG-31: trailing full stops are removed so a joined sentence never ends with two', () => {
  assert.equal(withoutFinalStop('أُلغي التحليل الذكي؛ نتائج الفحص البنيوي محفوظة.'), 'أُلغي التحليل الذكي؛ نتائج الفحص البنيوي محفوظة');
  assert.equal(withoutFinalStop('abort. . '), 'abort');
  assert.equal(withoutFinalStop(undefined), '');
  assert.doesNotMatch(`تعذّر استكمال النموذج: ${withoutFinalStop('انتهت مهلة النموذج.')}. نتائج`, /\.\./);
  assert.match(app, /تعذّر استكمال النموذج: \$\{withoutFinalStop\(error\.message\)\}\./);
  assert.match(app, /state\.cancelled\?\[aiError,revisionWarning\]/);
  assert.doesNotMatch(app, /جارٍ حفظ المقارنات المكتملة بعد إيقاف العملية الإضافية/);
});

// ---- BUG-36: the mushaf text of missing verses -----------------------------------------------------------------

test('BUG-36: the first missing verses are previewed from the finding, the rest are counted', () => {
  const finding = { code: 'missing_verses', verseIds: ['4:17', '4:18', '4:19', '4:20', '4:21', '4:22', '4:23', 'bad', '4:17'] };
  const preview = missingVersePreview(finding.verseIds);
  assert.deepEqual(preview.shown, ['4:17', '4:18', '4:19', '4:20', '4:21']);
  assert.equal(preview.hiddenCount, 2);
  assert.equal(preview.total, 7);
  assert.deepEqual(missingVersePreview(['4:17']), { shown: ['4:17'], hiddenCount: 0, total: 1 });
  assert.deepEqual(missingVersePreview(undefined), { shown: [], hiddenCount: 0, total: 0 });
  assert.match(app, /if\(finding\.code==='missing_verses'\)quranMissingBox\(\$\('detail-content'\),finding\)/);
});

test('BUG-36: the missing-verse box uses the same pinned loader, display-only wording and synthetic guard as the case box', () => {
  const box = app.slice(app.indexOf('function quranMissingBox'), app.indexOf('/** Names the defective rows'));
  assert.match(box, /loadQuranText\(\)/);
  assert.match(box, /البرنامج لا يقارن الترجمة بهذا النص آليًا/);
  assert.match(box, /state\.demo\|\|state\.report\?\.provenance\?\.candidate\?\.synthetic===true/);
  assert.match(box, /للاطلاع فقط/);
  assert.doesNotMatch(box, /fetch\(/, 'no new network path');
});

// ---- BUG-41: team table words ---------------------------------------------------------------------------------

test('BUG-41: the team table stops breaking short words in the role and remove columns', () => {
  assert.match(css, /\.team-members td\{overflow-wrap:normal;word-break:normal\}/);
  assert.match(css, /\.team-members td:first-child\{overflow-wrap:anywhere\}/);
  assert.match(css, /\.team-members td:nth-child\(2\),\.team-members td:last-child\{white-space:nowrap\}/);
});

// ---- BUG-42: semantics -------------------------------------------------------------------------------------------

test('BUG-42: the results count and page label are live regions, the progress track is a progressbar, the checklist is a list', () => {
  assert.match(html, /<strong id="list-count" tabindex="-1" role="status">/);
  assert.match(html, /<span id="page-label" role="status">/);
  assert.match(html, /<div class="progress-track" id="progress-track" role="progressbar" aria-label="[^"]+" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">/);
  assert.match(html, /<div id="dossier-checklist" role="list"/);
  assert.match(app, /track\.setAttribute\('aria-valuenow'/);
  assert.match(app, /track\.setAttribute\('aria-valuetext',message\)/);
  assert.match(app, /setText\(\$\('list-count'\)/);
  assert.match(app, /setText\(\$\('page-label'\)/);
});

test('BUG-42: one alert at a time, and checklist marks have spoken state words', () => {
  const invalid = app.slice(app.indexOf('function invalid('), app.indexOf('function exportStatus'));
  assert.doesNotMatch(invalid, /setAttribute\('role','alert'\)/);
  assert.match(invalid, /#step-1 \.field-error,#step-2 \.field-error/);
  assert.match(app, /'ai-enabled':\['reference-mode','ai-mode'\]/);
  assert.match(app, /append\(row,'span',good\?'✓':check\.status==='hold'\?'!':'○'\)\.setAttribute\('aria-hidden','true'\)/);
  assert.match(app, /srOnly\(`\$\{checklistStatusWord\(check\.status\)\}: `\)/);
  assert.equal(checklistStatusWord('recorded'), 'تم');
  assert.equal(checklistStatusWord('passed'), 'تم');
  assert.equal(checklistStatusWord('hold'), 'يحتاج متابعة');
  assert.equal(checklistStatusWord('required'), 'مطلوب خارج الأداة');
  assert.equal(checklistStatusWord('limited'), 'محدود');
  assert.equal(checklistStatusWord('whatever'), 'لم يكتمل');
  assert.doesNotMatch(html, /<aside class="intake-guide"/);
  assert.match(html, /<section class="intake-guide" aria-labelledby="intake-guide-title">/);
});

// ---- BUG-43: visual accessibility -----------------------------------------------------------------------------------

test('BUG-43: highlighted words are underlined, a legend explains them, sizes are relative, digits are one system, targets are 24px', () => {
  assert.match(css, /\.quote-box mark\{text-decoration:underline/);
  assert.match(app, /node\('p',null,'mark-legend'\)/);
  assert.match(app, /الكلمات المظللة والمسطّرة هي مواضع الاختلاف/);
  assert.equal((css.match(/font-size:\s*\d+(?:\.\d+)?px/g) || []).length, 0, 'no px font sizes remain in the tool stylesheet');
  assert.match(css, /font-size:max\(\.75rem,12px\)/, 'the existing max() floor is kept');
  assert.match(css, /\.workdesk input\[type=checkbox\],dialog input\[type=checkbox\]\{width:24px;height:24px\}/);
  assert.match(html, /<h2>1\. النطاق المتوقع<\/h2>/);
  assert.match(html, /<h2>2\. المرجع المقابل<\/h2>/);
  assert.doesNotMatch(html.slice(html.indexOf('<main id="workspace"')), /<h2>[٠-٩]/);
  assert.doesNotMatch(app, /style\.fontSize='12px'/);
});

// ---- BUG-44: bidi controls in displayed names -----------------------------------------------------------------------

test('BUG-44: bidi controls are removed from displayed file names only', () => {
  const stored = 'abc‮123.xyz.csv';
  assert.equal(displayFileName(stored), 'abc123.xyz.csv');
  assert.equal(stored, 'abc‮123.xyz.csv', 'the stored name is not touched');
  assert.equal(displayFileName('a⁦b⁩c‎d‏e؜f‪g‬h'), 'abcdefgh');
  assert.equal(displayFileName('ملف الترجمة.csv'), 'ملف الترجمة.csv');
  assert.equal(displayFileName(undefined), '');
  assert.match(app, /displayFileName\(parsed\.fileName\)/);
  assert.match(app, /\$\('candidate-name'\)\.value=displayFileName\(file\.name\)/);
  assert.match(app, /displayFileName\(state\.candidate\?\.fileName\)/);
  assert.match(app, /state\.candidate=parsed;/, 'the parsed candidate keeps the original file name');
});

// ---- BUG-46: the mushaf text never loads forever ----------------------------------------------------------------------

test('BUG-46: a request that never answers ends with a timeout error, aborts the request, and can be retried', async () => {
  assert.equal(QURAN_LOAD_TIMEOUT_MS, 20000);
  let seenSignal;
  const started = Date.now();
  await assert.rejects(loadQuranText((url, options) => { seenSignal = options?.signal; return new Promise(() => {}); }, { timeoutMS: 40 }), /انتهت مهلة تحميل ملف نص المصحف \(0 ثانية\)|انتهت مهلة تحميل ملف نص المصحف/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(seenSignal?.aborted, true, 'the stalled request is aborted');
  // The failed attempt is not cached: the next call loads normally.
  const text = await readFile(new URL('../public/data/quran-hafs-quranpedia.json', import.meta.url), 'utf8');
  const quran = await loadQuranText(async () => ({ ok: true, text: async () => text }), { timeoutMS: 5000 });
  assert.ok(quran.verse(4, 17));
  assert.equal(QURAN_DISPLAY.displayOnly, true);
});

test('BUG-46: the case window offers a retry button after a failed or timed-out load', () => {
  assert.match(app, /function quranRetry\(box,load\)/);
  assert.match(app, /'إعادة المحاولة'/);
  assert.match(app, /quranRetry\(box,load\)/);
  // The pinned display-only wording of the original box is unchanged.
  assert.match(app, /البرنامج لا يقارن الترجمة بهذا النص آليًا/);
});
