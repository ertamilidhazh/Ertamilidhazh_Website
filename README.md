# ஏர் – தமிழ் இதழ் · இணையதளம் (Website)

**Live:** https://ertamilidhazh.github.io/Ertamilidhazh_Website/

ஏர் தமிழ் இதழுக்கான நிலையான (static) இணையதளம். மாத இதழ்களின் PDF கோப்புகளை Google Drive கோப்புறையிலிருந்து நேரடியாக எடுத்து, பக்கம் புரட்டும் (flip book) வடிவில் காட்டும்.

A static website for Er Tamil Idhazh. It reads each month's issue PDF straight from a Google Drive folder and shows it as a page-turning flip book. There is no build step and no server code.

```
(repository root = website root, served by GitHub Pages)
  index.html             home: hero, flip book + issue dropdown, about, board, submission, details, contact
  read.html              full-page reader with the same dropdown (read.html?id=<Drive file id>, no id = latest)
  404.html
  assets/css/style.css
  assets/js/config.js    ← the only file you edit (folder id + API key)
  assets/js/drive.js     Google Drive API calls and file-name parsing
  assets/js/flipbook.js  the flip-book viewer (PDF.js + StPageFlip), shared by both pages
  assets/js/home.js      hero cover, issue dropdown, embedded viewer
  assets/js/reader.js    full-page reader
  assets/img/            logo sizes, favicon, share card, editor photos
```

---

## 1. மாதந்தோறும் இதழ் பதிவேற்றுவது (Monthly upload)

1. இதழின் PDF கோப்புக்கு இந்த வடிவில் பெயர் வையுங்கள்: **`ஆண்டு-மாதம்.pdf`**
   - `2026-10.pdf` → இணையதளத்தில் **அக்டோபர் 2026** எனக் காட்டும்
   - `2026-11 சிறப்பிதழ்.pdf` → **நவம்பர் 2026**, கீழே "சிறப்பிதழ்" எனக் குறிப்பு
2. கோப்பை Google Drive-இல் உள்ள இதழ் கோப்புறையில் பதிவேற்றுங்கள்.
3. அவ்வளவுதான். இணையதளத்தில் தானாகவே புதிய இதழ் "நடப்பு இதழ்" ஆகத் திறக்கும்; பழைய இதழ்கள் "இதழைத் தேர்ந்தெடுக்க" பட்டியலில் (dropdown) வரும். அட்டைப் படம் தோன்ற Drive-க்குச் சில நிமிடங்கள் ஆகலாம்.
   (API key அமைக்கப்படும் வரை, `config.js`-இல் உள்ள `ISSUES` பட்டியலில் கோப்பைச் சேர்க்க வேண்டும். கீழே 2.5 பார்க்கவும்.)

குறிப்புகள்:
- PDF அளவை **25 MB-க்குள்** வைத்தால் கைப்பேசியிலும் விரைவாகத் திறக்கும்.
- ஒரு இதழை நீக்க, Drive-இலிருந்து அந்தக் கோப்பை நீக்குங்கள் (Trash).
- பெயர் வடிவம் பின்பற்றப்படாத கோப்புகளும் காட்டப்படும், ஆனால் பதிவேற்றிய தேதியின்படி வரிசையில் கடைசியாக வரும்.

**English:** name the PDF `YYYY-MM.pdf` (optionally followed by a note, e.g. `2026-11 சிறப்பிதழ்.pdf`) and drop it in the Drive folder.
- **With the API key set** (section 2.2), the site lists the folder live.
  - The newest issue opens as a flip book in the "இதழ்கள்" section of the home page.
  - Every older issue is in the dropdown above it; picking one loads that issue's flip book in place.
  - The link updates (`?id=…`), so a specific issue can be shared.
- **Before the key is set**, see section 2.5.

---

## 2. ஒருமுறை மட்டும் செய்ய வேண்டிய அமைப்பு (One-time setup)

### 2.1 Share the Drive folder publicly

