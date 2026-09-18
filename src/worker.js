/**
 * Worker script for wobble-lab-site.
 *
 * Routes, then everything else falls through to the static site in public/
 * via the ASSETS binding (configured in wrangler.jsonc):
 *
 *   POST /event         store one analytics event in KV (public, unauthenticated
 *                        by necessity — any visitor's browser calls this)
 *   GET  /analytics      all daily rollups, newest first            [admin]
 *   GET  /analytics/raw  raw events from the last 24h, for debugging [admin]
 *   GET  /funnel         TikTok -> Jelly funnel over a date range    [admin]
 *   GET  /performance    aggregated WebGPU/FPS metrics               [admin]
 *   GET  /dashboard      the HTML dashboard shell                    [public shell,
 *                        the data fetches it makes from the browser are admin-gated]
 *
 * [admin] routes require header  X-Analytics-Key: <ANALYTICS_KEY secret>.
 *
 * A daily cron (see wrangler.jsonc "triggers") calls scheduled() below, which
 * aggregates the last 24h of raw events into one rollup:YYYY-MM-DD record and
 * deletes raw events older than 48h, so the admin endpoints stay cheap (a
 * handful of rollup reads) instead of re-scanning every event ever stored.
 */

import dashboardHtml from "./dashboard.html";

const DAY_MS = 86400000;
const MAX_EVENT_BYTES = 8192;

/* ------------------------------------------------------------- utilities */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function isAuthorized(request, env) {
  const key = request.headers.get("X-Analytics-Key");
  return Boolean(env.ANALYTICS_KEY) && key === env.ANALYTICS_KEY;
}

function unauthorized() {
  return new Response("unauthorized", { status: 401 });
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function clampDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(90, Math.max(1, n));
}

/** Buckets a bare hostname (already lowercased, no "www.") into a source name. */
function classifyReferrer(host) {
  if (!host) return "Direct";
  const is = (...domains) => domains.some(d => host === d || host.endsWith("." + d));
  if (is("tiktok.com")) return "TikTok";
  if (is("instagram.com")) return "Instagram";
  if (is("facebook.com", "fb.com")) return "Facebook";
  if (is("google.com")) return "Google Search";
  if (is("youtube.com") || host === "youtu.be") return "YouTube";
  if (is("twitter.com", "x.com")) return "Twitter/X";
  if (is("reddit.com")) return "Reddit";
  if (is("pinterest.com")) return "Pinterest";
  if (is("linkedin.com")) return "LinkedIn";
  if (is("snapchat.com")) return "Snapchat";
  if (is("discord.com")) return "Discord";
  if (is("wobble-lab.com", "workers.dev")) return "Internal";
  return "Other";
}

