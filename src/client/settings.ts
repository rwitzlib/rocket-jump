import { MAX_NAME } from '../shared/protocol';

// Player preferences, kept in localStorage. Everything has a sensible default, and storage being
// unavailable (private windows, blocked site data) just means nothing is remembered.

export interface Settings {
  name: string;
  sensitivity: number; // multiplier on the base mouse speed
  fov: number; // degrees, vertical
  volume: number; // 0..1
  invertY: boolean;
  showFps: boolean;
  graphics: 'high' | 'low'; // post-processing (outlines, bloom, antialiasing) on or off
  killcam: boolean; // replay your death from the killer's view
}

const KEY = 'rocket-jump:settings';

export const DEFAULTS: Settings = {
  name: '',
  sensitivity: 1,
  fov: 90,
  volume: 0.8,
  invertY: false,
  showFps: false,
  graphics: 'high',
  killcam: true,
};

export const LIMITS = {
  sensitivity: { min: 0.1, max: 4, step: 0.05 },
  fov: { min: 70, max: 110, step: 1 },
  volume: { min: 0, max: 1, step: 0.05 },
};

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULTS, ...raw };
    s.name = typeof s.name === 'string' ? s.name.slice(0, MAX_NAME) : '';
    for (const k of ['sensitivity', 'fov', 'volume'] as const) {
      const v = Number(s[k]);
      s[k] = Number.isFinite(v) ? Math.min(LIMITS[k].max, Math.max(LIMITS[k].min, v)) : DEFAULTS[k];
    }
    s.invertY = !!s.invertY;
    s.showFps = !!s.showFps;
    s.graphics = s.graphics === 'low' ? 'low' : 'high';
    s.killcam = s.killcam !== false;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered, but still applied for this session
  }
}
