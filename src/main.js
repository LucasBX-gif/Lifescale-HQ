import { createClient } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  POINTS_PER_FLOW_MINUTE,
  POINTS_PER_WIN,
  POINTS_PER_FULL_DAY,
  IDLE_CUTOFF_MINUTES,
  CHEER_MIN_FLOW_MINUTES,
  CHEER_MIN_PARTNER_FLOW_MINUTES,
} from "./config.js";
import { myFlowCheer, myWinCheer, myDayCheer, partnerFlowCheer, partnerWinCheer, crownCheer } from "./cheers.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const IN_APP = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const native = (cmd) => (IN_APP ? invoke(cmd).catch(() => null) : Promise.resolve(null));

/** Full-screen fireworks + message (see src/fx.js). */
function celebrate(payload) {
  if (!payload) return;
  if (IN_APP) invoke("celebrate", { payload }).catch((e) => console.warn("celebrate failed", e));
  else console.log("celebrate", payload);
}
const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const FLOW_KEY = "lshq.flow";
const TICK_KEY = "lshq.lastTick";

const app = document.getElementById("app");
document.documentElement.classList.toggle("native", IN_APP);

const state = {
  user: null,
  me: null,
  profiles: [],
  today: null, // my daily log for today
  logs: [], // recent logs for everyone
  sessions: [], // recent flow sessions for everyone
  presence: {},
  nowPlaying: null,
  flow: loadFlow(),
  tab: "now",
  updateReady: null,
  banner: null,
  date: localDate(),
  channel: null,
  timers: [],
};

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function localDate(d = new Date(), tz = MY_TZ) {
  // YYYY-MM-DD in the given time zone
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function hm(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function ago(iso) {
  if (!iso) return "Offline";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `Seen ${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `Seen ${h}h ago`;
  return `Seen ${Math.round(h / 24)}d ago`;
}

function timeIn(tz) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date());
  } catch {
    return "";
  }
}

function tzOffsetHours(tz) {
  try {
    const now = new Date();
    const a = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const b = new Date(now.toLocaleString("en-US", { timeZone: MY_TZ }));
    const diff = Math.round((a - b) / 3600000);
    if (!diff) return "";
    return diff > 0 ? `+${diff}h` : `${diff}h`;
  } catch {
    return "";
  }
}

function loadFlow() {
  try {
    return JSON.parse(localStorage.getItem(FLOW_KEY)) || null;
  } catch {
    return null;
  }
}

function saveFlow() {
  try {
    if (state.flow) localStorage.setItem(FLOW_KEY, JSON.stringify(state.flow));
    else localStorage.removeItem(FLOW_KEY);
  } catch {}
}

function setBanner(text, kind = "info", ms = 8000) {
  state.banner = text ? { text, kind } : null;
  renderBanner();
  if (text && ms) setTimeout(() => {
    if (state.banner && state.banner.text === text) {
      state.banner = null;
      renderBanner();
    }
  }, ms);
}

function monthRange(offset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return { start, end, label: start.toLocaleString("en-GB", { month: "long", year: "numeric" }) };
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ---------- data ---------- */

async function loadProfiles() {
  const { data } = await sb.from("profiles").select("*").order("created_at");
  state.profiles = data || [];
  state.me = state.profiles.find((p) => p.id === state.user.id) || null;
}

async function loadActivity() {
  // Last month + this month is plenty for the board and today's stats.
  const since = monthRange(-1).start;
  const [s, l] = await Promise.all([
    sb.from("flow_sessions").select("*").gte("started_at", since.toISOString()).order("started_at"),
    sb.from("daily_logs").select("*").gte("log_date", ymd(new Date(since.getTime() - 86400000))),
  ]);
  state.sessions = s.data || [];
  state.logs = l.data || [];
  state.today = state.logs.find((x) => x.user_id === state.user.id && x.log_date === state.date) || null;
}

async function saveToday(patch) {
  const row = {
    user_id: state.user.id,
    log_date: state.date,
    focus: state.today?.focus ?? null,
    notes: state.today?.notes ?? null,
    wins: state.today?.wins ?? 0,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb.from("daily_logs").upsert(row, { onConflict: "user_id,log_date" }).select().single();
  if (error) {
    setBanner(`Couldn't save: ${error.message}`, "err");
    return false;
  }
  state.today = data;
  state.logs = state.logs.filter((x) => !(x.user_id === data.user_id && x.log_date === data.log_date)).concat(data);
  track();
  return true;
}

/* ---------- presence ---------- */

function presencePayload() {
  return {
    user_id: state.user.id,
    name: state.me?.name,
    focus: state.today?.focus || null,
    flow_started_at: state.flow?.startedAt || null,
    flow_task: state.flow?.task || null,
    np: state.nowPlaying,
    tz: MY_TZ,
  };
}

function track() {
  if (state.channel) state.channel.track(presencePayload()).catch(() => {});
}

function joinPresence() {
  const ch = sb.channel("hq-room", { config: { presence: { key: state.user.id } } });
  ch.on("presence", { event: "sync" }, () => {
    const raw = ch.presenceState();
    const out = {};
    for (const [key, metas] of Object.entries(raw)) out[key] = metas[metas.length - 1];
    state.presence = out;
    if (state.tab === "now") renderBody();
  });
  ch.on("postgres_changes", { event: "*", schema: "public", table: "daily_logs" }, async (change) => {
    const row = change.new;
    const prevWins = row ? state.logs.find((l) => l.user_id === row.user_id && l.log_date === row.log_date)?.wins || 0 : 0;
    await loadActivity();
    renderBody();
    if (row && row.user_id !== state.user.id && (row.wins || 0) > prevWins) {
      const who = state.profiles.find((p) => p.id === row.user_id);
      celebrate(partnerWinCheer({ name: who?.name, winsToday: row.wins, after: standings(0), myId: state.user.id }));
    }
  });
  ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "flow_sessions" }, async (change) => {
    const row = change.new;
    await loadActivity();
    renderBody();
    if (row && row.user_id !== state.user.id && row.seconds >= CHEER_MIN_PARTNER_FLOW_MINUTES * 60) {
      const who = state.profiles.find((p) => p.id === row.user_id);
      const tz = state.presence[row.user_id]?.tz || who?.timezone || "UTC";
      celebrate(
        partnerFlowCheer({ name: who?.name, seconds: row.seconds, endMs: Date.parse(row.ended_at), tz, after: standings(0), myId: state.user.id })
      );
    }
  });
  ch.subscribe((status) => {
    if (status === "SUBSCRIBED") track();
  });
  state.channel = ch;
}

