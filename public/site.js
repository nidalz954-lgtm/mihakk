// Site layer: landing/tool view switch, scroll-linked 3D for the real screenshots, pinned step story,
// reveal-on-scroll and the video. No network calls, no storage. Without it the page stays readable.
const doc = document;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (selector, root = doc) => root.querySelector(selector);
const $$ = (selector, root = doc) => [...root.querySelectorAll(selector)];
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const landingTitle = doc.title;

// ---------- view router: #tool opens the application, anything else shows the site ----------
const isTool = () => location.hash === '#tool' || location.hash === '#workspace';
let currentView = null;
function hashTarget() {
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { id = ''; }
  return id && id !== 'top' ? doc.getElementById(id) : null;
}
let firstRoute = true;
function route() {
  const first = firstRoute; firstRoute = false;
  const tool = isTool(), changed = currentView !== null && currentView !== (tool ? 'tool' : 'landing');
  currentView = tool ? 'tool' : 'landing';
  doc.body.dataset.view = currentView;
  doc.title = tool ? 'مِحَكّ | مساحة الفحص' : landingTitle;
  const skip = $('[data-skip]');
  if (skip) { skip.setAttribute('href', tool ? '#workspace' : '#top'); skip.textContent = tool ? 'انتقل إلى مساحة العمل' : 'انتقل إلى المحتوى الرئيسي'; }
  if (tool) {
    scrollTo({top: 0, behavior: 'instant'});
    if (changed) $('.wizard-pane:not([hidden]) h1')?.focus({preventScroll: true});
    return;
  }
  // Leaving the tool: never leave a modal case dialog open over the landing page.
  const dialog = $('#finding-dialog');
  if (dialog?.open) dialog.close();
  const target = hashTarget();
  if (target) target.scrollIntoView({behavior: changed || reduceMotion || first ? 'instant' : 'smooth', block: 'start'});
  else if (changed) scrollTo({top: 0, behavior: 'instant'});
  if (changed && !target) $('#top')?.focus({preventScroll: true});
}
addEventListener('hashchange', route);
route();

$$('[data-open-tool]').forEach(link => link.addEventListener('click', event => {
  if (!link.hasAttribute('data-start-demo')) return;
  event.preventDefault();
  if (location.hash !== '#tool') location.hash = '#tool'; else route();
  // The app owns the demo and explains itself if a file is already loaded or a run is busy.
  setTimeout(() => $('#demo-button')?.click(), 60);
}));
$$('.brand, .home-link').forEach(link => link.addEventListener('click', event => { event.preventDefault(); history.pushState(null, '', '#top'); route(); }));

// ---------- per-frame scroll work, one rAF per frame ----------
const header = $('.site-header');
const progress = $('.scroll-progress i');
const showcase = $('[data-showcase]');
const hero = $('.hero');
const video3d = $('.video-3d');
const scrollers = [];
let ticking = false;
function onScroll() {
  if (ticking) return; ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    if (doc.body.dataset.view !== 'landing') return;
    const max = doc.documentElement.scrollHeight - innerHeight;
    header?.classList.toggle('scrolled', scrollY > 8);
    progress?.style.setProperty('--p', max > 0 ? (scrollY / max).toFixed(4) : 0);
    scrollers.forEach(fn => fn());
  });
}
addEventListener('scroll', onScroll, {passive: true});
addEventListener('resize', onScroll, {passive: true});

// Hero: the real dashboard starts tilted back in 3D and stands up as you scroll.
if (showcase && !reduceMotion) {
  scrollers.push(() => {
    const box = showcase.getBoundingClientRect();
    showcase.style.setProperty('--hp', clamp(1 - (box.top - innerHeight * .12) / (innerHeight * .55)).toFixed(3));
  });
  if (matchMedia('(pointer: fine)').matches) {
    let frame = 0;
    hero.addEventListener('pointermove', event => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        showcase.style.setProperty('--mx', ((event.clientX / innerWidth) * 2 - 1).toFixed(3));
        showcase.style.setProperty('--my', ((event.clientY / innerHeight) * 2 - 1).toFixed(3));
      });
    });
    hero.addEventListener('pointerleave', () => { showcase.style.setProperty('--mx', 0); showcase.style.setProperty('--my', 0); });
  }
} else showcase?.style.setProperty('--hp', 1);

