const assert = require("node:assert/strict");
const { runAppScripts } = require("./app_scripts.cjs");

// Load the dashboard's scripts in a minimal DOM sandbox to test the real quota math directly.
function loadDashboardScript() {
  const noop = () => {};
  const fakeEl = () => ({
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    value: "",
    dataset: {},
    style: { setProperty: noop },
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    addEventListener: noop,
    setAttribute: noop,
    removeAttribute: noop,
    hasAttribute: () => false,
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    closest: () => null,
    focus: noop,
  });

  const sandbox = {
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Date,
    JSON,
    RegExp,
    Error,
    URL,
    Promise,
    Intl,
    WeakMap,
    encodeURIComponent,
    decodeURIComponent,
    addEventListener: noop,
    removeEventListener: noop,
    getComputedStyle: () => ({}),
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    scrollTo: noop,
    innerWidth: 1440,
    matchMedia: () => ({ matches: true, addEventListener: noop }),
    localStorage: { getItem: () => null, setItem: noop },
    location: { pathname: "/dashboard/", hash: "", origin: "http://localhost:8318" },
    history: { replaceState: noop, pushState: noop },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    CSS: { escape: (s) => String(s) },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: false }) }),
    document: {
      hidden: false,
      fonts: { ready: Promise.resolve() },
      querySelector: () => fakeEl(),
      querySelectorAll: () => [],
      getElementById: () => fakeEl(),
      createElement: () => fakeEl(),
      addEventListener: noop,
      getAnimations: () => [],
    },
  };
  sandbox.window = sandbox;
  runAppScripts(sandbox);
  return sandbox;
}

const ctx = loadDashboardScript();
const {
  state,
  drainFor,
  drainSplitFor,
  poolDrain,
  drainSeries,
  allDrainSeries,
  accountDrainSplitSeries,
  quotaProjection,
  quotaMeter,
  plot,
  ratePlot,
  chartHoverInfo,
  inspectChart,
  seriesAt,
  niceRateMax,
  accountWeight,
  accountListWindow,
  accountsPage,
  forecastPoints,
  windowApiUsd,
  fmtApiUsd,
} = ctx.window.dashboard;

// Helper to build steady linear history for an account over the last `hours` hours (10m spacing < 900s gap).
function linearHistory(account, metric, now, hours, endRem, ratePerHour) {
  const pts = [];
  const steps = Math.max(6, Math.round(hours * 6));
  for (let i = 0; i <= steps; i++) {
    const dt = (hours * 3600 * (steps - i)) / steps;
    pts.push({
      account,
      metric,
      ts: now - dt,
      remaining: Math.min(100, endRem + (ratePerHour * dt) / 3600),
    });
  }
  return pts;
}

const now = 1_700_000_000;
state.burn = 3;
state.forecast = true;

// 1. poolDrain stays invariant across a Pro (1x) -> Max 5x swap-over for a constant 0.10x/h workload.
{
  const pro = { id: "pro1", name: "claude-pro1.json", provider: "claude", weight: 1, quota_at: now, windows: [] };
  const max = { id: "max1", name: "claude-max1.json", provider: "claude", weight: 5, quota_at: now, windows: [] };
  const items = [
    { a: pro, w: { id: "five_hour", remaining: 20, reset_at: null, period: 18000 } },
    { a: max, w: { id: "five_hour", remaining: 100, reset_at: null, period: 18000 } },
  ];

  // Before swap: Pro drains 10%/h, Max drains 0%/h -> demand = 0.10x/h, weighted = 0.10/6 * 100 = 1.6667%/h.
  state.data = {
    now,
    routing_strategy: "fill-first",
    history: [
      ...linearHistory("pro1", "five_hour", now, 3, 20, 10),
      ...linearHistory("max1", "five_hour", now, 3, 100, 0),
    ],
  };
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "units") - 0.1) < 1e-6);
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "weighted") - (10 / 6)) < 1e-6);
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "raw") - 10) < 1e-6);

  // Mid-swap: Pro burned 18% (6%/h over 3h), Max burned 2.4% (0.8%/h over 3h) -> still 0.10x/h!
  state.data.history = [
    ...linearHistory("pro1", "five_hour", now, 3, 0, 6),
    ...linearHistory("max1", "five_hour", now, 3, 97.6, 0.8),
  ];
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "units") - 0.1) < 1e-6);
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "weighted") - (10 / 6)) < 1e-6);

  // After swap: Pro idle (0%/h), Max drains 2%/h -> still 0.10x/h!
  state.data.history = [
    ...linearHistory("pro1", "five_hour", now, 3, 0, 0),
    ...linearHistory("max1", "five_hour", now, 3, 94, 2),
  ];
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "units") - 0.1) < 1e-6);
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "weighted") - (10 / 6)) < 1e-6);
  assert.ok(Math.abs(poolDrain(items, "five_hour", now, "raw") - 2) < 1e-6);
}

// 2. fill-first failover projection: Pro (1x, 20%, 10%/h) -> Max (5x, 100%, 0%/h).
//    Pro runs out at +2h; Max then drains at 2%/h (taking 50h) -> total pool runs out at +52h in ALL unit modes!
{
  const pro = {
    id: "pro1", name: "a-pro1.json", provider: "claude", weight: 1, quota_at: now,
    detail: { priority: 1 }, windows: [],
  };
  const max = {
    id: "max1", name: "b-max1.json", provider: "claude", weight: 5, quota_at: now,
    detail: { priority: 0 }, windows: [],
  };
  const items = [
    { a: pro, w: { id: "seven_day", remaining: 20, reset_at: null, period: 7 * 86400 } },
    { a: max, w: { id: "seven_day", remaining: 100, reset_at: null, period: 7 * 86400 } },
  ];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history: [
      ...linearHistory("pro1", "seven_day", now, 3, 20, 10),
      ...linearHistory("max1", "seven_day", now, 3, 100, 0),
    ],
  };

  const end = now + 60 * 3600;
  for (const mode of ["weighted", "units", "raw"]) {
    const fc = forecastPoints(items, "seven_day", now, end, mode);
    assert.ok(fc.length > 0, `expected forecast for ${mode}`);
    const empty = fc.find((p) => p.exhausted || p.value <= 0.01);
    assert.ok(empty, `expected pool exhaustion in ${mode}`);
    const hoursUntilEmpty = (empty.ts - now) / 3600;
    assert.ok(
      Math.abs(hoursUntilEmpty - 52) < 0.05,
      `expected 52h until empty in ${mode}, got ${hoursUntilEmpty}`,
    );
  }

  // Verify raw curve bends accurately at t = +2h (100% left) and t = +12h (80% left on Max = 80% raw).
  const fcRaw = forecastPoints(items, "seven_day", now, end, "raw");
  const at = (fc, h) => {
    const target = now + h * 3600;
    const i = fc.findIndex((p) => p.ts >= target);
    if (fc[i].ts === target) return fc[i].value;
    const a = fc[i - 1], b = fc[i];
    return a.value + ((b.value - a.value) * (target - a.ts)) / (b.ts - a.ts);
  };
  assert.ok(Math.abs(at(fcRaw, 0) - 120) < 1e-6);
  assert.ok(Math.abs(at(fcRaw, 2) - 100) < 0.05);
  assert.ok(Math.abs(at(fcRaw, 12) - 80) < 0.05); // 10h on Max at 2%/h = 20% drop!

  // Verify x-units curve is perfectly linear (5.2x -> 5.0x at +2h -> 4.0x at +12h -> 0x at +52h).
  const fcUnits = forecastPoints(items, "seven_day", now, end, "units");
  assert.ok(Math.abs(at(fcUnits, 0) - 5.2) < 1e-6);
  assert.ok(Math.abs(at(fcUnits, 2) - 5.0) < 1e-3);
  assert.ok(Math.abs(at(fcUnits, 12) - 4.0) < 1e-3);
}

// 3. Reset handback: when higher-priority Pro resets at +5h, traffic returns to Pro.
{
  const pro = {
    id: "pro1", name: "a-pro1.json", provider: "claude", weight: 1, quota_at: now,
    detail: { priority: 1 }, windows: [],
  };
  const max = {
    id: "max1", name: "b-max1.json", provider: "claude", weight: 5, quota_at: now,
    detail: { priority: 0 }, windows: [],
  };
  const items = [
    { a: pro, w: { id: "five_hour", remaining: 20, reset_at: now + 5 * 3600, period: 5 * 3600 } },
    { a: max, w: { id: "five_hour", remaining: 100, reset_at: null, period: 5 * 3600 } },
  ];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history: [
      ...linearHistory("pro1", "five_hour", now, 3, 20, 10),
      ...linearHistory("max1", "five_hour", now, 3, 100, 0),
    ],
  };
  // Over 10h at 0.10x/h: Pro resets at +5h (+1.0x) and +10h (+1.0x), so total stays high.
  // Specifically at +5h (after reset): Pro=100% (1x), Max=94% (4.7x) => 5.7x.
  const fcUnits = forecastPoints(items, "five_hour", now, now + 8 * 3600, "units");
  const postReset = fcUnits.find((p) => Math.abs(p.ts - (now + 5 * 3600)) < 1e-3);
  assert.ok(postReset, "expected exact post-reset point at +5h");
  assert.ok(Math.abs(postReset.value - 5.7) < 1e-2, `expected 5.7x at +5h reset, got ${postReset.value}`);
  // At +8h (3h later): Pro drains 30% back down to 70% (0.7x), Max stays untouched at 94% (4.7x) => 5.4x.
  assert.ok(Math.abs(fcUnits.at(-1).value - 5.4) < 1e-2, `expected 5.4x at +8h, got ${fcUnits.at(-1).value}`);
}

// 3b. An owner-paused or stale account in a multi-account pool holds at its last known value instead of pausing the pool forecast.
{
  const live = { id: "live1", name: "a-live.json", provider: "claude", weight: 1, quota_at: now, windows: [] };
  const off = { id: "off1", name: "b-off.json", provider: "claude", weight: 1, quota_at: now - 86400, disabled: true, windows: [] };
  const items = [
    { a: live, w: { id: "five_hour", remaining: 50, reset_at: null, period: 5 * 3600 } },
    { a: off, w: { id: "five_hour", remaining: 60, reset_at: null, period: 5 * 3600 } },
  ];
  state.data = { now, routing_strategy: "fill-first", history: linearHistory("live1", "five_hour", now, 3, 50, 10) };
  const fc = forecastPoints(items, "five_hour", now, now + 4 * 3600, "raw");
  assert.ok(fc.length, "a paused account's stale reading must not pause the forecast");
  assert.ok(Math.abs(fc.at(-1).value - 70) < 1e-2, `live drains 40% while the paused one holds at 60, got ${fc.at(-1).value}`);
  // A stale account in a multi-account pool holds steady instead of blinding the healthy accounts.
  const staleActive = { a: { ...off, disabled: false }, w: items[1].w };
  const items2 = [items[0], staleActive];
  const fcPool = forecastPoints(items2, "five_hour", now, now + 4 * 3600, "raw");
  assert.ok(fcPool.length, "one stale account must not pause a multi-account pool forecast");
  assert.ok(Math.abs(fcPool.at(-1).value - 70) < 1e-2, `stale account holds at 60, got ${fcPool.at(-1).value}`);
  // When no non-paused account has a fresh reading (single-account card or all-stale pool), the forecast pauses.
  assert.equal(forecastPoints([staleActive], "five_hour", now, now + 4 * 3600, "raw").length, 0);
  // The All accounts total is lenient: even an all-stale provider holds at its last known value instead.
  const fc2 = forecastPoints([staleActive], "five_hour", now, now + 4 * 3600, "raw", true);
  assert.ok(fc2.length, "the lenient forecast must still draw");
  assert.ok(Math.abs(fc2.at(-1).value - 60) < 1e-2, `stale account holds at 60, got ${fc2.at(-1).value}`);
}

