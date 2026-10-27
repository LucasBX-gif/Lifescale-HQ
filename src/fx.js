// Full-screen celebration overlay: fireworks on a canvas plus a glass message card.
// The window is transparent and click-through; it shows itself, plays, then asks to be hidden.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const IN_APP = "__TAURI_INTERNALS__" in window;
if (!IN_APP) document.documentElement.classList.add("preview");

const canvas = document.getElementById("sky");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");

const PALETTES = {
  gold: { hues: [42, 48, 30, 55], glow: "rgba(255, 200, 80, 0.45)", sat: 95 },
  warm: { hues: [28, 340, 12, 45], glow: "rgba(255, 140, 110, 0.4)", sat: 95 },
  night: { hues: [250, 200, 285, 220], glow: "rgba(140, 120, 255, 0.45)", sat: 90 },
  cool: { hues: [190, 160, 260, 210], glow: "rgba(92, 200, 255, 0.4)", sat: 90 },
};

let dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
}
resize();
addEventListener("resize", resize);

/* ---------- fireworks engine ---------- */

let rockets = [];
let sparks = [];
let running = false;

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function launch(palette, opts = {}) {
  const W = canvas.width, H = canvas.height;
  const x = opts.x ?? rand(0.12, 0.88) * W;
  const ty = opts.ty ?? rand(0.12, 0.42) * H;
  const hue = palette.hues[Math.floor(Math.random() * palette.hues.length)];
  rockets.push({ x, y: H + 10 * dpr, vx: rand(-0.6, 0.6) * dpr, vy: -rand(12, 15.5) * dpr * (H / (1000 * dpr)) ** 0.5, ty, hue, sat: palette.sat });
}

function explode(r, big) {
  const n = Math.round(rand(big ? 110 : 70, big ? 150 : 100));
  const power = rand(big ? 5.5 : 4, big ? 7.5 : 5.5) * dpr;
  const ring = Math.random() < 0.3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(-0.05, 0.05);
    const s = ring ? power : power * Math.sqrt(Math.random());
    const hue = r.hue + rand(-14, 14);
    sparks.push({
      x: r.x, y: r.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 1, decay: rand(0.008, 0.016),
      hue, sat: r.sat, light: rand(58, 72),
      size: rand(1.4, 2.6) * dpr,
      twinkle: Math.random() < 0.25,
    });
  }
  // A white core flash.
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2, s = rand(0.5, 2.2) * dpr;
    sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, decay: 0.05, hue: 50, sat: 20, light: 95, size: 2.6 * dpr, twinkle: false });
  }
}

function frame() {
  const gravity = 0.055 * dpr;
  // Fade the previous frame (keeps soft trails on a transparent canvas).
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "lighter";

  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.x += r.vx;
    r.y += r.vy;
    r.vy += gravity * 0.6;
    ctx.fillStyle = `hsla(${r.hue}, 100%, 80%, 0.9)`;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 2.2 * dpr, 0, Math.PI * 2);
    ctx.fill();
    if (r.y <= r.ty || r.vy >= 0) {
      explode(r, Math.random() < 0.5);
      rockets.splice(i, 1);
    }
  }

  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.vx *= 0.982;
    p.vy = p.vy * 0.982 + gravity;
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    if (p.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }
    const alpha = p.twinkle ? p.life * (0.4 + 0.6 * Math.abs(Math.sin(p.life * 40))) : p.life;
    ctx.fillStyle = `hsla(${p.hue}, ${p.sat}%, ${p.light}%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.5 + p.life * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  if (running || rockets.length || sparks.length) requestAnimationFrame(frame);
  else ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function show(c) {
  const palette = PALETTES[c.palette] || PALETTES.warm;
  const intensity = c.intensity || 2;
  const total = c.duration || (intensity >= 3 ? 6000 : intensity === 2 ? 5000 : 4200);
  const rocketsToFire = { 1: 3, 2: 6, 3: 11 }[intensity] || 6;
  const small = c.kind === "partner";

  stage.innerHTML = `
    <div class="card ${small ? "small" : ""}" style="--glow:${palette.glow}">
      <div class="icon">${esc(c.icon || "🔥")}</div>
      ${c.badge ? `<div><span class="badge">${esc(c.badge)}</span></div>` : ""}
      <div class="title">${esc(c.title)}</div>
      ${c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : ""}
      ${c.chips?.length ? `<div class="chips">${c.chips
        .map((t, i) => `<span class="chip ${/lead|behind|level/i.test(t) && i > 0 ? "lead" : ""}" style="animation-delay:${0.4 + i * 0.08}s">${esc(t)}</span>`)
        .join("")}</div>` : ""}
    </div>`;

  // Opening volley around the card, then a staggered show.
  const W = canvas.width;
  launch(palette, { x: W * 0.32, ty: canvas.height * 0.2 });
  launch(palette, { x: W * 0.68, ty: canvas.height * 0.22 });
  for (let i = 2; i < rocketsToFire; i++) setTimeout(() => launch(palette), 250 + i * rand(260, 420));

  running = true;
  requestAnimationFrame(frame);

  return new Promise((resolve) => {
    setTimeout(() => {
      stage.querySelector(".card")?.classList.add("out");
    }, total - 500);
    setTimeout(() => {
      stage.innerHTML = "";
      running = false;
      resolve();
    }, total);
  });
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------- queue ---------- */

const queue = [];
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await show(queue.shift());
  // Let the last sparks fall before hiding.
  await new Promise((r) => setTimeout(r, 1400));
  busy = false;
  if (queue.length) return pump();
  if (IN_APP) invoke("fx_done").catch(() => {});
}

function enqueue(c) {
  if (!c || !c.title) return;
  if (queue.length >= 3) queue.shift();
  queue.push(c);
  pump();
}

if (IN_APP) {
  listen("celebrate", (e) => enqueue(e.payload)).catch(() => {});
} else {
  // Browser preview: fx.html?demo=<json>
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo) enqueue(JSON.parse(demo));
  window.enqueue = enqueue;
}
