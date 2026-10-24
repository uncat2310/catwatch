/**
 * 服务图标（前后端共用的展示部分）
 * 服务端配置中的服务走 /api/icon/:id，由服务端抓取并缓存；
 * 这里只处理仅存在于浏览器本地的服务：手动图标地址，或站点根目录 favicon。
 */
import { escapeAttribute, escapeHtml } from './escape.js';
import { parseHttpUrl } from './url.js';

export function browserIconFor(targetUrl, iconUrl) {
  const custom = parseHttpUrl(iconUrl || '');
  if (custom) return custom.href;
  const parsed = parseHttpUrl(targetUrl || '');
  return parsed ? `${parsed.origin}/favicon.ico` : '';
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
  if (!iconSrc) {
    return `<div class="${cls} is-monogram" style="--mono-hue:${hue}">${monogram}</div>`;
  }
  return `<div class="${cls}" style="--mono-hue:${hue}">${monogram}<img src="${escapeAttribute(iconSrc)}" alt="" class="card-favicon-img" decoding="async" onerror="this.parentNode.classList.add('is-monogram');this.remove();" /></div>`;
}
