# ॐ

A single continuous ~22-second particle film. It opens in darkness, wakes a
field of stardust, throws it outward and pulls it back into a silhouette
sampled from the source artwork — ground and mist first, then the figure's
mass, then hair and markings, with the trishul igniting last — then holds
almost perfectly still while the camera pushes slowly in, and fades to black.
No scroll, no UI, no audio. Press **space** to replay.

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:5174
npm run build    # dist/
```

Append `?debug` to the URL to print the per-element classification counts and
expose the running experience as `window.__om` (`__om.hold = 12` parks the
score at one instant, `__om.replay()` restarts).

## How it works

**`src/experience/sampler.js`** — decodes the source once and turns it into
particles. Every resting position is a real pixel coordinate; every particle
keeps the brightness of the pixel it sampled. Pixels are classified into seven
elements, each with its own quota, opacity, drift, edge hardness and reveal
delay:

| element | what it is | share |
| --- | --- | --- |
| `SMOKE`  | soft atmosphere, the only thing allowed to widen past the frame | 6% |
| `BASE`   | coarse tone across the whole frame, so nothing goes missing | 16% |
| `FOCUS`  | fine tone, confined to the subject and the air around it | 26% |
| `GROUND` | the grass line, found by measuring the image, not by guessing | 8% |
| `FIGURE` | the solid silhouette | 18% |
| `DETAIL` | hair, markings, cloth, contour — the finest dots in the piece | 24% |
| `LIGHT`  | the trishul — the only thing bright enough to bloom | 2% |

Density is deliberately unequal: roughly 70% of the particles land on the
quarter of the frame where recognition lives, and the empty background is left
sparse. An even scattering costs exactly as much to draw and reads as static.

Two ideas do most of the work here:

- **Enclosure.** Telling the figure from the night sky is hard because both are
  black. Four linear scans ask whether light is found to the left, right, above
  and below: the figure is surrounded, an empty corner is not.
- **Self-sizing.** Each element's dot size is derived from the spacing its own
  particles actually end up at, so every layer covers itself whatever the
  budget, the source's aspect, or the viewport. Hand-picked sizes do not
  survive any of those changing.

The two full-frame layers are walked on an even, half-offset lattice with a
deterministic sub-cell jitter — a random thinning of a fine grid leaves clumps
and holes at exactly the scale of the spacing, which reads as noise rather than
as tone.

**`src/experience/shaders.js`** — one vertex program for the whole field.
Position, brightness, size and opacity for every formation ride in a single
`vec4` per formation (three 8-bit channels packed into `w`). Changing scene is
three uniform writes; geometry is never rebuilt.

**`src/experience/score.js`** — the timeline. One function maps elapsed
seconds onto formation blend, assembly, bloom and camera. There are no cuts.

**`src/experience/Experience.js`** — renderer, framing, pointer spring and
adaptive quality. If the frame rate cannot hold after a three-second warm-up,
pixel ratio steps down and bloom is dropped last.

## Notes

- Desktop runs 100k particles, touch devices 38k with brightness compensated so
  a phone reads as bright as a desktop.
- The pointer is part of the same field: a sprung, damped deflection in the
  vertex shader, not a separate system.
- Source art lives in `public/assets/`. Pointing `SOURCES` in
  `Experience.js` at more than one image restores the morph sequence — the
  shader's attribute list and the score both follow that array's length.
