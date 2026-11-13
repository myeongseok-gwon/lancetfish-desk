import { P, readJSON, dayKey, TZ } from '../util.mjs';

export function loadCalendar(now = new Date()) {
  const d = readJSON(P.calendar);
  if (!d || !Array.isArray(d.events)) return { syncedAt: null, today: [], tomorrow: [], upcoming: [] };
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 24 * 3600 * 1000));
  const events = d.events
    .filter((e) => e && e.start && !/@lancetfish$/.test(String(e.ical_uid || '')))
    .map((e) => {
      const start = e.all_day ? Date.parse(e.start + 'T00:00:00') : Date.parse(e.start);
      const end = e.all_day ? Date.parse((e.end || e.start) + 'T00:00:00') : Date.parse(e.end || e.start);
      return { title: e.summary || '(no title)', start, end, allDay: !!e.all_day, location: e.location || '', day: e.all_day ? String(e.start).slice(0, 10) : dayKey(new Date(start)) };
    })
    .sort((a, b) => a.start - b.start);
  const t = now.getTime();
  return {
    syncedAt: d.synced_at || null,
    tz: TZ,
    today: events.filter((e) => e.day === today),
    tomorrow: events.filter((e) => e.day === tomorrow),
    upcoming: events.filter((e) => (e.allDay ? e.day >= today : e.end > t) && (e.day === today || e.day === tomorrow)).slice(0, 3),
  };
}