/* ---------- flow timer ---------- */

function flowElapsed() {
  return state.flow ? (Date.now() - state.flow.startedAt) / 1000 : 0;
}

function startFlow() {
  state.flow = { startedAt: Date.now(), task: state.today?.focus || null };
  saveFlow();
  track();
  renderBody();
}

async function stopFlow(endAt = Date.now(), reason = null, { idle = false, quiet = false } = {}) {
  if (!state.flow) return;
  const flow = state.flow;
  state.flow = null;
  saveFlow();
  track();
  const seconds = Math.round((endAt - flow.startedAt) / 1000);
  if (seconds < 60) {
    setBanner(reason || "Under a minute, not logged.");
    renderBody();
    return;
  }
  const before = standings(0);
  const monthStart = monthRange(0).start.getTime();
  const longestBeforeSec = state.sessions
    .filter((x) => x.user_id === state.user.id && new Date(x.started_at).getTime() >= monthStart)
    .reduce((m, x) => Math.max(m, x.seconds), 0);
  const { error } = await sb.from("flow_sessions").insert({
    user_id: state.user.id,
    task: flow.task,
    started_at: new Date(flow.startedAt).toISOString(),
    ended_at: new Date(endAt).toISOString(),
    seconds: Math.min(seconds, 43200),
  });
  if (error) setBanner(`Couldn't log session: ${error.message}`, "err");
  else setBanner(reason ? `${reason} Logged ${hm(seconds)}.` : `Logged ${hm(seconds)} of flow.`);
  await loadActivity();
  renderBody();
  if (!error && !quiet && seconds >= CHEER_MIN_FLOW_MINUTES * 60) {
    celebrate(
      myFlowCheer({
        seconds,
        startMs: flow.startedAt,
        endMs: endAt,
        tz: MY_TZ,
        before,
        after: standings(0),
        userId: state.user.id,
        flowTodaySec: flowTodayFor(state.user.id, MY_TZ),
        longestBeforeSec,
        idle,
      })
    );
  }
}

