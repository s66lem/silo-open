const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

// Real dashboard HTTP handlers and an isolated SQLite ledger, without any upstream calls.
const fixture = `
import tempfile
from pathlib import Path
import server as s
with tempfile.TemporaryDirectory() as folder:
    s.SILO_REGISTRY = Path(folder) / "registry.json"
    s.SILO_REGISTRY.write_text(s.json.dumps([dict(provider="claude", node="sample", seat="seat",
        silo_cpa_base="http://offline.invalid", cpakey="fixture", hub_auth_name="Shared seat")]))
    hub = s.Hub(s.Store(Path(folder) / "ledger.sqlite"))
    hub.management_key = lambda: "fixture"
    hub.files = [dict(auth_index=k, name=k+".json", email=k, provider="codex") for k in ("Paid", "Trial")]
    hub.files[0]["id_token"] = {"chatgpt_account_id": "fixture-account"}
    hub.files[1]["provider"] = "claude"
    hub.files.append(dict(hub.files[0], auth_index="Paid-pro", name="paid-pro.json"))
    with s.ThreadingHTTPServer(("127.0.0.1", 0), s.Handler) as http:
        http.hub = hub
        s.LOCAL_HOSTS.add("127.0.0.1:"+str(http.server_port))
        print(http.server_port, flush=True)
        http.serve_forever()
`;

