const assert = require("node:assert/strict");
const { runAppScripts } = require("./app_scripts.cjs");

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
      documentElement: { style: { setProperty: noop } },
      body: { classList: { toggle: noop, add: noop, remove: noop } },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  runAppScripts(sandbox, "globalThis.__tokExports = { state, tokModelRate, fmtUsd, fmtUsdAxis, tokRateLabel, tokCostTag, tokCostSub, tokCacheSavePct, tokBuckets, tokSum, tokensMeta };");
  return sandbox.__tokExports;
}

const d = loadDashboardScript();
const rate = (m) => {
  const r = d.tokModelRate(m);
  return r ? { ...r } : null;
};

// 1. Model rate lookup & normalization
assert.deepEqual(rate("claude-opus-4-6"), { in: 5, out: 25, read: 0.5, write: 6.25 });
assert.deepEqual(rate("claude-opus-4-6-thinking"), { in: 5, out: 25, read: 0.5, write: 6.25 });
assert.deepEqual(rate("devin/claude-fable-5-1"), { in: 5, out: 25, read: 0.5, write: 6.25 });
assert.deepEqual(rate("claude-opus-4-20250514"), { in: 15, out: 75, read: 1.5, write: 18.75 });
assert.deepEqual(rate("claude-sonnet-4-5-20250929"), { in: 3, out: 15, read: 0.3, write: 3.75 });
assert.deepEqual(rate("claude-haiku-4-5-20251001"), { in: 1, out: 5, read: 0.1, write: 1.25 });
assert.deepEqual(rate("gpt-5.4"), { in: 2.5, out: 15, read: 0.25, write: 0 });
assert.deepEqual(rate("gpt-5.4-mini"), { in: 0.25, out: 2, read: 0.025, write: 0 });
assert.deepEqual(rate("gpt-5.4-nano"), { in: 0.05, out: 0.4, read: 0.005, write: 0 });
assert.deepEqual(rate("gpt-5.2-pro"), { in: 15, out: 120, read: 1.5, write: 0 });
assert.deepEqual(rate("gpt-6-astra"), { in: 2.5, out: 15, read: 0.25, write: 0 });
assert.deepEqual(rate("models/gemini-2.5-pro"), { in: 1.25, out: 10, read: 0.125, write: 0 });
assert.deepEqual(rate("gemini-3.1-flash-lite-preview"), { in: 0.1, out: 0.4, read: 0.01, write: 0 });
assert.deepEqual(rate("gemini-3-pro-preview"), { in: 2, out: 12, read: 0.2, write: 0 });
assert.deepEqual(rate("grok-4.7-build-fast"), { in: 0.2, out: 0.5, read: 0.05, write: 0 });
assert.deepEqual(rate("grok-4.6"), { in: 3, out: 15, read: 0.75, write: 0 });
assert.deepEqual(rate("kimi-k2.5"), { in: 0.6, out: 2.5, read: 0.15, write: 0 });
assert.deepEqual(rate("devin/deepseek-v4-flash"), { in: 0.28, out: 0.42, read: 0.028, write: 0 });
assert.deepEqual(rate("devin/glm-5-3"), { in: 0.6, out: 2.2, read: 0.11, write: 0 });
assert.equal(rate(""), null);
assert.equal(rate("custom-unknown-model"), null);

// 2. USD formatting
assert.equal(d.fmtUsd(null), "—");
assert.equal(d.fmtUsd(0), "$0.00");
assert.equal(d.fmtUsd(0.001), "<$0.01");
assert.equal(d.fmtUsd(0.005), "$0.01");
assert.equal(d.fmtUsd(12.345), "$12.35");
assert.equal(d.fmtUsd(1234.5), "$1,234.50");
assert.equal(d.fmtUsd(12345.67), "$12,346");
assert.equal(d.fmtUsdAxis(0), "$0");
assert.equal(d.fmtUsdAxis(0.05), "$0.05");
assert.equal(d.fmtUsdAxis(2.5), "$2.5");
assert.equal(d.fmtUsdAxis(50), "$50");
assert.equal(d.fmtUsdAxis(2500), "$2.5k");

// 3. Rate labels
assert.equal(d.tokRateLabel(d.tokModelRate("claude-opus-4-6")), "$5 / $25 per 1M");
assert.equal(d.tokRateLabel(d.tokModelRate("gemini-2.5-pro")), "$1.25 / $10 per 1M");
assert.equal(d.tokRateLabel(null), "Unpriced");

