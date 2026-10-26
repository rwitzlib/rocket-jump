import { COMBAT, MODES, TEAMS, WEAPONS, type GameMode } from '../shared/config';
import { MAPS } from '../shared/map';
import { compareScores, hasScored, type FlagState, type MatchState, type ScoreEntry } from '../shared/protocol';
import type { DeathCause } from '../shared/sim';
import type { WeaponId } from '../shared/types';
import { isTyping } from './input';
import { formatLap } from './objectives';

// Combat HUD: health and armor, weapons, kill feed, death screen and recap, the scoreboard (hold
// Tab), and what each mode adds: team scores, flag status, the race clock, objective markers, and
// a bar saying who you're watching while spectating.

const KILL_VERB: Record<DeathCause, string> = {
  rocket: ' rocketed ',
  grenade: ' fragged ',
  hypersonic: ' smoked ',
  javelin: ' javelined ',
  stinger: ' stung ',
  thunder: ' blew away ',
  fall: ' knocked off ',
  vehicle: ' blew up ',
  ram: ' ran over ',
};
/** What killed you, for the death recap. */
const CAUSE_NAME: Record<DeathCause, string> = {
  rocket: 'Rocket Launcher',
  grenade: 'Grenade Launcher',
  hypersonic: 'Hypersonic',
  javelin: 'Javelin',
  stinger: 'Stinger',
  thunder: 'Thunder Gun',
  fall: 'a long fall',
  vehicle: 'a vehicle blowing up',
  ram: 'a buggy',
};
const NOTICE_TIME = 2000; // ms a pickup notice stays up
// Every setter compares against what's already shown, so calling them each frame is cheap.

const FEED_TIME = 6000; // ms a kill feed entry stays up
const FEED_MAX = 5;

const el = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;

const MEDAL_TIME = 2200; // ms a medal stays up
const DAMAGE_TIME = 1000; // ms a damage direction marker takes to fade

export const mapTitle = (name: string) => MAPS[name]?.title ?? name;

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/** Best first, by what the mode scores. */
/** What wins this mode, for menus and the HUD: "first to 20", "best lap wins". */
export function modeGoal(mode: GameMode, limit: number): string {
  switch (mode) {
    case 'race':
      return 'best lap wins';
    case 'ctf':
      return `first to ${limit} captures`;
    case 'koth':
      return `first to ${limit} s on the hill`;
    case 'elim':
      return `first to ${limit} rounds`;
    default:
      return `first to ${limit}`;
  }
}

export const rankScores = (scores: readonly ScoreEntry[], mode: GameMode = 'ffa') => [...scores].sort(compareScores(mode));

const css = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

/** Everything the death screen shows. */
export interface DeathInfo {
  killerId: string | null;
  cause: DeathCause;
  distance: number;
  killerHealth: number;
  /** Damage you took this life, by who dealt it, most first. */
  damage: { id: string; amount: number }[];
  killcam: boolean; // the killcam is playing: the screen stays clear apart from the recap
}

/** A point of interest drawn over the 3D view: a flag, the next race ring. */
export interface Marker {
  x: number; // CSS pixels
  y: number;
  color: number;
  label: string;
  edge: boolean; // off screen: pinned to the edge, pointing the way
  angle: number; // radians, which way to point when on the edge (0 = up)
}

