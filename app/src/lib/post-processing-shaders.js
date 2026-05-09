// Custom shader passes used by AvatarScene's post-processing chain.
// Ported from ai-assistant/frontend/src/components/ThreeScene.jsx — same
// math, refactored as a standalone module so the scene component stays
// focused on rendering.

// Distance-based blur — center sharp, edges blur. Cheaper than a real DoF
// pass and reads as "the avatar is in focus." `blurStrength` 0..1 controls
// how aggressive the falloff is.
export const DistanceBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    blurStrength: { value: 0.0 },
    resolution: { value: null }, // THREE.Vector2 set by the host
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float blurStrength;
    uniform vec2 resolution;
    varying vec2 vUv;

    void main() {
      if (blurStrength < 0.021) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      vec2 center = vec2(0.5, 0.5);
      float dist = length(vUv - center) * 5.0;
      float blur = dist * blurStrength;
      vec2 blurSize = vec2(blur) / resolution;
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (float x = -5.0; x <= 5.0; x += 0.5) {
        for (float y = -5.0; y <= 5.0; y += 1.0) {
          float weight = exp(-(x*x + y*y) / 2.0);
          sum += texture2D(tDiffuse, vUv + vec2(x, y) * blurSize) * weight;
          total += weight;
        }
      }
      gl_FragColor = sum / total;
    }
  `,
};

// Barrel (lens) distortion. Pulls the corners in to fake a wide-angle lens
// look. `amount` ~0..6 is how much, `zoom` compensates for the resulting
// inward pull.
export const BarrelDistortionShader = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0.0 },
    zoom: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float zoom;
    varying vec2 vUv;

    void main() {
      vec2 center = vec2(0.5);
      vec2 uv = (vUv - center) / zoom;
      float r2 = dot(uv, uv);
      uv *= 1.0 + amount * r2 * 0.05;
      uv += center;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      gl_FragColor = texture2D(tDiffuse, uv);
    }
  `,
};

// Color grading: contrast / brightness / saturation / temperature / vignette.
// Sensible defaults are mostly identity (1.0 contrast, 0.0 brightness, etc.).
export const ColorGradingShader = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.0 },
    brightness: { value: 0.0 },
    saturation: { value: 1.0 },
    temperature: { value: 0.0 },
    vignette: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float brightness;
    uniform float saturation;
    uniform float temperature;
    uniform float vignette;
    varying vec2 vUv;

    vec3 applyContrast(vec3 c, float k) {
      return clamp((c - 0.5) * k + 0.5, 0.0, 1.0);
    }
    vec3 applySaturation(vec3 c, float s) {
      float luma = dot(c, vec3(0.299, 0.587, 0.114));
      return mix(vec3(luma), c, s);
    }
    vec3 applyTemperature(vec3 c, float t) {
      c.r += t;
      c.b -= t * 0.5;
      return clamp(c, 0.0, 1.0);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb;
      c += brightness;
      c = applyContrast(c, contrast);
      c = applySaturation(c, saturation);
      c = applyTemperature(c, temperature);
      float dist = distance(vUv, vec2(0.5));
      float v = smoothstep(0.8, 0.3, dist);
      c = mix(c * (1.0 - vignette), c, v);
      gl_FragColor = vec4(c, texel.a);
    }
  `,
};

// Multi-octave film grain. `intensity` 0..0.2 reads as gentle..heavy.
// Stronger in shadows to match real film stock.
export const FilmGrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0.0 },
    intensity: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float intensity;
    varying vec2 vUv;

    float random(vec2 co) {
      return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 uvR = vUv;
      uvR.y *= random(vec2(uvR.y, time));
      float grain = 0.0;
      grain += random(uvR * 2.5 + time) * 0.5;
      grain += random(uvR * 5.0 - time * 0.5) * 0.3;
      grain += random(uvR * 10.0 + time * 0.3) * 0.2;
      grain = (grain - 0.5) * 2.0;
      float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      float amount = intensity * (1.0 - luminance * 0.3);
      gl_FragColor = vec4(color.rgb + grain * amount, color.a);
    }
  `,
};

// Default config object — the empty/identity state. Each section has an
// `enabled` flag so the host can short-circuit a pass when it's off.
export function defaultPostProcessing() {
  return {
    quality: "high", // "high" | "low" — low halves the bloom resolution
    bloom: { enabled: false, strength: 0.15, radius: 0.5, threshold: 0.9 },
    distanceBlur: { enabled: false, strength: 0.4 },
    barrelDistortion: { enabled: false, amount: 1.0, zoom: 1.1 },
    colorGrading: {
      enabled: false,
      contrast: 1.02,
      brightness: 0.0,
      saturation: 1.03,
      temperature: 0.01,
      vignette: 0.15,
    },
    filmGrain: { enabled: false, intensity: 0.06 },
  };
}

// Curated presets — each is a complete postProcessing object. Apply replaces
// the avatar's current settings wholesale.
export const POST_PROCESSING_PRESETS = {
  raw: () => defaultPostProcessing(),
  cinematic: () => ({
    bloom: { enabled: true, strength: 0.18, radius: 0.6, threshold: 0.85 },
    distanceBlur: { enabled: true, strength: 0.45 },
    barrelDistortion: { enabled: false, amount: 0.0, zoom: 1.0 },
    colorGrading: {
      enabled: true,
      contrast: 1.06,
      brightness: -0.02,
      saturation: 0.95,
      temperature: 0.02,
      vignette: 0.25,
    },
    filmGrain: { enabled: true, intensity: 0.07 },
  }),
  anime: () => ({
    bloom: { enabled: true, strength: 0.35, radius: 0.7, threshold: 0.8 },
    distanceBlur: { enabled: false, strength: 0.0 },
    barrelDistortion: { enabled: false, amount: 0.0, zoom: 1.0 },
    colorGrading: {
      enabled: true,
      contrast: 1.1,
      brightness: 0.04,
      saturation: 1.2,
      temperature: -0.02,
      vignette: 0.0,
    },
    filmGrain: { enabled: false, intensity: 0.0 },
  }),
  dreamy: () => ({
    bloom: { enabled: true, strength: 0.5, radius: 0.9, threshold: 0.6 },
    distanceBlur: { enabled: true, strength: 0.7 },
    barrelDistortion: { enabled: true, amount: 1.5, zoom: 1.15 },
    colorGrading: {
      enabled: true,
      contrast: 0.95,
      brightness: 0.05,
      saturation: 1.1,
      temperature: 0.04,
      vignette: 0.2,
    },
    filmGrain: { enabled: true, intensity: 0.04 },
  }),
};

export const PRESET_KEYS = Object.keys(POST_PROCESSING_PRESETS);