/** Buckets a full document.referrer URL via classifyReferrer(). */
function classifySource(referrerRaw) {
  if (!referrerRaw) return "Direct";
  let host;
  try { host = new URL(referrerRaw).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return "Other"; }
  return classifyReferrer(host);
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function listByPrefix(env, prefix) {
  const out = [];
  let cursor;
  do {
    const list = await env.ANALYTICS.list({ prefix, cursor });
    for (const k of list.keys) {
      const v = await env.ANALYTICS.get(k.name);
      if (!v) continue;
      try { out.push({ key: k.name, ...JSON.parse(v) }); } catch { /* skip corrupt record */ }
    }
    cursor = list.cursor;
  } while (cursor);
  return out;
}

/** Buckets `values` into fixed ranges. `edges` has one fewer entry than `labels` — the last label catches everything >= the last edge. */
function histogram(values, edges, labels) {
  const counts = new Array(labels.length).fill(0);
  for (const v of values) {
    let idx = edges.findIndex(e => v < e);
    if (idx === -1) idx = labels.length - 1;
    counts[idx]++;
  }
  return labels.map((label, i) => ({ label, count: counts[i] }));
}

const FPS_EDGES = [15, 30, 45, 60, 75], FPS_LABELS = ["0-15", "15-30", "30-45", "45-60", "60-75", "75+"];
const GPU_EDGES = [8, 16, 24, 33, 50], GPU_LABELS = ["0-8ms", "8-16ms", "16-24ms", "24-33ms", "33-50ms", "50ms+"];
const ENERGY_EDGES = [.01, .1, 1, 5, 10], ENERGY_LABELS = ["0-0.01", "0.01-0.1", "0.1-1", "1-5", "5-10", "10+"];

async function listRollups(env, limit) {
  const rollups = (await listByPrefix(env, "rollup:")).map(({ key, ...r }) => r); // KV key name is an implementation detail, not data
  rollups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  return typeof limit === "number" ? rollups.slice(0, limit) : rollups;
}

/* ----------------------------------------------------------- POST /event */

async function handleEvent(request, env) {
  const text = await request.text();
  if (text.length > MAX_EVENT_BYTES) return new Response("payload too large", { status: 413 });

  let body;
  try { body = JSON.parse(text); }
  catch { return new Response("bad request", { status: 400 }); }

  if (!body || typeof body.event !== "string" || !body.event || body.event.length > 100) {
    return new Response("bad request", { status: 400 });
  }

  // request.cf is only populated for requests that actually traversed
  // Cloudflare's edge — real production traffic. In local `wrangler dev` it's
  // either absent or filled with a fixed placeholder location, so geo will
  // look fake (or empty) until this is genuinely deployed.
  const cf = request.cf || {};

  const record = {
    event: body.event,
    page: typeof body.page === "string" ? body.page.slice(0, 300) : null,
    sid: typeof body.sid === "string" ? body.sid.slice(0, 100) : null,
    extra: body.extra ?? null,
    timestamp: new Date().toISOString(),
    ip: request.headers.get("CF-Connecting-IP") || null,
    userAgent: request.headers.get("User-Agent") || null,
    geo: {
      country: cf.country || null,
      city: cf.city || null,
      latitude: cf.latitude != null ? Number(cf.latitude) : null,
      longitude: cf.longitude != null ? Number(cf.longitude) : null
    }
  };

  await env.ANALYTICS.put(`e:${crypto.randomUUID()}`, JSON.stringify(record));
  return new Response("ok");
}

/* --------------------------------------------------------------- rollup */

async function runRollup(env) {
  const end = Date.now();
  const start = end - DAY_MS;
  const cutoff48 = end - 2 * DAY_MS;
  const date = dateStr(new Date(start));

  const all = await listByPrefix(env, "e:");
  const dayEvents = all.filter(e => {
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) && t >= start && t <= end;
  });

  // First Pageview per session id decides that session's traffic source.
  // This is what lets a later Jelly Click be attributed back to "arrived via
  // TikTok" for the funnel, without any persistent cross-visit identity.
  const sourceBySid = new Map();
  for (const e of dayEvents) {
    if (e.event === "Pageview" && e.sid && !sourceBySid.has(e.sid)) {
      sourceBySid.set(e.sid, classifySource(e.extra && e.extra.referrer));
    }
  }

  const byEvent = {}, byPage = {}, bySource = {}, byPageDetail = {};
  const byCountry = {}, byCity = {};
  const visitorHashes = new Set();
  const allSids = new Set();
  let fpsSum = 0, fpsN = 0, minFPS = Infinity;
  let gpuSum = 0, gpuN = 0, maxGPU = 0;
  let energySum = 0, energyN = 0;
  const fpsValues = [], gpuValues = [], energyValues = [];
  const perfByPage = {};

  // One dot per (event type, city) for the world map — Jelly Click / Jelly
  // Rest use each event's own geo; "TikTok Arrival" uses Pageview events
  // whose referrer classified as TikTok. Keyed on city+country since city
  // names collide across countries (there is more than one "Paris").
  const mapPoints = new Map();
  const addMapPoint = (type, geo) => {
    if (!geo || !geo.city) return;
    const key = `${type}|${geo.city}|${geo.country || ""}`;
    const p = mapPoints.get(key) || { type, city: geo.city, country: geo.country || null, lat: geo.latitude, lon: geo.longitude, count: 0 };
    p.count++;
    mapPoints.set(key, p);
  };

  const pageDetail = page => byPageDetail[page] || (byPageDetail[page] =
    { pageviews: 0, jellyClicks: 0, jellyOscillations: 0, jellyRests: 0 });

  for (const e of dayEvents) {
    byEvent[e.event] = (byEvent[e.event] || 0) + 1;
    if (e.page) byPage[e.page] = (byPage[e.page] || 0) + 1;

    if (e.page) {
      const d = pageDetail(e.page);
      if (e.event === "Pageview") d.pageviews++;
      else if (e.event === "Jelly Click") d.jellyClicks++;
      else if (e.event === "Jelly Oscillation") d.jellyOscillations++;
      else if (e.event === "Jelly Rest") d.jellyRests++;
    }

    let src = null;
    if (e.event === "Pageview") {
      src = classifySource(e.extra && e.extra.referrer);
      bySource[src] = (bySource[src] || 0) + 1;
    }

    if (e.geo) {
      if (e.geo.country) byCountry[e.geo.country] = (byCountry[e.geo.country] || 0) + 1;
      if (e.geo.city) byCity[e.geo.city] = (byCity[e.geo.city] || 0) + 1;
    }
    if (e.event === "Jelly Click") addMapPoint("Jelly Click", e.geo);
    else if (e.event === "Jelly Rest") addMapPoint("Jelly Rest", e.geo);
    else if (e.event === "Pageview" && src === "TikTok") addMapPoint("TikTok Arrival", e.geo);

    // Daily-salted hash: good enough to count roughly how many distinct
    // visitors showed up today without storing a persistent identifier.
    if (e.ip || e.userAgent) {
      visitorHashes.add(await sha256Hex(`${date}|${e.ip || ""}|${e.userAgent || ""}`));
    }
    if (e.sid) allSids.add(e.sid);

    if (e.event === "Jelly Oscillation" && e.extra && typeof e.extra.energy === "number") {
      energySum += e.extra.energy; energyN++;
      energyValues.push(e.extra.energy);
    }

    if (e.event === "Performance" && e.extra) {
      const pp = perfByPage[e.page] || (perfByPage[e.page] = { fpsSum: 0, fpsN: 0, gpuSum: 0, gpuN: 0 });
      if (typeof e.extra.fps === "number") {
        fpsSum += e.extra.fps; fpsN++;
        if (e.extra.fps < minFPS) minFPS = e.extra.fps;
        pp.fpsSum += e.extra.fps; pp.fpsN++;
        fpsValues.push(e.extra.fps);
      }
      if (typeof e.extra.frameTimeMs === "number") {
        gpuSum += e.extra.frameTimeMs; gpuN++;
        if (e.extra.frameTimeMs > maxGPU) maxGPU = e.extra.frameTimeMs;
        pp.gpuSum += e.extra.frameTimeMs; pp.gpuN++;
        gpuValues.push(e.extra.frameTimeMs);
      }
    }
  }

  const perPage = {};
  for (const [page, pp] of Object.entries(perfByPage)) {
    perPage[page] = {
      avgFPS: pp.fpsN ? +(pp.fpsSum / pp.fpsN).toFixed(1) : null,
      avgGPUTime: pp.gpuN ? +(pp.gpuSum / pp.gpuN).toFixed(2) : null
    };
  }

  // TikTok -> Jelly funnel. tiktokClicks is really "sessions whose landing
  // pageview's referrer was tiktok.com" (there is no separate ad-click
  // pixel) — conversionRateTikTokToJelly is the one number here that is a
  // genuine per-session attribution, via sid; the raw byEvent counts above
  // are site-wide.
  let tiktokSessions = 0, tiktokSessionsWithClick = 0;
  const clickedSids = new Set();
  for (const e of dayEvents) if (e.event === "Jelly Click" && e.sid) clickedSids.add(e.sid);
  for (const [sid, src] of sourceBySid) {
    if (src === "TikTok") {
      tiktokSessions++;
      if (clickedSids.has(sid)) tiktokSessionsWithClick++;
    }
  }

  const landingPageViews = byEvent["Pageview"] || 0;
  const jellyClicks = byEvent["Jelly Click"] || 0;
  const jellyOscillations = byEvent["Jelly Oscillation"] || 0;
  const jellyRests = byEvent["Jelly Rest"] || 0;

  const rollup = {
    date,
    total: dayEvents.length,
    uniqueVisitors: visitorHashes.size,
    byEvent, byPage, byPageDetail, bySource,
    byCountry, byCity,
    mapPoints: Array.from(mapPoints.values()),
    performance: {
      avgFPS: fpsN ? +(fpsSum / fpsN).toFixed(1) : null,
      avgEnergy: energyN ? +(energySum / energyN).toFixed(5) : null,
      avgGPUTime: gpuN ? +(gpuSum / gpuN).toFixed(2) : null,
      maxGPUTime: gpuN ? +maxGPU.toFixed(2) : null,
      minFPS: fpsN ? +minFPS.toFixed(1) : null,
      fpsSamples: fpsN, gpuSamples: gpuN, energySamples: energyN,
      fpsHistogram: histogram(fpsValues, FPS_EDGES, FPS_LABELS),
      gpuHistogram: histogram(gpuValues, GPU_EDGES, GPU_LABELS),
      energyHistogram: histogram(energyValues, ENERGY_EDGES, ENERGY_LABELS),
      perPage
    },
    funnel: {
      sessionCount: allSids.size,
      tiktokClicks: tiktokSessions,
      landingPageViews,
      jellyClicks,
      jellyOscillations,
      jellyRests,
      conversionRateClickToJelly: landingPageViews ? +(jellyClicks / landingPageViews).toFixed(4) : 0,
      conversionRateTikTokToJelly: tiktokSessions ? +(tiktokSessionsWithClick / tiktokSessions).toFixed(4) : 0
    }
  };

  await env.ANALYTICS.put(`rollup:${date}`, JSON.stringify(rollup));

  const stale = all.filter(e => {
    const t = Date.parse(e.timestamp);
    return !Number.isFinite(t) || t < cutoff48;
  });
  await Promise.all(stale.map(e => env.ANALYTICS.delete(e.key)));

  return rollup;
}

