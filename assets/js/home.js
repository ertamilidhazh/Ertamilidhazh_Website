import { listIssues, thumbUrl, readerUrl, viewUrl } from './drive.js';
import { Flipbook, fillIssueSelect } from './flipbook.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.filter((c) => c != null && c !== false));
  return el;
}

const fallbackCover = (text) => h('span', { class: 'cover-fallback' },
  h('img', { src: 'assets/img/logo-192.png', alt: '', width: 192, height: 192 }),
  h('span', {}, text));

// Cover image from Drive, falling back to a typographic cover if Drive has no thumbnail.
function cover(issue) {
  const frame = h('span', { class: 'cover' });
  const img = h('img', {
    src: thumbUrl(issue.id, 700),
    alt: '',
    width: 600,
    height: 849,
    decoding: 'async',
    referrerpolicy: 'no-referrer',
  });
  img.addEventListener('error', () => frame.replaceChildren(fallbackCover(issue.label)), { once: true });
  frame.append(img);
  return frame;
}

function setupNav() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = $('site-nav');
  if (!toggle || !nav) return;
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
  });
}

function renderHero(latest, placeholder = 'முதல் இதழ் விரைவில்') {
  const link = $('hero-cover');
  const caption = $('hero-caption');
  if (!latest) {
    link.setAttribute('aria-label', 'இதழ்கள் பகுதிக்குச் செல்ல');
    link.replaceChildren(h('span', { class: 'cover' }, fallbackCover(placeholder)));
    caption.textContent = '';
    return;
  }
  link.setAttribute('aria-label', `${latest.label} இதழைப் படிக்க`);
  link.replaceChildren(cover(latest));
  caption.textContent = `${latest.label} இதழ்`;
}

function placeholderOption(select, text) {
  select.replaceChildren(h('option', {}, text));
  select.disabled = true;
}

async function init() {
  setupNav();
  const select = $('issue-select');
  const title = $('viewer-title');
  const fullLink = $('viewer-full');
  const driveLink = $('viewer-drive');
  const section = $('issues');
  const viewer = new Flipbook($('viewer'), { mobileScroll: true });

  let issues;
  try {
    issues = await listIssues();
  } catch (err) {
    renderHero(null, 'ஏர் இதழ்');
    placeholderOption(select, 'இதழ்கள் கிடைக்கவில்லை');
    viewer.showError(err);
    return;
  }

  if (!issues.length) {
    renderHero(null);
    placeholderOption(select, 'முதல் இதழ் விரைவில்');
    viewer.setStatus('முதல் இதழ் விரைவில் வெளியாகும். வெளியானதும் இங்கே படிக்கலாம்.', 'The first issue is coming soon.');
    return;
  }

  renderHero(issues[0]);
  const wanted = new URLSearchParams(window.location.search).get('id');
  let current = issues.find((issue) => issue.id === wanted) || issues[0];
  fillIssueSelect(select, issues, current.id);

  const label = (issue) => {
    title.textContent = `${issue.label} இதழ்`;
    fullLink.href = readerUrl(issue.id);
    driveLink.href = viewUrl(issue.id);
    fullLink.hidden = false;
    driveLink.hidden = false;
  };
  label(current);

  // Download only when the reader scrolls near the flip book, so the home page stays light.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    observer?.disconnect();
    viewer.open(current);
  };
  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) start(); }, { rootMargin: '300px 0px' })
    : null;
  if (wanted || !observer) start();
  else {
    viewer.setStatus(`${current.label} இதழ்`, 'Scroll down to open');
    observer.observe(section);
  }

  select.addEventListener('change', () => {
    const next = issues.find((issue) => issue.id === select.value);
    if (!next) return;
    current = next;
    label(next);
    const url = new URL(window.location.href);
    url.searchParams.set('id', next.id);
    url.hash = 'issues';
    window.history.replaceState(null, '', url);
    started = true;
    observer?.disconnect();
    viewer.open(next);
  });
}

init();
