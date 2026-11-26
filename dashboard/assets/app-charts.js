// Quota windows, history, drain math, chart drawing and the quota and account pages.
"use strict";
function compareAccountLabels(a, b) {
  const na = String(a.nickname || "").trim();
  const nb = String(b.nickname || "").trim();
  if (Boolean(na) !== Boolean(nb)) return na ? -1 : 1;
  const la = na || String(a.email || a.name || "").trim();
  const lb = nb || String(b.email || b.name || "").trim();
  return la.localeCompare(lb, undefined, { numeric: true, sensitivity: "base" }) ||
    String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""), undefined, { numeric: true, sensitivity: "base" });
}
function filteredAccounts(provider = state.provider) {
  const list = (state.data?.accounts || []).filter(
    (a) => provider === "all" || a.provider === provider,
  );
  const index = new Map(list.map((a, i) => [a, i]));
  return [...list].sort((a, b) => {
    if (Boolean(a.silo) !== Boolean(b.silo)) return a.silo ? 1 : -1;
    if (a.silo) return index.get(a) - index.get(b);
    if (provider === "all" && a.provider !== b.provider) {
      return providerRank(a.provider) - providerRank(b.provider);
    }
    return compareAccountLabels(a, b);
  });
}
function tabs(only) {
  const shown = presentProviders().filter((p) => !only || only.includes(p));
  // A saved provider this tab strip doesn't show reads as All here; the saved choice stays for other pages.
  const active = only && !only.includes(state.provider) ? "all" : state.provider;
  return `<div class="provider-tabs icon-tabs" role="group" aria-label="Filter provider">${[
    ["all", "All"],
    ...shown.map((p) => [p, pName(p)]),
  ]
    .map(([p, n]) => {
      const tab = `<button data-filter="${p}" ${p !== "all" ? `draggable="true" data-provider-tab="${p}" title="Drag, or Alt+arrow keys, to reorder"` : ""} ${choice(active === p)} aria-label="${esc(n)}">${p === "all" ? icon("all") : providerIcon(p)}<span class="tab-name">${n}</span><span class="count">${morph((p === "all" && only ? shown.flatMap((q) => filteredAccounts(q)) : filteredAccounts(p)).length)}</span></button>`;
      return p !== "all" && state.reorder
        ? `<span class="reorder-slot">${tab}<button class="ghost icon-btn sm" data-move="${p}:-1" aria-label="Move ${esc(pName(p))} earlier"${p === shown[0] ? " disabled" : ""}>◀</button><button class="ghost icon-btn sm" data-move="${p}:1"${p === shown.at(-1) ? " disabled" : ""} aria-label="Move ${esc(pName(p))} later">▶</button></span>`
        : tab;
    })
    .join("")}${shown.length > 1 ? `<button class="ghost sm reorder-toggle" data-reorder aria-pressed="${state.reorder}">${state.reorder ? "Done" : "Reorder"}</button>` : ""}</div>`;
}
function allWindows(accounts) {
  const map = new Map();
  accounts.forEach((a) =>
    a.windows.forEach((w) => {
      if (!map.has(w.id)) map.set(w.id, { ...w });
    }),
  );
  // Shortest window first within each group, whichever account listed it first.
  const groups = [...new Set([...map.values()].map((w) => w.group))];
  return [...map.values()].sort(
    (a, b) =>
      groups.indexOf(a.group) - groups.indexOf(b.group) ||
      (a.period ?? Infinity) - (b.period ?? Infinity),
  );
}
// A few quota windows read best as tabs; a long list keeps a select.
const MAX_WINDOW_TABS = 4;
const windowName = (w) =>
  (w.group ? w.label.replace(`${w.group} · `, "") : w.label).replace(
    / limit$/i,
    "",
  );
function windowTabs(p, label, list, active, className = "") {
  return `<div class="segmented sm pool-windows ${className}" role="group" aria-label="${esc(label)}">${list.map((o) => `<button data-window="${p}" ${o.group ? `data-window-group="${esc(o.group)}"` : ""} data-window-id="${esc(o.id)}" title="${esc(o.title)}" ${choice(o.id === active)}>${esc(o.text)}</button>`).join("")}</div>`;
}
// Grouped windows (Antigravity: models share a 5-hour and a weekly limit per
// group) get one tab set for the group and one for the window inside it.
function windowPicker(p, list, metric) {
  if (list.length < 2)
    return `<span class="pool-window">${esc(list[0]?.label || "Quota unavailable")}</span>`;
  const current = list.find((w) => w.id === metric) || list[0],
    groups = [...new Set(list.map((w) => w.group).filter(Boolean))];
  if (groups.length > 1 && groups.length <= MAX_WINDOW_TABS) {
    const inGroup = list.filter((w) => w.group === current.group);
    return `<div class="pool-pickers">${windowTabs(
      p,
      `Model group for ${pName(p)}`,
      groups.map((g) => {
        const options = list.filter((w) => w.group === g),
          match =
            options.find((w) => windowName(w) === windowName(current)) ||
            options[0];
        return { id: match.id, group: g, text: g, title: g };
      }),
      list.find(
        (w) =>
          w.group === current.group &&
          windowName(w) === windowName(current),
      ).id,
    )}${
      inGroup.length > 1
        ? windowTabs(
            p,
            `Quota window for ${pName(p)}`,
            inGroup.map((w) => ({
              id: w.id,
              text: windowName(w),
              title: w.label,
            })),
            current.id,
          )
        : ""
    }</div>`;
  }
  if (list.length <= MAX_WINDOW_TABS)
    return windowTabs(
      p,
      `Quota window for ${pName(p)}`,
      list.map((w) => ({ id: w.id, text: windowName(w), title: w.label })),
      current.id,
    );
  return `<label class="sr-only" for="window-${p}">Quota window for ${pName(p)}</label><select id="window-${p}" class="sm" data-window="${p}">${list.map((w) => `<option value="${esc(w.id)}" ${metric === w.id ? "selected" : ""}>${esc(w.label)}</option>`).join("")}</select>`;
}
function selectedWindow(p, accounts) {
  const list = allWindows(accounts);
  if (!list.some((w) => w.id === state.windows[p]))
    state.windows[p] =
      p === "codex"
        ? list.find((w) => w.id === "rate_limit:5h")?.id || list[0]?.id
        : p === "claude"
          ? list.find((w) => w.id === "five_hour")?.id || list[0]?.id
          : p === "devin"
            ? list.find((w) => w.id === "daily")?.id || list[0]?.id
            : p === "xai"
              ? list.find((w) => w.id === "credits")?.id || list[0]?.id
              : list.find(
                  (w) => /gemini/i.test(w.group) && w.period === 5 * 3600,
                )?.id || list[0]?.id;
  return state.windows[p];
}
function accountWindow(a, metric) {
  const w = a.windows.find((w) => w.id === metric);
  return w ? [{ a, w }] : [];
}
// Longest pause between samples still treated as continuous (~2.5 history buckets, as
// longer ranges arrive downsampled). The server sends it; older servers only send the bucket.
const historyGap = () =>
  state.data?.history_gap ?? Math.max(900, 2.5 * (state.data?.history_bucket || 0));
// History indexed once per snapshot: "account\0metric" -> rows sorted by ts. The server sends
// one column set per series ({account, metric, ts[], remaining[], reset_at[]}); flat rows
// from an older server (frontend-only deploys) are grouped the same way.
let historyIndexSource = null,
  historyIndex = new Map();
function historyRows(account, metric) {
  const source = state.data?.history;
  if (source !== historyIndexSource) {
    historyIndexSource = source;
    historyIndex = new Map();
    for (const s of source || []) {
      if (Array.isArray(s.ts)) {
        historyIndex.set(
          `${s.account}\0${s.metric}`,
          s.ts.map((ts, i) => ({ ts, account: s.account, metric: s.metric, remaining: s.remaining[i], reset_at: s.reset_at?.[i] ?? null })),
        );
      } else {
        const key = `${s.account}\0${s.metric}`;
        if (!historyIndex.has(key)) historyIndex.set(key, []);
        historyIndex.get(key).push(s);
      }
    }
    for (const rows of historyIndex.values()) rows.sort((x, y) => x.ts - y.ts);
  }
  return historyIndex.get(`${account}\0${metric}`) || [];
}
// First index whose ts is >= t (or > t when after is set), in rows sorted by ts.
function tsBound(rows, t, after = false) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].ts < t || (after && rows[mid].ts === t)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
// An account's rows for one metric with from <= ts <= to.
const historyBetween = (account, metric, from, to) => {
  const rows = historyRows(account, metric);
  return rows.slice(tsBound(rows, from), tsBound(rows, to, true));
};
function drainFor(a, metric, now) {
  const gap = historyGap();
  const rows = historyBetween(a.id, metric, now - state.burn * 3600, now);
  if (
    rows.length < 2 ||
    rows.at(-1).ts - rows[0].ts < 600 ||
    now - rows.at(-1).ts > 900
  )
    return null;
  let consumed = 0,
    seconds = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1],
      next = rows[i];
    if (
      next.ts - prev.ts > gap ||
      next.remaining > prev.remaining + 0.5 ||
      (prev.reset_at &&
        prev.reset_at > prev.ts &&
        prev.reset_at <= next.ts)
    )
      continue;
    consumed += Math.max(0, prev.remaining - next.remaining);
    seconds += next.ts - prev.ts;
  }
  return seconds >= 600 ? (consumed / seconds) * 3600 : null;
}
// Pool totals: each account keeps its latest value until its next sample, so
// accounts checked at different times still add up. A value older than the
// forecast's gap tolerance counts as missing, and no total is drawn then.
function historyPoints(accounts, metric, unitMode = "raw") {
  const ids = new Set(accounts.map((a) => a.id)),
    siloIds = new Set(accounts.filter((a) => a.silo).map((a) => a.id)),
    scaleById = new Map(
      accounts.map((a) => {
        const w = (a.windows || []).find((x) => x.id === metric);
        return [a.id, unitMode === "usd" ? windowApiUsd(a, w) / 100 : unitMode === "units" ? accountWeight(a) / 100 : 1];
      }),
    ),
    gap = historyGap(),
    latest = new Map(),
    out = [];
  const rows = [...ids].flatMap((id) => historyRows(id, metric)).sort((a, b) => a.ts - b.ts);
  rows.forEach((r, i) => {
    latest.set(r.account, r);
    if (rows[i + 1]?.ts === r.ts) return;
    const values = [...latest.values()];
    if (latest.size === ids.size && values.every((v) => r.ts - v.ts <= gap)) {
      const pt = { ts: r.ts, value: values.reduce((s, v) => s + v.remaining * (scaleById.get(v.account) ?? 1), 0) };
      if (siloIds.size)
        pt.silo = values.reduce((s, v) => s + (siloIds.has(v.account) ? v.remaining * (scaleById.get(v.account) ?? 1) : 0), 0);
      out.push(pt);
    }
  });
  return out;
}
// The last good reading is missing, older than 15 minutes, or from before a passed reset.
// A window still at 100% can't be refilled by that reset, so its reading stays current
// (idle Claude 5-hour windows report a reset that has already passed).
const expiredReading = ({ a, w }, now) =>
  !a.quota_at ||
  now - a.quota_at > 900 ||
  (w.reset_at && w.reset_at <= now && a.quota_at < w.reset_at && w.remaining < 100);
// The reading is old, errored, or from before the window last reset.
const staleReading = ({ a, w }, now) =>
  Boolean(a.quota_error) || expiredReading({ a, w }, now);
// Turned off by the owner (a cap pause still resets and comes back) or signed out: takes no traffic.
const ownerPausedAccount = (a) => Boolean((a.disabled && !a.capped) || a.requires_sign_in);
// A stale reading that holds up a single-account forecast: paused accounts never do, and a
// transient poll error does not pause the forecast while the last good reading is still fresh.
const blocksForecast = (o, now) => !ownerPausedAccount(o.a) && expiredReading(o, now);
// Out of rotation or without a fresh reading: holds at its last known value in a multi-account
// pool instead of freezing the chart, burn rate, or forecast for the healthy accounts around it.
const heldInForecast = (o, now) =>
  ownerPausedAccount(o.a) || expiredReading(o, now) || o.a.cap_label === "Silo: quota unreadable";
// A pool's forecast pauses only when no non-paused account has a fresh reading at all.
const poolForecastPaused = (items, now) => {
  const active = items.filter((o) => !ownerPausedAccount(o.a));
  return active.length > 0 && active.every((o) => expiredReading(o, now));
};
// Per-model and per-product limits never hold other windows.
const SCOPED_QUOTA = /^(weekly_scoped:|seven_day_|iguana_necktie$|product:)/;
// The other windows of the same account and quota group that block w: empty, fresh, and resetting
// later. Per-model and per-product limits never block.
const blockingWindows = (a, w, now) =>
  (a.windows || []).filter((o) => o.id !== w.id && (o.group || "") === (w.group || "") && !SCOPED_QUOTA.test(o.id) && o.remaining <= 0 && o.reset_at > now && !staleReading({ a, w: o }, now));
// A window resets at reset_at + k * period (once, with no period). While another
// window of the same account and quota group is empty (fresh reading) until later,
// this one is held: flat at its current value, and resets before then are skipped.
const forecastHolds = (items, now) =>
  items.map(({ a, w }) => Math.max(0, ...blockingWindows(a, w, now).map((o) => o.reset_at)));
// The first reset that applies to a window: reset_at + k * period at or after its hold.
const firstReset = (w, hold, now) =>
  !(w.reset_at > now)
    ? null
    : w.reset_at >= hold
      ? w.reset_at
      : w.period
        ? w.reset_at + Math.ceil((hold - w.reset_at) / w.period) * w.period
        : null;
