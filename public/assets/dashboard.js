/**
 * Wobble Lab Analytics dashboard — all client-side logic for /dashboard.
 *
 * Architecture:
 *   - A small set of component builders (kpiCard/statCard/chartPanel/
 *     tablePanel/mapPanel) build every card in the page. dashboard.html only
 *     holds empty, semantically-labelled row containers — no card markup is
 *     hand-duplicated there.
 *   - One fetch* function per backend endpoint (/analytics, /funnel,
 *     /performance, /analytics/raw), all thin wrappers over one shared api()
 *     helper that carries the auth header and error handling.
 *   - One render* function per dashboard panel, plus one shared updateKPI()
 *     helper used for all six KPI tiles (a single parametrized "update
 *     function per KPI" rather than six near-identical copies).
 *
 * Data flow: /analytics returns every daily rollup (newest first); this file
 * slices the last N days client-side for the selected time range, and calls
 * /funnel and /performance (which do the same slicing server-side, since
 * those need range-weighted aggregation the rollups alone don't carry).
 *
 * Security: every render* function only ever writes visitor-supplied data
 * (page paths, referrer hosts, event payloads, country/city names) via
 * textContent, MapLibre's Popup.setText(), or Chart.js's own canvas
 * rendering — never innerHTML with concatenated strings — because that data
 * ultimately comes from the public, unauthenticated POST /event endpoint. A
 * crafted payload must never be able to execute as markup in this
 * authenticated session.
 */
