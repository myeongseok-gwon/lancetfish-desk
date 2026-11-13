import { P, readJSON, toMs } from '../util.mjs';
import { codexLimits, listCodexFiles } from './codex.mjs';
import { readConfig } from '../settings.mjs';

function win(used, resets) {
  const u = Number(used);
  return { used: Number.isFinite(u) ? Math.max(0, Math.min(100, u)) : null, resetsAt: toMs(resets) || null };
}

export function loadLimits() {
  const out = { claude: null, codex: null };
  const enabled = readConfig().apps || {};
  const c = enabled.claudeCode === false ? null : readJSON(P.claudeLimits);
  if (c && c.rate_limits) {
    const r = c.rate_limits;
    out.claude = {
      at: toMs(c.at),
      fiveHour: r.five_hour ? win(r.five_hour.used_percentage ?? r.five_hour.used_percent, r.five_hour.resets_at) : null,
      sevenDay: r.seven_day ? win(r.seven_day.used_percentage ?? r.seven_day.used_percent, r.seven_day.resets_at) : null,
    };
  } else {
    out.claude = { absent: true, message: enabled.claudeCode === false ? 'Claude Code is off in Settings' : 'Open Claude Code once to read limits' };
  }
  const x = enabled.codex === false ? null : codexLimits(listCodexFiles());
  if (x) {
    out.codex = {
      at: x.at,
      fiveHour: x.primary ? win(x.primary.used_percent, x.primary.resets_at) : null,
      sevenDay: x.secondary ? win(x.secondary.used_percent, x.secondary.resets_at) : null,
    };
  } else out.codex = { absent: true, message: enabled.codex === false ? 'Codex is off in Settings' : 'No Codex session yet' };

  for (const k of ['claude', 'codex']) {
    const v = out[k];
    if (!v || v.absent) continue;
    for (const w of ['fiveHour', 'sevenDay']) if (v[w] && v[w].resetsAt && v[w].resetsAt < Date.now()) { v[w].used = 0; v[w].rolled = true; }
  }
  return out;
}
