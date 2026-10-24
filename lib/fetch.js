/**
 * 受限的服务端 HTTP GET（用于抓取服务图标）
 * - trusted：管理员配置的地址，允许内网，但仍做 DNS pinning
 * - 非 trusted：只允许公网地址（复用探针的 SSRF 校验）
 * - 同主机跳转保持原信任级别，跨主机跳转一律按公网规则校验
 * - 响应体有大小上限；truncate=true 时超限截断而不是报错（读 HTML 头部够用）
 */
import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import net from 'net';
import { validateProbeTarget, createPinnedLookup } from '../shared/ssrf.js';
import { parseHttpUrl } from '../shared/url.js';

async function resolveTarget(url, trusted) {
  if (!trusted) {
    const result = await validateProbeTarget(url);
    if (!result.ok) return { error: result.error };
    return { url: result.url, address: result.address, family: result.family };
  }

  const parsed = parseHttpUrl(url);
  if (!parsed) return { error: 'INVALID_URL' };
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    return { url: parsed.href, address: host, family: net.isIP(host) };
  }
  try {
    const [first] = await dns.lookup(host, { all: true, verbatim: true });
    if (!first) return { error: 'DNS_FAILED' };
    return { url: parsed.href, address: first.address, family: first.family };
  } catch {
    return { error: 'DNS_FAILED' };
  }
}

function requestOnce(target, { maxBytes, timeoutMs, insecureTls, accept, truncate }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const parsed = new URL(target.url);
    const isHttps = parsed.protocol === 'https:';
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const req = (isHttps ? https : http).request(
      {
        protocol: parsed.protocol,
        hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        timeout: timeoutMs,
        rejectUnauthorized: !insecureTls,
        servername: net.isIP(hostname) ? undefined : hostname,
        lookup: createPinnedLookup(target.address, target.family),
        headers: {
          Host: parsed.host,
          'User-Agent': 'CatWatch/1.0 (+icon-fetch)',
          Accept: accept
        }
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          finish({ redirect: res.headers.location });
          return;
        }

        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            if (truncate) {
              chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
              res.destroy();
              finish({ ok: true, status, headers: res.headers, body: Buffer.concat(chunks) });
            } else {
              res.destroy();
              finish({ ok: false, error: 'TOO_LARGE' });
            }
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish({ ok: true, status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', () => finish({ ok: false, error: 'ERR_NETWORK' }));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'TIMEOUT' });
    });
    req.on('error', () => finish({ ok: false, error: 'ERR_NETWORK' }));
    req.end();
  });
}

export async function fetchLimited(
  url,
  { trusted = false, maxBytes = 512 * 1024, timeoutMs = 6000, maxRedirects = 3, insecureTls = false, accept = '*/*', truncate = false } = {}
) {
  let current = url;
  let currentTrusted = trusted;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await resolveTarget(current, currentTrusted);
    if (target.error) return { ok: false, error: target.error };

    const res = await requestOnce(target, { maxBytes, timeoutMs, insecureTls, accept, truncate });
    if (!res.redirect) return { ...res, url: target.url };

    let next;
    try {
      next = new URL(res.redirect, target.url);
    } catch {
      return { ok: false, error: 'INVALID_REDIRECT' };
    }
    currentTrusted = currentTrusted && next.hostname === new URL(target.url).hostname;
    current = next.href;
  }
  return { ok: false, error: 'TOO_MANY_REDIRECTS' };
}
