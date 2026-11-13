import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';

const baseline = JSON.parse(readFileSync(new URL('../ci-timings.json', import.meta.url), 'utf8'));
if (baseline.version !== 1) throw new Error('不支持的测试耗时基线版本');

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

function median(timings) {
  const known = Object.values(timings)
    .filter(positive)
    .sort((a, b) => a - b);
  return known[Math.floor(known.length / 2)] ?? 1;
}

const fallback = median(baseline.files);

export function costOf(path, timings = baseline.files) {
  return positive(timings[path])
    ? timings[path]
    : timings === baseline.files
      ? fallback
      : median(timings);
}

// 最长任务优先放入当前总成本最低的一片；仅改变分配，不改变测试范围或隔离。
export function balancedShards(files, count, cost, key) {
  if (!Number.isInteger(count) || count < 1) throw new Error('分片数必须为正整数');
  const shards = Array.from({ length: count }, () => ({ files: [], total: 0 }));
  const ordered = files
    .map((file) => ({ file, cost: cost(file), key: key(file) }))
    .sort((a, b) => b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const entry of ordered) {
    const target = shards.reduce((best, shard) => (shard.total < best.total ? shard : best));
    target.files.push(entry.file);
    target.total += entry.cost;
  }
  return shards.map((shard) => shard.files);
}

export default class BalancedSequencer extends BaseSequencer {
  key(file) {
    return relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/');
  }

  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    if (!Number.isInteger(index) || index < 1 || index > count) throw new Error('分片编号越界');
    return balancedShards(
      files,
      count,
      (file) => costOf(this.key(file)),
      (file) => this.key(file),
    )[index - 1];
  }

  async sort(files) {
    if (!this.ctx.config.shard) return super.sort(files);
    return balancedShards(
      files,
      1,
      (file) => costOf(this.key(file)),
      (file) => this.key(file),
    )[0];
  }
}
