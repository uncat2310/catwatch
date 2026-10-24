import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { parseIconLinks, sniffImage, IconStore } from '../lib/icons.js';
import { fetchLimited } from '../lib/fetch.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);

test('parseIconLinks ranks svg and large icons first and resolves relative hrefs', () => {
  const html = `
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel='apple-touch-icon' href="apple.png">
    <link rel="icon" type="image/png" sizes="32x32" href="/i32.png">
    <link rel="icon" sizes="192x192" href="https://cdn.example.com/i192.png">
    <link rel="mask-icon" href="/mask.svg">
    <link rel="icon" href="data:image/png;base64,AAAA">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="stylesheet" href="/x.css">`;
  assert.deepEqual(parseIconLinks(html, 'https://svc.example.com/app/'), [
    'https://svc.example.com/logo.svg',
    'https://cdn.example.com/i192.png',
    'https://svc.example.com/app/apple.png',
    'https://svc.example.com/favicon.ico',
    'https://svc.example.com/i32.png'
  ]);
});

test('sniffImage accepts images and rejects html', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(ICO), 'image/x-icon');
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>')), 'image/svg+xml');
  assert.equal(sniffImage(Buffer.from('<!doctype html><title>Login</title>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

function startServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url];
      if (!route) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(route.status || 200, route.headers || {});
      res.end(route.body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('IconStore discovers, caches, keeps stale icons and prunes', async () => {
  const routes = {
    '/': { body: '<html><head><link rel="icon" href="/brand.png"></head></html>' },
    '/brand.png': { body: PNG },
    '/plain/': { body: '<html><head></head></html>' },
    '/favicon.ico': { body: ICO },
    '/login/': { status: 302, headers: { Location: '/login-page' } },
    '/login-page': { body: '<html><link rel="icon" href="/login-page"></html>' }
  };
  const server = await startServer(routes);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-'));
  let clock = 1_000_000;
  const store = new IconStore({ dir, fetcher: fetchLimited, now: () => clock });

  try {
    const linked = await store.get({ id: 'a', customWanUrl: `${base}/` });
    assert.equal(linked.contentType, 'image/png', 'uses <link rel=icon>');

    const fallback = await store.get({ id: 'b', customWanUrl: `${base}/plain/` });
    assert.equal(fallback.contentType, 'image/x-icon', 'falls back to /favicon.ico');

    const custom = await store.get({ id: 'c', customWanUrl: `${base}/plain/`, iconUrl: `${base}/brand.png` });
    assert.equal(custom.contentType, 'image/png', 'custom iconUrl wins');

    // 登录页返回 HTML：不能被当成图标；根目录 favicon 仍可兜底
    const login = await store.get({ id: 'd', customWanUrl: `${base}/login/` });
    assert.equal(login.contentType, 'image/x-icon');

    // 过期后源站挂了：继续用旧图标
    delete routes['/brand.png'];
    routes['/'] = { status: 500, body: '' };
    delete routes['/favicon.ico'];
    clock += 25 * 60 * 60 * 1000;
    const stale = await store.get({ id: 'a', customWanUrl: `${base}/` });
    assert.equal(stale?.contentType, 'image/png');

    // 没有任何图标的新服务返回 null
    assert.equal(await store.get({ id: 'e', customWanUrl: `${base}/nothing/` }), null);

    // 重新加载索引后仍能读到缓存
    const reloaded = new IconStore({ dir, fetcher: fetchLimited, now: () => clock });
    assert.equal((await reloaded.get({ id: 'b', customWanUrl: `${base}/plain/` }))?.contentType, 'image/x-icon');

    reloaded.prune(new Set(['b']));
    assert.equal(fs.readdirSync(dir).filter((f) => !f.startsWith('index')).length, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchLimited blocks private targets unless trusted', async () => {
  const server = await startServer({ '/': { body: 'ok' } });
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    assert.equal((await fetchLimited(url)).ok, false);
    const trusted = await fetchLimited(url, { trusted: true });
    assert.equal(trusted.ok, true);
    assert.equal(trusted.body.toString(), 'ok');
    const truncated = await fetchLimited(url, { trusted: true, maxBytes: 1, truncate: true });
    assert.equal(truncated.body.length, 1);
    assert.equal((await fetchLimited(url, { trusted: true, maxBytes: 1 })).error, 'TOO_LARGE');
  } finally {
    server.close();
  }
});
