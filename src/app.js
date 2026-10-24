import { DEFAULT_CONFIG } from './data/defaultConfig.js';
import { PingService } from './services/pingService.js';
import { escapeHtml } from '../shared/escape.js';
import { getGreeting, formatDateLabel, formatClock } from '../shared/greeting.js';
import { browserIconFor, renderIconBox } from '../shared/favicon.js';
import {
  renderProjectCard,
  renderPool,
  statusView,
  formatMetrics,
  aggregateSeries,
  renderDots,
  renderSeriesBars,
  renderSparkline
} from '../shared/card.js';
import { isValidHttpUrl, parseHttpUrl } from '../shared/url.js';
import { renderUptimeInner, renderUptimeStrip } from '../shared/uptime.js';

const STORAGE_KEY = 'SCHRODINGER_PORTAL';
const LEGACY_STORAGE_KEY = 'SCHRODINGER_PORTAL_V18';
const ADMIN_TOKEN_KEY = 'SCHRODINGER_PORTAL_ADMIN_TOKEN';
const SCHEMA_VERSION = 1;
const HISTORY_REFRESH_MS = 60 * 1000;

const SAVE_ERROR_TEXT = {
  INVALID_URL: '存在无效的服务链接',
  INVALID_TITLE: '服务名称不能为空',
  INVALID_ID: '服务 ID 含有不支持的字符',
  INVALID_ICON_URL: '图标地址无效',
  DUPLICATE_ID: '服务 ID 重复',
  TOO_MANY_PROJECTS: '服务数量超出上限',
  WRITE_FAILED: '服务器写入配置失败，请检查 config 目录权限',
  RATE_LIMITED: '操作过于频繁，请稍后再试'
};