// 3c. A transient or expired quota_error (Quota unavailable) does not pause a multi-account pool forecast while healthy accounts are live.
{
  const ok = { id: "c1", name: "a-c1.json", provider: "codex", weight: 1, quota_at: now - 120, windows: [] };
  const errFresh = {
    id: "c2", name: "b-c2.json", provider: "codex", weight: 1, quota_at: now - 360,
    quota_error: "Quota request returned HTTP 502.", cooldowns: [], windows: [],
  };
  const items = [
    { a: ok, w: { id: "rate_limit:5h", remaining: 80, reset_at: now + 4 * 3600, period: 5 * 3600 } },
    { a: errFresh, w: { id: "rate_limit:5h", remaining: 60, reset_at: now + 3 * 3600, period: 5 * 3600 } },
  ];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history: [
      ...linearHistory("c1", "rate_limit:5h", now - 120, 3, 80, 10),
      ...linearHistory("c2", "rate_limit:5h", now - 360, 3, 60, 5),
    ],
  };
  const fc = forecastPoints(items, "rate_limit:5h", now, now + 4 * 3600, "raw");
  assert.ok(fc.length > 0, "transient quota_error with fresh quota_at must not hide the pooled forecast");
  // The account itself still flags Quota unavailable in status UI.
  assert.equal(ctx.quotaState(errFresh, items[1].w).s, "Quota unavailable");
  // Once the last good reading expires (> 900s) or is missing, the multi-account pool still forecasts
  // using the live account while holding the unavailable account at its last known value.
  const expiredAcct = { a: { ...errFresh, quota_at: now - 901 }, w: items[1].w };
  const expiredPoolFc = forecastPoints([items[0], expiredAcct], "rate_limit:5h", now, now + 4 * 3600, "raw");
  assert.ok(expiredPoolFc.length > 0, "one Quota unavailable account must not pause a multi-account pool forecast");
  const missingAcct = { a: { ...errFresh, quota_at: null }, w: items[1].w };
  const missingPoolFc = forecastPoints([items[0], missingAcct], "rate_limit:5h", now, now + 4 * 3600, "raw");
  assert.ok(missingPoolFc.length > 0, "one account with missing quota_at must not pause a multi-account pool forecast");
  // On a single-account card (or when every active account is expired), the forecast still pauses.
  assert.equal(forecastPoints([expiredAcct], "rate_limit:5h", now, now + 4 * 3600, "raw").length, 0);
  assert.equal(forecastPoints([missingAcct], "rate_limit:5h", now, now + 4 * 3600, "raw").length, 0);
}

// 4. Silo cap floor: a Cyclone seat capped at 85% stops serving at 15% remaining and marks exhausted.
{
  const seat = {
    id: "silo:s1", name: "s1", provider: "claude", silo: true, cap_percent: 85,
    weight: 1.25, quota_at: now, windows: [],
  };
  const items = [{ a: seat, w: { id: "seven_day", remaining: 35, reset_at: null, period: 7 * 86400 } }];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history: linearHistory("silo:s1", "seven_day", now, 3, 35, 10),
  };
  const fc = forecastPoints(items, "seven_day", now, now + 10 * 3600, "weighted");
  const empty = fc.find((p) => p.exhausted);
  assert.ok(empty, "expected Silo account to hit cap floor");
  // 35% -> 15% at 10%/h = 2h.
  assert.ok(Math.abs((empty.ts - now) / 3600 - 2) < 0.05, `expected exhaustion at 2h, got ${(empty.ts - now) / 3600}`);
  // Remaining flattens at 15%, never drops to 0%.
  assert.ok(Math.abs(fc.at(-1).value - 15) < 0.05);
}

// Group overrides set independent forecast floors on a partially capped seat.
{
  const seat = {
    id: "silo:u1", name: "u1", provider: "antigravity", silo: true,
    cap_percent: 90, capped: false, disabled: false, quota_at: now, cooldowns: [],
    group_caps: [
      { group: "Gemini", cap_percent: 95, capped: false },
      { group: "Claude & GPT", cap_percent: 85, capped: true },
    ],
    windows: [
      { id: "gemini:5h", group: "Gemini", remaining: 35, reset_at: null, period: 18000 },
      { id: "claude_gpt:5h", group: "Claude & GPT", remaining: 12, reset_at: null, period: 18000 },
    ],
  };
  state.data = {
    now, routing_strategy: "fill-first",
    history: seat.windows.flatMap((w) => linearHistory(seat.id, w.id, now, 3, w.remaining, 10)),
  };
  const forecast = (w) => forecastPoints([{ a: seat, w }], w.id, now, now + 10 * 3600);
  const gemini = forecast(seat.windows[0]);
  assert.ok(Math.abs((gemini.find((p) => p.exhausted).ts - now) / 3600 - 3) < 0.05);
  assert.equal(gemini.at(-1).value, 5);
  const claudeGpt = forecast(seat.windows[1]);
  assert.equal(claudeGpt[0].exhausted, true);
  assert.ok(claudeGpt.every((p) => p.value === 12));

  const [w] = seat.windows;
  assert.equal(ctx.quotaState(seat, w).s, "Quota available");
  assert.equal(ctx.quotaState({ ...seat, unavailable: true }, w).s, "No idle laptop");
  assert.equal(ctx.quotaState({ ...seat, quota_error: "Quota read failed" }, w).s, "Quota unavailable");
  assert.equal(ctx.quotaState({ ...seat, quota_at: now - 901 }, w).s, "Ready");
  assert.equal(ctx.quotaState({ ...seat, disabled: true }, w).s, "Paused");
  assert.equal(ctx.quotaState({ ...seat, capped: true, disabled: true }, w).s, "Capped");
}

// 5. Cross-provider All accounts isolates failover per provider (Claude burn never drains Codex).
{
  const claude = { id: "c1", name: "c1.json", provider: "claude", weight: 1, quota_at: now, windows: [] };
  const codex = { id: "o1", name: "o1.json", provider: "codex", weight: 5, quota_at: now, windows: [] };
  const items = [
    { a: claude, metric: "five_hour", w: { id: "five_hour", remaining: 10, reset_at: null, period: 18000 } },
    { a: codex, metric: "rate_limit:5h", w: { id: "rate_limit:5h", remaining: 100, reset_at: null, period: 18000 } },
  ];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history: [
      ...linearHistory("c1", "five_hour", now, 3, 10, 10),
      ...linearHistory("o1", "rate_limit:5h", now, 3, 100, 0),
    ],
  };
  // Claude empties at +1h (0%), Codex stays at 100% -> weighted avg settles at 50%.
  const fcW = forecastPoints(items, null, now, now + 5 * 3600, "weighted");
  assert.ok(Math.abs(fcW[0].value - 55) < 1e-3);
  assert.ok(Math.abs(fcW.at(-1).value - 50) < 1e-2);
  // Units mode: starts at 0.1 + 5.0 = 5.1x, settles at 5.0x (Codex untouched).
  const fcU = forecastPoints(items, null, now, now + 5 * 3600, "units");
  assert.ok(Math.abs(fcU[0].value - 5.1) < 1e-3);
  assert.ok(Math.abs(fcU.at(-1).value - 5.0) < 1e-2);
}

// 6. soonest-reset picks the account resetting sooner first, then spills to the other plan at scaled rate.
{
  const week = 7 * 86400;
  const maxSoon = {
    id: "max_soon", name: "z-max.json", provider: "claude", weight: 5, quota_at: now,
    detail: { priority: 0 },
    windows: [{ id: "seven_day", period: week, remaining: 10, reset_at: now + 3 * 86400 }],
  };
  const proLater = {
    id: "pro_later", name: "a-pro.json", provider: "claude", weight: 1, quota_at: now,
    detail: { priority: 0 },
    windows: [{ id: "seven_day", period: week, remaining: 100, reset_at: now + 6 * 86400 }],
  };
  const items = [
    { a: maxSoon, w: maxSoon.windows[0] },
    { a: proLater, w: proLater.windows[0] },
  ];
  // Max (5x) is draining at 5%/h => demand = 0.25x/h.
  // Max has 10% left (0.5x) => empties at +2h, then spills onto Pro (1x) at 25%/h => Pro empties at +6h.
  state.data = {
    now,
    routing_strategy: "soonest-reset",
    history: [
      ...linearHistory("max_soon", "seven_day", now, 3, 10, 5),
      ...linearHistory("pro_later", "seven_day", now, 3, 100, 0),
    ],
  };
  const fc = forecastPoints(items, "seven_day", now, now + 10 * 3600, "units");
  const empty = fc.find((p) => p.exhausted || p.value <= 0.01);
  assert.ok(empty, "expected soonest-reset exhaustion");
  assert.ok(Math.abs((empty.ts - now) / 3600 - 6) < 0.05, `expected 6h until empty, got ${(empty.ts - now) / 3600}`);
}

// 7. round-robin splits normalized demand evenly across active accounts and spills full demand when smaller plan empties.
{
  const pro = { id: "pro1", name: "a.json", provider: "claude", weight: 1, quota_at: now, detail: { priority: 0 }, windows: [] };
  const max = { id: "max1", name: "b.json", provider: "claude", weight: 5, quota_at: now, detail: { priority: 0 }, windows: [] };
  const items = [
    { a: pro, w: { id: "seven_day", remaining: 50, reset_at: null, period: 7 * 86400 } },
    { a: max, w: { id: "seven_day", remaining: 50, reset_at: null, period: 7 * 86400 } },
  ];
  // Total remaining = 0.5x + 2.5x = 3.0x. Total demand = 0.50x/h (25%/h on Pro + 5%/h on Max).
  // Under round-robin: each takes 0.25x/h (Pro drains 25%/h for 2h -> 0%; Max drains 5%/h for 2h -> 40% = 2.0x),
  // then Max takes all 0.50x/h (10%/h for 4h -> 0%). Total = 6h!
  state.data = {
    now,
    routing_strategy: "round-robin",
    history: [
      ...linearHistory("pro1", "seven_day", now, 2, 50, 25),
      ...linearHistory("max1", "seven_day", now, 2, 50, 5),
    ],
  };
  const fc = forecastPoints(items, "seven_day", now, now + 10 * 3600, "weighted");
  const empty = fc.find((p) => p.exhausted || p.value <= 0.01);
  assert.ok(empty, "expected round-robin exhaustion");
  assert.ok(Math.abs((empty.ts - now) / 3600 - 6) < 0.05, `expected 6h until empty, got ${(empty.ts - now) / 3600}`);
}

// 8. Backwards compatibility with minimal test_ui.cjs mock account.
{
  state.data = {
    now,
    history: [{ account: "test", metric: "m", ts: now - 10, remaining: 50 }],
  };
  const fc = forecastPoints(
    [{ a: { id: "test", quota_at: now }, w: { remaining: 50, reset_at: now + 3600 } }],
    "m",
    now,
    now + 7200,
  );
  assert.equal(fc.length, 0);
  assert.equal(accountWeight({ id: "test" }), 1);
}

