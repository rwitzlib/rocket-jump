import * as THREE from 'three';
import { KOTH, RACE } from '../shared/config';
import { CUSTOM_LIMITS, encodeMapCode, MAP_THEMES, sanitizeMap, SURFACES } from '../shared/custommap';
import type { ItemKind, MapDef, SurfaceKind, Vec3Tuple } from '../shared/map';
import { boxMesh } from './level';
import type { PostFX } from './postfx';
import { Sky } from './sky';
import { resetLevelMaterials } from './surfaces';
import { THEMES } from './themes';

// The map editor: build a level out of boxes, put down spawns, mystery boxes, items, flags, race
// rings and hill spots, then play it at once (practice), host a room on it, or share it as a code.
//
// Fly with WASD, Space and Shift; hold the right mouse button to look. Pick a tool (or press its
// number), click to place; with Select, click anything to edit it in the panel. Arrows and Page
// Up/Down nudge what's selected, Delete removes it, Ctrl+D duplicates, Ctrl+Z undoes.

type Tool = 'select' | 'box' | 'spawn' | 'pickup' | ItemKind | 'flag' | 'ring' | 'start' | 'hill' | 'crate';
type Kind = 'box' | 'spawn' | 'pickup' | 'item' | 'flag' | 'ring' | 'start' | 'hill' | 'crate';
interface Selection {
  kind: Kind;
  index: number;
}

export const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: '`' },
  { id: 'box', label: 'Box', key: '1' },
  { id: 'spawn', label: 'Spawn', key: '2' },
  { id: 'pickup', label: '? box', key: '3' },
  { id: 'health', label: 'Health', key: '4' },
  { id: 'armor', label: 'Armor', key: '5' },
  { id: 'overdrive', label: 'Overdrive', key: '6' },
  { id: 'flag', label: 'Flags', key: '7' },
  { id: 'ring', label: 'Race ring', key: '8' },
  { id: 'start', label: 'Race start', key: '9' },
  { id: 'hill', label: 'Hill', key: '0' },
  { id: 'crate', label: 'Crate', key: '-' },
];

const SAVED_KEY = 'rocket-jump:maps';
const CURRENT_KEY = 'rocket-jump:editor-current';
const FLY_SPEED = 22;
const LOOK = 0.004;
const GRID = 0.5;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** A fresh map: a floor and four spawns. */
export function blankMap(): MapDef {
  return {
    title: 'My map',
    blurb: '',
    theme: 'classic',
    fragLimit: 20,
    boxes: [{ pos: [0, -0.5, 0], size: [80, 1, 80], color: 0x8a94a6, mat: 'grid' }],
    crates: [],
    spawns: [
      { pos: [0, 1, 30], yaw: 0 },
      { pos: [0, 1, -30], yaw: Math.PI },
      { pos: [30, 1, 0], yaw: Math.PI / 2 },
      { pos: [-30, 1, 0], yaw: -Math.PI / 2 },
    ],
    pickups: [],
    items: [],
    killY: -30,
  };
}

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // not saved
    }
  },
};

/** Maps saved in this browser, by name. */
export const savedMaps = () => store.get<Record<string, MapDef>>(SAVED_KEY, {});

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export interface EditorHooks {
  /** Play it now, in practice. */
  test(map: MapDef): void;
  /** Open an online room on it. */
  host(map: MapDef): void;
  /** Back to the menu. */
  exit(): void;
}

