const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runAppScripts } = require("./app_scripts.cjs");

function loadDashboard(innerWidth = 1440) {
  const noop = () => {};
  const fakeEl = () => ({
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    className: "",
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
    clientWidth: innerWidth <= 760 ? innerWidth - 32 : innerWidth - 288,
  });
  const sandbox = {
    console, Math, Number, String, Boolean, Array, Object, Map, Set, Date, JSON, RegExp, Error, URL, Promise, Intl, WeakMap,
    encodeURIComponent, decodeURIComponent,
    addEventListener: noop, removeEventListener: noop, getComputedStyle: () => ({}), navigator: {},
    setTimeout: () => 0, clearTimeout: noop, requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    scrollTo: noop, innerWidth, matchMedia: () => ({ matches: true, addEventListener: noop }),
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
  return runAppScripts(sandbox, "({ state, quotasGridPlan, quotaPage, renderTimePlot, usageBreakdownHtml, poolGlance })");
}

const d = loadDashboard(1440);
const plain = (x) => JSON.parse(JSON.stringify(x));
const fiveProviders = ["claude", "codex", "antigravity", "xai", "devin"];

// 1. Default desktop 5-provider layout: 6+6, 6+6, 4+4+4.
const def = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, isMobile: false }));
assert.deepEqual(
  def.cards.map((c) => [c.id, c.span, c.wide, c.expandable]),
  [
    ["all", 6, false, true],
    ["usage", 6, false, true],
    ["claude", 6, false, true],
    ["antigravity", 6, false, true],
    ["codex", 4, false, true],
    ["xai", 4, false, true],
    ["devin", 4, false, true],
  ],
);

// 2. Expanding Usage moves it first (12, expandable); All accounts below (12, not redundantly expandable).
const usageExp = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, wideCards: { usage: true }, isMobile: false }));
assert.deepEqual(
  usageExp.cards.slice(0, 2).map((c) => [c.id, c.span, c.wide, c.expandable]),
  [
    ["usage", 12, true, true],
    ["all", 12, false, false],
  ],
);

// 3. Expanding Antigravity moves it to top of Band 2 (12) and Claude below (12, not redundantly expandable).
const agyExp = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, wideCards: { antigravity: true }, isMobile: false }));
assert.deepEqual(
  agyExp.cards.slice(2, 4).map((c) => [c.id, c.span, c.wide, c.expandable]),
  [
    ["antigravity", 12, true, true],
    ["claude", 12, false, false],
  ],
);

// 4. Expanding xAI in 3-up Band 3 moves xAI first (12) and reflows Codex + Devin side-by-side (6 + 6).
const xaiExp = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, wideCards: { xai: true }, isMobile: false }));
assert.deepEqual(
  xaiExp.cards.slice(4).map((c) => [c.id, c.span, c.wide, c.expandable]),
  [
    ["xai", 12, true, true],
    ["codex", 6, false, true],
    ["devin", 6, false, true],
  ],
);

// 4b. Unified recency order: expanding xAI, then opening Codex's Show charts puts Codex first.
const xaiThenCodex = plain(
  d.quotasGridPlan(fiveProviders, {
    hasAll: true,
    hasUsage: true,
    wideCards: { xai: true },
    expanded: { codex: true },
    wideOrder: ["xai", "codex"],
    isMobile: false,
  }),
);
assert.deepEqual(
  xaiThenCodex.cards.slice(4).map((c) => [c.id, c.span, c.wide, c.expandable]),
  [
    ["codex", 12, true, true],
    ["xai", 12, true, true],
    ["devin", 12, false, false],
  ],
);

// 5. Opening "Show charts" (expanded.codex) also promotes Codex to full width (12) with xAI + Devin (6 + 6) below.
const codexCharts = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, expanded: { codex: true }, isMobile: false }));
assert.deepEqual(
  codexCharts.cards.slice(4).map((c) => [c.id, c.span, c.wide]),
  [
    ["codex", 12, true],
    ["xai", 6, false],
    ["devin", 6, false],
  ],
);

// 6. Unavailable Usage keeps a hidden mount so polling can recover, while All accounts spans 12 with no expand button.
const noUsage = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: false, isMobile: false }));
assert.deepEqual(noUsage.cards[0], { id: "all", span: 12, wide: false, expandable: false, mobileSpanFull: true });
assert.equal(noUsage.cards[1].id, "usage");
assert.equal(noUsage.cards[1].hidden, true);

