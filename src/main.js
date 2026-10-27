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
import { dayMap, streaks, isActive, monthGrid, winnerOf, STREAK_MILESTONES } from "./calendar.js";
import { clockLabel, hourOf } from "./cheers.js";
import { myFlowCheer, myWinCheer, myDayCheer, partnerFlowCheer, partnerWinCheer, crownCheer, streakCheer, yearCrownCheer } from "./cheers.js";

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
  layout: "bar",
  screen: "auth",
  pinned: false,
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

function agoShort(ms) {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
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

/** Supabase returns at most 1000 rows per request, so page through. */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

// History back to 1 January last year: enough for streaks, the calendar and both year views.
function historyStart() {
  return new Date(new Date().getFullYear() - 1, 0, 1);
}

async function loadActivity() {
  const since = historyStart();
  try {
    const [sessions, logs] = await Promise.all([
      fetchAll(() => sb.from("flow_sessions").select("*").gte("started_at", new Date(since.getTime() - 86400000).toISOString()).order("started_at")),
      fetchAll(() => sb.from("daily_logs").select("*").gte("log_date", ymd(new Date(since.getTime() - 86400000))).order("log_date")),
    ]);
    state.sessions = sessions;
    state.logs = logs;
  } catch (e) {
    setBanner(`Couldn't load history: ${e.message}`, "err");
  }
  state.today = state.logs.find((x) => x.user_id === state.user.id && x.log_date === state.date) || null;
}

/** Apply a live database change without reloading everything. */
function mergeChange(list, change) {
  if (change.eventType === "DELETE") {
    const id = change.old?.id;
    return id ? list.filter((x) => x.id !== id) : list;
  }
  const row = change.new;
  if (!row?.id) return list;
  const i = list.findIndex((x) => x.id === row.id);
  if (i === -1) return list.concat(row);
  const copy = list.slice();
  copy[i] = row;
  return copy;
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
  checkStreak();
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
    // When you last touched the keyboard or mouse, and a heartbeat so stale entries can be spotted.
    active_at: Date.now() - (state.idleSec || 0) * 1000,
    hb: Date.now(),
  };
}

const AWAY_AFTER_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 3 * 60 * 1000;

/** online = touched the Mac in the last 5 min; away = app open but idle; offline = gone or stale. */
function presenceStatus(p) {
  const pres = state.presence[p.id];
  const now = Date.now();
  // Old app versions don't send a heartbeat; treat them as plain online.
  if (pres && pres.hb && now - pres.hb > STALE_AFTER_MS) return { kind: "offline", lastMs: pres.active_at || Date.parse(p.last_seen) || 0 };
  if (!pres) return { kind: "offline", lastMs: Date.parse(p.last_seen) || 0 };
  if (pres.active_at && now - pres.active_at > AWAY_AFTER_MS) return { kind: "away", lastMs: pres.active_at };
  return { kind: "online", lastMs: now };
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
    state.logs = mergeChange(state.logs, change);
    state.today = state.logs.find((x) => x.user_id === state.user.id && x.log_date === state.date) || null;
    renderBody();
    if (row && row.user_id !== state.user.id && (row.wins || 0) > prevWins) {
      const who = state.profiles.find((p) => p.id === row.user_id);
      celebrate(partnerWinCheer({ name: who?.name, winsToday: row.wins, after: standings(0), myId: state.user.id }));
    }
  });
  ch.on("postgres_changes", { event: "*", schema: "public", table: "flow_sessions" }, async (change) => {
    state.sessions = mergeChange(state.sessions, change);
    renderBody();
    if (change.eventType !== "INSERT") return;
    const row = change.new;
    if (row && row.user_id !== state.user.id && row.seconds >= CHEER_MIN_PARTNER_FLOW_MINUTES * 60) {
      const who = state.profiles.find((p) => p.id === row.user_id);
      const tz = state.presence[row.user_id]?.tz || who?.timezone || "UTC";
      celebrate(
        partnerFlowCheer({ name: who?.name, seconds: row.seconds, endMs: Date.parse(row.ended_at), tz, after: standings(0), myId: state.user.id })
      );
    }
  });
  ch.on("broadcast", { event: "poke" }, ({ payload }) => onPoke(payload));
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
  const { data: inserted, error } = await sb
    .from("flow_sessions")
    .insert({
      user_id: state.user.id,
      task: flow.task,
      started_at: new Date(flow.startedAt).toISOString(),
      ended_at: new Date(endAt).toISOString(),
      seconds: Math.min(seconds, 43200),
    })
    .select()
    .single();
  if (error) setBanner(`Couldn't log session: ${error.message}`, "err");
  else {
    setBanner(reason ? `${reason} Logged ${hm(seconds)}.` : `Logged ${hm(seconds)} of flow.`);
    state.sessions = mergeChange(state.sessions, { eventType: "INSERT", new: inserted });
    checkStreak();
  }
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