// Next reset to show: the earliest one a forecast that is actually drawn applies
// (not in the Drain rate view), else the earliest reported.
const nextReset = (forecast, items, now) => {
  const reported = Math.min(...items.map((o) => o.w.reset_at).filter((r) => r > now));
  const t = state.view === "remaining" && forecast.length && Number.isFinite(forecast.next) ? forecast.next : reported;
  return Number.isFinite(t) ? t : null;
};
// Combined burn rate for a pool in the requested unit mode:
// - "usd": calibrated Compute Units (CU/h) across plans and providers
// - "usd_pct": CU-weighted %/h of combined capacity
// - "weighted": %/h of the capacity-weighted pool (stays steady across plan swap-overs)
// - "units": normalized 1x-plan-equivalent units/h
// - "raw": unweighted sum of per-account %/h
function poolDrain(items, metric, now, unitMode = "raw") {
  if (!items.length) return null;
  const rawRates = items.map(({ a, metric: own }) => drainFor(a, own ?? metric, now));
  if (!rawRates.some((r) => r !== null)) return null;
  const rates = rawRates.map((r) => r ?? 0);
  if (unitMode === "raw") return rates.reduce((t, r) => t + r, 0);
  if (unitMode === "usd" || unitMode === "usd_pct") {
    const demandUsd = items.reduce((t, { a, w }, i) => t + (windowApiUsd(a, w) * rates[i]) / 100, 0);
    if (unitMode === "usd") return demandUsd;
    const totalUsd = items.reduce((t, { a, w }) => t + windowApiUsd(a, w), 0);
    return totalUsd > 0 ? (demandUsd / totalUsd) * 100 : 0;
  }
  const totalWeight = items.reduce((t, { a }) => t + accountWeight(a), 0);
  const demandUnits = items.reduce((t, { a }, i) => t + (accountWeight(a) * rates[i]) / 100, 0);
  return unitMode === "units" ? demandUnits : totalWeight > 0 ? (demandUnits / totalWeight) * 100 : 0;
}
// Rolling drain rate time-series helpers: integrate valid non-reset intervals over
// [t - burn, t] with prefix sums so every historical point stays continuous and gap-honest.
// For shared Idlenet (silo) seats, intervals with zero requests from our hub are attributed
// to external (other users') drain using recorded request-count snapshots and hourly usage.
function siloReqNear(samples, ts, tol) {
  if (!samples?.length) return null;
  let lo = 0,
    hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] < ts) lo = mid + 1;
    else hi = mid;
  }
  let best = samples[lo];
  if (lo > 0 && Math.abs(samples[lo - 1][0] - ts) < Math.abs(best[0] - ts))
    best = samples[lo - 1];
  return Math.abs(best[0] - ts) <= tol ? best[1] : null;
}
function siloIntervalAttribution(act, t0, t1, gap) {
  if (!act) return null;
  const tol = Math.max(90, Math.min(gap / 2, 600));
  if (act.samples?.length >= 2) {
    const r0 = siloReqNear(act.samples, t0, tol);
    const r1 = siloReqNear(act.samples, t1, tol);
    if (r0 !== null && r1 !== null) {
      if (r1 === r0) return "external";
      if (r1 > r0) return "ours";
      if (r1 > 0) return "ours";
    }
  }
  if (act.hourly_range && t0 >= act.hourly_range[0] && t1 <= act.hourly_range[1]) {
    const h0 = Math.floor(t0 / 3600) * 3600;
    const h1 = Math.floor(Math.max(t0, t1 - 1e-6) / 3600) * 3600;
    let reqs = 0;
    for (let h = h0; h <= h1; h += 3600)
      reqs += Number(act.hourly?.[String(h)] || 0);
    return reqs > 0 ? "ours" : "external";
  }
  return null;
}
function drainSplitFor(a, metric, now) {
  if (!a?.silo) {
    const total = drainFor(a, metric, now);
    return total === null
      ? null
      : { total, ours: total, external: 0, hasAttribution: false };
  }
  const gap = historyGap();
  const act = state.data?.silo_activity?.[a.id];
  const rows = historyBetween(a.id, metric, now - state.burn * 3600, now);
  if (
    rows.length < 2 ||
    rows.at(-1).ts - rows[0].ts < 600 ||
    now - rows.at(-1).ts > 900
  )
    return null;
  let totalCons = 0,
    ourCons = 0,
    extCons = 0,
    seconds = 0,
    hasAttribution = false;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1],
      next = rows[i];
    if (
      next.ts - prev.ts > gap ||
      next.remaining > prev.remaining + 0.5 ||
      (prev.reset_at &&
        prev.reset_at > prev.ts &&
        prev.reset_at <= next.ts)
    )
      continue;
    const consumed = Math.max(0, prev.remaining - next.remaining);
    totalCons += consumed;
    const attr = siloIntervalAttribution(act, prev.ts, next.ts, gap);
    if (attr) hasAttribution = true;
    if (attr === "external") extCons += consumed;
    else ourCons += consumed;
    seconds += next.ts - prev.ts;
  }
  if (seconds < 600) return null;
  return {
    total: (totalCons / seconds) * 3600,
    ours: (ourCons / seconds) * 3600,
    external: (extCons / seconds) * 3600,
    hasAttribution,
  };
}
function drainIntegralTo(c, x) {
  const { segs, prefDt, prefCons, prefOur, prefExt } = c;
  if (!segs.length || x <= segs[0].t0)
    return { dt: 0, consumed: 0, ours: 0, external: 0 };
  let lo = 0,
    hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].t0 < x) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1,
    s = segs[idx];
  if (x >= s.t1)
    return {
      dt: prefDt[idx + 1],
      consumed: prefCons[idx + 1],
      ours: prefOur[idx + 1],
      external: prefExt[idx + 1],
    };
  const part = x - s.t0,
    frac = part / s.dt;
  return {
    dt: prefDt[idx] + part,
    consumed: prefCons[idx] + s.consumed * frac,
    ours: prefOur[idx] + s.ourConsumed * frac,
    external: prefExt[idx] + s.extConsumed * frac,
  };
}
function evalCompiledDrainSplit(c, t, windowSec, gap, maxAge = gap) {
  const { rowTs } = c;
  if (!rowTs.length || t < rowTs[0]) return null;
  let lo = 0,
    hi = rowTs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowTs[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0 || t - rowTs[idx] > maxAge) return null;
  if (idx + 1 < rowTs.length && rowTs[idx] < t && rowTs[idx + 1] - rowTs[idx] > gap)
    return null;
  const hiInt = drainIntegralTo(c, t);
  const loInt = drainIntegralTo(c, t - windowSec);
  const dt = hiInt.dt - loInt.dt;
  if (dt < 600) return null;
  return {
    total: ((hiInt.consumed - loInt.consumed) / dt) * 3600,
    ours: ((hiInt.ours - loInt.ours) / dt) * 3600,
    external: ((hiInt.external - loInt.external) / dt) * 3600,
  };
}
function evalCompiledDrain(c, t, windowSec, gap, maxAge = gap) {
  const res = evalCompiledDrainSplit(c, t, windowSec, gap, maxAge);
  return res ? res.total : null;
}
function evalCompiledRemaining(c, t, gap) {
  const { rowTs, rowRem } = c;
  if (!rowTs.length || t < rowTs[0]) return null;
  let lo = 0,
    hi = rowTs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowTs[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0 || t - rowTs[idx] > gap) return null;
  if (idx + 1 < rowTs.length && rowTs[idx] < t && rowTs[idx + 1] - rowTs[idx] > gap)
    return null;
  return rowRem[idx];
}
function compileAccountDrain(accountId, metric, gap, windowSec, silo = false) {
  const rows = historyRows(accountId, metric);
  const act = silo ? state.data?.silo_activity?.[accountId] : null;
  const segs = [],
    prefDt = [0],
    prefCons = [0],
    prefOur = [0],
    prefExt = [0];
  let hasAttribution = false;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1],
      next = rows[i],
      dt = next.ts - prev.ts;
    if (
      dt <= 0 ||
      dt > gap ||
      next.remaining > prev.remaining + 0.5 ||
      (prev.reset_at && prev.reset_at > prev.ts && prev.reset_at <= next.ts)
    )
      continue;
    const consumed = Math.max(0, prev.remaining - next.remaining);
    const attr = act ? siloIntervalAttribution(act, prev.ts, next.ts, gap) : null;
    if (attr) hasAttribution = true;
    const ourConsumed = attr === "external" ? 0 : consumed;
    const extConsumed = attr === "external" ? consumed : 0;
    segs.push({ t0: prev.ts, t1: next.ts, dt, consumed, ourConsumed, extConsumed });
    prefDt.push(prefDt.at(-1) + dt);
    prefCons.push(prefCons.at(-1) + consumed);
    prefOur.push(prefOur.at(-1) + ourConsumed);
    prefExt.push(prefExt.at(-1) + extConsumed);
  }
  const c = {
    rowTs: rows.map((r) => r.ts),
    rowRem: rows.map((r) => r.remaining),
    segs,
    prefDt,
    prefCons,
    prefOur,
    prefExt,
    hasAttribution,
    firstValidTs: null,
  };
  for (const s of segs) {
    if (evalCompiledDrain(c, s.t1, windowSec, gap) !== null) {
      c.firstValidTs = s.t1;
      break;
    }
  }
  return c;
}
function accountDrainSplitSeries(a, metric, start, end) {
  const now = state.data.now,
    gap = historyGap(),
    windowSec = state.burn * 3600;
  const c = compileAccountDrain(a.id, metric, gap, windowSec, Boolean(a.silo));
  if (c.firstValidTs === null) return [];
  const timestamps = drainTimestamps([c], start, end, gap, now);
  const out = [];
  let broken = false;
  for (const { ts: t, gap: tsGap } of timestamps) {
    if (tsGap && out.length) broken = true;
    const maxAge = t === now ? 900 : gap;
    const res = evalCompiledDrainSplit(c, t, windowSec, gap, maxAge);
    if (res) {
      const pt = {
        ts: t,
        value: res.total,
        parts: { ours: res.ours, external: res.external },
      };
      if (out.length && broken) pt.gap = true;
      out.push(pt);
      broken = false;
    } else if (out.length) {
      broken = true;
    }
  }
  return out;
}
function drainTimestamps(compiledList, start, end, gap, now) {
  const set = new Set();
  let maxTs = -Infinity;
  for (const c of compiledList) {
    for (const ts of c.rowTs) {
      if (ts >= start && ts <= end) {
        set.add(ts);
        if (ts > maxTs) maxTs = ts;
      }
    }
  }
  if (now <= end && now >= start && maxTs > -Infinity && now - maxTs > 1 && now - maxTs <= 900)
    set.add(now);
  const sorted = [...set].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const maxPts = 180;
  if (sorted.length <= maxPts) {
    return sorted.map((ts, i) => ({
      ts,
      gap: i > 0 && ts - sorted[i - 1] > gap,
    }));
  }
  const minStep = (sorted.at(-1) - sorted[0]) / maxPts;
  const out = [{ ts: sorted[0], gap: false }];
  let sawGap = false;
  for (let i = 1; i < sorted.length; i++) {
    const ts = sorted[i];
    if (ts - sorted[i - 1] > gap) sawGap = true;
    if (
      i === sorted.length - 1 ||
      ts - sorted[i - 1] > gap ||
      sorted[i + 1] - ts > gap ||
      ts - out.at(-1).ts >= minStep
    ) {
      out.push({ ts, gap: sawGap });
      sawGap = false;
    }
  }
  return out;
}
function evalPoolDrainAt(entries, minFirstValidTs, t, windowSec, gap, now, unitMode) {
  if (minFirstValidTs === null) return null;
  const cutoff = Math.max(t, minFirstValidTs + gap);
  const active = entries.filter(
    (e) => e.compiled.firstValidTs !== null && e.compiled.firstValidTs <= cutoff,
  );
  if (!active.length) return null;
  const maxAge = t === now ? 900 : gap;
  const hasSilo = active.some((e) => e.silo);
  let rawSum = 0,
    demandUnits = 0,
    demandUsd = 0,
    totalUsd = 0,
    siloRawSum = 0,
    siloDemandUnits = 0,
    siloDemandUsd = 0,
    totalWeight = 0,
    validCount = 0;
  for (const e of active) {
    totalUsd += e.apiUsd;
    totalWeight += e.weight;
    const r = evalCompiledDrain(e.compiled, t, windowSec, gap, maxAge);
    if (r === null) continue;
    validCount++;
    rawSum += r;
    demandUnits += (e.weight * r) / 100;
    demandUsd += (e.apiUsd * r) / 100;
    if (e.silo) {
      siloRawSum += r;
      siloDemandUnits += (e.weight * r) / 100;
      siloDemandUsd += (e.apiUsd * r) / 100;
    }
  }
  if (!validCount) return null;
  const value =
    unitMode === "raw"
      ? rawSum
      : unitMode === "usd"
        ? demandUsd
        : unitMode === "usd_pct"
          ? totalUsd > 0
            ? (demandUsd / totalUsd) * 100
            : 0
          : unitMode === "units"
            ? demandUnits
            : totalWeight > 0
              ? (demandUnits / totalWeight) * 100
              : 0;
  const silo = hasSilo
    ? unitMode === "raw"
      ? siloRawSum
      : unitMode === "usd"
        ? siloDemandUsd
        : unitMode === "usd_pct"
          ? totalUsd > 0
            ? (siloDemandUsd / totalUsd) * 100
            : 0
          : unitMode === "units"
            ? siloDemandUnits
            : totalWeight > 0
              ? (siloDemandUnits / totalWeight) * 100
              : 0
    : undefined;
  return { value, silo, demandUsd, siloDemandUsd: hasSilo ? siloDemandUsd : undefined, totalUsd, activeKey: active.map((e) => e.id).join("\0") };
}
function poolDrainSeries(items, metric, start, end, unitMode = "raw") {
  if (!items.length) return [];
  const now = state.data.now,
    gap = historyGap(),
    windowSec = state.burn * 3600;
  const entries = items.map(({ a, w, metric: own }) => ({
    id: a.id,
    silo: Boolean(a.silo),
    weight: accountWeight(a),
    apiUsd: windowApiUsd(a, w),
    compiled: compileAccountDrain(a.id, own ?? metric, gap, windowSec),
  }));
  const validStarts = entries
    .map((e) => e.compiled.firstValidTs)
    .filter((ts) => ts !== null);
  if (!validStarts.length) return [];
  const minFirstValidTs = Math.min(...validStarts);
  const timestamps = drainTimestamps(
    entries.map((e) => e.compiled),
    start,
    end,
    gap,
    now,
  );
  const out = [];
  let broken = false,
    prevKey = null;
  for (const { ts: t, gap: tsGap } of timestamps) {
    if (tsGap && out.length) broken = true;
    const res = evalPoolDrainAt(
      entries,
      minFirstValidTs,
      t,
      windowSec,
      gap,
      now,
      unitMode,
    );
    if (res) {
      const pt = res.silo !== undefined ? { ts: t, value: res.value, silo: res.silo } : { ts: t, value: res.value };
      if (
        out.length &&
        (broken || (prevKey !== null && res.activeKey !== prevKey))
      )
        pt.gap = true;
      out.push(pt);
      broken = false;
      prevKey = res.activeKey;
    } else if (out.length) {
      broken = true;
    }
  }
  return out;
}
function allDrainSeries(order, items, start, end, unitMode = "raw") {
  if (!order.length || !items.length) return [];
  const now = state.data.now,
    gap = historyGap(),
    windowSec = state.burn * 3600;
  const byProv = order
    .map((q) => {
      const entries = items
        .filter((o) => o.a.provider === q)
        .map(({ a, w, metric: own }) => ({
          id: a.id,
          silo: Boolean(a.silo),
          weight: accountWeight(a),
          apiUsd: windowApiUsd(a, w),
          compiled: compileAccountDrain(a.id, own, gap, windowSec),
        }));
      const validStarts = entries
        .map((e) => e.compiled.firstValidTs)
        .filter((ts) => ts !== null);
      return {
        q,
        entries,
        minFirstValidTs: validStarts.length ? Math.min(...validStarts) : null,
      };
    })
    .filter((p) => p.minFirstValidTs !== null);
  if (!byProv.length) return [];
  const minProvTs = Math.min(...byProv.map((p) => p.minFirstValidTs));
  const timestamps = drainTimestamps(
    byProv.flatMap((p) => p.entries.map((e) => e.compiled)),
    start,
    end,
    gap,
    now,
  );
  const out = [];
  let broken = false,
    prevKey = null;
  for (const { ts: t, gap: tsGap } of timestamps) {
    if (tsGap && out.length) broken = true;
    const cutoff = Math.max(t, minProvTs + gap);
    const activeProvs = byProv.filter((p) => p.minFirstValidTs <= cutoff);
    if (!activeProvs.length) continue;
    const rawParts = {},
      usdDemandParts = {},
      rawSiloParts = {},
      siloUsdDemandParts = {},
      keys = [];
    let totalActiveUsd = 0,
      validProvs = 0,
      hasSilo = false;
    for (const p of activeProvs) {
      const res = evalPoolDrainAt(
        p.entries,
        p.minFirstValidTs,
        t,
        windowSec,
        gap,
        now,
        unitMode,
      );
      if (!res) {
        const pTotalUsd = p.entries.reduce((s, e) => s + e.apiUsd, 0);
        rawParts[p.q] = 0;
        usdDemandParts[p.q] = 0;
        totalActiveUsd += pTotalUsd;
        keys.push(`${p.q}:held`);
        continue;
      }
      validProvs++;
      rawParts[p.q] = res.value;
      usdDemandParts[p.q] = res.demandUsd;
      totalActiveUsd += res.totalUsd;
      if (res.silo !== undefined) {
        rawSiloParts[p.q] = res.silo;
        siloUsdDemandParts[p.q] = res.siloDemandUsd || 0;
        hasSilo = true;
      }
      keys.push(`${p.q}:${res.activeKey}`);
    }
    if (validProvs > 0) {
      const activeKey = keys.join("|");
      const sum = Object.values(rawParts).reduce((a, b) => a + b, 0);
      const pt =
        unitMode === "usd_pct"
          ? (() => {
              const parts = Object.fromEntries(
                Object.entries(usdDemandParts).map(([q, v]) => [
                  q,
                  totalActiveUsd > 0 ? (v / totalActiveUsd) * 100 : 0,
                ]),
              );
              return { ts: t, value: Object.values(parts).reduce((a, b) => a + b, 0), parts };
            })()
          : unitMode === "weighted"
            ? {
                ts: t,
                value: sum / activeProvs.length,
                parts: Object.fromEntries(
                  Object.entries(rawParts).map(([q, v]) => [q, v / activeProvs.length]),
                ),
                partLabels: rawParts,
              }
            : { ts: t, value: sum, parts: rawParts };
      if (hasSilo) {
        pt.siloParts =
          unitMode === "usd_pct"
            ? Object.fromEntries(
                Object.entries(siloUsdDemandParts).map(([q, v]) => [
                  q,
                  totalActiveUsd > 0 ? (v / totalActiveUsd) * 100 : 0,
                ]),
              )
            : unitMode === "weighted"
              ? Object.fromEntries(
                  Object.entries(rawSiloParts).map(([q, v]) => [q, v / activeProvs.length]),
                )
              : rawSiloParts;
      }
      if (
        out.length &&
        (broken || (prevKey !== null && activeKey !== prevKey))
      )
        pt.gap = true;
      out.push(pt);
      broken = false;
      prevKey = activeKey;
    } else if (out.length) {
      broken = true;
    }
  }
  return out;
}
// Event-driven routing-aware forecast for one provider's accounts.
// Converts recent drain across all accounts into total normalized demand (1x-units/h),
// then routes that demand across eligible accounts in proxy routing order, spilling onto
// the next account at its plan-scaled % rate when one hits 0% (or its Silo cap).
function simulateProviderForecast(items, metric, now, end, unitMode = "raw", lenient = false) {
  const held = items.map((o) => heldInForecast(o, now));
  const hasLive = held.some((h) => !h);
  // Paused, signed-out, or stale/unavailable accounts hold at their last known value and take no
  // simulated traffic so healthy accounts in a pool still produce a live forecast. Pause only when
  // no non-paused account in the pool has a fresh reading at all.
  if (
    !state.forecast ||
    !items.length ||
    (!lenient && !hasLive && items.some((o) => blocksForecast(o, now)))
  )
    return [];
  const rawRates = items.map(({ a, metric: own }) => drainFor(a, own ?? metric, now));
  const anyRate = rawRates.some((r) => r !== null);
  const allOwnerPaused = items.every(({ a }) => ownerPausedAccount(a));
  if (!lenient && !anyRate && !allOwnerPaused) return [];
  const rates = rawRates.map((r) => r ?? 0);
  const weights = items.map(({ a }) => accountWeight(a));
  const apiUsds = items.map(({ a, w }) => windowApiUsd(a, w));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const floors = items.map(({ a, w }) => {
    const cap = capPercentFor(a, w), owner = groupCapFor(a, w)?.owner ?? a.cap_owner;
    return a.silo && cap && owner !== "Owner override" ? Math.max(0, 100 - Number(cap)) : 0;
  });
  const holds = forecastHolds(items, now);
  const resets = items.map(({ w }, i) => {
    const out = [];
    if (!held[i] && w.reset_at > now)
      for (let t = w.reset_at; t <= end; t += w.period || Infinity)
        if (t >= holds[i]) out.push(t);
    return out;
  });
  const priorities = items.map(({ a }) =>
    typeof a.detail?.priority === "number" ? a.detail.priority : 0,
  );
  const isSilo = items.map(({ a }) => Boolean(a.silo));
  const idents = items.map(({ a }) => String(a.name || a.id || ""));
  const weeklyResetBase = items.map(({ a, w }) => {
    const wins = (a.windows || []).filter((o) => o.period === 7 * 86400 && o.reset_at > now);
    if (wins.length) {
      const best = wins.reduce((m, o) => (o.reset_at < m.reset_at ? o : m));
      return { reset_at: best.reset_at, period: best.period };
    }
    return w.reset_at > now ? { reset_at: w.reset_at, period: w.period || 0 } : null;
  });
  const nextWeeklyAt = (i, t) => {
    const b = weeklyResetBase[i];
    if (!b) return Infinity;
    if (b.reset_at > t) return b.reset_at;
    if (!b.period) return Infinity;
    return b.reset_at + Math.floor((t - b.reset_at) / b.period + 1) * b.period;
  };
  const demandUnits = items.reduce((s, _, i) => s + (weights[i] * rates[i]) / 100, 0);
  const strategy = state.data?.routing_strategy || "";

  const totalUsd = apiUsds.reduce((s, v) => s + v, 0);
  const projectValue = (rem) => {
    if (unitMode === "raw") return rem.reduce((s, v) => s + v, 0);
    if (unitMode === "usd") return rem.reduce((s, v, i) => s + (apiUsds[i] * v) / 100, 0);
    if (unitMode === "usd_pct") {
      const remUsd = rem.reduce((s, v, i) => s + (apiUsds[i] * v) / 100, 0);
      return totalUsd > 0 ? (remUsd / totalUsd) * 100 : 0;
    }
    const units = rem.reduce((s, v, i) => s + (weights[i] * v) / 100, 0);
    return unitMode === "units" ? units : totalWeight > 0 ? (units / totalWeight) * 100 : 0;
  };
  const isExhausted = (rem) =>
    items.every((_, i) => held[i] || rem[i] <= floors[i] + 0.01);

  const eventSet = new Set([end]);
  resets.flat().forEach((t) => t > now && t <= end && eventSet.add(t));
  holds.forEach((t) => t > now && t < end && eventSet.add(t));
  const events = [...eventSet].sort((a, b) => a - b);

  const grid = [];
  const step = (end - now) / 100;
  if (step > 0) for (let k = 1; k < 100; k++) grid.push(now + step * k);

  const activePctRates = (rem, t) => {
    const pctRates = new Array(items.length).fill(0);
    if (demandUnits <= 0) return pctRates;
    const eligible = [];
    for (let i = 0; i < items.length; i++) {
      if (!held[i] && t >= holds[i] - 1e-6 && rem[i] > floors[i] + 1e-6)
        eligible.push(i);
    }
    if (!eligible.length) return pctRates;
    const hubEligible = eligible.filter((i) => !isSilo[i]);
    const pool = hubEligible.length ? hubEligible : eligible;
    const maxPri = Math.max(...pool.map((i) => priorities[i]));
    const tier = pool.filter((i) => priorities[i] === maxPri);

    if (tier.length === 1) {
      const idx = tier[0];
      pctRates[idx] = (demandUnits / weights[idx]) * 100;
      return pctRates;
    }
    if (strategy === "soonest-reset") {
      tier.sort((a, b) => nextWeeklyAt(a, t) - nextWeeklyAt(b, t) || idents[a].localeCompare(idents[b]));
      const idx = tier[0];
      pctRates[idx] = (demandUnits / weights[idx]) * 100;
      return pctRates;
    }
    if (strategy === "fill-first") {
      tier.sort((a, b) => idents[a].localeCompare(idents[b]));
      const idx = tier[0];
      pctRates[idx] = (demandUnits / weights[idx]) * 100;
      return pctRates;
    }
    if (strategy === "weighted-round-robin") {
      const tierW = tier.reduce((s, i) => s + weights[i], 0);
      for (const i of tier) pctRates[i] = tierW > 0 ? (demandUnits / tierW) * 100 : 0;
      return pctRates;
    }
    if (!strategy) {
      const obs = tier.map((i) => (weights[i] * rates[i]) / 100);
      const obsSum = obs.reduce((s, v) => s + v, 0);
      if (obsSum > 0) {
        tier.forEach((i, k) => {
          pctRates[i] = ((demandUnits * (obs[k] / obsSum)) / weights[i]) * 100;
        });
        return pctRates;
      }
    }
    const share = demandUnits / tier.length;
    for (const i of tier) pctRates[i] = (share / weights[i]) * 100;
    return pctRates;
  };

  const out = [];
  const rem = items.map(({ w }) => w.remaining);
  const hasSilo = isSilo.some(Boolean);
  const namer = makeAccountNamer(items);
  const pushPoint = (ts, r, pctRates) => {
    const units = r.reduce((s, v, i) => s + (weights[i] * v) / 100, 0);
    const remUsd = r.reduce((s, v, i) => s + (apiUsds[i] * v) / 100, 0);
    const activeDemand = pctRates.reduce((s, v, i) => s + (weights[i] * v) / 100, 0);
    const activeUsd = pctRates.reduce((s, v, i) => s + (apiUsds[i] * v) / 100, 0);
    const rate =
      unitMode === "raw"
        ? pctRates.reduce((s, v) => s + v, 0)
        : unitMode === "usd"
          ? activeUsd
          : unitMode === "usd_pct"
            ? totalUsd > 0
              ? (activeUsd / totalUsd) * 100
              : 0
            : unitMode === "units"
              ? activeDemand
              : totalWeight > 0
                ? (activeDemand / totalWeight) * 100
                : 0;
    const activeNames = [];
    for (let i = 0; i < items.length; i++)
      if (pctRates[i] > 1e-6) activeNames.push(namer(items[i].a));
    const pt = {
      ts,
      projected: true,
      value: projectValue(r),
      units,
      totalWeight,
      usd: remUsd,
      totalUsd,
      demandUsd: activeUsd,
      rate,
      demandUnits: activeDemand,
      activeNames,
      exhausted: isExhausted(r),
    };
    if (hasSilo) pt.silo = projectValue(r.map((v, i) => (isSilo[i] ? v : 0)));
    out.push(pt);
  };
  pushPoint(now, rem, activePctRates(rem, now));

  let t = now;
  let evIdx = 0;
  let gridIdx = 0;
  for (let iter = 0; iter < 2000 && t < end - 1e-6; iter++) {
    while (evIdx < events.length && events[evIdx] <= t + 1e-6) evIdx++;
    const nextEv = evIdx < events.length ? events[evIdx] : end;
    const pctRates = activePctRates(rem, t);
    let nextEmpty = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (pctRates[i] > 1e-9 && rem[i] > floors[i] + 1e-6) {
        const dt = ((rem[i] - floors[i]) / pctRates[i]) * 3600;
        if (dt > 1e-6 && t + dt < nextEmpty) nextEmpty = t + dt;
      }
    }
    const tStep = Math.min(nextEv, nextEmpty, end);
    while (gridIdx < grid.length && grid[gridIdx] <= t + 1e-6) gridIdx++;
    while (gridIdx < grid.length && grid[gridIdx] < tStep - 1e-3) {
      const tg = grid[gridIdx++];
      const dtH = (tg - t) / 3600;
      pushPoint(
        tg,
        rem.map((v, i) => Math.max(Math.min(v, floors[i]), v - pctRates[i] * dtH)),
        pctRates,
      );
    }
    const dtH = (tStep - t) / 3600;
    for (let i = 0; i < items.length; i++) {
      rem[i] = Math.max(Math.min(rem[i], floors[i]), rem[i] - pctRates[i] * dtH);
    }
    const resetting = [];
    for (let i = 0; i < items.length; i++) {
      if (resets[i].some((rt) => Math.abs(rt - tStep) <= 1e-4)) resetting.push(i);
    }
    if (resetting.length) {
      if (tStep - 0.01 > t) pushPoint(tStep - 0.01, rem, pctRates);
      for (const i of resetting) rem[i] = 100;
    }
    pushPoint(tStep, rem, activePctRates(rem, tStep));
    t = tStep;
  }

  // Each window's first applied reset (recurring ones stay in the curve only): the
  // chart's reset lines inside the view, and the earliest as the cards' next reset.
  const firsts = items.map(({ w }, i) => (held[i] ? null : firstReset(w, holds[i], now)));
  out.resets = items
    .map(({ a }, i) => ({ ts: firsts[i], a }))
    .filter((r) => r.ts > now && r.ts < end)
    .sort((a, b) => a.ts - b.ts);
  out.next = Math.min(...firsts.filter((ts) => ts !== null));
  return out;
}
function forecastPoints(items, metric, now, end, unitMode = "raw", lenient = false) {
  if (!state.forecast || !items.length) return [];
  const providers = [...new Set(items.map(({ a }) => a.provider || ""))];
  if (providers.length <= 1)
    return simulateProviderForecast(items, metric, now, end, unitMode, lenient);
  const curves = providers.map((q) =>
    simulateProviderForecast(
      items.filter(({ a }) => (a.provider || "") === q),
      metric,
      now,
      end,
      unitMode,
      lenient,
    ),
  );
  if (curves.some((c) => !c.length)) return [];
  const evalCurve = (curve, ts) => {
    if (ts <= curve[0].ts) return curve[0];
    const last = curve.at(-1);
    if (ts >= last.ts) return last;
    let lo = 0, hi = curve.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (curve[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    if (curve[lo].ts === ts) return curve[lo];
    const a = curve[lo - 1], b = curve[lo], k = (ts - a.ts) / (b.ts - a.ts || 1);
    const res = {
      ts,
      value: a.value + (b.value - a.value) * k,
      units: a.units + (b.units - a.units) * k,
      totalWeight: a.totalWeight,
      usd: a.usd + (b.usd - a.usd) * k,
      totalUsd: a.totalUsd,
      demandUsd: a.demandUsd,
      rate: a.rate,
      demandUnits: a.demandUnits,
      exhausted: a.exhausted && b.exhausted,
    };
    if (Number.isFinite(a.silo) && Number.isFinite(b.silo))
      res.silo = a.silo + (b.silo - a.silo) * k;
    return res;
  };
  const times = [...new Set(curves.flatMap((c) => c.map((p) => p.ts)))].sort((a, b) => a - b);
  const out = times.map((ts) => {
    const pts = curves.map((c) => evalCurve(c, ts));
    const sum = pts.reduce((s, p) => s + p.value, 0);
    const rateSum = pts.reduce((s, p) => s + (p.rate || 0), 0);
    const demandUnits = pts.reduce((s, p) => s + (p.demandUnits || 0), 0);
    const units = pts.reduce((s, p) => s + (p.units || 0), 0);
    const totalWeight = pts.reduce((s, p) => s + (p.totalWeight || 0), 0);
    const sumUsd = pts.reduce((s, p) => s + (p.usd || 0), 0);
    const allTotalUsd = pts.reduce((s, p) => s + (p.totalUsd || 0), 0);
    const sumDemandUsd = pts.reduce((s, p) => s + (p.demandUsd || 0), 0);
    const rawParts = Object.fromEntries(providers.map((q, idx) => [q, pts[idx].value]));
    const partRates =
      unitMode === "usd_pct"
        ? Object.fromEntries(
            providers.map((q, idx) => [q, allTotalUsd > 0 ? ((pts[idx].demandUsd || 0) / allTotalUsd) * 100 : 0]),
          )
        : Object.fromEntries(providers.map((q, idx) => [q, pts[idx].rate || 0]));
    const hasSilo = pts.some((p) => Number.isFinite(p.silo));
    const pt = {
      ts,
      projected: true,
      value:
        unitMode === "usd_pct"
          ? allTotalUsd > 0
            ? (sumUsd / allTotalUsd) * 100
            : 0
          : unitMode === "weighted"
            ? sum / curves.length
            : sum,
      parts:
        unitMode === "usd_pct"
          ? Object.fromEntries(
              providers.map((q, idx) => [q, allTotalUsd > 0 ? ((pts[idx].usd || 0) / allTotalUsd) * 100 : 0]),
            )
          : unitMode === "weighted"
            ? Object.fromEntries(providers.map((q, idx) => [q, pts[idx].value / curves.length]))
            : rawParts,
      partLabels: unitMode === "weighted" ? rawParts : null,
      rate:
        unitMode === "usd_pct"
          ? allTotalUsd > 0
            ? (sumDemandUsd / allTotalUsd) * 100
            : 0
          : unitMode === "weighted"
            ? rateSum / curves.length
            : rateSum,
      partRates,
      demandUnits,
      units,
      totalWeight,
      exhausted: pts.every((p) => p.exhausted),
    };
    if (hasSilo) {
      pt.siloParts = Object.fromEntries(
        providers
          .map((q, idx) => [q, pts[idx].silo])
          .filter(([, v]) => Number.isFinite(v))
          .map(([q, v]) => [q, unitMode === "weighted" ? v / curves.length : v]),
      );
    }
    return pt;
  });
  out.resets = curves.flatMap((c) => c.resets || []).sort((a, b) => a.ts - b.ts);
  out.next = Math.min(...curves.map((c) => c.next).filter((ts) => Number.isFinite(ts)));
  return out;
}
function makeAccountNamer(items) {
  const emailPrefixCounts = new Map();
  items.forEach(({ a }) => {
    if (!a?.nickname?.trim() && a?.email) {
      const prefix = a.email.split("@")[0];
      if (prefix) emailPrefixCounts.set(prefix, (emailPrefixCounts.get(prefix) || 0) + 1);
    }
  });
  return (a) => {
    if (!a) return "";
    const nick = a.nickname?.trim();
    if (nick) return nick;
    if (a.email) {
      const prefix = a.email.split("@")[0];
      return prefix && emailPrefixCounts.get(prefix) === 1 ? prefix : a.email;
    }
    const i = filteredAccounts(a.provider).indexOf(a);
    return accountLabel(a, i >= 0 ? i : 0);
  };
}
let activePlotSpan = 12;
function renderTimePlot({
  key,
  points,
  forecast = [],
  start,
  end,
  now,
  cap,
  maxY,
  unitMode = "raw",
  stack = null,
  resets = [],
  rate = false,
  meta = null,
  legendHtml = "",
  idle = "",
  emptyTitle = "History starts here",
  emptyBody = "Quotas are recorded every 30 seconds, even with this page closed. Your usage curve will build over time.",
  ariaLabel = "",
}) {
  const future = forecast.length > 0;
  const fmt = (v) => (rate ? fmtRateVal(v, unitMode) : fmtChartVal(v, unitMode));
  const isMobile = innerWidth <= 760,
    isMedium = !isMobile && innerWidth < 1280 && innerWidth >= 960,
    effSpan = isMobile || innerWidth < 960 ? 12 : isMedium ? (activePlotSpan === 12 ? 12 : 6) : activePlotSpan,
    cols = 12 / effSpan,
    pageW = $("#page-body").clientWidth || 1000,
    cardPad = isMobile ? 30 : effSpan === 4 ? 34 : effSpan === 6 ? 38 : 50,
    W = Math.max(240, Math.round((pageW - (cols - 1) * 16) / cols) - cardPad),
    // Matches the CSS svg height so the chart is never stretched.
    H = isMobile ? 160 : effSpan === 4 ? 160 : effSpan === 6 ? 185 : 220,
    left = unitMode === "usd" ? (rate ? 72 : 58) : rate ? 60 : 46,
    right = 10,
    bottom = 32;
  const x = (t) =>
    left + ((t - start) / (end - start || 1)) * (W - left - right);
  // Resets on the same visual line (within clusterPx) share one marker: the resetting
  // providers' icons above the line. Close markers stagger into up to maxLanes lanes so
  // none overlap without crushing the plot height; overflow clusters merge into the
  // closest marker while the tooltip still lists every account and exact reset time.
  const compact = W < 420,
    medium = W < 680,
    clusterPx = compact ? 12 : medium ? 8 : 5,
    maxLanes = medium ? 2 : 3;
  const groups = [];
  for (const r of resets) {
    const prev = groups.at(-1);
    if (prev && x(r.ts) - x(prev.ts) < clusterPx) prev.items.push(r);
    else groups.push({ ts: r.ts, items: [r] });
  }
  const iconSize = 12,
    iconGap = 2,
    gap = 6,
    laneStep = 15,
    nowNearLeft = future && x(now) - left < 22,
    nowBox = !future
      ? { x1: x(now) - 26, x2: x(now) + 2 }
      : nowNearLeft
        ? { x1: x(now) - 2, x2: x(now) + 26 }
        : { x1: x(now) - 14, x2: x(now) + 14 };
  const lanes = [[nowBox]];
  const placed = [];
  const extraWidth = (n) => 4.5 + String(`+${n}`).length * 5.6;
  const fitCountPill = (target) => {
    target.countOnly = true;
    const countLabel = String(target.items.length);
    const pillW = Math.max(iconSize, Math.ceil(countLabel.length * 5.6 + 8));
    const row = lanes[target.lane];
    let minX = left,
      maxX = W - right;
    for (const b of row) {
      if (b === target.box) continue;
      if (b.x2 <= target.box.x1) minX = Math.max(minX, b.x2 + gap);
      else if (b.x1 >= target.box.x2) maxX = Math.min(maxX, b.x1 - gap);
    }
    if (maxX - minX >= pillW) {
      const px1 = Math.min(Math.max(target.lineX - pillW / 2, minX), maxX - pillW);
      target.x1 = px1;
      target.pillW = pillW;
      target.box.x1 = px1;
      target.box.x2 = px1 + pillW;
      return target;
    }
    const peer = placed
      .filter((p) => p !== target && p.lane === target.lane)
      .reduce(
        (best, cur) =>
          !best || Math.abs(cur.lineX - target.lineX) < Math.abs(best.lineX - target.lineX)
            ? cur
            : best,
        null,
      );
    if (peer) {
      peer.items.push(...target.items);
      const pIdx = placed.indexOf(target);
      if (pIdx >= 0) placed.splice(pIdx, 1);
      const bIdx = row.indexOf(target.box);
      if (bIdx >= 0) row.splice(bIdx, 1);
      const allProvs = new Set(peer.items.map((r) => r.provider));
      peer.color = allProvs.size === 1 ? `var(--provider-${[...allProvs][0]})` : "var(--foreground)";
      return fitCountPill(peer);
    }
    const px1 = Math.min(Math.max(target.lineX - pillW / 2, left), W - right - pillW);
    target.x1 = px1;
    target.pillW = pillW;
    target.box.x1 = px1;
    target.box.x2 = px1 + pillW;
    return target;
  };
  for (const g of groups) {
    const lineX = x(g.ts),
      providers = [...new Set(g.items.map((r) => r.provider))],
      half = (providers.length * (iconSize + iconGap) - iconGap) / 2,
      at = Math.min(Math.max(lineX, left + half), W - right - half),
      x1 = at - half,
      x2 = at + half;
    let lane = lanes.findIndex((row) =>
      row.every((b) => x2 + gap <= b.x1 || x1 - gap >= b.x2),
    );
    if (lane < 0 && lanes.length < maxLanes) {
      lane = lanes.length;
      lanes.push([]);
    }
    if (lane < 0 && placed.length) {
      const target = placed.reduce((best, cur) =>
        Math.abs(cur.lineX - lineX) < Math.abs(best.lineX - lineX) ? cur : best,
      );
      target.items.push(...g.items);
      const nextProviders = [...target.providers];
      for (const p of providers) {
        if (!nextProviders.includes(p)) nextProviders.push(p);
      }
      const iconsW = target.providers.length * (iconSize + iconGap) - iconGap;
      const nextHalf = (nextProviders.length * (iconSize + iconGap) - iconGap) / 2;
      const nextAt = Math.min(Math.max(target.lineX, left + nextHalf), W - right - nextHalf);
      const nx1 = nextAt - nextHalf,
        nx2 = nextAt + nextHalf;
      const badgeW = target.extra ? extraWidth(target.extra) : 0;
      const fits = lanes[target.lane].every(
        (b) => b === target.box || nx2 + badgeW + gap <= b.x1 || nx1 - gap >= b.x2,
      );
      let active = target;
      if (fits && !target.extra && !target.countOnly) {
        target.providers = nextProviders;
        target.x1 = nx1;
        target.box.x1 = nx1;
        target.box.x2 = nx2;
      } else {
        target.extra = (target.extra || 0) + g.items.length;
        const newBadgeW = extraWidth(target.extra);
        const sideEnd = target.x1 + iconsW + newBadgeW;
        const fitsSide =
          !target.countOnly &&
          sideEnd <= W - right &&
          lanes[target.lane].every(
            (b) => b === target.box || sideEnd + gap <= b.x1 || target.x1 - gap >= b.x2,
          );
        if (fitsSide) {
          target.box.x1 = target.x1;
          target.box.x2 = sideEnd;
        } else {
          // Switch to a count-only pill within lane bounds so badges never overlap icons or adjacent lanes.
          active = fitCountPill(target);
        }
      }
      const allProvs = new Set(active.items.map((r) => r.provider));
      active.color = allProvs.size === 1 ? `var(--provider-${[...allProvs][0]})` : "var(--foreground)";
      continue;
    }
    if (lane < 0) lane = 0;
    const box = { x1, x2 };
    lanes[lane].push(box);
    // One provider: its color. Mixed providers resetting together: neutral, no one color wins.
    const color = providers.length === 1 ? `var(--provider-${providers[0]})` : "var(--foreground)";
    placed.push({ ts: g.ts, items: [...g.items], providers, color, lineX, x1, lane, box, extra: 0 });
  }
  const top = 30 + Math.max(0, lanes.length - 1) * laneStep;
  const iconY = (lane) => top - 25 - lane * laneStep;
  const y = (v) =>
    H - bottom - (v / maxY) * (H - top - bottom);
  state.charts[key] = {
    points,
    forecast,
    start,
    end,
    cap,
    unitMode,
    rate,
    meta,
    stackOrder: stack?.order || null,
    stackColors: stack?.colors || null,
    stackLabels: stack?.labels || null,
    stackHatched: stack?.hatched ? [...stack.hatched] : null,
    x,
    y,
    W,
    H,
    left,
    right,
    resets: placed,
  };
  // Monotone cubic curve (as d3's curveMonotoneX): smooth, passes through
  // every sample, and never overshoots between them, so it invents no values.
  const curveParts = (arr) => {
    const p = arr.map((r) => [x(r.ts), y(r.value)]),
      n = p.length;
    if (n < 3) return { p, m: null };
    const d = [],
      m = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = p[i + 1][0] - p[i][0];
      d.push(dx ? (p[i + 1][1] - p[i][1]) / dx : 0);
    }
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++)
      m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (!d[i]) {
        m[i] = m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i],
        b = m[i + 1] / d[i],
        h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    return { p, m };
  };
  const path = (arr) => {
    const { p, m } = curveParts(arr),
      n = p.length,
      f = (v) => v.toFixed(2);
    if (!m)
      return p.map(([px, py], i) => `${i ? "L" : "M"}${f(px)},${f(py)}`).join(" ");
    let out = `M${f(p[0][0])},${f(p[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const dx = (p[i + 1][0] - p[i][0]) / 3;
      out += ` C${f(p[i][0] + dx)},${f(p[i][1] + m[i] * dx)} ${f(p[i + 1][0] - dx)},${f(p[i + 1][1] - m[i + 1] * dx)} ${f(p[i + 1][0])},${f(p[i + 1][1])}`;
    }
    return out;
  };
  // Reversed monotone cubic edge (joins to a preceding forward path to close a band cleanly).
  const revEdge = (arr) => {
    const { p, m } = curveParts(arr),
      n = p.length,
      f = (v) => v.toFixed(2);
    if (!n) return "";
    if (!m)
      return [...p].reverse().map(([px, py]) => `L${f(px)},${f(py)}`).join(" ");
    let out = `L${f(p[n - 1][0])},${f(p[n - 1][1])}`;
    for (let i = n - 2; i >= 0; i--) {
      const dx = (p[i + 1][0] - p[i][0]) / 3;
      out += ` C${f(p[i + 1][0] - dx)},${f(p[i + 1][1] - m[i + 1] * dx)} ${f(p[i][0] + dx)},${f(p[i][1] + m[i] * dx)} ${f(p[i][0])},${f(p[i][1])}`;
    }
    return out;
  };
  let ticks = "";
  for (let i = 0; i <= 2; i++) {
    let v = (maxY * i) / 2;
    ticks += `<line class="grid-line" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/><text x="${left - 10}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  // As many time labels as fit (~100px each), at most 6.
  const tickCount = Math.max(2, Math.min(6, Math.floor((W - left - right) / 100))),
    span = end - start;
  for (let i = 0; i <= tickCount; i++) {
    const ts = start + (span * i) / tickCount;
    let tickLabel = new Date(ts * 1000).toLocaleString(
      undefined,
      span <= 36 * 3600
        ? { hour: "numeric" }
        : span <= 96 * 3600
          ? { weekday: "short", hour: "numeric" }
          : { month: "short", day: "numeric" },
    );
    ticks += `<line class="grid-line" x1="${x(ts)}" x2="${x(ts)}" y1="${top}" y2="${H - bottom}"/><text x="${x(ts)}" y="${H - 9}" text-anchor="${i === 0 ? "start" : i === tickCount ? "end" : "middle"}">${esc(tickLabel)}</text>`;
  }
  const resetLines = placed
    .map(
      (g, i) =>
        `<line class="chart-reset" data-reset="${i}" style="--reset-color:${esc(g.color)}" x1="${g.lineX}" x2="${g.lineX}" y1="${g.lane > 0 ? top : iconY(g.lane) + iconSize + 2}" y2="${H - bottom}"/>`,
    )
    .join("");
  const resetLabels = placed
    .map(
      (g, i) => {
        const y0 = iconY(g.lane);
        if (g.countOnly) {
          const pw = g.pillW || iconSize;
          return `<g class="reset-label reset-count-pill" data-reset="${i}"><title>${esc(g.items.map((r) => `${r.name} resets ${dateLabel(r.ts)}`).join("; "))}</title><rect x="${g.x1}" y="${y0}" width="${pw}" height="${iconSize}" rx="6" fill="var(--secondary)" stroke="var(--border)"/><text class="reset-pill-text" x="${g.x1 + pw / 2}" y="${y0 + iconSize - 3}" text-anchor="middle">${g.items.length}</text></g>`;
        }
        const iconsW = g.providers.length * (iconSize + iconGap) - iconGap;
        const extraHtml = g.extra
          ? `<text class="reset-extra" x="${g.x1 + iconsW + 1}" y="${y0 + iconSize - 3}" text-anchor="start">+${g.extra}</text>`
          : "";
        return `<g class="reset-label" data-reset="${i}"><title>${esc(g.items.map((r) => `${r.name} resets ${dateLabel(r.ts)}`).join("; "))}</title>${g.providers.map((p, k) => `<use href="#brand-${PROVIDERS[p]?.mark || "codex"}" x="${g.x1 + k * (iconSize + iconGap)}" y="${y0}" width="${iconSize}" height="${iconSize}"/>`).join("")}${extraHtml}</g>`;
      },
    )
    .join("");
  const resetMarks = resetLines + resetLabels;
  const segments = [];
  points.forEach((r) => {
    if (!segments.length || r.gap) segments.push([]);
    segments.at(-1).push(r);
  });
  const lines = segments.filter((g) => g.length > 1);
  const hatchedSet = new Set(stack?.hatched || []);
  const siloOf = (r) =>
    Math.max(0, Math.min(r.value, Number.isFinite(r.silo) ? r.silo : 0));
  const hasSiloHatch = stack
    ? lines.some((g) => stack.order.some((q) => !hatchedSet.has(q) && g.some((r) => (r.siloParts?.[q] || 0) > 1e-6)))
    : lines.some((g) => g.some((r) => siloOf(r) > 1e-6));
  const siloHatchDef = hasSiloHatch
    ? stack
      ? `<pattern id="hatch-${esc(key)}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4" stroke="#0a0a0a" stroke-opacity=".48" stroke-width="2"/></pattern>`
      : `<pattern id="hatch-${esc(key)}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4" stroke="var(--pool-color)" stroke-opacity=".3" stroke-width="1.5"/></pattern>`
    : "";
  const bandHatchDefs = stack
    ? stack.order
        .filter((q) => hatchedSet.has(q))
        .map((q) => {
          const bandColor = stack.colors?.[q] || `var(--provider-${q})`;
          return `<pattern id="hatch-${esc(key)}-${esc(q)}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${esc(bandColor)}" fill-opacity=".14"/><path d="M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4" stroke="${esc(bandColor)}" stroke-opacity=".75" stroke-width="2"/></pattern>`;
        })
        .join("")
    : "";
  const hatchDef = siloHatchDef + bandHatchDefs;
  // Stacked totals: one band per provider, in its own color; the top edge is the pool.
  const cum = (g, k) =>
    g.map((r) => ({ ts: r.ts, value: stack.order.slice(0, k).reduce((t, q) => t + (r.parts?.[q] || 0), 0) }));
  const bands = stack
    ? lines
        .map((g) =>
          stack.order
            .map((q, k) => {
              if (!g.some((r) => r.parts?.[q] !== undefined)) return "";
              const up = cum(g, k + 1),
                low = cum(g, k),
                bandColor = stack.colors?.[q] || `var(--provider-${q})`;
              const strokeRuns = [];
              if (k === 0) {
                strokeRuns.push(up);
              } else {
                let run = [];
                for (let i = 0; i < g.length; i++) {
                  const active =
                    (g[i].parts?.[q] || 0) > 1e-6 ||
                    (i > 0 && (g[i - 1].parts?.[q] || 0) > 1e-6) ||
                    (i + 1 < g.length && (g[i + 1].parts?.[q] || 0) > 1e-6);
                  if (active) run.push(up[i]);
                  else {
                    if (run.length > 1) strokeRuns.push(run);
                    run = [];
                  }
                }
                if (run.length > 1) strokeRuns.push(run);
              }
              const strokes = strokeRuns
                .map(
                  (run) =>
                    `<path d="${path(run)}" stroke="${esc(bandColor)}" stroke-width="2" vector-effect="non-scaling-stroke" fill="none"/>`,
                )
                .join("");
              if (hatchedSet.has(q)) {
                return `<path class="band-hatch" data-band="${esc(q)}" d="${path(up)} ${revEdge(low)} Z" fill="url(#hatch-${esc(key)}-${esc(q)})"/>${strokes}`;
              }
              let hatchHtml = "";
              if (g.some((r) => (r.siloParts?.[q] || 0) > 1e-6)) {
                const siloBase = g.map((r, i) => {
                  const part = Math.max(0, r.parts?.[q] || 0);
                  const s = Math.max(0, Math.min(part, r.siloParts?.[q] || 0));
                  return { ts: r.ts, value: up[i].value - s };
                });
                const mixed = siloBase.some(
                  (r, i) => r.value > low[i].value + 1e-6 && up[i].value > r.value + 1e-6,
                );
                hatchHtml =
                  `<path class="silo-hatch" d="${path(up)} ${revEdge(siloBase)} Z" fill="url(#hatch-${esc(key)})"/>` +
                  (mixed
                    ? `<path class="silo-divider" d="${path(siloBase)}" stroke="#0a0a0a" stroke-opacity=".45" stroke-width="1" vector-effect="non-scaling-stroke" fill="none"/>`
                    : "");
              }
              return `<path d="${path(up)} ${revEdge(low)} Z" fill="${esc(bandColor)}" fill-opacity=".5"/>${hatchHtml}${strokes}`;
            })
            .join(""),
        )
        .join("")
    : "";
  const area = stack
    ? bands
    : lines
        .map((g) => {
          const fillPath = `<path d="${path(g)} L${x(g.at(-1).ts)},${y(0)} L${x(g[0].ts)},${y(0)} Z" fill="url(#fill-${esc(key)})"/>`;
          if (!g.some((r) => siloOf(r) > 1e-6)) return fillPath;
          const base = g.map((r) => ({ ts: r.ts, value: Math.max(0, r.value - siloOf(r)) }));
          const hasBase = base.some((r) => r.value > 1e-6);
          const hatchPath = hasBase
            ? `<path class="silo-hatch" d="${path(g)} ${revEdge(base)} Z" fill="url(#hatch-${esc(key)})"/><path class="silo-divider" d="${path(base)}" stroke="var(--pool-color)" stroke-opacity=".35" stroke-width="1.25" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" fill="none"/>`
            : `<path class="silo-hatch" d="${path(g)} L${x(g.at(-1).ts)},${y(0)} L${x(g[0].ts)},${y(0)} Z" fill="url(#hatch-${esc(key)})"/>`;
          return fillPath + hatchPath;
        })
        .join("");
  const finalLegendHtml =
    hasSiloHatch && !legendHtml.includes("legend-silo")
      ? `${legendHtml}<span class="legend legend-silo"><i class="legend-swatch hatched"></i>Idlenet</span>`
      : legendHtml;
  const latest = points.at(-1);
  const latestRight = latest && x(latest.ts) - left < (rate ? 64 : 48);
  const annotation = latest
    ? `<circle cx="${x(latest.ts)}" cy="${y(latest.value)}" r="6" fill="${stack ? "var(--foreground)" : "var(--pool-color)"}" stroke="var(--card)" stroke-width="3"/><text class="current-value"${stack ? ' style="fill:var(--foreground)"' : ""} x="${x(latest.ts) + (latestRight ? 10 : -10)}" y="${y(latest.value) - 9 < top + 12 ? y(latest.value) + 18 : y(latest.value) - 9}" text-anchor="${latestRight ? "start" : "end"}">${esc(fmt(latest.value))}</text>`
    : "";
  return `<figure class="plot${stack ? " plot-stacked" : ""}" tabindex="0" data-chart="${esc(key)}" data-inspect-idle="${esc(idle)}" aria-label="${esc(ariaLabel)}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${points.length} recorded samples${forecast.length ? ", estimated future usage" : ""}"><defs><linearGradient id="fill-${esc(key)}" x1="0" x2="0" y1="0" y2="1"><stop stop-color="var(--pool-color)" stop-opacity=".16"/><stop offset="1" stop-color="var(--pool-color)" stop-opacity="0"/></linearGradient>${hatchDef}</defs>${ticks}${resetMarks}<line x1="${x(now)}" x2="${x(now)}" y1="${top - 4}" y2="${H - bottom + 2}" stroke="#686868"/><text class="axis-now" x="${x(now)}" y="${top - 14}" text-anchor="${!future ? "end" : nowNearLeft ? "start" : "middle"}">Now</text><g class="chart-data">${area}${(stack ? [] : lines).map((g) => `<path d="${path(g)}" stroke="var(--pool-color)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" fill="none"/>`).join("")}${forecast.length ? `<path class="forecast-line" d="${path(forecast)}" stroke="${stack ? "var(--foreground)" : "var(--pool-color)"}" stroke-opacity=".7" stroke-width="4" stroke-linecap="round" stroke-dasharray="4 10" vector-effect="non-scaling-stroke" fill="none"/>` : ""}${annotation}</g><g class="chart-crosshair" hidden><line x1="0" x2="0" y1="${top}" y2="${H - bottom}"/><circle class="halo" r="12"/><circle class="dot" r="6"/></g></svg><div class="chart-tooltip" hidden></div>${points.length < 2 ? `<div class="chart-empty"><strong>${esc(emptyTitle)}</strong><p>${esc(emptyBody)}</p></div>` : ""}<figcaption class="chart-caption">${finalLegendHtml}<span class="chart-inspect" aria-live="polite">${esc(idle)}</span></figcaption></figure>`;
}
function plot(key, label, items, metric, series, stack, unitMode = "raw") {
  const now = state.data.now,
    range = state.hours * 3600;
  // The future is only reserved when a forecast is actually drawn (not off, paused or unready).
  const lenient = Boolean(stack?.lenient);
  let forecast = forecastPoints(items, metric, now, now + range * 0.7, unitMode, lenient);
  const future = forecast.length > 0;
  let start = now - range * (future ? 0.3 : 1),
    end = future ? now + range * 0.7 : now;
  const totalWeight = items.reduce((s, o) => s + accountWeight(o.a), 0);
  const totalUsd = items.reduce((s, o) => s + windowApiUsd(o.a, o.w), 0);
  const cap =
    unitMode === "weighted" || unitMode === "usd_pct"
      ? 100
      : unitMode === "usd"
        ? totalUsd
        : unitMode === "units"
          ? totalWeight
          : items.length * 100;
  const maxY =
    unitMode === "usd" || unitMode === "units" ? Math.max(cap, 1) : Math.max(cap, 100);
  const gapLimit = historyGap();
  // Totals use the server's pooled series (same samples, same staleness rule);
  // a point flagged gap starts a new line segment instead of joining across.
  let points = (series
    ? series.map((r) => ({ ...r }))
    : historyPoints(
        items.map((o) => o.a),
        metric,
        unitMode,
      )
  ).filter((r) => r.ts >= start);
  const liveItems =
    items.length > 1
      ? items.filter((o) => !staleReading(o, now))
      : items.filter((o) => !o.a.quota_error);
  const actualAt = liveItems.length
    ? Math.min(...liveItems.map((o) => o.a.quota_at || now))
    : null;
  if (
    items.length &&
    liveItems.length &&
    actualAt >= start
  ) {
    const latestUnits = items.reduce((sum, o) => sum + (accountWeight(o.a) * o.w.remaining) / 100, 0);
    const latestUsd = items.reduce((sum, o) => sum + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0);
    const latestValue = stack && Number.isFinite(stack.latestValue)
      ? stack.latestValue
      : unitMode === "weighted"
        ? totalWeight > 0
          ? (latestUnits / totalWeight) * 100
          : 0
        : unitMode === "usd_pct"
          ? totalUsd > 0
            ? (latestUsd / totalUsd) * 100
            : 0
          : unitMode === "usd"
            ? latestUsd
            : unitMode === "units"
              ? latestUnits
              : items.reduce((sum, o) => sum + o.w.remaining, 0);
    const latest = {
      ts: actualAt,
      value: latestValue,
      units: latestUnits,
      weight: totalWeight,
      usd: latestUsd,
    };
    const siloItems = items.filter((o) => o.a.silo);
    if (siloItems.length && !stack) {
      const latestSiloUnits = siloItems.reduce((sum, o) => sum + (accountWeight(o.a) * o.w.remaining) / 100, 0);
      const latestSiloUsd = siloItems.reduce((sum, o) => sum + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0);
      latest.silo =
        unitMode === "weighted"
          ? totalWeight > 0
            ? (latestSiloUnits / totalWeight) * 100
            : 0
          : unitMode === "usd_pct"
            ? totalUsd > 0
              ? (latestSiloUsd / totalUsd) * 100
              : 0
            : unitMode === "usd"
              ? latestSiloUsd
              : unitMode === "units"
                ? latestSiloUnits
                : siloItems.reduce((sum, o) => sum + o.w.remaining, 0);
    }
    if (!points.length || (series ? latest.ts - points.at(-1).ts > 1 : Math.abs(points.at(-1).ts - latest.ts) > 1)) {
      if (series && points.length && (latest.ts - points.at(-1).ts > gapLimit || (stack && Object.keys(points.at(-1).parts || {}).length !== Object.keys(stack.parts).length))) latest.gap = true;
      if (stack) {
        latest.parts = stack.parts;
        if (stack.siloParts) latest.siloParts = stack.siloParts;
        if (stack.partLabels) latest.partLabels = stack.partLabels;
        if (Number.isFinite(stack.latestWeighted)) latest.weighted = stack.latestWeighted;
      }
      points.push(latest);
    }
  }
  // When recorded history starts later than the default window, shift the left edge to
  // the first sample instead of showing empty void before data began filling in.
  if (points.length >= 2 && points[0].ts > start) {
    start = Math.min(points[0].ts, now - 600);
    if (future) {
      end = start + range;
      forecast = forecastPoints(items, metric, now, end, unitMode, lenient);
    }
  }
  // A drawn forecast brings the resets it applied; otherwise each window's next reported reset.
  // Untrimmed: the name only shows in the tooltip, where it must identify the account.
  const resetName = makeAccountNamer(items);
  const resets = (
    forecast.length
      ? forecast.resets
      : items
          .map(({ a, w }) => ({ ts: w.reset_at, a }))
          .filter((r) => r.ts > now && r.ts < end)
          .sort((a, b) => a.ts - b.ts)
  ).map((r) => ({ ts: r.ts, name: resetName(r.a), provider: r.a.provider }));
  const single = items.length === 1 && !stack?.order ? items[0] : null;
  const rawCap = single?.a?.silo ? capPercentFor(single.a, single.w) : null;
  const capOwner = single?.a?.silo ? (groupCapFor(single.a, single.w)?.owner ?? single.a.cap_owner) : null;
  const singleCapPct = rawCap && Number(rawCap) < 100 && capOwner !== "Owner override" ? Number(rawCap) : null;
  const singleFloor = singleCapPct ? Math.max(0, 100 - singleCapPct) : 0;
  const idle = forecast.length || !state.forecast ? "" : poolForecastPaused(items, now) ? "Forecast paused until quotas update" : "Forecast needs 10+ minutes of recent samples";
  const legendHtml = `<span class="legend"><i class="legend-line"></i>Recorded</span>${future ? '<span class="legend legend-proj"><i class="legend-line dashed"></i>Projected</span>' : ""}`;
  return renderTimePlot({
    key,
    points,
    forecast,
    start,
    end,
    now,
    cap,
    maxY,
    unitMode,
    stack,
    resets,
    rate: false,
    meta: {
      items,
      metric,
      order: stack?.order || null,
      totalWeight,
      singleCapPct,
      singleFloor,
    },
    legendHtml,
    idle,
    ariaLabel: `${label} quota history and forecast. Use left and right arrows to inspect recorded samples.`,
  });
}

function ratePlot(
  key,
  label,
  items,
  metric,
  unitMode = "raw",
  pointsOverride = null,
  stack = null,
  extraLegend = "",
  remainingSeries = null,
  isAll = false,
) {
  const now = state.data.now,
    range = state.hours * 3600;
  let start = now - range;
  const end = now;
  const points = pointsOverride ?? poolDrainSeries(items, metric, start, end, unitMode);
  if (points.length >= 2 && points[0].ts > start)
    start = Math.min(points[0].ts, now - 600);
  const peak = points.length ? Math.max(...points.map((p) => p.value)) : 0;
  const maxY = niceRateMax(peak, unitMode);
  const totalWeight = items.reduce((s, o) => s + accountWeight(o.a), 0);
  const single = items.length === 1 && !isAll ? items[0] : null;
  const rawCap = single?.a?.silo ? capPercentFor(single.a, single.w) : null;
  const capOwner = single?.a?.silo ? (groupCapFor(single.a, single.w)?.owner ?? single.a.cap_owner) : null;
  const singleCapPct = rawCap && Number(rawCap) < 100 && capOwner !== "Owner override" ? Number(rawCap) : null;
  const singleFloor = singleCapPct ? Math.max(0, 100 - singleCapPct) : 0;
  let avg = null;
  let idle = "Needs 10+ minutes of recent samples";
  if (points.length >= 2) {
    const segments = [];
    points.forEach((r) => {
      if (!segments.length || r.gap) segments.push([]);
      segments.at(-1).push(r);
    });
    let areaSum = 0,
      durSum = 0;
    for (const g of segments) {
      for (let i = 1; i < g.length; i++) {
        const dt = g[i].ts - g[i - 1].ts;
        areaSum += ((g[i - 1].value + g[i].value) / 2) * dt;
        durSum += dt;
      }
    }
    avg =
      durSum > 0
        ? areaSum / durSum
        : points.reduce((s, p) => s + p.value, 0) / points.length;
    idle = `Peak ${fmtRateVal(peak, unitMode)} · Avg ${fmtRateVal(avg, unitMode)}`;
  }
  const legendHtml = stack
    ? `<span>Rolling ${state.burn}h drain</span>${extraLegend}`
    : `<span class="legend"><i class="legend-line"></i>Rolling ${state.burn}h drain</span>${extraLegend}`;
  return renderTimePlot({
    key,
    points,
    forecast: [],
    start,
    end,
    now,
    cap: maxY,
    maxY,
    unitMode,
    stack,
    resets: [],
    rate: true,
    meta: {
      items,
      metric,
      order: isAll ? stack?.order || null : null,
      totalWeight,
      remainingSeries,
      singleCapPct,
      singleFloor,
      peakRate: peak,
      avgRate: avg,
    },
    legendHtml,
    idle,
    emptyTitle: "Collecting drain history",
    emptyBody:
      "Needs at least 10 minutes of recorded quota samples to plot drain rate over time.",
    ariaLabel: `${label} rolling ${state.burn}-hour drain rate history. Use left and right arrows to inspect recorded samples.`,
  });
}
const stackSwatch = (color, hatched = false) =>
  hatched
    ? `<i class="tip-swatch hatched-color" style="--swatch-color:${esc(color)}"></i>`
    : `<i class="tip-swatch" style="background:${esc(color)}"></i>`;
// Antigravity groups third-party (Claude & GPT) models separately from Gemini.
function isAgyClaudeWindow(w) {
  const text = `${w?.group || ""} ${w?.id || ""} ${w?.label || ""}`;
  if (/gemini|imagen?/i.test(text)) return false;
  return /claude|third.?party|\b3p\b|3p[-:_]/i.test(text);
}
function agyClaudeWindow(a, period) {
  const wins = (a?.windows || []).filter(isAgyClaudeWindow);
  if (!wins.length || !period) return null;
  const exact = wins.find((w) => w.period && Math.abs(w.period - period) <= 3600);
  if (exact) return exact;
  if (period <= 86400) {
    const short = wins.filter((w) => w.period && w.period <= 86400).sort((x, y) => x.period - y.period);
    if (short.length) return short[0];
  }
  return null;
}
function devinWindowFor(a, period) {
  const wins = a?.windows || [];
  if (!wins.length || !period) return null;
  const exact = wins.find((w) => w.period && Math.abs(w.period - period) <= 3600);
  if (exact) return exact;
  if (period <= 86400) {
    // Devin has no 5-hour window; its daily (shortest <= 24h) window stands in, matching All accounts.
    const short = wins.filter((w) => w.period && w.period <= 86400).sort((x, y) => x.period - y.period);
    return short[0] || wins.find((w) => w.id === "daily") || null;
  }
  return wins.find((w) => w.id === "weekly") || null;
}
function claudeExtraAccounts(provider) {
  return filteredAccounts(provider).filter((a) => !(a.disabled && !a.silo));
}
function claudeExtraSources(metric, list) {
  const agyAccounts = claudeExtraAccounts("antigravity");
  const devinAccounts = claudeExtraAccounts("devin");
  const hasAgy = agyAccounts.some((a) => !a.windows?.length || a.windows.some(isAgyClaudeWindow));
  const hasDevin = devinAccounts.length > 0;
  const win = list.find((w) => w.id === metric);
  const period =
    win?.period ||
    (metric === "five_hour" ? 5 * 3600 : metric === "seven_day" ? 7 * 86400 : null);
  const eligible = Boolean(period && !SCOPED_QUOTA.test(metric));
  const byProvider = { antigravity: [], devin: [] };
  if (eligible) {
    for (const a of agyAccounts) {
      const w = agyClaudeWindow(a, period);
      if (w) byProvider.antigravity.push({ a, w, metric: w.id });
    }
    for (const a of devinAccounts) {
      const w = devinWindowFor(a, period);
      if (w) byProvider.devin.push({ a, w, metric: w.id });
    }
  }
  const providers = byProviderOrder(
    ["antigravity", "devin"].filter((q) => byProvider[q].length > 0),
  );
  return {
    hasToggle: hasAgy || hasDevin,
    toggleLabel:
      hasAgy && hasDevin
        ? "Include AGY & Devin"
        : hasAgy
          ? "Include AGY"
          : "Include Devin",
    eligible,
    providers,
    byProvider,
    items: providers.flatMap((q) => byProvider[q]),
  };
}
function providerPoolHistory(items, gap) {
  const firstRow = new Map(),
    metaById = new Map(),
    allRows = [];
  for (const { a, w, metric } of items) {
    const rows = historyRows(a.id, metric);
    if (!rows.length) continue;
    firstRow.set(a.id, rows[0]);
    metaById.set(a.id, {
      silo: Boolean(a.silo),
      weight: accountWeight(a),
      apiUsd: windowApiUsd(a, w),
    });
    for (const r of rows) allRows.push(r);
  }
  const ids = [...firstRow.keys()];
  if (!ids.length) return [];
  const hasSilo = ids.some((id) => metaById.get(id).silo);
  allRows.sort((x, y) => x.ts - y.ts);
  const latest = new Map(firstRow),
    out = [];
  let lastTs = null;
  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i];
    latest.set(r.account, r);
    if (allRows[i + 1]?.ts === r.ts) continue;
    let raw = 0,
      units = 0,
      weight = 0,
      usd = 0,
      usdCap = 0,
      siloRaw = 0,
      siloUnits = 0,
      siloUsd = 0;
    for (const id of ids) {
      const rem = latest.get(id).remaining,
        m = metaById.get(id);
      raw += rem;
      units += (m.weight * rem) / 100;
      weight += m.weight;
      usd += (m.apiUsd * rem) / 100;
      usdCap += m.apiUsd;
      if (m.silo) {
        siloRaw += rem;
        siloUnits += (m.weight * rem) / 100;
        siloUsd += (m.apiUsd * rem) / 100;
      }
    }
    const pt = {
      ts: r.ts,
      raw,
      units,
      weight,
      pct: weight > 0 ? (units / weight) * 100 : 0,
      usd,
      usdCap,
      hasSilo,
      siloRaw,
      siloUnits,
      siloPct: weight > 0 ? (siloUnits / weight) * 100 : 0,
      siloUsd,
    };
    if (lastTs !== null && r.ts - lastTs > gap) pt.gap = true;
    out.push(pt);
    lastTs = r.ts;
  }
  return out;
}
function stackedPoolHistory(order, items, unitMode = "raw", hatched = []) {
  const gap = historyGap();
  const hatchedSet = new Set(hatched);
  const byProv = new Map();
  for (const q of order) {
    const pts = providerPoolHistory(
      items.filter((o) => o.a.provider === q),
      gap,
    );
    if (pts.length) byProv.set(q, pts);
  }
  const names = order.filter((q) => byProv.has(q));
  if (!names.length) return [];
  const firstTs = Object.fromEntries(names.map((q) => [q, byProv.get(q)[0].ts]));
  const minFirstTs = Math.min(...Object.values(firstTs));
  const latest = {};
  for (const q of names) {
    if (firstTs[q] <= minFirstTs + gap) latest[q] = byProv.get(q)[0];
  }
  const events = [];
  for (const q of names) {
    for (const pt of byProv.get(q)) events.push({ ts: pt.ts, q, pt });
  }
  events.sort((a, b) => a.ts - b.ts);
  const out = [];
  let lastTs = null,
    prevActive = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    latest[ev.q] = ev.pt;
    if (events[i + 1]?.ts === ev.ts) continue;
    const active = names.filter((q) => latest[q] !== undefined);
    if (!active.length) continue;
    const activeKey = active.join("|");
    let sumRaw = 0,
      sumUnits = 0,
      sumWeight = 0,
      sumUsd = 0,
      sumUsdCap = 0,
      sumPct = 0;
    for (const q of active) {
      const p = latest[q];
      sumRaw += p.raw;
      sumUnits += p.units;
      sumWeight += p.weight;
      sumUsd += p.usd;
      sumUsdCap += p.usdCap;
      sumPct += p.pct;
    }
    let value,
      parts,
      partLabels = null;
    const siloParts = {};
    let hasSilo = false;
    if (unitMode === "usd") {
      value = sumUsd;
      parts = Object.fromEntries(active.map((q) => [q, latest[q].usd]));
      for (const q of active)
        if (!hatchedSet.has(q) && latest[q].hasSilo) {
          siloParts[q] = latest[q].siloUsd;
          hasSilo = true;
        }
    } else if (unitMode === "usd_pct") {
      value = sumUsdCap > 0 ? (sumUsd / sumUsdCap) * 100 : 0;
      parts = Object.fromEntries(
        active.map((q) => [q, sumUsdCap > 0 ? (latest[q].usd / sumUsdCap) * 100 : 0]),
      );
      for (const q of active)
        if (!hatchedSet.has(q) && latest[q].hasSilo) {
          siloParts[q] = sumUsdCap > 0 ? (latest[q].siloUsd / sumUsdCap) * 100 : 0;
          hasSilo = true;
        }
    } else if (unitMode === "weighted") {
      value = sumPct / active.length;
      partLabels = Object.fromEntries(active.map((q) => [q, latest[q].pct]));
      parts = Object.fromEntries(active.map((q) => [q, latest[q].pct / active.length]));
      for (const q of active)
        if (!hatchedSet.has(q) && latest[q].hasSilo) {
          siloParts[q] = latest[q].siloPct / active.length;
          hasSilo = true;
        }
    } else if (unitMode === "units") {
      value = sumUnits;
      parts = Object.fromEntries(active.map((q) => [q, latest[q].units]));
      for (const q of active)
        if (!hatchedSet.has(q) && latest[q].hasSilo) {
          siloParts[q] = latest[q].siloUnits;
          hasSilo = true;
        }
    } else {
      value = sumRaw;
      parts = Object.fromEntries(active.map((q) => [q, latest[q].raw]));
      for (const q of active)
        if (!hatchedSet.has(q) && latest[q].hasSilo) {
          siloParts[q] = latest[q].siloRaw;
          hasSilo = true;
        }
    }
    const pt = {
      ts: ev.ts,
      value,
      parts,
      units: sumUnits,
      weight: sumWeight,
      usd: sumUsd,
      usd_cap: sumUsdCap,
    };
    if (partLabels) {
      pt.partLabels = partLabels;
      pt.weighted = value;
    }
    if (hasSilo) pt.siloParts = siloParts;
    if ((lastTs !== null && ev.ts - lastTs > gap) || (prevActive !== null && activeKey !== prevActive))
      pt.gap = true;
    out.push(pt);
    lastTs = ev.ts;
    prevActive = activeKey;
  }
  return out;
}
const PRIMARY_QUOTA_POOLS = ["claude", "antigravity"];

