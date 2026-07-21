# Price Deflector

A narrow Manifest V3 proof of concept that compares a price shown to the current shopper with a clean local baseline. It supports Amazon India, Flipkart, and date-specific Airbnb India listings.

## Setup

### Prerequisites

- Desktop Google Chrome 109 or later.
- No package installation, build command, account, API key, proxy, or backend is needed.

### Load the extension

1. Download or clone this project to a local folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Select this project folder - the folder containing `manifest.json`.
6. Pin **Price Deflector** from Chrome's Extensions menu so its badge is visible.
7. After changing an extension file, reload the extension on `chrome://extensions`, then refresh the target page.

### Run your first check

1. Open one supported listing, not a home, category, search, basket, or checkout page:
   - Amazon India: `https://www.amazon.in/dp/<ASIN>` or `https://www.amazon.in/gp/product/<ASIN>`
   - Flipkart: `https://www.flipkart.com/<product-slug>/p/<product-id>`
   - Airbnb India: `https://www.airbnb.co.in/rooms/<listing-id>?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD&adults=1`
2. Let the page finish loading. The extension starts automatically.
3. Wait for the badge:
   - Grey `?`: unsupported page or no comparable price.
   - Blue `...`: a baseline comparison is in progress.
   - Green `OK`: comparison completed and the difference is below 3%.
   - Amber `!`: a difference from 3% to under 10% was detected.
   - Red `!`: a difference of 10% or more was detected.
4. Open the extension popup to see **Price shown to you**, **Baseline check**, the percentage difference, and the caveat.
5. Wait at least three seconds before selecting **Re-check**. Rapid checks are throttled.
6. On an Amazon India or Flipkart product page, select **Compare source prices** to run separate clean requests for Desktop Chrome, Android Chrome, and iPhone Safari user-agent profiles. The popup labels the lowest verified response.

When a meaningful difference is detected, a short in-page alert appears automatically. Normal matches stay quiet and are indicated by the badge; select the extension icon when you want the full comparison view. Chrome does not permit an extension to open its toolbar popup without a user gesture.

Prices are formatted as INR when the page exposes Indian rupees.

## Privacy and scope

All results remain in `chrome.storage.local`. There is no backend, account, analytics, or data collection. Requests use `credentials: "omit"`, `referrerPolicy: "no-referrer"`, and `cache: "no-store"`. A result is cleared as soon as its tab navigates to a different URL, so it cannot appear on a later search or homepage.

Amazon and Flipkart use a clean fetch of the listing page. The on-demand Source comparison uses Chrome's declarative request rules to set a temporary User-Agent only on the extension worker's own clean request. It never changes the tab's requests. Airbnb normalizes an apex-host listing to canonical `www.airbnb.co.in`, then uses its own cookie-free, same-origin booking quote because its price is client-rendered. The extension never uses a proxy or contacts a third-party service.

### Source comparison limits

Desktop Chrome is the normal clean baseline. Android Chrome and iPhone Safari are User-Agent profiles, not real-device emulators: they do not change the browser engine, viewport, client hints, locale, location, account, payment eligibility, or app-only offers. A lowest result means only that the retailer returned a lower comparable page price to that request profile. It is not proof that a shopper can complete a purchase for that amount.

Airbnb is deliberately excluded from source comparison. Its first-party booking quote must run from the active Airbnb page, and changing a request User-Agent would not create a trustworthy Android or iOS booking session.

If an Android or iPhone profile is at least 3% below the price currently shown, the popup exposes **Buy at the best price**. It opens the retailer in a new tab with that profile's User-Agent applied only to that tab until it is closed. The retailer can still change the price at checkout, so treat it as a best-price attempt rather than a price guarantee.

The hidden parser document exists only while a baseline HTML parse is active. It is automatically closed after three seconds of idle time.

## Test targets

| Domain | Test URL pattern | POC status | Expected result |
| --- | --- | --- | --- |
| Amazon India | `/dp/<ASIN>` or `/gp/product/<ASIN>` | Supported | A comparison when the page exposes an active price. |
| Flipkart | `/<product-slug>/p/<product-id>` | Supported | A comparison when the page exposes an active price. |
| Airbnb India | `/rooms/<listing-id>?check_in=...&check_out=...&adults=...` | Supported with dates | A comparison of the displayed total stay price with a clean first-party booking quote. |

### Airbnb price context

Airbnb prices depend on dates, guests, availability, and fees. Give the listing explicit `check_in` and `check_out` dates; use `adults` to set the guest count. The extension reads the rendered booking-sidebar total, then checks it against Airbnb's same-origin booking quote for exactly those stay inputs.

If Airbnb does not return a bookable price for the selected stay, the extension remains neutral. It never converts an unavailable stay into a zero-price comparison or a discrepancy claim.

## Manual QA

| # | Test | Steps | Expected result |
| --- | --- | --- | --- |
| 1 | Control / no difference | Open a supported Amazon India, Flipkart, or date-specific Airbnb India URL in a fresh Chrome profile. | Green badge for a delta below 3%; both raw INR prices appear in the popup. |
| 2 | Logged-in comparison | Sign in to the retailer, load the same supported URL, and open the popup. | Raw prices and delta appear. A zero delta still confirms the comparison path works. |
| 3 | Unsupported page | Open either retailer's homepage or a search result. | Neutral badge and "Couldn't verify this page." |
| 4 | Missing or unavailable price | Test an unavailable product or unbookable stay. | Neutral status; no zero-value comparison or discrepancy claim. |
| 5 | Rapid re-check | Click **Re-check** five times quickly. | Only the first check in a three-second window runs. |
| 6 | Noise threshold | Mock two prices 1% apart while debugging the extractor. | Green badge, not a discrepancy flag. |
| 7 | Local-only behavior | Open DevTools > Network, then load a supported listing and re-check. | Requests remain on the same retailer or listing site. Airbnb additionally calls its own first-party booking-price endpoint; no analytics or backend calls occur. |
| 8 | Airbnb comparison | Open an Airbnb India room URL with dates and adults. | Popup compares the displayed total with Airbnb's clean booking quote, or stays neutral if the stay is not bookable. |
| 9 | Source comparison | On a supported Amazon India or Flipkart product page, open the popup and select **Compare source prices**. | Desktop, Android, and iPhone profiles list verified returned prices; the lowest verified response is labelled. Profiles that do not expose a comparable price show as unavailable. |

## Troubleshooting

- **Badge stays grey:** wait for the listing to finish loading, then refresh once. Some retailer variants and unavailable stays do not expose a price.
- **Popup says "Couldn't verify this page":** the visible price or clean baseline was unavailable. This is a safe failure, not a zero-price result.
- **Airbnb stays neutral:** set both dates and an adult count in the listing URL, and choose a bookable stay.
- **Changes do not appear:** reload the extension at `chrome://extensions`, then refresh the listing page.
- **A retailer blocks the baseline request:** the extension remains neutral. Do not add proxies, cookie copying, login replay, or third-party services.
- **A source profile is unavailable:** that retailer returned a different page shape or blocked the clean request. It is not treated as a price difference.

## Markup validation (21 July 2026)

- Flipkart product URLs use the stable `/p/itm...` identifier and expose a `Product` JSON-LD offer with `price` and `priceCurrency: "INR"`.
- Amazon India `/dp/<ASIN>` responses expose transaction prices through `.apex-pricetopay-value .a-offscreen`.
- A live Airbnb India listing returned an INR two-night total through its same-origin `StaysPdpBookItQuery` booking flow.
