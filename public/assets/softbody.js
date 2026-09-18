/**
 * softbody.js — a zero-dependency pressure + shape-matched soft body solver.
 *
 * Produces a deforming closed triangle mesh you can hand to any renderer:
 * `positions` is a Float32Array you can bind directly as a vertex buffer, and
 * `indices` never changes.
 *
 *   import { SoftBody, shapes } from "./softbody.js";
 *
 *   const body = new SoftBody({ shape: shapes.roundedBox({ x: 1.45, y: .42, z: 1.05, radius: .32 }) });
 *   const grab = body.grab(worldPoint);      // returns null if nothing is near
 *   grab.move({ x, y, z });                  // per frame
 *   grab.release();
 *   body.step(dtSeconds);                    // fixed 1/120 substeps internally
 *
 * Solver, in order, per substep:
 *   forces (gravity, gas pressure, bowl, ceiling) -> Verlet -> N relaxation
 *   passes of [distance springs, shape match, grabs, floor] -> floor bounce.
 *
 * The shape-matching constraint is what stops a surface-only mesh from folding
 * into a dent it can never pop out of. A distance-to-centroid tether is cheaper
 * but perfectly happy with an inside-out mesh.
 */

/* ------------------------------------------------------------------ shapes */
/** A shape is `(dx, dy, dz) => distance from origin to the surface along that unit direction`. */
export const shapes = {
  sphere: (radius = 1, squashY = 1) => (dx, dy, dz) => {
    // ellipsoid radius along a unit direction
    const a = radius, b = radius * squashY;
    return 1 / Math.hypot(dx / a, dy / b, dz / a);
  },

  ellipsoid: (x = 1, y = 1, z = 1) => (dx, dy, dz) => 1 / Math.hypot(dx / x, dy / y, dz / z),

  roundedBox: ({ x = 1, y = 1, z = 1, radius = .2 } = {}) => {
    const bx = x - radius, by = y - radius, bz = z - radius;
    const sd = (px, py, pz) => {
      const qx = Math.abs(px) - bx, qy = Math.abs(py) - by, qz = Math.abs(pz) - bz;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0))
           + Math.min(Math.max(qx, qy, qz), 0) - radius;
    };
    return (dx, dy, dz) => {          // sphere-trace outward from the origin
      let t = .5;
      for (let i = 0; i < 40; i++) {
        const d = sd(t * dx, t * dy, t * dz);
        t -= d;
        if (Math.abs(d) < 1e-9) break;
      }
      return t;
    };
  }
};

/* ------------------------------------------------------------- 3x3 helpers */
const det3 = m => m[0]*(m[4]*m[8]-m[5]*m[7]) - m[1]*(m[3]*m[8]-m[5]*m[6]) + m[2]*(m[3]*m[7]-m[4]*m[6]);

function invT3(m, out) {              // inverse-transpose = cofactors / det
  const d = det3(m);
  if (Math.abs(d) < 1e-12) return false;
  const s = 1 / d;
  out[0]=(m[4]*m[8]-m[5]*m[7])*s; out[1]=(m[5]*m[6]-m[3]*m[8])*s; out[2]=(m[3]*m[7]-m[4]*m[6])*s;
  out[3]=(m[2]*m[7]-m[1]*m[8])*s; out[4]=(m[0]*m[8]-m[2]*m[6])*s; out[5]=(m[1]*m[6]-m[0]*m[7])*s;
  out[6]=(m[1]*m[5]-m[2]*m[4])*s; out[7]=(m[2]*m[3]-m[0]*m[5])*s; out[8]=(m[0]*m[4]-m[1]*m[3])*s;
  return true;
}

/**
 * Rotation part of `m`, by Newton iteration R <- (R + R^-T) / 2.
 * The pre-scale is load bearing. Apq has singular values in the hundreds and
 * each step only halves them, so without normalising first, 12 steps still
 * leave a residual scale near 1.3 and the body silently inflates.
 */
function polar(m, out, tmp) {
  out.set(m);
  const d0 = Math.abs(det3(out));
  if (d0 < 1e-12) return false;
  const s0 = 1 / Math.cbrt(d0);
  for (let k = 0; k < 9; k++) out[k] *= s0;
  for (let n = 0; n < 12; n++) {
    if (!invT3(out, tmp)) return false;
    let diff = 0;
    for (let k = 0; k < 9; k++) { const v = .5 * (out[k] + tmp[k]); diff += Math.abs(v - out[k]); out[k] = v; }
    if (diff < 1e-10) break;
  }
  return det3(out) > 0;
}

