import {answerQuestion, SUGGESTIONS, pickSaudiVoice} from './assistant-knowledge.mjs';
import {ELEVENLABS_AGENT_ID, ELEVENLABS_WIDGET_SRC} from './agent-config.mjs';

/**
 * On-page guide: a floating button that opens a chat panel. Answers come from the fixed
 * knowledge base; typed questions never leave the page. Voice uses the browser's own speech
 * services, which is disclosed before the microphone is first used.
 */

const make = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = String(text); if (cls) el.className = cls; return el; };
const currentStep = () => Number(document.querySelector('.workflow li.active')?.dataset.step) || 1;
const storage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private mode: consent is asked again */ } },
};

const ACTIONS = {
  demo: {label: 'شغّل المثال التعليمي الآن', target: 'demo-button'},
  template: {label: 'نزّل نموذج CSV', target: 'download-template'},
};

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
const LOCAL_MB = 77; // whisper-base q8, see speech-worker.mjs

function buildPanel() {
  const launcher = make('button', null, 'guide-launcher');
  launcher.type = 'button';
  launcher.id = 'guide-launcher';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'guide-panel');
  launcher.innerHTML = '<span class="guide-launcher-mark" aria-hidden="true"><i></i></span><span>اسأل المرشد</span>';

  const panel = make('section', null, 'guide-panel');
  panel.id = 'guide-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'guide-title');
  panel.innerHTML = `
    <header class="guide-head">
      <span class="guide-avatar" aria-hidden="true"><i></i></span>
      <div><h2 id="guide-title">مرشد مِحَكّ</h2><p>${ELEVENLABS_AGENT_ID ? 'دليل الأداة · والموظف الذكي اختياري' : 'يجيب من دليل الأداة · بلا ذكاء اصطناعي'}</p></div>
      <button type="button" class="guide-icon" id="guide-speak" aria-pressed="false" aria-label="قراءة الأجوبة بصوت" title="قراءة الأجوبة بصوت"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="wave" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg></button>
      <button type="button" class="guide-icon" id="guide-close" aria-label="إغلاق المرشد" title="إغلاق">×</button>
    </header>
    <div class="guide-log" id="guide-log" role="log" aria-live="polite" aria-relevant="additions"></div>
    <div class="guide-suggestions" id="guide-suggestions" aria-label="أسئلة مقترحة"></div>
    <form class="guide-form" id="guide-form">
      <label class="visually-hidden" for="guide-input">اكتب سؤالك</label>
      <input id="guide-input" type="text" autocomplete="off" maxlength="300" placeholder="اكتب سؤالك هنا…" />
      <button type="button" class="guide-icon guide-mic" id="guide-mic" aria-pressed="false" aria-label="تكلّم بسؤالك" title="تكلّم بسؤالك"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg></button>
      <button type="submit" class="guide-send" aria-label="إرسال السؤال">إرسال</button>
    </form>
    <p class="guide-foot">المرشد يشرح الأداة فقط. لا يحكم على صحة ترجمة ولا يفتي.</p>`;
  document.body.append(launcher, panel);
  return {launcher, panel};
}