const TABS = ["now", "log", "board", "cal"];
const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.2-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="3"/></svg>`;
const NAV_ICONS = {
  now: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.4"/><path d="M15.8 14.6c2.2.1 3.9 1.5 4.6 4"/></svg>`,
  log: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`,
  board: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`,
};
const NAV_TITLES = { now: "Now", log: "Log your day", board: "Employee of the month", cal: "Calendar & streaks" };

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((w) => (w[0] || "").toUpperCase()).join("") || "?";
}

function hues(seed) {
  let h = 0;
  for (const ch of String(seed || "x")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return [h, (h + 55) % 360];
}

// Each person gets a fixed, clearly different colour, by sign-up order (same on both Macs).
const PERSON_HUES = [[262, 222], [32, 352], [168, 200], [330, 290]];
function personHues(p) {
  const i = state.profiles.findIndex((x) => x.id === p?.id);
  return i >= 0 ? PERSON_HUES[i % PERSON_HUES.length] : hues(p?.id || p?.name);
}

function avatar(p, { size = "", status = null } = {}) {
  const st = status !== null ? `<span class="st ${status}"></span>` : "";
  return `<div class="av ${size}" style="--ring:${personColor(p)}">${esc(initials(p?.name))}${st}</div>`;
}

function ringOffset(seconds) {
  return RING_C * (1 - (seconds % 3600) / 3600);
}

function brandColumn() {
  return `
    <div class="brand">
      <div class="orb" title="Lifescale HQ"></div>
      ${state.user ? `<button class="pin ${state.pinned ? "on" : ""}" id="pinbtn" title="Mini widget: keep a small bar on screen you can drag anywhere">${ICON_PIN}</button>` : ""}
      <div id="updateslot">${state.updateReady ? `<button class="update" id="doupdate" title="Version ${esc(state.updateReady)} is ready">Update</button>` : `<small>HQ</small>`}</div>
    </div>`;
}

function wireBrand() {
  app.querySelector("#doupdate")?.addEventListener("click", restartForUpdate);
  app.querySelector("#pinbtn")?.addEventListener("click", togglePinned);
}

function renderShell() {
  state.screen = "shell";
  if (state.layout === "mini") return renderMini();
  app.classList.remove("is-mini");
  app.removeAttribute("data-tauri-drag-region");
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
      applyBarHeight();
      app.querySelector("#nav").style.setProperty("--i", TABS.indexOf(state.tab));
      app.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
      renderBody(true);
    })
  );
  renderBanner();
  applyBarHeight();
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
  if (state.layout === "mini") return renderMini();
  const el = document.getElementById("body");
  if (!el) return;
  // Don't wipe what you're typing when a live update comes in.
  const active = document.activeElement;
  if (!animate && active && el.contains(active) && /^(TEXTAREA|INPUT)$/.test(active.tagName)) {
    tick();
    return;
  }
  el.className = `content${animate ? " fade" : ""}`;
  el.innerHTML = state.tab === "now" ? nowView() : state.tab === "log" ? logView() : state.tab === "cal" ? calView() : boardView();
  wireBody(el);
  tick();
}