/* ------------------------------------------------------------------- build */
/**
 * Lay a lat/lon grid over an arbitrary shape, with single welded pole vertices.
 * Rings are spaced by arc length along each meridian and azimuths by arc length
 * round the equator. Uniform angle instead of arc length gives a wide flat slab
 * hair-thin triangles at the face centres and stretched ones down the long
 * sides: 30:1 edge-length ratio versus about 8:1 this way.
 */
function buildRest(shape, rings, segments) {
  const FINE_M = 900, FINE_A = 1440;

  const azimuths = () => {
    const ang = [], arc = [0];
    let px = 0, pz = 0;
    for (let m = 0; m <= FINE_A; m++) {
      const t = 2 * Math.PI * m / FINE_A;
      const r = shape(Math.cos(t), 0, Math.sin(t));
      const x = r * Math.cos(t), z = r * Math.sin(t);
      ang.push(t);
      if (m) arc.push(arc[m-1] + Math.hypot(x - px, z - pz));
      px = x; pz = z;
    }
    const total = arc[FINE_A], out = [];
    let m = 0;
    for (let j = 0; j < segments; j++) {
      const want = total * j / segments;
      while (m < FINE_A && arc[m+1] < want) m++;
      const seg = arc[m+1] - arc[m], f = seg > 1e-12 ? (want - arc[m]) / seg : 0;
      out.push(ang[m] + (ang[m+1] - ang[m]) * f);
    }
    return out;
  };

  const meridian = t => {
    const ct = Math.cos(t), st = Math.sin(t);
    const X = [], Y = [], Z = [], arc = [0];
    for (let m = 0; m <= FINE_M; m++) {
      const phi = Math.PI * m / FINE_M, sp = Math.sin(phi), cp = Math.cos(phi);
      const r = shape(sp * ct, cp, sp * st);
      const x = r * sp * ct, y = r * cp, z = r * sp * st;
      X.push(x); Y.push(y); Z.push(z);
      if (m) arc.push(arc[m-1] + Math.hypot(x - X[m-1], y - Y[m-1], z - Z[m-1]));
    }
    const total = arc[FINE_M], out = [];
    let m = 0;
    for (let i = 0; i <= rings; i++) {
      const want = total * i / rings;
      while (m < FINE_M && arc[m+1] < want) m++;
      const seg = arc[m+1] - arc[m], f = seg > 1e-12 ? (want - arc[m]) / seg : 0;
      out.push([X[m] + (X[m+1]-X[m])*f, Y[m] + (Y[m+1]-Y[m])*f, Z[m] + (Z[m+1]-Z[m])*f]);
    }
    return out;
  };

  const count = 2 + (rings - 1) * segments;
  const rest = new Float32Array(count * 3);
  const AZ = azimuths();
  for (let j = 0; j < segments; j++) {
    const prof = meridian(AZ[j]);
    for (let i = 0; i <= rings; i++) {
      if ((i === 0 || i === rings) && j > 0) continue;
      const k = vertexId(i, j, rings, segments) * 3, p = prof[i];
      rest[k] = p[0]; rest[k+1] = p[1]; rest[k+2] = p[2];
    }
  }
  return rest;
}

const vertexId = (i, j, rings, segments) =>
  i === 0 ? 0
  : i === rings ? 1 + (rings - 1) * segments
  : 1 + (i - 1) * segments + ((j % segments) + segments) % segments;

/* ---------------------------------------------------------------- SoftBody */
const DEFAULTS = {
  shape: null,
  rings: 26,
  segments: 44,
  ripple: .016,          // low-frequency wobble baked into the rest shape
  dropHeight: .55,       // starts this far above rest so it lands with a wobble

  gravity: -7.5,
  damping: .9955,        // per substep velocity retention; lower settles faster
  passes: 4,
  pressure: 26,          // gas term resisting volume loss
  shapeMatch: .012,      // master softness knob; lower is squishier
  stiffness: 1,          // multiplier on every spring
  floorY: -.5,
  friction: .6,
  restitution: .3,

  recenter: 3.5,         // bowl force pulling the body back to x = z = 0
  recenterStart: 1,      // beyond this radius the bowl steepens hard
  recenterEdge: 8,
  recenterMax: 14,
  ceiling: 1.4,          // soft lid so impulses cannot launch the body away
  ceilingK: 26,

  grabRadius: .62,
  grabStrength: .5,

  substep: 1 / 120,
  maxSubsteps: 4
};

