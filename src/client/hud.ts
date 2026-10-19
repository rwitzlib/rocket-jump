import { COMBAT, WEAPONS } from '../shared/config';
import type { ScoreEntry } from '../shared/protocol';
import type { DeathCause } from '../shared/sim';
import type { WeaponId } from '../shared/types';

// Combat HUD: health, weapons, kill feed, death screen and the scoreboard (hold Tab).

const KILL_VERB: Record<DeathCause, string> = {
  rocket: ' rocketed ',
  grenade: ' fragged ',
  hypersonic: ' smoked ',
  javelin: ' javelined ',
  stinger: ' stung ',
  fall: ' knocked off ',
};
const NOTICE_TIME = 2000; // ms a pickup notice stays up
// Every setter compares against what's already shown, so calling them each frame is cheap.

const FEED_TIME = 6000; // ms a kill feed entry stays up
const FEED_MAX = 5;

const el = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;

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

  private shownHealth = -1;
  private shownProtected = false;
  private shownTimer = '';
  private shownBoard = '';
  boardOpen = false; // Tab held

  constructor(private readonly localId: string) {
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab') return;
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
  setWeapons(primary: WeaponId, secondary: WeaponId, status: string, alert: boolean, stowed: boolean) {
    const key = `${primary}/${secondary}/${status}/${alert}/${stowed}`;
    if (key === this.shownWeapons) return;
    this.shownWeapons = key;
    this.primaryName.textContent = WEAPONS[primary].name;
    this.secondaryName.textContent = WEAPONS[secondary].name + (stowed ? ' (stowed)' : '');
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
  setScores(scores: readonly ScoreEntry[]) {
    if (!this.boardOpen) return;
    const sorted = [...scores].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id.localeCompare(b.id));
    const key = JSON.stringify(sorted);
    if (key === this.shownBoard) return;
    this.shownBoard = key;
    this.boardBody.replaceChildren(
      ...sorted.map((s) => {
        const tr = document.createElement('tr');
        if (s.id === this.localId) tr.classList.add('mine');
        for (const text of [this.name(s.id), String(s.kills), String(s.deaths)]) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.append(td);
        }
        return tr;
      }),
    );
  }

  private name(id: string): string {
    return id === this.localId ? 'You' : id;
  }

  private nameSpan(id: string): HTMLElement {
    const span = document.createElement('b');
    span.textContent = this.name(id);
    return span;
  }
}
