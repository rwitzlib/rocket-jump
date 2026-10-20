# Rocket Jump

A browser-based, physics-driven arena shooter: a grapple hook in one hand and a rocket launcher in the other.

Built with **Three.js** (rendering), **Rapier** (physics, WASM), **TypeScript** and **Vite**.

## Playing

Rocket Jump is an arena shooter for up to 12 people per server, in eight modes:

- **Deathmatch**: everyone for themselves. First to 20 kills (25 on Arena, 15 on the bigger Citadel), or the most
  kills after 8 minutes.
- **Team Deathmatch**: red against blue, first team to 1.6x the deathmatch frag limit. No friendly fire, though your
  rockets still shove teammates (handy for a boost).
- **Capture the Flag**: take the other team's flag from their base and bring it to yours while your own is home.
  First to 3 captures, or the most after 10 minutes. Touch your own flag where it lies to send it home; a dropped flag
  goes home by itself after 20 s. A carrier is held to 26 m/s, so one rocket jump can't cross the map. You spawn on
  your own half.
- **Rocket Race**: a time trial. Fly through the checkpoint rings in order; the start gate starts the clock and
  finishes each lap. Racers are ghosts to each other (no damage, no shoving, no hooking each other), E restarts from
  the start, and the best lap after 5 minutes wins. Split times at each ring compare with your best lap, and the
  ghost of that lap flies alongside you (kept in your browser, per map). Online, the map's record lap flies
  along too, as a gold ghost.
- **King of the Hill**: stand in the glowing ring with nobody else on it to score a point a second. First to 60.
  The hill moves every minute (each map has its spots; by default, under the mystery boxes).
- **Duel**: one on one, first to 10. Two play and everyone else waits in line; the winner stays on and the
  loser goes to the back.
- **Instagib**: everyone carries the Hypersonic and any hit kills, armor or not. No pickups or items.
- **Elimination**: red against blue in rounds. No regeneration and no respawning mid-round: the last team
  standing takes it (or, when the 2-minute round runs out, the one with more people up). First to 5 rounds.
  While you're out, the camera follows a teammate who's still in.

In team modes, names over teammates are white and over enemies red.

Bots fill in so there's always someone to fight, and they step aside as people join. They keep teams even, and in
CTF most of them attack (go for the flag, escort whoever has it, run it home) while the rest defend. They sit out
races. After a match come 15 seconds of results (a podium, the team score, plus awards for the most airshots, the
longest streak and the best K/D), and the next map and mode in the rotation:

- **Dockyard**: a sunny 160 m harbor. Container stacks, two giant cranes to swing from (the big one's boom runs out
  over the sea), warehouse roofs, buggies, and a long drop into the water off three sides.
- **Sunken Temple**: a stepped pyramid in a jungle basin at golden hour, with grand stairs, a ring of columns, ruined
  gatehouses in the corners, waterfalls and giant stone heads in the cliffs.
- **Skyreach**: floating islands above the clouds at sunset, linked by plank bridges, with crystal perches up high.
  Fall off and it's a long way down, but the rock under every island can be grappled to climb back.
- **Foundry**: a steel hall over a pit of molten metal: corner towers, catwalks, a lattice of girders to swing
  from, chains, and an island over the pit.
- **Coliseum**: a small torch-lit arena at night, made for duels: a dais, pillars, a square of beams, balconies.
- **Canyon**: a long red-rock canyon built for vehicles, with buggies and a helicopter at each base.
- **Arena** and **Citadel**: the original two maps, kept as they were.

**Training** (on the menu, highlighted until you've done it) is a short course that teaches one move per ring:
jumping, rocket jumping onto a ledge, swinging on the grapple, a rocket-jump long jump and grappling up a
tower. A coach says what to do next. In your first games, one-off tips explain the rest as it comes up (off in
Settings).

The menu shows one of the new maps drifting by behind it.

From the menu, pick a name, then **Play online** (the server this page came from), **Watch online**, or
**Practice** (runs a server inside the page, no network needed) with the mode, map, bots and difficulty of your
choice.

**Servers and rooms.** One server hosts several games at once. The main room plays the server's rotation; anyone can
open another from **Servers and rooms** on the menu, picking its mode, map (or every map in turn) and bots. A public
room is listed there for everyone to join or watch; a private one only by its five-letter code. In a room, Esc shows
its code and a **Copy invite link** button: the link (`?room=CODE`) drops whoever opens it straight into the room. A
room closes after two minutes with nobody in it. **Settings** has mouse sensitivity, field of view, volume, graphics (Low turns off outlines and glow for slower
machines), invert Y and the killcam, all remembered in the browser.

**No mouse capture?** The game normally captures the mouse (pointer lock). Browsers that won't (automated ones, like
an AI agent driving the page, and some embedded ones) still get to play: clicking to play starts the game without
it. The arrow keys look around, small mouse movements over the game do too, clicking (or F) fires, right click (or Q)
grapples, and Esc pauses. Each click on the game tries for the capture again.