(async () => {
  const server = spawn(process.env.PYTHON || "python", ["-u", "-c", fixture], { cwd: __dirname, stdio: ["ignore", "pipe", "inherit"] });
  let browser;
  try {
    const [port] = await once(server.stdout, "data");
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.setFixedTime(new Date(2028, 0, 10, 12));
    await page.goto(`http://127.0.0.1:${String(port).trim()}/dashboard/subscriptions`);
    await page.getByLabel("Management key", {exact: true}).fill("fixture");
    await page.getByRole("button", {name: "Open dashboard", exact: true}).click();
    const edit = async (name, kind, price, date, cycle = "monthly") => {
      await page.getByRole("button", {name: "Edit billing for " + name, exact: true}).click();
      await page.locator("#sub-kind").selectOption(kind);
      if (price != null) {
        await page.locator("#sub-amount").fill(price);
        await page.locator("#sub-cycle").selectOption(cycle);
      }
      if (date) await page.locator("#sub-date").fill(date);
      await page.getByRole("button", {name: "Save", exact: true}).click();
      await page.locator("#sub-dialog").waitFor({state: "hidden"});
    };
    const calendar = page.getByRole("region", {name: "Renewal calendar"});
    const grid = calendar.getByRole("table");
    const day = iso => grid.locator('td').filter({has: page.locator('time[datetime="' + iso + '"]')});
    const badge = page.locator("#nav-renewals");
    assert.equal(await page.locator("[data-sub-edit='silo:Shared seat']").count(), 0);
    await edit("Paid", "paid", "20", "2028-01-31");
    assert.equal(await grid.locator("th").count(), 7);
    assert.equal(await grid.locator("tbody tr").count(), 6);
    assert.equal(await grid.locator("time").count(), 31);
    assert.equal(await grid.locator('[aria-current="date"]').getAttribute("datetime"), "2028-01-10");
    assert.equal(await day("2028-01-10").locator(".today-label").innerText(), "Today");
    assert.equal(await grid.locator("tbody tr").first().locator("td").last().innerText(), "1");
    assert.equal(await day("2028-01-31").locator(".billing-event").count(), 1);
    await edit("Trial", "trial-renews", "120", "2028-02-29", "yearly");
    await page.getByRole("button", {name: "Show hypothetical cost"}).click();
    await edit("Shared seat", "estimate", "200");
    const combined = page.locator(".seat-total");
    assert.equal(await combined.innerText(), "$230.00 w/ idlenet");
    assert.equal(await page.locator(".monthly-totals > span").first().innerText(), "$30.00");
    assert.ok(await combined.evaluate(el => getComputedStyle(el).fontStyle === "normal"
      && parseFloat(getComputedStyle(el).fontSize) < parseFloat(getComputedStyle(el.parentElement).fontSize)));
    assert.match(await page.locator(".sub-metric").first().innerText(), /\$30\.00/);
    assert.match(await page.locator(".sub-metric").first().innerText(), /includes 1 free trial at post-trial price/);
    assert.match(await page.locator(".sub-metric").last().innerText(), /\$200\.00/);
    await page.getByRole("button", {name: "Next month"}).click();
    assert.equal(await grid.locator("time").count(), 29);
    assert.equal(await day("2028-02-29").locator(".billing-event").count(), 2);
    assert.equal(await grid.locator(".today-label").count(), 0);
    const chipColors = await day("2028-02-29").locator(".billing-event").evaluateAll(
      els => els.map(el => getComputedStyle(el).borderLeftColor));
    assert.equal(new Set(chipColors).size, 2);
    assert.match(await calendar.innerText(), /Trial converts/);
    assert.match(await calendar.innerText(), /\$140\.00 scheduled/);
    assert.doesNotMatch(await calendar.innerText(), /Shared seat/);
    assert.equal(await badge.isVisible(), false);
    await page.clock.setFixedTime(new Date(2028, 1, 25, 12));
    await page.locator('[data-page="accounts"]').click();
    assert.equal(await badge.isVisible(), false); // Four days ahead.
    await page.clock.setFixedTime(new Date(2028, 1, 26, 12));
    await page.reload();
    await badge.waitFor();
    assert.equal(await badge.innerText(), "2 · $140.00"); // Inclusive third day, full annual charge.
    await page.locator('[data-page="subscriptions"]').click();
    await page.getByRole("button", {name: "Next month"}).click();
    assert.equal(await badge.innerText(), "2 · $140.00"); // Independent of the viewed month.
    await page.clock.setFixedTime(new Date(2028, 1, 29, 23, 59));
    await page.getByRole("button", {name: "This month"}).click();
    assert.equal(await badge.innerText(), "2 · $140.00");
    await page.setViewportSize({width: 375, height: 800});
    assert.equal(await day("2028-02-29").locator(".billing-day-count").isVisible(), true);
    assert.equal(await day("2028-02-29").locator(".today-label").isVisible(), true);
    assert.equal(await day("2028-02-29").locator(".billing-dot").count(), 2);
    assert.match(await calendar.locator(".billing-agenda").innerText(), /Trial converts/);
    assert.ok(await grid.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    await page.setViewportSize({width: 1280, height: 800});
    await page.clock.setFixedTime(new Date(2028, 2, 1, 12));
    await page.reload();
    await page.locator(".sub-metric").first().waitFor();
    assert.equal(await combined.innerText(), "$230.00 w/ idlenet");
    assert.match(await page.locator(".sub-metric").first().innerText(), /\$30\.00/);
    assert.equal(await badge.isVisible(), false);
    assert.equal(await day("2028-03-31").locator(".billing-event").count(), 1);
    await edit("Trial", "trial", null, "2028-03-15");
    assert.match(await calendar.innerText(), /No charge/);
    assert.match(await calendar.innerText(), /\$20\.00 scheduled/);
    assert.match(await page.locator(".sub-metric").first().innerText(), /\$20\.00/);
    await page.getByRole("button", {name: "Show hypothetical cost"}).click();
    await edit("Shared seat", "clear");
    assert.equal(await combined.innerText(), "Idlenet seats unpriced");
    assert.match(await page.locator(".sub-metric").last().innerText(), /1 unpriced/);
    await edit("Trial", "trial", null, "2028-03-02");
    assert.equal(await badge.isVisible(), false); // A trial ending without a charge.
    await edit("Trial", "paid", "9.99", "2028-04-01");
    await page.clock.setFixedTime(new Date(2028, 2, 30, 12));
    await page.getByRole("button", {name: "This month"}).click();
    assert.equal(await badge.innerText(), "2 · $29.99"); // Window crosses a month boundary.
    assert.deepEqual(errors, []);
    console.log("Subscription editor, calendar, trial conversion, shared estimates and reload passed.");
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
