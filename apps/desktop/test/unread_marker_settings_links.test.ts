// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each([
  'components/settings/UpdateCard.tsx',
  'components/settings/EnhancementPacksSection.tsx',
  'components/tasks/CurrentTaskList.tsx',
  'im-template/template/sidebarHeader.tsx',
])('%s 不再放置未读标记设置快捷按钮', (path) => {
  const source = readFileSync(new URL(`../src/renderer/src/${path}`, import.meta.url), 'utf8');
  expect(source).not.toContain('NotificationSettingsLink');
});
