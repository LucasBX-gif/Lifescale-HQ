// Streaks and calendar maths. Pure functions, no app state.

/** YYYY-MM-DD for a moment, in a given time zone. */
export function dayKey(ms, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

/** Shift a YYYY-MM-DD key by n days (calendar days, no time zone drift). */
export function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Everything one person did, per day, in their own time zone. */
export function dayMap(sessions, logs, userId, tz) {
  const map = new Map();
  const get = (k) => {
    if (!map.has(k)) map.set(k, { flowSec: 0, sessions: 0, longestSec: 0, wins: 0, focus: null, notes: null, lastEndMs: 0 });
    return map.get(k);
  };
  for (const s of sessions) {
    if (s.user_id !== userId) continue;
    const startMs = Date.parse(s.started_at);
    const d = get(dayKey(startMs, tz));
    d.flowSec += s.seconds || 0;
    d.sessions += 1;
    d.longestSec = Math.max(d.longestSec, s.seconds || 0);
    d.lastEndMs = Math.max(d.lastEndMs, Date.parse(s.ended_at) || 0);
  }
  for (const l of logs) {
    if (l.user_id !== userId) continue;
    const d = get(l.log_date);
    d.wins += l.wins || 0;
    d.focus = l.focus || d.focus;
    d.notes = l.notes || d.notes;
  }
  return map;
}

/** A day counts if you checked in, ran a flow session, or logged a win. */
export function isActive(day) {
  return !!day && (day.flowSec > 0 || day.wins > 0 || !!(day.focus && day.focus.trim()));
}

/**
 * Current streak counts back from today. If today isn't active yet it counts from
 * yesterday, so the streak stays alive until the day is actually over.
 */
export function streaks(map, todayKey) {
  let d = isActive(map.get(todayKey)) ? todayKey : addDays(todayKey, -1);
  let current = 0;
  while (isActive(map.get(d))) {
    current += 1;
    d = addDays(d, -1);
  }
  const activeToday = isActive(map.get(todayKey));

  const keys = [...map.keys()].filter((k) => isActive(map.get(k))).sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    run = prev && addDays(prev, 1) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { current, best: Math.max(best, current), activeToday };
}

export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 75, 100, 150, 200, 365];

/** Weeks (Monday first) covering a month. Days outside the month are null. */
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Winner of a set of scored rows, or a tie, or nobody. */
export function winnerOf(rows) {
  const sorted = [...rows].sort((a, b) => b.points - a.points);
  if (!sorted.length || sorted[0].points <= 0) return { kind: "none", rows: sorted };
  if (sorted[1] && sorted[1].points === sorted[0].points) return { kind: "tie", rows: sorted };
  return { kind: "winner", winner: sorted[0], rows: sorted };
}
