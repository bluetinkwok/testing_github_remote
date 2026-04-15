/**
 * KMB Bus ETA App
 * Uses KMB Open API: https://data.etabus.gov.hk/
 */

const KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb";

let stopMap   = new Map(); // stopId → { stop, name_tc, name_en, ... }
let allRoutes = [];
let selectedStop  = null;
let refreshTimer  = null;
let searchDebounce = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const stopSearchEl  = document.getElementById("stopSearch");
const searchBtnEl   = document.getElementById("searchBtn");
const suggestionsEl = document.getElementById("suggestions");
const stopInfoEl    = document.getElementById("stopInfo");
const stopNameEl    = document.getElementById("stopName");
const stopIdEl      = document.getElementById("stopId");
const refreshBtnEl  = document.getElementById("refreshBtn");
const etaSectionEl  = document.getElementById("etaSection");
const etaListEl     = document.getElementById("etaList");
const loadingEl     = document.getElementById("loading");
const errorMsgEl    = document.getElementById("errorMsg");

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await Promise.all([loadStops(), loadRoutes()]);
  bindEvents();
}

async function loadStops() {
  try {
    showLoading(true);
    const res  = await fetch(`${KMB_BASE}/stop`);
    const json = await res.json();
    for (const s of (json.data || [])) stopMap.set(s.stop, s);
  } catch (e) {
    // non-fatal: individual stops can be fetched on demand
  } finally {
    showLoading(false);
  }
}

async function loadRoutes() {
  try {
    const res  = await fetch(`${KMB_BASE}/route`);
    const json = await res.json();
    allRoutes  = json.data || [];
  } catch (e) { /* non-fatal */ }
}

// Fetch a single stop (fallback if not in stopMap)
async function fetchStop(stopId) {
  if (stopMap.has(stopId)) return stopMap.get(stopId);
  try {
    const res  = await fetch(`${KMB_BASE}/stop/${stopId}`);
    const json = await res.json();
    if (json.data) { stopMap.set(stopId, json.data); return json.data; }
  } catch (e) { /* ignore */ }
  return { stop: stopId, name_tc: "未知站", name_en: stopId };
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  searchBtnEl.addEventListener("click", doSearch);
  stopSearchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  stopSearchEl.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(doSearch, 200);
  });
  refreshBtnEl.addEventListener("click", () => loadETA(selectedStop));

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-section")) hideSuggestions();
  });
}

async function doSearch() {
  const q = stopSearchEl.value.trim();
  if (!q) { hideSuggestions(); return; }
  // Queries starting with a digit → route number search
  if (/^\d/.test(q)) {
    await searchByRoute(q);
  } else {
    renderStopSuggestions(filterStops(q));
  }
}

// ── Route search ──────────────────────────────────────────────────────────────
async function searchByRoute(query) {
  const q = query.toUpperCase();
  let matched = allRoutes.filter((r) => r.route.toUpperCase() === q);

  if (!matched.length) {
    const prefix = allRoutes.filter((r) => r.route.toUpperCase().startsWith(q));
    if (!prefix.length) { renderStopSuggestions([]); return; }
    renderRouteSuggestions(prefix);
    return;
  }

  showLoading(true);
  hideSuggestions();
  try {
    const fetches = matched.map((r) =>
      fetch(`${KMB_BASE}/route-stop/${r.route}/${r.bound === "O" ? "outbound" : "inbound"}/${r.service_type}`)
        .then((res) => res.json())
        .then((json) => ({ route: r, stops: json.data || [] }))
    );
    const results = await Promise.all(fetches);
    await renderRouteStopSuggestions(results, q);
  } catch (e) {
    showError("無法取得路線資料，請稍後再試。");
  } finally {
    showLoading(false);
  }
}

// ── Suggestions ───────────────────────────────────────────────────────────────
function renderStopSuggestions(stops) {
  if (!stops.length) {
    suggestionsEl.innerHTML =
      '<div class="suggestion-item"><span class="stop-name-tc">找不到相關巴士站</span></div>';
    suggestionsEl.classList.remove("hidden");
    return;
  }
  suggestionsEl.innerHTML = stops.map((s) => stopItemHtml(s)).join("");
  suggestionsEl.classList.remove("hidden");
  bindStopClicks();
}

function renderRouteSuggestions(routes) {
  const unique = [...new Map(routes.map((r) => [r.route, r])).values()].slice(0, 10);
  suggestionsEl.innerHTML =
    '<div class="suggestion-header">🚌 路線搜尋結果</div>' +
    unique.map((r) => `
      <div class="suggestion-item" data-route="${r.route}">
        <div class="stop-name-tc"><strong>${r.route}</strong></div>
        <div class="stop-name-en">${r.orig_en || ""} → ${r.dest_en || ""}</div>
      </div>`).join("");
  suggestionsEl.classList.remove("hidden");
  suggestionsEl.querySelectorAll("[data-route]").forEach((el) => {
    el.addEventListener("click", () => {
      stopSearchEl.value = el.dataset.route;
      searchByRoute(el.dataset.route);
    });
  });
}