function personTile(p) {
  const ps = presenceStatus(p);
  const pres = ps.kind === "offline" ? null : state.presence[p.id];
  const online = ps.kind === "online";
  const tz = state.presence[p.id]?.tz || p.timezone || "UTC";
  const flowStart = pres?.flow_started_at;
  const log = latestLogFor(p.id, tz);
  const focus = pres?.focus || log?.focus;
  const np = pres?.np;
  const leader = standings(0)[0];
  const isLeader = leader && leader.points > 0 && leader.userId === p.id;
  const offset = tzOffsetHours(tz);
  const status = flowStart ? "flow" : online ? "on" : ps.kind === "away" ? "away" : "";

  const sub = flowStart
    ? `<div class="p-sub flow" data-flow-since="${flowStart}">In flow</div>`
    : `<div class="p-sub">${online ? "Online now" : ps.kind === "away" ? `Away · active ${esc(agoShort(ps.lastMs))}` : ps.lastMs ? esc(ago(new Date(ps.lastMs).toISOString())) : "Offline"}</div>`;

  return `
    <div class="tile glass grow person-tile">
      <div class="react">
        <button data-poke="nudge" title="Nudge ${esc(p.name.split(" ")[0])}">👊</button>
        <button data-poke="fire" title="Send fire">🔥</button>
        <button data-poke="call" title="Ask for a quick call">📞</button>
      </div>
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
        ${(() => { const st = streakFor(p); return st.current ? `<span class="chip" title="${st.current} day streak">🔥 <b>${st.current}</b></span>` : ""; })()}
        <span class="chip"><b>${esc(timeIn(tz))}</b>${offset ? esc(offset) : ""}</span>
        <span class="chip" title="Flow today">⏱ <b>${hm(flowTodayFor(p.id, tz))}</b></span>
        ${np ? "" : `<span class="chip" title="Wins today">🏆 <b>${log?.wins || 0}</b></span>`}
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
              <stop offset="0" stop-color="#ff9a3d"/>
              <stop offset="1" stop-color="#ff6a00"/>
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
        <span class="nm">${esc(r.name.split(" ")[0])}${i === 0 && r.points > 0 && !tie ? ` <span class="crown">♛</span>` : ""}${(() => { const pp = state.profiles.find((x) => x.id === r.userId); const st = pp ? streakFor(pp) : null; return st?.current ? ` <span class="streak" title="${st.current} day streak">🔥${st.current}</span>` : ""; })()}</span>
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
          <div class="bar"><i style="width:${Math.round((r.points / max) * 100)}%;background:${personColor({ id: r.userId })}"></i></div>
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
  wireCal(el);
  el.querySelector("#signout")?.addEventListener("click", signOut);
  el.querySelector("#flowbtn")?.addEventListener("click", toggleFlow);
  el.querySelectorAll("[data-poke]").forEach((b) => b.addEventListener("click", () => sendPoke(b.dataset.poke)));
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
  el.querySelector("#winplus")?.addEventListener("click", addWin);
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

/* ---------- instant actions (shared by bar, mini widget, menu bar and keyboard) ---------- */

function toggleFlow() {
  if (!state.user) return;
  return state.flow ? stopFlow() : startFlow();
}

async function addWin() {
  if (!state.user) return;
  const before = standings(0);
  const wins = (state.today?.wins || 0) + 1;
  if (await saveToday({ wins })) {
    renderBody();
    celebrate(myWinCheer({ winsToday: wins, before, after: standings(0), userId: state.user.id, points: POINTS_PER_WIN }));
  }
}

/* ---------- mini widget ---------- */

const PIN_KEY = "lshq.pinned";
const MINI_POS_KEY = "lshq.miniPos";

function loadPinned() {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}

function loadMiniPos() {
  try {
    const v = JSON.parse(localStorage.getItem(MINI_POS_KEY));
    return Array.isArray(v) && v.length === 2 ? v : null;
  } catch {
    return null;
  }
}

function syncPinned() {
  if (!IN_APP) return;
  const pos = loadMiniPos();
  invoke("set_pinned", { pinned: !!state.pinned, x: pos?.[0] ?? null, y: pos?.[1] ?? null }).catch(() => {});
  syncTray(true);
}

function togglePinned() {
  state.pinned = !state.pinned;
  try {
    localStorage.setItem(PIN_KEY, state.pinned ? "1" : "0");
  } catch {}
  syncPinned();
  const b = document.getElementById("pinbtn");
  if (b) b.classList.toggle("on", state.pinned);
  setBanner(state.pinned ? "Mini widget on. Drag it anywhere." : "Mini widget off.", "info", 3000);
}

const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="8" cy="12" r="1.4" fill="currentColor"/></svg>`;
const ICON_EXPAND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

function miniPartnerBlock() {
  const partner = state.profiles.find((p) => p.id !== state.user.id);
  if (!partner) return `<div class="mini-them" data-tauri-drag-region><span class="hint">Waiting for Seva</span></div>`;
  const ps = presenceStatus(partner);
  const pres = ps.kind === "offline" ? null : state.presence[partner.id];
  const flowStart = pres?.flow_started_at;
  const status = flowStart ? "flow" : ps.kind === "online" ? "on" : ps.kind === "away" ? "away" : "";
  const sub = flowStart
    ? `<div class="p-sub flow" data-flow-since="${flowStart}">In flow</div>`
    : `<div class="p-sub">${ps.kind === "online" ? "Online" : ps.kind === "away" ? `Away · ${esc(agoShort(ps.lastMs))}` : "Offline"}</div>`;
  return `
    <div class="mini-them" data-tauri-drag-region title="${esc(partner.name)}">
      ${avatar(partner, { size: "sm", status })}
      <div class="mini-txt"><b>${esc(partner.name.split(" ")[0])}</b>${sub}</div>
    </div>`;
}

function renderMini() {
  if (!state.user || !state.me) return;
  const running = !!state.flow;
  const st = streakFor(state.me);
  app.classList.add("is-mini");
  app.setAttribute("data-tauri-drag-region", "");
  app.innerHTML = `
    <div class="orb mini-orb" data-tauri-drag-region title="Drag to move"></div>
    <button class="play mini-play ${running ? "stop" : ""}" id="miniflow" title="${running ? "End flow" : "Start flow"} (Space)">${running ? ICON_STOP : ICON_PLAY}</button>
    <div class="mini-me" data-tauri-drag-region>
      <div class="mini-clock ${running ? "live" : ""}" id="myclock">${running ? clock(flowElapsed()) : "Start flow"}</div>
      <div class="hint">${hm(flowTodayFor(state.user.id, MY_TZ))} today${st.current ? ` · 🔥${st.current}` : ""}</div>
    </div>
    <div class="mini-sep"></div>
    ${miniPartnerBlock()}
    <button class="mini-btn" id="miniwin" title="Log a win">🏆</button>
    <button class="mini-btn" id="mininudge" title="Nudge Seva">👊</button>
    <button class="mini-btn icon" id="miniexpand" title="Open (⌥⇧Space)">${ICON_EXPAND}</button>`;
  app.querySelector("#miniflow").addEventListener("click", toggleFlow);
  app.querySelector("#miniwin").addEventListener("click", addWin);
  app.querySelector("#mininudge").addEventListener("click", () => sendPoke("nudge"));
  app.querySelector("#miniexpand").addEventListener("click", () => IN_APP && invoke("expand_bar").catch(() => {}));
  tick();
}

function onLayout(layout) {
  state.layout = layout;
  if (layout === "mini") {
    if (state.user && state.me) renderMini();
    return;
  }
  app.classList.remove("is-mini");
  app.removeAttribute("data-tauri-drag-region");
  if (!state.user) return;
  if (state.screen === "checkin") renderCheckin();
  else if (state.screen === "shell") renderShell();
}

/* ---------- menu bar ---------- */

let lastTray = "";
function syncTray(force = false) {
  if (!IN_APP) return;
  const title = state.flow ? clock(flowElapsed()) : null;
  const key = `${title}|${!!state.flow}|${!!state.pinned}`;
  if (!force && key === lastTray) return;
  lastTray = key;
  invoke("set_tray_state", { title, flowing: !!state.flow, pinned: !!state.pinned }).catch(() => {});
}

/* ---------- nudges & reactions ---------- */

const POKES = {
  nudge: { icon: "👊", title: (n) => `${n} nudged you.`, subtitle: "Lock in.", sent: "Nudge sent 👊" },
  fire: { icon: "🔥", title: (n) => `${n} sent you fire.`, subtitle: "Keep going.", sent: "Fire sent 🔥" },
  clap: { icon: "👏", title: (n) => `${n} is clapping for you.`, subtitle: "Respect.", sent: "Clap sent 👏" },
  call: { icon: "📞", title: (n) => `${n} wants a quick call.`, subtitle: "Hop on when you're free.", sent: "Call request sent 📞" },
};
const lastPoke = {};

function sendPoke(kind) {
  const partner = state.profiles.find((p) => p.id !== state.user?.id);
  if (!partner || !state.channel || !POKES[kind]) return;
  const now = Date.now();
  if (lastPoke[kind] && now - lastPoke[kind] < 8000) {
    setBanner("Easy, give it a second.", "info", 2000);
    return;
  }
  lastPoke[kind] = now;
  state.channel
    .send({ type: "broadcast", event: "poke", payload: { from: state.user.id, fromName: state.me?.name, to: partner.id, kind } })
    .catch(() => {});
  setBanner(POKES[kind].sent, "info", 2500);
}

function onPoke(p) {
  if (!p || p.to !== state.user?.id || !POKES[p.kind]) return;
  const k = POKES[p.kind];
  const name = String(p.fromName || "Your partner").split(" ")[0];
  celebrate({ kind: "poke", icon: k.icon, title: k.title(name), subtitle: k.subtitle, chips: [], intensity: p.kind === "fire" ? 1 : 0, palette: "cool", duration: 3800 });
}

/* ---------- keyboard ---------- */

function typing() {
  const a = document.activeElement;
  return a && /^(TEXTAREA|INPUT)$/.test(a.tagName);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (typing()) document.activeElement.blur();
    if (IN_APP) invoke("dismiss").catch(() => {});
    return;
  }
  if (typing() || e.metaKey || e.ctrlKey || e.altKey || !state.user || state.screen !== "shell") return;
  if (e.code === "Space") {
    e.preventDefault();
    toggleFlow();
  } else if (e.key === "w" || e.key === "W") {
    addWin();
  } else if (/^[1-4]$/.test(e.key) && state.layout !== "mini") {
    const tab = TABS[Number(e.key) - 1];
    app.querySelector(`[data-tab="${tab}"]`)?.click();
  }
});

