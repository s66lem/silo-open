// Client keys page and key dialog.
"use strict";
// ---- Client keys ----
// Each client gets its own key; the proxy enforces its restrictions and
// weekly token limit. A secret is shown once, right after create or rotate.
const keyById = (id) => state.keys.list?.find((k) => k.id === id);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
function fmtTokens(n) {
  n = Number(n) || 0;
  for (const [size, suffix] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ])
    if (n >= size) {
      const v = n / size;
      return `${+v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}${suffix}`;
    }
  return String(Math.round(n));
}
// "5M", "500k", "1.5b", "2,000,000"; empty or 0 means no limit.
function parseTokens(text) {
  const t = String(text).toLowerCase().replace(/[\s,_]/g, "");
  if (!t) return 0;
  const m = /^(\d+(?:\.\d+)?|\.\d+)([kmbt]?)$/.exec(t);
  if (!m) return NaN;
  const n = Math.round(
    Number(m[1]) * { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]],
  );
  return n <= 1e15 ? n : NaN;
}
// The proxy's model patterns: case-insensitive, * any run, ? one character.
const modelPattern = (p) =>
  new RegExp(
    `^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
    "i",
  );
const keyAccount = (id) =>
  state.keys.options?.accounts.find((a) => a.id === id);
const keyAccountLabel = (id) =>
  id ? nickOf(id) || keyAccount(id)?.label || id : "Unknown account";
function keysMeta() {
  const list = state.keys.list;
  if (!list) return "Loading keys…";
  if (!list.length) return "";
  const on = list.filter((k) => k.enabled).length;
  return `${list.length} key${list.length === 1 ? "" : "s"} · ${on} enabled`;
}
function keysPage() {
  return `<div class="keys" id="keys-live" data-live></div>`;
}
function ensureKeys() {
  if (!$("#keys-live")) return;
  if (!$("#keys-live").firstChild) renderKeys();
  // Entering the page and every snapshot refresh re-read keys and usage.
  loadKeys();
}
async function loadKeys() {
  const keys = state.keys;
  try {
    const [list, options] = await Promise.all([
      api("keys"),
      api("keys/options"),
    ]);
    keys.list = list.keys || [];
    keys.base = list.base_url || location.origin;
    keys.options = options;
    syncHeaderActions();
    keys.error = "";
    if (keys.open && !keyById(keys.open)) {
      keys.open = null;
      keys.usage = null;
    }
  } catch (e) {
    keys.error = e.message;
  }
  renderKeys();
  if (keys.open) loadKeyUsage(keys.open);
}
async function loadKeyUsage(id) {
  try {
    const r = await api(
      `keys/usage?hours=168&key=${encodeURIComponent(id)}`,
    );
    if (state.keys.open !== id) return;
    state.keys.usage = { id, buckets: r.buckets || [] };
    state.keys.usageError = "";
  } catch (e) {
    if (state.keys.open !== id) return;
    state.keys.usageError = e.message;
  }
  renderKeys();
}
function toggleKey(id) {
  const keys = state.keys;
  keys.open = keys.open === id ? null : id;
  keys.usage = null;
  keys.usageError = "";
  renderKeys();
  if (keys.open) {
    loadKeyUsage(id);
    $("#key-detail")?.scrollIntoView({
      block: "nearest",
      behavior: motionAllowed() ? "smooth" : "auto",
    });
  }
}
function scopeChips(k) {
  const chips = [
    ...k.providers.map(
      (p) =>
        `<span class="tag outline" title="Provider: ${esc(pName(p))}">${PROVIDERS[p] ? providerIcon(p) : ""}<span>${esc(pName(p))}</span></span>`,
    ),
    ...k.accounts.map(
      (a) =>
        `<span class="tag outline" title="Account: ${esc(keyAccountLabel(a))}">${icon("accounts")}<span>${esc(keyAccountLabel(a))}</span></span>`,
    ),
    ...k.models.map(
      (m) =>
        `<span class="tag outline model" title="Model: ${esc(m)}"><span>${esc(m)}</span></span>`,
    ),
  ];
  if (!chips.length)
    return `<span class="tag outline any" title="Any provider, account and model">Any</span>`;
  return (
    chips.slice(0, 4).join("") +
    (chips.length > 4
      ? `<span class="tag outline any">+${chips.length - 4}</span>`
      : "")
  );
}
function keyMeter(k) {
  const used = k.weekly_tokens,
    limit = k.weekly_token_limit;
  if (!limit)
    return `<div class="key-usage"><span class="key-usage-value"><strong>${morph(esc(fmtTokens(used)))}</strong> this week · no limit</span></div>`;
  const share = Math.min(1, used / limit);
  return `<div class="key-usage" title="${esc(`${used.toLocaleString()} of ${limit.toLocaleString()} tokens in the last 7 days`)}"><div class="meter ${share >= 1 ? "full" : share >= 0.8 ? "warning" : ""}"><span style="transform:scaleX(${share})"></span></div><span class="key-usage-value"><strong>${morph(esc(fmtTokens(used)))}</strong> / ${esc(fmtTokens(limit))}</span></div>`;
}
function keyRow(k) {
  const open = state.keys.open === k.id;
  return `<article class="key-row" data-key="${esc(k.id)}" data-enabled="${k.enabled}" aria-current="${open}"><div class="key-identity"><button class="key-name" data-key-open="${esc(k.id)}" aria-expanded="${open}" aria-controls="key-detail" title="${esc(k.name)}">${esc(k.name)}</button><code class="key-hint">cpk_…${esc(k.hint)}</code></div><div class="key-scope">${scopeChips(k)}</div>${keyMeter(k)}<div class="account-actions"><button class="switch" role="switch" aria-checked="${k.enabled}" aria-label="Enable ${esc(k.name)}" title="${k.enabled ? "Enabled" : "Disabled: requests with this key are refused"}" data-key-enabled="${esc(k.id)}"><span class="switch-thumb"></span></button></div></article>`;
}
// Usage totals by one bucket field (model or account), largest first.
function keyTotals(buckets, field) {
  const map = new Map();
  for (const b of buckets) {
    const row = map.get(b[field]) || { id: b[field], tokens: 0, requests: 0, failed: 0 };
    row.tokens += b.tokens;
    row.requests += b.requests;
    row.failed += b.failed;
    map.set(b[field], row);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
}
function keyShares(title, rows, label) {
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  return `<div><div class="breakdown-head"><span class="breakdown-title">${title}</span></div><div class="mini-accounts">${
    rows.length
      ? rows
          .map(
            (r) =>
              `<div class="key-share"><span class="mini-label" title="${esc(label(r))}">${r.swatch ? `<i class="mini-swatch" style="background:${r.swatch}"></i>` : ""}${esc(label(r))}</span><div class="meter"><span style="transform:scaleX(${total ? r.tokens / total : 0})"></span></div><span class="mini-value">${esc(fmtTokens(r.tokens))}</span><span class="key-requests">${r.requests.toLocaleString()} req${r.failed ? ` · ${r.failed} failed` : ""}</span></div>`,
          )
          .join("")
      : '<p class="key-empty">No requests in the last 7 days.</p>'
  }</div></div>`;
}
// Tokens per hour or per day over the last 7 days, stacked by model.
function keyChart(buckets, models) {
  const daily = state.keys.unit === "day",
    hour = 3600,
    now = Date.now() / 1000;
  let start, end, size;
  if (daily) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    end = today.getTime() / 1000 + 86400;
    start = end - 7 * 86400;
    size = 86400;
  } else {
    end = Math.floor(now / hour) * hour + hour;
    start = end - 168 * hour;
    size = hour;
  }
  // Local days can be 23 or 25 hours long; place each bucket by its own start.
  const slots = [];
  for (let i = 0, t = start; t < end; i++) {
    const next = daily
      ? new Date(new Date(t * 1000).setDate(new Date(t * 1000).getDate() + 1)).getTime() / 1000
      : t + size;
    slots.push({ ts: t, end: next, parts: models.map(() => 0), tokens: 0, requests: 0, failed: 0 });
    t = next;
  }
  const index = new Map(models.map((m, i) => [m.id, i]));
  for (const b of buckets) {
    const slot = slots.find((s) => b.hour >= s.ts && b.hour < s.end);
    if (!slot) continue;
    const i = index.get(b.model) ?? models.length - 1;
    slot.parts[i] += b.tokens;
    slot.tokens += b.tokens;
    slot.requests += b.requests;
    slot.failed += b.failed;
  }
  const W = Math.max(280, ($("#page-body").clientWidth || 1000) - 34),
    H = 160,
    left = 46,
    right = 10,
    top = 8,
    bottom = 24;
  const x = (t) => left + ((t - start) / (end - start)) * (W - left - right);
  const peak = Math.max(0, ...slots.map((s) => s.tokens));
  const magnitude = 10 ** Math.floor(Math.log10(peak || 1));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((v) => peak <= v) || 10 * magnitude;
  const y = (v) => H - bottom - (v / step) * (H - top - bottom);
  state.keys.chart = { slots, x, start, end, W, H, left, right, top, bottom, models, daily };
  let marks = `<line class="grid-line" x1="${left}" x2="${W - right}" y1="${y(step)}" y2="${y(step)}"/><text x="${left - 10}" y="${y(step) + 4}" text-anchor="end">${esc(fmtTokens(step))}</text><line x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}" stroke="var(--border)"/>`;
  const days = [];
  for (const s of slots) if (daily || new Date(s.ts * 1000).getHours() === 0) days.push(s);
  // Day labels, skipping any that would crowd the previous one.
  let lastLabel = -Infinity;
  days.forEach((s) => {
    const cx = daily ? (x(s.ts) + x(s.end)) / 2 : x(s.ts);
    // Keep the last label inside the chart.
    const anchor = cx > W - right - 40 ? "end" : daily ? "middle" : "start";
    const lx = anchor === "end" ? W - right : cx;
    if (lx - lastLabel < (anchor === "end" ? 110 : 64)) return;
    lastLabel = lx;
    marks += `<text x="${lx}" y="${H - 6}" text-anchor="${anchor}">${esc(dateLabel(s.ts, false))}</text>`;
  });
  const bars = slots
    .map((s) => {
      const x0 = x(s.ts),
        width = Math.max(1, x(s.end) - x0 - (daily ? 8 : 1));
      let acc = 0;
      return models
        .map((m, k) => {
          const v = s.parts[k];
          if (v <= 0) return "";
          const h = y(acc) - y(acc + v),
            rect = `<rect x="${x0 + (daily ? 4 : 0.5)}" y="${y(acc + v)}" width="${width}" height="${Math.max(1.5, acc ? h - 1 : h)}" rx="1.5" fill="${m.color}"/>`;
          acc += v;
          return rect;
        })
        .join("");
    })
    .join("");
  const quiet = !slots.some((s) => s.tokens > 0);
  return `<figure class="plot usage" data-key-chart tabindex="0" aria-label="Tokens per ${daily ? "day" : "hour"} over the last 7 days, by model. Use left and right arrows to inspect."><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${marks}<rect class="usage-hover" x="0" y="${top}" width="0" height="${H - top - bottom}" hidden/><g class="chart-data">${bars}</g></svg><div class="chart-tooltip" hidden></div>${quiet ? '<div class="usage-empty">No tokens used in the last 7 days</div>' : ""}<figcaption class="chart-caption"><span>Tokens per ${daily ? "day" : "hour"}</span>${models.length > 1 ? models.map((m) => `<span class="legend"><i class="tip-swatch" style="background:${m.color}"></i>${esc(m.name)}</span>`).join("") : ""}<span class="chart-inspect" aria-live="polite">Input and output; cache reads excluded</span></figcaption></figure>`;
}
function keyDetail(k) {
  const keys = state.keys,
    usage = keys.usage?.id === k.id ? keys.usage.buckets : null;
  const head = `<header class="log-viewer-head"><span class="key-detail-title" title="${esc(k.name)}">${esc(k.name)}</span><button class="outline sm" data-key-edit="${esc(k.id)}" aria-label="Edit ${esc(k.name)}">${icon("edit")}<span class="button-label">Edit</span></button><button class="outline sm" data-key-rotate="${esc(k.id)}" aria-label="Rotate ${esc(k.name)}">${icon("refresh")}<span class="button-label">Rotate</span></button><button class="ghost sm danger" data-key-delete="${esc(k.id)}" aria-label="Delete ${esc(k.name)}">${icon("trash")}<span class="button-label">Delete</span></button><button class="ghost icon-btn sm" data-key-close aria-label="Close usage">${icon("close")}</button></header>`;
  let body;
  if (keys.usageError && !usage)
    body = `<div class="notice error">${icon("warning")}<span>${esc(keys.usageError)}</span></div>`;
  else if (!usage)
    body = `<div class="logs-loading"><span class="loading-mark"></span>Loading usage…</div>`;
  else {
    // Biggest models get their own color; the rest share one.
    const byModel = keyTotals(usage, "model"),
      named = byModel.slice(0, byModel.length > MODEL_COLORS.length ? MODEL_COLORS.length - 1 : MODEL_COLORS.length);
    const models = named.map((r, i) => ({ id: r.id, name: r.id || "Unknown model", color: MODEL_COLORS[i] }));
    if (byModel.length > named.length)
      models.push({ id: null, name: "Other models", color: "var(--muted-foreground)" });
    byModel.forEach((r, i) => (r.swatch = (models[i] || models.at(-1)).color));
    const total = byModel.reduce(
      (s, r) => ({ tokens: s.tokens + r.tokens, requests: s.requests + r.requests, failed: s.failed + r.failed }),
      { tokens: 0, requests: 0, failed: 0 },
    );
    const cache = usage.reduce((s, b) => s + b.cache_read_tokens, 0);
    body = `<dl class="metrics"><div class="metric"><dt>Tokens, last 7 days</dt><dd>${morph(esc(total.tokens.toLocaleString()))}</dd></div><div class="metric"><dt>Weekly limit</dt><dd>${morph(k.weekly_token_limit ? esc(k.weekly_token_limit.toLocaleString()) : "No limit")}</dd></div><div class="metric"><dt>Requests</dt><dd>${morph(`${total.requests.toLocaleString()}${total.failed ? ` · ${total.failed} failed` : ""}`)}</dd></div><div class="metric"><dt>Cache reads</dt><dd>${morph(esc(cache.toLocaleString()))}</dd></div></dl><div class="key-chart-head"><span class="breakdown-title">Usage</span><div class="segmented sm" role="group" aria-label="Chart interval">${[["hour", "Hourly"], ["day", "Daily"]].map(([u, l]) => `<button data-key-unit="${u}" ${choice(keys.unit === u)}>${l}</button>`).join("")}</div></div>${keyChart(usage, models)}<div class="breakdown key-breakdowns">${keyShares("By model", byModel, (r) => r.id || "Unknown model")}${keyShares("By account", keyTotals(usage, "account"), (r) => keyAccountLabel(r.id))}</div>`;
  }
  return `<section class="key-detail" id="key-detail" aria-label="Usage for ${esc(k.name)}">${head}<div class="key-detail-body">${body}</div></section>`;
}
function renderKeys() {
  const root = $("#keys-live");
  if (!root) return;
  const keys = state.keys,
    open = keys.open && keyById(keys.open);
  let content;
  if (keys.error && !keys.list)
    content = `<div class="notice error">${icon("warning")}<span>${esc(keys.error)}</span></div>`;
  else if (!keys.list)
    content = `<div class="logs-loading"><span class="loading-mark"></span>Loading keys…</div>`;
  else if (!keys.list.length)
    content = `<div class="state-card"><h2>No client keys yet</h2><p>Give each client its own key to limit which providers, accounts and models it uses, cap its weekly tokens and see its usage.</p><button class="primary key-empty-new" data-key-new${keys.options ? "" : " disabled"}>${icon("plus")}New key</button></div>`;
  else
    content = `<div class="key-list">${keys.list.map(keyRow).join("")}</div>${open ? keyDetail(open) : ""}`;
  const next = document.createElement("template");
  next.innerHTML = `${keys.error && keys.list ? `<div class="notice error">${icon("warning")}<span>${esc(keys.error)}</span></div>` : ""}${content}`;
  patchChildren(root, next.content);
  updateIndicators();
  if (state.page === "keys") morphText($("#page-meta"), keysMeta());
}
async function keyAction(b) {
  const d = b.dataset;
  if (d.keyNew !== undefined) openKeyDialog();
  else if (d.keyOpen) toggleKey(d.keyOpen);
  else if (d.keyClose !== undefined) {
    const id = state.keys.open;
    toggleKey(id);
    $(`[data-key-open="${CSS.escape(id)}"]`)?.focus();
  } else if (d.keyUnit) {
    state.keys.unit = d.keyUnit;
    renderKeys();
  } else if (d.keyEdit) openKeyDialog(d.keyEdit);
  else if (d.keyRotate) confirmRotate(d.keyRotate);
  else if (d.keyDelete) confirmDelete(d.keyDelete);
  else if (d.keyEnabled) {
    if (b.hasAttribute("data-motion-pending")) return;
    const k = keyById(d.keyEnabled);
    if (!k) return;
    const enabled = !k.enabled;
    // Flip immediately; revert if the proxy rejects the change.
    b.dataset.motionPending = "";
    b.setAttribute("aria-checked", String(enabled));
    try {
      const r = await api("keys/update", { id: k.id, enabled });
      Object.assign(k, r.key);
      notify(
        enabled ? "Key enabled" : "Key disabled",
        "success",
        enabled
          ? `${k.name} can make requests again.`
          : `Requests with ${k.name} are refused.`,
      );
    } catch (err) {
      b.setAttribute("aria-checked", String(!enabled));
      notify("Couldn't update the key", "error", err.message);
    } finally {
      delete b.dataset.motionPending;
      renderKeys();
    }
  }
}
const focusKey = (id) => () =>
  ($(`[data-key-open="${CSS.escape(id)}"]`) || ($("#add-login").hidden ? $(".key-empty-new") : $("#add-login")))?.focus();
