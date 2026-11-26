// Quota management: per-project and per-thread usage breakdown.
"use strict";

const USAGE_RANGES = [
  [1, "1h"],
  [5, "5h"],
  [24, "24h"],
  [72, "3d"],
  [168, "7d"],
  [336, "14d"],
];
const USAGE_POLL_MS = 30000;
const USAGE_DEFAULT_PROJECTS = 8;
const USAGE_DEFAULT_THREADS = 12;
const USAGE_COMPACT_PROJECTS = 5;
const USAGE_COMPACT_THREADS = 6;
const USAGE_MOBILE_PROJECTS = 4;
const USAGE_MOBILE_THREADS = 5;

function usageCardLayout() {
  const sel = QUOTA_PROVIDERS.includes(state.provider) ? state.provider : "all";
  const hasAll = Boolean(state.data?.totals?.all);
  const isMobile = typeof innerWidth === "number" && innerWidth <= 760;
  const isStacked = typeof innerWidth === "number" && innerWidth < 960;
  const pairActive = sel === "all" && hasAll && !isStacked;
  const wide = Boolean(pairActive && state.wideCards?.usage);
  const allWide = Boolean(pairActive && state.wideCards?.all);
  const span = pairActive && !wide && !allWide ? 6 : 12;
  const canExpand = pairActive && (wide || span < 12);
  return { canExpand, wide, span, isMobile };
}

function usageHours() {
  return state.usage.hours ?? state.hours;
}

function usageProvider() {
  return QUOTA_PROVIDERS.includes(state.provider) ? state.provider : "all";
}

function usageRangeLabel(hours) {
  return USAGE_RANGES.find(([h]) => h === hours)?.[1] || `${hours}h`;
}

const usageIsCu = () => state.unit === "usd" || state.unit === "usd_pct";

function usageMetricLabel(item) {
  if (item.priced && item.cost_usd > 0) {
    return usageIsCu() ? fmtApiUsd(item.cost_usd) : fmtUsd(item.cost_usd);
  }
  return `${fmtTokens(item.tokens)} tok`;
}

