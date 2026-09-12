/**
 * 路径段清洗 / 文件名去重的单测。这块逻辑历史上「各模块各写一份、行为逐步漂移」，
 * 统一后的语义就是这里的契约 —— 测试把这个契约钉死，防止再漂。
 */

import { describe, expect, it } from 'vitest';
import { safeRelSegments, sanitizeSegment, uniqueName } from '../src/common/path_sanitize';

describe('sanitizeSegment', () => {
  it('普通名字原样保留', () => {
    expect(sanitizeSegment('群导出 2026', 'fb')).toBe('群导出 2026');
  });

  it.each([
    ['非法字符 → _', 'a<b>c:d"e/f\\g|h?i*j', 'a_b_c_d_e_f_g_h_i_j'],
    ['控制字符 → _（含 \t，控制符先替换再折叠空白）', 'a\u0000\u0007b', 'a__b'],
    ['连续空格折叠', 'a  b', 'a b'],
    ['\t 属控制符，变成 _ 不参与折叠', 'a \t b', 'a _ b'],
    ['去首尾空白与尾点', '  foo. . ', 'foo'],
  ])('%s', (_label, input, want) => {
    expect(sanitizeSegment(input, 'fb')).toBe(want);
  });

  it('超过 maxLen 截断', () => {
    expect(sanitizeSegment('x'.repeat(100), 'fb', { maxLen: 10 })).toBe('x'.repeat(10));
    expect(sanitizeSegment('y'.repeat(100), 'fb')).toBe('y'.repeat(80)); // 默认 80
  });

  it.each([
    ['undefined', undefined],
    ['空串', ''],
    ['纯空白（折叠后为空）', '   '],
    ['纯点（尾点剥光）', '. . .'],
  ])('%s → 回退 fallback（永不返回空串）', (_label, input) => {
    expect(sanitizeSegment(input as string | undefined, 'fallback')).toBe('fallback');
  });

  it('非法字符被替换后非空，不算空段（回下划线段而不是 fallback）', () => {
    expect(sanitizeSegment('<>?*', 'fb')).toBe('____');
  });

  it.each(['CON', 'con', 'Nul', 'com1', 'LPT9'])('Windows 保留名 %s → fallback', (name) => {
    expect(sanitizeSegment(name, 'fb')).toBe('fb');
  });

  it('保留名带后缀不算保留', () => {
    expect(sanitizeSegment('con.txt', 'fb')).toBe('con.txt');
  });
});

describe('uniqueName', () => {
  it('无冲突原样返回并登记', () => {
    const used = new Set<string>();
    expect(uniqueName('a.gif', used)).toBe('a.gif');
    expect(used.has('a.gif')).toBe(true);
  });

  it('冲突后 a.gif → a-2.gif → a-3.gif（保留扩展名）', () => {
    const used = new Set<string>();
    expect(uniqueName('a.gif', used)).toBe('a.gif');
    expect(uniqueName('a.gif', used)).toBe('a-2.gif');
    expect(uniqueName('a.gif', used)).toBe('a-3.gif');
  });

  it('无扩展名 → a-2', () => {
    const used = new Set<string>(['readme']);
    expect(uniqueName('readme', used)).toBe('readme-2');
  });

  it('去重大小写不敏感（通过 uniqueName 登记的名字才算占用）', () => {
    const used = new Set<string>();
    expect(uniqueName('A.GIF', used)).toBe('A.GIF'); // 登记小写 key
    expect(uniqueName('a.gif', used)).toBe('a-2.gif');
  });

  it('extname 取最后一段扩展名：2026.01.02 → 主干 2026.01 + .02', () => {
    const used = new Set<string>(['2026.01.02']);
    const names = [uniqueName('2026.01.02', used), uniqueName('2026.01.02', used)];
    expect(names[0]).toBe('2026.01-2.02');
    expect(names[1]).toBe('2026.01-3.02');
  });
});

describe('safeRelSegments', () => {
  it('逐段清洗', () => {
    expect(safeRelSegments('a/b c/d..')).toEqual(['a', 'b c', 'd']);
  });

  it('「..」整段只含点 → 回退 file，防目录穿越', () => {
    expect(safeRelSegments('../../etc/passwd')).toEqual(['file', 'file', 'etc', 'passwd']);
  });

  it('空段走 sanitize 的 fallback（file），不会真的消失', () => {
    expect(safeRelSegments('??/ok')).toEqual(['__', 'ok']);
    expect(safeRelSegments('a//b')).toEqual(['a', 'file', 'b']);
  });
});
