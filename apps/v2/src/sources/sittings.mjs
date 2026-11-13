import { P, readJSONL, dayKey } from '../util.mjs';

export function loadSittings() {
  return readJSONL(P.sittings).map((s) => ({
    day: s.day, minutes: Number(s.minutes) || 0, kind: s.kind || '', paperId: s.paper_id || null, ts: s.ts || '',
  }));
}

const DAY_MAX = 24 * 60;

export function heatmap(blocks, weeks = 20, now = new Date()) {
  const perDay = new Map();
  for (const s of loadSittings()) perDay.set(s.day, (perDay.get(s.day) || 0) + s.minutes);
  for (const b of blocks) {
    const day = dayKey(new Date(b.start));
    perDay.set(day, (perDay.get(day) || 0) + (Number(b.actualMinutes) || 0));
  }

  const today = dayKey(now);
  const [y, m, d] = today.split('-').map(Number);
  const todayUTC = Date.UTC(y, m - 1, d);
  const dow = new Date(todayUTC).getUTCDay();
  const startUTC = todayUTC - ((weeks - 1) * 7 + dow) * 86400000;

  const days = [];
  for (let t = startUTC; t <= todayUTC; t += 86400000) {
    const key = new Date(t).toISOString().slice(0, 10);
    const raw = Math.round(perDay.get(key) || 0);
    days.push(raw > DAY_MAX ? { day: key, minutes: DAY_MAX, logged: raw, suspect: true } : { day: key, minutes: raw });
  }
  return { weeks, days, today };
}
