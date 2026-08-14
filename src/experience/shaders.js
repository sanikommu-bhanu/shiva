/* shaders.js — one vertex program drives the entire field. */

/* Simplex noise 3D — Ashima Arts / Stefan Gustavson, MIT. */
const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/*
 * Every particle carries its place in every formation it will ever visit, so
 * changing scene is three uniform writes — uFrom, uTo, uBlend — and never
 * touches geometry. xyz is the rest position sampled from the image; w packs
 * the brightness of the pixel it came from together with its point size.
 *
 * The attribute list is generated to match however many formations the piece
 * is built from; with a single one the blend collapses to a no-op.
 */
export const buildFieldVert = (formations, elements) => /* glsl */ `
${Array.from({ length: formations }, (_, i) => `attribute vec4 aF${i};`).join('\n')}
attribute vec3 aEntry;   // the stardust it wakes from
attribute vec4 aRand;
attribute vec2 aMeta;    // x reveal delay · y element id

uniform float uFrom;
uniform float uTo;
uniform float uBlend;
uniform float uAssemble;
uniform float uWake;
uniform float uFade;
uniform float uTime;
uniform float uSizeScale;
uniform float uSizeMax;
uniform float uBoost;
uniform float uAlpha[${elements}];
uniform float uDrift[${elements}];
uniform float uSoft[${elements}];
uniform vec2  uPointer;
uniform float uPointerAmt;
uniform float uPointerRadius;
uniform float uSpread;

varying float vBright;
varying float vAlpha;
varying float vSoft;

${SIMPLEX}

float sel(float a, float b) { return max(0.0, 1.0 - abs(a - b)); }
float smoother(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

void main() {
  vec4 A = ${Array.from({ length: formations }, (_, i) => `aF${i} * sel(uFrom, ${i}.0)`).join(' + ')};
  vec4 B = ${Array.from({ length: formations }, (_, i) => `aF${i} * sel(uTo, ${i}.0)`).join(' + ')};

  float delay = aMeta.x;
  float el = aMeta.y;
  // element 0 is the smoke, the last element is the light — by construction
  float isSmoke = 1.0 - min(1.0, abs(el - 0.0));
  float isLight = 1.0 - min(1.0, abs(el - ${elements - 1}.0));

  // The artwork is 9:16; a desktop window is not. Rather than leave the piece
  // as a narrow column in a black field, the one element with no fixed shape —
  // the smoke — widens to meet the edges of whatever viewport it is given.
  // Nothing that has a shape is ever stretched.
  float widen = mix(1.0, uSpread, isSmoke);

  // per-particle stagger: each formation dissolves and rebuilds in its
  // authored order rather than all at once
  float lt = clamp(uBlend * 1.42 - delay * 0.42, 0.0, 1.0);
  float e = smoother(lt);

  vec3 p = mix(A.xyz, B.xyz, e);
  p.x *= widen;
  p.y *= mix(1.0, 1.30, isSmoke); // the smoke runs past the top and bottom too

  // never a straight line: the field swirls through depth mid-flight
  float bulge = sin(3.14159265 * e);
  float ang = bulge * (aRand.x - 0.5) * 1.15;
  float c = cos(ang), s = sin(ang);
  p.xz = vec2(p.x * c - p.z * s, p.x * s + p.z * c);
  p.z += bulge * (0.18 + aRand.y * 0.75);
  p.xy += bulge * (aRand.zw - 0.5) * 0.26 * mix(1.0, 1.7, isSmoke);

  // unpack brightness, size and opacity; interpolate all three
  float oA = mod(A.w, 256.0);
  float sA = mod(floor(A.w / 256.0), 256.0);
  float cA = floor(A.w / 65536.0);
  float oB = mod(B.w, 256.0);
  float sB = mod(floor(B.w / 256.0), 256.0);
  float cB = floor(B.w / 65536.0);
  float bright = mix(cA, cB, e) / 254.0;
  float size = mix(sA, sB, e) / 254.0 * uSizeMax;
  float alpha = uAlpha[int(el + 0.5)] * mix(oA, oB, e) / 254.0;

  // spreading the smoke over a wider frame must not thin it out
  size *= mix(1.0, sqrt(uSpread), isSmoke);

  // Assembly out of the woken stardust: staggered by element, once. The ease
  // accelerates smoothly and arrives under control rather than snapping —
  // the convergence is the moment the whole piece is built around.
  float at = clamp(uAssemble * 1.38 - delay * 0.38, 0.0, 1.0);
  float form = at < 0.5
    ? 16.0 * at * at * at * at * at
    : 1.0 - pow(-2.0 * at + 2.0, 5.0) * 0.5;
  p = mix(aEntry, p, form);

  // In flight a particle keeps its own value, only dimmed — a flat grey for
  // every unformed particle is what turns the assembly into static. Carrying
  // the artwork's own tone means the storm is already the picture.
  bright = mix(bright * 0.7, bright, form);
  size = mix(size * 0.75 + 0.004, size, form);
  alpha = mix(alpha * 0.42 * uWake, alpha, form);

  // Idle drift — the smoke rolls, everything with a shape only breathes.
  // Amplitude is per element, so the silhouette never softens.
  float t = uTime * 0.06;
  float n1 = snoise(vec3(p.xy * 1.25, t + aRand.x * 17.0));
  float n2 = snoise(vec3(p.yx * 1.25 + 11.3, t + 31.4 + aRand.y * 17.0));
  vec3 drift = vec3(n1, n2, (n1 + n2) * 0.5);
  p += drift * mix(0.022, uDrift[int(el + 0.5)], form) * (0.55 + 0.9 * aRand.w);

  // the pointer is part of the same field: a soft deflection, sprung back
  if (uPointerAmt > 0.001) {
    vec2 d = p.xy - uPointer;
    float l = length(d) + 1e-4;
    float f = 1.0 - smoothstep(0.0, uPointerRadius, l);
    f *= f;
    p.xy += (d / l) * f * uPointerRadius * 0.5 * uPointerAmt;
    p.z += f * 0.25 * uPointerAmt;
  }

  // mid-flight the swarm loosens and thins
  size *= 1.0 + 0.45 * bulge * bulge;
  alpha *= 1.0 - 0.22 * bulge;
  alpha *= uFade;

  // The light stays dark until it has nearly arrived, then ignites. Gathering
  // at full brightness would put a glowing blob on screen that reads as a
  // second trishul on its way in.
  bright *= mix(1.0, smoothstep(0.55, 1.0, form), isLight);

  // and once lit it breathes, 85–100% over a 4s cycle
  bright *= mix(1.0, 0.925 + 0.075 * sin(uTime * 1.5707963), isLight);
  bright = clamp(bright * uBoost, 0.0, 1.0);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(size * uSizeScale / -mv.z, 0.5, 240.0);
  vBright = bright;
  vAlpha = alpha;
  vSoft = uSoft[int(el + 0.5)];
}
`;

export const FIELD_FRAG = /* glsl */ `
precision highp float;
varying float vBright;
varying float vAlpha;
varying float vSoft;

void main() {
  // Round, never square — square dots read as television static. How much of
  // the disc is solid before it falls away is per element: the tonal layer is
  // nearly a flat dot so it covers its own spacing and reads as tone, while
  // smoke is pure feather.
  float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - vSoft;
  float a = 1.0 - smoothstep(core, 1.0, r);
  gl_FragColor = vec4(vec3(vBright), a * vAlpha);
}
`;

/* Final pass — natural light falloff and fine grain. No colour anywhere. */
export const GRAIN_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: [1, 1] },
    uTime: { value: 0 },
    uGrain: { value: 0.03 },
    uAspect: { value: 1 },
    uFade: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uGrain;
    uniform float uAspect;
    uniform float uFade;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
      float r = length(q);
      col *= mix(0.66, 1.0, smoothstep(1.45, 0.38, r));

      // film grain, stepped to ~24fps so it flickers like emulsion
      float g = hash(vUv * uResolution + floor(uTime * 24.0) * 13.77) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(max(col, 0.0) * uFade, 1.0);
    }
  `,
};
