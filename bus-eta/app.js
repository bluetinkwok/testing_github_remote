/**
 * KMB Bus ETA App
 * Uses KMB Open API: https://data.etabus.gov.hk/
 */

const KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb";

let allStops = [];       // { stop, name_tc, name_en, lat, long }
let allRoutes = [];      // { route, bound, service_type, orig_tc, dest_tc, ... }
let selectedStop = null;
let refreshTimer = null;
let searchDebounce = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const stopSearchEl = document.getElementById("stopSearch");
const searchBtnEl  = document.getElementById("searchBtn");
const suggestionsEl = document.getElementById("suggestions");
const stopInfoEl   = document.getElementById("stopInfo");
const stopNameEl   = document.getElementById("stopName");
const stopIdEl     = document.getElementById("stopId");
const refreshBtnEl = document.getElementById("refreshBtn");
const etaSectionEl = document.getElementById("etaSection");
const etaListEl    = document.getElementById("etaList");
const loadingEl    = document.getElementById("loading");
const errorMsgEl   = document.getElementById("errorMsg");

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await Promise.all([loadStops(), loadRoutes()]);
  bindEvents();
}

async function loadStops() {
  try {
    showLoading(true);
    const res = await fetch(`${KMB_BASE}/stop`);
    const json = await res.json();
    allStops = json.data || [];
  } catch (e) {
    showError("無法載入巴士站資料，請檢查網絡連線。");
  } finally {
    showLoading(false);
  }
}

async function loadRoutes() {
  try {
    const res = await fetch(`${KMB_BASE}/route`);
    const json = await res.json();
    allRoutes = json.data || [];
  } catch (e) {
    // non-fatal; route search will just be empty
  }
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

  // Detect if query looks like a route number (e.g. "87D", "1A", "296")
  const isRouteQuery = /^\d/.test(q);

  if (isRouteQuery) {
    await searchByRoute(q);
  } else {
    const stops = filterStops(q).slice(0, 20);
    renderStopSuggestions(stops);
  }
}

// ── Route search ──────────────────────────────────────────────────────────────
async function searchByRoute(query) {
  const q = query.toUpperCase();

  // Find matching route entries (exact or prefix match)
  const matched = allRoutes.filter((r) => r.route.toUpperCase() === q);
  if (!matched.length) {
    // Fallback: prefix match
    const prefix = allRoutes.filter((r) => r.route.toUpperCase().startsWith(q));
    if (!prefix.length) {
      renderStopSuggestions([]); // show "not found"
      return;
    }
    // Show unique route numbers as secondary suggestions
    renderRouteSuggestions(prefix);
    return;
  }

  // Exact match — fetch stops for each direction
  showLoading(true);
  hideSuggestions();
  try {
    const fetches = matched.map((r) =>
      fetch(`${KMB_BASE}/route-stop/${r.route}/${r.bound === "O" ? "outbound" : "inbound"}/${r.service_type}`)
        .then((res) => res.json())
        .then((json) => ({ route: r, stops: json.data || [] }))
    );
    const results = await Promise.all(fetches);
    renderRouteStopSuggestions(results, q);
  } catch (e) {
    showError("無法取得路線資料，請稍後再試。");
  } finally {
    showLoading(false);
  }
}

// ── Suggestions rendering ─────────────────────────────────────────────────────
function renderStopSuggestions(stops) {
  if (!stops.length) {
    suggestionsEl.innerHTML =
      '<div class="suggestion-item"><span class="stop-name-tc">找不到相關巴士站</span></div>';
    suggestionsEl.classList.remove("hidden");
    return;
  }
  suggestionsEl.innerHTML = stops
    .map(
      (s) => `
      <div class="suggestion-item" data-stop-id="${s.stop}">
        <div class="stop-name-tc">${s.name_tc}</div>
        <div class="stop-name-en">${s.name_en}</div>
      </div>`
    )
    .join("");
  suggestionsEl.classList.remove("hidden");
  bindSuggestionClicks();
}

function renderRouteSuggestions(routes) {
  const unique = [...new Map(routes.map((r) => [r.route, r])).values()].slice(0, 10);
  suggestionsEl.innerHTML =
    '<div class="suggestion-header">🚌 路線搜尋結果</div>' +
    unique
      .map(
        (r) => `
        <div class="suggestion-item" data-route="${r.route}">
          <div class="stop-name-tc"><strong>${r.route}</strong></div>
          <div class="stop-name-en">${r.orig_en || ""} → ${r.dest_en || ""}</div>
        </div>`
      )
      .join("");
  suggestionsEl.classList.remove("hidden");

  suggestionsEl.querySelectorAll(".suggestion-item[data-route]").forEach((el) => {
    el.addEventListener("click", () => {
      stopSearchEl.value = el.dataset.route;
      searchByRoute(el.dataset.route);
    });
  });
}