function readJsonScript(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

function formatSlotTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

class App {
  constructor() {
    this.ssrProjects = null;
    this.trustedUrlById = new Map();
    this.loadState();
    this.searchQuery = '';
    this.selectedSearchResultIndex = 0;
    this.searchResults = [];
    this.poolDelegated = false;
    this.clockTimer = null;
    this.lastFocusedBeforeModal = null;
    this.subtitleRevealed = false;
    this.historySummaries = {};
    this.historyEvents = [];
    this.historyTimer = null;
    this.authResolver = null;

    this.pingService = new PingService((statusMap) => {
      this.statusMap = statusMap;
      this.updateStatusBadges();
      this.updateMetrics();
    });

    this.statusMap = {};
    this.init();
  }

  /* -------------------------------------------------------------------------- */
  /* Persistence                                                                */
  /* -------------------------------------------------------------------------- */

  loadState() {
    const meta = readJsonScript('portal-meta') || {};
    // 服务器模式：服务端设置了 ADMIN_TOKEN，项目列表以服务器为准
    this.serverMode = Boolean(meta.adminEnabled);
    this.notifyChannels = Array.isArray(meta.notifyChannels) ? meta.notifyChannels : [];
    this.adminToken = this.serverMode ? safeStorageGet(ADMIN_TOKEN_KEY) : null;

    const parsedSsr = readJsonScript('initial-projects-data');
    let ssrProjects = null;
    if (Array.isArray(parsedSsr) && (parsedSsr.length > 0 || this.serverMode)) {
      ssrProjects = parsedSsr;
    }

    this.ssrProjects = ssrProjects;
    this.setTrustedProjects(ssrProjects || DEFAULT_CONFIG.projects);
    this.localOnlyProjects = null;

    try {
      let saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          saved = legacy;
          localStorage.setItem(STORAGE_KEY, legacy);
        }
      }

      if (saved) {
        this.config = JSON.parse(saved);
        if (!this.config.projects || this.config.projects.length === 0) {
          this.config.projects = ssrProjects || DEFAULT_CONFIG.projects;
        }
        if (!this.config.profile) this.config.profile = DEFAULT_CONFIG.profile;
        if (!this.config.settings) this.config.settings = DEFAULT_CONFIG.settings;
        this.config.categories = DEFAULT_CONFIG.categories;
        this.config.schemaVersion = SCHEMA_VERSION;
        if (this.serverMode && ssrProjects) {
          // 保留旧的本地列表，供登录后一次性迁移到服务器
          const local = this.config.projects;
          if (!this.sameProjects(local, ssrProjects) && !this.sameProjects(local, DEFAULT_CONFIG.projects)) {
            this.localOnlyProjects = this.config.projects;
          }
          this.config.projects = ssrProjects;
        }
      } else {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        this.config.schemaVersion = SCHEMA_VERSION;
        if (ssrProjects) this.config.projects = ssrProjects;
      }
    } catch {
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this.config.schemaVersion = SCHEMA_VERSION;
      if (ssrProjects) this.config.projects = ssrProjects;
    }

    if (!this.config.settings.theme) {
      this.config.settings.theme = 'light';
    }
  }

  persistState() {
    this.config.schemaVersion = SCHEMA_VERSION;
    const snapshot = this.serverMode
      ? { ...this.config, projects: this.localOnlyProjects || undefined }
      : this.config;
    safeStorageSet(STORAGE_KEY, JSON.stringify(snapshot));
  }

  setTrustedProjects(projects) {
    this.trustedUrlById = new Map();
    for (const project of projects) {
      if (project?.id && project?.customWanUrl) {
        const parsed = parseHttpUrl(project.customWanUrl);
        if (parsed) this.trustedUrlById.set(project.id, parsed.href);
      }
    }
  }

  sameProjects(a, b) {
    const key = (list) =>
      JSON.stringify(
        (list || []).map((p) => [
          p.id,
          p.title,
          parseHttpUrl(p.customWanUrl)?.href || '',
          p.pingEnabled !== false,
          p.statusPublic === true,
          p.iconUrl || ''
        ])
      );
    return key(a) === key(b);
  }

  /* -------------------------------------------------------------------------- */
  /* Server sync                                                                */
  /* -------------------------------------------------------------------------- */

  /** 保存项目列表：服务器模式写回 config/projects.json，本地模式写 LocalStorage */
  async commitProjects(nextProjects) {
    if (!this.serverMode) {
      this.config.projects = nextProjects;
      this.persistState();
      return true;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.ensureAdminToken();
      if (!token) return false;

      let res;
      try {
        res = await fetch('/api/projects', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ projects: nextProjects }),
          signal: AbortSignal.timeout(8000)
        });
      } catch {
        this.showToast('无法连接服务器，修改未保存', '⚠️');
        return false;
      }

      if (res.status === 401) {
        this.setAdminToken(null);
        this.showToast('管理口令已失效，请重新输入', '🔒');
        continue;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.projects)) {
        this.showToast(SAVE_ERROR_TEXT[data.error] || '保存失败', '⚠️');
        return false;
      }

      this.config.projects = data.projects;
      this.setTrustedProjects(data.projects);
      return true;
    }
    return false;
  }

  setAdminToken(token) {
    this.adminToken = token || null;
    safeStorageSet(ADMIN_TOKEN_KEY, this.adminToken);
    this.renderAdminStatus();
  }

  async verifyAdminToken(token) {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) return 'ok';
      if (res.status === 429) return 'rate_limited';
      return 'invalid';
    } catch {
      return 'network';
    }
  }

  /** 返回已保存的口令；没有则弹出登录框等待输入 */
  ensureAdminToken() {
    if (this.adminToken) return Promise.resolve(this.adminToken);
    return new Promise((resolve) => {
      this.authResolver = resolve;
      const input = document.getElementById('authTokenInput');
      if (input) input.value = '';
      const errorEl = document.getElementById('authError');
      if (errorEl) errorEl.textContent = '';
      this.openOverlay('authModalOverlay', '#authTokenInput');
    });
  }

  async handleAuthSubmit() {
    const input = document.getElementById('authTokenInput');
    const errorEl = document.getElementById('authError');
    const token = input?.value.trim() || '';
    if (!token) return;

    const verdict = await this.verifyAdminToken(token);
    if (verdict !== 'ok') {
      if (errorEl) {
        errorEl.textContent =
          verdict === 'invalid' ? '口令不正确' : verdict === 'rate_limited' ? '尝试过于频繁，请稍后再试' : '无法连接服务器';
      }
      return;
    }

    this.setAdminToken(token);
    const resolve = this.authResolver;
    this.authResolver = null;
    this.closeOverlay('authModalOverlay');
    this.showToast('已进入管理模式', '🔓');
    if (resolve) resolve(token);
  }

  cancelAuth() {
    const resolve = this.authResolver;
    this.authResolver = null;
    this.closeOverlay('authModalOverlay');
    if (resolve) resolve(null);
  }

  /** 把本浏览器以前在本地模式下保存的服务列表上传到服务器 */
  async migrateLocalProjects() {
    const local = this.localOnlyProjects;
    if (!local) return;
    if (!confirm(`将用此浏览器保存的 ${local.length} 个本地服务覆盖服务器上的列表，确定吗？`)) return;
    if (!(await this.commitProjects(local))) return;
    this.localOnlyProjects = null;
    this.persistState();
    this.closeSettingsModal();
    this.renderProjectPool();
    this.showToast('本地服务已同步到服务器', '☁️');
  }

  discardLocalProjects() {
    if (!confirm('丢弃此浏览器保存的本地服务列表？服务器上的列表不受影响。')) return;
    this.localOnlyProjects = null;
    this.persistState();
    this.renderAdminStatus();
  }

  renderAdminStatus() {
    const box = document.getElementById('adminStatus');
    if (!box) return;
    const text = box.querySelector('.admin-status-text');
    const loginBtn = document.getElementById('adminLoginBtn');
    const logoutBtn = document.getElementById('adminLogoutBtn');
    const testBtn = document.getElementById('notifyTestBtn');
    const migrateRow = document.getElementById('migrateRow');
    if (migrateRow) {
      migrateRow.hidden = !(this.serverMode && this.localOnlyProjects);
      const label = migrateRow.querySelector('.migrate-text');
      if (label && this.localOnlyProjects) {
        label.textContent = `此浏览器还保存着 ${this.localOnlyProjects.length} 个旧的本地服务。`;
      }
    }

    if (!this.serverMode) {
      text.textContent = '本地模式：修改只保存在当前浏览器。服务端设置 ADMIN_TOKEN 后可同步到服务器。';
      [loginBtn, logoutBtn, testBtn].forEach((btn) => btn && (btn.hidden = true));
      return;
    }

    const channels = this.notifyChannels.length ? this.notifyChannels.join(' / ') : '未配置';
    text.textContent = this.adminToken
      ? `服务器模式 · 已登录，修改会写入服务器。通知通道：${channels}`
      : '服务器模式 · 未登录，添加或编辑服务时需要管理口令。';
    if (loginBtn) loginBtn.hidden = Boolean(this.adminToken);
    if (logoutBtn) logoutBtn.hidden = !this.adminToken;
    if (testBtn) testBtn.hidden = !this.adminToken || this.notifyChannels.length === 0;
  }

  async sendTestNotification() {
    const token = await this.ensureAdminToken();
    if (!token) return;
    try {
      const res = await fetch('/api/notify/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.showToast('测试通知发送失败', '⚠️');
        return;
      }
      const failed = (data.results || []).filter((r) => !r.ok).map((r) => r.channel);
      this.showToast(failed.length ? `部分通道失败：${failed.join(', ')}` : '测试通知已发送', failed.length ? '⚠️' : '🔔');
    } catch {
      this.showToast('无法连接服务器', '⚠️');
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Uptime history                                                             */
  /* -------------------------------------------------------------------------- */

  async refreshHistory() {
    if (!this.pingService.hasBackend || document.visibilityState === 'hidden') return;
    try {
      const res = await fetch('/api/history', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      this.historySummaries = data?.services || {};
      this.historyEvents = Array.isArray(data?.events) ? data.events : [];
      this.updateUptimeStrips();
      this.renderMetrics();
    } catch {
      // ignore
    }
  }

  startHistoryPolling() {
    if (!this.pingService.hasBackend) return;
    this.refreshHistory();
    this.historyTimer = setInterval(() => this.refreshHistory(), HISTORY_REFRESH_MS);
  }

  /** 只有服务端可信项目才有历史；本地自定义项目不显示可用率条 */
  hasUptimeStrip(project) {
    return project.pingEnabled !== false && this.isTrustedProject(project, this.buildProjectUrl(project));
  }

  updateUptimeStrips() {
    this.config.projects.forEach((project) => {
      const el = document.getElementById(`uptime-${project.id}`);
      if (!el) return;
      el.innerHTML = renderUptimeInner(this.historySummaries[project.id] || null, formatSlotTime);
    });
  }

  isTrustedProject(project, url) {
    if (!project?.id || !url) return false;
    const canonical = this.trustedUrlById.get(project.id);
    if (!canonical) return false;
    const parsed = parseHttpUrl(url);
    return Boolean(parsed && parsed.href === canonical);
  }

  ssrDomMatchesConfig() {
    const existingCards = document.querySelectorAll('.project-card');
    const projects = this.config.projects;
    if (existingCards.length !== projects.length) return false;

    return [...existingCards].every((card, index) => {
      const project = projects[index];
      if (!project) return false;
      const expectedUrl = this.buildProjectUrl(project) || '';
      return card.getAttribute('data-id') === project.id && card.getAttribute('data-url') === expectedUrl;
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Init                                                                       */
  /* -------------------------------------------------------------------------- */

  async init() {
    const themeParam = new URLSearchParams(window.location.search).get('theme');
    const bootstrapped = document.documentElement.getAttribute('data-theme');
    const initialTheme =
      themeParam && ['light', 'dark', 'auto'].includes(themeParam)
        ? themeParam
        : this.config.settings.theme || bootstrapped || 'light';
    this.applyTheme(initialTheme, { persist: false });

    await this.pingService.checkBackend();
    this.bindEvents();
    this.ensurePoolDelegation();
    this.startClock();
    this.setupVisibilityHandling();
    this.revealSubtitleOnce();
    this.updateSearchShortcutLabel();

    if (this.ssrDomMatchesConfig()) {
      this.bindRefreshBtn();
      this.renderMetrics();
      this.enhanceExistingCards();
    } else {
      this.renderProjectPool();
      this.renderHeader();
    }

    this.startHistoryPolling();
    this.renderAdminStatus();

    if (this.config.settings.autoPing) {
      this.pingService.start(
        () => this.config.projects,
        (project) => this.buildProjectUrl(project),
        this.config.settings.pingIntervalSeconds || 20,
        () => ({
          isTrusted: (project, url) => this.isTrustedProject(project, url)
        })
      );
    }
  }

  enhanceExistingCards() {
    document.querySelectorAll('.project-card').forEach((card, index) => {
      card.style.animationDelay = `${Math.min(index * 28, 200)}ms`;
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Helpers                                                                    */
  /* -------------------------------------------------------------------------- */

  buildProjectUrl(project) {
    if (project.customWanUrl) {
      const parsed = parseHttpUrl(project.customWanUrl);
      return parsed ? parsed.href : '';
    }
    const host = this.config.profile.wanDomain || 'example.com';
    const protocol = project.protocol || 'https';
    if (protocol !== 'http' && protocol !== 'https') return '';
    const portPart = project.port ? `:${project.port}` : '';
    const pathPart = project.path || '/';
    const candidate = `${protocol}://${host}${portPart}${pathPart}`;
    return isValidHttpUrl(candidate) ? candidate : '';
  }

  /** 服务端配置中的服务由服务端代取图标；仅存在于本地的服务由浏览器直接加载 */
  iconFor(project, targetUrl) {
    if (this.pingService.hasBackend && this.isTrustedProject(project, targetUrl)) {
      return `/api/icon/${encodeURIComponent(project.id)}`;
    }
    return browserIconFor(targetUrl, project.iconUrl);
  }

  getHostname(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  openSafeUrl(url) {
    if (!isValidHttpUrl(url)) {
      this.showToast('链接无效，已拦截不安全地址', '⚠️');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  applyTheme(theme, { persist = true } = {}) {
    document.documentElement.setAttribute('data-theme', theme);
    this.config.settings.theme = theme;
    document.querySelectorAll('.theme-option').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-theme-val') === theme);
    });
    if (persist) this.persistState();
  }

  showToast(message, icon = '✨') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    toast.append(iconSpan, document.createTextNode(' '), messageSpan);
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      toast.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
      setTimeout(() => toast.remove(), 220);
    }, 2200);
  }

  prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  revealSubtitleOnce() {
    if (this.subtitleRevealed) return;
    const el = document.getElementById('headerSubtitle');
    if (!el) return;
    const text = el.textContent || '';
    if (this.prefersReducedMotion()) {
      this.subtitleRevealed = true;
      return;
    }
    el.textContent = '';
    [...text].forEach((ch, index) => {
      const span = document.createElement('span');
      span.className = 'reveal-char';
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      span.style.animationDelay = `${index * 32}ms`;
      el.appendChild(span);
    });
    this.subtitleRevealed = true;
  }

  updateSearchShortcutLabel() {
    const kbd = document.querySelector('#searchTriggerBtn .kbd-badge');
    if (!kbd) return;
    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
    kbd.textContent = isMac ? '⌘ K' : 'Ctrl K';
  }

  /* -------------------------------------------------------------------------- */
  /* Clock / Visibility                                                         */
  /* -------------------------------------------------------------------------- */

  startClock() {
    const update = () => {
      const now = new Date();
      const clockTime = document.getElementById('clockTime');
      const clockDate = document.getElementById('clockDate');
      const greetingText = document.getElementById('greetingText');
      if (clockTime) clockTime.textContent = formatClock(now);
      if (clockDate) clockDate.textContent = formatDateLabel(now);
      if (greetingText) greetingText.textContent = getGreeting(now.getHours()).greeting;
    };

    update();
    this.clockTimer = setInterval(update, 1000);
  }

  setupVisibilityHandling() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.pingService.pause();
        if (this.clockTimer) {
          clearInterval(this.clockTimer);
          this.clockTimer = null;
        }
      } else {
        this.startClock();
        this.pingService.resume();
      }
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Render                                                                     */
  /* -------------------------------------------------------------------------- */

  renderHeader() {
    const p = this.config.profile;
    const headerTitle = document.getElementById('headerTitle');
    const headerSubtitle = document.getElementById('headerSubtitle');
    if (headerTitle) headerTitle.textContent = p.title || '薛定谔的项目';
    if (headerSubtitle) {
      headerSubtitle.textContent = p.subtitle || '心之所向，触手可及';
      this.subtitleRevealed = false;
      this.revealSubtitleOnce();
    }
  }

  collectMetrics() {
    const projects = this.config.projects;
    const pingable = projects.filter((p) => p.pingEnabled);
    const results = pingable.map((p) => this.statusMap[p.id]).filter(Boolean);
    const allDone =
      pingable.length === 0 ||
      (results.length === pingable.length && results.every((st) => !st.checking));

    const average = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
    const ids = new Set(projects.map((p) => p.id));
    const latencies = results.filter((st) => st.alive && typeof st.latency === 'number').map((st) => st.latency);
    const summaries = pingable.map((p) => this.historySummaries[p.id]).filter(Boolean);
    const uptimes = summaries.map((s) => s.uptime24h).filter((u) => typeof u === 'number');

    return {
      total: projects.length,
      pingable: pingable.length,
      online: allDone ? results.filter((st) => st.alive).length : null,
      uptime: average(uptimes),
      latency: average(latencies),
      event: this.historyEvents.find((e) => ids.has(e.id)) || null,
      services: pingable.map((p) => ({ title: p.title || '未命名服务', cls: statusView(this.statusMap[p.id]).cls })),
      series: aggregateSeries(summaries),
      now: Date.now()
    };
  }

  renderMetrics() {
    const metrics = this.collectMetrics();
    const v = formatMetrics(metrics);
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const html = (id, markup) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = markup;
    };
    set('metricOnline', v.online);
    set('metricTotal', v.total);
    set('metricUptime', v.uptime);
    set('metricLatency', v.latency);
    set('metricEvent', v.eventTitle);
    set('metricEventTime', v.eventTime);
    html('metricDots', renderDots(metrics.services));
    html('metricUptimeViz', renderSeriesBars(metrics.series));
    html('metricLatencyViz', renderSparkline(metrics.series));
    document.getElementById('metricDot')?.setAttribute('data-level', v.level);
    document.getElementById('metricEventTile')?.setAttribute('data-type', v.eventType);
  }

  updateMetrics() {
    this.renderMetrics();
  }

  renderProjectPool() {
    const pool = document.getElementById('projectPool');
    if (!pool) return;

    pool.innerHTML = renderPool({
      cardsHtml: this.config.projects.map((p, index) => this.renderProjectCard(p, index)).join(''),
      metrics: this.collectMetrics()
    });

    this.bindRefreshBtn();
    this.updateStatusBadges();
  }

  bindRefreshBtn() {
    const refreshPingBtn = document.getElementById('refreshPingBtn');
    if (!refreshPingBtn || refreshPingBtn.dataset.bound === '1') return;
    refreshPingBtn.dataset.bound = '1';
    refreshPingBtn.addEventListener('click', () => {
      const svg = refreshPingBtn.querySelector('.spin-on-click');
      svg?.classList.add('spinning');
      this.showToast('正在同步服务状态...', '⚡');
      this.pingService
        .probeAll(this.config.projects, (p) => this.buildProjectUrl(p), {
          isTrusted: (project, url) => this.isTrustedProject(project, url)
        })
        .then(() => setTimeout(() => svg?.classList.remove('spinning'), 500));
    });
  }

  renderProjectCard(project, index = 0) {
    const targetUrl = this.buildProjectUrl(project);
    return renderProjectCard({
      id: project.id,
      title: project.title,
      url: targetUrl,
      iconSrc: this.iconFor(project, targetUrl),
      status: project.pingEnabled ? statusView(this.statusMap[project.id]) : null,
      stripHtml: this.hasUptimeStrip(project)
        ? renderUptimeStrip(project.id, this.historySummaries[project.id] || null, formatSlotTime)
        : '',
      delayMs: Math.min(index * 28, 200)
    });
  }

  updateStatusBadges() {
    this.config.projects.forEach((proj) => {
      const el = document.getElementById(`status-${proj.id}`);
      if (!el) return;
      const st = this.statusMap[proj.id];
      if (!st || !proj.pingEnabled) {
        el.className = 'card-status-badge';
        el.style.display = 'none';
        return;
      }

      const view = statusView(st);
      el.style.display = '';
      el.className = `card-status-badge ${view.cls}`;
      const textEl = el.querySelector('.status-text');
      if (textEl) textEl.textContent = view.label;
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Events                                                                     */
  /* -------------------------------------------------------------------------- */

  ensurePoolDelegation() {
    if (this.poolDelegated) return;
    const pool = document.getElementById('projectPool');
    if (!pool) return;
    this.poolDelegated = true;

    pool.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.copy-btn');
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const url = copyBtn.getAttribute('data-url');
        if (url && isValidHttpUrl(url)) {
          navigator.clipboard.writeText(url).then(() => this.showToast('已复制直达链接', '📋'));
        } else {
          this.showToast('链接无效，无法复制', '⚠️');
        }
        return;
      }

      const editBtn = e.target.closest('.edit-btn');
      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.openProjectModal(editBtn.getAttribute('data-id'));
        return;
      }

      const deleteBtn = e.target.closest('.delete-btn');
      if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        const id = deleteBtn.getAttribute('data-id');
        const proj = this.config.projects.find((p) => p.id === id);
        if (confirm(`确定要移除服务「${proj ? proj.title : id}」吗？`)) {
          this.commitProjects(this.config.projects.filter((p) => p.id !== id)).then((ok) => {
            if (!ok) return;
            delete this.statusMap[id];
            this.renderProjectPool();
            this.showToast('服务已移除', '🗑️');
          });
        }
        return;
      }

      if (e.target.closest('a, button')) return;

      const card = e.target.closest('.project-card');
      if (!card) return;
      const url = card.getAttribute('data-url');
      if (url && url !== '#') this.openSafeUrl(url);
    });

    pool.addEventListener('keydown', (e) => {
      const card = e.target.closest('.project-card');
      if (!card || e.target.closest('a, button')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const url = card.getAttribute('data-url');
        if (url && url !== '#') this.openSafeUrl(url);
      }
    });
  }

  bindEvents() {
    const themeBtn = document.getElementById('themeBtn');
    const themeMenu = document.getElementById('themeMenu');
    themeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      themeMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => themeMenu?.classList.remove('show'));

    document.querySelectorAll('.theme-option').forEach((opt) => {
      opt.addEventListener('click', () => {
        const t = opt.getAttribute('data-theme-val');
        this.applyTheme(t);
        this.showToast(`已切换主题为「${opt.textContent.trim()}」`, '🎨');
      });
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openSearchModal();
      }
      if (e.key === 'Escape') this.closeAllModals();
    });

    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.closeAllModals();
      });
    });

    document.getElementById('searchTriggerBtn')?.addEventListener('click', () => this.openSearchModal());
    document.getElementById('closeSearchKbdBtn')?.addEventListener('click', () => this.closeSearchModal());
    document.getElementById('addProjectBtn')?.addEventListener('click', () => this.openProjectModal());
    document.getElementById('closeProjectModalBtn')?.addEventListener('click', () => this.closeProjectModal());
    document.getElementById('cancelProjectBtn')?.addEventListener('click', () => this.closeProjectModal());
    document.getElementById('settingsBtn')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('closeSettingsModalBtn')?.addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('cancelSettingsBtn')?.addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('saveSettingsBtn')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('closeAuthModalBtn')?.addEventListener('click', () => this.cancelAuth());
    document.getElementById('cancelAuthBtn')?.addEventListener('click', () => this.cancelAuth());
    document.getElementById('authForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleAuthSubmit();
    });
    document.getElementById('adminLoginBtn')?.addEventListener('click', () => {
      this.closeSettingsModal();
      this.ensureAdminToken();
    });
    document.getElementById('adminLogoutBtn')?.addEventListener('click', () => {
      this.setAdminToken(null);
      this.showToast('已退出管理模式', '🔒');
    });
    document.getElementById('notifyTestBtn')?.addEventListener('click', () => this.sendTestNotification());
    document.getElementById('migrateLocalBtn')?.addEventListener('click', () => this.migrateLocalProjects());
    document.getElementById('discardLocalBtn')?.addEventListener('click', () => this.discardLocalProjects());

    document.getElementById('projectForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleProjectFormSubmit();
    });

    const searchInput = document.getElementById('paletteSearchInput');
    searchInput?.addEventListener('input', (e) => this.handleSearchInput(e.target.value));
    searchInput?.addEventListener('keydown', (e) => this.handleSearchKeydown(e));
  }

  /* -------------------------------------------------------------------------- */
  /* Modals                                                                     */
  /* -------------------------------------------------------------------------- */

  getFocusable(container) {
    if (!container) return [];
    return [...container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  bindFocusTrap(overlay) {
    if (!overlay || overlay.dataset.focusTrapBound === '1') return;
    overlay.dataset.focusTrapBound = '1';
    overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !overlay.classList.contains('active')) return;
      const panel = overlay.querySelector('.modal-card, .search-palette-box') || overlay;
      const nodes = this.getFocusable(panel);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  openOverlay(overlayId, focusSelector) {
    this.lastFocusedBeforeModal = document.activeElement;
    const modal = document.getElementById(overlayId);
    if (!modal) return;
    this.bindFocusTrap(modal);
    modal.classList.add('active');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setTimeout(() => {
      const focusEl = modal.querySelector(focusSelector) || this.getFocusable(modal)[0];
      focusEl?.focus();
    }, 30);
  }

  closeOverlay(overlayId) {
    document.getElementById(overlayId)?.classList.remove('active');
    if (this.lastFocusedBeforeModal && typeof this.lastFocusedBeforeModal.focus === 'function') {
      this.lastFocusedBeforeModal.focus();
    }
  }

  openProjectModal(projectId = null) {
    const titleEl = document.getElementById('projectModalTitle');
    if (projectId) {
      const proj = this.config.projects.find((p) => p.id === projectId);
      if (!proj) return;
      titleEl.textContent = '编辑服务';
      document.getElementById('formProjectId').value = proj.id;
      document.getElementById('formTitle').value = proj.title || '';
      document.getElementById('formCustomWan').value = proj.customWanUrl || '';
      document.getElementById('formIconUrl').value = proj.iconUrl || '';
      document.getElementById('formPing').checked = Boolean(proj.pingEnabled);
      document.getElementById('formStatusPublic').checked = proj.statusPublic === true;
    } else {
      titleEl.textContent = '添加新服务';
      document.getElementById('formProjectId').value = '';
      document.getElementById('formTitle').value = '';
      document.getElementById('formCustomWan').value = '';
      document.getElementById('formIconUrl').value = '';
      document.getElementById('formPing').checked = true;
      document.getElementById('formStatusPublic').checked = false;
    }
    // 公开状态页读取服务器配置，本地模式下该选项没有意义
    document.getElementById('statusPublicGroup').hidden = !this.serverMode;
    this.openOverlay('projectModalOverlay', '#formTitle');
  }

  closeProjectModal() {
    this.closeOverlay('projectModalOverlay');
  }

  async handleProjectFormSubmit() {
    const id = document.getElementById('formProjectId').value || `proj-${Date.now()}`;
    const title = document.getElementById('formTitle').value.trim();
    const customWanUrlRaw = document.getElementById('formCustomWan').value.trim();
    const pingEnabled = document.getElementById('formPing').checked;
    const existing = this.config.projects.find((p) => p.id === id);
    const statusPublic = this.serverMode
      ? document.getElementById('formStatusPublic').checked
      : existing?.statusPublic === true;

    if (!title) {
      this.showToast('请填写服务名称', '⚠️');
      return;
    }

    const parsedUrl = parseHttpUrl(customWanUrlRaw);
    if (!parsedUrl) {
      this.showToast('请输入有效的 http:// 或 https:// 链接', '⚠️');
      return;
    }

    const iconUrlRaw = document.getElementById('formIconUrl').value.trim();
    const parsedIcon = iconUrlRaw ? parseHttpUrl(iconUrlRaw) : null;
    if (iconUrlRaw && !parsedIcon) {
      this.showToast('图标地址需要是 http:// 或 https:// 链接', '⚠️');
      return;
    }

    const projectData = {
      id,
      title,
      categoryId: 'services',
      customWanUrl: parsedUrl.href,
      pingEnabled,
      statusPublic,
      ...(parsedIcon ? { iconUrl: parsedIcon.href } : {})
    };

    const nextProjects = [...this.config.projects];
    const existingIndex = nextProjects.findIndex((p) => p.id === id);
    if (existingIndex >= 0) {
      nextProjects[existingIndex] = projectData;
    } else {
      nextProjects.unshift(projectData);
    }

    const saveBtn = document.getElementById('saveProjectBtn');
    if (saveBtn) saveBtn.disabled = true;
    const ok = await this.commitProjects(nextProjects);
    if (saveBtn) saveBtn.disabled = false;
    if (!ok) return;

    this.showToast(existingIndex >= 0 ? `服务「${title}」修改已保存` : `新服务「${title}」已添加`, existingIndex >= 0 ? '💾' : '✨');
    this.closeProjectModal();
    this.renderProjectPool();

    this.pingService.probeService(projectData, parsedUrl.href).then((res) => {
      this.statusMap[id] = { checking: false, ...res };
      this.updateStatusBadges();
      this.updateMetrics();
    });
  }

  openSearchModal() {
    this.openOverlay('searchModalOverlay', '#paletteSearchInput');
    const input = document.getElementById('paletteSearchInput');
    if (input) input.value = '';
    this.handleSearchInput('');
  }

  closeSearchModal() {
    this.closeOverlay('searchModalOverlay');
  }

  handleSearchInput(query) {
    this.searchQuery = query.toLowerCase().trim();
    if (!this.searchQuery) {
      this.searchResults = [...this.config.projects];
    } else {
      this.searchResults = this.config.projects.filter((p) => {
        const matchTitle = p.title?.toLowerCase().includes(this.searchQuery);
        const matchUrl = p.customWanUrl?.toLowerCase().includes(this.searchQuery);
        return matchTitle || matchUrl;
      });
    }
    this.selectedSearchResultIndex = 0;
    this.renderSearchResults();
  }

  renderSearchResults() {
    const list = document.getElementById('searchResultsList');
    if (!list) return;

    if (this.searchResults.length === 0) {
      list.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
          没有找到匹配「${escapeHtml(this.searchQuery)}」的服务
        </div>
      `;
      return;
    }

    list.innerHTML = this.searchResults
      .map((proj, idx) => {
        const isSelected = idx === this.selectedSearchResultIndex;
        const targetUrl = this.buildProjectUrl(proj);
        const nativeFaviconUrl = this.iconFor(proj, targetUrl);
        const title = proj.title || '未命名服务';
        const host = this.getHostname(targetUrl);
        return `
          <div class="search-result-item ${isSelected ? 'selected' : ''}" data-idx="${idx}">
            <div class="search-result-left">
              ${renderIconBox(title, nativeFaviconUrl, 'icon-sm')}
              <div>
                <div class="search-result-title">${escapeHtml(title)}</div>
                ${host ? `<div class="search-result-host">${escapeHtml(host)}</div>` : ''}
              </div>
            </div>
            <span class="kbd-badge">↵ 打开</span>
          </div>
        `;
      })
      .join('');

    list.querySelectorAll('.search-result-item').forEach((item) => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.getAttribute('data-idx'), 10);
        this.launchSearchResult(idx);
      });
    });
  }

  updateSearchSelection(nextIndex) {
    const list = document.getElementById('searchResultsList');
    if (!list || this.searchResults.length === 0) return;
    const items = list.querySelectorAll('.search-result-item');
    items[this.selectedSearchResultIndex]?.classList.remove('selected');
    this.selectedSearchResultIndex = nextIndex;
    const selected = items[this.selectedSearchResultIndex];
    selected?.classList.add('selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  handleSearchKeydown(e) {
    if (this.searchResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.updateSearchSelection((this.selectedSearchResultIndex + 1) % this.searchResults.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.updateSearchSelection(
        (this.selectedSearchResultIndex - 1 + this.searchResults.length) % this.searchResults.length
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.launchSearchResult(this.selectedSearchResultIndex);
    }
  }

  launchSearchResult(index) {
    const proj = this.searchResults[index];
    if (!proj) return;
    this.openSafeUrl(this.buildProjectUrl(proj));
    this.closeSearchModal();
  }

  openSettingsModal() {
    const p = this.config.profile;
    const cfgTitle = document.getElementById('cfgTitle');
    const cfgSubtitle = document.getElementById('cfgSubtitle');
    if (cfgTitle) cfgTitle.value = p.title || '薛定谔的项目';
    if (cfgSubtitle) cfgSubtitle.value = p.subtitle || '心之所向，触手可及';
    this.renderAdminStatus();
    this.openOverlay('settingsModalOverlay', '#cfgTitle');
  }

  closeSettingsModal() {
    this.closeOverlay('settingsModalOverlay');
  }

  saveSettings() {
    const cfgTitle = document.getElementById('cfgTitle');
    const cfgSubtitle = document.getElementById('cfgSubtitle');
    if (cfgTitle) this.config.profile.title = cfgTitle.value.trim() || '薛定谔的项目';
    if (cfgSubtitle) this.config.profile.subtitle = cfgSubtitle.value.trim() || '心之所向，触手可及';
    this.persistState();
    this.renderHeader();
    this.closeSettingsModal();
    this.showToast('设置已成功保存', '💾');
  }

  closeAllModals() {
    this.closeProjectModal();
    this.closeSearchModal();
    this.closeSettingsModal();
    if (document.getElementById('authModalOverlay')?.classList.contains('active')) {
      this.cancelAuth();
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.schrodingerPortal = new App();
});
