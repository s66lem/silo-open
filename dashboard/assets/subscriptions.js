let billingMonthOffset = 0;
let showSeatEstimates = false;
const billingMoney = cents => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const monthNumber = date => date.getFullYear() * 12 + date.getMonth();
const monthStart = number => new Date(Math.floor(number / 12), number % 12, 1);
const billingISO = date => [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, "0")).join("-");
const civilDate = iso => new Date(iso + "T12:00:00");
const intervalPrice = t => `${billingMoney(t.cents)}\u00a0/\u00a0${t.cycle === "yearly" ? "yr" : "mo"}`;
const annualCents = t => t.cents * (t.cycle === "yearly" ? 1 : 12);

function providerTerms(account) {
  const profile = account.detail?.provider_fields || {};
  const trial = profile.trial_ends && profile.trial_ends * 1000 >= new Date().setHours(0, 0, 0, 0);
  const stamp = trial ? profile.trial_ends : profile.subscription_until;
  return { kind: trial ? "reported-trial" : "untracked", date: stamp ? billingISO(new Date(stamp * 1000)) : "" };
}

// Always clamp from the original billing day so a short February doesn't shift March.
function billingEvent(terms, month) {
  if (!terms.date || terms.kind === "estimate" || terms.kind === "free") return null;
  const anchor = civilDate(terms.date);
  const gap = month - monthNumber(anchor);
  if (gap < 0) return null;
  const recurring = terms.kind === "paid" || terms.kind === "trial-renews";
  if (gap && (!recurring || (terms.cycle === "yearly" && gap % 12))) return null;
  const day = monthStart(month);
  const last = monthStart(month + 1);
  last.setDate(0);
  day.setDate(Math.min(anchor.getDate(), last.getDate()));
  const labels = { "trial": "Trial ends", "reported-trial": "Reported trial end", "untracked": "Reported paid-through date" };
  return { day, label: labels[terms.kind] || (terms.kind === "trial-renews" && !gap ? "Trial converts" : "Renewal"),
    amount: terms.kind === "trial" ? "No charge" : terms.cents == null ? "Price unknown" : billingMoney(terms.cents) };
}

function nextBillingEvent(t, today) {
  if (!t.date) return null;
  const anchorMonth = monthNumber(civilDate(t.date));
  const current = Math.max(anchorMonth, monthNumber(today));
  const step = t.cycle === "yearly" ? 12 : 1;
  const candidate = anchorMonth + Math.ceil((current - anchorMonth) / step) * step;
  const event = billingEvent(t, candidate);
  return event && billingISO(event.day) < billingISO(today) ? billingEvent(t, candidate + step) : event;
}

const representsSubscription = account => !account.billing_id || account.billing_id === account.id;
const schedulesCharge = terms => terms?.kind === "paid" || terms?.kind === "trial-renews";

function subscriptionTarget(account) {
  if (!account) return null;
  if (account.billing_id && account.billing_id !== account.id) {
    return state.data?.accounts?.find(a => a.id === account.billing_id) || account;
  }
  return account;
}

function subscriptionSummary(account) {
  const target = subscriptionTarget(account);
  if (!target) return null;
  const today = new Date(), todayISO = billingISO(today);
  const t = target.subscription || providerTerms(target);
  let status, next = null;
  if (target.silo) {
    status = t.kind === "estimate" ? `${intervalPrice(t)} (estimate)` : "Estimate not set";
  } else {
    next = nextBillingEvent(t, today);
    if (t.kind === "paid" || (t.kind === "trial-renews" && t.date <= todayISO)) status = intervalPrice(t);
    else if (t.kind === "free") status = "Free / cancelled";
    else if (t.kind === "trial-renews") status = `Free trial · then ${intervalPrice(t)}`;
    else if (t.kind === "trial") status = t.date < todayISO ? "Trial ended" : "Free trial · expires";
    else status = t.kind === "reported-trial" ? "Reported trial · terms unconfirmed" : "Billing not set";
  }
  return { editId: target.id, status, next, isSet: Boolean(target.subscription) };
}