// 9. Rolling drain rate time-series: steady burn, burst->idle, reset skip, recording gap, and unit invariance.
{
  state.burn = 1;
  state.hours = 24;
  const pro = { id: "pro1", name: "pro1.json", provider: "claude", weight: 1, quota_at: now, windows: [] };
  const max = { id: "max1", name: "max1.json", provider: "claude", weight: 5, quota_at: now, windows: [] };

  // 9a. Steady 12%/h drain with a reset mid-way (reset must NOT cause negative or spike values).
  const hist = [];
  for (let m = 0; m <= 120; m += 5) {
    const ts = now - (120 - m) * 60;
    const rem = m < 60 ? 80 - (m / 60) * 12 : 100 - ((m - 60) / 60) * 12;
    hist.push({ account: "pro1", metric: "five_hour", ts, remaining: rem });
  }
  state.data = { now, history: hist, history_bucket: 120 };
  const pts = drainSeries([{ a: pro }], "five_hour", now - 24 * 3600, now, "raw");
  assert.ok(pts.length >= 10, `expected >=10 drain points, got ${pts.length}`);
  for (const p of pts) {
    assert.ok(Math.abs(p.value - 12) < 0.05, `expected ~12%/h across reset, got ${p.value}`);
  }

  // 9b. Recording gap (2 hours missing): breaks line with gap=true instead of interpolating across.
  const gapHist = [
    ...linearHistory("pro1", "five_hour", now - 3 * 3600, 1, 80, 10),
    ...linearHistory("pro1", "five_hour", now, 1, 60, 20),
  ];
  state.data = { now, history: gapHist, history_bucket: 120 };
  const gapPts = drainSeries([{ a: pro }], "five_hour", now - 24 * 3600, now, "raw");
  assert.ok(gapPts.some((p) => p.gap), "expected gap flag after recording outage");
  assert.ok(Math.abs(gapPts[0].value - 10) < 0.1);
  assert.ok(Math.abs(gapPts.at(-1).value - 20) < 0.1);

  // 9c. Pro (1x) -> Max (5x) swap-over stays invariant in units & weighted modes across time.
  const swapHist = [];
  for (let m = 0; m <= 180; m += 5) {
    const ts = now - (180 - m) * 60;
    // First 90m: Pro burns 10%/h (0.10x/h), Max idle. Next 90m: Pro idle, Max burns 2%/h (0.10x/h).
    const proRem = m <= 90 ? 100 - (m / 60) * 10 : 85;
    const maxRem = m <= 90 ? 100 : 100 - ((m - 90) / 60) * 2;
    swapHist.push({ account: "pro1", metric: "five_hour", ts, remaining: proRem });
    swapHist.push({ account: "max1", metric: "five_hour", ts, remaining: maxRem });
  }
  state.data = { now, history: swapHist, history_bucket: 120 };
  const items = [{ a: pro }, { a: max }];
  const uPts = drainSeries(items, "five_hour", now - 24 * 3600, now, "units");
  const wPts = drainSeries(items, "five_hour", now - 24 * 3600, now, "weighted");
  const rPts = drainSeries(items, "five_hour", now - 24 * 3600, now, "raw");
  assert.ok(uPts.length >= 10);
  for (const p of uPts) assert.ok(Math.abs(p.value - 0.1) < 1e-4, `units drift: ${p.value}`);
  for (const p of wPts) assert.ok(Math.abs(p.value - 10 / 6) < 1e-3, `weighted drift: ${p.value}`);
  assert.ok(Math.abs(rPts[0].value - 10) < 0.1);
  assert.ok(Math.abs(rPts.at(-1).value - 2) < 0.1);

  // 9d. Cross-provider allDrainSeries stacks Claude + Codex accurately.
  const codex = { id: "o1", name: "o1.json", provider: "codex", weight: 2, quota_at: now, windows: [] };
  state.data = {
    now,
    history_bucket: 120,
    history: [
      ...linearHistory("pro1", "five_hour", now, 2, 70, 12),
      ...linearHistory("o1", "rate_limit:5h", now, 2, 80, 4),
    ],
  };
  const allItems = [
    { a: pro, metric: "five_hour" },
    { a: codex, metric: "rate_limit:5h" },
  ];
  const allW = allDrainSeries(["claude", "codex"], allItems, now - 24 * 3600, now, "weighted");
  assert.ok(allW.length > 0);
  const lastW = allW.at(-1);
  assert.ok(Math.abs(lastW.value - 8) < 0.05); // avg(12, 4) = 8%/h
  assert.ok(Math.abs(lastW.partLabels.claude - 12) < 0.05);
  assert.ok(Math.abs(lastW.partLabels.codex - 4) < 0.05);
  assert.ok(Math.abs(lastW.parts.claude + lastW.parts.codex - lastW.value) < 1e-6);

  // 9e. ratePlot renders an actual SVG figure with data-chart and /h axis labels (never .rate-card).
  const html = ratePlot("claude-total-drain", "Claude total", [{ a: pro }], "five_hour", "raw");
  assert.ok(html.includes('data-chart="claude-total-drain"'));
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("%/h"));
  assert.ok(!html.includes("rate-card"));
  assert.ok(niceRateMax(0, "raw") === 10 && niceRateMax(0, "units") === 1);
  assert.ok(niceRateMax(10, "raw") === 12);
}

// 10. Idlenet (silo) split drain attribution + quota bar projections (white = ours, orange = other users).
{
  state.burn = 2;
  state.forecast = true;
  const seat = {
    id: "silo:s2",
    name: "s2",
    provider: "claude",
    silo: true,
    weight: 5,
    quota_at: now,
    windows: [],
  };
  const personal = {
    id: "c1",
    name: "c1.json",
    provider: "claude",
    silo: false,
    weight: 5,
    quota_at: now,
    windows: [],
  };
  // Over 2h (10m steps):
  // - First hour (now-7200..now-3600): we sent requests (req count 10 -> 16), quota dropped 10% (80 -> 70).
  // - Second hour (now-3600..now): we sent ZERO requests (req count stayed 16), quota dropped 20% (70 -> 50).
  // Expected over 2h: total = 15%/h, ours = 5%/h, external = 10%/h.
  const hist = [];
  const samples = [];
  let reqs = 10;
  for (let m = 0; m <= 120; m += 10) {
    const ts = now - (120 - m) * 60;
    let rem;
    if (m <= 60) {
      rem = 80 - (m / 60) * 10;
      if (m > 0) reqs += 1;
    } else {
      rem = 70 - ((m - 60) / 60) * 20;
    }
    hist.push({ account: "silo:s2", metric: "seven_day", ts, remaining: rem });
    samples.push([ts, reqs]);
  }
  hist.push(...linearHistory("c1", "seven_day", now, 2, 70, 5));
  state.data = {
    now,
    history_bucket: 120,
    history: hist,
    silo_activity: { "silo:s2": { samples, hourly: {}, hourly_range: null } },
  };

  const split = drainSplitFor(seat, "seven_day", now);
  assert.ok(split && split.hasAttribution);
  assert.ok(Math.abs(split.total - 15) < 0.05, `total=${split.total}`);
  assert.ok(Math.abs(split.ours - 5) < 0.05, `ours=${split.ours}`);
  assert.ok(Math.abs(split.external - 10) < 0.05, `external=${split.external}`);

  // Split time-series carries ours & external parts.
  const splitSeries = accountDrainSplitSeries(seat, "seven_day", now - 24 * 3600, now);
  assert.ok(splitSeries.length >= 5);
  assert.ok(Math.abs(splitSeries.at(-1).parts.ours - 5) < 0.1);
  assert.ok(Math.abs(splitSeries.at(-1).parts.external - 10) < 0.1);

  // Projection bar for Idlenet seat: 50% remaining, resets in 2h -> ours projects 40% (white), total projects 20% (orange).
  const wSeat = { id: "seven_day", remaining: 50, reset_at: now + 2 * 3600, period: 7 * 86400 };
  const projSeat = quotaProjection(seat, wSeat, now);
  assert.ok(projSeat);
  assert.ok(Math.abs(projSeat.projOurs - 40) < 0.1);
  assert.ok(Math.abs(projSeat.projTotal - 20) < 0.1);
  assert.equal(projSeat.hasOurs, true);
  assert.equal(projSeat.hasExternal, true);

  const seatHtml = quotaMeter(seat, wSeat, false);
  assert.ok(seatHtml.includes("meter-tick ours"), "expected white tick for our drain");
  assert.ok(seatHtml.includes("meter-tick external"), "expected orange tick for external drain");
  assert.ok(seatHtml.includes("meter-drain external"), "expected orange drain slice");
  assert.ok(seatHtml.includes("Other users +10%/h"));

  // Personal account: white tick only, never orange.
  const wPersonal = { id: "seven_day", remaining: 70, reset_at: now + 4 * 3600, period: 7 * 86400 };
  const personalHtml = quotaMeter(personal, wPersonal, false);
  assert.ok(personalHtml.includes("meter-tick ours"), "expected white tick on personal bar");
  assert.ok(!personalHtml.includes("meter-tick external"), "personal account should have no orange tick");

  // Hourly tokens_live fallback when 5m samples are absent.
  const hStart = Math.floor((now - 7200) / 3600) * 3600;
  state.data.silo_activity = {
    "silo:s2": {
      samples: [],
      hourly: {}, // 0 requests from us across the whole covered range
      hourly_range: [hStart, hStart + 4 * 3600],
    },
  };
  const extOnly = drainSplitFor(seat, "seven_day", now);
  assert.ok(extOnly && Math.abs(extOnly.ours) < 1e-6 && Math.abs(extOnly.external - 15) < 0.05);
  const extOnlyHtml = quotaMeter(seat, wSeat, false);
  assert.ok(!extOnlyHtml.includes("meter-tick ours"), "no white tick when our drain is 0");
  assert.ok(extOnlyHtml.includes("meter-tick external"), "orange tick shown for external-only drain");
}

// 9. Accounts page 5-hour / Weekly usage bar switch
{
  const now = 1_750_000_000;
  const claudeAcct = {
    id: "claude-1",
    provider: "claude",
    email: "claude@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "five_hour", label: "5-hour limit", remaining: 82, period: 5 * 3600, reset_at: now + 3600 },
      { id: "seven_day_sonnet", label: "Weekly · Sonnet", remaining: 40, period: 7 * 86400, reset_at: now + 86400 },
      { id: "seven_day", label: "Weekly limit", remaining: 61, period: 7 * 86400, reset_at: now + 86400 },
    ],
  };
  const codexAcct = {
    id: "codex-1",
    provider: "codex",
    email: "codex@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "code_review_rate_limit:7d", label: "Code review · Weekly limit", remaining: 100, period: 7 * 86400, reset_at: now + 86400 },
      { id: "rate_limit:5h", label: "5-hour limit", remaining: 91, period: 5 * 3600, reset_at: now + 3600 },
      { id: "rate_limit:7d", label: "Weekly limit", remaining: 48, period: 7 * 86400, reset_at: now + 86400 },
    ],
  };
  const agyAcct = {
    id: "agy-1",
    provider: "antigravity",
    email: "agy@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "claude:5h", label: "Claude & GPT · 5-hour limit", group: "Claude & GPT", remaining: 30, period: 5 * 3600, reset_at: now + 3600 },
      { id: "claude:weekly", label: "Claude & GPT · Weekly limit", group: "Claude & GPT", remaining: 25, period: 7 * 86400, reset_at: now + 86400 },
      { id: "gemini:5h", label: "Gemini · 5-hour limit", group: "Gemini", remaining: 75, period: 5 * 3600, reset_at: now + 3600 },
      { id: "gemini:weekly", label: "Gemini · Weekly limit", group: "Gemini", remaining: 55, period: 7 * 86400, reset_at: now + 86400 },
    ],
  };
  const devinAcct = {
    id: "devin-1",
    provider: "devin",
    email: "devin@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "daily", label: "Daily limit", remaining: 64, period: 86400, reset_at: now + 3600 },
      { id: "weekly", label: "Weekly limit", remaining: 33, period: 7 * 86400, reset_at: now + 86400 },
    ],
  };
  const weeklyOnlyCodex = {
    id: "codex-pro",
    provider: "codex",
    email: "pro@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "rate_limit:7d", label: "Weekly limit", remaining: 77, period: 7 * 86400, reset_at: now + 86400 },
    ],
  };
  const xaiAcct = {
    id: "xai-1",
    provider: "xai",
    email: "xai@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "credits", label: "Monthly credits", remaining: 88, period: 30 * 86400, reset_at: now + 86400 },
    ],
  };

  assert.equal(accountListWindow(claudeAcct, "5h")?.id, "five_hour");
  assert.equal(accountListWindow(claudeAcct, "7d")?.id, "seven_day");
  assert.equal(accountListWindow(codexAcct, "5h")?.id, "rate_limit:5h");
  assert.equal(accountListWindow(codexAcct, "7d")?.id, "rate_limit:7d");
  assert.equal(accountListWindow(agyAcct, "5h")?.id, "gemini:5h");
  assert.equal(accountListWindow(agyAcct, "7d")?.id, "gemini:weekly");
  assert.equal(accountListWindow(devinAcct, "5h")?.id, "daily");
  assert.equal(accountListWindow(devinAcct, "7d")?.id, "weekly");
  assert.equal(accountListWindow(weeklyOnlyCodex, "5h"), undefined);
  assert.equal(accountListWindow(weeklyOnlyCodex, "7d")?.id, "rate_limit:7d");
  assert.equal(accountListWindow(xaiAcct, "5h")?.id, "credits");
  assert.equal(accountListWindow(xaiAcct, "7d")?.id, "credits");

  state.provider = "all";
  state.data = {
    now,
    history: [],
    accounts: [claudeAcct, codexAcct],
  };
  state.accountWindow = "5h";
  const html5h = accountsPage();
  assert.ok(html5h.includes('data-acct-win="5h" class="active" aria-pressed="true"'));
  assert.ok(html5h.includes('data-acct-win="7d" class="" aria-pressed="false"'));
  assert.ok(html5h.includes("82%"));
  assert.ok(html5h.includes("91%"));
  assert.ok(!html5h.includes("61%"));
  assert.ok(!html5h.includes("48%"));

  state.accountWindow = "7d";
  const html7d = accountsPage();
  assert.ok(html7d.includes('data-acct-win="5h" class="" aria-pressed="false"'));
  assert.ok(html7d.includes('data-acct-win="7d" class="active" aria-pressed="true"'));
  assert.ok(html7d.includes("61%"));
  assert.ok(html7d.includes("48%"));
  assert.ok(!html7d.includes("82%"));
  assert.ok(!html7d.includes("91%"));
}

