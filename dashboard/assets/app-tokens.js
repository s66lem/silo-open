// Tokens page: usage, API cost and charts.
"use strict";
// ---- Tokens ----
// Hub-wide token use from the same hourly buckets the Keys page reads,
// including prompt-cache reads and writes. Many cache writes next to few
// reads means session affinity is broken (requests land on cold accounts).
// Model colors on the key usage chart (the Tokens page colors series, not accounts).
// Model colors avoid the Claude orange and Codex white so a model never looks like a provider.
const MODEL_COLORS = ["#56b4e9", "#e69f00", "#009e73", "#cc79a7", "#f0e442", "#0072b2"];
const TOK_SERIES = [
  { id: "input", name: "Input", color: "#56b4e9" },
  { id: "output", name: "Output", color: "#e69f00" },
  { id: "read", name: "Cache read", color: "#009e73" },
  { id: "write", name: "Cache write", color: "#cc79a7" },
];
const TOK_RANGES = [[24, "24h"], [168, "7d"], [720, "30d"], ["all", "All time"]];
const TOK_WARN_REQUESTS = 50;
// Published API list rates in USD per 1M tokens (input, output, cache read, cache write).
// Ordered most-specific first; unrecognized models stay unpriced rather than guessing.
const TOK_MODEL_RATES = [
  // Anthropic Claude
  [/^claude-3-haiku\b/, { in: 0.25, out: 1.25, read: 0.03, write: 0.30 }],
  [/^claude-3-5-haiku\b/, { in: 0.80, out: 4.00, read: 0.08, write: 1.00 }],
  [/^claude-(haiku-[45]|4-5-haiku|5-5-haiku)/, { in: 1.00, out: 5.00, read: 0.10, write: 1.25 }],
  [/^claude-(3-5-sonnet|3-7-sonnet|sonnet-[45])/, { in: 3.00, out: 15.00, read: 0.30, write: 3.75 }],
  [/^claude-(3-opus|opus-4-1|opus-4-20250514|opus-4$)/, { in: 15.00, out: 75.00, read: 1.50, write: 18.75 }],
  [/^claude-(opus-4-[5-9]|opus-5|fable-5)/, { in: 5.00, out: 25.00, read: 0.50, write: 6.25 }],
  // OpenAI / Codex
  [/^gpt-5(\.\d+)?-nano/, { in: 0.05, out: 0.40, read: 0.005, write: 0 }],
  [/^gpt-5(\.\d+)?-mini/, { in: 0.25, out: 2.00, read: 0.025, write: 0 }],
  [/^gpt-5(\.\d+)?-pro/, { in: 15.00, out: 120.00, read: 1.50, write: 0 }],
  [/^(gpt-5\.[4-9]|gpt-6)/, { in: 2.50, out: 15.00, read: 0.25, write: 0 }],
  [/^gpt-5\.[23]/, { in: 1.75, out: 14.00, read: 0.175, write: 0 }],
  [/^(gpt-5(\.1)?\b|gpt-5-codex|gpt-5\.1-codex|codex-mini)/, { in: 1.25, out: 10.00, read: 0.125, write: 0 }],
  [/^gpt-oss-120b/, { in: 0.15, out: 0.60, read: 0.075, write: 0 }],
  [/^gpt-4\.1-nano/, { in: 0.10, out: 0.40, read: 0.025, write: 0 }],
  [/^gpt-4\.1-mini/, { in: 0.40, out: 1.60, read: 0.10, write: 0 }],
  [/^gpt-4\.1\b/, { in: 2.00, out: 8.00, read: 0.50, write: 0 }],
  [/^gpt-4o-mini/, { in: 0.15, out: 0.60, read: 0.075, write: 0 }],
  [/^gpt-4o\b/, { in: 2.50, out: 10.00, read: 1.25, write: 0 }],
  [/^o3-pro/, { in: 20.00, out: 80.00, read: 2.00, write: 0 }],
  [/^(o3-mini|o4-mini)/, { in: 1.10, out: 4.40, read: 0.275, write: 0 }],
  [/^o3\b/, { in: 2.00, out: 8.00, read: 0.50, write: 0 }],
  [/^o1-mini/, { in: 1.10, out: 4.40, read: 0.55, write: 0 }],
  [/^o1\b/, { in: 15.00, out: 60.00, read: 7.50, write: 0 }],
  // Google Gemini
  [/^gemini-.*flash-lite/, { in: 0.10, out: 0.40, read: 0.01, write: 0 }],
  [/^gemini-2\.5-flash/, { in: 0.30, out: 2.50, read: 0.03, write: 0 }],
  [/^gemini-(3(\.\d+)?-flash|flash-latest|omni-.*flash)/, { in: 0.50, out: 3.00, read: 0.05, write: 0 }],
  [/^gemini-2\.5-pro/, { in: 1.25, out: 10.00, read: 0.125, write: 0 }],
  [/^gemini-4-neon/, { in: 3.00, out: 15.00, read: 0.30, write: 0 }],
  [/^gemini-(3(\.\d+)?-pro|pro-latest|4-)/, { in: 2.00, out: 12.00, read: 0.20, write: 0 }],
  // xAI Grok
  [/^grok-3-mini/, { in: 0.30, out: 0.50, read: 0.075, write: 0 }],
  [/^grok-(4-fast|code-fast|4\.\d+-build-fast|composer-.*-fast)/, { in: 0.20, out: 0.50, read: 0.05, write: 0 }],
  [/^grok-[34]/, { in: 3.00, out: 15.00, read: 0.75, write: 0 }],
  // Moonshot Kimi
  [/^kimi-k[23]/, { in: 0.60, out: 2.50, read: 0.15, write: 0 }],
  // DeepSeek / GLM
  [/^deepseek-(v[34]|chat|reasoner)/, { in: 0.28, out: 0.42, read: 0.028, write: 0 }],
  [/^glm-[45]/, { in: 0.60, out: 2.20, read: 0.11, write: 0 }],
];
function tokModelRate(model) {
  if (!model) return null;
  const m = String(model)
    .trim()
    .toLowerCase()
    .replace(/^(anthropic|openai|google|xai|moonshot|devin|vertex|gemini|antigravity|claude|codex)\//, "")
    .replace(/^models\//, "");
  if (!m) return null;
  for (const [re, rate] of TOK_MODEL_RATES) if (re.test(m)) return rate;
  return null;
}
function fmtUsd(amount) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  if (amount > 0 && amount < 0.005) return "<$0.01";
  const digits = amount >= 10000 ? 0 : 2;
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtUsdAxis(amount) {
  if (!amount) return "$0";
  if (amount >= 1000) return `$${fmtTokens(amount)}`;
  if (amount >= 10) return `$${Math.round(amount)}`;
  if (amount >= 1) return `$${Number(amount.toFixed(1))}`;
  if (amount >= 0.01) return `$${Number(amount.toFixed(2))}`;
  return `$${Number(amount.toPrecision(1))}`;
}
const TOK_COST_FIELDS = { input: "costIn", output: "costOut", read: "costRead", write: "costWrite" };
const tokRateLabel = (rate) => {
  if (!rate) return "Unpriced";
  const p = (v) => `$${Number(v.toFixed(2))}`;
  return `${p(rate.in)} / ${p(rate.out)} per 1M`;
};
const tokCostTag = (c) => (c.priced ? `~${fmtUsd(c.cost)} est.` : "");
const tokCacheSavePct = (c) => {
  const uncached = c.costIn + c.costRead + c.costWrite + c.cacheSaved;
  return uncached > 0 ? c.cacheSaved / uncached : null;
};
function tokCostSub(c, { fallback = "based on public API rates", saved = false, suffix = "" } = {}) {
  if (!c.priced) return tokTotal(c) ? "No priced models" : "No tokens in window";
  const parts = [];
  if (c.unpriced > 0) parts.push(`${Math.round((100 * c.priced) / (c.priced + c.unpriced))}% of tokens priced`);
  else if (saved && c.cacheSaved >= 0.005) parts.push(`~${fmtUsd(c.cacheSaved)} saved by cache`);
  else if (fallback) parts.push(fallback);
  if (suffix) parts.push(suffix);
  return parts.join(" · ");
}
const tokTotal = (c) => c.input + c.output + c.read + c.write;
const tokEmpty = () => ({
  requests: 0, failed: 0, input: 0, output: 0, read: 0, write: 0,
  cost: 0, costIn: 0, costOut: 0, costRead: 0, costWrite: 0, cacheSaved: 0, priced: 0, unpriced: 0, pricedRequests: 0,
});
function tokAdd(c, b) {
  c.requests += b.requests;
  c.failed += b.failed;
  c.input += b.input_tokens;
  c.output += b.output_tokens;
  c.read += b.cache_read_tokens;
  c.write += b.cache_write_tokens || 0;
  const total = tokBucketTotal(b);
  if (b._cost !== null && b._cost !== undefined) {
    c.cost += b._cost;
    c.costIn += b._costIn || 0;
    c.costOut += b._costOut || 0;
    c.costRead += b._costRead || 0;
    c.costWrite += b._costWrite || 0;
    c.cacheSaved += b._cacheSaved || 0;
    c.priced += total;
    c.pricedRequests += b.requests;
  } else {
    c.unpriced += total;
  }
}
const tokBucketTotal = (b) => b.input_tokens + b.output_tokens + b.cache_read_tokens + (b.cache_write_tokens || 0);
// Share of prompt tokens served from cache: read / (read + write + uncached input).
const tokHit = (c) => {
  const prompt = c.read + c.write + c.input;
  return prompt ? c.read / prompt : null;
};
const tokPct = (v) => (v === null ? "–" : `${v < 0.1 ? (v * 100).toFixed(1) : Math.round(v * 100)}%`);
const tokWarn = (c) => c.requests >= TOK_WARN_REQUESTS && c.write > c.read;
function tokSum(buckets) {
  const sum = tokEmpty();
  for (const b of buckets) tokAdd(sum, b);
  return sum;
}
const tokHourEnd = () => (Math.floor(Date.now() / 3600000) + 1) * 3600;
const tokFirstHour = (buckets) => buckets.length
  ? buckets.reduce((first, b) => Math.min(first, b.hour), Infinity) : tokHourEnd() - 86400;
function tokStart(buckets, range) {
  const end = tokHourEnd();
  return range === "all" ? Math.min(tokFirstHour(buckets), end - 86400) : end - range * 3600;
}
const tokWindow = (buckets, range = state.tokens.range) => {
  if (range === "all") return buckets;
  const start = tokStart(buckets, range);
  return buckets.filter((b) => b.hour >= start);
};
function tokensMeta(allSum) {
  const t = state.tokens;
  if (!t.buckets) return t.error ? "Couldn't load usage" : "Loading usage…";
  if (!allSum.requests) return "";
  if (t.mode === "cost") {
    if (!allSum.priced) return "All time: no priced models";
    const savedPart = allSum.cacheSaved >= 0.005 ? ` · ~${fmtUsd(allSum.cacheSaved)} saved by cache` : "";
    return `All time: ~${fmtUsd(allSum.cost)} est. API · ~${fmtUsd(allSum.costIn + allSum.costOut)} in + out${savedPart}`;
  }
  const costPart = allSum.priced ? ` · ~${fmtUsd(allSum.cost)} est. API` : "";
  return `All time: ${fmtTokens(tokTotal(allSum))} tokens · ${fmtTokens(allSum.input + allSum.output)} in + out${costPart}`;
}
function tokensPage() {
  return `<div class="tokens" id="tokens-live" data-live></div>`;
}
function ensureTokens() {
  if (!$("#tokens-live")) return;
  renderTokens();
  loadTokens();
}
async function loadTokens() {
  const t = state.tokens;
  try {
    const [usage, keys] = await Promise.all([api("keys/usage?all=1"), api("keys").catch(() => null)]);
    t.buckets = usage.buckets || [];
    if (keys) t.names = Object.fromEntries((keys.keys || []).map((k) => [k.id, k.name]));
    t.error = "";
  } catch (e) {
    t.error = e.message;
  }
  if (state.page === "tokens") renderTokens();
  else if (state.page === "account") render();
}
// Keep source buckets intact so a later account snapshot can resolve historical names.
function tokBuckets() {
  const accounts = new Map();
  for (const a of state.data?.accounts || []) {
    if (a.name) accounts.set(a.name.toLowerCase(), a);
    if (a.id.startsWith("silo:")) accounts.set(a.id.slice(5).toLowerCase(), a);
  }
  return (state.tokens.buckets || []).map((b) => {
    let { provider, account } = b;
    const compatName = /^openai-compatibility:([^:]+):[^:]+$/i.exec(account)?.[1];
    const providerName = provider?.startsWith("openai-compatible-") && provider.slice("openai-compatible-".length);
    if (compatName || providerName) {
      const a = accounts.get((compatName || providerName).toLowerCase());
      account = a?.id || compatName || account || providerName;
      provider = a?.provider || (providerName ? "openai-compatible" : provider);
    }
    // OpenAI and Gemini include cache reads in input. Claude reports them separately.
    const input = provider === "claude" ? b.input_tokens : Math.max(0, b.input_tokens - b.cache_read_tokens);
    const rate = tokModelRate(b.model);
    const write = b.cache_write_tokens || 0;
    const _costIn = rate ? (input * rate.in) / 1e6 : 0;
    const _costOut = rate ? (b.output_tokens * rate.out) / 1e6 : 0;
    const _costRead = rate ? (b.cache_read_tokens * rate.read) / 1e6 : 0;
    const _costWrite = rate ? (write * rate.write) / 1e6 : 0;
    const _cost = rate ? _costIn + _costOut + _costRead + _costWrite : null;
    const _cacheSaved = rate
      ? Math.max(0, (b.cache_read_tokens * (rate.in - rate.read) - write * Math.max(0, rate.write - rate.in)) / 1e6)
      : 0;
    return { ...b, provider, account, input_tokens: input, _rate: rate, _cost, _costIn, _costOut, _costRead, _costWrite, _cacheSaved };
  });
}
const tokAccount = (id) => (state.data?.accounts || []).find((a) => a.id === id || a.name === id || a.id === `silo:${id}`);
function tokAccountLabel(id) {
  const a = tokAccount(id);
  if (a) return labelFor(a);
  const key = /^([a-z0-9-]+):apikey:([0-9a-f-]+)$/i.exec(id);
  if (key) return `${pName(key[1])} API key · ${key[2].slice(0, 6)}`;
  return /^openai-compatibility:([^:]+):/i.exec(id)?.[1] || id?.replace(/^openai-compatible-/i, "") || "Unknown account";
}
const tokAccountFull = (id) => {
  const a = tokAccount(id);
  return [tokAccountLabel(id), a && secondary(a)].filter(Boolean).join(" · ");
};
const tokAccountSub = (r) => {
  const a = tokAccount(r.account);
  return subLine([a && secondary(a), pName(r.provider)]);
};
const tokClientName = (id) => (id === "shared" ? "Shared key" : id === "imported" ? "Outside Silo" : state.tokens.names[id] || "Deleted key");
// Groups window buckets by a key; largest first (by cost in cost mode, else tokens).
function tokGroup(buckets, keyOf, extra) {
  const map = new Map();
  for (const b of buckets) {
    const k = keyOf(b);
    const row = map.get(k) || { id: k, c: tokEmpty(), ...extra(b) };
    tokAdd(row.c, b);
    map.set(k, row);
  }
  const byCost = state.tokens.mode === "cost";
  return [...map.values()].sort((a, b) => (byCost ? b.c.cost - a.c.cost : 0) || tokTotal(b.c) - tokTotal(a.c));
}
// Bins the window into n slots for sparklines.
function tokSpark(buckets, pick, n = 24, range = state.tokens.range) {
  const start = tokStart(buckets, range),
    span = tokHourEnd() - start,
    out = new Array(n).fill(0);
  for (const b of buckets) {
    const i = Math.min(n - 1, Math.floor(((b.hour - start) / span) * n));
    if (i >= 0) out[i] += pick(b);
  }
  return out;
}
const tokSparkAll = (buckets, pick, n = 24) => tokSpark(buckets, pick, n, "all");
function sparkline(values, color) {
  const W = 96, H = 28, peak = Math.max(0, ...values), max = peak || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 6)).toFixed(1)}`);
  return `<svg class="tok-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${pts.join(" ")} ${W},${H}" fill="${color}" opacity=".14"/><polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}
