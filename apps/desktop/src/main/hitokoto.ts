/**
 * 一言（hitokoto）池 —— 供 WeQ 助手写报告时挑一句做「主题句大字」。
 *
 * 从 `resources/hitokoto.json` 读取句子与出处（hitokoto/from）。
 * 首页直接展示随机句子；助手报告将随机候选交给模型按主题选用。
 *
 * 读盘一次后常驻内存；随机抽样在主进程做（此处允许 Math.random）。
 */

import { readFileSync } from 'node:fs';
import { resolveResource } from './resource';

interface HitokotoEntry {
  hitokoto?: string;
  from?: string;
}

/** 采样结果：句子 + 出处（出处可能缺失）。 */
export interface HitokotoVerse {
  text: string;
  from: string;
}

let cache: HitokotoEntry[] | null = null;

function load(): HitokotoEntry[] {
  if (cache) return cache;
  try {
    const path = resolveResource('hitokoto.json');
    const parsed = path ? JSON.parse(readFileSync(path, 'utf-8')) : [];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * 随机抽 n 条一言（去重、去空、句长适中——太长的做不了大字标题）。
 * 资源缺失时返回空数组，调用方（系统提示）自动跳过该小节。
 */
export function sampleHitokoto(n: number): HitokotoVerse[] {
  const all = load();
  if (!all.length) return [];
  const pool = all.filter((e) => {
    const t = e.hitokoto?.trim();
    return t && t.length >= 4 && t.length <= 40;
  });
  if (!pool.length) return [];

  const picked: HitokotoVerse[] = [];
  const seen = new Set<number>();
  const want = Math.min(n, pool.length);
  let guard = 0;
  while (picked.length < want && guard < want * 20) {
    guard += 1;
    const i = Math.floor(Math.random() * pool.length);
    if (seen.has(i)) continue;
    seen.add(i);
    picked.push({ text: pool[i]!.hitokoto!.trim(), from: pool[i]!.from?.trim() || '' });
  }
  return picked;
}
