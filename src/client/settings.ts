import { MAX_NAME } from '../shared/protocol';
import { ACTIONS, DEFAULT_BINDS, type Binds } from './input';

// Player preferences, kept in localStorage. Everything has a sensible default, and storage being
// unavailable (private windows, blocked site data) just means nothing is remembered.

export type CrosshairStyle = 'circle' | 'dot' | 'cross' | 'circle-dot';

export interface Settings {
  name: string;
  sensitivity: number; // multiplier on the base mouse speed
  padSensitivity: number; // multiplier on the gamepad's look speed
  fov: number; // degrees, vertical
  volume: number; // 0..1
  invertY: boolean;
  showFps: boolean;
  graphics: 'high' | 'low'; // post-processing (outlines, bloom, antialiasing) on or off
  killcam: boolean; // replay your death from the killer's view
  binds: Binds;
  crosshairStyle: CrosshairStyle;
  crosshairColor: string; // #rrggbb
  crosshairSize: number; // multiplier
  colorblind: boolean; // orange and blue teams, cyan grapple cue: told apart without red and green
  hints: boolean; // tips for new players in their first few games
  touchLayout: 'right' | 'left'; // which thumb aims on a touch screen
}

const KEY = 'rocket-jump:settings';

export const DEFAULTS: Settings = {
  name: '',
  sensitivity: 1,
  padSensitivity: 1,
  fov: 90,
  volume: 0.8,
  invertY: false,
  showFps: false,
  graphics: 'high',
  killcam: true,
  binds: structuredClone(DEFAULT_BINDS),
  crosshairStyle: 'circle',
  crosshairColor: '#ffffff',
  crosshairSize: 1,
  colorblind: false,
  hints: true,
  touchLayout: 'right',
};

export const LIMITS = {
  sensitivity: { min: 0.1, max: 4, step: 0.05 },
  padSensitivity: { min: 0.2, max: 3, step: 0.05 },
  fov: { min: 70, max: 110, step: 1 },
  volume: { min: 0, max: 1, step: 0.05 },
  crosshairSize: { min: 0.5, max: 2.5, step: 0.1 },
};

const STYLES: CrosshairStyle[] = ['circle', 'dot', 'cross', 'circle-dot'];

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULTS, ...raw };
    s.name = typeof s.name === 'string' ? s.name.slice(0, MAX_NAME) : '';
    for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      const v = Number(s[k]);
      s[k] = Number.isFinite(v) ? Math.min(LIMITS[k].max, Math.max(LIMITS[k].min, v)) : DEFAULTS[k];
    }
    s.invertY = !!s.invertY;
    s.showFps = !!s.showFps;
    s.graphics = s.graphics === 'low' ? 'low' : 'high';
    s.killcam = s.killcam !== false;
    s.colorblind = !!s.colorblind;
    s.hints = s.hints !== false;
    s.touchLayout = s.touchLayout === 'left' ? 'left' : 'right';
    s.crosshairStyle = STYLES.includes(s.crosshairStyle) ? s.crosshairStyle : 'circle';
    s.crosshairColor = /^#[0-9a-f]{6}$/i.test(String(s.crosshairColor)) ? s.crosshairColor : '#ffffff';
    // Binds: every action, each a short list of codes; anything malformed falls back to the default.
    const binds = structuredClone(DEFAULT_BINDS);
    const saved = (raw.binds ?? {}) as Partial<Record<string, unknown>>;
    for (const { id } of ACTIONS) {
      const list = saved[id];
      if (Array.isArray(list) && list.every((c) => typeof c === 'string' && c.length < 32)) binds[id] = list.slice(0, 4) as string[];
    }
    s.binds = binds;
    return s;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/** Whether this browser has settings saved from before (a returning player). */
export function hasSavedSettings(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered, but still applied for this session
  }
}
