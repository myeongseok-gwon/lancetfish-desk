export const SAMPLE_MS = 15000;
export const ALPHA = 0.2;
export const BONUS_EACH = 0.25;
export const BONUS_DECAY_MS = 5 * 60 * 1000;

export const DEFAULT_ON_TASK = [
  'Google Chrome', 'Safari', 'Preview', 'Claude', 'ChatGPT', 'Codex', 'Claude Science', 'Obsidian', 'Anki',
  'Terminal', 'Orca', 'Zotero', 'Microsoft PowerPoint', 'Keynote', 'Microsoft Word', 'Code', 'Cursor', 'Ghostty', 'iTerm2',
];

export function presence(idleSeconds) {
  if (idleSeconds == null || !Number.isFinite(idleSeconds)) return 1;
  if (idleSeconds <= 60) return 1;
  if (idleSeconds >= 300) return 0;
  return 1 - (idleSeconds - 60) / 240;
}

export function context(appName, onTask = DEFAULT_ON_TASK) {
  if (!appName) return 0.5;
  return onTask.includes(appName) ? 1 : 0.5;
}

export function bonus(events, now) {
  let b = 0;
  for (const e of events || []) {
    const age = now - e.t;
    if (age >= 0 && age < BONUS_DECAY_MS) b += BONUS_EACH * (1 - age / BONUS_DECAY_MS);
  }
  return b;
}

export function step(prevEma, p, c, b) {
  const raw = Math.min(1, p * c + b);
  const ema = prevEma == null ? raw : ALPHA * raw + (1 - ALPHA) * prevEma;
  return { raw, ema };
}

export const toScore = (ema) => (ema == null ? null : Math.round(100 * ema));