export class SoftBody {
  constructor(opts = {}) {
    const o = this.options = { ...DEFAULTS, ...opts };
    if (!o.shape) o.shape = shapes.sphere(1);

    const rings = o.rings, segments = o.segments;
    this.rings = rings; this.segments = segments;
    this.count = 2 + (rings - 1) * segments;
    this.vid = (i, j) => vertexId(i, j, rings, segments);

    // rest shape
    const rest = buildRest(o.shape, rings, segments);
    if (o.ripple) for (let i = 0; i < this.count; i++) {
      const x = rest[i*3], y = rest[i*3+1], z = rest[i*3+2];
      const s = 1 + o.ripple * Math.sin(x * 3.1 + 1.2) * Math.cos(z * 2.7)
                  + o.ripple * .75 * Math.sin(z * 4.3 - .6) * Math.cos(y * 5.0);
      rest[i*3] = x * s; rest[i*3+1] = y * s; rest[i*3+2] = z * s;
    }
    this.rest = rest;

    this.positions = new Float32Array(this.count * 3);
    this._prev = new Float32Array(this.count * 3);
    this._acc  = new Float32Array(this.count * 3);
    this.reset();

    // An index buffer is not optional: without one the GPU draws unrelated
    // vertex triples (0,1,2)(3,4,5)... and you get a cloud of loose triangles.
    const idx = [];
    for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) {
      const a = this.vid(i, j), b = this.vid(i+1, j), c = this.vid(i+1, j+1), d = this.vid(i, j+1);
      if (i === 0)             idx.push(a, c, b);          // north cap fan
      else if (i === rings - 1) idx.push(a, d, b);          // south cap fan
      else                     idx.push(a, d, b, b, d, c); // quad, outward winding
    }
    this.indices = this.count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
    this._tri = idx;

    this._buildSprings();
    this.restVolume = this.volume();

    // shape-matching rest offsets, about the rest centroid
    this._q = new Float32Array(this.count * 3);
    let qx = 0, qy = 0, qz = 0;
    for (let i = 0; i < this.count; i++) { qx += rest[i*3]; qy += rest[i*3+1]; qz += rest[i*3+2]; }
    qx /= this.count; qy /= this.count; qz /= this.count;
    for (let i = 0; i < this.count; i++) {
      this._q[i*3] = rest[i*3]-qx; this._q[i*3+1] = rest[i*3+1]-qy; this._q[i*3+2] = rest[i*3+2]-qz;
    }
    this._A = new Float64Array(9); this._R = new Float64Array(9); this._T = new Float64Array(9);

