import http from 'http';
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import https from 'https';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { escapeHtml, safeJsonForHtmlScript } from './shared/escape.js';
import { getGreeting, formatDateLabel } from './shared/greeting.js';
import { parseHttpUrl } from './shared/url.js';
import { validateProbeTarget, createPinnedLookup } from './shared/ssrf.js';
import { renderUptimeStrip } from './shared/uptime.js';
import { renderStatusBody } from './shared/statusPage.js';
import { renderProjectCard, renderPool, statusView, aggregateSeries } from './shared/card.js';
import { HistoryStore } from './lib/history.js';
import { createNotifier } from './lib/notify.js';
import { sanitizeProjects, writeJsonAtomic, tokenMatches, readBearerToken } from './lib/store.js';
import { IconStore } from './lib/icons.js';
import { fetchLimited } from './lib/fetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DIST_DIR = path.join(__dirname, 'dist');
const INDEX_FILE = path.join(DIST_DIR, 'index.html');
const STATUS_FILE = path.join(DIST_DIR, 'status.html');
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const ALLOW_INSECURE_TLS = String(process.env.ALLOW_INSECURE_TLS || 'false').toLowerCase() === 'true';
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const CONFIG_PATH = path.join(__dirname, 'config', 'projects.json');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const ICON_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MAX_BODY_BYTES = 32 * 1024;
const MAX_PROJECTS_BODY_BYTES = 256 * 1024;
const HISTORY_SAVE_INTERVAL_MS = 5 * 60 * 1000;
const BACKGROUND_CHECK_INTERVAL_MS = 12000;
const MAX_BATCH_SIZE = 30;
const MAX_ID_LENGTH = 64;
const MAX_URL_LENGTH = 2048;
const BATCH_PROBE_CONCURRENCY = 8;
const GLOBAL_PROBE_CONCURRENCY = 16;
const HEALTH_CACHE_MAX = 200;
const HEALTH_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 45;

if (!fs.existsSync(INDEX_FILE)) {
  console.error('Production build not found. Run npm run build first.');
  process.exit(1);
}

if (ADMIN_TOKEN && ADMIN_TOKEN.length < 12) {
  console.warn('ADMIN_TOKEN is shorter than 12 characters; use a long random token.');
}

/**
 * 开源公开演示 Demo 矩阵（无私有域名）
 */
const PUBLIC_DEMO_PROJECTS = [
  {
    id: 'p-github',
    categoryId: 'services',
    title: 'GitHub 代码中枢',
    customWanUrl: 'https://github.com',
    pingEnabled: true
  },
  {
    id: 'p-vercel',
    categoryId: 'services',
    title: 'Vercel 部署平台',
    customWanUrl: 'https://vercel.com',
    pingEnabled: true
  },
  {
    id: 'p-cloudflare',
    categoryId: 'services',
    title: 'Cloudflare 边缘网络',
    customWanUrl: 'https://cloudflare.com',
    pingEnabled: true
  }
];

/* -------------------------------------------------------------------------- */
/* 服务端项目配置缓存（按 mtime）                                              */
/* -------------------------------------------------------------------------- */

let projectsCache = {
  mtimeMs: null,
  projects: null,
  trustedById: null
};

function loadServerProjects() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const stat = fs.statSync(CONFIG_PATH);
      if (projectsCache.projects && projectsCache.mtimeMs === stat.mtimeMs) {
        return projectsCache.projects;
      }
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      // 管理员通过页面清空列表时文件为 []，同样视为有效配置
      if (Array.isArray(parsed)) {
        // 手写配置可能省略 pingEnabled：统一成布尔值，前后端按同一规则判断
        const data = parsed.map((p) => (p && typeof p === 'object' ? { ...p, pingEnabled: p.pingEnabled !== false } : p));
        const trustedById = new Map();
        for (const project of data) {
          if (project?.id && typeof project.id === 'string') {
            trustedById.set(project.id, project);
          }
        }
        projectsCache = { mtimeMs: stat.mtimeMs, projects: data, trustedById };
        return data;
      }
    }
  } catch {
    // 容错降级到公开 Demo
  }

  if (projectsCache.projects === PUBLIC_DEMO_PROJECTS) {
    return PUBLIC_DEMO_PROJECTS;
  }
  const trustedById = new Map();
  for (const project of PUBLIC_DEMO_PROJECTS) {
    trustedById.set(project.id, project);
  }
  projectsCache = { mtimeMs: null, projects: PUBLIC_DEMO_PROJECTS, trustedById };
  return PUBLIC_DEMO_PROJECTS;
}