export class Hud {
  private readonly health = el('health');
  private readonly healthValue = el('health-value');
  private readonly healthBar = el('health-bar');
  private readonly armorValue = el('armor-value');
  private readonly overdriveEl = el('overdrive');
  private readonly feed = el('killfeed');
  private readonly death = el('death');
  private readonly deathTitle = el('death-title');
  private readonly deathTimer = el('death-timer');
  private readonly deathRecap = el('death-recap');
  private readonly killcamLabel = el('killcam-label');
  private shownRecap = '';
  private readonly board = el('scoreboard');
  private readonly boardHead = el<HTMLTableSectionElement>('scoreboard-head');
  private readonly boardBody = el<HTMLTableSectionElement>('scoreboard-body');
  private readonly crosshair = el('crosshair');
  private readonly cooldowns = document.querySelector<SVGSVGElement>('#cooldowns')!;
  private readonly rocketArc = document.querySelector<SVGPathElement>('#cd-rocket')!;
  private readonly grappleArc = document.querySelector<SVGPathElement>('#cd-grapple')!;
  private readonly shownCharge = { rocket: -1, grapple: -1 };
  private readonly primaryName = el('weapon-primary');
  private readonly secondaryName = el('weapon-secondary');
  private readonly ammo = el('weapon-ammo');
  private readonly lockBox = el('lock-box');
  private readonly lockFill = el('lock-fill');
  private readonly lockMarker = el('lock-marker');
  private readonly missileWarning = el('missile-warning');
  private shownLock = '';
  private shownWarning = false;
  private readonly notice = el('pickup-notice');
  private noticeTimer = 0;
  private shownWeapons = '';
  private readonly prompt = el('prompt');
  private shownPrompt = '';
  private readonly vehicle = el('vehicle-status');
  private readonly vehicleName = el('vehicle-name');
  private readonly vehicleBar = el('vehicle-bar');
  private shownVehicle = '';
  private readonly flagBar = el('flag-status');
  private shownFlags = '';
  private readonly race = el('race');
  private readonly raceLap = el('race-lap');
  private readonly raceInfo = el('race-info');
  private shownRace = '';
  private readonly markers = el('markers');
  private shownMarkers = '';
  private readonly spectating = el('spectating');
  private readonly spectatingName = el('spectating-name');
  private shownSpectating: string | null = null;

  private shownHealth = '';
  private shownProtected = false;
  private shownTimer = '';
  private shownBoard = '';
  private readonly boardTitle = el('scoreboard-title');
  private readonly matchBar = el('match-bar');
  private readonly matchTime = el('match-time');
  private readonly matchRank = el('match-rank');
  private readonly matchLeader = el('match-leader');
  private shownMatch = '';
  private readonly medals = el('medals');
  private readonly damageDirs = el('damage-dirs');
  private readonly results = el('results');
  private shownResults = '';
  private readonly names = new Map<string, string>();
  private readonly teams = new Map<string, number>();
  boardOpen = false; // Tab held
  private readonly xpBox = el('xp-gain');
  private highlightOn = false;
  /** The results wait for a replay that's about to start. */
  holdResults = false;
  private xpTotal = 0;
  /** Whether the game has the keyboard (the mouse captured, or playing without it): Tab opens the board only then. */
  isPlaying: () => boolean = () => !!document.pointerLockElement;

