/*
 * Experience.js — one field, one draw call, one continuous take.
 *
 * The whole piece is a single THREE.Points object. Every particle holds its
 * position, brightness, size and opacity for every formation the piece uses,
 * uploaded once at load. Moving through the score costs three uniform writes;
 * geometry is never rebuilt and pixels are never re-sampled after startup.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import {
  loadImage, buildFormation, buildMeta, ALPHAS, DRIFTS, SOFTS, ELEMENTS,
} from './sampler.js';
import { buildFieldVert, FIELD_FRAG, GRAIN_SHADER } from './shaders.js';
import { buildScore, evaluate } from './score.js';

// One source, one formation. The shader's attribute list and the score both
// follow this array, so adding frames back is only an edit here.
const SOURCES = ['/assets/omm6.jpeg'];

// Editing this module must reload the page rather than hot-swap it: a live
// replacement would leave the previous renderer drawing to the same canvas.
if (import.meta.hot) import.meta.hot.decline();

/*
 * Classified formations, keyed by source and particle count.
 *
 * React mounts an effect, tears it down and mounts it again in development,
 * so the experience is genuinely constructed twice on a fresh load. The second
 * one is the one that survives, and that is correct — but decoding and
 * classifying the source twice is not. The work is pure and deterministic, so
 * it is done once and handed to whoever asks for it next.
 */
const formationCache = new Map();

function formationFor(src, count) {
  // The promise is what gets cached, not the result: both instances are
  // constructed in the same tick, so caching the result would let each check
  // an empty map and start its own build before either finished.
  const key = `${src}@${count}`;
  if (!formationCache.has(key)) {
    formationCache.set(key, loadImage(src).then((img) => buildFormation(img, count)));
  }
  return formationCache.get(key);
}

const CONFIG = {
  countDesktop: 100000,
  countTouch: 38000,
  touchBoost: 1.18,     // fewer particles read dimmer; compensate in brightness
  fov: 50,
  fit: 1.06,
  maxCrop: 0.12,        // how far past "whole frame visible" the camera may go
  maxSpread: 2.35,      // how far the smoke may widen on a wide viewport
  sizeMax: 0.09,        // must match SIZE_MAX in sampler.js
  pointerRadius: 0.42,
  springK: 0.08,
  springDamp: 0.85,
  bloomRadius: 0.35,
  bloomThreshold: 0.90,   // only the trishul is this bright — never the fog
  warmup: 3.0,          // never let a first-frame hitch trigger degradation
  minFps: 45,
};

// Live instance count. A canvas has exactly one WebGL context, so a second
// Experience on the same canvas would share it and both would draw — which is
// what a ghosted, doubled frame looks like. This must never exceed 1.
let live = 0;

export default class Experience {
  constructor(canvas, { onProgress } = {}) {
    live += 1;
    Experience.live = live;
    if (live > 1) console.warn('[om] more than one Experience is alive:', live);
    this.canvas = canvas;
    this.onProgress = onProgress || (() => {});
    this.disposed = false;
    this.touch = window.matchMedia('(pointer: coarse)').matches;
    this.count = this.touch ? CONFIG.countTouch : CONFIG.countDesktop;

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.score = buildScore(SOURCES.length);

    this.pointer = new THREE.Vector2(999, 999);
    this.pointerTarget = new THREE.Vector2(999, 999);
    this.pointerVel = new THREE.Vector2();
    this.pointerAmt = 0;
    this.pointerSeen = false;

    this.quality = { dpr: Math.min(window.devicePixelRatio || 1, 1.5), bloom: true };
    this.frames = [];
    this.lastDrop = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setPixelRatio(this.quality.dpr);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.fov, 1, 0.01, 100);