**Spectating.** Watch online, or press Esc and Spectate in a game. Click to follow the next player (right click, the
one before), Space to go between following, a free camera you fly where you look with WASD, and an overhead
view of the whole map with everyone marked through walls, and J (or Esc, Join the game) to play. Someone
joining a full server watches until a place comes free, then gets in automatically.

**Profiles.** Online play earns XP (kills, airshots, captures, laps, matches and wins) toward levels, and counts
lifetime stats. Three daily and three weekly challenges (the same for everyone) pay extra. Levels unlock
armor colors and rocket trails, worn from **Profile, Looks** and seen by everyone. **Profile, Race records**
has the fastest laps on every map. There are no accounts: the browser keeps a secret key, and the server
keeps the profile (in `DATA_DIR`).

**Map editor.** Build a map from boxes and place spawns, mystery boxes, items, flags, race rings and hill spots,
then **Play it** (practice, any mode), **Host online** (opens a room on it; the map goes to everyone who joins)
or **Share link** (the whole map, compressed into a link that opens it in the editor). Maps save in the browser,
and export and import as JSON.

**Controls.** Every action can be rebound (Settings, Controls), mouse buttons included. Gamepads work: sticks
move and look, RT fires, LT grapples, A jumps, Start pauses, Back shows the scores, with a little aim assist
and rumble. Phones and tablets get touch controls: a stick wherever the left thumb lands, drag to look, and
buttons for fire, grapple and jump (swap sides in Settings). Settings also have crosshair styles, colors and
sizes, and colorblind-friendly colors (orange and blue teams, a cyan grapple cue).

**Dropped connections** don't throw you out: the game reconnects by itself and you carry on as you were, for
up to 30 seconds (and a server restart for a deploy puts you straight into the new match).

**Behaving.** Names and chat are filtered for slurs and the worst words. In chat, `/votekick name` starts a vote
(more than half of the others must say `/yes`; the kicked are kept out of that room for 10 minutes),
`/mute name` hides someone's chat from you, and `/help` lists the commands. The server also watches for
aimbot-like snaps onto targets and logs anyone it suspects (`suspect` lines) for a person to look at.

**Replays.** After the killcam (or the play of the match, which replays the best kill of the match before the
results), K saves it as a video file.

**Items.** Besides the mystery boxes, maps have health packs (+50, up to 150; anything over 100 drains away), armor
(+50, up to 100; it soaks up two thirds of each hit until it runs out) and one **overdrive** somewhere hard to reach:
15 seconds of double damage and 1.5x knockback against other players, with a pink glow so everyone can see it coming.

**Dying.** The camera watches your body fly, then the **killcam** replays your last couple of seconds from your
killer's eyes, their weapon in hand (kicking as they fire) and their grapple rope out when they swung. The death screen says what killed you, from how far, how much health your killer had left, and who
else hurt you that life. You respawn 3.5 seconds after dying.

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
| `MAPS` | dockyard,temple:ctf,foundry:koth,skyreach:tdm,canyon:ctf,arena:instagib,coliseum,citadel:elim | rotation: maps, each with an optional `:mode` (ffa, tdm, ctf, race, koth, duel, instagib, elim) |
| `MODE` | ffa | the mode for rotation entries that don't name one |
| `TIME_LIMIT` | per mode | seconds per match (8 minutes; CTF 10, races 5) |
| `FRAG_LIMIT` | per map | kills to win (20 on the new maps, 25 on Arena, 15 on Citadel; 1.6x that in TDM) |
| `INTERMISSION` | 15 | seconds on the results screen |
| `MIN_PLAYERS` | 4 | bots fill the game up to this many players (0 for no bots) |
| `MAX_PLAYERS` | 12 | people allowed in at once |
| `MAX_SPECTATORS` | 8 | people allowed to watch on top of that |
| `MAX_ROOMS` | 8 | rooms at once, the main one included (each runs a match: about 1 ms a tick with 12 players) |
| `BOT_SKILL` | auto | easy, normal or hard. Auto starts easy and steps up while people are winning, down while they're losing |
| `RECONNECT_GRACE` | 30 | seconds a player whose connection drops is held for them to come back |
| `DATA_DIR` | (none) | where profiles, race records and the server's numbers are saved. Unset, they're lost on restart |
| `STATS_KEY` | (none) | turns on `/stats?key=...`: players, sessions, early leavers, modes, maps, menu use, where people die |
| `REGION` | (none) | where this server is, shown in server lists |
| `SERVERS` | (none) | other Rocket Jump servers for the menu's list, with their ping: `Name|https://host,Name 2|https://host2` |
| `STATIC_DIR` | dist | where the built client is |

