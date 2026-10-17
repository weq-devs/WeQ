/**
 * jieba 分词引擎的纯逻辑单测 —— 用一份**手写的小词典夹具**，不读真 QQ 数据、
 * 不联网（见 docs/develop/testing.md）。
 *
 * 重点钉死三件事：
 *   1. 词典 DP 能切出 ICU 会切碎的合成词（这里用「密钥」这类词占位）；
 *   2. HMM 能把词典外的生词合成一个词（真机上是「跑路」「好累」这类）；
 *   3. 缺词典 / 缺 HMM 时优雅降级，绝不抛错。
 */

import { describe, expect, it } from 'vitest';
import { createJiebaSegmenter, setDefaultSegmenter, tokenizeText } from '../src/segment';
import { normalizeChatToken } from '../src/stopwords';

/**
 * 手写主词典：故意收录「北京大学」「密钥」「重启」「小笼包」几个合成词，
 * 并给单字留出词频，让 DP 有真实取舍空间。
 */
const MAIN_DICT = [
  '北京大学 2053 nt',
  '密钥 63 n',
  '重启 68 v',
  '小笼包 4 n',
  '我 328841 r',
  '想 100000 v',
  '搜 5000 v',
  '一下 8000 m',
  '的 1000000 uj',
  '录取 3000 v',
  '通知书 2000 n',
  '今天 40000 t',
  '加班 686 v',
  '到 90000 p',
  '十一点 500 m',
  '好 200000 a',
  '累 3000 a',
  '啊 100000 y',
  '大 144099 a',
  '手 28466 n',
  '子 19089 ng',
  '来 90000 v',
  '救 4000 v',
].join('\n');

/** 手写用户词典：无词频的「区块链」表示强制成词（对应 QQ 的 user_dict）。 */
const USER_DICT = ['区块链 10 nz', '云计算'].join('\n');

/**
 * 手写 HMM 模型：结构照抄 QQ `hmm_model.utf8`（4 态 + 起始/转移/发射）。
 * 发射表极小，只覆盖「跑路」「好累」用到的字，够验证 Viterbi 行为即可。
 */
const HMM_MODEL = [
  '#',
  '#0:B',
  '#1:E',
  '#2:M',
  '#3:S',
  '#',
  '#B:-0.26268660809250016',
  '#E:-3.14e+100',
  '#M:-3.14e+100',
  '#S:-1.4652633398537678',
  '#prob_start',
  '-0.26268660809250016 -3.14e+100 -3.14e+100 -1.4652633398537678',
  '#prob_trans 4x4 matrix',
  '-3.14e+100 -0.510825623765990 -0.916290731874155 -3.14e+100',
  '-0.5897149736854513 -3.14e+100 -3.14e+100 -0.8085250474669937',
  '-3.14e+100 -0.33344856811948514 -1.2603623820268226 -3.14e+100',
  '-0.7211965654669841 -3.14e+100 -3.14e+100 -0.6658631448798212',
  '#prob_emit 4 lines',
  '#B',
  '跑:-3.0,好:-4.0',
  '#E',
  '路:-3.0,累:-4.0',
  '#M',
  '跑:-8.0,好:-8.0',
  '#S',
  '跑:-9.0,好:-9.0,路:-9.0,累:-9.0',
].join('\n');

function build() {
  return createJiebaSegmenter({
    jiebaDict: MAIN_DICT,
    userDict: USER_DICT,
    hmmModel: HMM_MODEL,
  });
}

describe('createJiebaSegmenter', () => {
  it('词典里有的合成词不会被切碎', () => {
    const seg = build();
    expect(seg.cut('密钥')).toEqual(['密钥']);
    expect(seg.cut('重启')).toEqual(['重启']);
    expect(seg.cut('北京大学')).toEqual(['北京大学']);
    expect(seg.cut('小笼包')).toEqual(['小笼包']);
  });

  it('用户词典里的词强制成词（对应 QQ user_dict 的区块链）', () => {
    const seg = build();
    expect(seg.cut('区块链')).toEqual(['区块链']);
    expect(seg.cut('云计算')).toEqual(['云计算']);
  });

  it('词典外生词交给 HMM 合成一个词', () => {
    const seg = build();
    expect(seg.cut('跑路')).toEqual(['跑路']);
  });

  it('整句切分：中文按词、英文/数字按整块且小写化', () => {
    const seg = build();
    expect(seg.cut('我想搜一下北京大学的录取通知书')).toEqual([
      '我',
      '想',
      '搜',
      '一下',
      '北京大学',
      '的',
      '录取',
      '通知书',
    ]);
    expect(seg.cut('给 #45 close 了')).toEqual(['给', '45', 'close', '了']);
  });

  it('切分结果的字符拼接等于输入中文部分（不丢字）', () => {
    const seg = build();
    const input = '今天加班到十一点好累啊';
    expect(seg.cut(input).join('')).toBe(input);
  });

  it('空串 / 纯标点 / 空白不抛错', () => {
    const seg = build();
    expect(seg.cut('')).toEqual([]);
    expect(seg.cut('，。！？')).toEqual([]);
    expect(seg.cut('   ')).toEqual([]);
  });
});

describe('降级', () => {
  it('没有 HMM 时，词典外生词退化为单字（不抛错）', () => {
    const seg = createJiebaSegmenter({ jiebaDict: MAIN_DICT, userDict: USER_DICT });
    expect(seg.cut('跑路')).toEqual(['跑', '路']);
    // 词典里的词照常成词。
    expect(seg.cut('密钥')).toEqual(['密钥']);
  });

  it('完全没给词典时退化为「中文按字、英文按词」', () => {
    const seg = createJiebaSegmenter({});
    expect(seg.cut('密钥')).toEqual(['密', '钥']);
    expect(seg.cut('hello世界')).toEqual(['hello', '世', '界']);
  });
});

describe('tokenizeText（常用语 / 关键词提取）', () => {
  it('未安装默认切分器时，退回正则切分且过滤短碎片', () => {
    setDefaultSegmenter(null);
    expect(tokenizeText('下载链接 a')).toEqual(['下载链接']);
  });

  it('安装默认切分器后按词切，并小写化', () => {
    setDefaultSegmenter(build());
    expect(tokenizeText('密钥 和 Close')).toEqual(['密钥', 'close']);
    setDefaultSegmenter(null);
  });

  it('常用语与词云共用停用词过滤，不把虚词算进高频词', () => {
    setDefaultSegmenter(build());
    expect(tokenizeText('今天 和 一下 密钥 就是 的')).toEqual(['今天', '密钥']);
    setDefaultSegmenter(null);
  });
});

describe('normalizeChatToken（停用词 / 噪声）', () => {
  it('过滤单字、纯数字、纯符号和短虚词', () => {
    for (const raw of ['', '的', '我', '12345', '...', '就是', '那么', '一下', '我的']) {
      expect(normalizeChatToken(raw)).toBeNull();
    }
  });

  it('过滤英文功能词，但保留有内容的英文词', () => {
    expect(normalizeChatToken('The')).toBeNull();
    expect(normalizeChatToken("don't")).toBeNull();
    expect(normalizeChatToken('socket')).toBe('socket');
  });

  it('不误杀可能真的是口头禅的聊天词', () => {
    for (const word of ['谢谢', '加油', '晚安', '欢迎', '开始', '问题', '今天', '结果', '好朋友']) {
      expect(normalizeChatToken(word)).toBe(word);
    }
  });

  it('统一小写并去掉首尾空白', () => {
    expect(normalizeChatToken('  Close  ')).toBe('close');
  });
});
