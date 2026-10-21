/**
 * `text_segment.ts` 的词典接入单测 —— QQ 目录用临时目录里的**手写小词典夹具**，
 * 随包资源用仓库里真实的 `resources/jieba`，不读真 QQ 数据、不联网
 * （见 docs/develop/testing.md）。
 *
 * 钉死三件事：
 *   1. QQ 词典可用时优先用它；
 *   2. QQ 词典缺失时回退到随包的 `resources/jieba`，技术词仍能整词输出；
 *   3. 两份都读不到时 `segmentWords` 返回空数组而不是抛错，过滤口径不变。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetJiebaForTest, segmentWords, warmJiebaDict } from '../src/account/text_segment';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DICT_DIR = join(HERE, '../../../resources/jieba');

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
  '开始 8000 vn',
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
  it('QQ 词典可用时优先用 QQ 的', async () => {
    __resetJiebaForTest();
    await warmJiebaDict([fixtureDir(false), BUNDLED_DICT_DIR]);
    expect(segmentWords('这个区块链')).toEqual(['区块链']);
    expect(segmentWords('密钥')).toEqual(['密钥']);
    expect(segmentWords('重启')).toEqual(['重启']);
  });

  it('QQ 词典缺失时回退到随包 resources/jieba', async () => {
    __resetJiebaForTest();
    await warmJiebaDict([null, '/nonexistent/weq/jieba', BUNDLED_DICT_DIR]);
    expect(segmentWords('这个区块链')).toEqual(['区块链']);
    expect(segmentWords('密钥')).toEqual(['密钥']);
    expect(segmentWords('重启')).toEqual(['重启']);
  });

  it('两份词典都缺失时静默跳过，segmentWords 返回空数组', async () => {
    __resetJiebaForTest();
    await expect(warmJiebaDict([null, '/nonexistent/weq/jieba'])).resolves.toBeUndefined();
    expect(segmentWords('密钥')).toEqual([]);
  });

  it('只保留白名单词性：动词 / 名词保留，时间词 / 副词 / 量词被丢弃', async () => {
    __resetJiebaForTest();
    await warmJiebaDict([fixtureDir(false)]);
    expect(segmentWords('欢迎 今天 更新 一下 密钥')).toEqual(['欢迎', '密钥']);
  });

  it('停用词 / 单字 / 纯数字都被过滤', async () => {
    __resetJiebaForTest();
    await warmJiebaDict([fixtureDir(false)]);
    expect(segmentWords('的 我 个 12345')).toEqual([]);
  });

  it('扩充后的停用词能洗掉虚词，同时保留正常聊天词', async () => {
    __resetJiebaForTest();
    await warmJiebaDict([fixtureDir(false)]);
    expect(segmentWords('今天 和 一下 密钥 就是 的')).toEqual(['密钥']);
    expect(segmentWords('谢谢 加油 欢迎 开始 问题')).toEqual([
      '谢谢',
      '加油',
      '欢迎',
      '开始',
      '问题',
    ]);
  });
});
