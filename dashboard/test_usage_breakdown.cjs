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
  return sandbox.window.dashboard;
}

const dash = loadDashboard();
const { state, usageBreakdownHtml } = dash;
const now = 1_795_500_000;

state.data = {
  now,
  provider_order: ["claude", "codex", "antigravity"],
  accounts: [
    { id: "a1", provider: "claude", windows: [{ id: "five_hour", label: "5-hour limit", remaining: 80, period: 18000 }], cooldowns: [] },
    { id: "a2", provider: "codex", windows: [{ id: "rate_limit:5h", label: "5-hour limit", remaining: 60, period: 18000 }], cooldowns: [] },
  ],
};
state.provider = "all";
state.hours = 24;
state.unit = "usd";
state.usage.hours = null;
state.usage.view = "projects";
state.usage.expanded = {};
state.usage.data = {
  available: true,
  hours: 24,
  provider: "all",
  now,
  totals: {
    cost_usd: 100,
    priced: true,
    tokens: 200_000_000,
    io_tokens: 10_000_000,
    requests: 500,
    projects: 2,
    threads: 3,
    providers: {
      claude: { cost_usd: 70, tokens: 120_000_000, io_tokens: 6_000_000, requests: 300 },
      codex: { cost_usd: 30, tokens: 80_000_000, io_tokens: 4_000_000, requests: 200 },
    },
  },
  projects: [
    {
      id: "p1",
      title: "conjectures",
      cost_usd: 75,
      priced: true,
      share: 0.75,
      tokens: 150_000_000,
      io_tokens: 7_000_000,
      requests: 350,
      thread_count: 1,
      subagent_count: 12,
      last_active_at: now - 120,
      providers: {
        claude: { cost_usd: 55, tokens: 100_000_000, io_tokens: 5_000_000, requests: 250 },
        codex: { cost_usd: 20, tokens: 50_000_000, io_tokens: 2_000_000, requests: 100 },
      },
      models: ["claude-opus-5-5", "gpt-6.2-sol"],
      threads: [
        {
          id: "t1",
          title: "Attack WOWII Conjectures",
          project_id: "p1",
          project_title: "conjectures",
          cost_usd: 75,
          priced: true,
          share: 0.75,
          tokens: 150_000_000,
          io_tokens: 7_000_000,
          requests: 350,
          subagent_count: 12,
          last_active_at: now - 120,
          providers: {
            claude: { cost_usd: 55, tokens: 100_000_000, io_tokens: 5_000_000, requests: 250 },
            codex: { cost_usd: 20, tokens: 50_000_000, io_tokens: 2_000_000, requests: 100 },
          },
          models: ["claude-opus-5-5", "gpt-6.2-sol"],
        },
      ],
    },
  ],
  threads: [
    {
      id: "t1",
      title: "Attack WOWII Conjectures",
      project_id: "p1",
      project_title: "conjectures",
      cost_usd: 75,
      priced: true,
      share: 0.75,
      tokens: 150_000_000,
      io_tokens: 7_000_000,
      requests: 350,
      subagent_count: 12,
      last_active_at: now - 120,
      providers: {
        claude: { cost_usd: 55, tokens: 100_000_000, io_tokens: 5_000_000, requests: 250 },
        codex: { cost_usd: 20, tokens: 50_000_000, io_tokens: 2_000_000, requests: 100 },
      },
      models: ["claude-opus-5-5", "gpt-6.2-sol"],
    },
  ],
};

// 1. Projects view (collapsed): shows project, CU metric, share %, subagent count, provider legend; child thread hidden.
const collapsed = usageBreakdownHtml();
assert.match(collapsed, /Usage by project/);
assert.match(collapsed, /conjectures/);
assert.match(collapsed, /75 CU/);
assert.match(collapsed, /75%/);
assert.match(collapsed, /\+12 sub/);
assert.match(collapsed, /Claude 70 CU/);
assert.doesNotMatch(collapsed, /Attack WOWII Conjectures/);

// 2. Projects view (expanded): shows child thread inline.
state.usage.expanded = { p1: true };
const expanded = usageBreakdownHtml();
assert.match(expanded, /Attack WOWII Conjectures/);
assert.match(expanded, /claude-opus-5-5/);

// 3. Threads view: shows flat thread row with project pill.
state.usage.view = "threads";
const threadsHtml = usageBreakdownHtml();
assert.match(threadsHtml, /Usage by thread/);
assert.match(threadsHtml, /ub-proj-pill">conjectures/);
assert.match(threadsHtml, /Attack WOWII Conjectures/);

// 4. Non-CU unit mode renders USD instead of CU, and provider filter shows provider badge.
state.unit = "weighted";
state.provider = "claude";
const claudeUsd = usageBreakdownHtml();
assert.match(claudeUsd, /\$75\.00/);
assert.match(claudeUsd, /<span class="tag outline">Claude<\/span>/);

// 5. Unpriced model falls back to tokens cleanly.
state.usage.data = {
  available: true,
  hours: 5,
  provider: "devin",
  now,
  totals: { cost_usd: 0, priced: false, tokens: 85_000, io_tokens: 65_000, requests: 3, projects: 1, threads: 1, providers: { devin: { cost_usd: 0, tokens: 85_000, io_tokens: 65_000, requests: 3 } } },
  projects: [{
    id: "p2", title: "silo", cost_usd: 0, priced: false, share: 1, tokens: 85_000, io_tokens: 65_000, requests: 3,
    thread_count: 1, subagent_count: 0, last_active_at: now - 60,
    providers: { devin: { cost_usd: 0, tokens: 85_000, io_tokens: 65_000, requests: 3 } },
    models: ["devin/swe-2-flash"], threads: [],
  }],
  threads: [],
};
state.usage.view = "projects";
const devinHtml = usageBreakdownHtml();
assert.match(devinHtml, /85\.0K tok|85K tok/i);
assert.match(devinHtml, /100%/);

console.log("All quota usage breakdown UI tests passed.");
