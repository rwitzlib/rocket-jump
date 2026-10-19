# Rocket Jump

A browser-based, physics-driven arena shooter: a grapple hook in one hand and a rocket launcher in the other.

Built with **Three.js** (rendering), **Rapier** (physics, WASM), **TypeScript** and **Vite**.

## Playing

Rocket Jump is a free-for-all deathmatch for up to 12 people per server. Bots fill in so there's always someone to
fight, and they step aside as people join. A match is first to 25 kills (15 on the bigger Citadel), or the most kills after 8 minutes. Then come
15 seconds of results (a podium, plus awards for the most airshots, the longest streak and the best K/D), and the
next map in the rotation (Arena, then Citadel, a 240 m fortress with vehicles).

From the menu, pick a name, then **Play online** (the server this page came from) or **Practice vs bots** (runs a
server inside the page, no network needed). **Settings** has mouse sensitivity, field of view, volume and invert Y,
all remembered in the browser.

The announcer rewards what the game is about: an **AIRSHOT** medal and bell for hitting someone in midair, multi kills
(kills within 3 s of each other), sprees at 5/10/15/20/25 kills in one life, **SHUTDOWN** for ending someone's streak,
**REVENGE**, **FIRST BLOOD**, and lead changes. Names float over players (hidden by walls), and a red arc points at
whoever just hit you.

## Running a server

```bash
npm install
npm run build
npm start
```

Open http://localhost:8080. Others on your network join at `http://<your-ip>:8080`. One process serves the game page
and runs the matches; players connect over WebSockets at `/ws`.

Settings are environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | 8080 | HTTP and WebSocket port |
| `HOST` | 0.0.0.0 | interface to listen on |
| `MAPS` | arena,citadel | map rotation |
| `TIME_LIMIT` | 480 | seconds per match |
| `FRAG_LIMIT` | per map | kills to win (25 on Arena, 15 on Citadel) |
| `INTERMISSION` | 15 | seconds on the results screen |
| `MIN_PLAYERS` | 4 | bots fill the game up to this many players (0 for no bots) |
| `MAX_PLAYERS` | 12 | people allowed in at once |
| `BOT_SKILL` | auto | easy, normal or hard. Auto starts easy and steps up while people are winning, down while they're losing |
| `STATIC_DIR` | dist | where the built client is |

`GET /status` returns the map, who's playing, the match state and the average tick time as JSON. `GET /health`
answers `ok` for load balancers. The server logs one JSON line per event: join, leave, and a status line every minute
while anyone is on.

**Hosting publicly.** Anything that runs Node 20+ works, and a `Dockerfile` is included:

```bash
docker build -t rocket-jump .
docker run -p 8080:8080 rocket-jump
```

Put it behind a TLS-terminating proxy (Caddy, nginx, or a platform load balancer) that forwards WebSocket upgrades.
Served over HTTPS, the page uses `wss://` automatically. One process runs one match. The simulation takes about 1 ms
of CPU per 60 Hz tick with 11 players on Citadel, so a small VM is plenty. Each player costs roughly 30-100 KB/s
down (deflate-compressed JSON snapshots at 30 Hz). The server is authoritative: clients send only inputs, which are
validated and clamped, and names and chat are sanitized and rate limited.

If a change breaks the protocol between client and server, bump `PROTOCOL_VERSION` in `shared/config.ts`, and pages
still running the old build are told to reload.

## Developing

```bash
npm run dev          # the page with hot reload, at http://localhost:5173
npm run dev:server   # the game server on :8080, restarting on changes; Vite proxies /ws and /status to it
npm run typecheck
npx tsx scripts/balance.ts citadel 6 8   # bot-only match at full speed: kill pace, death causes, airshots
```

Use the balance script after tuning weapons or maps: if the leader can't reach the frag limit in the time limit,
matches end on time and the race to the limit is lost.

Practice needs only `npm run dev`. `?map=citadel` preselects the big map: 240 m square with a ring deck around a
central spire, bridges out to four corner towers and beams up top to swing from. `?server=ws://host:port/ws` points
Play online at a different server.

| Control | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Space | Jump (hold to bunny-hop) |
| Left click | Fire primary weapon (seekers: hold a target in the lock box first) |
| Right click / Shift | Grapple (hold) |
| E | Get in / out of a vehicle |
| Space / C | Helicopter: climb / descend |
| Tab (hold) | Scoreboard |
| T / Enter | Chat |
| M | Mute / unmute |
| P | Frame-time overlay (long frames are also logged to the console) |
| Esc | Pause menu |

