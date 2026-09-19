import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { SoftBody, shapes } from "/assets/softbody.js";
import { createJellyMaterial, mergePreset, DEFAULT_FLAVOUR, DEFAULT_NAME } from "/assets/jelly-shader.js?variant=names-v6";

const $ = id => document.getElementById(id);
const ELASTIC_MODE = location.pathname.startsWith("/elastic-ball/");
const ELASTIC_PRESET = {
  absorptionStrength: 0.6,
  glowDecay: 0.0,
  stressEffectStrength: 0.3
};
const ELASTIC_PHYSICS = {
  damping: 0.02,
  restitution: 0.95,
  stiffness: 1.4,
  wobbleFrequency: 1.3,
  wobbleDecay: 0.05
};
const ELASTIC_RETENTION = 1 - ELASTIC_PHYSICS.damping / 120;
const EVENT_PREFIX = ELASTIC_MODE ? "Elastic Ball" : "Jelly";
function fail(e) {
  console.error(e);
  const box = $("fallback");
  if (box) box.hidden = false;
  const stage = $("stage");
  if (stage) stage.classList.add("dead");
}
addEventListener("error", e => fail(e.error || e.message));
addEventListener("unhandledrejection", e => fail(e.reason));

/* ---------- renderer ---------- */
const app = $("stage");
const renderer = new WebGPURenderer({ antialias: true });
const MAX_PIXEL_RATIO = Math.min(devicePixelRatio, 2);
let renderPixelRatio = MAX_PIXEL_RATIO;
renderer.setPixelRatio(renderPixelRatio);
renderer.setSize(app.clientWidth, app.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);
try { await renderer.init(); window.__jellyReady = true; }
catch (e) { fail(e); throw e; }
$("backend").textContent = (renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2") + " \u00b7 live";

/* ---------- scene ---------- */
const scene = new THREE.Scene();
// A flat background refracts into a flat blob. A soft vertical gradient gives
// the transmission something to bend and reads as a lit studio sweep.
scene.background = (() => {
  const c = document.createElement("canvas"); c.width = 8; c.height = 256;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#f4f1ea"); g.addColorStop(.55, "#e7e4dd"); g.addColorStop(1, "#d5d1c6");
  x.fillStyle = g; x.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const camera = new THREE.PerspectiveCamera(38, app.clientWidth / app.clientHeight, .05, 60);
const LOOK    = new THREE.Vector3(0, -0.12, 0);
const VIEWDIR = new THREE.Vector3(0, 0.46, 1).normalize();
const DIST_MIN = 2.9, DIST_MAX = 12, DIST_STEP = .55;
const FIT_W = 1.98, FIT_H = 1.15;     // half-extents to keep inside the frame
let DIST_FIT = 4.7;
function fitDistance() {
  const vfov = camera.fov * Math.PI / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  return Math.max(FIT_W / Math.tan(hfov / 2), FIT_H / Math.tan(vfov / 2));
}
let dist = 4.7, distWanted = 4.7;
function placeCamera() {
  dist += (distWanted - dist) * .16;
  camera.position.copy(LOOK).addScaledVector(VIEWDIR, dist);
  camera.lookAt(LOOK);
}
const zoomBy = d => {
  distWanted = Math.min(DIST_MAX, Math.max(Math.max(DIST_MIN, DIST_FIT), distWanted + d));
};
$("zin").onclick  = () => zoomBy(-DIST_STEP);
$("zout").onclick = () => zoomBy( DIST_STEP);
addEventListener("wheel", e => zoomBy(Math.sign(e.deltaY) * DIST_STEP * .5), { passive: true });
placeCamera();

scene.add(new THREE.HemisphereLight(0xfff6e8, 0xb9b4a8, .55));
const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(-2.2, 4.2, 2.6); scene.add(key);
const rimL = new THREE.DirectionalLight(0xffe2b4, 1.1); rimL.position.set(3, 1.4, -3.2); scene.add(rimL);

/* A soft studio, painted into an equirect canvas.
   RoomEnvironment is a box of rectangular light panels, and a near-mirror
   clearcoat reflects those panels as hard white rectangles: that is the single
   biggest reason a transmissive blob reads as glazed ceramic rather than
   something wet. Large soft ellipses give long smeared highlights instead. */
function studioEnvironment() {
  const W = 1024, Hh = 512;
  const c = document.createElement("canvas"); c.width = W; c.height = Hh;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, Hh);
  g.addColorStop(0, "#ffffff"); g.addColorStop(.40, "#f3f0e9");
  g.addColorStop(.50, "#d9d5ca"); g.addColorStop(.62, "#a9a599"); g.addColorStop(1, "#5d5a52");
  x.fillStyle = g; x.fillRect(0, 0, W, Hh);
  const blob = (px, py, rx, ry, rgb, a) => {
    x.save(); x.translate(px, py); x.scale(rx, ry);
    const r = x.createRadialGradient(0, 0, 0, 0, 0, 1);
    r.addColorStop(0, `rgba(${rgb},${a})`);
    r.addColorStop(.45, `rgba(${rgb},${a * .45})`);
    r.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = r; x.beginPath(); x.arc(0, 0, 1, 0, Math.PI * 2); x.fill(); x.restore();
  };
  blob(W * .50, Hh * .05, W * .40, Hh * .13, "255,255,255", 1);    // overhead sweep
  blob(W * .24, Hh * .24, W * .17, Hh * .19, "255,251,242", .95);  // key
  blob(W * .78, Hh * .32, W * .14, Hh * .15, "223,234,255", .5);   // cool fill
  blob(W * .58, Hh * .47, W * .26, Hh * .07, "255,255,255", .35);  // horizon kicker
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(studioEnvironment()).texture;
  scene.environmentIntensity = 1.35;
} catch (e) { console.warn("env map skipped", e); }

/* ---------- the body ---------- */
const FLOOR_Y = -0.50;
const body = new SoftBody({
  shape: ELASTIC_MODE ? shapes.sphere(1.0, .98) : shapes.roundedBox({ x: 1.45, y: .42, z: 1.05, radius: .32 }),
  rings: 26, segments: 44, floorY: FLOOR_Y,
  dropHeight: ELASTIC_MODE ? 1.25 : .55,
  damping: ELASTIC_MODE ? ELASTIC_RETENTION : .9955,
  restitution: ELASTIC_MODE ? ELASTIC_PHYSICS.restitution : .3,
  stiffness: ELASTIC_MODE ? ELASTIC_PHYSICS.stiffness : 1,
  wobbleFrequency: ELASTIC_MODE ? ELASTIC_PHYSICS.wobbleFrequency : undefined,
  wobbleDecay: ELASTIC_MODE ? ELASTIC_PHYSICS.wobbleDecay : undefined,
  ripple: ELASTIC_MODE ? 0 : .016
});

const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(body.positions, 3));
geo.setIndex(new THREE.BufferAttribute(body.indices, 1));
geo.computeVertexNormals();

// WebGPU uses the custom WGSL material. WebGL2 retains this physical fallback
// through the same controller, so the interactive specimen still works there.
const jellyMaterial = createJellyMaterial({
  isWebGPU: renderer.backend?.isWebGPUBackend === true,
  vertexCount: body.count,
  restPositions: body.positions,
  preset: ELASTIC_MODE ? ELASTIC_PRESET : undefined
});
let selectedFlavour = DEFAULT_FLAVOUR; // Mint
let selectedName = DEFAULT_NAME;       // Steven
const mat = jellyMaterial.material;
const jelly = new THREE.Mesh(geo, mat);
jelly.frustumCulled = false;
jelly.renderOrder = 1;
scene.add(jelly);

/* ---------- contact shadow ---------- */
const shadowTex = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 160;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(80, 80, 0, 80, 80, 80);
  g.addColorStop(0, "rgba(46,42,32,.30)"); g.addColorStop(.30, "rgba(46,42,32,.20)");
  g.addColorStop(.62, "rgba(46,42,32,.07)"); g.addColorStop(1, "rgba(46,42,32,0)");
  x.fillStyle = g; x.fillRect(0, 0, 160, 160);
  return new THREE.CanvasTexture(c);
})();
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64),
  new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
);
blob.rotation.x = -Math.PI / 2; blob.position.y = FLOOR_Y + .004;
blob.renderOrder = -2; scene.add(blob);

