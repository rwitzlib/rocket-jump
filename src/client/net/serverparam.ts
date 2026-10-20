/**
 * The ?server=ws://host/ws override, for development builds only. A published page ignores it: a
 * link with it would point the page at someone else's server, which the page would then hand this
 * browser's secret profile key (and with it the profile, and any skins bought on it).
 */
export function serverOverride(search: string, dev: boolean): string | null {
  if (!dev) return null;
  const server = new URLSearchParams(search).get('server');
  return server && /^wss?:\/\/[^\s/?#]+/.test(server) ? server : null;
}
