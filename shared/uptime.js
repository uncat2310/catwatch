/**
 * 卡片底部 24h 可用率条（前后端共用）
 */
import { escapeAttribute, escapeHtml } from './escape.js';

export const UPTIME_SLOTS = 48;

export function formatUptime(ratio) {
  if (typeof ratio !== 'number') return '—';
  if (ratio >= 1) return '100%';
  if (ratio >= 0.99) return `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`;
  return `${(Math.floor(ratio * 1000) / 10).toFixed(1)}%`;
}

function barClass(u) {
  if (typeof u !== 'number') return 'none';
  if (u >= 1) return 'up';
  if (u <= 0) return 'down';
  return 'partial';
}

/** 生成可用率条内部 HTML；summary 为空时渲染占位 */
export function renderUptimeInner(summary, formatTime = () => '') {
  const bars = summary?.bars || Array.from({ length: UPTIME_SLOTS }, () => ({ t: 0, u: null, l: null }));
  const barsHtml = bars
    .map((bar) => {
      const time = bar.t ? formatTime(bar.t) : '';
      let label;
      if (typeof bar.u !== 'number') {
        label = time ? `${time} · 无数据` : '';
      } else {
        label = `${time} · 可用 ${formatUptime(bar.u)}${bar.l != null ? ` · ${bar.l} ms` : ''}`;
      }
      return `<i class="uptime-bar ${barClass(bar.u)}"${label ? ` title="${escapeAttribute(label)}"` : ''}></i>`;
    })
    .join('');

  const pct = formatUptime(summary?.uptime24h);
  const metaTitle = summary
    ? `近 24 小时可用率 ${pct} · 近 7 天 ${formatUptime(summary.uptime7d)}${summary.avgLatency24h != null ? ` · 平均 ${summary.avgLatency24h} ms` : ''}`
    : '近 24 小时可用率';

  return `<div class="uptime-bars">${barsHtml}</div><span class="uptime-pct" title="${escapeAttribute(metaTitle)}">${escapeHtml(pct)}</span>`;
}

export function renderUptimeStrip(projectId, summary, formatTime) {
  return `<div class="uptime-strip" id="uptime-${escapeAttribute(projectId)}">${renderUptimeInner(summary, formatTime)}</div>`;
}
