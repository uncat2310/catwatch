/**
 * 探测历史与状态机
 * - 按 10 分钟分桶聚合（成功/失败/延迟），保留 7 天
 * - 连续失败达到阈值才判定离线，避免抖动误报
 * - 状态翻转时产出事件（down / up），供通知与前端展示
 */

export const BUCKET_MS = 10 * 60 * 1000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BAR_SLOT_MS = 30 * 60 * 1000;
export const BAR_SLOTS = 48;
export const DOWN_THRESHOLD = 3;
const MAX_EVENTS = 100;
const SCHEMA_VERSION = 1;

function emptyEntry(url) {
  return {
    url,
    // [bucketStartMs, ok, fail, latencySum, latencyCount]
    buckets: [],
    state: null,
    since: null,
    failStreak: 0,
    firstFailAt: null,
    lastError: null
  };
}

function ratio(ok, total) {
  return total > 0 ? ok / total : null;
}

export class HistoryStore {
  constructor({ downThreshold = DOWN_THRESHOLD } = {}) {
    this.downThreshold = downThreshold;
    this.entries = new Map();
    this.events = [];
    this.dirty = false;
  }

  /**
   * 记录一次探测结果；状态翻转时返回事件，否则返回 null
   */
  record(project, result, now = Date.now()) {
    const { id, url } = project;
    let entry = this.entries.get(id);
    if (!entry || entry.url !== url) {
      entry = emptyEntry(url);
      this.entries.set(id, entry);
    }

    const bucketStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    let bucket = entry.buckets[entry.buckets.length - 1];
    if (!bucket || bucket[0] !== bucketStart) {
      bucket = [bucketStart, 0, 0, 0, 0];
      entry.buckets.push(bucket);
      const cutoff = now - RETENTION_MS;
      while (entry.buckets.length && entry.buckets[0][0] < cutoff) {
        entry.buckets.shift();
      }
    }

    let event = null;
    if (result.alive) {
      bucket[1] += 1;
      if (typeof result.latency === 'number') {
        bucket[3] += result.latency;
        bucket[4] += 1;
      }
      entry.failStreak = 0;
      entry.firstFailAt = null;
      entry.lastError = null;
      if (entry.state !== 'up') {
        const prevState = entry.state;
        const prevSince = entry.since;
        entry.state = 'up';
        entry.since = now;
        if (prevState === 'down') {
          event = { type: 'up', durationMs: prevSince ? now - prevSince : null };
        }
      }
    } else {
      bucket[2] += 1;
      entry.failStreak += 1;
      entry.firstFailAt = entry.firstFailAt || now;
      entry.lastError = result.error || null;
      if (entry.failStreak >= this.downThreshold && entry.state !== 'down') {
        entry.state = 'down';
        entry.since = entry.firstFailAt;
        event = { type: 'down', error: entry.lastError };
      }
    }

    this.dirty = true;
    if (event) {
      event = { id, title: project.title || id, url, at: now, ...event };
      this.events.push(event);
      if (this.events.length > MAX_EVENTS) {
        this.events.splice(0, this.events.length - MAX_EVENTS);
      }
    }
    return event;
  }

  /** 移除已不在配置中的项目 */
  prune(validIds) {
    for (const id of this.entries.keys()) {
      if (!validIds.has(id)) {
        this.entries.delete(id);
        this.dirty = true;
      }
    }
  }

  summary(id, now = Date.now()) {
    const entry = this.entries.get(id);
    if (!entry) return null;

    const barEnd = Math.ceil((now + 1) / BAR_SLOT_MS) * BAR_SLOT_MS;
    const barStart = barEnd - BAR_SLOTS * BAR_SLOT_MS;
    const slots = Array.from({ length: BAR_SLOTS }, (_, i) => ({
      t: barStart + i * BAR_SLOT_MS,
      ok: 0,
      fail: 0,
      latSum: 0,
      latN: 0
    }));

    const dayCutoff = now - 24 * 60 * 60 * 1000;
    let ok24 = 0, fail24 = 0, latSum24 = 0, latN24 = 0;
    let ok7 = 0, fail7 = 0;

    for (const [t, ok, fail, latSum, latN] of entry.buckets) {
      ok7 += ok;
      fail7 += fail;
      if (t >= dayCutoff) {
        ok24 += ok;
        fail24 += fail;
        latSum24 += latSum;
        latN24 += latN;
      }
      if (t >= barStart) {
        const slot = slots[Math.floor((t - barStart) / BAR_SLOT_MS)];
        if (slot) {
          slot.ok += ok;
          slot.fail += fail;
          slot.latSum += latSum;
          slot.latN += latN;
        }
      }
    }

    return {
      state: entry.state,
      since: entry.since,
      uptime24h: ratio(ok24, ok24 + fail24),
      uptime7d: ratio(ok7, ok7 + fail7),
      avgLatency24h: latN24 > 0 ? Math.round(latSum24 / latN24) : null,
      bars: slots.map((slot) => ({
        t: slot.t,
        u: ratio(slot.ok, slot.ok + slot.fail),
        l: slot.latN > 0 ? Math.round(slot.latSum / slot.latN) : null
      }))
    };
  }

  recentEvents(limit = 20) {
    return this.events.slice(-limit).reverse();
  }

  toJSON() {
    const entries = {};
    for (const [id, entry] of this.entries) {
      entries[id] = entry;
    }
    return { version: SCHEMA_VERSION, entries, events: this.events };
  }

  static fromJSON(data, options) {
    const store = new HistoryStore(options);
    if (!data || data.version !== SCHEMA_VERSION) return store;
    for (const [id, raw] of Object.entries(data.entries || {})) {
      if (!raw || typeof raw.url !== 'string' || !Array.isArray(raw.buckets)) continue;
      store.entries.set(id, {
        ...emptyEntry(raw.url),
        buckets: raw.buckets.filter((b) => Array.isArray(b) && b.length === 5),
        state: raw.state === 'up' || raw.state === 'down' ? raw.state : null,
        since: typeof raw.since === 'number' ? raw.since : null
      });
    }
    if (Array.isArray(data.events)) {
      store.events = data.events.slice(-MAX_EVENTS);
    }
    return store;
  }
}
