import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { findExportBaseline, listExportBaselines } from '../src/account/export/baseline';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-baseline-list-'));
  roots.push(root);
  return root;
}
function write(root: string, name: string, conv = '777') {
  const directory = join(root, name, '.weq-export');
  mkdirSync(directory, { recursive: true });
  const selection = 'a'.repeat(64),
    journal = `messages-${selection}.jsonl`;
  writeFileSync(join(directory, journal), '{}\n');
  writeFileSync(
    join(directory, 'baseline.json'),
    JSON.stringify({
      version: 1,
      kind: 'group',
      conv,
      selection,
      journal,
      name,
      formats: ['json', 'txt'],
      messageCount: 12,
      range: { start: 1, end: 2 },
      updatedAt: 3,
      owner: 'another-account',
    }),
  );
  return directory;
}
it('选择上级目录列出粗略信息，只按会话匹配，不限制范围或账号', () => {
  const root = fixture(),
    selected = write(root, '归档甲');
  write(root, '其他会话', '888');
  const list = listExportBaselines(root);
  expect(list.items).toHaveLength(2);
  expect(list.items.find((item) => item.conv === '777')).toMatchObject({
    name: '归档甲',
    messageCount: 12,
    formats: ['json', 'txt'],
    range: { start: 1, end: 2 },
    bytes: 3,
  });
  expect(findExportBaseline(root, { kind: 'group', conv: '777' })).toContain(selected);
});
it('相同会话找到多个或未找到时要求明确选择，不自动用最新；具体文件夹可消除歧义', () => {
  const root = fixture(),
    selected = write(root, '归档甲');
  write(root, '归档乙');
  expect(() => findExportBaseline(root, { kind: 'group', conv: '777' })).toThrow('找到 2 个');
  expect(() => findExportBaseline(root, { kind: 'group', conv: '999' })).toThrow('新建导出');
  expect(findExportBaseline(selected, { kind: 'group', conv: '777' })).toContain(selected);
});
