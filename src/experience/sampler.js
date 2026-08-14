/*
 * sampler.js — source image → classified particle formation
 *
 * The source is decoded once, on load, and its pixels are classified into the
 * element each actually belongs to, using geometry measured off the file
 * itself. Particles are then distributed with per-element quotas, and each one
 * keeps the brightness of the pixel it sampled. Nothing is re-coloured: the
 * silver of the fog, the black of the silhouette and the blaze of the trident
 * are the artwork's own values, carried on points.
 *
 * Two rules keep the result reading as one object made of particles rather
 * than a photograph dissolved into dots:
 *
 *   Every pixel belongs to exactly one element. A pixel that is the trishul is
 *   not also tone, and not also contour. Letting layers overlap puts two and
 *   three particle outlines along the same edge, which is what a "duplicated"
 *   or "ghosted" shape actually is.
 *
 *   Every element is sampled on a lattice sized to its own area and budget, so
 *   particles hold a minimum distance from each other. Randomly thinning a
 *   fine grid clusters particles at exactly the scale of their spacing — the
 *   thick, noisy contours that follow are the same defect by another name.
 *
 * Density is deliberately unequal. Particles are spent where recognition lives
 * — the face, its markings, the crescent, hair, the silhouette, the trident —
 * and saved where nothing is happening.
 *
 * A particle's rest position is always a real image coordinate. The only
 * invented positions in the piece are the scattered start the field wakes
 * from, which lives in Experience.js.
 *
 * Nothing in this file runs per frame.
 */

export const ELEMENT = {
  SMOKE: 0, BASE: 1, GLOW: 2, FOCUS: 3, GROUND: 4, FIGURE: 5, DETAIL: 6, LIGHT: 7,
};

/*
 * Order matters twice over.
 *
 * It is the paint order: the field renders back to front in index order under
 * normal blending. Atmosphere, the frame's coarse tone, the halo around the
 * light, finer tone across the subject, grass, the figure's mass, its contour,
 * and the light itself last of all.
 *
 * And it is the order the formation assembles in — ground and mist, tone,
 * mass, then hair and markings, with the trishul igniting at the end.
 *
 * `quota`  share of the particle budget
 * `spread` dot size as a multiple of the spacing this element's own particles
 *          end up at, so every layer covers itself whatever its budget,
 *          whatever the source's shape, on any viewport
 * `soft`   how much of the dot feathers away at its rim
 * `drift`  idle motion once formed — the subject is nearly still
 * `jitter` how far a sample may stray inside its own lattice cell
 */
export const ELEMENTS = [
  { id: ELEMENT.SMOKE,  quota: 0.05, alpha: 0.13, drift: 0.0350, soft: 1.00, spread: 2.7, jitter: 0.55, delay: [0.00, 0.26] },
  { id: ELEMENT.BASE,   quota: 0.11, alpha: 0.90, drift: 0.0016, soft: 0.60, spread: 2.5, jitter: 0.45, delay: [0.06, 0.34] },
  // The halo is light spilling into fog, not a second trident. Few, small,
  // faint, and never dense enough to read as a shape of its own.
  { id: ELEMENT.GLOW,   quota: 0.015, alpha: 0.26, drift: 0.0120, soft: 0.95, spread: 1.1, jitter: 0.55, delay: [0.70, 0.92] },
  { id: ELEMENT.FOCUS,  quota: 0.295, alpha: 0.92, drift: 0.0014, soft: 0.34, spread: 2.0, jitter: 0.45, delay: [0.20, 0.48] },
  { id: ELEMENT.GROUND, quota: 0.08, alpha: 0.90, drift: 0.0030, soft: 0.55, spread: 1.9, jitter: 0.35, delay: [0.00, 0.20] },
  { id: ELEMENT.FIGURE, quota: 0.17, alpha: 1.00, drift: 0.0014, soft: 0.45, spread: 2.0, jitter: 0.35, delay: [0.34, 0.60] },
  { id: ELEMENT.DETAIL, quota: 0.25, alpha: 0.96, drift: 0.0022, soft: 0.50, spread: 1.5, jitter: 0.30, delay: [0.52, 0.80] },
  // Tight lattice, minimal jitter, dots barely wider than their spacing: one
  // clean layer of particles across each blade, with a crisp boundary.
  { id: ELEMENT.LIGHT,  quota: 0.03, alpha: 1.00, drift: 0.0010, soft: 0.42, spread: 1.2, jitter: 0.20, delay: [0.82, 1.00] },
];

