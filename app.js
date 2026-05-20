const REFRESH_MS = 5 * 60 * 1000;
const QUIET_REFRESH_CHECK_MS = 12 * 1000;
const SNAPSHOT_KEY = "hot-trends:snapshot:v1";

const SOURCE_LABELS = {
  baidu: "百度",
  weibo: "微博",
  zhihu: "知乎",
  ithome: "IT之家",
  gamersky: "游民星空",
  economist: "Economist",
  reuters: "Reuters",
  ft: "FT",
  bbc: "BBC",
};

const SOURCE_GROUPS = {
  cn: new Set(["baidu", "weibo", "zhihu", "ithome", "gamersky"]),
  media: new Set(["economist", "reuters", "ft", "bbc"]),
};

const state = {
  items: [],
  rawItems: [],
  sources: {},
  updatedAt: "",
  filter: "all",
  requestInFlight: false,
  quietRefreshTimer: null,
  detailsExpanded: true,
};

const listEl = document.querySelector("#list");
const emptyEl = document.querySelector("#empty");
const updatedAtEl = document.querySelector("#updatedAt");
const themeButton = document.querySelector("#themeButton");
const summaryEl = document.querySelector("#summary");
const filterButtons = Array.from(document.querySelectorAll(".filter"));
const backToTopBtn = document.querySelector("#backToTop");
const expandAllButton = document.querySelector("#expandAllButton");

initTheme();
syncDetailsButton();
themeButton.addEventListener("click", toggleTheme);
backToTopBtn.addEventListener("click", () => { window.scrollTo({ top: 0, behavior: "smooth" }); });
expandAllButton.addEventListener("click", toggleDetails);
window.addEventListener("scroll", handleScroll, { passive: true });

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.source;
    filterButtons.forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

if (restoreSnapshot()) {
  render();
} else {
  renderInitialLoading();
}

loadHotData();
window.setInterval(() => loadHotData(), REFRESH_MS);