// 11. Graph hover tooltip info: drain rate, demand, runway, cap headroom, Silo split, burners, and forecast spillover.
{
  const makeFakePlot = (key) => {
    const noop = () => {};
    const makeNode = () => ({
      hidden: true,
      textContent: "",
      innerHTML: "",
      clientWidth: 800,
      clientHeight: 240,
      offsetWidth: 180,
      offsetHeight: 110,
      dataset: {},
      style: { setProperty: noop },
      classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
      setAttribute: noop,
      removeAttribute() {
        this._hasHidden = false;
      },
      hasAttribute(attr) {
        return attr === "hidden" ? Boolean(this._hasHidden) : false;
      },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 240 }),
      querySelector(sel) {
        if (!this._children) this._children = {};
        if (!this._children[sel]) this._children[sel] = makeNode();
        return this._children[sel];
      },
      querySelectorAll: () => [],
      _hasHidden: true,
    });
    const el = makeNode();
    el.dataset.chart = key;
    return el;
  };

  // 11a. Single 5x personal account on Remaining & Drain graphs.
  state.burn = 3;
  state.hours = 24;
  state.forecast = true;
  const maxAcct = {
    id: "m1",
    name: "max1.json",
    nickname: "Max One",
    provider: "claude",
    weight: 5,
    quota_at: now,
    cooldowns: [],
    windows: [{ id: "seven_day", remaining: 70, reset_at: null, period: 7 * 86400 }],
  };
  state.data = {
    now,
    history_bucket: 120,
    routing_strategy: "fill-first",
    accounts: [maxAcct],
    history: linearHistory("m1", "seven_day", now, 3, 70, 10),
  };
  plot("claude-0", "Max One", [{ a: maxAcct, w: maxAcct.windows[0] }], "seven_day");
  const singleChart = state.charts["claude-0"];
  const lastPt = singleChart.points.at(-1);
  const singleInfo = chartHoverInfo(singleChart, lastPt);
  assert.ok(Math.abs(singleInfo.rate - 10) < 0.05, `expected 10%/h, got ${singleInfo.rate}`);
  assert.ok(Math.abs(singleInfo.demandUnits - 0.5) < 1e-3);
  assert.ok(Math.abs(singleInfo.runwaySec - 7 * 3600) < 60);

  const singlePlotEl = makeFakePlot("claude-0");
  inspectChart(singlePlotEl, lastPt);
  const singleTip = singlePlotEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(singleTip.includes("3h drain"), `expected drain label in tooltip: ${singleTip}`);
  assert.ok(singleTip.includes("10%/h"), `expected 10%/h in tooltip: ${singleTip}`);
  assert.ok(singleTip.includes("Demand") && singleTip.includes("0.5x/h"), `expected Demand 0.5x/h: ${singleTip}`);
  assert.ok(singleTip.includes("Used") && singleTip.includes("30%"), `expected Used 30%: ${singleTip}`);
  assert.ok(singleTip.includes("Est. runway") && singleTip.includes("7h"), `expected Est. runway 7h: ${singleTip}`);
  const singleInspect = singlePlotEl.querySelector(".chart-inspect").textContent;
  assert.ok(singleInspect.includes("10%/h drain") && singleInspect.includes("~7h runway"), singleInspect);

  // Earliest sample (<10m history) must NOT invent a drain rate.
  const firstInfo = chartHoverInfo(singleChart, singleChart.points[0]);
  assert.equal(firstInfo.rate, null);
  inspectChart(singlePlotEl, singleChart.points[0]);
  assert.ok(!singlePlotEl.querySelector(".chart-tooltip").innerHTML.includes("3h drain"));

  // Drain rate chart hover shows Remaining, Demand, and Est. runway.
  ratePlot("claude-0-drain", "Max One", [{ a: maxAcct, w: maxAcct.windows[0] }], "seven_day");
  const drainChart = state.charts["claude-0-drain"];
  const drainPt = drainChart.points.at(-1);
  const drainInfo = chartHoverInfo(drainChart, drainPt);
  assert.ok(Math.abs(drainInfo.remaining - 70) < 0.5, `expected remaining ~70%, got ${drainInfo.remaining}`);
  assert.ok(Math.abs(drainInfo.demandUnits - 0.5) < 1e-2);
  assert.ok(Math.abs(drainInfo.runwaySec - 7 * 3600) < 180);
  const drainPlotEl = makeFakePlot("claude-0-drain");
  inspectChart(drainPlotEl, drainPt);
  const drainTip = drainPlotEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(drainTip.includes("Remaining") && drainTip.includes("70%"), drainTip);
  assert.ok(drainTip.includes("Est. runway") && drainTip.includes("7h"), drainTip);
  assert.ok(drainPlotEl.querySelector(".chart-inspect").textContent.includes("70% remaining"));

  // 11b. Shared Idlenet (Silo) seat with 85% cap & external drain split.
  state.burn = 2;
  const seat = {
    id: "silo:s2",
    name: "s2",
    nickname: "Seat Two",
    provider: "claude",
    silo: true,
    cap_percent: 85,
    weight: 5,
    quota_at: now,
    cooldowns: [],
    windows: [{ id: "seven_day", remaining: 50, reset_at: null, period: 7 * 86400 }],
  };
  const siloHist = [];
  const siloSamples = [];
  let reqs = 10;
  for (let m = 0; m <= 120; m += 10) {
    const ts = now - (120 - m) * 60;
    let rem;
    if (m <= 60) {
      rem = 80 - (m / 60) * 10;
      if (m > 0) reqs += 1;
    } else {
      rem = 70 - ((m - 60) / 60) * 20;
    }
    siloHist.push({ account: "silo:s2", metric: "seven_day", ts, remaining: rem });
    siloSamples.push([ts, reqs]);
  }
  state.data = {
    now,
    history_bucket: 120,
    routing_strategy: "fill-first",
    accounts: [seat],
    history: siloHist,
    silo_activity: { "silo:s2": { samples: siloSamples, hourly: {}, hourly_range: null } },
  };
  plot("claude-silo", "Seat Two", [{ a: seat, w: seat.windows[0] }], "seven_day");
  const siloChart = state.charts["claude-silo"];
  const siloLast = siloChart.points.at(-1);
  const siloInfo = chartHoverInfo(siloChart, siloLast);
  assert.equal(siloInfo.hasExternal, true);
  assert.ok(Math.abs(siloInfo.rate - 15) < 0.1);
  assert.ok(Math.abs(siloInfo.oursRate - 5) < 0.1);
  assert.ok(Math.abs(siloInfo.extRate - 10) < 0.1);
  // 50% remaining with 85% cap (15% floor) => 35% headroom / 15%/h = 2h 20m runway.
  assert.ok(Math.abs(siloInfo.runwaySec - (35 / 15) * 3600) < 120);
  const siloPlotEl = makeFakePlot("claude-silo");
  inspectChart(siloPlotEl, siloLast);
  const siloTip = siloPlotEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(siloTip.includes("Ours") && siloTip.includes("5.0%/h"), siloTip);
  assert.ok(siloTip.includes("Other users") && siloTip.includes("10.0%/h"), siloTip);
  assert.ok(siloTip.includes("To 85% cap") && siloTip.includes("35%"), siloTip);
  assert.ok(siloTip.includes("2h 20m"), siloTip);

  // Projected point after hitting the 85% cap shows At 85% cap and 0%/h est. drain.
  const cappedProj = seriesAt(siloChart, now + 5 * 3600);
  const cappedInfo = chartHoverInfo(siloChart, cappedProj);
  assert.equal(cappedInfo.exhausted, true);
  assert.equal(cappedInfo.rate, 0);
  inspectChart(siloPlotEl, cappedProj);
  const cappedTip = siloPlotEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(cappedTip.includes("Est. drain") && cappedTip.includes("0%/h"), cappedTip);
  assert.ok(cappedTip.includes("At 85% cap"), cappedTip);

  // 11c. Multi-account provider total (Pro 1x + Max 5x) with fill-first spillover & active burner names.
  state.burn = 3;
  state.hours = 72;
  const alice = {
    id: "pro1", name: "a-pro1.json", nickname: "Alice", provider: "claude",
    weight: 1, quota_at: now, detail: { priority: 1 }, cooldowns: [],
    windows: [{ id: "seven_day", remaining: 20, reset_at: null, period: 7 * 86400 }],
  };
  const bob = {
    id: "max1", name: "b-max1.json", nickname: "Bob", provider: "claude",
    weight: 5, quota_at: now, detail: { priority: 0 }, cooldowns: [],
    windows: [{ id: "seven_day", remaining: 100, reset_at: null, period: 7 * 86400 }],
  };
  const poolItems = [
    { a: alice, w: alice.windows[0] },
    { a: bob, w: bob.windows[0] },
  ];
  state.data = {
    now,
    history_bucket: 120,
    routing_strategy: "fill-first",
    accounts: [alice, bob],
    history: [
      ...linearHistory("pro1", "seven_day", now, 3, 20, 10),
      ...linearHistory("max1", "seven_day", now, 3, 100, 0),
    ],
  };
  plot("claude-total-raw", "Claude total", poolItems, "seven_day", null, null, "raw");
  const poolRawChart = state.charts["claude-total-raw"];
  const recPoolInfo = chartHoverInfo(poolRawChart, poolRawChart.points.at(-1));
  assert.ok(Math.abs(recPoolInfo.rate - 10) < 0.1);
  assert.ok(Math.abs(recPoolInfo.demandUnits - 0.1) < 1e-3);
  assert.equal(recPoolInfo.burners.length, 1);
  assert.equal(recPoolInfo.burners[0].name, "Alice");
  // Projected at +1h (still on Alice): 10%/h raw, active = Alice.
  const projPre = seriesAt(poolRawChart, now + 1 * 3600);
  assert.ok(Math.abs(projPre.rate - 10) < 0.05);
  assert.deepEqual([...projPre.activeNames], ["Alice"]);
  // Projected at +10h (spilled over to Bob 5x): 2%/h raw, active = Bob.
  const projPost = seriesAt(poolRawChart, now + 10 * 3600);
  assert.ok(Math.abs(projPost.rate - 2) < 0.05, `expected 2%/h after spillover, got ${projPost.rate}`);
  assert.deepEqual([...projPost.activeNames], ["Bob"]);
  const poolPlotEl = makeFakePlot("claude-total-raw");
  inspectChart(poolPlotEl, projPost);
  const projPostTip = poolPlotEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(projPostTip.includes("Est. drain") && projPostTip.includes("2%/h"), projPostTip);
  assert.ok(projPostTip.includes("Active") && projPostTip.includes("Bob"), projPostTip);

  // 11d. All accounts stacked chart (Remaining & Drain) shows per-provider drain / remaining without inventing cross-provider runway.
  state.burn = 1;
  state.hours = 24;
  const codexAcct = {
    id: "o1", name: "o1.json", nickname: "Codex One", provider: "codex",
    weight: 2, quota_at: now, cooldowns: [],
    windows: [{ id: "rate_limit:5h", remaining: 80, reset_at: null, period: 5 * 3600 }],
  };
  const claudeAcct2 = {
    id: "c1", name: "c1.json", nickname: "Claude One", provider: "claude",
    weight: 1, quota_at: now, cooldowns: [],
    windows: [{ id: "five_hour", remaining: 70, reset_at: null, period: 5 * 3600 }],
  };
  const allItems2 = [
    { a: claudeAcct2, w: claudeAcct2.windows[0], metric: "five_hour" },
    { a: codexAcct, w: codexAcct.windows[0], metric: "rate_limit:5h" },
  ];
  state.data = {
    now,
    history_bucket: 120,
    routing_strategy: "fill-first",
    accounts: [claudeAcct2, codexAcct],
    history: [
      ...linearHistory("c1", "five_hour", now, 2, 70, 12),
      ...linearHistory("o1", "rate_limit:5h", now, 2, 80, 4),
    ],
  };
  const allOrder = ["claude", "codex"];
  plot(
    "all-total",
    "All accounts total",
    allItems2,
    null,
    [{ ts: now - 3600, value: 83, units: 2.5, parts: { claude: 41, codex: 42 }, partLabels: { claude: 82, codex: 84 } }],
    { order: allOrder, parts: { claude: 35, codex: 40 }, partLabels: { claude: 70, codex: 80 }, latestValue: 75 },
    "weighted",
  );
  const allChart = state.charts["all-total"];
  const allLast = allChart.points.at(-1);
  const allInfo = chartHoverInfo(allChart, allLast);
  assert.ok(Math.abs(allInfo.rate - 8) < 0.1, `expected avg drain 8%/h, got ${allInfo.rate}`);
  assert.ok(Math.abs(allInfo.partRates.claude - 12) < 0.1);
  assert.ok(Math.abs(allInfo.partRates.codex - 4) < 0.1);
  assert.equal(allInfo.runwaySec, null, "cross-provider chart must not invent a pooled runway");
  const allPlotEl = makeFakePlot("all-total");
  inspectChart(allPlotEl, allLast);
  const allTip = allPlotEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(allTip.includes("tip-table has-sub"), `expected aligned 2-column table: ${allTip}`);
  assert.ok(allTip.includes("70.0%") && allTip.includes("80.0%"), `expected aligned primary column: ${allTip}`);
  assert.ok(allTip.includes("12.0%/h") && allTip.includes("4.0%/h"), `expected aligned burn column: ${allTip}`);
  assert.ok(allTip.includes("1h drain") && allTip.includes("8.0%/h"), allTip);
  assert.ok(allTip.includes("Demand") && allTip.includes("0.2x/h"), allTip);
  // Projected point on All accounts also carries per-provider projected values and drain rates.
  const allProj = seriesAt(allChart, now + 1 * 3600);
  assert.ok(allProj.partLabels && Math.abs(allProj.partLabels.claude - 58) < 0.2);
  assert.ok(allProj.partLabels && Math.abs(allProj.partLabels.codex - 76) < 0.2);
  assert.ok(allProj.partRates && Math.abs(allProj.partRates.claude - 12) < 0.1);
  assert.ok(allProj.partRates && Math.abs(allProj.partRates.codex - 4) < 0.1);

  // All accounts Drain rate graph hover shows remaining + per-provider remaining in aligned columns.
  const allDrainPts = allDrainSeries(allOrder, allItems2, now - 24 * 3600, now, "weighted");
  ratePlot("all-total-drain", "All accounts total", allItems2, null, "weighted", allDrainPts, { order: allOrder }, "", null, true);
  const allDrainChart = state.charts["all-total-drain"];
  const allDrainInfo = chartHoverInfo(allDrainChart, allDrainChart.points.at(-1));
  assert.ok(Math.abs(allDrainInfo.remaining - 75) < 0.5);
  assert.ok(Math.abs(allDrainInfo.partRemaining.claude - 70) < 0.5);
  assert.ok(Math.abs(allDrainInfo.partRemaining.codex - 80) < 0.5);
  const allDrainPlotEl = makeFakePlot("all-total-drain");
  inspectChart(allDrainPlotEl, allDrainChart.points.at(-1));
  const allDrainTip = allDrainPlotEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(allDrainTip.includes("tip-table has-sub"), allDrainTip);
  assert.ok(allDrainTip.includes("Remaining") && allDrainTip.includes("75.0%"), allDrainTip);
  assert.ok(allDrainTip.includes("70.0%") && allDrainTip.includes("80.0%"), allDrainTip);
}

