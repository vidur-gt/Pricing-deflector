(() => {
  // Airbnb's booking endpoint accepts requests only from its canonical page origin.
  // Keep the same listing and query parameters while normalizing an apex-host URL.
  const currentUrl = new URL(location.href);
  if (currentUrl.hostname === "airbnb.co.in" && /^\/rooms\/\d+/.test(currentUrl.pathname)) {
    currentUrl.hostname = "www.airbnb.co.in";
    location.replace(currentUrl.href);
    return;
  }

  let lastFingerprint = null;
  let retryTimer = null;

  function showResultToast(result) {
    // A normal match is intentionally quiet. The toolbar badge remains the
    // lightweight status signal; interrupt the shopper only for a real flag.
    if (!result || result.status !== "checked" || !result.meaningful) return;
    const oldHost = document.querySelector("price-deflector-alert[data-price-deflector-toast]");
    oldHost?.remove();

    const host = document.createElement("price-deflector-alert");
    host.dataset.priceDeflectorToast = "";
    host.style.setProperty("all", "initial", "important");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      #toast {
        position: fixed; top: 18px; right: 18px; z-index: 2147483647;
        width: 330px; padding: 14px 16px; border: 1px solid #cbd5e1;
        border-radius: 10px; box-sizing: border-box; background: #fff7ed;
        box-shadow: 0 8px 28px rgba(15, 23, 42, .25); color: #0f172a;
        font-family: system-ui, sans-serif; font-size: 16px; line-height: normal;
      }
      #toast strong { display: block; font-size: 16px; font-weight: 700; }
      #toast p { margin: 6px 0 0; font-size: 13px; line-height: 1.4; }
    `;
    const toast = document.createElement("section");
    toast.id = "toast";
    toast.setAttribute("role", "status");
    const title = document.createElement("strong");
    const detail = document.createElement("p");
    const percent = Math.abs(result.deltaPercent).toFixed(Math.abs(result.deltaPercent) < 10 ? 1 : 0);
    title.textContent = "Price difference detected";
    detail.textContent = `${percent}% ${result.deltaPercent > 0 ? "higher" : "lower"} than the clean baseline. Open Price Deflector for both prices.`;
    toast.append(title, detail);
    shadow.append(style, toast);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 8000);
  }

  async function getAirbnbBaseline(context) {
    if (!context?.listingId || !context.checkIn || !context.checkOut) {
      return { reason: "Choose check-in and check-out dates before checking this Airbnb listing." };
    }
    const bootstrap = document.getElementById("data-initializer-bootstrap")?.textContent || "";
    const apiKey = bootstrap.match(/"api_config"\s*:\s*\{\s*"key"\s*:\s*"([^"]+)"/)?.[1];
    if (!apiKey) return { reason: "Airbnb did not expose its first-party booking configuration." };
    const variables = {
      id: btoa(`DemandStayListing:${context.listingId}`),
      dateRange: { startDate: context.checkIn, endDate: context.checkOut },
      guestCounts: { numberOfAdults: context.adults },
      includePdpMigrationBookItCalendarSheetFragment: true,
      includePdpMigrationBookItFloatingFooterFragment: true,
      includePdpMigrationBookItNavFragment: true,
      includePdpMigrationBookItSidebarFragment: true,
      includePdpMigrationCancellationPolicyPickerModalFragment: true,
      includeOverviewMerchandisingTipsFragment: true,
      includeStaysPdpPriceHeatmapFragment: false,
      priceHeatmapDateRange: { startDate: context.checkIn, endDate: context.checkOut }
    };
    try {
      const response = await fetch("/api/v3/StaysPdpBookItQuery", {
        method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
        headers: {
          Accept: "application/json", "Content-Type": "application/json", "X-Airbnb-Api-Key": apiKey,
          "X-Airbnb-GraphQL-Platform": "web", "X-Airbnb-GraphQL-Platform-Client": "minimalist-niobe"
        },
        body: JSON.stringify({
          operationName: "StaysPdpBookItQuery", variables,
          extensions: { persistedQuery: { version: 1, sha256Hash: "86b99af14b966b9a5fd78b31fd1a3998eae4a2094112cba5fd3d8730fbcb439f" } }
        })
      });
      if (!response.ok) return { reason: `Airbnb booking quote failed (${response.status}).` };
      const data = await response.json();
      const bookIt = data?.data?.node?.pdpPresentation?.bookIt;
      const primaryLine = bookIt?.structuredDisplayPrice?.primaryLine;
      const options = bookIt?.productItemDetail?.guestOptions || [];
      const selectedOption = context.rate
        ? options.find((option) => String(option.title || "").toLowerCase() === context.rate)
        : null;
      const displayedRate = Number(context.displayedRateValue);
      const nearestOption = Number.isFinite(displayedRate)
        ? options
          .map((option) => ({ option, value: PriceExtractor.parsePrice(option.priceString) }))
          .filter((item) => item.value !== null)
          .sort((left, right) => Math.abs(left.value - displayedRate) - Math.abs(right.value - displayedRate))[0]
        : null;
      // Airbnb's radio markup can vary, but its clean quote lists every rate.
      // Prefer an option whose total agrees with the displayed total (allowing
      // minor rounding), then use the selected-label signal as a fallback.
      const displayedRateOption = nearestOption && Math.abs(nearestOption.value - displayedRate) / nearestOption.value < 0.015
        ? nearestOption.option
        : null;
      // Airbnb uses `discountedPrice` (rather than `price`) when a host discount is
      // shown. When the shopper has selected a cancellation rate, compare that
      // exact option rather than Airbnb's default headline price.
      const raw = displayedRateOption?.priceString || selectedOption?.priceString || primaryLine?.discountedPrice || primaryLine?.price;
      const value = PriceExtractor.parsePrice(raw);
      if (value === null) return { reason: "Airbnb did not return a bookable price for the selected stay." };
      const currency = /\u20B9|\bINR\b/i.test(raw) ? "INR" : null;
      return { price: { value, raw, currency, formatted: PriceExtractor.formatPrice({ value, currency }) } };
    } catch (error) {
      console.warn("Price Deflector Airbnb baseline failed", error);
      return { reason: "The Airbnb booking quote could not be completed." };
    }
  }

  const sendCheck = () => {
    const product = PriceExtractor.extract(document, location.href);
    const fingerprint = JSON.stringify({ url: location.href, price: product.price?.value, checkIn: product.airbnb?.checkIn, checkOut: product.airbnb?.checkOut, adults: product.airbnb?.adults, rate: product.airbnb?.rate, displayedRate: product.airbnb?.displayedRateValue });
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    chrome.runtime.sendMessage({ type: "CHECK_PAGE", url: location.href, product }).then((result) => {
      if (product.price) showResultToast(result);
    }).catch(() => {
      // The extension may have been reloaded while this document was open.
    });
  };

  sendCheck();
  const observer = new MutationObserver(() => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(sendCheck, 750);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_CURRENT_PRODUCT") {
      sendResponse({ url: location.href, product: PriceExtractor.extract(document, location.href) });
    }
    if (message.type === "GET_AIRBNB_BASELINE") {
      getAirbnbBaseline(message.context).then(sendResponse);
      return true;
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) sendCheck();
  });
})();