async function loadHotData({ force = false } = {}) {
  if (state.requestInFlight) return;

  const hadData = hasData();
  state.requestInFlight = true;

  try {
    const response = await fetch(`/api/hot${force ? "?refresh=1" : ""}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const changed = applyHotData(data);

    persistSnapshot();
    if (changed || !hadData) render();

    if (data.refreshing) {
      scheduleQuietRefreshCheck();
    } else {
      clearQuietRefreshCheck();
    }
  } catch (error) {
    if (!hadData) {
      summaryEl.textContent = `加载失败：${error instanceof Error ? error.message : "未知错误"}`;
      emptyEl.hidden = false;
    }
  } finally {
    state.requestInFlight = false;
  }
}

function applyHotData(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const rawItems = Array.isArray(data.rawItems) ? data.rawItems : [];
  const updatedAt = data.updatedAt || new Date().toISOString();
  const changed = updatedAt !== state.updatedAt
    || items.length !== state.items.length
    || rawItems.length !== state.rawItems.length;

  state.items = items;
  state.rawItems = rawItems;
  state.sources = data.sources || {};
  state.updatedAt = updatedAt;

  return changed;
}

function restoreSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
    if (!snapshot || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.rawItems)) {
      return false;
    }
    applyHotData(snapshot);
    return hasData();
  } catch {
    return false;
  }
}

function persistSnapshot() {
  if (!hasData()) return;

  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      items: state.items,
      rawItems: state.rawItems,
      sources: state.sources,
      updatedAt: state.updatedAt,
    }));
  } catch {
    // Snapshot persistence is opportunistic; live data still works without it.
  }
}

function hasData() {
  return state.items.length > 0 || state.rawItems.length > 0;
}

function renderInitialLoading() {
  updatedAtEl.textContent = "首次加载中";
  summaryEl.innerHTML = `
    <strong>0</strong>
    <span class="summary-tag">首次加载词条</span>
  `;
  emptyEl.hidden = true;
  listEl.innerHTML = "";
}

function scheduleQuietRefreshCheck() {
  if (state.quietRefreshTimer) return;

  state.quietRefreshTimer = window.setTimeout(() => {
    state.quietRefreshTimer = null;
    loadHotData();
  }, QUIET_REFRESH_CHECK_MS);
}

function clearQuietRefreshCheck() {
  if (!state.quietRefreshTimer) return;

  window.clearTimeout(state.quietRefreshTimer);
  state.quietRefreshTimer = null;
}

function render() {
  const visibleItems = getVisibleItems();
  const okCount = Object.values(state.sources).filter((status) => status === "ok").length;
  const isAll = state.filter === "all";
  const mergedCount = state.items.filter((item) => item.sources.length > 1).length;
  const totalCount = isAll ? state.items.length : state.rawItems.length;

  updatedAtEl.textContent = state.updatedAt ? `更新于 ${formatTime(state.updatedAt)}` : "等待更新";

  updateFilterStatus();
  syncDetailsButton();

  summaryEl.innerHTML = `
    <strong>${visibleItems.length}</strong>
    <span class="summary-tag">当前显示</span>
    <span class="summary-tag">${totalCount} 条总词条</span>
    ${isAll ? `<span class="summary-tag">${mergedCount} 条已合并</span>` : ""}
    <span class="summary-tag">${okCount}/${Object.keys(SOURCE_LABELS).length} 来源可用</span>
  `;

  emptyEl.hidden = visibleItems.length > 0;
  const scrollTop = window.scrollY;
  listEl.innerHTML = visibleItems.map((item, i) => renderTrendCard(item, i)).join("");
  if (scrollTop > 0) {
    requestAnimationFrame(() => window.scrollTo({ top: scrollTop, behavior: "instant" }));
  }
}

function getVisibleItems() {
  if (state.filter === "all") return state.items;

  const group = SOURCE_GROUPS[state.filter];
  let filtered;
  if (group) {
    filtered = state.rawItems.filter((item) => group.has(item.source));
  } else {
    filtered = state.rawItems.filter((item) => item.source === state.filter);
  }

  const sourceKeys = Object.keys(SOURCE_LABELS);
  filtered.sort((a, b) => {
    const ai = sourceKeys.indexOf(a.source);
    const bi = sourceKeys.indexOf(b.source);
    if (ai !== bi) return ai - bi;
    return (a.rank || 999) - (b.rank || 999);
  });

  return filtered.map((item, i) => ({
    id: `r-${item.source}-${i}`,
    title: item.title,
    description: item.description,
    image: item.image || "",
    sources: [item],
  }));
}

function renderTrendCard(item, index) {
  const expanded = state.detailsExpanded;
  const description = item.description
    || item.sources[0]?.description
    || "暂无可用简介。";
  const original = item.sources[0]?.originalTitle || item.sources[0]?.originalDescription
    ? item.sources[0] : null;

  const merged = item.sources.length > 1;
  const image = item.image || item.sources[0]?.image || "";
  const titleHtml = merged
    ? `<div class="source-titles">
        ${item.sources.map((s) => `
          <a class="source-title-link ${escapeHtml(s.source)}"
             href="${escapeUrl(s.url)}"
             target="_blank" rel="noopener noreferrer">
            <span class="st-label">${SOURCE_LABELS[s.source] || escapeHtml(s.source)}</span>
            <span class="st-text">${escapeHtml(s.title)}</span>
          </a>
        `).join("")}
       </div>`
    : `<h2 class="trend-title"><a href="${escapeUrl(item.sources[0].url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.sources[0].title)}</a></h2>`;

  return `
    <article class="trend-card ${expanded ? "expanded" : ""}">
      <div class="trend-index">${index < 9 ? "0" : ""}${index + 1}</div>
      <div class="trend-main">
        ${merged ? "" : `<div class="source-line">
          ${item.sources.map((s) => `<span class="source-badge ${escapeHtml(s.source)}">${SOURCE_LABELS[s.source] || escapeHtml(s.source)}</span>`).join("")}
        </div>`}
        ${titleHtml}
        <div class="description" ${expanded ? "" : "hidden"}>
          <p>${escapeHtml(description)}</p>
          ${original ? `<p class="original-text">原文：${escapeHtml(original.originalTitle || original.originalDescription || "")}</p>` : ""}
        </div>
        ${image ? `<img class="trend-thumb" src="${escapeUrl(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" ${expanded ? "" : "hidden"} />` : ""}
      </div>
    </article>
  `;
}

function updateFilterStatus() {
  filterButtons.forEach((button) => {
    const source = button.dataset.source;
    if (!SOURCE_LABELS[source]) return;
    button.dataset.status = state.sources[source] || "error";
  });
}

function toggleDetails() {
  state.detailsExpanded = !state.detailsExpanded;
  render();
}

function syncDetailsButton() {
  expandAllButton.textContent = state.detailsExpanded ? "收起" : "展开";
  expandAllButton.title = state.detailsExpanded ? "收起全部简介和图片" : "展开全部简介和图片";
  expandAllButton.setAttribute("aria-pressed", String(state.detailsExpanded));
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
  syncThemeButton();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
  syncThemeButton();
}

function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  themeButton.textContent = dark ? "浅色" : "暗色";
  themeButton.title = dark ? "切换浅色模式" : "切换暗色模式";
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function handleScroll() {
  backToTopBtn.classList.toggle("visible", window.scrollY > 400);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeUrl(value) {
  try {
    const url = new URL(String(value || "#"), window.location.href);
    if (!["http:", "https:"].includes(url.protocol)) return "#";
    return escapeHtml(url.href);
  } catch {
    return "#";
  }
}