// 10. Calibrated API $ universal unit: formatting, swap invariance, failover parity, and cross-provider stacking.
{
  state.burn = 3;
  state.hours = 24;
  state.forecast = true;

  // 10a. fmtApiUsd formatting across orders of magnitude (in calibrated Compute Units, CU).
  assert.equal(fmtApiUsd(0), "0 CU");
  assert.equal(fmtApiUsd(0.004), "<0.01 CU");
  assert.equal(fmtApiUsd(4.25), "4.25 CU");
  assert.equal(fmtApiUsd(46.23), "46.2 CU");
  assert.equal(fmtApiUsd(1847.4), "1,847 CU");
  assert.equal(fmtApiUsd(12460), "12.5k CU");

  // 10b. Pro (1x, $50) -> Max (5x, $250) swap-over stays invariant in API $ burn rate ($5/h)
  //      and produces the exact same 52h exhaustion timestamp as weighted/units/raw.
  const pro = {
    id: "pro_u", name: "a-pro.json", provider: "claude", weight: 1, quota_at: now,
    detail: { priority: 1 }, windows: [],
  };
  const max = {
    id: "max_u", name: "b-max.json", provider: "claude", weight: 5, quota_at: now,
    detail: { priority: 0 }, windows: [],
  };
  const claudeItems = [
    { a: pro, w: { id: "seven_day", remaining: 20, reset_at: null, period: 7 * 86400, api_usd: 50 } },
    { a: max, w: { id: "seven_day", remaining: 100, reset_at: null, period: 7 * 86400, api_usd: 250 } },
  ];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history_bucket: 120,
    history: [
      ...linearHistory("pro_u", "seven_day", now, 3, 20, 10),
      ...linearHistory("max_u", "seven_day", now, 3, 100, 0),
    ],
  };
  assert.equal(windowApiUsd(pro, claudeItems[0].w), 50);
  assert.equal(windowApiUsd(max, claudeItems[1].w), 250);
  assert.ok(Math.abs(poolDrain(claudeItems, "seven_day", now, "usd") - 5.0) < 1e-6);

  const fcUsd = forecastPoints(claudeItems, "seven_day", now, now + 60 * 3600, "usd");
  assert.ok(Math.abs(fcUsd[0].value - 260) < 1e-4); // $10 on Pro + $250 on Max = $260
  const emptyUsd = fcUsd.find((p) => p.exhausted || p.value <= 0.01);
  assert.ok(emptyUsd, "expected exhaustion in usd mode");
  assert.ok(Math.abs((emptyUsd.ts - now) / 3600 - 52) < 0.05);

  // Mid-swap: Pro 6%/h ($3/h) + Max 0.8%/h ($2/h) = $5/h; after swap: Max 2%/h = $5/h.
  state.data.history = [
    ...linearHistory("pro_u", "seven_day", now, 3, 0, 6),
    ...linearHistory("max_u", "seven_day", now, 3, 97.6, 0.8),
  ];
  assert.ok(Math.abs(poolDrain(claudeItems, "seven_day", now, "usd") - 5.0) < 1e-6);
  state.data.history = [
    ...linearHistory("pro_u", "seven_day", now, 3, 0, 0),
    ...linearHistory("max_u", "seven_day", now, 3, 94, 2),
  ];
  assert.ok(Math.abs(poolDrain(claudeItems, "seven_day", now, "usd") - 5.0) < 1e-6);

  // 10c. Cross-provider All accounts stacks true API $ (Claude $1,850 vs Antigravity $72),
  //      and allDrainSeries sums provider $/h cleanly without skewing by disparate plan sizes.
  const agy = { id: "agy_u", name: "agy.json", provider: "antigravity", weight: 5, quota_at: now, windows: [] };
  const allItems = [
    { a: max, metric: "seven_day", w: { id: "seven_day", remaining: 50, reset_at: null, period: 7 * 86400, api_usd: 1850 } },
    { a: agy, metric: "gemini:weekly", w: { id: "gemini:weekly", remaining: 50, reset_at: null, period: 7 * 86400, api_usd: 72 } },
  ];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history_bucket: 120,
    history: [
      ...linearHistory("max_u", "seven_day", now, 2, 50, 2),       // 2%/h of $1,850 = $37/h
      ...linearHistory("agy_u", "gemini:weekly", now, 2, 50, 10), // 10%/h of $72 = $7.20/h
    ],
  };
  const allUsdDrain = allDrainSeries(["claude", "antigravity"], allItems, now - 24 * 3600, now, "usd");
  assert.ok(allUsdDrain.length > 0);
  const lastUsd = allUsdDrain.at(-1);
  assert.ok(Math.abs(lastUsd.parts.claude - 37.0) < 0.2, `claude=$/h=${lastUsd.parts.claude}`);
  assert.ok(Math.abs(lastUsd.parts.antigravity - 7.2) < 0.2, `agy=$/h=${lastUsd.parts.antigravity}`);
  assert.ok(Math.abs(lastUsd.value - 44.2) < 0.3, `total=$/h=${lastUsd.value}`);

  // Forecast in All accounts usd mode starts at $925 + $36 = $961 and drains Claude ($37/h) + AGY ($7.20/h).
  const allFcUsd = forecastPoints(allItems, null, now, now + 10 * 3600, "usd");
  assert.ok(Math.abs(allFcUsd[0].value - 961) < 0.1);
  // At +5h: AGY empties ($36 -> $0), Claude loses $185 ($925 -> $740).
  // At +10h: AGY stays $0, Claude loses another $185 ($740 -> $555).
  assert.ok(Math.abs(allFcUsd.at(-1).value - 555) < 1.0, `expected ~$555 at +10h, got ${allFcUsd.at(-1).value}`);

  // 10d. ratePlot renders CU/h axis labels cleanly in usd/CU mode, and hover shows CU/h & CU remaining.
  const usdRateHtml = ratePlot("claude-usd-drain", "Claude total", claudeItems, "seven_day", "usd");
  assert.ok(usdRateHtml.includes("CU/h"));
  plot("claude-usd-rem", "Claude total", claudeItems, "seven_day", null, null, "usd");
  const usdRemChart = state.charts["claude-usd-rem"];
  const usdHoverRec = chartHoverInfo(usdRemChart, usdRemChart.points.at(-1));
  assert.ok(Math.abs(usdHoverRec.rate - 5.0) < 0.1, `expected 5 CU/h recorded hover, got ${usdHoverRec.rate}`);
  const usdHoverProj = chartHoverInfo(usdRemChart, seriesAt(usdRemChart, now + 5 * 3600));
  assert.ok(Math.abs(usdHoverProj.rate - 5.0) < 0.1, `expected 5 CU/h projected hover, got ${usdHoverProj.rate}`);
}

// 12. Mobile tooltip placement: floats cleanly above the chart when room exists, or docks opposite the finger near the top edge.
{
  const prevWidth = ctx.innerWidth;
  try {
    ctx.innerWidth = 390;
    const noop = () => {};
    const makeMobilePlot = (key, svgTop) => {
      const makeNode = (isSvg = false) => ({
        hidden: true,
        textContent: "",
        innerHTML: "",
        clientWidth: 340,
        clientHeight: 200,
        offsetWidth: 170,
        offsetHeight: 110,
        dataset: {},
        style: { setProperty: noop },
        classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
        setAttribute: noop,
        removeAttribute() {
          this._hasHidden = false;
        },
        hasAttribute(attr) {
          return attr === "hidden" ? Boolean(this._hasHidden) : false;
        },
        getBoundingClientRect: () => ({ top: isSvg ? svgTop : 0, bottom: 0, left: 0, width: 340, height: 200 }),
        querySelector(sel) {
          if (!this._children) this._children = {};
          if (!this._children[sel]) this._children[sel] = makeNode(sel === "svg");
          return this._children[sel];
        },
        querySelectorAll: () => [],
        _hasHidden: true,
      });
      const el = makeNode(false);
      el.dataset.chart = key;
      return el;
    };
    const mobAcct = {
      id: "mob1", name: "mob1.json", provider: "claude", weight: 1, quota_at: now,
      cooldowns: [], windows: [{ id: "five_hour", remaining: 70, reset_at: null, period: 5 * 3600 }],
    };
    state.burn = 1;
    state.hours = 24;
    state.forecast = true;
    state.data = {
      now, history_bucket: 120, routing_strategy: "fill-first", accounts: [mobAcct],
      history: linearHistory("mob1", "five_hour", now, 3, 70, 10),
    };
    plot("mob-chart", "Mobile Test", [{ a: mobAcct, w: mobAcct.windows[0] }], "five_hour");
    const chart = state.charts["mob-chart"];
    assert.ok(chart && chart.points.length >= 2 && chart.forecast.length >= 2);

    // Room above chart (svgTop = 260 >= 110 + 10 + 8): floats cleanly above the SVG (negative Y).
    const plotRoom = makeMobilePlot("mob-chart", 260);
    inspectChart(plotRoom, chart.points.at(-1));
    const tfRoom = plotRoom.querySelector(".chart-tooltip").style.transform;
    const mRoom = tfRoom.match(/translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px/);
    assert.ok(mRoom && Number(mRoom[2]) < 0, `expected above-chart tooltip on mobile, got ${tfRoom}`);

    // Near viewport top (svgTop = 40 < 110 + 18): docks at top=4 inside SVG opposite the finger.
    const plotTight = makeMobilePlot("mob-chart", 40);
    inspectChart(plotTight, chart.points[0]); // near left edge -> tooltip docks right
    const tfLeft = plotTight.querySelector(".chart-tooltip").style.transform;
    const mLeft = tfLeft.match(/translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px/);
    assert.ok(mLeft && Number(mLeft[2]) === 4 && Number(mLeft[1]) >= 150, `expected right-docked tooltip, got ${tfLeft}`);

    inspectChart(plotTight, chart.forecast.at(-1)); // near right edge -> tooltip docks left
    const tfRight = plotTight.querySelector(".chart-tooltip").style.transform;
    const mRight = tfRight.match(/translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px/);
    assert.ok(mRight && Number(mRight[2]) === 4 && Number(mRight[1]) === 4, `expected left-docked tooltip, got ${tfRight}`);
  } finally {
    ctx.innerWidth = prevWidth;
  }
}