function confirmRotate(id) {
  const k = keyById(id);
  if (!k) return;
  askConfirm({
    title: `Rotate ${k.name}?`,
    description:
      "A new secret replaces this key's secret right away. Clients using the current one stop working until they get the new one.",
    label: "Rotate key",
    busy: "Rotating…",
    failure: "Couldn't rotate the key",
    returnFocus: () => $(`[data-key-rotate="${CSS.escape(id)}"]`)?.focus(),
    run: () => api("keys/rotate", { id }),
    done(r) {
      Object.assign(k, r.key);
      renderKeys();
      showSecret(r.key, r.secret, "rotated");
    },
  });
}
function confirmDelete(id) {
  const k = keyById(id);
  if (!k) return;
  askConfirm({
    title: `Delete ${k.name}?`,
    description:
      "Clients using this key stop working right away and its usage history is deleted. This can’t be undone.",
    label: "Delete key",
    busy: "Deleting…",
    failure: "Couldn't delete the key",
    returnFocus: () => $(`[data-key-delete="${CSS.escape(id)}"]`)?.focus(),
    run: () => api("keys/delete", { id }),
    async done() {
      notify("Key deleted", "success", `${k.name} no longer works.`);
      if (state.keys.open === id) state.keys.open = null;
      await loadKeys();
      // The phone empty state hides the header button; focus its own button instead.
      ($("#add-login").hidden ? $(".key-empty-new") : $("#add-login"))?.focus();
    },
  });
}