function cardExpandButton(id, label, isWide) {
  const action = isWide ? "Collapse" : "Expand";
  return `<button type="button" class="ghost icon-btn sm card-expand-btn" data-expand-card="${esc(id)}" aria-expanded="${Boolean(isWide)}" aria-label="${esc(`${action} ${label}`)}" title="${esc(`${action} ${label}`)}">${icon(isWide ? "collapse" : "expand")}</button>`;
}

// Compute the responsive bento layout for the Quotas "All" view.
// Desktop bands: [All accounts | Usage by project] (6+6), [Claude | Antigravity] (6+6),
// [Codex | xAI | Devin] (4+4+4). Expanding any card moves it full-width to the top of its
// band (most recently expanded first) and reflows its unexpanded siblings cleanly below.
// Stacked desktop (761-959px) emits span 12 so charts stay 1:1 with no stretching.
// Mobile keeps Overview full-width and packs collapsed provider tiles 2-up.
function quotasGridPlan(
  providers,
  { hasAll = true, hasUsage = true, wideCards = {}, expanded = {}, wideOrder = [], isMobile = false, isStacked = false, maxColsSecondary = 3 } = {},
) {
  const isWide = (id) => Boolean(wideCards?.[id] || expanded?.[id]);
  const orderList = Array.isArray(wideOrder) ? wideOrder : [];
  const wideKeys = Object.keys(wideCards || {});
  const expKeys = Object.keys(expanded || {});
  const wideRank = (id) => {
    const oi = orderList.lastIndexOf(id);
    if (oi >= 0) return 2000 + oi;
    const wi = wideKeys.indexOf(id);
    if (wi >= 0) return 1000 + wi;
    return expKeys.indexOf(id);
  };
  const sortRecent = (list) => [...list].sort((a, b) => wideRank(b) - wideRank(a));
  const cards = [];
  const spans = {};
  const add = (card) => {
    cards.push(card);
    spans[card.id] = card.span;
  };

  let band2 = providers.filter((p) => PRIMARY_QUOTA_POOLS.includes(p));
  let band3 = providers.filter((p) => !PRIMARY_QUOTA_POOLS.includes(p));
  if (providers.length === 3 && maxColsSecondary === 3 && !isMobile && !isStacked) {
    band2 = [];
    band3 = [...providers];
  } else if (band2.length === 1 && (band3.length === 1 || band3.length === 3)) {
    band2.push(band3.shift());
  }

  // Mobile: All accounts -> 2-up provider glance tiles (expanded first) -> Usage by project.
  if (isMobile) {
    if (hasAll) add({ id: "all", span: 12, wide: false, expandable: false, mobileSpanFull: true });
    const ordered = [...band2, ...band3];
    const wideList = sortRecent(ordered.filter(isWide));
    const compactList = ordered.filter((p) => !isWide(p));
    for (const p of wideList) {
      add({ id: p, span: 12, wide: true, expandable: true, mobileSpanFull: true });
    }
    compactList.forEach((p, idx) => {
      const lastOdd = compactList.length % 2 === 1 && idx === compactList.length - 1;
      add({ id: p, span: 6, wide: false, expandable: true, mobileSpanFull: lastOdd });
    });
    add({ id: "usage", span: 12, wide: false, expandable: false, mobileSpanFull: true, hidden: !hasUsage });
    return { cards, spans };
  }

  // Single-column desktop (761-959px): every card spans 12 with no compact squashing.
  if (isStacked) {
    if (hasAll) add({ id: "all", span: 12, wide: false, expandable: false, mobileSpanFull: true });
    add({ id: "usage", span: 12, wide: false, expandable: false, mobileSpanFull: true, hidden: !hasUsage });
    for (const p of [...band2, ...band3]) {
      add({ id: p, span: 12, wide: false, expandable: false, mobileSpanFull: true });
    }
    return { cards, spans };
  }

  // Band 1: Overview (All accounts + Usage by project)
  if (hasAll && hasUsage) {
    const allW = isWide("all"),
      usageW = isWide("usage");
    if (allW && usageW) {
      for (const id of sortRecent(["all", "usage"])) {
        add({ id, span: 12, wide: true, expandable: true, mobileSpanFull: true });
      }
    } else if (usageW) {
      add({ id: "usage", span: 12, wide: true, expandable: true, mobileSpanFull: true });
      add({ id: "all", span: 12, wide: false, expandable: false, mobileSpanFull: true });
    } else if (allW) {
      add({ id: "all", span: 12, wide: true, expandable: true, mobileSpanFull: true });
      add({ id: "usage", span: 12, wide: false, expandable: false, mobileSpanFull: true });
    } else {
      add({ id: "all", span: 6, wide: false, expandable: true, mobileSpanFull: true });
      add({ id: "usage", span: 6, wide: false, expandable: true, mobileSpanFull: true });
    }
  } else {
    if (hasAll) add({ id: "all", span: 12, wide: false, expandable: false, mobileSpanFull: true });
    add({ id: "usage", span: 12, wide: false, expandable: false, mobileSpanFull: true, hidden: !hasUsage });
  }

  const layoutBand = (list, maxCols) => {
    const canExpandBand = list.length > 1;
    const wideList = sortRecent(list.filter(isWide));
    const compactList = list.filter((p) => !isWide(p));
    for (const p of wideList) {
      add({ id: p, span: 12, wide: true, expandable: canExpandBand, mobileSpanFull: true });
    }
    for (let i = 0; i < compactList.length; i += maxCols) {
      const chunk = compactList.slice(i, i + maxCols);
      const span = 12 / chunk.length;
      for (const p of chunk) {
        add({ id: p, span, wide: false, expandable: span < 12, mobileSpanFull: false });
      }
    }
  };
  layoutBand(band2, 2);
  layoutBand(band3, maxColsSecondary);
  return { cards, spans };
}

