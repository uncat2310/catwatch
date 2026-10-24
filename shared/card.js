/**
 * 服务列表模板（服务端 SSR 与前端渲染共用）
 * - renderProjectCard: 单个服务行
 * - renderPool: 观测栏 + 服务列表
 */
import { escapeAttribute, escapeHtml } from './escape.js';
import { renderIconBox } from './favicon.js';
import { formatUptime } from './uptime.js';

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
      <div class="card-identity">
        ${renderIconBox(name, iconSrc)}
        <div class="card-text">
          <a class="card-title" href="${safeHref}" target="_blank" rel="noreferrer" tabindex="-1" title="${escapeAttribute(name)}"><span class="card-title-text">${escapeHtml(name)}</span>${svg('arrow', 'card-title-arrow')}</a>
          ${hostname ? `<span class="card-hostname">${escapeHtml(hostname)}</span>` : ''}
        </div>
      </div>
      ${stripHtml}
      <div class="card-status-badge ${escapeAttribute(badge.cls)}" id="status-${safeId}"${status ? '' : ' style="display:none"'}>
        <span class="status-dot"></span>
        <span class="status-text">${escapeHtml(badge.label)}</span>
      </div>
      <div class="card-manage-actions">
        <button class="card-action-btn copy-btn" data-url="${safeHref}" title="复制链接" aria-label="复制链接" type="button">${svg('copy')}</button>
        <button class="card-action-btn edit-btn" data-id="${safeId}" title="编辑服务" aria-label="编辑服务" type="button">${svg('edit')}</button>
        <button class="card-action-btn delete-btn" data-id="${safeId}" title="删除服务" aria-label="删除服务" type="button">${svg('delete')}</button>
      </div>
    </li>
  `;
}

function formatRelative(ms, now) {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 观测栏各项的展示文本
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
    total: String(m.total),
    uptime: formatUptime(m.uptime),
    latency: m.latency == null ? '—' : `${Math.round(m.latency)} ms`,
    event: m.event
      ? `${m.event.title} ${m.event.type === 'down' ? '离线' : '恢复'} · ${formatRelative(m.event.at, m.now)}`
      : '近 7 天无状态变化'
  };
}

export function renderPool({ cardsHtml, metrics }) {
  const v = formatMetrics(metrics);
  const list = cardsHtml
    ? `<ul class="ledger">${cardsHtml}</ul>`
    : '<p class="empty-category-notice">还没有服务。点击右上角「添加」开始。</p>';

  return `
    <div class="observatory">
      <div class="obs-cell obs-main">
        <span class="obs-dot" id="metricDot" data-level="${v.level}"></span>
        <span class="obs-value"><span id="metricOnline">${escapeHtml(v.online)}</span><span class="obs-of">/</span><span id="metricTotal">${escapeHtml(v.total)}</span></span>
        <span class="obs-label">在线</span>
      </div>
      <div class="obs-cell">
        <span class="obs-value" id="metricUptime">${escapeHtml(v.uptime)}</span>
        <span class="obs-label">24h 可用率</span>
      </div>
      <div class="obs-cell">
        <span class="obs-value" id="metricLatency">${escapeHtml(v.latency)}</span>
        <span class="obs-label">平均延迟</span>
      </div>
      <div class="obs-cell obs-event">
        <span class="obs-label">最近事件</span>
        <span class="obs-event-text" id="metricEvent">${escapeHtml(v.event)}</span>
      </div>
      <button class="obs-refresh" id="refreshPingBtn" type="button" title="重新探测服务状态" aria-label="重新探测服务状态">${svg('refresh', 'btn-svg spin-on-click')}</button>
    </div>
    ${list}
  `;
}