Open the folder → **Share** → *General access* → **Anyone with the link** → role **Viewer** → Done.
Files uploaded into the folder inherit this, so each new issue is readable by the site. Right now the folder is private, and the site cannot see it until this is done.

### 2.2 Create a Google API key (free; required for the flip book)

Browsers are only allowed to download a Drive file's contents from another website through the official Drive API, and the API needs a key. Without one, the site can still show issues, but only in Google's own scrolling viewer (see 2.5).

1. Go to <https://console.cloud.google.com/> and create a project, for example "Er Idhazh Website".
2. **APIs & Services → Library**: search for **Google Drive API** and click **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Click the new key to restrict it:
   - **Application restrictions → Websites**, then add:
     - `http://localhost:8765/*`
     - `http://127.0.0.1:8765/*`
     - `https://ertamilidhazh.github.io/*` (and your custom domain later, if any)
   - **API restrictions → Restrict key → Google Drive API**
   - Save.
5. Paste the key into [assets/js/config.js](assets/js/config.js):

   ```js
   API_KEY: 'AIza…your key…',
   ```

The key is visible to anyone who views the page source. That is normal for browser API keys, and the restrictions above stop it being used from other websites or for other APIs. It can only read files that are already public.

### 2.3 Try it locally

```sh
python -m http.server 8765
```

Open <http://localhost:8765>. Without a key, the issues section explains that Drive isn't connected yet; the rest of the site still works.

### 2.4 Publish on GitHub Pages

The site lives in the repository <https://github.com/ertamilidhazh/Ertamilidhazh_Website>, with `index.html` at the top level.

1. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)`** → Save.
2. After a minute or two, the site is live at <https://ertamilidhazh.github.io/Ertamilidhazh_Website/>.
3. Make sure `https://ertamilidhazh.github.io/*` is in the API key's website restrictions (step 2.2).

Any later change is published by committing to `main`. GitHub Pages redeploys automatically. New issues don't need a commit at all, because they come from Drive.

### 2.5 Until the API key is set up

The site falls back to the `ISSUES` list in `config.js`, and shows each issue in Google Drive's own viewer: it scrolls rather than flips, but it is readable. To add a month:

1. Share the PDF ("Anyone with the link").
2. Copy its ID from the share link, the part between `/d/` and `/view`.
3. Add a line to `config.js`:

```js
ISSUES: [
  { id: '18XPWqz27-A4XoW-AnUKWy75P2VgfPy0j', name: '2026-11.pdf' },
  { id: '<next file id>', name: '2026-12.pdf' },
],
```

Once `API_KEY` is filled in, this list is ignored. Every PDF in the folder then appears automatically and opens as a flip book.

### 2.6 Link previews

`index.html` and `read.html` already point `og:image`, `og:url` and `canonical` at the GitHub Pages address, so WhatsApp and Facebook link previews show the logo card. If you move to a custom domain, update those lines and `sitemap.xml`.

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
| "இணையதளம் இன்னும் Google Drive உடன் இணைக்கப்படவில்லை" | `API_KEY` is empty in `config.js`. |
| "Google Drive இணைப்பு அமைப்பில் சிக்கல்" | The key is wrong, the Drive API isn't enabled, or the site's address isn't in the key's website list. |
| "முதல் இதழ் விரைவில்" even though PDFs exist | The folder isn't shared as *Anyone with the link*, or `FOLDER_ID` is wrong. |
| "இந்த இதழ் கிடைக்கவில்லை" in the reader | That file was deleted or isn't public. |
| Download limit message | Google Drive temporarily limits very popular files; readers can still open it in Drive with the button shown. |
| Cover shows the logo instead of the first page | Drive hasn't made a thumbnail yet; wait a few minutes. |

Libraries (loaded from jsDelivr, pinned): PDF.js 4.10.38, StPageFlip (page-flip) 2.0.7. Fonts: Arima and Hind Madurai from Google Fonts.