  constructor(private localId: string) {
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab' || isTyping(e.target) || !this.isPlaying()) return;
      e.preventDefault(); // keep focus (and pointer lock) on the game
      this.boardOpen = true;
      this.board.hidden = false;
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Tab') return;
      this.boardOpen = false;
      this.board.hidden = true;
    });
  }

  /** "+25 XP Kill" in the corner, adding up while they come in quick succession. */
  xpGained(amount: number, why: string) {
    const box = this.xpBox;
    this.xpTotal = box.classList.contains('show') ? this.xpTotal + amount : amount;
    box.textContent = `+${this.xpTotal} XP${why ? `  ${why}` : ''}`;
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
  }

  /** The banner over the play of the match; null hides it (and lets the results show). */
  setHighlight(text: string | null) {
    this.highlightOn = text !== null;
    const label = el('highlight-label');
    label.hidden = text === null;
    if (text) label.textContent = text;
  }

  /** Shows or hides the scoreboard (Tab does this by itself; this is for the gamepad and touch). */
  showBoard(on: boolean) {
    this.boardOpen = on;
    this.board.hidden = !on;
  }

  setLocalId(id: string) {
    this.localId = id;
  }

  /** Display names (and teams) from the latest scores; the names are also returned, for the name tags. */
  setNames(scores: readonly ScoreEntry[]): ReadonlyMap<string, string> {
    for (const s of scores) {
      this.names.set(s.id, s.name);
      this.teams.set(s.id, s.team);
    }
    return this.names;
  }

  /** Everything per-match goes: called when leaving a game. */
  reset() {
    this.feed.replaceChildren();
    this.medals.replaceChildren();
    this.damageDirs.replaceChildren();
    this.markers.replaceChildren();
    this.results.hidden = true;
    this.matchBar.hidden = true;
    this.death.hidden = true;
    this.flagBar.hidden = true;
    this.race.hidden = true;
    this.spectating.hidden = true;
    el('hud').classList.remove('watching');
    this.shownMatch = this.shownResults = this.shownBoard = this.shownFlags = this.shownRace = this.shownMarkers = this.shownRecap = '';
    this.shownSpectating = null;
    this.names.clear();
    this.teams.clear();
  }

  /** The timer and standings at the top of the screen: your place in deathmatch, the team scores in team modes, the best laps in a race. */
  setMatch(match: MatchState | null, scores: readonly ScoreEntry[]) {
    if (!match) {
      this.matchBar.hidden = true;
      return;
    }
    // Elimination counts the round down, then the wait for the next one.
    const time =
      match.mode === 'elim' && match.phase === 'playing'
        ? match.roundLeft > 0
          ? `R${match.round} ${formatTime(match.roundLeft)}`
          : `Next round ${Math.ceil(-match.roundLeft)}`
        : formatTime(match.phase === 'playing' ? match.timeLeft : 0);
    const ranked = rankScores(scores, match.mode);
    const myIndex = ranked.findIndex((s) => s.id === this.localId);
    const me = ranked[myIndex];
    let left = '';
    let right = '';
    let leftClass = '';
    let rightClass = '';
    if (MODES[match.mode].teams) {
      const [red, blue] = match.teamScores;
      left = `${TEAMS[0].name.toUpperCase()} ${red}`;
      right = `${blue} ${TEAMS[1].name.toUpperCase()}`;
      leftClass = `team red${me?.team === 0 ? ' mine' : ''}`;
      rightClass = `team blue${me?.team === 1 ? ' mine' : ''}`;
    } else if (match.mode === 'race') {
      const leader = ranked[0];
      left = me?.bestLap ? `Best ${formatLap(me.bestLap)}` : 'No lap yet';
      if (leader?.bestLap && leader.id !== this.localId) right = `Record: ${leader.name} ${formatLap(leader.bestLap)}`;
      else if (leader?.bestLap) right = 'You hold the record';
    } else if (match.mode === 'koth') {
      const leader = ranked[0];
      left = me ? `${ordinal(myIndex + 1)} · ${me.points} / ${match.scoreLimit} s` : '';
      if (leader && leader.id !== this.localId && leader.points > 0) right = `Leader: ${leader.name} ${leader.points} s`;
      else if (ranked[1] && leader?.id === this.localId && leader.points > 0) right = `Next: ${ranked[1].name} ${ranked[1].points} s`;
    } else {
      const leader = ranked[0];
      left = me ? `${ordinal(myIndex + 1)} · ${me.kills} / ${match.scoreLimit}` : '';
      if (leader && leader.id !== this.localId && leader.kills > 0) right = `Leader: ${leader.name} ${leader.kills}`;
      else if (ranked[1] && leader?.id === this.localId && leader.kills > 0) right = `Next: ${ranked[1].name} ${ranked[1].kills}`;
    }
    const key = `${time}/${left}/${right}/${leftClass}/${rightClass}`;
    if (key === this.shownMatch) return;
    this.shownMatch = key;
    this.matchBar.hidden = false;
    this.matchTime.textContent = time;
    this.matchTime.classList.toggle('urgent', match.phase === 'playing' && match.timeLeft <= 30);
    this.matchRank.textContent = left;
    this.matchRank.className = leftClass;
    this.matchLeader.textContent = right;
    this.matchLeader.className = rightClass;
  }

  /**
   * Capture the flag: each flag's state under the match bar. `localTeam` -1 when watching.
   * Pass null outside capture the flag.
   */
  setFlags(flags: readonly FlagState[] | null, localTeam: number) {
    if (!flags || flags.length < 2) {
      if (!this.flagBar.hidden) this.flagBar.hidden = true;
      this.shownFlags = '';
      return;
    }
    const status = flags.map((f) => {
      if (f.atHome) return ['home', 'Home'];
      if (f.carrier) return ['taken', f.carrier === this.localId ? 'You have it' : `${this.name(f.carrier)} has it`];
      return ['dropped', 'Dropped'];
    });
    const key = JSON.stringify(status) + localTeam;
    if (key === this.shownFlags) return;
    this.shownFlags = key;
    this.flagBar.hidden = false;
    this.flagBar.replaceChildren(
      ...status.map(([state, text], team) => {
        const div = document.createElement('div');
        div.className = `flag ${team === 0 ? 'red' : 'blue'} ${state}${team === localTeam ? ' mine' : ''}`;
        const icon = document.createElement('span');
        icon.className = 'icon';
        const label = document.createElement('span');
        label.textContent = `${team === localTeam ? 'Your flag' : `${TEAMS[team].name} flag`}: ${text}`;
        div.append(icon, label);
        return div;
      }),
    );
  }

  /** The race clock and progress. Null outside a race (or with nothing to show). */
  setRace(race: { lapTime: number; ring: number; rings: number; best: number } | null) {
    if (!race) {
      if (!this.race.hidden) this.race.hidden = true;
      this.shownRace = '';
      return;
    }
    const lap = race.lapTime >= 0 ? formatLap(race.lapTime) : 'Through the start gate';
    const info = race.lapTime >= 0 ? `Ring ${race.ring === 0 ? race.rings : race.ring} of ${race.rings}${race.ring === 0 ? ' · finish' : ''}` : 'E restarts';
    const key = `${lap}/${info}`;
    if (key === this.shownRace) return;
    this.shownRace = key;
    this.race.hidden = false;
    this.raceLap.textContent = lap;
    this.raceLap.classList.toggle('waiting', race.lapTime < 0);
    this.raceInfo.textContent = info;
  }

  /** Points of interest over the view: flags, the next race ring. Rebuilt only when they visibly move. */
  setMarkers(markers: readonly Marker[]) {
    const key = markers.map((m) => `${Math.round(m.x / 2)},${Math.round(m.y / 2)},${m.label},${m.edge},${m.color}`).join('|');
    if (key === this.shownMarkers) return;
    this.shownMarkers = key;
    while (this.markers.childElementCount > markers.length) this.markers.lastElementChild!.remove();
    while (this.markers.childElementCount < markers.length) {
      const div = document.createElement('div');
      div.className = 'marker';
      div.append(document.createElement('i'), document.createElement('span'));
      this.markers.append(div);
    }
    markers.forEach((m, i) => {
      const div = this.markers.children[i] as HTMLElement;
      div.style.left = `${Math.round(m.x)}px`;
      div.style.top = `${Math.round(m.y)}px`;
      div.style.setProperty('--color', css(m.color));
      div.style.setProperty('--angle', `${m.angle}rad`);
      div.classList.toggle('edge', m.edge);
      div.lastElementChild!.textContent = m.label;
    });
  }

  /** "Watching NAME": null while playing. Watching hides your own health, weapons and crosshair. */
  setSpectating(text: string | null) {
    if (text === this.shownSpectating) return;
    this.shownSpectating = text;
    this.spectating.hidden = text === null;
    el('hud').classList.toggle('watching', text !== null);
    if (text !== null) this.spectatingName.textContent = text;
  }

  /**
   * A medal under the crosshair: `medal` for your achievements, `notice` for match news,
   * `big` for the start of a match. Newer ones replace older ones.
   */
  medal(title: string, sub: string, kind: 'medal' | 'notice' | 'big', color?: number) {
    const div = document.createElement('div');
    div.className = `medal ${kind}`;
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = title;
    if (color !== undefined) t.style.color = css(color);
    div.append(t);
    if (sub) {
      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = sub;
      div.append(s);
    }
    this.medals.replaceChildren(div);
    setTimeout(() => div.remove(), MEDAL_TIME);
  }

  /** A line in the kill feed that isn't a kill: sprees, shutdowns, flag news. */
  feedNotice(text: string, color?: number) {
    const row = document.createElement('div');
    row.className = 'notice';
    row.textContent = text;
    if (color !== undefined) row.style.borderLeft = `3px solid ${css(color)}`;
    this.feed.prepend(row);
    while (this.feed.childElementCount > FEED_MAX) this.feed.lastElementChild!.remove();
    setTimeout(() => row.remove(), FEED_TIME);
  }

  /** A red arc toward whoever just hurt you. `angle`: radians clockwise from straight ahead. */
  damageFrom(angle: number, amount: number) {
    const arc = document.createElement('div');
    arc.className = 'damage-dir';
    arc.style.rotate = `${angle}rad`;
    arc.style.setProperty('--strength', String(Math.min(1, 0.4 + amount / 80)));
    this.damageDirs.append(arc);
    while (this.damageDirs.childElementCount > 4) this.damageDirs.firstElementChild!.remove();
    setTimeout(() => arc.remove(), DAMAGE_TIME);
  }

  /** The results screen between matches; hidden otherwise. */
  setResults(match: MatchState | null, scores: readonly ScoreEntry[]) {
    // (held back while the final kill and the play of the match are showing)
    const show = match?.phase === 'intermission' && !this.highlightOn && !this.holdResults;
    this.results.hidden = !show;
    if (!show || !match) {
      this.shownResults = '';
      return;
    }
    const mode = match.mode;
    const teams = MODES[mode].teams;
    // The server breaks ties; its winner heads the podium.
    const ranked = rankScores(scores, mode);
    const w = ranked.findIndex((s) => s.id === match.winnerId);
    if (w > 0) ranked.unshift(...ranked.splice(w, 1));
    const key = `${match.id}/${Math.ceil(match.timeLeft)}/${JSON.stringify(ranked.map((s) => [s.id, s.kills, s.deaths, s.name, s.captures, s.bestLap]))}`;
    if (key === this.shownResults) return;
    this.shownResults = key;

    const winner = ranked[0];
    const myTeam = scores.find((s) => s.id === this.localId)?.team ?? -1;
    const title = el('results-title');
    let youWon: boolean;
    if (teams) {
      youWon = match.winnerTeam >= 0 && match.winnerTeam === myTeam;
      title.textContent = match.winnerTeam < 0 ? 'DRAW' : youWon ? 'VICTORY' : `${TEAMS[match.winnerTeam].name.toUpperCase()} WINS`;
      title.style.color = match.winnerTeam >= 0 && !youWon ? css(TEAMS[match.winnerTeam].color) : '';
    } else {
      youWon = winner?.id === this.localId && hasScored(mode, winner);
      title.textContent = !winner || !hasScored(mode, winner) ? (mode === 'race' ? 'NO LAPS' : 'DRAW') : youWon ? 'VICTORY' : `${winner.name.toUpperCase()} WINS`;
      title.style.color = '';
    }
    title.classList.toggle('victory', youWon);
    const myPlace = ranked.findIndex((s) => s.id === this.localId);
    const placed = myPlace >= 0 ? `You placed ${ordinal(myPlace + 1)} of ${ranked.length}` : '';
    el('results-sub').textContent = teams ? `${TEAMS[0].name} ${match.teamScores[0]} – ${match.teamScores[1]} ${TEAMS[1].name}${placed ? ` · ${placed}` : ''}` : placed;

    const scoreText = (s: ScoreEntry) =>
      mode === 'race'
        ? s.bestLap
          ? formatLap(s.bestLap)
          : 'no lap'
        : mode === 'ctf'
          ? `${s.captures} cap${s.captures === 1 ? '' : 's'} · ${s.kills} kills`
          : mode === 'koth'
            ? `${s.points} s on the hill · ${s.kills} kills`
            : `${s.kills} kill${s.kills === 1 ? '' : 's'}`;
    el('results-podium').replaceChildren(
      ...ranked.slice(0, 3).map((s, i) => {
        const div = document.createElement('div');
        div.className = `place p${i + 1}${s.id === this.localId ? ' mine' : ''}`;
        if (s.team >= 0) div.style.borderTopColor = css(TEAMS[s.team].color);
        const rank = document.createElement('div');
        rank.className = 'rank';
        rank.textContent = ordinal(i + 1);
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = s.name;
        const kills = document.createElement('div');
        kills.className = 'kills';
        kills.textContent = scoreText(s);
        div.append(rank, name, kills);
        return div;
      }),
    );

    // Awards for what this game is about: airshots, streaks, staying alive.
    const best = (score: (s: ScoreEntry) => number) => {
      let top: ScoreEntry | undefined;
      for (const s of ranked) if (score(s) > 0 && (!top || score(s) > score(top))) top = s;
      return top;
    };
    const kdOf = (s: ScoreEntry) => (s.kills >= 3 ? s.kills / Math.max(1, s.deaths) : 0);
    const awards: [string, ScoreEntry | undefined, string][] = [];
    if (mode !== 'race') {
      const air = best((s) => s.airshots);
      const streak = best((s) => s.bestStreak);
      const kd = best(kdOf);
      if (air) awards.push(['Sky Hunter', air, `${air.airshots} airshot${air.airshots === 1 ? '' : 's'}`]);
      if (streak) awards.push(['Unstoppable', streak, `${streak.bestStreak} kill streak`]);
      if (kd) awards.push(['Survivor', kd, `${kdOf(kd).toFixed(1)} kills per death`]);
    }
    el('results-awards').replaceChildren(
      ...awards.map(([name, s, what]) => {
        const div = document.createElement('div');
        div.className = `award${s?.id === this.localId ? ' mine' : ''}`;
        const t = document.createElement('div');
        t.className = 'award-title';
        t.textContent = name;
        const n = document.createElement('div');
        n.textContent = `${s?.name} · ${what}`;
        div.append(t, n);
        return div;
      }),
    );
    const next = match.nextMode === match.mode && match.nextMap === match.map ? mapTitle(match.nextMap) : `${MODES[match.nextMode].name} on ${mapTitle(match.nextMap)}`;
    el('results-next').textContent = `Next up: ${next} in ${Math.ceil(match.timeLeft)}`;
  }

  /** Health (over 100 from health packs shows gold), armor, and the overdrive's time left. */
  setHealth(value: number, armor = 0, overdrive = 0) {
    const shown = Math.max(0, Math.ceil(value));
    const shownArmor = Math.ceil(armor);
    const shownOverdrive = Math.ceil(overdrive);
    const key = `${shown}/${shownArmor}/${shownOverdrive}`;
    if (key === this.shownHealth) return;
    this.shownHealth = key;
    this.healthValue.textContent = String(shown);
    this.healthBar.style.transform = `scaleX(${Math.min(1, shown / COMBAT.maxHealth)})`;
    this.health.classList.toggle('low', shown <= 30);
    this.health.classList.toggle('over', shown > COMBAT.maxHealth);
    this.armorValue.hidden = shownArmor <= 0;
    this.armorValue.textContent = String(shownArmor);
    this.overdriveEl.hidden = shownOverdrive <= 0;
    this.overdriveEl.textContent = `OVERDRIVE ${shownOverdrive}`;
  }

  setProtected(on: boolean) {
    if (on === this.shownProtected) return;
    this.shownProtected = on;
    this.health.classList.toggle('protected', on);
  }

  /**
   * `status`: shown after the primary's name (ammo, reloading, lock state); `alert` colors it as a
   * warning. `stowed`: the primary is two-handed, so the secondary can't be used.
   */
  setWeapons(primary: string, secondary: string, status: string, alert: boolean, stowed: boolean) {
    const key = `${primary}/${secondary}/${status}/${alert}/${stowed}`;
    if (key === this.shownWeapons) return;
    this.shownWeapons = key;
    this.primaryName.textContent = primary;
    this.secondaryName.textContent = secondary + (stowed ? ' (stowed)' : '');
    this.secondaryName.parentElement!.classList.toggle('stowed', stowed);
    this.ammo.textContent = status;
    this.ammo.classList.toggle('reloading', alert);
  }

  /**
   * The seeker lock box around the crosshair (half sizes in CSS pixels), how full the lock is (0..1),
   * and a marker on the target, in CSS pixels. Pass null when no seeker is in hand.
   */
  setLock(lock: { halfWidth: number; halfHeight: number; progress: number; locked: boolean; marker: { x: number; y: number } | null } | null) {
    const key = lock
      ? [Math.round(lock.halfWidth), Math.round(lock.halfHeight), Math.round(lock.progress * 50), lock.locked, lock.marker ? `${Math.round(lock.marker.x)},${Math.round(lock.marker.y)}` : ''].join('/')
      : '';
    if (key === this.shownLock) return;
    this.shownLock = key;
    this.lockBox.hidden = !lock;
    this.lockMarker.hidden = !lock?.marker;
    if (!lock) return;
    const box = this.lockBox.style;
    box.width = `${Math.round(lock.halfWidth * 2)}px`;
    box.height = `${Math.round(lock.halfHeight * 2)}px`;
    box.margin = `${-Math.round(lock.halfHeight)}px 0 0 ${-Math.round(lock.halfWidth)}px`;
    this.lockBox.classList.toggle('locking', lock.progress > 0 && !lock.locked);
    this.lockBox.classList.toggle('locked', lock.locked);
    this.lockFill.style.transform = `scaleX(${Math.round(lock.progress * 50) / 50})`;
    this.lockMarker.classList.toggle('locked', lock.locked);
    if (lock.marker) {
      this.lockMarker.style.left = `${Math.round(lock.marker.x)}px`;
      this.lockMarker.style.top = `${Math.round(lock.marker.y)}px`;
    }
  }

  /** A key hint under the crosshair, like "E  Drive Buggy". Null hides it. */
  setPrompt(key: string | null, action = '') {
    const shown = key ? `${key}/${action}` : '';
    if (shown === this.shownPrompt) return;
    this.shownPrompt = shown;
    this.prompt.hidden = !key;
    if (!key) return;
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    this.prompt.replaceChildren(kbd, action);
  }

  /** The vehicle you're in and its health. Null on foot. */
  setVehicle(vehicle: { name: string; health: number; maxHealth: number } | null) {
    const shown = vehicle ? `${vehicle.name}/${Math.ceil(vehicle.health)}` : '';
    if (shown === this.shownVehicle) return;
    this.shownVehicle = shown;
    this.vehicle.hidden = !vehicle;
    if (!vehicle) return;
    const frac = Math.max(0, vehicle.health) / vehicle.maxHealth;
    this.vehicleName.textContent = `${vehicle.name}  ${Math.max(0, Math.ceil(vehicle.health))}`;
    this.vehicleBar.style.transform = `scaleX(${frac})`;
    this.vehicle.classList.toggle('low', frac <= 0.3);
  }

  /** Someone's seeker missile is coming for you. */
  setMissileWarning(on: boolean) {
    if (on === this.shownWarning) return;
    this.shownWarning = on;
    this.missileWarning.hidden = !on;
  }

  /** Flashes a line under the crosshair: the name of a weapon you just picked up, or an item. */
  pickedUp(what: WeaponId | string) {
    this.notice.textContent = what in WEAPONS ? WEAPONS[what as WeaponId].name : what;
    this.notice.classList.remove('show');
    void this.notice.offsetWidth; // restart the CSS animation
    this.notice.classList.add('show');
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.notice.classList.remove('show'), NOTICE_TIME);
  }

  /** How charged each weapon is, 0 (just used) to 1 (ready): the primary on the right, the grapple on the left. */
  setCooldowns(rocket: number, grapple: number) {
    this.setArc(this.rocketArc, 'rocket', rocket);
    this.setArc(this.grappleArc, 'grapple', grapple);
  }

  private setArc(arc: SVGPathElement, key: 'rocket' | 'grapple', charge: number) {
    const shown = Math.round(Math.min(Math.max(charge, 0), 1) * 50) / 50;
    if (shown === this.shownCharge[key]) return;
    this.shownCharge[key] = shown;
    arc.style.strokeDasharray = `${shown} 1`;
    arc.classList.toggle('ready', shown === 1);
  }

  /** Pass null while alive. */
  setDeath(info: DeathInfo | null, respawnIn: number) {
    this.death.hidden = !info;
    this.crosshair.hidden = !!info;
    this.cooldowns.classList.toggle('hidden', !!info);
    if (!info) return;
    this.death.classList.toggle('killcam', info.killcam);
    this.killcamLabel.hidden = !info.killcam;
    const timer = respawnIn > 1000 ? 'Out until the next round' : respawnIn > 0 ? `Respawning in ${Math.ceil(respawnIn)}` : 'Respawning…';
    if (timer !== this.shownTimer) this.deathTimer.textContent = this.shownTimer = timer;
    this.deathTitle.textContent = info.killerId
      ? `Killed by ${this.name(info.killerId)}`
      : info.cause === 'fall'
        ? 'You fell'
        : 'You blew yourself up';
    // The recap: what did it, from how far, how the killer was doing, and who else hurt you.
    const lines: string[] = [];
    if (info.killerId) {
      lines.push(`${CAUSE_NAME[info.cause]}${info.distance > 1 ? ` from ${Math.round(info.distance)} m` : ''}`);
      lines.push(`${this.name(info.killerId)} had ${info.killerHealth} health left`);
    }
    const others = info.damage.filter((d) => d.amount > 0);
    if (others.length) lines.push(`Damage taken: ${others.map((d) => `${this.name(d.id)} ${Math.round(d.amount)}`).join(' · ')}`);
    const key = lines.join('\n');
    if (key === this.shownRecap) return;
    this.shownRecap = key;
    this.deathRecap.replaceChildren(
      ...lines.map((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        return div;
      }),
    );
  }

  killed(victimId: string, killerId: string | null, cause: DeathCause) {
    const row = document.createElement('div');
    const victim = this.nameSpan(victimId);
    if (killerId) {
      row.append(this.nameSpan(killerId), KILL_VERB[cause], victim);
    } else {
      row.append(victim, cause === 'fall' ? ' fell' : ' blew up');
    }
    if (victimId === this.localId || killerId === this.localId) row.classList.add('mine');
    this.feed.prepend(row);
    while (this.feed.childElementCount > FEED_MAX) this.feed.lastElementChild!.remove();
    setTimeout(() => row.remove(), FEED_TIME);
  }

  hitMarker(kill: boolean) {
    const c = this.crosshair;
    c.classList.remove('hit', 'kill');
    void c.offsetWidth; // restart the CSS animation
    c.classList.add(kill ? 'kill' : 'hit');
  }

  /** Only rebuilt while the board is open and the numbers changed. Team modes split it by team. */
  setScores(scores: readonly ScoreEntry[], match: MatchState | null) {
    if (!this.boardOpen) return;
    const mode = match?.mode ?? 'ffa';
    const sorted = rankScores(scores, mode);
    const goal = !match ? '' : modeGoal(mode, match.scoreLimit);
    const title = match ? `${MODES[mode].name}  ·  ${mapTitle(match.map)}  ·  ${goal}  ·  ${formatTime(match.phase === 'playing' ? match.timeLeft : 0)} left` : '';
    const key = title + JSON.stringify(sorted) + JSON.stringify(match?.teamScores);
    if (key === this.shownBoard) return;
    this.shownBoard = key;
    this.boardTitle.textContent = title;

    const columns: [string, (s: ScoreEntry) => string][] =
      mode === 'race'
        ? [['Best lap', (s) => (s.bestLap ? formatLap(s.bestLap) : '–')]]
        : mode === 'ctf'
          ? [['Caps', (s) => String(s.captures)], ['Kills', (s) => String(s.kills)], ['Deaths', (s) => String(s.deaths)]]
          : mode === 'koth'
            ? [['Hill', (s) => `${s.points} s`], ['Kills', (s) => String(s.kills)], ['Deaths', (s) => String(s.deaths)]]
            : [['Kills', (s) => String(s.kills)], ['Deaths', (s) => String(s.deaths)], ['Air', (s) => String(s.airshots)]];
    const head = document.createElement('tr');
    for (const text of ['Player', ...columns.map(([name]) => name), 'Ping']) {
      const th = document.createElement('th');
      th.textContent = text;
      head.append(th);
    }
    this.boardHead.replaceChildren(head);

    const row = (s: ScoreEntry) => {
      const tr = document.createElement('tr');
      if (s.id === this.localId) tr.classList.add('mine');
      for (const text of [s.name, ...columns.map(([, value]) => value(s)), s.bot ? 'bot' : String(s.ping)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    };
    if (!MODES[mode].teams) {
      this.boardBody.replaceChildren(...sorted.map(row));
      return;
    }
    const rows: HTMLTableRowElement[] = [];
    TEAMS.forEach((team, t) => {
      const header = document.createElement('tr');
      header.className = 'team-row';
      header.style.setProperty('--team', css(team.color));
      const name = document.createElement('td');
      name.textContent = team.name;
      const score = document.createElement('td');
      score.colSpan = columns.length + 1;
      score.textContent = String(match?.teamScores[t] ?? 0);
      header.append(name, score);
      rows.push(header, ...sorted.filter((s) => s.team === t).map(row));
    });
    this.boardBody.replaceChildren(...rows);
  }

  /** What to call a player: "You", or their name. */
  name(id: string): string {
    return id === this.localId ? 'You' : (this.names.get(id) ?? id);
  }

  /** A name for the kill feed, in its team's color in team modes. */
  private nameSpan(id: string): HTMLElement {
    const span = document.createElement('b');
    span.textContent = this.name(id);
    const team = this.teams.get(id) ?? -1;
    if (team >= 0) span.style.color = css(TEAMS[team].color);
    return span;
  }
}
