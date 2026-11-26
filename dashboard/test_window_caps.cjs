const assert = require("node:assert/strict");
const { runAppScripts } = require("./app_scripts.cjs");

function loadDashboard(innerWidth = 1440) {
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
    clientWidth: innerWidth,
  });
  const pageBodyListeners = {};
  const pageBody = {
    ...fakeEl(),
    addEventListener: (ev, fn) => (pageBodyListeners[ev] ||= []).push(fn),
  };
  const apiCalls = [];
  const toasts = [];
  const sandbox = {
    console, Math, Number, String, Boolean, Array, Object, Map, Set, Date, JSON, RegExp, Error, URL, Promise, Intl, WeakMap,
    encodeURIComponent, decodeURIComponent,
    notify: (title, kind, detail) => toasts.push({ title, kind, detail }),
    updateRenewalAlert: noop,
    addEventListener: noop, removeEventListener: noop, getComputedStyle: () => ({}), navigator: {},
    setTimeout: () => 0, clearTimeout: noop, requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    scrollTo: noop, innerWidth, matchMedia: () => ({ matches: true, addEventListener: noop }),
    localStorage: { getItem: () => null, setItem: noop },
    location: { pathname: "/dashboard/", hash: "", origin: "http://localhost:8318" },
    history: { replaceState: noop, pushState: noop },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    CSS: { escape: (s) => String(s) },
    fetch: (url, opts = {}) => {
      if (String(url).includes("/api/account/cap")) {
        apiCalls.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(opts.body)) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: false }) });
    },
    document: {
      title: "Silo",
      hidden: false,
      fonts: { ready: Promise.resolve() },
      querySelector: (sel) => (sel === "#page-body" ? pageBody : fakeEl()),
      querySelectorAll: () => [],
      getElementById: (id) => (id === "page-body" ? pageBody : fakeEl()),
      createElement: () => fakeEl(),
      addEventListener: noop,
      documentElement: { style: { setProperty: noop } },
      body: { classList: { toggle: noop, add: noop, remove: noop } },
      getAnimations: () => [],
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  runAppScripts(
    sandbox,
    "globalThis.__wcExports = { state, capWindowKey, capPercentFor, windowCapValue, windowIsCapped, capSummaryText, capReasonFor, capControl, accountsPage, accountPage, forecastPoints, stubReload: () => { render = () => {}; load = async () => {}; } };",
  );
  return { ...sandbox.__wcExports, pageBodyListeners, apiCalls, toasts };
}

function linearHistory(account, metric, now, hours, currentRem, ratePerHour) {
  const out = [];
  const steps = hours * 4;
  for (let i = steps; i >= 0; i--) {
    const dt = (i * 15) / 60;
    out.push({ ts: now - i * 900, account, metric, remaining: Math.min(100, currentRem + ratePerHour * dt) });
  }
  return out;
}

const d = loadDashboard();
const now = 1_795_500_000;

// 1. Window classification and per-window cap lookup.
const w5 = { id: "five_hour", label: "5-hour limit", remaining: 10, period: 5 * 3600, reset_at: now + 7200 };
const w7 = { id: "seven_day", label: "Weekly limit", remaining: 14, period: 7 * 86400, reset_at: now + 4 * 86400 };
assert.equal(d.capWindowKey(w5), "5h");
assert.equal(d.capWindowKey(w7), "weekly");
assert.equal(d.capWindowKey({ id: "rate_limit:5h", period: 18000 }), "5h");
assert.equal(d.capWindowKey({ id: "weekly_scoped:fable_5", period: 604800 }), "weekly");

const claudeSeat = {
  id: "silo:s1",
  name: "s1",
  provider: "claude",
  silo: true,
  cap_percent: 85,
  window_caps: { "5h": 95, weekly: 85 },
  capped: true,
  capped_until: w7.reset_at,
  cap_label: "Capped until Nov 28, 7:00 PM",
  disabled: true,
  nodes: ["bishop"],
  active_node: "bishop",
  quota_at: now - 60,
  cooldowns: [],
  windows: [w5, w7],
};
assert.equal(d.capPercentFor(claudeSeat, w5), 95);
assert.equal(d.capPercentFor(claudeSeat, w7), 85);
assert.equal(d.capSummaryText(claudeSeat), "Cap 5h 95% · Wk 85%");
assert.equal(d.capSummaryText({ ...claudeSeat, window_caps: { "5h": 85, weekly: 85 } }), "Cap 85%");
assert.equal(d.windowIsCapped(claudeSeat, w5), false, "5h at 90% used is below 95% 5h cap");
assert.equal(d.windowIsCapped(claudeSeat, w7), true, "Weekly at 86% used exceeds 85% weekly cap");
assert.equal(d.capReasonFor(claudeSeat, claudeSeat), "Weekly limit at 86% (85% cap)");
assert.equal(
  d.capReasonFor({ ...claudeSeat, windows: [{ ...w5, remaining: 4 }, w7] }, { ...claudeSeat, windows: [{ ...w5, remaining: 4 }, w7] }),
  "5-hour limit at 96% (95% cap), Weekly limit at 86% (85% cap)",
);

