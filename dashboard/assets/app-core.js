// Shared helpers, state, formatting and account status.
"use strict";
const $ = (s, r = document) => r.querySelector(s),
  $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
const icon = (name, extra = "") =>
  `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
// Every sign-in CLIProxyAPI offers. Quotas are read for QUOTA_PROVIDERS; other
// accounts still appear on the Accounts page.
const PROVIDERS = {
  claude: { name: "Claude", note: "Anthropic account", mark: "claude" },
  codex: { name: "Codex", note: "ChatGPT plan", mark: "codex" },
  antigravity: {
    name: "Antigravity",
    note: "Google account",
    mark: "antigravity",
  },
  xai: { name: "xAI", note: "Grok account", mark: "xai" },
  kimi: { name: "Kimi", note: "kimi.com", mark: "kimi" },
  "kimi-ai": {
    name: "Kimi",
    note: "kimi.ai, international",
    mark: "kimi",
  },
  devin: { name: "Devin", note: "Cognition account", mark: "devin" },
  meta: { name: "Meta", note: "Meta AI account", mark: "meta" },
};
const QUOTA_PROVIDERS = ["codex", "claude", "antigravity", "devin", "xai"];
const pName = (p) => p === "openai-compatible" || p?.startsWith("openai-compatible-")
  ? "OpenAI-compatible" : PROVIDERS[p]?.name || p;
// Providers that have at least one account, in picker order.
// The owner's order (stored on the server); providers not in it append at the end.
const providerRank = (p) => {
  const i = (state.data?.provider_order || []).indexOf(p),
    d = Object.keys(PROVIDERS).indexOf(p);
  return i >= 0 ? i : 1000 + (d >= 0 ? d : 99);
};
const byProviderOrder = (list, key = (x) => x) =>
  [...list].sort((a, b) => providerRank(key(a)) - providerRank(key(b)));
const presentProviders = () =>
  byProviderOrder(Object.keys(PROVIDERS)).filter((p) =>
    (state.data?.accounts || []).some((a) => a.provider === p),
  );
// The providers whose tabs show on this page: Quotas hides providers it doesn't track.
const tabProviders = () =>
  pageFromPath() === "quotas" ? presentProviders().filter((p) => QUOTA_PROVIDERS.includes(p)) : presentProviders();
const providerIcon = (p) =>
  `<span class="provider-icon" aria-hidden="true">${PROVIDERS[p]?.mark ? `<svg><use href="#brand-${PROVIDERS[p].mark}"/></svg>` : icon("key")}</span>`;
// Text that changes in place morphs with Torph (assets/vendor.js).
const morph = (text) => `<span data-morph>${text}</span>`;
const morphs = new WeakMap();
function morphText(el, text) {
  text = String(text);
  if (!window.TextMorph || reducedMotion.matches) {
    morphs.delete(el);
    if (el.textContent !== text) el.textContent = text;
    return;
  }
  let entry = morphs.get(el);
  if (!entry) {
    entry = {
      text: el.textContent,
      morph: new TextMorph({
        element: el,
        duration: 400,
        ease: "cubic-bezier(0.19, 1, 0.22, 1)",
      }),
    };
    morphs.set(el, entry);
    entry.morph.update(entry.text);
  }
  if (entry.text === text) return;
  entry.text = text;
  entry.morph.update(text);
}
const state = {
  data: null,
  allWindow: "5h",
  accountWindow: "5h",
  reorder: false,
  renaming: null,
  renameDraft: "",
  chartOpts: false,
  provider: "all",
  page: "quotas",
  hours: 24,
  // The long range (7d or 14d) a weekly window switches to: the last one picked.
  weekHours: 168,
  burn: 3,
  unit: "usd",
  view: "remaining",
  forecast: true,
  claudeExtra: false,
  windows: {},
  expanded: {},
  wideCards: {},
  wideOrder: [],
  charts: {},
  session: false,
  oauth: null,
  oauthTimer: null,
  oauthMode: "add",
  loadBusy: false,
  keys: {
    list: null,
    options: null,
    base: "",
    error: "",
    open: null,
    usage: null,
    usageError: "",
    unit: "hour",
  },
  machines: { data: null, error: "", timer: 0 },
  tokens: { mode: "tokens", colorBy: "provider", view: "provider", range: 24, buckets: null, names: {}, error: "", html: "", chart: null },
  usage: { view: "projects", hours: null, data: null, key: "", error: "", loading: false, fetchedAt: 0, expanded: {}, showAll: false, html: "" },
  logs: {
    tab: "errors",
    files: null,
    error: "",
    open: null,
    text: null,
    truncated: false,
    activity: {
      enabled: null,
      lines: [],
      cursor: null,
      paused: false,
      error: "",
    },
    timer: 0,
  },
};
let refreshTimer;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const motionAllowed = () => !reducedMotion.matches;
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches)
    document.getAnimations().forEach((animation) => animation.cancel());
});
const entrances = new WeakMap();
function enter(element, distance = 0) {
  if (!element || !motionAllowed()) return;
  const prior = entrances.get(element);
  // Retarget from the current frame if another action interrupts this one.
  const from =
    prior && prior.playState === "running"
      ? {
          opacity: getComputedStyle(element).opacity,
          transform: getComputedStyle(element).transform,
        }
      : { opacity: 0.5, transform: `translateY(${distance}px)` };
  prior?.cancel();
  entrances.set(
    element,
    element.animate([from, { opacity: 1, transform: "translateY(0)" }], {
      duration: 180,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    }),
  );
}

// Keep live controls in place: polling must not dismiss a native select,
// lose keyboard focus, reset chart inspection, or collapse a disclosure.
function nodeKey(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  for (const attr of [
    "id",
    "data-pool",
    "data-account",
    "data-chart",
    "data-filter",
    "data-acct-win",
    "data-view",
    "data-burn",
    "data-unit",
    "data-hours",
    "data-claude-extra",
    "data-window-group",
    "data-window-id",
    "data-pause",
    "data-weight-set",
    "data-weight-form",
    "data-plan-select",
    "data-key",
    "data-key-unit",
    "data-expand-card",
    "data-ub-project",
    "data-ub-thread",
    "data-ub-toggle",
    "data-ub-view",
    "data-ub-hours",
  ])
    if (node.hasAttribute(attr))
      return `${attr}:${node.getAttribute(attr)}`;
  if (node.classList.contains("segmented"))
    return `segmented:${node.getAttribute("aria-label")}`;
  return node.getAttribute("class")?.split(/\s/)[0] || "";
}
function patchChildren(parent, next) {
  const unused = [...parent.childNodes];
  const pairs = [...next.childNodes].map((fresh) => {
    const key = nodeKey(fresh);
    const current = unused.find(
      (node) =>
        node.nodeType === fresh.nodeType &&
        node.nodeName === fresh.nodeName &&
        nodeKey(node) === key,
    );
    if (current) unused.splice(unused.indexOf(current), 1);
    return { fresh, current };
  });
  // Remove obsolete siblings before ordering: moving an otherwise stable
  // focused control around a stale sibling would unnecessarily blur it.
  unused.forEach((node) => node.remove());
  let cursor = parent.firstChild;
  for (const { fresh, current } of pairs) {
    if (!current) {
      parent.insertBefore(fresh.cloneNode(true), cursor);
      continue;
    }
    if (current !== cursor) {
      if (parent.moveBefore) parent.moveBefore(current, cursor);
      else {
        const focused = document.activeElement;
        parent.insertBefore(current, cursor);
        if (current.contains(focused))
          focused.focus({ preventScroll: true });
      }
    }
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue !== fresh.nodeValue)
        current.nodeValue = fresh.nodeValue;
    } else if (
      current.nodeType === Node.ELEMENT_NODE &&
      !current.hasAttribute("data-live")
    ) {
      const inspected = current.closest("[data-chart]");
      if (
        !inspected ||
        !current.matches(
          ".chart-crosshair, .chart-tooltip, .chart-inspect",
        ) ||
        $(".chart-tooltip", inspected)?.hidden
      ) {
        const local = (name) =>
          name.startsWith("data-motion-") ||
          (name === "style" &&
            current.hasAttribute("data-motion-indicator")) ||
          (name === "open" && current.tagName === "DETAILS") ||
          ((name === "data-inspected-at" ||
            name === "data-inspected-projected") &&
            current.hasAttribute("data-chart"));
        const morphing = current.hasAttribute("data-morph");
        for (const attr of [...current.attributes])
          if (
            !morphing &&
            !local(attr.name) &&
            !fresh.hasAttribute(attr.name)
          )
            current.removeAttribute(attr.name);
        for (const attr of [...fresh.attributes])
          if (
            !local(attr.name) &&
            current.getAttribute(attr.name) !== attr.value
          )
            current.setAttribute(attr.name, attr.value);
        if (morphing) morphText(current, fresh.textContent);
        else patchChildren(current, fresh);
      }
    }
    cursor = current.nextSibling;
  }
}
function updateIndicators() {
  $$(".provider-tabs, .segmented, .sidebar-group").forEach((group) => {
    const active = $(".active", group);
    // A hidden group (e.g. before sign-in) measures as 0×0, which would clip
    // the indicator to the whole group; measure once it is laid out.
    if (!active || !group.offsetWidth) return;
    const x = active.offsetLeft,
      y = active.offsetTop,
      radius = parseFloat(getComputedStyle(active).borderRadius) || 0;
    group.style.setProperty(
      "--indicator-clip",
      `inset(${y}px ${group.clientWidth - x - active.offsetWidth}px ${group.clientHeight - y - active.offsetHeight}px ${x}px round ${radius}px)`,
    );
    if (!group.hasAttribute("data-motion-indicator")) {
      group.dataset.motionIndicator = "initial";
      requestAnimationFrame(() => {
        if (group.isConnected) group.dataset.motionIndicator = "ready";
      });
    }
  });
}
document.fonts.ready.then(updateIndicators);
let renderedPage, renderedSelection;
async function api(path, body) {
  const res = await fetch(
    new URL("/dashboard/api/" + path, location.origin),
    {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-Dashboard-Request": "1",
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  let data;
  try {
    data = await res.json();
  } catch {
    throw Error(
      "The dashboard returned an unexpected response. Reload and try again.",
    );
  }
  if (!res.ok) {
    if (res.status === 401 && state.session) {
      state.session = false;
      showLogin();
    }
    throw Error(data.error || "Request failed. Try again.");
  }
  return data;
}
function showLogin() {
  clearTimeout(refreshTimer);
  document.title = "Silo";
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#management-key").focus();
}
function showApp() {
  state.session = true;
  $("#login").hidden = true;
  $("#app").hidden = false;
  load();
}
function fmtPct(n) {
  if (!Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.1) return `${n.toFixed(2)}%`;
  return `${n.toFixed(n % 1 ? 1 : 0)}%`;
}
function fmtUnits(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 10 ? 1 : abs > 0 ? 2 : 0;
  return `${Number(n.toFixed(d))}x`;
}
function fmtApiUsd(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs === 0) return "0 CU";
  if (abs < 0.01) return "<0.01 CU";
  if (abs < 10) return `${n.toFixed(2)} CU`;
  if (abs < 100) return `${Number(n.toFixed(1))} CU`;
  if (abs < 10000) return `${Math.round(n).toLocaleString("en-US")} CU`;
  return `${Number((n / 1000).toFixed(1))}k CU`;
}
function fmtChartVal(n, unitMode = "raw") {
  if (unitMode === "usd") return fmtApiUsd(n);
  return unitMode === "units" ? fmtUnits(n) : fmtPct(n);
}
function fmtRateVal(n, unitMode = "raw") {
  return Number.isFinite(n) ? `${fmtChartVal(n, unitMode)}/h` : "—";
}
function niceRateMax(peak, unitMode = "raw") {
  if (!Number.isFinite(peak) || peak <= 0) return unitMode === "units" ? 1 : 10;
  const target = peak * 1.12;
  const exp = Math.floor(Math.log10(target));
  const mag = 10 ** exp;
  const steps =
    exp >= 1
      ? [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
      : exp === 0
        ? [1, 2, 3, 4, 5, 6, 8, 10]
        : [1, 2, 4, 6, 8, 10];
  const step = steps.find((m) => m * mag >= target - 1e-12) || 10;
  return Number((step * mag).toPrecision(6));
}
function accountWeight(a) {
  const w = Number(a?.weight);
  return Number.isFinite(w) && w > 0 ? w : 1;
}
function windowApiUsd(a, w) {
  const v = Number(w?.api_usd);
  if (Number.isFinite(v) && v > 0) return v;
  return accountWeight(a) * 25;
}
function windowCalibrationNote(p, items) {
  const w = items[0]?.w;
  if (!w) return "";
  const period = Number(w.period);
  const pk =
    Math.abs(period - 5 * 3600) <= 600
      ? "5h"
      : Math.abs(period - 86400) <= 3600
        ? "24h"
        : Math.abs(period - 7 * 86400) <= 7200
          ? "7d"
          : Math.abs(period - 30 * 86400) <= 3 * 86400
            ? "30d"
            : null;
  const pCal = state.data?.api_calibration?.[p];
  const agyGroup = p === "antigravity"
    ? (/gemini/i.test(`${w.group || ""} ${w.id || ""}`) ? "gemini" : "3p")
    : null;
  const gCal = pk && agyGroup ? pCal?.[`${pk}:${agyGroup}`] : null;
  const cal = (gCal && gCal.obs_1x_drop > 0 ? gCal : null) || (pk && pCal?.[pk]);
  if (!cal) return "";
  if (cal.source === "calibrated")
    return `Calibrated from ${cal.obs_hours}h of hub usage · ~${fmtApiUsd(cal.usd_per_1x)} per 1x (1 CU ≈ $1 API compute)`;
  if (cal.source === "blended")
    return `Blended estimate (${cal.obs_hours}h observed${cal.prior_source === "mypriors" ? " + mypriors.com" : ""}) · ~${fmtApiUsd(cal.usd_per_1x)} per 1x (1 CU ≈ $1 API compute)`;
  const priorLabel = cal.prior_source === "mypriors" ? "mypriors.com prior" : "Prior estimate";
  return `${priorLabel} · ~${fmtApiUsd(cal.usd_per_1x)} per 1x (calibrates automatically as you use hub accounts)`;
}
function relative(ts) {
  if (!ts) return "Unknown";
  let s = Math.max(0, ts - Date.now() / 1000);
  if (s < 60) return "Less than a minute";
  let m = Math.ceil(s / 60);
  if (m < 60) return `in ${m}m`;
  let h = Math.floor(m / 60);
  return h < 24
    ? `in ${h}h ${m % 60}m`
    : `in ${Math.floor(h / 24)}d ${h % 24}h`;
}
function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return "<1m";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
function dateLabel(ts, withTime = true) {
  if (!ts) return "Unknown";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}
function age(ts) {
  if (!ts) return "Not checked";
  const n = Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60));
  if (n === 0) return "just now";
  if (n < 60) return `${n}m ago`;
  if (n < 1440) return `${Math.floor(n / 60)}h ago`;
  return `${Math.floor(n / 1440)}d ago`;
}
function accountLabel(a, i) {
  return a.nickname || a.email || (a.silo && a.name) || `${pName(a.provider)} account ${i + 1}`;
}
const cycloneIcon = () =>
  `<svg class="cyclone-icon" aria-hidden="true"><use href="#mark-cyclone"/></svg>`;
function cyclonePoolText(a) {
  const nodes = a.nodes || [];
  if (a.active_node) return `${a.active_node}${nodes.length > 1 ? ` (+${nodes.length - 1})` : ""}`;
  return nodes.join(", ");
}
function cycloneBadge(a) {
  if (!a?.silo) return "";
  const tip = [
    a.nodes?.length ? `Cyclone pool: ${a.nodes.join(", ")}` : "Routed via Cyclone laptops",
    a.active_node ? `Active: ${a.active_node}` : "",
    capSummaryText(a),
  ].filter(Boolean).join(" · ");
  return `<span class="cyclone-badge" title="${esc(tip)}" aria-label="${esc(tip)}">${cycloneIcon()}</span>`;
}
function strategyLabel(strategy) {
  return {
    "fill-first": "Fill-first",
    "soonest-reset": "Soonest reset",
    "round-robin": "Round-robin",
    "weighted-round-robin": "Weighted round-robin",
  }[strategy] || strategy || "";
}
function activityAge(ts, now = state.data?.now || Date.now() / 1000) {
  if (!ts) return "";
  const s = Math.max(0, Math.round(now - ts));
  if (s < 15) return "just now";
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function useBadge(a, compact = false) {
  if (!a) return "";
  if (a.in_use) {
    const live = a.in_flight > 0;
    const tip = live
      ? `In use now (${a.in_flight} active request${a.in_flight === 1 ? "" : "s"})`
      : `In use · last request ${activityAge(a.last_used_at)}`;
    const label = a.in_flight > 1 ? `In use (${a.in_flight})` : "In use";
    if (compact)
      return `<span class="use-badge live" data-use-indicator="in-use" title="${esc(tip)}" aria-label="${esc(tip)}"><i class="live-dot" aria-hidden="true"></i><span class="use-text">${esc(label)}</span></span>`;
    return `<span class="tag in-use" data-use-indicator="in-use" title="${esc(tip)}"><i class="live-dot" aria-hidden="true"></i>${esc(label)}</span>`;
  }
  if (a.next_up) {
    const strat = strategyLabel(state.data?.routing_strategy);
    const tip = `Next account selected${strat ? ` (${strat})` : ""}`;
    if (compact)
      return `<span class="use-badge next" data-use-indicator="next-up" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="use-text">Next</span></span>`;
    return `<span class="tag outline next-up" data-use-indicator="next-up" title="${esc(tip)}">Next up</span>`;
  }
  return "";
}
// The email stays visible as secondary text once an account has a nickname.
const secondary = (a) => (a.nickname && (a.email || (a.silo && a.name && a.nickname.toLowerCase() !== a.name.toLowerCase())) ? (a.email || a.name) : "");
// Sub-line parts without empties or case-insensitive repeats ("xai" and "xAI"); the last spelling wins, so the provider name does.
const subLine = (parts) =>
  parts.filter((v, n) => v && parts.findLastIndex((o) => o && o.toLowerCase() === v.toLowerCase()) === n).join(" · ");
const nickOf = (id) =>
  state.data?.accounts.find((a) => a.id === id || a.name === id)?.nickname || "";
// Single-choice groups use a roving tab stop: only the active button is tabbable.
const choice = (active) =>
  `class="${active ? "active" : ""}" aria-pressed="${active}" tabindex="${active ? 0 : -1}"`;
function capWindowKey(w) {
  if (!w) return null;
  const p = Number(w.period);
  if (Number.isFinite(p) && p > 0) {
    if (Math.abs(p - 5 * 3600) <= 600) return "5h";
    if (Math.abs(p - 7 * 86400) <= 7200) return "weekly";
  }
  const id = String(w.id || "").trim().toLowerCase();
  const lbl = String(w.label || "").trim().toLowerCase();
  if (id === "five_hour" || /[:_-]5h$/.test(id) || lbl.includes("5-hour") || lbl.includes("5h")) return "5h";
  if (
    id === "seven_day" ||
    id === "iguana_necktie" ||
    id.startsWith("seven_day_") ||
    id.startsWith("weekly_scoped:") ||
    /[:_-](7d|weekly)$/.test(id) ||
    lbl.includes("weekly") ||
    lbl.includes("7-day")
  )
    return "weekly";
  return null;
}
const groupCapsOf = (a) =>
  Array.isArray(a?.group_caps) && a.group_caps.length > 1 ? a.group_caps : [];
const groupCapFor = (a, w) =>
  w?.group ? a.group_caps?.find((g) => g.group === w.group) : undefined;
function windowCapValue(target, win, fallback = null) {
  const v = target?.window_caps?.[win];
  if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v);
  const base = target?.cap_percent;
  if (base !== null && base !== undefined && Number.isFinite(Number(base))) return Number(base);
  return fallback;
}
function capPercentFor(a, w) {
  const wkey = capWindowKey(w);
  const gc = groupCapFor(a, w);
  if (gc) return wkey ? windowCapValue(gc, wkey, gc.cap_percent) : gc.cap_percent;
  return wkey ? windowCapValue(a, wkey, a?.cap_percent) : a?.cap_percent;
}
function windowIsOverCap(a, w) {
  if (!a?.silo || !w || !Number.isFinite(w.remaining)) return false;
  const cap = Number(capPercentFor(a, w));
  return Number.isFinite(cap) && cap > 0 && 100 - w.remaining >= cap - 1e-6;
}
function windowIsCapped(a, w) {
  if (!a?.silo || !w) return false;
  const gc = groupCapFor(a, w);
  if (gc) {
    if (!gc.capped) return false;
    if (windowIsOverCap(a, w)) return true;
    const peers = (a.windows || []).filter((x) => x.group === w.group);
    return !peers.some((x) => windowIsOverCap(a, x));
  }
  if (!a.capped || a.cap_label === "Silo: quota unreadable") return false;
  if (windowIsOverCap(a, w)) return true;
  return !(a.windows || []).some((x) => windowIsOverCap(a, x));
}
const cappedGroupsOf = (a) => (a?.group_caps || []).filter((g) => g.capped);
function capSummaryText(a) {
  const groups = groupCapsOf(a);
  if (!groups.length) {
    const c5 = windowCapValue(a, "5h", null),
      cw = windowCapValue(a, "weekly", null);
    if (c5 && cw && c5 !== cw) return `Cap 5h ${c5}% · Wk ${cw}%`;
    const single = c5 ?? cw ?? a.cap_percent;
    return single ? `Cap ${single}%` : "";
  }
  const parsed = groups.map((g) => {
    const c5 = windowCapValue(g, "5h", null),
      cw = windowCapValue(g, "weekly", null);
    const split = Boolean(c5 && cw && c5 !== cw);
    const single = split ? null : (c5 ?? cw ?? g.cap_percent);
    return {
      group: g.group,
      split,
      single,
      text: split ? `${g.group} 5h ${c5}%/Wk ${cw}%` : `${g.group} ${single}%`,
    };
  });
  const first = parsed[0].single;
  if (!parsed.some((p) => p.split) && parsed.every((p) => p.single === first))
    return `Cap ${first}%`;
  return parsed.map((p) => p.text).join(" · ");
}
function capTimeLabel(item) {
  if (!item) return "Capped";
  if (item.cap_label === "Silo: quota unreadable") return "Capped";
  if (Number.isFinite(item.capped_until) && item.capped_until > 0)
    return `Capped until ${dateLabel(item.capped_until)}`;
  if (item.cap_label) return item.cap_label.replace(/^Capped by Silo\b/, "Capped");
  return "Capped";
}
function capReasonFor(item, a = null) {
  if (!item) return "";
  if (item.cap_reason) return item.cap_reason;
  if (item.cap_label === "Silo: quota unreadable") {
    const err = a?.quota_error ? String(a.quota_error).replace(/\.+$/, "") : "";
    return err ? `Quota unreadable (${err})` : "Quota unreadable";
  }
  const capPct = Number(item.cap_percent);
  const src = a || item;
  const wins = Array.isArray(src?.windows) ? src.windows : [];
  const filtered = item.group ? wins.filter((w) => w.group === item.group) : wins;
  const numericWins = filtered.filter((w) => Number.isFinite(w.remaining));
  const winCap = (w) => {
    const wk = capWindowKey(w);
    const v = wk ? item?.window_caps?.[wk] : undefined;
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v);
    return Number.isFinite(capPct) && capPct > 0 ? capPct : NaN;
  };
  if (numericWins.length) {
    const hit = numericWins
      .map((w) => ({ w, used: 100 - w.remaining, cap: winCap(w) }))
      .filter((x) => Number.isFinite(x.cap) && x.cap > 0 && x.used >= x.cap - 1e-6)
      .sort((x, y) => y.used - x.used);
    if (hit.length) {
      const capKeys = new Set(hit.map((x) => Math.round(x.cap * 1000)));
      const labelPart = (w, used) => {
        const name = item.group && w.label?.startsWith(`${item.group} · `)
          ? w.label.slice(item.group.length + 3)
          : (w.label || w.id);
        const usedText = fmtPct(used);
        return item.group && name.toLowerCase() === item.group.toLowerCase()
          ? `${usedText} used`
          : `${name} at ${usedText}`;
      };
      if (capKeys.size === 1)
        return `${hit.map((x) => labelPart(x.w, x.used)).join(", ")} (${fmtPct(hit[0].cap)} cap)`;
      return hit.map((x) => `${labelPart(x.w, x.used)} (${fmtPct(x.cap)} cap)`).join(", ");
    }
    if (item.capped) {
      return Number.isFinite(capPct) && capPct > 0 && !item.window_caps
        ? `Reached ${fmtPct(capPct)} cap`
        : "Waiting for reset confirmation";
    }
    return "";
  }
  if (Number.isFinite(capPct) && capPct > 0) {
    if (Number.isFinite(item.usage_percent) && item.usage_percent >= capPct - 1e-6)
      return `Usage at ${fmtPct(item.usage_percent)} (${fmtPct(capPct)} cap)`;
    if (item.capped) return `Reached ${fmtPct(capPct)} cap`;
  }
  return "";
}
function capStatusText(item, a = null) {
  const head = capTimeLabel(item);
  const reason = capReasonFor(item, a);
  return reason ? `${head} · ${reason}` : head;
}
const cappedGroupReasons = (groups, a = null) => groups.map((g) =>
  `${g.group}: ${capStatusText(g, a)}`).join(" · ");
function status(a) {
  if (a.silo && a.capped) return ["Capped", "warning"];
  if (a.disabled) return ["Paused", ""];
  if (a.requires_sign_in) return ["Sign-in needed", "bad"];
  if (a.silo && cappedGroupsOf(a).length) return ["Partial cap", "warning"];
  return routingStatus(a);
}
function routingStatus(a) {
  if (a.cooldowns.some((c) => c.reason === "model_not_supported"))
    return ["Model restriction", "warning"];
  if (a.silo && a.unavailable) return ["No idle laptop", "warning"];
  if (a.unavailable)
    return [a.cooldowns.length ? "Cooling down" : "Unavailable", "warning"];
  if (a.quota_error) return ["Quota unavailable", "warning"];
  return ["Ready", "good"];
}
function statusReason(a, w = null) {
  if (a.disabled && !a.capped) return "Excluded from account selection.";
  const gc = a.silo ? groupCapFor(a, w) : null;
  if (gc?.capped) return capStatusText(gc, a);
  if (a.silo && a.capped) return capStatusText(a, a);
  if (a.requires_sign_in) return "Sign in again to reconnect this account.";
  const capped = a.silo && !gc ? cappedGroupsOf(a) : [];
  if (capped.length) return cappedGroupReasons(capped, a);
  if (a.silo && a.unavailable) return "All candidate laptops are currently offline or in use.";
  const unsupported = a.cooldowns.filter(
    (c) => c.reason === "model_not_supported",
  );
  if (unsupported.length)
    return `This plan cannot use ${unsupported.map((c) => c.model_key).join(", ")}.`;
  if (a.quota_error) return a.quota_error;
  if (a.unavailable && a.cooldowns.some((c) => ["quota", "credential_quota"].includes(c.reason))) {
    const now = state.data.now;
    const exhausted = a.windows.filter((w) => w.remaining === 0 &&
      now - a.quota_at <= 900 && (!w.reset_at || w.reset_at > now));
    if (exhausted.length)
      return exhausted.map((w) => (exhausted.length > 1 ? w.label.replace(/ limit$/i, "") : w.label)).join(", ") + " exhausted.";
  }
  if (a.unavailable)
    return a.cooldowns.length
      ? "The proxy will retry eligible requests after cooldown."
      : "The proxy reports this account is unavailable.";
  return "The proxy selects this account automatically.";
}