function openSubscriptionEditor(id) {
  const raw = state.data?.accounts?.find(a => a.id === id);
  const account = subscriptionTarget(raw);
  if (!account) return;
  const t = account.subscription || providerTerms(account);
  $("#sub-account").textContent = labelFor(account);
  $("#sub-form").dataset.account = account.id;
  $("#sub-kind").innerHTML = account.silo ? '<option value="estimate">Hypothetical seat cost</option>' :
    '<option value="paid">Paid subscription</option><option value="trial">Free trial · expires</option><option value="trial-renews">Free trial · converts to paid</option><option value="free">Free / cancelled</option>';
  if (account.subscription) $("#sub-kind").add(new Option("Clear saved terms", "clear"));
  $("#sub-kind").value = account.silo ? "estimate" : ({ "reported-trial": "trial", untracked: "paid" }[t.kind] || t.kind);
  $("#sub-amount").value = t.cents == null ? "" : (t.cents / 100).toFixed(2);
  $("#sub-cycle").value = t.cycle || "monthly";
  $("#sub-date").value = t.date || "";
  $("#sub-error").textContent = "";
  updateBillingFields();
  $("#sub-dialog").showModal();
}

function updateRenewalAlert(accounts) {
  const today = new Date(), through = new Date(today);
  through.setDate(through.getDate() + 3);
  const lastDate = billingISO(through);
  let count = 0, cents = 0;
  for (const account of accounts) {
    const terms = account.subscription;
    if (account.silo || !representsSubscription(account) || !schedulesCharge(terms)) continue;
    const next = nextBillingEvent(terms, today);
    if (next && billingISO(next.day) <= lastDate) {
      count++;
      cents += terms.cents;
    }
  }
  const badge = $("#nav-renewals");
  badge.hidden = !count;
  badge.textContent = count ? `${count} · ${billingMoney(cents)}` : "";
  badge.parentElement.title = count ? `${count} account${count === 1 ? "" : "s"} renewing within 3 days · ${billingMoney(cents)}` : "";
  if (count) badge.parentElement.setAttribute("aria-label", `Subscriptions, ${badge.parentElement.title}`);
  else badge.parentElement.removeAttribute("aria-label");
}

function renewalCalendar(month, events, todayISO) {
  const first = monthStart(month), end = monthStart(month + 1);
  end.setDate(0);
  const byDay = new Map();
  for (const event of events) {
    const day = event.day.getDate();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }
  const weeks = [];
  for (let start = 1 - first.getDay(); start <= end.getDate(); start += 7) {
    const cells = [];
    for (let day = start; day < start + 7; day++) {
      if (day < 1 || day > end.getDate()) {
        cells.push("<td></td>");
        continue;
      }
      const date = new Date(first.getFullYear(), first.getMonth(), day);
      const iso = billingISO(date), entries = byDay.get(day) || [];
      const details = entries.map(e => `<button type="button" class="billing-event provider-${e.color}" data-sub-edit="${e.editId}" title="${e.providerName} · Edit billing"><strong>${e.labelAccount}</strong><small>${e.label} · ${e.amount}</small></button>`).join("");
      const dots = [...new Set(entries.map(e => e.color))].map(color => `<i class="billing-dot provider-${color}" aria-hidden="true"></i>`).join("");
      const count = entries.length ? `<small class="billing-day-count" aria-label="${entries.length} scheduled events">${dots}${entries.length}</small>` : "";
      const today = iso === todayISO, past = iso < todayISO;
      cells.push(`<td${today ? ' class="billing-today"' : past ? ' class="billing-past"' : ""}><time class="billing-day" datetime="${iso}"${today ? ' aria-current="date"' : ""}>${day}</time>${today ? '<span class="today-label">Today</span>' : ""}${details}${count}</td>`);
    }
    weeks.push(`<tr>${cells.join("")}</tr>`);
  }
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `<table class="billing-calendar" aria-labelledby="billing-month"><thead><tr>${weekdays.map(d => `<th scope="col">${d}</th>`).join("")}</tr></thead><tbody>${weeks.join("")}</tbody></table>`;
}