export function createGuide() {
  const {launcher, panel} = buildPanel();
  const log = panel.querySelector('#guide-log');
  const suggestions = panel.querySelector('#guide-suggestions');
  const form = panel.querySelector('#guide-form');
  const input = panel.querySelector('#guide-input');
  const mic = panel.querySelector('#guide-mic');
  const speakToggle = panel.querySelector('#guide-speak');
  let speakAlways = storage.get('mihakk-guide-speak') === '1';
  let recognition = null, listening = false, greeted = false, lastStep = 0, warnedNoVoice = false;
  speakToggle.setAttribute('aria-pressed', String(speakAlways));

  function scrollLog() { log.scrollTop = log.scrollHeight; }

  function addMessage(role, text, extra) {
    const item = make('div', null, `guide-msg ${role}`);
    item.append(make('p', text));
    if (extra) item.append(extra);
    log.append(item);
    scrollLog();
    return item;
  }

  function actionButton(name) {
    const action = ACTIONS[name];
    const target = action && document.getElementById(action.target);
    if (!target || target.disabled || !target.offsetParent) return null;
    const button = make('button', action.label, 'guide-action');
    button.type = 'button';
    button.addEventListener('click', () => { target.click(); button.disabled = true; button.textContent = 'تم'; });
    return button;
  }

  function renderSuggestions() {
    const step = currentStep();
    if (step === lastStep) return;
    lastStep = step;
    suggestions.replaceChildren(...(SUGGESTIONS[step] || SUGGESTIONS[1]).map(question => {
      const chip = make('button', question, 'guide-chip');
      chip.type = 'button';
      chip.addEventListener('click', () => ask(question, false));
      return chip;
    }));
  }

  function arabicVoice() {
    return pickSaudiVoice(synth?.getVoices() || []);
  }

  function speak(text) {
    if (!synth) { addMessage('system', 'متصفحك لا يدعم قراءة النص بصوت.'); return; }
    const voice = arabicVoice();
    if (!voice) {
      if (!warnedNoVoice) addMessage('system', 'لا يوجد صوت عربي مثبت على جهازك، لذلك لا أستطيع قراءة الجواب. في ويندوز: الإعدادات ← الوقت واللغة ← الكلام ← إضافة صوت عربي.');
      warnedNoVoice = true;
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 0.95;
    synth.speak(utterance);
  }

  function ask(question, byVoice) {
    const text = String(question || '').trim();
    if (!text) return;
    addMessage('user', text);
    const result = answerQuestion(text, {step: currentStep()});
    addMessage('guide', result.answer, result.action ? actionButton(result.action) : null);
    if (byVoice || speakAlways) speak(result.answer);
    input.value = '';
  }


  /** Smart employee (ElevenLabs agent): loaded only after the visitor accepts the disclosure. */
  let agentState = 'idle';
  function loadAgent() {
    if (agentState === 'loading' || agentState === 'ready') return;
    agentState = 'loading';
    const note = addMessage('system', 'أحمّل الموظف الذكي…');
    const fail = text => { agentState = 'idle'; note.querySelector('p').textContent = text; };
    const script = document.createElement('script');
    script.src = ELEVENLABS_WIDGET_SRC;
    script.async = true;
    script.onerror = () => fail('تعذّر تحميل الموظف الذكي (يحتاج إنترنت). أستطيع مساعدتك هنا من دليل الأداة.');
    script.onload = () => {
      const widget = document.createElement('elevenlabs-convai');
      widget.setAttribute('agent-id', ELEVENLABS_AGENT_ID);
      for (const [name, value] of [['action-text', 'تحدث مع مرشد مِحَكّ'], ['start-call-text', 'ابدأ المحادثة'], ['end-call-text', 'إنهاء'], ['expand-text', 'افتح المحادثة'], ['listening-text', 'أستمع…'], ['speaking-text', 'المرشد يتحدث']]) widget.setAttribute(name, value);
      document.body.append(widget);
      customElements.whenDefined('elevenlabs-convai').then(() => {
        agentState = 'ready';
        document.body.classList.add('guide-agent-on');
        note.querySelector('p').textContent = 'الموظف الذكي جاهز أسفل الصفحة: اضغط «بدء مكالمة» للتحدث بالصوت، أو زر المحادثة للكتابة.';
        close();
      });
      setTimeout(() => { if (agentState === 'loading') fail('لم يكتمل تحميل الموظف الذكي. أعد المحاولة لاحقاً، أو اسألني هنا.'); }, 15000);
    };
    document.head.append(script);
  }

  function offerAgent() {
    if (!ELEVENLABS_AGENT_ID) return;
    const row = make('div', null, 'guide-consent');
    const yes = make('button', 'ابدأ مع الموظف الذكي', 'guide-action');
    const no = make('button', 'أكمل هنا', 'guide-action plain');
    yes.type = no.type = 'button';
    yes.addEventListener('click', () => { row.remove(); loadAgent(); });
    no.addEventListener('click', () => { row.remove(); input.focus(); });
    row.append(yes, no);
    addMessage('guide', 'تريد محادثة أعمق بالصوت؟ الموظف الذكي يفهم أسئلتك الحرة ويرد بصوت سعودي. يعمل عبر خدمة ElevenLabs، فكلامك ومحادثتك تمر عبرها؛ لا تضع فيها نصوص ترجمات سرية. ملف الترجمة نفسه يبقى في متصفحك.', row);
  }

  function open() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    launcher.classList.add('is-open');
    if (!greeted) {
      addMessage('guide', 'أهلاً، أنا مرشد مِحَكّ. اسألني عن أي خطوة في الأداة، بالكتابة أو بالصوت.');
      greeted = true;
      offerAgent();
    }
    renderSuggestions();
    input.focus();
  }

  function close() {
    stopListening();
    synth?.cancel();
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.classList.remove('is-open');
    launcher.focus();
  }

  function setListening(value) {
    listening = value;
    mic.setAttribute('aria-pressed', String(value));
    mic.classList.toggle('is-listening', value);
    input.placeholder = value ? 'أستمع إليك… تكلّم الآن' : 'اكتب سؤالك هنا…';
  }

  let localController = null, localBusy = false, localReady = false;
  const engine = () => (!Recognition || storage.get('mihakk-guide-engine') === 'local' ? 'local' : 'browser');

  function stopListening() {
    if (recognition && listening) recognition.stop();
    localController?.stop?.();
  }

  const speechErrors = {
    'not-allowed': 'لم يُسمح باستخدام الميكروفون. اضغط رمز القفل بجانب عنوان الموقع، واختر «السماح» للميكروفون، ثم أعد تحميل الصفحة. أو اكتب سؤالك.',
    'service-not-allowed': 'خدمة الكلام في المتصفح غير مسموحة.',
    'no-speech': 'لم أسمع شيئاً. اضغط الميكروفون وتكلّم مرة أخرى.',
    'audio-capture': 'لم أجد ميكروفوناً يعمل على جهازك.',
    network: 'خدمة الكلام في المتصفح لم تستجب.',
  };

  /** After the browser service fails, offer on-device recognition instead of a dead end. */
  function offerLocal(reason) {
    const button = make('button', `اسمع على جهازي (تنزيل نحو ${LOCAL_MB} MB مرة واحدة)`, 'guide-action');
    button.type = 'button';
    button.addEventListener('click', () => { button.disabled = true; storage.set('mihakk-guide-engine', 'local'); startLocal(); });
    addMessage('system', `${reason} أستطيع أن أسمعك بطريقة أخرى تعمل كلها على جهازك، وصوتك لا يغادره.`, button);
  }

  function startBrowser() {
    recognition = new Recognition();
    recognition.lang = 'ar-SA';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    let finalText = '', failed = false;
    recognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      input.value = (finalText + interim).trim();
    };
    recognition.onerror = event => {
      if (event.error === 'aborted') return;
      failed = true;
      if (event.error === 'not-allowed' || event.error === 'audio-capture') addMessage('system', speechErrors[event.error]);
      else offerLocal(speechErrors[event.error] || 'تعذّر التعرّف على الكلام عبر المتصفح.');
    };
    recognition.onend = () => {
      setListening(false);
      if (finalText.trim()) ask(finalText, true);
      else if (!failed) offerLocal('لم يصلني أي كلام من خدمة المتصفح.');
    };
    synth?.cancel();
    setListening(true);
    try { recognition.start(); } catch { setListening(false); offerLocal('تعذّر تشغيل خدمة الكلام في المتصفح.'); }
  }

  async function startLocal() {
    if (localBusy) return;
    localBusy = true;
    synth?.cancel();
    const status = (item, text) => { item.querySelector('p').textContent = text; };
    let note = null;
    try {
      const speech = await import('./local-speech.mjs');
      if (!localReady) {
        note = addMessage('system', 'أجهّز السماع على جهازك… 0%');
        await speech.prepareLocalSpeech(percent => status(note, `أجهّز السماع على جهازك… ${percent}%`));
        localReady = true;
        status(note, 'السماع على جهازك جاهز. تكلّم الآن.');
      }
      localController = {};
      setListening(true);
      const audio = await speech.recordQuestion({controller: localController});
      setListening(false);
      if (!audio) { addMessage('system', speechErrors['no-speech']); return; }
      note = addMessage('system', 'أحوّل صوتك إلى نص…');
      const text = await speech.transcribe(audio);
      note.remove();
      if (text) ask(text, true);
      else addMessage('system', 'لم أفهم الكلام. تكلّم بوضوح أقرب إلى الميكروفون، أو اكتب سؤالك.');
    } catch (error) {
      setListening(false);
      const name = error?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') addMessage('system', speechErrors['not-allowed']);
      else if (name === 'NotFoundError') addMessage('system', speechErrors['audio-capture']);
      else addMessage('system', `تعذّر السماع على جهازك (${String(error?.message || error).slice(0, 120)}). تأكد من الإنترنت عند أول تنزيل، أو اكتب سؤالك.`);
    } finally {
      localController = null;
      localBusy = false;
    }
  }

  function startListening() { if (engine() === 'local') startLocal(); else startBrowser(); }

  function askMicConsent() {
    const row = make('div', null, 'guide-consent');
    const yes = make('button', 'موافق، شغّل الميكروفون', 'guide-action');
    const local = make('button', 'اسمع على جهازي فقط', 'guide-action');
    const no = make('button', 'سأكتب بدلاً من ذلك', 'guide-action plain');
    yes.type = local.type = no.type = 'button';
    yes.addEventListener('click', () => { storage.set('mihakk-guide-mic', '1'); row.remove(); startListening(); });
    local.addEventListener('click', () => { storage.set('mihakk-guide-mic', '1'); storage.set('mihakk-guide-engine', 'local'); row.remove(); startLocal(); });
    no.addEventListener('click', () => { row.remove(); input.focus(); });
    if (Recognition) row.append(yes, local, no); else row.append(local, no);
    const text = Recognition
      ? `قبل أول استخدام: «موافق» يستعمل خدمة الكلام في متصفحك، وقد ترسل صوتك إلى جوجل أو مايكروسوفت لتحويله إلى نص. «اسمع على جهازي فقط» ينزّل نموذجاً صغيراً (نحو ${LOCAL_MB} MB مرة واحدة) ويبقي صوتك على جهازك.`
      : `متصفحك لا يقدّم خدمة كلام، لكني أستطيع أن أسمعك على جهازك بعد تنزيل نموذج صغير (نحو ${LOCAL_MB} MB مرة واحدة). صوتك لا يغادر جهازك.`;
    addMessage('system', text, row);
  }

  mic.addEventListener('click', () => {
    if (localBusy && !listening) return;
    if (listening) { stopListening(); return; }
    if (!navigator.mediaDevices?.getUserMedia && !Recognition) { addMessage('system', 'متصفحك لا يدعم الميكروفون. اكتب سؤالك.'); return; }
    if (storage.get('mihakk-guide-mic') === '1') startListening(); else askMicConsent();
  });

  speakToggle.addEventListener('click', () => {
    speakAlways = !speakAlways;
    speakToggle.setAttribute('aria-pressed', String(speakAlways));
    storage.set('mihakk-guide-speak', speakAlways ? '1' : '0');
    if (!speakAlways) synth?.cancel();
    else if (!arabicVoice()) speak('');
  });

  form.addEventListener('submit', event => { event.preventDefault(); ask(input.value, false); });
  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.querySelector('#guide-close').addEventListener('click', close);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  // Keep suggestions in step with the wizard without touching app.js.
  new MutationObserver(() => { if (!panel.hidden) renderSuggestions(); }).observe(document.querySelector('.workflow') || document.body, {subtree: true, attributes: true, attributeFilter: ['class']});
  synth?.getVoices(); // Chrome fills the voice list lazily; ask early so the first answer can be spoken.

  return {open, close, ask};
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createGuide, {once: true});
else createGuide();
