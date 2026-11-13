export const NAMER = /^Name this chat from the user(’|')s first request/;
export const PROBE_SLUG = /orca-rate-limit/;
export const REPEAT_MIN = 5;

const repeated = new Set();
export const promptKey = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);

export function learnRepeats(records) {
  const seen = new Map();
  for (const r of records) if (r.prompts <= 1 && r.firstPrompt) { const k = promptKey(r.firstPrompt); seen.set(k, (seen.get(k) || 0) + 1); }
  repeated.clear();
  for (const [k, n] of seen) if (n >= REPEAT_MIN) repeated.add(k);
}

export function isAutomatedPrompt(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (NAMER.test(t) || t.startsWith('[Request interrupted')) return true;
  if (/^\/usage\b/.test(t)) return true;
  return repeated.has(promptKey(t));
}

export function isNoiseSession(r) {
  if (r.prompts === 0 || r.namerOnly) return true;
  if (PROBE_SLUG.test(r.slug || '')) return true;
  return r.prompts <= 1 && repeated.has(promptKey(r.firstPrompt));
}