// 7. Stacked desktop (761-959px): every card spans 12 and expandable=false so SVGs stay 1:1.
const stacked = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, isStacked: true }));
assert.ok(stacked.cards.every((c) => c.span === 12 && !c.expandable));

// 8. Medium desktop (1024px, maxColsSecondary=2): Band 3 packs 6+6 then 12 (no expand button on already full-width Devin).
const med = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, isMobile: false, maxColsSecondary: 2 }));
assert.deepEqual(
  med.cards.slice(4).map((c) => [c.id, c.span, c.expandable]),
  [
    ["codex", 6, true],
    ["xai", 6, true],
    ["devin", 12, false],
  ],
);

// 8b. 3 total providers pack cleanly into one 4+4+4 row on wide desktop.
const threeProv = plain(d.quotasGridPlan(["claude", "codex", "xai"], { hasAll: true, hasUsage: true, isMobile: false }));
assert.deepEqual(
  threeProv.cards.slice(2).map((c) => [c.id, c.span]),
  [
    ["claude", 4],
    ["codex", 4],
    ["xai", 4],
  ],
);

// 9. Mobile layout: All -> 5 collapsed providers 2-up (last odd full) -> Usage.
const mobDef = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, isMobile: true }));
assert.deepEqual(
  mobDef.cards.map((c) => [c.id, c.wide, c.mobileSpanFull]),
  [
    ["all", false, true],
    ["claude", false, false],
    ["antigravity", false, false],
    ["codex", false, false],
    ["xai", false, false],
    ["devin", false, true],
    ["usage", false, true],
  ],
);

// 10. Mobile expand Codex: Codex moves to top of providers full-width; remaining 4 pack cleanly 2x2.
const mobCodex = plain(d.quotasGridPlan(fiveProviders, { hasAll: true, hasUsage: true, wideCards: { codex: true }, isMobile: true }));
assert.deepEqual(
  mobCodex.cards.slice(1, 6).map((c) => [c.id, c.wide, c.mobileSpanFull]),
  [
    ["codex", true, true],
    ["claude", false, false],
    ["antigravity", false, false],
    ["xai", false, false],
    ["devin", false, false],
  ],
);

// 11. Chart SVG dimensions match card spans, desktop skips poolGlance, mobile glance honors stale/unit/a11y rules.
const now = 1_795_500_000;
const makeAcct = (id, provider, rem, opts = {}) => ({
  id,
  name: id,
  provider,
  windows: [{ id: "five_hour", label: "5-hour limit", remaining: rem, period: 18000, api_usd: opts.apiUsd || 100, reset_at: now + 7200 }],
  cooldowns: [],
  quota_at: opts.quotaAt ?? now - 30,
  weight: opts.weight || 1,
  plan_weight: opts.weight || 1,
  history: { five_hour: [{ ts: now - 3600, value: rem + 10 }, { ts: now, value: rem }] },
});
d.state.data = {
  now,
  provider_order: fiveProviders,
  accounts: [
    makeAcct("c1", "claude", 70, { apiUsd: 200, weight: 5 }),
    makeAcct("c2", "claude", 80, { apiUsd: 100, weight: 1 }),
    makeAcct("a1", "antigravity", 60),
    makeAcct("x1", "codex", 40),
    makeAcct("x2", "codex", 50),
    makeAcct("g1", "xai", 85, { quotaAt: now - 3600 }), // stale single account
    makeAcct("d1", "devin", 95),
  ],
  totals: {
    all: { "5h": { metrics: { claude: "five_hour", antigravity: "five_hour", codex: "five_hour", xai: "five_hour", devin: "five_hour" }, points: [{ ts: now - 3600, usd: 450 }, { ts: now, usd: 400 }] } },
    claude: { five_hour: [{ ts: now - 3600, usd: 220 }, { ts: now, usd: 220 }] },
    codex: { five_hour: [{ ts: now - 3600, usd: 100 }, { ts: now, usd: 90 }] },
  },
};
d.state.provider = "all";
d.state.wideCards = {};
d.state.expanded = {};
const htmlDesktop = d.quotaPage();
assert.match(htmlDesktop, /id="quotas-grid"/);
assert.doesNotMatch(htmlDesktop, /class="pool-glance"/, "desktop must not waste work rendering hidden mobile glance tiles");
assert.ok(d.state.charts["claude-total"].W < 600 && d.state.charts["claude-total"].H === 185);
assert.ok(d.state.charts["codex-total"].W < 400 && d.state.charts["codex-total"].H === 160);

