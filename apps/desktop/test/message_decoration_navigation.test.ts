// @vitest-environment node
import { expect, it } from 'vitest';
import { resolveSettingsTarget } from '../src/renderer/src/components/settings/navigation';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';

it.each(['消息装扮', '消息装扮（气泡/字体/挂件）'])('旧入口 %s 定位到拆分后的气泡开关', (item) => {
  expect(resolveSettingsTarget({ section: 'message-display', item })).toEqual({
    section: 'chat-messages',
    item: '消息气泡',
    settingId: 'message-bubble',
  });
});

it('旧稳定 ID 仍能定位，新气泡与字体可分别搜索', () => {
  expect(
    resolveSettingsTarget({ section: 'chat-messages', settingId: 'message-decoration' }),
  ).toEqual({
    section: 'chat-messages',
    item: '消息气泡',
    settingId: 'message-bubble',
  });
  for (const [item, settingId] of [
    ['消息气泡', 'message-bubble'],
    ['消息字体', 'message-font'],
  ] as const) {
    expect(searchAppEntries(item)[0]?.target).toEqual({
      kind: 'setting',
      section: 'chat-messages',
      item,
      settingId,
    });
  }
});