function usageShareLabel(share) {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const pct = share * 100;
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function usageProviderBreakdownTip(item) {
  const entries = Object.entries(item.providers || {});
  if (!entries.length) return "";
  const isCu = usageIsCu();
  return entries
    .map(([p, v]) => {
      const val = v.cost_usd > 0
        ? (isCu ? fmtApiUsd(v.cost_usd) : fmtUsd(v.cost_usd))
        : `${fmtTokens(v.tokens)} tok`;
      return `${pName(p)} ${val}`;
    })
    .join(" · ");
}

function usageProviderDots(providers) {
  const keys = byProviderOrder(Object.keys(providers || {}));
  if (!keys.length) return "";
  return `<span class="ub-dots" aria-hidden="true">${keys
    .map((p) => `<i class="ub-dot" style="background:${provColor(p)}" title="${esc(pName(p))}"></i>`)
    .join("")}</span>`;
}

function usageShareBar(item) {
  const share = Math.max(0, Math.min(1, Number(item.share) || 0));
  const widthPct = share > 0 ? Math.max(1.5, share * 100) : 0;
  const entries = Object.entries(item.providers || {});
  const useCost = item.priced && item.cost_usd > 0;
  const total = entries.reduce((sum, [, v]) => sum + (useCost ? v.cost_usd : v.tokens), 0) || 1;
  const segs = byProviderOrder(entries, ([p]) => p)
    .map(([p, v]) => {
      const val = useCost ? v.cost_usd : v.tokens;
      if (val <= 0) return "";
      return `<span style="flex:${val / total};background:${provColor(p)}"></span>`;
    })
    .join("");
  const tip = [
    `${usageShareLabel(share)} of window`,
    usageProviderBreakdownTip(item),
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="ub-bar" role="img" aria-label="${esc(tip)}" title="${esc(tip)}"><div class="ub-bar-fill" style="width:${widthPct.toFixed(2)}%">${segs}</div></div>`;
}

function usageThreadRow(th, showProject = false, now = state.usage.data?.now) {
  const recency = th.last_active_at ? activityAge(th.last_active_at, now) : "";
  const topModel = th.models?.[0] || "";
  const subParts = [
    showProject && th.project_title ? `<span class="ub-proj-pill">${esc(th.project_title)}</span>` : "",
    th.subagent_count > 0 ? `<span class="ub-sub-pill" title="Includes ${th.subagent_count} subagent / delegated thread${th.subagent_count === 1 ? "" : "s"}">+${th.subagent_count} sub</span>` : "",
    topModel ? `<span class="ub-model" title="${esc((th.models || []).join(", "))}">${esc(topModel)}</span>` : "",
    recency ? `<span class="ub-age">${esc(recency)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const secondaryVal = th.priced && th.cost_usd > 0
    ? `${fmtTokens(th.tokens)} tok · ${th.requests.toLocaleString()} req`
    : `${th.requests.toLocaleString()} req`;
  const valTip = [
    th.priced && th.cost_usd > 0 ? `Est. API cost: ${fmtUsd(th.cost_usd)} (${fmtApiUsd(th.cost_usd)})` : "Unpriced model",
    `${th.tokens.toLocaleString()} total tokens (${fmtTokens(th.io_tokens)} in+out)`,
    `${th.requests.toLocaleString()} requests`,
    usageProviderBreakdownTip(th),
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="ub-row ub-thread" data-ub-thread="${esc(th.id)}"><div class="ub-id">${usageProviderDots(th.providers)}<div class="ub-text"><span class="ub-title" title="${esc(th.title)}">${esc(th.title)}</span>${subParts ? `<span class="ub-meta">${subParts}</span>` : ""}</div></div>${usageShareBar(th)}<div class="ub-nums" title="${esc(valTip)}"><strong class="ub-val">${esc(usageMetricLabel(th))}</strong><span class="ub-share">${esc(usageShareLabel(th.share))}</span><span class="ub-tok">${esc(secondaryVal)}</span></div></div>`;
}

function usageProjectRow(proj, now = state.usage.data?.now) {
  const open = Boolean(state.usage.expanded[proj.id]);
  const recency = proj.last_active_at ? activityAge(proj.last_active_at, now) : "";
  const metaParts = [
    `<span class="ub-meta-item">${proj.thread_count} thread${proj.thread_count === 1 ? "" : "s"}</span>`,
    proj.subagent_count > 0 ? `<span class="ub-meta-item">+${proj.subagent_count} sub</span>` : "",
    recency ? `<span class="ub-age">${esc(recency)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const secondaryVal = proj.priced && proj.cost_usd > 0
    ? `${fmtTokens(proj.tokens)} tok · ${proj.requests.toLocaleString()} req`
    : `${proj.requests.toLocaleString()} req`;
  const valTip = [
    proj.priced && proj.cost_usd > 0 ? `Est. API cost: ${fmtUsd(proj.cost_usd)} (${fmtApiUsd(proj.cost_usd)})` : "Unpriced models",
    `${proj.tokens.toLocaleString()} total tokens (${fmtTokens(proj.io_tokens)} in+out)`,
    `${proj.requests.toLocaleString()} requests`,
    usageProviderBreakdownTip(proj),
  ]
    .filter(Boolean)
    .join(" · ");
  const children = open
    ? `<div class="ub-children">${(proj.threads || []).map((th) => usageThreadRow(th, false, now)).join("")}</div>`
    : "";
  return `<div class="ub-project${open ? " open" : ""}" data-ub-project="${esc(proj.id)}"><button type="button" class="ub-row ub-proj-btn" data-ub-toggle="${esc(proj.id)}" aria-expanded="${open}"><div class="ub-id"><span class="ub-chev" aria-hidden="true">${icon("chevron")}</span>${usageProviderDots(proj.providers)}<div class="ub-text"><span class="ub-title" title="${esc(proj.title)}">${esc(proj.title)}</span><span class="ub-meta">${metaParts}</span></div></div>${usageShareBar(proj)}<div class="ub-nums" title="${esc(valTip)}"><strong class="ub-val">${esc(usageMetricLabel(proj))}</strong><span class="ub-share">${esc(usageShareLabel(proj.share))}</span><span class="ub-tok">${esc(secondaryVal)}</span></div></button>${children}</div>`;
}

function usageBreakdownHtml() {
  const u = state.usage;
  const data = u.data;
  const hours = usageHours();
  const prov = usageProvider();
  const rangeBtns = USAGE_RANGES.map(
    ([h, label]) => `<button type="button" data-ub-hours="${h}" ${choice(hours === h)}>${label}</button>`,
  ).join("");
  const viewBtns = [
    ["projects", "Projects"],
    ["threads", "Threads"],
  ]
    .map(([v, label]) => `<button type="button" data-ub-view="${v}" ${choice(u.view === v)}>${label}</button>`)
    .join("");
  const scopeTag = prov !== "all" ? `<span class="tag outline">${esc(pName(prov))}</span>` : "";

  let summary = "";
  let body = "";
  if (u.error && !data) {
    body = `<p class="ub-empty">${esc(u.error)}</p>`;
  } else if (!data) {
    body = `<div class="ub-loading"><span class="loading-mark"></span>Scanning project &amp; thread usage…</div>`;
  } else {
    const totals = data.totals || {};
    const totalCost = totals.priced && totals.cost_usd > 0
      ? (usageIsCu() ? fmtApiUsd(totals.cost_usd) : fmtUsd(totals.cost_usd))
      : "";
    const sumParts = [
      totalCost ? `~${totalCost}` : "",
      totals.tokens ? `${fmtTokens(totals.tokens)} tok` : "",
      totals.requests ? `${totals.requests.toLocaleString()} req` : "",
      totals.projects ? `${totals.projects} project${totals.projects === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    summary = sumParts.length
      ? `<span class="ub-summary">${sumParts.map((part) => `<span class="nowrap">${esc(part)}</span>`).join(" · ")}</span>`
      : "";

    const provEntries = byProviderOrder(Object.keys(totals.providers || {}));
    const provLegend = prov === "all" && provEntries.length > 1
      ? `<div class="ub-legend">${provEntries
          .map((p) => {
            const v = totals.providers[p];
            const amt = v.cost_usd > 0
              ? (usageIsCu() ? fmtApiUsd(v.cost_usd) : fmtUsd(v.cost_usd))
              : `${fmtTokens(v.tokens)} tok`;
            return `<span class="legend"><i class="tip-swatch" style="background:${provColor(p)}"></i>${esc(pName(p))} ${esc(amt)}</span>`;
          })
          .join("")}</div>`
      : "";

    const layout = usageCardLayout();
    const defaultProjLimit = layout.isMobile
      ? USAGE_MOBILE_PROJECTS
      : layout.span === 6
        ? USAGE_COMPACT_PROJECTS
        : USAGE_DEFAULT_PROJECTS;
    const defaultThreadLimit = layout.isMobile
      ? USAGE_MOBILE_THREADS
      : layout.span === 6
        ? USAGE_COMPACT_THREADS
        : USAGE_DEFAULT_THREADS;
    if (!totals.requests) {
      body = `<p class="ub-empty">No local project or thread usage recorded in the last ${esc(usageRangeLabel(hours))}.</p>`;
    } else if (u.view === "threads") {
      const list = data.threads || [];
      const limit = u.showAll ? list.length : defaultThreadLimit;
      const shown = list.slice(0, limit);
      const more = list.length > limit
        ? `<button type="button" class="ghost sm ub-more" data-ub-more>Show all ${list.length} threads</button>`
        : u.showAll && list.length > defaultThreadLimit
          ? `<button type="button" class="ghost sm ub-more" data-ub-more>Show fewer</button>`
          : "";
      body = `<div class="ub-list">${shown.map((th) => usageThreadRow(th, true, data.now)).join("")}</div>${more}${provLegend}`;
    } else {
      const list = data.projects || [];
      const limit = u.showAll ? list.length : defaultProjLimit;
      const shown = list.slice(0, limit);
      const more = list.length > limit
        ? `<button type="button" class="ghost sm ub-more" data-ub-more>Show all ${list.length} projects</button>`
        : u.showAll && list.length > defaultProjLimit
          ? `<button type="button" class="ghost sm ub-more" data-ub-more>Show fewer</button>`
          : "";
      body = `<div class="ub-list">${shown.map((p) => usageProjectRow(p, data.now)).join("")}</div>${more}${provLegend}`;
    }
  }

  const layout = usageCardLayout();
  const cardTitle = u.view === "threads" ? "Usage by thread" : "Usage by project";
  const expandBtn =
    layout.canExpand && typeof cardExpandButton === "function"
      ? cardExpandButton("usage", cardTitle, layout.wide)
      : "";
  return `<div class="ub-head"><div class="ub-head-id"><h2>${cardTitle}</h2>${scopeTag}${summary}</div><div class="ub-controls"><div class="segmented sm" role="group" aria-label="Breakdown grouping">${viewBtns}</div><div class="segmented sm" role="group" aria-label="Usage breakdown range">${rangeBtns}</div></div>${expandBtn}</div>${body}`;
}

function renderUsageBreakdown() {
  const root = $("#usage-breakdown");
  if (!root) return;
  const u = state.usage;
  if (u.data && u.data.available === false) {
    const wasVisible = !root.hidden;
    root.hidden = true;
    u.html = "";
    const allCard = $('[data-pool="all"]');
    if (
      (wasVisible || allCard?.classList.contains("card-span-6") || allCard?.querySelector('[data-expand-card="all"]')) &&
      typeof render === "function"
    ) {
      render();
    }
    return;
  }
  const wasHidden = root.hidden;
  root.hidden = false;
  const layout = usageCardLayout();
  root.className = `pool usage-breakdown card-span-${layout.span}${layout.wide ? " card-wide" : ""}`;
  const html = usageBreakdownHtml();
  if (html !== u.html || !root.childElementCount) {
    u.html = html;
    const next = document.createElement("template");
    next.innerHTML = html;
    if (typeof patchChildren === "function" && root.childElementCount) {
      patchChildren(root, next.content);
    } else {
      root.replaceChildren(next.content);
    }
    updateIndicators();
  }
  if (wasHidden && typeof render === "function") render();
}

let usageTicket = 0;
async function loadUsageBreakdown(force = false) {
  const u = state.usage;
  if (!state.session || state.page !== "quotas") return;
  const hours = usageHours();
  const provider = usageProvider();
  const key = `${hours}:${provider}`;
  const now = Date.now();
  if (!force && u.key === key && u.data && now - u.fetchedAt < USAGE_POLL_MS) {
    renderUsageBreakdown();
    return;
  }
  const ticket = ++usageTicket;
  u.loading = true;
  if (u.key !== key) {
    u.data = null;
    u.error = "";
    renderUsageBreakdown();
  }
  try {
    const res = await api(`usage/breakdown?hours=${hours}&provider=${encodeURIComponent(provider)}`);
    if (ticket !== usageTicket) return;
    u.data = res;
    u.key = key;
    u.error = "";
    u.fetchedAt = Date.now();
  } catch (e) {
    if (ticket !== usageTicket) return;
    // Older backend without /api/usage/breakdown: stay quietly hidden.
    if (/not found/i.test(e.message || "")) {
      u.data = { available: false };
      u.key = key;
      u.fetchedAt = Date.now();
    } else {
      u.error = e.message;
    }
  } finally {
    if (ticket === usageTicket) {
      u.loading = false;
      if (state.page === "quotas") renderUsageBreakdown();
    }
  }
}

function ensureUsageBreakdown(force = false) {
  if (!$("#usage-breakdown")) return;
  renderUsageBreakdown();
  loadUsageBreakdown(force);
}

$("#page-body").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !b.closest("#usage-breakdown")) return;
  if (b.dataset.ubView) {
    state.usage.view = b.dataset.ubView;
    state.usage.showAll = false;
    savePrefs();
    renderUsageBreakdown();
    return;
  }
  if (b.dataset.ubHours) {
    const h = Number(b.dataset.ubHours);
    if (Number.isFinite(h)) {
      state.usage.hours = h === state.hours ? null : h;
      state.usage.showAll = false;
      savePrefs();
      loadUsageBreakdown(true);
    }
    return;
  }
  if (b.dataset.ubToggle) {
    const id = b.dataset.ubToggle;
    if (state.usage.expanded[id]) delete state.usage.expanded[id];
    else state.usage.expanded[id] = true;
    renderUsageBreakdown();
    return;
  }
  if (b.hasAttribute("data-ub-more")) {
    state.usage.showAll = !state.usage.showAll;
    renderUsageBreakdown();
  }
});
