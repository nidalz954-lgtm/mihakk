import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {answerQuestion, normalizeArabic, ENTRIES, BOUNDARIES, SUGGESTIONS, pickSaudiVoice} from '../public/modules/assistant-knowledge.mjs';

test('normalization folds hamza, ta marbuta, alef maqsura and diacritics', () => {
  assert.equal(normalizeArabic('الإِحالَة'), 'الاحاله');
  assert.equal(normalizeArabic('مُستوى؟'), 'مستوي');
});

test('everyday questions reach the right help entry, in formal and colloquial wording', () => {
  const cases = [
    ['كيف أجهّز ملفي؟', 'file-format'],
    ['شو لازم يكون بالملف من أعمدة', 'file-format'],
    ['وين بروح ملفي؟ بينبعت لسيرفر؟', 'privacy'],
    ['ماذا أختار في القرار؟', 'decisions'],
    ['شو يعني إحالة لمتخصص', 'decisions'],
    ['كيف أحفظ التقرير PDF', 'export'],
    ['ما هو ملف المتابعة؟', 'dossier'],
    ['من وين ابلش', 'start'],
    ['ما معنى النطاق؟', 'scope'],
    ['الفحص علق وبدي اوقفه', 'slow'],
    ['السلام عليكم', 'greeting'],
    ['كيف جهزوا ملفة الجمع؟', 'file-format'], // real whisper-base transcript of «كيف أجهز ملف الترجمة؟»
    ['وش أختار في القرار', 'decisions'],
    ['ابي احفظ التقرير', 'export'],
  ];
  for (const [question, id] of cases) assert.equal(answerQuestion(question).id, id, question);
});

test('requests for a verdict, ruling or translation are declined before any how-to answer', () => {
  assert.equal(answerQuestion('هل الترجمة صحيحة؟ ممكن انشر الملف').id, 'boundary-verdict');
  assert.equal(answerQuestion('هل يجوز قراءة الترجمة بدون وضوء').id, 'boundary-ruling');
  assert.equal(answerQuestion('صحح الترجمة في الملف').id, 'boundary-write');
  for (const boundary of BOUNDARIES) assert.doesNotMatch(boundary.answer, /معتمدة\b|صحيحة 100/);
});

test('unknown questions say so honestly instead of guessing', () => {
  const result = answerQuestion('ما هو سعر الذهب اليوم');
  assert.equal(result.id, 'fallback');
  assert.equal(result.matched, false);
  assert.equal(answerQuestion('   ').id, 'empty');
});

test('the current step breaks ties toward the stage the user is on', () => {
  assert.equal(answerQuestion('المرجع', {step: 2}).id, 'reference');
});

test('no answer promises certification, accuracy or publication', () => {
  for (const entry of ENTRIES) {
    assert.doesNotMatch(entry.answer, /دقة 100|مضمون|يعتمد الترجمة|شهادة اعتماد للترجمة/, entry.id);
    assert.ok(entry.keywords.length > 0, entry.id);
  }
  for (const step of [1, 2, 3, 4]) for (const question of SUGGESTIONS[step]) assert.equal(answerQuestion(question, {step}).matched, true, question);
});

test('the guide UI sends nothing over the network and the page loads it', async () => {
  for (const file of ['assistant-ui.mjs', 'local-speech.mjs']) {
    const source = await readFile(new URL(`../public/modules/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage/, file);
  }
  // The speech worker's only network use is the one-time model download, pinned to a revision.
  const worker = await readFile(new URL('../public/modules/speech-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /revision: '[0-9a-f]{40}'/);
  assert.doesNotMatch(worker, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /src="modules\/assistant-ui\.mjs"/);
  assert.match(html, /href="assistant\.css"/);
});

test('spoken answers prefer a Saudi voice, then Gulf, then any Arabic, device voices first', () => {
  const egypt = {name: 'Hoda', lang: 'ar-EG', localService: true};
  const saudiOnline = {name: 'Zariyah Online', lang: 'ar-SA', localService: false};
  const saudi = {name: 'Naayf', lang: 'ar-SA', localService: true};
  const uae = {name: 'Fatima', lang: 'ar_AE', localService: true};
  const english = {name: 'David', lang: 'en-US', localService: true};
  assert.equal(pickSaudiVoice([egypt, saudiOnline, saudi]).name, 'Naayf');
  assert.equal(pickSaudiVoice([egypt, saudiOnline]).name, 'Zariyah Online');
  assert.equal(pickSaudiVoice([english, egypt, uae]).name, 'Fatima');
  assert.equal(pickSaudiVoice([english, egypt]).name, 'Hoda');
  assert.equal(pickSaudiVoice([english]), null);
});

test('the smart employee is off in the submission build and, in the demo, loads a pinned widget only after consent', async () => {
  const {ELEVENLABS_AGENT_ID, ELEVENLABS_WIDGET_SRC} = await import('../public/modules/agent-config.mjs');
  assert.match(ELEVENLABS_AGENT_ID, /^(agent_[a-z0-9]+)?$/);
  assert.match(ELEVENLABS_WIDGET_SRC, /^https:\/\/unpkg\.com\/@elevenlabs\/convai-widget-embed@\d+\.\d+\.\d+$/);
  const ui = await readFile(new URL('../public/modules/assistant-ui.mjs', import.meta.url), 'utf8');
  // The script tag is created inside loadAgent(), which only the consent button calls.
  assert.match(ui, /yes\.addEventListener\('click', \(\) => \{ row\.remove\(\); loadAgent\(\); \}\)/);
  assert.equal((ui.match(/loadAgent\(\)/g) || []).length, 2);
  // Submission build: no agent and the strict CSP. The widget's sources exist only in DEMO_CSP.
  assert.equal(ELEVENLABS_AGENT_ID, '');
  const {CSP, DEMO_CSP} = await import('../src/static-app.mjs');
  assert.doesNotMatch(CSP, /unpkg|elevenlabs|script-src [^;]*blob:/);
  assert.match(DEMO_CSP, /script-src [^;]*blob: [^;]*https:\/\/unpkg\.com\/@elevenlabs\//); // blob: is the widget's audio worklet
  assert.match(DEMO_CSP, /connect-src [^;]*wss:\/\/\*\.elevenlabs\.io/);
});
