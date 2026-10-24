/**
 * 服务列表模板（服务端 SSR 与前端渲染共用）
 * - renderProjectCard: 单个服务行
 * - renderPool: 观测栏 + 服务列表
 */
import { escapeAttribute, escapeHtml } from './escape.js';
import { renderIconBox } from './favicon.js';
import { formatUptime, renderUptimeBars } from './uptime.js';
import { formatRelative } from './time.js';

const ICONS = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
  delete: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
  arrow: '<line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>'
};

function svg(name, cls = 'btn-svg') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** 探测结果 → 徽章样式与文案；st 为空表示尚未有结果 */
export function statusView(st) {
  if (!st || st.checking) return { cls: 'checking', label: '检测中' };
  if (st.alive) return { cls: 'online', label: st.latency != null ? `${st.latency} ms` : '在线' };
  return { cls: 'offline', label: '离线' };
}

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.title
 * @param {string} options.url        已校验的 http(s) URL，无效时为空
 * @param {string} options.iconSrc
 * @param {{cls: string, label: string}|null} options.status  null 表示未启用探针
 * @param {string} [options.stripHtml] 可用率条 HTML
 * @param {number} [options.delayMs]   入场动画延迟
 */
export function renderProjectCard({ id, title, url, iconSrc, status, stripHtml = '', delayMs = null }) {
  const href = url || '#';
  let hostname = '';
  try {
    hostname = url ? new URL(url).hostname : '';
  } catch {
    hostname = '';
  }
  const name = title || '未命名服务';
  const safeId = escapeAttribute(id || '');
  const safeHref = escapeAttribute(href);
  const style = delayMs != null ? ` style="animation-delay:${Number(delayMs) || 0}ms"` : '';
  const badge = status || { cls: '', label: '' };

  return `
    <li class="project-card" data-id="${safeId}" data-url="${safeHref}" tabindex="0" role="link"${style}>
      <div class="card-head">
        ${renderIconBox(name, iconSrc, 'icon-lg')}
        <div class="card-text">
          <a class="card-title" href="${safeHref}" target="_blank" rel="noreferrer" tabindex="-1" title="${escapeAttribute(name)}"><span class="card-title-text">${escapeHtml(name)}</span>${svg('arrow', 'card-title-arrow')}</a>
          ${hostname ? `<span class="card-hostname">${escapeHtml(hostname)}</span>` : ''}
        </div>
        <div class="card-status-badge ${escapeAttribute(badge.cls)}" id="status-${safeId}"${status ? '' : ' style="display:none"'}>
          <span class="status-dot"></span>
          <span class="status-text">${escapeHtml(badge.label)}</span>
        </div>
      </div>
      ${stripHtml || '<p class="card-note">未启用健康探针</p>'}
      <div class="card-manage-actions">
        <button class="card-action-btn copy-btn" data-url="${safeHref}" title="复制链接" aria-label="复制链接" type="button">${svg('copy')}</button>
        <button class="card-action-btn edit-btn" data-id="${safeId}" title="编辑服务" aria-label="编辑服务" type="button">${svg('edit')}</button>
        <button class="card-action-btn delete-btn" data-id="${safeId}" title="删除服务" aria-label="删除服务" type="button">${svg('delete')}</button>
      </div>
    </li>
  `;
}

/** 把多个服务的 48 段历史按时段取平均，得到整体可用率与延迟序列 */
export function aggregateSeries(summaries) {
  const list = summaries.filter((s) => Array.isArray(s?.bars) && s.bars.length);
  if (!list.length) return null;
  const length = Math.max(...list.map((s) => s.bars.length));
  const avg = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  return Array.from({ length }, (_, i) => ({
    u: avg(list.map((s) => s.bars[i]?.u).filter((v) => typeof v === 'number')),
    l: avg(list.map((s) => s.bars[i]?.l).filter((v) => typeof v === 'number'))
  }));
}

export function renderDots(services) {
  if (!services?.length) return '<span class="stat-empty">暂无启用探针的服务</span>';
  return services
    .map((s) => `<i class="svc-dot ${escapeAttribute(s.cls)}" title="${escapeAttribute(s.title)}"></i>`)
    .join('');
}

export function renderSeriesBars(series) {
  return renderUptimeBars(series ? { bars: series.map((p) => ({ t: 0, u: p.u, l: p.l })) } : null);
}