/* ------------------------------------------------------------ admin GETs */

async function handleAnalytics(request, env) {
  if (!isAuthorized(request, env)) return unauthorized();
  return json(await listRollups(env));
}

async function handleAnalyticsRaw(request, env) {
  if (!isAuthorized(request, env)) return unauthorized();
  const all = await listByPrefix(env, "e:");
  const cutoff = Date.now() - DAY_MS;
  const recent = all
    .filter(e => { const t = Date.parse(e.timestamp); return Number.isFinite(t) && t >= cutoff; })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .map(({ key, ...e }) => e); // KV key name is an implementation detail, not data
  return json(recent);
}

async function handleFunnel(request, env) {
  if (!isAuthorized(request, env)) return unauthorized();
  const days = clampDays(new URL(request.url).searchParams.get("days"));
  const rollups = await listRollups(env, days);
  const daily = rollups.map(r => ({ date: r.date, ...r.funnel })).reverse();

  const totals = daily.reduce((acc, d) => {
    acc.sessionCount += d.sessionCount || 0;
    acc.tiktokClicks += d.tiktokClicks;
    acc.landingPageViews += d.landingPageViews;
    acc.jellyClicks += d.jellyClicks;
    acc.jellyOscillations += d.jellyOscillations;
    acc.jellyRests += d.jellyRests;
    return acc;
  }, { sessionCount: 0, tiktokClicks: 0, landingPageViews: 0, jellyClicks: 0, jellyOscillations: 0, jellyRests: 0 });

  totals.conversionRateClickToJelly = totals.landingPageViews
    ? +(totals.jellyClicks / totals.landingPageViews).toFixed(4) : 0;

  let tikWeighted = 0;
  for (const d of daily) tikWeighted += d.tiktokClicks * d.conversionRateTikTokToJelly;
  totals.conversionRateTikTokToJelly = totals.tiktokClicks ? +(tikWeighted / totals.tiktokClicks).toFixed(4) : 0;

  return json({ days, totals, daily });
}

