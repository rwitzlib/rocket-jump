# Rocket Jump

A browser-based, physics-driven arena shooter: a grapple hook in one hand and a rocket launcher in the other.

Built with **Three.js** (rendering), **Rapier** (physics, WASM), **TypeScript** and **Vite**.

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click to play.

| Control | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Space | Jump (hold to bunny-hop) |
| Left click | Fire rocket |
| Right click / E / Shift | Grapple (hold) |
| Tab (hold) | Scoreboard |
| M | Mute / unmute |
| P | Frame-time overlay (long frames are also logged to the console) |
| Esc | Release mouse |

Aim at your feet and fire while jumping to rocket jump. Your own rockets never hurt you, so rocket jumping is free.
Everyone has 100 health, which regenerates after 5 seconds without damage. You respawn 3 seconds after dying, with
3 seconds of spawn protection. Knocking someone off the map counts as your kill. All of this is tuned in `COMBAT` in
`shared/config.ts`. The crosshair turns green when the grapple can reach.

The grapple hooks players and crates as well as walls. Hooking a player is a tug of war: you're pulled in and they get
dragged toward you. A hooked crate is reeled in with a fixed force, so loose crates fly at you while stacked or wedged
ones hold firm enough to swing from. Rockets and hooks are judged against where you saw other players: the server
rewinds them by your latency (up to 500 ms).

## Layout

```
src/
  shared/          # no DOM / rendering: runs in the browser now and on a Node server later
    config.ts      # all gameplay tuning numbers
    types.ts       # PlayerInput, what a client will send each tick
    movement.ts    # Quake-style movement + grapple physics (pure functions)
    map.ts         # arena as plain data (boxes, crates, spawns)
    sim.ts         # GameSim: fixed 60 Hz authoritative simulation (players, rockets, explosions)
  client/
    main.ts        # bootstrap, fixed-timestep loop, interpolated camera
    input.ts       # keyboard + pointer lock
    level.ts       # meshes for the map and crates
    effects.ts     # rockets, trails, explosions (fireball, sparks, smoke, shockwave, scorch marks)
    particles.ts   # GPU point-sprite particle system
    rope.ts        # grapple rope + hook visuals
    audio.ts       # procedurally synthesized 3D sound (no audio files)
    camerafx.ts    # screen shake, speed FOV, landing dip
    viewmodel.ts   # first-person weapons (rendered in a separate pass)
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
