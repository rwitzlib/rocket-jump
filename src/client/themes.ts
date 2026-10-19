// The look of each map: sky, sun, fog and the light the level is painted with. Maps name a theme
// (MapDef.theme); the client looks it up here, the server never needs it.

export interface Theme {
  sky: {
    top: number;
    horizon: number; // also the fog color
    bottom: number;
    sunColor: number;
    sunSize: number; // 1 - cos(angular radius)
    clouds: number; // 0 clear .. 1 overcast
    cloudColor: number;
    cloudShade: number;
  };
  /** Points toward the sun. */
  sunDir: [number, number, number];
  sun: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  /** Fog starts and ends at these fractions of the map's half-width (with sensible minimums). */
  fog: [number, number];
  exposure: number;
}

export const THEMES: Record<string, Theme> = {
  // Arena and Citadel: the original bright test-range look, with a real sky over it.
  classic: {
    sky: { top: 0x5d9be0, horizon: 0xb4d7f2, bottom: 0x8a9aa8, sunColor: 0xfff0d0, sunSize: 0.0012, clouds: 0.38, cloudColor: 0xffffff, cloudShade: 0xc4d2e2 },
    sunDir: [30, 60, 20],
    sun: { color: 0xfff2dd, intensity: 2.4 },
    hemi: { sky: 0xdfefff, ground: 0x5a5048, intensity: 1.6 },
    fog: [0.6, 2.2],
    exposure: 1,
  },
  // Dockyard: a bright, breezy harbor morning.
  harbor: {
    sky: { top: 0x3f8fe6, horizon: 0xbfe3f7, bottom: 0x2d6f96, sunColor: 0xfff1cf, sunSize: 0.0014, clouds: 0.42, cloudColor: 0xffffff, cloudShade: 0xb9cde3 },
    sunDir: [-40, 55, 30],
    sun: { color: 0xfff0d8, intensity: 2.6 },
    hemi: { sky: 0xd4ecff, ground: 0x6a6258, intensity: 1.5 },
    fog: [1.5, 5],
    exposure: 1.05,
  },
  // Sunken Temple: late golden afternoon in the jungle.
  jungle: {
    sky: { top: 0x4a86c8, horizon: 0xf5d7a0, bottom: 0x5b6e4c, sunColor: 0xffc878, sunSize: 0.0016, clouds: 0.34, cloudColor: 0xfff1dc, cloudShade: 0xd8a888 },
    sunDir: [50, 32, -30],
    sun: { color: 0xffd7a0, intensity: 2.7 },
    hemi: { sky: 0xcfe4ff, ground: 0x4f5a34, intensity: 1.35 },
    fog: [0.8, 2.8],
    exposure: 1,
  },
  // Skyreach: islands above the clouds at sunset.
  dusk: {
    sky: { top: 0x3b4f9a, horizon: 0xffb58a, bottom: 0xf2c6b0, sunColor: 0xffa060, sunSize: 0.002, clouds: 0.5, cloudColor: 0xffe2d0, cloudShade: 0xb07aa0 },
    sunDir: [-60, 18, -40],
    sun: { color: 0xffc090, intensity: 2.6 },
    hemi: { sky: 0xb8c4ff, ground: 0x7a5068, intensity: 1.5 },
    fog: [1.0, 3.6],
    exposure: 1.05,
  },
};