export const ALPHAS = ELEMENTS.map((e) => e.alpha);
export const DRIFTS = ELEMENTS.map((e) => e.drift);
export const SOFTS = ELEMENTS.map((e) => e.soft);

// Working resolution — at or above the source's own width, so the classifier
// sees every strand of hair and blade of grass the artwork actually has.
const MAX_W = 1280;
const BANDS = 64;
const SIZE_MAX = 0.09;          // world units, the quantisation ceiling
const PROBE = 2;                // stride of the area-measuring pass
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/* ------------------------------------------------------------------ utils */

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// smoothstep that also accepts a > b (an inverted ramp)
function sstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Deterministic 0..1 from a pixel coordinate — same input, same result. */
function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Three 8-bit channels in one float: brightness, point size, and an opacity
 * scale. 254³ stays well inside float32's exact-integer range, so the shader
 * unpacks all three without loss — and the whole formation stays one vec4.
 */
function pack(brightness, size, opacity) {
  const c = Math.round(clamp01(brightness) * 254);
  const s = Math.round(clamp01(size / SIZE_MAX) * 254);
  const a = Math.round(clamp01(opacity) * 254);
  return c * 65536 + s * 256 + a;
}

/* --------------------------------------------------------------- filtering */

// Separable box blur, O(1) per pixel regardless of radius.
function boxBlur(src, w, h, r) {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (r * 2 + 1);
  const cx = (x) => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  const cy = (y) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + cx(x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv;
      sum -= src[row + cx(x - r)];
      sum += src[row + cx(x + r + 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[cy(y) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv;
      sum -= tmp[cy(y - r) * w + x];
      sum += tmp[cy(y + r + 1) * w + x];
    }
  }
  return out;
}

/*
 * "Surrounded by light."
 *
 * The hardest call in this file is telling Shiva apart from the night sky:
 * both are black. Averaging a neighbourhood fails, because the body merges
 * downward into an equally black field of grass, so any kernel wide enough to
 * see past the torso also drowns in it.
 *
 * Enclosure is what separates them. Fire a ray left, right, up and down: the
 * figure finds light in every direction within a reasonable distance, while a
 * bank of cloud in the corner finds light on one side and empty frame on the
 * others. Four linear scans, O(n).
 */
function enclosure(lum, W, H) {
  const R = Math.round(W * 0.26);
  const BRIGHT = 0.52;
  const out = new Float32Array(W * H);
  const add = (i, d) => { out[i] += 0.25 * (1 - Math.min(d, R) / R); };

  for (let y = 0; y < H; y++) {
    const row = y * W;
    let last = -R * 4;
    for (let x = 0; x < W; x++) {
      if (lum[row + x] > BRIGHT) last = x;
      add(row + x, x - last);
    }
    last = W + R * 4;
    for (let x = W - 1; x >= 0; x--) {
      if (lum[row + x] > BRIGHT) last = x;
      add(row + x, last - x);
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -R * 4;
    for (let y = 0; y < H; y++) {
      if (lum[y * W + x] > BRIGHT) last = y;
      add(y * W + x, y - last);
    }
    last = H + R * 4;
    for (let y = H - 1; y >= 0; y--) {
      if (lum[y * W + x] > BRIGHT) last = y;
      add(y * W + x, last - y);
    }
  }
  return out;
}

/**
 * How far each pixel is from something that is not bright, along four axis
 * rays. Small inside a blade or a strand of rim-light; large in the middle of
 * an open field of glow. This is what tells a lit object from its own bloom.
 */
function distanceToDark(lum, W, H) {
  const DARK = 0.60;
  const CAP = Math.round(W * 0.1);
  const out = new Float32Array(W * H).fill(CAP);
  const relax = (i, v) => { if (v < out[i]) out[i] = v; };

  for (let y = 0; y < H; y++) {
    const row = y * W;
    let last = -CAP;
    for (let x = 0; x < W; x++) {
      if (lum[row + x] <= DARK) last = x;
      relax(row + x, x - last);
    }
    last = W + CAP;
    for (let x = W - 1; x >= 0; x--) {
      if (lum[row + x] <= DARK) last = x;
      relax(row + x, last - x);
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -CAP;
    for (let y = 0; y < H; y++) {
      if (lum[y * W + x] <= DARK) last = y;
      relax(y * W + x, y - last);
    }
    last = H + CAP;
    for (let y = H - 1; y >= 0; y--) {
      if (lum[y * W + x] <= DARK) last = y;
      relax(y * W + x, last - y);
    }
  }
  return out;
}

/**
 * Where the grass line starts, measured rather than assumed: walking up from
 * the bottom edge, the first row whose dark-pixel fraction breaks is the top
 * of the ground.
 */
function findGround(lum, W, H) {
  const frac = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let d = 0;
    for (let x = 0; x < W; x++) if (lum[y * W + x] < 0.34) d++;
    frac[y] = d / W;
  }
  let y = H - 1;
  let run = 0;
  for (; y > H * 0.45; y--) {
    if (frac[y] > 0.30) run = 0;
    else if (++run > H * 0.02) break;      // tolerate thin gaps in the blades
  }
  const found = Math.min(H - 1, y + Math.round(H * 0.02));
  return found > H * 0.5 ? found : Math.round(H * 0.80);
}

/* -------------------------------------------------------------- selection */

/*
 * Formation correspondence: ordering each element into horizontal bands
 * top-to-bottom, then left-to-right within a band, puts index i at the same
 * height percentile in every formation.
 */
function orderByBands(pts, H) {
  return pts.sort((a, b) => {
    const ba = ((a.iy / H) * BANDS) | 0;
    const bb = ((b.iy / H) * BANDS) | 0;
    if (ba !== bb) return ba - bb;
    return a.ix - b.ix;
  });
}

/*
 * Trim or top up a lattice to exactly `count`.
 *
 * The lattice is sized to land close to the budget, so this only ever adjusts
 * the last few percent. Over: drop at random, which thins evenly. Under: reissue
 * on a golden-angle spiral inside the source cell, which stays inside the
 * minimum spacing rather than stacking particles on top of each other.
 */
function fit(list, count, cell) {
  const a = list.slice();
  if (a.length === 0) return a;

  if (a.length > count) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a.slice(0, count);
  }

  const out = a.slice();
  const rounds = Math.max(1, count / a.length);
  for (let k = out.length; k < count; k++) {
    const src = a[k % a.length];
    const ang = k * GOLDEN;
    const rad = cell * 0.42 * Math.sqrt(Math.floor(k / a.length) / rounds);
    out.push({
      ix: src.ix + Math.cos(ang) * rad,
      iy: src.iy + Math.sin(ang) * rad,
      v: src.v,
      c: src.c,
      o: src.o,
    });
  }
  return out;
}

export function quotas(total) {
  const b = ELEMENTS.map((e) => Math.round(total * e.quota));
  b[0] += total - b.reduce((s, v) => s + v, 0);
  return b;
}

/* ------------------------------------------------------------------- build */

/**
 * @param {HTMLImageElement} img
 * @param {number} total  particle count — identical for every formation
 * @returns {{data:Float32Array, aspect:number, ground:number}}
 *          data: x, y, z, packed(brightness, size, opacity) per particle
 */
export function buildFormation(img, total) {
  const W = Math.min(MAX_W, img.naturalWidth);
  const H = Math.round((W * img.naturalHeight) / img.naturalWidth);

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;

  const n = W * H;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lum[i] = (px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114) / 255;
  }

  const soft = boxBlur(lum, W, H, 2);
  const encl = enclosure(lum, W, H);
  const ground = findGround(lum, W, H);

  /*
   * Object versus glow, measured.
   *
   * Brightness alone cannot tell the trident from the light pouring off it:
   * sampling the frame shows the blades running 0.87–1.0 and the glow band
   * beside them reaching 1.0 as well. Thresholding high enough to exclude the
   * glow leaves only the blades' rims, which is what renders the trident
   * hollow — an outline with a hole in it.
   *
   * Geometry separates them. The trident is thin: every pixel inside a blade
   * is within about nine pixels of something dark. The glow is a wide field —
   * fifteen to twenty-five. So the light is "bright *and* narrow", and the
   * spill around it is "bright and broad".
   */
  const gt1 = 0.70;
  const gt2 = 0.86;
  const narrow = distanceToDark(lum, W, H);

  /*
   * Bright and narrow also describes the rim-light running along a strand of
   * hair or the edge of a shoulder, and treating those as the light beads the
   * silhouette in glowing dots. What sets the trident apart is concentration:
   * blown-out pixels crowd together there and nowhere else. Requiring a
   * genuine local density of them keeps the light where the light is.
   */
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) seed[i] = lum[i] > 0.93 ? 1 : 0;
  const seedField = boxBlur(seed, W, H, Math.round(W * 0.06));

  // Local darkness coverage, on the scale of a limb. A body is solid black
  // across the whole window; a blade of grass or a strand of hair is not.
  const shade = new Float32Array(n);
  for (let i = 0; i < n; i++) shade[i] = lum[i] < 0.34 ? 1 : 0;
  const mass = boxBlur(shade, W, H, Math.round(W * 0.022));

  const MARGIN = Math.round(W * 0.018);   // the source's own edge artefacts
  const at = (x, y) => y * W + x;
  const clampX = (x) => Math.min(W - MARGIN - 1, Math.max(MARGIN, x));
  const clampY = (y) => Math.min(H - MARGIN - 1, Math.max(MARGIN, y));

  const coreAt = (i) =>
    sstep(gt1, gt2, lum[i])
    * (1 - sstep(10, 24, narrow[i]))
    * sstep(0.020, 0.055, seedField[i]);

  /*
   * Object versus glow.
   *
   * The trident is drawn as a white shape wrapped in a wide bloom, and the two
   * cannot be told apart by brightness — which is precisely why sampling raw
   * luminance builds a second, fatter trident out of the halo and welds it to
   * the first. So the geometry is taken from the blown-out core only, and the
   * spill around it is measured separately, as proximity to that core, and
   * handed to a sparse layer of its own.
   */
  const coreMask = new Float32Array(n);
  for (let i = 0; i < n; i++) coreMask[i] = coreAt(i) > 0.25 ? 1 : 0;
  const nearCore = boxBlur(coreMask, W, H, Math.round(W * 0.045));

  /*
   * A soft falloff toward the frame's own borders, so the field does not stop
   * in a visible rectangle.
   */
  const edgeFade = (x, y) => {
    const fx = 1 - sstep(0.62, 1.0, Math.abs((x / W) * 2 - 1));
    const fy = 1 - sstep(0.74, 1.0, Math.abs((y / H) * 2 - 1));
    return Math.min(fx, fy);
  };

  /**
   * Exactly one element per pixel. Order is priority: the light, then the
   * body — so the halo can never spill across Shiva's shoulder — then the
   * ground, the halo itself, contour, and tone last.
   */
  function classify(x, y) {
    const i = at(x, y);
    const l = lum[i];

    // the trident's own geometry
    const core = coreAt(i);
    if (core > 0.25) {
      return { el: ELEMENT.LIGHT, v: core, c: Math.min(0.97, Math.max(l, 0.9)), smoke: 0 };
    }

    const dark = sstep(0.46, 0.06, l);
    const ctxw = sstep(0.30, 0.72, encl[i]);
    const gx = soft[i + 1] - soft[i - 1];
    const gy = soft[i + W] - soft[i - W];
    const grad = Math.sqrt(gx * gx + gy * gy) * (W / 128);

    const solid = sstep(0.22, 0.62, dark * ctxw);
    // Contour counts anywhere a real edge sits — along the silhouette, where
    // enclosure vouches for it, but also deep inside the body, where local
    // darkness does. Gating it on enclosure alone loses everything interior:
    // the tripundra, the eyes, the modelling across the chest and arms.
    const detail = clamp01(grad * 0.8)
      * Math.max(ctxw, mass[i] * 0.9)
      * (1 - solid * 0.7);
    const smoke = sstep(0.10, 0.92, soft[i]);

    // A solid black mass is the figure wherever it stands — including down in
    // the grass, where a seated silhouette would otherwise be read as ground.
    if (solid > 0.45 && mass[i] > 0.82) return { el: ELEMENT.FIGURE, v: solid, c: l, smoke: 0 };
    if (y >= ground && dark > 0.45) return { el: ELEMENT.GROUND, v: dark, c: l, smoke: 0 };
    if (solid > 0.45) return { el: ELEMENT.FIGURE, v: solid, c: l, smoke: 0 };

    // the spill around the light: bright, and close to the core
    const halo = clamp01(nearCore[i] * 9) * sstep(0.45, 0.92, l);
    if (halo > 0.12 && detail < 0.55) {
      return { el: ELEMENT.GLOW, v: halo, c: Math.min(0.85, l), smoke: 0 };
    }

    if (detail > 0.34) return { el: ELEMENT.DETAIL, v: detail, c: l, smoke };
    return { el: ELEMENT.BASE, v: sstep(0.02, 0.92, soft[i]), c: soft[i], smoke };
  }

  /* --- where recognition lives ------------------------------------------ */

  /*
   * The subject's own neighbourhood at half resolution: the figure and its
   * contour, dilated enough to take in the air around a strand of hair or the
   * rim of a shoulder. The finer of the two tonal layers is confined here,
   * which is what buys the face and the markings their density. The light is
   * deliberately *not* part of it — the trident carries its own layer, and
   * laying tone over it as well is what thickened its blades.
   */
  const hw = Math.ceil(W / 2);
  const hh = Math.ceil(H / 2);
  const subject = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const el = classify(clampX(x * 2), clampY(y * 2)).el;
      subject[y * hw + x] = (el === ELEMENT.FIGURE || el === ELEMENT.DETAIL) ? 1 : 0;
    }
  }
  const halo = boxBlur(subject, hw, hh, Math.round(hw * 0.035));
  const inFocus = (x, y) => halo[((y >> 1) * hw) + (x >> 1)] > 0.05;

  /* --- pass one: measure every element's area --------------------------- */

  const budget = quotas(total);
  const index = new Map(ELEMENTS.map((e, i) => [e.id, i]));
  const areas = new Float64Array(ELEMENTS.length);
  const cellArea = PROBE * PROBE;

  for (let y = MARGIN; y < H - MARGIN; y += PROBE) {
    for (let x = MARGIN; x < W - MARGIN; x += PROBE) {
      const c = classify(x, y);
      areas[index.get(c.el)] += cellArea;

      // tone and atmosphere overlay whatever is not the light or its halo
      if (c.el !== ELEMENT.LIGHT && c.el !== ELEMENT.GLOW) {
        if (c.el !== ELEMENT.BASE) {
          areas[index.get(inFocus(x, y) ? ELEMENT.FOCUS : ELEMENT.BASE)] += cellArea;
        }
        if (c.smoke > 0.005) areas[index.get(ELEMENT.SMOKE)] += cellArea;
      }
    }
  }
  // BASE's own tally counts pixels it owns outright; split it by the mask
  areas[index.get(ELEMENT.BASE)] = Math.max(areas[index.get(ELEMENT.BASE)], 1);

  /* --- pass two: lay each element on its own lattice --------------------- */

  const found = ELEMENTS.map(() => []);
  const steps = ELEMENTS.map(() => PROBE);

  for (let e = 0; e < ELEMENTS.length; e++) {
    const { id, jitter } = ELEMENTS[e];
    const list = found[e];

    /*
     * Spacing comes from this element's measured area and its budget, so every
     * layer lands on an even lattice with a guaranteed minimum distance
     * between particles — no clustering, no two particles at nearly the same
     * coordinate, no doubled contour.
     */
    const step = Math.max(1, Math.sqrt(Math.max(1, areas[e]) / Math.max(1, budget[e])));
    steps[e] = step;
    const jit = step * jitter;

    let row = 0;
    for (let fy = MARGIN; fy < H - MARGIN; fy += step, row++) {
      const shift = row % 2 ? step * 0.5 : 0;
      for (let fx = MARGIN + shift; fx < W - MARGIN; fx += step) {
        const gx0 = Math.round(fx);
        const gy0 = Math.round(fy);
        const x = clampX(Math.round(fx + (hash2(gx0, gy0) - 0.5) * jit));
        const y = clampY(Math.round(fy + (hash2(gy0, gx0) - 0.5) * jit));
        const i = at(x, y);
        const c = classify(x, y);
        const lit = c.el === ELEMENT.LIGHT || c.el === ELEMENT.GLOW;

        if (id === ELEMENT.SMOKE) {
          if (!lit && c.smoke > 0.005) {
            list.push({ ix: x, iy: y, v: c.smoke, c: Math.pow(soft[i], 0.60), o: edgeFade(x, y) });
          }
        } else if (id === ELEMENT.BASE || id === ELEMENT.FOCUS) {
          // Tone never covers the light or its halo — that overlap is exactly
          // what put two particle outlines along every blade.
          if (lit) continue;
          if ((id === ELEMENT.FOCUS) !== inFocus(x, y)) continue;
          // The exposure curve lifts the background's low midtones so the frame
          // does not collapse to black. The subject is meant to be black, so
          // there the curve is inverted instead — otherwise every faint
          // highlight on the body blooms into white speckle.
          const dark = c.el === ELEMENT.FIGURE
            || c.el === ELEMENT.DETAIL
            || c.el === ELEMENT.GROUND;
          list.push({
            ix: x,
            iy: y,
            v: sstep(0.02, 0.92, soft[i]),
            c: Math.pow(lum[i], dark ? 1.12 : 0.78),
            o: edgeFade(x, y),
          });
        } else if (c.el === id) {
          list.push({ ix: x, iy: y, v: c.v, c: c.c, o: 1 });
        }
      }
    }
  }

  if (location.search.includes('debug')) {
    const name = Object.keys(ELEMENT);
    console.log('[formation]', img.src.split('/').pop(), 'ground', (ground / H).toFixed(2),
      ...ELEMENTS.map((e, i) => `· ${name[e.id]} ${found[i].length}/${budget[i]} @${steps[i].toFixed(1)}px`));
  }

  const groups = found.map((list, i) => orderByBands(fit(list, budget[i], steps[i]), H));

  /* --- image space → world space ---------------------------------------- */

  const aspect = W / H;
  const data = new Float32Array(total * 4);

  let p = 0;
  for (let e = 0; e < groups.length; e++) {
    const list = groups[e];
    const id = ELEMENTS[e].id;

    // the achieved spacing, in world units, scaled by this element's spread
    const covered = found[e].length * steps[e] * steps[e];
    const spacing = Math.sqrt(covered / Math.max(1, budget[e]));
    const cell = ((spacing * 2) / H) * ELEMENTS[e].spread;

    for (let k = 0; k < list.length; k++) {
      const pt = list[k];

      // The real coordinate, straight from the image. Height spans 2 units.
      const x = (pt.ix / W - 0.5) * 2 * aspect;
      const y = -(pt.iy / H - 0.5) * 2;

      // Depth is the one thing a flat image cannot supply. It is derived from
      // the pixel's own values — mist behind, light in front — so it stays
      // deterministic and never shifts a particle in the plane the silhouette
      // is read from.
      let z, size;
      if (id === ELEMENT.SMOKE) {
        z = -0.40 - (1 - pt.v) * 0.40;
        size = cell * lerp(0.85, 1.20, pt.v);
      } else if (id === ELEMENT.BASE || id === ELEMENT.FOCUS) {
        z = -0.16 - (1 - pt.v) * 0.10;
        size = cell * lerp(0.90, 1.10, pt.v);
      } else if (id === ELEMENT.GLOW) {
        z = -0.10 + pt.v * 0.04;
        size = cell * lerp(0.70, 0.95, pt.v);
      } else if (id === ELEMENT.GROUND) {
        z = 0.06 + pt.v * 0.05;
        size = cell * lerp(0.80, 1.10, pt.v);
      } else if (id === ELEMENT.FIGURE) {
        z = (pt.c - 0.18) * 0.20;
        size = cell * lerp(0.90, 1.10, pt.v);
      } else if (id === ELEMENT.DETAIL) {
        z = 0.02 + (pt.c - 0.18) * 0.18;
        size = cell * lerp(0.70, 1.00, pt.v);
      } else {
        z = 0.10 + pt.v * 0.06;
        size = cell * lerp(0.95, 1.10, pt.v);
      }

      data[p * 4] = x;
      data[p * 4 + 1] = y;
      data[p * 4 + 2] = z;
      data[p * 4 + 3] = pack(pt.c, size, pt.o === undefined ? 1 : pt.o);
      p++;
    }
  }

  return { data, aspect, ground: ground / H };
}

/**
 * Per-particle constants: reveal delay and element id. Element membership is
 * fixed by quota, so this is computed once for the whole run. Within an
 * element the delay leans on height, so the formation grows upward out of the
 * ground rather than appearing all at once.
 */
export function buildMeta(total, firstFormation) {
  const budget = quotas(total);
  const meta = new Float32Array(total * 2);
  let p = 0;
  for (let e = 0; e < ELEMENTS.length; e++) {
    const [d0, d1] = ELEMENTS[e].delay;
    for (let k = 0; k < budget[e]; k++, p++) {
      const y = firstFormation[p * 4 + 1];          // −1 bottom → +1 top
      meta[p * 2] = lerp(d0, d1, clamp01((y + 1) * 0.5));
      meta[p * 2 + 1] = ELEMENTS[e].id;
    }
  }
  return meta;
}