/* ---------- scoring ---------- */

function scoreFor(userId, range) {
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();
  const startDay = ymd(range.start);
  const endDay = ymd(range.end);
  let flowSec = state.sessions
    .filter((s) => s.user_id === userId)
    .filter((s) => {
      const t = new Date(s.started_at).getTime();
      return t >= startMs && t < endMs;
    })
    .reduce((a, s) => a + s.seconds, 0);
  const logs = state.logs.filter((l) => l.user_id === userId && l.log_date >= startDay && l.log_date < endDay);
  const wins = logs.reduce((a, l) => a + (l.wins || 0), 0);
  const fullDays = logs.filter((l) => l.focus && l.notes && l.notes.trim()).length;
  const flowMin = Math.floor(flowSec / 60);
  const points = flowMin * POINTS_PER_FLOW_MINUTE + wins * POINTS_PER_WIN + fullDays * POINTS_PER_FULL_DAY;
  return { userId, flowSec, flowMin, wins, fullDays, points };
}

function standings(offset = 0) {
  const range = monthRange(offset);
  return state.profiles
    .map((p) => ({ ...scoreFor(p.id, range), name: p.name }))
    .sort((a, b) => b.points - a.points);
}

function lastMonthWinner() {
  const s = standings(-1);
  if (!s.length || s[0].points === 0) return null;
  if (s[1] && s[1].points === s[0].points) return { tie: true, names: s.filter((x) => x.points === s[0].points).map((x) => x.name), points: s[0].points };
  return s[0];
}

function flowTodayFor(userId, tz) {
  const today = localDate(new Date(), tz);
  return state.sessions
    .filter((s) => s.user_id === userId && localDate(new Date(s.started_at), tz) === today)
    .reduce((a, s) => a + s.seconds, 0);
}

function latestLogFor(userId, tz) {
  const today = localDate(new Date(), tz);
  return state.logs.find((l) => l.user_id === userId && l.log_date === today) || null;
}

/* ---------- rendering ---------- */

const TABS = ["now", "log", "board"];
const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.2-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="3"/></svg>`;
const NAV_ICONS = {
  now: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.4"/><path d="M15.8 14.6c2.2.1 3.9 1.5 4.6 4"/></svg>`,
  log: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`,
  board: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/></svg>`,
};
const NAV_TITLES = { now: "Now", log: "Log your day", board: "Employee of the month" };

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((w) => (w[0] || "").toUpperCase()).join("") || "?";
}

function hues(seed) {
  let h = 0;
  for (const ch of String(seed || "x")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return [h, (h + 55) % 360];
}

function avatar(p, { size = "", status = null } = {}) {
  const [a, b] = hues(p?.id || p?.name);
  const st = status !== null ? `<span class="st ${status}"></span>` : "";
  return `<div class="av ${size}" style="--c1:hsl(${a} 80% 64%);--c2:hsl(${b} 85% 54%)">${esc(initials(p?.name))}${st}</div>`;
}

function ringOffset(seconds) {
  return RING_C * (1 - (seconds % 3600) / 3600);
}

function brandColumn() {
  return `
    <div class="brand">
      <div class="orb" title="Lifescale HQ"></div>
      <div id="updateslot">${state.updateReady ? `<button class="update" id="doupdate" title="Version ${esc(state.updateReady)} is ready">Update</button>` : `<small>HQ</small>`}</div>
    </div>`;
}

function wireBrand() {
  app.querySelector("#doupdate")?.addEventListener("click", restartForUpdate);
}

function renderShell() {
  app.innerHTML = `
    ${brandColumn()}
    <div class="content" id="body"></div>
    <nav class="nav glass" id="nav" style="--i:${TABS.indexOf(state.tab)}">
      <span class="nav-thumb"></span>
      ${TABS.map((t) => `<button class="${state.tab === t ? "on" : ""}" data-tab="${t}" title="${NAV_TITLES[t]}">${NAV_ICONS[t]}</button>`).join("")}
    </nav>
    <div id="banner"></div>`;
  wireBrand();
  app.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.tab === b.dataset.tab) return;
      state.tab = b.dataset.tab;
      app.querySelector("#nav").style.setProperty("--i", TABS.indexOf(state.tab));
      app.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
      renderBody(true);
    })
  );
  renderBanner();
  renderBody(true);
}