d.state.wideCards = { codex: true };
d.quotaPage();
assert.ok(d.state.charts["codex-total"].W > 900 && d.state.charts["codex-total"].H === 220);

const dm = loadDashboard(390);
dm.state.data = d.state.data;
dm.state.provider = "all";
dm.state.unit = "raw";
const htmlMobile = dm.quotaPage();
for (const p of fiveProviders) {
  assert.match(htmlMobile, new RegExp(`class="pool-glance" data-expand-card="${p}"`));
}
assert.doesNotMatch(htmlMobile, /<button[^>]*class="pool-glance"[^>]*aria-label=/, "mobile glance tile must not override screen-reader content with aria-label");
assert.doesNotMatch(htmlMobile, /<button[^>]*class="pool-glance"[^>]*>(?:(?!<\/button>)[\s\S])*?<div/, "mobile glance button must use phrasing <span> children, not <div>");
assert.match(htmlMobile, /data-expand-card="xai"[\s\S]*?class="glance-status muted">Last known</, "stale single-account glance tile must show muted Last known, not green Ready");
assert.match(htmlMobile, /data-expand-card="claude"[\s\S]*?width:75\.0%/, "raw mode progress bar must match raw average (75%), not CU ratio");

// Stale single-account with Sign-in needed preserves destructive status alongside Last known.
const staleAuthAcct = makeAcct("g2", "xai", 85, { quotaAt: now - 3600 });
staleAuthAcct.requires_sign_in = true;
dm.state.data = { ...d.state.data, accounts: [staleAuthAcct] };
const staleAuthHtml = dm.poolGlance("xai", [staleAuthAcct], "five_hour", staleAuthAcct.windows, null);
assert.match(staleAuthHtml, /class="glance-status bad">Sign-in needed</, "stale auth-expired tile must preserve Sign-in needed");
assert.match(staleAuthHtml, /class="glance-reset">Last known</, "stale auth-expired tile must still mark quota as Last known");

