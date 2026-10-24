import http from 'http';
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import https from 'https';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { escapeHtml, escapeAttribute, safeJsonForHtmlScript } from './shared/escape.js';
import { getGreeting } from './shared/greeting.js';
import { getProjectNativeFavicon } from './shared/favicon.js';
import { parseHttpUrl } from './shared/url.js';
import { validateProbeTarget, createPinnedLookup } from './shared/ssrf.js';
import { renderUptimeStrip } from './shared/uptime.js';
import { HistoryStore } from './lib/history.js';
import { createNotifier } from './lib/notify.js';
import { sanitizeProjects, writeJsonAtomic, tokenMatches, readBearerToken } from './lib/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DIST_DIR = path.join(__dirname, 'dist');
const INDEX_FILE = path.join(DIST_DIR, 'index.html');
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const ALLOW_INSECURE_TLS = String(process.env.ALLOW_INSECURE_TLS || 'false').toLowerCase() === 'true';
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const CONFIG_PATH = path.join(__dirname, 'config', 'projects.json');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

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
      const data = JSON.parse(content);
      // 管理员通过页面清空列表时文件为 []，同样视为有效配置
      if (Array.isArray(data)) {
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
  historyStore.prune(new Set(saved.map((p) => p.id)));
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
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
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
  try {
    return await new Promise((resolve) => {
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
            probeHttpEndpoint(nextUrl, {
              timeoutMs,
              redirectCount: redirectCount + 1,
              trusted: redirectTrusted
            }).then(finish);
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
  return { now, services, events: historyStore.recentEvents(20) };
}

function isAdminRequest(req) {
  return Boolean(ADMIN_TOKEN) && tokenMatches(ADMIN_TOKEN, readBearerToken(req));
}

/* -------------------------------------------------------------------------- */
/* SSR                                                                       */
/* -------------------------------------------------------------------------- */

function resolveFaviconForProject(project, targetUrl) {
  return getProjectNativeFavicon(targetUrl || project.customWanUrl);
}

function renderCardHtml(project) {
  const rawUrl = project.customWanUrl || '';
  const parsed = parseHttpUrl(rawUrl, { maxLength: MAX_URL_LENGTH });
  const targetUrl = parsed ? parsed.href : '#';
  const hostname = parsed ? parsed.hostname : '';
  const iconSrc = resolveFaviconForProject(project, parsed ? parsed.href : '');
  const title = project.title || '未命名服务';

  const health = HEALTH_CACHE.get(project.id);
  let statusClass = 'checking';
  let statusLabel = '检测中';
  if (health) {
    if (health.alive) {
      statusClass = 'online';
      statusLabel = health.latency != null ? `在线 · ${health.latency} ms` : '在线';
    } else {
      statusClass = 'offline';
      statusLabel = '不可用';
    }
  }

  const safeId = escapeAttribute(project.id || '');
  const safeTitle = escapeHtml(title);
  const safeTitleAttr = escapeAttribute(title);
  const safeUrl = escapeAttribute(targetUrl);
  const safeIcon = escapeAttribute(iconSrc);
  const safeHost = escapeHtml(hostname);

  return `
    <div class="project-card" data-id="${safeId}" data-url="${safeUrl}" tabindex="0" role="link">
      <div class="card-top">
        <div class="card-identity">
          <div class="card-icon-box">
            <img src="${safeIcon}" alt="${safeTitleAttr}" width="28" height="28" class="card-favicon-img" loading="eager" decoding="async" onerror="this.onerror=null;this.src='/favicon.svg';" />
          </div>
          <div class="card-text">
            <div class="card-title" title="${safeTitleAttr}">${safeTitle}</div>
            ${hostname ? `<div class="card-hostname">${safeHost}</div>` : ''}
          </div>
        </div>
        <div class="card-status-badge ${statusClass}" id="status-${safeId}">
          <span class="status-dot"></span>
          <span class="status-text">${escapeHtml(statusLabel)}</span>
        </div>
      </div>

      ${project.pingEnabled !== false ? renderUptimeStrip(project.id, null) : ''}

      <div class="card-footer">
        <div class="card-manage-actions">
          <button class="card-action-btn copy-btn" data-url="${safeUrl}" title="复制直达链接">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button class="card-action-btn edit-btn" data-id="${safeId}" title="编辑服务">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button class="card-action-btn delete-btn" data-id="${safeId}" title="删除服务">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
        <a href="${safeUrl}" target="_blank" rel="noreferrer" class="btn-launch" title="直达打开服务">
          <span>直达</span>
          <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </a>
      </div>
    </div>
  `;
}

function renderPageSSR(htmlTemplate) {
  const projects = loadServerProjects();

  let onlineCount = 0;
  let checkedCount = 0;
  projects.forEach((p) => {
    const h = HEALTH_CACHE.get(p.id);
    if (!h) return;
    checkedCount += 1;
    if (h.alive) onlineCount += 1;
  });
  const onlineDisplay = checkedCount === 0 ? '—' : String(onlineCount);

  const now = new Date();
  const hours = (now.getUTCHours() + 8) % 24;
  const { greeting, icon } = getGreeting(hours);
  const timeStr = `${String(hours).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${days[now.getDay()]}`;

  const poolHtml = `
    <div class="category-section">
      <div class="section-header">
        <div class="section-header-inline">
          <h2 class="sec-name">服务列表</h2>
          <button class="section-refresh-btn" id="refreshPingBtn" title="重新探测服务状态">
            <svg class="btn-svg spin-on-click" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6M1 20v-6h6"></path>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
          <div class="stat-inline">
            <span class="stat-label">服务</span>
            <span class="stat-num" id="metricTotal">${projects.length}</span>
          </div>
          <div class="stat-inline">
            <span class="stat-label">在线</span>
            <span class="stat-num online" id="metricOnline">${escapeHtml(onlineDisplay)}</span>
          </div>
        </div>
      </div>
      <div class="cards-grid">
        ${projects.map(renderCardHtml).join('')}
      </div>
    </div>
  `;

  const portalMeta = { adminEnabled: Boolean(ADMIN_TOKEN), notifyChannels: notifier.channels };
  const injectedScript =
    `<script id="initial-projects-data" type="application/json">${safeJsonForHtmlScript(projects)}</script>` +
    `<script id="portal-meta" type="application/json">${safeJsonForHtmlScript(portalMeta)}</script>`;
  const poolReplacement = `<section class="project-pool" id="projectPool">${poolHtml}</section>${injectedScript}`;

  // 兼容 dist 中 CRLF / LF
  const normalized = htmlTemplate.replace(/\r\n/g, '\n');

  return normalized
    .replace('<span class="greeting-icon" id="greetingIcon">✨</span>', `<span class="greeting-icon" id="greetingIcon">${icon}</span>`)
    .replace('<span class="greeting-text" id="greetingText">欢迎回来</span>', `<span class="greeting-text" id="greetingText">${escapeHtml(greeting)}</span>`)
    .replace('<span class="clock-time" id="clockTime">00:00:00</span>', `<span class="clock-time" id="clockTime">${timeStr}</span>`)
    .replace('<span class="clock-date" id="clockDate">2026年8月14日 星期五</span>', `<span class="clock-date" id="clockDate">${escapeHtml(dateStr)}</span>`)
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

      const ssrHtml = renderPageSSR(indexEntry.text);
      const acceptEncoding = req.headers['accept-encoding'] || '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

      if (acceptEncoding.includes('gzip')) {
        try {
          const gzipped = await new Promise((resolve, reject) => {
            zlib.gzip(Buffer.from(ssrHtml, 'utf-8'), (err, buf) => (err ? reject(err) : resolve(buf)));
          });
          res.writeHead(200, {
            'Content-Encoding': 'gzip',
            Vary: 'Accept-Encoding'
          });
          res.end(gzipped);
        } catch {
          res.writeHead(200);
          res.end(ssrHtml);
        }
      } else {
        res.writeHead(200);
        res.end(ssrHtml);
      }
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
