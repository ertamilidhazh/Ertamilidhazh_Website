import { getIssue, listIssues, readerUrl, viewUrl } from './drive.js';
import { Flipbook, fillIssueSelect } from './flipbook.js';

const $ = (id) => document.getElementById(id);

async function init() {
  const select = $('issue-select');
  const driveLink = $('open-drive');
  const viewer = new Flipbook($('viewer'), {
    keyboardTarget: document,
    fullscreenTarget: document.documentElement,
  });

  const show = (issue) => {
    document.title = `${issue.label} இதழ் – ஏர் தமிழ் இதழ்`;
    driveLink.href = viewUrl(issue.id);
    driveLink.hidden = false;
    viewer.open(issue);
  };

  const id = new URLSearchParams(window.location.search).get('id');
  let issues = [];
  let listError = null;
  try {
    issues = await listIssues();
  } catch (err) {
    listError = err;
  }

  let issue = id ? issues.find((i) => i.id === id) : issues[0];
  if (!issue && id) {
    try {
      issue = await getIssue(id);
      issues = [...issues, issue];
    } catch (err) {
      viewer.showError(err, { id, label: '' });
      return;
    }
  }
  if (!issue) {
    if (listError) {
      viewer.showError(listError);
    } else {
      viewer.setStatus('முதல் இதழ் விரைவில் வெளியாகும்.', 'The first issue is coming soon.');
      viewer.setActions(viewer.action('முகப்புப் பக்கத்திற்கு', { href: 'index.html' }));
    }
    select.replaceChildren(new Option('இதழ்கள் இல்லை'));
    return;
  }

  fillIssueSelect(select, issues, issue.id);
  select.addEventListener('change', () => {
    const next = issues.find((i) => i.id === select.value);
    if (!next) return;
    window.history.replaceState(null, '', readerUrl(next.id));
    show(next);
  });
  show(issue);
}

init();