/** 延迟走势折线（48 个时段，空缺处断开） */
export function renderSparkline(series) {
  const points = (series || []).map((p, i) => ({ x: i, l: p.l })).filter((p) => typeof p.l === 'number');
  if (points.length < 2) return '<span class="stat-empty">积累数据中</span>';
  const max = Math.max(...points.map((p) => p.l));
  const min = Math.min(...points.map((p) => p.l));
  const span = max - min || 1;
  const width = Math.max((series.length || 48) - 1, 1);
  const y = (l) => (18 - ((l - min) / span) * 15).toFixed(2);

  let line = '';
  let prev = null;
  for (const p of points) {
    line += `${prev !== null && p.x === prev + 1 ? 'L' : 'M'}${p.x} ${y(p.l)} `;
    prev = p.x;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const area = `M${first.x} 20 ${line.replace(/M/g, 'L')}L${last.x} 20 Z`;
  return `<svg class="sparkline" viewBox="0 0 ${width} 20" preserveAspectRatio="none" aria-hidden="true"><path class="sparkline-area" d="${area}"/><path class="sparkline-line" d="${line.trim()}" vector-effect="non-scaling-stroke"/></svg>`;
}

/**
 * 观测卡片各项的展示文本
 * @param {object} m
 * @param {number} m.total
 * @param {number|null} m.online   null 表示尚未完成首轮探测
 * @param {number} m.pingable
 * @param {number|null} m.uptime   24h 平均可用率 (0-1)
 * @param {number|null} m.latency  当前平均延迟 ms
 * @param {object|null} m.event    最近一次状态变化 { title, type, at }
 * @param {number} m.now
 */
export function formatMetrics(m) {
  let level = 'unknown';
  if (m.online != null) level = m.online >= m.pingable ? 'ok' : 'warn';
  return {
    level,
    online: m.online == null ? '—' : String(m.online),
    total: String(m.pingable ?? m.total),
    uptime: formatUptime(m.uptime),
    latency: m.latency == null ? '—' : String(Math.round(m.latency)),
    eventTitle: m.event ? `${m.event.title} ${m.event.type === 'down' ? '离线' : '恢复'}` : '一切平稳',
    eventTime: m.event ? formatRelative(m.event.at, m.now) : '近 7 天没有状态变化',
    eventType: m.event ? m.event.type : 'none'
  };
}

export function renderPool({ cardsHtml, metrics }) {
  const v = formatMetrics(metrics);
  const list = cardsHtml
    ? `<ul class="service-grid">${cardsHtml}</ul>`
    : '<p class="empty-category-notice">还没有服务。点击右上角「添加」开始。</p>';

  return `
    <section class="stats" aria-label="概览">
      <article class="stat-tile">
        <p class="stat-label"><span class="obs-dot" id="metricDot" data-level="${v.level}"></span>在线服务</p>
        <p class="stat-value"><span id="metricOnline">${escapeHtml(v.online)}</span><span class="stat-of">/<span id="metricTotal">${escapeHtml(v.total)}</span></span></p>
        <div class="stat-viz stat-dots" id="metricDots">${renderDots(metrics.services)}</div>
      </article>
      <article class="stat-tile">
        <p class="stat-label">24 小时可用率</p>
        <p class="stat-value" id="metricUptime">${escapeHtml(v.uptime)}</p>
        <div class="stat-viz" id="metricUptimeViz">${renderSeriesBars(metrics.series)}</div>
      </article>
      <article class="stat-tile">
        <p class="stat-label">平均延迟</p>
        <p class="stat-value"><span id="metricLatency">${escapeHtml(v.latency)}</span><span class="stat-unit">ms</span></p>
        <div class="stat-viz" id="metricLatencyViz">${renderSparkline(metrics.series)}</div>
      </article>
      <article class="stat-tile stat-event" id="metricEventTile" data-type="${escapeAttribute(v.eventType)}">
        <p class="stat-label">最近事件</p>
        <p class="stat-event-title" id="metricEvent">${escapeHtml(v.eventTitle)}</p>
        <p class="stat-event-time" id="metricEventTime">${escapeHtml(v.eventTime)}</p>
      </article>
    </section>

    <div class="section-bar">
      <h2 class="section-title">服务</h2>
      <span class="section-count">${escapeHtml(String(metrics.total))}</span>
      <button class="obs-refresh" id="refreshPingBtn" type="button" title="重新探测服务状态" aria-label="重新探测服务状态">${svg('refresh', 'btn-svg spin-on-click')}</button>
    </div>
    ${list}
  `;
}