// 12. CSS static guard: no invalid nested :has() selectors in index.html.
const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
assert.doesNotMatch(indexHtml, /:has\([^)]*:has\(/, "CSS Selectors Level 4 forbids nested :has()");

// 13. Standalone Chromium Playwright verification across 1440/1300/1200/1024/850/600/390.
let playwright;
for (const mod of [process.env.PLAYWRIGHT_MODULE, "playwright", "playwright-core"].filter(Boolean)) {
  try {
    playwright = require(mod);
    break;
  } catch {}
}

if (playwright) {
  (async () => {
    const browser = await playwright.chromium.launch({ executablePath: process.env.CHROME_PATH });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));

      const snapshot = {
        now,
        provider_order: fiveProviders,
        accounts: d.state.data.accounts,
        totals: d.state.data.totals,
      };
      let usageAvailable = true;
      let usageProjects = [
        { id: "p1", title: "silo", cost_usd: 225, priced: true, share: 0.6, tokens: 100e6, io_tokens: 5e6, requests: 200, thread_count: 1, subagent_count: 0, last_active_at: now - 60, providers: { claude: { cost_usd: 225, tokens: 100e6, io_tokens: 5e6, requests: 200 } }, models: ["claude-opus-5-5"], threads: [] },
        { id: "p2", title: "tincan", cost_usd: 150, priced: true, share: 0.4, tokens: 80e6, io_tokens: 4e6, requests: 120, thread_count: 1, subagent_count: 0, last_active_at: now - 120, providers: { codex: { cost_usd: 150, tokens: 80e6, io_tokens: 4e6, requests: 120 } }, models: ["gpt-6.2-sol"], threads: [] },
      ];
      await page.route("**/dashboard/**", async (route) => {
        const url = new URL(route.request().url());
        const p = url.pathname;
        if (p === "/dashboard/" || p === "/dashboard") {
          return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: indexHtml });
        }
        if (p.startsWith("/dashboard/assets/")) {
          const file = path.join(__dirname, "assets", p.replace("/dashboard/assets/", ""));
          if (fs.existsSync(file)) {
            return route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(file) });
          }
          return route.fulfill({ status: 200, contentType: "application/octet-stream", body: "" });
        }
        if (p === "/dashboard/api/session") return route.fulfill({ json: { authenticated: true } });
        if (p === "/dashboard/api/snapshot") return route.fulfill({ json: snapshot });
        if (p === "/dashboard/api/usage/breakdown") {
          if (!usageAvailable) return route.fulfill({ json: { available: false } });
          const totalCost = usageProjects.reduce((s, r) => s + r.cost_usd, 0);
          return route.fulfill({
            json: {
              available: true,
              hours: 24,
              provider: "all",
              now,
              totals: { cost_usd: totalCost, priced: true, tokens: 180e6, io_tokens: 9e6, requests: 320, projects: usageProjects.length, threads: 2, providers: { claude: { cost_usd: totalCost, tokens: 180e6, io_tokens: 9e6, requests: 320 } } },
              projects: usageProjects,
              threads: [],
            },
          });
        }
        return route.fulfill({ json: {} });
      });

      // Restored expanded <details> must NOT scroll the page on load (Opus F1).
      await page.addInitScript(() => {
        if (!sessionStorage.getItem("init-once")) {
          sessionStorage.setItem("init-once", "1");
          localStorage.setItem("prox:prefs", JSON.stringify({ expanded: { codex: true } }));
        }
      });
      await page.goto("http://127.0.0.1:1/dashboard/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#quotas-grid .pool");
      await page.waitForSelector("#usage-breakdown .ub-row");
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.querySelector('[data-accounts="codex"]')?.open), true, "saved expanded.codex must actually restore open");
      assert.equal(await page.evaluate(() => window.scrollY), 0, "loading with saved expanded.codex must keep scrollY === 0");
      // Collapse Codex back to default state for layout checks.
      await page.locator('[data-pool="codex"] .card-expand-btn').click();
      await page.waitForFunction(() => !document.querySelector('[data-pool="codex"]').classList.contains("card-wide"));
      await page.evaluate(() => window.scrollTo(0, 0));

      // 1440px checks: Row 1 aligned headers + equal stretched height + xAI expand button flush right.
      const g1440 = await page.evaluate(() => {
        const all = document.querySelector('[data-pool="all"]');
        const ub = document.querySelector("#usage-breakdown");
        const allHead = all.querySelector(".account-pool-head").getBoundingClientRect();
        const ubHead = ub.querySelector(".ub-head").getBoundingClientRect();
        const xaiCard = document.querySelector('[data-pool="xai"]').getBoundingClientRect();
        const xaiBtn = document.querySelector('[data-pool="xai"] .card-expand-btn').getBoundingClientRect();
        return {
          allRect: all.getBoundingClientRect(),
          ubRect: ub.getBoundingClientRect(),
          headTopDiff: Math.abs(allHead.top - ubHead.top),
          xaiRightGap: xaiCard.right - xaiBtn.right,
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      assert.ok(g1440.overflowX <= 0, `1440px overflow: ${g1440.overflowX}`);
      assert.ok(Math.abs(g1440.allRect.height - g1440.ubRect.height) <= 1, "Row 1 cards should stretch to equal height");
      assert.ok(g1440.headTopDiff <= 8, `Row 1 headers should align vertically (diff=${g1440.headTopDiff})`);
      assert.ok(g1440.xaiRightGap <= 28, `xAI expand button must sit flush right (gap=${g1440.xaiRightGap})`);

      // Live usage poll that reorders two projects preserves focus on the focused project button (Sol F1).
      const p2Btn = page.locator('[data-ub-toggle="p2"]');
      await p2Btn.focus();
      usageProjects = [
        { ...usageProjects[1], cost_usd: 310, share: 0.65 },
        { ...usageProjects[0], cost_usd: 165, share: 0.35 },
      ];
      await page.evaluate(() => loadUsageBreakdown(true));
      await page.waitForFunction(() => document.querySelector('#usage-breakdown [data-ub-project]')?.dataset.ubProject === "p2");
      assert.equal(
        await page.evaluate(() => document.activeElement?.dataset?.ubToggle === "p2"),
        true,
        "reordering projects on live poll must keep focus on the focused project toggle",
      );

      // Usage recovery: available: false hides card, subsequent available: true restores it.
      usageAvailable = false;
      await page.evaluate(() => loadUsageBreakdown(true));
      await page.waitForFunction(() => document.querySelector("#usage-breakdown")?.hidden === true);
      assert.equal(await page.locator('[data-pool="all"] .card-expand-btn').count(), 0, "All accounts loses expand button when Usage is unavailable");
      usageAvailable = true;
      await page.evaluate(() => loadUsageBreakdown(true));
      await page.waitForFunction(() => document.querySelector("#usage-breakdown")?.hidden === false);
      assert.equal(await page.locator('[data-pool="all"] .card-expand-btn').count(), 1, "All accounts regains expand button when Usage recovers");

      // Expand xAI, then open Codex's Show charts -> Codex moves FIRST in Band 3 (Sol F3).
      await page.locator('[data-pool="xai"] .card-expand-btn').click();
      const codexSummary = page.locator('[data-pool="codex"] [data-accounts="codex"] > summary');
      await codexSummary.click();
      await page.waitForSelector('[data-pool="codex"].card-wide');
      const band3Order = await page.evaluate(() =>
        [...document.querySelectorAll('#quotas-grid > [data-pool]')].map((el) => el.dataset.pool).slice(3),
      );
      assert.deepEqual(band3Order.slice(0, 2), ["codex", "xai"], "opening Show charts after expanding xAI must put Codex first");
      // Closing Show charts with Enter on a short viewport keeps the focused summary in view (Sol R3 F1).
      await page.setViewportSize({ width: 1440, height: 500 });
      await codexSummary.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector('[data-pool="codex"]').classList.contains("card-wide"));
      const summaryInView = await page.evaluate(() => {
        const el = document.activeElement;
        const r = el.getBoundingClientRect();
        return { isSummary: el.matches('[data-accounts="codex"] > summary'), top: r.top, bottom: r.bottom, ih: window.innerHeight };
      });
      assert.ok(summaryInView.isSummary && summaryInView.top >= 0 && summaryInView.bottom <= summaryInView.ih, `closing Show charts must keep summary in view (${JSON.stringify(summaryInView)})`);
      // Open Codex Show charts on desktop, resize to mobile, close via Enter -> focus transfers to visible glance tile (Sol R3 F1).
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('[data-pool="xai"] .card-expand-btn').click();
      await codexSummary.click();
      await page.waitForSelector('[data-pool="codex"].card-wide');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => render());
      await codexSummary.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector('[data-pool="codex"]').classList.contains("card-wide"));
      const tileAfterClose = await page.evaluate(() => {
        const el = document.activeElement;
        const r = el.getBoundingClientRect();
        return { isTile: el.matches('[data-pool="codex"] .pool-glance'), top: r.top, bottom: r.bottom, ih: window.innerHeight };
      });
      assert.ok(tileAfterClose.isTile && tileAfterClose.top >= 0 && tileAfterClose.bottom <= tileAfterClose.ih, `closing Show charts on mobile must focus visible glance tile (${JSON.stringify(tileAfterClose)})`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => render());

      // Intermediate widths: 1300px (3-up), 1200px (2-up), 1024px (2-up) -> expand buttons stay flush right on Row 1 (Neon F1/F3, Opus F4).
      for (const [w, checks] of [
        [1300, ["devin", "codex", "xai"]],
        [1200, ["all", "codex", "claude"]],
        [1024, ["all", "codex", "claude"]],
      ]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.evaluate(() => render());
        const res = await page.evaluate((ids) => {
          const out = { overflowX: document.documentElement.scrollWidth - window.innerWidth, cards: {} };
          for (const id of ids) {
            const card = document.querySelector(`[data-pool="${id}"]`);
            const title = card.querySelector(".pool-top h2, .account-pool-head .mini-label").getBoundingClientRect();
            const btn = card.querySelector(".card-expand-btn")?.getBoundingClientRect();
            const cr = card.getBoundingClientRect();
            out.cards[id] = btn ? { sameRow: Math.abs(title.top - btn.top) <= 12, rightGap: Math.round(cr.right - btn.right) } : null;
          }
          return out;
        }, checks);
        assert.ok(res.overflowX <= 0, `${w}px overflow: ${res.overflowX}`);
        for (const id of checks) {
          assert.ok(res.cards[id]?.sameRow, `${w}px ${id} expand button must sit on row 1`);
          assert.ok(res.cards[id]?.rightGap <= 28, `${w}px ${id} expand button must sit flush right (gap=${res.cards[id]?.rightGap})`);
        }
      }
      assert.equal(await page.locator('[data-pool="devin"] .card-expand-btn').count(), 0, "1024px full-width Devin must not show expand button");

      // 850px stacked check: viewBox height matches rendered CSS SVG height (no squashing!).
      await page.setViewportSize({ width: 850, height: 900 });
      await page.evaluate(() => render());
      const g850 = await page.evaluate(() => {
        const svg = document.querySelector('[data-pool="claude"] .plot svg');
        const vb = svg.getAttribute("viewBox").split(" ").map(Number);
        const r = svg.getBoundingClientRect();
        return { vbH: vb[3], cssH: Math.round(r.height), expandBtns: document.querySelectorAll("#quotas-grid .card-expand-btn").length };
      });
      assert.equal(g850.vbH, g850.cssH, `850px SVG viewBox height (${g850.vbH}) must match CSS height (${g850.cssH})`);
      assert.equal(g850.expandBtns, 0, "850px stacked view must not show expand buttons");

      // 600px mobile expanded Codex: collapse button stays flush right on Row 1 (Neon F1).
      await page.setViewportSize({ width: 600, height: 800 });
      await page.evaluate(() => render());
      await page.locator('[data-pool="codex"] .pool-glance').click();
      const g600 = await page.evaluate(() => {
        const card = document.querySelector('[data-pool="codex"]');
        const h2 = card.querySelector(".pool-top h2").getBoundingClientRect();
        const btn = card.querySelector(".pool-full .card-expand-btn").getBoundingClientRect();
        return { sameRow: Math.abs(h2.top - btn.top) <= 14, rightGap: Math.round(card.getBoundingClientRect().right - btn.right) };
      });
      assert.ok(g600.sameRow && g600.rightGap <= 28, `600px expanded Codex collapse button must stay flush right on row 1 (${JSON.stringify(g600)})`);
      await page.locator('[data-pool="codex"] .pool-full .card-expand-btn').click();

      // Short 390x400 mobile viewport: expanding & collapsing Devin keeps focused control visible (Sol F2, Opus F5).
      await page.setViewportSize({ width: 390, height: 400 });
      await page.evaluate(() => render());
      const devinTile = page.locator('[data-pool="devin"] .pool-glance');
      await devinTile.scrollIntoViewIfNeeded();
      await devinTile.focus();
      await page.keyboard.press("Enter");
      const devinInView = await page.evaluate(() => {
        const btn = document.activeElement;
        const r = btn.getBoundingClientRect();
        return { isCollapse: btn.matches('[data-pool="devin"] .pool-full .card-expand-btn'), top: r.top, bottom: r.bottom, ih: window.innerHeight };
      });
      assert.ok(devinInView.isCollapse && devinInView.top >= 0 && devinInView.bottom <= devinInView.ih, `390x400 expanded Devin button must stay in viewport (${JSON.stringify(devinInView)})`);
      await page.keyboard.press("Enter");
      const tileInView = await page.evaluate(() => {
        const btn = document.activeElement;
        const r = btn.getBoundingClientRect();
        return { isTile: btn.matches('[data-pool="devin"] .pool-glance'), top: r.top, bottom: r.bottom, ih: window.innerHeight };
      });
      assert.ok(tileInView.isTile && tileInView.top >= 0 && tileInView.bottom <= tileInView.ih, `390x400 collapsed Devin tile must stay in viewport (${JSON.stringify(tileInView)})`);

      assert.deepEqual(errors, []);
      console.log("test_quotas_grid.cjs: all assertions passed (including Chromium 1440/1300/1200/1024/850/600/390 checks)");
    } finally {
      await browser.close();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  if (process.env.CI) {
    console.error("test_quotas_grid.cjs: Playwright not found in CI");
    process.exit(1);
  }
  console.log("test_quotas_grid.cjs: unit assertions passed (Chromium checks SKIPPED — Playwright not found)");
}
