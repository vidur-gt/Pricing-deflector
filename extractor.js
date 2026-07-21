/* Shared, dependency-free product extraction used in the page and service worker. */
(function (global) {
  "use strict";

  const AIRBNB_RULE = {
    pattern: /^\/rooms\/\d+(?:\/|$)/i,
    id: (url) => (url.pathname.match(/^\/rooms\/(\d+)/i) || [])[1],
    preferDisplayedDom: true,
    isAirbnb: true,
    selectors: []
  };

  const SITE_RULES = {
    "www.amazon.in": {
      pattern: /^\/(?:[^/]+\/)*(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i,
      id: (url) => (url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i) || [])[1],
      preferDisplayedDom: true,
      selectors: [
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
        "#corePrice_feature_div .a-price .a-offscreen",
        ".apex-pricetopay-value .a-offscreen",
        "#apex-pricetopay-accessibility-label",
        "#priceblock_dealprice",
        "#priceblock_ourprice",
        "#priceblock_saleprice",
        "[itemprop='price']",
        "meta[itemprop='price']",
        "meta[property='product:price:amount']"
      ]
    },
    "www.flipkart.com": {
      pattern: /^\/.+\/p\/itm[a-z0-9]+(?:\/|$)/i,
      id: (url) => (url.pathname.match(/\/p\/(itm[a-z0-9]+)(?:\/|$)/i) || [])[1],
      preferDisplayedDom: true,
      selectors: [
        "[itemprop='price']",
        "meta[itemprop='price']",
        "meta[property='product:price:amount']",
        "div.Nx9bqj",
        "div[class*='Nx9bqj']",
        "._30jeq3"
      ]
    },
    "www.airbnb.co.in": AIRBNB_RULE,
    "airbnb.co.in": AIRBNB_RULE
  };

  function getRule(url) {
    const rule = SITE_RULES[url.hostname];
    return rule && rule.pattern.test(url.pathname) ? rule : null;
  }

  function textOf(element) {
    return element && (element.getAttribute("content") || element.getAttribute("value") || element.textContent || "").trim();
  }

  function parsePrice(input) {
    if (input === undefined || input === null) return null;
    const text = String(input).replace(/\s/g, "");
    // Keep digits, dots, commas and minus; remove currency labels and symbols.
    let cleaned = text.replace(/[^0-9,.-]/g, "");
    if (!cleaned || !/\d/.test(cleaned)) return null;
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    const commaOnly = lastComma !== -1 && lastDot === -1;
    const commaIsThousands = commaOnly && cleaned.length - lastComma - 1 === 3;
    if (commaIsThousands) {
      cleaned = cleaned.replace(/,/g, "");
    } else if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
    const value = Number.parseFloat(cleaned);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function priceFromCurrencyText(text, fallbackCurrency = null) {
    const match = String(text || "").match(/(?:₹|\$|€|£|\b(?:INR|USD|EUR|GBP)\b)\s*[0-9][0-9,.]*/i);
    if (!match) return null;
    const value = parsePrice(match[0]);
    if (value === null) return null;
    return { value, raw: match[0], currency: currencyFrom(null, { querySelector: () => null }, match[0]) || fallbackCurrency };
  }

  function airbnbContext(href) {
    const url = new URL(href);
    const listingId = AIRBNB_RULE.id(url);
    const checkIn = url.searchParams.get("check_in");
    const checkOut = url.searchParams.get("check_out");
    const adults = Number.parseInt(url.searchParams.get("adults") || url.searchParams.get("guests") || "1", 10);
    const validDate = /^\d{4}-\d{2}-\d{2}$/;
    return {
      listingId,
      checkIn: validDate.test(checkIn || "") ? checkIn : null,
      checkOut: validDate.test(checkOut || "") ? checkOut : null,
      adults: Number.isFinite(adults) && adults > 0 ? adults : 1
    };
  }

  function selectedAirbnbRate(doc) {
    const sidebar = doc.querySelector("[data-section-id='BOOK_IT_SIDEBAR']");
    if (!sidebar) return null;
    const control = sidebar.querySelector("[role='radio'][aria-checked='true'], input[type='radio']:checked");
    if (!control) return null;
    const container = control.matches("[role='radio']")
      ? control
      : control.closest("[role='radio'], label") || control.parentElement;
    const text = textOf(container);
    const normalized = text.toLowerCase();
    const rate = /non[\s-]*refundable/.test(normalized)
      ? "non-refundable"
      : (/refundable/.test(normalized) ? "refundable" : null);
    const price = priceFromCurrencyText(text, "INR");
    return rate && price ? { rate, price } : null;
  }

  function currencyFrom(element, doc, fallbackText) {
    return (
      (element && (element.getAttribute("content") || element.getAttribute("currency"))) ||
      (doc.querySelector("meta[itemprop='priceCurrency']") || {}).content ||
      (doc.querySelector("meta[property='product:price:currency']") || {}).content ||
      (/₹|\b(?:INR|Rs\.?)\b/i.test(fallbackText || "") ? "INR" : (/\$/.test(fallbackText || "") ? "USD" : null))
    );
  }

  function productNodes(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(productNodes);
    if (typeof value !== "object") return [];
    const type = value["@type"];
    const types = Array.isArray(type) ? type : [type];
    const own = types.includes("Product") ? [value] : [];
    return own.concat(productNodes(value["@graph"]));
  }

  function offerFrom(product) {
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    for (const offer of offers) {
      if (!offer || typeof offer !== "object") continue;
      const nested = offer.priceSpecification || offer;
      const candidate = Array.isArray(nested) ? nested[0] : nested;
      const value = parsePrice(candidate && candidate.price);
      if (value !== null) {
        return {
          value,
          raw: String(candidate.price),
          currency: candidate.priceCurrency || offer.priceCurrency || product.priceCurrency || null
        };
      }
    }
    return null;
  }

  function priceFromJsonLd(doc) {
    const scripts = doc.querySelectorAll("script[type='application/ld+json']");
    for (const script of scripts) {
      try {
        const products = productNodes(JSON.parse(script.textContent));
        for (const product of products) {
          const price = offerFrom(product);
          if (price) return price;
        }
      } catch (_) {
        // Individual JSON-LD blocks on retail pages are often malformed; try the next block.
      }
    }
    return null;
  }

  function priceFromDom(doc, rule) {
    if (rule.isAirbnb) {
      const sidebar = doc.querySelector("[data-section-id='BOOK_IT_SIDEBAR']");
      if (!sidebar) return null;

      // A discounted stay renders its old rate before its payable rate. Exclude
      // amounts styled as struck-through so we never compare the baseline against
      // the promotional "was" price.
      const struckAmounts = new Set();
      sidebar.querySelectorAll("*").forEach((element) => {
        if (getComputedStyle(element).textDecorationLine.includes("line-through")) {
          const amount = priceFromCurrencyText(element.textContent, "INR");
          if (amount) struckAmounts.add(amount.value);
        }
      });
      const amounts = String(sidebar.textContent || "").match(/(?:₹|\$|€|£|\b(?:INR|USD|EUR|GBP)\b)\s*[0-9][0-9,.]*/gi) || [];
      for (const raw of amounts) {
        const amount = priceFromCurrencyText(raw, "INR");
        if (amount && !struckAmounts.has(amount.value)) return amount;
      }
      return null;
    }
    for (const selector of rule.selectors) {
      const element = doc.querySelector(selector);
      const raw = textOf(element);
      const currency = currencyFrom(element, doc, raw);
      // Amazon's mobile markup exposes an accessible sentence such as
      // "₹189.00 with 81 percent savings". Extract its currency amount rather
      // than accidentally treating the savings percentage as price digits.
      const value = priceFromCurrencyText(raw, currency)?.value ?? parsePrice(raw);
      if (value !== null) return { value, raw, currency };
    }
    return null;
  }

  function formatPrice(price) {
    if (!price) return null;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: price.currency || "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(price.value);
    } catch (_) {
      return `${price.currency ? `${price.currency} ` : ""}${price.value.toFixed(2)}`;
    }
  }

  function extract(doc, href) {
    const url = new URL(href);
    const rule = getRule(url);
    if (!rule) return { supported: false, reason: "This is not a supported product page." };
    // These two sites expose an explicit current transaction-price element. Prefer it
    // for the price actually shown to the shopper, then fall back to Product JSON-LD.
    let price = rule.preferDisplayedDom
      ? priceFromDom(doc, rule) || priceFromJsonLd(doc)
      : priceFromJsonLd(doc) || priceFromDom(doc, rule);
    const stay = rule.isAirbnb ? airbnbContext(href) : null;
    const selectedRate = rule.isAirbnb ? selectedAirbnbRate(doc) : null;
    if (stay && selectedRate) {
      stay.rate = selectedRate.rate;
      price = selectedRate.price;
    }
    if (stay && price) stay.displayedRateValue = price.value;
    if (!price) return {
      supported: true,
      productId: rule.id(url) || url.pathname,
      title: doc.title || "Product page",
      airbnb: stay,
      reason: "A product price could not be found on this page."
    };
    return {
      supported: true,
      productId: rule.id(url) || url.pathname,
      title: doc.title || "Product page",
      airbnb: stay,
      price: { ...price, formatted: formatPrice(price) }
    };
  }

  global.PriceExtractor = { extract, formatPrice, getRule, parsePrice, airbnbContext };
})(globalThis);