Aim at your feet and fire while jumping to rocket jump. Your own rockets never hurt you and launch you harder than
they push others, so rocket jumping is free. WASD steers you in the air. The arcs around the crosshair show weapon
cooldowns: rocket (1 s) on the right, grapple (0.6 s after letting go) on the left.
Everyone has 100 health, which regenerates after 5 seconds without damage. You respawn 3 seconds after dying, with
3 seconds of spawn protection. Knocking someone off the map counts as your kill. All of this is tuned in `COMBAT` in
`shared/config.ts`. The crosshair turns green when the grapple can reach.

Weapons sit in two slots: primary (left click: rocket launcher by default) and secondary (right click: grapple).
Floating **?** mystery boxes swap one of your weapons for a random one you aren't carrying, in that weapon's slot.
A taken box comes back after 10 seconds, and dying resets you to the default loadout.

The rocket launcher is the precise, mobile weapon: fast, straight, and the one to rocket jump and ride with. The
**grenade launcher** is for bursts and area denial. Its six-shot drum empties in under two seconds, then takes 2.5 s
to reload. Each grenade does less damage than a rocket (55) over a wider blast (5 m). Grenades fall under gravity and
always bounce off walls and floors, so you can bank them around corners or leave them rolling in a doorway. After
6 m of flight they're armed and explode on any player they touch. Closer than that they bounce off players too,
for 35 damage. Anything that doesn't hit a player goes off when the 2.5 s fuse runs out.

The **Hypersonic** launcher is the precision weapon. Its dart flies at 110 m/s (nearly hitscan) with a tiny 1.5 m
blast, so a near miss does next to nothing. A direct hit always lands its full 90 damage and a huge upward shove that
launches people across the map, or off a ledge for a fall kill. It reloads in 1.6 s. It's also the best jumping
weapon: your own darts reach further (3 m), so shooting your feet launches you about 1.5x as high as a rocket jump.

Two **heat-seeking launchers** show a lock box around the crosshair. Hold an enemy (in sight) inside it until the
lock fills, and only then will it fire; the missile steers after them. Letting them slip out of the box drains the
lock. Each shot spends the lock, and a new one only starts building once the launcher has reloaded. Whoever is
being targeted gets a MISSILE LOCK warning and a beep.
- **Javelin**: 1.4 s lock, 4 s reload. Soft launch, then a steep climb toward the target, an arc over the top and a
  dive onto them from above, over cover. A direct hit kills, but the blast is tight (3.5 m). It's two-handed, so you
  can't grapple while carrying it.
- **Stinger**: 0.6 s lock, 1.2 s reload, 50 damage. Fast, but it turns wide.

Missiles can be shaken off. On its final approach a missile that loses you outside its seeker cone gives up and flies
straight on, and your warning goes away. Grapple sideways about a third of a second before impact: against a Stinger
that's a clean dodge, and against a Javelin it turns a kill into a wound. Too early and the missile turns back onto you;
too late and it hits.

Tuning is in `GRENADE`, `HYPERSONIC`, `SEEKERS`, `WEAPONS` and `PICKUP` in `shared/config.ts`.

The grapple hooks players and crates as well as walls. Hooking a player is a tug of war: you're pulled in and they get
dragged toward you. A hooked crate is reeled in with a fixed force, so loose crates fly at you while stacked or wedged
ones hold firm enough to swing from. Rockets and hooks are judged against where you saw other players: the server
rewinds them by your latency (up to 500 ms).

### Vehicles

Citadel has a **buggy** in each quadrant and two **helicopters** on the ramparts. Walk up to one and press **E** to
get in: the first person takes the driver's seat, the second rides as gunner. Press E again to jump out, keeping the
vehicle's speed. Inside a vehicle the camera switches to third person, and shots fly to whatever the crosshair is on.
- **Buggy**: W/S throttle, brake and reverse, A/D steer, up to 26 m/s. Its gunner stands on the rear deck and fires
  whatever primary they're carrying, but can't grapple. Hitting someone above 7 m/s runs them over: they're launched
  along its path and hurt by its speed.
- **Helicopter**: WASD moves relative to your view, Space climbs, C descends, and the nose follows the mouse. Left
  click fires rocket pods (fast, alternating, 40% of a rocket). Right click fires a heat seeker after a Stinger-style
  lock. A second player can ride in the side door as gunner. With no pilot it drops.

