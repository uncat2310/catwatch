/**
 * Favicon 解析：常见自建路径优先，公开站点走域名 fallback
 * 不会解析目标站点 HTML 中的 <link rel="icon">
 */

import { escapeAttribute, escapeHtml } from './escape.js';

const LOCAL_FALLBACK = '/favicon.svg';

/** 内网 / 本机地址：第三方 favicon 服务拿不到，也不应把地址发出去 */
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  if (host === 'localhost' || !host.includes('.')) return true;
  return /\.(local|lan|home|internal|localdomain)$/.test(host);
}

export function getProjectNativeFavicon(targetUrl) {
  if (!targetUrl) return LOCAL_FALLBACK;

  try {
    const parsed = new URL(targetUrl);
    const origin = parsed.origin;
    const hostname = parsed.hostname.toLowerCase();

    // 常见自建服务：优先同源已知路径（不向外泄露 hostname）
    if (hostname.includes('traffic')) return `${origin}/favicon.svg`;
    if (hostname.includes('tz.')) return `${origin}/favicon.ico`;
    if (hostname.includes('blog.')) return `${origin}/favicon.png`;
    if (hostname.includes('v.')) return `${origin}/images/favicon-32x32.png`;
    if (hostname.includes('cd2.')) return `${origin}/public/favicon.png`;
    if (hostname.includes('img.')) return `${origin}/favicon.png`;
    if (hostname.includes('catbox.')) return `${origin}/static/catbox-logo.png`;
    if (hostname.includes('qb.')) return `${origin}/icons/qbittorrent-tray.svg`;

    if (isPrivateHost(hostname)) return `${origin}/favicon.ico`;

    // 公开站点：第三方域名 favicon fallback
    if (hostname.includes('github.')) return 'https://icons.duckduckgo.com/ip3/github.com.ico';
    if (hostname.includes('vercel.')) return 'https://icons.duckduckgo.com/ip3/vercel.com.ico';
    if (hostname.includes('cloudflare.')) return 'https://icons.duckduckgo.com/ip3/cloudflare.com.ico';

    return `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
  } catch {
    return LOCAL_FALLBACK;
  }
}

/** 取标题首字符与稳定色相，用于图标加载失败时的字母头像 */
export function monogramFor(title) {
  const text = String(title || '').trim();
  const char = [...text][0] || '·';
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) % 3600;
  return { char: char.toUpperCase(), hue: hash % 360 };
}

/**
 * 服务图标：优先 favicon，加载失败（或无 URL）时显示字母头像
 * 内联 onerror 在 SSR 首屏、JS 尚未执行时同样生效
 */
export function renderIconBox(title, iconSrc, extraClass = '') {
  const { char, hue } = monogramFor(title);
  const cls = `card-icon-box${extraClass ? ` ${extraClass}` : ''}`;
  const monogram = `<span class="card-monogram" aria-hidden="true">${escapeHtml(char)}</span>`;
  if (!iconSrc || iconSrc === LOCAL_FALLBACK) {
    return `<div class="${cls} is-monogram" style="--mono-hue:${hue}">${monogram}</div>`;
  }
  return `<div class="${cls}" style="--mono-hue:${hue}">${monogram}<img src="${escapeAttribute(iconSrc)}" alt="" class="card-favicon-img" decoding="async" onerror="this.parentNode.classList.add('is-monogram');this.remove();" /></div>`;
}
