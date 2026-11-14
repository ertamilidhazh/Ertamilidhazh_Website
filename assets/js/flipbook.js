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
// Zoom is a multiple of "fit to reader width" (1 = 100%). Any value between
// ZOOM_MIN and ZOOM_MAX can be chosen with the slider, the % box, pinch,
// Ctrl/⌘ + scroll or double-tap; the +/− buttons move between ZOOM_STEPS.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
const ZOOM_FIT_MAX = 1100; // widest a page is drawn at 100%, in CSS pixels
const ZOOM_MAX_PIXELS = 12e6; // canvas area cap (≈48 MB), keeps phones within memory
const ZOOM_RENDER_DELAY = 160; // ms to wait after the last zoom change before re-rendering sharply
const ZOOM_STORE = 'er-idhazh-zoom'; // remembers the reader's preferred zoom in this browser
const SLIDER_MAX = 1000;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clampZoom = (s) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s));
const scaleToSlider = (s) => Math.round((SLIDER_MAX * Math.log(s / ZOOM_MIN)) / Math.log(ZOOM_MAX / ZOOM_MIN));
const sliderToScale = (v) => ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (v / SLIDER_MAX);

function loadZoom() {
  try {
    const s = Number(localStorage.getItem(ZOOM_STORE));
    return s >= ZOOM_MIN && s <= ZOOM_MAX ? s : 1;
  } catch {
    return 1;
  }
}