function subscriptionsPage() {
  const today = new Date(), todayISO = billingISO(today);
  const month = monthNumber(today) + billingMonthOffset;
  const events = [], rows = [], seats = [];
  let due = 0, spend = 0, estimate = 0, missing = 0, unpricedSeats = 0, trials = 0;
  for (const account of state.data.accounts) {
    if (!representsSubscription(account)) continue;
    const label = esc(labelFor(account)), t = account.subscription || providerTerms(account);
    let status, next;
    if (account.silo) {
      if (t.kind === "estimate") estimate += annualCents(t);
      else unpricedSeats++;
      status = t.kind === "estimate" ? intervalPrice(t) : "Estimate not set";
    } else {
      const event = billingEvent(t, month);
      next = nextBillingEvent(t, today);
      if (event) {
        events.push({ ...event, editId: esc(account.id), labelAccount: label, providerName: esc(pName(account.provider)),
          color: Object.hasOwn(PROVIDERS, account.provider) ? account.provider : "other" });
        if (schedulesCharge(t)) due += t.cents;
      }
      // Active trials count at their post-trial price so the total reflects committed spend.
      if (schedulesCharge(t)) spend += annualCents(t);
      if (t.kind === "paid" || (t.kind === "trial-renews" && t.date <= todayISO)) status = intervalPrice(t);
      else if (t.kind === "free") status = "Free";
      else if (t.kind === "trial-renews") {
        trials++;
        status = `Free trial · then ${intervalPrice(t)}`;
      }
      else if (t.kind === "trial") status = t.date < todayISO ? "Trial ended" : "Free trial · expires";
      else {
        missing++;
        status = t.kind === "reported-trial" ? "Reported trial · terms unconfirmed" : "Billing not set";
      }
    }
    const row = `<div class="sub-row sub-acct-row"><div class="sub-acct-id">${providerIcon(account.provider)}<div><a class="account-label" href="${accountPath(account)}" data-open-account="${esc(account.id)}">${label}</a><small>${esc(subLine([pName(account.provider), planLabel(account.plan)]))}</small></div></div>
      <div class="sub-billing">${status}${next ? `<small>${next.label} · ${next.day.toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"})}</small>` : ""}</div><button class="outline sm" data-sub-edit="${esc(account.id)}" aria-label="Edit billing for ${label}">Edit</button></div>`;
    (account.silo ? seats : rows).push(row);
  }
  events.sort((a, b) => a.day - b.day);
  const agenda = events.map(e => `<button type="button" class="sub-row sub-agenda-row" data-sub-edit="${e.editId}" title="Edit billing for ${e.labelAccount}"><time datetime="${billingISO(e.day)}">${e.day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</time><i class="billing-dot provider-${e.color}" title="${e.providerName}"></i>
    <div><strong>${e.labelAccount}</strong><small>${e.label}</small></div><span>${e.amount}</span></button>`).join("");
  const withSeats = billingMoney(Math.round((spend + estimate) / 12));
  const estimateLabel = unpricedSeats === seats.length ? "Idlenet seats unpriced"
    : `${withSeats} w/ idlenet${unpricedSeats ? ` · ${unpricedSeats} unpriced` : ""}`;
  return `<section class="sub-card"><div class="sub-head"><h2>Monthly subscription spend</h2></div><div class="sub-metric"><div class="monthly-totals"><span>${billingMoney(Math.round(spend / 12))}</span>${seats.length ? `<span class="seat-total" title="Includes hypothetical Idlenet seat estimates">${estimateLabel}</span>` : ""}</div><small>USD per month · annual plans averaged over 12 months${trials ? ` · includes ${trials} free trial${trials === 1 ? "" : "s"} at post-trial price` : ""}${seats.length ? " · Idlenet total is hypothetical" : ""}</small></div>
    ${missing ? `<p class="muted">${missing} account${missing === 1 ? "" : "s"} with unconfirmed billing excluded.</p>` : ""}</section>
    <section class="sub-card" aria-label="Renewal calendar"><div class="sub-head"><div class="sub-head-id"><h2 id="billing-month">${monthStart(month).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2><span class="sub-sched">${billingMoney(due)} scheduled</span></div>
    <div><button class="outline sm" data-sub-month="-1" aria-label="Previous month">‹</button> <button class="outline sm" data-sub-month="0">This month</button> <button class="outline sm" data-sub-month="1" aria-label="Next month">›</button></div></div>
    ${renewalCalendar(month, events, todayISO)}
    ${agenda ? `<div class="billing-agenda">${agenda}</div>` : '<p class="muted">No renewals or trial deadlines this month.</p>'}</section>
    <section class="sub-card"><div class="sub-head"><h2>Account subscriptions</h2></div>${rows.join("") || '<p class="muted">No personal accounts.</p>'}</section>
    ${seats.length ? `<section class="sub-card"><div class="sub-head"><div class="sub-head-id"><h2>Idlenet seats</h2></div><button class="outline sm" data-sub-estimates aria-expanded="${showSeatEstimates}">${showSeatEstimates ? "Hide" : "Show"} hypothetical cost</button></div><p class="muted sub-card-desc">Hypothetical seat cost estimates for shared Idlenet accounts; excluded from your scheduled renewals.</p>
    ${showSeatEstimates ? `<div class="sub-metric">${billingMoney(Math.round(estimate / 12))}<small>Estimated USD per month${unpricedSeats ? ` · ${unpricedSeats} unpriced` : ""}</small></div>${seats.join("")}` : ""}</section>` : ""}`;
}

function updateBillingFields() {
  const kind = $("#sub-kind").value, hasPrice = ["paid", "trial-renews", "estimate"].includes(kind);
  for (const [selector, visible] of [["#sub-amount", hasPrice], ["#sub-cycle", hasPrice], ["#sub-date", ["paid", "trial", "trial-renews"].includes(kind)]]) {
    const field = $(selector);
    field.disabled = !visible;
    field.closest(".field").hidden = !visible;
  }
  $('label[for="sub-date"]').textContent = kind.startsWith("trial") ? "Trial end date" : "Next renewal date";
  $('label[for="sub-amount"]').textContent = kind === "trial-renews" ? "Price after trial (USD)" : "Price per billing interval (USD)";
}

document.addEventListener("click", e => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-sub-month")) {
    const step = Number(button.dataset.subMonth);
    billingMonthOffset = step ? billingMonthOffset + step : 0;
    render();
  } else if (button.hasAttribute("data-sub-estimates")) {
    showSeatEstimates = !showSeatEstimates;
    render();
  } else if (button.hasAttribute("data-sub-edit")) {
    openSubscriptionEditor(button.dataset.subEdit);
  }
});

document.getElementById("sub-kind").addEventListener("change", updateBillingFields);
document.getElementById("sub-cancel").addEventListener("click", () => $("#sub-dialog").close());
document.getElementById("sub-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.currentTarget, id = form.dataset.account;
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  $("#sub-cancel").disabled = true;
  try {
    const terms = await api("account/subscription", { id, kind: $("#sub-kind").value,
      ...($("#sub-amount").disabled ? {} : { cents: Math.round($("#sub-amount").valueAsNumber * 100), cycle: $("#sub-cycle").value }),
      ...($("#sub-date").disabled ? {} : { date: $("#sub-date").value }) });
    const value = terms.cleared ? null : terms;
    for (const a of state.data?.accounts || []) {
      if (a.id === id || a.billing_id === id) a.subscription = value;
    }
    $("#sub-dialog").close();
    render();
    load();
  } catch (err) {
    $("#sub-error").textContent = err.message;
  } finally {
    submit.disabled = false;
    $("#sub-cancel").disabled = false;
  }
});
document.getElementById("sub-dialog").addEventListener("cancel", e => {
  if ($("#sub-cancel").disabled) e.preventDefault();
});
