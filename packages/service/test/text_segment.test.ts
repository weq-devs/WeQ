/**
 * `text_segment.ts` 的词典接入单测 —— 用临时目录里的**手写小词典夹具**，不读真
 * QQ 数据、不联网（见 docs/develop/testing.md）。
 *
 * 钉死三件事：
 *   1. 装了 QQ 结巴词典后，ICU 会切碎的技术词（这里用夹具里的合成词占位）能整词输出；
 *   2. 词典缺失（老 QQ / 静态账号）时 `warmJiebaDict` 静默跳过，`segmentWords` 照常工作；
 *   3. 无论走哪条路径，停用词 / 单字 / 纯数字的过滤口径都不变。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetJiebaForTest, segmentWords, warmJiebaDict } from '../src/account/text_segment';

const MAIN_DICT = [
  '区块链 500 n',
  '密钥 63 n',
  '重启 68 v',
  '安装 3000 v',
  '包 9000 n',
  '的 1000000 uj',
  '我 328841 r',
  '密 200 n',
  '钥 150 n',
  '重 900 v',
  '启 300 v',
  '区 400 n',
  '块 350 n',
  '链 250 n',
  '这 800000 r',
  '个 700000 q',
  '今天 40000 t',
  '和 90000 c',
  '就是 5000 d',
  '谢谢 1000 v',
  '加油 2000 v',
  '欢迎 3000 v',
  '开始 8000 v',
  '问题 9000 n',
].join('\n');

const dirs: string[] = [];

function fixtureDir(withHmm: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-text-segment-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'jieba_dict.utf8'), MAIN_DICT);
  if (withHmm) {
    writeFileSync(
      join(dir, 'hmm_model.utf8'),
      [
        '#prob_start',
        '-0.26268660809250016 -3.14e+100 -3.14e+100 -1.4652633398537678',
        '#prob_trans 4x4 matrix',
        '-3.14e+100 -0.510825623765990 -0.916290731874155 -3.14e+100',
        '-0.5897149736854513 -3.14e+100 -3.14e+100 -0.8085250474669937',
        '-3.14e+100 -0.33344856811948514 -1.2603623820268226 -3.14e+100',
        '-0.7211965654669841 -3.14e+100 -3.14e+100 -0.6658631448798212',
        '#prob_emit 4 lines',
        '#B',
        '区:-3.0',
        '#E',
        '块:-3.0',
        '#M',
        '区:-8.0',
        '#S',
        '区:-9.0,块:-9.0',
      ].join('\n'),
    );
  }
  return dir;
}

afterEach(() => {
  __resetJiebaForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('warmJiebaDict + segmentWords', () => {
  it('装了词典后，技术词整词输出而不是被切碎', async () => {
    __resetJiebaForTest();
    await warmJiebaDict(fixtureDir(false));
    expect(segmentWords('这个区块链')).toEqual(['区块链']);
    expect(segmentWords('密钥')).toEqual(['密钥']);
    expect(segmentWords('重启')).toEqual(['重启']);
  });

  it('未装词典时回落到内置分词器，不抛错', async () => {
    __resetJiebaForTest();
    // 没调用 warmJiebaDict —— 走 Intl.Segmenter / 正则兜底。
    expect(() => segmentWords('这个区块链')).not.toThrow();
  });

  it('词典目录缺失 / 为 null 时静默跳过', async () => {
    __resetJiebaForTest();
    await expect(warmJiebaDict(null)).resolves.toBeUndefined();
    await expect(warmJiebaDict('/nonexistent/weq/jieba')).resolves.toBeUndefined();
    expect(() => segmentWords('密钥')).not.toThrow();
  });

  it('无论哪条路径，停用词 / 单字 / 纯数字都被过滤', async () => {
    __resetJiebaForTest();
    await warmJiebaDict(fixtureDir(false));
    expect(segmentWords('的 我 个 12345')).toEqual([]);
  });

  it('扩充后的停用词能洗掉虚词，同时保留正常聊天词', async () => {
    __resetJiebaForTest();
    await warmJiebaDict(fixtureDir(false));
    expect(segmentWords('今天 和 一下 密钥 就是 的')).toEqual(['今天', '密钥']);
    expect(segmentWords('谢谢 加油 欢迎 开始 问题')).toEqual([
      '谢谢',
      '加油',
      '欢迎',
      '开始',
      '问题',
    ]);
  });
});