function saveZoom(s) {
  try { localStorage.setItem(ZOOM_STORE, String(Math.round(s * 100) / 100)); } catch { /* private mode */ }
}

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
    this.zoom = { open: false, page: 0, scale: loadZoom(), ratio: this.pageRatio, token: 0, task: null, timer: 0 };
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
        <div class="zoom-fit" role="group" aria-label="பக்கத்தைப் பொருத்து">
          ${button('', 'i-fit-width', 'data-zoom-fit-width aria-label="திரை அகலத்திற்குப் பொருத்து (Fit width)" title="திரை அகலத்திற்குப் பொருத்து (Fit width) · 0"')}
          ${button('', 'i-fit-page', 'data-zoom-fit-page aria-label="முழுப் பக்கம் தெரியும்படி (Fit page)" title="முழுப் பக்கம் தெரியும்படி (Fit page)"')}
        </div>
        <div class="zoom-steps">
          ${button('', 'i-minus', 'data-zoom-out aria-label="சிறிதாக்கு" title="சிறிதாக்கு (−)"')}
          <input class="zoom-range" data-zoom-range type="range" min="0" max="${SLIDER_MAX}" step="1"
            aria-label="பெரிதாக்கும் அளவு (Zoom level)">
          <input class="zoom-input" data-zoom-input type="text" inputmode="numeric" autocomplete="off"
            spellcheck="false" maxlength="5" aria-label="பெரிதாக்கும் அளவு, சதவீதத்தில் (Zoom %)"
            title="அளவைத் தட்டச்சு செய்து Enter அழுத்துங்கள் (Type a % and press Enter)">
          ${button('', 'i-plus', 'data-zoom-in aria-label="பெரிதாக்கு" title="பெரிதாக்கு (+)"')}
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
      zoomRange: q('zoom-range'),
      zoomInput: q('zoom-input'),
      zoomIn: q('zoom-in'),
      zoomOut: q('zoom-out'),
    });
    const { zoomRange, zoomInput } = this.ui;

    this.ui.zoomIn.addEventListener('click', () => this.stepZoom(1));
    this.ui.zoomOut.addEventListener('click', () => this.stepZoom(-1));
    q('zoom-fit-width').addEventListener('click', () => this.setZoom(1));
    q('zoom-fit-page').addEventListener('click', () => this.setZoom(this.fitPageScale()));
    q('zoom-close').addEventListener('click', () => this.closeZoom());
    this.ui.zoom?.addEventListener('click', () => (this.zoom.open ? this.closeZoom() : this.openZoom()));

    // Slider: logarithmic, so 100% sits in the middle and small zooms get as much room as large ones.
    zoomRange.addEventListener('input', () => {
      let s = sliderToScale(Number(zoomRange.value));
      if (Math.abs(s - 1) < 0.04) s = 1; // snap to "fit width"
      this.setZoom(s);
    });

    // Typed percentage: applied on Enter or when the box loses focus.
    const applyTyped = () => {
      const n = parseFloat(zoomInput.value.replace(/[^\d.]/g, ''));
      if (Number.isFinite(n) && n > 0) this.setZoom(n / 100);
      this.updateZoomUI(true); // show the applied (clamped) value, e.g. 9999 → 400%
    };
    // select after the click lands, so typing replaces the old value instead of inserting into it
    zoomInput.addEventListener('focus', () => setTimeout(() => zoomInput.select()));
    zoomInput.addEventListener('change', applyTyped);
    zoomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyTyped(); zoomInput.select(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.updateZoomUI(true); this.ui.zoomScroll.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.stepZoom(1); zoomInput.select(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.stepZoom(-1); zoomInput.select(); }
    });

    this.setupZoomGestures();
    this.updateZoomUI();
  }

  setupZoomGestures() {
    const sc = this.ui.zoomScroll;
    const page = this.ui.zoomPage;

    // Ctrl/⌘ + mouse wheel, and trackpad pinch in Chrome, Edge and Firefox (sent as ctrl+wheel).
    sc.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientHeight : 1;
      const dy = Math.max(-20, Math.min(20, e.deltaY * unit));
      this.setZoom(this.zoom.scale * Math.exp(-dy * 0.01), { x: e.clientX, y: e.clientY });
    }, { passive: false });

    // Two-finger pinch on phones and tablets, zooming around the point between the fingers.
    let pinch = null;
    let frame = 0;
    let pending = null;
    let multiTouch = false;
    let lastTap = null;
    let tapStart = null;
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
    sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        multiTouch = false;
        tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      if (e.touches.length === 2) {
        multiTouch = true;
        const m = mid(e.touches);
        pinch = { d0: dist(e.touches), s0: this.zoom.scale, anchor: this.zoomAnchor(m.x, m.y) };
        e.preventDefault();
      }
    }, { passive: false });
    sc.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches);
      pending = { scale: pinch.s0 * (dist(e.touches) / pinch.d0), anchor: pinch.anchor, x: m.x, y: m.y };
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        if (pending) this.zoomAround(pending.scale, pending.anchor, pending.x, pending.y);
      });
    }, { passive: false });
    const endTouch = (e) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length || multiTouch || e.changedTouches.length !== 1 || !tapStart) return;
      // Double-tap: zoom in to 200% at that spot, or back to fit width.
      const t = e.changedTouches[0];
      if (Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > 12) { lastTap = null; return; }
      const now = Date.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
        e.preventDefault();
        lastTap = null;
        this.toggleZoomAt(t.clientX, t.clientY);
      } else {
        lastTap = { t: now, x: t.clientX, y: t.clientY };
      }
    };
    sc.addEventListener('touchend', endTouch, { passive: false });
    sc.addEventListener('touchcancel', () => { pinch = null; });

    // Safari on Mac sends trackpad pinches as gesture events instead of ctrl+wheel.
    if (!navigator.maxTouchPoints) {
      let gesture = null;
      sc.addEventListener('gesturestart', (e) => {
        e.preventDefault();
        gesture = { s0: this.zoom.scale, anchor: this.zoomAnchor(e.clientX, e.clientY) };
      });
      sc.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        if (gesture) this.zoomAround(gesture.s0 * e.scale, gesture.anchor, e.clientX, e.clientY);
      });
      sc.addEventListener('gestureend', () => { gesture = null; });
    }

    // Mouse: double-click toggles zoom, drag to move around a zoomed page.
    const onPage = (e) => {
      const r = page.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    sc.addEventListener('dblclick', (e) => {
      if (!onPage(e)) return; // the drag below captures the pointer, so the target is the scroller
      e.preventDefault();
      this.toggleZoomAt(e.clientX, e.clientY);
    });
    let drag = null;
    sc.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !page.contains(e.target)) return;
      if (sc.scrollWidth <= sc.clientWidth && sc.scrollHeight <= sc.clientHeight) return;
      drag = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop, id: e.pointerId };
      sc.setPointerCapture(e.pointerId);
      sc.classList.add('is-panning');
      e.preventDefault();
    });
    sc.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      sc.scrollLeft = drag.left - (e.clientX - drag.x);
      sc.scrollTop = drag.top - (e.clientY - drag.y);
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      sc.classList.remove('is-panning');
    };
    sc.addEventListener('pointerup', endDrag);
    sc.addEventListener('pointercancel', endDrag);
  }

  openZoom() {
    if (!this.flip) return;
    Object.assign(this.zoom, { open: true, page: this.flip.getCurrentPageIndex(), ratio: this.pageRatio });
    this.ui.zoomView.hidden = false;
    this.ui.zoom?.setAttribute('aria-pressed', 'true');
    this.layoutZoomPage();
    this.ui.zoomScroll.scrollTop = 0;
    this.ui.zoomScroll.scrollLeft = (this.ui.zoomScroll.scrollWidth - this.ui.zoomScroll.clientWidth) / 2;
    this.updateZoomUI(true);
    this.renderZoom();
    this.updateControls();
    this.ui.zoomScroll.focus({ preventScroll: true });
  }

  closeZoom() {
    if (!this.zoom.open) return;
    this.zoom.open = false;
    this.zoom.token += 1;
    clearTimeout(this.zoom.timer);
    this.zoom.task?.cancel();
    this.zoom.task = null;
    this.ui.zoomView.hidden = true;
    for (const old of this.ui.zoomPage.querySelectorAll('canvas')) { old.width = 0; old.height = 0; }
    this.ui.zoomPage.replaceChildren();
    this.ui.zoom?.setAttribute('aria-pressed', 'false');
    if (this.flip) this.goTo(this.zoom.page);
  }

  // Width of the page at 100%: the reader's width (minus padding), capped for very wide screens.
  zoomFitWidth() {
    const sc = this.ui.zoomScroll;
    const cs = getComputedStyle(sc);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    return Math.max(120, Math.min(sc.clientWidth - padX, ZOOM_FIT_MAX));
  }

  // Zoom at which the whole page is visible without scrolling.
  fitPageScale() {
    const sc = this.ui.zoomScroll;
    const cs = getComputedStyle(sc);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const w = Math.min(sc.clientWidth - padX, (sc.clientHeight - padY) * this.zoom.ratio);
    return clampZoom(w / this.zoomFitWidth());
  }

  zoomCssSize() {
    const width = Math.round(this.zoomFitWidth() * this.zoom.scale);
    return { width, height: Math.round(width / this.zoom.ratio) };
  }

  // Sizes the page box at once (the current canvas stretches to it); a sharp render follows.
  layoutZoomPage() {
    const { width, height } = this.zoomCssSize();
    const sc = this.ui.zoomScroll;
    this.ui.zoomPage.style.width = `${width}px`;
    this.ui.zoomPage.style.height = `${height}px`;
    sc.classList.toggle('can-pan', sc.scrollWidth > sc.clientWidth + 1 || sc.scrollHeight > sc.clientHeight + 1);
  }

  // Where a screen point falls on the page, as fractions of its width and height.
  zoomAnchor(clientX, clientY) {
    const sc = this.ui.zoomScroll;
    const page = this.ui.zoomPage;
    const rect = sc.getBoundingClientRect();
    return {
      px: (sc.scrollLeft + clientX - rect.left - page.offsetLeft) / (page.offsetWidth || 1),
      py: (sc.scrollTop + clientY - rect.top - page.offsetTop) / (page.offsetHeight || 1),
    };
  }

  // Zooms to `scale`, keeping the page point `anchor` under the screen point (clientX, clientY).
  zoomAround(scale, anchor, clientX, clientY) {
    const next = clampZoom(scale);
    const sc = this.ui.zoomScroll;
    const page = this.ui.zoomPage;
    this.zoom.scale = next;
    this.layoutZoomPage();
    const rect = sc.getBoundingClientRect();
    sc.scrollLeft = page.offsetLeft + anchor.px * page.offsetWidth - (clientX - rect.left);
    sc.scrollTop = page.offsetTop + anchor.py * page.offsetHeight - (clientY - rect.top);
    this.updateZoomUI();
    this.scheduleZoomRender();
    saveZoom(next);
  }

  // Zooms around a screen point, or the middle of the reader when none is given.
  setZoom(scale, point) {
    if (!this.zoom.open) return;
    const rect = this.ui.zoomScroll.getBoundingClientRect();
    const x = point ? point.x : rect.left + rect.width / 2;
    const y = point ? point.y : rect.top + rect.height / 2;
    this.zoomAround(scale, this.zoomAnchor(x, y), x, y);
  }

  stepZoom(direction) {
    const s = this.zoom.scale;
    const next = direction > 0
      ? ZOOM_STEPS.find((v) => v > s + 0.005) ?? ZOOM_MAX
      : [...ZOOM_STEPS].reverse().find((v) => v < s - 0.005) ?? ZOOM_MIN;
    this.setZoom(next);
  }

  toggleZoomAt(x, y) {
    this.setZoom(this.zoom.scale < 1.5 ? 2 : 1, { x, y });
  }

  updateZoomUI(force = false) {
    const { zoomRange, zoomInput, zoomIn, zoomOut } = this.ui;
    const s = this.zoom.scale;
    const pct = `${Math.round(s * 100)}%`;
    zoomRange.value = String(scaleToSlider(s));
    zoomRange.setAttribute('aria-valuetext', pct);
    if (force || document.activeElement !== zoomInput) zoomInput.value = pct;
    zoomOut.disabled = s <= ZOOM_MIN + 0.001;
    zoomIn.disabled = s >= ZOOM_MAX - 0.001;
  }

  scheduleZoomRender() {
    clearTimeout(this.zoom.timer);
    this.zoom.timer = setTimeout(() => this.renderZoom(), ZOOM_RENDER_DELAY);
  }

  async renderZoom() {
    const pdf = this.pdf;
    if (!pdf || !this.zoom.open) return;
    const token = ++this.zoom.token;
    this.zoom.task?.cancel();
    const { zoomPage } = this.ui;
    zoomPage.classList.add('is-loading');
    const canvas = document.createElement('canvas');
    try {
      const page = await pdf.getPage(this.zoom.page + 1);
      if (token !== this.zoom.token) return;
      const base = page.getViewport({ scale: 1 });
      const ratio = base.width / base.height;
      if (Math.abs(ratio - this.zoom.ratio) > 0.001) {
        this.zoom.ratio = ratio;
        this.layoutZoomPage();
      }
      const { width } = this.zoomCssSize();
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const pixelWidth = Math.min(width * dpr, Math.sqrt(ZOOM_MAX_PIXELS * ratio));
      const viewport = page.getViewport({ scale: pixelWidth / base.width });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      this.zoom.task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
      await this.zoom.task.promise;
      if (token !== this.zoom.token || pdf !== this.pdf) { canvas.width = 0; canvas.height = 0; return; }
      for (const old of zoomPage.querySelectorAll('canvas')) { old.width = 0; old.height = 0; }
      zoomPage.replaceChildren(canvas);
    } catch (err) {
      canvas.width = 0;
      canvas.height = 0;
      if (token === this.zoom.token && err?.name !== 'RenderingCancelledException') {
        console.warn('Er Idhazh flip book: zoomed page failed to render', err);
      }
    } finally {
      if (token === this.zoom.token) {
        zoomPage.classList.remove('is-loading');
        this.zoom.task = null;
      }
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
      this.ui.zoomScroll.scrollTop = 0; // keep the horizontal position: the next page's column lines up
      this.renderZoom();
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
      if (this.zoom.open && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.stepZoom(1); return; }
      if (this.zoom.open && (e.key === '-' || e.key === '_')) { e.preventDefault(); this.stepZoom(-1); return; }
      if (this.zoom.open && e.key === '0') { e.preventDefault(); this.setZoom(1); return; }
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
        if (this.zoom.open) { this.layoutZoomPage(); this.renderZoom(); }
        this.flip.getSettings().minWidth = this.portraitThreshold();
        this.flip.update();
        this.refresh();
      }, 200);
    });
  }
}
