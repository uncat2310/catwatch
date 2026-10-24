import { renderStatusBody } from '../shared/statusPage.js';

const REFRESH_MS = 60 * 1000;

function formatSlotTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function render(payload) {
  const root = document.getElementById('statusRoot');
  if (!root || !payload) return;
  root.innerHTML = renderStatusBody(payload, formatSlotTime);
  const updated = document.getElementById('statusUpdated');
  if (updated) {
    const d = new Date(payload.now || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    updated.textContent = `更新于 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

async function refresh() {
  if (document.visibilityState === 'hidden') return;
  try {
    const res = await fetch('/api/status', { signal: AbortSignal.timeout(5000) });
    if (res.ok) render(await res.json());
  } catch {
    // 保留上一次的结果
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // 服务端预渲染的数据：立即按本地时区重绘一次，补上每格的时间提示
  const initial = document.getElementById('status-data');
  if (initial) {
    try {
      render(JSON.parse(initial.textContent));
    } catch {
      refresh();
    }
  } else {
    refresh();
  }
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', refresh);
});