function sync(dt = 0) {
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();          // keeps raycasting valid while it deforms
  jellyMaterial.update(body.positions, dt);
  const { centroid: c, radius, minY } = body.bounds();
  const lift = Math.max(0, minY - FLOOR_Y);
  const s = radius * (.92 + lift * .5);   // tucked inside the silhouette, never rimming it
  blob.scale.set(s, s, 1);
  blob.position.set(c.x, FLOOR_Y + .004, c.z);
  blob.material.opacity = Math.max(0, 1 - lift / 1.1) * .85;
}

/* ---------- grabbing (multi-touch) ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let DRAG_R = 2.1, DRAG_TOP = 1.6;
const DRAG_R0 = DRAG_R, DRAG_TOP0 = DRAG_TOP;
const handles = new Map();            // pointerId -> { handle, plane, target }
function toNDC(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x =  (e.clientX - r.left) / r.width  * 2 - 1;
  ndc.y = -(e.clientY - r.top)  / r.height * 2 + 1;
}
renderer.domElement.addEventListener("pointerdown", e => {
  toNDC(e); ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(jelly, false)[0];
  if (!hit) return;
  const handle = body.grab(hit.point);
  if (!handle) return;
  sendEvent(EVENT_PREFIX + " Click");
  const plane = new THREE.Plane();
  plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
  handles.set(e.pointerId, { handle, plane, target: hit.point.clone(), origin: hit.point.clone() });
  renderer.domElement.setPointerCapture?.(e.pointerId);
  navigator.vibrate?.(8);
});
renderer.domElement.addEventListener("pointermove", e => {
  const h = handles.get(e.pointerId);
  if (!h) return;
  toNDC(e); ray.setFromCamera(ndc, camera);
  if (!ray.ray.intersectPlane(h.plane, h.target)) return;
  // keep the drag inside the bowl and under the ceiling, so you can stretch it
  // hard without ever flinging it out of the scene
  const hr = Math.hypot(h.target.x, h.target.z);
  if (hr > DRAG_R) { h.target.x *= DRAG_R / hr; h.target.z *= DRAG_R / hr; }
  h.target.y = Math.min(DRAG_TOP, Math.max(FLOOR_Y - .2, h.target.y));
  h.handle.move(h.target);
});
const release = e => {
  if (e) {
    handles.get(e.pointerId)?.handle.release();
    handles.delete(e.pointerId);
    renderer.domElement.releasePointerCapture?.(e.pointerId);
  } else { body.releaseAll(); handles.clear(); }
};
renderer.domElement.addEventListener("pointerup", release);
renderer.domElement.addEventListener("pointercancel", release);
addEventListener("blur", () => release());

/* ---------- panel ---------- */
const lerp = (a, b, t) => a + (b - a) * t;
function applyFirmness(v) {
  body.options.shapeMatch = ELASTIC_MODE ? lerp(.02, .08, v * v) : lerp(.003, .05, v);
  body.options.stiffness  = ELASTIC_MODE ? ELASTIC_PHYSICS.stiffness : lerp(.45, 1.5, v);
  $("vFirm").textContent = v.toFixed(2);
}
function applyDamping(v) {
  body.options.damping = ELASTIC_MODE ? lerp(ELASTIC_RETENTION, 1 - .015 / 120, v) : lerp(.9990, .9840, v);
  $("vDamp").textContent = v.toFixed(2);
}
$("firm").oninput = e => applyFirmness(+e.target.value);
$("damp").oninput = e => applyDamping(+e.target.value);

