/**
 * 公开状态页渲染（前后端共用）
 * 只包含名称、状态与可用率，不含任何 URL / hostname
 */
import { escapeHtml } from './escape.js';
import { renderUptimeInner } from './uptime.js';

const STATE_VIEW = {
  up: { cls: 'online', text: '正常' },
  down: { cls: 'offline', text: '离线' },
  unknown: { cls: 'checking', text: '检测中' }
};

export function overallStatus(services) {
  if (!services.length) {
    return { level: 'empty', text: '暂未公开任何服务' };
  }
  const down = services.filter((s) => s.state === 'down').length;
  if (down === 0) {
    return { level: 'ok', text: '全部服务运行正常' };
  }
  return { level: 'degraded', text: down === services.length ? '全部服务离线' : `${down} 个服务离线` };
}

export function renderStatusBody(payload, formatTime) {
  const services = Array.isArray(payload?.services) ? payload.services : [];
  const overall = overallStatus(services);

  const rows = services
    .map((service) => {
      const view = STATE_VIEW[service.state] || STATE_VIEW.unknown;
      return `
        <li class="status-row">
          <span class="status-row-name">${escapeHtml(service.title)}</span>
          <div class="uptime-strip">${renderUptimeInner(service.bars ? service : null, formatTime)}</div>
          <span class="card-status-badge ${view.cls}"><span class="status-dot"></span><span class="status-text">${view.text}</span></span>
        </li>`;
    })
    .join('');

  return `
    <div class="status-overall ${overall.level}">
      <span class="status-overall-dot"></span>
      <span class="status-overall-text">${escapeHtml(overall.text)}</span>
    </div>
    ${rows ? `<ul class="status-list">${rows}</ul>` : '<p class="status-empty">在服务的编辑弹窗中勾选「在公开状态页显示」即可出现在这里。</p>'}
  `;
}