The rotation and match settings are the main room's. `GET /rooms` lists the public rooms as JSON, and `POST /rooms`
opens one (`{ name, mode, map, bots, skill, private }`, at most three a minute from one address).
`POST /profile` (`{ key }`) returns a profile, `POST /profile/look` puts on a look, `GET /leaderboard?map=NAME`
lists a map's fastest laps (`&ghost=1` adds the record lap's path), `GET /servers` lists the other servers, and
`POST /event` counts menu use. `GET /status` returns the main room's map and mode, who's playing and watching, the rotation, the match state, how
many rooms are open, and the average tick time as JSON. `GET /health` answers `ok` for load balancers. The server logs one JSON line per event: join,
leave, and a status line every minute while anyone is on (with the average outgoing bandwidth).

**Keeping profiles.** Profiles, race records and the stats live in one JSON file each in `DATA_DIR`, written a
few seconds after changes and on shutdown. On Railway: add a Volume to the service mounted at `/data`, and set
`DATA_DIR=/data`. The image runs as the `node` user and Railway mounts volumes owned by root, so also set
`RAILWAY_RUN_UID=0` (or the server can't write there, and says so in its log).

**More than one region.** Run another copy of the service in another region (on Railway, a second service with
its own region), give each a `REGION`, and list the others in `SERVERS` on each. The menu's Servers and rooms
shows every server's ping and who's on, and sends people to the one they pick.

**Hosting publicly.** Anything that runs Node 20+ works, and a `Dockerfile` is included:

```bash
docker build -t rocket-jump .
docker run -p 8080:8080 rocket-jump
```

Put it behind a TLS-terminating proxy (Caddy, nginx, or a platform load balancer) that forwards WebSocket upgrades.
Served over HTTPS, the page uses `wss://` automatically. One process runs all its rooms. A match takes about 1 ms
of CPU per 60 Hz tick with 11 players on Citadel, so a small VM is plenty. Each player costs roughly 3-9 kB/s down
(30 delta-compressed binary snapshots a second: see Netcode below) and about 4 kB/s up. The server is
authoritative: clients send only inputs, which are validated and clamped, and names and chat are sanitized and rate
limited.

If a change breaks the protocol between client and server, bump `PROTOCOL_VERSION` in `shared/config.ts`, and pages
still running the old build are told to reload.

## Developing

```bash
npm run dev          # the page with hot reload, at http://localhost:5173
npm run dev:server   # the game server on :8080, restarting on changes; Vite proxies /ws and /status to it
npm run typecheck
npm test                                        # the test suite: about 90 tests, a few seconds
npx tsx scripts/balance.ts citadel 6 8          # bot-only match at full speed: kill pace, death causes, airshots
npx tsx scripts/balance.ts temple 7 10 normal ctf # any mode: team modes also report team scores and flag play
npx tsx scripts/wire-check.ts citadel 11 60      # round-trips every snapshot of a match through the wire format, and measures it
npx tsx scripts/probe.ts temple 15,15 0,52       # the surfaces under points on a map, for placing things
```

`npm test` runs `test/*.test.ts` with Node's own test runner: movement and weapons (jump heights, rocket jumps,
determinism, the grapple, kill credit), the game modes (flags, team damage, items, race laps), the server's rules
(full servers, spectators, bots, teams, the rotation), rooms, every map's data (spawns, items and flags on floors,
race rings in open air), the wire format, and client prediction against the real server through the real wire
format with latency, which has to agree to the millimeter.

Use the balance script after tuning weapons or maps: if the leader can't reach the frag limit in the time limit,
matches end on time and the race to the limit is lost. Run the wire check after changing anything in a snapshot.

Practice needs only `npm run dev`. `?map=citadel&mode=ctf` preselects the practice map and mode. Citadel is the big
map: 240 m square with a ring deck around a central spire, bridges out to four corner towers and beams up top to swing
from. `?server=ws://host:port/ws` points Play online at a different server.

Each map says where its flag bases, race rings and items go (`flags`, `race` and `items` in its `MapDef`). A map
without them still works: flags go on the two spawns farthest apart and the race visits every mystery box.
`shared/modes.ts` has those defaults, which spawns belong to which team, and each mode's limits.

