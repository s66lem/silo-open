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
  const elements = {
    "#machines-live": fakeEl(),
    "#page-meta": fakeEl(),
    "#page-title": fakeEl(),
  };

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
      querySelector: (sel) => elements[sel] || fakeEl(),
      querySelectorAll: () => [],
      getElementById: (id) => elements[`#${id}`] || fakeEl(),
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
    "globalThis.__hExports = { state, fmtTokensExact, parseTokens, accountsPage, accountPage, renderTimePlot, weightControl };",
  );
  return { ...sandbox.__hExports, machinesRoot: elements["#machines-live"] };
}

// 1. fmtTokensExact preserves exact integers instead of silently rounding.
const d = loadDashboard(1440);
assert.equal(d.fmtTokensExact(5_000_000), "5M");
assert.equal(d.fmtTokensExact(9_999_999), "9,999,999");
assert.equal(d.parseTokens(d.fmtTokensExact(9_999_999)), 9_999_999);
assert.equal(d.fmtTokensExact(123_456), "123,456");

// 2. Accounts page: 0% ready account shows Limit reached + reset time; fallback window shows inline label; Idlenet cap renders as tag.
const now = 1_795_500_000;
d.state.provider = "all";
d.state.accountWindow = "5h";
d.state.data = {
  now,
  provider_order: ["codex", "devin", "claude"],
  accounts: [
    {
      id: "codex-plus",
      name: "PLUS 1",
      provider: "codex",
      quota_at: now - 60,
      cooldowns: [],
      windows: [{ id: "rate_limit:5h", label: "5-hour limit", remaining: 0, period: 5 * 3600, reset_at: now + 3600 }],
    },
    {
      id: "devin-max",
      name: "Devin",
      provider: "devin",
      quota_at: now - 60,
      cooldowns: [],
      windows: [{ id: "daily", label: "Daily limit", remaining: 100, period: 86400, reset_at: now + 10 * 3600 }],
    },
    {
      id: "silo:s1",
      name: "s1",
      provider: "claude",
      silo: true,
      cap_percent: 80,
      nodes: ["bishop"],
      active_node: "bishop",
      quota_at: now - 60,
      cooldowns: [],
      windows: [{ id: "five_hour", label: "5-hour limit", remaining: 90, period: 5 * 3600, reset_at: now + 7200 }],
    },
  ],
};
const acctHtml = d.accountsPage();
assert.match(acctHtml, /data-account="codex-plus"[\s\S]*Limit reached[\s\S]*Resets /, "0% account should show Limit reached with reset time");
assert.match(acctHtml, /data-account="devin-max"[\s\S]*acct-win-tag[^>]*>Daily</, "Devin daily fallback should show inline Daily window tag under 5-hour filter");
assert.match(acctHtml, /data-account="silo:s1"[\s\S]*acct-cap-tag">Cap 80%</, "Idlenet account should display Cap 80% as dedicated non-truncating tag");

// 3. Account detail: preset weight avoids Custom label; stale reading + quota_error show inline honesty indicators.
d.state.accountId = "stale-acct";
d.state.data.accounts.push({
  id: "stale-acct",
  name: "ULTRA 1",
  provider: "antigravity",
  plan_weight: 1,
  weight_override: 5,
  weight: 5,
  quota_at: now - 3600,
  quota_error: "HTTP 503 upstream timeout",
  cooldowns: [],
  windows: [{ id: "g5h", label: "5-hour limit", group: "Gemini", remaining: 88, period: 5 * 3600, reset_at: now + 3600 }],
});
const detailHtml = d.accountPage();
assert.match(detailHtml, /placeholder="Custom" value=""/, "preset 5x should not show a numeric placeholder that looks like a custom input");
assert.match(detailHtml, /weight-hint">5x \(auto 1x\)</, "preset 5x should not be labeled Custom");
assert.match(detailHtml, /Quota poll error: HTTP 503 upstream timeout/, "quota_error should render inline inside Quota card");
assert.match(detailHtml, /stale-tag">Last known</, "stale window should render Last known tag");

// 4. Dense mobile reset markers stay capped at maxLanes=2, never overlap Now or adjacent lanes, and fit two-digit pills.
const fs = require("node:fs");
const path = require("node:path");
const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
assert.match(indexHtml, /\.plot\s+text\.reset-extra\s*\{[^}]*font-size:\s*8px;/, "reset-extra must beat .plot text specificity");
assert.match(indexHtml, /\.plot\s+text\.reset-pill-text\s*\{[^}]*font-size:\s*8px;/, "reset-pill-text must beat .plot text specificity");

const dm = loadDashboard(390);
dm.state.data = { now };
const makeDenseSvg = (key, count, stepSec) => {
  const resets = Array.from({ length: count }, (_, idx) => ({
    ts: now + 600 + idx * stepSec,
    name: `acct-${idx}`,
    provider: ["claude", "codex", "antigravity", "devin", "xai"][idx % 5],
  }));
  const svg = dm.renderTimePlot({
    key,
    points: [{ ts: now - 3600, value: 100 }, { ts: now, value: 80 }],
    forecast: [{ ts: now, value: 80 }, { ts: now + 16 * 3600, value: 50 }],
    start: now - 8 * 3600,
    end: now + 16 * 3600,
    now,
    cap: 100,
    maxY: 100,
    unitMode: "raw",
    resets,
  });
  const placed = dm.state.charts[key].resets;
  assert.ok(placed.every((r) => r.lane <= 1), `${key}: mobile reset icons must stay within 2 lanes`);
  assert.equal(placed.reduce((s, r) => s + r.items.length, 0), resets.length, `${key}: all resetting accounts must remain inspectable`);
  for (const lane of [0, 1]) {
    const row = placed.filter((r) => r.lane === lane).sort((a, b) => a.box.x1 - b.box.x1);
    for (let i = 1; i < row.length; i++) {
      assert.ok(row[i - 1].box.x2 <= row[i].box.x1, `${key}: lane ${lane} reset markers must not overlap`);
    }
  }
  for (const r of placed) {
    if (r.countOnly) {
      const minW = Math.max(12, Math.ceil(String(r.items.length).length * 5.6 + 8));
      assert.ok((r.pillW || 0) >= minW, `${key}: count pill width (${r.pillW}) must fit label "${r.items.length}" (need >= ${minW})`);
    }
  }
  return svg;
};

const denseSvg12 = makeDenseSvg("dense-mobile-12", 12, 900);
const denseSvg24 = makeDenseSvg("dense-mobile-24", 24, 900);
// Packed groups spanning the full forecast horizon right up to the right plot edge trigger both +N and 2-digit count-only pills.
const packedResets = [];
for (let g = 0; g < 28; g++) {
  const ts = now + 1800 + g * 2000;
  for (let k = 0; k < 3; k++) {
    packedResets.push({
      ts,
      name: `packed-${g}-${k}`,
      provider: ["claude", "codex", "antigravity", "devin", "xai"][(g + k) % 5],
    });
  }
}
const denseSvgPacked = dm.renderTimePlot({
  key: "dense-mobile-packed",
  points: [{ ts: now - 3600, value: 100 }, { ts: now, value: 80 }],
  forecast: [{ ts: now, value: 80 }, { ts: now + 16 * 3600, value: 50 }],
  start: now - 8 * 3600,
  end: now + 16 * 3600,
  now,
  cap: 100,
  maxY: 100,
  unitMode: "raw",
  resets: packedResets,
});
const packedPlaced = dm.state.charts["dense-mobile-packed"].resets;
assert.ok(packedPlaced.some((r) => r.countOnly && r.items.length >= 10), "packed mobile resets should exercise a two-digit count-only pill");
assert.equal(packedPlaced.reduce((s, r) => s + r.items.length, 0), packedResets.length, "packed resets must keep every account");

// 6. Optional real-browser SVG bounds & mobile 4-tab wrapping verification (runs whenever Playwright is available).
let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
} catch {}

if (playwright) {
  (async () => {
    const browser = await playwright.chromium.launch({ executablePath: process.env.CHROME_PATH });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const styleMatch = indexHtml.match(/<style>[\s\S]*?<\/style>/);
      const defsMatch = indexHtml.match(/<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>/);
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8">${styleMatch[0]}</head><body>
        ${defsMatch[0]}
        <main class="shell"><div class="content"><div id="page-body">
          <section class="pool" id="test-xai-card">
            <div class="pool-top">
              <div class="pool-id"><h2>xAI</h2><span class="pool-count">1 account</span></div>
              <div class="segmented pool-windows" role="group" aria-label="Quota window for xAI">
                <button class="active">Weekly credits</button><button>GrokBot</button><button>GrokChat</button><button>GrokBuild</button>
              </div>
            </div>
            <div class="plot" id="plot-12">${denseSvg12}</div>
            <div class="plot" id="plot-24">${denseSvg24}</div>
            <div class="plot" id="plot-packed">${denseSvgPacked}</div>
          </section>
        </div></div></main>
      </body></html>`);
      const check = await page.evaluate(() => {
        const card = document.querySelector("#test-xai-card").getBoundingClientRect();
        const tabs = document.querySelector("#test-xai-card .pool-windows").getBoundingClientRect();
        const scrollW = document.documentElement.scrollWidth;
        const innerW = window.innerWidth;
        const issues = [];
        let sawExtra = false;
        let sawTwoDigitPill = false;
        // Measure each visual piece in screen coordinates: clipped <use> viewport box via CTM,
        // and real rendered getBoundingClientRect() for <rect> and <text> (catches CSS font-size overrides).
        const childBox = (svg, el) => {
          if (el.tagName.toLowerCase() === "use") {
            const ctm = svg.getScreenCTM();
            const x = Number(el.getAttribute("x") || 0);
            const y = Number(el.getAttribute("y") || 0);
            const w = Number(el.getAttribute("width") || 0);
            const h = Number(el.getAttribute("height") || 0);
            const p1 = new DOMPoint(x, y).matrixTransform(ctm);
            const p2 = new DOMPoint(x + w, y + h).matrixTransform(ctm);
            return { left: p1.x, top: p1.y, right: p2.x, bottom: p2.y };
          }
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        for (const plotId of ["#plot-12", "#plot-24", "#plot-packed"]) {
          const svg = document.querySelector(`${plotId} svg`);
          const labels = [...document.querySelectorAll(`${plotId} .reset-label`)];
          const rects = labels.map((g, idx) => {
            const kids = [...g.children].filter((c) => c.tagName.toLowerCase() !== "title");
            const boxes = kids.map((c) => childBox(svg, c));
            const box = {
              left: Math.min(...boxes.map((b) => b.left)),
              top: Math.min(...boxes.map((b) => b.top)),
              right: Math.max(...boxes.map((b) => b.right)),
              bottom: Math.max(...boxes.map((b) => b.bottom)),
            };
            const extra = g.querySelector(".reset-extra");
            if (extra) {
              sawExtra = true;
              const fs = getComputedStyle(extra).fontSize;
              if (fs !== "8px") issues.push(`${plotId}[${idx}]: .reset-extra fontSize=${fs}`);
            }
            const pillRect = g.querySelector("rect");
            const pillText = g.querySelector(".reset-pill-text");
            if (pillRect && pillText) {
              if (Number(pillText.textContent) >= 10) sawTwoDigitPill = true;
              const fs = getComputedStyle(pillText).fontSize;
              if (fs !== "8px") issues.push(`${plotId}[${idx}]: .reset-pill-text fontSize=${fs}`);
              const pr = pillRect.getBoundingClientRect();
              const tr = pillText.getBoundingClientRect();
              if (tr.left < pr.left - 0.5 || tr.right > pr.right + 0.5 || tr.top < pr.top - 0.5 || tr.bottom > pr.bottom + 0.5) {
                issues.push(`${plotId}[${idx}]: pill text "${pillText.textContent}" (${tr.width.toFixed(1)}x${tr.height.toFixed(1)}) overflows pill (${pr.width.toFixed(1)}x${pr.height.toFixed(1)})`);
              }
            }
            return { idx, box };
          });
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i].box, b = rects[j].box;
              const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (overlapX > 0.5 && overlapY > 0.5) {
                issues.push(`${plotId}: marker ${i} and ${j} intersect (${overlapX.toFixed(1)}x${overlapY.toFixed(1)}px)`);
              }
            }
          }
        }
        return { cardRight: card.right, tabsRight: tabs.right, scrollW, innerW, issues, sawExtra, sawTwoDigitPill };
      });
      assert.ok(check.sawExtra, "Chromium SVG test must exercise .reset-extra");
      assert.ok(check.sawTwoDigitPill, "Chromium SVG test must exercise a two-digit .reset-count-pill");
      assert.ok(check.tabsRight <= check.cardRight + 0.5, `4-tab xAI selector (${check.tabsRight}) must stay inside card (${check.cardRight})`);
      assert.ok(check.scrollW <= check.innerW, `mobile page must not overflow horizontally (${check.scrollW} > ${check.innerW})`);
      assert.deepEqual(check.issues, [], `SVG marker bounds check failed: ${check.issues.join("; ")}`);
      console.log("test_hillclimb_ui.cjs: all assertions passed (including Chromium SVG bounds & 4-tab mobile wrap)");
    } finally {
      await browser.close();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.log("test_hillclimb_ui.cjs: all assertions passed");
}