// 2. Forecasts honor separate 5h vs weekly cap floors.
{
  const seat = {
    ...claudeSeat,
    capped: false,
    disabled: false,
    window_caps: { "5h": 95, weekly: 80 },
    windows: [
      { ...w5, remaining: 35, reset_at: null },
      { ...w7, remaining: 35, reset_at: null },
    ],
  };
  d.state.forecast = true;
  d.state.data = {
    now,
    routing_strategy: "fill-first",
    accounts: [seat],
    history: [
      ...linearHistory(seat.id, "five_hour", now, 3, 35, 10),
      ...linearHistory(seat.id, "seven_day", now, 3, 35, 10),
    ],
  };
  const fc5 = d.forecastPoints([{ a: seat, w: seat.windows[0] }], "five_hour", now, now + 10 * 3600);
  const fc7 = d.forecastPoints([{ a: seat, w: seat.windows[1] }], "seven_day", now, now + 10 * 3600);
  assert.ok(Math.abs(fc5.at(-1).value - 5) < 0.05, `5h forecast should floor at 5% (95% cap), got ${fc5.at(-1).value}`);
  assert.ok(Math.abs(fc7.at(-1).value - 20) < 0.05, `weekly forecast should floor at 20% (80% cap), got ${fc7.at(-1).value}`);
}

// 3. Accounts list tag and Account detail 5-hour/Weekly cap controls.
d.state.provider = "all";
d.state.accountWindow = "5h";
d.state.accountId = "silo:s1";
d.state.data = { now, provider_order: ["claude", "antigravity"], accounts: [claudeSeat], history: [] };
const listHtml = d.accountsPage();
assert.match(listHtml, /acct-cap-tag">Cap 5h 95% · Wk 85%</, "Accounts list should show split 5h/Wk cap tag");

const detailHtml = d.accountPage();
assert.match(detailHtml, /Usage caps/, "Detail page should label the row Usage caps");
assert.match(detailHtml, /data-cap-set="silo:s1" data-cap-window="5h" data-cap-value="95" class="active"/);
assert.match(detailHtml, /data-cap-set="silo:s1" data-cap-window="weekly" data-cap-value="85" class="active"/);
// Quota card badges ONLY the Weekly window as Capped, not 5-hour.
const detailWins = detailHtml.split('<div class="detail-win">').slice(1);
assert.equal(detailWins.length, 2);
assert.ok(!detailWins[0].split("</span></div>")[0].includes(">Capped<"), "5-hour quota row should not be tagged Capped when under 95% cap");
assert.ok(detailWins[1].split("</span></div>")[0].includes(">Capped<"), "Weekly quota row should be tagged Capped when over 85% cap");

// 4. Antigravity seat with split 5h/weekly windows per group renders per-group window controls.
const agySeat = {
  id: "silo:u1",
  name: "u1",
  provider: "antigravity",
  silo: true,
  cap_percent: 90,
  window_caps: { "5h": 90, weekly: 90 },
  group_caps: [
    { group: "Gemini", cap_percent: 90, window_caps: { "5h": 95, weekly: 80 }, capped: false, owner: null },
    { group: "Claude & GPT", cap_percent: 85, window_caps: { "5h": 85, weekly: 85 }, capped: false, owner: null },
  ],
  windows: [
    { id: "gem:5h", label: "Gemini · 5-hour limit", group: "Gemini", remaining: 50, period: 5 * 3600, reset_at: now + 3600 },
    { id: "gem:weekly", label: "Gemini · Weekly limit", group: "Gemini", remaining: 60, period: 7 * 86400, reset_at: now + 86400 },
    { id: "3p:weekly", label: "Claude & GPT · Weekly limit", group: "Claude & GPT", remaining: 70, period: 7 * 86400, reset_at: now + 86400 },
  ],
  quota_at: now - 30,
  cooldowns: [],
};
assert.equal(d.capPercentFor(agySeat, agySeat.windows[0]), 95);
assert.equal(d.capPercentFor(agySeat, agySeat.windows[1]), 80);
assert.equal(d.capPercentFor(agySeat, agySeat.windows[2]), 85);
assert.equal(d.capSummaryText(agySeat), "Gemini 5h 95%/Wk 80% · Claude & GPT 85%");
const agyCtrl = d.capControl(agySeat);
assert.match(agyCtrl, /data-cap-set="silo:u1" data-cap-group="Gemini" data-cap-window="5h" data-cap-value="95" class="active"/);
assert.match(agyCtrl, /data-cap-set="silo:u1" data-cap-group="Gemini" data-cap-window="weekly" data-cap-value="80" class="active"/);
// Claude & GPT only has a weekly window with equal caps -> single group row without split.
assert.match(agyCtrl, /data-cap-set="silo:u1" data-cap-group="Claude &amp; GPT" data-cap-value="85" class="active"/);

// 5. Clicking a 5-hour / Weekly cap button sends { id, window, cap_percent } and updates state optimistically.
(async () => {
  d.stubReload();
  d.state.data = { now, provider_order: ["claude", "antigravity"], accounts: [claudeSeat, agySeat], history: [] };
  const fireClick = async (dataset) => {
    const btn = {
      dataset,
      hasAttribute: () => false,
      closest: (sel) => (sel === "button" ? btn : null),
    };
    for (const fn of d.pageBodyListeners.click || []) await fn({ target: btn, preventDefault: () => {} });
  };
  await fireClick({ capSet: "silo:s1", capWindow: "5h", capValue: "90" });
  await fireClick({ capSet: "silo:u1", capGroup: "Gemini", capWindow: "weekly", capValue: "85" });
  assert.deepEqual(d.apiCalls, [
    { id: "silo:s1", cap_percent: 90, window: "5h" },
    { id: "silo:u1", cap_percent: 85, group: "Gemini", window: "weekly" },
  ]);
  assert.deepEqual(
    d.toasts.map((t) => t.detail),
    ["s1 (5-hour) will pause at 90%.", "u1 (Gemini · Weekly) will pause at 85%."],
  );
  assert.deepEqual({ ...claudeSeat.window_caps }, { "5h": 90, weekly: 85 });
  assert.deepEqual({ ...agySeat.group_caps[0].window_caps }, { "5h": 95, weekly: 85 });
  console.log("test_window_caps.cjs: all assertions passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
