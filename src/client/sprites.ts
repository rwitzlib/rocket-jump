import * as THREE from 'three';
import { ATLAS_GRID, SPRITE } from './spriteframes';

export { ATLAS_GRID, GLYPHS, SPRITE } from './spriteframes';

// The shapes the fancier skins are drawn with (hearts, notes, ducks, cranes, "KABOOM!"...), all in
// one texture: an 8x8 grid of 128-pixel cells, drawn once at startup on a canvas. One texture means
// one particle system (one draw call) can show any of them, picked per particle by `frame`.
//
// Most are white, so a particle's color tints them; the few that only make sense in their own
// colors (a duck, a coin, a watermelon) are drawn colored, and used with white particles.

const CELL = 128;
const PAD = 8; // empty border round each cell, so neighbors don't bleed in at small sizes

type Draw = (ctx: CanvasRenderingContext2D, s: number) => void;

const W = '#ffffff';

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, points: number, outer: number, inner: number) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
}

function text(ctx: CanvasRenderingContext2D, s: number, word: string, fill: string, size: number) {
  ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.16;
  ctx.strokeStyle = '#1a1020';
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(-0.12);
  ctx.strokeText(word, 0, 0, s * 0.95);
  ctx.fillStyle = fill;
  ctx.fillText(word, 0, 0, s * 0.95);
  ctx.restore();
}

/** A burst-shaped comic balloon behind a word. */
function comic(ctx: CanvasRenderingContext2D, s: number, word: string, fill: string, back: string) {
  starPath(ctx, s / 2, s / 2, 12, s * 0.48, s * 0.34);
  ctx.fillStyle = back;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#1a1020';
  ctx.stroke();
  text(ctx, s, word, fill, s * 0.3);
}

