/* Shared advertising loader.
   One slot, in the page flow, loaded after the page has settled, collapsing to
   nothing when it cannot be filled. No interstitials, no vignettes, and Auto Ads
   must stay switched off in the AdSense console: Auto Ads injects its own
   overlays and would undo the no-overlap guarantee. */
const ADS = {
  enabled: true,
  client: "ca-pub-0000000000000000",   // <-- your AdSense publisher ID
  slot:   "0000000000",                // <-- your display unit ID
  delayMs: 1200,
  fillTimeoutMs: 6000
};

const zone = document.getElementById("adzone");
const slot = document.getElementById("adslot");

function collapse(why) {
  console.info("[ads] collapsed:", why);
  if (zone) zone.hidden = true;
  if (slot) slot.innerHTML = "";
}

function start() {
  if (!zone || !slot) return;
  if (new URLSearchParams(location.search).has("noads")) return;
  if (!ADS.enabled) return;

  if (/^ca-pub-0+$/.test(ADS.client) || /^0+$/.test(ADS.slot)) {
    // Reserved space made visible during development. No request is ever sent
    // with placeholder identifiers.
    slot.classList.add("dev");
    slot.textContent = "Ad slot reserved";
    zone.hidden = false;
    return;
  }

  zone.hidden = false;
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.cssText = "display:block;width:100%";
  ins.dataset.adClient = ADS.client;
  ins.dataset.adSlot = ADS.slot;
  ins.dataset.adFormat = "horizontal";
  ins.dataset.fullWidthResponsive = "true";
  slot.appendChild(ins);

  const sc = document.createElement("script");
  sc.async = true;
  sc.crossOrigin = "anonymous";
  sc.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" +
           encodeURIComponent(ADS.client);
  sc.onerror = () => collapse("script blocked or failed");
  sc.onload = () => {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
    catch (e) { collapse("push failed: " + e.message); }
  };
  document.head.appendChild(sc);

  // Unfilled units report it on the element. Collapsing those is the documented
  // behaviour, not ad hiding.
  setTimeout(() => {
    if (zone.hidden) return;
    if (ins.dataset.adStatus === "unfilled" || ins.offsetHeight < 8) collapse("unfilled");
  }, ADS.fillTimeoutMs);
}

setTimeout(start, ADS.delayMs);