export class MapEditor {
  map: MapDef = blankMap();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1500);
  private readonly world = new THREE.Group(); // boxes and markers, rebuilt as the map changes
  private readonly helpers = new THREE.Group(); // the grid and the selection outline
  private sky: Sky | null = null;
  private yaw = Math.PI / 4;
  private pitch = -0.45;
  private readonly keys = new Set<string>();
  private looking = false;
  private tool: Tool = 'select';
  private selection: Selection | null = null;
  private pickables: { mesh: THREE.Object3D; sel: Selection }[] = [];
  private history: string[] = [];
  private lastSize: Vec3Tuple = [4, 1, 4];
  private flagNext = 0;
  private dirty = true;
  private active = false;
  private readonly ray = new THREE.Raycaster();
  private readonly ui = $('#editor');
  private readonly panel = $('#editor-panel');
  private readonly status = $('#editor-status');

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly post: PostFX,
    private readonly hooks: EditorHooks,
  ) {
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(45, 30, 45);
    this.scene.add(this.world, this.helpers);
    const grid = new THREE.GridHelper(400, 100, 0x5a6a88, 0x3a4458);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.18;
    grid.position.y = 0.01;
    this.helpers.add(grid);
    this.buildToolbar();
    this.bindInput();
  }

  // --- opening and closing ----------------------------------------------------------------------

  open(map?: MapDef) {
    this.map = structuredClone(map ?? store.get<MapDef | null>(CURRENT_KEY, null) ?? blankMap());
    this.history = [];
    this.selection = null;
    this.active = true;
    this.ui.hidden = false;
    this.dirty = true;
    this.setTool('select');
    this.renderPanel();
  }

  close() {
    this.active = false;
    this.ui.hidden = true;
    this.keys.clear();
    this.clearWorld();
    resetLevelMaterials();
  }

  get isOpen() {
    return this.active;
  }

  // --- the frame --------------------------------------------------------------------------------

  frame(dt: number) {
    if (!this.active) return;
    if (this.dirty) this.rebuild();
    const k = this.keys;
    const speed = FLY_SPEED * (k.has('ControlLeft') ? 3 : 1) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const p = this.camera.position;
    if (k.has('KeyW')) p.addScaledVector(forward, speed);
    if (k.has('KeyS')) p.addScaledVector(forward, -speed);
    if (k.has('KeyD')) p.addScaledVector(right, speed);
    if (k.has('KeyA')) p.addScaledVector(right, -speed);
    if (k.has('Space')) p.y += speed;
    if (k.has('ShiftLeft')) p.y -= speed;
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.camera.aspect !== w / h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.sky?.update(dt);
    this.renderer.toneMappingExposure = THEMES[this.map.theme ?? 'classic']?.exposure ?? 1;
    this.post.outlineFade = [60, 200];
    this.post.render(this.scene, this.camera);
  }

  // --- building what's shown --------------------------------------------------------------------

  private clearWorld() {
    this.world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // Box surfaces are shared (surfaces.ts caches them); only geometry is ours.
      mesh.geometry?.dispose();
    });
    this.world.clear();
    this.pickables = [];
  }

  /** Builds everything from the map again: cheap enough for maps this size, and never out of step. */
  private rebuild() {
    this.dirty = false;
    this.clearWorld();
    const map = this.map;
    const theme = THEMES[map.theme ?? 'classic'] ?? THEMES.classic;
    if (this.sky) this.scene.remove(this.sky.mesh);
    this.sky = new Sky(theme);
    this.scene.add(this.sky.mesh);
    this.scene.background = new THREE.Color(theme.sky.horizon);
    this.scene.fog = new THREE.Fog(theme.sky.horizon, 250, 900);
    this.world.add(new THREE.HemisphereLight(theme.hemi.sky, theme.hemi.ground, theme.hemi.intensity));
    const sun = new THREE.DirectionalLight(theme.sun.color, theme.sun.intensity);
    sun.position.set(...theme.sunDir);
    this.world.add(sun);

    map.boxes.forEach((b, index) => {
      const mesh = boxMesh(b);
      mesh.castShadow = mesh.receiveShadow = false;
      this.world.add(mesh);
      this.pickables.push({ mesh, sel: { kind: 'box', index } });
    });
    const marker = (kind: Kind, index: number, obj: THREE.Object3D) => {
      this.world.add(obj);
      this.pickables.push({ mesh: obj, sel: { kind, index } });
    };
    map.spawns.forEach((s, i) => marker('spawn', i, spawnMarker(s.pos, s.yaw, 0x60ff90)));
    map.pickups.forEach((p, i) => marker('pickup', i, cube(p, 0.8, 0xa060ff)));
    (map.items ?? []).forEach((it, i) => marker('item', i, cube([it.pos[0], it.pos[1] + 0.7, it.pos[2]], 0.6, it.kind === 'health' ? 0x60ff60 : it.kind === 'armor' ? 0x50a0ff : 0xff40d0)));
    (map.flags ?? []).forEach((f, i) => marker('flag', i, flagMarker(f, i === 0 ? 0xf0503c : 0x3d8cf0)));
    map.crates.forEach((c, i) => marker('crate', i, cube(c, 1.2, 0xa0784a)));
    (map.hills ?? []).forEach((h, i) => marker('hill', i, hillMarker(h)));
    if (map.race) {
      marker('start', 0, spawnMarker(map.race.start, 0, 0xffe060));
      map.race.rings.forEach((r, i) => marker('ring', i, ringMarker(r, i === 0 ? 0xffe060 : 0x50e0ff)));
    }
    this.showSelection();
  }

  private showSelection() {
    for (const c of [...this.helpers.children]) if (c.name === 'selection') this.helpers.remove(c);
    const sel = this.selection;
    if (!sel) return;
    const hit = this.pickables.find((p) => p.sel.kind === sel.kind && p.sel.index === sel.index);
    if (!hit) return;
    const outline = new THREE.BoxHelper(hit.mesh, 0xffe040);
    outline.name = 'selection';
    this.helpers.add(outline);
  }

  // --- editing ----------------------------------------------------------------------------------

  /** Call before every change: remembers the map as it was, for undo. */
  private remember() {
    this.history.push(JSON.stringify(this.map));
    if (this.history.length > 60) this.history.shift();
  }

  private changed() {
    this.dirty = true;
    store.set(CURRENT_KEY, this.map);
    this.renderPanel();
  }

  private undo() {
    const last = this.history.pop();
    if (!last) return;
    this.map = JSON.parse(last) as MapDef;
    this.selection = null;
    this.changed();
  }

  /** The position of what's selected (a reference into the map: changing it moves the thing). */
  private selectedPos(): Vec3Tuple | null {
    const s = this.selection;
    if (!s) return null;
    const m = this.map;
    switch (s.kind) {
      case 'box':
        return m.boxes[s.index]?.pos ?? null;
      case 'spawn':
        return m.spawns[s.index]?.pos ?? null;
      case 'pickup':
        return m.pickups[s.index] ?? null;
      case 'item':
        return m.items?.[s.index]?.pos ?? null;
      case 'flag':
        return m.flags?.[s.index] ?? null;
      case 'crate':
        return m.crates[s.index] ?? null;
      case 'hill':
        return m.hills?.[s.index] ?? null;
      case 'ring':
        return m.race?.rings[s.index] ?? null;
      case 'start':
        return m.race?.start ?? null;
    }
  }

  private deleteSelected() {
    const s = this.selection;
    if (!s) return;
    const m = this.map;
    this.remember();
    const drop = <T>(list: T[] | undefined) => list?.splice(s.index, 1);
    switch (s.kind) {
      case 'box':
        if (m.boxes.length > 1) drop(m.boxes);
        break;
      case 'spawn':
        if (m.spawns.length > 1) drop(m.spawns);
        break;
      case 'pickup':
        drop(m.pickups);
        break;
      case 'item':
        drop(m.items);
        break;
      case 'flag':
        delete m.flags; // flags go as a pair
        break;
      case 'crate':
        drop(m.crates);
        break;
      case 'hill':
        drop(m.hills);
        break;
      case 'ring':
        drop(m.race?.rings);
        if (m.race && m.race.rings.length === 0) delete m.race;
        break;
      case 'start':
        delete m.race;
        break;
    }
    this.selection = null;
    this.changed();
  }

  private duplicate() {
    const s = this.selection;
    if (s?.kind !== 'box' || this.map.boxes.length >= CUSTOM_LIMITS.boxes) return;
    this.remember();
    const copy = structuredClone(this.map.boxes[s.index]);
    copy.pos[0] += copy.size[0];
    this.map.boxes.push(copy);
    this.selection = { kind: 'box', index: this.map.boxes.length - 1 };
    this.changed();
  }

  private nudge(dx: number, dy: number, dz: number, resize: boolean) {
    const s = this.selection;
    if (!s) return;
    this.remember();
    if (resize && s.kind === 'box') {
      const b = this.map.boxes[s.index];
      b.size = [Math.max(0.5, b.size[0] + dx), Math.max(0.25, b.size[1] + dy), Math.max(0.5, b.size[2] + dz)];
      this.lastSize = [...b.size];
    } else {
      const p = this.selectedPos();
      if (!p) return;
      p[0] += dx;
      p[1] += dy;
      p[2] += dz;
    }
    this.changed();
  }

  /** Places whatever the tool makes where the cursor points. */
  private place(point: THREE.Vector3, normal: THREE.Vector3) {
    const m = this.map;
    const at: Vec3Tuple = [snap(point.x), snap(point.y), snap(point.z)];
    const above = (h: number): Vec3Tuple => [at[0], at[1] + h, at[2]];
    const full = (n: number, max: number) => n >= max;
    this.remember();
    switch (this.tool) {
      case 'box': {
        if (full(m.boxes.length, CUSTOM_LIMITS.boxes)) return this.say(`That's the most boxes a map can have (${CUSTOM_LIMITS.boxes}).`);
        const [w, h, d] = this.lastSize;
        // Against whatever face was clicked: on top of a floor, beside a wall, under a ceiling.
        const pos: Vec3Tuple = [snap(point.x + (normal.x * w) / 2), snap(point.y + (normal.y * h) / 2), snap(point.z + (normal.z * d) / 2)];
        const last = m.boxes.at(-1);
        m.boxes.push({ pos, size: [w, h, d], color: last?.color ?? 0x8a94a6, mat: last?.mat ?? 'grid' });
        this.selection = { kind: 'box', index: m.boxes.length - 1 };
        break;
      }
      case 'spawn':
        if (full(m.spawns.length, CUSTOM_LIMITS.spawns)) return;
        m.spawns.push({ pos: above(1), yaw: this.yaw });
        this.selection = { kind: 'spawn', index: m.spawns.length - 1 };
        break;
      case 'pickup':
        if (full(m.pickups.length, CUSTOM_LIMITS.pickups)) return;
        m.pickups.push(above(1.4));
        this.selection = { kind: 'pickup', index: m.pickups.length - 1 };
        break;
      case 'health':
      case 'armor':
      case 'overdrive':
        m.items ??= [];
        if (full(m.items.length, CUSTOM_LIMITS.items)) return;
        m.items.push({ kind: this.tool, pos: at });
        this.selection = { kind: 'item', index: m.items.length - 1 };
        break;
      case 'flag': {
        // Red, then blue: each click places the next of the pair.
        m.flags ??= [at, [-at[0], at[1], -at[2]]];
        m.flags[this.flagNext] = at;
        this.selection = { kind: 'flag', index: this.flagNext };
        this.flagNext = 1 - this.flagNext;
        this.say(this.flagNext === 1 ? 'Red flag placed. Click again for the blue one.' : 'Blue flag placed.');
        break;
      }
      case 'ring':
        m.race ??= { start: m.spawns[0].pos, rings: [] };
        if (full(m.race.rings.length, CUSTOM_LIMITS.rings)) return;
        m.race.rings.push(above(RACE.ringRadius * 0.8));
        this.selection = { kind: 'ring', index: m.race.rings.length - 1 };
        this.say(m.race.rings.length === 1 ? 'The first ring is the start and finish gate. Place the rest in order.' : `Ring ${m.race.rings.length - 1} placed.`);
        break;
      case 'start':
        m.race ??= { start: above(1), rings: [] };
        m.race.start = above(1);
        this.selection = { kind: 'start', index: 0 };
        break;
      case 'hill':
        m.hills ??= [];
        if (full(m.hills.length, CUSTOM_LIMITS.hills)) return;
        m.hills.push(at);
        this.selection = { kind: 'hill', index: m.hills.length - 1 };
        break;
      case 'crate':
        if (full(m.crates.length, CUSTOM_LIMITS.crates)) return;
        m.crates.push(above(0.6));
        this.selection = { kind: 'crate', index: m.crates.length - 1 };
        break;
      default:
        this.history.pop();
        return;
    }
    this.changed();
  }

  // --- input ------------------------------------------------------------------------------------

  private pointer(e: MouseEvent): { point: THREE.Vector3; normal: THREE.Vector3; sel: Selection | null } | null {
    const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hits = this.ray.intersectObjects(
      this.pickables.map((p) => p.mesh),
      true,
    );
    const hit = hits[0];
    if (hit) {
      let o: THREE.Object3D | null = hit.object;
      let sel: Selection | null = null;
      while (o && !sel) {
        sel = this.pickables.find((p) => p.mesh === o)?.sel ?? null;
        o = o.parent;
      }
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      return { point: hit.point, normal, sel };
    }
    // Nothing there: the ground plane.
    const t = -this.ray.ray.origin.y / this.ray.ray.direction.y;
    if (t > 0) return { point: this.ray.ray.at(t, new THREE.Vector3()), normal: new THREE.Vector3(0, 1, 0), sel: null };
    return null;
  }

  private bindInput() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (e.button === 2) {
        this.looking = true;
        return;
      }
      if (e.button !== 0) return;
      const hit = this.pointer(e);
      if (!hit) return;
      if (this.tool === 'select') {
        this.selection = hit.sel;
        this.showSelection();
        this.renderPanel();
      } else this.place(hit.point, hit.normal);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.looking = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.active || !this.looking) return;
      this.yaw -= e.movementX * LOOK;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * LOOK));
    });
    canvas.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (typing) return;
      this.keys.add(e.code);
      const step = e.shiftKey ? 0.25 : 1;
      const resize = e.altKey;
      const tool = TOOLS.find((t) => t.key === e.key);
      if (e.ctrlKey && e.code === 'KeyZ') this.undo();
      else if (e.ctrlKey && e.code === 'KeyD') this.duplicate();
      else if (e.code === 'Delete' || e.code === 'Backspace') this.deleteSelected();
      else if (e.code === 'ArrowLeft') this.nudge(-step, 0, 0, resize);
      else if (e.code === 'ArrowRight') this.nudge(step, 0, 0, resize);
      else if (e.code === 'ArrowUp') this.nudge(0, 0, -step, resize);
      else if (e.code === 'ArrowDown') this.nudge(0, 0, step, resize);
      else if (e.code === 'PageUp') this.nudge(0, step, 0, resize);
      else if (e.code === 'PageDown') this.nudge(0, -step, 0, resize);
      else if (e.code === 'Escape') this.setTool('select');
      else if (tool && !e.ctrlKey) this.setTool(tool.id);
      else return;
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private setTool(tool: Tool) {
    this.tool = tool;
    for (const b of this.ui.querySelectorAll<HTMLElement>('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
    if (tool === 'flag') this.flagNext = 0;
  }

  private say(text: string) {
    this.status.textContent = text;
  }

  // --- the panels -------------------------------------------------------------------------------

  private buildToolbar() {
    const bar = $('#editor-tools');
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.dataset.tool = t.id;
      b.className = 'ghost';
      b.innerHTML = `<kbd></kbd><span></span>`;
      b.querySelector('kbd')!.textContent = t.key;
      b.querySelector('span')!.textContent = t.label;
      b.addEventListener('click', () => this.setTool(t.id));
      bar.append(b);
    }
    const action = (id: string, run: () => void) => $(`#${id}`).addEventListener('click', run);
    action('editor-new', () => {
      if (!confirm('Start a new map? The current one is lost unless you saved it.')) return;
      this.remember();
      this.map = blankMap();
      this.selection = null;
      this.changed();
    });
    action('editor-save', () => {
      const name = prompt('Save as:', this.map.title)?.trim();
      if (!name) return;
      this.map.title = name.slice(0, CUSTOM_LIMITS.title);
      const all = savedMaps();
      all[this.map.title] = this.map;
      store.set(SAVED_KEY, all);
      this.say(`Saved "${this.map.title}" in this browser.`);
      this.changed();
    });
    action('editor-open', () => this.showOpen());
    action('editor-share', () => void this.share());
    action('editor-export', () => {
      const blob = new Blob([JSON.stringify(this.map, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.map.title.replace(/[^\w-]+/g, '_') || 'map'}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    action('editor-import', () => $<HTMLInputElement>('#editor-file').click());
    $<HTMLInputElement>('#editor-file').addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const map = sanitizeMap(JSON.parse(await file.text()));
      if (!map) return this.say("That file isn't a map this editor can read.");
      this.remember();
      this.map = map;
      this.selection = null;
      this.changed();
    });
    action('editor-test', () => {
      const map = sanitizeMap(this.map);
      if (!map) return this.say('A map needs at least one box and one spawn.');
      this.hooks.test(map);
    });
    action('editor-host', () => {
      const map = sanitizeMap(this.map);
      if (!map) return this.say('A map needs at least one box and one spawn.');
      this.hooks.host(map);
    });
    action('editor-exit', () => this.hooks.exit());
  }

  private showOpen() {
    const all = savedMaps();
    const names = Object.keys(all);
    if (!names.length) return this.say('Nothing saved in this browser yet.');
    const name = prompt(`Open which map?\n${names.join('\n')}`, names[0]);
    if (!name || !all[name]) return;
    this.remember();
    this.map = sanitizeMap(all[name]) ?? blankMap();
    this.selection = null;
    this.changed();
  }

  private async share() {
    const map = sanitizeMap(this.map);
    if (!map) return this.say('A map needs at least one box and one spawn.');
    const code = await encodeMapCode(map);
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('mapcode', code);
    try {
      await navigator.clipboard.writeText(url.toString());
      this.say(`Link copied (${Math.round(code.length / 1024)} kB): anyone who opens it gets this map in their editor.`);
    } catch {
      prompt('Copy this link:', url.toString());
    }
  }

  /** The panel on the right: the map's settings, and whatever is selected. */
  private renderPanel() {
    const m = this.map;
    const rows: HTMLElement[] = [];
    const field = (label: string, input: HTMLElement) => {
      const row = document.createElement('label');
      row.className = 'editor-field';
      const span = document.createElement('span');
      span.textContent = label;
      row.append(span, input);
      rows.push(row);
    };
    const text = (value: string, set: (v: string) => void) => {
      const i = document.createElement('input');
      i.value = value;
      i.addEventListener('change', () => {
        this.remember();
        set(i.value);
        this.changed();
      });
      return i;
    };
    const number = (value: number, set: (v: number) => void, step = 0.5) => {
      const i = document.createElement('input');
      i.type = 'number';
      i.step = String(step);
      i.value = String(Math.round(value * 1000) / 1000);
      i.addEventListener('change', () => {
        const v = Number(i.value);
        if (!Number.isFinite(v)) return;
        this.remember();
        set(v);
        this.changed();
      });
      return i;
    };
    const select = (value: string, options: string[], set: (v: string) => void) => {
      const s = document.createElement('select');
      for (const o of options) s.append(new Option(o, o));
      s.value = value;
      s.addEventListener('change', () => {
        this.remember();
        set(s.value);
        this.changed();
      });
      return s;
    };
    const color = (value: number, set: (v: number) => void) => {
      const i = document.createElement('input');
      i.type = 'color';
      i.value = `#${value.toString(16).padStart(6, '0')}`;
      i.addEventListener('change', () => {
        this.remember();
        set(parseInt(i.value.slice(1), 16));
        this.changed();
      });
      return i;
    };
    const vec3 = (label: string, v: Vec3Tuple, step = 0.5) => {
      const wrap = document.createElement('div');
      wrap.className = 'vec3';
      v.forEach((_, i) => wrap.append(number(v[i], (n) => (v[i] = n), step)));
      field(label, wrap);
    };
    const heading = (t: string) => {
      const h = document.createElement('h3');
      h.textContent = t;
      rows.push(h);
    };

    heading('Map');
    field('Name', text(m.title, (v) => (m.title = v.slice(0, CUSTOM_LIMITS.title))));
    field('Sky', select(m.theme ?? 'classic', MAP_THEMES, (v) => (m.theme = v)));
    field('Fall death height', number(m.killY, (v) => (m.killY = v), 1));
    field('Kills to win', number(m.fragLimit ?? 20, (v) => (m.fragLimit = Math.round(v)), 1));
    const counts = document.createElement('p');
    counts.className = 'hint';
    counts.textContent = `${m.boxes.length} boxes · ${m.spawns.length} spawns · ${m.pickups.length} ? boxes · ${m.items?.length ?? 0} items · ${m.race ? `${m.race.rings.length} race rings` : 'no race'} · ${m.flags ? 'flags set' : 'no flags (CTF uses the farthest spawns)'}`;
    rows.push(counts);

    const s = this.selection;
    if (s) {
      heading(`Selected: ${s.kind === 'item' ? m.items![s.index].kind : s.kind}`);
      const pos = this.selectedPos();
      if (s.kind === 'box') {
        const b = m.boxes[s.index];
        vec3('Center', b.pos);
        vec3('Size', b.size);
        const rot = (b.rot ??= [0, 0, 0]);
        const deg = (r: number) => Math.round((r * 180) / Math.PI);
        const rad = (d: number) => (d * Math.PI) / 180;
        field('Turn (°)', number(deg(rot[1]), (v) => (rot[1] = rad(v)), 15));
        field('Tilt (°)', number(deg(rot[0]), (v) => (rot[0] = rad(v)), 5));
        field('Surface', select(b.mat ?? 'grid', SURFACES, (v) => (b.mat = v as SurfaceKind)));
        field('Color', color(b.color, (v) => (b.color = v)));
        field('Top surface', select(b.top?.mat ?? '(same)', ['(same)', ...SURFACES], (v) => (v === '(same)' ? delete b.top : (b.top = { mat: v as SurfaceKind, color: b.top?.color ?? b.color }))));
        if (b.top) field('Top color', color(b.top.color, (v) => (b.top!.color = v)));
      } else if (pos) {
        vec3('Position', pos);
        if (s.kind === 'spawn') {
          const sp = m.spawns[s.index];
          field('Facing (°)', number(Math.round((sp.yaw * 180) / Math.PI), (v) => (sp.yaw = (v * Math.PI) / 180), 45));
        }
      }
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = 'Delete (Del)';
      del.addEventListener('click', () => this.deleteSelected());
      rows.push(del);
    } else {
      const help = document.createElement('p');
      help.className = 'hint';
      help.innerHTML =
        'Fly: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, <kbd>Space</kbd> up, <kbd>Shift</kbd> down, hold right mouse to look.<br>' +
        'Pick a tool and click to place. <b>Select</b> and click to edit: arrows and <kbd>PgUp</kbd>/<kbd>PgDn</kbd> move it (hold <kbd>Alt</kbd> to resize a box, <kbd>Shift</kbd> for small steps), <kbd>Del</kbd> deletes, <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes.';
      rows.push(help);
    }
    this.panel.replaceChildren(...rows);
    this.showSelection();
  }
}

// --- markers --------------------------------------------------------------------------------------

const basic = (color: number, opacity = 0.85) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });

function cube(at: Vec3Tuple, size: number, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), basic(color));
  mesh.position.set(...at);
  return mesh;
}

/** A standing figure with an arrow for which way it faces (its feet 1 m below `at`). */
function spawnMarker(at: Vec3Tuple, yaw: number, color: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1, 4, 10), basic(color, 0.6));
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 10), basic(color));
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.2, -0.8);
  g.add(body, arrow);
  g.position.set(...at);
  g.rotation.y = yaw;
  return g;
}

function flagMarker(at: Vec3Tuple, color: number): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6), basic(0xdddddd, 1));
  pole.position.y = 1.3;
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 0.05), basic(color, 1));
  cloth.position.set(0.6, 2.2, 0);
  g.add(pole, cloth);
  g.position.set(...at);
  return g;
}

function ringMarker(at: Vec3Tuple, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(RACE.ringRadius, 0.15, 8, 40), basic(color));
  mesh.position.set(...at);
  return mesh;
}

function hillMarker(at: Vec3Tuple): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(KOTH.radius, KOTH.radius, 0.3, 40);
  const mesh = new THREE.Mesh(geo, basic(0xffffff, 0.25));
  mesh.position.set(at[0], at[1] + 0.15, at[2]);
  return mesh;
}