const DRAW: Record<number, Draw> = {
  [SPRITE.dot]: (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  },
  [SPRITE.puff]: (ctx, s) => {
    for (const [x, y, r] of [
      [0.5, 0.56, 0.3],
      [0.32, 0.6, 0.2],
      [0.68, 0.6, 0.21],
      [0.42, 0.4, 0.22],
      [0.6, 0.38, 0.2],
    ]) {
      const g = ctx.createRadialGradient(x * s, y * s, 0, x * s, y * s, r * s);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  },
  [SPRITE.bubble]: (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,0.08)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.2)');
    g.addColorStop(0.9, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = W;
    circle(ctx, c * 0.68, c * 0.62, s * 0.08);
  },
  [SPRITE.heart]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.85);
    ctx.bezierCurveTo(s * 0.05, s * 0.55, s * 0.12, s * 0.12, s / 2, s * 0.32);
    ctx.bezierCurveTo(s * 0.88, s * 0.12, s * 0.95, s * 0.55, s / 2, s * 0.85);
    ctx.fill();
  },
  [SPRITE.note]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.save();
    ctx.translate(s * 0.32, s * 0.74);
    ctx.rotate(-0.4);
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.14, s * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(s * 0.7, s * 0.66);
    ctx.rotate(-0.4);
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.14, s * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillRect(s * 0.42, s * 0.18, s * 0.06, s * 0.56);
    ctx.fillRect(s * 0.8, s * 0.1, s * 0.06, s * 0.56);
    ctx.beginPath();
    ctx.moveTo(s * 0.42, s * 0.18);
    ctx.lineTo(s * 0.86, s * 0.1);
    ctx.lineTo(s * 0.86, s * 0.24);
    ctx.lineTo(s * 0.42, s * 0.32);
    ctx.fill();
  },
  [SPRITE.star]: (ctx, s) => {
    starPath(ctx, s / 2, s * 0.53, 5, s * 0.46, s * 0.2);
    ctx.fillStyle = W;
    ctx.fill();
  },
  [SPRITE.twinkle]: (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.25);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    starPath(ctx, s / 2, s / 2, 4, s * 0.48, s * 0.06);
    ctx.fillStyle = W;
    ctx.fill();
  },
  [SPRITE.petal]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.9);
    ctx.bezierCurveTo(s * 0.05, s * 0.6, s * 0.2, s * 0.1, s * 0.42, s * 0.14);
    ctx.lineTo(s / 2, s * 0.24);
    ctx.lineTo(s * 0.58, s * 0.14);
    ctx.bezierCurveTo(s * 0.8, s * 0.1, s * 0.95, s * 0.6, s / 2, s * 0.9);
    ctx.fill();
  },
  [SPRITE.leaf]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.06);
    ctx.bezierCurveTo(s * 0.95, s * 0.3, s * 0.85, s * 0.8, s / 2, s * 0.86);
    ctx.bezierCurveTo(s * 0.15, s * 0.8, s * 0.05, s * 0.3, s / 2, s * 0.06);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.1);
    ctx.lineTo(s / 2, s * 0.98);
    ctx.stroke();
  },
  [SPRITE.square]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.fillRect(s * 0.12, s * 0.12, s * 0.76, s * 0.76);
  },
  [SPRITE.ring]: (ctx, s) => {
    ctx.strokeStyle = W;
    ctx.lineWidth = s * 0.1;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.38, 0, Math.PI * 2);
    ctx.stroke();
  },
  [SPRITE.feather]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.04);
    ctx.bezierCurveTo(s * 0.85, s * 0.3, s * 0.75, s * 0.75, s * 0.52, s * 0.86);
    ctx.lineTo(s * 0.48, s * 0.86);
    ctx.bezierCurveTo(s * 0.25, s * 0.75, s * 0.15, s * 0.3, s / 2, s * 0.04);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.08);
    ctx.lineTo(s / 2, s * 0.98);
    ctx.stroke();
  },
  [SPRITE.crane]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.05, s * 0.3); // wing tip
    ctx.lineTo(s * 0.5, s * 0.55);
    ctx.lineTo(s * 0.95, s * 0.25); // other wing tip
    ctx.lineTo(s * 0.62, s * 0.62);
    ctx.lineTo(s * 0.9, s * 0.62); // head
    ctx.lineTo(s * 0.55, s * 0.78);
    ctx.lineTo(s * 0.12, s * 0.62); // tail
    ctx.lineTo(s * 0.4, s * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
  },
  [SPRITE.bill]: (ctx, s) => {
    ctx.fillStyle = '#7cc46a';
    ctx.fillRect(s * 0.06, s * 0.28, s * 0.88, s * 0.44);
    ctx.strokeStyle = '#2f6a2a';
    ctx.lineWidth = 4;
    ctx.strokeRect(s * 0.12, s * 0.33, s * 0.76, s * 0.34);
    ctx.fillStyle = '#2f6a2a';
    circle(ctx, s / 2, s / 2, s * 0.1);
    ctx.fillStyle = '#7cc46a';
    ctx.font = `bold ${s * 0.16}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', s / 2, s / 2 + 1);
  },
  [SPRITE.coin]: (ctx, s) => {
    ctx.fillStyle = '#c88a10';
    circle(ctx, s / 2, s / 2, s * 0.42);
    ctx.fillStyle = '#ffd040';
    circle(ctx, s / 2, s / 2, s * 0.36);
    ctx.fillStyle = '#fff2a0';
    circle(ctx, s * 0.4, s * 0.38, s * 0.08);
  },
  [SPRITE.duck]: (ctx, s) => {
    ctx.fillStyle = '#ffd21f';
    ctx.beginPath();
    ctx.ellipse(s * 0.48, s * 0.66, s * 0.36, s * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    circle(ctx, s * 0.62, s * 0.36, s * 0.18);
    ctx.fillStyle = '#ff8a10';
    ctx.beginPath();
    ctx.moveTo(s * 0.76, s * 0.36);
    ctx.lineTo(s * 0.96, s * 0.42);
    ctx.lineTo(s * 0.76, s * 0.46);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    circle(ctx, s * 0.66, s * 0.32, s * 0.035);
    ctx.fillStyle = '#e8b800';
    ctx.beginPath();
    ctx.ellipse(s * 0.4, s * 0.64, s * 0.16, s * 0.09, -0.3, 0, Math.PI * 2);
    ctx.fill();
  },
  [SPRITE.bat]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.42);
    ctx.quadraticCurveTo(s * 0.3, s * 0.2, s * 0.04, s * 0.36);
    ctx.quadraticCurveTo(s * 0.14, s * 0.46, s * 0.12, s * 0.6);
    ctx.quadraticCurveTo(s * 0.24, s * 0.5, s * 0.3, s * 0.64);
    ctx.quadraticCurveTo(s * 0.4, s * 0.54, s / 2, s * 0.7);
    ctx.quadraticCurveTo(s * 0.6, s * 0.54, s * 0.7, s * 0.64);
    ctx.quadraticCurveTo(s * 0.76, s * 0.5, s * 0.88, s * 0.6);
    ctx.quadraticCurveTo(s * 0.86, s * 0.46, s * 0.96, s * 0.36);
    ctx.quadraticCurveTo(s * 0.7, s * 0.2, s / 2, s * 0.42);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s * 0.44, s * 0.4);
    ctx.lineTo(s * 0.46, s * 0.3);
    ctx.lineTo(s * 0.5, s * 0.36);
    ctx.lineTo(s * 0.54, s * 0.3);
    ctx.lineTo(s * 0.56, s * 0.4);
    ctx.fill();
  },
  [SPRITE.snowflake]: (ctx, s) => {
    ctx.strokeStyle = W;
    ctx.lineWidth = s * 0.05;
    ctx.lineCap = 'round';
    ctx.translate(s / 2, s / 2);
    for (let i = 0; i < 6; i++) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -s * 0.42);
      ctx.moveTo(0, -s * 0.24);
      ctx.lineTo(-s * 0.1, -s * 0.34);
      ctx.moveTo(0, -s * 0.24);
      ctx.lineTo(s * 0.1, -s * 0.34);
      ctx.stroke();
    }
  },
  [SPRITE.glyph]: (ctx, s) => glyph(ctx, s, 'ア'),
  [SPRITE.glyph + 1]: (ctx, s) => glyph(ctx, s, 'ﾈ'),
  [SPRITE.glyph + 2]: (ctx, s) => glyph(ctx, s, '7'),
  [SPRITE.glyph + 3]: (ctx, s) => glyph(ctx, s, 'ｸ'),
  [SPRITE.checker]: (ctx, s) => {
    const n = 4;
    const c = (s * 0.84) / n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111111' : W;
        ctx.fillRect(s * 0.08 + x * c, s * 0.08 + y * c, c, c);
      }
  },
  [SPRITE.crown]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.1, s * 0.75);
    ctx.lineTo(s * 0.1, s * 0.3);
    ctx.lineTo(s * 0.3, s * 0.5);
    ctx.lineTo(s * 0.5, s * 0.2);
    ctx.lineTo(s * 0.7, s * 0.5);
    ctx.lineTo(s * 0.9, s * 0.3);
    ctx.lineTo(s * 0.9, s * 0.75);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(s * 0.1, s * 0.66, s * 0.8, s * 0.06);
  },
  [SPRITE.bee]: (ctx, s) => {
    ctx.fillStyle = 'rgba(230,245,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(s * 0.4, s * 0.3, s * 0.14, s * 0.2, -0.5, 0, Math.PI * 2);
    ctx.ellipse(s * 0.6, s * 0.3, s * 0.14, s * 0.2, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(s / 2, s * 0.6, s * 0.3, s * 0.22, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#ffc800';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#1a1a1a';
    for (const x of [0.36, 0.52, 0.68]) ctx.fillRect(s * x, 0, s * 0.07, s);
    ctx.restore();
  },
  [SPRITE.ghost]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.18, s * 0.9);
    ctx.lineTo(s * 0.18, s * 0.44);
    ctx.arc(s / 2, s * 0.44, s * 0.32, Math.PI, 0);
    ctx.lineTo(s * 0.82, s * 0.9);
    for (let i = 0; i < 4; i++) ctx.lineTo(s * (0.82 - (i + 0.5) * 0.16), i % 2 ? s * 0.9 : s * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1a2030';
    circle(ctx, s * 0.4, s * 0.44, s * 0.06);
    circle(ctx, s * 0.6, s * 0.44, s * 0.06);
    ctx.beginPath();
    ctx.ellipse(s / 2, s * 0.62, s * 0.06, s * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  },
  [SPRITE.skull]: (ctx, s) => {
    ctx.fillStyle = W;
    circle(ctx, s / 2, s * 0.42, s * 0.32);
    ctx.fillRect(s * 0.32, s * 0.55, s * 0.36, s * 0.3);
    ctx.fillStyle = '#101018';
    circle(ctx, s * 0.38, s * 0.44, s * 0.09);
    circle(ctx, s * 0.62, s * 0.44, s * 0.09);
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.56);
    ctx.lineTo(s * 0.45, s * 0.66);
    ctx.lineTo(s * 0.55, s * 0.66);
    ctx.fill();
    for (const x of [0.38, 0.47, 0.56]) ctx.fillRect(s * x, s * 0.74, s * 0.04, s * 0.11);
  },
  [SPRITE.flake]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.2, s * 0.4);
    ctx.lineTo(s * 0.55, s * 0.2);
    ctx.lineTo(s * 0.85, s * 0.45);
    ctx.lineTo(s * 0.6, s * 0.8);
    ctx.lineTo(s * 0.3, s * 0.7);
    ctx.fill();
  },
  [SPRITE.blob]: (ctx, s) => {
    const g = ctx.createRadialGradient(s * 0.42, s * 0.4, 0, s / 2, s / 2, s * 0.42);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.85, '#d8d8d8');
    g.addColorStop(1, 'rgba(200,200,200,0)');
    ctx.fillStyle = g;
    circle(ctx, s / 2, s / 2, s * 0.42);
  },
  [SPRITE.confetti]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.fillRect(s * 0.3, s * 0.15, s * 0.4, s * 0.7);
  },
  [SPRITE.clock]: (ctx, s) => {
    ctx.fillStyle = W;
    circle(ctx, s / 2, s / 2, s * 0.42);
    ctx.strokeStyle = '#202830';
    ctx.lineWidth = s * 0.05;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.36, 0, Math.PI * 2);
    ctx.moveTo(s / 2, s / 2);
    ctx.lineTo(s / 2, s * 0.24);
    ctx.moveTo(s / 2, s / 2);
    ctx.lineTo(s * 0.68, s * 0.58);
    ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.fillStyle = '#202830';
      circle(ctx, s / 2 + Math.cos(a) * s * 0.3, s / 2 + Math.sin(a) * s * 0.3, s * 0.015);
    }
  },
  [SPRITE.diamond]: (ctx, s) => {
    const g = ctx.createLinearGradient(0, s / 2, s, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(s * 0.04, s / 2);
    ctx.lineTo(s / 2, s * 0.3);
    ctx.lineTo(s * 0.96, s / 2);
    ctx.lineTo(s / 2, s * 0.7);
    ctx.fill();
  },
  [SPRITE.toon]: (ctx, s) => {
    const lobes: [number, number, number][] = [
      [0.5, 0.58, 0.26],
      [0.3, 0.62, 0.18],
      [0.7, 0.62, 0.18],
      [0.4, 0.4, 0.2],
      [0.62, 0.4, 0.18],
    ];
    ctx.fillStyle = '#1a1a22';
    for (const [x, y, r] of lobes) circle(ctx, x * s, y * s, r * s + 5);
    ctx.fillStyle = W;
    for (const [x, y, r] of lobes) circle(ctx, x * s, y * s, r * s);
    ctx.fillStyle = 'rgba(160,170,190,0.6)';
    ctx.beginPath();
    ctx.ellipse(s / 2, s * 0.74, s * 0.3, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
  },
  [SPRITE.flag]: (ctx, s) => {
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(s * 0.2, s * 0.1, s * 0.05, s * 0.8);
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.25, s * 0.12);
    ctx.quadraticCurveTo(s * 0.55, s * 0.04, s * 0.85, s * 0.16);
    ctx.lineTo(s * 0.85, s * 0.48);
    ctx.quadraticCurveTo(s * 0.55, s * 0.38, s * 0.25, s * 0.46);
    ctx.fill();
  },
  [SPRITE.pumpkin]: (ctx, s) => {
    ctx.fillStyle = '#ff7a00';
    for (const [x, r] of [
      [0.3, 0.24],
      [0.7, 0.24],
      [0.5, 0.3],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(s * x, s * 0.56, s * r, s * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#3a7a20';
    ctx.fillRect(s * 0.46, s * 0.12, s * 0.08, s * 0.14);
    ctx.fillStyle = '#ffe060';
    for (const x of [0.35, 0.65]) {
      ctx.beginPath();
      ctx.moveTo(s * x, s * 0.4);
      ctx.lineTo(s * (x - 0.08), s * 0.52);
      ctx.lineTo(s * (x + 0.08), s * 0.52);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(s * 0.26, s * 0.64);
    for (let i = 0; i <= 6; i++) ctx.lineTo(s * (0.26 + i * 0.08), s * (i % 2 ? 0.7 : 0.62));
    ctx.lineTo(s * 0.7, s * 0.74);
    ctx.quadraticCurveTo(s / 2, s * 0.86, s * 0.3, s * 0.74);
    ctx.fill();
  },
  [SPRITE.shard]: (ctx, s) => {
    const g = ctx.createLinearGradient(s * 0.3, 0, s * 0.7, s);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, 'rgba(255,255,255,0.5)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.04);
    ctx.lineTo(s * 0.7, s * 0.55);
    ctx.lineTo(s * 0.5, s * 0.96);
    ctx.lineTo(s * 0.32, s * 0.5);
    ctx.fill();
  },
  [SPRITE.kaboom]: (ctx, s) => comic(ctx, s, 'KABOOM!', '#ffe020', '#ff4020'),
  [SPRITE.pow]: (ctx, s) => comic(ctx, s, 'POW!', '#ffffff', '#2080ff'),
  [SPRITE.boom]: (ctx, s) => comic(ctx, s, 'BOOM!', '#ff3060', '#ffe020'),
  [SPRITE.wings]: (ctx, s) => {
    ctx.fillStyle = W;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s / 2, s * 0.55);
      for (let i = 0; i <= 5; i++) {
        const a = -0.2 - i * 0.28;
        const r = s * (0.44 - i * 0.03);
        ctx.lineTo(s / 2 + side * Math.cos(a) * r, s * 0.55 + Math.sin(a) * r);
        ctx.lineTo(s / 2 + side * Math.cos(a - 0.14) * r * 0.75, s * 0.55 + Math.sin(a - 0.14) * r * 0.75);
      }
      ctx.closePath();
      ctx.fill();
    }
  },
  [SPRITE.dragon]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.06, s * 0.5); // snout
    ctx.lineTo(s * 0.3, s * 0.36);
    ctx.lineTo(s * 0.5, s * 0.3);
    ctx.lineTo(s * 0.62, s * 0.08); // horn
    ctx.lineTo(s * 0.66, s * 0.3);
    ctx.lineTo(s * 0.9, s * 0.2); // horn
    ctx.lineTo(s * 0.8, s * 0.42);
    ctx.lineTo(s * 0.96, s * 0.6); // neck
    ctx.lineTo(s * 0.6, s * 0.7);
    ctx.lineTo(s * 0.3, s * 0.66); // jaw
    ctx.lineTo(s * 0.12, s * 0.62);
    ctx.lineTo(s * 0.3, s * 0.56);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#201008';
    circle(ctx, s * 0.5, s * 0.42, s * 0.04);
  },
  [SPRITE.rocket]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.92, s / 2);
    ctx.lineTo(s * 0.7, s * 0.38);
    ctx.lineTo(s * 0.2, s * 0.38);
    ctx.lineTo(s * 0.08, s * 0.24);
    ctx.lineTo(s * 0.1, s * 0.76);
    ctx.lineTo(s * 0.2, s * 0.62);
    ctx.lineTo(s * 0.7, s * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    for (let y = 0.24; y < 0.78; y += 0.08) ctx.fillRect(0, s * y, s, s * 0.03);
    ctx.globalCompositeOperation = 'source-over';
  },
  [SPRITE.grid]: (ctx, s) => {
    ctx.strokeStyle = W;
    ctx.lineWidth = 3;
    const r = s * 0.42;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    for (let i = 1; i < 4; i++) {
      ctx.ellipse(s / 2, s / 2, r * Math.cos((i / 4) * (Math.PI / 2)) * 1, r, 0, 0, Math.PI * 2);
      ctx.moveTo(s / 2 + r, s / 2 + r * Math.sin((i / 4 - 0.5) * Math.PI));
    }
    ctx.stroke();
    for (const k of [-0.6, -0.3, 0, 0.3, 0.6]) {
      const w = Math.sqrt(1 - k * k) * r;
      ctx.beginPath();
      ctx.moveTo(s / 2 - w, s / 2 + k * r);
      ctx.lineTo(s / 2 + w, s / 2 + k * r);
      ctx.stroke();
    }
  },
  [SPRITE.swirl]: (ctx, s) => {
    ctx.strokeStyle = W;
    ctx.lineCap = 'round';
    for (let arm = 0; arm < 3; arm++) {
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const a = arm * ((Math.PI * 2) / 3) + t * Math.PI * 2.2;
        const r = s * 0.44 * t;
        ctx.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
      }
      ctx.stroke();
    }
  },
  [SPRITE.melon]: (ctx, s) => {
    ctx.fillStyle = '#2a8a30';
    ctx.beginPath();
    ctx.moveTo(s * 0.08, s * 0.4);
    ctx.lineTo(s * 0.92, s * 0.4);
    ctx.lineTo(s / 2, s * 0.92);
    ctx.fill();
    ctx.fillStyle = '#ff3a50';
    ctx.beginPath();
    ctx.moveTo(s * 0.16, s * 0.4);
    ctx.lineTo(s * 0.84, s * 0.4);
    ctx.lineTo(s / 2, s * 0.84);
    ctx.fill();
    ctx.fillStyle = '#1a1010';
    for (const [x, y] of [
      [0.4, 0.5],
      [0.6, 0.5],
      [0.5, 0.62],
    ])
      circle(ctx, s * x, s * y, s * 0.025);
  },
  [SPRITE.candy]: (ctx, s) => {
    ctx.fillStyle = '#ff5ab0';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s / 2 + side * s * 0.2, s / 2);
      ctx.lineTo(s / 2 + side * s * 0.44, s * 0.3);
      ctx.lineTo(s / 2 + side * s * 0.44, s * 0.7);
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    circle(ctx, s / 2, s / 2, s * 0.22);
    ctx.strokeStyle = '#ff3a6a';
    ctx.lineWidth = s * 0.06;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.13, 0.4, Math.PI * 1.7);
    ctx.stroke();
  },
  [SPRITE.ribbon]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.06, s * 0.3);
    ctx.quadraticCurveTo(s * 0.5, s * 0.5, s * 0.94, s * 0.3);
    ctx.lineTo(s * 0.94, s * 0.66);
    ctx.quadraticCurveTo(s * 0.5, s * 0.86, s * 0.06, s * 0.66);
    ctx.fill();
  },
  [SPRITE.halftone]: (ctx, s) => {
    ctx.fillStyle = W;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const dx = (x + 0.5) / 8 - 0.5;
        const dy = (y + 0.5) / 8 - 0.5;
        const r = Math.max(0, 0.5 - Math.hypot(dx, dy)) * 0.18;
        if (r > 0) circle(ctx, s * (x + 0.5) / 8, s * (y + 0.5) / 8, s * r);
      }
  },
  [SPRITE.scale]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.1, s * 0.3);
    ctx.quadraticCurveTo(s * 0.5, s * 1.05, s * 0.9, s * 0.3);
    ctx.quadraticCurveTo(s * 0.5, s * 0.55, s * 0.1, s * 0.3);
    ctx.fill();
  },
  [SPRITE.splat]: (ctx, s) => {
    ctx.fillStyle = W;
    circle(ctx, s / 2, s / 2, s * 0.24);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + (i % 2) * 0.3;
      const d = s * (0.22 + ((i * 37) % 10) / 60);
      circle(ctx, s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, s * (0.06 + ((i * 13) % 5) / 100));
    }
  },
  [SPRITE.arc]: (ctx, s) => {
    ctx.strokeStyle = W;
    ctx.lineCap = 'round';
    for (const [r, w] of [
      [0.18, 0.06],
      [0.3, 0.05],
      [0.42, 0.04],
    ]) {
      ctx.lineWidth = s * w;
      ctx.beginPath();
      ctx.arc(s * 0.2, s / 2, s * r, -0.8, 0.8);
      ctx.stroke();
    }
  },
  [SPRITE.chip]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.1, s * 0.45);
    ctx.lineTo(s * 0.85, s * 0.3);
    ctx.lineTo(s * 0.9, s * 0.5);
    ctx.lineTo(s * 0.15, s * 0.62);
    ctx.fill();
  },
  [SPRITE.rock]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.beginPath();
    ctx.moveTo(s * 0.2, s * 0.3);
    ctx.lineTo(s * 0.55, s * 0.12);
    ctx.lineTo(s * 0.88, s * 0.38);
    ctx.lineTo(s * 0.8, s * 0.8);
    ctx.lineTo(s * 0.35, s * 0.88);
    ctx.lineTo(s * 0.12, s * 0.6);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.moveTo(s * 0.88, s * 0.38);
    ctx.lineTo(s * 0.8, s * 0.8);
    ctx.lineTo(s * 0.35, s * 0.88);
    ctx.lineTo(s * 0.55, s * 0.5);
    ctx.fill();
  },
  [SPRITE.streak]: (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, s, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, s * 0.45, s, s * 0.1);
  },
  [SPRITE.disc]: (ctx, s) => {
    ctx.fillStyle = W;
    circle(ctx, s / 2, s / 2, s * 0.42);
  },
  [SPRITE.cross]: (ctx, s) => {
    ctx.fillStyle = W;
    ctx.fillRect(s * 0.4, s * 0.08, s * 0.2, s * 0.84);
    ctx.fillRect(s * 0.08, s * 0.4, s * 0.84, s * 0.2);
  },
};

function glyph(ctx: CanvasRenderingContext2D, s: number, ch: string) {
  ctx.fillStyle = W;
  ctx.font = `bold ${s * 0.72}px "MS Gothic", "Yu Gothic", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, s / 2, s / 2);
}

/** The atlas, drawn once. */
export function spriteAtlas(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CELL * ATLAS_GRID;
  const ctx = canvas.getContext('2d')!;
  for (const [frame, draw] of Object.entries(DRAW)) {
    const i = Number(frame);
    ctx.save();
    ctx.translate((i % ATLAS_GRID) * CELL + PAD, Math.floor(i / ATLAS_GRID) * CELL + PAD);
    ctx.beginPath();
    ctx.rect(0, 0, CELL - PAD * 2, CELL - PAD * 2);
    ctx.clip();
    draw(ctx, CELL - PAD * 2);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
