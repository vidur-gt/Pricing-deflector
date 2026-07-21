chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "PARSE_BASELINE_HTML") return;
  try {
    const document = new DOMParser().parseFromString(message.html, "text/html");
    sendResponse(PriceExtractor.extract(document, message.url));
  } catch (error) {
    console.warn("Price Deflector could not parse baseline HTML", error);
    sendResponse({ supported: true, reason: "The baseline page could not be parsed." });
  }
});
