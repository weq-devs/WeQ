import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { qqWriteOutcomeText } from '../src/renderer/src/hooks/useQQWriteSession';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {} }));

function readRepoFile(path: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..', path), 'utf8');
}

describe('用户可见文案', () => {
  it('写操作区分请求提交、QQ 确认、结果未知与未提交', () => {
    expect(qqWriteOutcomeText({ state: 'accepted' })).toBe('正在确认操作完成情况');
    expect(qqWriteOutcomeText({ state: 'confirmed' })).toBe('正在确认操作完成情况');
    expect(qqWriteOutcomeText({ state: 'unconfirmed' })).toBe('暂未确认结果，请在 QQ 中核对后刷新');
    expect(qqWriteOutcomeText({ state: 'unchanged' })).toBe('本机记录没有变化，未提交请求');
  });

  it('随机句库不包含已识别的辱骂、贬低和伤害性劝说', () => {
    const entries: { hitokoto: string; from: string }[] = JSON.parse(
      readRepoFile('resources/hitokoto.json'),
    );
    // 只检查展示正文，作品名称与出处不按关键词删改。
    const inappropriate = /笨蛋|蠢货|白痴|去死|我讨厌你|永远当个废物|内心不够强大|脆弱的人才/;
    expect(entries.filter((entry) => inappropriate.test(entry.hitokoto))).toEqual([]);
  });

  it('修复提示、报告与使用文档不再引导到旧工具入口', () => {
    for (const path of [
      'apps/desktop/src/renderer/src/components/DatabaseDamagedDialog.tsx',
      'apps/desktop/src/renderer/src/components/settings/DatabaseToleranceSection.tsx',
      'packages/service/src/account/db_repair/report.ts',
      'docs/guide/wonderful-tools.md',
      'docs/guide/voice-transcribe.md',
    ]) {
      expect(readRepoFile(path), path).not.toContain('妙妙工具');
    }
  });
});
