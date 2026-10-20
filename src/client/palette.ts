import { TEAMS } from '../shared/config';

// Colors that depend on the colorblind setting. Team colors are baked into materials as modules
// load, so this runs first (main.ts imports it before anything else) and reads the saved setting
// straight from storage; changing the setting takes a reload.

const colorblind = (() => {
  try {
    return (JSON.parse(localStorage.getItem('rocket-jump:settings') ?? '{}') as { colorblind?: boolean }).colorblind === true;
  } catch {
    return false;
  }
})();

/** Orange and blue sit far apart for every common kind of colorblindness; red and green don't. */
if (colorblind) {
  (TEAMS[0] as { color: number }).color = 0xff9a1f;
  (TEAMS[1] as { color: number }).color = 0x2f74ff;
}

export const PALETTE = {
  colorblind,
  /** An enemy's name tag in team modes. */
  enemyTag: colorblind ? '#ff9a1f' : '#ff4a3a',
  /** Name tags while watching, by team. */
  teamTags: colorblind ? ['#ffb766', '#8ab0ff'] : ['#ff8a7a', '#7ab4ff'],
  /** The crosshair when the grapple can reach. */
  grapple: colorblind ? '#4fd8ff' : '#7cf0a0',
};