function applyAppearance() {
  jellyMaterial.setAppearance(selectedFlavour, selectedName);
}
for (const b of document.querySelectorAll("#flavours button")) b.onclick = () => {
  for (const o of document.querySelectorAll("#flavours button")) o.setAttribute("aria-pressed", String(o === b));
  selectedFlavour = +b.dataset.f;
  applyAppearance();
};
applyAppearance();
$("nudge").onclick = () => {
  body.impulse({ x: (Math.random() - .5) * 1.9, y: 2.4, z: (Math.random() - .5) * 1.9 }, .5);
  navigator.vibrate?.(12);
};
$("reset").onclick = () => { release(); body.reset(); sync(); };

/* ---------- panel show / hide ---------- */
const panel = $("panel"), tab = $("tab"), cls = document.body.classList;
let hideTimer = null, held = false;
const openPanel = (ms = 1800) => {
  cls.add("panel-open");
  clearTimeout(hideTimer);
  if (!held && !nearPanel) hideTimer = setTimeout(closePanel, ms);
};
function closePanel() { if (!held) cls.remove("panel-open"); }
tab.onclick = () => cls.contains("panel-open") ? (held = false, closePanel()) : openPanel(5000);
let nearPanel = false;
addEventListener("pointermove", e => {
  if (e.pointerType !== "mouse" || handles.size) return;
  const r = panel.getBoundingClientRect();
  const near = e.clientX > r.left - 70 && e.clientX < r.right + 70 &&
               e.clientY > r.top  - 70 && e.clientY < r.bottom + 70;
  if (near) { nearPanel = true; cls.add("panel-open"); clearTimeout(hideTimer); }
  else if (nearPanel) { nearPanel = false; openPanel(700); }
});
panel.addEventListener("pointerdown", () => { held = true; openPanel(); });   // slider drags
addEventListener("pointerup", () => { if (held) { held = false; openPanel(2500); } });
panel.addEventListener("input", () => openPanel(2500));
openPanel(3200);                                           // a peek on load