function saveServerProjects(projects) {
  writeJsonAtomic(CONFIG_PATH, projects);
  projectsCache = { mtimeMs: null, projects: null, trustedById: null };
  const saved = loadServerProjects();
  const ids = new Set(saved.map((p) => p.id));
  historyStore.prune(ids);
  iconStore.prune(ids);
  iconStore.warm(saved);
  return saved;
}

function getTrustedProjectMap() {
  loadServerProjects();
  return projectsCache.trustedById || new Map();
}

function canonicalUrl(value) {
  const parsed = parseHttpUrl(value, { maxLength: MAX_URL_LENGTH });
  return parsed ? parsed.href : '';
}

function urlsMatch(a, b) {
  const left = canonicalUrl(a);
  const right = canonicalUrl(b);
  return Boolean(left && right && left === right);
}

/* -------------------------------------------------------------------------- */
/* 健康探针                                                                   */
/* -------------------------------------------------------------------------- */

const HEALTH_CACHE = new Map();
let healthCheckRunning = false;
let globalProbeActive = 0;
const globalProbeWaiters = [];

const rateLimitMap = new Map();

function pruneHealthCache() {
  const now = Date.now();
  for (const [key, value] of HEALTH_CACHE.entries()) {
    if (now - (value.lastChecked || 0) > HEALTH_CACHE_TTL_MS) {
      HEALTH_CACHE.delete(key);
    }
  }
  while (HEALTH_CACHE.size > HEALTH_CACHE_MAX) {
    const oldest = HEALTH_CACHE.keys().next().value;
    HEALTH_CACHE.delete(oldest);
  }
}

function setHealthCache(id, payload) {
  pruneHealthCache();
  if (HEALTH_CACHE.size >= HEALTH_CACHE_MAX && !HEALTH_CACHE.has(id)) {
    const oldest = HEALTH_CACHE.keys().next().value;
    HEALTH_CACHE.delete(oldest);
  }
  HEALTH_CACHE.set(id, payload);
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

function acquireGlobalProbeSlot() {
  if (globalProbeActive < GLOBAL_PROBE_CONCURRENCY) {
    globalProbeActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    globalProbeWaiters.push(resolve);
  });
}

function releaseGlobalProbeSlot() {
  globalProbeActive = Math.max(0, globalProbeActive - 1);
  const next = globalProbeWaiters.shift();
  if (next) {
    globalProbeActive += 1;
    next();
  }
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run());
  await Promise.all(runners);
  return results;
}