    this.onResize = this.onResize.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerOut = this.onPointerOut.bind(this);
    this.tick = this.tick.bind(this);
  }

  /* ------------------------------------------------------------- loading */

  async load() {
    // One lifecycle, once. A second call — a re-entered effect, a stray retry —
    // would put a second field and a second animation loop on the same canvas,
    // and every shape in the piece would render twice.
    if (this.started) return;
    this.started = true;

    const formations = [];
    for (let i = 0; i < SOURCES.length; i++) {
      formations.push(await formationFor(SOURCES[i], this.count));
      if (this.disposed) return;
      this.onProgress((i + 1) / SOURCES.length);
      await new Promise((r) => setTimeout(r, 0));   // let the preloader paint
    }
    if (this.disposed) return;

    this.aspect = formations[0].aspect;
    this.buildField(formations);
    this.buildComposer();
    this.onResize();

    window.addEventListener('resize', this.onResize);
    if (!this.touch) {
      window.addEventListener('pointermove', this.onPointerMove, { passive: true });
      window.addEventListener('pointerleave', this.onPointerOut);
      window.addEventListener('blur', this.onPointerOut);
    }

    this.clock.start();
    this.renderer.setAnimationLoop(this.tick);
  }

  buildField(formations) {
    const n = this.count;
    const geo = new THREE.BufferGeometry();

    // xyz rest position + packed(brightness, size), one attribute per formation
    formations.forEach((f, i) => {
      geo.setAttribute(`aF${i}`, new THREE.BufferAttribute(f.data, 4));
    });
    // three counts vertices off `position`; formation 0 doubles as it, no copy
    geo.setAttribute('position', geo.attributes.aF0);

    /*
     * Where each particle starts.
     *
     * A shell of random positions around the camera looks like nothing at all
     * — 100,000 grey specks filling the frame for the whole of the assembly,
     * which is exactly what reads as television static. Instead every particle
     * starts on the ray from the centre of the composition through its own
     * target, thrown outward: the artwork itself blown apart. From the first
     * frame the cloud already carries the figure's shape, and the assembly is
     * a storm contracting into focus rather than noise resolving into an
     * image.
     */
    const target = formations[0].data;
    const entry = new Float32Array(n * 3);
    const rand = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const tx = target[i * 4];
      const ty = target[i * 4 + 1];
      const tz = target[i * 4 + 2];

      const len = Math.hypot(tx, ty);
      const a = len > 1e-3 ? Math.atan2(ty, tx) : Math.random() * Math.PI * 2;
      const push = 0.55 + Math.pow(Math.random(), 1.5) * 2.4;

      entry[i * 3] = tx + Math.cos(a) * push + (Math.random() - 0.5) * 0.5;
      entry[i * 3 + 1] = ty + Math.sin(a) * push * 0.8 + (Math.random() - 0.5) * 0.5;
      entry[i * 3 + 2] = tz + (Math.random() - 0.5) * 1.4;

      for (let k = 0; k < 4; k++) rand[i * 4 + k] = Math.random();
    }
    geo.setAttribute('aEntry', new THREE.BufferAttribute(entry, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(buildMeta(n, formations[0].data), 2));

    this.material = new THREE.ShaderMaterial({
      vertexShader: buildFieldVert(formations.length, ELEMENTS.length),
      fragmentShader: FIELD_FRAG,
      uniforms: {
        uFrom: { value: 0 },
        uTo: { value: 0 },
        uBlend: { value: 0 },
        uAssemble: { value: 0 },
        uWake: { value: 0 },
        uFade: { value: 1 },
        uTime: { value: 0 },
        uSizeScale: { value: 900 },
        uSizeMax: { value: CONFIG.sizeMax },
        uBoost: { value: this.touch ? CONFIG.touchBoost : 1 },
        uAlpha: { value: ALPHAS.slice() },
        uDrift: { value: DRIFTS.slice() },
        uSoft: { value: SOFTS.slice() },
        uPointer: { value: new THREE.Vector2(999, 999) },
        uPointerAmt: { value: 0 },
        uPointerRadius: { value: CONFIG.pointerRadius },
        uSpread: { value: 1 },
      },
      transparent: true,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  buildComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1), 0.6, CONFIG.bloomRadius, CONFIG.bloomThreshold,
    );
    this.composer.addPass(this.bloom);

    this.grain = new ShaderPass(GRAIN_SHADER);
    this.grain.renderToScreen = true;
    this.composer.addPass(this.grain);
  }

  /* -------------------------------------------------------------- layout */

  onResize() {
    if (!this.material) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = this.quality.dpr;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);

    this.camera.aspect = w / h;

    // Frame the artwork however the viewport is shaped. Containing it whole
    // would strand a landscape frame in the middle of a tall phone, so the
    // camera is allowed to come in a little past that — never far enough to
    // cut into the composition, just enough to meet the edges.
    const half = Math.tan((CONFIG.fov * Math.PI) / 360);
    const needH = 2 * CONFIG.fit;
    const needW = 2 * this.aspect * CONFIG.fit;
    const contain = Math.max(needH / (2 * half), needW / (2 * half * this.camera.aspect));
    const cover = Math.min(needH / (2 * half), needW / (2 * half * this.camera.aspect));
    this.baseZ = Math.max(cover, contain * (1 - CONFIG.maxCrop));
    this.camera.updateProjectionMatrix();

    this.visH = 2 * this.baseZ * half;
    this.visW = this.visH * this.camera.aspect;
    this.material.uniforms.uSizeScale.value = (h * dpr) / (2 * half);

    // widen the shapeless elements until they meet the sides of the viewport
    const room = (this.visW / 2) / this.aspect;
    this.material.uniforms.uSpread.value =
      Math.min(CONFIG.maxSpread, Math.max(1, room * 0.94));

    this.grain.uniforms.uResolution.value = [w * dpr, h * dpr];
    this.grain.uniforms.uAspect.value = this.camera.aspect;
  }

  /* --------------------------------------------------------- interaction */

  onPointerMove(e) {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = 1 - (e.clientY / window.innerHeight) * 2;
    this.pointerTarget.set((nx * this.visW) / 2, (ny * this.visH) / 2);
    if (!this.pointerSeen) {
      this.pointerSeen = true;              // no sweep across frame on entry
      this.pointer.copy(this.pointerTarget);
      this.pointerVel.set(0, 0);
    }
    this.pointerAmtTarget = 1;
  }

  onPointerOut() { this.pointerAmtTarget = 0; }

  replay() {
    this.elapsed = 0;
  }

  /* ------------------------------------------------------------ quality */

  adapt(dt) {
    if (this.elapsed < CONFIG.warmup) return;
    this.frames.push(dt);
    if (this.frames.length < 60) return;

    const avg = this.frames.reduce((s, v) => s + v, 0) / this.frames.length;
    this.frames.length = 0;
    this.fps = Math.round(1 / avg);
    if (1 / avg >= CONFIG.minFps) return;
    if (this.elapsed - this.lastDrop < 2) return;
    this.lastDrop = this.elapsed;

    if (this.quality.dpr > 1.25) this.quality.dpr = 1.25;
    else if (this.quality.dpr > 1) this.quality.dpr = 1;
    else if (this.quality.bloom) {
      this.quality.bloom = false;
      this.bloom.enabled = false;
      return;
    } else return;
    this.onResize();
  }

  /* --------------------------------------------------------------- frame */

  tick() {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    // `hold` parks the score at one instant — for inspecting a single beat
    if (this.hold === undefined) this.elapsed += dt;
    else this.elapsed = this.hold;
    this.adapt(dt);

    const s = evaluate(this.score, this.elapsed);
    const u = this.material.uniforms;

    u.uFrom.value = s.from;
    u.uTo.value = s.to;
    u.uBlend.value = s.blend;
    u.uAssemble.value = s.assemble;
    u.uWake.value = s.wake;
    u.uFade.value = s.fade;
    u.uTime.value = this.elapsed;
    this.bloom.strength = s.bloom;
    this.grain.uniforms.uTime.value = this.elapsed;

    /*
     * A continuous, unhurried push-in with a breath of drift — never a cut.
     * The camera looks straight ahead at its own x/y rather than back at the
     * origin, so the drift is a true pan and not a tilt, and it rises a little
     * as it closes in: whatever the tightening frame eventually crops is grass
     * along the bottom, never the trident's top blade.
     */
    const z = this.baseZ * (1.10 - 0.13 * s.push);
    const px = Math.sin(this.elapsed * 0.11) * 0.045;
    const py = Math.cos(this.elapsed * 0.08) * 0.03 + s.push * 0.055;
    this.camera.position.set(px, py, z);
    this.camera.lookAt(px, py, 0);

    // the pointer belongs to the same field: sprung, damped, no separate system
    const steps = Math.min(4, Math.max(1, Math.round(dt * 60)));
    for (let i = 0; i < steps; i++) {
      this.pointerVel.x += (this.pointerTarget.x - this.pointer.x) * CONFIG.springK;
      this.pointerVel.y += (this.pointerTarget.y - this.pointer.y) * CONFIG.springK;
      this.pointerVel.multiplyScalar(CONFIG.springDamp);
      this.pointer.add(this.pointerVel);
    }
    const k = 1 - Math.exp(-7 * dt);
    this.pointerAmt += ((this.pointerAmtTarget || 0) - this.pointerAmt) * k;
    u.uPointer.value.copy(this.pointer);
    u.uPointerAmt.value = this.pointerAmt;

    this.composer.render();
  }

  /* ------------------------------------------------------------- teardown */

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    live -= 1;
    Experience.live = live;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerleave', this.onPointerOut);
    window.removeEventListener('blur', this.onPointerOut);
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.material.dispose();
      this.points = null;
    }
    if (this.composer) this.composer.dispose?.();
    this.renderer.dispose();
  }
}