/* ---------- loop ---------- */
function resize() {
  const w = app.clientWidth, h = app.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  DIST_FIT = fitDistance();
  if (distWanted < DIST_FIT) distWanted = DIST_FIT;
}
addEventListener("resize", resize);
new ResizeObserver(resize).observe(app);

let last = performance.now();

renderer.setAnimationLoop(now => {
  const rawDt = (now - last) / 1000; last = now;
  const dt = ELASTIC_MODE ? Math.max(0, Math.min(.1, rawDt)) : rawDt;
  body.step(dt);
  sync(dt);
  placeCamera();
  tick(dt);
  renderer.render(scene, camera);
});


/* ================= free-tier extras ================= */

/* --- naming ---------------------------------------------------------------
   Purely cosmetic: the chosen name replaces the study number above the stage.
   Nothing is written to storage, so the privacy and cookie pages stay true. */
const NAME_SLOT = $("studyid");
let specimenName = null;
function setName(n) {
  specimenName = n;
  selectedName = n.toLowerCase();
  NAME_SLOT.textContent = n;
  for (const b of document.querySelectorAll("#names button"))
    b.setAttribute("aria-pressed", String(b.dataset.n === n));
  jellyMaterial.setNamePreset(selectedName);
  const s = mergePreset(selectedFlavour, selectedName).sliders[ELASTIC_MODE ? "ball" : "jelly"];
  $("firm").value = s.firmness; $("damp").value = s.damping;
  applyFirmness(s.firmness);
  applyDamping(s.damping);
}
for (const b of document.querySelectorAll("#names button"))
  b.onclick = () => setName(b.dataset.n);
setName(DEFAULT_NAME[0].toUpperCase() + DEFAULT_NAME.slice(1));

/* --- haptics ---------------------------------------------------------------
   navigator.vibrate takes a duration, not an intensity, so stretch is mapped to
   pulse length and repeat rate. Android only: iOS Safari does not implement it. */