/* ---------- streaks & calendar ---------- */

const CAL_HEIGHT = 480;
const BAR_HEIGHT_PX = 156;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function tzFor(p) {
  if (p.id === state.user.id) return MY_TZ;
  return state.presence[p.id]?.tz || p.timezone || "UTC";
}

// You are white, everyone else is orange (so on Seva's Mac, he's white and you're orange).
const ME_COLOR = "#ffffff";
const THEM_COLOR = "#ff7a1a";
function personColor(p) {
  return p?.id && state.user && p.id === state.user.id ? ME_COLOR : THEM_COLOR;
}

function daysFor(p) {
  return dayMap(state.sessions, state.logs, p.id, tzFor(p));
}

function streakFor(p) {
  return streaks(daysFor(p), localDate(new Date(), tzFor(p)));
}

function setBarHeight(h) {
  if (IN_APP) invoke("set_bar_height", { height: h }).catch(() => {});
}

function calState() {
  if (!state.cal) {
    const now = new Date();
    state.cal = { mode: "month", year: now.getFullYear(), month: now.getMonth(), selected: localDate() };
  }
  return state.cal;
}

function orderedPeople() {
  // You first, then everyone else.
  return [...state.profiles].sort((a, b) => (b.id === state.user.id) - (a.id === state.user.id));
}

