import { COMBAT, WEAPONS } from '../shared/config';
import { MAPS } from '../shared/map';
import type { MatchState, ScoreEntry } from '../shared/protocol';
import type { DeathCause } from '../shared/sim';
import type { WeaponId } from '../shared/types';
import { isTyping } from './input';

// Combat HUD: health, weapons, kill feed, death screen and the scoreboard (hold Tab).

const KILL_VERB: Record<DeathCause, string> = {
  rocket: ' rocketed ',
  grenade: ' fragged ',
  hypersonic: ' smoked ',
  javelin: ' javelined ',
  stinger: ' stung ',
  fall: ' knocked off ',
  vehicle: ' blew up ',
  ram: ' ran over ',
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

/** Best first: most kills, then fewest deaths. */
export const rankScores = (scores: readonly ScoreEntry[]) =>
  [...scores].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));

export class Hud {
  private readonly health = el('health');
  private readonly healthValue = el('health-value');
  private readonly healthBar = el('health-bar');
  private readonly feed = el('killfeed');
  private readonly death = el('death');
  private readonly deathTitle = el('death-title');
  private readonly deathTimer = el('death-timer');
  private readonly board = el('scoreboard');
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

  private shownHealth = -1;
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
  boardOpen = false; // Tab held

  constructor(private localId: string) {
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab' || isTyping(e.target) || !document.pointerLockElement) return;
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

  setLocalId(id: string) {
    this.localId = id;
  }

  /** Display names from the latest scores; also returned, for the name tags. */
  setNames(scores: readonly ScoreEntry[]): ReadonlyMap<string, string> {
    for (const s of scores) this.names.set(s.id, s.name);
    return this.names;
  }

  /** Everything per-match goes: called when leaving a game. */
  reset() {
    this.feed.replaceChildren();
    this.medals.replaceChildren();
    this.damageDirs.replaceChildren();
    this.results.hidden = true;
    this.matchBar.hidden = true;
    this.death.hidden = true;
    this.shownMatch = this.shownResults = this.shownBoard = '';
    this.names.clear();
  }

  /** The timer and standings at the top of the screen. */
  setMatch(match: MatchState | null, scores: readonly ScoreEntry[]) {
    if (!match) {
      this.matchBar.hidden = true;
      return;
    }
    const ranked = rankScores(scores);
    const myIndex = ranked.findIndex((s) => s.id === this.localId);
    const me = ranked[myIndex];
    const leader = ranked[0];
    const time = formatTime(match.phase === 'playing' ? match.timeLeft : 0);
    const key = `${time}/${me?.kills}/${myIndex}/${leader?.name}/${leader?.kills}/${ranked[1]?.name}/${ranked[1]?.kills}/${match.fragLimit}`;
    if (key === this.shownMatch) return;
    this.shownMatch = key;
    this.matchBar.hidden = false;
    this.matchTime.textContent = time;
    this.matchTime.classList.toggle('urgent', match.phase === 'playing' && match.timeLeft <= 30);
    this.matchRank.textContent = me ? `${ordinal(myIndex + 1)} · ${me.kills} / ${match.fragLimit}` : '';
    if (leader && leader.id !== this.localId && leader.kills > 0) this.matchLeader.textContent = `Leader: ${leader.name} ${leader.kills}`;
    else if (ranked[1] && leader?.id === this.localId && leader.kills > 0) this.matchLeader.textContent = `Next: ${ranked[1].name} ${ranked[1].kills}`;
    else this.matchLeader.textContent = '';
  }

  /**
   * A medal under the crosshair: `medal` for your achievements, `notice` for match news,
   * `big` for the start of a match. Newer ones replace older ones.
   */
  medal(title: string, sub: string, kind: 'medal' | 'notice' | 'big') {
    const div = document.createElement('div');
    div.className = `medal ${kind}`;
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = title;
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

  /** A line in the kill feed that isn't a kill: sprees, shutdowns. */
  feedNotice(text: string) {
    const row = document.createElement('div');
    row.className = 'notice';
    row.textContent = text;
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
    const show = match?.phase === 'intermission';
    this.results.hidden = !show;
    if (!show || !match) {
      this.shownResults = '';
      return;
    }
    // The server breaks ties; its winner heads the podium.
    const ranked = rankScores(scores);
    const w = ranked.findIndex((s) => s.id === match.winnerId);
    if (w > 0) ranked.unshift(...ranked.splice(w, 1));
    const key = `${match.id}/${Math.ceil(match.timeLeft)}/${JSON.stringify(ranked.map((s) => [s.id, s.kills, s.deaths, s.name]))}`;
    if (key === this.shownResults) return;
    this.shownResults = key;

    const winner = ranked[0];
    const youWon = winner?.id === this.localId && winner.kills > 0;
    const title = el('results-title');
    title.textContent = !winner || winner.kills === 0 ? 'DRAW' : youWon ? 'VICTORY' : `${winner.name.toUpperCase()} WINS`;
    title.classList.toggle('victory', youWon);
    const myPlace = ranked.findIndex((s) => s.id === this.localId);
    el('results-sub').textContent = myPlace >= 0 ? `You placed ${ordinal(myPlace + 1)} of ${ranked.length}` : '';

    el('results-podium').replaceChildren(
      ...ranked.slice(0, 3).map((s, i) => {
        const div = document.createElement('div');
        div.className = `place p${i + 1}${s.id === this.localId ? ' mine' : ''}`;
        const rank = document.createElement('div');
        rank.className = 'rank';
        rank.textContent = ordinal(i + 1);
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = s.name;
        const kills = document.createElement('div');
        kills.className = 'kills';
        kills.textContent = `${s.kills} kill${s.kills === 1 ? '' : 's'}`;
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
    const air = best((s) => s.airshots);
    const streak = best((s) => s.bestStreak);
    const kd = best(kdOf);
    if (air) awards.push(['Sky Hunter', air, `${air.airshots} airshot${air.airshots === 1 ? '' : 's'}`]);
    if (streak) awards.push(['Unstoppable', streak, `${streak.bestStreak} kill streak`]);
    if (kd) awards.push(['Survivor', kd, `${kdOf(kd).toFixed(1)} kills per death`]);
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
    el('results-next').textContent = `Next up: ${mapTitle(match.nextMap)} in ${Math.ceil(match.timeLeft)}`;
  }

  setHealth(value: number) {
    const shown = Math.max(0, Math.ceil(value));
    if (shown === this.shownHealth) return;
    this.shownHealth = shown;
    this.healthValue.textContent = String(shown);
    this.healthBar.style.transform = `scaleX(${shown / COMBAT.maxHealth})`;
    this.health.classList.toggle('low', shown <= 30);
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

  /** Someone's seeker missile is coming for you. */
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

  setMissileWarning(on: boolean) {
    if (on === this.shownWarning) return;
    this.shownWarning = on;
    this.missileWarning.hidden = !on;
  }

  /** Flashes the name of a weapon you just picked up under the crosshair. */
  pickedUp(weapon: WeaponId) {
    this.notice.textContent = WEAPONS[weapon].name;
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
  setDeath(info: { killerId: string | null; cause: DeathCause } | null, respawnIn: number) {
    this.death.hidden = !info;
    this.crosshair.hidden = !!info;
    this.cooldowns.classList.toggle('hidden', !!info);
    if (!info) return;
    const timer = respawnIn > 0 ? `Respawning in ${Math.ceil(respawnIn)}` : 'Respawning…';
    if (timer !== this.shownTimer) this.deathTimer.textContent = this.shownTimer = timer;
    this.deathTitle.textContent = info.killerId
      ? `Killed by ${this.name(info.killerId)}`
      : info.cause === 'fall'
        ? 'You fell'
        : 'You blew yourself up';
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

  /** Only rebuilt while the board is open and the numbers changed. */
  setScores(scores: readonly ScoreEntry[], match: MatchState | null) {
    if (!this.boardOpen) return;
    const sorted = rankScores(scores);
    const title = match ? `${mapTitle(match.map)}  ·  first to ${match.fragLimit}  ·  ${formatTime(match.phase === 'playing' ? match.timeLeft : 0)} left` : '';
    const key = title + JSON.stringify(sorted);
    if (key === this.shownBoard) return;
    this.shownBoard = key;
    this.boardTitle.textContent = title;
    this.boardBody.replaceChildren(
      ...sorted.map((s) => {
        const tr = document.createElement('tr');
        if (s.id === this.localId) tr.classList.add('mine');
        for (const text of [s.name, String(s.kills), String(s.deaths), String(s.airshots), s.bot ? 'bot' : String(s.ping)]) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.append(td);
        }
        return tr;
      }),
    );
  }

  /** What to call a player: "You", or their name. */
  name(id: string): string {
    return id === this.localId ? 'You' : (this.names.get(id) ?? id);
  }

  private nameSpan(id: string): HTMLElement {
    const span = document.createElement('b');
    span.textContent = this.name(id);
    return span;
  }
}