const HAPTICS = !!navigator.vibrate;
let lastBuzz = 0;
function stretchAmount() {
  let far = 0;
  for (const h of handles.values()) {
    const d = Math.hypot(h.target.x - h.origin.x, h.target.y - h.origin.y, h.target.z - h.origin.z);
    if (d > far) far = d;
  }
  return far;
}
function haptics(now) {
  if (!HAPTICS || handles.size === 0) return;
  const s = stretchAmount();
  if (s < .28) return;
  const t = Math.min(1, (s - .28) / 1.5);
  const gap = 150 - t * 90;                 // faster the further you pull
  if (now - lastBuzz < gap) return;
  lastBuzz = now;
  navigator.vibrate(Math.round(4 + t * 16));
}

/* --- charge and mega stretch ------------------------------------------------
   The problem with a reward at 30 seconds is that nobody holds on for 30
   seconds without a reason. So the meter appears after barely a second of
   contact, the label talks, and the jelly itself brightens as it charges. The
   countdown afterwards is the same line draining back down: no digits. */
const MEGA_EARN = 30, MEGA_LASTS = 25, DECAY = .7;
const charge = $("charge"), chargeFill = $("chargefill"), chargeLabel = $("chargelabel");
const STAGES = [
  [0,   "Keep hold"],
  [.28, "Something is building"],
  [.62, "Nearly there"],
  [.88, "Ready"]
];
let streak = 0, megaLeft = 0, megaShape = null, lastLabel = "", ticked = 0;
const BASE_EMISSIVE = .045;
let internalGlow = BASE_EMISSIVE;

function setInternalGlow(intensity) {
  internalGlow = intensity;
  jellyMaterial.setInternalGlow(intensity);
}

function label(txt) {
  if (txt === lastLabel) return;
  lastLabel = txt;
  chargeLabel.textContent = txt;
}

function megaOn() {
  megaLeft = MEGA_LASTS;
  streak = 0;
  DRAG_R = DRAG_R0 * 1.55;
  DRAG_TOP = DRAG_TOP0 * 1.5;
  megaShape = body.options.shapeMatch;
  body.options.shapeMatch = megaShape * .58;
  charge.classList.add("mega");
  charge.classList.remove("ready");
  label("Mega stretch");
  setInternalGlow(1.1);                         // flash, decays over the next second
  if (HAPTICS) navigator.vibrate([22, 55, 22, 55, 60]);
}

function megaOff() {
  megaLeft = 0; streak = 0; ticked = 0;
  DRAG_R = DRAG_R0; DRAG_TOP = DRAG_TOP0;
  if (megaShape !== null) { body.options.shapeMatch = megaShape; megaShape = null; }
  charge.classList.remove("mega", "ready", "on");
  chargeFill.style.width = "0%";
  setInternalGlow(BASE_EMISSIVE);
  lastLabel = "";
}

/* --- oscillation / rest analytics -------------------------------------------
   kineticEnergy() approximates mean-square vertex velocity. Measured live: an
   active wobble ranges roughly 0.5-10 right after release, decaying through
   it; settled floor-contact jitter never reaches zero and keeps blipping as
   high as ~0.01. A raw instantaneous reading would make "0.5s continuously
   below threshold" nearly unreachable, so ke is smoothed with an exponential
   moving average first — a single noisy frame near the floor bounce can no
   longer reset the rest timer or falsely trigger oscillation. Hysteresis (a
   lower "off" threshold than "on") plus the hold delay give the smoothing a
   moment to settle before "Jelly Rest" fires. */
const MOTION_ON = .05, MOTION_OFF = .008, REST_HOLD = .6, KE_SMOOTH = .12;
let wobbling = false, restFor = 0, keSmoothed = 0;
function trackMotion(dt) {
  keSmoothed += (body.kineticEnergy() - keSmoothed) * KE_SMOOTH;
  if (!wobbling && keSmoothed > MOTION_ON) {
    wobbling = true; restFor = 0;
    sendEvent(EVENT_PREFIX + " Oscillation", { energy: keSmoothed });
  } else if (wobbling) {
    if (keSmoothed < MOTION_OFF) {
      restFor += dt;
      if (restFor > REST_HOLD) { wobbling = false; sendEvent(EVENT_PREFIX + " Rest"); }
    } else restFor = 0;
  }
}