async function renderRouteStopSuggestions(results, routeNum) {
  if (!results.length || results.every((r) => !r.stops.length)) {
    suggestionsEl.innerHTML =
      '<div class="suggestion-item"><span class="stop-name-tc">找不到此路線巴士站</span></div>';
    suggestionsEl.classList.remove("hidden");
    return;
  }

  // Fetch any stop not yet cached
  const allStopIds = results.flatMap(({ stops }) => stops.map((rs) => rs.stop));
  const missing    = [...new Set(allStopIds.filter((id) => !stopMap.has(id)))];
  if (missing.length) await Promise.all(missing.map(fetchStop));

  const dirLabel = { O: "往 ", I: "回 " };
  let html = "";
  for (const { route, stops } of results) {
    const dest = route.dest_tc || route.dest_en || "";
    html += `<div class="suggestion-header">🚌 ${routeNum} ${dirLabel[route.bound] || ""}${dest}</div>`;
    for (const rs of stops) {
      const info = stopMap.get(rs.stop) || { stop: rs.stop, name_tc: "未知站", name_en: "" };
      html += stopItemHtml(info, rs.seq);
    }
  }

  suggestionsEl.innerHTML = html;
  suggestionsEl.classList.remove("hidden");
  bindStopClicks();
}

function stopItemHtml(stop, seq) {
  const badge = seq != null ? `<span class="seq-badge">${seq}</span> ` : "";
  return `<div class="suggestion-item" data-stop-id="${stop.stop}">
    <div class="stop-name-tc">${badge}${stop.name_tc}</div>
    <div class="stop-name-en">${stop.name_en}</div>
  </div>`;
}

function bindStopClicks() {
  suggestionsEl.querySelectorAll("[data-stop-id]").forEach((el) => {
    el.addEventListener("click", async () => {
      const stop = await fetchStop(el.dataset.stopId);
      selectStop(stop);
    });
  });
}

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
}

// ── Stop name filter ──────────────────────────────────────────────────────────
function filterStops(query) {
  const q = query.toLowerCase();
  const out = [];
  for (const s of stopMap.values()) {
    if ((s.name_tc && s.name_tc.includes(query)) ||
        (s.name_en && s.name_en.toLowerCase().includes(q))) {
      out.push(s);
      if (out.length >= 20) break;
    }
  }
  return out;
}

// ── Stop selection ────────────────────────────────────────────────────────────
function selectStop(stop) {
  selectedStop = stop;
  stopNameEl.textContent = stop.name_tc;
  stopIdEl.textContent   = `站號：${stop.stop} ・ ${stop.name_en}`;
  stopInfoEl.classList.remove("hidden");
  hideSuggestions();
  stopSearchEl.value = stop.name_tc;
  loadETA(stop);

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadETA(stop), 30000);
}

// ── ETA ───────────────────────────────────────────────────────────────────────
async function loadETA(stop) {
  if (!stop) return;
  clearError();
  showLoading(true);
  etaSectionEl.classList.add("hidden");
  try {
    const res  = await fetch(`${KMB_BASE}/stop-eta/${stop.stop}`);
    const json = await res.json();
    renderETA(json.data || []);
  } catch (e) {
    showError("無法取得到站時間，請稍後再試。");
  } finally {
    showLoading(false);
  }
}

function renderETA(etas) {
  if (!etas.length) {
    etaListEl.innerHTML = '<p class="eta-no-service" style="padding:12px">此站暫無服務</p>';
    etaSectionEl.classList.remove("hidden");
    return;
  }

  const groups = {};
  for (const item of etas) {
    const key = `${item.route}__${item.dir}__${item.service_type}`;
    if (!groups[key]) {
      groups[key] = { route: item.route, dir: item.dir, service_type: item.service_type,
                      dest_tc: item.dest_tc, dest_en: item.dest_en, times: [] };
    }
    if (item.eta) groups[key].times.push(item.eta);
  }

  const now = Date.now();
  etaListEl.innerHTML = Object.values(groups)
    .sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }))
    .map((g) => buildRouteCard(g, now))
    .join("");
  etaSectionEl.classList.remove("hidden");
}

function buildRouteCard(group, now) {
  const badgesHtml = group.times.length
    ? group.times.map((t) => {
        const mins = Math.round((new Date(t) - now) / 60000);
        if (mins < 0) return null;
        let cls = "eta-badge", label = `${mins} 分鐘`;
        if (mins <= 1) { cls += " arriving"; label = "即將到站"; }
        else if (mins <= 5) { cls += " soon"; }
        return `<div class="${cls}">
          <span class="eta-minutes">${mins <= 1 ? "◎" : mins}</span>
          <span class="eta-label">${label}</span>
        </div>`;
      }).filter(Boolean).join("") || '<span class="eta-no-service">暫無班次</span>'
    : '<span class="eta-no-service">暫無班次</span>';

  return `<div class="route-card">
    <div class="route-header">
      <span class="route-number">${group.route}</span>
      <span class="route-dest">往 ${group.dest_tc || group.dest_en}</span>
    </div>
    <div class="eta-times">${badgesHtml}</div>
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoading(show) { loadingEl.classList.toggle("hidden", !show); }
function showError(msg) { errorMsgEl.textContent = msg; errorMsgEl.classList.remove("hidden"); }
function clearError() { errorMsgEl.classList.add("hidden"); }

// ── Start ─────────────────────────────────────────────────────────────────────
init();