// 13. Long-range (7d / 14d) downsampled drain series stay continuous without spurious gap flags,
//     still break on real recording outages, and niceRateMax uses the 2.5 step (e.g. 250 instead of 300).
{
  state.burn = 1;
  state.hours = 168; // 7d -> history_bucket = 840s, gap = 2100s, minStep (~3360s) > gap
  const bucket7d = 840;
  const cAcct = { id: "c7d", name: "c7d.json", provider: "claude", weight: 1, quota_at: now, windows: [] };
  const oAcct = { id: "o7d", name: "o7d.json", provider: "codex", weight: 1, quota_at: now, windows: [] };
  const hist7d = [];
  const start7d = now - 168 * 3600;
  for (let ts = start7d; ts <= now; ts += bucket7d) {
    // Drop 0.5% per bucket, resetting when low so remaining stays in [10, 100].
    const step = Math.floor((ts - start7d) / bucket7d);
    const rem = 100 - ((step % 150) * 0.5);
    hist7d.push({ account: "c7d", metric: "seven_day", ts, remaining: rem });
    hist7d.push({ account: "o7d", metric: "rate_limit:7d", ts, remaining: rem });
  }
  state.data = { now, history_bucket: bucket7d, history: hist7d };
  const allItems7d = [
    { a: cAcct, metric: "seven_day" },
    { a: oAcct, metric: "rate_limit:7d" },
  ];
  const allPts7d = allDrainSeries(["claude", "codex"], allItems7d, start7d, now, "raw");
  assert.ok(allPts7d.length >= 100, `expected >=100 downsampled 7d points, got ${allPts7d.length}`);
  assert.equal(allPts7d.filter((p) => p.gap).length, 0, "continuous 7d drain series must not mark downsampled steps as gaps");

  const poolPts7d = drainSeries([{ a: cAcct }], "seven_day", start7d, now, "raw");
  assert.ok(poolPts7d.length >= 100);
  assert.equal(poolPts7d.filter((p) => p.gap).length, 0, "continuous 7d pool drain series must not mark downsampled steps as gaps");

  const svg7d = ratePlot("all-7d-drain", "All accounts total", allItems7d, null, "raw", allPts7d, { order: ["claude", "codex"] }, "", null, true);
  assert.ok(svg7d.includes("<path d=\"M"), "expected rendered stacked paths for 7d All accounts drain chart");

  // Real 3-hour outage inside a 7d series MUST still produce a single gap flag.
  const outageStart = now - 72 * 3600;
  const outageEnd = outageStart + 3 * 3600;
  state.data = {
    now,
    history_bucket: bucket7d,
    history: hist7d.filter((r) => r.ts < outageStart || r.ts > outageEnd),
  };
  const gapPts7d = allDrainSeries(["claude", "codex"], allItems7d, start7d, now, "raw");
  assert.equal(gapPts7d.filter((p) => p.gap).length, 1, "expected exactly 1 gap flag for the 3-hour outage in 7d series");

  // niceRateMax includes the 2.5 step so ~199%/h peaks use 250%/h instead of jumping to 300%/h.
  assert.equal(niceRateMax(199.2, "raw"), 250);
  assert.equal(niceRateMax(20, "raw"), 25);
}

// The server sends history grouped by series ({account, metric, ts[], remaining[], reset_at[]}) and its
// own gap; every reader gives the same answers as with flat rows, which older servers still send.
{
  const pro = { id: "pro1", name: "claude-pro1.json", provider: "claude", weight: 1, quota_at: now, windows: [] };
  const max = { id: "max1", name: "claude-max1.json", provider: "claude", weight: 5, quota_at: now, windows: [] };
  const items = [
    { a: pro, w: { id: "five_hour", remaining: 20, reset_at: null, period: 18000 } },
    { a: max, w: { id: "five_hour", remaining: 100, reset_at: null, period: 18000 } },
  ];
  // Unsorted on purpose, with a reset inside the burn window.
  const flat = [
    ...linearHistory("max1", "five_hour", now, 3, 90, 1),
    ...linearHistory("pro1", "five_hour", now, 3, 20, 10).map((r) => ({ ...r, reset_at: r.ts < now - 3600 ? now - 3000 : null })),
  ].reverse();
  const grouped = Object.values(
    flat.reduce((acc, r) => {
      const key = `${r.account}|${r.metric}`;
      acc[key] ??= { account: r.account, metric: r.metric, rows: [] };
      acc[key].rows.push(r);
      return acc;
    }, {}),
  ).map(({ account, metric, rows }) => {
    rows.sort((x, y) => x.ts - y.ts);
    return { account, metric, ts: rows.map((r) => r.ts), remaining: rows.map((r) => r.remaining), reset_at: rows.map((r) => r.reset_at ?? null) };
  });
  const answers = () => ({
    drain: drainFor(pro, "five_hour", now),
    split: drainSplitFor(pro, "five_hour", now),
    pool: poolDrain(items, "five_hour", now, "units"),
    points: ctx.window.dashboard.parseHistory([pro, max], "five_hour"),
    series: drainSeries(items, "five_hour", now - 3 * 3600, now, "raw"),
  });
  state.data = { now, history_bucket: 120, history: flat };
  const fromFlat = answers();
  state.data = { now, history_bucket: 120, history_gap: 900, history: grouped };
  const fromGrouped = answers();
  assert.ok(fromFlat.drain !== null && fromFlat.points.length > 0 && fromFlat.series.length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(fromGrouped)), JSON.parse(JSON.stringify(fromFlat)));
  // The server's gap wins over the client's fallback: an 80-minute hole is continuous only with a wide gap.
  const steady = grouped.find((s) => s.account === "max1"),
    kept = (t) => t < now - 7200 || t > now - 3600;
  const holey = { ...steady, ts: steady.ts.filter(kept), remaining: steady.remaining.filter((_, i) => kept(steady.ts[i])) };
  holey.reset_at = holey.ts.map(() => null);
  state.data = { now, history_bucket: 120, history_gap: 900, history: [holey] };
  const narrow = drainSeries([items[1]], "five_hour", now - 3 * 3600, now, "raw").filter((p) => p.gap).length;
  state.data = { now, history_bucket: 120, history_gap: 6000, history: [holey] }; // the hole spans 4800s
  const wide = drainSeries([items[1]], "five_hour", now - 3 * 3600, now, "raw").filter((p) => p.gap).length;
  assert.ok(narrow >= 1 && wide === 0, `narrow=${narrow} wide=${wide}`);
}

// Accounts that report other windows but not the selected window show "N/A" rather than "Not on plan".
{
  const maxWin = { id: "seven_day_sonnet", label: "Weekly · Sonnet", remaining: 80, reset_at: now + 86400, period: 7 * 86400 };
  const maxAcct = { id: "max1", name: "MAX 1", provider: "claude", plan: "Max 5x", weight: 5, quota_at: now, cooldowns: [], windows: [maxWin] };
  const proAcct = { id: "pro1", name: "PRO 1", provider: "claude", plan: "Pro", weight: 1, quota_at: now, cooldowns: [], windows: [{ id: "five_hour", label: "5-hour limit", remaining: 100, reset_at: null, period: 18000 }] };
  const unmeasuredAcct = { id: "pro2", name: "PRO 2", provider: "claude", plan: "Pro", weight: 1, quota_at: null, cooldowns: [], windows: [] };
  state.data = { now, accounts: [maxAcct, proAcct, unmeasuredAcct], history: [] };
  assert.match(ctx.accountRow(proAcct, 1, "seven_day_sonnet"), /<span class="acct-reset">N\/A<\/span>/);
  assert.match(ctx.accountRow(unmeasuredAcct, 2, "seven_day_sonnet"), /<span class="acct-reset">Not measured<\/span>/);
  assert.match(ctx.accountQuota("claude", proAcct, 1, "seven_day_sonnet", [maxWin]), /<p class="mini-none">N\/A<\/p>/);
  assert.equal(ctx.capacity([{ a: maxAcct, w: maxWin }], [proAcct, unmeasuredAcct]).note, "1 not measured · 1 N/A");
}

// Every quota card shows each account's capacity multiplier ("x") consistently,
// whether seats share the same weight, have mixed weights, or sit in a single/expanded card.
{
  const win = (id, period = 5 * 3600) => ({ id, label: "5-hour limit", remaining: 80, reset_at: now + 3600, period });
  const agyA = { id: "agy1", name: "agy1.json", nickname: "AGY 1", provider: "antigravity", plan: "Google AI Ultra", weight: 5, quota_at: now, cooldowns: [], windows: [win("gemini:5h")] };
  const agyB = { id: "silo:u1", name: "u1", provider: "antigravity", silo: true, plan: "Google AI Ultra", weight: 5, quota_at: now, cooldowns: [], windows: [win("gemini:5h")] };
  const codexA = { id: "silo:c1", name: "c1", provider: "codex", silo: true, plan: "ChatGPT Business Slot 1", weight: 1, quota_at: now, cooldowns: [], windows: [win("rate_limit:5h")] };
  const codexB = { id: "silo:c2", name: "c2", provider: "codex", silo: true, plan: "ChatGPT Business Slot 2", weight: 1, quota_at: now, cooldowns: [], windows: [win("rate_limit:5h")] };
  const xaiSolo = { id: "xai1", name: "xai1.json", nickname: "Grok Heavy", provider: "xai", plan: "SuperGrok Heavy", weight: 10, quota_at: now, cooldowns: [], windows: [win("credits", 7 * 86400)] };
  state.provider = "all";
  state.data = { now, accounts: [agyA, agyB, codexA, codexB, xaiSolo], history: [], totals: {} };

  const agyPool = ctx.pool("antigravity");
  const agyRows = agyPool.slice(agyPool.indexOf('<div class="acct-rows">'));
  assert.equal((agyRows.match(/<span class="acct-weight"[^>]*>5x<\/span>/g) || []).length, 2, "uniform 5x seats should each show 5x");

  const codexPool = ctx.pool("codex");
  const codexRows = codexPool.slice(codexPool.indexOf('<div class="acct-rows">'));
  assert.equal((codexRows.match(/<span class="acct-weight"[^>]*>1x<\/span>/g) || []).length, 2, "uniform 1x seats should each show 1x");

  const xaiPool = ctx.pool("xai");
  assert.match(xaiPool, /<span class="acct-label-wrap"><a class="mini-label"[^>]*>Grok Heavy<\/a><span class="acct-weight"[^>]*>10x<\/span>/, "single-account card should show its x badge");
  assert.match(agyPool, /<span class="acct-label-wrap"><a class="mini-label"[^>]*>AGY 1<\/a><span class="acct-weight"[^>]*>5x<\/span>/, "expanded account card should show its x badge");
}

