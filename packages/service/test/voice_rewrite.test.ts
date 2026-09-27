/**
 * 语音转写回写单测：转写是导出里最后跑完的一步，消息文件早已落盘，靠
 * `[语音: 文件名]`（文本形态）和 `<small class="cap">文件名</small>`（HTML 形态）
 * 两个锚点做事后替换。
 *
 * 回归点：TXT / CSV 过去只有裸的 `[语音]`，没有任何可用于定位的键，转写结果
 * 只能单独躺在 transcripts.json 里 —— 用户看到的还是文件名。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rewriteVoiceTranscripts } from '../src/account/export/voice_rewrite';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-voice-rewrite-'));
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

describe('rewriteVoiceTranscripts', () => {
  it('TXT：`[语音: 文件名]` → `[语音] 转写文本`', () => {
    const path = write('a.txt', '[2026-09-27 10:00:00] 10001: [语音: abc.silk]\n');
    const stats = rewriteVoiceTranscripts([path], { 'abc.silk': '你好呀' });
    expect(read(path)).toBe('[2026-09-27 10:00:00] 10001: [语音] 你好呀\n');
    expect(stats).toEqual({ files: 1, replaced: 1, skipped: 0 });
  });

  it('TXT：保留 → media/record 路径，只换文件名那一节', () => {
    const path = write('b.txt', '[语音: abc.silk → media/record/abc.wav]\n');
    rewriteVoiceTranscripts([path], { 'abc.silk': '收到' });
    expect(read(path)).toBe('[语音 → media/record/abc.wav] 收到\n');
  });

  it('同一条语音出现多次（回复引用 / 合并转发）全部替换', () => {
    const path = write('c.txt', '[语音: abc.silk] 引用 [语音: abc.silk] 再引用\n');
    const stats = rewriteVoiceTranscripts([path], { 'abc.silk': '嗯' });
    expect(read(path)).toBe('[语音] 嗯 引用 [语音] 嗯 再引用\n');
    expect(stats.replaced).toBe(2);
  });

  it('转写里的换行折成空格，不撑开行结构', () => {
    const path = write('d.txt', '[语音: abc.silk]\n');
    rewriteVoiceTranscripts([path], { 'abc.silk': '第一行\n第二行' });
    expect(read(path)).toBe('[语音] 第一行 第二行\n');
  });

  it('CSV：含半角逗号 / 引号 / 换行的转写跳过，保留文件名而不是写坏文件', () => {
    const path = write('e.csv', '"时间,内容"\r\n"1","[语音: abc.silk]"\r\n');
    const logs: string[] = [];
    const stats = rewriteVoiceTranscripts(
      [path],
      { 'abc.silk': '好的,没问题' },
      {
        onLog: (t) => logs.push(t),
      },
    );
    expect(read(path)).toBe('"时间,内容"\r\n"1","[语音: abc.silk]"\r\n');
    expect(stats.replaced).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(logs.length).toBe(1);
  });

  it('CSV：全角逗号不破坏 CSV，照常替换', () => {
    const path = write('e2.csv', '"1","[语音: abc.silk]"\r\n');
    rewriteVoiceTranscripts([path], { 'abc.silk': '好的，没问题' });
    expect(read(path)).toBe('"1","[语音] 好的，没问题"\r\n');
  });

  it('CSV：无特殊字符的转写正常替换', () => {
    const path = write('f.csv', '"1","[语音: abc.silk]"\r\n');
    rewriteVoiceTranscripts([path], { 'abc.silk': '好的' });
    expect(read(path)).toBe('"1","[语音] 好的"\r\n');
  });

  it('HTML：文件名小字换成转写文本，音频元素不动', () => {
    const path = write(
      'index.html',
      '<span class="voice"><audio controls src="media/record/abc.wav"></audio>' +
        '<small class="cap">abc.silk</small></span>',
    );
    rewriteVoiceTranscripts([path], { 'abc.silk': '在的' });
    expect(read(path)).toBe(
      '<span class="voice"><audio controls src="media/record/abc.wav"></audio>' +
        '<small class="cap">在的</small></span>',
    );
  });

  it('HTML：转写文本先做转义（不会被当成标签注入）', () => {
    const path = write('x.html', '<small class="cap">abc.silk</small>');
    rewriteVoiceTranscripts([path], { 'abc.silk': '<b>粗</b>' });
    expect(read(path)).toBe('<small class="cap">&lt;b&gt;粗&lt;/b&gt;</small>');
  });

  it('ChatLab json：按 JSON 字符串转义替换，普通 JSON 不动', () => {
    const chatlab = write('chat.json', '{"content":"[语音: abc.silk]"}\n');
    rewriteVoiceTranscripts([chatlab], { 'abc.silk': '嘿' }, { chatlabJson: true });
    expect(read(chatlab)).toBe('{"content":"[语音] 嘿"}\n');

    const plain = write('plain.json', '{"content":"[语音: abc.silk]"}\n');
    rewriteVoiceTranscripts([plain], { 'abc.silk': '嘿' });
    expect(read(plain)).toBe('{"content":"[语音: abc.silk]"}\n');
  });

  it('文件名里的正则元字符按字面匹配', () => {
    const path = write('g.txt', '[语音: a(1)+b.silk]\n');
    rewriteVoiceTranscripts([path], { 'a(1)+b.silk': '好' });
    expect(read(path)).toBe('[语音] 好\n');
  });

  it('空转写 / 不存在的文件 / xlsx 都安全跳过', () => {
    const path = write('h.txt', '[语音: abc.silk]\n');
    const stats = rewriteVoiceTranscripts([path, join(dir, 'nope.txt'), join(dir, 'k.xlsx')], {
      'abc.silk': '   ',
    });
    expect(read(path)).toBe('[语音: abc.silk]\n');
    expect(stats).toEqual({ files: 0, replaced: 0, skipped: 0 });
  });
});
