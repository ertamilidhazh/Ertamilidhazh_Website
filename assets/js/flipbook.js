// Flip-book viewer: downloads an issue from Drive, renders it with PDF.js, turns pages with StPageFlip.
// Used embedded on the home page and full-screen on read.html.
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import { downloadPdf, viewUrl, previewUrl, hasApiKey, folderUrl, ERROR_TEXT, DriveError } from './drive.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38';
pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;

const MAX_DPR = 2;
const MAX_CANVAS_WIDTH = 2200;
const RENDER_AHEAD = 2; // pages rendered on each side of the open spread
const KEEP_RENDERED = 6; // pages further away than this are released to save memory

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Fills a <select> with every issue, newest first, grouped by year.
export function fillIssueSelect(select, issues, selectedId) {
  const groups = new Map();
  for (const issue of issues) {
    if (!groups.has(issue.year)) groups.set(issue.year, []);
    groups.get(issue.year).push(issue);
  }
  const children = [];
  for (const [year, list] of groups) {
    const group = document.createElement('optgroup');
    group.label = String(year);
    for (const issue of list) {
      const option = document.createElement('option');
      option.value = issue.id;
      option.textContent = issue === issues[0] ? `${issue.label} (நடப்பு இதழ்)` : issue.label;
      if (issue.note) option.textContent += `, ${issue.note}`;
      option.selected = issue.id === selectedId;
      group.append(option);
    }
    children.push(group);
  }
  select.replaceChildren(...children);
  select.disabled = issues.length === 0;
}

export class Flipbook {
  /**
   * @param {HTMLElement} root  element containing the [data-*] parts of the viewer
   * @param {object} options
   * @param {Element|Document} options.keyboardTarget  where arrow keys are listened for
   * @param {boolean} options.mobileScroll  let vertical swipes scroll the page (embedded use)
   */
  constructor(root, { keyboardTarget = root, mobileScroll = false, fullscreenTarget = root } = {}) {
    const part = (name) => root.querySelector(`[data-${name}]`);
    this.root = root;
    this.ui = {
      status: part('status'),
      statusText: part('status-text'),
      statusEn: part('status-en'),
      progress: part('progress'),
      bar: part('progress')?.firstElementChild,
      actions: part('actions'),
      host: part('host'),
      prev: part('prev'),
      next: part('next'),
      counter: part('counter'),
      fullscreen: part('fullscreen'),
      spacer: part('spacer'),
    };
    this.mobileScroll = mobileScroll;
    this.fullscreenTarget = fullscreenTarget;
    this.flip = null;
    this.pdf = null;
    this.pages = [];
    this.pageRatio = 1 / 1.414;
    this.token = 0;
    this.abort = null;
    this.issue = null;
    this.setupControls(keyboardTarget);
  }

  /* ---------- status panel ---------- */

  setStatus(ta, en = '') {
    const { status, statusText, statusEn, host } = this.ui;
    status.hidden = false;
    host.hidden = true;
    statusText.textContent = ta;
    statusEn.textContent = en;
    statusEn.hidden = !en;
  }

  setProgress(fraction) {
    const pct = Math.round(fraction * 100);
    this.ui.progress.hidden = false;
    this.ui.progress.setAttribute('aria-valuenow', String(pct));
    this.ui.bar.style.width = `${pct}%`;
  }

  setActions(...buttons) {
    this.ui.actions.replaceChildren(...buttons);
  }

  action(label, attrs) {
    const el = document.createElement(attrs.href ? 'a' : 'button');
    el.className = attrs.primary ? 'r-btn r-btn--sun' : 'r-btn';
    el.textContent = label;
    if (attrs.href) {
      el.href = attrs.href;
      if (attrs.external) { el.target = '_blank'; el.rel = 'noopener'; }
    } else {
      el.type = 'button';
      el.addEventListener('click', attrs.onClick);
    }
    return el;
  }

  showError(err, issue) {
    let kind = err instanceof DriveError ? err.kind : 'network';
    if (err?.name === 'InvalidPDFException') kind = 'bad-pdf';
    const [ta, en] = ERROR_TEXT[kind] || ERROR_TEXT.network;
    console.warn('Er Idhazh flip book:', err);
    this.ui.progress.hidden = true;
    this.setStatus(ta, en);
    const buttons = [];
    if (issue && ['network', 'quota'].includes(kind)) {
      buttons.push(this.action('மீண்டும் முயற்சிக்க', { primary: true, onClick: () => this.open(issue) }));
    }
    buttons.push(this.action('Google Drive-இல் படிக்க', { href: issue ? viewUrl(issue.id) : folderUrl(), external: true }));
    this.setActions(...buttons);
  }