function tokStat(label, value, sub, spark, color) {
  return `<div class="tok-stat"><dt>${esc(label)}</dt><dd>${esc(value)}</dd><span class="tok-stat-sub" title="${esc(sub)}">${esc(sub)}</span>${sparkline(spark, color)}</div>`;
}
function tokMix(c) {
  if (state.tokens.mode === "cost") {
    const total = c.cost || 1;
    return `<div class="tok-mix" role="img" aria-label="${TOK_SERIES.map((s) => `${s.name} ${fmtUsd(c[TOK_COST_FIELDS[s.id]])}`).join(", ")}">${TOK_SERIES.map((s) => `<span style="flex:${c[TOK_COST_FIELDS[s.id]] / total};background:${s.color}"></span>`).join("")}</div>`;
  }
  const total = tokTotal(c) || 1;
  return `<div class="tok-mix" role="img" aria-label="${TOK_SERIES.map((s) => `${s.name} ${fmtTokens(c[s.id])}`).join(", ")}">${TOK_SERIES.map((s) => `<span style="flex:${c[s.id] / total};background:${s.color}"></span>`).join("")}</div>`;
}
function tokRing(c) {
  if (state.tokens.mode === "cost") {
    const saved = tokCacheSavePct(c);
    return `<div class="tok-ring" style="--p:${saved === null ? 0 : Math.round(saved * 100)}" title="${tokPct(saved)} saved on prompt cost via cache"><strong>${tokPct(saved)}</strong><span>saved</span></div>`;
  }
  const hit = tokHit(c);
  return `<div class="tok-ring" style="--p:${hit === null ? 0 : Math.round(hit * 100)}" title="${tokPct(hit)} of prompt tokens were read from cache"><strong>${tokPct(hit)}</strong><span>cache hit</span></div>`;
}
function tokCard(lead, title, sub, c) {
  const warn = tokWarn(c);
  const isCost = state.tokens.mode === "cost";
  const subText = isCost ? subLine([sub, plural(c.requests, "request")]) : subLine([sub, tokCostTag(c)]);
  const nums = isCost
    ? [
        ["Est. cost", c.priced ? fmtUsd(c.cost) : "—"],
        ["Input", c.priced ? fmtUsd(c.costIn) : "—"],
        ["Output", c.priced ? fmtUsd(c.costOut) : "—"],
        ["Cache read", c.priced ? fmtUsd(c.costRead) : "—"],
        ["Cache write", c.priced ? fmtUsd(c.costWrite) : "—"],
      ]
    : [["Requests", c.requests.toLocaleString()], ["Input", fmtTokens(c.input)], ["Output", fmtTokens(c.output)], ["Cache read", fmtTokens(c.read)], ["Cache write", fmtTokens(c.write)]];
  return `<article class="tok-card"><div class="tok-card-head">${lead}<div class="tok-card-id"><span class="account-label" title="${esc(title)}">${esc(title)}</span><span class="account-sub">${esc(subText)}</span></div>${tokRing(c)}${warn ? `<span class="tag warning tok-warn" title="${c.write.toLocaleString()} cache writes vs ${c.read.toLocaleString()} reads over ${c.requests.toLocaleString()} requests">${icon("warning")}<span>cache writes high — check session affinity</span></span>` : ""}</div>${tokMix(c)}<dl class="tok-nums">${nums.map(([k, v], i) => `<div><dt>${i > 0 ? `<i class="tip-swatch" style="background:${TOK_SERIES[i - 1].color}"></i>` : ""}${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></article>`;
}
const provColor = (p) =>
  `var(--provider-${["claude", "codex", "antigravity", "xai", "kimi", "meta", "devin"].includes(p) ? p : p === "kimi-ai" ? "kimi" : "other"})`;
function tokAddBy(slot, b) {
  tokAdd(slot.c, b);
  slot.by[b.provider] = (slot.by[b.provider] || 0) + tokBucketTotal(b);
  if (b._cost !== null && b._cost !== undefined)
    slot.byCost[b.provider] = (slot.byCost[b.provider] || 0) + b._cost;
}
// What the charts stack: the four types, or total per provider (in tokens or USD cost).
function tokSeries(buckets) {
  const isCost = state.tokens.mode === "cost";
  if (state.tokens.colorBy !== "provider")
    return TOK_SERIES.map((q) => ({ ...q, get: (sl) => sl.c[isCost ? TOK_COST_FIELDS[q.id] : q.id] }));
  const tot = new Map();
  for (const b of buckets) {
    if (isCost) {
      if (b._cost !== null && b._cost !== undefined) tot.set(b.provider, (tot.get(b.provider) || 0) + b._cost);
    } else {
      tot.set(b.provider, (tot.get(b.provider) || 0) + tokBucketTotal(b));
    }
  }
  return byProviderOrder([...tot.keys()])
    .map((q) => ({ id: q, name: pName(q), color: provColor(q), total: tot.get(q), get: (sl) => (isCost ? sl.byCost[q] : sl.by[q]) || 0 }));
}
// Calendar-day indices keep local dates consecutive across daylight-saving changes.
function tokDayIndex(ts) {
  const d = new Date(ts * 1000);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
}
const tokDays = (first) => Math.max(1, tokDayIndex(Date.now() / 1000) - tokDayIndex(first) + 1);
function tokDaySlots(buckets, n) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const first = tokDayIndex(today.getTime() / 1000) - n + 1;
  const slots = Array.from({ length: n }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (n - 1 - i));
    const ts = d.getTime() / 1000;
    d.setDate(d.getDate() + 1);
    return { ts, end: d.getTime() / 1000, c: tokEmpty(), by: {}, byCost: {} };
  });
  for (const b of buckets) {
    const slot = slots[tokDayIndex(b.hour) - first];
    if (slot) tokAddBy(slot, b);
  }
  return slots;
}
function tokChart(buckets) {
  const isCost = state.tokens.mode === "cost";
  const ser = tokSeries(buckets);
  state.tokens.series = ser;
  const t = state.tokens, end = tokHourEnd(), first = tokFirstHour(buckets);
  const spanHours = t.range === "all" ? Math.max(24, Math.ceil((end - first) / 3600)) : t.range;
  const daily = spanHours > 168, size = daily ? 86400 : 3600;
  let slots;
  if (daily && t.range === "all") slots = tokDaySlots(buckets, tokDays(first));
  else {
    const count = Math.ceil(spanHours * 3600 / size), origin = end - count * size;
    slots = Array.from({ length: count }, (_, i) => ({ ts: origin + i * size, end: origin + (i + 1) * size, c: tokEmpty(), by: {}, byCost: {} }));
    for (const b of buckets) {
      const slot = slots[Math.floor((b.hour - origin) / size)];
      if (slot) tokAddBy(slot, b);
    }
  }
  const n = slots.length;
  const W = Math.max(280, ($("#page-body").clientWidth || 1000) - 34),
    H = innerWidth <= 760 ? 160 : 220,
    left = isCost ? 54 : 46, right = 10, top = 8, bottom = 24;
  const x = (i) => left + (n === 1 ? 0 : (i / (n - 1)) * (W - left - right));
  const peak = Math.max(0, ...slots.map((s) => (isCost ? s.c.cost : tokTotal(s.c))));
  const mag = peak > 0 ? 10 ** Math.floor(Math.log10(peak)) : 1;
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => peak <= v) || 10 * mag;
  const y = (v) => H - bottom - (v / step) * (H - top - bottom);
  t.chart = { slots, x, W, H, left, right, top, bottom, n, daily };
  t.daily = null;
  const cum = (sl, k) => ser.slice(0, k).reduce((a, q) => a + q.get(sl), 0);
  const areas = ser.map((s, k) => {
    const upper = slots.map((sl, i) => `${x(i).toFixed(1)},${y(cum(sl, k + 1)).toFixed(1)}`);
    const lower = slots.map((sl, i) => `${x(i).toFixed(1)},${y(cum(sl, k)).toFixed(1)}`).reverse();
    return `<polygon points="${[...upper, ...lower].join(" ")}" fill="${s.color}" fill-opacity=".78" stroke="${s.color}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const fmtAxis = (v) => (isCost ? fmtUsdAxis(v) : fmtTokens(v));
  const fmtLeg = (v) => (isCost ? fmtUsd(v) : fmtTokens(v));
  const half = step / 2;
  let marks = `<line class="grid-line" x1="${left}" x2="${W - right}" y1="${y(step)}" y2="${y(step)}"/><text x="${left - 10}" y="${y(step) + 4}" text-anchor="end">${esc(fmtAxis(step))}</text><line class="grid-line" x1="${left}" x2="${W - right}" y1="${y(half)}" y2="${y(half)}"/><text x="${left - 10}" y="${y(half) + 4}" text-anchor="end">${esc(fmtAxis(half))}</text><line x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}" stroke="var(--border)"/><text x="${left - 10}" y="${y(0) + 4}" text-anchor="end">${isCost ? "$0" : "0"}</text>`;
  let last = -Infinity;
  slots.forEach((s, i) => {
    const d = new Date(s.ts * 1000);
    const show = spanHours <= 24 ? d.getHours() % 6 === 0 : daily ? n <= 10 || i % Math.ceil(n / 10) === 0 : d.getHours() === 0;
    const lx = x(i);
    if (!show || lx - last < 64 || lx > W - right - 24 || lx < left) return;
    last = lx;
    marks += `<text x="${lx}" y="${H - 6}" text-anchor="middle">${esc(spanHours <= 24 ? d.toLocaleTimeString(undefined, { hour: "numeric" }) : dateLabel(s.ts, false))}</text>`;
  });
  const emptyMsg = isCost ? "No priced API cost in this window" : "No tokens used in this window";
  const captionLead = `${isCost ? "Estimated API cost" : "Tokens"} per ${daily ? "day" : "hour"}`;
  const ariaLabel = isCost
    ? "Estimated API cost over time split into input, output, cache read and cache write. Use left and right arrows to inspect."
    : "Tokens over time split into input, output, cache read and cache write. Use left and right arrows to inspect.";
  return `<figure class="plot usage tok-chart" data-tok-chart tabindex="0" aria-label="${ariaLabel}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${marks}<g class="chart-data">${areas}</g><line class="tok-cursor" x1="0" x2="0" y1="${top}" y2="${H - bottom}" hidden/></svg><div class="chart-tooltip" hidden></div>${peak ? "" : `<div class="usage-empty">${emptyMsg}</div>`}<figcaption class="chart-caption"><span>${captionLead}</span>${ser.map((s) => `<span class="legend"><i class="tip-swatch" style="background:${s.color}"></i>${esc(s.name)}${s.total !== undefined ? " " + esc(fmtLeg(s.total)) : ""}</span>`).join("")}<span class="chart-inspect" aria-live="polite"></span></figcaption></figure>`;
}
// Tokens or estimated API cost per day (local days), stacked like the hourly chart.
function tokDaily(buckets) {
  const t = state.tokens, ser = t.series, isCost = t.mode === "cost";
  const slots = t.range === "all" && t.chart.daily ? t.chart.slots :
    tokDaySlots(buckets, t.range === "all" ? tokDays(tokFirstHour(buckets)) : t.range / 24);
  const n = slots.length;
  const W = Math.max(280, ($("#page-body").clientWidth || 1000) - 34),
    H = innerWidth <= 760 ? 160 : 220,
    left = isCost ? 54 : 46, right = 10, top = 8, bottom = 24,
    span = W - left - right,
    x = (i) => left + ((i + 0.5) / n) * span,
    bw = Math.max(2, (span / n) * 0.7);
  const peak = Math.max(0, ...slots.map((s) => (isCost ? s.c.cost : tokTotal(s.c))));
  const mag = peak > 0 ? 10 ** Math.floor(Math.log10(peak)) : 1;
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => peak <= v) || 10 * mag;
  const y = (v) => H - bottom - (v / step) * (H - top - bottom);
  t.daily = { slots, x, W, H, left, right, top, bottom, n, bars: true };
  const bars = slots
    .map((sl, i) => {
      let low = 0;
      return ser.map((s) => {
        const from = low;
        low += s.get(sl);
        if (!s.get(sl)) return "";
        return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(low).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y(from) - y(low)).toFixed(1)}" fill="${s.color}" fill-opacity=".78"/>`;
      }).join("");
    })
    .join("");
  const fmtAxis = (v) => (isCost ? fmtUsdAxis(v) : fmtTokens(v));
  const fmtLeg = (v) => (isCost ? fmtUsd(v) : fmtTokens(v));
  const half = step / 2;
  let marks = `<line class="grid-line" x1="${left}" x2="${W - right}" y1="${y(step)}" y2="${y(step)}"/><text x="${left - 10}" y="${y(step) + 4}" text-anchor="end">${esc(fmtAxis(step))}</text><line class="grid-line" x1="${left}" x2="${W - right}" y1="${y(half)}" y2="${y(half)}"/><text x="${left - 10}" y="${y(half) + 4}" text-anchor="end">${esc(fmtAxis(half))}</text><line x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}" stroke="var(--border)"/><text x="${left - 10}" y="${y(0) + 4}" text-anchor="end">${isCost ? "$0" : "0"}</text>`;
  let last = -Infinity;
  slots.forEach((s, i) => {
    const lx = x(i);
    if (lx - last < 64 || lx > W - right - 24 || lx < left + 12) return;
    last = lx;
    marks += `<text x="${lx}" y="${H - 6}" text-anchor="middle">${esc(dateLabel(s.ts, false))}</text>`;
  });
  const emptyMsg = isCost ? "No priced API cost in this window" : "No tokens used in this window";
  const captionLead = `${isCost ? "Estimated API cost" : "Tokens"} per day`;
  const ariaLabel = isCost
    ? "Estimated API cost per day split into input, output, cache read and cache write. Use left and right arrows to inspect."
    : "Tokens per day split into input, output, cache read and cache write. Use left and right arrows to inspect.";
  return `<section class="tok-section"><h3 class="breakdown-title">Daily totals</h3><figure class="plot usage tok-chart" data-tok-chart data-tok-daily tabindex="0" aria-label="${ariaLabel}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${marks}<g class="chart-data">${bars}</g><line class="tok-cursor" x1="0" x2="0" y1="${top}" y2="${H - bottom}" hidden/></svg><div class="chart-tooltip" hidden></div>${peak ? "" : `<div class="usage-empty">${emptyMsg}</div>`}<figcaption class="chart-caption"><span>${captionLead}</span>${ser.map((s) => `<span class="legend"><i class="tip-swatch" style="background:${s.color}"></i>${esc(s.name)}${s.total !== undefined ? " " + esc(fmtLeg(s.total)) : ""}</span>`).join("")}<span class="chart-inspect" aria-live="polite"></span></figcaption></figure></section>`;
}
const tokChartFor = (fig) => (fig?.hasAttribute("data-tok-daily") ? state.tokens.daily : state.tokens.chart);
function inspectTokChart(fig, i) {
  const ch = tokChartFor(fig);
  if (!ch) return;
  const isCost = state.tokens.mode === "cost";
  i = Math.min(ch.n - 1, Math.max(0, i));
  const slot = ch.slots[i];
  fig.dataset.slot = i;
  const svg = $("svg", fig),
    cur = $(".tok-cursor", fig),
    tip = $(".chart-tooltip", fig),
    cx = ch.x(i);
  cur.setAttribute("x1", cx);
  cur.setAttribute("x2", cx);
  cur.removeAttribute("hidden");
  const label = `${dateLabel(slot.ts, false)}${ch.daily || ch.bars ? "" : ` · ${new Date(slot.ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}`;
  const total = tokTotal(slot.c);
  // Empty series are left out; on phones the top 2 and one "Other" row for the rest.
  let rows = (state.tokens.series || []).map((s) => ({ name: s.name, color: s.color, v: s.get(slot) })).filter((r) => r.v > 0);
  if (innerWidth <= 760 && rows.length > 3) {
    rows.sort((a, b) => b.v - a.v);
    rows = [...rows.slice(0, 2), { name: "Other", color: "var(--muted-foreground)", v: rows.slice(2).reduce((s, r) => s + r.v, 0) }];
  }
  const sx = svg.clientWidth / ch.W,
    sy = svg.clientHeight / ch.H;
  tip.style.maxWidth = `${(ch.W - ch.left - ch.right) * sx}px`;
  const fmtRow = (v) => (isCost ? fmtUsd(v) : fmtTokens(v));
  const totalStr = isCost ? (slot.c.priced ? fmtUsd(slot.c.cost) : "—") : total.toLocaleString();
  const costTip = !isCost && slot.c.priced ? ` · ~${fmtUsd(slot.c.cost)} est.` : "";
  tip.innerHTML = `<div class="tip-label">${esc(label)}</div>${rows.map((r) => `<div class="tip-row"><i class="tip-swatch" style="background:${r.color}"></i><span title="${esc(r.name)}">${esc(r.name)}</span><strong>${esc(fmtRow(r.v))}</strong></div>`).join("")}<div class="tip-row tip-total"><span>${plural(slot.c.requests, "request")} · ${tokPct(tokHit(slot.c))} hit${esc(costTip)}</span><strong>${esc(totalStr)}</strong></div>`;
  tip.hidden = false;
  const ax = cx * sx,
    tw = tip.offsetWidth;
  let left = ax + 14;
  if (left + tw > svg.clientWidth) left = ax - 14 - tw;
  // Stay inside the plot area: right of the y-axis labels, between the top gridline and the x-axis ticks.
  left = Math.max(ch.left * sx, Math.min(left, svg.clientWidth - tw));
  // The tip is positioned from the figure's padding edge; the svg sits below its padding.
  const gap = svg.getBoundingClientRect().top - fig.getBoundingClientRect().top - fig.clientTop,
    y0 = gap + ch.top * sy,
    top = Math.max(y0, Math.min(y0 + 16, gap + (ch.H - ch.bottom) * sy - tip.offsetHeight));
  tip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  $(".chart-inspect", fig).textContent = isCost
    ? `${label} · ${slot.c.priced ? fmtUsd(slot.c.cost) : "—"} est., ${plural(slot.c.requests, "request")}`
    : `${label} · ${total.toLocaleString()} tokens, ${plural(slot.c.requests, "request")}${slot.c.priced ? `, ~${fmtUsd(slot.c.cost)} est.` : ""}`;
}
function clearTokChart(fig) {
  $(".tok-cursor", fig)?.setAttribute("hidden", "");
  const tip = $(".chart-tooltip", fig);
  if (tip) tip.hidden = true;
  const note = $(".chart-inspect", fig);
  if (note) note.textContent = "";
  delete fig.dataset.slot;
}
function renderTokens() {
  const root = $("#tokens-live");
  if (!root) return;
  const t = state.tokens, isCost = t.mode === "cost";
  const buckets = tokBuckets(), allSum = tokSum(buckets);
  morphText($("#page-meta"), tokensMeta(allSum));
  let html;
  const toolbar = `<div class="page-toolbar"><div class="segmented sm" role="group" aria-label="Metric">${[["tokens", "Tokens"], ["cost", "API cost"]].map(([k, l]) => `<button data-tok-mode="${k}" ${choice(t.mode === k)}>${l}</button>`).join("")}</div><div class="segmented sm" role="group" aria-label="Time range">${TOK_RANGES.map(([h, l]) => `<button data-tok-range="${h}" ${choice(t.range === h)}>${l}</button>`).join("")}</div><div class="control-group"><span class="toolbar-label">Color by</span><div class="segmented sm" role="group" aria-label="Color tokens by">${[["provider", "Provider"], ["type", "Type"]].map(([k, l]) => `<button data-tok-color="${k}" ${choice(t.colorBy === k)}>${l}</button>`).join("")}</div></div></div>`;
  if (t.error && !t.buckets) html = `${toolbar}<div class="notice error">${icon("warning")}<span>${esc(t.error)}</span></div>`;
  else if (!t.buckets) html = `${toolbar}<div class="logs-loading"><span class="loading-mark"></span>Loading usage…</div>`;
  else {
    const win = tokWindow(buckets), sum = t.range === "all" ? allSum : tokSum(win);
    const firstTs = tokFirstHour(buckets);
    if (!allSum.requests) html = `${toolbar}<div class="state-card"><h2>No token usage yet</h2><p>Requests through the hub show up here within a minute, per account and per client.</p></div>`;
    else {
      const accounts = tokGroup(win, (b) => `${b.provider}\u0000${b.account}`, (b) => ({ provider: b.provider, account: b.account }));
      const models = tokGroup(win, (b) => b.model || "unknown", (b) => ({ model: b.model || "Unknown model", provider: b.provider, rate: b._rate }));
      const clients = tokGroup(win, (b) => b.key_id, (b) => ({ key: b.key_id }));
      const providers = byProviderOrder(tokGroup(win, (b) => b.provider, (b) => ({ provider: b.provider })), (r) => r.provider);
      const byProvider = t.colorBy === "provider";
      const top = byProvider
        ? [...providers].sort((a, b) => (isCost ? b.c.cost - a.c.cost : 0) || tokTotal(b.c) - tokTotal(a.c))[0]
        : accounts[0];
      const all = Math.max(1, tokTotal(sum));
      const allCost = sum.cost || 1;
      const spark = (pick) => tokSpark(win, pick);
      const isTop = (b) => b.provider === top.provider && (byProvider || b.account === top.account);
      const days = tokDays(firstTs);
      let hero;
      if (isCost) {
        const costSpark = spark((b) => b._cost || 0);
        const reqSpark = spark((b) => (b._cost !== null ? b.requests : 0));
        const cprSpark = costSpark.map((v, i) => (reqSpark[i] ? v / reqSpark[i] : 0));
        const historyCard = t.range === "all"
          ? tokStat("Daily average", sum.priced ? fmtUsd(sum.cost / days) : "—",
              tokCostSub(sum, { fallback: `across ${plural(days, "day")}`, suffix: `since ${dateLabel(firstTs, false)}` }),
              costSpark, "#cc79a7")
          : tokStat("All-time API cost", allSum.priced ? fmtUsd(allSum.cost) : "—",
              tokCostSub(allSum, { fallback: `${fmtUsd(allSum.costIn + allSum.costOut)} in + out`, suffix: `since ${dateLabel(firstTs, false)}` }),
              tokSparkAll(buckets, (b) => b._cost || 0), "#cc79a7");
        const topSub = !top ? "No requests" : byProvider
          ? `${pName(top.provider)} · ${sum.cost ? Math.round((100 * top.c.cost) / allCost) : 0}% of API cost`
          : tokAccountFull(top.account);
        hero = `<dl class="tok-hero">${[
          tokStat("Estimated API cost", sum.priced ? fmtUsd(sum.cost) : "—",
            tokCostSub(sum, { fallback: `incl. ${fmtUsd(sum.costRead + sum.costWrite)} cache read/write` }),
            costSpark, "#10b981"),
          tokStat("Input + output", sum.priced ? fmtUsd(sum.costIn + sum.costOut) : "—",
            sum.priced ? `${fmtUsd(sum.costIn)} input · ${fmtUsd(sum.costOut)} output` : "No priced models",
            spark((b) => (b._costIn || 0) + (b._costOut || 0)), "#56b4e9"),
          historyCard,
          tokStat("Cache savings", sum.priced ? fmtUsd(sum.cacheSaved) : "—",
            sum.priced ? `${tokPct(tokCacheSavePct(sum))} off uncached · ${fmtUsd(sum.costRead)} read` : "No priced models",
            spark((b) => b._cacheSaved || 0), "#009e73"),
          tokStat("Cost / request", sum.pricedRequests ? fmtUsd(sum.cost / sum.pricedRequests) : "—",
            `across ${plural(sum.requests, "request")}`, cprSpark, "#e69f00"),
          tokStat(byProvider ? "Top provider" : "Top account", top && top.c.priced ? fmtUsd(top.c.cost) : "—", topSub,
            spark((b) => (isTop(b) ? b._cost || 0 : 0)), byProvider ? provColor(top?.provider) : "#cc79a7"),
        ].join("")}</dl>`;
      } else {
        const reads = spark((b) => b.cache_read_tokens),
          prompts = spark((b) => b.cache_read_tokens + (b.cache_write_tokens || 0) + b.input_tokens);
        const hitSpark = reads.map((v, i) => (prompts[i] ? v / prompts[i] : 0));
        const historyCard = t.range === "all"
          ? tokStat("Daily average", fmtTokens(Math.round(tokTotal(sum) / days)), `across ${plural(days, "day")} · since ${dateLabel(firstTs, false)}`, spark(tokBucketTotal), "#cc79a7")
          : tokStat("All-time tokens", fmtTokens(tokTotal(allSum)), `${fmtTokens(allSum.input + allSum.output)} in + out · since ${dateLabel(firstTs, false)}`, tokSparkAll(buckets, tokBucketTotal), "#cc79a7");
        const topSub = !top ? "No requests" : byProvider
          ? `${pName(top.provider)} · ${Math.round(100 * tokTotal(top.c) / all)}% of all tokens` : tokAccountFull(top.account);
        hero = `<dl class="tok-hero">${[
          tokStat("Total tokens", fmtTokens(tokTotal(sum)), `incl. ${fmtTokens(sum.read + sum.write)} cache read/write`, spark(tokBucketTotal), "#82aafa"),
          tokStat("Input + output", fmtTokens(sum.input + sum.output), `${fmtTokens(sum.input)} input · ${fmtTokens(sum.output)} output`, spark((b) => b.input_tokens + b.output_tokens), "#56b4e9"),
          historyCard,
          tokStat("Cache hit", tokPct(tokHit(sum)), `${fmtTokens(sum.read)} read · ${fmtTokens(sum.write)} written`, hitSpark, "#009e73"),
          tokStat("Requests", sum.requests.toLocaleString(), sum.failed ? `${sum.failed.toLocaleString()} failed` : "none failed", spark((b) => b.requests), "#e69f00"),
          tokStat(byProvider ? "Top provider" : "Top account", top ? fmtTokens(tokTotal(top.c)) : "—", topSub,
            spark((b) => isTop(b) ? tokBucketTotal(b) : 0), byProvider ? provColor(top?.provider) : "#cc79a7"),
        ].join("")}</dl>`;
      }
      const shareUnit = isCost ? "API cost" : "all tokens";
      const showAll = (t.showAll ||= {});
      const TOK_DEFAULT_LIMIT = 6;
      const slicePart = (part, list, noun) => {
        const open = Boolean(showAll[part]);
        const shown = open ? list : list.slice(0, TOK_DEFAULT_LIMIT);
        const btn = list.length > TOK_DEFAULT_LIMIT
          ? `<button type="button" class="outline sm tok-more" data-tok-more="${part}" aria-expanded="${open}">${open ? "Show fewer" : `Show all ${list.length} ${noun}`}</button>`
          : "";
        return { shown, btn };
      };
      const acctPart = slicePart("account", accounts, "accounts");
      const modelPart = slicePart("model", models, "models");
      html = `${toolbar}${hero}${tokChart(win)}${t.range === "all" || t.range >= 168 ? tokDaily(win) : ""}<div class="segmented sm tok-switch" role="group" aria-label="Breakdown">${[["provider", "Providers"], ["account", "Accounts"], ["model", "Models"], ["client", "Clients"]].map(([k, l]) => `<button data-tok-view="${k}" ${choice(t.view === k)}>${l}</button>`).join("")}</div><div class="tok-breakdowns" data-tok-show="${t.view}"><section class="tok-section" data-tok-part="provider"><h3 class="breakdown-title">By provider</h3><div class="tok-grid">${providers.map((r) => { const share = isCost ? (sum.cost ? r.c.cost / allCost : 0) : tokTotal(r.c) / all, card = tokCard(providerIcon(r.provider), pName(r.provider), `${share === 0 ? "0" : share < 0.001 ? "<0.1" : (share * 100).toFixed(share < 0.1 ? 1 : 0)}% of ${shareUnit}`, r.c); return card.slice(0, -10) + `<div class="tok-share" role="img" aria-label="${Math.round(share * 100)}% of ${shareUnit}"><span style="width:${(share * 100).toFixed(1)}%;background:${provColor(r.provider)}"></span></div></article>`; }).join("")}</div></section><section class="tok-section" data-tok-part="account"><div class="tok-section-head"><h3 class="breakdown-title">By account</h3>${acctPart.btn}</div><div class="tok-grid">${acctPart.shown.map((r) => tokCard(providerIcon(r.provider), tokAccountLabel(r.account), tokAccountSub(r), r.c)).join("")}</div></section><section class="tok-section" data-tok-part="model"><div class="tok-section-head"><h3 class="breakdown-title">By model</h3>${modelPart.btn}</div><div class="tok-grid">${modelPart.shown.map((r) => tokCard(providerIcon(r.provider), r.model, tokRateLabel(r.rate), r.c)).join("")}</div></section><section class="tok-section" data-tok-part="client"><h3 class="breakdown-title">By client</h3><div class="tok-grid">${clients.map((r) => tokCard(icon(r.key === "shared" ? "accounts" : "key"), tokClientName(r.key), r.key === "shared" ? "Config api-key" : r.key === "imported" ? "Local CLI logs (not via Silo)" : "", r.c)).join("")}</div></section></div>`;
    }
  }
  // Skip only when this container already shows it (a re-mounted page starts empty).
  if (html === t.html && root.childElementCount) return;
  t.html = html;
  const next = document.createElement("template");
  next.innerHTML = html;
  root.replaceChildren(next.content);
  updateIndicators();
}
$("#page-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tok-more]");
  if (!b) return;
  const part = b.dataset.tokMore;
  state.tokens.showAll ||= {};
  state.tokens.showAll[part] = !state.tokens.showAll[part];
  renderTokens();
  $(`[data-tok-more="${CSS.escape(part)}"]`)?.focus({ preventScroll: true });
});
// Tapping inspects too, like the quota charts.
for (const type of ["pointermove", "pointerdown", "pointerup"])
  $("#page-body").addEventListener(type, (e) => {
    const fig = e.target.closest("[data-tok-chart]"),
      ch = tokChartFor(fig);
    if (!fig || !ch || !inspects(e)) return;
    holdTouch(e, fig);
    const rect = $("svg", fig).getBoundingClientRect(),
      px = ((e.clientX - rect.left) / rect.width) * ch.W,
      f = (px - ch.left) / (ch.W - ch.left - ch.right);
    inspectTokChart(fig, ch.bars ? Math.floor(f * ch.n) : Math.round(f * (ch.n - 1)));
  });
$("#page-body").addEventListener("pointerout", (e) => {
  if (e.pointerType === "touch") return;
  const fig = e.target.closest("[data-tok-chart]");
  if (fig && !fig.contains(e.relatedTarget) && document.activeElement !== fig) clearTokChart(fig);
});
$("#page-body").addEventListener("focusout", (e) => {
  if (e.target.matches?.("[data-tok-chart]")) clearTokChart(e.target);
});
$("#page-body").addEventListener("keydown", (e) => {
  const fig = e.target.closest?.("[data-tok-chart]"),
    ch = tokChartFor(fig);
  if (!fig || !ch || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const cur = fig.dataset.slot === undefined ? ch.n : Number(fig.dataset.slot);
  inspectTokChart(fig, { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: ch.n - 1 }[e.key]);
});

// Key usage chart: the pointer or arrow keys pick an interval.
function clearUsage(fig) {
  $(".usage-hover", fig)?.setAttribute("hidden", "");
  const tooltip = $(".chart-tooltip", fig),
    note = $(".chart-inspect", fig);
  if (tooltip) tooltip.hidden = true;
  if (note && fig.dataset.idle !== undefined) note.textContent = fig.dataset.idle;
  delete fig.dataset.slot;
}
function inspectKeyChart(fig, slot) {
  const chart = state.keys.chart;
  if (!chart || !slot) return clearUsage(fig);
  fig.dataset.idle ??= $(".chart-inspect", fig).textContent;
  fig.dataset.slot = slot.ts;
  const svg = $("svg", fig),
    hover = $(".usage-hover", fig),
    tooltip = $(".chart-tooltip", fig),
    x0 = chart.x(slot.ts),
    x1 = chart.x(slot.end);
  hover.setAttribute("x", x0);
  hover.setAttribute("width", Math.max(1, x1 - x0));
  hover.removeAttribute("hidden");
  const time = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const label = chart.daily
    ? dateLabel(slot.ts, false)
    : `${dateLabel(slot.ts, false)} · ${time(slot.ts)} – ${time(slot.end)}`;
  // On phones: the top 2 models and one "Other" row for the rest.
  let rows = chart.models.map((m, i) => ({ name: m.name, color: m.color, v: slot.parts[i] })).filter((r) => r.v > 0);
  if (innerWidth <= 760 && rows.length > 3) {
    rows.sort((a, b) => b.v - a.v);
    rows = [...rows.slice(0, 2), { name: "Other", color: "var(--muted-foreground)", v: rows.slice(2).reduce((s, r) => s + r.v, 0) }];
  }
  tooltip.style.maxWidth = `${((chart.W - chart.left - chart.right) / chart.W) * svg.clientWidth}px`;
  tooltip.innerHTML = `<div class="tip-label">${esc(label)}</div>${rows
    .map((r) => `<div class="tip-row"><i class="tip-swatch" style="background:${r.color}"></i><span title="${esc(r.name)}">${esc(r.name)}</span><strong>${esc(fmtTokens(r.v))}</strong></div>`)
    .join("")}<div class="tip-row tip-total"><span>${plural(slot.requests, "request")}${slot.failed ? ` · ${slot.failed} failed` : ""}</span><strong>${esc(slot.tokens.toLocaleString())} tokens</strong></div>`;
  tooltip.hidden = false;
  const ax = ((x0 + x1) / 2 / chart.W) * svg.clientWidth,
    tw = tooltip.offsetWidth;
  let left = ax + 14;
  if (left + tw > svg.clientWidth) left = ax - 14 - tw;
  // Same plot-area clamp as the tokens chart.
  const sx = svg.clientWidth / chart.W,
    sy = svg.clientHeight / chart.H;
  left = Math.max(chart.left * sx, Math.min(left, svg.clientWidth - tw));
  const gap = svg.getBoundingClientRect().top - fig.getBoundingClientRect().top - fig.clientTop,
    y0 = gap + chart.top * sy,
    top = Math.max(y0, Math.min(y0 + 16, gap + (chart.H - chart.bottom) * sy - tooltip.offsetHeight));
  tooltip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  $(".chart-inspect", fig).textContent = `${label} · ${slot.tokens.toLocaleString()} tokens, ${plural(slot.requests, "request")}`;
}
for (const type of ["pointermove", "pointerdown", "pointerup"])
  $("#page-body").addEventListener(type, (e) => {
    const fig = e.target.closest("[data-key-chart]"),
      chart = state.keys.chart;
    if (!fig || !chart || !inspects(e)) return;
    holdTouch(e, fig);
    const rect = $("svg", fig).getBoundingClientRect(),
      px = ((e.clientX - rect.left) / rect.width) * chart.W,
      ts = chart.start + ((px - chart.left) / (chart.W - chart.left - chart.right)) * (chart.end - chart.start),
      clamped = Math.min(chart.end - 1, Math.max(chart.start, ts));
    inspectKeyChart(fig, chart.slots.find((s) => clamped >= s.ts && clamped < s.end));
  });
$("#page-body").addEventListener("pointerout", (e) => {
  if (e.pointerType === "touch") return;
  const fig = e.target.closest("[data-key-chart]");
  if (fig && !fig.contains(e.relatedTarget) && document.activeElement !== fig) clearUsage(fig);
});
$("#page-body").addEventListener("focusout", (e) => {
  if (e.target.matches?.("[data-key-chart]")) clearUsage(e.target);
});
$("#page-body").addEventListener("keydown", (e) => {
  const fig = e.target.closest?.("[data-key-chart]"),
    chart = state.keys.chart;
  if (!fig || !chart || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const slots = chart.slots,
    current = slots.findIndex((s) => s.ts === Number(fig.dataset.slot)),
    n = {
      ArrowLeft: current < 0 ? slots.length - 1 : current - 1,
      ArrowRight: current < 0 ? slots.length - 1 : current + 1,
      Home: 0,
      End: slots.length - 1,
    }[e.key];
  inspectKeyChart(fig, slots[Math.min(slots.length - 1, Math.max(0, n))]);
});