/* --- performance analytics ---------------------------------------------
   fpsSmoothed/frameMsSmoothed are EMAs sampled every 15s and sent as one
   "Performance" event while the tab is visible. frameTimeMs is JS wall-clock
   time per frame (physics + render + everything else on the main thread) —
   a proxy for render cost, not a true GPU hardware timestamp: that needs the
   WebGPU timestamp-query feature, which isn't requested at renderer.init()
   above and has no Safari support. Fine for comparing relative performance
   across pages/sessions, not for isolating GPU-only time. */
let fpsSmoothed = 60, frameMsSmoothed = 16;
let overBudgetFor = 0, headroomFor = 0;
const MOBILE_RENDERER = matchMedia("(max-width: 720px), (pointer: coarse)");

function tuneMobileResolution(dt) {
  if (!MOBILE_RENDERER.matches || dt <= 0) return;

  if (dt > 1 / 48) {
    overBudgetFor += dt;
    headroomFor = 0;
  } else if (dt < 1 / 58) {
    headroomFor += dt;
    overBudgetFor = 0;
  } else {
    overBudgetFor = 0;
    headroomFor = 0;
  }

  if (overBudgetFor > 1.5 && renderPixelRatio > 1) {
    renderPixelRatio = Math.max(1, renderPixelRatio - .25);
    renderer.setPixelRatio(renderPixelRatio);
    overBudgetFor = 0;
  } else if (headroomFor > 6 && renderPixelRatio < MAX_PIXEL_RATIO) {
    renderPixelRatio = Math.min(MAX_PIXEL_RATIO, renderPixelRatio + .25);
    renderer.setPixelRatio(renderPixelRatio);
    headroomFor = 0;
  }
}

function trackPerformance(dt) {
  if (dt <= 0) return;
  const fps = 1 / dt;
  fpsSmoothed += (fps - fpsSmoothed) * .05;
  frameMsSmoothed += (dt * 1000 - frameMsSmoothed) * .05;
  tuneMobileResolution(dt);
}
setInterval(() => {
  if (document.visibilityState === "visible") {
    sendEvent("Performance", { fps: Math.round(fpsSmoothed), frameTimeMs: +frameMsSmoothed.toFixed(2) });
  }
}, 15000);

function tick(dt) {
  trackMotion(dt);
  trackPerformance(dt);
  haptics(performance.now());

  if (megaLeft > 0) {
    megaLeft -= dt;
    const left = Math.max(0, megaLeft / MEGA_LASTS);
    chargeFill.style.width = (left * 100).toFixed(1) + "%";
    // the flash fades back to a steady glow
    setInternalGlow(Math.max(.42, internalGlow - dt * 1.6));
    if (megaLeft <= 0) megaOff();
    return;
  }

  // Holding builds the streak; letting go bleeds it away rather than wiping it,
  // so repositioning your finger does not cost you everything.
  if (handles.size > 0) streak = Math.min(MEGA_EARN, streak + dt);
  else streak = Math.max(0, streak - dt * DECAY);

  const t = streak / MEGA_EARN;
  charge.classList.toggle("on", streak > 1.1);
  charge.classList.toggle("ready", t >= .88);
  chargeFill.style.width = (t * 100).toFixed(1) + "%";
  for (let i = STAGES.length - 1; i >= 0; i--)
    if (t >= STAGES[i][0]) { label(STAGES[i][1]); break; }

  // the specimen lights up from within as it charges
  setInternalGlow(BASE_EMISSIVE + t * t * .26);

  if (HAPTICS && handles.size > 0) {
    if (t >= .62 && ticked < 1) { ticked = 1; navigator.vibrate(10); }
    if (t >= .88 && ticked < 2) { ticked = 2; navigator.vibrate([10, 40, 10]); }
  }
  if (streak >= MEGA_EARN) megaOn();
}

// The firmness slider owns shapeMatch, so it has to respect an active mega.
const _applyFirmness = applyFirmness;
applyFirmness = v => {
  _applyFirmness(v);
  if (megaLeft > 0) { megaShape = body.options.shapeMatch; body.options.shapeMatch = megaShape * .58; }
};
$("reset").addEventListener("click", megaOff);