(function () {
  var KEY_STORAGE = "wobble_admin_key";
  var charts = {};
  var currentDays = 30;
  var currentSource = "all";
  var lastRecent = []; // last N days of rollups, oldest -> newest, cached for the source filter

  var map = null, mapLoaded = false, pendingPoints = null;

  /* ------------------------------------------------------------ helpers */

  function fmtPct(n) { return (n * 100).toFixed(1) + "%"; }
  function fmtNum(n) { return n == null ? "–" : Number(n).toLocaleString(); }
  function fmtMs(n) { return n == null ? "–" : n + " ms"; }
  function fmtPlain(n) { return n == null ? "–" : n; }

  // Apache Superset's own default categorical palette (supersetColors),
  // lightened where needed to stay legible on this dark background.
  function colors() {
    return {
      indigo: "#7B8FE4", pink: "#EFA1B0", amber: "#FCC700",
      green: "#5AC189", gray: "#9CA3AF", cyan: "#3CCCCB", violet: "#A868B7"
    };
  }
  var EVENT_COLOR = { "Jelly Click": colors().indigo, "Jelly Rest": colors().green, "TikTok Arrival": colors().pink };

  function el(tag, className) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  /* ----------------------------------------------------- fetch functions */
  /* One function per endpoint; all share the same auth header + error
     handling via api(), so that logic lives in exactly one place. */

  async function api(path, key) {
    var res = await fetch(path, { headers: { "X-Analytics-Key": key } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  async function fetchAnalytics(key) { return api("/analytics", key); }
  async function fetchFunnel(key, days) { return api("/funnel?days=" + days, key); }
  async function fetchPerformance(key, days) { return api("/performance?days=" + days, key); }
  async function fetchRaw(key) { return api("/analytics/raw", key); }

  /* ------------------------------------------------------- UI components */
  /* Every card in the dashboard is built by one of these five functions. */

  function kpiCard(container, label, valueId, sparkId) {
    var card = el("div", "card");
    var lab = el("div", "stat-label"); lab.textContent = label;
    var val = el("div", "stat-value"); val.id = valueId; val.textContent = "–";
    var spark = el("canvas", "stat-spark"); spark.id = sparkId;
    card.appendChild(lab); card.appendChild(val); card.appendChild(spark);
    container.appendChild(card);
  }

  function statCard(container, label, valueId) {
    var card = el("div", "card");
    var lab = el("div", "stat-label"); lab.textContent = label;
    var val = el("div", "stat-value"); val.id = valueId; val.textContent = "–";
    card.appendChild(lab); card.appendChild(val);
    container.appendChild(card);
  }

  function chartPanel(container, title, canvasId, height) {
    var card = el("div", "card");
    var head = el("div", "card-header"); head.textContent = title;
    var canvas = el("canvas"); canvas.id = canvasId; if (height) canvas.height = height;
    card.appendChild(head); card.appendChild(canvas);
    container.appendChild(card);
  }

  function tablePanel(container, title, tableId) {
    var card = el("div", "card overflow-x-auto");
    var head = el("div", "card-header"); head.textContent = title;
    var table = el("table", "w-full text-sm"); table.id = tableId;
    card.appendChild(head); card.appendChild(table);
    container.appendChild(card);
  }

  function mapPanel(container) {
    var card = el("div", "card");
    var legend = el("div", "flex flex-wrap items-center gap-4 mb-3 text-xs text-[var(--muted)]");
    ["Jelly Click", "Jelly Rest", "TikTok Arrival"].forEach(function (type) {
      var item = el("span", "flex items-center gap-1");
      var dot = el("span", "inline-block w-2.5 h-2.5 rounded-full bg-[" + EVENT_COLOR[type] + "]");
      item.appendChild(dot);
      item.appendChild(document.createTextNode(" " + type));
      legend.appendChild(item);
    });
    var summary = el("span", "ml-auto"); summary.id = "mapSummary";
    legend.appendChild(summary);

    var mapDiv = el("div"); mapDiv.id = "worldMap";
    var caption = el("p", "caption mt-2");
    caption.textContent = "Geo comes from Cloudflare's edge (request.cf) — only populated for real deployed traffic; empty or placeholder in local dev. Circles are aggregated by country.";

    card.appendChild(legend); card.appendChild(mapDiv); card.appendChild(caption);
    container.appendChild(card);
  }

  function buildLayout() {
    var kpiRow = document.getElementById("kpiRow");
    kpiCard(kpiRow, "Jelly Clicks", "kpiJellyClicks", "sparkJellyClicks");
    kpiCard(kpiRow, "Jelly Rest", "kpiJellyRests", "sparkJellyRests");
    kpiCard(kpiRow, "TikTok → Jelly rate", "kpiConvTiktok", "sparkConvTiktok");
    kpiCard(kpiRow, "Avg FPS", "kpiAvgFPS", "sparkAvgFPS");
    kpiCard(kpiRow, "Avg frame time", "kpiAvgFrameTime", "sparkAvgFrameTime");
    kpiCard(kpiRow, "Avg energy", "kpiAvgEnergy", "sparkAvgEnergy");

    mapPanel(document.getElementById("mapRow"));

    var ts = document.getElementById("timeSeriesRow");
    chartPanel(ts, "Jelly Clicks over time", "chartJellyClicksTs", 160);
    chartPanel(ts, "Jelly Rest over time", "chartJellyRestTs", 160);
    chartPanel(ts, "FPS over time", "chartFPSTs", 160);
    chartPanel(ts, "Frame-time over time", "chartFrameTimeTs", 160);

    var funnelStats = document.getElementById("funnelStatsRow");
    statCard(funnelStats, "TikTok arrivals", "funnelTiktok");
    statCard(funnelStats, "Jelly interactions", "funnelInteractions");
    statCard(funnelStats, "Conversion rate", "funnelConversion");
    statCard(funnelStats, "Session count", "funnelSessions");
    chartPanel(document.getElementById("funnelChartRow"), "Funnel shape", "chartFunnel", 180);

    var sources = document.getElementById("sourcesRow");
    chartPanel(sources, "By source", "chartSources", 220);
    tablePanel(sources, "Breakdown", "tableSources");

    var topPages = document.getElementById("topPagesRow");
    chartPanel(topPages, "By pageviews", "chartTopPages", 220);
    tablePanel(topPages, "Detail", "tablePages");

    var physics = document.getElementById("physicsRow");
    statCard(physics, "Oscillations", "physicsOscillations");
    statCard(physics, "Rests", "physicsRests");
    chartPanel(physics, "Energy distribution", "chartEnergyHist", 140);

    var perfStats = document.getElementById("performanceStatsRow");
    statCard(perfStats, "Min FPS", "perfMinFPS");
    statCard(perfStats, "Max frame time", "perfMaxFrameTime");
    var perfCharts = document.getElementById("performanceChartsRow");
    chartPanel(perfCharts, "FPS histogram", "chartFPSHist", 160);
    chartPanel(perfCharts, "Frame-time histogram", "chartFrameTimeHist", 160);
  }

  /* ------------------------------------------------------------- charts */

  function baseScales() {
    return {
      x: { ticks: { color: "#6b7280" }, grid: { color: "#1f2937" } },
      y: { ticks: { color: "#6b7280" }, grid: { color: "#1f2937" }, beginAtZero: true }
    };
  }

  function lineChart(canvasId, labels, datasets) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (charts[canvasId]) charts[canvasId].destroy();
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: { responsive: true, plugins: { legend: { labels: { color: "#9ca3af" } } }, scales: baseScales() }
    });
  }

  function barChart(canvasId, labels, data, color, horizontal) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (charts[canvasId]) charts[canvasId].destroy();
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels: labels, datasets: [{ data: data, backgroundColor: color }] },
      options: { indexAxis: horizontal ? "y" : "x", responsive: true, plugins: { legend: { display: false } }, scales: baseScales() }
    });
  }

  function pieChart(canvasId, labels, data) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (charts[canvasId]) charts[canvasId].destroy();
    var c = colors();
    var palette = [c.indigo, c.pink, c.amber, c.green, c.cyan, c.violet, c.gray, "#8FD3E4", "#E45756", "#54A24B", "#EECA3B"];
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "doughnut",
      data: { labels: labels, datasets: [{ data: data, backgroundColor: palette }] },
      options: { plugins: { legend: { labels: { color: "#9ca3af" } } } }
    });
  }

  function histChart(canvasId, hist, color) {
    if (!hist) return;
    barChart(canvasId, hist.map(function (b) { return b.label; }), hist.map(function (b) { return b.count; }), color, false);
  }

  /** A tiny axis-less trend line under a KPI "Big Number" tile, Superset-style. */
  function sparkline(canvasId, data, color) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (charts[canvasId]) charts[canvasId].destroy();
    if (!data.length || data.every(function (v) { return v == null; })) return;
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: data.map(function (_, i) { return i; }),
        datasets: [{ data: data, borderColor: color, backgroundColor: "transparent", borderWidth: 1.5, pointRadius: 0, tension: .35 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } }
      }
    });
  }

  // Table cells always go through textContent, never innerHTML — page
  // names, source names and event data ultimately come from visitor-
  // supplied POST /event bodies, so they are treated as data, never markup.
  function renderTable(tableId, rows, headers) {
    var table = document.getElementById(tableId);
    if (!table) return;
    table.innerHTML = "";
    var thead = el("thead"), htr = el("tr");
    headers.forEach(function (h) {
      var th = el("th", "text-left text-gray-400 font-medium py-1.5 pr-4");
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el("tbody");
    rows.forEach(function (row) {
      var tr = el("tr", "border-t border-gray-800");
      row.forEach(function (cell) {
        var td = el("td", "py-1.5 pr-4 text-gray-200");
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function sumRange(rollups, picker) {
    return rollups.reduce(function (acc, r) { return acc + (picker(r) || 0); }, 0);
  }

  /* --------------------------------------------------------------- map */
  /* MapLibre GL. Basemap is Esri's free "World Dark Gray Base" tile
     service — plain raster JPEGs served over CloudFront, no key, verified
     directly (curl on the actual tile, not just a style manifest — CARTO's
     dark-matter-gl-style *manifest* returns a clean 200 but the real tiles
     behind it are watermarked "API KEY REQUIRED" in the browser, which is
     what shipped here first and had to be replaced). Circles are a GeoJSON
     "circle" layer, radius/color driven by data expressions — MapLibre's
     native way to do this, rather than one DOM marker per point.
     Aggregated to one dot per (event type, country): a per-city view is
     possible from the same rollup.mapPoints data, but this panel's brief
     calls for country-level. */

  var MAP_STYLE = {
    version: 8,
    sources: {
      "esri-dark-gray": {
        type: "raster",
        // Esri's tile path order is z/y/x, not the more common z/x/y.
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Esri, HERE, Garmin, FAO, NOAA, USGS — © OpenStreetMap contributors"
      }
    },
    layers: [{ id: "esri-dark-gray-layer", type: "raster", source: "esri-dark-gray" }]
  };

  function emptyFC() { return { type: "FeatureCollection", features: [] }; }

  function aggregateByCountry(recent) {
    var totals = {}; // "type|country" -> accumulator
    recent.forEach(function (r) {
      (r.mapPoints || []).forEach(function (p) {
        if (!p.country) return;
        var key = p.type + "|" + p.country;
        var t = totals[key] || (totals[key] = { type: p.type, country: p.country, count: 0, latSum: 0, lonSum: 0 });
        t.count += p.count;
        if (p.lat != null && p.lon != null) { t.latSum += p.lat * p.count; t.lonSum += p.lon * p.count; }
      });
    });
    return Object.values(totals).map(function (t) {
      return { type: t.type, country: t.country, count: t.count, lat: t.count ? t.latSum / t.count : null, lon: t.count ? t.lonSum / t.count : null };
    });
  }

  function toFeatureCollection(points) {
    return {
      type: "FeatureCollection",
      features: points.filter(function (p) { return p.lat != null && p.lon != null; }).map(function (p) {
        return { type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { type: p.type, country: p.country, count: p.count } };
      })
    };
  }

  function initMap() {
    if (map || typeof maplibregl === "undefined") return;
    map = new maplibregl.Map({ container: "worldMap", style: MAP_STYLE, center: [0, 20], zoom: 1.2 });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", function () {
      map.addSource("mapPoints", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "mapPointsCircles",
        type: "circle",
        source: "mapPoints",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 5, 50, 26],
          "circle-color": ["match", ["get", "type"],
            "Jelly Click", EVENT_COLOR["Jelly Click"],
            "Jelly Rest", EVENT_COLOR["Jelly Rest"],
            "TikTok Arrival", EVENT_COLOR["TikTok Arrival"],
            "#9CA3AF"],
          "circle-opacity": .6,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#0e1117"
        }
      });

      var popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      map.on("mouseenter", "mapPointsCircles", function (e) {
        map.getCanvas().style.cursor = "pointer";
        var f = e.features[0], p = f.properties;
        // setText() — never setHTML() with concatenated strings — country
        // names are visitor-influenced (derived from Cloudflare geo-IP on a
        // request an attacker fully controls the headers of).
        popup.setLngLat(f.geometry.coordinates).setText(p.country + " — " + p.type + ": " + p.count).addTo(map);
      });
      map.on("mouseleave", "mapPointsCircles", function () {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      mapLoaded = true;
      if (pendingPoints) { applyMapPoints(pendingPoints); pendingPoints = null; }
    });
  }

  function applyMapPoints(points) {
    var source = map.getSource("mapPoints");
    if (!source) { pendingPoints = points; return; }
    source.setData(toFeatureCollection(points));
  }

  function renderMap(recent) {
    initMap();
    if (!map) return; // MapLibre failed to load (offline / CDN blocked) — skip rather than throw

    var points = aggregateByCountry(recent);
    var countries = new Set(points.map(function (p) { return p.country; }));
    var summary = document.getElementById("mapSummary");
    if (summary) summary.textContent = countries.size + " countries";

    if (mapLoaded) applyMapPoints(points); else pendingPoints = points;
    setTimeout(function () { if (map) map.resize(); }, 50);
  }

  /* ---------------------------------------------------------- render(s) */

  function updateKPI(valueId, sparkId, value, sparkData, color, formatter) {
    var target = document.getElementById(valueId);
    if (target) target.textContent = value == null ? "–" : (formatter ? formatter(value) : value);
    sparkline(sparkId, sparkData, color);
  }

  function renderKPIs(recent, funnel, perf) {
    var t = funnel.totals, c = colors();
    updateKPI("kpiJellyClicks", "sparkJellyClicks", t.jellyClicks,
      recent.map(function (r) { return (r.byEvent || {})["Jelly Click"] || 0; }), c.indigo, fmtNum);
    updateKPI("kpiJellyRests", "sparkJellyRests", t.jellyRests,
      recent.map(function (r) { return (r.byEvent || {})["Jelly Rest"] || 0; }), c.green, fmtNum);
    updateKPI("kpiConvTiktok", "sparkConvTiktok", t.conversionRateTikTokToJelly,
      funnel.daily.map(function (d) { return d.conversionRateTikTokToJelly; }), c.pink, fmtPct);
    updateKPI("kpiAvgFPS", "sparkAvgFPS", perf.avgFPS,
      perf.daily.map(function (d) { return d.avgFPS; }), c.amber, fmtPlain);
    updateKPI("kpiAvgFrameTime", "sparkAvgFrameTime", perf.avgGPUTime,
      perf.daily.map(function (d) { return d.avgGPUTime; }), c.cyan, fmtMs);
    updateKPI("kpiAvgEnergy", "sparkAvgEnergy", perf.avgEnergy,
      perf.daily.map(function (d) { return d.avgEnergy; }), c.violet, fmtPlain);
  }

  function renderTimeSeries(recent, perf) {
    var labels = recent.map(function (r) { return r.date; });
    lineChart("chartJellyClicksTs", labels, [{
      label: "Jelly Clicks", data: recent.map(function (r) { return (r.byEvent || {})["Jelly Click"] || 0; }),
      borderColor: colors().indigo, backgroundColor: "transparent", tension: .3
    }]);
    lineChart("chartJellyRestTs", labels, [{
      label: "Jelly Rest", data: recent.map(function (r) { return (r.byEvent || {})["Jelly Rest"] || 0; }),
      borderColor: colors().green, backgroundColor: "transparent", tension: .3
    }]);
    var perfLabels = (perf.daily || []).map(function (d) { return d.date; });
    lineChart("chartFPSTs", perfLabels, [{
      label: "Avg FPS", data: (perf.daily || []).map(function (d) { return d.avgFPS; }),
      borderColor: colors().amber, backgroundColor: "transparent", tension: .3
    }]);
    lineChart("chartFrameTimeTs", perfLabels, [{
      label: "Avg frame time (ms)", data: (perf.daily || []).map(function (d) { return d.avgGPUTime; }),
      borderColor: colors().cyan, backgroundColor: "transparent", tension: .3
    }]);
  }

  function renderFunnelPanel(funnel) {
    var t = funnel.totals;
    document.getElementById("funnelTiktok").textContent = fmtNum(t.tiktokClicks);
    document.getElementById("funnelInteractions").textContent = fmtNum(t.jellyClicks + t.jellyOscillations + t.jellyRests);
    document.getElementById("funnelConversion").textContent = fmtPct(t.conversionRateTikTokToJelly);
    document.getElementById("funnelSessions").textContent = fmtNum(t.sessionCount);

    barChart("chartFunnel",
      ["TikTok landings", "All pageviews", "Jelly Clicks", "Jelly Oscillations", "Jelly Rests"],
      [t.tiktokClicks, t.landingPageViews, t.jellyClicks, t.jellyOscillations, t.jellyRests],
      colors().indigo, true);
  }

  function sourceTotals(recent) {
    var totals = {};
    recent.forEach(function (r) {
      Object.entries(r.bySource || {}).forEach(function (entry) {
        totals[entry[0]] = (totals[entry[0]] || 0) + entry[1];
      });
    });
    return totals;
  }

  function populateSourceFilter(recent) {
    var select = document.getElementById("sourceFilter");
    var totals = sourceTotals(recent);
    var sources = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    var prev = currentSource;
    select.innerHTML = "";
    var allOpt = document.createElement("option");
    allOpt.value = "all"; allOpt.textContent = "All sources";
    select.appendChild(allOpt);
    sources.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      select.appendChild(opt);
    });
    currentSource = sources.indexOf(prev) >= 0 || prev === "all" ? prev : "all";
    select.value = currentSource;
  }

  function renderSources(recent) {
    var totals = sourceTotals(recent);
    var sources = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });

    if (currentSource === "all") {
      pieChart("chartSources", sources, sources.map(function (s) { return totals[s]; }));
    } else {
      // Filtered view: pageviews-over-time for just the selected source. The
      // 6 KPI cards above stay site-wide on purpose — Jelly interactions and
      // performance samples aren't attributed to an arbitrary source (only
      // TikTok gets that treatment, via the funnel's session-id linking), so
      // filtering them here would silently show numbers that don't mean what
      // the filter implies.
      var labels = recent.map(function (r) { return r.date; });
      var data = recent.map(function (r) { return (r.bySource || {})[currentSource] || 0; });
      lineChart("chartSources", labels, [{
        label: currentSource + " pageviews", data: data,
        borderColor: colors().pink, backgroundColor: "transparent", tension: .3
      }]);
    }

    renderTable("tableSources", sources.map(function (s) { return [s, totals[s]]; }), ["Source", "Pageviews"]);
  }

  function renderTopPages(recent) {
    var totals = {};
    recent.forEach(function (r) {
      Object.entries(r.byPageDetail || {}).forEach(function (entry) {
        var page = entry[0], d = entry[1];
        var t = totals[page] || (totals[page] = { pageviews: 0, jellyClicks: 0, jellyOscillations: 0, jellyRests: 0 });
        t.pageviews += d.pageviews; t.jellyClicks += d.jellyClicks;
        t.jellyOscillations += d.jellyOscillations; t.jellyRests += d.jellyRests;
      });
    });
    var perfLast = recent.length ? ((recent[recent.length - 1].performance || {}).perPage || {}) : {};
    var pages = Object.keys(totals).sort(function (a, b) { return totals[b].pageviews - totals[a].pageviews; }).slice(0, 10);

    barChart("chartTopPages", pages, pages.map(function (p) { return totals[p].pageviews; }), colors().indigo, true);
    renderTable("tablePages", pages.map(function (p) {
      var t = totals[p];
      var fps = perfLast[p] && perfLast[p].avgFPS != null ? perfLast[p].avgFPS : "–";
      return [p, t.pageviews, t.jellyClicks + t.jellyOscillations + t.jellyRests, fps];
    }), ["Page", "Pageviews", "Jelly interactions", "Avg FPS"]);
  }

  function renderJellyPhysics(recent, perf) {
    document.getElementById("physicsOscillations").textContent =
      fmtNum(sumRange(recent, function (r) { return (r.byEvent || {})["Jelly Oscillation"]; }));
    document.getElementById("physicsRests").textContent =
      fmtNum(sumRange(recent, function (r) { return (r.byEvent || {})["Jelly Rest"]; }));
    histChart("chartEnergyHist", perf.energyHistogram, colors().pink);
  }

  function renderPerformancePanel(perf) {
    document.getElementById("perfMinFPS").textContent = perf.minFPS != null ? perf.minFPS : "–";
    document.getElementById("perfMaxFrameTime").textContent = fmtMs(perf.maxGPUTime);
    histChart("chartFPSHist", perf.fpsHistogram, colors().amber);
    histChart("chartFrameTimeHist", perf.gpuHistogram, colors().cyan);
  }

  // Every field here (event, page, extra, ip, userAgent, geo) can be set by
  // whoever calls POST /event, including outside this site's own JS — hence
  // pre.textContent, never innerHTML, so a crafted payload can never execute
  // as markup inside this authenticated dashboard.
  function renderRaw(events) {
    var list = document.getElementById("rawList");
    list.innerHTML = "";
    if (!events.length) {
      var empty = el("p", "text-sm text-gray-500");
      empty.textContent = "No events in the last 24h.";
      list.appendChild(empty);
      return;
    }
    events.forEach(function (ev) {
      var details = el("details", "card");
      var summary = el("summary", "cursor-pointer text-sm text-gray-300");
      summary.textContent = (ev.timestamp || "") + "   " + (ev.event || "") + "   " + (ev.page || "");
      var pre = el("pre", "text-xs text-gray-400 mt-2 overflow-x-auto");
      pre.textContent = JSON.stringify(ev, null, 2);
      details.appendChild(summary);
      details.appendChild(pre);
      list.appendChild(details);
    });
  }

  /* ---------------------------------------------------------------- load */

  function setDashboardState(message, isError) {
    var status = document.getElementById("statusLine");
    var loading = document.getElementById("loadingBar");
    if (status) {
      status.textContent = message;
      status.classList.toggle("error", Boolean(isError));
    }
    if (loading) loading.hidden = !message || Boolean(isError);
  }

  async function loadDashboard(key) {
    setDashboardState("Loading " + currentDays + " days of data");
    try {
      var analytics = await fetchAnalytics(key); // all rollups, newest first
      var recent = analytics.slice(0, currentDays).slice().reverse(); // oldest -> newest for charts
      var funnel = await fetchFunnel(key, currentDays);
      var perf = await fetchPerformance(key, currentDays);
      var raw = await fetchRaw(key);

      lastRecent = recent;
      populateSourceFilter(recent);

      renderKPIs(recent, funnel, perf);
      renderMap(recent);
      renderTimeSeries(recent, perf);
      renderFunnelPanel(funnel);
      renderSources(recent);
      renderTopPages(recent);
      renderJellyPhysics(recent, perf);
      renderPerformancePanel(perf);
      renderRaw(raw);
      setDashboardState("Updated just now");
    } catch (error) {
      setDashboardState("Data could not be loaded. Check the key or try again.", true);
      throw error;
    }
  }

  /* -------------------------------------------------------------- unlock */

  function setActiveRangeButton() {
    document.querySelectorAll(".range-btn").forEach(function (btn) {
      btn.classList.toggle("active", Number(btn.dataset.days) === currentDays);
    });
  }

  async function tryUnlock(key) {
    try {
      await fetchAnalytics(key);
      sessionStorage.setItem(KEY_STORAGE, key);
      document.getElementById("unlock").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");
      setActiveRangeButton();
      await loadDashboard(key);
      return true;
    } catch (e) {
      sessionStorage.removeItem(KEY_STORAGE);
      document.getElementById("unlock").classList.remove("hidden");
      document.getElementById("app").classList.add("hidden");
      return false;
    }
  }

  buildLayout();

  document.getElementById("unlockForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var key = document.getElementById("keyInput").value.trim();
    if (!key) return;
    var ok = await tryUnlock(key);
    document.getElementById("unlockError").classList.toggle("hidden", ok);
  });

  document.getElementById("logoutBtn").addEventListener("click", function () {
    sessionStorage.removeItem(KEY_STORAGE);
    location.reload();
  });

  document.querySelectorAll(".range-btn").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      currentDays = Number(btn.dataset.days);
      setActiveRangeButton();
      var key = sessionStorage.getItem(KEY_STORAGE);
      if (key) {
        try { await loadDashboard(key); }
        catch (e) { /* loadDashboard has already shown the recoverable error */ }
      }
    });
  });

  document.getElementById("sourceFilter").addEventListener("change", function (e) {
    currentSource = e.target.value;
    renderSources(lastRecent);
  });

  var storedKey = sessionStorage.getItem(KEY_STORAGE);
  if (storedKey) tryUnlock(storedKey);
})();