| Control | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Space | Jump (hold to bunny-hop) |
| Left click / F | Fire primary weapon (seekers: hold a target in the lock box first) |
| Right click / Shift / Q | Grapple (hold) |
| Arrow keys | Look around |
| E | Get in / out of a vehicle; in a race, restart the lap |
| Space / Shift | Helicopter: climb / descend (C works too) |
| Tab (hold) | Scoreboard |
| T / Enter | Chat |
| M | Mute / unmute |
| P | Frame-time overlay (long frames are also logged to the console) |
| Esc | Pause menu (Spectate is there) |
| K | Save the last replay (killcam, play of the match) as a video |
| Chat `/votekick`, `/yes`, `/no`, `/mute`, `/unmute`, `/help` | Vote someone out, hide someone's chat |
| Spectating: click / right click | Follow the next / previous player |
| Spectating: Space, J | Camera: follow, free, overhead; join the game |

Aim at your feet and fire while jumping to rocket jump. Your own rockets never hurt you and launch you harder than
they push others, so rocket jumping is free. WASD steers you in the air. The arcs around the crosshair show weapon
cooldowns: rocket (1 s) on the right, grapple (0.6 s after letting go) on the left.
Everyone has 100 health, which regenerates after 5 seconds without damage. You respawn 3.5 seconds after dying, with
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

Tuning is in `GRENADE`, `HYPERSONIC`, `SEEKERS`, `WEAPONS`, `PICKUP` and `ITEMS` in `shared/config.ts`, and the
modes in `MODES`, `TEAMS`, `TDM`, `CTF` and `RACE`.

The grapple hooks players and crates as well as walls. Hooking a player is a tug of war: you're pulled in and they get
dragged toward you. A hooked crate is reeled in with a fixed force, so loose crates fly at you while stacked or wedged
ones hold firm enough to swing from. Rockets and hooks are judged against where you saw other players: the server
rewinds them by your latency (up to 500 ms).

### Vehicles

Citadel has a **buggy** in each quadrant and two **helicopters** on the ramparts, and Dockyard has two buggies. Walk up to one and press **E** to
get in: the first person takes the driver's seat, the second rides as gunner. Press E again to jump out, keeping the
vehicle's speed. Inside a vehicle the camera switches to third person, and shots fly to whatever the crosshair is on.
- **Buggy**: W/S throttle, brake and reverse, A/D steer, up to 26 m/s. Its gunner stands on the rear deck and fires
  whatever primary they're carrying, but can't grapple. Hitting someone above 7 m/s runs them over: they're launched
  along its path and hurt by its speed.
- **Helicopter**: WASD moves relative to your view, Space climbs, Shift (or C) descends, and the nose follows the mouse. Left
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
    config.ts      # all gameplay tuning numbers, match rules (MATCH), modes, items, protocol version
    modes.ts       # what each mode needs from a map: flag bases, team spawns, the race course; score and time limits
    types.ts       # PlayerInput, what a client sends each tick
    movement.ts    # Quake-style movement + grapple physics (pure functions)
    map.ts         # maps as plain data (boxes, crates, spawns, vehicles, scenery); Arena and Citadel
    maps/          # the newer maps (dockyard, temple, skyreach) and helpers for laying maps out
    sim.ts         # GameSim: fixed 60 Hz authoritative simulation: the tick, players, weapons, combat
    player.ts      # PlayerSim, and the PlayerState copy of it that goes to its own client
    projectile.ts  # projectile types, blasts, seeker lock rules
    flight.ts      # projectiles in flight: rockets, grenades, seeker missiles
    driving.ts     # vehicles in the world: moving, running people over, getting in and out, blowing up
    rules.ts       # per-mode rules: items, capture-the-flag flags, race checkpoints
    events.ts      # SimEvent: what a tick reports
    physics.ts     # collision groups and geometry helpers
    vehicle.ts     # VehicleSim and buggy / helicopter handling (velocity and heading, like movement.ts)
    server.ts      # GameServer: joins, spectators, teams, bots, matches, rotation, snapshots (transport-agnostic)
    protocol.ts    # messages, and validation of everything a client sends
    wire.ts        # the binary, delta-compressed wire format for snapshots and inputs
    rooms.ts       # several games per server: room codes, the public list, closing empty rooms
    bot.ts         # server-side bots
    progress.ts    # XP, levels, challenges, cosmetics: what a profile is and how events change it
    moderation.ts  # the word filter and vote-kick rules
    anticheat.ts   # spotting aimbot-like snaps onto targets
    custommap.ts   # checking maps from the editor, and their share codes
  server/
    main.ts        # the dedicated server: HTTP for the built client and /rooms, WebSockets at /ws, the tick loop
    store.ts       # profiles and race records, saved in DATA_DIR
    analytics.ts   # the server's numbers (/stats)
