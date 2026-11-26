// Sign-in (OAuth) dialog, test exports and startup.
"use strict";
const oauthDescriptions = {
  choose:
    "Sign in once. The proxy adds the account to its pool automatically.",
  flow: "Open the sign-in page and choose the account to add.",
};
$("#oauth-providers").innerHTML = Object.entries(PROVIDERS)
  .map(
    ([id, p], i) =>
      `<label class="provider-option"><input type="radio" name="oauth-provider" value="${id}" ${i === 1 ? "checked" : ""}/>${providerIcon(id)}<span class="provider-option-text"><strong>${p.name}</strong><span>${p.note}</span></span></label>`,
  )
  .join("");
// Double-click a provider to start right away.
$("#oauth-providers").addEventListener("dblclick", (e) => {
  if (e.target.closest(".provider-option")) $("#oauth-start").click();
});
const chosenProvider = () =>
  $("#oauth-providers input:checked")?.value || "codex";
// Keep a button in a loading state until the outcome is actually known.
function setBusy(button, busy, label) {
  button.idleHTML ??= button.innerHTML;
  button.disabled = busy;
  button.toggleAttribute("aria-busy", busy);
  button.innerHTML = busy
    ? `<span class="loading-mark"></span>${esc(label)}`
    : button.idleHTML;
}
function setCallbackError(text) {
  const input = $("#oauth-callback"),
    error = $("#oauth-callback-error");
  error.textContent = text || "";
  error.hidden = !text;
  if (text) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
$("#oauth-callback").addEventListener("input", () =>
  setCallbackError(""),
);
async function copyWithFeedback(button, text, label) {
  try {
    await navigator.clipboard.writeText(text);
    // data-motion-* survives the polling patch, so the check stays visible.
    button.dataset.motionCopied = "";
    button.setAttribute("aria-label", "Copied");
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      delete button.dataset.motionCopied;
      button.setAttribute("aria-label", label);
    }, 2000);
  } catch {
    notify("Couldn't copy", "error", "Select the text and copy it.");
  }
}
$("#oauth-copy").addEventListener("click", (e) =>
  copyWithFeedback(
    e.currentTarget,
    $("#oauth-url").href,
    "Copy sign-in link",
  ),
);
// The header's primary action follows the page: New key on Keys, else Add login.
$("#add-login").addEventListener("click", () =>
  pageFromPath() === "keys" ? openKeyDialog() : openOAuth(),
);
function resetOAuthDialog(mode) {
  clearTimeout(state.oauthTimer);
  state.oauth = null;
  state.oauthMode = mode;
  oauthTicket++;
  $("#oauth-title").textContent =
    mode === "relogin" ? "Sign in again" : "Add login";
  $("#oauth-url").removeAttribute("aria-disabled");
  $("#oauth-copy").disabled = false;
}
let oauthTicket = 0;
function openOAuth(provider) {
  resetOAuthDialog("add");
  const radio =
    provider && $(`#oauth-providers input[value="${provider}"]`);
  if (radio) radio.checked = true;
  setCallbackError("");
  $("#oauth-description").textContent = oauthDescriptions.choose;
  $("#oauth-choose").hidden = false;
  $("#oauth-flow").hidden = true;
  $("#oauth-error").hidden = true;
  $("#oauth-callback").value = "";
  setBusy($("#oauth-start"), false);
  setBusy($("#oauth-submit"), false);
  $("#oauth-dialog").showModal();
}
async function closeOAuth() {
  clearTimeout(state.oauthTimer);
  oauthTicket++;
  $("#oauth-dialog").close();
  if (state.oauth) {
    try {
      await api("oauth/cancel", { state: state.oauth.state });
    } catch {}
    state.oauth = null;
  }
}
$("#oauth-close").addEventListener("click", closeOAuth);
$$("[data-dialog-cancel]").forEach((button) =>
  button.addEventListener("click", closeOAuth),
);
$("#oauth-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeOAuth();
});
function oauthError(text) {
  $("#oauth-error").textContent = text;
  $("#oauth-error").hidden = false;
}
async function pollOAuth() {
  if (!state.oauth) return;
  try {
    const r = await api("oauth/status", { state: state.oauth.state });
    if (r.status === "ok") {
      clearTimeout(state.oauthTimer);
      state.oauth = null;
      $("#oauth-dialog").close();
      notify(
        state.oauthMode === "relogin"
          ? "Signed in again"
          : "Account connected",
        "success",
        "Refreshing quotas.",
      );
      await load();
      setTimeout(load, 2000);
      return;
    }
    if (r.status === "error") {
      setBusy($("#oauth-submit"), false);
      setCallbackError(
        r.error || "Sign-in failed. Close this dialog and try again.",
      );
      $("#oauth-status").textContent = "Sign-in did not complete";
      return;
    }
  } catch (e) {
    setBusy($("#oauth-submit"), false);
    oauthError(e.message);
    return;
  }
  state.oauthTimer = setTimeout(pollOAuth, 2000);
}
// Show the link/callback step for a started OAuth session.
function showOAuthFlow(r, description) {
  const url = new URL(r.url);
  if (url.protocol !== "https:")
    throw Error("Unexpected sign-in address. Use the original panel.");
  state.oauth = r;
  $("#oauth-url").href = url.href;
  $("#oauth-url").removeAttribute("aria-disabled");
  $("#oauth-copy").disabled = false;
  $("#oauth-link").textContent = url.href;
  $("#oauth-choose").hidden = true;
  $("#oauth-flow").hidden = false;
  $("#oauth-description").textContent = description;
  $("#oauth-status").innerHTML =
    '<span class="loading-mark"></span>Waiting for sign-in';
  pollOAuth();
}
async function relogin(id) {
  const a = accountById(id);
  if (!a) return;
  const description = `Sign in as ${labelFor(a)} to restore this login.`;
  resetOAuthDialog("relogin");
  const ticket = oauthTicket;
  setCallbackError("");
  $("#oauth-error").hidden = true;
  $("#oauth-callback").value = "";
  setBusy($("#oauth-submit"), false);
  $("#oauth-description").textContent = description;
  $("#oauth-choose").hidden = true;
  $("#oauth-flow").hidden = false;
  $("#oauth-url").removeAttribute("href");
  $("#oauth-url").setAttribute("aria-disabled", "true");
  $("#oauth-copy").disabled = true;
  $("#oauth-link").textContent = "Preparing sign-in link…";
  $("#oauth-status").innerHTML =
    '<span class="loading-mark"></span>Preparing sign-in';
  $("#oauth-dialog").showModal();
  try {
    const r = await api("account/relogin", { id });
    // The dialog may have been closed while the link was being prepared.
    if (ticket !== oauthTicket || !$("#oauth-dialog").open) {
      api("oauth/cancel", { state: r.state }).catch(() => {});
      return;
    }
    showOAuthFlow(r, description);
  } catch (e) {
    if (ticket !== oauthTicket) return;
    oauthError(e.message);
    $("#oauth-link").textContent = "Sign-in link unavailable";
    $("#oauth-status").textContent = "Couldn't start sign-in";
  }
}
$("#oauth-start").addEventListener("click", async () => {
  setBusy($("#oauth-start"), true, "Starting…");
  $("#oauth-error").hidden = true;
  try {
    const r = await api("oauth/start", {
      provider: chosenProvider(),
    });
    showOAuthFlow(r, oauthDescriptions.flow);
    setBusy($("#oauth-start"), false);
  } catch (e) {
    oauthError(e.message);
    setBusy($("#oauth-start"), false);
  }
});
$("#oauth-submit").addEventListener("click", async () => {
  if (!state.oauth) return;
  $("#oauth-error").hidden = true;
  const raw = $("#oauth-callback").value.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {}
  if (!raw) return setCallbackError("Paste the callback address first.");
  if (
    !url ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.searchParams.has("code")
  )
    return setCallbackError(
      "Paste the full address from your browser, starting with http://localhost and including ?code=.",
    );
  setBusy($("#oauth-submit"), true, "Completing sign-in…");
  try {
    await api("oauth/callback", {
      state: state.oauth.state,
      redirect_url: raw,
    });
    // pollOAuth() clears the busy state once the proxy reports the result.
    $("#oauth-status").innerHTML =
      '<span class="loading-mark"></span>Verifying sign-in…';
  } catch (e) {
    setBusy($("#oauth-submit"), false);
    setCallbackError(e.message);
  }
});
window.dashboard = {
  state,
  render,
  parseHistory: historyPoints,
  drainFor,
  drainSplitFor,
  poolDrain,
  drainSeries: poolDrainSeries,
  allDrainSeries,
  accountDrainSplitSeries,
  quotaProjection,
  quotaMeter,
  plot,
  ratePlot,
  chartHoverInfo,
  inspectChart,
  seriesAt,
  niceRateMax,
  accountWeight,
  windowApiUsd,
  fmtApiUsd,
  accountListWindow,
  accountsPage,
  forecastPoints,
  usageBreakdownHtml,
  renderUsageBreakdown,
  isAgyClaudeWindow,
  claudeExtraSources,
  stackedPoolHistory,
};
(async () => {
  try {
    const r = await api("session");
    // Signed in by the tailnet: there is no session to end.
    $("#logout").hidden = !!r.tailnet;
    r.authenticated ? showApp() : showLogin();
  } catch (e) {
    showLogin();
    $("#login-error").textContent = e.message;
    $("#login-error").hidden = false;
  }
})();
