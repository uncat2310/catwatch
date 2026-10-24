/**
 * 服务图标：由服务端抓取并缓存
 * 1. 管理员手动指定的 iconUrl
 * 2. 服务首页 HTML 中声明的 <link rel="icon" / "apple-touch-icon">，按清晰度排序
 * 3. 站点根目录 /favicon.ico
 * 抓到的图片按内容嗅探类型（拒绝登录页之类的 HTML），存入 DATA_DIR/icons/
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeJsonAtomic } from './store.js';

const MAX_HTML_BYTES = 384 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] ?? match[3] ?? match[4] ?? '').trim() : '';
}

/** 解析 HTML 中声明的图标，返回按清晰度从高到低排序的绝对地址 */
export function parseIconLinks(html, baseUrl) {
  const results = [];
  const seen = new Set();
  for (const tag of String(html).match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/);
    const isTouch = rel.some((r) => r.startsWith('apple-touch-icon'));
    if (!isTouch && !rel.includes('icon')) continue;

    const href = attr(tag, 'href');
    if (!href || href.startsWith('data:')) continue;
    let absolute;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(absolute.protocol) || seen.has(absolute.href)) continue;
    seen.add(absolute.href);

    const type = attr(tag, 'type').toLowerCase();
    const sizes = attr(tag, 'sizes').toLowerCase();
    let score;
    if (type === 'image/svg+xml' || /\.svg($|\?)/i.test(absolute.pathname) || sizes === 'any') {
      score = 1000;
    } else {
      const dims = [...sizes.matchAll(/(\d+)x(\d+)/g)].map((m) => Number(m[1]));
      score = dims.length ? Math.max(...dims) : isTouch ? 180 : 32;
    }
    results.push({ href: absolute.href, score });
  }
  return results.sort((a, b) => b.score - a.score).map((r) => r.href);
}

/** 按文件头判断图片类型；不是图片返回 null */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return 'image/x-icon';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 1024).toString('utf-8').replace(/^﻿/, '').trimStart().toLowerCase();
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

function hashId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
}

export class IconStore {
  /**
   * @param {object} options
   * @param {string} options.dir        缓存目录
   * @param {Function} options.fetcher  (url, opts) => fetchLimited 结果
   */
  constructor({ dir, fetcher, now = () => Date.now() }) {
    this.dir = dir;
    this.fetcher = fetcher;
    this.now = now;
    this.indexPath = path.join(dir, 'index.json');
    this.index = new Map();
    this.buffers = new Map();
    this.inflight = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
      for (const [id, entry] of Object.entries(data || {})) this.index.set(id, entry);
    } catch {
      // 首次运行或索引损坏：从空开始
    }
  }

  static keyFor(project) {
    return `${project.iconUrl || ''}|${project.customWanUrl || ''}`;
  }

  /** 返回 { buffer, contentType, etag }；没有可用图标返回 null */
  async get(project) {
    const key = IconStore.keyFor(project);
    let entry = this.index.get(project.id);
    const ttl = entry?.ok ? OK_TTL_MS : FAIL_TTL_MS;
    if (!entry || entry.key !== key || this.now() - entry.fetchedAt > ttl) {
      entry = await this.refresh(project);
    }
    if (!entry?.ok) return null;

    let buffer = this.buffers.get(project.id);
    if (!buffer || buffer.etag !== entry.etag) {
      try {
        buffer = { data: fs.readFileSync(path.join(this.dir, entry.file)), etag: entry.etag };
        this.buffers.set(project.id, buffer);
      } catch {
        this.index.delete(project.id);
        return null;
      }
    }
    return { buffer: buffer.data, contentType: entry.contentType, etag: entry.etag };
  }

  refresh(project) {
    if (this.inflight.has(project.id)) return this.inflight.get(project.id);
    const job = this.fetchIcon(project)
      .catch(() => null)
      .then((result) => this.save(project, result))
      .finally(() => this.inflight.delete(project.id));
    this.inflight.set(project.id, job);
    return job;
  }

  async candidates(project) {
    if (project.iconUrl) return [{ url: project.iconUrl, trusted: true }];

    const site = new URL(project.customWanUrl);
    const list = [];
    const page = await this.fetcher(project.customWanUrl, {
      trusted: true,
      maxBytes: MAX_HTML_BYTES,
      truncate: true,
      accept: 'text/html,*/*;q=0.5'
    });
    if (page.ok && page.status < 400) {
      const base = page.url || project.customWanUrl;
      for (const href of parseIconLinks(page.body.toString('utf-8'), base)) {
        list.push({ url: href, trusted: new URL(href).hostname === site.hostname });
      }
    }
    list.push({ url: `${site.origin}/favicon.ico`, trusted: true });
    return list;
  }

  async fetchIcon(project) {
    for (const candidate of await this.candidates(project)) {
      const res = await this.fetcher(candidate.url, {
        trusted: candidate.trusted,
        maxBytes: MAX_ICON_BYTES,
        accept: 'image/*,*/*;q=0.5'
      });
      if (!res.ok || res.status !== 200) continue;
      const contentType = sniffImage(res.body);
      if (contentType) return { source: candidate.url, contentType, body: res.body };
    }
    return null;
  }

  save(project, result) {
    const fetchedAt = this.now();
    const entry = { key: IconStore.keyFor(project), fetchedAt, ok: Boolean(result) };
    const old = this.index.get(project.id);

    if (!result && old?.ok && old.key === entry.key) {
      // 刷新失败：同一配置下的旧图标继续使用，一小时后再试
      old.fetchedAt = fetchedAt - OK_TTL_MS + FAIL_TTL_MS;
      this.persist();
      return old;
    }

    if (result) {
      const ext = EXT_BY_TYPE[result.contentType] || 'bin';
      entry.file = `${hashId(project.id)}.${ext}`;
      entry.contentType = result.contentType;
      entry.source = result.source;
      entry.etag = `"${crypto.createHash('sha1').update(result.body).digest('hex').slice(0, 16)}"`;
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, entry.file), result.body);
      } catch {
        entry.ok = false;
      }
    }
    if (old?.file && old.file !== entry.file) {
      fs.rmSync(path.join(this.dir, old.file), { force: true });
    }
    this.index.set(project.id, entry);
    this.buffers.delete(project.id);
    this.persist();
    return entry;
  }

  persist() {
    try {
      writeJsonAtomic(this.indexPath, Object.fromEntries(this.index));
    } catch {
      // 缓存写失败不影响服务
    }
  }

  /** 删除已不在配置中的项目的缓存 */
  prune(validIds) {
    let changed = false;
    for (const [id, entry] of this.index) {
      if (validIds.has(id)) continue;
      if (entry.file) fs.rmSync(path.join(this.dir, entry.file), { force: true });
      this.index.delete(id);
      this.buffers.delete(id);
      changed = true;
    }
    if (changed) this.persist();
  }

  /** 后台预热：依次抓取尚未缓存或已过期的图标 */
  async warm(projects) {
    for (const project of projects) {
      if (!project.customWanUrl) continue;
      await this.get(project).catch(() => null);
    }
  }
}
