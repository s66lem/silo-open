const assert = require("node:assert/strict");
const { runAppScripts } = require("./app_scripts.cjs");

function loadDashboard(savedPrefs = null) {
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

  const store = new Map();
  if (savedPrefs !== null) {
    store.set("prox:prefs", JSON.stringify(savedPrefs));
  }

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
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    location: { pathname: "/dashboard/", hash: "", origin: "http://localhost:8318" },
    history: { replaceState: noop, pushState: noop },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    CSS: { escape: (s) => String(s) },
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ authenticated: false }),
      }),
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
  const api = runAppScripts(
    sandbox,
    "({ state, savePrefs, accountListWindows, accountListWindowShort, accountsPage, dateLabel })",
  );
  return { sandbox: api, store };
}

const now = 1_776_000_000;

// 1. restorePrefs accepts "both" for accountWindow and preserves it on savePrefs.
{
  const { sandbox, store } = loadDashboard({ accountWindow: "both" });
  assert.equal(sandbox.state.accountWindow, "both");
  sandbox.savePrefs();
  const saved = JSON.parse(store.get("prox:prefs"));
  assert.equal(saved.accountWindow, "both");
}

// 2. accountListWindows resolves stacked windows cleanly across all provider shapes.
{
  const { sandbox } = loadDashboard();
  const { accountListWindows, accountListWindowShort, accountsPage, state } = sandbox;

  const claudeAcct = {
    id: "claude-1",
    provider: "claude",
    email: "claude@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "five_hour", label: "5-hour limit", remaining: 82, period: 5 * 3600, reset_at: now + 3600 },
      { id: "seven_day", label: "Weekly limit", remaining: 61, period: 7 * 86400, reset_at: now + 86400 },
      { id: "seven_day_sonnet", label: "Sonnet weekly", remaining: 95, period: 7 * 86400, reset_at: now + 86400 },
    ],
  };
  const codexWeeklyExhausted = {
    id: "codex-1",
    provider: "codex",
    email: "codex@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [
      { id: "rate_limit:5h", label: "5-hour limit", remaining: 100, period: 5 * 3600, reset_at: now + 3600 },
      { id: "rate_limit:7d", label: "Weekly limit", remaining: 0, period: 7 * 86400, reset_at: now + 3 * 86400 },
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
  const noWinAcct = {
    id: "xai-empty",
    provider: "xai",
    email: "grok@example.com",
    quota_at: now - 30,
    cooldowns: [],
    windows: [],
  };

  assert.deepEqual(
    [...accountListWindows(claudeAcct, "both").map((w) => w.id)],
    ["five_hour", "seven_day"],
  );
  assert.deepEqual(
    [...accountListWindows(devinAcct, "both").map((w) => w.id)],
    ["daily", "weekly"],
  );
  assert.deepEqual(
    [...accountListWindows(weeklyOnlyCodex, "both").map((w) => w.id)],
    ["rate_limit:7d"],
  );
  // Single non-5h/7d window must not be duplicated in "both" mode.
  assert.deepEqual(
    [...accountListWindows(xaiAcct, "both").map((w) => w.id)],
    ["credits"],
  );
  assert.deepEqual([...accountListWindows(noWinAcct, "both")], []);

  assert.equal(accountListWindowShort(claudeAcct.windows[0]), "5h");
  assert.equal(accountListWindowShort(claudeAcct.windows[1]), "Wk");
  assert.equal(accountListWindowShort(devinAcct.windows[0]), "1d");
  assert.equal(accountListWindowShort(xaiAcct.windows[0]), "Mo");

  // Render accountsPage in "both" mode.
  state.provider = "all";
  state.accountWindow = "both";
  state.data = {
    now,
    history: [],
    accounts: [claudeAcct, codexWeeklyExhausted, devinAcct, weeklyOnlyCodex, xaiAcct, noWinAcct],
  };
  const html = accountsPage();

  assert.ok(html.includes('data-acct-win="5h" class="" aria-pressed="false"'));
  assert.ok(html.includes('data-acct-win="7d" class="" aria-pressed="false"'));
  assert.ok(html.includes('data-acct-win="both" class="active" aria-pressed="true"'));
  assert.ok(html.includes('class="account-list both-windows"'));

  // Claude row shows both 5h (82%) and Wk (61%) stacked.
  const claudeRow = html.match(/<article[^>]*data-account="claude-1"[\s\S]*?<\/article>/)?.[0] || "";
  assert.ok(claudeRow.includes("account-quota-stack"));
  assert.ok(claudeRow.includes('data-win-slot="5h"'));
  assert.ok(claudeRow.includes('data-win-slot="weekly"'));
  assert.ok(claudeRow.includes(">5h<"));
  assert.ok(claudeRow.includes(">Wk<"));
  assert.ok(claudeRow.includes("82%"));
  assert.ok(claudeRow.includes("61%"));
  assert.ok(claudeRow.includes("account-quota-line-secondary"));

  // Codex with 100% 5h and 0% weekly displays both bars and reports "Limit reached".
  const codexRow = html.match(/<article[^>]*data-account="codex-1"[\s\S]*?<\/article>/)?.[0] || "";
  assert.ok(codexRow.includes("100%"));
  assert.ok(codexRow.includes("0%"));
  assert.ok(codexRow.includes("Limit reached"));
  assert.ok(codexRow.includes("Resets "));

  // Devin shows 1d (64%) and Wk (33%) stacked.
  const devinRow = html.match(/<article[^>]*data-account="devin-1"[\s\S]*?<\/article>/)?.[0] || "";
  assert.ok(devinRow.includes(">1d<"));
  assert.ok(devinRow.includes(">Wk<"));
  assert.ok(devinRow.includes("64%"));
  assert.ok(devinRow.includes("33%"));

  // Weekly-only Codex and xAI show a single bar line without duplicating.
  const weeklyOnlyRow = html.match(/<article[^>]*data-account="codex-pro"[\s\S]*?<\/article>/)?.[0] || "";
  assert.equal((weeklyOnlyRow.match(/account-quota-line/g) || []).length, 1);
  assert.ok(weeklyOnlyRow.includes(">Wk<"));
  assert.ok(weeklyOnlyRow.includes("77%"));

  const xaiRow = html.match(/<article[^>]*data-account="xai-1"[\s\S]*?<\/article>/)?.[0] || "";
  assert.equal((xaiRow.match(/account-quota-line/g) || []).length, 1);
  assert.ok(xaiRow.includes(">Mo<"));
  assert.ok(xaiRow.includes("88%"));

  // Account with no windows renders an aligned placeholder bar with "—".
  const emptyRow = html.match(/<article[^>]*data-account="xai-empty"[\s\S]*?<\/article>/)?.[0] || "";
  assert.equal((emptyRow.match(/account-quota-line/g) || []).length, 1);
  assert.ok(emptyRow.includes("—"));
}

// 3. When both 5h and weekly are exhausted, status picks the later reset time.
{
  const { sandbox } = loadDashboard();
  const { accountsPage, state, dateLabel } = sandbox;
  const bothOut = {
    id: "claude-out",
    provider: "claude",
    email: "out@example.com",
    quota_at: now - 10,
    cooldowns: [],
    windows: [
      { id: "five_hour", label: "5-hour limit", remaining: 0, period: 5 * 3600, reset_at: now + 3600 },
      { id: "seven_day", label: "Weekly limit", remaining: 0, period: 7 * 86400, reset_at: now + 4 * 86400 },
    ],
  };
  state.provider = "all";
  state.accountWindow = "both";
  state.data = { now, history: [], accounts: [bothOut] };
  const html = accountsPage();
  assert.ok(html.includes("Limit reached"));
  assert.ok(html.includes(`Resets ${dateLabel(now + 4 * 86400)}`));
}

console.log("test_stacked_usage_limits passed");
