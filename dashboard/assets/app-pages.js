// Navigation and preferences, loading and rendering, page events and chart inspection.
"use strict";

// The logs container is JS-owned (data-live); the snapshot patch leaves it alone.
function logsPage() {
  return `<div class="logs" id="logs-live" data-live></div>`;
}

// Chart choices survive reloads (per browser; storage may be unavailable).
const PREFS_KEY = "prox:prefs";
// Pages live at clean paths: /dashboard/, /dashboard/accounts, /dashboard/keys, /dashboard/tokens, /dashboard/logs.
const PAGES = ["quotas", "accounts", "subscriptions", "keys", "tokens", "logs"];
const PAGE_ALIASES = {};
const pagePath = (page) => {
  const canonical = PAGE_ALIASES[page] || page;
  return canonical === "quotas" ? "/dashboard/" : `/dashboard/${canonical}`;
};
function pageFromPath() {
  const raw = location.pathname
    .replace(/^\/dashboard\/?/, "")
    .replace(/\/$/, "");
  // /dashboard/accounts/<id> is one account's page.
  const one = raw.match(/^accounts\/([^/]+)$/);
  if (one) {
    state.accountId = decodeURIComponent(one[1]);
    return "account";
  }
  const page = PAGE_ALIASES[raw] || raw;
  return PAGES.includes(page) ? page : "quotas";
}
const navPage = (page) => (page === "account" ? "accounts" : page);
const accountPath = (a) => `/dashboard/accounts/${encodeURIComponent(a.id)}`;
const PAGE_TITLES = {
  quotas: "Quota management",
  accounts: "Accounts",
  subscriptions: "Subscriptions",
  account: "Account",
  keys: "Keys",
  tokens: "Tokens",
  logs: "Logs",
};
function syncDocumentTitle() {
  document.title = "Silo";
}
// Old #accounts-style links land on the matching clean path.
const hashPage = PAGE_ALIASES[location.hash.slice(1)] || location.hash.slice(1);
if (PAGES.includes(hashPage))
  history.replaceState(null, "", pagePath(hashPage));