// CU % (usd_pct): CU-weighted % across providers on All accounts (remaining, drain, forecast, and UI).
{
  state.burn = 3;
  state.hours = 24;
  state.forecast = true;
  state.unit = "usd_pct";
  const claude = {
    id: "c_cup", name: "c.json", provider: "claude", weight: 5, quota_at: now, cooldowns: [],
    windows: [{ id: "seven_day", label: "Weekly limit", remaining: 70, reset_at: null, period: 7 * 86400, api_usd: 800 }],
  };
  const agy = {
    id: "a_cup", name: "a.json", provider: "antigravity", weight: 5, quota_at: now, cooldowns: [],
    windows: [{ id: "gemini:weekly", label: "Gemini · Weekly", group: "Gemini", remaining: 20, reset_at: null, period: 7 * 86400, api_usd: 200 }],
  };
  // Total CU cap = 800 + 200 = 1,000 CU.
  // Remaining = 560 CU (Claude) + 40 CU (AGY) = 600 CU -> 60% CU % (NOT 45% equal-provider Pool %!).
  // Drain = Claude 10%/h (80 CU/h) + AGY 10%/h (20 CU/h) = 100 CU/h -> 10%/h of total CU pool (8%/h Claude + 2%/h AGY).
  const allItems = [
    { a: claude, metric: "seven_day", w: claude.windows[0] },
    { a: agy, metric: "gemini:weekly", w: agy.windows[0] },
  ];
  state.data = {
    now,
    routing_strategy: "fill-first",
    history_bucket: 120,
    accounts: [claude, agy],
    history: [
      ...linearHistory("c_cup", "seven_day", now, 3, 70, 10),
      ...linearHistory("a_cup", "gemini:weekly", now, 3, 20, 10),
    ],
    totals: {
      all: {
        "7d": {
          metrics: { claude: "seven_day", antigravity: "gemini:weekly" },
          points: [
            { ts: now - 3600, value: 110, units: 5.5, parts: { claude: 80, antigravity: 30 }, parts_pct: { claude: 80, antigravity: 30 }, weighted: 55, usd: 700, usd_cap: 1000, parts_usd: { claude: 640, antigravity: 60 } },
            { ts: now, value: 90, units: 4.5, parts: { claude: 70, antigravity: 20 }, parts_pct: { claude: 70, antigravity: 20 }, weighted: 45, usd: 600, usd_cap: 1000, parts_usd: { claude: 560, antigravity: 40 } },
          ],
        },
      },
    },
  };
  state.allWindow = "7d";
  state.provider = "all";
  state.view = "remaining";

  assert.ok(Math.abs(poolDrain(allItems, null, now, "usd_pct") - 10.0) < 1e-4);

  const drainPts = allDrainSeries(["claude", "antigravity"], allItems, now - 24 * 3600, now, "usd_pct");
  assert.ok(drainPts.length > 0);
  const lastD = drainPts.at(-1);
  assert.ok(Math.abs(lastD.value - 10.0) < 0.1, `expected 10%/h, got ${lastD.value}`);
  assert.ok(Math.abs(lastD.parts.claude - 8.0) < 0.1, `expected claude 8%/h, got ${lastD.parts.claude}`);
  assert.ok(Math.abs(lastD.parts.antigravity - 2.0) < 0.1, `expected agy 2%/h, got ${lastD.parts.antigravity}`);

  const fc = forecastPoints(allItems, null, now, now + 10 * 3600, "usd_pct");
  assert.ok(Math.abs(fc[0].value - 60.0) < 0.1, `expected 60%, got ${fc[0].value}`);
  assert.ok(Math.abs(fc[0].parts.claude - 56.0) < 0.1);
  assert.ok(Math.abs(fc[0].parts.antigravity - 4.0) < 0.1);
  assert.ok(Math.abs(fc[0].rate - 10.0) < 0.1);
  // AGY empties at +2h (4% -> 0%), Claude drains 8%/h -> empties at +7h -> 0% at +10h.
  const empty = fc.find((p) => p.exhausted || p.value <= 0.01);
  assert.ok(empty && Math.abs((empty.ts - now) / 3600 - 7) < 0.05);

  const html = ctx.quotaPage();
  assert.ok(html.includes('data-unit="usd_pct"'), "expected CU % unit button");
  assert.ok(html.includes(">CU %<"), "expected CU % label");
  assert.ok(html.includes("60%"), "expected 60% CU-weighted All accounts total");
  assert.ok(html.includes("of 1,000 CU pool"), "expected CU pool cap subtext");
  state.unit = "usd";
}

// 12. Idlenet seat hatching on pooled, stacked, single-account, and drain charts + tooltip breakdown.
{
  const makeFakePlot = (key) => {
    const noop = () => {};
    const makeNode = () => ({
      hidden: true,
      textContent: "",
      innerHTML: "",
      clientWidth: 800,
      clientHeight: 240,
      offsetWidth: 180,
      offsetHeight: 110,
      dataset: {},
      style: { setProperty: noop },
      classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
      setAttribute: noop,
      removeAttribute() { this._hasHidden = false; },
      hasAttribute(attr) { return attr === "hidden" ? Boolean(this._hasHidden) : false; },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 240 }),
      querySelector(sel) {
        if (!this._children) this._children = {};
        if (!this._children[sel]) this._children[sel] = makeNode();
        return this._children[sel];
      },
      querySelectorAll: () => [],
      _hasHidden: true,
    });
    const el = makeNode();
    el.dataset.chart = key;
    return el;
  };
  state.burn = 1;
  state.hours = 24;
  state.forecast = false;
  const personal = {
    id: "p1", name: "p1.json", nickname: "PLUS 1", provider: "codex",
    weight: 1, quota_at: now, cooldowns: [],
    windows: [{ id: "rate_limit:7d", label: "Weekly limit", remaining: 80, reset_at: now + 86400, period: 7 * 86400, api_usd: 100 }],
  };
  const idlenet = {
    id: "silo:c1", name: "c1", nickname: "c1", provider: "codex", silo: true,
    weight: 1, cap_percent: 85, quota_at: now, cooldowns: [],
    windows: [{ id: "rate_limit:7d", label: "Weekly limit", remaining: 60, reset_at: now + 86400, period: 7 * 86400, api_usd: 100 }],
  };
  const claudePersonal = {
    id: "cl1", name: "cl1.json", nickname: "Claude 1", provider: "claude",
    weight: 1, quota_at: now, cooldowns: [],
    windows: [{ id: "seven_day", label: "Weekly limit", remaining: 70, reset_at: now + 86400, period: 7 * 86400, api_usd: 100 }],
  };
  state.data = {
    now,
    history_bucket: 120,
    routing_strategy: "fill-first",
    accounts: [personal, idlenet, claudePersonal],
    history: [
      ...linearHistory("p1", "rate_limit:7d", now, 2, 80, 5),
      ...linearHistory("silo:c1", "rate_limit:7d", now, 2, 60, 10),
      ...linearHistory("cl1", "seven_day", now, 2, 70, 5),
    ],
  };

  // Mixed personal + Idlenet provider total: hatches the Idlenet slice, draws a divider, adds legend, and reports Idlenet in tooltip.
  const mixedSeries = [
    { ts: now - 3600, value: 155, units: 1.55, weight: 2, usd: 155, silo_value: 70, silo_units: 0.7, silo_usd: 70 },
    { ts: now - 1800, value: 147.5, units: 1.475, weight: 2, usd: 147.5, silo_value: 65, silo_units: 0.65, silo_usd: 65 },
  ];
  const mixedItems = [
    { a: personal, w: personal.windows[0] },
    { a: idlenet, w: idlenet.windows[0] },
  ];
  const mixedProjected = ctx.projectPoolSeries(mixedSeries, "usd", 2, mixedItems);
  const mixedHtml = plot("codex-total", "Codex total", mixedItems, "rate_limit:7d", mixedProjected, null, "usd");
  assert.ok(mixedHtml.includes('id="hatch-codex-total"'), "mixed pool should define hatch pattern");
  assert.ok(mixedHtml.includes('class="silo-hatch"'), "mixed pool should draw hatched Idlenet overlay");
  assert.ok(mixedHtml.includes('class="silo-divider"'), "mixed pool should draw personal/Idlenet divider");
  assert.ok(mixedHtml.includes('class="legend legend-silo"'), "mixed pool should add Idlenet legend item");
  const mixedChart = state.charts["codex-total"];
  assert.ok(Math.abs(mixedChart.points.at(-1).silo - 60) < 1e-6);
  const mixedEl = makeFakePlot("codex-total");
  inspectChart(mixedEl, mixedChart.points.at(-1));
  const mixedTip = mixedEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(mixedTip.includes("Idlenet") && mixedTip.includes("60 CU"), `expected Idlenet share in tooltip: ${mixedTip}`);

  // Personal-only chart: must NOT draw any hatching.
  const personalHtml = plot("claude-0", "Claude 1", [{ a: claudePersonal, w: claudePersonal.windows[0] }], "seven_day", null, null, "usd");
  assert.ok(!personalHtml.includes("silo-hatch"), "personal-only chart must not draw Idlenet hatching");
  assert.ok(!personalHtml.includes("legend-silo"), "personal-only chart must not show Idlenet legend");

  // Single Idlenet account chart: hatches full area with no personal divider.
  const soloSiloHtml = plot("codex-1", "c1", [{ a: idlenet, w: idlenet.windows[0] }], "rate_limit:7d", null, null, "usd");
  assert.ok(soloSiloHtml.includes('class="silo-hatch"'), "single Idlenet account chart should be hatched");
  assert.ok(!soloSiloHtml.includes('class="silo-divider"'), "100% Idlenet chart needs no personal divider");

  // Mixed provider drain rate chart: hatches the Idlenet drain slice.
  const drainHtml = ratePlot("codex-total-drain", "Codex total", mixedItems, "rate_limit:7d", "usd");
  assert.ok(drainHtml.includes('class="silo-hatch"'), "drain rate chart with Idlenet seats should hatch Idlenet drain");
  assert.ok(drainHtml.includes('class="silo-divider"'), "mixed drain rate chart should draw divider");

  // All accounts stacked chart: hatches only the Idlenet portion inside Codex's band.
  const stackedSeries = [
    { ts: now - 3600, value: 230, parts: { claude: 75, codex: 155 }, siloParts: { codex: 70 } },
    { ts: now - 1800, value: 220, parts: { claude: 72.5, codex: 147.5 }, siloParts: { codex: 65 } },
  ];
  const allHtml = plot(
    "all-total",
    "All accounts total",
    [
      { a: claudePersonal, w: claudePersonal.windows[0], metric: "seven_day" },
      { a: personal, w: personal.windows[0], metric: "rate_limit:7d" },
      { a: idlenet, w: idlenet.windows[0], metric: "rate_limit:7d" },
    ],
    null,
    stackedSeries,
    { order: ["claude", "codex"], parts: { claude: 70, codex: 140 }, siloParts: { codex: 60 }, latestValue: 210 },
    "usd",
  );
  assert.ok(allHtml.includes('id="hatch-all-total"'), "stacked All chart should define hatch pattern");
  assert.ok(allHtml.includes('class="silo-hatch"'), "stacked All chart should hatch Idlenet band slice");
  const allEl = makeFakePlot("all-total");
  inspectChart(allEl, state.charts["all-total"].points.at(-1));
  const allTip = allEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(allTip.includes("Idlenet") && allTip.includes("60 CU"), `expected Idlenet share in All tooltip: ${allTip}`);
}

// 13. Readable "Capped until ..." datetime format and cap reason.
{
  const resetTs = 1795568400; // Nov 24, 2026
  const expectedDate = ctx.dateLabel(resetTs);
  const cappedSeat = {
    id: "silo:c1", name: "c1", nickname: "c1", provider: "codex", silo: true,
    cap_percent: 85, capped: true, capped_until: resetTs,
    cap_label: "Capped by Silo until 2026-11-24 19:00",
    disabled: true, quota_at: now, cooldowns: [], nodes: ["ash"], active_node: "ash",
    windows: [
      { id: "rate_limit:5h", label: "5-hour limit", remaining: 12, reset_at: resetTs, period: 5 * 3600 },
      { id: "rate_limit:7d", label: "Weekly limit", remaining: 41, reset_at: resetTs + 86400, period: 7 * 86400 },
    ],
  };
  assert.equal(ctx.capTimeLabel(cappedSeat), `Capped until ${expectedDate}`);
  assert.equal(ctx.capReasonFor(cappedSeat, cappedSeat), "5-hour limit at 88% (85% cap)");
  assert.equal(ctx.statusReason(cappedSeat), `Capped until ${expectedDate} · 5-hour limit at 88% (85% cap)`);

  // Server-provided cap_reason takes precedence.
  const withServerReason = { ...cappedSeat, cap_reason: "5-hour limit at 91% (85% cap)" };
  assert.equal(ctx.capReasonFor(withServerReason, withServerReason), "5-hour limit at 91% (85% cap)");

  // Unreadable quota cap shows concise reason.
  const unreadableSeat = { ...cappedSeat, capped_until: null, cap_label: "Silo: quota unreadable", quota_error: "Laptop unreachable." };
  assert.equal(ctx.capTimeLabel(unreadableSeat), "Capped");
  assert.equal(ctx.capReasonFor(unreadableSeat, unreadableSeat), "Quota unreadable (Laptop unreachable)");

  // Detail card renders readable "Capped until ..." and a separate cap-reason line.
  state.data = { now: resetTs - 3600, accounts: [cappedSeat], history: [] };
  state.accountId = "silo:c1";
  const detailHtml = ctx.accountPage();
  assert.ok(detailHtml.includes(`Capped until ${expectedDate}`), detailHtml);
  assert.ok(!detailHtml.includes("Capped by Silo"), "must not show legacy 'Capped by Silo' phrasing");
  assert.ok(detailHtml.includes('<div class="cap-reason">5-hour limit at 88% (85% cap)</div>'), detailHtml);
}

