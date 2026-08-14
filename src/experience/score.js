/*
 * score.js — the authored timeline.
 *
 * One function maps elapsed seconds onto everything that changes: which two
 * formations are in play and how far between them, how much of the field has
 * assembled out of the stardust, bloom intensity, and where the camera is.
 * There are no cuts anywhere in it.
 */

const WAKE = 0.9;        // absolute darkness, then dust
const ASSEMBLE = 1.7;    // dust gathers into the formation — fast, on purpose
const HOLD = 1.6;        // a formation stands, fully formed
const TRANSITION = 2.2;  // one silhouette dissolves into the next
const LAST_HOLD = 2.6;
const SOLO_HOLD = 4.0;   // the formed image stands for four seconds, held still
const FADE = 2.4;        // then back to black

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function buildScore(formations) {
  const seg = [];
  const push = (type, dur, from, to) => seg.push({ type, dur, from, to });

  push('wake', WAKE, 0, 0);
  push('assemble', ASSEMBLE, 0, 0);
  // with nothing to morph into, the one formation stands for the whole middle
  // of the piece and the camera's push carries it
  push('hold', formations === 1 ? SOLO_HOLD : HOLD, 0, 0);
  for (let i = 0; i < formations - 1; i++) {
    push('transition', TRANSITION, i, i + 1);
    push('hold', i === formations - 2 ? LAST_HOLD : HOLD, i + 1, i + 1);
  }
  push('fade', FADE, formations - 1, formations - 1);

  const duration = seg.reduce((s, x) => s + x.dur, 0);
  return { seg, duration };
}

/**
 * @returns {{from,to,blend,assemble,wake,fade,bloom,push}}
 */
export function evaluate(score, time) {
  const t = Math.min(time, score.duration);
  let acc = 0;
  let cur = score.seg[score.seg.length - 1];
  let local = 1;

  for (let i = 0; i < score.seg.length; i++) {
    const s = score.seg[i];
    if (t < acc + s.dur || i === score.seg.length - 1) {
      cur = s;
      local = clamp01((t - acc) / s.dur);
      break;
    }
    acc += s.dur;
  }

  const out = {
    from: cur.from,
    to: cur.to,
    blend: 0,
    assemble: 1,
    wake: 1,
    fade: 1,
    bloom: 0.30,
    push: smoother(clamp01(t / score.duration)),
  };

  if (cur.type === 'wake') {
    out.assemble = 0;
    // the first half-second is genuine darkness
    out.wake = smoother(clamp01((local - 0.22) / 0.78));
    out.bloom = 0.12;
  } else if (cur.type === 'assemble') {
    out.assemble = local;
    out.bloom = 0.12 + 0.18 * smoother(local);
  } else if (cur.type === 'transition') {
    out.blend = local;
    // the field is loosest at mid-flight, and glows least there
    out.bloom = 0.30 - 0.14 * Math.sin(Math.PI * local);
  } else if (cur.type === 'fade') {
    out.fade = 1 - smoother(local);
    out.bloom = 0.30 * (1 - local * 0.5);
  }

  return out;
}