// Key dialog: create or edit.
let keyEditing = null,
  keyModels = [];
function keyFieldError(id, text) {
  const input = $(`#${id}`),
    error = $(`#${id}-error`);
  if (error) {
    error.textContent = text || "";
    error.hidden = !text;
  }
  if (text) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
function renderModelChips() {
  const box = $("#key-models");
  $$(".tag", box).forEach((chip) => chip.remove());
  $("#key-model-input").insertAdjacentHTML(
    "beforebegin",
    keyModels
      .map(
        (m, i) =>
          `<span class="tag outline">${esc(m)}<button type="button" class="chip-remove" data-chip="${i}" aria-label="Remove ${esc(m)}">${icon("close")}</button></span>`,
      )
      .join(""),
  );
  $("#key-model-input").placeholder = keyModels.length ? "Add a pattern" : "Any model";
}
function addModelChips(text) {
  for (const p of text.toLowerCase().split(/[\s,]+/))
    if (p && !keyModels.includes(p)) keyModels.push(p);
  $("#key-model-input").value = "";
  renderModelChips();
}
function showLimit() {
  const input = $("#key-limit"),
    n = parseTokens(input.value);
  keyFieldError("key-limit", "");
  if (Number.isNaN(n)) {
    input.setAttribute("aria-invalid", "true");
    $("#key-limit-help").textContent = "Use a number like 5M, 500k or 2,000,000.";
  } else
    $("#key-limit-help").textContent = n
      ? `${n.toLocaleString()} tokens over any 7 days. Input and output count; cache reads don't.`
      : "No limit. Type a number like 5M or 500k to cap tokens over any 7 days.";
  return n;
}
// Format a token limit concisely only when the abbreviated form parses back to the exact integer.
function fmtTokensExact(n) {
  if (!n) return "";
  const short = fmtTokens(n);
  return parseTokens(short) === n ? short : n.toLocaleString("en-US");
}
function hiddenCheckedKeyAccounts() {
  const hidden = [];
  for (const group of $$("#key-accounts [data-account-provider]")) {
    if (!group.hidden || !group.dataset.accountProvider) continue;
    for (const input of $$('input[name="key-account"]:checked', group)) {
      hidden.push({
        input,
        provider: group.dataset.accountProvider,
        label: input.closest(".reset-row")?.querySelector(".reset-row-title")?.textContent || input.value,
      });
    }
  }
  return hidden;
}
function updateKeyAccountsScopeHelp() {
  const help = $("#key-accounts-help");
  if (!help) return;
  const selectedProviders = $$('input[name="key-provider"]:checked', $("#key-form"));
  const selectedAccounts = $$('input[name="key-account"]:checked', $("#key-form"));
  if (!selectedAccounts.length) {
    help.textContent = selectedProviders.length
      ? "Any account under the selected providers."
      : "Any account.";
  } else {
    help.textContent = `Restricted to ${selectedAccounts.length} selected account${selectedAccounts.length === 1 ? "" : "s"}.`;
  }
}
function updateHiddenKeyAccountsNotice() {
  const hidden = hiddenCheckedKeyAccounts();
  let notice = $("#key-accounts .key-hidden-notice");
  if (!hidden.length) {
    notice?.remove();
    if ($("#key-error")?.dataset.hiddenAccountsError) {
      $("#key-error").hidden = true;
      delete $("#key-error").dataset.hiddenAccountsError;
    }
    updateKeyAccountsScopeHelp();
    return;
  }
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "key-hidden-notice";
    $("#key-accounts").prepend(notice);
  }
  const providers = [...new Set(hidden.map((h) => pName(h.provider)))].join(", ");
  notice.innerHTML = `<span>${hidden.length} selected account${hidden.length === 1 ? "" : "s"} hidden by provider filter (${esc(providers)}). Re-enable ${esc(providers)} or clear them before saving.</span><button type="button" class="outline sm" data-key-clear-hidden>Clear hidden</button>`;
  updateKeyAccountsScopeHelp();
}
function filterKeyAccounts() {
  const selected = new Set($$('input[name="key-provider"]:checked').map((input) => input.value));
  let visible = false;
  for (const group of $$("#key-accounts [data-account-provider]")) {
    const provider = group.dataset.accountProvider;
    group.hidden = selected.size > 0 && !selected.has(provider);
    if (!group.hidden) visible = true;
  }
  updateHiddenKeyAccountsNotice();
  const empty = $("#key-accounts .key-empty");
  empty.hidden = visible;
  empty.textContent = selected.size
    ? "No accounts for the selected providers."
    : "No accounts are signed in.";
}
$("#key-providers").addEventListener("change", filterKeyAccounts);
$("#key-accounts").addEventListener("change", updateKeyAccountsScopeHelp);
$("#key-accounts").addEventListener("click", (e) => {
  if (!e.target.closest("[data-key-clear-hidden]")) return;
  for (const h of hiddenCheckedKeyAccounts()) h.input.checked = false;
  updateHiddenKeyAccountsNotice();
  const nextFocus =
    $$('#key-accounts [data-account-provider]:not([hidden]) input[name="key-account"]')[0] ||
    $("#key-save");
  nextFocus?.focus();
});
function openKeyDialog(id) {
  const k = id ? keyById(id) : null,
    options = state.keys.options;
  if (!options || (id && !k)) return;
  keyEditing = id || null;
  $("#key-title").textContent = k ? `Edit ${k.name}` : "New key";
  $("#key-description").textContent = k
    ? "Changes apply to the next request made with this key."
    : "Leave a restriction empty to allow anything. The secret is shown once, after you create the key.";
  $("#key-save").idleHTML = k ? "Save changes" : "Create key";
  setBusy($("#key-save"), false);
  $("#key-error").hidden = true;
  $("#key-name").value = k?.name || "";
  keyFieldError("key-name", "");
  // Keep restrictions the proxy no longer lists, so saving never drops them silently.
  const providers = [...new Set([...options.providers, ...(k?.providers || [])])];
  $("#key-providers").innerHTML = providers
    .map(
      (p) =>
        `<label class="chip-option"><input type="checkbox" name="key-provider" value="${esc(p)}" ${k?.providers.includes(p) ? "checked" : ""}/>${PROVIDERS[p] ? providerIcon(p) : ""}${esc(pName(p))}</label>`,
    )
    .join("") || '<p class="key-empty">No providers are signed in.</p>';
  const accounts = [
    ...options.accounts,
    ...(k?.accounts || [])
      .filter((a) => !keyAccount(a))
      .map((a) => ({ id: a, provider: "", label: a, missing: true })),
  ];
  const groups = [...new Set(accounts.map((a) => a.provider))];
  $("#key-accounts").innerHTML = groups
    .map(
      (g) =>
        `<div data-account-provider="${esc(g)}"><div class="account-group-title">${esc(g ? pName(g) : "No longer signed in")}</div><div class="reset-list">${accounts
          .filter((a) => a.provider === g)
          .map(
            (a) =>
              `<label class="reset-row"><input type="checkbox" name="key-account" value="${esc(a.id)}" ${k?.accounts.includes(a.id) ? "checked" : ""}/><span class="reset-row-text"><span class="reset-row-title">${esc(nickOf(a.id) || a.label || a.id)}</span>${nickOf(a.id) && a.label ? `<span class="reset-row-meta">${esc(a.label)}</span>` : ""}${a.disabled ? '<span class="reset-row-meta">Paused</span>' : ""}</span></label>`,
          )
          .join("")}</div></div>`,
    )
    .join("") + '<p class="key-empty"></p>';
  filterKeyAccounts();
  $("#key-model-options").innerHTML = options.models
    .map((m) => `<option value="${esc(m.id)}"></option>`)
    .join("");
  keyModels = [...(k?.models || [])];
  $("#key-model-input").value = "";
  renderModelChips();
  $("#key-limit").value = k?.weekly_token_limit ? fmtTokensExact(k.weekly_token_limit) : "";
  showLimit();
  $("#key-dialog").showModal();
  $("#key-name").focus();
}
function closeKeyDialog() {
  const id = keyEditing;
  $("#key-dialog").close();
  focusKey(id || "")();
}
$("#key-close").addEventListener("click", closeKeyDialog);
$("#key-cancel").addEventListener("click", closeKeyDialog);
$("#key-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeKeyDialog();
});
$("#key-models").addEventListener("click", (e) => {
  const remove = e.target.closest("[data-chip]");
  if (remove) {
    keyModels.splice(Number(remove.dataset.chip), 1);
    renderModelChips();
  }
  $("#key-model-input").focus();
});
$("#key-model-input").addEventListener("keydown", (e) => {
  const input = e.target;
  if ((e.key === "Enter" || e.key === ",") && input.value.trim()) {
    e.preventDefault();
    addModelChips(input.value);
  } else if (e.key === "Backspace" && !input.value && keyModels.length) {
    keyModels.pop();
    renderModelChips();
  }
});
$("#key-model-input").addEventListener("input", (e) => {
  if (/[\s,]/.test(e.target.value)) addModelChips(e.target.value);
});
$("#key-model-input").addEventListener("blur", (e) => {
  if (e.target.value.trim()) addModelChips(e.target.value);
});
$("#key-limit").addEventListener("input", showLimit);
$("#key-limit").addEventListener("blur", () => {
  const n = parseTokens($("#key-limit").value);
  if (!Number.isNaN(n)) $("#key-limit").value = n ? fmtTokensExact(n) : "";
  showLimit();
});
$("#key-name").addEventListener("input", () => keyFieldError("key-name", ""));
$("#key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("#key-model-input").value.trim()) addModelChips($("#key-model-input").value);
  const name = $("#key-name").value.trim(),
    limit = showLimit();
  if (!name) {
    keyFieldError("key-name", "Name the key, e.g. after the person or app using it.");
    return $("#key-name").focus();
  }
  if (Number.isNaN(limit)) return $("#key-limit").focus();
  const hiddenAccounts = hiddenCheckedKeyAccounts();
  if (hiddenAccounts.length) {
    const uniqueProviders = [...new Set(hiddenAccounts.map((h) => pName(h.provider)))];
    const providers = uniqueProviders.join(", ");
    $("#key-error").textContent = `${hiddenAccounts.length} selected account${hiddenAccounts.length === 1 ? "" : "s"} belong to deselected provider${uniqueProviders.length === 1 ? "" : "s"} (${providers}). Re-enable ${providers} or clear hidden accounts before saving.`;
    $("#key-error").dataset.hiddenAccountsError = "1";
    $("#key-error").hidden = false;
    return $("#key-accounts [data-key-clear-hidden]")?.focus();
  }
  const checked = (n) => $$(`input[name="${n}"]:checked`, $("#key-form")).map((i) => i.value);
  const body = {
    name,
    providers: checked("key-provider"),
    accounts: checked("key-account"),
    models: keyModels,
    weekly_token_limit: limit,
  };
  $("#key-error").hidden = true;
  setBusy($("#key-save"), true, keyEditing ? "Saving…" : "Creating…");
  try {
    if (keyEditing) {
      await api("keys/update", { id: keyEditing, ...body });
      notify("Key updated", "success", `${name}'s settings apply to its next request.`);
      closeKeyDialog();
      await loadKeys();
    } else {
      const r = await api("keys/create", body);
      $("#key-dialog").close();
      state.keys.open = r.key.id;
      state.keys.usage = null;
      await loadKeys();
      showSecret(r.key, r.secret, "created");
    }
  } catch (err) {
    setBusy($("#key-save"), false);
    $("#key-error").textContent = err.message;
    $("#key-error").hidden = false;
  }
});

