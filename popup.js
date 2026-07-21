const $ = (id) => document.getElementById(id);
let activeTabId = null;
let currentResult = null;

function show(section) {
  ["loading", "result", "unverified"].forEach((id) => { $(id).hidden = id !== section; });
}

function signedPercent(value) {
  return `${Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}%`;
}

function renderSources(sourceComparison) {
  const section = $("source-comparison");
  const buyButton = $("buy-best-price");
  if (!sourceComparison) {
    section.hidden = true;
    buyButton.hidden = true;
    return;
  }
  const summary = $("source-summary");
  const prices = $("source-prices");
  const note = $("source-note");
  prices.replaceChildren();
  if (sourceComparison.unavailable) {
    summary.textContent = sourceComparison.message;
    note.textContent = "";
    buyButton.hidden = true;
    section.hidden = false;
    return;
  }
  const cheapest = sourceComparison.profiles.find((profile) => profile.id === sourceComparison.cheapestProfileId);
  summary.textContent = cheapest
    ? `Lowest verified response: ${cheapest.label} (${cheapest.price.formatted}).`
    : "No profile returned a comparable price.";
  sourceComparison.profiles.forEach((profile) => {
    const item = document.createElement("li");
    if (profile.id === sourceComparison.cheapestProfileId) item.className = "cheapest";
    const label = document.createElement("span");
    label.textContent = profile.id === sourceComparison.cheapestProfileId ? `${profile.label} · lowest` : profile.label;
    const value = document.createElement("strong");
    value.textContent = profile.price ? profile.price.formatted : "Unavailable";
    item.append(label, value);
    prices.append(item);
  });
  note.textContent = sourceComparison.note || "";
  buyButton.hidden = !sourceComparison.bestPurchase;
  if (sourceComparison.bestPurchase) {
    buyButton.textContent = `Buy at the best price (${sourceComparison.bestPurchase.profileLabel})`;
  }
  section.hidden = false;
}

function render(result) {
  currentResult = result;
  renderSources(result?.sourceComparison);
  if (result?.status === "checking") {
    $("loading").textContent = result.message || "Checking this product page...";
    show("loading");
    return;
  }
  if (!result || result.status !== "checked") {
    $("unverified-message").textContent = result?.message || "Open a supported product page and wait for a baseline check.";
    show("unverified");
    return;
  }

  $("product-title").textContent = result.title;
  $("shown-price").textContent = result.shownPrice.formatted;
  $("baseline-price").textContent = result.baselinePrice.formatted;
  const higher = result.deltaPercent > 0;
  const difference = signedPercent(result.deltaPercent);
  const delta = $("delta");
  if (result.meaningful) {
    delta.textContent = `You’re seeing a price ${difference} ${higher ? "higher" : "lower"} than our baseline check for this exact page.`;
    delta.className = "delta flagged";
  } else {
    delta.textContent = `The prices differ by ${difference}, below the 3% noise threshold.`;
    delta.className = "delta clear";
  }
  show("result");
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  if (!Number.isInteger(activeTabId)) return render(null);
  const result = await chrome.runtime.sendMessage({ type: "GET_RESULT", tabId: activeTabId });
  render(result);
}

$("recheck").addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) return;
  const button = $("recheck");
  button.disabled = true;
  button.textContent = "Checking…";
  $("throttle-note").hidden = true;
  try {
    const next = await chrome.runtime.sendMessage({ type: "RECHECK", tabId: activeTabId });
    if (next?.throttled) $("throttle-note").hidden = false;
    render(next);
  } finally {
    button.disabled = false;
    button.textContent = "Re-check";
  }
});

$("compare-sources").addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) return;
  const button = $("compare-sources");
  button.disabled = true;
  button.textContent = "Comparing sources…";
  try {
    const next = await chrome.runtime.sendMessage({ type: "COMPARE_SOURCES", tabId: activeTabId });
    render(next);
  } finally {
    button.disabled = false;
    button.textContent = "Compare source prices";
  }
});

$("buy-best-price").addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) return;
  const button = $("buy-best-price");
  button.disabled = true;
  try {
    const opened = await chrome.runtime.sendMessage({ type: "OPEN_BEST_PRICE", tabId: activeTabId });
    if (opened?.tabId) window.close();
  } finally {
    button.disabled = false;
  }
});

load().catch(() => render(null));