Vehicles have health (300 each: about three direct rockets) and their riders' own shots don't hurt them. Destroyed,
they explode: whoever is inside dies, credited to whoever did it, and the blast catches anyone nearby. They come back
on their pad 15 s (buggy) or 20 s (helicopter) later. Hard landings damage them too, so bailing out of a high
helicopter wrecks it. The grapple can hook a vehicle and ride along. Tuning is in `CAR`, `HELI` and `VEHICLE_DAMAGE`.

Vehicles use the same netcode as players: the driver's client predicts its vehicle and replays it after server
corrections, and everyone else sees it interpolated.

## Layout

```
src/
  shared/          # no DOM / rendering: runs in the browser and on the Node server
    config.ts      # all gameplay tuning numbers, match rules (MATCH), protocol version
    types.ts       # PlayerInput, what a client sends each tick
    movement.ts    # Quake-style movement + grapple physics (pure functions)
    map.ts         # maps as plain data (boxes, crates, spawns, vehicles)
    sim.ts         # GameSim: fixed 60 Hz authoritative simulation (players, vehicles, projectiles, pickups, explosions)
    vehicle.ts     # VehicleSim and buggy / helicopter handling (velocity and heading, like movement.ts)
    server.ts      # GameServer: joins, bots, matches, map rotation, snapshots (transport-agnostic)
    protocol.ts    # messages, and validation of everything a client sends
    bot.ts         # server-side bots
  server/
    main.ts        # the dedicated server: HTTP for the built client, WebSockets at /ws, the tick loop
  client/
    main.ts        # menus, settings, sessions (online or practice), the frame loop
    game.ts        # one map's game: scene, prediction, event handling, HUD updates
    announcer.ts   # medals, sprees, lead changes
    chat.ts        # text chat
    settings.ts    # saved player preferences
    hud.ts         # health, weapons, match bar, kill feed, scoreboard, results
    input.ts       # keyboard + pointer lock
    level.ts       # meshes for the map and crates
    effects.ts     # rockets, grenades, trails, explosions (fireball, sparks, smoke, shockwave, scorch marks)
    particles.ts   # GPU point-sprite particle system
    rope.ts        # grapple rope + hook visuals
    audio.ts       # procedurally synthesized 3D sound (no audio files)
    camerafx.ts    # screen shake, speed FOV, landing dip
    viewmodel.ts   # first-person weapons (rendered in a separate pass)
    weapons.ts     # weapon and projectile models
    remoteview.ts  # other players' models and name tags
    pickups.ts     # mystery boxes
    vehicles.ts    # buggy and helicopter models
    net/           # WebSocket and loopback transports, NetClient prediction + interpolation, debug overlay
```

The simulation is kept separate from rendering on purpose. The server runs `GameSim` with every player's inputs, and
each client runs the same code locally for prediction.

In dev builds the current game is exposed as `window.game` (`game.sim`, `game.me`, `game.effects`, ...) for tweaking
from the console, and the page as `window.rj`. `game.frame(t)` advances one rendered frame manually, which is handy
for stepping through effects.

## Netcode testing (loopback)

Open http://localhost:5173/?net=loopback to practice behind a fake network (the real server, running in the page).
Optional parameters: `ping` (round trip, ms, default 100), `jitter` (ms, default 10), `loss` (0..1), `bots` (default 2).

Your player is predicted locally and corrected against the server. Bots, rockets and crates are interpolated about
100ms in the past. The overlay in the bottom left (N toggles it) shows prediction errors, the server's input queue
and bandwidth. `[` `]` change ping, `;` `'` change jitter and `L` cycles packet loss, all while you play.

Code: `shared/server.ts` (transport-agnostic `GameServer`), `shared/protocol.ts` (messages), `client/net/`
(loopback transport, `NetClient` prediction + interpolation, overlay).

## Roadmap

1. ~~Single-player movement sandbox: rocket jumping, grappling, test arena~~
2. ~~Weapon polish: sounds, better explosion VFX, rope visuals, hit feedback~~
3. ~~Multiplayer: Node server + WebSockets~~
4. ~~Server-authoritative sim with client-side prediction and interpolation~~
5. ~~Combat loop: health, damage, kills, respawns, scoreboard~~
6. ~~Matches, menus, announcer, deployment~~
7. Next: team modes (CTF suits the grapple), more maps, a server browser, binary snapshots
