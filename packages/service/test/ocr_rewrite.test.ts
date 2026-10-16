/**
 * 图片文字识别结果回写单测：OCR 与语音转写一样是导出里最后跑完的一步，消息文件
 * 早已落盘，靠 `[图片: 文件名]`（文本形态）和 `<small class="cap">文件名</small>`
 * （HTML 形态）两个锚点做事后替换。
 *
 * 与语音那条线的差别：识别结果常常是**多行**的 —— TXT / CSV 折成空格保住一行一条
 * 消息的结构，HTML 则转成 `<br>`。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rewriteOcrTexts } from '../src/account/export/ocr_rewrite';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-ocr-rewrite-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('rewriteOcrTexts', () => {
  it('TXT：`[图片: 文件名]` → `[图片] 识别文字`（多行折成空格）', () => {
    const path = write('a.txt', '[2026-10-16 10:00:00] 10001: [图片: abc.jpg]\n');
    const stats = rewriteOcrTexts([path], { 'abc.jpg': { text: '第一行\n第二行' } });
    expect(read(path)).toBe('[2026-10-16 10:00:00] 10001: [图片] 第一行 第二行\n');
    expect(stats).toEqual({ files: 1, replaced: 1, skipped: 0 });
  });

  it('TXT：保留 → media/image 路径，只换文件名那一节', () => {
    const path = write('b.txt', '[图片: abc.jpg → media/image/abc.jpg]\n');
    rewriteOcrTexts([path], { 'abc.jpg': { text: '收到' } });
    expect(read(path)).toBe('[图片 → media/image/abc.jpg] 收到\n');
  });

  it('同一条图片出现多次（回复引用 / 合并转发）全部替换', () => {
    const path = write('c.txt', '[图片: a.jpg] 楼上的 [图片: a.jpg]\n');
    const stats = rewriteOcrTexts([path], { 'a.jpg': { text: '文字' } });
    expect(read(path)).toBe('[图片] 文字 楼上的 [图片] 文字\n');
    expect(stats.replaced).toBe(2);
  });

  it('空文字 / 没结果的文件名不动锚点', () => {
    const path = write('d.txt', '[图片: a.jpg] [图片: b.jpg]\n');
    const stats = rewriteOcrTexts([path], { 'a.jpg': { text: '   ' } });
    expect(read(path)).toBe('[图片: a.jpg] [图片: b.jpg]\n');
    expect(stats).toEqual({ files: 0, replaced: 0, skipped: 0 });
  });

  it('HTML：图片下方的小字换成识别文字（换行转 <br>，特殊字符转义）', () => {
    const path = write(
      'index.html',
      '<div class="bubble"><span class="pic-wrap"><img class="media" src="media/image/a.jpg" alt="图片">' +
        '<small class="cap">a.jpg</small></span></div>\n',
    );
    rewriteOcrTexts([path], { 'a.jpg': { text: '降价 <50%> & 速来\n第二行' } });
    expect(read(path)).toBe(
      '<div class="bubble"><span class="pic-wrap"><img class="media" src="media/image/a.jpg" alt="图片">' +
        '<small class="cap">降价 &lt;50%&gt; &amp; 速来<br>第二行</small></span></div>\n',
    );
  });

  it('CSV：含逗号 / 引号的识别结果跳过（宁可留文件名，也不写出坏 CSV）', () => {
    const path = write('e.csv', '时间,内容\n"2026-10-16","[图片: a.jpg]"\n');
    const stats = rewriteOcrTexts([path], { 'a.jpg': { text: '标题,正文' } });
    expect(read(path)).toBe('时间,内容\n"2026-10-16","[图片: a.jpg]"\n');
    expect(stats).toEqual({ files: 0, replaced: 0, skipped: 1 });
  });

  it('CSV：安全文本照常替换', () => {
    const path = write('f.csv', '时间,内容\n"2026-10-16","[图片: a.jpg]"\n');
    const stats = rewriteOcrTexts([path], { 'a.jpg': { text: '开头' } });
    expect(read(path)).toBe('时间,内容\n"2026-10-16","[图片] 开头"\n');
    expect(stats).toEqual({ files: 1, replaced: 1, skipped: 0 });
  });

  it('ChatLab JSON：按 JSON 字符串字面量转义后替换', () => {
    const path = write('g.json', '{"content":"看这个 [图片: a.jpg]"}');
    rewriteOcrTexts([path], { 'a.jpg': { text: '他说"你好"' } }, { chatlabJson: true });
    expect(read(path)).toBe('{"content":"看这个 [图片] 他说\\"你好\\""}');
  });

  it('普通 JSON / XLSX 跳过（序列化的是元素结构，没有锚点）', () => {
    const json = write('h.json', '{"elements":[{"type":"pic","fileName":"a.jpg"}]}');
    const xlsx = write('i.xlsx', '[图片: a.jpg]');
    const stats = rewriteOcrTexts([json, xlsx], { 'a.jpg': { text: '文字' } });
    expect(read(json)).toBe('{"elements":[{"type":"pic","fileName":"a.jpg"}]}');
    expect(stats).toEqual({ files: 0, replaced: 0, skipped: 0 });
  });

  it('不存在的文件安静跳过', () => {
    const stats = rewriteOcrTexts([join(dir, 'missing.txt')], { 'a.jpg': { text: '文字' } });
    expect(stats).toEqual({ files: 0, replaced: 0, skipped: 0 });
  });
});
