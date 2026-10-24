/**
 * 卡片上显示的延迟：取最近几次成功探测的中位数，单次网络抖动不会让数字忽高忽低
 */
export const LATENCY_WINDOW = 5;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export class LatencyWindow {
  constructor(size = LATENCY_WINDOW) {
    this.size = size;
    this.samples = new Map();
  }

  /** 记录一次探测结果，返回平滑后的延迟；失败的探测不计入，返回 null */
  add(id, result) {
    if (!result?.alive || typeof result.latency !== 'number') return null;
    const list = this.samples.get(id) || [];
    list.push(result.latency);
    if (list.length > this.size) list.splice(0, list.length - this.size);
    this.samples.set(id, list);
    return median(list);
  }

  delete(id) {
    this.samples.delete(id);
  }
}