function renderRouteStopSuggestions(results, routeNum) {
  if (!results.length || results.every((r) => !r.stops.length)) {
    suggestionsEl.innerHTML =
      '<div class="suggestion-item"><span class="stop-name-tc">找不到此路線的巴士站</span></div>';
    suggestionsEl.classList.remove("hidden");
    return;
  }

  const dirLabel = { O: "往 ", I: "回 " };
  let html = "";

  for (const { route, stops } of results) {
    const dir = route.bound === "O" ? "outbound" : "inbound";
    const dest = route.dest_tc || route.dest_en || "";
    html += `<div class="suggestion-header">🚌 ${routeNum} ${dirLabel[route.bound] || ""}${dest}</div>`;
    for (const rs of stops) {
      const stopInfo = allStops.find((s) => s.stop === rs.stop);
      const name_tc = stopInfo ? stopInfo.name_tc : rs.stop;
      const name_en = stopInfo ? stopInfo.name_en : "";
      html += `
        <div class="suggestion-item" data-stop-id="${rs.stop}" data-seq="${rs.seq}">
          <div class="stop-name-tc"><span class="seq-badge">${rs.seq}</span> ${name_tc}</div>
          <div class="stop-name-en">${name_en}</div>
        </div>`;
    }
  }

  suggestionsEl.innerHTML = html;
  suggestionsEl.classList.remove("hidden");
  bindSuggestionClicks();
}

function bindSuggestionClicks() {
  suggestionsEl.querySelectorAll(".suggestion-item[data-stop-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const stop = allStops.find((s) => s.stop === el.dataset.stopId);
      if (stop) selectStop(stop);
    });
  });
}

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
}

// ── Stop filter (by name) ─────────────────────────────────────────────────────
function filterStops(query) {
  const q = query.toLowerCase();
  return allStops.filter(
    (s) =>
      (s.name_tc && s.name_tc.includes(query)) ||
      (s.name_en && s.name_en.toLowerCase().includes(q))
  );
}

// ── Stop selection ────────────────────────────────────────────────────────────
function selectStop(stop) {
  selectedStop = stop;
  stopNameEl.textContent = stop.name_tc;
  stopIdEl.textContent = `站號：${stop.stop} ・ ${stop.name_en}`;
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
    const res = await fetch(`${KMB_BASE}/stop-eta/${stop.stop}`);
    const json = await res.json();
    const etas = json.data || [];
    renderETA(etas);
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

  // Group by route + direction + service_type
  const groups = {};
  for (const item of etas) {
    const key = `${item.route}__${item.dir}__${item.service_type}`;
    if (!groups[key]) {
      groups[key] = {
        route: item.route,
        dir: item.dir,
        service_type: item.service_type,
        dest_tc: item.dest_tc,
        dest_en: item.dest_en,
        times: [],
      };
    }
    if (item.eta) groups[key].times.push(item.eta);
  }

  const now = Date.now();
  const cards = Object.values(groups)
    .sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }))
    .map((g) => buildRouteCard(g, now))
    .join("");

  etaListEl.innerHTML = cards;
  etaSectionEl.classList.remove("hidden");
}

function buildRouteCard(group, now) {
  const badgesHtml = group.times.length
    ? group.times
        .map((t) => {
          const mins = Math.round((new Date(t) - now) / 60000);
          if (mins < 0) return null;
          let cls = "eta-badge";
          let label = `${mins} 分鐘`;
          if (mins <= 1) { cls += " arriving"; label = "即將到站"; }
          else if (mins <= 5) { cls += " soon"; }
          return `<div class="${cls}">
            <span class="eta-minutes">${mins <= 1 ? "◎" : mins}</span>
            <span class="eta-label">${label}</span>
          </div>`;
        })
        .filter(Boolean)
        .join("")
    : '<span class="eta-no-service">暫無班次</span>';

  return `
    <div class="route-card">
      <div class="route-header">
        <span class="route-number">${group.route}</span>
        <span class="route-dest">往 ${group.dest_tc || group.dest_en}</span>
      </div>
      <div class="eta-times">${badgesHtml || '<span class="eta-no-service">暫無班次</span>'}</div>
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoading(show) {
  loadingEl.classList.toggle("hidden", !show);
}

function showError(msg) {
  errorMsgEl.textContent = msg;
  errorMsgEl.classList.remove("hidden");
}

function clearError() {
  errorMsgEl.classList.add("hidden");
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