function glanceWindowLabel(list, metric) {
  const w = (list || []).find((x) => x.id === metric);
  if (!w) return "";
  const base = windowName(w).replace(/ limit$/i, "");
  return w.group ? `${w.group} · ${base}` : base;
}

// Compact at-a-glance summary tile shown on mobile (<= 760px) when a provider card is collapsed.
function poolGlance(p, accounts, metric, list, extra) {
  const now = state.data.now,
    unitMode = state.unit,
    useExtra = Boolean(p === "claude" && state.claudeExtra && extra?.items?.length),
    baseItems = accounts.flatMap((a) => accountWindow(a, metric)),
    items = useExtra
      ? [...baseItems.map((o) => ({ ...o, metric })), ...extra.items]
      : baseItems,
    inUse = accounts.some((a) => a.in_use),
    winLabel = glanceWindowLabel(list, metric);
  let valText = "—",
    capText = "",
    pct = 0,
    statusText = "Not measured",
    statusTone = "muted",
    resetText = "—",
    rateText = "—",
    stale = false;
  if (items.length) {
    if (accounts.length === 1 && !useExtra) {
      const { a, w } = items[0],
        qs = quotaState(a, w),
        usdMode = unitMode === "usd",
        acctUnit = usdMode ? "usd" : "raw",
        apiUsd = windowApiUsd(a, w),
        split = drainSplitFor(a, metric, now),
        rateRaw = split ? split.total : null,
        rate = rateRaw !== null ? (usdMode ? rateRaw * (apiUsd / 100) : rateRaw) : null,
        forecasts = forecastPoints(items, metric, now, now + state.hours * 0.7 * 3600, acctUnit),
        next = nextReset(forecasts, items, now);
      stale = qs.stale;
      pct = Math.max(0, Math.min(100, w.remaining));
      valText = usdMode ? fmtApiUsd((apiUsd * w.remaining) / 100) : fmtPct(w.remaining);
      capText = usdMode ? `of ${fmtApiUsd(apiUsd)}` : "";
      if (qs.stale) {
        if (qs.c === "bad" || (qs.s !== "Ready" && qs.s !== "Quota available")) {
          statusText = qs.s;
          statusTone = qs.c || "warning";
          resetText = "Last known";
        } else {
          statusText = "Last known";
          statusTone = "muted";
          resetText = next ? `Reset ${relative(next)}` : w.remaining >= 100 ? "Full" : "—";
        }
      } else {
        statusText = qs.s === "Quota available" ? "Available" : qs.s;
        statusTone = qs.c || "muted";
        resetText = next ? `Reset ${relative(next)}` : w.remaining >= 100 ? "Full" : "—";
      }
      rateText = rate !== null ? fmtRateVal(rate, acctUnit) : "—";
    } else {
      const n = items.length,
        totalWeight = items.reduce((t, o) => t + accountWeight(o.a), 0),
        totalUsd = items.reduce((t, o) => t + windowApiUsd(o.a, o.w), 0),
        sumRaw = items.reduce((t, o) => t + o.w.remaining, 0),
        sumUnits = items.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0),
        sumUsd = items.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0);
      let avgWeighted = totalWeight > 0 ? (sumUnits / totalWeight) * 100 : 0;
      let order = [];
      if (useExtra) {
        order = baseItems.length ? ["claude", ...extra.providers] : [...extra.providers];
        const pctParts = {};
        order.forEach((q) => {
          const got = items.filter((o) => o.a.provider === q);
          const qw = got.reduce((t, o) => t + accountWeight(o.a), 0);
          const qu = got.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0);
          pctParts[q] = qw > 0 ? (qu / qw) * 100 : 0;
        });
        avgWeighted = order.length ? order.reduce((t, q) => t + pctParts[q], 0) / order.length : 0;
      }
      const displayVal =
          unitMode === "usd"
            ? sumUsd
            : unitMode === "usd_pct"
              ? totalUsd > 0 ? (sumUsd / totalUsd) * 100 : 0
              : unitMode === "weighted"
                ? avgWeighted
                : unitMode === "units"
                  ? sumUnits
                  : sumRaw,
        displayCap =
          unitMode === "usd"
            ? `of ${fmtApiUsd(totalUsd)}`
            : unitMode === "usd_pct"
              ? `of ${fmtApiUsd(totalUsd)}`
              : unitMode === "weighted"
                ? useExtra
                  ? `avg across ${order.length} provider${order.length === 1 ? "" : "s"}`
                  : `${fmtUnits(totalWeight)}`
                : unitMode === "units"
                  ? `of ${fmtUnits(totalWeight)}`
                  : `of ${n * 100}%`,
        last = items.filter((o) => quotaState(o.a, o.w).stale).length,
        live = items.filter((o) => !quotaState(o.a, o.w).stale),
        open = live.filter(usable).length,
        full = live.filter((o) => o.w.remaining <= 0).length,
        rate = useExtra
          ? (() => {
              const provRates = Object.fromEntries(
                order.map((q) => {
                  const pi = items.filter((o) => o.a.provider === q);
                  if (unitMode === "usd_pct") {
                    const r = poolDrain(pi, null, now, "usd");
                    return [q, r === null ? null : totalUsd > 0 ? (r / totalUsd) * 100 : 0];
                  }
                  return [q, poolDrain(pi, null, now, unitMode)];
                }),
              );
              const valid = order.map((q) => provRates[q]).filter((v) => v !== null);
              return valid.length && (provRates.claude !== null || !baseItems.length)
                ? unitMode === "weighted"
                  ? valid.reduce((a, b) => a + b, 0) / valid.length
                  : valid.reduce((a, b) => a + b, 0)
                : null;
            })()
          : poolDrain(items, metric, now, unitMode),
        forecasts = forecastPoints(items, useExtra ? null : metric, now, now + state.hours * 0.7 * 3600, unitMode, useExtra),
        next = nextReset(forecasts, items, now);
      stale = live.length === 0;
      const rawPct =
        unitMode === "usd"
          ? totalUsd > 0 ? (sumUsd / totalUsd) * 100 : 0
          : unitMode === "usd_pct" || unitMode === "weighted"
            ? displayVal
            : unitMode === "units"
              ? totalWeight > 0 ? (sumUnits / totalWeight) * 100 : 0
              : n > 0 ? sumRaw / n : 0;
      pct = Math.max(0, Math.min(100, rawPct));
      valText = fmtChartVal(displayVal, unitMode);
      capText = displayCap;
      if (stale) {
        statusText = "Last known";
        statusTone = "muted";
      } else if (open > 0) {
        statusText = last > 0 ? `${open}/${n} available · ${last} stale` : `${open}/${n} available`;
        statusTone = "good";
      } else {
        statusText = full === n ? "At limit" : "Unavailable";
        statusTone = "warning";
      }
      resetText = next ? `Reset ${relative(next)}` : items.every((o) => o.w.remaining >= 100) ? "Full" : "—";
      rateText = rate !== null ? fmtRateVal(rate, unitMode) : "—";
    }
  }
  const activeDot = inUse ? '<i class="live-dot" aria-hidden="true" title="In use"></i>' : "";
  const winHtml = winLabel ? `<span class="glance-win">${esc(winLabel)}</span>` : "";
  return `<button type="button" class="pool-glance" data-expand-card="${esc(p)}" aria-expanded="false"><span class="glance-head"><span class="glance-id">${providerIcon(p)}<span class="glance-name">${esc(pName(p))}</span>${activeDot}</span><span class="glance-icon" aria-hidden="true">${icon("expand")}</span></span><span class="glance-val"><strong>${morph(esc(valText))}</strong>${capText ? `<small>${esc(capText)}</small>` : ""}</span><span class="glance-bar${stale ? " stale" : ""}${statusTone !== "good" && pct <= 0 ? " empty" : ""}" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></span><span class="glance-meta"><span class="glance-status ${esc(statusTone)}">${esc(statusText)}</span><span class="glance-reset">${esc(resetText)}</span></span><span class="glance-foot"><span class="glance-burn">Burn ${esc(rateText)}</span>${winHtml}</span><span class="sr-only"> — Expand ${esc(pName(p))} details</span></button>`;
}

