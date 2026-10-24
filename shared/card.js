/**
 * 服务卡片模板（服务端 SSR 与前端渲染共用）
 */
import { escapeAttribute, escapeHtml } from './escape.js';
import { renderIconBox } from './favicon.js';

const ICONS = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
  delete: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
  arrow: '<line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline>'
};

function svg(name, cls = 'btn-svg') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[name]}</svg>`;
}

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.title
 * @param {string} options.url        已校验的 http(s) URL，无效时为空
 * @param {string} options.iconSrc
 * @param {{cls: string, label: string}} options.status
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

  return `
    <div class="project-card" data-id="${safeId}" data-url="${safeHref}" tabindex="0" role="link"${style}>
      <div class="card-top">
        <div class="card-identity">
          ${renderIconBox(name, iconSrc)}
          <div class="card-text">
            <a class="card-title" href="${safeHref}" target="_blank" rel="noreferrer" tabindex="-1" title="${escapeAttribute(name)}"><span class="card-title-text">${escapeHtml(name)}</span>${svg('arrow', 'card-title-arrow')}</a>
            ${hostname ? `<div class="card-hostname">${escapeHtml(hostname)}</div>` : ''}
          </div>
        </div>
        <div class="card-status-badge ${escapeAttribute(status.cls)}" id="status-${safeId}">
          <span class="status-dot"></span>
          <span class="status-text">${escapeHtml(status.label)}</span>
        </div>
      </div>
      ${stripHtml}
      <div class="card-manage-actions">
        <button class="card-action-btn copy-btn" data-url="${safeHref}" title="复制链接" aria-label="复制链接" type="button">${svg('copy')}</button>
        <button class="card-action-btn edit-btn" data-id="${safeId}" title="编辑服务" aria-label="编辑服务" type="button">${svg('edit')}</button>
        <button class="card-action-btn delete-btn" data-id="${safeId}" title="删除服务" aria-label="删除服务" type="button">${svg('delete')}</button>
      </div>
    </div>
  `;
}
