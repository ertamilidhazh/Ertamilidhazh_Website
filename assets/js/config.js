// இணையதள அமைப்புகள் · Site settings
// This is the only file you need to edit. See README.md for details.

export const CONFIG = {
  // Google Drive folder that holds the monthly issue PDFs.
  // Share it as "Anyone with the link → Viewer".
  FOLDER_ID: '1xZP665MnxgkRv113o1D-2g6--DwAEWgv',

  // Google API key, restricted to the Google Drive API and this website's address.
  // With a key: every PDF in the folder appears automatically and opens as a flip book.
  // Without a key: only the issues listed below appear, shown in Google's Drive viewer.
  API_KEY: 'AIzaSyCipb0wNjucMz_GVMIpRXCy8Y26n47O3x4',

  // Used only while API_KEY is empty: list each issue by hand.
  // id = the long code in the file's share link: drive.google.com/file/d/<id>/view
  // name = the file name, "YYYY-MM.pdf", which sets the month shown on the site.
  ISSUES: [
    { id: '18XPWqz27-A4XoW-AnUKWy75P2VgfPy0j', name: '2026-10.pdf' },
  ],
};
