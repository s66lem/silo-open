// Tests natural account ordering and 2x weight display on Quota and Accounts pages.
"use strict";
const assert = require("node:assert/strict");
const { runAppScripts } = require("./app_scripts.cjs");

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
  clientWidth: 1440,
});

const sandbox = {
  console, Math, Number, String, Boolean, Array, Object, Map, Set, Date, JSON, RegExp, Error, URL, Promise, Intl, WeakMap,
  encodeURIComponent, decodeURIComponent,
  addEventListener: noop, removeEventListener: noop, getComputedStyle: () => ({}), navigator: {},
  setTimeout: () => 0, clearTimeout: noop, requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  scrollTo: noop, innerWidth: 1440, matchMedia: () => ({ matches: true, addEventListener: noop }),
  localStorage: { getItem: () => null, setItem: noop },
  location: { pathname: "/dashboard/", hash: "", origin: "http://localhost:8318" },
  history: { replaceState: noop, pushState: noop },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  CSS: { escape: (s) => String(s) },
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: false }) }),
  document: {
    title: "Silo",
    hidden: false,
    fonts: { ready: Promise.resolve() },
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    getElementById: () => fakeEl(),
    createElement: () => fakeEl(),
    addEventListener: noop,
    documentElement: { style: { setProperty: noop } },
    body: { classList: { toggle: noop, add: noop, remove: noop } },
    getAnimations: () => [],
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
runAppScripts(sandbox, "globalThis.__exports = { state, filteredAccounts, accountsPage, pool, weightControl, planControl };");
const d = sandbox.__exports;

const now = 1_795_660_000;
const win = (rem = 100) => [
  { id: "rate_limit:5h", label: "5-hour limit", remaining: rem, reset_at: now + 3600, period: 5 * 3600 },
  { id: "rate_limit:7d", label: "Weekly limit", remaining: rem, reset_at: now + 86400, period: 7 * 86400 },
];

d.state.provider = "codex";
d.state.accountWindow = "5h";
d.state.data = {
  now,
  accounts: [
    { id: "p1", name: "codex-17a91fa0-a@x.com-plus.json", nickname: "PLUS 1", email: "a@x.com", provider: "codex", plan: "plus", plan_weight: 1, weight: 1, quota_at: now - 30, cooldowns: [], windows: win(100) },
    { id: "t3", name: "codex-62a37559-c@x.com-team.json", nickname: "TEAM 3", email: "c@x.com", provider: "codex", plan: "team", plan_weight: 2, weight: 2, quota_at: now - 30, cooldowns: [], windows: win(100) },
    { id: "t4", name: "codex-62a37559-l@x.com-team.json", nickname: "TEAM 4", email: "l@x.com", provider: "codex", plan: "team", plan_weight: 2, weight: 2, quota_at: now - 30, cooldowns: [], windows: win(100) },
    { id: "t2", name: "codex-62a37559-s1@x.com-team.json", nickname: "TEAM 2", email: "s1@x.com", provider: "codex", plan: "team", plan_weight: 2, weight: 2, quota_at: now - 30, cooldowns: [], windows: win(100) },
    { id: "t1", name: "codex-62a37559-s2@x.com-team.json", nickname: "TEAM 1", email: "s2@x.com", provider: "codex", plan: "team", plan_weight: 2, weight: 2, quota_at: now - 30, cooldowns: [], windows: win(100) },
    { id: "p2", name: "codex-823ee5ea-b@x.com-plus.json", nickname: "PLUS 2", email: "b@x.com", provider: "codex", plan: "plus", plan_weight: 1, weight: 1, quota_at: now - 30, cooldowns: [], windows: win(100) },
    { id: "silo:c1", name: "c1", nickname: "c1", provider: "codex", silo: true, plan: "ChatGPT Business Slot 1", plan_weight: 1, weight: 1, quota_at: now - 30, cooldowns: [], windows: win(80) },
    { id: "silo:c2", name: "c2", nickname: "c2", provider: "codex", silo: true, plan: "ChatGPT Business Slot 2", plan_weight: 1, weight: 1, quota_at: now - 30, cooldowns: [], windows: win(90) },
  ],
  history: [],
  totals: {},
};

const ordered = Array.from(d.filteredAccounts("codex"), (a) => a.nickname);
assert.deepEqual(ordered, ["PLUS 1", "PLUS 2", "TEAM 1", "TEAM 2", "TEAM 3", "TEAM 4", "c1", "c2"]);

const acctHtml = d.accountsPage();
const t1Idx = acctHtml.indexOf('data-account="t1"');
const t2Idx = acctHtml.indexOf('data-account="t2"');
const t3Idx = acctHtml.indexOf('data-account="t3"');
const t4Idx = acctHtml.indexOf('data-account="t4"');
assert.ok(t1Idx > 0 && t1Idx < t2Idx && t2Idx < t3Idx && t3Idx < t4Idx, "Accounts page must render TEAM 1..4 in order");
assert.match(acctHtml, /data-account="t1"[\s\S]*<span class="acct-weight"[^>]*>2x<\/span>/, "Accounts page should display 2x weight badge on TEAM 1");

const poolHtml = d.pool("codex");
const rows = poolHtml.slice(poolHtml.indexOf('<div class="acct-rows">'));
assert.equal((rows.match(/<span class="acct-weight"[^>]*>2x<\/span>/g) || []).length, 4, "Quota card should display 2x on all 4 TEAM rows");

const wc = d.weightControl(d.state.data.accounts[4]);
assert.match(wc, /data-weight-value="2"[^>]*>2x<\/button>/, "Weight presets should include 2x");

console.log("All team account ordering and 2x display tests passed.");
