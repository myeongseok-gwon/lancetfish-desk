import fs from 'node:fs';
import readline from 'node:readline';

export function streamLines(file, onLine) {
  return new Promise((resolve) => {
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }); } catch { return resolve(); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let stopped = false;
    rl.on('line', (line) => {
      if (stopped) return;
      if (onLine(line) === false) { stopped = true; rl.close(); stream.destroy(); }
    });
    rl.on('close', resolve);
    stream.on('error', () => resolve());
  });
}

export const TOOL_CAP = 20 * 1024;
export const DOC_CAP = 200 * 1024;
export const SESSION_CAP = 2 * 1024 * 1024;
export const MSG_INDEX_CAP = 4000;
export const SESSION_INDEX_CAP = 200000;

export function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : (b && (b.text || b.input_text || '')) || '')).join('\n');
}

export function cleanPrompt(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, '')

    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<\/?command-(name|args)>/g, ' ')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .trim();
}