    this.centroid = { x: 0, y: 0, z: 0 };
    this._grabs = new Map();
    this._gid = 0;
    this._acc_t = 0;
  }

  _buildSprings() {
    const p = this.positions, S = [];
    const d = (a, b) => Math.hypot(p[a*3]-p[b*3], p[a*3+1]-p[b*3+1], p[a*3+2]-p[b*3+2]);
    const add = (a, b, k) => { if (a !== b) S.push(a, b, d(a, b), k); };
    const { rings, segments } = this, v = this.vid;
    for (let i = 1; i < rings; i++) for (let j = 0; j < segments; j++) add(v(i, j), v(i, j+1), .46);
    for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) {
      add(v(i, j), v(i+1, j), .48);
      if (i > 0 && i < rings - 1) add(v(i, j), v(i+1, j+1), .18);    // shear
    }
    for (let i = 0; i <= rings-2; i++) for (let j = 0; j < segments; j++) add(v(i, j), v(i+2, j), .10);
    for (let i = 1; i < rings;    i++) for (let j = 0; j < segments; j++) add(v(i, j), v(i, j+2), .10);
    this.springs = S;
  }

  /** Restore the rest shape, at rest, lifted by `dropHeight`. */
  reset() {
    const { positions: p, _prev: q, rest, options: o } = this;
    p.set(rest); q.set(rest);
    if (o.dropHeight) for (let i = 0; i < this.count; i++) { p[i*3+1] += o.dropHeight; q[i*3+1] += o.dropHeight; }
    this._grabs?.clear();
  }

  /** Signed volume of the closed mesh. Positive means outward-facing winding. */
  volume() {
    const p = this.positions, t = this._tri;
    let v = 0;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k]*3, b = t[k+1]*3, c = t[k+2]*3;
      v += (p[a]   * (p[b+1]*p[c+2] - p[b+2]*p[c+1])
          - p[a+1] * (p[b]  *p[c+2] - p[b+2]*p[c])
          + p[a+2] * (p[b]  *p[c+1] - p[b+1]*p[c])) / 6;
    }
    return v;
  }

  /** Sum of 0.5 m v^2 over all vertices, for `totalMass` in whatever unit you like. */
  kineticEnergy(totalMass = 1) {
    const { positions: p, _prev: q, options: o } = this;
    const m = totalMass / this.count, inv = 1 / o.substep;
    let ke = 0;
    for (let i = 0; i < this.count; i++) {
      const vx = (p[i*3]-q[i*3])*inv, vy = (p[i*3+1]-q[i*3+1])*inv, vz = (p[i*3+2]-q[i*3+2])*inv;
      ke += .5 * m * (vx*vx + vy*vy + vz*vz);
    }
    return ke;
  }

  /** Uniform velocity impulse plus optional per-vertex jitter. Units are per second. */
  impulse({ x = 0, y = 0, z = 0 } = {}, jitter = 0) {
    const h = this.options.substep, q = this._prev;
    for (let i = 0; i < this.count; i++) {
      q[i*3]   -= (x + (Math.random()-.5)*jitter) * h;
      q[i*3+1] -= (y + (Math.random()-.5)*jitter) * h;
      q[i*3+2] -= (z + (Math.random()-.5)*jitter) * h;
    }
  }

  /**
   * Grab every vertex within `grabRadius` of `point`, weighted by a smoothstep
   * falloff so the pull blends into the surrounding surface instead of pinching
   * a cone. Returns null if nothing is in range; otherwise a handle with
   * `.move(point)` and `.release()`. Multiple grabs can be live at once.
   */
  grab(point, { radius = this.options.grabRadius } = {}) {
    const p = this.positions, list = [];
    for (let i = 0; i < this.count; i++) {
      const dx = p[i*3]-point.x, dy = p[i*3+1]-point.y, dz = p[i*3+2]-point.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < radius) { const t = 1 - d / radius; list.push([i, t*t*(3-2*t), dx, dy, dz]); }
    }
    if (!list.length) return null;
    const id = ++this._gid;
    const g = { list, target: { x: point.x, y: point.y, z: point.z } };
    this._grabs.set(id, g);
    return {
      move: q => { g.target.x = q.x; g.target.y = q.y; g.target.z = q.z; },
      release: () => this._grabs.delete(id),
      get active() { return this._grabs.has(id); }
    };
  }

  releaseAll() { this._grabs.clear(); }
  get grabCount() { return this._grabs.size; }

  /** Advance by `dt` seconds using fixed substeps. Returns how many ran. */
  step(dt) {
    const { substep: h, maxSubsteps } = this.options;
    this._acc_t += Math.min(dt, .1);
    let n = 0;
    while (this._acc_t >= h && n < maxSubsteps) { this._substep(); this._acc_t -= h; n++; }
    if (this._acc_t > h) this._acc_t = 0;   // drop the backlog rather than spiral
    return n;
  }

  _centroid() {
    const p = this.positions;
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < this.count; i++) { x += p[i*3]; y += p[i*3+1]; z += p[i*3+2]; }
    const c = this.centroid;
    c.x = x / this.count; c.y = y / this.count; c.z = z / this.count;
    return c;
  }

  _shapeMatch(beta) {
    const p = this.positions, q = this._q, A = this._A, R = this._R;
    const c = this._centroid();
    A.fill(0);
    for (let i = 0; i < this.count; i++) {
      const px = p[i*3]-c.x, py = p[i*3+1]-c.y, pz = p[i*3+2]-c.z;
      const qx = q[i*3], qy = q[i*3+1], qz = q[i*3+2];
      A[0]+=px*qx; A[1]+=px*qy; A[2]+=px*qz;
      A[3]+=py*qx; A[4]+=py*qy; A[5]+=py*qz;
      A[6]+=pz*qx; A[7]+=pz*qy; A[8]+=pz*qz;
    }
    if (!polar(A, R, this._T)) return;
    for (let i = 0; i < this.count; i++) {
      const qx = q[i*3], qy = q[i*3+1], qz = q[i*3+2];
      p[i*3]   += (c.x + R[0]*qx + R[1]*qy + R[2]*qz - p[i*3])   * beta;
      p[i*3+1] += (c.y + R[3]*qx + R[4]*qy + R[5]*qz - p[i*3+1]) * beta;
      p[i*3+2] += (c.z + R[6]*qx + R[7]*qy + R[8]*qz - p[i*3+2]) * beta;
    }
  }

  _applyGrabs() {
    if (this._grabs.size === 0) return;
    const p = this.positions, K = this.options.grabStrength;
    for (const g of this._grabs.values()) {
      const t = g.target;
      for (const v of g.list) {
        const k = v[0]*3, w = v[1] * K;
        p[k]   += (t.x + v[2] - p[k])   * w;
        p[k+1] += (t.y + v[3] - p[k+1]) * w;
        p[k+2] += (t.z + v[4] - p[k+2]) * w;
      }
    }
  }

  _substep() {
    const o = this.options, p = this.positions, prev = this._prev, acc = this._acc;
    const n = this.count, tri = this._tri, h = o.substep;

    // --- forces: gravity, bowl, soft ceiling ---
    const c = this._centroid();
    const r = Math.hypot(c.x, c.z) || 1e-6;
    const over = Math.max(0, r - o.recenterStart);
    const f = Math.min(o.recenterMax, o.recenter * r + o.recenterEdge * over * over);
    const bx = -f * c.x / r, bz = -f * c.z / r;
    const gy = o.gravity - (c.y > o.ceiling ? o.ceilingK * (c.y - o.ceiling) : 0);
    for (let i = 0; i < n; i++) { acc[i*3] = bx; acc[i*3+1] = gy; acc[i*3+2] = bz; }

    // --- gas pressure along the outward surface normal ---
    const V = this.volume();
    const P = Math.max(-o.pressure, Math.min(o.pressure, o.pressure * (this.restVolume / Math.max(V, 1e-4) - 1)));
    for (let k = 0; k < tri.length; k += 3) {
      const a = tri[k]*3, b = tri[k+1]*3, cc = tri[k+2]*3;
      const e1x = p[b]-p[a], e1y = p[b+1]-p[a+1], e1z = p[b+2]-p[a+2];
      const e2x = p[cc]-p[a], e2y = p[cc+1]-p[a+1], e2z = p[cc+2]-p[a+2];
      let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
      const L = Math.hypot(nx, ny, nz) || 1;
      nx = P*nx/(3*L); ny = P*ny/(3*L); nz = P*nz/(3*L);
      acc[a]+=nx; acc[a+1]+=ny; acc[a+2]+=nz;
      acc[b]+=nx; acc[b+1]+=ny; acc[b+2]+=nz;
      acc[cc]+=nx; acc[cc+1]+=ny; acc[cc+2]+=nz;
    }

    // --- Verlet ---
    for (let k = 0; k < n * 3; k++) {
      const v = (p[k] - prev[k]) * o.damping;
      prev[k] = p[k];
      p[k] += v + acc[k] * h * h;
    }

    // --- relaxation ---
    const S = this.springs;
    for (let pass = 0; pass < o.passes; pass++) {
      for (let s = 0; s < S.length; s += 4) {
        const a = S[s]*3, b = S[s+1]*3, restLen = S[s+2];
        const k = Math.min(.9, S[s+3] * o.stiffness);
        let dx = p[b]-p[a], dy = p[b+1]-p[a+1], dz = p[b+2]-p[a+2];
        const d = Math.max(Math.hypot(dx, dy, dz), 1e-6);
        const t = (d - restLen) / d * k * .5;
        dx *= t; dy *= t; dz *= t;
        p[a]+=dx; p[a+1]+=dy; p[a+2]+=dz;
        p[b]-=dx; p[b+1]-=dy; p[b+2]-=dz;
      }
      this._shapeMatch(o.shapeMatch);
      this._applyGrabs();
      for (let i = 0; i < n; i++) if (p[i*3+1] < o.floorY) {
        p[i*3+1] = o.floorY;
        prev[i*3]   += (p[i*3]   - prev[i*3])   * o.friction;
        prev[i*3+2] += (p[i*3+2] - prev[i*3+2]) * o.friction;
      }
    }

    // --- bounce, once per substep so it cannot compound across passes ---
    for (let i = 0; i < n; i++) {
      const k = i*3 + 1;
      if (p[k] <= o.floorY + 1e-5) {
        const vy = p[k] - prev[k];
        if (vy < -.004) prev[k] = p[k] + vy * o.restitution;
      }
    }
  }

  /** Footprint radius, lowest point and centroid. Handy for contact shadows. */
  bounds() {
    const p = this.positions, c = this._centroid();
    let spread = 0, minY = Infinity;
    for (let i = 0; i < this.count; i++) {
      const dx = p[i*3]-c.x, dz = p[i*3+2]-c.z;
      const s = dx*dx + dz*dz;
      if (s > spread) spread = s;
      if (p[i*3+1] < minY) minY = p[i*3+1];
    }
    return { centroid: c, radius: Math.sqrt(spread), minY };
  }
}
