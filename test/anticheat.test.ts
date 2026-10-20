import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AimWatch } from '../src/shared/anticheat';

// The aim watch flags hit after hit that comes right after an instant big turn, and not normal play.

test('steady aim is never flagged', () => {
  const w = new AimWatch();
  let flagged = false;
  for (let i = 0; i < 400; i++) {
    w.look(i * 0.01, 0);
    if (i % 10 === 0) flagged ||= w.hit();
  }
  assert.equal(flagged, false);
});

test('snapping onto target after target is flagged, once', () => {
  const w = new AimWatch();
  let flags = 0;
  let yaw = 0;
  for (let i = 0; i < 20; i++) {
    for (let t = 0; t < 30; t++) w.look(yaw, 0);
    yaw += 2; // an instant 115° turn...
    w.look(yaw, 0);
    if (w.hit()) flags++; // ...and a hit right after
  }
  assert.equal(flags, 1);
});

test('the odd flick shot among many hits is not enough', () => {
  const w = new AimWatch();
  let flagged = false;
  let yaw = 0;
  for (let i = 0; i < 60; i++) {
    for (let t = 0; t < 30; t++) w.look((yaw += 0.005), 0);
    if (i % 8 === 0) w.look((yaw += 2), 0);
    flagged ||= w.hit();
  }
  assert.equal(flagged, false);
});
