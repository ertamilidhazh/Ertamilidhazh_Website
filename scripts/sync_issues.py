"""Copy the monthly issue PDFs from the public Google Drive folder into issues/.

Runs in GitHub Actions (see .github/workflows/sync-issues.yml). The website then
reads issues/issues.json and the PDFs from its own address, so visitors never
download from Google Drive and no API key is needed in the browser.

Listing:  Drive API with GDRIVE_API_KEY if set, else the folder's public HTML view.
Download: Drive API (key) first, then the public download link; retried with backoff.
Covers:   first page rendered to issues/<id>.jpg when PyMuPDF is installed.
Only new or changed files are downloaded; files removed from Drive are removed here.
"""

import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

FOLDER_ID = os.environ.get('GDRIVE_FOLDER_ID', '1xZP665MnxgkRv113o1D-2g6--DwAEWgv')
API_KEY = os.environ.get('GDRIVE_API_KEY', '').strip()
OUT = Path(__file__).resolve().parent.parent / 'issues'
MANIFEST = OUT / 'issues.json'
UA = 'Mozilla/5.0 (compatible; ErIdhazhSync/1.0; +https://ertamilidhazh.github.io/Ertamilidhazh_Website/)'
ATTEMPTS = int(os.environ.get("SYNC_ATTEMPTS", "3"))


def get(url, *, accept_html=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=120) as res:
        body = res.read()
        if not accept_html and 'text/html' in res.headers.get('Content-Type', ''):
            raise RuntimeError('got an HTML page instead of a file (Google may be rate-limiting)')
        return body


def list_with_api():
    params = urllib.parse.urlencode({
        'q': f"'{FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false",
        'fields': 'files(id,name,createdTime,modifiedTime,size,md5Checksum)',
        'pageSize': '1000',
        'key': API_KEY,
    })
    data = json.loads(get(f'https://www.googleapis.com/drive/v3/files?{params}'))
    return [{
        'id': f['id'],
        'name': f['name'],
        'createdTime': f.get('createdTime', ''),
        'version': f.get('md5Checksum') or f.get('modifiedTime', ''),
    } for f in data.get('files', [])]


def list_public():
    page = get(f'https://drive.google.com/embeddedfolderview?id={FOLDER_ID}', accept_html=True).decode('utf-8')
    files = []
    for entry in re.findall(r'<div class="flip-entry" id="entry-([\w-]+)".*?flip-entry-title">([^<]*)<.*?flip-entry-last-modified"><div>([^<]*)<', page, re.S):
        file_id, name, modified = entry
        name = html.unescape(name).strip()
        if name.lower().endswith('.pdf'):
            files.append({'id': file_id, 'name': name, 'createdTime': '', 'version': modified})
    if not files and 'flip-entry' not in page:
        # An empty folder looks the same as a broken page, so stop rather than wipe every issue off the site.
        raise RuntimeError('the Drive folder looks empty, or it is not shared as "Anyone with the link". '
                           'The website was left unchanged; upload at least one PDF and run again.')
    return files


def download(file_id):
    urls = []
    if API_KEY:
        urls.append(f'https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&key={API_KEY}')
    urls.append(f'https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t')
    last = None
    for attempt in range(ATTEMPTS):
        for url in urls:
            try:
                data = get(url)
                if data[:5] == b'%PDF-':
                    return data
                last = RuntimeError('downloaded data is not a PDF')
            except (urllib.error.URLError, RuntimeError, TimeoutError) as err:
                last = err
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(f'download failed for {file_id}: {last}')


def render_cover(pdf_path, jpg_path):
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return False
    with fitz.open(pdf_path) as doc:
        page = doc[0]
        zoom = 600 / page.rect.width
        page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False).save(jpg_path, jpg_quality=82)
    return True


def main():
    OUT.mkdir(exist_ok=True)
    previous = {}
    if MANIFEST.exists():
        previous = {i['id']: i for i in json.loads(MANIFEST.read_text(encoding='utf-8')).get('issues', [])}

    try:
        files = list_with_api() if API_KEY else list_public()
    except Exception as err:  # noqa: BLE001 - fall back to the public view on any API problem
        if not API_KEY:
            raise
        print(f'Drive API listing failed ({err}); using the public folder view', file=sys.stderr)
        files = list_public()
    print(f'Drive folder has {len(files)} PDF(s)')

    issues, failures = [], []
    for f in files:
        pdf = OUT / f'{f["id"]}.pdf'
        jpg = OUT / f'{f["id"]}.jpg'
        old = previous.get(f['id'])
        unchanged = old and old.get('version') == f['version'] and pdf.exists()
        if not unchanged:
            try:
                data = download(f['id'])
            except RuntimeError as err:
                print(f'::warning::{f["name"]}: {err}')
                failures.append(f['name'])
                if old and pdf.exists():
                    issues.append(old)  # keep serving the copy we already have
                continue
            if pdf.exists() and pdf.read_bytes() == data:
                # Only Drive's "last modified" label changed (e.g. "12:49 am" became "Nov 14").
                print(f'  = {f["name"]} (content unchanged)')
            else:
                tmp = pdf.with_suffix('.part')
                tmp.write_bytes(data)
                tmp.replace(pdf)
                print(f'  + {f["name"]} ({len(data) // 1024} KB)')
                jpg.unlink(missing_ok=True)  # the old cover belongs to the old file
                old = None  # forces a new content hash below
        has_cover = jpg.exists() or render_cover(pdf, jpg)
        # Content hash: the site adds it to the PDF/cover URLs so browsers never show a stale cached copy.
        digest = (old or {}).get('hash') or hashlib.sha256(pdf.read_bytes()).hexdigest()[:16]
        issues.append({
            'id': f['id'],
            'name': f['name'],
            'createdTime': f['createdTime'] or (old or {}).get('createdTime', ''),
            'version': f['version'],
            'size': pdf.stat().st_size,
            'hash': digest,
            'file': f'issues/{pdf.name}',
            'cover': f'issues/{jpg.name}' if has_cover else '',
        })

    keep = {i['id'] for i in issues}
    for path in OUT.glob('*'):
        if path.suffix in ('.pdf', '.jpg', '.part') and path.stem not in keep:
            path.unlink()
            print(f'  - removed {path.name}')

    MANIFEST.write_text(json.dumps({'issues': issues}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if failures:
        raise RuntimeError(f'could not download {", ".join(failures)}; it will be retried on the next run')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as err:
        # "::error::" shows the reason on the run's summary page instead of just "exit code 1".
        print(f'::error title=Drive sync stopped::{err}')
        sys.exit(1)
