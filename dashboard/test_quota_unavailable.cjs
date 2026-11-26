const assert = require("node:assert/strict");
const { runAppScripts } = require("./app_scripts.cjs");

function loadDashboard() {
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

function linearHistory(account, metric, endTs, hours, endRem, ratePerHour) {
  const pts = [];
  const steps = Math.max(6, Math.round(hours * 6));
  for (let i = 0; i <= steps; i++) {
    const dt = (hours * 3600 * (steps - i)) / steps;
    pts.push({
      account,
      metric,
      ts: endTs - dt,
      remaining: Math.min(100, endRem + (ratePerHour * dt) / 3600),
    });
  }
  return pts;
}

const ctx = loadDashboard();
const { state, poolDrain, drainSeries, allDrainSeries, forecastPoints, chartHoverInfo } = ctx.window.dashboard;

const now = 1_795_721_844;
const week = 7 * 86400;
const fiveH = 5 * 3600;
state.burn = 3;
state.hours = 168;
state.unit = "usd";
state.view = "remaining";
state.forecast = true;
state.windows.codex = "rate_limit:7d";

// 1. Reproduce the multi-account Codex pool with Sign-in needed (PLUS 1), stale Capped seats (c1, c2, c4),
//    a Quota unavailable account, and live burning accounts (PLUS 2, TEAM 1..5, c3).
{
  const cuPer1x = 73.25;
  const win7 = (rem, weight, resetIn = 6 * 86400) => ({
    id: "rate_limit:7d",
    label: "Weekly limit",
    remaining: rem,
    reset_at: now + resetIn,
    period: week,
    api_usd: cuPer1x * weight,
  });
  const win5 = (rem, weight, resetIn = 2 * 3600) => ({
    id: "rate_limit:5h",
    label: "5-hour limit",
    remaining: rem,
    reset_at: now + resetIn,
    period: fiveH,
    api_usd: 20 * weight,
  });

  const plus1 = {
    id: "plus1", name: "plus1.json", nickname: "PLUS 1", provider: "codex", weight: 1,
    requires_sign_in: true, quota_at: now - 7200, quota_error: "HTTP 401", cooldowns: [],
    windows: [win5(100, 1), win7(50, 1)],
  };
  const plus2 = {
    id: "plus2", name: "plus2.json", nickname: "PLUS 2", provider: "codex", weight: 1,
    unavailable: true, quota_at: now - 60, cooldowns: [{ reason: "quota" }],
    windows: [win5(0, 1), win7(16, 1)],
  };
  const team2 = {
    id: "team2", name: "team2.json", nickname: "TEAM 2", provider: "codex", weight: 2,
    quota_at: now - 60, cooldowns: [],
    windows: [win5(80, 2), win7(81, 2)],
  };
  const team5 = {
    id: "team5", name: "team5.json", nickname: "TEAM 5", provider: "codex", weight: 2,
    quota_at: now - 60, in_use: true, cooldowns: [],
    windows: [win5(70, 2), win7(72, 2)],
  };
  const c1 = {
    id: "silo:c1", name: "c1", nickname: "c1", provider: "codex", silo: true, weight: 1,
    capped: true, disabled: true, cap_percent: 90, cap_label: "Silo: quota unreadable",
    quota_at: now - 7200, quota_error: "Laptop unreachable.", cooldowns: [],
    windows: [win5(100, 1), win7(69, 1)],
  };
  const c3 = {
    id: "silo:c3", name: "c3", nickname: "c3", provider: "codex", silo: true, weight: 1,
    capped: true, disabled: true, cap_percent: 90, cap_label: "Capped until Dec 2",
    quota_at: now - 60, cooldowns: [],
    windows: [win5(100, 1), win7(10, 1)],
  };
  const quotaUnavail = {
    id: "unavail1", name: "unavail1.json", nickname: "UNAVAIL", provider: "codex", weight: 1,
    quota_at: now - 7200, quota_error: "Quota request returned HTTP 502.", cooldowns: [],
    windows: [win5(100, 1), win7(40, 1)],
  };

  const accounts = [plus1, plus2, team2, team5, c1, c3, quotaUnavail];
  const history = [
    ...linearHistory("plus1", "rate_limit:7d", now - 7200, 3, 50, 0),
    ...linearHistory("plus2", "rate_limit:7d", now - 60, 3, 16, 4),
    ...linearHistory("team2", "rate_limit:7d", now - 60, 3, 81, 5),
    ...linearHistory("team5", "rate_limit:7d", now - 60, 3, 72, 6),
    ...linearHistory("silo:c1", "rate_limit:7d", now - 7200, 3, 69, 0),
    ...linearHistory("silo:c3", "rate_limit:7d", now - 60, 3, 10, 0),
    ...linearHistory("unavail1", "rate_limit:7d", now - 7200, 3, 40, 0),
  ];

  // Expected live remaining CU across all 7 accounts:
  // (0.50 + 0.16 + 2*0.81 + 2*0.72 + 0.69 + 0.10 + 0.40) * 73.25 = 4.91 * 73.25 = 359.6575 CU
  const expectedNowUsd = (0.5 + 0.16 + 1.62 + 1.44 + 0.69 + 0.1 + 0.4) * cuPer1x;
  // Expected live burn in CU/h: (1*4 + 2*5 + 2*6) / 100 * 73.25 = 0.26 * 73.25 = 19.045 CU/h
  const expectedBurnUsd = 0.26 * cuPer1x;

  state.data = {
    now,
    history_bucket: 120,
    routing_strategy: "fill-first",
    accounts,
    history,
    totals: {
      codex: {
        "rate_limit:7d": [
          { ts: now - 10800, value: 390, units: 5.69, weight: 9, usd: 5.69 * cuPer1x, silo_value: 79, silo_units: 0.79, silo_usd: 0.79 * cuPer1x },
          { ts: now - 3600, value: 350, units: 5.17, weight: 9, usd: 5.17 * cuPer1x, silo_value: 79, silo_units: 0.79, silo_usd: 0.79 * cuPer1x },
        ],
      },
    },
  };

  // Burn rate is computed from live accounts instead of returning null.
  const items = accounts.map((a) => ({ a, w: a.windows.find((w) => w.id === "rate_limit:7d") }));
  const burnUsd = poolDrain(items, "rate_limit:7d", now, "usd");
  assert.ok(burnUsd !== null && Math.abs(burnUsd - expectedBurnUsd) < 0.2, `expected ~${expectedBurnUsd} CU/h, got ${burnUsd}`);

  // Forecast draws cleanly from the full pool total and drains live accounts while holding stale/unavailable ones flat.
  const fc = forecastPoints(items, "rate_limit:7d", now, now + 120 * 3600, "usd");
  assert.ok(fc.length > 0, "pooled forecast must draw when healthy accounts are live");
  assert.ok(Math.abs(fc[0].value - expectedNowUsd) < 0.2);
  // Stale/held accounts (plus1=50%, c1=69%, unavail1=40%) + c3 floor (10%) = 1.69x = 123.79 CU.
  // Live usable pool (plus2=16% + team2=81%*2 + team5=72%*2 = 3.22x) runs out in 3.22 / 0.26 = 12.38h.
  const exhaustedPt = fc.find((p) => p.exhausted);
  assert.ok(exhaustedPt, "forecast must detect exhaustion once live accounts run out");
  const hoursToEmpty = (exhaustedPt.ts - now) / 3600;
  assert.ok(Math.abs(hoursToEmpty - 3.22 / 0.26) < 0.25, `expected ~12.4h runway, got ${hoursToEmpty}`);
  assert.ok(Math.abs(exhaustedPt.value - 1.69 * cuPer1x) < 1.0, `held accounts should stay at their last known floor, got ${exhaustedPt.value}`);

  // Rendered Codex pooled card shows live burn, live forecast, latest point at now, and NO "Paused" / "Forecast paused".
  const html = ctx.pool("codex");
  const totalSection = html.split('<details class="pool-accounts"')[0];
  assert.ok(!totalSection.includes("Forecast paused until quotas update"), "pooled Codex total must not pause forecast");
  assert.ok(!totalSection.includes("<dt>Runs out</dt><dd><span data-morph>Paused</span></dd>"), "pooled Runs out must not say Paused");
  assert.ok(totalSection.includes("19 CU/h") || totalSection.includes("19.0 CU/h"), `expected ~19 CU/h burn in total card: ${totalSection}`);
  // Individual card for the Quota unavailable account inside the collapsed details still honestly pauses.
  const unavailCard = html.split('data-account="unavail1"')[1] || "";
  assert.ok(unavailCard.includes("Forecast paused until quotas update"), "single Quota unavailable account card should still pause its own forecast");
  const chart = state.charts["codex-total"];
  assert.ok(chart.forecast.length > 0, "chart must include forecast points");
  assert.ok(Math.abs(chart.points.at(-1).ts - (now - 60)) <= 1, `latest live point must be appended near now, got ${chart.points.at(-1).ts}`);
  assert.ok(Math.abs(chart.points.at(-1).value - expectedNowUsd) < 0.2);

  // Drain rate chart and hover burn info continue up to now despite silent stale accounts.
  const drainPts = drainSeries(items, "rate_limit:7d", now - 24 * 3600, now, "usd");
  assert.ok(drainPts.length > 0);
  assert.ok(now - drainPts.at(-1).ts <= 120, `drain series must reach near now, ended ${now - drainPts.at(-1).ts}s early`);
  assert.ok(Math.abs(drainPts.at(-1).value - expectedBurnUsd) < 0.3);
  const hover = chartHoverInfo(chart, chart.points.at(-1));
  assert.ok(hover.rate !== null && Math.abs(hover.rate - expectedBurnUsd) < 0.3, `expected hover burn ~${expectedBurnUsd}, got ${hover.rate}`);
  assert.ok(hover.burners.length >= 3, "hover must list active burning accounts");
}

// 2. All-accounts card keeps combined burn rate & drain series when one single-account provider is Quota unavailable.
{
  const claudeOk = {
    id: "cl1", name: "cl1.json", provider: "claude", weight: 5, quota_at: now - 60, cooldowns: [],
    windows: [{ id: "five_hour", label: "5-hour limit", remaining: 60, reset_at: now + 3 * 3600, period: fiveH, api_usd: 250 }],
  };
  const xaiBroken = {
    id: "xai1", name: "xai1.json", provider: "xai", weight: 1, quota_at: now - 7200,
    quota_error: "Quota request returned HTTP 503.", cooldowns: [],
    windows: [{ id: "credits", label: "Weekly credits", remaining: 80, reset_at: now + 5 * 86400, period: week, api_usd: 50 }],
  };
  state.allWindow = "5h";
  state.hours = 24;
  state.data = {
    now,
    history_bucket: 120,
    accounts: [claudeOk, xaiBroken],
    history: [
      ...linearHistory("cl1", "five_hour", now - 60, 3, 60, 10), // 10%/h of 250 CU = 25 CU/h
      ...linearHistory("xai1", "credits", now - 7200, 3, 80, 0),
    ],
    totals: {
      all: {
        "5h": {
          metrics: { claude: "five_hour", xai: "credits" },
          points: [
            { ts: now - 7200, value: 160, units: 4.8, usd: 240, usd_cap: 300, parts_usd: { claude: 200, xai: 40 } },
            { ts: now - 60, value: 140, units: 3.8, usd: 190, usd_cap: 300, parts_usd: { claude: 150, xai: 40 } },
          ],
        },
      },
    },
  };
  const allHtml = ctx.allQuota();
  assert.ok(allHtml.includes("25 CU/h"), `expected 25 CU/h combined burn on All accounts: ${allHtml}`);
  const allDrain = allDrainSeries(
    ["claude", "xai"],
    [
      { a: claudeOk, w: claudeOk.windows[0], metric: "five_hour" },
      { a: xaiBroken, w: xaiBroken.windows[0], metric: "credits" },
    ],
    now - 24 * 3600,
    now,
    "usd",
  );
  assert.ok(allDrain.length > 0 && now - allDrain.at(-1).ts <= 120);
  assert.ok(Math.abs(allDrain.at(-1).value - 25) < 0.3);
}

// 3. When EVERY active account in a provider pool is Quota unavailable, the card still honestly pauses.
{
  const a1 = {
    id: "u1", name: "u1.json", provider: "codex", weight: 1, quota_at: now - 7200,
    quota_error: "HTTP 502", cooldowns: [],
    windows: [{ id: "rate_limit:7d", label: "Weekly limit", remaining: 50, reset_at: now + 5 * 86400, period: week, api_usd: 73.25 }],
  };
  const a2 = {
    id: "u2", name: "u2.json", provider: "codex", weight: 1, quota_at: now - 7200,
    quota_error: "HTTP 502", cooldowns: [],
    windows: [{ id: "rate_limit:7d", label: "Weekly limit", remaining: 60, reset_at: now + 5 * 86400, period: week, api_usd: 73.25 }],
  };
  state.data = { now, history_bucket: 120, accounts: [a1, a2], history: [], totals: {} };
  const html = ctx.pool("codex");
  assert.ok(html.includes("Forecast paused until quotas update"), "all-unavailable pool should still pause forecast");
  assert.ok(html.includes(">Paused<"), "all-unavailable pool should show Runs out: Paused");
}

// 4. Freshly re-signed-in or newly added account with <10m of samples must not blank pool burn or forecast.
{
  const cuPer1x = 73.25;
  const freshRecovered = {
    id: "plus1_fresh", name: "plus1.json", nickname: "PLUS 1", provider: "codex", weight: 1,
    quota_at: now - 60, cooldowns: [],
    windows: [{ id: "rate_limit:7d", label: "Weekly limit", remaining: 48, reset_at: now + 4 * 86400, period: week, api_usd: cuPer1x }],
  };
  const burningTeam = {
    id: "team2_live", name: "team2.json", nickname: "TEAM 2", provider: "codex", weight: 2,
    quota_at: now - 30, cooldowns: [],
    windows: [{ id: "rate_limit:7d", label: "Weekly limit", remaining: 68, reset_at: now + 6 * 86400, period: week, api_usd: 2 * cuPer1x }],
  };
  const offlineSilo = {
    id: "silo:c1_off", name: "c1", nickname: "c1", provider: "codex", silo: true, weight: 1,
    capped: true, disabled: true, cap_percent: 90, cap_label: "Silo: quota unreadable",
    quota_at: now - 35000, quota_error: "Laptop unreachable.", cooldowns: [],
    windows: [{ id: "rate_limit:7d", label: "Weekly limit", remaining: 69, reset_at: now + 5 * 86400, period: week, api_usd: cuPer1x }],
  };
  state.data = {
    now,
    history_bucket: 840,
    routing_strategy: "fill-first",
    accounts: [freshRecovered, burningTeam, offlineSilo],
    history: [
      // PLUS 1 just signed back in: only 1 recent sample -> drainFor returns null.
      { account: "plus1_fresh", metric: "rate_limit:7d", ts: now - 60, remaining: 48 },
      // TEAM 2 burning 5%/h on 2x = 0.10x/h = 7.325 CU/h.
      ...linearHistory("team2_live", "rate_limit:7d", now - 30, 3, 68, 5),
    ],
    totals: {},
  };
  const items = [freshRecovered, burningTeam, offlineSilo].map((a) => ({ a, w: a.windows[0] }));
  const burn = poolDrain(items, "rate_limit:7d", now, "usd");
  assert.ok(burn !== null && Math.abs(burn - 0.1 * cuPer1x) < 0.2, `expected ~${0.1 * cuPer1x} CU/h, got ${burn}`);
  const fc = forecastPoints(items, "rate_limit:7d", now, now + 48 * 3600, "usd");
  assert.ok(fc.length > 0, "pool forecast must run while freshly recovered account collects 10m of samples");
  // Freshly recovered PLUS 1 IS live and takes simulated traffic (unlike offline c1):
  // Usable pool = 0.48x (PLUS 1) + 1.36x (TEAM 2) = 1.84x at 0.10x/h => empties at ~18.4h!
  const ex = fc.find((p) => p.exhausted);
  assert.ok(ex && Math.abs((ex.ts - now) / 3600 - 18.4) < 0.3, `expected ~18.4h runway including PLUS 1, got ${ex ? (ex.ts - now) / 3600 : null}`);
}

console.log("All quota unavailable continuity tests passed.");
