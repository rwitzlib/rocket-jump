import { randomBytes } from 'node:crypto';

// Signing in with Discord (OAuth2, authorization code). It's optional: everyone plays with the
// secret key their browser made, and signing in only ties that profile to a Discord account so
// purchases survive a cleared browser and follow the player to other ones.
//
//   POST /auth/discord { key, returnTo }  -> { url }: where to send the browser to sign in
//   GET  /auth/discord/callback            Discord sends the browser back here; we send it on to
//                                          returnTo#signin=CODE (or #signin-error=REASON)
//   POST /auth/claim { code, key }         -> { key, name }: the key that browser should keep now
//                                          (null: keep the one it has)
//
// The browser's key never goes in a URL: the sign-in is tracked by a random `state`, and the
// result comes back as a one-time code the page swaps for the key over a POST. Nothing is linked
// until that claim, and only the browser that started the sign-in (the same key) can make it: a
// Discord link someone else started, sent to you, can't tie your Discord account to their profile.

const STATE_LIFE = 10 * 60000; // ms to finish signing in
const CLAIM_LIFE = 2 * 60000;
const MAX_PENDING = 5000; // sign-ins under way at once; past that, the oldest are dropped

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // PUBLIC_URL/auth/discord/callback, as registered with Discord
}

export interface DiscordUser {
  id: string;
  name: string;
}

const token = () => randomBytes(16).toString('hex');

/** Where a sign-in (or checkout) may send the browser back to: only pages we serve. */
export function safeReturn(returnTo: unknown, allowed: readonly string[]): string | null {
  if (typeof returnTo !== 'string' || returnTo.length > 500) return null;
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return null;
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) && url.protocol === 'http:';
  if (!allowed.includes(url.origin) && !(allowed.length === 0 && local)) return null;
  return `${url.origin}${url.pathname}`;
}

export class DiscordAuth {
  private readonly pending = new Map<string, { profile: string; returnTo: string; expires: number }>();
  private readonly claims = new Map<string, { profile: string; user: DiscordUser; expires: number }>();

  constructor(
    private readonly config: DiscordConfig,
    /** Discord's API, swapped out in tests. */
    private readonly fetchUser: (code: string) => Promise<DiscordUser> = (code) => discordUser(config, code),
  ) {}

  /** The Discord page to send the browser to, for the profile with this id. */
  start(profile: string, returnTo: string): string {
    this.expire();
    const state = token();
    this.pending.set(state, { profile, returnTo, expires: Date.now() + STATE_LIFE });
    for (const k of this.pending.keys()) {
      if (this.pending.size <= MAX_PENDING) break;
      this.pending.delete(k);
    }
    const q = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      scope: 'identify',
      state,
    });
    return `https://discord.com/oauth2/authorize?${q}`;
  }

  /**
   * Discord sent the browser back. Finds out who they are and says where to send the browser: back
   * to the game, with a code to claim (or the reason it didn't work).
   */
  async callback(query: URLSearchParams): Promise<string | null> {
    const state = query.get('state') ?? '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) return null;
    const code = query.get('code');
    if (!code) return `${pending.returnTo}#signin-error=${query.get('error') === 'access_denied' ? 'denied' : 'failed'}`;
    let user: DiscordUser;
    try {
      user = await this.fetchUser(code);
    } catch (err) {
      console.error('Discord sign-in failed', err);
      return `${pending.returnTo}#signin-error=failed`;
    }
    const claim = token();
    this.expire();
    this.claims.set(claim, { profile: pending.profile, user, expires: Date.now() + CLAIM_LIFE });
    return `${pending.returnTo}#signin=${claim}`;
  }

  /**
   * The page swaps its one-time code for the result, saying which profile it is (`from`, the id of
   * its key). Only the profile that started the sign-in may: then `signIn` (the store's) links it.
   */
  claim(code: unknown, from: string, signIn: (profile: string, user: DiscordUser) => { key: string | null }): { key: string | null; name: string } | null {
    if (typeof code !== 'string') return null;
    const claim = this.claims.get(code);
    if (!claim || claim.expires < Date.now() || claim.profile !== from) return null;
    this.claims.delete(code);
    return { key: signIn(claim.profile, claim.user).key, name: claim.user.name };
  }

  private expire() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    for (const [k, v] of this.claims) if (v.expires < now) this.claims.delete(k);
  }
}

/** Swaps the authorization code for a token, then asks who it belongs to. */
async function discordUser(config: DiscordConfig, code: string): Promise<DiscordUser> {
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }),
  });
  if (!tokenRes.ok) throw new Error(`Discord token: ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const meRes = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${access_token}` } });
  if (!meRes.ok) throw new Error(`Discord user: ${meRes.status}`);
  const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null };
  return { id: me.id, name: me.global_name || me.username };
}
