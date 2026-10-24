/**
 * 公开状态页渲染（前后端共用）
 * 只包含名称、状态、可用率与事件，不含任何 URL / hostname
 */
import { escapeHtml } from './escape.js';
import { formatUptime, renderUptimeBars } from './uptime.js';
import { formatDuration, formatRelative } from './time.js';

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

function overallUptime(services) {
  const values = services.map((s) => s.uptime24h).filter((u) => typeof u === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function renderRow(service, formatTime) {
  const view = STATE_VIEW[service.state] || STATE_VIEW.unknown;
  const latency = service.avgLatency24h != null ? ` · 平均 ${service.avgLatency24h} ms` : '';
  return `
    <li class="status-row">
      <div class="status-row-head">
        <span class="status-row-name">${escapeHtml(service.title)}</span>
        <span class="card-status-badge ${view.cls}"><span class="status-dot"></span><span class="status-text">${view.text}</span></span>
      </div>
      ${renderUptimeBars(service.bars ? service : null, formatTime)}
      <div class="status-axis">
        <span>24 小时前</span>
        <span class="status-axis-pct">${escapeHtml(formatUptime(service.uptime24h))} 可用${escapeHtml(latency)}</span>
        <span>现在</span>
      </div>
    </li>`;
}

function renderEvent(event, now) {
  const down = event.type === 'down';
  const detail = !down && event.durationMs != null ? `中断 ${formatDuration(event.durationMs)}` : '';
  return `
    <li class="status-event ${down ? 'is-down' : 'is-up'}">
      <span class="status-event-dot"></span>
      <span class="status-event-text"><strong>${escapeHtml(event.title)}</strong> ${down ? '离线' : '恢复'}${detail ? `<span class="status-event-detail">${escapeHtml(detail)}</span>` : ''}</span>
      <time class="status-event-time">${escapeHtml(formatRelative(event.at, now))}</time>
    </li>`;
}

export function renderStatusBody(payload, formatTime) {
  const services = Array.isArray(payload?.services) ? payload.services : [];
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const now = payload?.now || Date.now();
  const overall = overallStatus(services);
  const uptime = overallUptime(services);

  const summary = `
    <section class="status-hero ${overall.level}">
      <div class="status-hero-main">
        <span class="status-overall-dot"></span>
        <div>
          <p class="status-overall-text">${escapeHtml(overall.text)}</p>
          <p class="status-hero-sub">${services.length} 个公开服务 · 每分钟自动刷新</p>
        </div>
      </div>
      ${
        services.length
          ? `<div class="status-hero-metric"><span class="obs-value">${escapeHtml(formatUptime(uptime))}</span><span class="obs-label">24h 整体可用率</span></div>`
          : ''
      }
    </section>`;

  if (!services.length) {
    return `${summary}<p class="status-empty">在服务的编辑弹窗中勾选「在公开状态页显示」即可出现在这里。</p>`;
  }

  return `
    ${summary}
    <ul class="status-list">${services.map((s) => renderRow(s, formatTime)).join('')}</ul>
    <section class="status-events">
      <h2 class="status-section-title">最近事件</h2>
      ${
        events.length
          ? `<ul class="status-event-list">${events.map((e) => renderEvent(e, now)).join('')}</ul>`
          : '<p class="status-events-empty">近 7 天没有状态变化。</p>'
      }
    </section>
  `;
}
