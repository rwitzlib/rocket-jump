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
| Esc | Release mouse |

Aim at your feet and fire while jumping to rocket jump. The crosshair turns green when the grapple can reach.

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
    effects.ts     # rockets, smoke, explosions, grapple rope
    viewmodel.ts   # first-person weapons (rendered in a separate pass)
```

The simulation is kept separate from rendering on purpose. In multiplayer the server runs `GameSim`
with every player's inputs, and each client runs the same code locally for prediction.

In dev builds the game is exposed as `window.game` (`game.sim`, `game.me`) for tweaking from the console.

## Roadmap

1. ~~Single-player movement sandbox: rocket jumping, grappling, test arena~~
2. Weapon polish: sounds, better explosion VFX, rope visuals, hit feedback
3. Basic multiplayer: Node server + WebSockets, players see each other
4. Server-authoritative sim with client-side prediction and interpolation of remote players
5. Combat loop: health, damage, kills, respawns, scoreboard
6. Maps, polish, deployment
