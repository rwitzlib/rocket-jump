# Rocket Jump

A browser-based, physics-driven arena shooter: a grapple hook in one hand and a rocket launcher in the other.

Built with **Three.js** (rendering), **Rapier** (physics, WASM), **TypeScript** and **Vite**.

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click to play.

Add `?map=citadel` for the big map: 240 m square with a ring deck around a central spire, bridges out to four corner
towers and beams up top to swing from. The default is `arena`, the original 120 m map. It combines with the other
options, e.g. `?map=citadel&net=loopback&bots=4`.

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
| M | Mute / unmute |
| P | Frame-time overlay (long frames are also logged to the console) |
| Esc | Release mouse |

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
  shared/          # no DOM / rendering: runs in the browser now and on a Node server later
    config.ts      # all gameplay tuning numbers
    types.ts       # PlayerInput, what a client will send each tick
    movement.ts    # Quake-style movement + grapple physics (pure functions)
    map.ts         # arena as plain data (boxes, crates, spawns)
    sim.ts         # GameSim: fixed 60 Hz authoritative simulation (players, vehicles, projectiles, pickups, explosions)
    vehicle.ts     # VehicleSim and buggy / helicopter handling (velocity and heading, like movement.ts)
  client/
    main.ts        # bootstrap, fixed-timestep loop, interpolated camera
    input.ts       # keyboard + pointer lock
    level.ts       # meshes for the map and crates
    effects.ts     # rockets, grenades, trails, explosions (fireball, sparks, smoke, shockwave, scorch marks)
    particles.ts   # GPU point-sprite particle system
    rope.ts        # grapple rope + hook visuals
    audio.ts       # procedurally synthesized 3D sound (no audio files)
    camerafx.ts    # screen shake, speed FOV, landing dip
    viewmodel.ts   # first-person weapons (rendered in a separate pass)
    weapons.ts     # weapon and projectile models
    pickups.ts     # mystery boxes
    vehicles.ts    # buggy and helicopter models
```

The simulation is kept separate from rendering on purpose. In multiplayer the server runs `GameSim`
with every player's inputs, and each client runs the same code locally for prediction.

In dev builds the game is exposed as `window.game` (`game.sim`, `game.me`, `game.effects`, ...) for tweaking from
the console. `game.frame(t)` advances one rendered frame manually, which is handy for stepping through effects.

## Netcode testing (loopback)

Open http://localhost:5173/?net=loopback to run the real server inside the page, behind a fake network.
Optional parameters: `ping` (round trip, ms, default 100), `jitter` (ms, default 10), `loss` (0..1), `bots` (default 2).

Your player is predicted locally and corrected against the server. Bots, rockets and crates are interpolated about
100ms in the past. The overlay in the bottom left (N toggles it) shows prediction errors, the server's input queue
and bandwidth. `[` `]` change ping, `;` `'` change jitter and `L` cycles packet loss, all while you play.

Code: `shared/server.ts` (transport-agnostic `GameServer`), `shared/protocol.ts` (messages), `client/net/`
(loopback transport, `NetClient` prediction + interpolation, overlay).

## Roadmap

1. ~~Single-player movement sandbox: rocket jumping, grappling, test arena~~
2. ~~Weapon polish: sounds, better explosion VFX, rope visuals, hit feedback~~
3. Basic multiplayer: Node server + WebSockets, players see each other
4. Server-authoritative sim with client-side prediction and interpolation of remote players
5. ~~Combat loop: health, damage, kills, respawns, scoreboard~~
6. Maps, polish, deployment