function calView() {
  const c = calState();
  const people = orderedPeople();
  const streakChips = people
    .map((p) => {
      const s = streakFor(p);
      return `<span class="chip" title="Best streak: ${s.best} days"><span class="dot" style="background:${personColor(p)}"></span>${esc(p.name.split(" ")[0])} <b>🔥 ${s.current}</b><span class="hint">best ${s.best}</span></span>`;
    })
    .join("");
  const label = c.mode === "month" ? `${new Date(c.year, c.month, 1).toLocaleString("en-GB", { month: "long" })} ${c.year}` : String(c.year);

  return `
    <div class="cal">
      <div class="cal-head">
        <div class="seg glass">
          <button class="${c.mode === "month" ? "on" : ""}" data-cal-mode="month">Month</button>
          <button class="${c.mode === "year" ? "on" : ""}" data-cal-mode="year">Year</button>
        </div>
        <button class="arrow" data-cal-nav="-1" aria-label="Previous">‹</button>
        <div class="cal-label">${esc(label)}</div>
        <button class="arrow" data-cal-nav="1" aria-label="Next">›</button>
        <div class="chips cal-streaks">${streakChips}</div>
      </div>
      <div class="cal-body">${c.mode === "month" ? monthView(c, people) : yearView(c, people)}</div>
    </div>`;
}

