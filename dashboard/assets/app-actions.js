// Account menu, rename, remove and cooldown reset, and the Logs page.
"use strict";
// ---- Account actions (shadcn DropdownMenu) ----
const menu = $("#account-menu");
let menuTrigger = null;
const accountById = (id) => state.data?.accounts.find((a) => a.id === id);
const labelFor = (a) => accountLabel(a, state.data.accounts.indexOf(a));
const canResetCooldown = (a) =>
  Boolean(
    a.unavailable ||
    a.cooldowns?.length ||
    (a.cooldown_until && a.cooldown_until > Date.now() / 1000),
  );
const menuItems = () =>
  $$('.menu-item:not([aria-disabled="true"]):not([hidden])', menu);
function positionMenu() {
  if (!menuTrigger) return;
  const r = menuTrigger.getBoundingClientRect(),
    w = menu.offsetWidth,
    h = menu.offsetHeight;
  const below = r.bottom + 4 + h <= innerHeight - 8;
  menu.style.top = `${below ? r.bottom + 4 : r.top - 4 - h}px`;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  menu.style.transformOrigin = below ? "top right" : "bottom right";
}
function openMenu(trigger, focusFirst) {
  const a = accountById(trigger.dataset.menu);
  if (!a) return;
  if (menuTrigger) closeMenu(false);
  menuTrigger = trigger;
  menu.dataset.account = a.id;
  const isSilo = !!a.silo;
  $('[data-action="relogin"]', menu).hidden = isSilo;
  $('[data-action="cooldown"]', menu).hidden = isSilo;
  $('[data-action="remove"]', menu).hidden = isSilo;
  $(".menu-separator", menu).hidden = isSilo;
  $('[data-action="cooldown"]', menu).setAttribute(
    "aria-disabled",
    String(!canResetCooldown(a)),
  );
  const useReset = $('[data-action="use-reset"]', menu);
  useReset.hidden = isSilo || !a.resets?.items?.length;
  useReset.setAttribute("aria-disabled", String(!a.resets?.available));
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  positionMenu();
  if (focusFirst) menuItems()[0]?.focus();
}
function closeMenu(returnFocus = true) {
  if (!menuTrigger) return;
  const trigger = menuTrigger;
  menuTrigger = null;
  menu.hidden = true;
  if (trigger.isConnected) {
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus();
  }
}
// The 30 s patch re-renders rows; keep an open menu attached to its trigger.
function syncMenu() {
  if (!menuTrigger) return;
  const trigger = $(
    `[data-menu="${CSS.escape(menu.dataset.account || "")}"]`,
  );
  if (!trigger) return closeMenu(false);
  menuTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
  positionMenu();
}
menu.addEventListener("keydown", (e) => {
  const items = menuItems(),
    i = items.indexOf(document.activeElement);
  const target = {
    ArrowDown: i + 1,
    ArrowUp: i - 1,
    Home: 0,
    End: items.length - 1,
  }[e.key];
  if (target !== undefined) {
    e.preventDefault();
    items[(target + items.length) % items.length]?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "Tab") closeMenu(false);
});
menu.addEventListener("click", (e) => {
  const item = e.target.closest(".menu-item");
  if (!item || item.getAttribute("aria-disabled") === "true") return;
  const id = menu.dataset.account,
    action = item.dataset.action;
  closeMenu(action === "cooldown");
  if (action === "rename") startRename(id);
  else if (action === "subscription") {
    if (typeof openSubscriptionEditor === "function") openSubscriptionEditor(id);
  } else if (action === "relogin") relogin(id);
  else if (action === "cooldown") resetCooldown(id);
  else if (action === "remove") confirmRemove(id);
  else if (action === "use-reset") confirmReset(id);
});
document.addEventListener(
  "pointerdown",
  (e) => {
    if (
      menuTrigger &&
      !menu.contains(e.target) &&
      !menuTrigger.contains(e.target)
    )
      closeMenu(false);
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuTrigger) closeMenu();
});
addEventListener("scroll", positionMenu, true);
addEventListener("resize", positionMenu);
$("#page-body").addEventListener("keydown", (e) => {
  const trigger = e.target.closest?.("[data-menu]");
  if (!trigger || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
  e.preventDefault();
  openMenu(trigger, true);
});

// Inline rename on the Accounts page: Enter saves, Escape cancels. The draft lives
// in state so snapshot updates re-render the field without losing what was typed.
function startRename(id) {
  const a = accountById(id);
  if (!a) return;
  if (!["accounts", "account"].includes(state.page)) navigate("accounts");
  state.renaming = id;
  state.renameDraft = a.silo && a.nickname === a.name ? "" : (a.nickname || "");
  render();
  const input = $(`[data-rename="${CSS.escape(id)}"]`);
  input?.focus();
  input?.select();
}
function stopRename(returnFocus = true) {
  const id = state.renaming;
  state.renaming = null;
  render();
  if (returnFocus && id) $(`[data-menu="${CSS.escape(id)}"]`)?.focus();
}
async function saveRename(input) {
  const id = input.dataset.rename,
    a = accountById(id);
  if (!a || input.dataset.saving) return;
  const nickname = input.value.trim();
  input.dataset.saving = "1";
  try {
    const r = await api("account/rename", { id, nickname });
    a.nickname = r.nickname || (a.silo ? a.name : "");
    state.renaming = null;
    notify(
      r.nickname ? "Account renamed" : "Nickname cleared",
      "success",
      r.nickname ? `Now shown as ${r.nickname}.` : `${a.email || a.name || "The account"} shows its ${a.silo ? "default name" : "email"} again.`,
    );
    render();
    $(`[data-menu="${CSS.escape(id)}"]`)?.focus();
    await load();
  } catch (e) {
    delete input.dataset.saving;
    notify("Couldn't rename the account", "error", e.message);
  }
}
$("#page-body").addEventListener("input", (e) => {
  if (e.target.matches?.("[data-rename]")) state.renameDraft = e.target.value;
});
$("#page-body").addEventListener("keydown", (e) => {
  if (!e.target.matches?.("[data-rename]")) return;
  if (e.key === "Enter") {
    e.preventDefault();
    saveRename(e.target);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    stopRename();
  }
});
$("#page-body").addEventListener("focusout", (e) => {
  if (e.target.matches?.("[data-rename]") && !e.target.dataset.saving && state.renaming)
    setTimeout(() => state.renaming && !document.activeElement?.matches?.("[data-rename]") && stopRename(false), 0);
});
async function resetCooldown(id) {
  const a = accountById(id);
  try {
    await api("account/cooldown", { id });
    notify(
      "Cooldown cleared",
      "success",
      `${a ? labelFor(a) : "The account"} is back in rotation.`,
    );
    await load();
  } catch (e) {
    notify("Couldn't reset the cooldown", "error", e.message);
  }
}

// One confirmation dialog for every action that can't be undone.
let confirmAction = null;
function askConfirm(action) {
  confirmAction = action;
  const button = $("#confirm-remove");
  $("#confirm-title").textContent = action.title;
  $("#confirm-description").textContent = action.description;
  button.idleHTML = esc(action.label);
  setBusy(button, false);
  $("#confirm-dialog").showModal();
  $("#confirm-cancel").focus();
}
function confirmRemove(id) {
  const a = accountById(id);
  if (!a) return;
  askConfirm({
    title: `Remove ${labelFor(a)}?`,
    description:
      "The proxy stops using this login and deletes its credential file. This can’t be undone.",
    label: "Remove",
    busy: "Removing…",
    failure: "Couldn't remove the account",
    returnFocus: () => $(`[data-menu="${CSS.escape(id)}"]`)?.focus(),
    run: () => api("account/remove", { id }),
    async done() {
      notify(
        "Account removed",
        "success",
        `${labelFor(a)} is no longer in the pool.`,
      );
      if (state.page === "account") navigate("accounts");
      await load();
    },
  });
}
$("#confirm-cancel").addEventListener("click", () =>
  $("#confirm-dialog").close(),
);
$("#confirm-dialog").addEventListener("close", () => {
  const action = confirmAction;
  confirmAction = null;
  action?.returnFocus?.();
});
$("#confirm-remove").addEventListener("click", async () => {
  const action = confirmAction;
  if (!action) return;
  setBusy($("#confirm-remove"), true, action.busy);
  let result;
  try {
    result = await action.run();
  } catch (e) {
    setBusy($("#confirm-remove"), false);
    notify(action.failure, "error", e.message);
    return;
  }
  confirmAction = null;
  $("#confirm-dialog").close();
  action.done(result);
});

// ---- Manual resets ----
// Codex spends one of the account's reset credits; Claude claims a chosen
// banked grant. Both are limited, so the dialog always confirms first.
let resetTarget = null;
function resetError(text) {
  $("#reset-error").textContent = text || "";
  $("#reset-error").hidden = !text;
}
let resetRead = 0;
async function confirmReset(id) {
  const a = accountById(id);
  if (!a?.resets) return;
  const label = labelFor(a),
    claude = a.provider === "claude";
  resetTarget = id;
  $("#reset-title").textContent = `Use a reset on ${label}?`;
  $("#reset-description").textContent =
    "Choose a reset. It clears this account's usage limits right away and can't be given back.";
  const read = ++resetRead;
  $("#reset-list").replaceChildren();
  resetError("");
  setBusy($("#reset-confirm"), true, "Checking resets…");
  $("#reset-dialog").showModal();
  $("#reset-cancel").focus();
  let resets = a.resets;
  if (!claude) {
    try {
      resets = await api("account/reset-options", { id });
    } catch (e) {
      if (read === resetRead) {
        setBusy($("#reset-confirm"), false);
        $("#reset-confirm").disabled = true;
        resetError(e.message);
      }
      return;
    }
    if (read !== resetRead) return;
    load();
  }
  const items = resets.available ? resets.items : [];
  if (!items.length) $("#reset-description").textContent = "This account has no resets available.";
  const firstUsable = items.find((g) => !g.reason && g.left > 0);
  const until = (ts) => {
    const days = Math.round((ts - Date.now() / 1000) / 86400);
    return days >= 1 ? `in ${days} day${days === 1 ? "" : "s"}` : relative(ts);
  };
  const when = (g) =>
    g.expires_at
      ? `<span class="reset-row-when">Expires <strong>${esc(dateLabel(g.expires_at))}</strong> · ${esc(until(g.expires_at))}</span>`
      : "";
  // Repeated titles ("Full reset" ×3) read better numbered.
  const numbered = new Set(items.map((g) => g.label)).size < items.length;
  $("#reset-list").setAttribute("role", "radiogroup");
  $("#reset-list").setAttribute("aria-label", "Resets");
  $("#reset-list").innerHTML = items
    .map((g, i) => {
      const title = numbered ? `Reset ${i + 1}` : g.label,
        radio = `<input type="radio" name="reset-grant" value="${esc(g.id)}" ${g === firstUsable ? "checked" : ""} ${g.reason || g.left <= 0 ? "disabled" : ""}/>`;
      // Codex credits come soonest-expiring first, so the default spends the one that runs out first.
      if (!claude)
        return `<label class="reset-row">${radio}<span class="reset-row-text"><span class="reset-row-title">${esc(title)}</span></span>${when(g)}</label>`;
      // Grant titles are long, so the expiry sits under the title instead of beside it.
      const meta = [
        g.total > 1 ? `${g.left} of ${g.total} left` : "",
        g.reason ||
          (g.expires_at
            ? `Expires ${dateLabel(g.expires_at)} · ${until(g.expires_at)}`
            : ""),
      ]
        .filter(Boolean)
        .join(" · ");
      return `<label class="reset-row">${radio}<span class="reset-row-text"><span class="reset-row-title">${esc(title)}</span>${meta ? `<span class="reset-row-meta">${esc(meta)}</span>` : ""}</span></label>`;
    })
    .join("");
  resetError("");
  setBusy($("#reset-confirm"), false);
  $("#reset-confirm").textContent = "Use reset";
  $("#reset-confirm").idleHTML = $("#reset-confirm").innerHTML;
  $("#reset-confirm").disabled = !firstUsable;
}
$("#reset-cancel").addEventListener("click", () =>
  $("#reset-dialog").close(),
);
$("#reset-dialog").addEventListener("close", () => {
  resetRead++;
  const trigger =
    resetTarget && $(`[data-menu="${CSS.escape(resetTarget)}"]`);
  resetTarget = null;
  trigger?.focus();
});
$("#reset-confirm").addEventListener("click", async () => {
  const id = resetTarget,
    a = accountById(id);
  if (!id || !a) return;
  const grant = $('#reset-list input[name="reset-grant"]:checked')?.value;
  resetError("");
  setBusy($("#reset-confirm"), true, "Using reset…");
  try {
    await api("account/reset", grant ? { id, grant } : { id });
    resetTarget = null;
    $("#reset-dialog").close();
    notify(
      "Reset used",
      "success",
      `${labelFor(a)}'s limits are clearing. Quotas update ${a.provider === "claude" ? "within a few minutes" : "in a moment"}.`,
    );
    await load();
  } catch (e) {
    setBusy($("#reset-confirm"), false);
    // An unknown outcome is retried with the same request, which can't spend twice.
    if (/outcome is unknown/i.test(e.message)) {
      $("#reset-confirm").textContent = "Retry same request";
      $("#reset-confirm").idleHTML = $("#reset-confirm").innerHTML;
    }
    resetError(e.message);
  }
});

// ---- Logs ----
const fmtSize = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
function logsMeta() {
  const logs = state.logs;
  if (logs.tab === "activity") return logs.activity.enabled ? "Live activity" : "";
  if (!logs.files) return logs.error ? "" : "Loading logs…";
  if (!logs.files.length) return "";
  return `${logs.files.length} recent error${logs.files.length === 1 ? "" : "s"}`;
}
function ensureLogs(entering) {
  const root = $("#logs-live");
  if (!root) return;
  if (!root.firstChild) {
    root.innerHTML = `<div class="logs-toolbar"><div class="segmented" role="group" aria-label="Log type"><button data-logs-tab="errors" ${choice(state.logs.tab === "errors")}>Errors</button><button data-logs-tab="activity" ${choice(state.logs.tab === "activity")}>Activity</button></div><button class="outline sm logs-refresh" data-logs-refresh${state.logs.tab === "errors" ? "" : " hidden"}>${icon("refresh")}Refresh</button></div><div class="logs-content" id="logs-content"></div>`;
    renderLogsContent();
  }
  if (entering) loadLogsTab();
}
function loadLogsTab() {
  stopLogs();
  if (state.logs.tab === "errors") loadErrors();
  else fetchActivity(true);
}
function selectLogsTab(tab) {
  state.logs.tab = tab;
  $$("[data-logs-tab]").forEach((button) => {
    const active = button.dataset.logsTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active);
    button.tabIndex = active ? 0 : -1;
  });
  updateIndicators();
  // A wrapping sentence: plain text (Torph keeps a single measured line).
  renderLogsContent();
  loadLogsTab();
}
function stopLogs() {
  clearTimeout(state.logs.timer);
  state.logs.timer = 0;
}
// error-v1-chat-completions-2026-11-20T181403-8b0e.log -> /v1/chat/completions.
// Hyphens are ambiguous (model names), so only known routes are rewritten.
const LOG_ROUTES = {
  "v1-chat-completions": "/v1/chat/completions",
  "v1-completions": "/v1/completions",
  "v1-responses": "/v1/responses",
  "v1-messages": "/v1/messages",
  "v1-messages-count_tokens": "/v1/messages/count_tokens",
  "v1-embeddings": "/v1/embeddings",
  "v1-models": "/v1/models",
};
function logRoute(name) {
  const stem = name.replace(/^error-/, "").replace(/-\d{4}-\d\d-\d\dT[\s\S]*$/, "");
  return LOG_ROUTES[stem] || stem.replace(/\.log$/, "");
}
function renderLogsContent() {
  const box = $("#logs-content");
  if (!box) return;
  const logs = state.logs,
    activity = logs.activity;
  const refreshBtn = $("[data-logs-refresh]");
  if (refreshBtn) refreshBtn.hidden = logs.tab !== "errors";
  if (state.page === "logs") morphText($("#page-meta"), logsMeta());
  const loading = (text) =>
    `<div class="logs-loading"><span class="loading-mark"></span>${text}</div>`;
  const failure = (text) =>
    `<div class="notice error">${icon("warning")}<span>${esc(text)}</span></div>`;
  if (logs.tab === "errors") {
    if (logs.error) box.innerHTML = failure(logs.error);
    else if (!logs.files) box.innerHTML = loading("Loading logs…");
    else if (!logs.files.length)
      box.innerHTML = `<div class="state-card"><h2>No failed requests recorded</h2><p>When a request fails, the proxy saves its details here. It keeps the last 10.</p></div>`;
    else
      box.innerHTML = `<div class="log-list">${logs.files
        .map(
          (f) =>
            `<button class="log-row" data-log-name="${esc(f.name)}" aria-current="${logs.open === f.name}">${icon("file")}<span class="log-time">${esc(new Date(f.modified * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }))}</span><span class="log-age">${esc(age(f.modified))}</span><span class="log-name" title="${esc(f.name)}">${esc(logRoute(f.name))}</span><span class="log-size">${fmtSize(f.size)}</span>${icon("chevron")}</button>`,
        )
        .join("")}</div>${
        logs.open
          ? `<section class="log-viewer" aria-label="Log ${esc(logs.open)}"><header class="log-viewer-head"><span class="log-viewer-title" tabindex="-1" title="${esc(logs.open)}">${esc(logs.open)}</span><button class="ghost icon-btn sm copy-button" data-log-copy aria-label="Copy log" ${logs.text === null ? "disabled" : ""}><span class="copy-icons">${icon("copy", "copy-idle")}${icon("check", "copy-done")}</span></button><button class="ghost icon-btn sm" data-log-close aria-label="Close log">${icon("close")}</button></header>${
              logs.text === null
                ? `<div class="log-text">${loading("Loading log…")}</div>`
                : `<pre class="log-text" tabindex="0">${esc(logs.text)}</pre>${logs.truncated ? '<p class="log-note">Showing the first 256 KB.</p>' : ""}`
            }</section>`
          : ""
      }`;
    return;
  }
  if (activity.error && activity.enabled === null)
    box.innerHTML = failure(activity.error);
  else if (activity.enabled === null)
    box.innerHTML = loading("Loading activity…");
  else if (!activity.enabled)
    box.innerHTML = `<div class="state-card"><h2>Activity log is off</h2><p>The proxy isn’t writing its activity log to disk. Turn it on to follow requests, retries and account switches here. This changes one proxy setting.</p><button class="primary" data-logs-enable>Enable activity log</button></div>`;
  else {
    box.innerHTML = `<section class="log-viewer"><header class="log-viewer-head"><span class="live-dot"></span><span class="live-label"></span><span class="live-hint">Updates every 5 seconds</span><button class="outline sm" data-logs-pause></button></header><pre class="log-text log-tail" tabindex="0" id="activity-text">${esc(activity.lines.join("\n"))}</pre></section>`;
    updateLiveHead();
    const pre = $("#activity-text");
    pre.scrollTop = pre.scrollHeight;
  }
}
function updateLiveHead() {
  const paused = state.logs.activity.paused,
    button = $("[data-logs-pause]");
  if (!button) return;
  $(".live-dot").classList.toggle("paused", paused);
  $(".live-label").textContent = paused ? "Paused" : "Live";
  button.innerHTML = `${icon(paused ? "play" : "pause")}${paused ? "Resume" : "Pause"}`;
}
async function loadErrors() {
  try {
    const r = await api("logs/errors");
    state.logs.files = r.files || [];
    state.logs.error = "";
    if (
      state.logs.open &&
      !state.logs.files.some((f) => f.name === state.logs.open)
    )
      state.logs.open = null;
  } catch (e) {
    state.logs.error = e.message;
  }
  if (state.logs.tab === "errors") renderLogsContent();
}
async function openLog(name) {
  state.logs.open = name;
  state.logs.text = null;
  renderLogsContent();
  $(`[data-log-name="${CSS.escape(name)}"]`)?.focus();
  try {
    const r = await api(
      `logs/errors/file?name=${encodeURIComponent(name)}`,
    );
    if (state.logs.open !== name) return;
    state.logs.text = r.text || "";
    state.logs.truncated = Boolean(r.truncated);
  } catch (e) {
    if (state.logs.open !== name) return;
    state.logs.text = `Couldn't load this log: ${e.message}`;
    state.logs.truncated = false;
  }
  const focused = document.activeElement?.dataset?.logName;
  renderLogsContent();
  if (focused === name) $(".log-viewer-title")?.focus();
  else if (focused) $(`[data-log-name="${CSS.escape(focused)}"]`)?.focus();
  $(".log-viewer")?.scrollIntoView({
    block: "nearest",
    behavior: motionAllowed() ? "smooth" : "auto",
  });
}
async function fetchActivity(initial = false) {
  const activity = state.logs.activity;
  stopLogs();
  if (state.page !== "logs" || state.logs.tab !== "activity") return;
  if (initial) {
    activity.cursor = null;
    activity.lines = [];
  }
  if (!initial && document.hidden) return scheduleActivity();
  try {
    const r = await api(
      `logs/activity?limit=300${activity.cursor ? `&cursor=${encodeURIComponent(activity.cursor)}` : ""}`,
    );
    if (state.logs.tab !== "activity") return;
    const wasLive = activity.enabled === true;
    activity.enabled = Boolean(r.enabled);
    activity.error = "";
    if (r.next_cursor) activity.cursor = r.next_cursor;
    const fresh = r.lines || [];
    if (!activity.enabled || initial || !wasLive) {
      activity.lines = fresh.slice(-2000);
      renderLogsContent();
    } else if (fresh.length) appendActivity(fresh);
  } catch (e) {
    activity.error = e.message;
    if (activity.enabled === null) renderLogsContent();
  }
  scheduleActivity();
}
function appendActivity(lines) {
  const activity = state.logs.activity,
    pre = $("#activity-text");
  activity.lines.push(...lines);
  if (!pre) return;
  const atBottom =
    pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  if (activity.lines.length > 2000) {
    activity.lines = activity.lines.slice(-2000);
    pre.textContent = activity.lines.join("\n");
  } else pre.append((pre.textContent ? "\n" : "") + lines.join("\n"));
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
function scheduleActivity() {
  const activity = state.logs.activity;
  stopLogs();
  if (
    state.page === "logs" &&
    state.logs.tab === "activity" &&
    activity.enabled &&
    !activity.paused
  )
    state.logs.timer = setTimeout(fetchActivity, 5000);
}
async function enableActivity(button) {
  setBusy(button, true, "Enabling…");
  try {
    await api("logs/activity/enable", {});
    notify(
      "Activity log enabled",
      "success",
      "New proxy activity appears here.",
    );
    state.logs.activity.enabled = null;
    renderLogsContent();
    fetchActivity(true);
  } catch (e) {
    setBusy(button, false);
    notify("Couldn't enable the activity log", "error", e.message);
  }
}
