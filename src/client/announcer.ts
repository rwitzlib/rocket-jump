import { MATCH, MODES, TEAMS } from '../shared/config';
import type { MatchState, ScoreEntry } from '../shared/protocol';
import type { DeathCause, FlagAction } from '../shared/sim';
import type { GameAudio } from './audio';
import type { Hud } from './hud';

// The announcer: medals for you (airshots, multi kills, sprees, revenge, shutdowns), lines in the
// kill feed when anyone goes on a spree, and match beats like taking the lead or a minute left.
// Arena shooters live on this feedback: it tells you that the hard shot you just landed mattered.
// Everything is worked out here from the kill events and scores every client already receives.

const MULTI = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'MEGA KILL', 'ULTRA KILL', 'MONSTER KILL'];
const SPREES: Record<number, string> = { 5: 'KILLING SPREE', 10: 'RAMPAGE', 15: 'DOMINATING', 20: 'UNSTOPPABLE', 25: 'GODLIKE' };
const SPREE_FEED: Record<number, string> = { 5: 'is on a killing spree', 10: 'is on a rampage', 15: 'is dominating', 20: 'is unstoppable', 25: 'is godlike' };

interface Tally {
  streak: number;
  multi: number;
  lastKill: number; // seconds, announcer clock
}

export class Announcer {
  private readonly tallies = new Map<string, Tally>();
  private clock = 0;
  private matchId = -1;
  private firstBlood = false;
  private lastKiller: string | null = null; // who last killed us, for REVENGE
  private rank = 0; // 1 = leading, 0 = not ranked yet
  private warnedMinute = false;
  private warnedFrags = Infinity;
  private teamLead = -2; // which team leads: -1 tied, -2 not known yet

  constructor(
    private readonly hud: Hud,
    private readonly audio: GameAudio,
    private localId: string,
  ) {}

  setLocalId(id: string) {
    this.localId = id;
  }

  private tally(id: string): Tally {
    let t = this.tallies.get(id);
    if (!t) this.tallies.set(id, (t = { streak: 0, multi: 0, lastKill: -Infinity }));
    return t;
  }

  update(dt: number, match: MatchState | null, scores: readonly ScoreEntry[]) {
    this.clock += dt;
    if (!match) return;
    if (match.id !== this.matchId) {
      // A new match: everyone starts from nothing.
      const first = this.matchId === -1;
      this.matchId = match.id;
      this.tallies.clear();
      this.firstBlood = first ? scores.some((s) => s.kills > 0) : false;
      this.lastKiller = null;
      this.rank = 0;
      this.warnedMinute = match.timeLeft <= 60;
      this.warnedFrags = Infinity;
      this.teamLead = -2;
      if (!first && match.phase === 'playing') {
        const goal =
          match.mode === 'race' ? 'Best lap wins' : match.mode === 'ctf' ? `First to ${match.scoreLimit} captures` : `First to ${match.scoreLimit}`;
        this.hud.medal(match.mode === 'race' ? 'GO!' : 'FIGHT!', `${MODES[match.mode].name} · ${goal}`, 'big');
      }
    }
    if (match.phase !== 'playing') return;

    if (!this.warnedMinute && match.timeLeft <= 60) {
      this.warnedMinute = true;
      this.hud.medal('1 MINUTE LEFT', '', 'notice');
      this.audio.play('lead', { volume: 0.4, rate: 0.8 });
    }

    if (match.mode === 'race') return;
    if (MODES[match.mode].teams) {
      this.teamUpdate(match, scores);
      return;
    }
    const sorted = [...scores].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const top = sorted[0]?.kills ?? 0;
    const left = match.scoreLimit - top;
    if (top > 0 && left <= 3 && left > 0 && left < this.warnedFrags) {
      this.warnedFrags = left;
      this.hud.medal(left === 1 ? '1 FRAG LEFT' : `${left} FRAGS LEFT`, '', 'notice');
      this.audio.play('lead', { volume: 0.4, rate: 0.8 });
    }

    // Lead changes, Quake style. Nobody leads until someone has a kill.
    const mine = scores.find((s) => s.id === this.localId);
    if (!mine || top === 0) return;
    const ahead = scores.filter((s) => s.kills > mine.kills).length;
    const tied = scores.filter((s) => s.id !== this.localId && s.kills === mine.kills).length;
    const rank = ahead === 0 ? (tied ? 1.5 : 1) : ahead + 1;
    if (rank !== this.rank) {
      if (rank === 1) {
        this.hud.medal('YOU TOOK THE LEAD', '', 'notice');
        this.audio.play('lead', { volume: 0.6 });
      } else if (rank === 1.5 && this.rank !== 0) {
        this.hud.medal('TIED FOR THE LEAD', '', 'notice');
        this.audio.play('lead', { volume: 0.5, rate: 0.9 });
      } else if ((this.rank === 1 || this.rank === 1.5) && rank > 1.5) {
        this.hud.medal('YOU LOST THE LEAD', '', 'notice');
        this.audio.play('lostLead', { volume: 0.6 });
      }
      this.rank = rank;
    }
  }

