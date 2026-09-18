/**
 * Shared analytics client, loaded on every page. Exposes a single global
 * sendEvent(event, extra) and auto-fires one "Pageview" per page load.
 *
 * Visitor identity: a random id in sessionStorage, not a cookie. It is
 * generated fresh per browser tab, never written to disk, and gone as soon
 * as the tab closes — it never persists across visits or devices. It exists
 * only so the worker can link this one visit's later events (e.g. a Jelly
 * Click) back to how that same visit arrived (e.g. from TikTok), which a
 * purely per-event log cannot do on its own.
 */
(function () {
  function sessionId() {
    try {
      var KEY = "wobble_sid";
      var id = sessionStorage.getItem(KEY);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(KEY, id);
      }
      return id;
    } catch (e) { return null; }
  }

  window.sendEvent = function (event, extra) {
    try {
      var body = JSON.stringify({
        event: event,
        page: location.pathname,
        sid: sessionId(),
        extra: extra || null
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/event", new Blob([body], { type: "application/json" }));
      } else {
        fetch("/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true });
      }
    } catch (e) {}
  };

  window.sendEvent("Pageview", { referrer: document.referrer || null });
})();
