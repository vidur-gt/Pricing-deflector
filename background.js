importScripts("extractor.js");

const MIN_RECHECK_MS = 3000;
const OFFSCREEN_IDLE_MS = 3000;
const tabResults = new Map();
const lastChecks = new Map();
const SOURCE_UA_RULE_ID = 71001;
const PURCHASE_RULE_ID_START = 72000;
const PURCHASE_RULE_ID_END = 72999;
const detectedChromeVersion = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "120.0.0.0";
const SOURCE_PROFILES = [
  { id: "desktop", label: "Desktop Chrome", userAgent: null, fidelity: "Desktop Chrome request" },
  {
    id: "android",
    label: "Android Chrome",
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${detectedChromeVersion} Mobile Safari/537.36`,
    fidelity: "Android Chrome user-agent request"
  },
  {
    id: "ios",
    label: "iPhone Safari",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    fidelity: "iPhone Safari user-agent request"
  }
];
let offscreenCreation;
let activeOffscreenParses = 0;
let offscreenCloseTimer;
let retailFetchQueue = Promise.resolve();
const purchaseRuleByTab = new Map();

function samePageUrl(first, second) {
  try {
    const left = new URL(first);
    const right = new URL(second);
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
  } catch (_) {
    return false;
  }
}

async function tabIsStillAtUrl(tabId, url) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return samePageUrl(tab.url, url);
  } catch (_) {
    return false;
  }
}

function scheduleOffscreenClose() {
  clearTimeout(offscreenCloseTimer);
  if (activeOffscreenParses > 0) return;
  offscreenCloseTimer = setTimeout(async () => {
    if (activeOffscreenParses > 0) return;
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (contexts.length) await chrome.offscreen.closeDocument();
    } catch (error) {
      console.warn("Price Deflector could not close its idle parser document", error);
    }
  }, OFFSCREEN_IDLE_MS);
}

async function ensureOffscreenDocument() {
  clearTimeout(offscreenCloseTimer);
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Parse the fetched product HTML with the same local price extractor used on pages."
    }).finally(() => { offscreenCreation = null; });
  }
  await offscreenCreation;
}

async function extractBaseline(html, url) {
  await ensureOffscreenDocument();
  activeOffscreenParses += 1;
  try {
    return await chrome.runtime.sendMessage({ type: "PARSE_BASELINE_HTML", html, url });
  } finally {
    activeOffscreenParses -= 1;
    scheduleOffscreenClose();
  }
}

function queueRetailFetch(task) {
  const next = retailFetchQueue.then(task, task);
  retailFetchQueue = next.catch(() => undefined);
  return next;
}

async function fetchRetailBaseline(url, userAgent = null) {
  return queueRetailFetch(async () => {
    const host = new URL(url).hostname;
    if (userAgent) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [SOURCE_UA_RULE_ID],
        addRules: [{
          id: SOURCE_UA_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "User-Agent", operation: "set", value: userAgent }]
          },
          // Only affects this extension worker's short-lived fetch, never the tab.
          condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest"], tabIds: [chrome.tabs.TAB_ID_NONE] }
        }]
      });
    }
    try {
      const response = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
      if (!response.ok) throw new Error(`Baseline request failed (${response.status}).`);
      return extractBaseline(await response.text(), url);
    } finally {
      if (userAgent) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [SOURCE_UA_RULE_ID] });
      }
    }
  });
}

async function compareRetailSources(url, desktopPrice, shownPrice) {
  const profiles = [{ ...SOURCE_PROFILES[0], price: desktopPrice }];
  for (const profile of SOURCE_PROFILES.slice(1)) {
    try {
      const baseline = await fetchRetailBaseline(url, profile.userAgent);
      if (baseline.price) profiles.push({ ...profile, price: baseline.price });
      else profiles.push({ ...profile, error: baseline.reason || "No comparable price returned." });
    } catch (_) {
      profiles.push({ ...profile, error: "The site did not return a comparable price for this profile." });
    }
  }
  const verified = profiles.filter((profile) => profile.price);
  const cheapest = verified.reduce((lowest, profile) => profile.price.value < lowest.price.value ? profile : lowest, verified[0]);
  // A background desktop baseline is cookie-free, but a normal new desktop tab
  // would reuse the shopper's cookies. Only offer an actionable handoff to an
  // alternate profile that we can reproduce with a tab-scoped request rule.
  const actionable = profiles
    .filter((profile) => profile.userAgent && profile.price)
    .sort((left, right) => left.price.value - right.price.value)[0];
  const savingsPercent = actionable && shownPrice
    ? ((shownPrice.value - actionable.price.value) / shownPrice.value) * 100
    : 0;
  return {
    profiles,
    cheapestProfileId: cheapest?.id || null,
    bestPurchase: actionable && savingsPercent >= 3
      ? { profileId: actionable.id, profileLabel: actionable.label, price: actionable.price, savingsPercent }
      : null,
    note: "Profiles change the request User-Agent only. They do not emulate a real Android or iOS device, account, location, viewport, or payment eligibility."
  };
}

function statusFor(result) {
  if (result?.status === "checking") {
    return { text: "...", color: "#2563eb", title: "Price Deflector: checking baseline price" };
  }
  if (!result || result.status === "unsupported" || result.status === "unverified") {
    return { text: "?", color: "#6b7280", title: "Price Deflector: no verified price comparison" };
  }
  if (!result.meaningful) {
    return { text: "✓", color: "#16a34a", title: "Price Deflector: no meaningful price difference" };
  }
  return {
    text: "!",
    color: Math.abs(result.deltaPercent) >= 10 ? "#dc2626" : "#d97706",
    title: "Price Deflector: a price difference was detected"
  };
}

async function setBadge(tabId, result) {
  const status = statusFor(result);
  await chrome.action.setBadgeText({ tabId, text: status.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: status.color });
  await chrome.action.setTitle({ tabId, title: status.title });
}

async function saveResult(tabId, result) {
  // A fetch started by the old document can finish after a same-tab navigation.
  // Do not let it repopulate storage, the badge, or the popup for the new page.
  if (result.url && !(await tabIsStillAtUrl(tabId, result.url))) return null;
  tabResults.set(tabId, result);
  await chrome.storage.local.set({ [`tab:${tabId}`]: result });
  await setBadge(tabId, result);
  return result;
}

function asUnverified(product, url, reason) {
  return {
    status: product.supported ? "unverified" : "unsupported",
    url,
    productId: product.productId || null,
    title: product.title || "Product page",
    checkedAt: Date.now(),
    message: reason || product.reason || "This page could not be checked."
  };
}

function isAirbnbUrl(url) {
  const hostname = new URL(url).hostname;
  return hostname === "www.airbnb.co.in" || hostname === "airbnb.co.in";
}

function comparisonKey(url, product) {
  return JSON.stringify({
    url,
    shownPrice: product.price?.value || null,
    airbnbRate: product.airbnb?.rate || null
  });
}

async function requestAirbnbBaselineFromPage(tabId, product) {
  const baseline = await chrome.tabs.sendMessage(tabId, {
    type: "GET_AIRBNB_BASELINE",
    context: product.airbnb
  });
  if (!baseline?.price) {
    return { supported: true, reason: baseline?.reason || "The Airbnb booking quote could not be completed." };
  }
  return baseline;
}

async function comparePage(tabId, url, product, force = false) {
  if (!product.supported || !product.price) return saveResult(tabId, asUnverified(product, url));

  const previous = tabResults.get(tabId);
  const now = Date.now();
  const key = comparisonKey(url, product);
  if (!force && previous?.comparisonKey === key && now - (lastChecks.get(key) || 0) < MIN_RECHECK_MS) {
    return previous;
  }
  if (force && now - (lastChecks.get(key) || 0) < MIN_RECHECK_MS) {
    return previous ? { ...previous, throttled: true } : saveResult(tabId, asUnverified(product, url, "Please wait a moment before checking again."));
  }
  const checking = await saveResult(tabId, {
    status: "checking",
    url,
    productId: product.productId,
    title: product.title,
    comparisonKey: key,
    checkedAt: now,
    message: "Comparing the displayed price with a clean baseline..."
  });
  if (!checking) return null;
  lastChecks.set(key, now);

  try {
    let baseline;
    if (isAirbnbUrl(url)) {
      // Airbnb rejects a chrome-extension Origin. The content script performs a
      // cookie-free request from the canonical Airbnb page origin instead.
      baseline = await requestAirbnbBaselineFromPage(tabId, product);
    } else {
      baseline = await fetchRetailBaseline(url);
    }
    if (!baseline.price) {
      return saveResult(tabId, asUnverified(product, url, baseline.reason || "The clean baseline page did not expose a comparable price."));
    }
    const delta = (product.price.value - baseline.price.value) / baseline.price.value;
    return saveResult(tabId, {
      status: "checked",
      url,
      productId: product.productId,
      title: product.title,
      comparisonKey: key,
      shownPrice: product.price,
      baselinePrice: baseline.price,
      delta,
      deltaPercent: delta * 100,
      meaningful: Math.abs(delta) >= 0.03,
      checkedAt: Date.now()
    });
  } catch (error) {
    console.warn("Price Deflector baseline check failed", error);
    return saveResult(tabId, asUnverified(product, url, "The baseline check could not be completed."));
  }
}

async function compareSourcesForTab(tabId) {
  const { url, product } = await chrome.tabs.sendMessage(tabId, { type: "GET_CURRENT_PRODUCT" });
  const checked = await comparePage(tabId, url, product);
  if (!checked || checked.status !== "checked") return checked;
  if (isAirbnbUrl(url)) {
    return saveResult(tabId, {
      ...checked,
      sourceComparison: {
        unavailable: true,
        message: "Source comparison is unavailable for Airbnb. Its booking quote must be requested from the active Airbnb page, so a Chrome extension cannot reliably emulate an Android or iPhone booking session."
      }
    });
  }
  const sourceComparison = await compareRetailSources(url, checked.baselinePrice, checked.shownPrice);
  return saveResult(tabId, { ...checked, sourceComparison });
}

async function nextPurchaseRuleId() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(rules.map((rule) => rule.id));
  for (let id = PURCHASE_RULE_ID_START; id <= PURCHASE_RULE_ID_END; id += 1) {
    if (!used.has(id)) return id;
  }
  throw new Error("No temporary purchase rule is available.");
}

function bestPurchaseFromResult(result) {
  const offer = result?.sourceComparison?.bestPurchase;
  const profile = result?.sourceComparison?.profiles?.find((item) => item.id === offer?.profileId);
  return offer && profile?.userAgent ? { offer, profile } : null;
}

async function openBestPrice(tabId) {
  const result = tabResults.get(tabId) || (await chrome.storage.local.get(`tab:${tabId}`))[`tab:${tabId}`];
  const candidate = bestPurchaseFromResult(result);
  if (!candidate || !result?.url) return null;

  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const ruleId = await nextPurchaseRuleId();
  const host = new URL(result.url).hostname;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "User-Agent", operation: "set", value: candidate.profile.userAgent }]
        },
        condition: {
          requestDomains: [host],
          tabIds: [tab.id],
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
        }
      }]
    });
    purchaseRuleByTab.set(tab.id, ruleId);
    await chrome.tabs.update(tab.id, { url: result.url });
    return { tabId: tab.id, profileLabel: candidate.offer.profileLabel };
  } catch (error) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => undefined);
    await chrome.tabs.remove(tab.id).catch(() => undefined);
    throw error;
  }
}

async function removePurchaseRule(tabId) {
  const ruleId = purchaseRuleByTab.get(tabId);
  purchaseRuleByTab.delete(tabId);
  if (ruleId) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

async function clearOrphanedPurchaseRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = rules
    .filter((rule) => rule.id >= PURCHASE_RULE_ID_START && rule.id <= PURCHASE_RULE_ID_END)
    .map((rule) => rule.id);
  if (removeRuleIds.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_PAGE" && sender.tab?.id !== undefined) {
    if (!samePageUrl(sender.tab.url, message.url)) {
      sendResponse(null);
      return;
    }
    comparePage(sender.tab.id, message.url, message.product).then(sendResponse);
    return true;
  }
  if (message.type === "GET_RESULT") {
    (async () => {
      const tabId = message.tabId;
      const stored = tabResults.get(tabId) || (await chrome.storage.local.get(`tab:${tabId}`))[`tab:${tabId}`];
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (stored && (!tab || !samePageUrl(stored.url, tab.url))) {
        tabResults.delete(tabId);
        await chrome.storage.local.remove(`tab:${tabId}`);
        if (tab) await setBadge(tabId, asUnverified({ supported: false }, tab.url, "This page has not been checked yet."));
        sendResponse(null);
        return;
      }
      sendResponse(stored || null);
    })();
    return true;
  }
  if (message.type === "RECHECK" && Number.isInteger(message.tabId)) {
    chrome.tabs.sendMessage(message.tabId, { type: "GET_CURRENT_PRODUCT" }).then(async ({ url, product }) => {
      sendResponse(await comparePage(message.tabId, url, product, true));
    }).catch(() => sendResponse(null));
    return true;
  }
  if (message.type === "COMPARE_SOURCES" && Number.isInteger(message.tabId)) {
    compareSourcesForTab(message.tabId).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (message.type === "OPEN_BEST_PRICE" && Number.isInteger(message.tabId)) {
    openBestPrice(message.tabId).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  const nextUrl = changeInfo.url || tab.url;
  if (!nextUrl) return;
  const previous = tabResults.get(tabId);
  if (previous && samePageUrl(previous.url, nextUrl) && !changeInfo.url) return;
  tabResults.delete(tabId);
  chrome.storage.local.remove(`tab:${tabId}`);
  setBadge(tabId, asUnverified({ supported: false }, nextUrl, "This page has not been checked yet."));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabResults.delete(tabId);
  chrome.storage.local.remove(`tab:${tabId}`);
  removePurchaseRule(tabId).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  scheduleOffscreenClose();
  clearOrphanedPurchaseRules().catch(() => undefined);
});
chrome.runtime.onInstalled.addListener(() => {
  scheduleOffscreenClose();
  clearOrphanedPurchaseRules().catch(() => undefined);
});