// Video frame: tilted while entering, flat when centred.
if (video3d && !reduceMotion) {
  scrollers.push(() => {
    const box = video3d.getBoundingClientRect();
    video3d.style.setProperty('--vt', clamp((box.top - innerHeight * .18) / (innerHeight * .6)).toFixed(3));
  });
} else video3d?.style.setProperty('--vt', 0);

// ---------- pinned story: four real screens, one per step (wide screens with motion allowed) ----------
const story = $('.story');
const storyQuery = matchMedia('(min-width: 1001px) and (min-height: 620px)');
if (story && !reduceMotion) {
  const stage = $('.story-stage', story);
  const items = $$('.story-item', story);
  const screens = $$('.screen', story);
  const bar = $('.story-progress', story);
  let active = 0;
  const setStage = n => {
    if (n === active) return;
    active = n;
    stage.dataset.stage = String(n);
    items.forEach((item, i) => { item.classList.toggle('on', i + 1 === n); item.classList.toggle('done', i + 1 < n); });
    screens.forEach((screen, i) => { screen.classList.toggle('is-on', i + 1 === n); screen.classList.toggle('is-past', i + 1 < n); });
  };
  const update = () => {
    if (!doc.documentElement.classList.contains('story-on')) return;
    const box = story.getBoundingClientRect(), total = story.offsetHeight - innerHeight;
    const p = clamp(-box.top / Math.max(1, total));
    bar.style.setProperty('--sp', p.toFixed(3));
    setStage(Math.min(4, 1 + Math.floor(p * 4 * .999)));
  };
  const apply = () => { doc.documentElement.classList.toggle('story-on', storyQuery.matches); active = 0; update(); };
  storyQuery.addEventListener('change', apply);
  apply();
  scrollers.push(update);
  items.forEach((item, i) => item.addEventListener('click', () => {
    const top = story.getBoundingClientRect().top + scrollY + (story.offsetHeight - innerHeight) * ((i + .5) / 4);
    scrollTo({top, behavior: 'smooth'});
  }));
}

// ---------- tool: keep the status / error banner (#notice) out from under the sticky app header ----------
// The app scrolls to the step heading, which sits BELOW the banner, so a fresh message can end up behind the header.
// Publish the header height for CSS, and after a message changes and the page has stopped moving, bring the banner
// into view only if it is covered AND within one screen above the viewport. Keep validation focus in view,
// and stop a pending correction as soon as the reader chooses to scroll or interact elsewhere.
const appHeader = $('.app-header'), noticeBox = $('#notice');
if (appHeader && noticeBox) {
  const publishHeader = () => { const h = appHeader.offsetHeight; if (h > 0) doc.documentElement.style.setProperty('--app-header-h', h + 'px'); };
  if ('ResizeObserver' in window) new ResizeObserver(publishHeader).observe(appHeader); else addEventListener('resize', publishHeader);
  publishHeader();
  let revealTimer = 0;
  const cancelReveal = () => { clearTimeout(revealTimer); revealTimer = 0; };
  const reveal = () => {
    revealTimer = 0;
    if (doc.body.dataset.view !== 'tool' || noticeBox.hidden || $('#finding-dialog')?.open) return;
    // app.js focuses an invalid field and supplies an inline alert there. Its focus takes precedence
    // over the duplicate summary banner, particularly on phones with the software keyboard open.
    if (doc.activeElement?.matches('input[aria-invalid="true"],select[aria-invalid="true"],textarea[aria-invalid="true"]')) return;
    const cover = appHeader.getBoundingClientRect().bottom, box = noticeBox.getBoundingClientRect();
    if (box.top < cover && box.bottom > -innerHeight) noticeBox.scrollIntoView({behavior: 'instant', block: 'start'});
  };
  const settle = () => { clearTimeout(revealTimer); revealTimer = setTimeout(reveal, 220); };
  new MutationObserver(settle).observe(noticeBox, {childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class']});
  addEventListener('scroll', () => { if (revealTimer) settle(); }, {passive: true});
  ['wheel', 'touchstart', 'pointerdown'].forEach(name => addEventListener(name, cancelReveal, {passive: true}));
  addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab', 'Escape'].includes(event.key)) cancelReveal();
  });
}