// 4. Bucket cost calculation, cache-read normalization (Claude vs OpenAI/Gemini), and cache savings
const nowHour = Math.floor(Date.now() / 3600000) * 3600;
d.state.tokens.buckets = [
  // Claude: input_tokens is already uncached (1M in @ $5, 1M out @ $25, 2M cache read @ $0.50, 1M cache write @ $6.25)
  // Cost = 5 + 25 + 1 + 6.25 = $37.25
  // Cache savings = 2M * (5 - 0.5) - 1M * (6.25 - 5) = 9 - 1.25 = $7.75
  {
    hour: nowHour,
    provider: "claude",
    account: "claude-1",
    model: "claude-opus-4-6",
    key_id: "shared",
    requests: 10,
    failed: 0,
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 2_000_000,
    cache_write_tokens: 1_000_000,
  },
  // OpenAI/Codex: input_tokens includes cache_read_tokens (3M total input, 2M cached -> 1M uncached @ $2.50, 1M out @ $15, 2M cache read @ $0.25)
  // Cost = 2.50 + 15 + 0.50 = $18.00
  // Cache savings = 2M * (2.50 - 0.25) = $4.50
  {
    hour: nowHour,
    provider: "codex",
    account: "codex-1",
    model: "gpt-5.4",
    key_id: "shared",
    requests: 5,
    failed: 0,
    input_tokens: 3_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 2_000_000,
    cache_write_tokens: 0,
  },
];
let normalized = d.tokBuckets();
let sum = d.tokSum(normalized);
assert.ok(Math.abs(sum.cost - 55.25) < 1e-9, `Expected $55.25, got ${sum.cost}`);
assert.ok(Math.abs(sum.costIn - 7.5) < 1e-9, `Expected $7.50 input cost, got ${sum.costIn}`);
assert.ok(Math.abs(sum.costOut - 40.0) < 1e-9, `Expected $40.00 output cost, got ${sum.costOut}`);
assert.ok(Math.abs(sum.costRead - 1.5) < 1e-9, `Expected $1.50 cache read cost, got ${sum.costRead}`);
assert.ok(Math.abs(sum.costWrite - 6.25) < 1e-9, `Expected $6.25 cache write cost, got ${sum.costWrite}`);
assert.ok(Math.abs(sum.cacheSaved - 12.25) < 1e-9, `Expected $12.25 cache saved, got ${sum.cacheSaved}`);
assert.equal(sum.pricedRequests, 15);
assert.equal(sum.unpriced, 0);
assert.equal(d.tokCostSub(sum, { saved: true }), "~$12.25 saved by cache");
assert.equal(d.tokCostTag(sum), "~$55.25 est.");
assert.match(d.tokensMeta(sum), /~\$55\.25 est\. API$/);
d.state.tokens.mode = "cost";
assert.equal(d.tokensMeta(sum), "All time: ~$55.25 est. API · ~$47.50 in + out · ~$12.25 saved by cache");
d.state.tokens.mode = "tokens";

// 5. Partial pricing honesty
d.state.tokens.buckets.push({
  hour: nowHour,
  provider: "other",
  account: "custom",
  model: "my-local-model",
  key_id: "shared",
  requests: 2,
  failed: 0,
  input_tokens: 1_000_000,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});
normalized = d.tokBuckets();
sum = d.tokSum(normalized);
assert.ok(Math.abs(sum.cost - 55.25) < 1e-9);
assert.equal(sum.unpriced, 1_000_000);
assert.equal(d.tokCostSub(sum, { saved: true }), "90% of tokens priced");

// 6. All unpriced honesty
d.state.tokens.buckets = [
  {
    hour: nowHour,
    provider: "other",
    account: "custom",
    model: "",
    key_id: "shared",
    requests: 1,
    failed: 0,
    input_tokens: 500,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  },
];
sum = d.tokSum(d.tokBuckets());
assert.equal(sum.priced, 0);
assert.equal(sum.unpriced, 600);
assert.equal(d.tokCostTag(sum), "");
assert.equal(d.tokCostSub(sum, { saved: true }), "No priced models");
assert.doesNotMatch(d.tokensMeta(sum), /est\. API/);

console.log("All tokens estimated API cost tests passed.");