  /** Team modes: which team leads, and how close the leader is to winning. */
  private teamUpdate(match: MatchState, scores: readonly ScoreEntry[]) {
    const [red, blue] = match.teamScores;
    const mine = scores.find((s) => s.id === this.localId)?.team ?? -1;
    const top = Math.max(red, blue);
    const left = match.scoreLimit - top;
    const unit = match.mode === 'ctf' ? 'CAPTURE' : 'FRAG';
    if (top > 0 && left <= (match.mode === 'ctf' ? 1 : 3) && left > 0 && left < this.warnedFrags) {
      this.warnedFrags = left;
      this.hud.medal(left === 1 ? `1 ${unit} LEFT` : `${left} ${unit}S LEFT`, '', 'notice');
      this.audio.play('lead', { volume: 0.4, rate: 0.8 });
    }
    if (top === 0) return;
    const lead = red === blue ? -1 : red > blue ? 0 : 1;
    if (lead === this.teamLead) return;
    const was = this.teamLead;
    this.teamLead = lead;
    if (was === -2 && match.mode === 'ctf') return; // joined mid-match: no news
    if (lead === -1) {
      this.hud.medal('SCORES TIED', '', 'notice');
      this.audio.play('lead', { volume: 0.5, rate: 0.9 });
    } else if (mine >= 0 && match.mode === 'tdm') {
      this.hud.medal(lead === mine ? 'YOUR TEAM TOOK THE LEAD' : 'YOUR TEAM LOST THE LEAD', '', 'notice', TEAMS[lead].color);
      this.audio.play(lead === mine ? 'lead' : 'lostLead', { volume: 0.6 });
    }
  }

  /** Capture the flag news, for everyone: who took, dropped, returned or captured which flag. */
  flag(team: number, action: FlagAction, playerId: string | null, name: (id: string) => string) {
    const mine = this.localTeam === team;
    const flag = mine ? 'your flag' : `the ${TEAMS[team].name.toLowerCase()} flag`;
    const who = playerId ? name(playerId) : '';
    const color = TEAMS[team].color;
    switch (action) {
      case 'taken':
        this.hud.feedNotice(`${who} took ${flag}`, color);
        if (playerId === this.localId) {
          this.hud.medal('YOU HAVE THE FLAG', 'Take it home', 'notice', TEAMS[1 - team].color);
          this.audio.play('medal', { volume: 0.6 });
        } else if (mine) {
          this.hud.medal('YOUR FLAG WAS TAKEN', '', 'notice', color);
          this.audio.play('lostLead', { volume: 0.6 });
        }
        break;
      case 'dropped':
        this.hud.feedNotice(`${who} dropped ${flag}`, color);
        break;
      case 'returned':
        this.hud.feedNotice(playerId ? `${who} returned ${flag}` : `${flag[0].toUpperCase()}${flag.slice(1)} went home`, color);
        if (playerId === this.localId) {
          this.hud.medal('FLAG RETURNED', '', 'medal');
          this.audio.play('medal', { volume: 0.5 });
        }
        break;
      case 'captured': {
        const scorer = TEAMS[1 - team];
        this.hud.feedNotice(`${who} captured ${flag}!`, scorer.color);
        if (playerId === this.localId) {
          this.hud.medal('CAPTURE!', '', 'medal');
          this.audio.play('airshot', { volume: 0.8 });
        } else {
          this.hud.medal(`${scorer.name.toUpperCase()} SCORES`, `${who} captured ${flag}`, 'notice', scorer.color);
          this.audio.play(mine ? 'lostLead' : 'lead', { volume: 0.6 });
        }
        break;
      }
    }
  }

  /** Our team, set by the game each frame (-1 outside team modes or while watching). */
  localTeam = -1;

  killed(victimId: string, killerId: string | null, _cause: DeathCause, midair: boolean, name: (id: string) => string) {
    const victim = this.tally(victimId);
    const ended = victim.streak;
    victim.streak = 0;
    victim.multi = 0;
    if (victimId === this.localId) this.lastKiller = killerId;
    if (!killerId || killerId === victimId) return;

    const k = this.tally(killerId);
    k.streak++;
    k.multi = this.clock - k.lastKill <= MATCH.multiKillWindow ? k.multi + 1 : 1;
    k.lastKill = this.clock;
    const firstBlood = !this.firstBlood;
    this.firstBlood = true;

    if (ended >= 5) this.hud.feedNotice(`${name(killerId)} ended ${name(victimId)}'s spree`);
    if (SPREE_FEED[k.streak] && killerId !== this.localId) this.hud.feedNotice(`${name(killerId)} ${SPREE_FEED[k.streak]}!`);

    if (killerId !== this.localId) return;
    // Our medals, the most impressive first; the rest show as smaller tags under it.
    const medals: string[] = [];
    if (MULTI[Math.min(k.multi, MULTI.length - 1)]) medals.push(MULTI[Math.min(k.multi, MULTI.length - 1)]);
    if (SPREES[k.streak]) medals.push(SPREES[k.streak]);
    if (midair) medals.push('AIRSHOT');
    if (ended >= 3) medals.push('SHUTDOWN');
    if (victimId === this.lastKiller) {
      medals.push('REVENGE');
      this.lastKiller = null;
    }
    if (firstBlood) medals.push('FIRST BLOOD');
    if (!medals.length) return;
    this.hud.medal(medals[0], medals.slice(1).join(' · '), 'medal');
    if (midair) this.audio.play('airshot', { volume: 0.8 });
    if (medals.length > 1 || !midair) this.audio.play('medal', { volume: 0.55 });
  }
}