function renderUpdateSlot() {
  const slot = document.getElementById("updateslot");
  if (!slot) return;
  slot.innerHTML = state.updateReady ? `<button class="update" id="doupdate" title="Version ${esc(state.updateReady)} is ready">Update</button>` : `<small>HQ</small>`;
  wireBrand();
}

function renderBanner() {
  const el = document.getElementById("banner");
  if (!el) return;
  el.innerHTML = state.banner ? `<div class="toast ${state.banner.kind === "err" ? "err" : ""}">${esc(state.banner.text)}</div>` : "";
}

function renderBody(animate = false) {
  const el = document.getElementById("body");
  if (!el) return;
  // Don't wipe what you're typing when a live update comes in.
  const active = document.activeElement;
  if (!animate && active && el.contains(active) && /^(TEXTAREA|INPUT)$/.test(active.tagName)) {
    tick();
    return;
  }
  el.className = `content${animate ? " fade" : ""}`;
  el.innerHTML = state.tab === "now" ? nowView() : state.tab === "log" ? logView() : boardView();
  wireBody(el);
  tick();
}

function personTile(p) {
  const pres = state.presence[p.id];
  const online = !!pres;
  const tz = pres?.tz || p.timezone || "UTC";
  const flowStart = pres?.flow_started_at;
  const log = latestLogFor(p.id, tz);
  const focus = pres?.focus || log?.focus;
  const np = pres?.np;
  const leader = standings(0)[0];
  const isLeader = leader && leader.points > 0 && leader.userId === p.id;
  const offset = tzOffsetHours(tz);
  const status = flowStart ? "flow" : online ? "on" : "";

  const sub = flowStart
    ? `<div class="p-sub flow" data-flow-since="${flowStart}">In flow</div>`
    : `<div class="p-sub">${online ? "Online now" : esc(ago(p.last_seen))}</div>`;

  return `
    <div class="tile glass grow">
      <div class="p-head">
        ${avatar(p, { size: "lg", status })}
        <div style="min-width:0;flex:1">
          <div class="p-name">${esc(p.name)}${isLeader ? `<span class="crown" title="Leading this month">♛</span>` : ""}</div>
          ${sub}
        </div>
      </div>
      ${focus ? `<div class="clamp${np ? " one" : ""}">${esc(focus)}</div>` : `<div class="clamp empty">Hasn't checked in today</div>`}
      <div class="chips">
        ${np ? `<span class="chip music" title="${esc(np.track)} · ${esc(np.artist)}"><span class="eq"><i></i><i></i><i></i></span><span class="txt"><b>${esc(np.track)}</b> · ${esc(np.artist)}</span></span>` : ""}
        <span class="chip"><b>${esc(timeIn(tz))}</b>${offset ? esc(offset) : ""}</span>
        <span class="chip">Flow <b>${hm(flowTodayFor(p.id, tz))}</b></span>
        ${np ? "" : `<span class="chip">Wins <b>${log?.wins || 0}</b></span>`}
      </div>
    </div>`;
}

function meTile() {
  const running = !!state.flow;
  const el = flowElapsed();
  const todayFlow = flowTodayFor(state.user.id, MY_TZ);
  const focus = state.today?.focus;
  const np = state.nowPlaying;
  return `
    <div class="tile glass me-tile">
      <div class="ring">
        <svg viewBox="0 0 108 108">
          <defs>
            <linearGradient id="ringgrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#ffb547"/>
              <stop offset="1" stop-color="#ff7ab6"/>
            </linearGradient>
          </defs>
          <circle class="track" cx="54" cy="54" r="${RING_R}" fill="none" stroke-width="7"/>
          <circle class="prog" id="ringprog" cx="54" cy="54" r="${RING_R}" fill="none" stroke="url(#ringgrad)" stroke-width="7"
            stroke-linecap="round" stroke-dasharray="${RING_C}" stroke-dashoffset="${running ? ringOffset(el) : RING_C}"
            style="opacity:${running ? 1 : 0}"/>
        </svg>
        <div class="center">
          <div class="clock" id="myclock">${running ? clock(el) : "00:00"}</div>
          <div class="clock-sub" id="clocksub">${running ? "in flow" : "ready"}</div>
        </div>
      </div>
      <div class="me-col">
        <div class="label">You${running ? " · in flow" : ""}</div>
        ${focus ? `<div class="clamp" style="margin-top:4px">${esc(focus)}</div>` : `<div class="clamp empty" style="margin-top:4px">No focus set. Add one in Log.</div>`}
        ${np ? `<div class="chips" style="margin-top:6px"><span class="chip music"><span class="eq"><i></i><i></i><i></i></span><span class="txt"><b>${esc(np.track)}</b></span></span></div>` : ""}
        <div class="me-foot">
          <button class="play ${running ? "stop" : ""}" id="flowbtn" title="${running ? "End flow" : "Start flow"}">${running ? ICON_STOP : ICON_PLAY}</button>
          <div><div style="font-weight:600;font-size:12px">${hm(todayFlow)} today</div><div class="hint">Auto-stops after ${IDLE_CUTOFF_MINUTES}m idle</div></div>
        </div>
      </div>
    </div>`;
}

function scoreTile() {
  const s = standings(0);
  const tie = s[1] && s[0] && s[1].points === s[0].points;
  const rows = s
    .slice(0, 3)
    .map(
      (r, i) => `
      <div class="row ${i === 0 && r.points > 0 && !tie ? "lead" : ""}">
        ${avatar({ id: r.userId, name: r.name }, { size: "sm" })}
        <span class="nm">${esc(r.name.split(" ")[0])}${i === 0 && r.points > 0 && !tie ? ` <span class="crown">♛</span>` : ""}</span>
        <span class="pts">${r.points}</span>
      </div>`
    )
    .join("");
  return `
    <div class="tile glass score">
      <div class="label">${esc(monthRange(0).label.split(" ")[0])} points</div>
      ${rows}
      <div class="wins">
        <span class="label">Wins today</span>
        <div class="stepper">
          <button id="winminus" aria-label="Remove a win">−</button>
          <span class="n">${state.today?.wins || 0}</span>
          <button id="winplus" aria-label="Add a win">+</button>
        </div>
      </div>
    </div>`;
}

function nowView() {
  const others = state.profiles.filter((p) => p.id !== state.user.id);
  const partners = others.length
    ? others.map(personTile).join("")
    : `<div class="tile glass grow"><div class="empty">Waiting for Seva to sign up</div></div>`;
  return partners + meTile() + scoreTile();
}

function logView() {
  const t = state.today || {};
  return `
    <div class="tile glass grow">
      <div class="label">Today's focus</div>
      <textarea id="focus" placeholder="What are you working on today?">${esc(t.focus || "")}</textarea>
    </div>
    <div class="tile glass grow">
      <div class="label">What did you get done?</div>
      <textarea id="notes" placeholder="Note down what you did today.">${esc(t.notes || "")}</textarea>
    </div>
    <div class="tile glass actions">
      <button class="pill primary" id="savelog">Save</button>
      <div class="saved" id="logsaved">Saved</div>
      <button class="link" id="signout">Sign out</button>
    </div>`;
}

function boardView() {
  const now = standings(0);
  const range = monthRange(0);
  const winner = lastMonthWinner();
  const lead = now[0];
  const tie = now[1] && lead && now[1].points === lead.points;
  const max = Math.max(1, ...now.map((r) => r.points));

  let hero;
  if (winner && !winner.tie) {
    hero = `
      <div class="tile glass hero">
        ${avatar({ id: winner.userId, name: winner.name }, { size: "lg" })}
        <div style="min-width:0"><div class="crown-big">♛ Employee of the month</div><div class="big">${esc(winner.name)}</div><div class="small">${esc(monthRange(-1).label)} · ${winner.points} pts</div></div>
      </div>`;
  } else if (winner && winner.tie) {
    hero = `<div class="tile glass hero"><div><div class="crown-big">♛ ${esc(monthRange(-1).label)}</div><div class="big">Tie</div><div class="small">${esc(winner.names.join(" & "))}</div></div></div>`;
  } else if (lead && lead.points > 0 && !tie) {
    hero = `
      <div class="tile glass hero">
        ${avatar({ id: lead.userId, name: lead.name }, { size: "lg" })}
        <div style="min-width:0"><div class="crown-big">♛ Leading</div><div class="big">${esc(lead.name.split(" ")[0])}</div><div class="small">Crowned on the 1st</div></div>
      </div>`;
  } else {
    hero = `<div class="tile glass hero"><div><div class="crown-big">♛</div><div class="big">Up for grabs</div><div class="small">Start a flow to score</div></div></div>`;
  }

  const rows = now
    .map(
      (r, i) => `
      <div class="rank ${i === 0 && r.points > 0 && !tie ? "lead" : ""}">
        ${avatar({ id: r.userId, name: r.name }, { size: "sm" })}
        <div class="who">
          <b>${esc(r.name)}</b><small>${hm(r.flowSec)} flow · ${r.wins} ${r.wins === 1 ? "win" : "wins"} · ${r.fullDays} full ${r.fullDays === 1 ? "day" : "days"}</small>
          <div class="bar"><i style="width:${Math.round((r.points / max) * 100)}%"></i></div>
        </div>
        <span class="pts">${r.points}</span>
      </div>`
    )
    .join("");

  return `
    ${hero}
    <div class="tile glass grow">
      <div class="label">${esc(range.label)}</div>
      ${rows || `<div class="empty">Nothing logged yet.</div>`}
    </div>
    <div class="tile glass rules">
      <div class="label" style="margin-bottom:2px">Points</div>
      <div><span>Flow minute</span><b>${POINTS_PER_FLOW_MINUTE}</b></div>
      <div><span>Win</span><b>${POINTS_PER_WIN}</b></div>
      <div><span>Full day</span><b>${POINTS_PER_FULL_DAY}</b></div>
    </div>`;
}

function flash(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1800);
}

function wireBody(el) {
  el.querySelector("#signout")?.addEventListener("click", signOut);
  el.querySelector("#flowbtn")?.addEventListener("click", () => (state.flow ? stopFlow() : startFlow()));
  el.querySelector("#savelog")?.addEventListener("click", async () => {
    const focus = el.querySelector("#focus").value.trim();
    const notes = el.querySelector("#notes").value.trim();
    const wasFull = !!(state.today?.focus && state.today?.notes);
    const before = standings(0);
    if (await saveToday({ focus: focus || null, notes: notes || null })) {
      flash("logsaved");
      if (!wasFull && focus && notes) {
        celebrate(myDayCheer({ points: POINTS_PER_FULL_DAY, before, after: standings(0), userId: state.user.id }));
      }
    }
  });
  el.querySelector("#winplus")?.addEventListener("click", async () => {
    const before = standings(0);
    const wins = (state.today?.wins || 0) + 1;
    if (await saveToday({ wins })) {
      renderBody();
      celebrate(myWinCheer({ winsToday: wins, before, after: standings(0), userId: state.user.id, points: POINTS_PER_WIN }));
    }
  });
  el.querySelector("#winminus")?.addEventListener("click", async () => {
    const w = state.today?.wins || 0;
    if (w > 0 && (await saveToday({ wins: w - 1 }))) renderBody();
  });
}

function tick() {
  if (state.flow) {
    const s = flowElapsed();
    const mine = document.getElementById("myclock");
    if (mine) mine.textContent = clock(s);
    const ring = document.getElementById("ringprog");
    if (ring) ring.setAttribute("stroke-dashoffset", ringOffset(s));
    const sub = document.getElementById("clocksub");
    if (sub) sub.textContent = s >= 3600 ? `hour ${Math.floor(s / 3600) + 1}` : "in flow";
  }
  document.querySelectorAll("[data-flow-since]").forEach((n) => {
    const since = Number(n.dataset.flowSince);
    n.textContent = `In flow · ${clock((Date.now() - since) / 1000)}`;
  });
}

/* ---------- screens ---------- */

function renderAuth(mode = "in", msg = "") {
  stopLoops();
  const err = msg.startsWith("!");
  app.innerHTML = `
    ${brandColumn()}
    <div class="tile glass prompt">
      <div class="prompt-head">
        <h1>Lifescale HQ <span>· ${mode === "in" ? "sign in" : "create your account"}</span></h1>
        <button class="link" id="switch">${mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}</button>
      </div>
      <div class="prompt-row">
        ${mode === "up" ? `<input id="name" placeholder="Your name" autocomplete="off">` : ""}
        <input id="email" type="email" placeholder="Email" autocomplete="off">
        <input id="password" type="password" placeholder="Password (6+ characters)">
        <button class="pill primary" id="go">${mode === "in" ? "Sign in" : "Create"}</button>
      </div>
      <div class="msg ${err ? "err" : ""}">${esc(msg.replace(/^!/, ""))}</div>
    </div>`;
  wireBrand();
  app.querySelector("#switch").addEventListener("click", () => renderAuth(mode === "in" ? "up" : "in"));
  const go = async () => {
    const email = app.querySelector("#email").value.trim();
    const password = app.querySelector("#password").value;
    const btn = app.querySelector("#go");
    btn.disabled = true;
    if (mode === "up") {
      const name = app.querySelector("#name").value.trim();
      if (!name) return renderAuth("up", "!Add your name.");
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name, timezone: MY_TZ } } });
      if (error) return renderAuth("up", `!${error.message}`);
      if (!data.session) return renderAuth("in", "Account made. Confirm the email Supabase sent you, then sign in.");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return renderAuth("in", `!${error.message}`);
    }
  };
  app.querySelector("#go").addEventListener("click", go);
  app.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => e.key === "Enter" && go()));
}

function renderCheckin() {
  const first = (state.me?.name || "").split(" ")[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  app.innerHTML = `
    ${brandColumn()}
    <div class="tile glass prompt">
      <div class="prompt-head">
        <h1>${greet}${first ? `, ${esc(first)}` : ""}. <span>What are you working on today?</span></h1>
        <button class="link" id="skip">Skip for now</button>
      </div>
      <div class="prompt-row">
        <input id="focus" placeholder="30 DMs to architects working with developers…" autocomplete="off">
        <button class="pill primary" id="go">Lock it in</button>
      </div>
      <div class="msg"></div>
    </div>`;
  wireBrand();
  const input = app.querySelector("#focus");
  setTimeout(() => input.focus(), 50);
  const go = async () => {
    const v = input.value.trim();
    if (!v) return input.focus();
    if (await saveToday({ focus: v })) renderShell();
  };
  app.querySelector("#go").addEventListener("click", go);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  app.querySelector("#skip").addEventListener("click", () => renderShell());
}

/* ---------- updates ---------- */

async function checkForUpdate() {
  if (!IN_APP || state.updateReady) return;
  try {
    const update = await check();
    if (!update) return;
    // Download in the background; the bar just shows a little "Update" button when it's ready.
    await update.downloadAndInstall();
    state.updateReady = update.version;
    renderUpdateSlot();
  } catch (e) {
    console.warn("update check failed", e);
  }
}

async function restartForUpdate() {
  await relaunch();
}

/* ---------- loops ---------- */

function stopLoops() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  if (state.channel) {
    sb.removeChannel(state.channel);
    state.channel = null;
  }
}

async function pollMusic() {
  const np = await native("now_playing");
  const key = (x) => (x ? `${x.track}|${x.artist}` : "");
  if (key(np) !== key(state.nowPlaying)) {
    state.nowPlaying = np;
    track();
    if (state.tab === "now") renderBody();
  }
}

async function pollIdle() {
  if (!state.flow) return;
  const idle = await native("idle_seconds");
  if (idle != null && idle >= IDLE_CUTOFF_MINUTES * 60) {
    await stopFlow(Date.now() - idle * 1000, `Timer stopped: no activity for ${IDLE_CUTOFF_MINUTES} min.`, { idle: true });
  }
}

function secondTick() {
  const now = Date.now();
  let last = 0;
  try {
    last = Number(localStorage.getItem(TICK_KEY)) || 0;
    localStorage.setItem(TICK_KEY, String(now));
  } catch {}
  // Mac slept or app was closed mid-session: end the session where it actually stopped.
  if (state.flow && last && now - last > 2 * 60 * 1000 && last > state.flow.startedAt) {
    stopFlow(last, "Timer stopped while your Mac was asleep or the app was closed.");
    return;
  }
  // New day rolled over.
  const d = localDate();
  if (d !== state.date) {
    state.date = d;
    state.today = null;
    loadActivity().then(() => (state.today?.focus ? renderShell() : renderCheckin()));
    return;
  }
  tick();
}

async function heartbeat() {
  await sb.from("profiles").update({ last_seen: new Date().toISOString(), timezone: MY_TZ }).eq("id", state.user.id);
}

function startLoops() {
  state.timers.push(setInterval(secondTick, 1000));
  state.timers.push(setInterval(pollMusic, 10000));
  state.timers.push(setInterval(pollIdle, 30000));
  state.timers.push(setInterval(heartbeat, 120000));
  state.timers.push(setInterval(async () => {
    await Promise.all([loadProfiles(), loadActivity()]);
    renderBody();
  }, 5 * 60 * 1000));
}

/* ---------- boot ---------- */

let entering = null;
async function enter(user) {
  // SIGNED_IN can fire again on token refresh or focus: ignore if we're already in.
  if (state.user?.id === user.id && (state.channel || entering)) return;
  entering = user.id;
  try {
    await doEnter(user);
  } finally {
    entering = null;
  }
}

async function doEnter(user) {
  stopLoops();
  state.user = user;
  app.innerHTML = `<div class="loading">Loading…</div>`;
  await heartbeat();
  await Promise.all([loadProfiles(), loadActivity()]);
  if (!state.me) {
    app.innerHTML = `${brandColumn()}<div class="tile glass prompt"><div class="prompt-head"><h1>Almost there <span>· your profile is missing</span></h1><button class="link" id="out">Sign out</button></div><div class="msg">Run supabase/schema.sql in Supabase, then sign out and back in.</div></div>`;
    app.querySelector("#out").addEventListener("click", signOut);
    return;
  }
  maybeCrown();
  // Pick up the cutoff check straight away if the app was closed mid-session.
  secondTick();
  joinPresence();
  startLoops();
  pollMusic();
  if (state.today?.focus) renderShell();
  else renderCheckin();
}

/** First open of a new month: crown last month's Employee of the Month, once. */
function maybeCrown() {
  const winner = lastMonthWinner();
  if (!winner || winner.tie) return;
  const label = monthRange(-1).label;
  const key = "lshq.crowned";
  try {
    if (localStorage.getItem(key) === label) return;
    localStorage.setItem(key, label);
  } catch {
    return;
  }
  setTimeout(() => celebrate(crownCheer({ winner, monthLabel: label, isMe: winner.userId === state.user.id })), 1500);
}

async function signOut() {
  if (state.flow) await stopFlow(Date.now(), null, { quiet: true });
  stopLoops();
  state.user = null;
  await sb.auth.signOut();
  renderAuth("in");
}

// Supabase advises against awaiting its own calls inside this callback, so defer.
sb.auth.onAuthStateChange((event, session) => {
  setTimeout(() => {
    if ((event === "INITIAL_SESSION" || event === "SIGNED_IN") && session?.user) enter(session.user);
    else if (event === "INITIAL_SESSION") renderAuth("in");
    else if (event === "SIGNED_OUT") {
      stopLoops();
      state.user = null;
      renderAuth("in");
    }
  }, 0);
});

if (IN_APP) {
  listen("bar-shown", () => {
    app.classList.remove("drop");
    void app.offsetWidth;
    app.classList.add("drop");
  }).catch(() => {});
  setTimeout(checkForUpdate, 5000);
  setInterval(checkForUpdate, 3 * 60 * 60 * 1000);
}