function getClientIp(req) {
  if (TRUST_PROXY) {
    // 取最右一项：它由最近的可信代理追加；最左项可被客户端伪造，用来绕过限流
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref?.();

async function probeHttpEndpoint(targetUrl, options = {}) {
  const {
    timeoutMs = 2800,
    redirectCount = 0,
    trusted = false
  } = options;

  let pinned = null;

  if (!trusted) {
    const validation = await validateProbeTarget(targetUrl, { maxLength: MAX_URL_LENGTH });
    if (!validation.ok) {
      return { alive: false, error: validation.error };
    }
    targetUrl = validation.url;
    pinned = { address: validation.address, family: validation.family, hostname: validation.hostname };
  } else {
    const parsed = parseHttpUrl(targetUrl, { maxLength: MAX_URL_LENGTH });
    if (!parsed) {
      return { alive: false, error: 'INVALID_URL' };
    }
    targetUrl = parsed.href;
    // 管理员可信配置：允许内网目标，但仍做 DNS pinning 防止请求阶段被换解析
    try {
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host)) {
        pinned = { address: host, family: net.isIP(host), hostname: host };
      } else {
        const looked = await dns.lookup(host, { all: true, verbatim: true });
        if (!looked[0]) {
          return { alive: false, error: 'DNS_FAILED' };
        }
        pinned = { address: looked[0].address, family: looked[0].family, hostname: host };
      }
    } catch {
      return { alive: false, error: 'DNS_FAILED' };
    }
  }

  await acquireGlobalProbeSlot();
  let result;
  try {
    result = await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        const parsed = new URL(targetUrl);
        const isHttps = parsed.protocol === 'https:';
        const client = isHttps ? https : http;
        const startTime = Date.now();
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

        const requestOptions = {
          protocol: parsed.protocol,
          hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          timeout: timeoutMs,
          rejectUnauthorized: !ALLOW_INSECURE_TLS,
          servername: hostname,
          headers: {
            Host: parsed.host,
            'User-Agent': 'SchrodingerPortal/1.0 (+health-probe)',
            Accept: '*/*'
          }
        };

        if (pinned?.address) {
          requestOptions.lookup = createPinnedLookup(pinned.address, pinned.family);
        }

        const req = client.request(requestOptions, (res) => {
          const status = res.statusCode || 0;
          const location = res.headers.location;

          if (status >= 300 && status < 400 && location && redirectCount < MAX_REDIRECTS) {
            res.resume();
            let nextUrl;
            try {
              nextUrl = new URL(location, parsed).href;
            } catch {
              finish({ alive: false, error: 'INVALID_REDIRECT', statusCode: status });
              return;
            }

            // 同 hostname 的 trusted 跳转（如 http→https）可继续 trusted；换 hostname 则严格 SSRF
            let redirectTrusted = false;
            if (trusted) {
              try {
                const nextHost = new URL(nextUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
                redirectTrusted = nextHost === hostname.toLowerCase();
              } catch {
                redirectTrusted = false;
              }
            }
            finish({ redirect: { url: nextUrl, trusted: redirectTrusted } });
            return;
          }

          res.resume();
          const latency = Date.now() - startTime;

          if (status >= 200 && status < 500) {
            finish({ alive: true, latency, statusCode: status });
            return;
          }
          if (status >= 500 && status < 600) {
            finish({ alive: false, latency, statusCode: status, error: 'HTTP_5XX' });
            return;
          }
          finish({ alive: false, statusCode: status, error: 'HTTP_ERROR' });
        });

        req.on('timeout', () => {
          req.destroy();
          finish({ alive: false, error: 'TIMEOUT' });
        });

        req.on('error', (err) => {
          const code = err?.code || '';
          if (
            code === 'CERT_HAS_EXPIRED' ||
            code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
            code === 'ERR_TLS_CERT_ALTNAME_INVALID'
          ) {
            finish({ alive: false, error: 'TLS_ERROR' });
            return;
          }
          finish({ alive: false, error: 'ERR_NETWORK' });
        });

        req.end();
      } catch {
        finish({ alive: false, error: 'INVALID_URL' });
      }
    });
  } finally {
    releaseGlobalProbeSlot();
  }

  // 先释放并发槽再跟随跳转：持有槽位递归时，并发打满后所有探测会互相等待而永久卡住
  if (result.redirect) {
    return probeHttpEndpoint(result.redirect.url, {
      timeoutMs,
      redirectCount: redirectCount + 1,
      trusted: result.redirect.trusted
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 探测历史 / 状态通知                                                         */
/* -------------------------------------------------------------------------- */

function loadHistoryStore() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return HistoryStore.fromJSON(JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')));
    }
  } catch (err) {
    console.warn('Failed to load history, starting fresh:', err?.message || err);
  }
  return new HistoryStore();
}

const historyStore = loadHistoryStore();
const notifier = createNotifier();

// 服务图标由服务端抓取：同源返回，避免混合内容拦截，也不把域名发给第三方
const iconStore = new IconStore({
  dir: ICON_DIR,
  fetcher: (url, options) => fetchLimited(url, { ...options, insecureTls: ALLOW_INSECURE_TLS })
});
setTimeout(() => iconStore.warm(loadServerProjects()), 3000).unref?.();
setInterval(() => iconStore.warm(loadServerProjects()), ICON_REFRESH_INTERVAL_MS).unref?.();

/** 公开状态页使用的图标地址：不暴露内部 ID */
function statusIconKey(id) {
  return crypto.createHash('sha256').update(`status-icon:${id}`).digest('hex').slice(0, 16);
}

async function sendIcon(req, res, project) {
  const icon = project?.customWanUrl ? await iconStore.get(project) : null;
  if (!icon) {
    res.writeHead(404, { 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  const headers = {
    'Content-Type': icon.contentType,
    'Cache-Control': 'no-cache',
    ETag: icon.etag,
    // SVG 来自第三方服务：禁止脚本，防止直接打开时在本站执行
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  };
  if (req.headers['if-none-match'] === icon.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(icon.buffer);
}

function saveHistory() {
  if (!historyStore.dirty) return;
  try {
    writeJsonAtomic(HISTORY_PATH, historyStore.toJSON());
    historyStore.dirty = false;
  } catch (err) {
    console.warn('Failed to save history:', err?.message || err);
  }
}

function dispatchEvent(event) {
  console.log(`[status] ${event.title} → ${event.type}${event.error ? ` (${event.error})` : ''}`);
  if (!notifier.enabled) return;
  notifier.send(event).then((results) => {
    for (const r of results) {
      if (!r.ok) console.warn(`[notify] ${r.channel} failed: ${r.error}`);
    }
  });
}

async function runBackgroundHealthCheck() {
  if (healthCheckRunning) return;
  healthCheckRunning = true;
  try {
    const allProjects = loadServerProjects();
    historyStore.prune(new Set(allProjects.map((p) => p.id)));
    const projects = allProjects.filter((p) => p.customWanUrl && p.pingEnabled !== false);
    await mapPool(projects, BATCH_PROBE_CONCURRENCY, async (proj) => {
      const res = await probeHttpEndpoint(proj.customWanUrl, {
        timeoutMs: 2500,
        trusted: true
      });
      const entry = {
        alive: Boolean(res.alive),
        latency: res.latency || null,
        statusCode: res.statusCode || null,
        error: res.error || null,
        lastChecked: Date.now()
      };
      setHealthCache(proj.id, entry);
      const event = historyStore.record(
        { id: proj.id, title: proj.title, url: canonicalUrl(proj.customWanUrl) },
        entry,
        entry.lastChecked
      );
      if (event) dispatchEvent(event);
    });
  } finally {
    healthCheckRunning = false;
    pruneHealthCache();
  }
}

runBackgroundHealthCheck();
setInterval(() => {
  runBackgroundHealthCheck();
}, BACKGROUND_CHECK_INTERVAL_MS);
setInterval(saveHistory, HISTORY_SAVE_INTERVAL_MS).unref?.();

function buildHistoryPayload() {
  const now = Date.now();
  const services = {};
  for (const project of loadServerProjects()) {
    const summary = historyStore.summary(project.id, now);
    if (summary) services[project.id] = summary;
  }
  // 事件只返回前端需要的字段，不带 URL 和错误码
  const events = historyStore.recentEvents(20).map((e) => ({
    id: e.id,
    title: e.title,
    type: e.type,
    at: e.at,
    durationMs: typeof e.durationMs === 'number' ? e.durationMs : null
  }));
  return { now, services, events };
}

/**
 * 公开状态页数据：只包含勾选了 statusPublic 的服务，且不带 URL / hostname
 */
function buildStatusPayload() {
  const now = Date.now();
  const publicProjects = loadServerProjects().filter(
    (p) => p.statusPublic === true && p.pingEnabled !== false && p.customWanUrl
  );
  const titleById = new Map(publicProjects.map((p) => [p.id, p.title || '未命名服务']));

  const services = publicProjects.map((p) => {
    const summary = historyStore.summary(p.id, now);
    let state = 'unknown';
    if (summary) {
      // 历史状态经过连续失败防抖；尚未确认时显示「检测中」
      state = summary.state || 'unknown';
    } else {
      const cached = HEALTH_CACHE.get(p.id);
      if (cached?.alive) state = 'up';
    }
    return {
      title: titleById.get(p.id),
      icon: `/api/status-icon/${statusIconKey(p.id)}`,
      state,
      uptime24h: summary?.uptime24h ?? null,
      uptime7d: summary?.uptime7d ?? null,
      avgLatency24h: summary?.avgLatency24h ?? null,
      bars: summary?.bars || null
    };
  });

  // 只保留公开服务的事件，并去掉 URL / 错误码 / 内部 ID
  const events = historyStore
    .recentEvents(100)
    .filter((e) => titleById.has(e.id))
    .slice(0, 8)
    .map((e) => ({
      title: titleById.get(e.id),
      type: e.type,
      at: e.at,
      durationMs: typeof e.durationMs === 'number' ? e.durationMs : null
    }));

  return { now, services, events };
}

function renderStatusSSR(htmlTemplate) {
  const payload = buildStatusPayload();
  const body =
    renderStatusBody(payload) +
    `<script id="status-data" type="application/json">${safeJsonForHtmlScript(payload)}</script>`;
  return htmlTemplate
    .replace(/\r\n/g, '\n')
    .replace(/<main class="status-main" id="statusRoot">\s*<\/main>/, `<main class="status-main" id="statusRoot">${body}</main>`);
}

async function sendHtml(req, res, html, cacheControl = 'public, max-age=0, must-revalidate') {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip')) {
    try {
      const gzipped = await new Promise((resolve, reject) => {
        zlib.gzip(Buffer.from(html, 'utf-8'), (err, buf) => (err ? reject(err) : resolve(buf)));
      });
      res.writeHead(200, { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.end(gzipped);
      return;
    } catch {
      // 回退到未压缩
    }
  }
  res.writeHead(200);
  res.end(html);
}

function isAdminRequest(req) {
  return Boolean(ADMIN_TOKEN) && tokenMatches(ADMIN_TOKEN, readBearerToken(req));
}

/* -------------------------------------------------------------------------- */
/* SSR                                                                       */
/* -------------------------------------------------------------------------- */

function iconUrlFor(project) {
  return `/api/icon/${encodeURIComponent(project.id)}`;
}

function renderCardHtml(project) {
  const parsed = parseHttpUrl(project.customWanUrl || '', { maxLength: MAX_URL_LENGTH });
  const targetUrl = parsed ? parsed.href : '';
  const pingEnabled = project.pingEnabled !== false;

  return renderProjectCard({
    id: project.id,
    title: project.title,
    url: targetUrl,
    iconSrc: targetUrl ? iconUrlFor(project) : '',
    status: pingEnabled ? statusView(HEALTH_CACHE.get(project.id)) : null,
    stripHtml: pingEnabled ? renderUptimeStrip(project.id, null) : ''
  });
}

function computeServerMetrics(projects) {
  const now = Date.now();
  const pingable = projects.filter((p) => p.pingEnabled !== false);
  const ids = new Set(projects.map((p) => p.id));

  let checked = 0;
  let online = 0;
  const latencies = [];
  const uptimes = [];
  const summaries = [];
  const services = [];
  for (const project of pingable) {
    const health = HEALTH_CACHE.get(project.id);
    services.push({ title: project.title || '未命名服务', cls: statusView(health).cls });
    if (health) {
      checked += 1;
      if (health.alive) {
        online += 1;
        if (typeof health.latency === 'number') latencies.push(health.latency);
      }
    }
    const summary = historyStore.summary(project.id, now);
    if (summary) summaries.push(summary);
    if (typeof summary?.uptime24h === 'number') uptimes.push(summary.uptime24h);
  }

  const average = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  return {
    total: projects.length,
    pingable: pingable.length,
    online: checked === pingable.length ? online : null,
    uptime: average(uptimes),
    latency: average(latencies),
    event: historyStore.recentEvents(20).find((e) => ids.has(e.id)) || null,
    services,
    series: aggregateSeries(summaries),
    now
  };
}

function renderPageSSR(htmlTemplate) {
  const projects = loadServerProjects();

  const now = new Date();
  // 服务器多为 UTC：问候语按东八区计算，避免凌晨显示「下午好」
  const { greeting } = getGreeting((now.getUTCHours() + 8) % 24);

  const poolHtml = renderPool({
    cardsHtml: projects.map(renderCardHtml).join(''),
    metrics: computeServerMetrics(projects)
  });

  const portalMeta = { adminEnabled: Boolean(ADMIN_TOKEN), notifyChannels: notifier.channels };
  const injectedScript =
    `<script id="initial-projects-data" type="application/json">${safeJsonForHtmlScript(projects)}</script>` +
    `<script id="portal-meta" type="application/json">${safeJsonForHtmlScript(portalMeta)}</script>`;
  const poolReplacement = `<section class="project-pool" id="projectPool">${poolHtml}</section>${injectedScript}`;

  // 兼容 dist 中 CRLF / LF
  const normalized = htmlTemplate.replace(/\r\n/g, '\n');

  return normalized
    .replace('<span id="greetingText">欢迎回来</span>', `<span id="greetingText">${escapeHtml(greeting)}</span>`)
    .replace('<span id="clockDate"></span>', `<span id="clockDate">${escapeHtml(formatDateLabel(now))}</span>`)
    .replace(
      /<section class="project-pool" id="projectPool">\s*(?:<!--\s*Rendered dynamically\s*-->\s*)?<\/section>/,
      poolReplacement
    );
}

/* -------------------------------------------------------------------------- */
/* HTTP 服务                                                                  */
/* -------------------------------------------------------------------------- */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.xml', '.ico']);
const fileCache = new Map();

function getCachedFile(filePath) {
  if (fileCache.has(filePath)) {
    return fileCache.get(filePath);
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const shouldCompress = COMPRESSIBLE_EXT.has(ext) && data.length > 256;
    const entry = {
      raw: data,
      gzip: shouldCompress ? zlib.gzipSync(data) : null,
      text: data.toString('utf-8')
    };
    fileCache.set(filePath, entry);
    return entry;
  }
  return null;
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // 不强制 CSP，避免破坏现有 inline onerror / style 行为
}

function applyCors(req, res) {
  if (!CORS_ORIGIN) return false;
  const requestOrigin = req.headers.origin;
  if (CORS_ORIGIN === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (requestOrigin && requestOrigin === CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Vary', 'Origin');
  } else {
    return false;
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

async function parseJsonBody(req, limitBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > limitBytes) {
      const err = new Error('BODY_TOO_LARGE');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(buf);
  }

  const body = Buffer.concat(chunks).toString('utf-8');
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function resolveSafeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const normalized = path.normalize(decoded).replace(/^([/\\])+/, path.sep);
  const resolved = path.resolve(DIST_DIR, `.${normalized}`);
  const relative = path.relative(DIST_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function cacheControlFor(pathname, ext) {
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (pathname === '/' || pathname === '/index.html' || ext === '.html') {
    return 'public, max-age=0, must-revalidate';
  }
  if (
    pathname === '/favicon.svg' ||
    pathname === '/favicon.ico' ||
    pathname === '/favicon.png' ||
    pathname === '/avatar.jpg'
  ) {
    return 'public, max-age=86400, must-revalidate';
  }
  if (ext === '.svg' || ext === '.ico' || ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    return 'public, max-age=604800, must-revalidate';
  }
  return 'public, max-age=0, must-revalidate';
}

async function resolveProbeJobs(body) {
  const trustedMap = getTrustedProjectMap();
  const jobs = [];
  const seen = new Set();

  const pushJob = (id, url, trusted) => {
    if (!isValidId(id) || seen.has(id)) return;
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return;
    seen.add(id);
    jobs.push({ id, url, trusted });
  };

  // 仅 ids：读取服务端可信配置（供运维/兼容）；浏览器自定义探测应走 items
  if (Array.isArray(body.ids)) {
    for (const id of body.ids.slice(0, MAX_BATCH_SIZE)) {
      const project = trustedMap.get(id);
      if (project?.customWanUrl) {
        pushJob(id, project.customWanUrl, true);
      }
    }
  }

  if (Array.isArray(body.items)) {
    for (const item of body.items.slice(0, MAX_BATCH_SIZE)) {
      if (!item || typeof item !== 'object') continue;
      const id = item.id;
      if (!isValidId(id) || seen.has(id)) continue;

      const serverProject = trustedMap.get(id);
      const clientUrl = typeof item.url === 'string' ? item.url : '';

      // 可信要求：id 相同且 URL 与服务端配置完全一致
      if (serverProject?.customWanUrl && clientUrl && urlsMatch(serverProject.customWanUrl, clientUrl)) {
        pushJob(id, serverProject.customWanUrl, true);
        continue;
      }

      if (clientUrl) {
        pushJob(id, clientUrl, false);
      }
    }
  }

  return jobs.slice(0, MAX_BATCH_SIZE);
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    if (!CORS_ORIGIN) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const pathname = parsedUrl.pathname;

  try {
    if (pathname === '/api/info') {
      sendJson(res, 200, {
        status: 'ok',
        ssr: true,
        cachedCount: HEALTH_CACHE.size,
        adminEnabled: Boolean(ADMIN_TOKEN)
      });
      return;
    }

    // 服务端项目的 24h / 7d 可用率与最近状态事件
    if (pathname === '/api/history' && req.method === 'GET') {
      sendJson(res, 200, buildHistoryPayload());
      return;
    }

    // 公开状态页数据（仅 statusPublic 服务，无 URL）
    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, buildStatusPayload());
      return;
    }

    if ((pathname === '/status' || pathname === '/status.html') && req.method === 'GET') {
      const statusEntry = getCachedFile(STATUS_FILE);
      if (!statusEntry) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing status.html');
        return;
      }
      await sendHtml(req, res, renderStatusSSR(statusEntry.text));
      return;
    }

    const iconMatch = pathname.match(/^\/api\/icon\/([^/]+)$/);
    if (iconMatch && req.method === 'GET') {
      let id = '';
      try {
        id = decodeURIComponent(iconMatch[1]);
      } catch {
        // 非法编码按不存在处理
      }
      await sendIcon(req, res, getTrustedProjectMap().get(id));
      return;
    }

    const statusIconMatch = pathname.match(/^\/api\/status-icon\/([0-9a-f]{16})$/);
    if (statusIconMatch && req.method === 'GET') {
      const project = loadServerProjects().find(
        (p) => p.statusPublic === true && statusIconKey(p.id) === statusIconMatch[1]
      );
      await sendIcon(req, res, project);
      return;
    }

    // 校验管理口令（前端登录用）
    if (pathname === '/api/auth' && req.method === 'POST') {
      if (!ADMIN_TOKEN) {
        sendJson(res, 404, { error: 'ADMIN_DISABLED' });
        return;
      }
      if (!checkRateLimit(getClientIp(req))) {
        sendJson(res, 429, { error: 'RATE_LIMITED' });
        return;
      }
      if (!isAdminRequest(req)) {
        sendJson(res, 401, { error: 'UNAUTHORIZED' });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // 整体替换服务端项目列表（需管理口令）
    if (pathname === '/api/projects' && req.method === 'PUT') {
      if (!ADMIN_TOKEN) {
        sendJson(res, 404, { error: 'ADMIN_DISABLED' });
        return;
      }
      if (!checkRateLimit(getClientIp(req))) {
        sendJson(res, 429, { error: 'RATE_LIMITED' });
        return;
      }
      if (!isAdminRequest(req)) {
        sendJson(res, 401, { error: 'UNAUTHORIZED' });
        return;
      }

      let body;
      try {
        body = await parseJsonBody(req, MAX_PROJECTS_BODY_BYTES);
      } catch (err) {
        if (err?.code === 'BODY_TOO_LARGE') {
          sendJson(res, 413, { error: 'BODY_TOO_LARGE' });
          return;
        }
        sendJson(res, 400, { error: 'INVALID_JSON' });
        return;
      }

      const result = sanitizeProjects(body?.projects);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }

      try {
        const saved = saveServerProjects(result.projects);
        runBackgroundHealthCheck();
        sendJson(res, 200, { projects: saved });
      } catch (err) {
        console.error('Failed to write projects.json:', err);
        sendJson(res, 500, { error: 'WRITE_FAILED' });
      }
      return;
    }

    // 发送一条测试通知（需管理口令）
    if (pathname === '/api/notify/test' && req.method === 'POST') {
      if (!ADMIN_TOKEN) {
        sendJson(res, 404, { error: 'ADMIN_DISABLED' });
        return;
      }
      if (!checkRateLimit(getClientIp(req))) {
        sendJson(res, 429, { error: 'RATE_LIMITED' });
        return;
      }
      if (!isAdminRequest(req)) {
        sendJson(res, 401, { error: 'UNAUTHORIZED' });
        return;
      }
      if (!notifier.enabled) {
        sendJson(res, 400, { error: 'NO_CHANNELS' });
        return;
      }
      const results = await notifier.send({ type: 'test', at: Date.now() });
      sendJson(res, 200, { results });
      return;
    }

    // 批量探针：items 中仅当 id+url 与服务端配置一致才 trusted；否则 SSRF 校验
    if (pathname === '/api/ping-batch' && req.method === 'POST') {
      const ip = getClientIp(req);
      if (!checkRateLimit(ip)) {
        sendJson(res, 429, { error: 'RATE_LIMITED' });
        return;
      }

      let body;
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        if (err?.code === 'BODY_TOO_LARGE') {
          sendJson(res, 413, { error: 'BODY_TOO_LARGE' });
          return;
        }
        sendJson(res, 400, { error: 'INVALID_JSON' });
        return;
      }

      const jobs = await resolveProbeJobs(body || {});
      const results = {};

      await mapPool(jobs, BATCH_PROBE_CONCURRENCY, async (job) => {
        const probeResult = await probeHttpEndpoint(job.url, {
          timeoutMs: 3000,
          trusted: job.trusted
        });
        const entry = {
          alive: Boolean(probeResult.alive),
          latency: probeResult.latency || null,
          statusCode: probeResult.statusCode || null,
          error: probeResult.error || null,
          lastChecked: Date.now()
        };
        results[job.id] = entry;
        if (job.trusted) {
          setHealthCache(job.id, entry);
        }
      });

      sendJson(res, 200, results);
      return;
    }

    // 只读取后台 HEALTH_CACHE，不在每次浏览器轮询时触发新一轮外连探测
    if (pathname === '/api/ping-all' && req.method === 'GET') {
      pruneHealthCache();
      const output = {};
      for (const [key, value] of HEALTH_CACHE.entries()) {
        output[key] = value;
      }
      if (HEALTH_CACHE.size === 0) {
        runBackgroundHealthCheck();
      }
      sendJson(res, 200, output);
      return;
    }

    // 单服务探针：id+url 与配置一致 → trusted；否则仅允许校验后的 url
    if (pathname === '/api/ping' && req.method === 'GET') {
      const ip = getClientIp(req);
      if (!checkRateLimit(ip)) {
        sendJson(res, 429, { error: 'RATE_LIMITED' });
        return;
      }

      const id = parsedUrl.searchParams.get('id');
      const targetUrl = parsedUrl.searchParams.get('url');

      if (id && isValidId(id) && targetUrl) {
        const project = getTrustedProjectMap().get(id);
        if (project?.customWanUrl && urlsMatch(project.customWanUrl, targetUrl)) {
          const cached = HEALTH_CACHE.get(id);
          if (cached && Date.now() - (cached.lastChecked || 0) < 8000) {
            sendJson(res, 200, cached);
            return;
          }
          const httpResult = await probeHttpEndpoint(project.customWanUrl, {
            timeoutMs: 3000,
            trusted: true
          });
          const entry = {
            alive: Boolean(httpResult.alive),
            latency: httpResult.latency || null,
            statusCode: httpResult.statusCode || null,
            error: httpResult.error || null,
            lastChecked: Date.now()
          };
          setHealthCache(id, entry);
          sendJson(res, 200, entry);
          return;
        }
      }

      if (targetUrl) {
        const httpResult = await probeHttpEndpoint(targetUrl, {
          timeoutMs: 3000,
          trusted: false
        });
        sendJson(res, 200, {
          alive: Boolean(httpResult.alive),
          latency: httpResult.latency || null,
          statusCode: httpResult.statusCode || null,
          error: httpResult.error || null,
          lastChecked: Date.now()
        });
        return;
      }

      sendJson(res, 400, { alive: false, error: 'MISSING_TARGET' });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const indexEntry = getCachedFile(INDEX_FILE);
      if (!indexEntry) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing index.html');
        return;
      }

      // 主页内嵌了服务地址：禁止 CDN 等共享缓存保存
      await sendHtml(req, res, renderPageSSR(indexEntry.text), 'private, no-cache');
      return;
    }

    let filePath = resolveSafeStaticPath(pathname);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      // SPA fallback 仅回退到 index.html，不暴露仓库根目录
      filePath = INDEX_FILE;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileEntry = getCachedFile(filePath);

    if (!fileEntry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    res.setHeader('Cache-Control', cacheControlFor(pathname, ext));
    const acceptEncoding = req.headers['accept-encoding'] || '';

    if (acceptEncoding.includes('gzip') && fileEntry.gzip) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding'
      });
      res.end(fileEntry.gzip);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fileEntry.raw);
    }
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'INTERNAL_ERROR' });
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Schrödinger's Portal listening on :${PORT}`);
  console.log(`Admin editing: ${ADMIN_TOKEN ? 'enabled' : 'disabled (set ADMIN_TOKEN to enable)'}`);
  console.log(`Notify channels: ${notifier.channels.length ? notifier.channels.join(', ') : 'none'}`);
});

// Docker 中 node 为 PID 1，需要自行处理信号；退出前落盘历史
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    saveHistory();
    server.close();
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