function monthView(c, people) {
  const maps = people.map((p) => ({ p, days: daysFor(p) }));
  const weeks = monthGrid(c.year, c.month);
  const keys = weeks.flat().filter(Boolean);
  const maxFlow = Math.max(3600, ...maps.flatMap(({ days }) => keys.map((k) => days.get(k)?.flowSec || 0)));
  const today = localDate();

  const cells = weeks
    .map((week) =>
      week
        .map((k) => {
          if (!k) return `<div class="day blank"></div>`;
          const future = k > today;
          const bars = maps
            .map(({ p, days }) => {
              const d = days.get(k);
              const active = isActive(d);
              const w = d?.flowSec ? Math.max(8, Math.round((d.flowSec / maxFlow) * 100)) : active ? 4 : 0;
              return `<div class="dbar" title="${esc(p.name.split(" ")[0])}: ${d?.flowSec ? hm(d.flowSec) : active ? "checked in" : "nothing"}"><i style="width:${w}%;background:${personColor(p)}"></i></div>`;
            })
            .join("");
          const top = maps
            .map(({ p, days }) => ({ p, f: days.get(k)?.flowSec || 0 }))
            .sort((a, b) => b.f - a.f);
          const crown = top[0]?.f > 0 && (!top[1] || top[0].f > top[1].f) ? `<span class="dcrown" style="color:${personColor(top[0].p, 70)}">●</span>` : "";
          return `
            <button class="day ${k === today ? "today" : ""} ${k === c.selected ? "sel" : ""} ${future ? "future" : ""}" data-day="${k}">
              <span class="dnum">${Number(k.slice(8))}</span>${crown}
              <div class="dbars">${bars}</div>
            </button>`;
        })
        .join("")
    )
    .join("");

  return `
    <div class="tile glass month">
      <div class="wk">${WEEKDAYS.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="grid" style="grid-template-rows:repeat(${weeks.length},1fr)">${cells}</div>
    </div>
    ${dayDetail(c, maps)}`;
}

function dayDetail(c, maps) {
  const k = c.selected;
  const [y, m, d] = k.split("-").map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const rows = maps
    .map(({ p, days }) => {
      const day = days.get(k);
      const late = day?.lastEndMs && hourOf(day.lastEndMs, tzFor(p)) < 5 && day.lastEndMs > Date.parse(`${k}T00:00:00Z`) ? ` · till ${clockLabel(day.lastEndMs, tzFor(p))}` : "";
      return `
        <div class="dd-person">
          <div class="dd-head">${avatar(p, { size: "sm" })}<b>${esc(p.name.split(" ")[0])}</b>
            <span class="hint">${day?.flowSec ? `${hm(day.flowSec)} flow${late}` : isActive(day) ? "Checked in" : "No activity"}</span></div>
          ${day && isActive(day) ? `
            <div class="chips" style="margin-top:6px">
              <span class="chip">Sessions <b>${day.sessions}</b></span>
              <span class="chip">Longest <b>${day.longestSec ? hm(day.longestSec) : "0m"}</b></span>
              <span class="chip">Wins <b>${day.wins}</b></span>
            </div>
            ${day.focus ? `<div class="clamp" style="margin-top:6px"><span class="label">Focus</span> ${esc(day.focus)}</div>` : ""}
            ${day.notes ? `<div class="clamp" style="margin-top:4px"><span class="label">Done</span> ${esc(day.notes)}</div>` : ""}` : ""}
        </div>`;
    })
    .join("");
  return `
    <div class="tile glass dd">
      <div class="label">${esc(label)}</div>
      ${rows}
    </div>`;
}

function rangeOfMonth(y, m) {
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 1);
  return { start, end, label: start.toLocaleString("en-GB", { month: "long", year: "numeric" }) };
}

function scoredFor(range) {
  return state.profiles.map((p) => ({ ...scoreFor(p.id, range), name: p.name, p }));
}

