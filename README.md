# ஏர் – தமிழ் இதழ் · இணையதளம் (Website)

**Live:** https://ertamilidhazh.github.io/Ertamilidhazh_Website/

ஏர் தமிழ் இதழுக்கான நிலையான (static) இணையதளம். மாத இதழ்களின் PDF கோப்புகள் Google Drive கோப்புறையிலிருந்து ஒவ்வொரு மணி நேரமும் தானாக இணையதளத்திற்கு நகலெடுக்கப்பட்டு, பக்கம் புரட்டும் (flip book) வடிவில் காட்டப்படும்.

A static website for Er Tamil Idhazh. A GitHub Action copies each month's issue PDF from a Google Drive folder into the site every hour. The site shows it as a page-turning flip book with a zoom-to-read view. Visitors load everything from the website itself, so nothing depends on Google Drive while someone is reading.

```
(repository root = website root, served by GitHub Pages)
  index.html                     home: hero, flip book + issue dropdown, about, board, submission, details, contact
  read.html                      full-page reader with the same dropdown (read.html?id=<Drive file id>, no id = latest)
  issues/                        PDFs, cover images and issues.json, written only by the sync Action
  scripts/sync_issues.py         copies new/changed PDFs from Drive, renders covers, removes deleted ones
  .github/workflows/sync-issues.yml   runs the sync every hour and on demand
  assets/js/config.js            Drive folder id
  assets/js/drive.js             reads issues/issues.json, file-name → month parsing
  assets/js/flipbook.js          flip-book + zoom viewer (PDF.js + StPageFlip), shared by both pages
  assets/js/home.js, reader.js   page scripts
  assets/css/style.css, assets/img/
```

---

## 1. மாதந்தோறும் இதழ் பதிவேற்றுவது (Monthly upload)

1. இதழின் PDF கோப்புக்கு இந்த வடிவில் பெயர் வையுங்கள்: **`ஆண்டு-மாதம்.pdf`**
   - `2026-12.pdf` → இணையதளத்தில் **டிசம்பர் 2026** எனக் காட்டும்
   - `2027-01 சிறப்பிதழ்.pdf` → **ஜனவரி 2027**, கீழே "சிறப்பிதழ்" எனக் குறிப்பு
2. கோப்பை Google Drive-இல் உள்ள **Article Archive** கோப்புறையில் பதிவேற்றுங்கள்.
3. ஒரு மணி நேரத்திற்குள் அது இணையதளத்தில் "நடப்பு இதழ்" ஆகத் தோன்றும். உடனே வேண்டுமெனில்: GitHub → **Actions** → **Sync issues from Google Drive** → **Run workflow**.

குறிப்புகள்:
- PDF அளவை **25 MB-க்குள்** வைத்தால் கைப்பேசியிலும் விரைவாகத் திறக்கும்.
- ஒரு இதழை நீக்க, Drive-இலிருந்து அந்தக் கோப்பை நீக்குங்கள்; அடுத்த ஒத்திசைவில் இணையதளத்திலிருந்தும் நீங்கும்.
- ஒரு இதழைத் திருத்த, அதே பெயரில் புதிய PDF-ஐப் பதிவேற்றுங்கள் (பழையதை நீக்கிவிட்டு).

**English:**
- Name the PDF `YYYY-MM.pdf`, optionally followed by a note (e.g. `2027-01 சிறப்பிதழ்.pdf`), and upload it to the Drive folder.
- Within the hour, the sync copies it into the site. The newest issue opens as the flip book on the home page, and older issues are in the dropdown.
- To publish immediately, open **Actions → Sync issues from Google Drive → Run workflow** on GitHub.

---

## 2. How the sync works (one-time setup is already done)

- The Drive folder is shared as *Anyone with the link → Viewer*. Keep it that way; the sync reads it as a public folder.
- Every hour, the workflow runs [scripts/sync_issues.py](scripts/sync_issues.py):
  - Lists the folder's PDFs.
  - Downloads new or changed ones into `issues/`.
  - Renders each cover to a JPEG.
  - Deletes files removed from Drive.
  - Writes `issues/issues.json`.
- If anything changed, the workflow commits it and GitHub Pages redeploys.
- **Optional API key:**
  - Without a key, the script uses Drive's public folder view and download links.
  - For extra reliability, add a key as a repository secret: **Settings → Secrets and variables → Actions → New repository secret**, name `GDRIVE_API_KEY`.
  - Create that key in Google Cloud with **API restrictions: Google Drive API** and **Application restrictions: None**. It stays private in GitHub, so it doesn't need website restrictions.
  - **Never put an API key in the website files.**
- If Google rate-limits a download, the run is marked failed and the file is retried on the next hour. Issues already on the site keep working.

Run the sync yourself (Python 3; `pip install pymupdf` for covers):

```sh
python scripts/sync_issues.py
python -m http.server 8765      # then open http://localhost:8765
```

Any change pushed to `main` is published by GitHub Pages automatically.

`index.html` and `read.html` point `og:image`, `og:url` and `canonical` at the GitHub Pages address, so WhatsApp and Facebook link previews show the logo card. If you move to a custom domain, update those lines and `sitemap.xml`.

---

## 3. Content notes

All text comes from `Er Idhazh 19-10-2026.docx`, with these later changes:

- "சக நலிஞர்கள் மதிப்பாய்வு" was written as **"சக அறிஞர்கள் மதிப்பாய்வு"** (Peer reviewed).
- The bank account, copyright and website address fields were empty in the document:
  - The bank row is left out.
  - The footer reads "© 2026 ஏர் – தமிழ் இதழ்".
- The editorial board shows names, roles and affiliations only. Personal emails and phone numbers are deliberately not published; the magazine's email is the public contact.
- Subscription prices and the journal "type" line were removed on request (November 2026).
- To change any text, edit `index.html` directly. Each section is clearly marked by its heading.

## 4. Troubleshooting

| What you see | Cause and fix |
|---|---|
| A new issue hasn't appeared | Wait for the hourly run or press **Run workflow**. Check the run's log on the Actions tab; a failed download is retried next hour. |
| "இதழ்கள் இன்னும் இணையதளத்தில் சேர்க்கப்படவில்லை" | `issues/issues.json` doesn't exist yet. Run the workflow once. |
| Wrong month shown | Rename the PDF in Drive to `YYYY-MM.pdf`; the next sync updates the label. |
| Cover shows the logo instead of the first page | The sync couldn't render it; it retries on the next run. |
| Actions stopped running | GitHub pauses scheduled workflows after 60 days with no repository activity. Open Actions and re-enable the workflow. |

Libraries (loaded from jsDelivr, pinned): PDF.js 4.10.38, StPageFlip (page-flip) 2.0.7. Fonts: Arima and Hind Madurai from Google Fonts.
