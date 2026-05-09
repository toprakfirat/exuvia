import React from "react";
import {
  defaultPostProcessing,
  POST_PROCESSING_PRESETS,
  PRESET_KEYS,
} from "../lib/post-processing-shaders.js";

// Per-avatar post-processing controls.
// `value` is the avatar's postProcessing object (or null/undefined for "off").
// `onChange(next)` receives a new full object.

export default function EffectsSection({ value, onChange }) {
  const cfg = mergeWithDefaults(value);

  const update = (section, patch) => {
    onChange({
      ...cfg,
      [section]: { ...cfg[section], ...patch },
    });
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        <span
          className="muted"
          style={{ fontSize: 10, letterSpacing: "0.5px", textTransform: "uppercase", marginRight: 4 }}
        >
          preset
        </span>
        {PRESET_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => onChange({ ...POST_PROCESSING_PRESETS[key](), quality: cfg.quality })}
            type="button"
            style={{ padding: "3px 8px", fontSize: 10, letterSpacing: "0.4px" }}
          >
            {key}
          </button>
        ))}
      </div>
      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11,
          color: "rgba(255,255,255,0.6)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={cfg.quality === "low"}
          onChange={(e) =>
            onChange({ ...cfg, quality: e.target.checked ? "low" : "high" })
          }
        />
        <span>Low quality mode — halves bloom resolution for integrated GPUs.</span>
      </label>

      <Effect
        title="Bloom"
        enabled={cfg.bloom.enabled}
        onToggle={(v) => update("bloom", { enabled: v })}
      >
        <Slider
          label="strength"
          value={cfg.bloom.strength}
          min={0}
          max={1.5}
          step={0.01}
          onChange={(v) => update("bloom", { strength: v })}
        />
        <Slider
          label="radius"
          value={cfg.bloom.radius}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => update("bloom", { radius: v })}
        />
        <Slider
          label="threshold"
          value={cfg.bloom.threshold}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => update("bloom", { threshold: v })}
        />
      </Effect>

      <Effect
        title="Distance blur"
        enabled={cfg.distanceBlur.enabled}
        onToggle={(v) => update("distanceBlur", { enabled: v })}
      >
        <Slider
          label="strength"
          value={cfg.distanceBlur.strength}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => update("distanceBlur", { strength: v })}
        />
      </Effect>

      <Effect
        title="Barrel distortion"
        enabled={cfg.barrelDistortion.enabled}
        onToggle={(v) => update("barrelDistortion", { enabled: v })}
      >
        <Slider
          label="amount"
          value={cfg.barrelDistortion.amount}
          min={-3}
          max={6}
          step={0.05}
          onChange={(v) => update("barrelDistortion", { amount: v })}
        />
        <Slider
          label="zoom"
          value={cfg.barrelDistortion.zoom}
          min={0.5}
          max={2}
          step={0.01}
          onChange={(v) => update("barrelDistortion", { zoom: v })}
        />
      </Effect>

      <Effect
        title="Color grading"
        enabled={cfg.colorGrading.enabled}
        onToggle={(v) => update("colorGrading", { enabled: v })}
      >
        <Slider
          label="contrast"
          value={cfg.colorGrading.contrast}
          min={0.5}
          max={2}
          step={0.01}
          onChange={(v) => update("colorGrading", { contrast: v })}
        />
        <Slider
          label="brightness"
          value={cfg.colorGrading.brightness}
          min={-0.3}
          max={0.3}
          step={0.005}
          onChange={(v) => update("colorGrading", { brightness: v })}
        />
        <Slider
          label="saturation"
          value={cfg.colorGrading.saturation}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => update("colorGrading", { saturation: v })}
        />
        <Slider
          label="temperature"
          value={cfg.colorGrading.temperature}
          min={-0.3}
          max={0.3}
          step={0.005}
          onChange={(v) => update("colorGrading", { temperature: v })}
        />
        <Slider
          label="vignette"
          value={cfg.colorGrading.vignette}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => update("colorGrading", { vignette: v })}
        />
      </Effect>

      <Effect
        title="Film grain"
        enabled={cfg.filmGrain.enabled}
        onToggle={(v) => update("filmGrain", { enabled: v })}
      >
        <Slider
          label="intensity"
          value={cfg.filmGrain.intensity}
          min={0}
          max={0.3}
          step={0.005}
          onChange={(v) => update("filmGrain", { intensity: v })}
        />
      </Effect>
    </section>
  );
}

function Effect({ title, enabled, onToggle, children }) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.06)",
        padding: "8px 0 6px",
        opacity: enabled ? 1 : 0.55,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        transition: "opacity 0.15s ease",
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          fontSize: 11,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
          color: enabled ? "#e7e7ea" : "rgba(255,255,255,0.45)",
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>{title}</span>
      </label>
      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginBottom: 6,
      }}
    >
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: 10,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
        }}
      >
        <span>{label}</span>
        <span
          style={{
            fontFamily:
              'ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace',
            fontSize: 10,
            color: "rgba(255,255,255,0.7)",
          }}
        >
          {Number(value).toFixed(stepDigits(step))}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function stepDigits(step) {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 3;
}

function mergeWithDefaults(value) {
  const d = defaultPostProcessing();
  if (!value) return d;
  return {
    quality: value.quality === "low" ? "low" : "high",
    bloom: { ...d.bloom, ...(value.bloom ?? {}) },
    distanceBlur: { ...d.distanceBlur, ...(value.distanceBlur ?? {}) },
    barrelDistortion: { ...d.barrelDistortion, ...(value.barrelDistortion ?? {}) },
    colorGrading: { ...d.colorGrading, ...(value.colorGrading ?? {}) },
    filmGrain: { ...d.filmGrain, ...(value.filmGrain ?? {}) },
  };
}
