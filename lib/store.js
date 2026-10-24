import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseHttpUrl } from '../shared/url.js';

export const MAX_PROJECTS = 200;
const MAX_TITLE_LENGTH = 80;
const ID_PATTERN = /^[\p{L}\p{N}_.:-]{1,64}$/u;

/**
 * 校验并规范化前端提交的项目列表；只保留已知字段
 * 返回 { ok: true, projects } 或 { ok: false, error }
 */
export function sanitizeProjects(input) {
  if (!Array.isArray(input)) return { ok: false, error: 'NOT_AN_ARRAY' };
  if (input.length > MAX_PROJECTS) return { ok: false, error: 'TOO_MANY_PROJECTS' };

  const seen = new Set();
  const projects = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'INVALID_PROJECT' };
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!ID_PATTERN.test(id)) return { ok: false, error: 'INVALID_ID' };
    if (seen.has(id)) return { ok: false, error: 'DUPLICATE_ID' };
    seen.add(id);

    const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
    if (!title) return { ok: false, error: 'INVALID_TITLE' };

    const parsed = parseHttpUrl(raw.customWanUrl);
    if (!parsed) return { ok: false, error: 'INVALID_URL' };

    projects.push({
      id,
      categoryId: 'services',
      title,
      customWanUrl: parsed.href,
      pingEnabled: raw.pingEnabled !== false,
      statusPublic: raw.statusPublic === true
    });
  }
  return { ok: true, projects };
}

/**
 * 原子写入：先写临时文件再 rename；
 * 单文件 bind mount（rename 会 EBUSY/EXDEV）时退回直接覆盖写
 */
export function writeJsonAtomic(filePath, data) {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    if (err?.code === 'EBUSY' || err?.code === 'EXDEV' || err?.code === 'EPERM') {
      fs.writeFileSync(filePath, content, 'utf-8');
      return;
    }
    throw err;
  }
}

/** 常量时间比较管理口令 */
export function tokenMatches(expected, provided) {
  if (!expected || typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

export function readBearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
