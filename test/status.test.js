import test from 'node:test';
import assert from 'node:assert/strict';
import { overallStatus, renderStatusBody } from '../shared/statusPage.js';

test('overall status summarizes public services', () => {
  assert.equal(overallStatus([]).level, 'empty');
  assert.equal(overallStatus([{ state: 'up' }, { state: 'unknown' }]).level, 'ok');
  assert.equal(overallStatus([{ state: 'up' }, { state: 'down' }]).text, '1 个服务离线');
  assert.equal(overallStatus([{ state: 'down' }]).text, '全部服务离线');
});

test('status body escapes titles and renders one row per service', () => {
  const html = renderStatusBody({
    services: [
      { title: '<img src=x>', state: 'down', uptime24h: 0.5, bars: [{ t: 1, u: 0.5, l: 10 }] },
      { title: 'Blog', state: 'up', bars: null }
    ]
  });
  assert.equal(html.includes('<img src=x>'), false);
  assert.equal((html.match(/class="status-row"/g) || []).length, 2);
  assert.match(html, /1 个服务离线/);
  assert.match(renderStatusBody({ services: [] }), /status-empty/);
});

test('status events render recovery duration and relative time', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const html = renderStatusBody({
    now,
    services: [{ title: 'Blog', state: 'up', uptime24h: 1, bars: [] }],
    events: [
      { title: 'Blog', type: 'up', at: now - 5 * 60000, durationMs: 65000 },
      { title: 'Blog', type: 'down', at: now - 2 * 3600000, durationMs: null }
    ]
  });
  assert.match(html, /中断 1 分 5 秒/);
  assert.match(html, /5 分钟前/);
  assert.match(html, /2 小时前/);
  assert.match(renderStatusBody({ now, services: [{ title: 'A', state: 'up', bars: null }], events: [] }), /近 7 天没有状态变化/);
});