test/              # npm test (node:test, run with tsx)
  client/
    main.ts        # menus, settings, sessions (online or practice), the frame loop
    game.ts        # one map's game: scene, prediction, event handling, HUD updates
    announcer.ts   # medals, sprees, lead changes, flag news
    chat.ts        # text chat
    settings.ts    # saved player preferences
    hud.ts         # health and armor, weapons, match bar, flag status, race clock, markers, kill feed, death
                   #   recap, scoreboard, results
    killcam.ts     # records the last few seconds, to replay a death from the killer's eyes
    objectives.ts  # flags and their bases, items, race rings, the best-lap ghost
    input.ts       # keyboard, mouse (pointer lock), gamepads; rebindable actions
    touch.ts       # on-screen controls for phones and tablets
    tutorial.ts    # the training course's coach, and tips for new players
    profile.ts     # the Profile window: level, stats, challenges, looks, race records
    editor.ts      # the map editor
    clips.ts       # saving replays as video
    palette.ts     # colorblind-friendly colors (loaded first)
    level.ts       # meshes for the map and crates, the sky, sun and fog
    surfaces.ts    # painted level textures (stone, brick, planks, containers...) drawn on canvases at startup
    decor.ts       # scenery: trees, water, mountains, lamps, ships, waterfalls, clouds (merged into few draw calls)
    themes.ts      # each map's sky, light and fog
    sky.ts         # gradient sky with sun and drifting clouds
    postfx.ts      # cartoon outlines, bloom and tone mapping (the Graphics setting turns them off)
    menubackdrop.ts # a map drifting by behind the main menu
    effects.ts     # rockets, grenades, trails, explosions, hit sparks, death bursts, landing dust, respawn beams
    debris.ts      # tumbling chunks thrown by explosions and kills
    particles.ts   # GPU point-sprite particle system
    rope.ts        # grapple rope + hook visuals
    audio.ts       # procedurally synthesized 3D sound (no audio files)
    camerafx.ts    # screen shake, speed FOV, landing dip
    viewmodel.ts   # first-person weapons (rendered in a separate pass)
    weapons.ts     # weapon and projectile models
    remoteview.ts  # other players' models and name tags
    pickups.ts     # mystery boxes
    vehicles.ts    # buggy and helicopter models
    net/           # WebSocket (reconnecting) and loopback transports, NetClient prediction + interpolation, debug overlay
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

Code: `shared/server.ts` (transport-agnostic `GameServer`), `shared/protocol.ts` (messages), `shared/wire.ts` (the
wire format), `client/net/` (loopback transport, `NetClient` prediction + interpolation, overlay).

**The wire format.** Snapshots and inputs are binary; joins, chat, pings and welcomes stay JSON. Every input packet
carries the newest snapshot tick the client has (spectators send a small `ack` instead), and the server codes each
snapshot against that one: every record (a player, a crate, a score line, a vehicle) starts with a bitmask of the
fields that changed since, positions go as millimeter offsets, and events the baseline carried aren't repeated. With
no usable baseline (just joined, a new map) a snapshot goes out in full. What's only drawn is quantized (millimeters,
milliradians); what a client predicts from (its own player, its own projectiles, a vehicle it drives) goes at full
64-bit precision, and inputs are rounded to what the wire carries before the client predicts with them, so client
and server simulate exactly the same numbers (a hair's difference in a cooldown or a position grows into a visible
correction). On Citadel with 12 players that's about 670 bytes a snapshot against 9.5 kB of JSON, and 8 kB/s per
player after the WebSocket's compression against 31 (`scripts/wire-check.ts` measures it).

## Roadmap

1. ~~Single-player movement sandbox: rocket jumping, grappling, test arena~~
2. ~~Weapon polish: sounds, better explosion VFX, rope visuals, hit feedback~~
3. ~~Multiplayer: Node server + WebSockets~~
4. ~~Server-authoritative sim with client-side prediction and interpolation~~
5. ~~Combat loop: health, damage, kills, respawns, scoreboard~~
6. ~~Matches, menus, announcer, deployment~~
7. ~~Team deathmatch, capture the flag, rocket races, spectating, killcam, items, binary snapshots~~
8. ~~Rooms and a server browser, automated tests, the simulation split into parts~~
9. ~~More maps, rebindable keys and gamepads, a list of servers across hosts~~
10. ~~Training, profiles and challenges, race records, four more modes, a map editor, touch controls, reconnecting~~
11. Next: accounts that follow you across devices, ranked duels, map voting between matches
