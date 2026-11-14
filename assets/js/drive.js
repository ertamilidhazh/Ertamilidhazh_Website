// Reads the monthly issues that the "Sync issues from Google Drive" GitHub Action
// copies from Drive into issues/ (see scripts/sync_issues.py). Everything loads
// from this website's own address, so readers never depend on Google Drive.
import { CONFIG } from './config.js';

const MANIFEST = 'issues/issues.json';

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
  'not-synced': ['இதழ்கள் இன்னும் இணையதளத்தில் சேர்க்கப்படவில்லை. சிறிது நேரம் கழித்து மீண்டும் பார்க்கவும்.', 'The issues have not been copied to the website yet. Please check back shortly.'],
  'not-found': ['இந்த இதழ் கிடைக்கவில்லை.', 'This issue was not found. It may have been removed.'],
  network: ['இதழை ஏற்ற முடியவில்லை. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.', 'Could not load the issue. Check your connection and try again.'],
  'bad-pdf': ['இந்தக் கோப்பைத் திறக்க முடியவில்லை.', 'The file could not be opened as a PDF.'],
};

export const folderUrl = () => `https://drive.google.com/drive/folders/${CONFIG.FOLDER_ID}`;
export const viewUrl = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
export const readerUrl = (id) => `read.html?id=${encodeURIComponent(id)}`;

// Adds the sync's content hash, so a replaced PDF or cover is never served from a stale browser cache.
const versioned = (url, hash) => (url && hash ? `${url}?v=${encodeURIComponent(hash)}` : url);

// "2026-10.pdf" or "2026-10 அக்டோபர் இதழ்.pdf" → அக்டோபர் 2026
export function parseIssue(file) {
  const base = (file.name || '').replace(/(\.pdf)+$/i, '').trim() || 'ஏர் இதழ்'; // "x.pdf.pdf" → "x"
  const created = Date.parse(file.createdTime) || 0;
  const issue = {
    id: file.id,
    name: file.name,
    size: Number(file.size) || 0,
    created,
    file: versioned(file.file, file.hash),
    cover: versioned(file.cover || '', file.hash),
  };
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
  return { ...issue, year: new Date(created || Date.now()).getFullYear(), month: 0, label: base, note: '', sortKey: 0 };
}

const byNewest = (a, b) => b.sortKey - a.sortKey || b.created - a.created;

let manifest = null;

export function listIssues() {
  manifest ||= (async () => {
    let res;
    try {
      res = await fetch(MANIFEST, { cache: 'no-cache' });
    } catch (err) {
      throw new DriveError('network', err.message);
    }
    if (res.status === 404) throw new DriveError('not-synced');
    if (!res.ok) throw new DriveError('network', `${res.status}`);
    const { issues = [] } = await res.json();
    return issues.filter((f) => f && f.id && f.file).map(parseIssue).sort(byNewest);
  })();
  manifest.catch(() => { manifest = null; }); // let a retry fetch again
  return manifest;
}

export async function getIssue(id) {
  const issue = (await listIssues()).find((i) => i.id === id);
  if (!issue) throw new DriveError('not-found', id);
  return issue;
}

// Downloads the whole PDF from this website, reporting progress from 0 to 1.
export async function downloadPdf(issue, onProgress, signal) {
  let res;
  try {
    res = await fetch(issue.file, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new DriveError('network', err.message);
  }
  if (res.status === 404) throw new DriveError('not-found', issue.file);
  if (!res.ok) throw new DriveError('network', `${res.status}`);

  const total = Number(res.headers.get('content-length')) || issue.size;
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