// 14. Toggle setting to include Claude usage from Antigravity seats & Devin in the Claude chart, hatched in provider colors.
{
  const makeFakePlot = (key) => {
    const noop = () => {};
    const makeNode = () => ({
      hidden: true,
      textContent: "",
      innerHTML: "",
      clientWidth: 800,
      clientHeight: 240,
      offsetWidth: 180,
      offsetHeight: 110,
      dataset: {},
      style: { setProperty: noop },
      classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
      setAttribute: noop,
      removeAttribute() {
        this._hasHidden = false;
      },
      hasAttribute(attr) {
        return attr === "hidden" ? Boolean(this._hasHidden) : false;
      },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 240 }),
      querySelector(sel) {
        if (!this._children) this._children = {};
        if (!this._children[sel]) this._children[sel] = makeNode();
        return this._children[sel];
      },
      querySelectorAll: () => [],
      _hasHidden: true,
    });
    const el = makeNode();
    el.dataset.chart = key;
    return el;
  };

  assert.equal(ctx.isAgyClaudeWindow({ id: "claude:5h", group: "Claude & GPT", label: "Claude & GPT · 5-hour limit" }), true);
  assert.equal(ctx.isAgyClaudeWindow({ id: "3p-weekly", group: "Third party", label: "Weekly limit" }), true);
  assert.equal(ctx.isAgyClaudeWindow({ id: "gemini:5h", group: "Gemini", label: "Gemini · 5-hour limit" }), false);
  assert.equal(ctx.isAgyClaudeWindow({ id: "image:5h", group: "Image", label: "Image · 5-hour limit" }), false);

  state.burn = 2;
  state.hours = 24;
  state.forecast = true;
  state.unit = "usd";
  state.view = "remaining";
  state.provider = "all";
  state.windows.claude = "five_hour";

  const claudeMain = {
    id: "c_main", name: "claude-main.json", nickname: "Claude Main", provider: "claude",
    weight: 5, quota_at: now, cooldowns: [],
    windows: [
      { id: "five_hour", label: "5-hour limit", remaining: 60, reset_at: now + 3 * 3600, period: 5 * 3600, api_usd: 250 },
      { id: "seven_day", label: "Weekly limit", remaining: 80, reset_at: now + 5 * 86400, period: 7 * 86400, api_usd: 1500 },
      { id: "seven_day_sonnet", label: "Weekly · Sonnet", remaining: 90, reset_at: now + 5 * 86400, period: 7 * 86400, api_usd: 1500 },
    ],
  };
  const agySeat = {
    id: "silo:u1", name: "u1", nickname: "AGY Seat", provider: "antigravity", silo: true,
    weight: 5, quota_at: now, cooldowns: [],
    windows: [
      { id: "gemini:5h", group: "Gemini", label: "Gemini · 5-hour limit", remaining: 10, reset_at: now + 2 * 3600, period: 5 * 3600, api_usd: 100 },
      { id: "claude:5h", group: "Claude & GPT", label: "Claude & GPT · 5-hour limit", remaining: 80, reset_at: now + 4 * 3600, period: 5 * 3600, api_usd: 100 },
      { id: "claude:weekly", group: "Claude & GPT", label: "Claude & GPT · Weekly limit", remaining: 50, reset_at: now + 4 * 86400, period: 7 * 86400, api_usd: 400 },
    ],
  };
  const devinAcct = {
    id: "devin1", name: "devin1.json", nickname: "Devin", provider: "devin",
    weight: 1, quota_at: now, cooldowns: [],
    windows: [
      { id: "daily", label: "Daily limit", remaining: 50, reset_at: now + 12 * 3600, period: 86400, api_usd: 20 },
      { id: "weekly", label: "Weekly limit", remaining: 75, reset_at: now + 6 * 86400, period: 7 * 86400, api_usd: 80 },
    ],
  };
  const disabledDevin = {
    id: "devin_off", name: "devin-off.json", provider: "devin", disabled: true,
    weight: 1, quota_at: now, cooldowns: [],
    windows: [{ id: "daily", label: "Daily limit", remaining: 100, reset_at: null, period: 86400, api_usd: 20 }],
  };

  state.data = {
    now,
    history_bucket: 120,
    routing_strategy: "fill-first",
    accounts: [claudeMain, agySeat, devinAcct, disabledDevin],
    history: [
      ...linearHistory("c_main", "five_hour", now, 2, 60, 10),     // 10%/h of 250 CU = 25 CU/h
      ...linearHistory("silo:u1", "claude:5h", now, 2, 80, 5),     // 5%/h of 100 CU = 5 CU/h
      ...linearHistory("devin1", "daily", now, 2, 50, 10),         // 10%/h of 20 CU = 2 CU/h
      ...linearHistory("c_main", "seven_day", now, 2, 80, 2),
      ...linearHistory("silo:u1", "claude:weekly", now, 2, 50, 5),
      ...linearHistory("devin1", "weekly", now, 2, 75, 4),
    ],
    totals: {},
  };

  // Toggle OFF (default): single Claude account shows its own card and renders the toggle unchecked.
  state.claudeExtra = false;
  const offHtml = ctx.pool("claude");
  assert.ok(offHtml.includes('data-claude-extra'), "expected Claude extra toggle button");
  assert.ok(offHtml.includes('aria-checked="false"'), "toggle should default to unchecked");
  assert.ok(offHtml.includes("Include AGY &amp; Devin"), "toggle should mention AGY & Devin");
  assert.ok(!offHtml.includes("hatch-claude-total-antigravity"), "no AGY hatch when toggle is off");
  assert.ok(!offHtml.includes("150 CU") || !offHtml.includes("240 CU"), "off view must not include AGY/Devin total");

  // Toggle ON (5-hour, Remaining, CU mode):
  // Claude: 60% of 250 = 150 CU; AGY Claude & GPT: 80% of 100 = 80 CU (Gemini 10% ignored!); Devin daily: 50% of 20 = 10 CU.
  // Total = 240 CU of 370 CU, burn = 25 + 5 + 2 = 32 CU/h.
  state.claudeExtra = true;
  const onHtml = ctx.pool("claude");
  assert.ok(onHtml.includes('aria-checked="true"'), "toggle should show checked when enabled");
  assert.ok(onHtml.includes("1 Claude + 2 extra"), "header count should show extra seats");
  assert.ok(onHtml.includes("incl. Antigravity &amp; Devin"), "total card should name included providers");
  assert.ok(onHtml.includes("240 CU"), `expected combined 240 CU total: ${onHtml}`);
  assert.ok(onHtml.includes("of 370 CU"), `expected combined 370 CU cap: ${onHtml}`);
  assert.ok(onHtml.includes("32 CU/h"), `expected combined 32 CU/h burn: ${onHtml}`);
  assert.ok(onHtml.includes('id="hatch-claude-total-antigravity"'), "expected AGY colored hatch pattern");
  assert.ok(onHtml.includes('id="hatch-claude-total-devin"'), "expected Devin colored hatch pattern");
  assert.ok(onHtml.includes('stroke="var(--provider-antigravity)"'), "AGY hatch must use AGY color");
  assert.ok(onHtml.includes('stroke="var(--provider-devin)"'), "Devin hatch must use Devin color");
  assert.ok(onHtml.includes('class="band-hatch" data-band="antigravity"'), "expected hatched AGY band path");
  assert.ok(onHtml.includes('class="band-hatch" data-band="devin"'), "expected hatched Devin band path");
  assert.ok(!onHtml.includes('id="hatch-claude-total-claude"'), "Claude base band must stay solid");
  assert.ok(!onHtml.includes('class="silo-hatch"'), "AGY silo seat must not double-hatch with dark Idlenet hatch");
  assert.ok(onHtml.includes('tip-swatch hatched-color" style="--swatch-color:var(--provider-antigravity)"'), "legend should show hatched AGY swatch");
  assert.ok(onHtml.includes('tip-swatch hatched-color" style="--swatch-color:var(--provider-devin)"'), "legend should show hatched Devin swatch");

  // Hover tooltip on combined Claude Remaining chart shows hatched swatches for AGY & Devin and no double-counted Idlenet row.
  const remChart = state.charts["claude-total"];
  assert.deepEqual([...remChart.stackOrder], ["claude", "antigravity", "devin"]);
  assert.deepEqual([...remChart.stackHatched], ["antigravity", "devin"]);
  const remEl = makeFakePlot("claude-total");
  inspectChart(remEl, remChart.points.at(-1));
  const remTip = remEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(remTip.includes('tip-swatch hatched-color" style="--swatch-color:var(--provider-antigravity)"'), remTip);
  assert.ok(remTip.includes('tip-swatch hatched-color" style="--swatch-color:var(--provider-devin)"'), remTip);
  assert.ok(remTip.includes("150 CU") && remTip.includes("80 CU") && remTip.includes("10 CU"), remTip);
  assert.ok(!remTip.includes("Idlenet"), "hatched AGY silo seat should not duplicate as Idlenet row");

  // Drain rate view also stacks and hatches AGY & Devin in their colors.
  state.view = "drain";
  const drainOnHtml = ctx.pool("claude");
  assert.ok(drainOnHtml.includes('id="hatch-claude-total-drain-antigravity"'), "drain chart should define AGY hatch pattern");
  assert.ok(drainOnHtml.includes('id="hatch-claude-total-drain-devin"'), "drain chart should define Devin hatch pattern");
  assert.ok(drainOnHtml.includes('class="band-hatch" data-band="antigravity"'), "drain chart should hatch AGY band");
  assert.ok(drainOnHtml.includes('class="band-hatch" data-band="devin"'), "drain chart should hatch Devin band");
  const drainEl = makeFakePlot("claude-total-drain");
  inspectChart(drainEl, state.charts["claude-total-drain"].points.at(-1));
  const drainTip = drainEl.querySelector(".chart-tooltip").innerHTML;
  assert.ok(!drainTip.includes("Idlenet"), "drain tooltip must not duplicate hatched AGY silo seat into Idlenet row");

  // Weekly window matches AGY weekly + Devin weekly (Claude 1200 + AGY 200 + Devin 60 = 1,460 CU of 1,980 CU).
  state.view = "remaining";
  state.windows.claude = "seven_day";
  const weeklyHtml = ctx.pool("claude");
  assert.ok(weeklyHtml.includes("1,460 CU"), `expected 1,460 CU weekly total: ${weeklyHtml}`);
  assert.ok(weeklyHtml.includes("of 1,980 CU"), `expected 1,980 CU weekly cap: ${weeklyHtml}`);

  // Model-scoped Claude window (Weekly · Sonnet) does NOT mix in overall AGY/Devin limits.
  state.windows.claude = "seven_day_sonnet";
  const scopedHtml = ctx.pool("claude");
  assert.ok(!scopedHtml.includes("hatch-claude-total-antigravity"), "scoped Sonnet window must not stack AGY");
  assert.ok(!scopedHtml.includes("incl. Antigravity"), "scoped Sonnet window must not claim AGY/Devin");

  // Restore defaults for cleanliness.
  state.claudeExtra = false;
  state.windows.claude = "five_hour";
}

console.log("All quota unit, drain graph, and projection bar tests passed.");