// One block per account under a shared provider header: each account keeps
// its own figure, forecast and chart instead of a summed pool.
function pool(p, opts = {}) {
  const { span = 12, wide = false, expandable = false, mobileSpanFull = false } = opts;
  const accounts = filteredAccounts(p);
  if (!accounts.length) return "";
  const metric = selectedWindow(p, accounts),
    list = allWindows(accounts),
    extra = p === "claude" ? claudeExtraSources(metric, list) : null,
    total = totalQuota(p, accounts, metric, list, extra),
    cards = accounts.map((a, i) => accountQuota(p, a, i, metric, list)).join("");
  const toggleHtml =
    extra?.hasToggle
      ? `<label class="pool-toggle" title="Stack Claude-capable quota from Antigravity (Claude &amp; GPT) and Devin on the Claude chart"><button type="button" class="switch" role="switch" aria-checked="${Boolean(state.claudeExtra)}" data-claude-extra aria-label="${esc(extra.toggleLabel)}"><span class="switch-thumb"></span></button><span>${esc(extra.toggleLabel)}</span></label>`
      : "";
  const countText =
    p === "claude" && state.claudeExtra && extra?.items?.length
      ? `${accounts.length} Claude + ${extra.items.length} extra`
      : `${accounts.length} account${accounts.length === 1 ? "" : "s"}`;
  const expandBtn = expandable ? cardExpandButton(p, pName(p), wide) : "";
  // With a pooled total on top, the per-account charts start collapsed into
  // one row per account; the provider view stays short, especially on phones.
  const body =
    accounts.length > 1 || Boolean(total)
      ? `${total}<details class="pool-accounts" data-accounts="${esc(p)}"${state.expanded[p] ? " open" : ""}><summary><span class="pool-accounts-title">${icon("chevron")}<span class="pool-accounts-hint"></span></span></summary>${cards}</details><div class="acct-rows">${accounts.map((a, i) => accountRow(a, i, metric)).join("")}</div>`
      : cards;
  const glance = expandable && innerWidth <= 760 ? poolGlance(p, accounts, metric, list, extra) : "";
  const cls = `pool provider-${p} card-span-${span}${wide ? " card-wide" : ""}${mobileSpanFull ? " mobile-span-full" : ""}`;
  return `<section class="${cls}" data-pool="${p}">${glance}<div class="pool-full"><div class="pool-top">${providerIcon(p)}<h2>${pName(p)}</h2><span class="muted">${esc(countText)}</span>${toggleHtml}${windowPicker(p, list, metric)}${expandBtn}</div>${body}</div></section>`;
}
// Has quota left in this window and the proxy will route to it right now.
const usable = ({ a, w }) => quotaState(a, w).s === "Quota available";
// Availability of a pooled card's items: "open" must be usable and a fresh reading.
// rest: the accounts that report nothing for this window (no windows at all, or none like it).
function capacity(items, rest = []) {
  // Stale readings are only ever "last known"; the rest are classified fresh.
  const last = items.filter((o) => quotaState(o.a, o.w).stale).length,
    live = items.filter((o) => !quotaState(o.a, o.w).stale),
    n = items.length,
    open = live.filter(usable).length,
    full = live.filter((o) => o.w.remaining <= 0).length,
    blocked = live.filter((o) => o.w.remaining > 0 && !usable(o)).length,
    unmeasured = rest.filter((a) => !a.windows.length).length,
    offPlan = rest.length - unmeasured;
  return {
    tag: open
      ? [`${open} of ${n} available`, "good"]
      : [full === n ? "All at a limit" : "None available", "warning"],
    note: [full && `${full} at a limit`, blocked && `${blocked} unavailable`, last && `${last} last known`, unmeasured && `${unmeasured} not measured`, offPlan && `${offPlan} N/A`]
      .filter(Boolean)
      .join(" · "),
  };
}
const notInRangeLabel = () => "Beyond forecast";
// Next reset cell: a full window with nothing scheduled reads "Full"; the title only when there is a date.
const nextDd = (next, full) =>
  `<dd${next ? ` title="${esc(dateLabel(next))}"` : ""}>${morph(next ? esc(relative(next)) : full ? "Full" : "Not reported")}</dd>`;
