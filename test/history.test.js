import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore, BUCKET_MS, BAR_SLOTS, RETENTION_MS } from '../lib/history.js';
import { formatEventMessage, formatDuration, createNotifier } from '../lib/notify.js';
import { formatUptime, renderUptimeStrip } from '../shared/uptime.js';

const project = { id: 'p-a', title: '服务 A', url: 'https://a.example/' };
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

test('down requires consecutive failures; recovery emits up with duration', () => {
  const store = new HistoryStore({ downThreshold: 3 });
  assert.equal(store.record(project, { alive: true, latency: 50 }, T0), null, 'unknown → up is silent');
  assert.equal(store.record(project, { alive: false, error: 'TIMEOUT' }, T0 + 1000), null);
  assert.equal(store.record(project, { alive: false, error: 'TIMEOUT' }, T0 + 2000), null);
  const down = store.record(project, { alive: false, error: 'TIMEOUT' }, T0 + 3000);
  assert.equal(down.type, 'down');
  assert.equal(down.error, 'TIMEOUT');
  assert.equal(store.record(project, { alive: false }, T0 + 4000), null, 'no repeat while down');

  const up = store.record(project, { alive: true, latency: 40 }, T0 + 61000);
  assert.equal(up.type, 'up');
  assert.equal(up.durationMs, 60000, 'downtime counted from first failure');
  assert.equal(store.recentEvents().length, 2);
});

test('a single blip does not trigger down', () => {
  const store = new HistoryStore({ downThreshold: 3 });
  store.record(project, { alive: true }, T0);
  store.record(project, { alive: false }, T0 + 1000);
  store.record(project, { alive: false }, T0 + 2000);
  assert.equal(store.record(project, { alive: true }, T0 + 3000), null);
  assert.equal(store.summary('p-a', T0 + 3000).state, 'up');
});

test('summary aggregates uptime, latency and 48 bars', () => {
  const store = new HistoryStore();
  const now = T0 + 24 * 60 * 60 * 1000 + 5 * 60 * 1000; // 避开分桶边界
  for (let i = 0; i < 10; i += 1) {
    store.record(project, { alive: i !== 0, latency: 100 }, now - i * 1000);
  }
  const summary = store.summary('p-a', now);
  assert.equal(summary.bars.length, BAR_SLOTS);
  assert.equal(summary.uptime24h, 0.9);
  assert.equal(summary.avgLatency24h, 100);
  const filled = summary.bars.filter((b) => b.u !== null);
  assert.equal(filled.length, 1);
  assert.equal(summary.bars.at(-1).u, 0.9, 'latest slot is the last bar');
});

test('old buckets expire and URL change resets history', () => {
  const store = new HistoryStore();
  store.record(project, { alive: true }, T0);
  store.record(project, { alive: true }, T0 + RETENTION_MS + BUCKET_MS);
  assert.equal(store.entries.get('p-a').buckets.length, 1);

  store.record({ ...project, url: 'https://b.example/' }, { alive: false }, T0 + RETENTION_MS + 2 * BUCKET_MS);
  const entry = store.entries.get('p-a');
  assert.equal(entry.url, 'https://b.example/');
  assert.equal(entry.buckets.length, 1);
  assert.equal(entry.state, null);
});

test('history round-trips through JSON and prunes removed projects', () => {
  const store = new HistoryStore({ downThreshold: 1 });
  store.record(project, { alive: false, error: 'ERR_NETWORK' }, T0);
  const restored = HistoryStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())), { downThreshold: 1 });
  assert.equal(restored.summary('p-a', T0).state, 'down');
  assert.equal(restored.record(project, { alive: false }, T0 + 1000), null, 'persisted down state is not re-announced');

  restored.prune(new Set());
  assert.equal(restored.summary('p-a', T0), null);
  assert.equal(HistoryStore.fromJSON({ version: 999 }).entries.size, 0);
});

test('notification text and channel wiring', () => {
  assert.equal(formatDuration(65000), '1 分 5 秒');
  assert.equal(formatDuration(3 * 3600 * 1000 + 120000), '3 小时 2 分');
  const down = formatEventMessage({ type: 'down', title: 'A', url: 'https://a/', error: 'TIMEOUT' });
  assert.match(down.title, /A 不可用/);
  const up = formatEventMessage({ type: 'up', title: 'A', url: 'https://a/', durationMs: 5000 });
  assert.match(up.body, /5 秒/);

  assert.equal(createNotifier({}).enabled, false);
  const notifier = createNotifier({ BARK_URL: 'https://api.day.app/x', TELEGRAM_BOT_TOKEN: 't' });
  assert.deepEqual(notifier.channels, ['bark'], 'telegram needs both token and chat id');
});

test('uptime strip renders placeholders and escapes ids', () => {
  assert.equal(formatUptime(1), '100%');
  assert.equal(formatUptime(0.99987), '99.98%');
  assert.equal(formatUptime(0.5), '50.0%');
  assert.equal(formatUptime(null), '—');
  const html = renderUptimeStrip('"><x', null);
  assert.equal(html.includes('"><x'), false);
  assert.equal((html.match(/uptime-bar none/g) || []).length, BAR_SLOTS);
});