// Show the right heading and nav item before any data arrives (first
// paint, or back/forward while loading); only real page changes morph.
function showPageChrome() {
  const page = pageFromPath();
  $("#page-title").textContent = PAGE_TITLES[page];
  syncDocumentTitle(page);
  $$("[data-page]").forEach((a) =>
    a.classList.toggle("active", a.dataset.page === navPage(page)),
  );
  syncHeaderActions();
}
showPageChrome();
function navigate(page) {
  page = PAGE_ALIASES[page] || page;
  if (!PAGES.includes(page)) return;
  if (location.pathname !== pagePath(page))
    history.pushState(null, "", pagePath(page));
  setMenu(false);
  render(true);
}
function restorePrefs() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {}
  const pick = (value, allowed) =>
    allowed.includes(value) ? value : undefined;
  state.provider =
    pick(saved.provider, ["all", ...Object.keys(PROVIDERS)]) ??
    state.provider;
  state.view = pick(saved.view, ["remaining", "drain"]) ?? state.view;
  state.hours = pick(saved.hours, [24, 72, 168, 336]) ?? state.hours;
  state.weekHours = pick(saved.weekHours, [168, 336]) ?? state.weekHours;
  state.allWindow = pick(saved.allWindow, ["5h", "7d"]) ?? state.allWindow;
  state.accountWindow =
    pick(saved.accountWindow, ["5h", "7d", "both"]) ?? state.accountWindow;
  state.burn = pick(saved.burn, [1, 3, 6]) ?? state.burn;
  state.unit = pick(saved.unit, ["usd", "usd_pct", "weighted", "units", "raw"]) ?? state.unit;
  state.usage.view = pick(saved.usageView, ["projects", "threads"]) ?? state.usage.view;
  state.usage.hours = pick(saved.usageHours, [1, 5, 24, 72, 168, 336]) ?? null;
  if (typeof saved.forecast === "boolean")
    state.forecast = saved.forecast;
  if (typeof saved.claudeExtra === "boolean")
    state.claudeExtra = saved.claudeExtra;
  if (saved.windows && typeof saved.windows === "object")
    for (const [p, id] of Object.entries(saved.windows))
      if (typeof id === "string") state.windows[p] = id;
  if (saved.expanded && typeof saved.expanded === "object")
    for (const [p, open] of Object.entries(saved.expanded))
      if (open === true) state.expanded[p] = true;
  const allowedCards = new Set(["all", "usage", ...Object.keys(PROVIDERS)]);
  if (saved.wideCards && typeof saved.wideCards === "object") {
    for (const [id, open] of Object.entries(saved.wideCards))
      if (open === true && allowedCards.has(id)) state.wideCards[id] = true;
  }
  if (Array.isArray(saved.wideOrder)) {
    state.wideOrder = saved.wideOrder.filter(
      (id) => typeof id === "string" && allowedCards.has(id) && (state.wideCards[id] || state.expanded[id]),
    );
  }
}
function recordWideOrder(id, open) {
  state.wideOrder = (state.wideOrder || []).filter((x) => x !== id);
  if (open) state.wideOrder.push(id);
}
function savePrefs() {
  const { provider, view, hours, weekHours, allWindow, accountWindow, burn, unit, forecast, claudeExtra, windows, expanded, wideCards, wideOrder } = state;
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        provider, view, hours, weekHours, allWindow, accountWindow, burn, unit, forecast, claudeExtra, windows, expanded, wideCards, wideOrder,
        usageView: state.usage.view,
        usageHours: state.usage.hours,
      }),
    );
  } catch {}
}
restorePrefs();
function keepInView(el) {
  if (!el || typeof el.getBoundingClientRect !== "function" || typeof el.scrollIntoView !== "function") return;
  const r = el.getBoundingClientRect();
  if (r.top < 12) {
    el.scrollIntoView({ block: "start", behavior: motionAllowed() ? "smooth" : "auto" });
  } else if (r.bottom > innerHeight - 12) {
    el.scrollIntoView({ block: "nearest", behavior: motionAllowed() ? "smooth" : "auto" });
  }
}
// A provider's account list remembers whether it was expanded (toggle doesn't bubble).
document.addEventListener(
  "toggle",
  (e) => {
    const p = e.target.dataset?.accounts;
    if (!p) return;
    // Ignore synthetic toggle events fired when restoring saved <details open> on load or tab switch.
    if (e.target.open === Boolean(state.expanded[p])) return;
    if (e.target.open) {
      state.expanded[p] = true;
      recordWideOrder(p, true);
    } else {
      delete state.expanded[p];
      if (!state.wideCards[p]) recordWideOrder(p, false);
    }
    savePrefs();
    render();
    dedupeProjected();
    const summary = $(`[data-accounts="${CSS.escape(p)}"] > summary`);
    if (e.target.open) {
      keepInView(summary || e.target);
    } else if (summary && summary.offsetParent !== null) {
      keepInView(summary);
    } else {
      const tile = $$(`[data-expand-card="${CSS.escape(p)}"]`).find((el) => el.offsetParent !== null);
      if (tile) {
        tile.focus({ preventScroll: true });
        keepInView(tile);
      }
    }
  },
  true,
);
$("#page-body").addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-expand-card]");
  if (!btn) return;
  const id = btn.dataset.expandCard;
  if (!id) return;
  const wasOpen = Boolean(state.wideCards[id] || state.expanded[id]);
  if (wasOpen) {
    delete state.wideCards[id];
    if (state.expanded[id]) {
      delete state.expanded[id];
      $(`[data-accounts="${CSS.escape(id)}"]`)?.removeAttribute("open");
    }
    recordWideOrder(id, false);
  } else {
    state.wideCards[id] = true;
    recordWideOrder(id, true);
  }
  savePrefs();
  render();
  if (typeof renderUsageBreakdown === "function") renderUsageBreakdown();
  const focusTarget = $$(`[data-expand-card="${CSS.escape(id)}"]`).find((el) => el.offsetParent !== null);
  focusTarget?.focus({ preventScroll: true });
  keepInView(focusTarget);
});
// Header actions follow the route, so they are right before the first snapshot too:
// quota actions only where quotas and accounts show, New key on Keys.
function syncHeaderActions() {
  const page = pageFromPath(),
    showsQuotas = ["quotas", "accounts", "account"].includes(page),
    addLabel = page === "keys" ? "New key" : "Add login";
  $("#refresh").hidden = !showsQuotas;
  // On phones an empty key list has its own labelled button, so the header one steps aside.
  $("#add-login").hidden =
    (!showsQuotas && page !== "keys") ||
    (page === "keys" && state.keys.list?.length === 0 && innerWidth <= 760);
  // New key needs the provider/account options, so it waits for them.
  $("#add-login").disabled = page === "keys" && !state.keys.options;
  $("#add-login").title = addLabel;
  $("#add-login").setAttribute("aria-label", addLabel);
  morphText($("#add-login .button-label"), addLabel);
}
// Show "Projected" and "Idlenet" once on the page: on the first visible chart that draws each.
function dedupeProjected() {
  for (const sel of [".legend-proj", ".legend-silo"]) {
    let seen = false;
    $$(sel).forEach((el) => {
      el.classList.remove("legend-dup");
      // Closed <details> content still reports an offsetParent in Chrome, so test for it explicitly.
      if (!el.offsetParent || el.closest("details:not([open])")) return;
      if (seen) el.classList.add("legend-dup");
      seen = true;
    });
  }
}
function render(animate = false) {
  syncHeaderActions();
  if (!state.data) return;
  if (state.provider !== "all" && !presentProviders().includes(state.provider)) state.provider = "all";
  const body = $("#page-body");
  state.page = pageFromPath();
  morphText($("#page-title"), PAGE_TITLES[state.page]);
  syncDocumentTitle(state.page);
  const count = state.data.accounts.length;
  if (state.page !== "tokens") {
    const meta =
      state.page === "keys"
        ? keysMeta()
        : state.page === "logs" && typeof logsMeta === "function"
          ? logsMeta()
          : "";
    morphText($("#page-meta"), meta);
  }
  morphText($("#nav-account-count"), count);
  updateRenewalAlert(state.data.accounts);
  $$("[data-page]").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === navPage(state.page));
    if (a.dataset.page === navPage(state.page))
      a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#global-error").hidden = !state.data.error;
  $("#global-error").textContent = state.data.error || "";
  $("#refresh").disabled = state.data.refreshing;
  morphText(
    $("#refresh .button-label"),
    state.data.refreshing ? "Refreshing…" : "Refresh all quotas",
  );
  const next = document.createElement("template");
  // Logs and keys don't need any signed-in account.
  if (!count && !["logs", "keys", "tokens", "subscriptions"].includes(state.page)) {
    next.innerHTML = `<div class="state-card"><h2>${state.data.error ? "Waiting for the proxy" : "Your account pool starts here"}</h2><p>${state.data.error ? "The connection will be checked automatically." : "Add a login to start pooling accounts and tracking their quotas."}</p><button class="primary" data-add>${icon("plus")}Add login</button></div>`;
  } else
    next.innerHTML =
      state.page === "quotas"
        ? quotaPage()
        : state.page === "accounts"
          ? accountsPage()
          : state.page === "account"
            ? accountPage()
            : state.page === "subscriptions"
            ? subscriptionsPage()
            : state.page === "keys"
            ? keysPage()
            : state.page === "tokens"
              ? tokensPage()
              : logsPage();
  const selection = JSON.stringify([
    state.provider,
    state.allWindow,
    state.accountWindow,
    state.view,
    state.hours,
    state.burn,
    state.unit,
    state.forecast,
    state.claudeExtra,
    state.windows,
  ]);
  savePrefs();
  const pageChanged = renderedPage !== state.page;
  const selectionChanged = renderedSelection !== selection;
  if (selectionChanged) $$("[data-chart]", body).forEach(clearChart);
  patchChildren(body, next.content);
  dedupeProjected();
  // A pinned point is placed again from its timestamp in the redrawn geometry; it is
  // dropped when the forecast it sat on is gone or the sample left the view.
  $$("[data-chart]", body).forEach((plot) => {
    const tip = $(".chart-tooltip", plot),
      chart = state.charts[plot.dataset.chart],
      ts = Number(plot.dataset.inspectedAt);
    if (plot.dataset.inspectedAt === undefined || !tip || tip.hidden) return;
    if (plot.dataset.inspectedProjected === "1") {
      if (chart?.forecast.length && ts >= chart.forecast[0].ts) inspectChart(plot, seriesAt(chart, ts));
      else clearChart(plot);
      return;
    }
    // Recorded: the nearest sample, so the latest point survives a refresh that adds one.
    if (chart?.points.length && ts >= chart.points[0].ts) inspectChart(plot, { ...nearestPoint(chart.points, ts), projected: false });
    else clearChart(plot);
  });
  if (state.page === "quotas" && typeof ensureUsageBreakdown === "function")
    ensureUsageBreakdown(false);
  if (state.page === "logs") ensureLogs(pageChanged);
  else stopLogs();
  if (state.page === "keys") ensureKeys();
  if (state.page === "tokens") ensureTokens();
  if (state.page === "account" && !state.tokens.buckets && !state.tokens.fetching) {
    state.tokens.fetching = true;
    loadTokens().finally(() => (state.tokens.fetching = false));
  }
  syncMenu();
  updateIndicators();
  // Draw each chart's data in from the left the first time it mounts.
  $$("[data-chart]", body).forEach((plot) => {
    if (plot.hasAttribute("data-motion-drawn")) return;
    plot.dataset.motionDrawn = "";
    if (motionAllowed())
      $(".chart-data", plot)?.animate(
        [
          { clipPath: "inset(0 100% 0 0)" },
          { clipPath: "inset(0 0 0 0)" },
        ],
        { duration: 900, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
  });
  if (animate && motionAllowed()) {
    if (pageChanged) enter(body, 6);
    else if (selectionChanged) {
      if (state.page === "quotas")
        $$(".account-pool", body).forEach((block) => {
          enter($(".plot", block));
          enter($(".pool-total", block));
        });
      else enter($(".account-list", body));
    }
  }
  renderedPage = state.page;
  renderedSelection = selection;
}
let pendingLoad = false,
  pendingAnimation = false;
async function load(animate = false) {
  if (!state.session) return;
  if (state.loadBusy) {
    pendingLoad = true;
    pendingAnimation ||= animate;
    return;
  }
  state.loadBusy = true;
  clearTimeout(refreshTimer);
  const requestedHours = state.hours;
  try {
    const data = await api(`snapshot?hours=${requestedHours}&history=series`);
    if (requestedHours === state.hours) {
      state.data = data;
      render(animate);
    } else {
      pendingLoad = true;
      pendingAnimation ||= animate;
    }
  } catch (e) {
    if (state.session) {
      $("#global-error").hidden = false;
      $("#global-error").textContent = e.message;
    }
  } finally {
    state.loadBusy = false;
    if (state.session && pendingLoad) {
      const again = pendingAnimation;
      pendingLoad = pendingAnimation = false;
      await load(again);
    } else if (state.session)
      refreshTimer = setTimeout(
        load,
        state.data?.refreshing ? 2000 : document.hidden ? 30000 : 10000,
      );
  }
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("button", e.target);
  button.disabled = true;
  $("#login-error").hidden = true;
  try {
    await api("login", { key: $("#management-key").value });
    $("#management-key").value = "";
    showApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
    $("#login-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});
$("#logout").addEventListener("click", async () => {
  try {
    await api("logout", {});
    state.session = false;
    state.data = null;
    showLogin();
  } catch (e) {
    notify(e.message, "error");
  }
});
$("#refresh").addEventListener("click", async () => {
  const b = $("#refresh");
  b.disabled = true;
  try {
    await api("refresh", {});
    state.data.refreshing = true;
    render();

    setTimeout(load, 1200);
  } catch (e) {
    b.disabled = false;
    notify(e.message, "error");
  }
});
function setMenu(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#sidebar").inert = innerWidth <= 760 && !open;
  $("#nav-scrim").hidden = !open;
  $("#menu").setAttribute("aria-expanded", open);
}
$("#menu").addEventListener("click", () =>
  setMenu(!$("#sidebar").classList.contains("open")),
);
$("#nav-scrim").addEventListener("click", () => {
  setMenu(false);
  $("#menu").focus();
});
window.addEventListener("popstate", () => {
  setMenu(false);
  if (state.data) render(true);
  else showPageChrome();
});
// Sidebar links navigate in place; modified clicks still open a new tab.
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-page], a[data-page-link]");
  if (
    !link ||
    e.defaultPrevented ||
    e.button !== 0 ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey
  )
    return;
  e.preventDefault();
  navigate(link.dataset.page || link.dataset.pageLink);
});
let resizeTimer,
  layoutWidth = innerWidth;
window.addEventListener("resize", () => {
  if (innerWidth === layoutWidth) return;
  if (layoutWidth <= 760 !== innerWidth <= 760) {
    setMenu(false);
    // Phones hide the Done button, so leave Reorder before it is stranded.
    if (innerWidth <= 760) state.reorder = false;
  }
  layoutWidth = innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    render();
  }, 150);
});
setMenu(false);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setMenu(false);
  }
});
// Provider order lives on the server so every device shows the same order.
async function saveProviderOrder(order) {
  const before = state.data.provider_order;
  state.data.provider_order = order;
  render();
  try {
    await api("provider-order", { order });
  } catch (e) {
    state.data.provider_order = before;
    render();
    notify("Couldn't save the provider order", "error", e.message);
  }
}
// Save a new order for the providers in this tab strip. They go back into the slots they
// held among all signed-in providers, so ones hidden here keep their place; providers
// that are not signed in stay after them.
function saveShownOrder(shown) {
  const all = presentProviders(),
    visible = tabProviders();
  let k = 0;
  const next = all.map((q) => (visible.includes(q) ? shown[k++] : q)),
    rest = (state.data.provider_order || []).filter((q) => !next.includes(q));
  saveProviderOrder([...next, ...rest]);
}
function moveProvider(p, delta) {
  const list = tabProviders(),
    i = list.indexOf(p),
    j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return false;
  list.splice(j, 0, list.splice(i, 1)[0]);
  saveShownOrder(list);
  return true;
}
let dragProvider = null;
$("#page-body").addEventListener("dragstart", (e) => {
  const tab = e.target.closest?.("[data-provider-tab]");
  if (!tab) return;
  dragProvider = tab.dataset.providerTab;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragProvider);
});
$("#page-body").addEventListener("dragover", (e) => {
  if (dragProvider && e.target.closest?.("[data-provider-tab]")) e.preventDefault();
});
$("#page-body").addEventListener("drop", (e) => {
  const tab = e.target.closest?.("[data-provider-tab]");
  if (!dragProvider || !tab) return;
  e.preventDefault();
  // Dropping a tab onto itself changes nothing.
  if (tab.dataset.providerTab === dragProvider) {
    dragProvider = null;
    return;
  }
  const list = tabProviders().filter((q) => q !== dragProvider),
    at = list.indexOf(tab.dataset.providerTab),
    after = e.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
  list.splice(at + (after ? 1 : 0), 0, dragProvider);
  dragProvider = null;
  saveShownOrder(list);
});
$("#page-body").addEventListener("dragend", () => (dragProvider = null));
$("#page-body").addEventListener("keydown", (e) => {
  const tab = e.target.closest?.("[data-provider-tab]");
  if (!tab || !e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  const p = tab.dataset.providerTab;
  if (moveProvider(p, e.key === "ArrowLeft" ? -1 : 1))
    requestAnimationFrame(() => $(`[data-provider-tab="${CSS.escape(p)}"]`)?.focus());
});
function openAccount(id) {
  history.pushState(null, "", `/dashboard/accounts/${encodeURIComponent(id)}`);
  setMenu(false);
  render(true);
  scrollTo(0, 0);
}
$("#page-body").addEventListener("click", async (e) => {
  const link = e.target.closest("[data-open-account]");
  if (link && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button)) {
    e.preventDefault();
    openAccount(link.dataset.openAccount);
    return;
  }
  const b = e.target.closest("button");
  if (!b) {
    // An account row opens its page from anywhere outside its controls.
    const arow = e.target.closest(".account-row");
    if (arow && !e.target.closest("a,input,select") && !getSelection().toString()) {
      openAccount(arow.dataset.account);
      return;
    }
    // A key row opens its usage from anywhere outside its controls.
    const row = e.target.closest(".key-row");
    if (row && !getSelection().toString()) toggleKey(row.dataset.key);
    return;
  }
  if (b.closest(".keys")) {
    keyAction(b);
    return;
  }
  if (b.dataset.reorder !== undefined) {
    state.reorder = !state.reorder;
    render();
    return;
  }
  if (b.dataset.move) {
    // Read before rendering: the patch may reuse this button for another provider.
    const move = b.dataset.move,
      [p, d] = move.split(":");
    moveProvider(p, Number(d));
    requestAnimationFrame(() => {
      const arrow = $(`[data-move="${CSS.escape(move)}"]`);
      (arrow && !arrow.disabled ? arrow : $(`[data-provider-tab="${CSS.escape(p)}"]`))?.focus();
    });
    return;
  }
  if (b.dataset.tokMode) {
    state.tokens.mode = b.dataset.tokMode;
    renderTokens();
    return;
  }
  if (b.dataset.tokColor) {
    state.tokens.colorBy = b.dataset.tokColor;
    renderTokens();
    return;
  }
  if (b.dataset.tokRange) {
    state.tokens.range = b.dataset.tokRange === "all" ? "all" : Number(b.dataset.tokRange);
    renderTokens();
    return;
  }
  if (b.dataset.tokView) {
    state.tokens.view = b.dataset.tokView;
    renderTokens();
    return;
  }
  if (b.hasAttribute("data-chart-opts")) {
    state.chartOpts = !state.chartOpts;
    render();
  } else if (b.dataset.filter) {
    state.provider = b.dataset.filter;
    render(true);
  } else if (b.dataset.allWin) {
    state.allWindow = b.dataset.allWin;
    await rangeForWindow(b.dataset.allWin === "5h" ? 5 * 3600 : 7 * 86400);
  } else if (b.dataset.acctWin) {
    state.accountWindow = b.dataset.acctWin;
    render(true);
  } else if (b.dataset.windowId) {
    await pickWindow(b.dataset.window, b.dataset.windowId, "windowGroup" in b.dataset);
  } else if (b.dataset.view) {
    state.view = b.dataset.view;
    render(true);
  } else if (b.dataset.burn) {
    state.burn = Number(b.dataset.burn);
    render(true);
  } else if (b.dataset.unit) {
    state.unit = b.dataset.unit;
    render(true);
  } else if (b.hasAttribute("data-claude-extra")) {
    state.claudeExtra = !state.claudeExtra;
    render(true);
  } else if (b.dataset.hours) {
    const hours = Number(b.dataset.hours);
    if (hours >= 168) state.weekHours = hours;
    await setHours(hours);
  } else if (b.dataset.go) {
    navigate(b.dataset.go);
  } else if (b.hasAttribute("data-add")) {
    openOAuth(b.dataset.add);
  } else if (b.dataset.menu) {
    if (menuTrigger === b) closeMenu();
    else openMenu(b, e.detail === 0);
  } else if (b.dataset.prioritySet) {
    const priority = Number(b.dataset.priorityValue),
      name = PRIORITY_CHOICES.find(([v]) => v === priority)?.[1] || "Normal";
    b.disabled = true;
    try {
      await api("account/priority", { id: b.dataset.prioritySet, priority });
      notify(`Priority set to ${name}`, "success", PRIORITY_CHOICES.find(([v]) => v === priority)?.[2]);
      await load();
    } catch (err) {
      notify("Couldn't change the priority", "error", err.message);
    } finally {
      b.disabled = false;
    }
  } else if (b.dataset.startRename) {
    startRename(b.dataset.startRename);
  } else if (b.dataset.relogin) {
    relogin(b.dataset.relogin);
  } else if (b.dataset.logsTab) {
    selectLogsTab(b.dataset.logsTab);
  } else if (b.hasAttribute("data-logs-refresh")) {
    loadErrors();
  } else if (b.dataset.logName) {
    openLog(b.dataset.logName);
  } else if (b.hasAttribute("data-log-close")) {
    const name = state.logs.open;
    state.logs.open = null;
    renderLogsContent();
    $(`[data-log-name="${CSS.escape(name)}"]`)?.focus();
  } else if (b.hasAttribute("data-log-copy")) {
    copyWithFeedback(b, state.logs.text || "", "Copy log");
  } else if (b.hasAttribute("data-logs-enable")) {
    enableActivity(b);
  } else if (b.hasAttribute("data-logs-pause")) {
    const activity = state.logs.activity;
    activity.paused = !activity.paused;
    updateLiveHead();
    if (activity.paused) stopLogs();
    else fetchActivity();
  } else if (b.dataset.copy) {
    copyWithFeedback(b, state.data.endpoint, "Copy API endpoint");
  } else if (b.dataset.pause) {
    if (b.hasAttribute("data-motion-pending")) return;
    const pause = b.dataset.disabled === "true",
      label = b
        .closest(".account-row")
        ?.querySelector(".account-label")?.textContent || labelFor(accountById(b.dataset.pause));
    // Flip immediately; revert if the proxy rejects the change.
    b.dataset.motionPending = "";
    b.setAttribute("aria-checked", String(!pause));
    try {
      await api("account/status", {
        id: b.dataset.pause,
        disabled: pause,
      });
      notify(
        pause ? "Account paused" : "Account resumed",
        "success",
        pause
          ? `${label} is excluded from rotation.`
          : `${label} is back in rotation.`,
      );
      await load();
    } catch (err) {
      b.setAttribute("aria-checked", String(pause));
      notify("Couldn't update the account", "error", err.message);
    } finally {
      delete b.dataset.motionPending;
    }
  } else if (b.dataset.capSet) {
    const id = b.dataset.capSet,
      group = b.dataset.capGroup || "",
      win = b.dataset.capWindow || "",
      cap = Number(b.dataset.capValue),
      a = accountById(id);
    if (!a || !Number.isInteger(cap)) return;
    try {
      const payload = { id, cap_percent: cap };
      if (group) payload.group = group;
      if (win) payload.window = win;
      await api("account/cap", payload);
      const current = accountById(id) || a;
      const target = group ? groupCapFor(current, { group }) : current;
      if (target) {
        if (win) {
          target.window_caps = {
            "5h": windowCapValue(target, "5h", target.cap_percent),
            weekly: windowCapValue(target, "weekly", target.cap_percent),
            [win]: cap,
          };
        } else {
          target.cap_percent = cap;
          if (target.window_caps) {
            target.window_caps = { ...target.window_caps, "5h": cap, weekly: cap };
          }
        }
      }
      const winLabel = win === "5h" ? "5-hour" : win === "weekly" ? "Weekly" : "";
      const scope = [group, winLabel].filter(Boolean).join(" · ");
      notify("Usage cap updated", "success", `${labelFor(a)}${scope ? ` (${scope})` : ""} will pause at ${cap}%.`);
      render();
      await load();
    } catch (err) {
      notify("Couldn't update usage cap", "error", err.message);
    }
  } else if (b.dataset.weightSet) {
    const id = b.dataset.weightSet,
      rawVal = b.dataset.weightValue,
      weight = rawVal === "" ? null : Number(rawVal),
      a = accountById(id);
    if (!a || (weight !== null && !Number.isFinite(weight))) return;
    await saveAccountWeight(a, weight, b);
  }
});
async function saveAccountWeight(a, weight, control) {
  if (control) control.disabled = true;
  try {
    const r = await api("account/weight", { id: a.id, weight });
    a.weight_override = r.weight;
    a.weight = r.weight ?? a.plan_weight ?? 1;
    notify(
      "Capacity weight updated",
      "success",
      r.weight === null
        ? `${labelFor(a)} reset to auto (${fmtUnits(a.weight)}).`
        : `${labelFor(a)} counted as ${fmtUnits(r.weight)}.`,
    );
    render();
    await load();
  } catch (err) {
    notify("Couldn't update capacity weight", "error", err.message);
  } finally {
    if (control) control.disabled = false;
  }
}
$("#page-body").addEventListener("submit", async (e) => {
  const form = e.target.closest?.("[data-weight-form]");
  if (!form) return;
  e.preventDefault();
  const a = accountById(form.dataset.weightForm),
    input = $("input", form),
    submit = $('button[type="submit"]', form);
  if (!a || !input) return;
  const raw = input.value.trim();
  const weight = raw === "" ? null : Number(raw);
  if (weight !== null && (!Number.isFinite(weight) || weight < 0.05 || weight > 1000)) {
    notify("Invalid capacity weight", "error", "Enter a number between 0.05 and 1000, or leave blank for Auto.");
    return;
  }
  await saveAccountWeight(a, weight, submit);
});
async function setHours(hours) {
  state.hours = hours;
  state.usage.hours = null;
  $$("[data-hours]").forEach((button) => {
    const active = Number(button.dataset.hours) === state.hours;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active);
    button.tabIndex = active ? 0 : -1;
  });
  updateIndicators();
  await load(true);
}
function windowPeriod(p, id) {
  return allWindows(filteredAccounts(p)).find((w) => w.id === id)?.period;
}
// Picking a quota window shows the range that fits it: a 5-hour window shows a
// day, a weekly one the last long range picked (7d or 14d).
// Every explicit pick applies that rule, even re-clicking the active window; only a
// model-group tab whose window has the same period as before keeps the range.
async function pickWindow(p, id, group) {
  const before = windowPeriod(p, selectedWindow(p, filteredAccounts(p)));
  state.windows[p] = id;
  await rangeForWindow(windowPeriod(p, id), group && windowPeriod(p, id) === before);
}
async function rangeForWindow(period, keep) {
  const hours = !period || keep ? state.hours : period <= 86400 ? 24 : state.weekHours;
  render(true);
  if (hours !== state.hours) await setHours(hours);
}
$("#page-body").addEventListener("change", async (e) => {
  if (e.target.dataset.window) {
    await pickWindow(e.target.dataset.window, e.target.value);
  } else if (e.target.id === "forecast") {
    state.forecast = e.target.value === "on";
    render(true);
  } else if (e.target.dataset.planSelect) {
    const a = accountById(e.target.dataset.planSelect);
    if (!a) return;
    const plan = e.target.value || null;
    e.target.disabled = true;
    try {
      const r = await api("account/plan", { id: a.id, plan });
      a.plan_override = r.plan;
      a.plan = r.plan || a.detected_plan || a.plan;
      notify(
        "Plan updated",
        "success",
        r.plan === null
          ? `${labelFor(a)} reset to auto (${planLabel(a.detected_plan || a.plan) || "detected"}).`
          : `${labelFor(a)} set to ${r.plan}.`,
      );
      await load();
    } catch (err) {
      notify("Couldn't update plan", "error", err.message);
      render();
    } finally {
      e.target.disabled = false;
    }
  }
});
function findSeriesNear(series, ts, gap) {
  if (!series?.length) return null;
  let lo = 0,
    hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx >= 0 && ts - series[idx].ts <= gap) {
    if (idx + 1 < series.length && series[idx].ts < ts && series[idx + 1].ts - series[idx].ts > gap)
      return null;
    return series[idx];
  }
  if (lo < series.length && series[lo].ts - ts <= gap) return series[lo];
  return null;
}
function evalPoolHoverAt(entries, minFirstValidTs, ts, windowSec, gap, unitMode) {
  if (minFirstValidTs === null) return null;
  const cutoff = Math.max(ts, minFirstValidTs + gap);
  const active = entries.filter(
    (e) => e.compiled.firstValidTs !== null && e.compiled.firstValidTs <= cutoff,
  );
  if (!active.length) return null;
  let rawSum = 0,
    demandUnits = 0,
    demandUsd = 0,
    activeUsdCap = 0,
    activeWeight = 0,
    validCount = 0;
  const burners = [];
  for (const e of active) {
    activeUsdCap += e.apiUsd;
    activeWeight += e.weight;
    const split = evalCompiledDrainSplit(e.compiled, ts, windowSec, gap, gap);
    if (!split) continue;
    validCount++;
    rawSum += split.total;
    const dUnits = (e.weight * split.total) / 100;
    demandUnits += dUnits;
    demandUsd += (e.apiUsd * split.total) / 100;
    if (split.total > 0.05)
      burners.push({ name: e.name, rate: split.total, demandUnits: dUnits });
  }
  if (!validCount) return null;
  burners.sort((a, b) => b.demandUnits - a.demandUnits || b.rate - a.rate);
  const weightedRate = activeWeight > 0 ? (demandUnits / activeWeight) * 100 : 0;
  const usdPctRate = activeUsdCap > 0 ? (demandUsd / activeUsdCap) * 100 : 0;
  const rate =
    unitMode === "raw"
      ? rawSum
      : unitMode === "usd"
        ? demandUsd
        : unitMode === "usd_pct"
          ? usdPctRate
          : unitMode === "units"
            ? demandUnits
            : weightedRate;
  return { rate, demandUnits, demandUsd, activeUsdCap, weightedRate, activeWeight, burners };
}
function evalPoolRemainingAt(entries, ts, gap, unitMode) {
  const validStarts = entries
    .map((e) => e.compiled.rowTs[0])
    .filter((t) => Number.isFinite(t));
  if (!validStarts.length) return null;
  const minTs = Math.min(...validStarts);
  const cutoff = Math.max(ts, minTs + gap);
  const active = entries.filter(
    (e) => Number.isFinite(e.compiled.rowTs[0]) && e.compiled.rowTs[0] <= cutoff,
  );
  if (!active.length) return null;
  let rawSum = 0,
    units = 0,
    usd = 0,
    usdCap = 0,
    weight = 0,
    freshCount = 0;
  for (const e of active) {
    let rem = evalCompiledRemaining(e.compiled, ts, gap);
    if (Number.isFinite(rem)) {
      freshCount++;
    } else if (
      e.item?.w &&
      Number.isFinite(e.item.a?.quota_at) &&
      Math.abs(ts - e.item.a.quota_at) <= gap
    ) {
      rem = e.item.w.remaining;
      freshCount++;
    } else if (active.length > 1) {
      // Carry forward the last known sample at or before ts for accounts that stopped reporting.
      const { rowTs, rowRem } = e.compiled;
      let lo = 0, hi = rowTs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rowTs[mid] <= ts) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) rem = rowRem[lo - 1];
      else if (e.item?.w && Number.isFinite(e.item.w.remaining) && (!Number.isFinite(e.item.a?.quota_at) || e.item.a.quota_at <= ts))
        rem = e.item.w.remaining;
    }
    if (!Number.isFinite(rem)) return null;
    rawSum += rem;
    units += (e.weight * rem) / 100;
    usd += (e.apiUsd * rem) / 100;
    usdCap += e.apiUsd;
    weight += e.weight;
  }
  if (!freshCount) return null;
  const weightedPct = weight > 0 ? (units / weight) * 100 : 0;
  const usdPct = usdCap > 0 ? (usd / usdCap) * 100 : 0;
  const value =
    unitMode === "raw"
      ? rawSum
      : unitMode === "usd"
        ? usd
        : unitMode === "usd_pct"
          ? usdPct
          : unitMode === "units"
            ? units
            : weightedPct;
  return { value, units, usd, usdCap, weight, weightedPct };
}
function ensureHoverContext(chart) {
  if (chart._hoverCtx) return chart._hoverCtx;
  const meta = chart.meta;
  if (!meta?.items?.length) return null;
  const gap = historyGap();
  const windowSec = state.burn * 3600;
  const namer = makeAccountNamer(meta.items);
  const compileEntry = (item) => ({
    item,
    id: item.a.id,
    provider: item.a.provider,
    name: namer(item.a),
    weight: accountWeight(item.a),
    apiUsd: windowApiUsd(item.a, item.w),
    compiled: compileAccountDrain(
      item.a.id,
      item.metric ?? meta.metric,
      gap,
      windowSec,
      Boolean(item.a.silo),
    ),
  });
  const entries = meta.items.map(compileEntry);
  if (meta.order) {
    const byProv = meta.order
      .map((q) => {
        const pEntries = entries.filter((e) => e.provider === q);
        const starts = pEntries
          .map((e) => e.compiled.firstValidTs)
          .filter((t) => t !== null);
        return {
          q,
          entries: pEntries,
          minFirstValidTs: starts.length ? Math.min(...starts) : null,
        };
      })
      .filter((p) => p.entries.length);
    const validProvStarts = byProv
      .map((p) => p.minFirstValidTs)
      .filter((t) => t !== null);
    chart._hoverCtx = {
      gap,
      windowSec,
      entries,
      byProv,
      minProvTs: validProvStarts.length ? Math.min(...validProvStarts) : null,
    };
  } else {
    const starts = entries
      .map((e) => e.compiled.firstValidTs)
      .filter((t) => t !== null);
    chart._hoverCtx = {
      gap,
      windowSec,
      entries,
      minFirstValidTs: starts.length ? Math.min(...starts) : null,
    };
  }
  return chart._hoverCtx;
}
function chartHoverInfo(chart, point) {
  const meta = chart?.meta;
  const empty = {
    rate: null,
    oursRate: null,
    extRate: null,
    hasExternal: false,
    demandUnits: null,
    weightedRate: null,
    partRates: null,
    remaining: null,
    partRemaining: null,
    units: null,
    weight: meta?.totalWeight ?? null,
    weightedPct: null,
    runwaySec: null,
    exhausted: Boolean(point?.exhausted),
    burners: [],
    activeNames: point?.activeNames || [],
    singleCapPct: meta?.singleCapPct ?? null,
    singleFloor: meta?.singleFloor || 0,
  };
  if (!meta?.items?.length || !point) return empty;
  const unitMode = chart.unitMode || "raw";
  const isFuture = point.projected ?? point.ts > (state.data?.now ?? Infinity);
  const isAll = Boolean(meta.order);
  const isSingle = meta.items.length === 1 && !isAll;

  if (isFuture) {
    const rate = Number.isFinite(point.rate) ? point.rate : null;
    const demandUnits = Number.isFinite(point.demandUnits) ? point.demandUnits : null;
    const weight = Number.isFinite(point.totalWeight) ? point.totalWeight : meta.totalWeight;
    const units = Number.isFinite(point.units)
      ? point.units
      : unitMode === "units"
        ? point.value
        : unitMode === "weighted" && weight > 0
          ? (point.value / 100) * weight
          : null;
    const weightedPct =
      unitMode === "weighted"
        ? point.value
        : !isAll && Number.isFinite(units) && weight > 0
          ? (units / weight) * 100
          : null;
    const weightedRate =
      unitMode === "weighted"
        ? rate
        : !isAll && demandUnits !== null && weight > 0
          ? (demandUnits / weight) * 100
          : null;
    let runwaySec = null;
    if (!isAll && !empty.exhausted) {
      if (isSingle) {
        const usable = Math.max(0, point.value - empty.singleFloor);
        if (rate > 0.01 && usable > 0.05) runwaySec = (usable / rate) * 3600;
      } else if (demandUnits > 1e-6 && Number.isFinite(units) && units > 1e-4) {
        runwaySec = (units / demandUnits) * 3600;
      } else if (rate > 0.01 && point.value > 0.05) {
        runwaySec = (point.value / rate) * 3600;
      }
    }
    return {
      ...empty,
      rate,
      demandUnits,
      weightedRate,
      partRates: point.partRates || null,
      units,
      weight,
      weightedPct,
      runwaySec,
    };
  }

  const ctx = ensureHoverContext(chart);
  if (!ctx) return empty;
  const { gap, windowSec, entries } = ctx;
  const ts = point.ts;

  if (isSingle) {
    const e = entries[0];
    const split = evalCompiledDrainSplit(e.compiled, ts, windowSec, gap, gap);
    const pctRate = split ? split.total : null;
    const rate = chart.rate
      ? point.value
      : pctRate === null
        ? null
        : unitMode === "usd"
          ? (e.apiUsd * pctRate) / 100
          : unitMode === "units"
            ? (e.weight * pctRate) / 100
            : pctRate;
    const oursRate = chart.rate
      ? Number.isFinite(point.parts?.ours) ? point.parts.ours : split?.ours ?? null
      : split?.ours ?? null;
    const extRate = chart.rate
      ? Number.isFinite(point.parts?.external) ? point.parts.external : split?.external ?? null
      : split?.external ?? null;
    const hasExternal = Boolean(extRate !== null && extRate > 1e-6);
    const demandUnits = pctRate !== null ? (e.weight * pctRate) / 100 : null;
    let remPct = chart.rate
      ? evalCompiledRemaining(e.compiled, ts, gap)
      : unitMode === "usd"
        ? e.apiUsd > 0 ? (point.value / e.apiUsd) * 100 : null
        : unitMode === "units"
          ? e.weight > 0 ? (point.value / e.weight) * 100 : null
          : point.value;
    if (
      chart.rate &&
      remPct === null &&
      e.item?.w &&
      Number.isFinite(e.item.a?.quota_at) &&
      Math.abs(ts - e.item.a.quota_at) <= gap
    )
      remPct = e.item.w.remaining;
    const remaining = chart.rate
      ? remPct === null
        ? null
        : unitMode === "usd"
          ? (e.apiUsd * remPct) / 100
          : unitMode === "units"
            ? (e.weight * remPct) / 100
            : remPct
      : point.value;
    const units = Number.isFinite(remPct) ? (e.weight * remPct) / 100 : null;
    const usable = Number.isFinite(remPct) ? Math.max(0, remPct - empty.singleFloor) : null;
    const runwaySec =
      pctRate !== null && pctRate > 0.01 && usable !== null && usable > 0.05
        ? (usable / pctRate) * 3600
        : null;
    return {
      ...empty,
      rate,
      oursRate,
      extRate,
      hasExternal,
      demandUnits,
      weightedRate: pctRate,
      remaining,
      units,
      weight: e.weight,
      weightedPct: remPct,
      runwaySec,
    };
  }

  if (isAll) {
    const partRates = {};
    let rate = chart.rate ? point.value : null;
    let demandUnits = null;
    if (ctx.minProvTs !== null) {
      const cutoff = Math.max(ts, ctx.minProvTs + gap);
      const activeProvs = ctx.byProv.filter(
        (p) => p.minFirstValidTs !== null && p.minFirstValidTs <= cutoff,
      );
      let sumRate = 0,
        sumDemand = 0,
        sumDemandUsd = 0,
        sumCapUsd = 0,
        validProvs = 0;
      const provDemandUsd = {};
      for (const p of activeProvs) {
        const res = evalPoolHoverAt(p.entries, p.minFirstValidTs, ts, windowSec, gap, unitMode);
        if (!res) {
          partRates[p.q] = 0;
          provDemandUsd[p.q] = 0;
          sumCapUsd += p.entries.reduce((s, e) => s + e.apiUsd, 0);
          continue;
        }
        validProvs++;
        partRates[p.q] = res.rate;
        provDemandUsd[p.q] = res.demandUsd;
        sumRate += res.rate;
        sumDemand += res.demandUnits;
        sumDemandUsd += res.demandUsd;
        sumCapUsd += res.activeUsdCap;
      }
      if (validProvs > 0) {
        if (unitMode === "usd_pct") {
          for (const [q, dUsd] of Object.entries(provDemandUsd))
            partRates[q] = sumCapUsd > 0 ? (dUsd / sumCapUsd) * 100 : 0;
          if (!chart.rate) rate = sumCapUsd > 0 ? (sumDemandUsd / sumCapUsd) * 100 : 0;
        } else if (!chart.rate) {
          rate = unitMode === "weighted" ? sumRate / activeProvs.length : sumRate;
        }
        demandUnits = sumDemand;
      } else {
        for (const q of Object.keys(partRates)) delete partRates[q];
      }
    }
    let remaining = chart.rate ? null : point.value;
    let partRemaining = null;
    let units = !chart.rate
      ? Number.isFinite(point.units)
        ? point.units
        : unitMode === "units"
          ? point.value
          : null
      : null;
    let weightedPct = !chart.rate
      ? Number.isFinite(point.weighted)
        ? point.weighted
        : unitMode === "weighted"
          ? point.value
          : null
      : null;
    if (chart.rate) {
      const remPt = findSeriesNear(meta.remainingSeries, ts, gap);
      if (remPt) {
        remaining = remPt.value;
        partRemaining = remPt.partLabels || remPt.parts || null;
        units = Number.isFinite(remPt.units)
          ? remPt.units
          : unitMode === "units"
            ? remPt.value
            : null;
        weightedPct = Number.isFinite(remPt.weighted)
          ? remPt.weighted
          : unitMode === "weighted"
            ? remPt.value
            : null;
      } else {
        const provRems = {};
        const provUsdRems = {};
        let sumVal = 0,
          sumU = 0,
          sumW = 0,
          sumUsd = 0,
          sumUsdCap = 0,
          count = 0;
        for (const p of ctx.byProv) {
          const r = evalPoolRemainingAt(p.entries, ts, gap, unitMode);
          if (!r) continue;
          provRems[p.q] = r.value;
          provUsdRems[p.q] = r.usd;
          sumVal += r.value;
          sumU += r.units;
          sumW += r.weightedPct;
          sumUsd += r.usd;
          sumUsdCap += r.usdCap;
          count++;
        }
        if (count === ctx.byProv.length && count > 0) {
          if (unitMode === "usd_pct") {
            remaining = sumUsdCap > 0 ? (sumUsd / sumUsdCap) * 100 : 0;
            partRemaining = Object.fromEntries(
              Object.entries(provUsdRems).map(([q, u]) => [q, sumUsdCap > 0 ? (u / sumUsdCap) * 100 : 0]),
            );
          } else {
            remaining = unitMode === "weighted" ? sumVal / count : sumVal;
            partRemaining = provRems;
          }
          units = sumU;
          weightedPct = sumW / count;
        }
      }
    }
    return {
      ...empty,
      rate,
      demandUnits,
      partRates: Object.keys(partRates).length ? partRates : null,
      remaining,
      partRemaining,
      units,
      weightedPct,
    };
  }

  // Provider total (multi-account or pooled card).
  const hoverDrain = evalPoolHoverAt(
    entries,
    ctx.minFirstValidTs,
    ts,
    windowSec,
    gap,
    unitMode,
  );
  const rate = chart.rate ? point.value : hoverDrain ? hoverDrain.rate : null;
  const demandUnits = hoverDrain ? hoverDrain.demandUnits : null;
  const weightedRate = hoverDrain ? hoverDrain.weightedRate : null;
  const burners = hoverDrain ? hoverDrain.burners : [];
  let remaining = chart.rate ? null : point.value;
  let weight = Number.isFinite(point.weight) && point.weight > 0
    ? point.weight
    : hoverDrain?.activeWeight || meta.totalWeight;
  let units = !chart.rate
    ? Number.isFinite(point.units)
      ? point.units
      : unitMode === "units"
        ? point.value
        : unitMode === "weighted" && weight > 0
          ? (point.value / 100) * weight
          : null
    : null;
  let weightedPct = !chart.rate
    ? unitMode === "weighted"
      ? point.value
      : Number.isFinite(units) && weight > 0
        ? (units / weight) * 100
        : null
    : null;
  if (chart.rate) {
    const remPt = findSeriesNear(meta.remainingSeries, ts, gap);
    if (remPt) {
      remaining = remPt.value;
      weight = Number.isFinite(remPt.weight) && remPt.weight > 0 ? remPt.weight : weight;
      units = Number.isFinite(remPt.units)
        ? remPt.units
        : unitMode === "units"
          ? remPt.value
          : unitMode === "weighted" && weight > 0
            ? (remPt.value / 100) * weight
            : null;
      weightedPct =
        unitMode === "weighted"
          ? remPt.value
          : Number.isFinite(units) && weight > 0
            ? (units / weight) * 100
            : null;
    } else {
      const evalRem = evalPoolRemainingAt(entries, ts, gap, unitMode);
      if (evalRem) {
        remaining = evalRem.value;
        units = evalRem.units;
        weight = evalRem.weight;
        weightedPct = evalRem.weightedPct;
      }
    }
  }
  let runwaySec = null;
  if (demandUnits !== null && demandUnits > 1e-6 && Number.isFinite(units) && units > 1e-4) {
    runwaySec = (units / demandUnits) * 3600;
  } else if (rate !== null && rate > 0.01 && Number.isFinite(remaining) && remaining > 0.05) {
    runwaySec = (remaining / rate) * 3600;
  }
  return {
    ...empty,
    rate,
    demandUnits,
    weightedRate,
    remaining,
    units,
    weight,
    weightedPct,
    runwaySec,
    burners,
  };
}
function makeColumnFormatter(values, unitMode = "raw", isRate = false) {
  const nums = values.filter(Number.isFinite);
  const suffix = isRate ? "/h" : "";
  if (unitMode === "units") {
    const maxAbs = nums.length ? Math.max(...nums.map(Math.abs)) : 0;
    const anySmall = nums.some(
      (v) => Math.abs(v) > 0 && Math.abs(v) < 10 && Math.abs((v * 10) % 1) > 1e-6,
    );
    const d = maxAbs >= 10 && !anySmall ? 1 : 2;
    return (v) => (Number.isFinite(v) ? `${v.toFixed(d)}x${suffix}` : "—");
  }
  if (unitMode === "usd") {
    const maxAbs = nums.length ? Math.max(...nums.map(Math.abs)) : 0;
    if (maxAbs > 0 && maxAbs < 10)
      return (v) => (Number.isFinite(v) ? `${v.toFixed(2)} CU${suffix}` : "—");
    if (maxAbs >= 10 && maxAbs < 100)
      return (v) => (Number.isFinite(v) ? `${v.toFixed(1)} CU${suffix}` : "—");
    return (v) => (Number.isFinite(v) ? `${fmtApiUsd(v)}${suffix}` : "—");
  }
  const anyTiny = nums.some((v) => v > 0 && v < 0.05);
  const d = anyTiny ? 2 : 1;
  return (v) => (Number.isFinite(v) ? `${v.toFixed(d)}%${suffix}` : "—");
}
function inspectChart(plot, point) {
  const chart = state.charts[plot.dataset.chart],
    isFuture = point.projected ?? point.ts > state.data.now;
  plot.dataset.inspectedAt = point.ts;
  plot.dataset.inspectedProjected = isFuture ? "1" : "";
  const svg = $("svg", plot),
    group = $(".chart-crosshair", plot),
    line = $("line", group),
    halo = $(".halo", group),
    dot = $(".dot", group),
    tooltip = $(".chart-tooltip", plot);
  const px = chart.x(point.ts),
    py = chart.y(point.value),
    entering = group.hasAttribute("hidden"),
    // Exact reset time only: the forecast's sample 0.01s before it still shows the old value.
    hit = chart.resets.findIndex((r) => r.items.some((i) => i.ts === point.ts)),
    reset = chart.resets[hit];
  markReset(svg, hit);
  line.style.stroke = reset ? reset.color : "";
  // Each grouped account's own reset time; the date only when it isn't the header's day.
  const day = (t) => new Date(t * 1000).toDateString(),
    when = (t) =>
      day(t) === day(point.ts)
        ? new Date(t * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
        : dateLabel(t);
  const unitMode = chart.unitMode || "raw";
  const fmt = (v) => (chart.rate ? fmtRateVal(v, unitMode) : fmtChartVal(v, unitMode));
  const info = chartHoverInfo(chart, point);
  const meta = chart.meta;
  const isAll = Boolean(meta?.order);
  const isSingle = Boolean(meta?.items?.length === 1 && !isAll);
  const multiOrWeighted = Boolean(
    meta && (meta.items.length > 1 || Math.abs((meta.totalWeight || 1) - 1) > 1e-6),
  );
  const displayParts = point.partLabels || point.parts;
  const topLabel = isFuture
    ? "Projected"
    : point.partLabels
      ? "Average"
      : point.parts
        ? "Total"
        : chart.rate
          ? `${state.burn}h burn rate`
          : "Recorded";
  const partKeys = displayParts
    ? chart.stackOrder
      ? chart.stackOrder.filter((q) => displayParts[q] !== undefined)
      : byProviderOrder(Object.keys(displayParts))
    : [];
  const subMap = isAll ? (chart.rate ? info.partRemaining : info.partRates) : null;
  const topSubVal = isAll ? (chart.rate ? info.remaining : info.rate) : null;
  const hasSubCol = Boolean(
    isAll &&
      partKeys.length > 0 &&
      (Number.isFinite(topSubVal) || partKeys.some((q) => Number.isFinite(subMap?.[q]))),
  );
  const subColHeader = hasSubCol
    ? chart.rate
      ? "Remaining"
      : isFuture
        ? "Est. drain"
        : `${state.burn}h drain`
    : "";
  let primaryBlockHtml;
  if (partKeys.length > 0) {
    const primaryVals = [point.value, ...partKeys.map((q) => displayParts[q])];
    const fmtCol1 = makeColumnFormatter(primaryVals, unitMode, chart.rate);
    const fmtCol2 = hasSubCol
      ? makeColumnFormatter(
          [topSubVal, ...partKeys.map((q) => subMap?.[q])],
          unitMode,
          !chart.rate,
        )
      : null;
    const headRowHtml = `<div class="tip-row tip-head-row"><span class="tip-name"><i class="tip-swatch${isFuture ? " dashed" : ""}"></i><span>${topLabel}</span></span><strong>${esc(fmtCol1(point.value))}</strong>${hasSubCol ? `<span class="tip-col-sub">${esc(fmtCol2(topSubVal))}</span>` : ""}</div>`;
    const partRowsHtml = partKeys
      .map((q) => {
        const color = chart.stackColors?.[q] || `var(--provider-${q})`;
        const swatch = stackSwatch(color, Boolean(chart.stackHatched?.includes(q)));
        return `<div class="tip-row"><span class="tip-name">${swatch}<span>${esc(chart.stackLabels?.[q] || pName(q))}</span></span><strong>${esc(fmtCol1(displayParts[q]))}</strong>${hasSubCol ? `<span class="tip-col-sub">${esc(fmtCol2(subMap?.[q]))}</span>` : ""}</div>`;
      })
      .join("");
    primaryBlockHtml = `<div class="tip-table${hasSubCol ? " has-sub" : ""}">${headRowHtml}${partRowsHtml}</div>`;
  } else {
    primaryBlockHtml = `<div class="tip-row"><i class="tip-swatch${isFuture ? " dashed" : ""}"></i><span>${topLabel}</span><strong>${esc(fmt(point.value))}</strong></div>`;
  }

  const detailRows = [];
  const pushRow = (label, valHtml, swatch = "") =>
    detailRows.push(
      `<div class="tip-row${detailRows.length === 0 ? " tip-section" : ""}">${swatch}<span>${label}</span>${valHtml}</div>`,
    );

  if (!isSingle) {
    let siloVal = null;
    if (isAll && point.siloParts) {
      const sum = partKeys.reduce(
        (s, q) =>
          s +
          (!chart.stackHatched?.includes(q) && Number.isFinite(point.siloParts[q])
            ? point.siloParts[q]
            : 0),
        0,
      );
      if (sum > 1e-6) siloVal = sum;
    } else if (!isAll && Number.isFinite(point.silo) && point.silo > 1e-6) {
      siloVal = point.silo;
    }
    if (siloVal !== null) {
      pushRow(
        "Idlenet",
        `<strong>${esc(fmt(siloVal))}</strong>`,
        '<i class="tip-swatch hatched"></i>',
      );
    }
  }

  if (!chart.rate) {
    if (info.rate !== null && !hasSubCol) {
      const fmtSplit =
        isSingle && !isFuture && info.hasExternal
          ? makeColumnFormatter([info.rate, info.oursRate, info.extRate], "raw", true)
          : null;
      pushRow(
        isFuture ? "Est. drain" : `${state.burn}h drain`,
        `<strong>${esc(fmtSplit ? fmtSplit(info.rate) : fmtRateVal(info.rate, unitMode))}</strong>`,
      );
      if (fmtSplit) {
        pushRow(
          "Ours",
          `<strong>${esc(fmtSplit(info.oursRate))}</strong>`,
          '<i class="tip-swatch" style="background:var(--foreground)"></i>',
        );
        pushRow(
          "Other users",
          `<strong>${esc(fmtSplit(info.extRate))}</strong>`,
          '<i class="tip-swatch" style="background:#f59e0b"></i>',
        );
      }
    }
    if (unitMode !== "units" && info.demandUnits !== null && multiOrWeighted) {
      pushRow("Demand", `<strong>${esc(fmtRateVal(info.demandUnits, "units"))}</strong>`);
    } else if (unitMode === "units" && info.weightedRate !== null && !isAll) {
      pushRow("Pool rate", `<strong>${esc(fmtRateVal(info.weightedRate, "weighted"))}</strong>`);
    }
    if (isSingle) {
      const singlePct = Number.isFinite(info.weightedPct) ? info.weightedPct : point.value;
      if (info.singleCapPct) {
        const headroom = Math.max(0, singlePct - info.singleFloor);
        pushRow(
          `To ${info.singleCapPct}% cap`,
          headroom <= 0.05
            ? '<strong class="tip-warn">At cap</strong>'
            : `<strong>${esc(fmtPct(headroom))}</strong>`,
        );
      } else {
        pushRow("Used", `<strong>${esc(fmtPct(Math.max(0, 100 - singlePct)))}</strong>`);
      }
    } else if (isAll) {
      if (unitMode !== "units" && Number.isFinite(info.units)) {
        pushRow(
          "Total units",
          `<strong>${esc(fmtUnits(info.units))}${meta.totalWeight ? ` / ${esc(fmtUnits(meta.totalWeight))}` : ""}</strong>`,
        );
      } else if (unitMode === "units" && Number.isFinite(info.weightedPct)) {
        pushRow("Provider avg", `<strong>${esc(fmtPct(info.weightedPct))}</strong>`);
      }
    } else if (multiOrWeighted) {
      if (unitMode !== "units" && Number.isFinite(info.units)) {
        pushRow(
          "Pool units",
          `<strong>${esc(fmtUnits(info.units))} / ${esc(fmtUnits(info.weight || meta.totalWeight))}</strong>`,
        );
      } else if (unitMode === "units" && Number.isFinite(info.weightedPct)) {
        pushRow("Pool average", `<strong>${esc(fmtPct(info.weightedPct))}</strong>`);
      }
    }
    if (isFuture && info.exhausted) {
      pushRow(
        "Status",
        `<strong class="tip-warn">${info.singleCapPct ? `At ${info.singleCapPct}% cap` : "Exhausted"}</strong>`,
      );
    } else if (info.runwaySec !== null) {
      pushRow("Est. runway", `<strong>${esc(fmtDuration(info.runwaySec))}</strong>`);
    }
    if (!isAll && meta?.items?.length > 1) {
      if (!isFuture && info.burners.length) {
        const b0 = info.burners[0];
        const label =
          info.burners.length === 1
            ? `${b0.name} (${fmtPct(b0.rate)}/h)`
            : `${b0.name} +${info.burners.length - 1}`;
        pushRow("Burning", `<strong>${esc(label)}</strong>`);
      } else if (isFuture && info.activeNames.length) {
        const label =
          info.activeNames.length === 1
            ? info.activeNames[0]
            : `${info.activeNames[0]} +${info.activeNames.length - 1}`;
        pushRow("Active", `<strong>${esc(label)}</strong>`);
      }
    }
  } else {
    if (Number.isFinite(info.remaining) && !hasSubCol) {
      pushRow("Remaining", `<strong>${esc(fmtChartVal(info.remaining, unitMode))}</strong>`);
    }
    if (unitMode !== "units" && info.demandUnits !== null && multiOrWeighted) {
      pushRow("Demand", `<strong>${esc(fmtRateVal(info.demandUnits, "units"))}</strong>`);
    } else if (unitMode === "units" && info.weightedRate !== null && !isAll) {
      pushRow("Pool rate", `<strong>${esc(fmtRateVal(info.weightedRate, "weighted"))}</strong>`);
    }
    if (isSingle && info.singleCapPct && Number.isFinite(info.remaining)) {
      const headroom = Math.max(0, info.remaining - info.singleFloor);
      pushRow(
        `To ${info.singleCapPct}% cap`,
        headroom <= 0.05
          ? '<strong class="tip-warn">At cap</strong>'
          : `<strong>${esc(fmtPct(headroom))}</strong>`,
      );
    }
    if (info.runwaySec !== null) {
      pushRow("Est. runway", `<strong>${esc(fmtDuration(info.runwaySec))}</strong>`);
    }
    if (!isAll && meta?.items?.length > 1 && info.burners.length) {
      const b0 = info.burners[0];
      const label =
        info.burners.length === 1
          ? `${b0.name} (${fmtPct(b0.rate)}/h)`
          : `${b0.name} +${info.burners.length - 1}`;
      pushRow("Burning", `<strong>${esc(label)}</strong>`);
    }
  }

  const resetHtml = reset
    ? reset.items
        .map(
          (r, idx) =>
            `<div class="tip-row tip-reset${idx === 0 && detailRows.length ? " tip-section" : ""}">${providerIcon(r.provider)}<span>${esc(r.name)} resets</span><strong>${esc(when(r.ts))}</strong></div>`,
        )
        .join("")
    : "";

  tooltip.innerHTML = `<div class="tip-label"><span>${esc(dateLabel(point.ts))}</span>${subColHeader ? `<span class="tip-label-sub">${esc(subColHeader)}</span>` : ""}</div>${primaryBlockHtml}${detailRows.join("")}${resetHtml}`;
  // Sit beside the point: above it when there is room, flipped left near the edge.
  // Unhide first: a hidden tooltip measures 0px tall, so it would never flip or clamp.
  const width = svg.clientWidth || 0;
  const height = svg.clientHeight || 0;
  if (width > 0) tooltip.style.maxWidth = `${Math.max(160, width - 8)}px`;
  tooltip.hidden = false;
  const ax = (px / chart.W) * width,
    ay = (py / chart.H) * height,
    tw = tooltip.offsetWidth || 0,
    th = tooltip.offsetHeight || 0;
  let left, top;
  if (innerWidth <= 760 && width > 0) {
    // On mobile, float the tooltip cleanly above the chart when there is viewport
    // room so a dragging finger never covers it; otherwise dock opposite the finger.
    const svgTop = svg.getBoundingClientRect ? svg.getBoundingClientRect().top : 0;
    const topbarBottom = $(".topbar")?.getBoundingClientRect?.().bottom || 0;
    const minTop = Math.max(8, topbarBottom + 6);
    if (th > 0 && svgTop - th - 10 >= minTop) {
      top = -(th + 8);
      left = Math.max(0, Math.min(width - tw, ax - tw / 2));
    } else {
      top = 4;
      left = ax < width / 2 ? Math.max(4, width - tw - 4) : 4;
    }
  } else {
    left = ax + 16;
    top = ay - th - 12;
    if (left + tw > width) left = ax - 16 - tw;
    if (width > 0) left = Math.max(4, Math.min(width - tw - 4, left));
    else left = Math.max(0, left);
    if (top < 0) top = ay + 12;
    top = height > 0 ? Math.max(0, Math.min(height - th - 4, top)) : Math.max(0, top);
  }
  // Appear in place (fade only); afterwards glide between positions.
  const moving = [line, halo, dot, tooltip];
  if (entering)
    moving.forEach((el) => (el.style.transitionProperty = "opacity"));
  line.style.transform = `translateX(${px}px)`;
  halo.style.transform =
    dot.style.transform = `translate(${px}px, ${py}px)`;
  tooltip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  group.removeAttribute("hidden");
  tooltip.hidden = false;
  if (entering) {
    group.getBoundingClientRect();
    moving.forEach((el) => (el.style.transitionProperty = ""));
  }
  const inspectParts = [
    dateLabel(point.ts),
    `${fmt(point.value)} ${isFuture ? "projected" : chart.rate ? "drain rate" : "recorded"}`,
  ];
  if (!chart.rate && info.rate !== null) {
    inspectParts.push(`${fmtRateVal(info.rate, unitMode)} drain`);
  } else if (chart.rate && Number.isFinite(info.remaining)) {
    inspectParts.push(`${fmtChartVal(info.remaining, unitMode)} remaining`);
  }
  if (info.runwaySec !== null) {
    inspectParts.push(`~${fmtDuration(info.runwaySec)} runway`);
  } else if (isFuture && info.exhausted) {
    inspectParts.push(info.singleCapPct ? `at ${info.singleCapPct}% cap` : "exhausted");
  }
  if (reset) {
    inspectParts.push(
      `${reset.items.map((r) => r.name).join(", ")} reset${reset.items.length === 1 ? "s" : ""}`,
    );
  }
  $(".chart-inspect", plot).textContent = inspectParts.join(" · ");
}
// Highlight reset marker i (its line takes the provider color); -1 clears.
const markReset = (svg, i) =>
  $$(".chart-reset, .reset-label", svg).forEach((el) =>
    el.classList.toggle("active", Number(el.dataset.reset) === i),
  );
function clearChart(plot) {
  delete plot.dataset.inspectedAt;
  delete plot.dataset.inspectedProjected;
  $(".chart-inspect", plot).textContent = plot.dataset.inspectIdle || "";
  const group = $(".chart-crosshair", plot);
  if (group) group.setAttribute("hidden", "");
  const svg = $("svg", plot);
  if (svg) markReset(svg, -1);
  const tooltip = $(".chart-tooltip", plot);
  if (tooltip) tooltip.hidden = true;
}
// Arrow keys move between the options of a single-choice group and select them.
$("#page-body").addEventListener("keydown", (e) => {
  // Alt+Arrow reorders tabs (handled above) and Ctrl/Meta chords belong to the browser.
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const group = e.target.closest(".provider-tabs, .segmented");
  if (!group || e.target.tagName !== "BUTTON") return;
  // Reorder shares the tab strip but is not one of its choices; in Reorder mode the
  // provider tabs sit inside slots.
  const buttons = $$(":scope > button:not([data-reorder]), :scope > .reorder-slot > button[data-filter]", group),
    i = buttons.indexOf(e.target),
    n = buttons.length;
  const target = {
    ArrowLeft: i - 1,
    ArrowUp: i - 1,
    ArrowRight: i + 1,
    ArrowDown: i + 1,
    Home: 0,
    End: n - 1,
  }[e.key];
  if (target === undefined || i < 0) return;
  e.preventDefault();
  const next = buttons[(target + n) % n];
  next.focus();
  if (!next.classList.contains("active")) next.click();
});
$("#page-body").addEventListener("keydown", (e) => {
  const plot = e.target.closest("[data-chart]");
  if (!plot || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  const chart = state.charts[plot.dataset.chart],
    points = [...chart.points, ...chart.forecast];
  if (!points.length) return;
  const ts = Number(plot.dataset.inspectedAt),
    first = plot.dataset.inspectedAt === undefined,
    projected = plot.dataset.inspectedProjected === "1";
  // The first press lands on the latest recorded point (Left) or the first projected one (Right).
  // At a tie in time (the last recorded point sits at Now, like the first projected one),
  // the point on the inspected side wins, so Right can move on into the projection.
  let n = first
    ? chart.points.length - (e.key === "ArrowLeft" ? 0 : 1)
    : points.reduce((nearest, point, i) => {
        const d = Math.abs(point.ts - ts),
          best = Math.abs(points[nearest].ts - ts);
        return d < best || (d === best && !!point.projected === projected) ? i : nearest;
      }, 0);
  n = Math.min(
    points.length - 1,
    Math.max(0, n + (e.key === "ArrowLeft" ? -1 : 1)),
  );
  inspectChart(plot, points[n]);
});
// Recorded history snaps to the nearest real sample; the projection is
// a drawn line, so the pointer can glide along it.
const nearestPoint = (points, ts) =>
  points.reduce((a, b) => (Math.abs(a.ts - ts) < Math.abs(b.ts - ts) ? a : b));
function seriesAt(chart, ts) {
  const { points, forecast } = chart;
  if (!points.length) return forecast[0] && { ...forecast[0], projected: true };
  const first = (points[0] || forecast[0]).ts,
    last = (forecast.at(-1) || points.at(-1)).ts;
  ts = Math.min(last, Math.max(first, ts));
  if (forecast.length && ts >= forecast[0].ts) {
    const idx = forecast.findIndex((p) => p.ts >= ts);
    if (forecast.length === 1 || idx === 0) return { ...forecast[0], projected: true };
    const i = idx < 0 ? forecast.length - 1 : idx;
    const a = forecast[i - 1],
      b = forecast[i],
      k = (ts - a.ts) / (b.ts - a.ts || 1);
    if (k >= 1 - 1e-9) return { ...b, projected: true };
    if (k <= 1e-9) return { ...a, projected: true };
    const lerpMap = (ma, mb) => {
      if (!ma || !mb) return ma || mb || null;
      const out = {};
      for (const key of Object.keys(ma))
        if (Number.isFinite(ma[key]) && Number.isFinite(mb[key]))
          out[key] = ma[key] + (mb[key] - ma[key]) * k;
      return Object.keys(out).length ? out : null;
    };
    return {
      ts,
      value: a.value + (b.value - a.value) * k,
      projected: true,
      exhausted: Boolean(a.exhausted && b.exhausted),
      units:
        Number.isFinite(a.units) && Number.isFinite(b.units)
          ? a.units + (b.units - a.units) * k
          : undefined,
      totalWeight: a.totalWeight,
      rate: a.rate,
      demandUnits: a.demandUnits,
      partRates: a.partRates,
      activeNames: a.activeNames,
      parts: lerpMap(a.parts, b.parts),
      partLabels: lerpMap(a.partLabels, b.partLabels),
    };
  }
  return { ...nearestPoint(points, ts), projected: false };
}
let scrubFrame = 0,
  scrubTarget = null,
  sawTouchEvent = false;
// Mouse and pen inspect as the pointer moves; touch is handled by the horizontal-drag /
// press-and-hold / tap touch scrubber below (with a pointerup fallback for synthetic touch).
const inspects = (e) =>
  e.pointerType !== "touch" || (!sawTouchEvent && e.type === "pointerup");
const holdTouch = (e, fig) => e.pointerType === "touch" && fig.focus({ preventScroll: true });
const CHARTS = "[data-chart], [data-tok-chart], [data-key-chart]";
const clearAnyChart = (fig) => {
  delete fig.dataset.motionScrubbing;
  fig.matches("[data-chart]") ? clearChart(fig) : fig.matches("[data-tok-chart]") ? clearTokChart(fig) : clearUsage(fig);
};
function inspectChartAtX(fig, clientX, isTouch = false) {
  if (!fig?.isConnected) return;
  const svg = $("svg", fig);
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  if (fig.matches("[data-chart]")) {
    const chart = state.charts[fig.dataset.chart];
    if (!chart || !(chart.points.length || chart.forecast.length)) return;
    const relative = ((clientX - rect.left) / rect.width) * chart.W;
    const snapTol = isTouch ? 12 : 8;
    // Within snapTol px of a reset line, snap onto the closest one.
    const snap = chart.resets
      .filter((r) => Math.abs(r.lineX - relative) <= snapTol)
      .sort((a, b) => Math.abs(a.lineX - relative) - Math.abs(b.lineX - relative))[0];
    const ts = snap
      ? snap.ts
      : chart.start +
        ((relative - chart.left) / (chart.W - chart.left - chart.right)) *
          (chart.end - chart.start);
    inspectChart(fig, seriesAt(chart, ts));
  } else if (fig.matches("[data-tok-chart]")) {
    const ch = tokChartFor(fig);
    if (!ch) return;
    const px = ((clientX - rect.left) / rect.width) * ch.W,
      f = (px - ch.left) / (ch.W - ch.left - ch.right);
    inspectTokChart(fig, ch.bars ? Math.floor(f * ch.n) : Math.round(f * (ch.n - 1)));
  } else if (fig.matches("[data-key-chart]")) {
    const chart = state.keys.chart;
    if (!chart) return;
    const px = ((clientX - rect.left) / rect.width) * chart.W,
      ts = chart.start + ((px - chart.left) / (chart.W - chart.left - chart.right)) * (chart.end - chart.start),
      clamped = Math.min(chart.end - 1, Math.max(chart.start, ts));
    inspectKeyChart(fig, chart.slots.find((s) => clamped >= s.ts && clamped < s.end));
  }
}
function scheduleChartScrub(fig, clientX, isTouch = false) {
  scrubTarget = { fig, clientX, isTouch };
  scrubFrame ||= requestAnimationFrame(() => {
    scrubFrame = 0;
    const t = scrubTarget;
    scrubTarget = null;
    if (t) inspectChartAtX(t.fig, t.clientX, t.isTouch);
  });
}
function inspectPointer(e) {
  const fig = e.target.closest("[data-chart]");
  if (!fig || !inspects(e)) return;
  holdTouch(e, fig);
  scheduleChartScrub(fig, e.clientX, e.pointerType === "touch");
}
$("#page-body").addEventListener("pointermove", inspectPointer);
$("#page-body").addEventListener("pointerdown", inspectPointer);
$("#page-body").addEventListener("pointerup", inspectPointer);
// Mobile touch scrubbing across all charts:
// - Vertical swipe lets the page scroll natively without fighting the chart.
// - Horizontal drag or a brief press-and-hold (160ms) locks scrubbing 1:1 with the finger.
// - Quick tap inspects and pins that sample; lifting keeps the tooltip visible until tap outside.
let touchScrub = null;
const clearTouchScrub = () => {
  if (!touchScrub) return;
  clearTimeout(touchScrub.holdTimer);
  delete touchScrub.fig.dataset.motionScrubbing;
  touchScrub = null;
};
$("#page-body").addEventListener(
  "touchstart",
  (e) => {
    sawTouchEvent = true;
    const fig = e.target.closest?.(CHARTS);
    if (!fig || e.target.closest?.("figcaption")) {
      clearTouchScrub();
      return;
    }
    if (e.touches.length !== 1) {
      clearTouchScrub();
      return;
    }
    clearTouchScrub();
    const t = e.changedTouches[0];
    const session = {
      fig,
      id: t.identifier,
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      mode: "pending",
      holdTimer: 0,
    };
    session.holdTimer = setTimeout(() => {
      if (touchScrub !== session || session.mode !== "pending" || !fig.isConnected) return;
      session.mode = "scrub";
      fig.dataset.motionScrubbing = "";
      try {
        navigator.vibrate?.(8);
      } catch {}
      inspectChartAtX(fig, session.lastX, true);
    }, 160);
    touchScrub = session;
  },
  { passive: true },
);
$("#page-body").addEventListener(
  "touchmove",
  (e) => {
    if (!touchScrub) return;
    if (e.touches.length !== 1) {
      clearTouchScrub();
      return;
    }
    const t = [...e.touches].find((x) => x.identifier === touchScrub.id);
    if (!t) return;
    touchScrub.lastX = t.clientX;
    if (touchScrub.mode === "scroll") return;
    if (touchScrub.mode === "pending") {
      const adx = Math.abs(t.clientX - touchScrub.startX),
        ady = Math.abs(t.clientY - touchScrub.startY);
      if (adx < 6 && ady < 6) return;
      clearTimeout(touchScrub.holdTimer);
      if (ady > adx * 1.15) {
        touchScrub.mode = "scroll";
        return;
      }
      touchScrub.mode = "scrub";
      touchScrub.fig.dataset.motionScrubbing = "";
    }
    if (e.cancelable) e.preventDefault();
    scheduleChartScrub(touchScrub.fig, t.clientX, true);
  },
  { passive: false },
);
$("#page-body").addEventListener(
  "touchend",
  (e) => {
    if (!touchScrub) return;
    const t = [...e.changedTouches].find((x) => x.identifier === touchScrub.id);
    if (!t) return;
    const { fig, mode } = touchScrub;
    const x = t.clientX;
    clearTouchScrub();
    if (mode === "scroll") return;
    cancelAnimationFrame(scrubFrame);
    scrubFrame = 0;
    scrubTarget = null;
    inspectChartAtX(fig, x, true);
    fig.focus({ preventScroll: true });
  },
  { passive: true },
);
$("#page-body").addEventListener(
  "touchcancel",
  () => {
    if (!touchScrub) return;
    const { fig, mode } = touchScrub;
    clearTouchScrub();
    cancelAnimationFrame(scrubFrame);
    scrubFrame = 0;
    scrubTarget = null;
    if (mode === "scroll") {
      clearAnyChart(fig);
      if (document.activeElement === fig) fig.blur();
    }
  },
  { passive: true },
);
// A scroll swipe cancels synthetic touch pointer events: drop any pending or visible inspection.
$("#page-body").addEventListener("pointercancel", (e) => {
  if (sawTouchEvent) return;
  const fig = e.pointerType === "touch" && e.target.closest?.(CHARTS);
  if (!fig) return;
  cancelAnimationFrame(scrubFrame);
  scrubFrame = 0;
  scrubTarget = null;
  clearAnyChart(fig);
  if (document.activeElement === fig) fig.blur();
});
// Tapping outside a pinned chart clears it (a tap on the page need not move focus).
document.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  $$(CHARTS).forEach((fig) => {
    // Only charts that show an inspection: clearing rewrites their aria-live caption.
    if (fig.contains(e.target) || $(".chart-tooltip", fig)?.hidden !== false) return;
    clearAnyChart(fig);
    if (document.activeElement === fig) fig.blur();
  });
});
$("#page-body").addEventListener("pointerout", (e) => {
  if (e.pointerType === "touch") return;
  const plot = e.target.closest("[data-chart]");
  if (plot && !plot.contains(e.relatedTarget)) {
    cancelAnimationFrame(scrubFrame);
    scrubFrame = 0;
    scrubTarget = null;
    clearChart(plot);
  }
});
$("#page-body").addEventListener("focusout", (e) => {
  const plot = e.target.closest("[data-chart]");
  if (plot && !plot.contains(e.relatedTarget)) clearChart(plot);
});