// Quota freshness and the status tag an account's quota card shows.
function quotaState(a, w) {
  const now = state.data.now,
    stale = !!(a.quota_error || !a.quota_at || now - a.quota_at > 900 ||
      (w?.reset_at && w.reset_at <= now && a.quota_at < w.reset_at && w.remaining < 100)),
    seat = status(a),
    group = a.silo ? groupCapFor(a, w) : null,
    routing = seat[0] === "Paused"
      ? seat
      : group?.capped
        ? ["Capped", "warning"]
        : group?.capped === false && seat[0] === "Partial cap" ? routingStatus(a) : seat,
    quotaCooldown = routing[0] === "Cooling down" &&
      a.cooldowns.every((c) => ["credential_quota", "quota"].includes(c.reason)),
    // A quota cooldown with room left here is held by another window that is empty right now.
    holder = quotaCooldown && w && !stale && w.remaining > 0 && blockingWindows(a, w, now)[0],
    [s, c] = holder
      ? [holder.label, "warning"]
      : w && !stale && (routing[0] === "Ready" || (quotaCooldown && w.remaining <= 0))
        ? (w.remaining > 0 ? ["Quota available", "good"] : ["Limit reached", "warning"])
        : routing;
  return { stale, routing, s, c, holder: !!holder };
}
// Projected remaining quota at reset for one account window, split into our hub usage
// (white marker) and additional external usage on shared Idlenet seats (orange marker).
function quotaProjection(a, w, now = state.data?.now) {
  if (
    !w ||
    !state.forecast ||
    w.remaining <= 0 ||
    !(w.reset_at > now) ||
    staleReading({ a, w }, now)
  )
    return null;
  const split = drainSplitFor(a, w.id, now);
  if (!split || split.total <= 1e-6) return null;
  const hoursLeft = (w.reset_at - now) / 3600;
  const rem = Math.max(0, Math.min(100, w.remaining));
  const projOurs = Math.max(0, rem - split.ours * hoursLeft);
  const projTotal = Math.max(0, rem - split.total * hoursLeft);
  return {
    rem,
    oursRate: split.ours,
    extRate: split.external,
    totalRate: split.total,
    projOurs,
    projTotal,
    hasOurs: split.ours > 1e-6,
    hasExternal: split.external > 1e-6,
    runsOutAt: split.total > 0 ? now + (rem / split.total) * 3600 : null,
  };
}
function quotaMeter(a, w, stale = false) {
  const v = w ? Math.max(0, Math.min(100, w.remaining)) : 0;
  const proj = !stale && w ? quotaProjection(a, w, state.data.now) : null;
  let slices = "";
  let ticks = "";
  let tip = "";
  if (proj) {
    if (proj.hasOurs && proj.rem - proj.projOurs > 0.1)
      slices += `<i class="meter-drain ours" style="left:${proj.projOurs.toFixed(2)}%;width:${(proj.rem - proj.projOurs).toFixed(2)}%"></i>`;
    if (proj.hasExternal && proj.projOurs - proj.projTotal > 0.1)
      slices += `<i class="meter-drain external" style="left:${proj.projTotal.toFixed(2)}%;width:${(proj.projOurs - proj.projTotal).toFixed(2)}%"></i>`;
    if (proj.hasOurs)
      ticks += `<i class="meter-tick ours" style="left:${proj.projOurs.toFixed(2)}%"></i>`;
    if (proj.hasExternal) {
      const extLeft =
        proj.hasOurs && proj.projOurs - proj.projTotal <= 0.25
          ? `calc(${proj.projTotal.toFixed(2)}% + 3px)`
          : `${proj.projTotal.toFixed(2)}%`;
      ticks += `<i class="meter-tick external" style="left:${extLeft}"></i>`;
    }
    if (proj.hasExternal) {
      const oursText = proj.hasOurs
        ? `Ours ${fmtRateVal(proj.oursRate)} (→ ${proj.projOurs <= 0.05 ? "0%" : fmtPct(proj.projOurs)})`
        : "Ours 0%/h";
      const extText = `Other users +${fmtRateVal(proj.extRate)} (→ ${proj.projTotal <= 0.05 ? `runs out ${relative(proj.runsOutAt)}` : `${fmtPct(proj.projTotal)} at reset`})`;
      tip = `${fmtPct(proj.rem)} left · ${oursText} · ${extText}`;
    } else {
      tip =
        proj.projOurs <= 0.05
          ? `${fmtPct(proj.rem)} left · Burning ${fmtRateVal(proj.oursRate)} · Runs out ${relative(proj.runsOutAt)} (before reset)`
          : `${fmtPct(proj.rem)} left · Burning ${fmtRateVal(proj.oursRate)} · Projected ${fmtPct(proj.projOurs)} at reset`;
    }
  }
  return `<div class="meter meter-quota${w && w.remaining <= 0 ? " full" : ""}${stale ? " stale" : ""}"${tip ? ` title="${esc(tip)}"` : ""}><div class="meter-track"><div class="meter-fill" style="transform:scaleX(${v / 100})"></div>${slices}</div>${ticks}</div>`;
}
function weightBadge(a) {
  const w = fmtUnits(accountWeight(a));
  return `<span class="acct-weight" title="Capacity weight: ${esc(w)}">${esc(w)}</span>`;
}
// Compact row for a collapsed account: name, meter, remaining, then the next reset
// or whatever makes that number less than current (stale, paused, cooling down).
function accountRow(a, i, metric, showWeight = true) {
  const items = accountWindow(a, metric),
    w = items[0]?.w,
    now = state.data.now,
    { stale, routing, s, c } = quotaState(a, w),
    label = accountLabel(a, i),
    weightTag = showWeight ? weightBadge(a) : "",
    // Same value as the expanded card's "Next reset".
    next = w && nextReset(forecastPoints(items, metric, now, now + state.hours * 0.7 * 3600), items, now),
    note = !w
      ? a.windows.length ? "N/A" : "Not measured"
      : routing[0] !== "Ready" || (!stale && w.remaining <= 0)
        ? `<span class="tag ${c}" title="${esc(statusReason(a, w))}">${esc(s)}</span>`
        : stale
          ? "Last known"
          : next
            ? esc(relative(next))
            : w.remaining >= 100
              ? "Full"
              : "—";
  return `<div class="acct-row" data-row="${esc(a.id)}"${a.in_use ? ' data-in-use="true"' : ""}><span class="acct-label-wrap"><a class="mini-label" href="${accountPath(a)}" data-open-account="${esc(a.id)}" title="${esc(label)}">${esc(label)}</a>${weightTag}${cycloneBadge(a, true)}${useBadge(a, true)}</span>${quotaMeter(a, w, stale)}<span class="mini-value">${morph(w ? fmtPct(w.remaining) : "—")}</span><span class="acct-reset">${note}</span></div>`;
}
function projectPoolSeries(series, unitMode, fallbackCount, items = []) {
  if (!series?.length) return [];
  if (unitMode === "raw")
    return series.map((r) => (r.silo_value !== undefined ? { ...r, silo: r.silo_value } : r));
  const totalWeight = items.reduce((t, o) => t + accountWeight(o.a), 0);
  const totalUsd = items.reduce((t, o) => t + windowApiUsd(o.a, o.w), 0);
  const usdPer1x = totalWeight > 0 ? totalUsd / totalWeight : 25;
  return series.map((r) => {
    const units = Number.isFinite(r.units) ? r.units : r.value / 100;
    const weight = Number.isFinite(r.weight) && r.weight > 0 ? r.weight : fallbackCount || 1;
    const hasSilo = Number.isFinite(r.silo_units) || Number.isFinite(r.silo_value) || Number.isFinite(r.silo_usd);
    const siloUnits = Number.isFinite(r.silo_units) ? r.silo_units : (Number.isFinite(r.silo_value) ? r.silo_value / 100 : 0);
    const out = {
      ...r,
      value:
        unitMode === "usd"
          ? Number.isFinite(r.usd) ? r.usd : units * usdPer1x
          : unitMode === "usd_pct"
            ? (() => {
                const usd = Number.isFinite(r.usd) ? r.usd : units * usdPer1x;
                const capUsd = Number.isFinite(r.usd_cap) && r.usd_cap > 0 ? r.usd_cap : weight * usdPer1x;
                return capUsd > 0 ? (usd / capUsd) * 100 : 0;
              })()
            : unitMode === "units"
              ? units
              : (units / weight) * 100,
    };
    if (hasSilo) {
      out.silo =
        unitMode === "usd"
          ? Number.isFinite(r.silo_usd) ? r.silo_usd : siloUnits * usdPer1x
          : unitMode === "usd_pct"
            ? (() => {
                const sUsd = Number.isFinite(r.silo_usd) ? r.silo_usd : siloUnits * usdPer1x;
                const capUsd = Number.isFinite(r.usd_cap) && r.usd_cap > 0 ? r.usd_cap : weight * usdPer1x;
                return capUsd > 0 ? (sUsd / capUsd) * 100 : 0;
              })()
            : unitMode === "units"
              ? siloUnits
              : (siloUnits / weight) * 100;
    }
    return out;
  });
}
// One pooled card per provider: remaining quota over the accounts that report
// this window, displayed in the selected unit mode (CU, Pool %, x units, or Raw %).
function totalQuota(p, accounts, metric, list, extra = null) {
  const baseItems = accounts.flatMap((a) => accountWindow(a, metric));
  const useExtra = Boolean(p === "claude" && state.claudeExtra && extra?.items?.length);
  if (useExtra) {
    const claudeItems = baseItems.map((o) => ({ ...o, metric }));
    const items = [...claudeItems, ...extra.items];
    const order = claudeItems.length ? ["claude", ...extra.providers] : [...extra.providers];
    const hatched = [...extra.providers];
    const now = state.data.now,
      n = items.length,
      unitMode = state.unit,
      rawParts = {},
      unitParts = {},
      usdParts = {},
      pctParts = {},
      siloRawParts = {},
      siloUnitParts = {},
      siloUsdParts = {},
      siloPctParts = {};
    let hasClaudeSilo = false;
    for (const q of order) {
      const got = items.filter((o) => o.a.provider === q);
      const qWeight = got.reduce((t, o) => t + accountWeight(o.a), 0);
      const qUnits = got.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0);
      const qUsd = got.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0);
      rawParts[q] = got.reduce((t, o) => t + o.w.remaining, 0);
      unitParts[q] = qUnits;
      usdParts[q] = qUsd;
      pctParts[q] = qWeight > 0 ? (qUnits / qWeight) * 100 : 0;
      if (!hatched.includes(q)) {
        const siloGot = got.filter((o) => o.a.silo);
        if (siloGot.length) {
          hasClaudeSilo = true;
          const sUnits = siloGot.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0);
          const sUsd = siloGot.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0);
          siloRawParts[q] = siloGot.reduce((t, o) => t + o.w.remaining, 0);
          siloUnitParts[q] = sUnits;
          siloUsdParts[q] = sUsd;
          siloPctParts[q] = qWeight > 0 ? (sUnits / qWeight) * 100 : 0;
        }
      }
    }
    const totalWeight = items.reduce((t, o) => t + accountWeight(o.a), 0),
      totalUsd = items.reduce((t, o) => t + windowApiUsd(o.a, o.w), 0),
      sumRaw = items.reduce((t, o) => t + o.w.remaining, 0),
      sumUnits = items.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0),
      sumUsd = items.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0),
      avgWeighted = order.length ? order.reduce((t, q) => t + pctParts[q], 0) / order.length : 0,
      displayVal =
        unitMode === "usd"
          ? sumUsd
          : unitMode === "usd_pct"
            ? totalUsd > 0 ? (sumUsd / totalUsd) * 100 : 0
            : unitMode === "weighted"
              ? avgWeighted
              : unitMode === "units"
                ? sumUnits
                : sumRaw,
      displayCap =
        unitMode === "usd"
          ? `of ${fmtApiUsd(totalUsd)}`
          : unitMode === "usd_pct"
            ? `of ${fmtApiUsd(totalUsd)} pool`
            : unitMode === "weighted"
              ? `avg across ${order.length} provider${order.length === 1 ? "" : "s"}`
              : unitMode === "units"
                ? `of ${fmtUnits(totalWeight)}`
                : `of ${n * 100}%`,
      { tag: [s, c], note } = capacity(items, accounts.filter((a) => !accountWindow(a, metric).length)),
      provRates = Object.fromEntries(
        order.map((q) => {
          const provItems = items.filter((o) => o.a.provider === q);
          if (unitMode === "usd_pct") {
            const usdRate = poolDrain(provItems, null, now, "usd");
            return [q, usdRate === null ? null : totalUsd > 0 ? (usdRate / totalUsd) * 100 : 0];
          }
          return [q, poolDrain(provItems, null, now, unitMode)];
        }),
      ),
      validRates = order.map((q) => provRates[q]).filter((r) => r !== null),
      rate =
        validRates.length && (provRates.claude !== null || !claudeItems.length)
          ? unitMode === "weighted"
            ? validRates.reduce((t, r) => t + r, 0) / validRates.length
            : validRates.reduce((t, r) => t + r, 0)
          : null,
      anyRate = items.some(({ a, metric: own }) => drainFor(a, own ?? metric, now) !== null),
      forecasts = anyRate
        ? forecastPoints(items, null, now, now + state.hours * 0.7 * 3600, unitMode, true)
        : [],
      next = nextReset(forecasts, items, now),
      empty = forecasts.find((r) => r.exhausted || r.value <= 0.01);
    const head = `<div class="account-pool-head"><span class="mini-name"><span class="mini-label">Total</span><span class="mini-plan">incl. ${esc(extra.providers.map(pName).join(" & "))}</span></span><span class="tag ${c}">${morph(s)}</span></div>`;
    const remSeries = stackedPoolHistory(order, items, unitMode, hatched);
    let chart;
    if (state.view === "remaining") {
      const stackParts =
        unitMode === "usd"
          ? usdParts
          : unitMode === "usd_pct"
            ? Object.fromEntries(order.map((q) => [q, totalUsd > 0 ? (usdParts[q] / totalUsd) * 100 : 0]))
            : unitMode === "weighted"
              ? Object.fromEntries(order.map((q) => [q, pctParts[q] / Math.max(1, order.length)]))
              : unitMode === "units"
                ? unitParts
                : rawParts;
      const stackSiloParts = hasClaudeSilo
        ? unitMode === "usd"
          ? siloUsdParts
          : unitMode === "usd_pct"
            ? Object.fromEntries(Object.entries(siloUsdParts).map(([q, v]) => [q, totalUsd > 0 ? (v / totalUsd) * 100 : 0]))
            : unitMode === "weighted"
              ? Object.fromEntries(Object.entries(siloPctParts).map(([q, v]) => [q, v / Math.max(1, order.length)]))
              : unitMode === "units"
                ? siloUnitParts
                : siloRawParts
        : null;
      const partLabels = unitMode === "weighted" ? pctParts : null;
      const legendParts = unitMode === "weighted" ? pctParts : stackParts;
      const rows = order
        .map(
          (q) =>
            `<span class="legend">${stackSwatch(`var(--provider-${q})`, hatched.includes(q))}${esc(pName(q))} ${esc(fmtChartVal(legendParts[q], unitMode))}</span>`,
        )
        .join("");
      chart = plot(
        `${p}-total`,
        `${pName(p)} total`,
        items,
        null,
        remSeries,
        {
          order,
          parts: stackParts,
          siloParts: stackSiloParts,
          partLabels,
          hatched,
          latestValue: displayVal,
          latestWeighted: avgWeighted,
          lenient: anyRate,
        },
        unitMode,
      ).replace('<span class="chart-inspect"', () => `${rows}<span class="chart-inspect"`);
    } else {
      const drainPts = allDrainSeries(order, items, now - state.hours * 3600, now, unitMode);
      const latestParts = drainPts.at(-1)?.partLabels || drainPts.at(-1)?.parts || {};
      const rows = order
        .map((q) => {
          const v = provRates[q] ?? latestParts[q];
          return `<span class="legend">${stackSwatch(`var(--provider-${q})`, hatched.includes(q))}${esc(pName(q))}${Number.isFinite(v) ? ` ${esc(fmtRateVal(v, unitMode))}` : ""}</span>`;
        })
        .join("");
      chart = ratePlot(
        `${p}-total-drain`,
        `${pName(p)} total`,
        items,
        null,
        unitMode,
        drainPts,
        { order, hatched },
        rows,
        remSeries,
        true,
      );
    }
    return `<div class="account-pool pool-sum" data-account="total-${esc(p)}">${head}<div class="pool-total"><div><div class="big-number">${morph(fmtChartVal(displayVal, unitMode))}<small>${esc(displayCap)}</small></div>${note ? `<div class="capacity-note">${esc(note)}</div>` : ""}</div><dl class="metrics"><div class="metric"><dt>Runs out</dt><dd>${morph(empty ? empty.ts <= now ? "Now" : esc(dateLabel(empty.ts)) : rate === 0 || !state.forecast ? "—" : forecasts.length ? esc(notInRangeLabel()) : poolForecastPaused(items, now) ? "Paused" : "Collecting history")}</dd></div><div class="metric"><dt>Next reset</dt>${nextDd(next, items.every((o) => o.w.remaining >= 100))}</div><div class="metric"><dt>Burn, last ${state.burn}h</dt><dd>${morph(rate !== null ? fmtRateVal(rate, unitMode) : "—")}</dd></div></dl></div>${chart}</div>`;
  }
  const items = baseItems;
  // One account's total is that account's own card.
  // A provider with 2+ accounts always shows a total, even if only one reports
  // this window, so its accounts can stay collapsed underneath.
  if (!items.length || (items.length < 2 && accounts.length < 2)) return "";
  const now = state.data.now,
    n = items.length,
    unitMode = state.unit,
    totalWeight = items.reduce((t, o) => t + accountWeight(o.a), 0),
    totalUsd = items.reduce((t, o) => t + windowApiUsd(o.a, o.w), 0),
    unitsSum = items.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0),
    usdSum = items.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0),
    rawSum = items.reduce((t, o) => t + o.w.remaining, 0),
    displayVal =
      unitMode === "usd"
        ? usdSum
        : unitMode === "usd_pct"
          ? totalUsd > 0 ? (usdSum / totalUsd) * 100 : 0
          : unitMode === "weighted"
            ? totalWeight > 0 ? (unitsSum / totalWeight) * 100 : 0
            : unitMode === "units"
              ? unitsSum
              : rawSum,
    displayCap =
      unitMode === "usd" || unitMode === "usd_pct"
        ? `of ${fmtApiUsd(totalUsd)}`
        : unitMode === "weighted"
          ? `of ${fmtUnits(totalWeight)} pool`
          : unitMode === "units"
            ? `of ${fmtUnits(totalWeight)}`
            : `of ${n * 100}%`,
    calNote = unitMode === "usd" || unitMode === "usd_pct" ? windowCalibrationNote(p, items) : "",
    { tag: [s, c], note } = capacity(items, accounts.filter((a) => !accountWindow(a, metric).length)),
    rate = poolDrain(items, metric, now, unitMode),
    demandUnits = poolDrain(items, metric, now, "units"),
    demandUsd = poolDrain(items, metric, now, "usd"),
    rateTitle =
      unitMode === "usd"
        ? [demandUnits !== null ? `${fmtUnits(demandUnits)}/h across ${fmtUnits(totalWeight)} pool` : "", calNote].filter(Boolean).join(" · ")
        : unitMode === "usd_pct"
          ? [demandUsd !== null ? `~${fmtRateVal(demandUsd, "usd")} of ${fmtApiUsd(totalUsd)}` : "", calNote].filter(Boolean).join(" · ")
          : demandUnits !== null && unitMode === "weighted"
            ? `${fmtUnits(demandUnits)}/h across ${fmtUnits(totalWeight)} pool${demandUsd !== null ? ` (~${fmtRateVal(demandUsd, "usd")})` : ""}`
            : "",
    forecasts = forecastPoints(items, metric, now, now + state.hours * 0.7 * 3600, unitMode),
    next = nextReset(forecasts, items, now),
    empty = forecasts.find((r) => r.exhausted || r.value <= 0.01);
  const head = `<div class="account-pool-head"><span class="mini-name"><span class="mini-label">Total</span></span><span class="tag ${c}">${morph(s)}</span></div>`;
  const series = projectPoolSeries(state.data.totals?.[p]?.[metric], unitMode, n, items);
  return `<div class="account-pool pool-sum" data-account="total-${esc(p)}">${head}<div class="pool-total"><div${calNote ? ` title="${esc(calNote)}"` : ""}><div class="big-number">${morph(fmtChartVal(displayVal, unitMode))}<small>${esc(displayCap)}</small></div>${note ? `<div class="capacity-note">${esc(note)}</div>` : ""}</div><dl class="metrics"><div class="metric"><dt>Runs out</dt><dd>${morph(empty ? empty.ts <= now ? "Now" : esc(dateLabel(empty.ts)) : rate === 0 || !state.forecast ? "—" : forecasts.length ? esc(notInRangeLabel()) : poolForecastPaused(items, now) ? "Paused" : "Collecting history")}</dd></div><div class="metric"><dt>Next reset</dt>${nextDd(next, items.every((o) => o.w.remaining >= 100))}</div><div class="metric"><dt>Burn, last ${state.burn}h</dt><dd${rateTitle ? ` title="${esc(rateTitle)}"` : ""}>${morph(rate !== null ? fmtRateVal(rate, unitMode) : "—")}</dd></div></dl></div>${state.view === "remaining" ? plot(`${p}-total`, `${pName(p)} total`, items, metric, series, null, unitMode) : ratePlot(`${p}-total-drain`, `${pName(p)} total`, items, metric, unitMode, null, null, "", series)}</div>`;
}
// Every quota-tracked account of every provider: stacked by provider, so the height is
// the pooled remaining quota and each band is that provider's share.
function allQuota(opts = {}) {
  const { span = 12, wide = false, expandable = false } = opts;
  const key = state.allWindow,
    totals = state.data.totals?.all?.[key],
    now = state.data.now,
    unitMode = state.unit;
  if (!state.data.totals?.all) return "";
  const expandBtn = expandable ? cardExpandButton("all", "All accounts", wide) : "";
  const cardCls = `pool pool-all card-span-${span}${wide ? " card-wide" : ""}`;
  // Disabled accounts are out of the whole total, as in the server's stack.
  const allAccounts = (q) => filteredAccounts(q).filter((a) => !(a.disabled && !a.silo));
  const order = byProviderOrder(Object.keys(totals?.metrics || {})),
    rawParts = {},
    unitParts = {},
    usdParts = {},
    pctParts = {},
    siloRawParts = {},
    siloUnitParts = {},
    siloUsdParts = {},
    siloPctParts = {},
    items = [];
  let hasAnySilo = false;
  order.forEach((q) => {
    const got = allAccounts(q).flatMap((a) =>
      accountWindow(a, totals.metrics[q]).map((o) => ({ ...o, metric: totals.metrics[q] })),
    );
    const qWeight = got.reduce((t, o) => t + accountWeight(o.a), 0);
    const qUnits = got.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0);
    const qUsd = got.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0);
    rawParts[q] = got.reduce((t, o) => t + o.w.remaining, 0);
    unitParts[q] = qUnits;
    usdParts[q] = qUsd;
    pctParts[q] = qWeight > 0 ? (qUnits / qWeight) * 100 : 0;
    const siloGot = got.filter((o) => o.a.silo);
    if (siloGot.length) {
      hasAnySilo = true;
      const sUnits = siloGot.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0);
      const sUsd = siloGot.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0);
      siloRawParts[q] = siloGot.reduce((t, o) => t + o.w.remaining, 0);
      siloUnitParts[q] = sUnits;
      siloUsdParts[q] = sUsd;
      siloPctParts[q] = qWeight > 0 ? (sUnits / qWeight) * 100 : 0;
    }
    items.push(...got);
  });
  const tabs = `<div class="segmented sm pool-windows" role="group" aria-label="Quota window for all accounts">${[["5h", "5-hour"], ["7d", "Weekly"]].map(([k, t]) => `<button data-all-win="${k}" ${choice(key === k)}>${t}</button>`).join("")}</div>`;
  // Keep the card and its picker so the other window stays one tap away.
  if (items.length < 2)
    return `<section class="${cardCls}" data-pool="all"><div class="account-pool pool-sum" data-account="total-all"><div class="account-pool-head"><span class="mini-name"><span class="mini-label">All accounts</span></span>${tabs}${expandBtn}</div><p class="mini-none">Not enough accounts report this window</p></div></section>`;
  const n = items.length,
    totalWeight = items.reduce((t, o) => t + accountWeight(o.a), 0),
    totalUsd = items.reduce((t, o) => t + windowApiUsd(o.a, o.w), 0),
    sumRaw = items.reduce((t, o) => t + o.w.remaining, 0),
    sumUnits = items.reduce((t, o) => t + (accountWeight(o.a) * o.w.remaining) / 100, 0),
    sumUsd = items.reduce((t, o) => t + (windowApiUsd(o.a, o.w) * o.w.remaining) / 100, 0),
    avgWeighted = order.length ? order.reduce((t, q) => t + pctParts[q], 0) / order.length : 0,
    displayVal =
      unitMode === "usd"
        ? sumUsd
        : unitMode === "usd_pct"
          ? totalUsd > 0 ? (sumUsd / totalUsd) * 100 : 0
          : unitMode === "weighted"
            ? avgWeighted
            : unitMode === "units"
              ? sumUnits
              : sumRaw,
    displayCap =
      unitMode === "usd"
        ? `of ${fmtApiUsd(totalUsd)}`
        : unitMode === "usd_pct"
          ? `of ${fmtApiUsd(totalUsd)} pool`
          : unitMode === "weighted"
            ? `avg across ${order.length} provider${order.length === 1 ? "" : "s"}`
            : unitMode === "units"
              ? `of ${fmtUnits(totalWeight)}`
              : `of ${n * 100}%`,
    { tag: [s, c], note } = capacity(items, QUOTA_PROVIDERS.flatMap((q) => allAccounts(q).filter((a) => !accountWindow(a, totals.metrics?.[q]).length))),
    next = nextReset(forecastPoints(items, null, now, now + state.hours * 0.7 * 3600, unitMode, true), items, now);
  const head = `<div class="account-pool-head"><span class="mini-name"><span class="mini-label">All accounts</span></span><span class="tag ${c}">${morph(s)}</span>${tabs}${expandBtn}</div>`;
  const provRates = Object.fromEntries(
    order.map((q) => {
      const provItems = items.filter((o) => o.a.provider === q);
      if (unitMode === "usd_pct") {
        const usdRate = poolDrain(provItems, null, now, "usd");
        return [q, usdRate === null ? null : totalUsd > 0 ? (usdRate / totalUsd) * 100 : 0];
      }
      return [q, poolDrain(provItems, null, now, unitMode)];
    }),
  );
  const validRates = order.map((q) => provRates[q]).filter((r) => r !== null);
  const combinedRate = validRates.length > 0
    ? unitMode === "weighted"
      ? validRates.reduce((t, r) => t + r, 0) / order.length
      : validRates.reduce((t, r) => t + r, 0)
    : null;
  const remSeries = (totals.points || []).map((r) => {
    if (unitMode === "raw")
      return r.silo_parts ? { ...r, siloParts: r.silo_parts } : { ...r };
    if (unitMode === "usd") {
      const pu = r.parts_usd || Object.fromEntries(Object.entries(r.parts_units || r.parts || {}).map(([q, v]) => [q, v * 25]));
      const sp = r.silo_parts_usd || (r.silo_parts_units ? Object.fromEntries(Object.entries(r.silo_parts_units).map(([q, v]) => [q, v * 25])) : null);
      const out = { ...r, value: Number.isFinite(r.usd) ? r.usd : Object.values(pu).reduce((a, b) => a + b, 0), parts: pu };
      if (sp) out.siloParts = sp;
      return out;
    }
    if (unitMode === "usd_pct") {
      const pu = r.parts_usd || Object.fromEntries(Object.entries(r.parts_units || r.parts || {}).map(([q, v]) => [q, v * 25]));
      const capUsd = Number.isFinite(r.usd_cap) && r.usd_cap > 0 ? r.usd_cap : totalUsd;
      const parts = Object.fromEntries(
        Object.entries(pu).map(([q, v]) => [q, capUsd > 0 ? (v / capUsd) * 100 : 0]),
      );
      const valUsd = Number.isFinite(r.usd) ? r.usd : Object.values(pu).reduce((a, b) => a + b, 0);
      const out = { ...r, value: capUsd > 0 ? (valUsd / capUsd) * 100 : 0, parts };
      const spUsd = r.silo_parts_usd || (r.silo_parts_units ? Object.fromEntries(Object.entries(r.silo_parts_units).map(([q, v]) => [q, v * 25])) : null);
      if (spUsd)
        out.siloParts = Object.fromEntries(Object.entries(spUsd).map(([q, v]) => [q, capUsd > 0 ? (v / capUsd) * 100 : 0]));
      return out;
    }
    if (unitMode === "units") {
      const pu = r.parts_units || Object.fromEntries(Object.entries(r.parts || {}).map(([q, v]) => [q, v / 100]));
      const sp = r.silo_parts_units || (r.silo_parts ? Object.fromEntries(Object.entries(r.silo_parts).map(([q, v]) => [q, v / 100])) : null);
      const out = { ...r, value: Number.isFinite(r.units) ? r.units : r.value / 100, parts: pu };
      if (sp) out.siloParts = sp;
      return out;
    }
    const pp = r.parts_pct || r.parts || {};
    const activeCount = Math.max(1, Object.keys(pp).length);
    const out = {
      ...r,
      value: Number.isFinite(r.weighted) ? r.weighted : Object.values(pp).reduce((a, b) => a + b, 0) / activeCount,
      parts: Object.fromEntries(Object.entries(pp).map(([q, v]) => [q, v / activeCount])),
      partLabels: pp,
    };
    const spp = r.silo_parts_pct || r.silo_parts;
    if (spp)
      out.siloParts = Object.fromEntries(Object.entries(spp).map(([q, v]) => [q, v / activeCount]));
    return out;
  });
  let chart;
  if (state.view === "remaining") {
    const stackParts =
      unitMode === "usd"
        ? usdParts
        : unitMode === "usd_pct"
          ? Object.fromEntries(order.map((q) => [q, totalUsd > 0 ? (usdParts[q] / totalUsd) * 100 : 0]))
          : unitMode === "weighted"
            ? Object.fromEntries(order.map((q) => [q, pctParts[q] / Math.max(1, order.length)]))
            : unitMode === "units"
              ? unitParts
              : rawParts;
    const stackSiloParts = hasAnySilo
      ? unitMode === "usd"
        ? siloUsdParts
        : unitMode === "usd_pct"
          ? Object.fromEntries(Object.entries(siloUsdParts).map(([q, v]) => [q, totalUsd > 0 ? (v / totalUsd) * 100 : 0]))
          : unitMode === "weighted"
            ? Object.fromEntries(Object.entries(siloPctParts).map(([q, v]) => [q, v / Math.max(1, order.length)]))
            : unitMode === "units"
              ? siloUnitParts
              : siloRawParts
      : null;
    const partLabels = unitMode === "weighted" ? pctParts : null;
    const legendParts = unitMode === "weighted" ? pctParts : stackParts;
    const rows = order.map((q) => `<span class="legend"><i class="tip-swatch" style="background:var(--provider-${esc(q)})"></i>${esc(pName(q))} ${esc(fmtChartVal(legendParts[q], unitMode))}</span>`).join("");
    chart = plot("all-total", "All accounts total", items, null, remSeries, { order, parts: stackParts, siloParts: stackSiloParts, partLabels, latestValue: displayVal, latestWeighted: avgWeighted, lenient: true }, unitMode).replace('<span class="chart-inspect"', () => `${rows}<span class="chart-inspect"`);
  } else {
    const drainPts = allDrainSeries(order, items, now - state.hours * 3600, now, unitMode);
    const latestParts = drainPts.at(-1)?.partLabels || drainPts.at(-1)?.parts || {};
    const rows = order
      .map((q) => {
        const v = provRates[q] ?? latestParts[q];
        return `<span class="legend"><i class="tip-swatch" style="background:var(--provider-${esc(q)})"></i>${esc(pName(q))}${Number.isFinite(v) ? ` ${esc(fmtRateVal(v, unitMode))}` : ""}</span>`;
      })
      .join("");
    chart = ratePlot(
      "all-total-drain",
      "All accounts total",
      items,
      null,
      unitMode,
      drainPts,
      { order },
      rows,
      remSeries,
      true,
    );
  }
  return `<section class="${cardCls}" data-pool="all"><div class="account-pool pool-sum" data-account="total-all">${head}<div class="pool-total"><div><div class="big-number">${morph(fmtChartVal(displayVal, unitMode))}<small>${esc(displayCap)}</small></div>${note ? `<div class="capacity-note">${esc(note)}</div>` : ""}</div><dl class="metrics"><div class="metric"><dt>Next reset</dt>${nextDd(next, items.every((o) => o.w.remaining >= 100))}</div><div class="metric"><dt>Burn, last ${state.burn}h</dt><dd>${morph(combinedRate !== null ? fmtRateVal(combinedRate, unitMode) : "—")}</dd></div></dl></div>${chart}</div></section>`;
}
function accountQuota(p, a, i, metric, list) {
  const items = accountWindow(a, metric),
    w = items[0]?.w,
    now = state.data.now,
    label = accountLabel(a, i),
    { stale, s, c } = quotaState(a, w);
  const subText = a.silo
    ? subLine([secondary(a), planLabel(a.plan), cyclonePoolText(a)])
    : [secondary(a), planLabel(a.plan)].filter((v) => v && v !== pName(p)).join(" · ");
  const head = `<div class="account-pool-head"><span class="mini-name"><span class="acct-label-wrap"><a class="mini-label" href="${accountPath(a)}" data-open-account="${esc(a.id)}" title="${esc(label)}">${esc(label)}</a>${weightBadge(a)}${cycloneBadge(a)}</span><span class="mini-plan">${esc(subText)}</span></span><span class="head-tags">${useBadge(a)}<span class="tag ${c}" title="${esc(statusReason(a, w))}">${morph(s)}</span></span></div>`;
  if (!w)
    return `<div class="account-pool" data-account="${esc(a.id)}"${a.in_use ? ' data-in-use="true"' : ""}>${head}<p class="mini-none">${a.windows.length ? "N/A" : "Quota not measured yet"}</p></div>`;
  const usdMode = state.unit === "usd",
    acctUnit = usdMode ? "usd" : "raw",
    apiUsd = windowApiUsd(a, w),
    usdScale = apiUsd / 100,
    split = drainSplitFor(a, metric, now),
    rateRaw = split ? split.total : null,
    rate = rateRaw !== null ? (usdMode ? rateRaw * usdScale : rateRaw) : null,
    rateTitle =
      split && split.external > 1e-6
        ? `Ours ${fmtRateVal(usdMode ? split.ours * usdScale : split.ours, acctUnit)} · Other users +${fmtRateVal(usdMode ? split.external * usdScale : split.external, acctUnit)}`
        : usdMode && rateRaw !== null
          ? `${fmtPct(rateRaw)}/h of ~${fmtApiUsd(apiUsd)} window`
          : "",
    forecasts = forecastPoints(
      items,
      metric,
      now,
      now + state.hours * 0.7 * 3600,
      acctUnit,
    ),
    empty = forecasts.find((r) => r.exhausted || r.value <= 0.01),
    next = nextReset(forecasts, items, now);
  let chartHtml;
  if (state.view === "remaining") {
    chartHtml = plot(`${p}-${i}`, label, items, metric, null, null, acctUnit);
  } else if (a.silo) {
    const splitPtsRaw = accountDrainSplitSeries(a, metric, now - state.hours * 3600, now);
    const splitPts = usdMode
      ? splitPtsRaw.map((pt) => ({
          ...pt,
          value: pt.value * usdScale,
          parts: pt.parts
            ? { ours: pt.parts.ours * usdScale, external: pt.parts.external * usdScale }
            : undefined,
        }))
      : splitPtsRaw;
    const hasExt = splitPts.some((pt) => pt.parts?.external > 1e-6);
    if (hasExt) {
      const latestP = splitPts.at(-1)?.parts || {};
      const oursNow = split ? (usdMode ? split.ours * usdScale : split.ours) : latestP.ours;
      const extNow = split ? (usdMode ? split.external * usdScale : split.external) : latestP.external;
      const splitLegend = `<span class="legend"><i class="tip-swatch" style="background:var(--foreground)"></i>Ours${Number.isFinite(oursNow) ? ` ${esc(fmtRateVal(oursNow, acctUnit))}` : ""}</span><span class="legend"><i class="tip-swatch" style="background:#f59e0b"></i>Other users${Number.isFinite(extNow) ? ` ${esc(fmtRateVal(extNow, acctUnit))}` : ""}</span>`;
      chartHtml = ratePlot(
        `${p}-${i}-drain`,
        label,
        items,
        metric,
        acctUnit,
        splitPts,
        {
          order: ["ours", "external"],
          colors: { ours: "var(--foreground)", external: "#f59e0b" },
          labels: { ours: "Ours", external: "Other users" },
        },
        splitLegend,
      );
    } else {
      chartHtml = ratePlot(`${p}-${i}-drain`, label, items, metric, acctUnit);
    }
  } else {
    chartHtml = ratePlot(`${p}-${i}-drain`, label, items, metric, acctUnit);
  }
  const bigVal = usdMode ? fmtApiUsd(apiUsd * w.remaining / 100) : fmtPct(w.remaining);
  const bigSub = usdMode
    ? `of ${fmtApiUsd(apiUsd)} · ${fmtPct(w.remaining)}`
    : state.unit === "usd_pct"
      ? `of ${fmtApiUsd(apiUsd)}`
      : "remaining";
  return `<div class="account-pool" data-account="${esc(a.id)}"${a.in_use ? ' data-in-use="true"' : ""}>${head}<div class="pool-total"><div><div class="big-number">${morph(bigVal)}<small>${esc(bigSub)}</small></div>${stale ? '<div class="capacity-note">Last known quota</div>' : ""}</div><dl class="metrics"><div class="metric"><dt>Runs out</dt><dd>${morph(empty ? empty.ts <= now ? "Now" : esc(dateLabel(empty.ts)) : rate === 0 || !state.forecast ? "—" : forecasts.length ? esc(notInRangeLabel()) : poolForecastPaused(items, now) ? "Paused" : "Collecting history")}</dd></div><div class="metric"><dt>Next reset</dt>${nextDd(next, w.remaining >= 100)}</div><div class="metric"><dt>Burn, last ${state.burn}h</dt><dd${rateTitle ? ` title="${esc(rateTitle)}"` : ""}>${morph(rate !== null ? fmtRateVal(rate, acctUnit) : "—")}</dd></div></dl></div>${chartHtml}</div>`;
}
function planLabel(plan) {
  if (plan === "Unknown") return "";
  return (
    {
      prolite: "Pro 100",
      pro: "Pro 200",
      go: "Go",
      plus: "Plus",
      free: "Free",
      team: "Team",
      enterprise: "Enterprise",
    }[plan] || plan
  );
}
// First in the DOM, so keyboard order matches the layout on desktop and phones
// (range, Options, then what Options reveals).
function rangeAndOptions() {
  const changed = state.view !== "remaining" || state.burn !== 3 || state.unit !== "usd" || !state.forecast;
  return `<div class="control-group range-group"><div class="segmented" role="group" aria-label="Chart time range">${[
    [24, "24h"],
    [72, "3d"],
    [168, "7d"],
    [336, "14d"],
  ]
    .map(([h, l]) => `<button data-hours="${h}" ${choice(state.hours === h)}>${l}</button>`)
    .join("")}</div></div><button class="ghost sm opts-toggle${changed ? " changed" : ""}" data-chart-opts aria-expanded="${state.chartOpts}" aria-label="Chart options${changed ? " (changed)" : ""}">Options${icon("chevron")}</button>`;
}
function quotaPage() {
  if (!tabProviders().length)
    return `<div class="state-card"><h2>No quota-tracked accounts</h2><p>Quotas are read for ${QUOTA_PROVIDERS.map(pName).join(", ")}. Add a login for one of them to see its quota here.</p><button class="primary" data-add>${icon("plus")}Add login</button></div>`;
  // Accounts keeps the saved provider; Quotas reads an untracked one as All.
  const sel = QUOTA_PROVIDERS.includes(state.provider) ? state.provider : "all";
  const restricted = state.data.accounts.filter((a) =>
    a.cooldowns.some((c) => c.reason === "model_not_supported"),
  );
  const presentQuota = [...QUOTA_PROVIDERS]
    .filter((p) => presentProviders().includes(p))
    .sort((a, b) => providerRank(a) - providerRank(b));
  let gridHtml;
  if (sel === "all") {
    const plan = quotasGridPlan(presentQuota, {
      hasAll: Boolean(state.data.totals?.all),
      hasUsage: state.usage?.data?.available !== false,
      wideCards: state.wideCards,
      expanded: state.expanded,
      wideOrder: state.wideOrder,
      isMobile: innerWidth <= 760,
      isStacked: innerWidth < 960,
      maxColsSecondary: innerWidth < 1280 ? 2 : 3,
    });
    const parts = [];
    for (const card of plan.cards) {
      if (card.id === "usage") {
        parts.push(`<section class="pool usage-breakdown card-span-${card.span}${card.wide ? " card-wide" : ""}" id="usage-breakdown" data-live${card.hidden ? " hidden" : ""}></section>`);
        continue;
      }
      activePlotSpan = card.span;
      try {
        if (card.id === "all") parts.push(allQuota(card));
        else parts.push(pool(card.id, card));
      } finally {
        activePlotSpan = 12;
      }
    }
    gridHtml = `<div class="quotas-grid" id="quotas-grid">${parts.join("")}</div>`;
  } else {
    const usageSection = `<section class="pool usage-breakdown card-span-12" id="usage-breakdown" data-live></section>`;
    activePlotSpan = 12;
    let poolsHtml = "";
    try {
      poolsHtml = presentQuota
        .filter((p) => p === sel)
        .map((p) => pool(p, { span: 12, wide: true, expandable: false }))
        .join("");
    } finally {
      activePlotSpan = 12;
    }
    gridHtml = `${poolsHtml}${usageSection}`;
  }
  return `${tabs(QUOTA_PROVIDERS)}<div class="controls${state.chartOpts ? " opts-open" : ""}">${rangeAndOptions()}<div class="segmented metric-control" role="group" aria-label="Chart metric"><button data-view="remaining" ${choice(state.view === "remaining")}>Remaining</button><button data-view="drain" ${choice(state.view === "drain")}>Drain rate</button></div><div class="control-group burn-control"><span class="toolbar-label">Burn</span><div class="segmented" role="group" aria-label="Burn rate lookback">${[1, 3, 6].map((h) => `<button data-burn="${h}" ${choice(state.burn === h)}>${h}h</button>`).join("")}</div></div><div class="control-group unit-control"><span class="toolbar-label">Units</span><div class="segmented" role="group" aria-label="Pool quota units">${[
    ["usd", "CU", "Calibrated compute units (1 CU ≈ $1 API compute) — apples-to-apples across plans and providers"],
    ["usd_pct", "CU %", "CU-weighted % of combined capacity — providers sized by true compute share"],
    ["weighted", "Pool %", "Capacity-weighted % per provider (equal provider average on All accounts)"],
    ["units", "x units", "Normalized 1x plan-equivalent units"],
    ["raw", "Raw %", "Unweighted sum of each account's %"],
  ]
    .map(([u, l, tip]) => `<button data-unit="${u}" title="${esc(tip)}" ${choice(state.unit === u)}>${l}</button>`)
    .join("")}</div></div><label class="forecast-control">Future usage <select id="forecast" class="sm"><option value="on" ${state.forecast ? "selected" : ""}>Same as recent</option><option value="off" ${!state.forecast ? "selected" : ""}>Hide forecast</option></select></label></div>${restricted.length && (sel === "all" || sel === "codex") ? `<div class="notice">${icon("warning")}<span>${restricted.length} Codex account${restricted.length === 1 ? " has" : "s have"} a model restriction. Available quota does not guarantee access to every model.</span><button data-go="accounts" class="ghost sm">View accounts</button></div>` : ""}${gridHtml}`;
}
function accountListWindow(a, mode = state.accountWindow) {
  const windows = a?.windows || [];
  if (!windows.length) return undefined;
  const period = mode === "7d" ? 7 * 86400 : 5 * 3600;
  const matching = windows.filter(
    (w) =>
      w.period === period &&
      !SCOPED_QUOTA.test(w.id) &&
      !w.id.startsWith("code_review_rate_limit:"),
  );
  if (matching.length)
    return matching.find((w) => /gemini/i.test(w.group || "")) || matching[0];
  const anyPeriod = windows.filter((w) => w.period === period);
  if (anyPeriod.length) return anyPeriod[0];
  const otherPeriod = mode === "7d" ? 5 * 3600 : 7 * 86400;
  return windows.find((w) => w.period !== otherPeriod);
}
function accountListWindowShort(w) {
  if (!w) return "";
  const p = Number(w.period);
  if (Number.isFinite(p) && p > 0) {
    if (Math.abs(p - 5 * 3600) <= 600) return "5h";
    if (Math.abs(p - 7 * 86400) <= 7200) return "Wk";
    if (Math.abs(p - 86400) <= 3600) return "1d";
    if (Math.abs(p - 30 * 86400) <= 2 * 86400) return "Mo";
  }
  const name = windowName(w);
  if (/5-?h/i.test(name)) return "5h";
  if (/weekly|7-?d/i.test(name)) return "Wk";
  if (/daily|1-?d|24-?h/i.test(name)) return "1d";
  if (/monthly|30-?d/i.test(name)) return "Mo";
  return name;
}
function accountListWindows(a, mode = state.accountWindow) {
  if (mode !== "both") {
    const w = accountListWindow(a, mode);
    return w ? [w] : [];
  }
  const w5 = accountListWindow(a, "5h");
  const w7 = accountListWindow(a, "7d");
  const out = [];
  if (w5) out.push(w5);
  if (w7 && w7.id !== w5?.id) out.push(w7);
  return out;
}
function accountListStatus(a, wins, routing) {
  const states = wins.map((w) => ({ w, qs: quotaState(a, w) }));
  const reached = states.filter(({ qs }) => qs.s === "Limit reached");
  const primary =
    reached.sort((x, y) => (y.w.reset_at || 0) - (x.w.reset_at || 0))[0] ||
    states.find(({ qs }) => qs.holder) ||
    states[0] || { w: undefined, qs: quotaState(a, undefined) };
  const { w, qs } = primary;
  const [s, c] =
    routing[0] !== "Partial cap" && (qs.holder || qs.s === "Limit reached")
      ? [qs.s, qs.c]
      : routing;
  const reason =
    s === "Ready"
      ? ""
      : s === "Limit reached" && routing[0] === "Ready"
        ? w?.reset_at > state.data.now
          ? `Resets ${dateLabel(w.reset_at)}`
          : "Window exhausted"
        : statusReason(a, w);
  return { w, s, c, reason };
}
function accountQuotaCell(a, wins, isBoth, expectedPeriod) {
  const now = state.data.now;
  const ageHtml = `<span class="account-meta"${a.quota_error ? ' title="Last known quota"' : ""}>${morph(esc(age(a.quota_at)))}</span>`;
  if (!isBoth) {
    const w = wins[0];
    const fallbackWin = w && w.period && Math.abs(w.period - expectedPeriod) > 3600;
    return `<div class="account-quota">${quotaMeter(a, w, w ? staleReading({ a, w }, now) : false)}${fallbackWin ? `<span class="acct-win-tag" title="${esc(w.label)}">${esc(windowName(w))}</span>` : ""}<span class="quota-value"${w?.label ? ` title="${esc(w.label)}"` : ""}>${morph(w ? fmtPct(w.remaining) : "—")}</span>${ageHtml}</div>`;
  }
  const lines = wins.length
    ? wins
        .map((w, idx) => {
          const stale = staleReading({ a, w }, now);
          const tag = accountListWindowShort(w);
          const sec = idx > 0 ? " account-quota-line-secondary" : "";
          const tipText = w.label
            ? w.reset_at > now
              ? `${w.label} · Resets ${dateLabel(w.reset_at)}`
              : w.label
            : "";
          const tip = tipText ? ` title="${esc(tipText)}"` : "";
          return `<div class="account-quota-line${sec}" data-win-slot="${esc(capWindowKey(w) || w.id)}"><span class="acct-win-tag"${tip}>${esc(tag)}</span>${quotaMeter(a, w, stale)}<span class="quota-value"${tip}>${morph(fmtPct(w.remaining))}</span></div>`;
        })
        .join("")
    : `<div class="account-quota-line"><span class="acct-win-tag"></span>${quotaMeter(a, undefined, false)}<span class="quota-value">${morph("—")}</span></div>`;
  return `<div class="account-quota account-quota-both"><div class="account-quota-stack">${lines}</div>${ageHtml}</div>`;
}
function accountsPage() {
  const isBoth = state.accountWindow === "both";
  const expectedPeriod = state.accountWindow === "7d" ? 7 * 86400 : 5 * 3600;
  const windowSwitch = `<div class="controls"><div class="control-group"><span class="toolbar-label">Usage window</span><div class="segmented sm" role="group" aria-label="Account usage window">${[
    ["5h", "5-hour"],
    ["7d", "Weekly"],
    ["both", "Both"],
  ]
    .map(
      ([k, t]) =>
        `<button data-acct-win="${k}" ${choice(state.accountWindow === k)}>${t}</button>`,
    )
    .join("")}</div></div></div>`;
  const listHead = `<div class="account-list-head" aria-hidden="true"><span>Account</span><span>Remaining</span><span>Status</span><span>Rotation</span></div>`;
  return `${tabs()}${windowSwitch}<div class="account-list${isBoth ? " both-windows" : ""}">${listHead}${filteredAccounts()
    .map((a, i) => {
      const routing = status(a),
        wins = accountListWindows(a, state.accountWindow),
        { s, c, reason } = accountListStatus(a, wins, routing);
      const label = accountLabel(a, i);
      const labelHtml =
        state.renaming === a.id
          ? `<input class="rename-input" data-rename="${esc(a.id)}" value="${esc(state.renameDraft)}" maxlength="40" placeholder="${esc(a.email || a.name || "Nickname")}" aria-label="Nickname for ${esc(a.email || label)}. Enter saves, Escape cancels."/>`
          : `<a class="account-label" href="${accountPath(a)}" data-open-account="${esc(a.id)}" title="${esc(label)}">${esc(label)}</a>`;
      const capText = a.silo ? capSummaryText(a) : "";
      const capTag = capText ? `<span class="tag outline acct-cap-tag">${esc(capText)}</span>` : "";
      const sub = a.silo
        ? subLine([secondary(a), planLabel(a.plan), cyclonePoolText(a)])
        : subLine([secondary(a), planLabel(a.plan)].filter((v) => v?.toLowerCase() !== pName(a.provider).toLowerCase())) || pName(a.provider);
      return `<article class="account-row provider-${esc(a.provider)}" data-account="${esc(a.id)}"${a.in_use ? ' data-in-use="true"' : ""}><div class="account-identity">${providerIcon(a.provider)}${labelHtml}${weightBadge(a)}${cycloneBadge(a, true)}${capTag}<span class="account-sub" title="${esc(sub)}">${esc(sub)}</span></div>${accountQuotaCell(a, wins, isBoth, expectedPeriod)}<div class="account-status">${useBadge(a)}<span class="tag ${c}">${morph(s)}</span>${a.resets?.available ? `<span class="tag reset-count" title="Manual resets available. Use one from the account menu.">${morph(`${a.resets.available} reset${a.resets.available === 1 ? "" : "s"}`)}</span>` : ""}${reason ? `<span class="account-reason" title="${esc(reason)}">${morph(esc(reason))}</span>` : ""}${a.requires_sign_in ? `<button class="outline sm" data-relogin="${esc(a.id)}">Sign in again</button>` : ""}</div><div class="account-actions"><button class="switch" role="switch" aria-checked="${!a.disabled}" aria-label="Include ${esc(label)} in rotation" title="${a.disabled ? "Paused: excluded from rotation" : "In rotation"}" data-pause="${esc(a.id)}" data-disabled="${!a.disabled}"><span class="switch-thumb"></span></button><button class="ghost icon-btn sm row-menu" data-menu="${esc(a.id)}" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu" aria-label="More actions for ${esc(label)}">${icon("more")}</button></div></article>`;
    })
    .join(
      "",
    )}</div>`;
}

const NOT_REPORTED = '<span class="muted">Not reported</span>';
const isoTs = (v) => (v ? Date.parse(v) / 1000 || null : null);
const inRange = (ts, now) => (ts ? `<span class="nowrap">${esc(dateLabel(ts))}</span> <span class="muted nowrap">(${esc(ts > now ? relative(ts) : age(ts))})</span>` : NOT_REPORTED);
// Rows with nothing to report are left out.
const detailRow = (label, html) => (html === NOT_REPORTED ? "" : `<div class="metric"><dt>${esc(label)}</dt><dd>${html}</dd></div>`);
const detailGrid = (rows) => (rows ? `<dl class="metrics detail-grid">${rows}</dl>` : "");
const orNot = (v) => (v === null || v === undefined || v === "" ? NOT_REPORTED : esc(v));
function accountUsage(a) {
  const t = state.tokens;
  if (!t.buckets) return `<div class="logs-loading"><span class="loading-mark"></span>Loading usage…</div>`;
  const mine = tokBuckets().filter((b) => b.provider === a.provider &&
    (b.account === a.name || b.account === a.id || `silo:${b.account}` === a.id));
  const stat = (label, range, n) => {
    const buckets = tokWindow(mine, range), sum = tokSum(buckets);
    const spark = tokSpark(buckets, tokBucketTotal, n, range);
    const costPart = sum.priced ? ` · ~${fmtUsd(sum.cost)} est.` : "";
    return tokStat(label, fmtTokens(tokTotal(sum)), `${plural(sum.requests, "request")} · ${tokPct(tokHit(sum))} cache hit${costPart}`, spark, "#56b4e9");
  };
  return `<dl class="tok-hero">${stat("Last 24 hours", 24, 24)}${stat("Last 7 days", 168, 28)}${stat("All time", "all", 24)}</dl>`;
}
const PRIORITY_CHOICES = [
  [1, "First", "Used before your other accounts for the same models."],
  [0, "Normal", "Shares the load with your other accounts."],
  [-1, "Overflow", "Used only when the others are at a limit."],
];
function priorityControl(a, priority) {
  const now = priority ?? 0;
  return `<div class="segmented sm" role="group" aria-label="Priority for ${esc(labelFor(a))}">${PRIORITY_CHOICES.map(([v, name, why]) => `<button data-priority-set="${esc(a.id)}" data-priority-value="${v}" title="${esc(why)}" ${choice(v === now)}>${name}</button>`).join("")}</div>`;
}
const CAP_PRESETS = [80, 85, 90, 95, 100];
const CAP_WINDOW_CHOICES = [
  ["5h", "5-hour"],
  ["weekly", "Weekly"],
];
function groupHasSplitWindows(a, g) {
  const keys = new Set(
    (a.windows || [])
      .filter((w) => w.group === g.group)
      .map(capWindowKey)
      .filter(Boolean),
  );
  if (keys.has("5h") && keys.has("weekly")) return true;
  const wc = g.window_caps;
  return Boolean(
    wc &&
      Number.isFinite(Number(wc["5h"])) &&
      Number.isFinite(Number(wc.weekly)) &&
      Number(wc["5h"]) !== Number(wc.weekly),
  );
}
function capControl(a) {
  const presets = (g, winKey = "") => {
    const cur = Math.round(
      winKey
        ? windowCapValue(g || a, winKey, 90)
        : (g?.cap_percent || a.cap_percent || 90),
    );
    const groupAttr = g ? ` data-cap-group="${esc(g.group)}"` : "";
    const winAttr = winKey ? ` data-cap-window="${esc(winKey)}"` : "";
    const winLabel = winKey === "5h" ? "5-hour" : winKey === "weekly" ? "Weekly" : "";
    const scope = [g?.group, winLabel].filter(Boolean).join(" · ");
    const label = scope ? `Usage cap for ${labelFor(a)} (${scope})` : `Usage cap for ${labelFor(a)}`;
    return `<div class="segmented sm" role="group" aria-label="${esc(label)}">${CAP_PRESETS.map((v) => `<button data-cap-set="${esc(a.id)}"${groupAttr}${winAttr} data-cap-value="${v}" ${choice(v === cur)}>${v}%</button>`).join("")}</div>`;
  };
  const groups = groupCapsOf(a);
  if (!groups.length) {
    return `<div class="cap-groups">${CAP_WINDOW_CHOICES.map(([winKey, winLabel]) => {
      const hitWin = (a.windows || []).find((w) => capWindowKey(w) === winKey && windowIsCapped(a, w));
      const status = hitWin
        ? `<span class="tag warning" title="${esc(capStatusText(a, a))}">Capped</span>`
        : `<span class="muted">${esc(a.cap_owner || "Under cap")}</span>`;
      return `<div class="cap-group-row cap-window-row"><span class="cap-window-label">${esc(winLabel)}</span>${presets(null, winKey)}${status}</div>`;
    }).join("")}</div>`;
  }
  return `<div class="cap-groups">${groups.map((g) => {
    const status = g.capped
      ? `<span class="tag warning" title="${esc(capStatusText(g, a))}">Capped</span>`
      : `<span class="muted">${esc(g.owner || "Under cap")}</span>`;
    if (!groupHasSplitWindows(a, g)) {
      return `<div class="cap-group-row"><span class="cap-group-label">${esc(g.group)}</span>${presets(g)}${status}</div>`;
    }
    return `<div class="cap-group-block"><div class="cap-group-head"><span class="cap-group-label">${esc(g.group)}</span>${status}</div><div class="cap-group-windows">${CAP_WINDOW_CHOICES.map(([winKey, winLabel]) => `<div class="cap-group-row cap-window-row"><span class="cap-window-label">${esc(winLabel)}</span>${presets(g, winKey)}</div>`).join("")}</div></div>`;
  }).join("")}</div>`;
}
const PLAN_PRESETS = {
  claude: [
    ["Pro", "Pro (1x)"],
    ["Team · Standard", "Team · Standard (1.25x)"],
    ["Team · Premium", "Team · Premium (~4.1x)"],
    ["Max 5x", "Max 5x (~6x)"],
    ["Claude Ultra", "Claude Ultra / Max 20x (~8.2x)"],
    ["Free", "Free (0.25x)"],
  ],
  codex: [
    ["Plus", "Plus (1x)"],
    ["Team", "Team (2x)"],
    ["Business · Standard", "Business · Standard (1x)"],
    ["Business · Premium", "Business · Premium (5x)"],
    ["Pro 100", "Pro 100 / 10x (10x)"],
    ["Pro 200", "Pro 200 / 20x (~21x)"],
    ["Pro 500", "Pro 500 (50x)"],
    ["Go", "Go (0.5x)"],
    ["Free", "Free (0.25x)"],
  ],
  antigravity: [
    ["Google AI Pro", "Google AI Pro (1x)"],
    ["Google AI Ultra 5x", "Google AI Ultra 5x (5x)"],
    ["Google AI Ultra 20x", "Google AI Ultra 20x (20x)"],
  ],
  xai: [
    ["Free", "Free (0.25x)"],
    ["X Plus", "X Plus (0.25x)"],
    ["SuperGrok Lite", "SuperGrok Lite (0.3x)"],
    ["SuperGrok", "SuperGrok / X Premium (1x)"],
    ["X Super", "X Super (3.75x)"],
    ["SuperGrok Plus", "SuperGrok Plus (4x)"],
    ["SuperGrok Heavy", "SuperGrok Heavy (10x)"],
    ["X Ultra", "X Ultra (12.5x)"],
  ],
  devin: [
    ["Core", "Core (1x)"],
    ["Team", "Team (1x)"],
    ["Pro", "Pro (1x)"],
    ["Max", "Max (~4.4x)"],
  ],
};
function planControl(a) {
  const detected = planLabel(a.detected_plan || a.plan) || "Detected";
  const override = a.plan_override || "";
  const presets = PLAN_PRESETS[a.provider] || [];
  const options = [
    ["", `Auto (${detected})`],
    ...presets,
    ...(override && !presets.some(([v]) => v === override) ? [[override, override]] : []),
  ];
  return `<select class="sm plan-select" data-plan-select="${esc(a.id)}" aria-label="Plan for ${esc(labelFor(a))}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === override ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
}
const WEIGHT_PRESETS = [1, 2, 5, 20];
function weightControl(a) {
  const auto = Number(a.plan_weight) > 0 ? Number(a.plan_weight) : 1;
  const override = a.weight_override != null ? Number(a.weight_override) : null;
  const custom = override !== null && !WEIGHT_PRESETS.includes(override);
  const hint =
    override === null
      ? `Auto · ${fmtUnits(auto)}`
      : custom
        ? `Custom · ${fmtUnits(override)} (auto ${fmtUnits(auto)})`
        : `${fmtUnits(override)} (auto ${fmtUnits(auto)})`;
  return `<div class="weight-control"><div class="segmented sm" role="group" aria-label="Capacity weight for ${esc(labelFor(a))}"><button data-weight-set="${esc(a.id)}" data-weight-value="" title="Use detected plan capacity (${esc(fmtUnits(auto))})" ${choice(override === null)}>Auto</button>${WEIGHT_PRESETS.map((v) => `<button data-weight-set="${esc(a.id)}" data-weight-value="${v}" title="Count this account as ${v}x a base plan" ${choice(override === v)}>${v}x</button>`).join("")}</div><form class="weight-custom" data-weight-form="${esc(a.id)}"><input type="number" step="any" min="0.05" max="1000" inputmode="decimal" aria-label="Custom capacity multiplier for ${esc(labelFor(a))}" placeholder="Custom" value="${custom ? esc(String(override)) : ""}"/><button type="submit" class="outline sm">Set</button></form><span class="weight-hint">${esc(hint)}</span></div>`;
}
function accountPage() {
  const back = `<div class="page-toolbar"><button class="ghost sm" data-go="accounts">← All accounts</button></div>`;
  const a = accountById(state.accountId) || state.data.accounts.find((x) => x.name === state.accountId);
  if (!a)
    return `${back}<div class="state-card"><h2>Account not found</h2><p>It may have been removed or is not signed in. Go back to the accounts list.</p></div>`;
  const now = state.data.now,
    d = a.detail || {},
    pf = d.provider_fields || {},
    label = labelFor(a),
    held = quotaState(a, a.windows.find((w) => w.period === 5 * 3600) || a.windows[0]),
    routing = status(a),
    [s, c] = routing[0] !== "Partial cap" && (held.holder || held.s === "Limit reached") ? [held.s, held.c] : routing;
  const title =
    state.renaming === a.id
      ? `<input class="rename-input" data-rename="${esc(a.id)}" value="${esc(state.renameDraft)}" maxlength="40" placeholder="${esc(a.email || a.name || "Nickname")}" aria-label="Nickname for ${esc(a.email || label)}. Enter saves, Escape cancels."/>`
      : `<h2 class="detail-title">${esc(label)}</h2>`;
  const detailSub = a.silo
    ? `${cycloneBadge(a, true)} <span class="muted">${esc(subLine([secondary(a), planLabel(a.plan), cyclonePoolText(a)]))}</span>`
    : `<span class="muted">${esc(secondary(a) && secondary(a).toLowerCase() !== pName(a.provider).toLowerCase() ? secondary(a) : subLine([planLabel(a.plan), pName(a.provider)]))}</span>`;
  const head = `<section class="account-pool detail-head provider-${esc(a.provider)}" data-account="${esc(a.id)}"${a.in_use ? ' data-in-use="true"' : ""}><div class="detail-top">${providerIcon(a.provider)}<div class="detail-id">${title}<div class="acct-label-wrap">${detailSub}</div></div><span class="head-tags">${useBadge(a)}<span class="tag ${c}" title="${esc(statusReason(a))}">${morph(s)}</span></span></div><div class="detail-actions"><button class="outline sm" data-start-rename="${esc(a.id)}">${icon("edit")}Rename</button>${a.requires_sign_in ? `<button class="outline sm" data-relogin="${esc(a.id)}">Sign in again</button>` : ""}<button class="switch" role="switch" aria-checked="${!a.disabled}" aria-label="Include ${esc(label)} in rotation" title="${a.disabled ? "Paused: excluded from rotation" : "In rotation"}" data-pause="${esc(a.id)}" data-disabled="${!a.disabled}"><span class="switch-thumb"></span></button><span class="muted">${a.disabled ? "Paused" : "In rotation"}</span><button class="ghost icon-btn sm row-menu" data-menu="${esc(a.id)}" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu" aria-label="More actions for ${esc(label)}">${icon("more")}</button></div></section>`;
  const isClaude = a.provider === "claude",
    until = pf.subscription_until,
    subStatus = pf.subscription_status
      ? pf.subscription_status.charAt(0).toUpperCase() + pf.subscription_status.slice(1)
      : until
        ? until > now ? "Active" : "Ended"
        : null;
  const poolChips = (a.router_nodes?.length ? a.router_nodes : (a.nodes || []).map((n) => ({ node: n, eligible: n === a.active_node }))).map((n) => {
    const cls = n.node === a.active_node ? "good" : n.eligible ? "outline" : "warning";
    const note = n.node === a.active_node ? "active" : n.eligible ? "standby" : (n.in_use ? "in use" : "offline");
    return `<span class="tag ${cls}" title="${esc(note)}">${esc(n.node)} · ${esc(note)}</span>`;
  }).join("");
  const lastUsedHtml = a.in_flight > 0
    ? `<span class="tag in-use"><i class="live-dot" aria-hidden="true"></i>${a.in_flight > 1 ? `Active now (${a.in_flight})` : "Active now"}</span>`
    : inRange(a.last_used_at, now);
  const groups = groupCapsOf(a), capped = groups.filter((g) => g.capped);
  let capStatusHtml;
  if (a.capped) {
    const head = esc(capTimeLabel(a));
    const rel = Number.isFinite(a.capped_until) && a.capped_until > now ? ` <span class="muted">(${esc(relative(a.capped_until))})</span>` : "";
    const reason = capReasonFor(a, a);
    capStatusHtml = `${head}${rel}${reason ? `<div class="cap-reason">${esc(reason)}</div>` : ""}`;
  } else if (capped.length) {
    capStatusHtml = esc(cappedGroupReasons(capped, a));
  } else {
    capStatusHtml = esc(a.cap_owner || (groups.length ? "All groups under cap" : "Under cap"));
  }
  const account = a.silo
    ? `<section class="account-pool detail-card"><h3 class="breakdown-title">Cyclone pool</h3><dl class="metrics detail-grid">${detailRow("Route", `${cycloneBadge(a, true)} <span class="muted">Laptop egress · token never leaves laptop</span>`)}${detailRow("Provider", esc(pName(a.provider)))}${detailRow("Plan", planControl(a))}${detailRow("Capacity", weightControl(a))}${detailRow("Prefix", `<code>${esc(a.name)}/</code>`)}${detailRow("Last used", lastUsedHtml)}${detailRow("Usage caps", capControl(a))}${detailRow("Cap status", capStatusHtml)}${detailRow("Failover laptops", poolChips ? `<div class="cyclone-nodes">${poolChips}</div>` : NOT_REPORTED)}</dl></section>`
    : `<section class="account-pool detail-card"><h3 class="breakdown-title">Account</h3><dl class="metrics detail-grid">${detailRow("Email", orNot(a.email))}${detailRow("Provider", esc(pName(a.provider)))}${detailRow("Plan", planControl(a))}${detailRow("Seat / tier", orNot(isClaude ? [pf.seat, pf.rate_limit_tier?.startsWith("default_") ? null : pf.rate_limit_tier].filter(Boolean).join(" · ") : null))}${detailRow("Capacity", weightControl(a))}${detailRow("Organization", orNot(pf.org_name?.replace("’", "'") === `${a.email}'s Organization` ? null : pf.org_name))}${detailRow("Priority", priorityControl(a, d.priority))}${detailRow("Last used", lastUsedHtml)}${detailRow("Credential file", orNot(d.file))}${detailRow("Added", inRange(d.added, now))}${detailRow("Signed in", inRange(d.signed_in, now))}${detailRow("Last refreshed", inRange(isoTs(a.last_refresh), now))}${isClaude ? detailRow("Account created", inRange(pf.account_created, now)) : ""}</dl></section>`;
  const subInfo = typeof subscriptionSummary === "function" ? subscriptionSummary(a) : null;
  const subNext = subInfo?.next
    ? `${esc(subInfo.next.label)} · ${esc(subInfo.next.day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}`
    : NOT_REPORTED;
  const primaryWins = (a.windows || []).filter((w) => !SCOPED_QUOTA.test(w.id) && !w.id.startsWith("code_review") && Number(w.api_usd) > 0);
  const fiveHWin = primaryWins.find((w) => Math.abs((w.period || 0) - 5 * 3600) <= 600);
  const dayWin = !fiveHWin ? primaryWins.find((w) => Math.abs((w.period || 0) - 86400) <= 3600) : null;
  const weekWin = primaryWins.find((w) => Math.abs((w.period || 0) - 7 * 86400) <= 7200);
  const monthWin = !weekWin ? primaryWins.find((w) => Math.abs((w.period || 0) - 30 * 86400) <= 3 * 86400) : null;
  const apiCapParts = [
    fiveHWin ? `~${fmtApiUsd(fiveHWin.api_usd)} / 5h` : "",
    dayWin ? `~${fmtApiUsd(dayWin.api_usd)} / 24h` : "",
    weekWin ? `~${fmtApiUsd(weekWin.api_usd)} / wk` : "",
    monthWin ? `~${fmtApiUsd(monthWin.api_usd)} / mo` : "",
  ].filter(Boolean);
  const apiCapSrc = (weekWin || monthWin || fiveHWin || dayWin)?.api_usd_source;
  const apiCapHtml = apiCapParts.length
    ? `${apiCapParts.map((part) => `<span class="nowrap">${esc(part)}</span>`).join(" · ")}${apiCapSrc ? ` <span class="muted nowrap">(${esc(apiCapSrc)})</span>` : ""}`
    : NOT_REPORTED;
  const monthlyCents = a.subscription?.cents > 0 ? a.subscription.cents * (a.subscription.cycle === "yearly" ? 1 / 12 : 1) : 0;
  const monthlyApiUsd = weekWin ? weekWin.api_usd * (30.4375 / 7) : monthWin ? monthWin.api_usd : 0;
  const subsidyRatio = monthlyCents > 0 && monthlyApiUsd > 0 ? monthlyApiUsd / (monthlyCents / 100) : 0;
  const subsidyHtml = subsidyRatio > 0
    ? `${esc(fmtUnits(subsidyRatio))} <span class="muted">(~${esc(fmtApiUsd(monthlyApiUsd))}/mo)</span>`
    : NOT_REPORTED;
  const subRows = `${subInfo ? detailRow(a.silo ? "Seat estimate" : "Billing", esc(subInfo.status)) : ""}${subInfo?.next ? detailRow("Next date", subNext) : ""}${detailRow("Est. capacity", apiCapHtml)}${detailRow("Max subsidy", subsidyHtml)}${detailRow("Bought through", orNot(pf.billing))}${detailRow("Status", orNot(subStatus))}${detailRow("Started", inRange(pf.subscription_started, now))}${detailRow(isClaude ? "Renewal" : "Paid through", inRange(until, now))}${pf.subscription_checked ? detailRow("Last checked", inRange(pf.subscription_checked, now)) : ""}${isClaude ? detailRow("Extra usage", pf.extra_usage === null || pf.extra_usage === undefined ? NOT_REPORTED : pf.extra_usage ? "Enabled" : "Off") : ""}${pf.trial_ends ? detailRow("Trial ends", inRange(pf.trial_ends, now)) : ""}`;
  const sub = `<section class="account-pool detail-card"><div class="detail-card-head"><h3 class="breakdown-title">Subscription</h3>${subInfo ? `<button class="outline sm" data-sub-edit="${esc(subInfo.editId)}">Edit billing</button>` : ""}</div>${detailGrid(subRows)}</section>`;
  const quotaWindows = a.windows.map((w) => {
    const stale = staleReading({ a, w }, now);
    const capTag = windowIsCapped(a, w)
      ? `<span class="tag warning" title="${esc(statusReason(a, w))}">Capped</span>` : "";
    const staleTag = stale ? '<span class="tag outline stale-tag">Last known</span>' : "";
    const reset = w.reset_at > now ? `Resets ${esc(dateLabel(w.reset_at))}`
      : w.remaining >= 100 ? "Full" : w.reset_at ? "Reset passed" : "No reset reported";
    return `<div class="detail-win"><span class="detail-win-name">${esc(windowName(w))}${w.group ? ` <span class="muted">${esc(w.group)}</span>` : ""}</span>${quotaMeter(a, w, stale)}<span class="quota-value${stale ? " muted" : ""}">${esc(fmtPct(w.remaining))}</span><span class="muted detail-win-reset">${reset}${staleTag}${capTag}</span></div>`;
  }).join("");
  const quotaErrBanner = a.quota_error
    ? `<div class="notice error detail-quota-error">${icon("warning")}<span>Quota poll error: ${esc(a.quota_error)}</span></div>`
    : "";
  const readAge = a.quota_at ? `<span class="muted detail-read-age">Read ${esc(age(a.quota_at))}</span>` : "";
  const quotaMeta = a.resets ? detailGrid(detailRow("Banked resets", esc(a.resets.available))) : "";
  const quota = `<section class="account-pool detail-card provider-${esc(a.provider)}"><div class="detail-card-head"><h3 class="breakdown-title">Quota</h3>${readAge}</div>${quotaErrBanner}${quotaWindows || `<p class="mini-none">${a.quota_error ? esc(a.quota_error) : "Quota not measured yet"}</p>`}${quotaMeta}</section>`;
  const usage = `<section class="account-pool detail-card"><h3 class="breakdown-title">Token usage</h3>${accountUsage(a)}</section>`;
  return `${back}${head}${quota}${sub ? `<div class="detail-cols">${account}${sub}</div>` : account}${usage}`;
}
