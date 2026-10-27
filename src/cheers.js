// Turns what just happened into a celebration: title, subtitle, chips and how big the fireworks are.
// Pure functions only, so they can be tested without the app.

export function clockLabel(ms, tz) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
      .format(new Date(ms))
      .replace(/\s/g, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

export function hourOf(ms, tz) {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    return Number(h) % 24;
  } catch {
    return new Date(ms).getHours();
  }
}

export function duration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${String(r).padStart(2, "0")}m` : `${h}h`;
}

const first = (name) => String(name || "").trim().split(/\s+/)[0] || "They";
const pts = (n) => `${n} ${n === 1 ? "pt" : "pts"}`;

/** Where someone stands on this month's board, from their own point of view. */
export function standing(rows, userId) {
  const me = rows.find((r) => r.userId === userId);
  const others = rows.filter((r) => r.userId !== userId);
  if (!me || !others.length) return { kind: "solo" };
  const best = others.reduce((a, b) => (b.points > a.points ? b : a));
  if (me.points > best.points) return { kind: "leading", by: me.points - best.points, rival: best };
  if (me.points === best.points) return { kind: "level", rival: best };
  return { kind: "behind", by: best.points - me.points, rival: best };
}

function leadChip(before, after, userId) {
  const a = standing(after, userId);
  const b = standing(before, userId);
  if (a.kind === "leading" && b.kind !== "leading") return { text: `You just took the lead from ${first(a.rival.name)}`, tookLead: true };
  if (a.kind === "leading") return { text: `Leading by ${pts(a.by)}`, tookLead: false };
  if (a.kind === "level") return { text: `Level with ${first(a.rival.name)}`, tookLead: false };
  if (a.kind === "behind") return { text: `${pts(a.by)} behind ${first(a.rival.name)}`, tookLead: false };
  return null;
}

/** You just ended a flow session. */
export function myFlowCheer({ seconds, startMs, endMs, tz, before, after, userId, flowTodaySec, longestBeforeSec, idle = false }) {
  const endHour = hourOf(endMs, tz);
  const startHour = hourOf(startMs, tz);
  const len = duration(seconds);
  let icon = "🔥", title, subtitle, intensity = 2;

  if (endHour >= 0 && endHour < 5) {
    icon = "🌙";
    title = `Worked till ${clockLabel(endMs, tz)}.`;
    subtitle = `${len} of flow. Employee of the Month behaviour.`;
    intensity = 3;
  } else if (startHour >= 4 && startHour < 7) {
    icon = "🌅";
    title = `Locked in since ${clockLabel(startMs, tz)}.`;
    subtitle = `${len} done while everyone was asleep.`;
    intensity = 3;
  } else if (seconds >= 3 * 3600) {
    title = `${len} straight.`;
    subtitle = "Absolute machine.";
    intensity = 3;
  } else if (seconds >= 2 * 3600) {
    title = `${len} of deep work.`;
    subtitle = "That's how it's done.";
    intensity = 3;
  } else if (seconds >= 3600) {
    title = `${len} locked in.`;
    subtitle = "Hour in the bank.";
  } else {
    title = `${len} locked in.`;
    subtitle = "Stacking it up.";
    intensity = 1;
  }
  if (idle) subtitle = `${subtitle} Auto-stopped when you went idle.`;

  const lead = leadChip(before, after, userId);
  const record = longestBeforeSec > 0 && seconds > longestBeforeSec && seconds >= 45 * 60;
  if (lead?.tookLead) intensity = 3;

  const chips = [`+${pts(Math.floor(seconds / 60))}`, `Flow today ${duration(flowTodaySec)}`];
  if (lead) chips.push(lead.text);

  return {
    kind: "flow",
    icon,
    title,
    subtitle,
    badge: lead?.tookLead ? "♛ New leader" : record ? "Longest session this month" : null,
    chips,
    intensity,
    palette: lead?.tookLead ? "gold" : endHour < 5 ? "night" : "warm",
  };
}

/** You just logged a win. */
export function myWinCheer({ winsToday, before, after, userId, points }) {
  const titles = { 1: "First win of the day.", 2: "Two wins today.", 3: "Hat trick." };
  const title = titles[winsToday] || `Win number ${winsToday}. On a heater.`;
  const lead = leadChip(before, after, userId);
  const chips = [`+${pts(points)}`, `${winsToday} ${winsToday === 1 ? "win" : "wins"} today`];
  if (lead) chips.push(lead.text);
  return {
    kind: "win",
    icon: "🏆",
    title,
    subtitle: winsToday >= 3 ? "Somebody stop him." : "Keep them coming.",
    badge: lead?.tookLead ? "♛ New leader" : null,
    chips,
    intensity: 3,
    palette: "gold",
  };
}

/** You checked in and wrote what you did: a full day. */
export function myDayCheer({ points, before, after, userId }) {
  const lead = leadChip(before, after, userId);
  const chips = [`+${pts(points)}`];
  if (lead) chips.push(lead.text);
  return { kind: "day", icon: "✅", title: "Day logged.", subtitle: "Full day in the books.", badge: null, chips, intensity: 1, palette: "cool" };
}

/** Your partner just finished a flow session. Shown on your screen. */
export function partnerFlowCheer({ name, seconds, endMs, tz, after, myId }) {
  const endHour = hourOf(endMs, tz);
  const len = duration(seconds);
  const late = endHour >= 0 && endHour < 5;
  const a = standing(after, myId);
  const chips = [`${len} of flow`];
  if (a.kind === "behind") chips.push(`${first(a.rival.name)} leads by ${pts(a.by)}`);
  else if (a.kind === "leading") chips.push(`You still lead by ${pts(a.by)}`);
  else if (a.kind === "level") chips.push("Dead level");
  return {
    kind: "partner",
    icon: late ? "🌙" : "⚡",
    title: late ? `${first(name)} worked till ${clockLabel(endMs, tz)}.` : `${first(name)} just did ${len} of flow.`,
    subtitle: late ? "His time. Employee of the Month behaviour. Your move." : "Your move.",
    badge: null,
    chips,
    intensity: late ? 2 : 1,
    palette: "cool",
  };
}

/** Your partner just logged a win. */
export function partnerWinCheer({ name, winsToday, after, myId }) {
  const a = standing(after, myId);
  const chips = [`${winsToday} ${winsToday === 1 ? "win" : "wins"} today`];
  if (a.kind === "behind") chips.push(`${first(name)} leads by ${pts(a.by)}`);
  else if (a.kind === "leading") chips.push(`You still lead by ${pts(a.by)}`);
  return {
    kind: "partner",
    icon: "⚡",
    title: `${first(name)} just logged a win.`,
    subtitle: winsToday >= 2 ? `That's ${winsToday} today. Your move.` : "Your move.",
    badge: null,
    chips,
    intensity: 1,
    palette: "cool",
  };
}

/** The 1st of the month: Employee of the Month is crowned. */
export function crownCheer({ winner, monthLabel, isMe }) {
  return {
    kind: "crown",
    icon: "👑",
    title: isMe ? "You're Employee of the Month." : `${first(winner.name)} is Employee of the Month.`,
    subtitle: isMe ? `${monthLabel} is yours. ${pts(winner.points)}.` : `${monthLabel} · ${pts(winner.points)}. New month, clean slate.`,
    badge: monthLabel,
    chips: [`${duration(winner.flowSec)} flow`, `${winner.wins} ${winner.wins === 1 ? "win" : "wins"}`, `${winner.fullDays} full days`],
    intensity: 3,
    palette: "gold",
    duration: 7000,
  };
}