async function handlePerformance(request, env) {
  if (!isAuthorized(request, env)) return unauthorized();
  const days = clampDays(new URL(request.url).searchParams.get("days"));
  const rollups = await listRollups(env, days);

  let fpsSum = 0, fpsW = 0, gpuSum = 0, gpuW = 0, energySum = 0, energyW = 0;
  let minFPS = Infinity, maxGPU = 0;
  const perPage = {};
  let fpsHist = null, gpuHist = null, energyHist = null;

  const mergeHist = (acc, h) => {
    if (!h) return acc;
    if (!acc) return h.map(b => ({ ...b }));
    for (let i = 0; i < acc.length; i++) acc[i].count += h[i].count;
    return acc;
  };

  for (const r of rollups) {
    const p = r.performance || {};
    if (p.avgFPS != null) { fpsSum += p.avgFPS * (p.fpsSamples || 1); fpsW += (p.fpsSamples || 1); }
    if (p.avgGPUTime != null) { gpuSum += p.avgGPUTime * (p.gpuSamples || 1); gpuW += (p.gpuSamples || 1); }
    if (p.avgEnergy != null) { energySum += p.avgEnergy * (p.energySamples || 1); energyW += (p.energySamples || 1); }
    if (p.minFPS != null && p.minFPS < minFPS) minFPS = p.minFPS;
    if (p.maxGPUTime != null && p.maxGPUTime > maxGPU) maxGPU = p.maxGPUTime;
    if (p.perPage) for (const [page, stats] of Object.entries(p.perPage)) {
      const cur = perPage[page] || (perPage[page] = { fpsSum: 0, fpsW: 0, gpuSum: 0, gpuW: 0 });
      if (stats.avgFPS != null) { cur.fpsSum += stats.avgFPS; cur.fpsW++; }
      if (stats.avgGPUTime != null) { cur.gpuSum += stats.avgGPUTime; cur.gpuW++; }
    }
    fpsHist = mergeHist(fpsHist, p.fpsHistogram);
    gpuHist = mergeHist(gpuHist, p.gpuHistogram);
    energyHist = mergeHist(energyHist, p.energyHistogram);
  }

  const perPageOut = {};
  for (const [page, s] of Object.entries(perPage)) {
    perPageOut[page] = {
      avgFPS: s.fpsW ? +(s.fpsSum / s.fpsW).toFixed(1) : null,
      avgGPUTime: s.gpuW ? +(s.gpuSum / s.gpuW).toFixed(2) : null
    };
  }

  const daily = rollups.map(r => ({ date: r.date, ...r.performance })).reverse();

  return json({
    days,
    avgFPS: fpsW ? +(fpsSum / fpsW).toFixed(1) : null,
    avgEnergy: energyW ? +(energySum / energyW).toFixed(5) : null,
    avgGPUTime: gpuW ? +(gpuSum / gpuW).toFixed(2) : null,
    maxGPUTime: gpuW ? +maxGPU.toFixed(2) : null,
    minFPS: fpsW ? +minFPS.toFixed(1) : null,
    fpsHistogram: fpsHist || FPS_LABELS.map(label => ({ label, count: 0 })),
    gpuHistogram: gpuHist || GPU_LABELS.map(label => ({ label, count: 0 })),
    energyHistogram: energyHist || ENERGY_LABELS.map(label => ({ label, count: 0 })),
    perPage: perPageOut,
    daily
  });
}

function handleDashboard() {
  return new Response(dashboardHtml, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}

/* -------------------------------------------------------------- routing */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/event") return handleEvent(request, env);
    if (request.method === "GET" && pathname === "/analytics") return handleAnalytics(request, env);
    if (request.method === "GET" && pathname === "/analytics/raw") return handleAnalyticsRaw(request, env);
    if (request.method === "GET" && pathname === "/funnel") return handleFunnel(request, env);
    if (request.method === "GET" && pathname === "/performance") return handlePerformance(request, env);
    if (request.method === "GET" && pathname === "/dashboard") return handleDashboard();

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRollup(env));
  }
};