// The secret, shown once with a ready-to-paste example.
let secretKey = null;
function showSecret(k, secret, how) {
  secretKey = k.id;
  const base = state.keys.base.replace(/\/$/, ""),
    allowed = (state.keys.options?.models || []).filter(
      (m) =>
        (!k.models.length || k.models.some((p) => modelPattern(p).test(m.id))) &&
        (!k.providers.length || m.providers.some((p) => k.providers.includes(p))),
    ),
    model = allowed[0]?.id || k.models.find((p) => !/[*?]/.test(p)) || "MODEL";
  $("#secret-title").textContent = `Copy ${k.name}'s key`;
  $("#secret-description").textContent =
    how === "rotated"
      ? "The key was rotated. Give the client this new secret; the old one no longer works."
      : "The key is ready. Give it to the client it's for.";
  $("#secret-key").textContent = secret;
  $("#secret-base").textContent = base;
  $("#secret-example").textContent = `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`;
  $("#secret-dialog").showModal();
  $("#secret-copy").focus();
}
$("#secret-copy").addEventListener("click", (e) =>
  copyWithFeedback(e.currentTarget, $("#secret-key").textContent, "Copy API key"),
);
$("#secret-base-copy").addEventListener("click", (e) =>
  copyWithFeedback(e.currentTarget, $("#secret-base").textContent, "Copy base URL"),
);
$("#secret-example-copy").addEventListener("click", (e) =>
  copyWithFeedback(e.currentTarget, $("#secret-example").textContent, "Copy example request"),
);
// Don't leave the secret in the page once the dialog is gone.
function clearSecret() {
  $("#secret-key").textContent = "";
  $("#secret-example").textContent = "";
}
$("#secret-done").addEventListener("click", () => {
  clearSecret();
  $("#secret-dialog").close();
});
$("#secret-dialog").addEventListener("close", () => {
  clearSecret();
  focusKey(secretKey || "")();
  secretKey = null;
});