  /* ---------- open / close ---------- */

  teardown() {
    if (this.flip) {
      this.flip.destroy();
      this.flip = null;
    }
    this.ui.host.replaceChildren();
    this.pages = [];
    if (this.pdf) {
      this.pdf.destroy();
      this.pdf = null;
    }
    this.ui.prev.disabled = true;
    this.ui.next.disabled = true;
    this.ui.counter.textContent = 'பக்கம் – / –';
  }

  // Until an API key is set, show the issue in Google's own Drive viewer (scrolling, not flipping).
  showPreview(issue) {
    console.info('Er Idhazh: add API_KEY in assets/js/config.js to turn on the flip book.');
    const frame = document.createElement('iframe');
    frame.className = 'drive-preview';
    frame.src = previewUrl(issue.id);
    frame.title = `${issue.label} இதழ் (Google Drive)`;
    frame.allow = 'fullscreen';
    this.ui.status.hidden = true;
    this.ui.host.hidden = false;
    this.ui.host.replaceChildren(frame);
    this.ui.counter.textContent = 'Google Drive பார்வை';
  }

  async open(issue) {
    const token = ++this.token;
    this.abort?.abort();
    this.abort = new AbortController();
    this.teardown();
    this.issue = issue;

    if (!hasApiKey()) {
      this.showPreview(issue);
      return;
    }

    this.setActions();
    this.setStatus('இதழ் பதிவிறக்கம் ஆகிறது…', `Downloading ${issue.label}`);
    this.setProgress(0);
    try {
      const data = await downloadPdf(issue, (p) => token === this.token && this.setProgress(p), this.abort.signal);
      if (token !== this.token) return;

      this.setStatus('பக்கங்கள் தயாராகின்றன…', 'Preparing pages');
      const pdf = await pdfjsLib.getDocument({
        data,
        cMapUrl: `${PDFJS}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS}/standard_fonts/`,
      }).promise;
      if (token !== this.token) { pdf.destroy(); return; }
      this.pdf = pdf;
      await this.build();
    } catch (err) {
      if (err?.name === 'AbortError' || token !== this.token) return;
      this.teardown();
      this.showError(err, issue);
    }
  }

  /* ---------- book ---------- */

  // StPageFlip shows one page when the book is narrower than 2 × minWidth.
  // Show a spread only when two pages fit at a readable size.
  portraitThreshold() {
    const { clientWidth: w, clientHeight: h } = this.ui.host;
    return Math.max(200, Math.min(h * this.pageRatio * 0.8, w));
  }

  async build() {
    const first = await this.pdf.getPage(1);
    const size = first.getViewport({ scale: 1 });
    this.pageRatio = size.width / size.height;

    const count = this.pdf.numPages;
    const els = [];
    for (let i = 0; i < count; i += 1) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.density = i === 0 || i === count - 1 ? 'hard' : 'soft';
      const num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = String(i + 1);
      el.append(num);
      els.push(el);
      this.pages.push({ el, width: 0, busy: false });
    }

    this.ui.status.hidden = true;
    this.ui.host.hidden = false;
    // StPageFlip removes its element on destroy, so each issue gets a fresh one.
    const book = document.createElement('div');
    book.className = 'book';
    this.ui.host.append(book);

