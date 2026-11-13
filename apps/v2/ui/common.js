export const CLIENT = await fetch('/api/client-config').then((r) => r.ok ? r.json() : {}).catch(() => ({}));
export const TZ = CLIENT.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const S = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ICONS = {
  mark: S('<path d="M3 12c3.5-5 9-6.5 14-3.5l4-2.5-1.5 5.5 1.5 5.5-4-2.5C12 17.5 6.5 17 3 12z"/><circle cx="8" cy="11" r="0.9" fill="currentColor"/>'),
  search: S('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  ext: S('<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>'),
  highlights: S('<path d="M15 4l5 5-9 9H6v-5z"/><path d="M4 21h8"/>'),
  'claude-code': S('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>'),
  codex: S('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
  science: S('<path d="M9.5 3h5M10 3v6L4.8 18.2A1.9 1.9 0 0 0 6.5 21h11a1.9 1.9 0 0 0 1.7-2.8L14 9V3"/><path d="M7.5 15h9"/>'),
  marlin: S('<path d="M2.5 12c3-4 7.5-5.5 12-3l6.5-3.5-2 6.5 2 6.5-6.5-3.5c-4.5 2.5-9 1-12-3z"/><circle cx="7" cy="11.2" r="0.8" fill="currentColor"/>'),
  web: S('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.5 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.5-3.6-8.5S9.5 6.1 12 3.5z"/>'),
  'claude.ai': S('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.5 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.5-3.6-8.5S9.5 6.1 12 3.5z"/>'),
  chatgpt: S('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.5 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.5-3.6-8.5S9.5 6.1 12 3.5z"/>'),
  decks: S('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M12 16.5V20M8.5 20h7"/>'),
  deck: S('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M12 16.5V20M8.5 20h7"/>'),
  notes: S('<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 16h5"/>'),
  note: S('<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 16h5"/>'),
  paper: S('<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>'),
  highlight: S('<path d="M15 4l5 5-9 9H6v-5z"/><path d="M4 21h8"/>'),
  pdf: S('<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M9 14h6M12 11v6"/>'),
  book: S('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>'),
  quote: S('<path d="M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6"/>'),
  copy: S('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  check: S('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  pause: S('<path d="M9 5v14M15 5v14"/>'),
  play: S('<path d="M7 5l12 7-12 7z"/>'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  trash: S('<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>'),
  chev: S('<path d="M9 6l6 6-6 6"/>'),
  inbox: S('<path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>'),
  library: S('<path d="M5 4v16M10 4v16M15 5l4.5 14.5"/>'),
  dashboard: S('<circle cx="12" cy="13" r="8"/><path d="M12 13l3.5-3.5M12 5V3"/>'),
  sparkle: S('<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5L9 15M15 9l2.5-2.5"/>'),
  link: S('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  warn: S('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>'),
  edit: S('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  table: S('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17M3.5 14.5h17M9.5 5v14"/>'),
  image: S('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 3.5 3 3-2.5 5 4"/>'),
  chat: S('<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16h-6.5L8 19.5V16H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 5z"/>'),
  folder: S('<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
};
export const icon = (name, cls = '') => `<span class="icon ${cls}" aria-hidden="true">${ICONS[name] || ICONS.paper}</span>`;

export const APP_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', science: 'Claude Science', marlin: 'Marlin', 'claude.ai': 'Claude', chatgpt: 'ChatGPT', web: 'Claude or ChatGPT' };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function snippetHTML(s) {
  return esc(String(s || '').replace(/\s+/g, ' ').trim()).replace(//g, '<b class="hit">').replace(//g, '</b>');
}

export function firstAuthor(authors) {
  if (!authors || !authors.length) return '';
  const last = (n) => { const p = String(n).trim().split(/\s+/); return p[p.length - 1]; };
  if (authors.length === 1) return last(authors[0]);
  if (authors.length === 2) return `${last(authors[0])} and ${last(authors[1])}`;
  return `${last(authors[0])} et al.`;
}

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
export const timeOf = (ms) => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
export const dayOf = (ms) => fmt({ weekday: 'short' }).format(new Date(ms));
export const dateOf = (ms) => fmt({ month: 'short', day: 'numeric' }).format(new Date(ms));
export const dateYearOf = (ms) => fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(ms));
export const dayKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

export function when(ms) {
  if (!ms) return '';
  const t = typeof ms === 'number' ? ms : Date.parse(ms);
  if (!t) return '';
  const now = Date.now();
  if (dayKey(t) === dayKey(now)) return `today ${timeOf(t)}`;
  if (dayKey(t) === dayKey(now - 86400000)) return 'yesterday';
  if (now - t < 6 * 86400000) return dayOf(t);
  const y = fmt({ year: 'numeric' }).format(new Date(t));
  return y === fmt({ year: 'numeric' }).format(new Date(now)) ? dateOf(t) : dateYearOf(t);
}

export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

let toastEl;
export function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

export async function copyText(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(label); } catch { toast('Copy failed'); }
    ta.remove();
  }
}

let tipEl;
export function enableTips(root = document) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl); }
  root.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    tipEl.textContent = t.dataset.tip;
    tipEl.classList.add('show');
    const r = t.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    let y = r.top - h - 8;
    if (y < 8) y = r.bottom + 8;
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
  });
  root.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) tipEl.classList.remove('show'); });
}

export function md(text) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  for (const block of String(text || '').split(/\n{2,}/)) {
    const lines = block.split('\n');

    if (lines.length >= 2 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l)) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(lines[0]);
      const body = lines.slice(2).map(cells);
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (lines.every((l) => /^\s*[-*]\s+/.test(l) || !l.trim())) {
      out.push(`<ul>${lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`);
      continue;
    }
    const h = block.match(/^(#{1,4})\s+(.+)$/);
    if (h && lines.length === 1) { out.push(`<h3>${inline(h[2])}</h3>`); continue; }
    out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
  }
  void list;
  return out.join('');
}

export function topbar(active) {
  const links = [
    ['/', 'Dashboard', 'dashboard'],
    ['/library', 'Library', 'library'],
    ['/inbox', 'Inbox', 'inbox'],
    ['/science', 'Science', 'science'],
    ['/schedule', 'Schedule', 'schedule'],
    ['/slides', 'Slides', 'slides'],
    ['/settings', 'Settings', 'settings'],
  ].filter(([, , k]) => k !== active && (CLIENT.features || {})[k] !== false);
  return `<header class="topbar">
    <a class="wordmark" href="/">${icon('mark', 'mark')}Lancetfish</a>
    <nav class="nav">${links.map(([h, l, k]) => `<a href="${h}" ${active === 'dashboard' ? 'target="_blank" rel="noopener"' : ''}>${l}${active === 'dashboard' ? icon('ext') : ''}</a>`).join('')}</nav>
  </header>`;
}

import('/ui/marks.js').catch(() => {});
