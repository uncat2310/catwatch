/**
 * 状态变化通知（全部可选，由环境变量开启）
 * - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 * - BARK_URL（如 https://api.day.app/<key>）
 * - SERVERCHAN_SENDKEY（Server酱 Turbo）
 * - NOTIFY_WEBHOOK_URL（通用 JSON POST）
 */

import { formatDuration } from '../shared/time.js';

export { formatDuration };

const NOTIFY_TIMEOUT_MS = 6000;

export function formatEventMessage(event) {
  if (event.type === 'test') {
    return { title: '猫咪值班室 · 测试通知', body: '通知通道工作正常。' };
  }
  if (event.type === 'down') {
    return {
      title: `🔴 ${event.title} 不可用`,
      body: `${event.url}\n原因：${event.error || '未知'}`
    };
  }
  const duration = formatDuration(event.durationMs);
  return {
    title: `🟢 ${event.title} 已恢复`,
    body: `${event.url}${duration ? `\n中断时长：${duration}` : ''}`
  };
}

async function post(url, init) {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS), ...init });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export function createNotifier(env = process.env) {
  const channels = [];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    channels.push({
      name: 'telegram',
      send: ({ title, body }) =>
        post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `${title}\n${body}`,
            disable_web_page_preview: true
          })
        })
    });
  }

  if (env.BARK_URL) {
    channels.push({
      name: 'bark',
      send: ({ title, body }) =>
        post(env.BARK_URL.replace(/\/+$/, ''), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ title, body, group: 'catwatch' })
        })
    });
  }

  if (env.SERVERCHAN_SENDKEY) {
    channels.push({
      name: 'serverchan',
      send: ({ title, body }) =>
        post(`https://sctapi.ftqq.com/${encodeURIComponent(env.SERVERCHAN_SENDKEY)}.send`, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ title, desp: body }).toString()
        })
    });
  }

  if (env.NOTIFY_WEBHOOK_URL) {
    channels.push({
      name: 'webhook',
      send: ({ title, body }, event) =>
        post(env.NOTIFY_WEBHOOK_URL, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, event })
        })
    });
  }

  return {
    channels: channels.map((c) => c.name),
    enabled: channels.length > 0,
    /** 并发发送到所有通道；返回每个通道的结果，不抛出 */
    async send(event) {
      const message = formatEventMessage(event);
      const results = await Promise.allSettled(channels.map((c) => c.send(message, event)));
      return results.map((r, i) => ({
        channel: channels[i].name,
        ok: r.status === 'fulfilled',
        error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null
      }));
    }
  };
}