    this.flip = new window.St.PageFlip(book, {
      width: Math.round(size.width),
      height: Math.round(size.height),
      size: 'stretch',
      autoSize: false,
      minWidth: this.portraitThreshold(),
      maxWidth: 1600,
      minHeight: 200,
      maxHeight: 2400,
      showCover: true,
      usePortrait: true,
      mobileScrollSupport: this.mobileScroll,
      maxShadowOpacity: 0.45,
      flippingTime: 700,
      showPageCorners: !reduceMotion,
    });
    this.flip.loadFromHTML(els);
    this.flip.on('flip', () => this.refresh());
    this.flip.on('changeOrientation', () => this.refresh());
    this.refresh();
  }

  refresh() {
    if (!this.flip) return;
    this.updateControls();
    this.renderAround(this.flip.getCurrentPageIndex());
  }

  /* ---------- page rendering ---------- */

  pageCssWidth() {
    const { clientWidth: w, clientHeight: h } = this.ui.host;
    const portrait = this.flip?.getOrientation() === 'portrait';
    return Math.min(portrait ? w : w / 2, h * this.pageRatio);
  }

  renderAround(current) {
    for (let i = current - RENDER_AHEAD; i <= current + 1 + RENDER_AHEAD; i += 1) this.renderPage(i);
    this.pages.forEach((page, i) => {
      if (page.width && Math.abs(i - current) > KEEP_RENDERED) this.releasePage(page);
    });
  }

  async renderPage(index) {
    const page = this.pages[index];
    const pdf = this.pdf;
    if (!page || page.busy || !pdf) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const want = Math.min(Math.ceil(this.pageCssWidth() * dpr), MAX_CANVAS_WIDTH);
    if (page.width >= want * 0.9) return;

    page.busy = true;
    try {
      const pdfPage = await pdf.getPage(index + 1);
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: want / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
      if (pdf !== this.pdf) return;
      this.releasePage(page);
      page.el.prepend(canvas);
      page.width = canvas.width;
      page.el.classList.add('is-rendered');
      pdfPage.cleanup();
    } catch (err) {
      if (pdf === this.pdf) console.warn(`Er Idhazh flip book: page ${index + 1} failed to render`, err);
    } finally {
      page.busy = false;
    }
  }

  releasePage(page) {
    const canvas = page.el.querySelector('canvas');
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    page.width = 0;
    page.el.classList.remove('is-rendered');
  }

  /* ---------- navigation ---------- */

  isLandscape() {
    return this.flip.getOrientation() === 'landscape';
  }

  updateControls() {
    const total = this.flip.getPageCount();
    const i = this.flip.getCurrentPageIndex();
    const spread = this.isLandscape() && i > 0 && i + 1 < total;
    this.ui.counter.textContent = spread ? `பக்கம் ${i + 1}–${i + 2} / ${total}` : `பக்கம் ${i + 1} / ${total}`;
    this.ui.prev.disabled = i <= 0;
    this.ui.next.disabled = spread ? i + 2 >= total : i + 1 >= total;
  }

  go(direction) {
    if (!this.flip) return;
    if (!reduceMotion) {
      if (direction > 0) this.flip.flipNext();
      else this.flip.flipPrev();
      return;
    }
    // Reduced motion: jump straight to the page without the curl animation.
    const total = this.flip.getPageCount();
    const i = this.flip.getCurrentPageIndex();
    const step = this.isLandscape() && !(direction > 0 && i === 0) ? 2 : 1;
    this.goTo(Math.max(0, Math.min(total - 1, i + direction * step)));
  }

  goTo(index) {
    if (!this.flip) return;
    this.flip.turnToPage(index);
    this.refresh();
  }

  setupControls(keyboardTarget) {
    const { prev, next, fullscreen, spacer } = this.ui;
    prev.addEventListener('click', () => this.go(-1));
    next.addEventListener('click', () => this.go(1));

    keyboardTarget.addEventListener('keydown', (e) => {
      if (!this.flip || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); this.go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); this.go(-1); }
      else if (e.key === 'Home') { e.preventDefault(); this.goTo(0); }
      else if (e.key === 'End') { e.preventDefault(); this.goTo(this.flip.getPageCount() - 1); }
    });

    if (document.fullscreenEnabled) {
      fullscreen.hidden = false;
      fullscreen.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else this.fullscreenTarget.requestFullscreen().catch(() => {});
      });
      document.addEventListener('fullscreenchange', () => {
        const on = Boolean(document.fullscreenElement);
        fullscreen.setAttribute('aria-pressed', String(on));
        fullscreen.setAttribute('aria-label', on ? 'முழுத்திரையிலிருந்து வெளியேற' : 'முழுத்திரை');
        fullscreen.querySelector('use').setAttribute('href', on ? '#i-collapse' : '#i-expand');
      });
    } else if (spacer) {
      spacer.hidden = true;
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!this.flip) return;
        this.flip.getSettings().minWidth = this.portraitThreshold();
        this.flip.update();
        this.refresh();
      }, 200);
    });
  }
}