function yearSummary(year) {
  const now = new Date();
  const months = [];
  for (let m = 0; m < 12; m++) {
    const range = rangeOfMonth(year, m);
    const status = range.end <= now ? "done" : range.start <= now ? "live" : "future";
    const rows = scoredFor(range);
    months.push({ m, range, status, rows, result: winnerOf(rows) });
  }
  const yearRange = { start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
  const totals = scoredFor(yearRange).map((r) => ({
    ...r,
    crowns: months.filter((x) => x.status === "done" && x.result.kind === "winner" && x.result.winner.userId === r.userId).length,
  }));
  const yearDone = yearRange.end <= now;
  return { months, totals, result: winnerOf(totals), yearDone };
}

function yearView(c, people) {
  const ys = yearSummary(c.year);
  const maxPts = Math.max(1, ...ys.months.flatMap((x) => x.rows.map((r) => r.points)));

  const tiles = ys.months
    .map(({ m, status, rows, result }) => {
      let body;
      if (status === "future") body = `<div class="hint">Upcoming</div>`;
      else if (result.kind === "winner") {
        const w = result.winner;
        body = `<div class="mwin">${avatar(w.p, { size: "sm" })}<b>${esc(w.name.split(" ")[0])}</b>${status === "done" ? `<span class="crown">👑</span>` : ""}</div>${status === "live" ? `<div class="hint">Leading · ${w.points} pts</div>` : `<div class="hint">${w.points} pts</div>`}`;
      } else if (result.kind === "tie") body = `<div class="mwin"><b>Tie</b></div>`;
      else body = `<div class="hint">${status === "live" ? "Nothing yet" : "No data"}</div>`;
      const bars = people
        .map((p) => {
          const r = rows.find((x) => x.userId === p.id);
          return `<div class="dbar"><i style="width:${Math.round(((r?.points || 0) / maxPts) * 100)}%;background:${personColor(p)}"></i></div>`;
        })
        .join("");
      return `
        <button class="mtile glass ${status}" data-month="${m}">
          <div class="mname">${MONTHS_SHORT[m]}${status === "live" ? ` <span class="live">live</span>` : ""}</div>
          ${body}
          <div class="dbars">${bars}</div>
        </button>`;
    })
    .join("");

  const maxTotal = Math.max(1, ...ys.totals.map((t) => t.points));
  const race = [...ys.totals]
    .sort((a, b) => b.points - a.points)
    .map(
      (t, i) => `
      <div class="rank ${i === 0 && ys.result.kind === "winner" ? "lead" : ""}">
        ${avatar(t.p, { size: "sm" })}
        <div class="who"><b>${esc(t.name.split(" ")[0])}</b><small>${t.crowns} ${t.crowns === 1 ? "crown" : "crowns"} · ${hm(t.flowSec)} flow</small>
          <div class="bar"><i style="width:${Math.round((t.points / maxTotal) * 100)}%;background:${personColor(t.p)}"></i></div></div>
        <span class="pts">${t.points}</span>
      </div>`
    )
    .join("");

  let hero;
  if (ys.yearDone && ys.result.kind === "winner") {
    const w = ys.result.winner;
    hero = `<div class="eoy">${avatar(w.p, { size: "lg" })}<div><div class="crown-big">👑 Employee of the Year</div><div class="big">${esc(w.name)}</div></div></div>`;
  } else if (ys.yearDone) {
    hero = `<div class="eoy"><div><div class="crown-big">👑 ${c.year}</div><div class="big">${ys.result.kind === "tie" ? "Dead heat" : "No data"}</div></div></div>`;
  } else {
    hero = `<div class="eoy"><div><div class="crown-big">👑 Race for ${c.year}</div><div class="small">Most points across the year. Crowned 1 January.</div></div></div>`;
  }

  return `
    <div class="months">${tiles}</div>
    <div class="tile glass yr">
      ${hero}
      ${race}
    </div>`;
}

function wireCal(el) {
  el.querySelectorAll("[data-cal-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      calState().mode = b.dataset.calMode;
      renderBody();
    })
  );
  el.querySelectorAll("[data-cal-nav]").forEach((b) =>
    b.addEventListener("click", () => {
      const c = calState();
      const step = Number(b.dataset.calNav);
      if (c.mode === "year") c.year += step;
      else {
        const d = new Date(c.year, c.month + step, 1);
        c.year = d.getFullYear();
        c.month = d.getMonth();
      }
      renderBody();
    })
  );
  el.querySelectorAll("[data-day]").forEach((b) =>
    b.addEventListener("click", () => {
      calState().selected = b.dataset.day;
      renderBody();
    })
  );
  el.querySelectorAll("[data-month]").forEach((b) =>
    b.addEventListener("click", () => {
      const c = calState();
      c.mode = "month";
      c.month = Number(b.dataset.month);
      const firstOfMonth = `${c.year}-${String(c.month + 1).padStart(2, "0")}-01`;
      c.selected = localDate().startsWith(firstOfMonth.slice(0, 7)) ? localDate() : firstOfMonth;
      renderBody();
    })
  );
}

function applyBarHeight() {
  const tall = state.tab === "cal";
  document.documentElement.classList.toggle("tall", tall);
  setBarHeight(tall ? CAL_HEIGHT : BAR_HEIGHT_PX);
}

