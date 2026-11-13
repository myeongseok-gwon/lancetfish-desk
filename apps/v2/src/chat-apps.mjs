import { execFile } from 'node:child_process';
import { settings } from './settings.mjs';
import { stat } from './util.mjs';

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10000 }, (err) => err ? reject(new Error('Could not open the app or copy the PDF. Check that the app is installed.')) : resolve()));

export function paperPrompt(p) {
  return `I am reading ${p.title}\nAuthors: ${p.authors.join(', ')}\nYear: ${p.year || 'unverified'}\n${p.doi ? `DOI: ${p.doi}\n` : ''}Library paper ID: ${p.id}\n\nPlease read the attached PDF. Give me the research question, method, main findings and limitations, with page references. Distinguish what the paper says from your interpretation. Keep this paper ID in any notes or slide drafts so I can link them back.`;
}

export async function askPaper(p, app) {
  const name = { chatgpt: 'ChatGPT', claude: 'Claude' }[app];
  if (!name) throw new Error('Choose ChatGPT or Claude');
  if (process.platform !== 'darwin') throw new Error('Opening desktop apps requires macOS. Download the PDF and use the web app.');
  if (!settings().apps.find((a) => a.id === app)?.enabled) throw new Error('Enable this app in Settings first');
  if (!p?.pdfPath || !stat(p.pdfPath)?.isFile()) throw new Error('No PDF on disk for this paper');
  await run('/usr/bin/osascript', ['-e', 'on run argv\nset the clipboard to (POSIX file (item 1 of argv))\nend run', p.pdfPath]);
  await run('/usr/bin/open', ['-a', name]);
  return { app: name, copied: 'pdf', message: `PDF copied. Paste it into ${name}, then save the conversation URL here.` };
}
