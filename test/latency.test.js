import test from 'node:test';
import assert from 'node:assert/strict';
import { LatencyWindow, median } from '../lib/latency.js';

test('median of odd and even lists', () => {
  assert.equal(median([]), null);
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 41]), 25);
});

test('a single spike does not move the displayed latency', () => {
  const win = new LatencyWindow(5);
  for (const latency of [80, 90, 85]) win.add('p', { alive: true, latency });
  assert.equal(win.add('p', { alive: true, latency: 600 }), 88);
  assert.equal(win.add('p', { alive: true, latency: 70 }), 85);
});

test('window keeps only the newest samples and ignores failures', () => {
  const win = new LatencyWindow(3);
  for (const latency of [1000, 1000, 1000]) win.add('p', { alive: true, latency });
  assert.equal(win.add('p', { alive: false, error: 'TIMEOUT' }), null);
  win.add('p', { alive: true, latency: 50 });
  win.add('p', { alive: true, latency: 60 });
  assert.equal(win.add('p', { alive: true, latency: 70 }), 60, 'old 1000 ms samples rolled out');
  win.delete('p');
  assert.equal(win.add('p', { alive: true, latency: 5 }), 5);
});
