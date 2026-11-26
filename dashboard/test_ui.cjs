const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");
const artifacts = path.join(__dirname, "artifacts");
const assert = require("assert/strict");
async function serveDashboardSource(page, url) {
  if (!process.env.DASHBOARD_SOURCE) return;
  await page.route("**/dashboard/assets/*", (route) =>
    route.fulfill({ path: path.join(__dirname, "assets", path.basename(new URL(route.request().url()).pathname)) }),
  );
  await page.route(
    new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(accounts(/[^?#]*)?|keys|tokens|machines|tincan|subscriptions|logs)?(#.*)?$`),
    (route) => route.fulfill({ contentType: "text/html", path: path.join(__dirname, "index.html") }),
  );
}

async function tokensChecks(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US", timezoneId: "America/Chicago", reducedMotion: "reduce" });
  try {
    const now = new Date("2026-11-21T18:00:00Z"), hour = now.getTime() / 1000;
    await page.clock.setFixedTime(now);
    const errors = [], queries = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await serveDashboardSource(page, url);
    const silo = { id: "silo:u1", name: "u1", nickname: "Cyclone One", provider: "antigravity", silo: true, windows: [], cooldowns: [] };
    await page.route("**/dashboard/api/session", (route) => route.fulfill({ json: { authenticated: true, tailnet: true } }));
    await page.route("**/dashboard/api/snapshot?*", (route) => route.fulfill({ json: { now: hour, accounts: [silo] } }));
    await page.route("**/dashboard/api/keys", (route) => route.fulfill({ json: { keys: [] } }));
    const bucket = (provider, account, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, daysAgo = 0, model = "") => ({
      hour: hour - daysAgo * 86400, provider, account, model, key_id: daysAgo ? "imported" : "shared",
      requests: 1, failed: 0, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    });
    const buckets = [
      bucket("openai-compatible-u1", "openai-compatibility:U1:aa", 100, 40, 20, 5, 0, "claude-opus-4-6"),
      bucket("openai-compatible-a1", "openai-compatibility:a1:bb", 20, 3, 4, 1),
      bucket("openai-compatible", "openai-compatibility:a1:cc", 10, 2, 3, 0),
      bucket("claude", "claude:apikey:7bb12de6ac91", 80, 10, 5, 4, 0, "claude-sonnet-4-6"),
      bucket("antigravity", "silo:u1", 200, 10, 50, 0, 40, "gemini-2.5-pro"),
    ];
    let usage = buckets;
    await page.route("**/dashboard/api/keys/usage*", (route) => {
      queries.push(new URL(route.request().url()).search);
      return route.fulfill({ json: { since: null, buckets: usage } });
    });
    await page.goto(new URL("tokens", url).href);
    const stat = (name) => page.locator(".tok-stat").filter({ has: page.getByText(name, { exact: true }) });
    const value = (name) => stat(name).locator("dd").innerText();
    assert.equal(await value("Input + output"), "238");
    assert.equal(await stat("Input + output").locator(".tok-stat-sub").innerText(), "183 input · 55 output");
    assert.equal(await value("Total tokens"), "280");
    assert.equal(await stat("Total tokens").locator(".tok-stat-sub").innerText(), "incl. 42 cache read/write");
    assert.equal(await value("All-time tokens"), "490");
    assert.deepEqual(
      await page.locator(".tok-hero .tok-stat dt").allTextContents(),
      ["Total tokens", "Input + output", "All-time tokens", "Cache hit", "Requests", "Top provider"],
    );
    assert.equal(await page.locator("#page-meta").innerText(), "All time: 490 tokens · 398 in + out · ~<$0.01 est. API");
    const range = page.getByRole("group", { name: "Time range" });
    for (const label of ["7d", "30d"]) {
      await range.getByRole("button", { name: label, exact: true }).click();
      assert.equal(await value("Total tokens"), "280");
    }
    const all = range.getByRole("button", { name: "All time", exact: true });
    await all.click();
    assert.equal(await all.getAttribute("aria-pressed"), "true");
    assert.equal(await value("Total tokens"), "490");
    assert.equal(await value("Input + output"), "398");
    assert.equal(await value("Daily average"), "12");
    assert.deepEqual(
      await page.locator(".tok-hero .tok-stat dt").allTextContents(),
      ["Total tokens", "Input + output", "Daily average", "Cache hit", "Requests", "Top provider"],
    );
    assert.match(await stat("Daily average").innerText(), /across 41 days/);
    assert.equal(await stat("All-time tokens").count(), 0);
    assert.deepEqual(queries, ["?all=1"], "Switching ranges reuses the loaded history");
    for (const chart of [page.locator("[data-tok-chart]:not([data-tok-daily])"), page.locator("[data-tok-daily]")]) {
      assert.match(await chart.locator("figcaption").innerText(), /Tokens per day/);
      assert.match(await chart.locator("figcaption").innerText(), /Antigravity 355/);
      await chart.press("Home");
      assert.match(await chart.locator(".chart-inspect").innerText(), /^Oct 12 · 210 tokens, 1 request, ~<\$0\.01 est\.$/);
      await chart.press("End");
      assert.match(await chart.locator(".chart-inspect").innerText(), /^Nov 21 · 280 tokens, 4 requests, ~<\$0\.01 est\.$/);
    }
    const titles = (part) => page.locator(`[data-tok-part="${part}"] .account-label`).allTextContents();
    assert.deepEqual((await titles("provider")).sort(), ["Antigravity", "Claude", "OpenAI-compatible"]);
    assert.deepEqual((await titles("account")).sort(), ["Claude API key · 7bb12d", "Cyclone One", "a1"]);
    assert.deepEqual((await titles("model")).sort(), ["Unknown model", "claude-opus-4-6", "claude-sonnet-4-6", "gemini-2.5-pro"]);
    const accounts = page.locator('[data-tok-part="account"] .tok-card');
    const compat = accounts.filter({ has: page.getByText("a1", { exact: true }) });
    assert.equal(await compat.locator(".account-sub").innerText(), "OpenAI-compatible");
    assert.equal(await compat.locator(".provider-icon use").getAttribute("href"), "#i-key");
    assert.deepEqual(await compat.locator("dd").allTextContents(), ["2", "23", "5", "7", "1"]);
    assert.match(await accounts.filter({ hasText: "Cyclone One" }).locator(".account-sub").innerText(), /Antigravity/);
    await page.getByRole("button", { name: "Type", exact: true }).click();
    assert.match(await stat("Top account").innerText(), /Cyclone One/);
    assert.doesNotMatch(await page.locator("#page-body").textContent(), /openai-compatibility:|openai-compatible-u1|claude:apikey:/i);
    // Switch to full API cost view and verify hero stats, charts, inspection, and cost breakdown cards.
    const metric = page.getByRole("group", { name: "Metric" });
    await metric.getByRole("button", { name: "API cost", exact: true }).click();
    assert.equal(await metric.getByRole("button", { name: "API cost", exact: true }).getAttribute("aria-pressed"), "true");
    assert.deepEqual(
      await page.locator(".tok-hero .tok-stat dt").allTextContents(),
      ["Estimated API cost", "Input + output", "Daily average", "Cache savings", "Cost / request", "Top account"],
    );
    assert.equal(await value("Estimated API cost"), "<$0.01");
    assert.match(await page.locator("#page-meta").innerText(), /^All time: ~<\$0\.01 est\. API/);
    for (const chart of [page.locator("[data-tok-chart]:not([data-tok-daily])"), page.locator("[data-tok-daily]")]) {
      assert.match(await chart.locator("figcaption").innerText(), /Estimated API cost per day/);
      await chart.press("End");
      assert.match(await chart.locator(".chart-inspect").innerText(), /^Nov 21 · <\$0\.01 est\., 4 requests$/);
    }
    const opusModel = page.locator('[data-tok-part="model"] .tok-card').filter({ has: page.getByText("claude-opus-4-6", { exact: true }) });
    assert.deepEqual(await opusModel.locator("dt").allTextContents(), ["Est. cost", "Input", "Output", "Cache read", "Cache write"]);
    assert.equal(await opusModel.locator("dd").first().innerText(), "<$0.01");
    await range.getByRole("button", { name: "24h", exact: true }).click();
    assert.deepEqual(
      await page.locator(".tok-hero .tok-stat dt").allTextContents(),
      ["Estimated API cost", "Input + output", "All-time API cost", "Cache savings", "Cost / request", "Top account"],
    );
    await metric.getByRole("button", { name: "Tokens", exact: true }).click();
    const columns = () => page.locator(".tok-hero").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    assert.equal(await columns(), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await columns(), 2);
    await page.goto(new URL("accounts/silo%3Au1", url).href);
    assert.equal(await value("All time"), "355");
    assert.equal(await value("Last 24 hours"), "145");
    assert.equal(await value("Last 7 days"), "145");
    assert.equal(await columns(), 1);
    usage = [buckets.at(-1)];
    await page.goto(new URL("tokens", url).href);
    assert.equal(await value("Total tokens"), "0");
    assert.equal(await value("All-time tokens"), "210");
    usage = [buckets[0]];
    await page.reload();
    assert.equal(await value("Total tokens"), "145");
    await all.click();
    assert.equal(await value("Daily average"), "145");
    assert.match(await stat("Daily average").innerText(), /across 1 day ·/);
    assert.match(await page.locator("[data-tok-chart]:not([data-tok-daily]) figcaption").innerText(), /Tokens per hour/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

// Keys page, against mocked /api/keys* routes: no real key is created or changed.
async function keysChecks(page, mock, until, url) {
  const now = Date.now() / 1000;
  const hour = Math.floor(now / 3600) * 3600;
  const keys = [
    { id: "ck_aaaaaaaaaaaa", name: "alice", hint: "abcd", enabled: true, providers: ["codex"], accounts: [],
      models: ["gpt-5*"], weekly_token_limit: 1000, weekly_tokens: 1200, created_at: null, updated_at: null },
    { id: "ck_bbbbbbbbbbbb", name: "ci-bot", hint: "wxyz", enabled: true, providers: [], accounts: [],
      models: [], weekly_token_limit: 0, weekly_tokens: 450, created_at: null, updated_at: null },
  ];
  const secret = "cpk_" + "f0".repeat(24);
  await page.route("**/dashboard/api/keys", (route) =>
    route.fulfill({ json: { keys, base_url: "https://box.tail.ts.net:8317" } }),
  );
  await page.route("**/dashboard/api/keys/options", (route) =>
    route.fulfill({ json: {
      providers: ["claude", "codex"],
      accounts: [{ id: "codex-a.json", provider: "codex", label: "a@example.com", disabled: false },
                 { id: "claude-b.json", provider: "claude", label: "b@example.com", disabled: true }],
      models: [{ id: "gpt-5", providers: ["codex"] }, { id: "claude-opus-5", providers: ["claude"] }],
    } }),
  );
  await page.route("**/dashboard/api/keys/usage*", (route) =>
    route.fulfill({ json: { since: now - 7 * 86400, buckets: [
      { key_id: "ck_bbbbbbbbbbbb", hour, provider: "codex", account: "codex-a.json", model: "gpt-5",
        requests: 2, failed: 0, input_tokens: 200, output_tokens: 100, cache_read_tokens: 0, tokens: 300 },
      { key_id: "ck_bbbbbbbbbbbb", hour: hour - 7200, provider: "claude", account: "claude-b.json", model: "claude-opus-5",
        requests: 1, failed: 1, input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, tokens: 150 },
    ] } }),
  );
  const created = await mock("**/dashboard/api/keys/create", { key: { ...keys[1], id: "ck_cccccccccccc", name: "new" }, secret });
  const updated = await mock("**/dashboard/api/keys/update", { key: { ...keys[1], enabled: false } });
  const rotated = await mock("**/dashboard/api/keys/rotate", { key: keys[1], secret });
  const deleted = await mock("**/dashboard/api/keys/delete", { status: "ok" });
  await page.locator('[data-page="keys"]').click();
  await page.waitForFunction(() => document.querySelector("#page-title").textContent.trim() === "Keys");
  assert.equal(new URL(page.url()).pathname, "/dashboard/keys");
  await page.locator(".key-row").nth(1).waitFor();
  assert.equal(await page.locator(".key-row").count(), 2);
  assert.match(await page.locator(".key-row").first().innerText(), /cpk_…abcd/);
  assert.equal(await page.locator(".key-row").nth(1).locator(".tag").innerText(), "Any");
  assert.equal(await page.locator(".key-row").first().locator(".meter.full").count(), 1, "Over the limit shows a full bar");
  // A reload keeps the page.
  await page.reload();
  await page.locator(".key-row").first().waitFor();

  // Create: chips, readable limit, then the secret is shown once.
  // On Keys the header's primary action is New key.
  await page.locator("#add-login").click();
  await page.locator("#key-dialog[open]").waitFor();
  await page.locator("#key-name").fill("new");
  const claudeAccount = page.locator(".reset-row", { hasText: "b@example.com" });
  assert.match(await page.locator("#key-accounts").innerText(), /Paused/);
  await claudeAccount.click();
  await page.locator(".chip-option", { hasText: "Codex" }).click();
  assert.equal(await claudeAccount.isVisible(), false);
  await page.locator(".reset-row", { hasText: "a@example.com" }).click();
  await page.locator("#key-model-input").fill("GPT-5*");
  await page.keyboard.press("Enter");
  await page.locator("#key-limit").fill("abc");
  assert.equal(await page.locator("#key-limit").getAttribute("aria-invalid"), "true");
  await page.locator("#key-limit").fill("5m");
  await page.locator("#key-limit").blur();
  assert.equal(await page.locator("#key-limit").inputValue(), "5M");
  assert.match(await page.locator("#key-limit-help").innerText(), /5,000,000/);
  await page.locator("#key-save").click();
  await page.locator("#key-error:not([hidden])").waitFor();
  assert.equal(created.length, 0, "Saving is blocked while hidden accounts remain selected");
  await page.locator("[data-key-clear-hidden]").click();
  await page.locator("#key-save").click();
  await page.locator("#secret-dialog[open]").waitFor();
  assert.deepEqual(created, [{ name: "new", providers: ["codex"], accounts: ["codex-a.json"], models: ["gpt-5*"], weekly_token_limit: 5000000 }]);
  assert.equal(await page.locator("#secret-key").innerText(), secret);
  assert.match(await page.locator("#secret-example").innerText(), /https:\/\/box\.tail\.ts\.net:8317\/v1\/chat\/completions/);
  assert.match(await page.locator("#secret-dialog").innerText(), /won’t see this key again/);
  await page.locator("#secret-done").click();
  await page.locator("#secret-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#secret-key").textContent(), "", "The secret leaves the page with its dialog");

  // The switch disables a key.
  await page.locator('[data-key-enabled="ck_bbbbbbbbbbbb"]').click();
  await until(() => updated.length);
  assert.deepEqual(updated, [{ id: "ck_bbbbbbbbbbbb", enabled: false }]);

  // Usage: chart with keyboard inspection, and breakdowns by model and account.
  await page.locator('[data-key-open="ck_bbbbbbbbbbbb"]').click();
  await page.locator("[data-key-chart]").waitFor();
  await page.locator("[data-key-chart]").focus();
  await page.keyboard.press("End");
  assert.match(await page.locator("[data-key-chart] .chart-inspect").innerText(), /300 tokens, 2 requests/);
  const breakdowns = await page.locator(".key-breakdowns").innerText();
  assert.match(breakdowns, /gpt-5[\s\S]*300[\s\S]*2 req/);
  assert.match(breakdowns, /b@example\.com[\s\S]*150[\s\S]*1 req · 1 failed/);
  await page.locator('[data-key-unit="day"]').click();
  assert.equal(await page.locator('[data-key-unit="day"]').getAttribute("aria-pressed"), "true");

  // Rotate and delete confirm first; Cancel sends nothing and returns focus.
  await page.locator("[data-key-rotate]").click();
  await page.locator("#confirm-dialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#confirm-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute("data-key-rotate")), true);
  assert.deepEqual(rotated, []);
  await page.locator("[data-key-rotate]").click();
  await page.locator("#confirm-remove").click();
  await page.locator("#secret-dialog[open]").waitFor();
  assert.deepEqual(rotated, [{ id: "ck_bbbbbbbbbbbb" }]);
  await page.locator("#secret-done").click();
  await page.locator("[data-key-delete]").click();
  await page.locator("#confirm-dialog[open]").waitFor();
  assert.equal(await page.locator("#confirm-remove").innerText(), "Delete key");
  await page.locator("#confirm-remove").click();
  await until(() => deleted.length);
  assert.deepEqual(deleted, [{ id: "ck_bbbbbbbbbbbb" }]);

  // Phone width: no sideways scroll.
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize(size);
  await page.unroute("**/dashboard/api/keys");
  await page.unroute("**/dashboard/api/keys/options");
  await page.unroute("**/dashboard/api/keys/usage*");
  for (const route of ["create", "update", "rotate", "delete"]) await page.unroute(`**/dashboard/api/keys/${route}`);
}
async function groupCapChecks(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
  try {
    const now = 1795477520, reset = now + 7200;
    const capLabel = "Capped by Silo until 2026-11-23 19:45";
    const expectedTime = new Date(reset * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const expectedCapStatus = `Capped until ${expectedTime} · 5-hour limit at 88% (85% cap)`;
    const groupCaps = [
      { group: "Gemini", cap_percent: 90, usage_percent: 0, capped: false, capped_until: null, cap_label: null, owner: null },
      { group: "Claude & GPT", cap_percent: 85, usage_percent: 88, capped: true, capped_until: reset, cap_label: capLabel, owner: null },
      { group: "Other models", cap_percent: 100, usage_percent: 20, capped: false, capped_until: null, cap_label: null, owner: null },
    ];
    const windows = groupCaps.map((g, i) => ({
      id: `group_${i}:5h`, label: `${g.group} · 5-hour limit`, group: g.group,
      period: 18000, reset_at: reset, remaining: 100 - g.usage_percent,
    }));
    const account = {
      id: "silo:u1", name: "u1", provider: "antigravity", silo: true,
      cap_percent: 90, capped: false, disabled: false, group_caps: groupCaps,
      quota_at: now, cooldowns: [], windows,
    };
    const peer = {
      id: "a2", name: "a2", provider: "antigravity", quota_at: now, cooldowns: [],
      windows: windows.map((w) => ({ ...w, remaining: 70 })),
    };
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await serveDashboardSource(page, url);
    await page.route("**/dashboard/api/session", (route) => route.fulfill({ json: { authenticated: true, tailnet: true } }));
    await page.route("**/dashboard/api/snapshot?*", (route) => route.fulfill({ json: { now, accounts: [account, peer], history: [] } }));
    await page.route("**/dashboard/api/keys", (route) => route.fulfill({ json: { keys: [] } }));
    await page.route("**/dashboard/api/keys/usage*", (route) => route.fulfill({ json: { buckets: [] } }));
    const caps = [];
    await page.route("**/dashboard/api/account/cap", (route) => {
      const body = route.request().postDataJSON();
      caps.push({ method: route.request().method(), body });
      const group = groupCaps.find((g) => g.group === body.group);
      if (group) group.cap_percent = body.cap_percent;
      return route.fulfill({ json: { group: body.group, cap_percent: body.cap_percent } });
    });

    await page.goto(url);
    const pool = page.locator('[data-pool="antigravity"]');
    const tab = (name) => pool.getByRole("group", { name: "Model group for Antigravity" })
      .getByRole("button", { name, exact: true });
    const pooledStatus = pool.locator(".pool-sum .account-pool-head .tag");
    const cardStatus = pool.locator('[data-account="silo:u1"] .head-tags .tag');
    await tab("Gemini").click();
    await pool.locator(".pool-accounts > summary").click();
    assert.equal(await cardStatus.innerText(), "Quota available");
    assert.equal(await pooledStatus.innerText(), "2 of 2 available");
    await tab("Claude & GPT").click();
    assert.equal(await cardStatus.innerText(), "Capped");
    assert.equal(await cardStatus.getAttribute("title"), expectedCapStatus);
    assert.equal(await pooledStatus.innerText(), "1 of 2 available");
    await pool.locator(".pool-accounts > summary").click();
    const rowStatus = pool.locator('[data-row="silo:u1"] .acct-reset .tag');
    assert.equal(await rowStatus.innerText(), "Capped");
    assert.equal(await rowStatus.getAttribute("title"), expectedCapStatus);
    await tab("Other models").click();
    assert.equal(await pooledStatus.innerText(), "2 of 2 available");

    await page.locator('[data-page="accounts"]').click();
    const row = page.locator('.account-row[data-account="silo:u1"]');
    const reason = `Claude & GPT: ${expectedCapStatus}`;
    const summary = "Gemini 90% · Claude & GPT 85% · Other models 100%";
    assert.equal(await row.locator(".account-status .tag").innerText(), "Partial cap");
    assert.equal(await row.locator(".account-reason").innerText(), reason);
    assert.match(await row.locator(".account-sub").innerText(), new RegExp(summary));
    assert.match(await row.locator(".cyclone-badge").getAttribute("title"), new RegExp(summary));
    await row.getByRole("link", { name: "u1" }).click();
    assert.equal(decodeURIComponent(new URL(page.url()).pathname), "/dashboard/accounts/silo:u1");
    assert.equal(await page.locator(".detail-head .tag").innerText(), "Partial cap");
    assert.equal(await page.locator(".detail-head .tag").getAttribute("title"), reason);
    assert.equal(await page.getByText("Usage caps", { exact: true }).count(), 1);
    assert.equal(await page.locator(".metric", { has: page.getByText("Cap status", { exact: true }) }).locator("dd").innerText(), reason);
    const selectors = page.locator(".cap-group-row");
    assert.equal(await selectors.count(), 3);
    const activeCaps = selectors.locator("[data-cap-group].active");
    assert.deepEqual(await activeCaps.allTextContents(), ["90%", "85%", "100%"]);
    assert.equal(await selectors.nth(1).locator(".tag").innerText(), "Capped");
    assert.equal(await selectors.nth(1).locator(".tag").getAttribute("title"), expectedCapStatus);
    const detailCaps = page.locator(".detail-win:has(.detail-win-reset .tag)");
    assert.equal(await detailCaps.count(), 1);
    assert.match(await detailCaps.locator(".detail-win-name").innerText(), /Claude & GPT/);

    await selectors.getByRole("button", { name: "95%" }).and(page.locator('[data-cap-group="Gemini"]')).click();
    await activeCaps.first().filter({ hasText: "95%" }).waitFor();
    assert.deepEqual(caps, [{ method: "POST", body: { id: "silo:u1", group: "Gemini", cap_percent: 95 } }]);
    assert.deepEqual(await activeCaps.allTextContents(), ["95%", "85%", "100%"]);
    assert.equal(await page.evaluate(() => dashboard.state.data.accounts[0].cap_percent), 90);
    assert.equal(await page.getByText("u1 (Gemini) will pause at 95%.", { exact: true }).isVisible(), true);

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
    args: ["--no-sandbox"],
  });
  const url = process.env.DASHBOARD_URL || "http://localhost:8318/dashboard/";
  const only = process.env.DASHBOARD_ONLY;
  if (!only || only === "group-caps") await groupCapChecks(browser, url);
  if (only === "group-caps") {
    console.log(JSON.stringify({ passed: true, checks: ["Silo quota group caps (mocked)"] }));
    await browser.close();
    return;
  }
  if (only !== "keys") await tokensChecks(browser, url);
  if (only === "tokens") {
    console.log(JSON.stringify({ passed: true, checks: ["tokens and account usage (mocked)"] }));
    await browser.close();
    return;
  }
  fs.mkdirSync(artifacts, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Registered first, so every specific mock below takes precedence. Anything
  // that falls through here would have changed a real account or the proxy config.
  const escaped = [];
  const guard = (route) => {
    if (route.request().method() === "GET") return route.fallback();
    escaped.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  };
  await page.route("**/dashboard/api/account/**", guard);
  await page.route("**/dashboard/api/logs/activity/enable", guard);
  await page.route("**/dashboard/api/keys/**", guard);
  const until = async (check) => {
    for (let i = 0; i < 60 && !check(); i++) await page.waitForTimeout(50);
  };
  // Record a mutating endpoint's JSON bodies and answer with a fixture.
  const mock = async (pattern, json) => {
    const bodies = [];
    await page.route(pattern, (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json });
    });
    return bodies;
  };
  await serveDashboardSource(page, url);
  // Over the tailnet the dashboard may sign this browser in by its Tailscale login. Report
  // only key sessions here so the key sign-in flow is still exercised (tailnet is checked below).
  await page.route("**/dashboard/api/session", (route) =>
    route.fulfill({
      json: {
        authenticated: (route.request().headers().cookie || "").includes("prox_session="),
        tailnet: false,
      },
    }),
  );
  await page.goto(url);
  await page
    .getByLabel("Management key", { exact: true })
    .fill(
      JSON.parse(
        fs.readFileSync(
          process.env.DASHBOARD_KEY_FILE ||
            path.join(os.homedir(), "cliproxyapi", "credentials.json"),
        ),
      ).management_key,
    );
  await page
    .getByRole("button", { name: "Open dashboard", exact: true })
    .click();
  // DASHBOARD_ONLY=keys runs just the Keys checks (e.g. against a test proxy with no quota accounts).
  if (process.env.DASHBOARD_ONLY === "keys") {
    await page.locator("#app:not([hidden])").waitFor();
    await keysChecks(page, mock, until, url);
    assert.deepEqual(escaped, [], "No real key mutation escaped");
    assert.deepEqual(errors, [], "No page errors");
    console.log(JSON.stringify({ passed: true, checks: ["keys (mocked)"] }));
    await browser.close();
    return;
  }
  await page.locator('[data-pool="codex"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Quota cards: one per provider with a quota reader that has accounts.
  const expectedPools = await page.evaluate(
    () =>
      new Set(
        dashboard.state.data.accounts
          .map((a) => a.provider)
          .filter((p) => ["codex", "claude", "antigravity", "devin", "xai"].includes(p)),
      ).size,
  );
  assert.equal(await page.locator('[data-pool]:not([data-pool="all"])').count(), expectedPools);
  // Providers with 2+ accounts show their total, with one compact row per account;
  // the per-account charts start collapsed.
  assert.equal(await page.locator("[data-pool] details[open]").count(), 0);
  assert.equal(
    await page.locator('[data-pool="codex"] .account-pool').first().isVisible(),
    true,
  );
  assert.equal(await page.locator('[data-pool="codex"] .acct-row').first().isVisible(), true);
  // Reset icons never overlap each other or "Now" (2D box check for staggered lanes). Icon
  // boxes come from their placement: some brand marks draw masked art past their viewBox.
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll(".plot svg")].flatMap((svg) => {
        const boxes = [
          ...[...svg.querySelectorAll(".reset-label use")].map((u) => ({
            x: +u.getAttribute("x"), y: +u.getAttribute("y"),
            width: +u.getAttribute("width"), height: +u.getAttribute("height"),
          })),
          ...[...svg.querySelectorAll(".axis-now")].map((t) => t.getBBox()),
        ];
        return boxes.flatMap((a, i) =>
          boxes
            .slice(i + 1)
            .filter(
              (b) =>
                a.x < b.x + b.width &&
                b.x < a.x + a.width &&
                a.y < b.y + b.height &&
                b.y < a.y + a.height,
            )
            .map(() => i),
        );
      }),
    ),
    [],
    "reset labels overlap",
  );
  // Reset markers are provider icons; hovering near one snaps onto it, colors the line,
  // and the tooltip names the account and when it resets.
  const snapped = await page.evaluate(() => {
    const fig = [...document.querySelectorAll(".plot[data-chart]")].find(
      (f) => f.offsetParent && state.charts[f.dataset.chart]?.resets.length,
    );
    if (!fig) return null;
    fig.scrollIntoView({ block: "center" });
    const chart = state.charts[fig.dataset.chart],
      reset = chart.resets[0],
      svg = fig.querySelector("svg"),
      rect = svg.getBoundingClientRect();
    return {
      key: fig.dataset.chart,
      icons: fig.querySelectorAll(".reset-label use[href^='#brand-']").length,
      x: rect.left + ((reset.lineX + 1) / chart.W) * rect.width,
      y: rect.top + rect.height / 2,
      names: reset.items.map((r) => r.name),
      times: reset.items.map((r) =>
        new Date(r.ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
      ),
      lineX: reset.lineX,
      // The marker's color resolved to rgb: one provider's color, or neutral when mixed.
      color: (() => {
        const probe = document.createElementNS("http://www.w3.org/2000/svg", "line");
        probe.style.stroke = reset.color;
        svg.append(probe);
        const c = getComputedStyle(probe).stroke;
        probe.remove();
        return c;
      })(),
    };
  });
  if (snapped) {
    assert.ok(snapped.icons > 0, "reset markers show provider icons");
    await page.mouse.move(snapped.x, snapped.y);
    await page.waitForTimeout(100);
    const fig = page.locator(`[data-chart="${snapped.key}"]`);
    assert.equal(await fig.locator(".chart-reset.active").count(), 1);
    const tip = await fig.locator(".chart-tooltip .tip-reset").allTextContents();
    snapped.names.forEach((n, i) => {
      assert.ok(tip[i].includes(`${n} resets`), `row ${i} names ${n}: ${tip[i]}`);
      assert.ok(tip[i].includes(snapped.times[i]), `row ${i} shows its own time ${snapped.times[i]}: ${tip[i]}`);
    });
    // The crosshair sits on the reset line and takes its color.
    const cross = await fig.evaluate((f) => {
      const line = f.querySelector(".chart-crosshair line");
      return {
        // Inline target, not computed: the glide transition may still be running.
        x: parseFloat(line.style.transform.slice("translateX(".length)),
        stroke: getComputedStyle(line).stroke,
        resetStroke: getComputedStyle(f.querySelector(".chart-reset.active")).stroke,
      };
    });
    assert.ok(Math.abs(cross.x - snapped.lineX) < 0.5, `crosshair at ${cross.x}, reset line at ${snapped.lineX}`);
    assert.equal(cross.stroke, snapped.color);
    assert.equal(cross.resetStroke, snapped.color);
    await page.mouse.move(0, 0);
  }
  const quotaBadges = await page.evaluate(() => {
    const a = { ...state.data.accounts.find((a) => a.provider === "codex"),
      disabled: false, requires_sign_in: false, unavailable: true, quota_error: null,
      cooldowns: [{ reason: "credential_quota" }], quota_at: state.data.now,
      windows: [{ id: "short", label: "5-hour limit", remaining: 100 },
                { id: "long", label: "Weekly limit", remaining: 0 }] };
    return a.windows.map((w) => {
      const row = document.createElement("div");
      row.innerHTML = accountQuota("codex", a, 0, w.id, a.windows);
      return row.querySelector(".tag").textContent;
    }).concat(status(a)[0], statusReason(a));
  });
  // A cooldown caused by another window's limit means this window's quota can't be used either.
  assert.deepEqual(quotaBadges, ["Cooling down", "Limit reached", "Cooling down", "Weekly limit exhausted."]);
  const counts = await page.evaluate(() => ({
    accounts: dashboard.state.data.accounts.length,
    measured: dashboard.state.data.accounts.filter((a) => a.windows.length)
      .length,
    windows: dashboard.state.data.accounts.reduce(
      (n, a) => n + a.windows.length,
      0,
    ),
  }));
  // The provider tabs already count accounts; the header line stays empty.
  assert.equal(await page.locator("#page-meta").textContent(), "");
  assert.equal(
    await page.evaluate(() => document.cookie.includes("prox_session")),
    false,
  );
  assert.equal(
    await page.evaluate(() => document.fonts.check("14px Geist")),
    true,
  );
  // A tab group must hold all of its tabs, or the active one spills out.
  const assertTabsFit = async (where) =>
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll(".segmented")]
          .filter((g) => g.offsetWidth && g.scrollWidth > g.clientWidth)
          .map((g) => g.getAttribute("aria-label")),
      ),
      [],
      `tab groups overflow at ${where}`,
    );
  await assertTabsFit("first load");
  await page.screenshot({
    path: path.join(artifacts, "dashboard-desktop.png"),
    fullPage: true,
  });
  const chart = page.locator('[data-pool="codex"] [data-chart]').first();
  // The first render after login can land between the keypress and the check,
  // so wait for loading to settle and give the keypress a few tries.
  await page.waitForFunction(() => !dashboard.state.loadBusy);
  let tooltipShown = false;
  for (let i = 0; i < 3 && !tooltipShown; i++) {
    await chart.focus();
    await page.keyboard.press("ArrowLeft");
    tooltipShown = await chart
      .locator(".chart-tooltip")
      .waitFor({ state: "visible", timeout: 1000 })
      .then(() => true, () => false);
  }
  assert.equal(tooltipShown, true, "Arrow keys inspect the chart");
  await page.locator("#page-title").click();
  await page.locator('[data-filter="antigravity"]').click();
  assert.equal(await page.locator("[data-pool]").count(), 1);
  // Antigravity limits are shared per model group: one tab set picks the
  // group, a second picks the window, and the choice survives a reload.
  const agy = page.locator('[data-pool="antigravity"]');
  await agy.locator('.pool-windows[aria-label^="Model group"] > button').nth(1).click();
  await agy.locator('.pool-windows[aria-label^="Quota window"] > button').nth(1).click();
  const chosenWindow = await agy
    .locator('.pool-windows[aria-label^="Quota window"] > .active')
    .getAttribute("data-window-id");
  await page.locator("#forecast").selectOption("off");
  await page.reload();
  await page.locator("[data-pool]").first().waitFor();
  assert.equal(
    await page.locator("[data-pool]").count(),
    1,
    "Provider filter persists",
  );
  assert.equal(
    await agy
      .locator('.pool-windows[aria-label^="Quota window"] > .active')
      .getAttribute("data-window-id"),
    chosenWindow,
  );
  assert.equal(
    await agy
      .locator('.pool-windows[aria-label^="Model group"] > .active')
      .getAttribute("data-window-group"),
    await page.evaluate(
      (id) =>
        dashboard.state.data.accounts
          .flatMap((a) => a.windows)
          .find((w) => w.id === id).group,
      chosenWindow,
    ),
  );
  assert.equal(await page.locator("#forecast").inputValue(), "off");
  await page.locator("#forecast").selectOption("on");
  await page.locator('[data-filter="all"]').click();
  // One quota window shows a label, a few show tabs, many keep a select,
  // and grouped windows get a group tab set plus a window tab set.
  assert.equal(
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-pool]:not([data-pool="all"])')].every((pool) => {
        const windows = dashboard.state.data.accounts
          .filter((a) => a.provider === pool.dataset.pool)
          .flatMap((a) => a.windows);
        const n = new Set(windows.map((w) => w.id)).size,
          groups = new Set(windows.map((w) => w.group).filter(Boolean)).size;
        if (groups > 1)
          return (
            pool.querySelectorAll('[aria-label^="Model group"] > button')
              .length === groups &&
            // The window tabs list the selected group's windows (groups can differ).
            pool.querySelectorAll('[aria-label^="Quota window"] > button').length ===
              new Set(
                windows
                  .filter((w) => w.group === pool.querySelector('[aria-label^="Model group"] > .active')?.dataset.windowGroup)
                  .map((w) => w.id),
              ).size
          );
        return n > 4
          ? !!pool.querySelector("select[data-window]")
          : n > 1
            ? pool.querySelectorAll(".pool-windows > button").length === n
            : !!pool.querySelector(".pool-window");
      }),
    ),
    true,
  );
  const tabbedPool = await page.evaluate(
    () =>
      document
        .querySelector(".pool-top > .pool-windows")
        ?.closest("[data-pool]").dataset.pool,
  );
  if (tabbedPool) {
    const tabs = page.locator(`[data-pool="${tabbedPool}"] .pool-windows > button`);
    const second = await tabs.nth(1).getAttribute("data-window-id");
    await tabs.nth(1).click();
    assert.equal(await tabs.nth(1).getAttribute("aria-pressed"), "true");
    assert.equal(await tabs.nth(0).getAttribute("tabindex"), "-1");
    await page.reload();
    await page.locator("[data-pool]").first().waitFor();
    assert.equal(
      await page
        .locator(`[data-pool="${tabbedPool}"] .pool-windows > .active`)
        .getAttribute("data-window-id"),
      second,
      "Window tab persists across a reload",
    );
    // Arrow keys move between window tabs like every other tab group.
    await tabs.nth(1).focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await tabs.nth(0).getAttribute("aria-pressed"), "true");
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.windowId),
      await tabs.nth(0).getAttribute("data-window-id"),
    );
  } else console.log("skip: no provider with 2–4 quota windows");
  await page.locator('[data-burn="1"]').click();
  assert.equal(
    await page.locator('[data-burn="1"]').getAttribute("aria-pressed"),
    "true",
  );
  await page.locator('[data-view="drain"]').click();
  assert.equal(await page.locator(".pool .rate-card").count(), 0);
  assert.ok(await page.locator('[data-chart$="-drain"]').count());
  assert.match(await page.locator('[data-chart$="-drain"] svg').first().textContent(), /\/h/);
  await page.locator('[data-view="remaining"]').click();

  // Roving focus: one tab stop per group, arrows move and activate.
  await page.locator("#add-login").focus();
  await page.keyboard.press("Tab");
  const tabStop = await page.evaluate(() => {
    const group = document.querySelector(".provider-tabs");
    const buttons = [...group.querySelectorAll("button[data-filter]")];
    const scroller = getComputedStyle(group);
    const clipped =
      scroller.overflowX !== "visible" || scroller.overflowY !== "visible";
    return {
      focused: document.activeElement.dataset.filter,
      active: group.querySelector("button.active").dataset.filter,
      others: buttons
        .filter((b) => !b.classList.contains("active"))
        .map((b) => b.getAttribute("tabindex")),
      ring: getComputedStyle(document.activeElement).boxShadow,
      padded:
        !clipped ||
        ["Top", "Right", "Bottom", "Left"].every(
          (side) => parseFloat(scroller["padding" + side]) >= 3,
        ),
    };
  });
  assert.equal(tabStop.focused, tabStop.active);
  assert.ok(tabStop.others.length && tabStop.others.every((t) => t === "-1"));
  assert.ok(tabStop.ring && tabStop.ring !== "none", "Focus ring is visible");
  assert.ok(tabStop.padded, "Provider tab focus ring is not clipped");
  await page.keyboard.press("Tab");
  assert.equal(
    // The Reorder button shares the tab strip but is not one of the filter tabs.
    await page.evaluate(() => document.activeElement.closest(".provider-tabs") &&
      !document.activeElement.hasAttribute("data-reorder")),
    false,
    "Tab leaves the provider filter tabs after one stop",
  );
  const arrowCheck = async (selector, attr, key, expected) => {
    await page.keyboard.press(key);
    const result = await page.evaluate(
      ([selector, attr]) => {
        const focused = document.activeElement;
        return {
          focused: focused.getAttribute(attr),
          pressed: focused.getAttribute("aria-pressed"),
          active: focused.classList.contains("active"),
          tabindex: focused.getAttribute("tabindex"),
          inGroup: !!focused.closest(selector),
        };
      },
      [selector, attr],
    );
    assert.deepEqual(
      result,
      {
        focused: expected,
        pressed: "true",
        active: true,
        tabindex: "0",
        inGroup: true,
      },
      `${key} in ${selector}`,
    );
  };
  await page.locator(".provider-tabs button.active").focus();
  // Tabs follow the providers that have accounts, in picker order.
  const tabOrder = await page
    .locator(".provider-tabs > button[data-filter]")
    .evaluateAll((bs) => bs.map((b) => b.dataset.filter));
  await arrowCheck(".provider-tabs", "data-filter", "ArrowRight", tabOrder[1]);
  assert.equal(await page.locator("[data-pool]").count(), 1);
  await arrowCheck(".provider-tabs", "data-filter", "End", tabOrder.at(-1));
  await arrowCheck(".provider-tabs", "data-filter", "Home", "all");
  assert.equal(await page.locator('[data-pool]:not([data-pool="all"])').count(), expectedPools);
  const burnGroup = ".segmented:has([data-burn])";
  await page.locator(`${burnGroup} button.active`).focus();
  assert.ok(
    (
      await page
        .locator(`${burnGroup} button:not(.active)`)
        .evaluateAll((bs) => bs.map((b) => b.getAttribute("tabindex")))
    ).every((t) => t === "-1"),
  );
  await arrowCheck(burnGroup, "data-burn", "Home", "1");
  await arrowCheck(burnGroup, "data-burn", "ArrowRight", "3");
  await arrowCheck(burnGroup, "data-burn", "End", "6");
  await arrowCheck(burnGroup, "data-burn", "ArrowLeft", "3");

  await page.locator('[data-page="accounts"]').click();
  await page.locator(".account-row").first().waitFor();
  assert.equal(await page.locator(".account-row").count(), counts.accounts);
  assert.equal(await page.locator("#toggle-emails").count(), 0);
  const labels = await page.evaluate(() => {
    const names = { codex: "Codex", antigravity: "Antigravity" };
    return {
      expected: dashboard.state.data.accounts.map(
        (a, i) => a.email || `${names[a.provider]} account ${i + 1}`,
      ),
      shown: [...document.querySelectorAll(".account-row .account-label")].map(
        (el) => el.textContent.trim(),
      ),
    };
  });
  assert.deepEqual(labels.shown, labels.expected, "Emails shown by default");
  await page.locator("#add-login").click();
  assert.equal(
    await page.locator("#oauth-dialog").evaluate((d) => d.open),
    true,
  );
  const footerAlignment = await page.evaluate(() => {
    const footer = document.querySelector("#oauth-choose .dialog-footer");
    const last = [...footer.querySelectorAll("button")].at(-1);
    return Math.abs(
      footer.getBoundingClientRect().right - last.getBoundingClientRect().right,
    );
  });
  assert.ok(footerAlignment <= 1, "Dialog footer actions align right");
  await page.locator("#oauth-choose [data-dialog-cancel]").click();
  assert.equal(
    await page.locator("#oauth-dialog").evaluate((d) => d.open),
    false,
  );
  await page.locator("#add-login").click();
  await page.locator("#oauth-close").click();
  // Add login lists every CLIProxyAPI sign-in as radio cards.
  await page.locator("#add-login").click();
  assert.equal(await page.locator(".provider-option").count(), 8);
  await page.locator('.provider-option:has(input[value="xai"])').click();
  assert.equal(
    await page.locator("#oauth-providers input:checked").inputValue(),
    "xai",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#oauth-providers input:checked").inputValue(),
    "kimi",
  );
  await page.locator("#oauth-choose [data-dialog-cancel]").click();
  await page.waitForFunction(
    () => !document.querySelector("#oauth-dialog").open,
  );
  // Toasts are rich-colored and their text is not selectable.
  await page.evaluate(() => notify("Test", "success"));
  assert.equal(
    await page
      .locator('[data-sonner-toast][data-type="success"]')
      .evaluate((el) => getComputedStyle(el).userSelect),
    "none",
  );
  // Account row menu: keyboard open, arrow focus, Escape returns focus.
  await page.locator('[data-page="accounts"]').click();
  await page.locator(".account-row").first().waitFor();
  const accountIds = await page.evaluate(() =>
    dashboard.state.data.accounts.map((a) => a.id),
  );
  const rowMenu = (i) =>
    page.locator(".account-row").nth(i).locator('[aria-haspopup="menu"]');
  const menu = page.locator('[role="menu"]');
  const menuItem = (name) =>
    menu.locator('[role="menuitem"]').filter({ hasText: name });
  await rowMenu(0).focus();
  await page.keyboard.press("Enter");
  await menu.waitFor();
  for (const name of ["Sign in again", "Reset cooldown", "Remove account"])
    assert.equal(await menuItem(name).count(), 1, `Menu has ${name}`);
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute("role")),
    "menuitem",
    "Arrow keys move focus into the menu",
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(
    await rowMenu(0).evaluate((b) => document.activeElement === b),
    true,
    "Escape returns focus to the menu trigger",
  );

  // Reset cooldown is offered for a cooling-down account and posts its id.
  const cooldownBodies = await mock("**/dashboard/api/account/cooldown", {
    status: "ok",
  });
  await page.evaluate(() => {
    // Browser-only fixture; the next snapshot restores the real state.
    const a = dashboard.state.data.accounts[0];
    a.unavailable = true;
    a.cooldowns = [{ reason: "quota", model_key: "test" }];
    a.cooldown_until = Date.now() / 1000 + 600;
    dashboard.render();
  });
  await rowMenu(0).click();
  await menuItem("Reset cooldown").click();
  await until(() => cooldownBodies.length);
  assert.deepEqual(cooldownBodies, [{ id: accountIds[0] }]);

  // Manual resets: confirm first; Claude picks a grant and retries an unknown
  // outcome with the same request. The endpoint is mocked; nothing is spent.
  const resetBodies = [];
  let resetReplies = [];
  await page.route("**/dashboard/api/account/reset", (route) => {
    resetBodies.push(route.request().postDataJSON());
    const [status, json] = resetReplies.shift() || [200, { status: "ok" }];
    return route.fulfill({ status, json });
  });
  // Fixtures ride on every snapshot, so a background refresh can't undo them.
  let resetFixtures = {};
  const stateRoute = async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.accounts.forEach((a) => {
      a.resets = resetFixtures[a.provider] ?? null;
    });
    return route.fulfill({ response, json });
  };
  await page.route("**/dashboard/api/snapshot**", stateRoute);
  const resetFixture = async (provider, resets) => {
    resetFixtures = { [provider]: resets };
    await page.evaluate(() => load());
    await page.waitForFunction(
      ([provider, n]) =>
        !dashboard.state.loadBusy &&
        dashboard.state.data.accounts
          .filter((a) => a.provider === provider)
          .every((a) => a.resets?.available === n),
      [provider, resets.available],
    );
    return page.evaluate(
      (provider) =>
        dashboard.state.data.accounts.find((a) => a.provider === provider)
          ?.id ?? null,
      provider,
    );
  };
  const resetMenu = async (id) => {
    await page.locator(`.account-row[data-account="${id}"] [aria-haspopup="menu"]`).click();
    await menu.waitFor();
  };
  const codexId = await resetFixture("codex", {
    available: 2,
    items: [
      { id: "c1", label: "Full reset", left: 1, total: 1, expires_at: 1796000000, reason: null },
      { id: "c2", label: "Full reset", left: 1, total: 1, expires_at: 1797000000, reason: null },
    ],
  });
  if (codexId) {
    // The earlier credit was spent outside the dashboard after the snapshot.
    await mock("**/dashboard/api/account/reset-options", {
      available: 1, items: [resetFixtures.codex.items[1]],
    });
    assert.match(
      await page.locator(`.account-row[data-account="${codexId}"] .reset-count`).textContent(),
      /2 resets/,
    );
    await resetMenu(codexId);
    await menuItem("Use a reset").click();
    await page.locator("#reset-dialog[open]").waitFor();
    await page.locator('#reset-list input[value="c2"]').waitFor();
    assert.equal(await page.locator('#reset-list input[name="reset-grant"]').count(), 1);
    assert.equal(await page.locator('#reset-list input[value="c2"]').isChecked(), true);
    await page.locator("#reset-cancel").click();
    assert.equal(resetBodies.length, 0, "Cancel spends nothing");
    await resetMenu(codexId);
    await menuItem("Use a reset").click();
    await page.locator('#reset-list label:has(input[value="c2"])').click();
    await page.locator("#reset-confirm").click();
    await page.waitForFunction(() => !document.querySelector("#reset-dialog").open);
    assert.deepEqual(resetBodies.splice(0), [{ id: codexId, grant: "c2" }]);
    await page.locator('[data-sonner-toast][data-type="success"]', { hasText: "Reset used" }).first().waitFor();
  }
  const claudeId = await resetFixture("claude", {
    available: 2,
    items: [
      { id: "g1", label: "Fable launch reset", left: 1, total: 1, expires_at: 1796000000, reason: "No usage to give back yet" },
      { id: "g2", label: "One full limit reset", left: 1, total: 1, expires_at: 1797000000, reason: null },
    ],
  });
  if (claudeId) {
    await resetMenu(claudeId);
    await menuItem("Use a reset").click();
    await page.locator("#reset-dialog[open]").waitFor();
    assert.equal(await page.locator('#reset-list input[value="g1"]').isDisabled(), true);
    assert.equal(await page.locator('#reset-list input[value="g2"]').isChecked(), true);
    resetReplies = [[409, { error: "The outcome is unknown and a reset may have been spent." }]];
    await page.locator("#reset-confirm").click();
    await page.locator("#reset-error:not([hidden])").waitFor();
    assert.equal((await page.locator("#reset-confirm").textContent()).trim(), "Retry same request");
    await page.locator("#reset-confirm").click();
    await page.waitForFunction(() => !document.querySelector("#reset-dialog").open);
    assert.deepEqual(resetBodies.splice(0), [
      { id: claudeId, grant: "g2" },
      { id: claudeId, grant: "g2" },
    ]);
  }
  // Accounts without resets don't offer the action.
  resetFixtures = {};
  await page.evaluate(() => load());
  await page.waitForFunction(
    () =>
      !dashboard.state.loadBusy &&
      dashboard.state.data.accounts.every((a) => !a.resets),
  );
  await rowMenu(0).click();
  assert.equal(await menuItem("Use a reset").isHidden(), true);
  await page.keyboard.press("Escape");
  await page.unroute("**/dashboard/api/snapshot**", stateRoute);
  await page.evaluate(() => load());
  // Let the success toasts finish before later checks measure motion.
  await page.waitForFunction(
    () => !document.querySelector("[data-sonner-toast]"),
    null,
    { timeout: 20000 },
  );

  // Sign in again opens the OAuth dialog directly in its flow step.
  const reloginUrl = "https://auth.example.test/authorize?state=test-state";
  const reloginBodies = await mock("**/dashboard/api/account/relogin", {
    url: reloginUrl,
    state: "test-state",
  });
  await mock("**/dashboard/api/oauth/status", { status: "wait" });
  await mock("**/dashboard/api/oauth/cancel", { status: "ok" });
  await rowMenu(0).click();
  await menuItem("Sign in again").click();
  await page.locator("#oauth-flow:not([hidden])").waitFor();
  // The link step shows "Preparing sign-in link…" until the URL arrives.
  await page.waitForFunction(
    (url) => document.querySelector("#oauth-link")?.textContent === url,
    reloginUrl,
  );
  assert.deepEqual(reloginBodies, [{ id: accountIds[0] }]);
  assert.equal(await page.locator("#oauth-link").textContent(), reloginUrl);
  assert.equal(
    (await page.locator("#oauth-title").textContent()).trim(),
    "Sign in again",
  );
  await page.locator("#oauth-close").click();
  await page.waitForFunction(
    () => !document.querySelector("#oauth-dialog").open,
  );

  // Accounts that need it get an inline Sign in again button too.
  await page.evaluate(() => {
    dashboard.state.data.accounts.at(-1).requires_sign_in = true;
    dashboard.render();
  });
  assert.equal(
    await page
      .locator(".account-row")
      .last()
      .getByRole("button", { name: "Sign in again", exact: true })
      .isVisible(),
    true,
  );

  // Remove asks for confirmation; Cancel sends nothing, Remove posts the id.
  const removeBodies = await mock("**/dashboard/api/account/remove", {
    status: "ok",
  });
  const confirm = page.locator('[role="alertdialog"]').or(
    page.locator("dialog[open]").filter({
      has: page.getByRole("button", { name: "Remove", exact: true }),
    }),
  );
  const lastRow = counts.accounts - 1;
  await rowMenu(lastRow).click();
  await menuItem("Remove account").click();
  await confirm.first().waitFor();
  await confirm.first().getByRole("button", { name: "Cancel" }).click();
  await confirm.first().waitFor({ state: "hidden" });
  assert.deepEqual(removeBodies, [], "Cancel does not remove the account");
  await rowMenu(lastRow).click();
  await menuItem("Remove account").click();
  await confirm.first().waitFor();
  await confirm
    .first()
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await until(() => removeBodies.length);
  assert.deepEqual(removeBodies, [{ id: accountIds[lastRow] }]);
  await page.evaluate(() => load());

  // Logs page: Errors list and viewer, Activity enabled and disabled states.
  const errorName = "error-2026-11-13T01-00-00-test.log";
  await page.route("**/dashboard/api/logs/errors", (route) =>
    route.fulfill({
      json: {
        files: [
          {
            name: errorName,
            size: 2048,
            modified: Math.floor(Date.now() / 1000),
          },
        ],
      },
    }),
  );
  await page.route("**/dashboard/api/logs/errors/file*", (route) =>
    route.fulfill({
      json: {
        name: errorName,
        text: "POST /v1/responses\n429 Too Many Requests",
        truncated: false,
      },
    }),
  );
  let activityEnabled = true;
  await page.route("**/dashboard/api/logs/activity*", (route) =>
    route.fulfill({
      json: activityEnabled
        ? {
            enabled: true,
            lines: ["activity line one", "activity line two"],
            latest: Math.floor(Date.now() / 1000),
          }
        : { enabled: false, lines: [] },
    }),
  );
  const enableBodies = await mock("**/dashboard/api/logs/activity/enable", {
    enabled: true,
  });
  const logsTab = (name) =>
    page.locator("#page-body .segmented button").filter({ hasText: name });
  await page.locator('[data-page="logs"]').click();
  await page.waitForFunction(
    () => document.querySelector("#page-title").textContent.trim() === "Logs",
  );
  // Clean URLs: each page has its own path that survives a reload, back and
  // forward work, and old #hash links land on the matching path.
  const title = () => page.locator("#page-title").textContent().then((s) => s.trim());
  const titleIs = (name) =>
    page.waitForFunction((n) => document.querySelector("#page-title").textContent.trim() === n, name);
  assert.equal(new URL(page.url()).pathname, "/dashboard/logs");
  await page.reload();
  await titleIs("Logs");
  await page.goBack();
  await page.waitForFunction(() => location.pathname !== "/dashboard/logs");
  assert.notEqual(await title(), "Logs");
  await page.goForward();
  await titleIs("Logs");
  // Loading a page directly shows its own heading from the first paint.
  await page.addInitScript(() => {
    window.seenTitles = [];
    new MutationObserver(() => {
      const el = document.querySelector("#page-title");
      if (el) window.seenTitles.push(el.textContent.trim());
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.addInitScript(() => {
    window.seenClips = [];
    new MutationObserver(() => {
      const group = document.querySelector(".sidebar-group");
      const clip = group?.style.getPropertyValue("--indicator-clip");
      if (clip) window.seenClips.push(clip);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["style"] });
  });
  await page.goto(url + "accounts");
  await titleIs("Accounts");
  await page.waitForTimeout(600);
  // The nav highlight never covers the whole group (measured while hidden).
  assert.deepEqual(
    await page.evaluate(() => window.seenClips.filter((c) => /^inset\(0px 0px 0px 0px/.test(c))),
    [],
    "The sidebar highlight starts on the active item",
  );
  assert.deepEqual(
    [...new Set(await page.evaluate(() => window.seenTitles.filter(Boolean)))],
    ["Accounts"],
    "The heading never shows another page's name on load",
  );
  await page.goto(url + "#accounts");
  await titleIs("Accounts");
  assert.equal(new URL(page.url()).pathname, "/dashboard/accounts");
  assert.equal(new URL(page.url()).hash, "");
  await page.locator('[data-page="logs"]').click();
  await titleIs("Logs");
  await logsTab("Errors").click();
  const errorItem = page
    .locator(`[data-log-name="${errorName}"]`)
    .or(page.locator("#page-body button", { hasText: errorName }))
    .first();
  await errorItem.click();
  await page
    .locator("#page-body pre", { hasText: "429 Too Many Requests" })
    .waitFor();
  await logsTab("Activity").click();
  await page
    .locator("#page-body pre", { hasText: "activity line two" })
    .waitFor();
  activityEnabled = false;
  await logsTab("Errors").click();
  await logsTab("Activity").click();
  const enable = page.getByRole("button", { name: "Enable activity log" });
  await enable.waitFor();
  activityEnabled = true;
  await enable.click();
  await page
    .locator("#page-body pre", { hasText: "activity line two" })
    .waitFor();
  assert.equal(enableBodies.length, 1, "Enable posts once, on click only");
  await page.unroute("**/dashboard/api/logs/activity*");
  await page.unroute("**/dashboard/api/logs/errors");
  await page.unroute("**/dashboard/api/logs/errors/file*");
  await keysChecks(page, mock, until, url);

  // One-time setup info lives in the README, not the sidebar.
  assert.equal(await page.locator('[data-page="connection"]').count(), 0);
  await page.locator('[data-page="quotas"]').click();
  await page.locator("[data-pool]").first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => dashboard.render());
  await page.screenshot({
    path: path.join(artifacts, "dashboard-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator("#menu").click();
  await page.locator('[data-page="accounts"]').click();
  await page.locator(".account-row").first().waitFor();
  assert.equal(await page.locator(".account-row").count(), counts.accounts);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(artifacts, "dashboard-mobile-accounts.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const calculations = await page.evaluate(() => {
    const api = window.dashboard,
      original = api.state.data,
      now = Date.now() / 1000;
    api.state.burn = 3;
    api.state.forecast = true;
    api.state.data = {
      now,
      history: [
        { account: "test", metric: "m", ts: now - 1800, remaining: 70 },
        { account: "test", metric: "m", ts: now - 1200, remaining: 100 },
        { account: "test", metric: "m", ts: now - 600, remaining: 95 },
      ],
    };
    const rate = api.drainFor({ id: "test" }, "m", now);
    api.state.data.history = [
      { account: "test", metric: "m", ts: now - 10, remaining: 50 },
    ];
    const unknown = api.drainFor({ id: "test" }, "m", now);
    const forecast = api.forecastPoints(
      [
        {
          a: { id: "test", quota_at: now },
          w: { remaining: 50, reset_at: now + 3600 },
        },
      ],
      "m",
      now,
      now + 7200,
    );
    api.state.data = original;
    return { rate, unknown, forecastCount: forecast.length };
  });
  assert.equal(calculations.rate, 30);
  assert.equal(calculations.unknown, null);
  assert.equal(calculations.forecastCount, 0);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(180);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await assertTabsFit(`${width}px`);
  }

  // Exercise motion with the actual controls and browser animations enabled.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-page="quotas"]').click();
  await page.locator("[data-pool]").first().waitFor();
  await page.waitForTimeout(240);
  const settle = () =>
    page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
  await page.locator('[data-filter="codex"]').click();
  assert.ok(
    await page.evaluate(() =>
      document
        .getAnimations()
        .some(
          (a) =>
            a.playState === "running" &&
            a.effect.getComputedTiming().duration > 0,
        ),
    ),
    "Pointer selection starts a transition",
  );
  // Reverse rapidly: the final selection must win without a delayed swap.
  await page.locator('[data-filter="antigravity"]').click({ force: true });
  await page.locator('[data-filter="all"]').click({ force: true });
  await settle();
  assert.equal(
    await page.locator('[data-filter="all"]').getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await page.locator('[data-pool]:not([data-pool="all"])').count(), expectedPools);
  const indicators = await page.evaluate(() =>
    [...document.querySelectorAll(".provider-tabs, .segmented")].every((g) => {
      const active = g.querySelector("button.active");
      const expected = active.offsetLeft;
      const clip = getComputedStyle(g, "::before").clipPath;
      return (
        clip !== "none" &&
        Number.isFinite(expected) &&
        g.dataset.motionIndicator === "ready"
      );
    }),
  );
  assert.ok(indicators, "Selection indicators settle on their active controls");

  // Read a sample, then fetch a new snapshot with exactly the same live nodes.
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  const quietRefresh = await page.evaluate(async () => {
    const plot = document.querySelector('[data-pool="codex"] [data-chart]');
    const windowTab = document.querySelector(
      '[data-pool="antigravity"] [aria-label^="Quota window"] > .active',
    );
    const button = document.querySelector('[data-filter="all"]');
    const tooltip = plot.querySelector(".chart-tooltip");
    const breakdown = document.querySelector(
      '[data-pool="codex"] .account-pool',
    );
    const inspected = tooltip.textContent;
    await load();
    const inspectionPreserved =
      tooltip.isConnected &&
      !tooltip.hidden &&
      tooltip.textContent === inspected &&
      document.activeElement === plot;
    windowTab.focus();
    // Let the tab's own focus-ring transition finish; only refresh motion counts.
    await new Promise((r) => setTimeout(r, 300));
    await load();
    return {
      inspectionPreserved,
      windowTabPreserved:
        windowTab.isConnected && document.activeElement === windowTab,
      buttonPreserved: button.isConnected,
      breakdownPreserved: breakdown.isConnected && breakdown.checkVisibility(),
      // Torph morphs real text changes (ages, values); nothing else may move.
      quiet:
        document
          .getAnimations()
          .filter(
            (a) =>
              !(
                a.effect?.target?.hasAttribute?.("torph-item") ||
                a.effect?.target?.closest?.("[torph-root]")
              ),
          ).length === 0,
    };
  });
  assert.deepEqual(quietRefresh, {
    inspectionPreserved: true,
    windowTabPreserved: true,
    buttonPreserved: true,
    breakdownPreserved: true,
    quiet: true,
  });

  // Keyboard activation animates like pointer activation, including the indicator.
  await page.locator('[data-filter="codex"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("[data-pool]").count(), 1);
  assert.ok(
    await page.evaluate(() =>
      document
        .getAnimations()
        .some((a) => a.transitionProperty === "clip-path"),
    ),
  );
  await page.locator('[data-filter="all"]').click();
  await settle();
  const timestampInspection = await page.evaluate(() => {
    const plot = document.querySelector('[data-pool="codex"] [data-chart]');
    const chart = dashboard.state.charts[document.querySelector('[data-pool="codex"] [data-chart]').dataset.chart];
    const original = { points: chart.points, forecast: chart.forecast };
    const now = dashboard.state.data.now;
    chart.points = [1800, 1200, 600].map((ago) => ({
      ts: now - ago,
      value: 50,
    }));
    chart.forecast = [];
    inspectChart(plot, chart.points[1]);
    // The first sample falls off the range as a new sample arrives.
    chart.points = [...chart.points.slice(1), { ts: now, value: 50 }];
    plot.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    const correct = Number(plot.dataset.inspectedAt) === now - 600;
    Object.assign(chart, original);
    clearChart(plot);
    return correct;
  });
  assert.ok(
    timestampInspection,
    "Chart inspection follows the sample timestamp after history shifts",
  );

  // Hold one response while changing range again: only the latest range may
  // render, and it must animate after its own snapshot arrives.
  const snapshot = await page.evaluate(() => dashboard.state.data);
  const requests = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const snapshotRoute = "**/dashboard/api/snapshot?hours=*";
  await page.route(snapshotRoute, async (route) => {
    const hours = Number(
      new URL(route.request().url()).searchParams.get("hours"),
    );
    requests.push(hours);
    if (hours === 168) await held;
    await route.fulfill({ json: { ...snapshot, testHours: hours } });
  });
  await page.locator('[data-hours="168"]').click();
  await page.waitForFunction(() => dashboard.state.loadBusy);
  await page.locator('[data-hours="336"]').click();
  assert.equal(
    await page.evaluate(() => {
      const c = dashboard.state.charts[document.querySelector('[data-pool="codex"] [data-chart]').dataset.chart];
      return Math.round((c.end - c.start) / 3600);
    }),
    24,
    "The chart keeps the previous range while new history loads",
  );
  release();
  await page.waitForFunction(
    () => dashboard.state.data.testHours === 336 && !dashboard.state.loadBusy,
  );
  assert.deepEqual(requests, [168, 336]);
  assert.equal(
    await page.evaluate(() => {
      const c = dashboard.state.charts[document.querySelector('[data-pool="codex"] [data-chart]').dataset.chart];
      return Math.round((c.end - c.start) / 3600);
    }),
    336,
  );
  await page.unroute(snapshotRoute);
  await page.locator('[data-hours="24"]').click();
  await page.waitForFunction(
    () =>
      !dashboard.state.loadBusy &&
      Math.round(
        (dashboard.state.charts[document.querySelector('[data-pool="codex"] [data-chart]').dataset.chart].end -
          dashboard.state.charts[document.querySelector('[data-pool="codex"] [data-chart]').dataset.chart].start) /
          3600,
      ) === 24,
  );
  await settle();
  await page.locator('[data-page="accounts"]').click();
  await page.locator(".account-row").first().waitFor();
  await settle();
  const focusAfterRemoval = await page.evaluate(() => {
    const original = dashboard.state.data.accounts;
    const button = document.querySelector(
      ".account-row:last-child [data-pause]",
    );
    button.focus();
    // Browser-only fixture; no real account is changed.
    dashboard.state.data.accounts = original.slice(1);
    dashboard.render();
    const removal = button.isConnected && document.activeElement === button;
    dashboard.state.data.accounts = [...original].reverse();
    dashboard.render();
    const reorder = button.isConnected && document.activeElement === button;
    dashboard.state.data.accounts = original;
    dashboard.render();
    return { removal, reorder };
  });
  assert.deepEqual(focusAfterRemoval, { removal: true, reorder: true });
  const add = page.locator("#add-login");
  await add.click();
  assert.ok(
    await page
      .locator("#oauth-dialog")
      .evaluate((d) => d.getAnimations().length > 0),
  );
  await settle();
  await page.locator("#oauth-close").click();
  assert.equal(
    await page.locator("#oauth-dialog").evaluate((d) => d.open),
    false,
  );
  await settle();
  assert.equal(await add.evaluate((b) => document.activeElement === b), true);
  // Cancel an entrance with Escape, then reopen before the exit settles.
  await add.click();
  await page.keyboard.press("Escape");
  await add.click();
  await settle();
  assert.equal(
    await page.locator("#oauth-dialog").evaluate((d) => d.open),
    true,
  );
  await page.keyboard.press("Escape");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator('[data-page="quotas"]').click();
  await page.locator("[data-pool]").first().waitFor();
  await page.locator('[data-filter="antigravity"]').click();
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await page.locator('[data-filter="all"]').click();
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  // Original SVGL marks are referenced everywhere provider identity appears.
  assert.ok(
    await page.locator('.provider-icon use[href="#brand-codex"]').count(),
  );
  assert.ok(
    await page.locator('.provider-icon use[href="#brand-antigravity"]').count(),
  );
  await page.screenshot({
    path: path.join(artifacts, "dashboard-motion-desktop.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const cookie = (await context.cookies()).find(
    (c) => c.name === "prox_session",
  );
  assert.ok(cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict");
  // Signed in by the tailnet: no key prompt and no Sign out (there is no session to end).
  assert.equal(await page.locator("#logout").isVisible(), true);
  await page.route("**/dashboard/api/session", (route) =>
    route.fulfill({ json: { authenticated: true, tailnet: true } }),
  );
  await page.reload();
  await page.locator("[data-pool]").first().waitFor();
  assert.equal(await page.locator("#logout").isHidden(), true);
  await page.unroute("**/dashboard/api/session");
  assert.deepEqual(escaped, [], "No real account or config mutation escaped");
  console.log(
    JSON.stringify({
      passed: true,
      accounts: counts.accounts,
      quotaWindows: counts.windows,
      checks: [
        "login",
        "protected cookie",
        "live quotas",
        "provider filters",
        "quota window selection",
        "Silo quota group caps (mocked)",
        "burn lookback",
        "drain view",
        "account list",
        "roving keyboard focus and focus rings",
        "emails shown by default",
        "sign-in dialog and right-aligned footer",
        "add login providers and toasts",
        "persisted chart choices",
        "breakdown visible without interaction",
        "account menu keyboard and focus return",
        "reset cooldown (mocked)",
        "sign in again opens flow step (mocked)",
        "inline sign in again",
        "remove with confirmation (mocked)",
        "manual resets with confirmation and safe retry (mocked)",
        "clean URLs with reload, back/forward and old #hash links",
        "page heading and sidebar highlight correct from first paint",
        "logs: errors viewer and activity states (mocked)",
        "keys: list, create, edit, rotate, delete and usage (mocked)",
        "tokens: all-time totals, account and provider breakdowns, chart inspection (mocked)",
        "no mutation reached the real proxy",
        "no connection page",
        "tailnet sign-in hides Sign out",
        "390px layout",
        "mobile navigation",
        "interruptible motion",
        "quiet polling and focus preservation",
        "history timestamp inspection",
        "queued range selection",
        "dialog entrance, exit and focus return",
        "keyboard motion and reduced motion",
        "SVGL provider marks",
      ],
      pageErrors: errors,
    }),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
