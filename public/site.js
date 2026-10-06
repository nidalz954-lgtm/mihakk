// Site layer: landing/tool view switch, scroll reveal, count-up, pointer tilt, case demo, video start.
// No network calls, no storage. Everything degrades to a readable static page without it.
const doc = document;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (selector, root = doc) => root.querySelector(selector);
const $$ = (selector, root = doc) => [...root.querySelectorAll(selector)];

doc.documentElement.classList.add('js-ready');

// ---------- view router: #tool opens the application, anything else shows the site ----------
const isTool = () => location.hash === '#tool' || location.hash === '#workspace';
function route() {
  const tool = isTool();
  doc.body.dataset.view = tool ? 'tool' : 'landing';
  const skip = $('[data-skip]');
  if (skip) { skip.setAttribute('href', tool ? '#workspace' : '#top'); skip.textContent = tool ? 'انتقل إلى مساحة العمل' : 'انتقل إلى المحتوى الرئيسي'; }
  if (tool) {
    scrollTo({top: 0, behavior: 'instant'});
    const heading = $('.wizard-pane:not([hidden]) h1');
    if (heading) heading.focus({preventScroll: true});
  } else {
    const target = location.hash.length > 1 ? doc.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    if (target) target.scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth', block: 'start'});
    else scrollTo({top: 0, behavior: 'instant'});
  }
}
addEventListener('hashchange', route);
route();

$$('[data-open-tool]').forEach(link => link.addEventListener('click', event => {
  if (link.hasAttribute('data-start-demo')) {
    event.preventDefault();
    const firstStep = $('#step-1');
    const canStart = firstStep && !firstStep.hidden;
    if (location.hash !== '#tool') location.hash = '#tool'; else route();
    // The existing app owns the demo; start it only from the first step so a file in progress is never replaced.
    if (canStart) setTimeout(() => $('#demo-button')?.click(), 60);
  }
}));

// The tool's brand and "home" links return to the site.
$$('.brand, .home-link').forEach(link => link.addEventListener('click', event => { event.preventDefault(); history.pushState(null, '', '#top'); route(); }));

// ---------- header shadow + scroll progress ----------
const header = $('.site-header');
const progress = $('.scroll-progress i');
let ticking = false;
function onScroll() {
  if (ticking) return; ticking = true;
  requestAnimationFrame(() => {
    const max = doc.documentElement.scrollHeight - innerHeight;
    header?.classList.toggle('scrolled', scrollY > 8);
    progress?.style.setProperty('--p', max > 0 ? (scrollY / max).toFixed(4) : 0);
    ticking = false;
  });
}
addEventListener('scroll', onScroll, {passive: true}); onScroll();

// ---------- reveal on scroll ----------
const reveals = $$('.reveal');
if ('IntersectionObserver' in window && !reduceMotion) {
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in'); observer.unobserve(entry.target);
  }), {threshold: .14, rootMargin: '0px 0px -6% 0px'});
  reveals.forEach(node => observer.observe(node));
} else reveals.forEach(node => node.classList.add('in'));

// ---------- count-up numbers (final value is the real text, so no-JS and reduced-motion show it at once) ----------
const format = new Intl.NumberFormat('en-US');
const counters = $$('[data-count]');
if ('IntersectionObserver' in window && !reduceMotion) {
  const countObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    countObserver.unobserve(entry.target);
    const node = entry.target, end = Number(node.dataset.count), start = performance.now(), duration = 1400;
    const tick = now => {
      const t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 4);
      node.textContent = format.format(Math.round(end * eased));
      if (t < 1) requestAnimationFrame(tick);
    };
    node.textContent = '0'; requestAnimationFrame(tick);
  }), {threshold: .6});
  counters.forEach(node => countObserver.observe(node));
} else counters.forEach(node => node.textContent = format.format(Number(node.dataset.count)));

// ---------- hero 3D tilt that follows the pointer (fine pointers only) ----------
const scene = $('[data-tilt]');
if (scene && !reduceMotion && matchMedia('(pointer: fine)').matches) {
  const stage = $('.scene-3d', scene);
  let frame = 0;
  const hero = $('.hero');
  hero.addEventListener('pointermove', event => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const box = scene.getBoundingClientRect();
      const x = (event.clientX - (box.left + box.width / 2)) / innerWidth;
      const y = (event.clientY - (box.top + box.height / 2)) / innerHeight;
      stage.style.setProperty('--ry', `${(-14 + x * 22).toFixed(2)}deg`);
      stage.style.setProperty('--rx', `${(8 - y * 16).toFixed(2)}deg`);
    });
  });
  hero.addEventListener('pointerleave', () => { stage.style.removeProperty('--ry'); stage.style.removeProperty('--rx'); });
}

// ---------- case card: show how a decision is recorded (illustrative only, nothing is saved) ----------
const caseCard = $('[data-case]');
if (caseCard) {
  const state = $('.case-state', caseCard);
  const buttons = $$('[data-choice]', caseCard);
  buttons.forEach(button => button.setAttribute('aria-pressed', 'false'));
  buttons.forEach(button => button.addEventListener('click', () => {
    buttons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    state.classList.remove('set'); void state.offsetWidth; state.classList.add('set');
    const closing = button.dataset.choice.startsWith('إغلاق');
    state.textContent = closing
      ? 'مثال: يُطلب سبب قبل إغلاق التنبيه، ولا يُعد الإغلاق اعتماداً للترجمة.'
      : `مثال: تُسجَّل «${button.dataset.choice}» وتبقى الحالة مفتوحة حتى تُعالج.`;
  }));
}

// ---------- video: load only when asked ----------
const video = $('#demo-video');
const playButton = $('#video-play');
if (video && playButton) {
  const frame = video.closest('.video-frame');
  video.removeAttribute('controls');
  playButton.addEventListener('click', () => { video.setAttribute('controls', ''); video.play().catch(() => {}); });
  video.addEventListener('play', () => { frame.classList.add('playing'); video.setAttribute('controls', ''); });
  video.addEventListener('ended', () => { frame.classList.remove('playing'); video.removeAttribute('controls'); });
}
