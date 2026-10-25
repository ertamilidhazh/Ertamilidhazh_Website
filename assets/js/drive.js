// Reads the monthly issues straight from the public Google Drive folder.
import { CONFIG } from './config.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const CACHE_KEY = `er-issues:${CONFIG.FOLDER_ID}`;
const CACHE_MS = 10 * 60 * 1000;

export const TAMIL_MONTHS = [
  'ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்',
  'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்',
];

export class DriveError extends Error {
  constructor(kind, detail = '') {
    super(detail || kind);
    this.kind = kind;
  }
}

// What the reader sees for each failure, in Tamil with an English hint.
export const ERROR_TEXT = {
  'no-key': ['இதழ்களைக் காட்ட இணையதளம் இன்னும் Google Drive உடன் இணைக்கப்படவில்லை.', 'The site is not connected to Google Drive yet: the API key is missing in config.js.'],
  'bad-key': ['Google Drive இணைப்பு அமைப்பில் சிக்கல் உள்ளது.', 'The API key is invalid, the Drive API is not enabled, or the key is not allowed for this web address.'],
  'not-found': ['இந்த இதழ் கிடைக்கவில்லை.', 'The file was not found, or it is not shared as "Anyone with the link".'],
  forbidden: ['இந்த இதழைத் திறக்க அனுமதி இல்லை.', 'The file is not shared publicly in Google Drive.'],
  quota: ['இப்போது பலர் இந்த இதழைப் படிப்பதால் Drive தற்காலிகமாகப் பதிவிறக்கத்தை நிறுத்தியுள்ளது. சிறிது நேரம் கழித்து முயற்சிக்கவும், அல்லது Drive-இல் படிக்கவும்.', 'Google Drive download limit reached for now. Try again later or read it in Drive.'],
  network: ['இதழ்களை ஏற்ற முடியவில்லை. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.', 'Could not reach Google Drive. Check your connection and try again.'],
  'bad-pdf': ['இந்தக் கோப்பைத் திறக்க முடியவில்லை.', 'The file could not be opened as a PDF.'],
};

export const folderUrl = () => `https://drive.google.com/drive/folders/${CONFIG.FOLDER_ID}`;
export const viewUrl = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
export const thumbUrl = (id, width = 600) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`;
export const readerUrl = (id) => `read.html?id=${encodeURIComponent(id)}`;
// Google's own viewer; embeddable without an API key, used until the key is configured.
export const previewUrl = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
export const hasApiKey = () => Boolean(CONFIG.API_KEY);

// "2026-10.pdf" or "2026-10 அக்டோபர் இதழ்.pdf" → அக்டோபர் 2026
export function parseIssue(file) {
  const base = (file.name || '').replace(/\.pdf$/i, '').trim() || 'ஏர் இதழ்';
  const created = Date.parse(file.createdTime) || 0;
  const issue = { id: file.id, name: file.name, size: Number(file.size) || 0, created };
  const m = base.match(/^(\d{4})[-_. ](\d{1,2})(?!\d)/);
  const month = m ? Number(m[2]) : 0;

  if (m && month >= 1 && month <= 12) {
    const year = Number(m[1]);
    const monthName = TAMIL_MONTHS[month - 1];
    const rest = base.slice(m[0].length).replace(/^[\s\-–_.]+/, '').trim();
    return {
      ...issue,
      year,
      month,
      label: `${monthName} ${year}`,
      note: rest && !rest.includes(monthName) ? rest : '',
      sortKey: year * 100 + month,
    };
  }
  // Files that don't follow the naming pattern still show up, ordered by upload date.
  return { ...issue, year: new Date(created).getFullYear(), month: 0, label: base, note: '', sortKey: 0 };
}

const byNewest = (a, b) => b.sortKey - a.sortKey || b.created - a.created;

function classify(status, reason, message) {
  const text = `${reason} ${message}`;
  if (/quota|rateLimit/i.test(reason)) return 'quota';
  if (/keyInvalid|API key not valid|referer|referrer|accessNotConfigured|has not been used|is disabled|API_KEY/i.test(text)) return 'bad-key';
  if (status === 404) return 'not-found';
  if (status === 403 || status === 401) return 'forbidden';
  return 'network';
}

async function driveFetch(url, signal) {
  if (!CONFIG.API_KEY) throw new DriveError('no-key');
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new DriveError('network', err.message);
  }
  if (res.ok) return res;

  let reason = '';
  let message = '';
  try {
    const body = await res.json();
    reason = body.error?.errors?.[0]?.reason || body.error?.status || '';
    message = body.error?.message || '';
  } catch { /* non-JSON error body */ }
  throw new DriveError(classify(res.status, reason, message), `${res.status} ${reason} ${message}`.trim());
}

function readCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if (cached && Date.now() - cached.t < CACHE_MS) return cached.issues;
  } catch { /* storage blocked or empty */ }
  return null;
}

function writeCache(issues) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), issues }));
  } catch { /* storage blocked */ }
}

// Without an API key the folder can't be listed, so fall back to the hand-written list in config.js.
function configIssues() {
  return (CONFIG.ISSUES || []).filter((f) => f && f.id).map(parseIssue).sort(byNewest);
}

export async function listIssues() {
  if (!CONFIG.API_KEY) {
    const issues = configIssues();
    if (issues.length) return issues;
    throw new DriveError('no-key');
  }
  const cached = readCache();
  if (cached) return cached;

  const params = new URLSearchParams({
    q: `'${CONFIG.FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: 'files(id,name,createdTime,size)',
    pageSize: '1000',
    key: CONFIG.API_KEY,
  });
  const res = await driveFetch(`${API}?${params}`);
  const { files = [] } = await res.json();
  const issues = files.map(parseIssue).sort(byNewest);
  writeCache(issues);
  return issues;
}

export async function getIssue(id) {
  if (!CONFIG.API_KEY) {
    return configIssues().find((issue) => issue.id === id) || parseIssue({ id, name: '' });
  }
  const params = new URLSearchParams({ fields: 'id,name,createdTime,size,mimeType', key: CONFIG.API_KEY });
  const res = await driveFetch(`${API}/${encodeURIComponent(id)}?${params}`);
  const file = await res.json();
  if (file.mimeType && file.mimeType !== 'application/pdf') throw new DriveError('bad-pdf', file.mimeType);
  return parseIssue(file);
}

// Downloads the whole PDF, reporting progress from 0 to 1.
// Browsers can only fetch Drive file bytes cross-site through the Drive API, so this needs the API key.
export async function downloadPdf(issue, onProgress, signal) {
  const params = new URLSearchParams({ alt: 'media', key: CONFIG.API_KEY });
  const res = await driveFetch(`${API}/${encodeURIComponent(issue.id)}?${params}`, signal);
  return readBody(res, issue.size, onProgress);
}

async function readBody(res, size, onProgress) {
  const total = Number(res.headers.get('content-length')) || size;

  if (!res.body || !total) {
    const data = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return data;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(received / total, 1));
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}
