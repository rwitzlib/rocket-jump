import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

// What keeps the server's doors: who a request comes from, how often an address may do something,
// how many connections one address may hold, and the headers every response carries.

/**
 * Cloudflare's addresses, from https://www.cloudflare.com/ips/ (checked 2026-10-20). They change
 * rarely; if Cloudflare adds a range, requests through it count as the Cloudflare address itself
 * (safe, just coarser rate limits) until it's added here.
 */
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
const cloudflareRanges = new BlockList();
for (const range of CLOUDFLARE_V4) cloudflareRanges.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv4');
for (const range of CLOUDFLARE_V6) cloudflareRanges.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv6');

/** Whether an address is one of Cloudflare's. */
export function isCloudflare(addr: string): boolean {
  const ip = addr.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, ''); // (IPv4 written as IPv6)
  const version = isIP(ip);
  return version !== 0 && cloudflareRanges.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The address a request came from. X-Forwarded-For is only believed behind proxies we run
 * (TRUST_PROXY=n): each one appends the address it got the request from, so the client's is the
 * n-th from the end. Anything before that the client wrote itself, and could be anything.
 *
 * With `cloudflare` (TRUST_CLOUDFLARE=1) there may be Cloudflare in front as well, but only
 * sometimes: anyone can skip it and go to the host's address directly. So Cloudflare's word
 * (CF-Connecting-IP, which it sets itself) is taken only when the request really came from one of
 * Cloudflare's addresses; from anywhere else, that address is the client's.
 */
export function clientAddr(req: IncomingMessage, trustedProxies: number, cloudflare = false): string {
  const { addr, chain, short } = nearestHop(req, trustedProxies);
  if (short) return addr;
  if (cloudflare && isCloudflare(addr)) {
    const connecting = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (isIP(connecting)) return connecting;
    return chain.at(-1) ?? addr; // (Cloudflare appends the client's address too)
  }
  return addr;
}

/**
 * The first address in front of our own proxies, and the X-Forwarded-For entries written before it
 * (only Cloudflare's can be believed). Short: fewer entries than proxies, so it's the direct address.
 */
function nearestHop(req: IncomingMessage, trustedProxies: number): { addr: string; chain: string[]; short: boolean } {
  const direct = req.socket.remoteAddress ?? '';
  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (trustedProxies === 0) return { addr: direct, chain, short: false };
  if (chain.length < trustedProxies) return { addr: direct, chain: [], short: true };
  const addr = chain[chain.length - trustedProxies];
  chain.length -= trustedProxies;
  return { addr, chain, short: false };
}

/**
 * The country a request came from, as Cloudflare tells it (CF-IPCountry, two letters), for the
 * server's numbers. Only with TRUST_CLOUDFLARE and only on requests that really came through
 * Cloudflare; null otherwise, or when Cloudflare doesn't know (XX) or it's Tor (T1).
 */
export function clientCountry(req: IncomingMessage, trustedProxies: number, cloudflare = false): string | null {
  if (!cloudflare) return null;
  const { addr, short } = nearestHop(req, trustedProxies);
  if (short || !isCloudflare(addr)) return null;
  const country = String(req.headers['cf-ipcountry'] ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null;
}

/** At most `max` actions per address in a sliding window. Keeps a bounded number of addresses. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10000,
  ) {}

  /** Whether this address may act now (and counts it if so). */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.delete(key); // (re-inserted below: the map stays oldest first)
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return true;
  }

  /** Whether this address has used up its actions for now (without counting this as one). */
  blocked(key: string, now = Date.now()): boolean {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.max;
  }

  /** Forgets addresses with nothing recent, then (if still too many) the least recently seen. */
  private prune(now: number) {
    for (const [key, times] of this.hits) if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/** Open connections per address, up to a limit. */
export class ConnectionCap {
  private readonly open = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Takes a place for this address, or false if it has as many as it may. */
  add(key: string): boolean {
    const n = this.open.get(key) ?? 0;
    if (n >= this.max) return false;
    this.open.set(key, n + 1);
    return true;
  }

  remove(key: string) {
    const n = (this.open.get(key) ?? 0) - 1;
    if (n > 0) this.open.set(key, n);
    else this.open.delete(key);
  }

  count(key: string): number {
    return this.open.get(key) ?? 0;
  }
}

/**
 * Messages one connection may send: a bucket of `burst` that refills at `rate` a second. A client
 * sends an input a tick (60 a second), with bursts after a stall; anything past the bucket is
 * dropped, and a connection that keeps flooding (`abuse` drops within a second) is told to go.
 */
export class MessageBudget {
  private tokens: number;
  private last: number;
  private drops = 0;
  private dropWindow = 0;

  constructor(
    private readonly rate = 120,
    private readonly burst = 240,
    private readonly abuse = 600,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** 'ok' to handle the message, 'drop' to ignore it, 'abuse' to close the connection. */
  take(now = Date.now()): 'ok' | 'drop' | 'abuse' {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens--;
      return 'ok';
    }
    if (now - this.dropWindow >= 1000) {
      this.dropWindow = now;
      this.drops = 0;
    }
    return ++this.drops > this.abuse ? 'abuse' : 'drop';
  }
}

/** Compares secrets without the time taken saying how much of a guess was right. */
export function sameSecret(given: string, secret: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(given), hash(secret));
}

/** The password from an HTTP Basic Authorization header (any user name), or null. */
export function basicPassword(header: string | undefined): string | null {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/**
 * Headers for every response. The page gets a Content Security Policy: our own scripts only (plus
 * compiling Rapier's inlined WASM), connections only to us and the servers we list, and no framing.
 * HSTS once the server is public over HTTPS, so browsers never fall back to plain HTTP.
 */
export function securityHeaders(options: { https: boolean; page: boolean; connect: readonly string[] }): Record<string, string> {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
  };
  if (options.https) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  if (options.page) {
    headers['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      `connect-src ${["'self'", ...options.connect].join(' ')}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return headers;
}