// ---------- case visual: gentle pointer tilt ----------
const caseVisual = $('[data-tilt-card]');
if (caseVisual && !reduceMotion && matchMedia('(pointer: fine)').matches) {
  caseVisual.addEventListener('pointermove', event => {
    const box = caseVisual.getBoundingClientRect();
    caseVisual.style.setProperty('--mx', (((event.clientX - box.left) / box.width) * 2 - 1).toFixed(3));
    caseVisual.style.setProperty('--my', (((event.clientY - box.top) / box.height) * 2 - 1).toFixed(3));
  });
  caseVisual.addEventListener('pointerleave', () => { caseVisual.style.setProperty('--mx', 0); caseVisual.style.setProperty('--my', 0); });
}

// ---------- reveal on scroll: items already on screen are shown before the hiding class is applied ----------
const reveals = $$('.reveal');
if ('IntersectionObserver' in window && !reduceMotion) {
  reveals.forEach(node => { const box = node.getBoundingClientRect(); if (box.top < innerHeight && box.bottom > 0) node.classList.add('in'); });
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in'); observer.unobserve(entry.target);
  }), {threshold: .12, rootMargin: '0px 0px -6% 0px'});
  reveals.forEach(node => { if (!node.classList.contains('in')) observer.observe(node); });
  doc.documentElement.classList.add('js-ready');
}

// Numbers are static on purpose: a running counter shows wrong intermediate values to readers and screenshots.

// ---------- video: silent loop while visible, full narrated video on request ----------
const frame = $('.video-frame');
if (frame) {
  const loop = $('.video-loop', frame), full = $('.video-full', frame), play = $('#video-play'), toggle = $('#loop-toggle');
  let userPaused = reduceMotion;
  const syncToggle = () => { toggle.setAttribute('aria-pressed', String(userPaused)); toggle.setAttribute('aria-label', userPaused ? 'تشغيل حركة المقطع' : 'إيقاف حركة المقطع'); };
  syncToggle();
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !userPaused && !frame.classList.contains('playing')) loop.play().catch(() => {});
      else loop.pause();
    }, {threshold: .35}).observe(frame);
  }
  toggle.addEventListener('click', () => { userPaused = !userPaused; syncToggle(); userPaused ? loop.pause() : loop.play().catch(() => {}); });
  play.addEventListener('click', () => {
    loop.pause();
    frame.classList.add('playing');
    full.hidden = false;
    full.focus({preventScroll: true});
    full.play().catch(() => {});
  });
}

// Cold deep link: route() ran before the pinned story (340vh, added above) existed, so the first scroll aimed at the pre-story
// layout. Re-aim once now that the layout is final, and once more after load, unless the reader has already moved the page.
let readerMoved = false;
['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(name => addEventListener(name, () => { readerMoved = true; }, {once: true, passive: true}));
const settleHash = () => { if (readerMoved || isTool()) return; hashTarget()?.scrollIntoView({behavior: 'instant', block: 'start'}); };
settleHash();
addEventListener('load', settleHash, {once: true});

// First paint of scroll-linked values, and again whenever the landing view comes back.
onScroll();
addEventListener('hashchange', () => setTimeout(onScroll, 0));