/* ---------- screens ---------- */

function renderAuth(mode = "in", msg = "") {
  stopLoops();
  state.screen = "auth";
  app.classList.remove("is-mini");
  app.removeAttribute("data-tauri-drag-region");
  document.documentElement.classList.remove("tall");
  setBarHeight(BAR_HEIGHT_PX);
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
  state.screen = "checkin";
  if (state.layout === "mini") return renderMini();
  app.classList.remove("is-mini");
  app.removeAttribute("data-tauri-drag-region");
  document.documentElement.classList.remove("tall");
  setBarHeight(BAR_HEIGHT_PX);
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
  const idle = await native("idle_seconds");
  if (idle != null) {
    const wasAway = (state.idleSec || 0) * 1000 > AWAY_AFTER_MS;
    state.idleSec = idle;
    const isAway = idle * 1000 > AWAY_AFTER_MS;
    // Tell the other person straight away when you go away or come back.
    if (wasAway !== isAway) track();
  }
  if (!state.flow) return;
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
  syncTray();
}

async function heartbeat() {
  const lastActive = new Date(Date.now() - (state.idleSec || 0) * 1000).toISOString();
  await sb.from("profiles").update({ last_seen: lastActive, timezone: MY_TZ }).eq("id", state.user.id);
}

function startLoops() {
  state.timers.push(setInterval(secondTick, 1000));
  state.timers.push(setInterval(pollMusic, 10000));
  state.timers.push(setInterval(pollIdle, 30000));
  state.timers.push(setInterval(heartbeat, 120000));
  // Presence heartbeat, and re-render so "away" and stale people update even without new events.
  state.timers.push(setInterval(() => {
    track();
    if (state.tab === "now") renderBody();
  }, 60000));
  state.timers.push(setInterval(async () => {
    await Promise.all([loadProfiles(), loadActivity()]);
    renderBody();
  }, 30 * 60 * 1000));
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
  maybeCrownYear();
  // Pick up the cutoff check straight away if the app was closed mid-session.
  secondTick();
  joinPresence();
  startLoops();
  state.pinned = loadPinned();
  syncPinned();
  pollMusic();
  if (state.today?.focus) renderShell();
  else renderCheckin();
}

/** After anything you log: fireworks if today just pushed your streak to a milestone. */
function checkStreak() {
  if (!state.me) return;
  const st = streakFor(state.me);
  if (!st.activeToday || !STREAK_MILESTONES.includes(st.current)) return;
  const key = "lshq.streakCheer";
  const mark = `${st.current}:${localDate()}`;
  try {
    if (localStorage.getItem(key) === mark) return;
    localStorage.setItem(key, mark);
  } catch {
    return;
  }
  setTimeout(() => celebrate(streakCheer({ days: st.current, best: st.best })), 400);
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

/** First open of a new year: crown last year's Employee of the Year, once. */
function maybeCrownYear() {
  const year = new Date().getFullYear() - 1;
  const ys = yearSummary(year);
  if (ys.result.kind !== "winner") return;
  const key = "lshq.crownedYear";
  try {
    if (localStorage.getItem(key) === String(year)) return;
    localStorage.setItem(key, String(year));
  } catch {
    return;
  }
  const w = ys.result.winner;
  setTimeout(() => celebrate(yearCrownCheer({ winner: w, year, isMe: w.userId === state.user.id })), 2500);
}

async function signOut() {
  if (state.flow) await stopFlow(Date.now(), null, { quiet: true });
  state.pinned = false;
  syncPinned();
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
  listen("layout", (e) => onLayout(e.payload)).catch(() => {});
  listen("mini-moved", (e) => {
    try {
      localStorage.setItem(MINI_POS_KEY, JSON.stringify(e.payload));
    } catch {}
  }).catch(() => {});
  listen("tray-action", (e) => {
    if (e.payload === "flow") toggleFlow();
    else if (e.payload === "win") addWin();
    else if (e.payload === "pin") togglePinned();
  }).catch(() => {});
  listen("bar-shown", () => {
    app.classList.remove("drop");
    void app.offsetWidth;
    app.classList.add("drop");
  }).catch(() => {});
  setTimeout(checkForUpdate, 5000);
  setInterval(checkForUpdate, 3 * 60 * 60 * 1000);
}

// Browser previews only: switch layouts by hand.
if (!IN_APP) window.__layout = onLayout;
