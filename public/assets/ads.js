/*
  Shared controller for the manual, in-flow AdSense units. The AdSense loader
  lives in every page's <head>; this module creates units only after that
  loader is ready. Keep Auto Ads disabled so no ad can overlap the simulation.
*/
const ADS = {
  enabled: true,
  client: "ca-pub-1855350767840503", // Keep in sync with the publisher ID in every page head.
  slot: "0000000000",                // Replace with the display-ad unit ID.
  delayMs: 1200,
  fillTimeoutMs: 6000
};

const CLIENT_PATTERN = /^ca-pub-\d{16}$/;
const SLOT_PATTERN = /^\d{10}$/;
const PLACEHOLDER_CLIENT = /^ca-pub-0+$/;
const PLACEHOLDER_SLOT = /^0+$/;

const units = Array.from(document.querySelectorAll("[data-ad-zone]"))
  .map(zone => ({ zone, slot: zone.querySelector("[data-ad-slot]") }))
  .filter(unit => unit.slot);

function log(message) {
  console.info("[ads] " + message);
}

function collapse(unit, reason) {
  log("collapsed: " + reason);
  unit.zone.hidden = true;
  unit.slot.replaceChildren();
  unit.slot.classList.remove("dev");
}

function showDevelopmentPlaceholder(unit) {
  unit.zone.hidden = false;
  unit.slot.classList.add("dev");
  unit.slot.textContent = "Ad unit reserved";
}

function hasConfiguredIds() {
  return CLIENT_PATTERN.test(ADS.client) && SLOT_PATTERN.test(ADS.slot) &&
    !PLACEHOLDER_CLIENT.test(ADS.client) && !PLACEHOLDER_SLOT.test(ADS.slot);
}

function getLoader() {
  const loader = document.getElementById("adsense-loader");
  if (!loader) return null;

  try {
    const client = new URL(loader.src, location.href).searchParams.get("client");
    return client === ADS.client ? loader : null;
  } catch (error) {
    return null;
  }
}

function waitForLoader(loader) {
  if (window.adsbygoogle) return Promise.resolve();

  return new Promise((resolve, reject) => {
    loader.addEventListener("load", resolve, { once: true });
    loader.addEventListener("error", () => reject(new Error("loader failed")), { once: true });
  });
}

function initialise(unit) {
  if (unit.zone.dataset.adsInitialised === "true") return;

  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.cssText = "display:block;width:100%";
  ins.dataset.adClient = ADS.client;
  ins.dataset.adSlot = ADS.slot;
  ins.dataset.adFormat = "horizontal";
  ins.dataset.fullWidthResponsive = "true";

  unit.slot.replaceChildren(ins);
  unit.slot.classList.remove("dev");
  unit.zone.hidden = false;
  unit.zone.dataset.adsInitialised = "true";

  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (error) {
    collapse(unit, "push failed: " + error.message);
    return;
  }

  setTimeout(() => {
    if (!ins.isConnected || unit.zone.hidden) return;
    if (ins.dataset.adStatus === "unfilled" || ins.offsetHeight < 8) {
      collapse(unit, "unfilled");
    }
  }, ADS.fillTimeoutMs);
}

function start() {
  if (!ADS.enabled || !units.length) return;
  if (new URLSearchParams(location.search).has("noads")) return;

  if (!hasConfiguredIds()) {
    units.forEach(showDevelopmentPlaceholder);
    return;
  }

  const loader = getLoader();
  if (!loader) {
    units.forEach(unit => collapse(unit, "missing or mismatched loader"));
    return;
  }

  waitForLoader(loader)
    .then(() => units.forEach(initialise))
    .catch(() => units.forEach(unit => collapse(unit, "loader failed")));
}

setTimeout(start, ADS.delayMs);
