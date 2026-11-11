// Flip-book viewer: downloads an issue from Drive, renders it with PDF.js, turns pages with StPageFlip.
// Used embedded on the home page and full-screen on read.html.
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import { downloadPdf, viewUrl, folderUrl, ERROR_TEXT, DriveError } from './drive.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38';
pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;

const MAX_DPR = 2;
const MAX_CANVAS_WIDTH = 2200;
const RENDER_AHEAD = 2; // pages rendered on each side of the open spread
const KEEP_RENDERED = 6; // pages further away than this are released to save memory
const ZOOM_LEVELS = [1, 1.5, 2, 3]; // multiples of "fit to reader width"
const ZOOM_FIT_MAX = 1100; // widest a page is drawn at 100%, in CSS pixels
const ZOOM_MAX_CANVAS = 2800; // canvas pixel cap, keeps phones within memory

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
      zoom: part('zoom'),
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
    this.zoom = { open: false, page: 0, level: 0, token: 0 };
    this.buildZoomView();
    this.setupControls(keyboardTarget);
  }

  /* ---------- zoom to read ---------- */

  buildZoomView() {
    const button = (cls, icon, attrs, label = '') => `<button class="r-btn ${cls}" type="button" ${attrs}>`
      + `<svg aria-hidden="true"><use href="#${icon}"/></svg>${label}</button>`;
    const view = document.createElement('div');
    view.className = 'zoom-view';
    view.hidden = true;
    view.setAttribute('role', 'region');
    view.setAttribute('aria-label', 'பெரிதாக்கிய பக்கம்');
    view.innerHTML = `
      <div class="zoom-bar">
        <div class="zoom-steps">
          ${button('', 'i-minus', 'data-zoom-out aria-label="சிறிதாக்கு"')}
          <p class="zoom-level" data-zoom-level aria-live="polite">100%</p>
          ${button('', 'i-plus', 'data-zoom-in aria-label="பெரிதாக்கு"')}
        </div>
        ${button('zoom-close', 'i-close', 'data-zoom-close aria-label="பெரிதாக்கிய பார்வையை மூட"', '<span class="label-long">புரட்டும் பார்வை</span>')}
      </div>
      <div class="zoom-scroll" data-zoom-scroll tabindex="0"><div class="zoom-page" data-zoom-page></div></div>`;
    this.ui.host.parentElement.append(view);
    const q = (name) => view.querySelector(`[data-${name}]`);
    Object.assign(this.ui, {
      zoomView: view,
      zoomScroll: q('zoom-scroll'),
      zoomPage: q('zoom-page'),
      zoomLevel: q('zoom-level'),
      zoomIn: q('zoom-in'),
      zoomOut: q('zoom-out'),
    });
    this.ui.zoomIn.addEventListener('click', () => this.setZoomLevel(this.zoom.level + 1));
    this.ui.zoomOut.addEventListener('click', () => this.setZoomLevel(this.zoom.level - 1));
    q('zoom-close').addEventListener('click', () => this.closeZoom());
    this.ui.zoom?.addEventListener('click', () => (this.zoom.open ? this.closeZoom() : this.openZoom()));
  }

  openZoom() {
    if (!this.flip) return;
    Object.assign(this.zoom, { open: true, page: this.flip.getCurrentPageIndex() });
    this.ui.zoomView.hidden = false;
    this.ui.zoom?.setAttribute('aria-pressed', 'true');
    this.renderZoom(true);
    this.updateControls();
    this.ui.zoomScroll.focus({ preventScroll: true });
  }

  closeZoom() {
    if (!this.zoom.open) return;
    this.zoom.open = false;
    this.zoom.token += 1;
    this.ui.zoomView.hidden = true;
    this.ui.zoomPage.replaceChildren();
    this.ui.zoom?.setAttribute('aria-pressed', 'false');
    if (this.flip) this.goTo(this.zoom.page);
  }

  setZoomLevel(level) {
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, level));
    if (next === this.zoom.level) return;
    // keep the same spot of the page in view while zooming
    const sc = this.ui.zoomScroll;
    const fx = (sc.scrollLeft + sc.clientWidth / 2) / (sc.scrollWidth || 1);
    const fy = (sc.scrollTop + sc.clientHeight / 2) / (sc.scrollHeight || 1);
    this.zoom.level = next;
    this.renderZoom(false).then(() => {
      sc.scrollLeft = fx * sc.scrollWidth - sc.clientWidth / 2;
      sc.scrollTop = fy * sc.scrollHeight - sc.clientHeight / 2;
    });
  }

  async renderZoom(toTop) {
    const pdf = this.pdf;
    if (!pdf || !this.zoom.open) return;
    const token = ++this.zoom.token;
    const { zoomScroll, zoomPage, zoomLevel, zoomIn, zoomOut } = this.ui;
    const scale = ZOOM_LEVELS[this.zoom.level];
    zoomLevel.textContent = `${Math.round(scale * 100)}%`;
    zoomOut.disabled = this.zoom.level === 0;
    zoomIn.disabled = this.zoom.level === ZOOM_LEVELS.length - 1;
    zoomPage.classList.add('is-loading');

    const pad = parseFloat(getComputedStyle(zoomScroll).paddingLeft) * 2;
    const cssWidth = Math.floor(Math.min(zoomScroll.clientWidth - pad, ZOOM_FIT_MAX) * scale);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    try {
      const page = await pdf.getPage(this.zoom.page + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(cssWidth * dpr, ZOOM_MAX_CANVAS) / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${Math.round(cssWidth * (viewport.height / viewport.width))}px`;
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
      if (token !== this.zoom.token || pdf !== this.pdf) return;
      for (const old of zoomPage.querySelectorAll('canvas')) { old.width = 0; old.height = 0; }
      zoomPage.replaceChildren(canvas);
      if (toTop) { zoomScroll.scrollTop = 0; zoomScroll.scrollLeft = 0; }
    } catch (err) {
      if (token === this.zoom.token) console.warn('Er Idhazh flip book: zoomed page failed to render', err);
    } finally {
      if (token === this.zoom.token) zoomPage.classList.remove('is-loading');
    }
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
    if (issue && kind === 'network') {
      buttons.push(this.action('மீண்டும் முயற்சிக்க', { primary: true, onClick: () => this.open(issue) }));
    }
    buttons.push(this.action('Google Drive-இல் படிக்க', { href: issue ? viewUrl(issue.id) : folderUrl(), external: true }));
    this.setActions(...buttons);
  }

  /* ---------- open / close ---------- */

  teardown() {
    this.closeZoom();
    if (this.ui.zoom) this.ui.zoom.disabled = true;
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

  async open(issue) {
    const token = ++this.token;
    this.abort?.abort();
    this.abort = new AbortController();
    this.teardown();
    this.issue = issue;

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
    if (this.ui.zoom) this.ui.zoom.disabled = false;
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
    if (this.zoom.open) {
      const total = this.pdf.numPages;
      this.ui.counter.textContent = `பக்கம் ${this.zoom.page + 1} / ${total}`;
      this.ui.prev.disabled = this.zoom.page <= 0;
      this.ui.next.disabled = this.zoom.page + 1 >= total;
      return;
    }
    const total = this.flip.getPageCount();
    const i = this.flip.getCurrentPageIndex();
    const spread = this.isLandscape() && i > 0 && i + 1 < total;
    this.ui.counter.textContent = spread ? `பக்கம் ${i + 1}–${i + 2} / ${total}` : `பக்கம் ${i + 1} / ${total}`;
    this.ui.prev.disabled = i <= 0;
    this.ui.next.disabled = spread ? i + 2 >= total : i + 1 >= total;
  }

  go(direction) {
    if (!this.flip) return;
    if (this.zoom.open) {
      this.goTo(this.zoom.page + direction);
      return;
    }
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
    if (this.zoom.open) {
      const page = Math.max(0, Math.min(this.pdf.numPages - 1, index));
      if (page === this.zoom.page) return;
      this.zoom.page = page;
      this.updateControls();
      this.renderZoom(true);
      return;
    }
    this.flip.turnToPage(index);
    this.refresh();
  }

  setupControls(keyboardTarget) {
    const { prev, next, fullscreen } = this.ui;
    prev.addEventListener('click', () => this.go(-1));
    next.addEventListener('click', () => this.go(1));

    keyboardTarget.addEventListener('keydown', (e) => {
      if (!this.flip || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.closest?.('input, textarea, select')) return;
      if (this.zoom.open && e.key === 'Escape') { e.preventDefault(); this.closeZoom(); return; }
      if (this.zoom.open && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.setZoomLevel(this.zoom.level + 1); return; }
      if (this.zoom.open && e.key === '-') { e.preventDefault(); this.setZoomLevel(this.zoom.level - 1); return; }
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
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!this.flip) return;
        if (this.zoom.open) this.renderZoom(false);
        this.flip.getSettings().minWidth = this.portraitThreshold();
        this.flip.update();
        this.refresh();
      }, 200);
    });
  }
}
