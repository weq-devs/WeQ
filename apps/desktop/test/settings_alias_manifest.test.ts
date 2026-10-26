// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_ITEM_TARGETS,
  SETTINGS_PAGE_LABELS,
  resolveSettingsTarget,
  settingsGroupFor,
  type SectionId,
} from '../src/renderer/src/components/settings/navigation';
import { APP_SEARCH_ENTRIES } from '../src/renderer/src/components/search/appSearchCatalog';

it('从真实类型声明枚举全部旧 section，均归属于现行页面，默认项都在稳定目录', () => {
  const source = ts.createSourceFile(
    'navigation.ts',
    readFileSync(
      new URL('../src/renderer/src/components/settings/navigation.ts', import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === 'SectionId',
  );
  if (!declaration || !ts.isUnionTypeNode(declaration.type))
    throw new Error('未找到旧 section 联合类型');
  const legacy = declaration.type.types.flatMap((node) =>
    ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
      ? [node.literal.text as SectionId]
      : [],
  );
  expect(legacy.length).toBeGreaterThan(0);
  const canonical = new Set(Object.keys(SETTINGS_PAGE_LABELS));
  for (const section of [...Object.keys(SETTINGS_PAGE_LABELS), ...legacy] as SectionId[]) {
    const target = resolveSettingsTarget({ section });
    expect(canonical.has(target.section), section).toBe(true);
    expect(settingsGroupFor(section).sections, section).toContain(target.section);
    if (target.settingId)
      expect(
        SETTINGS_ITEM_TARGETS.some((item) => item.id === target.settingId),
        `${section}: ${target.settingId}`,
      ).toBe(true);
  }
  expect(SETTINGS_GROUPS.flatMap((group) => group.sections)).toHaveLength(canonical.size);
});

it('每个稳定 ID、公开名称与受支持别名由同一解析器定位，搜索不遗漏已注册项', () => {
  expect(new Set(SETTINGS_ITEM_TARGETS.map((item) => item.id)).size).toBe(
    SETTINGS_ITEM_TARGETS.length,
  );
  for (const item of SETTINGS_ITEM_TARGETS) {
    expect(resolveSettingsTarget({ section: item.section, settingId: item.id })).toMatchObject({
      section: item.section,
      settingId: item.id,
    });
    for (const section of item.from)
      expect(
        resolveSettingsTarget({ section, item: item.label }),
        `${section}: ${item.label}`,
      ).toMatchObject({ section: item.section, settingId: item.id });
    for (const section of item.aliasesFrom ?? item.from)
      for (const alias of item.aliases ?? [])
        expect(
          resolveSettingsTarget({ section, item: alias }),
          `${section}: ${alias}`,
        ).toMatchObject({ section: item.section, settingId: item.id });
    expect(
      APP_SEARCH_ENTRIES.some(
        (entry) => entry.target.kind === 'setting' && entry.target.settingId === item.id,
      ),
      item.id,
    ).toBe(true);
  }
});
it('旧装扮 ID 只定位新气泡项，AI 同名别名按页面隔离', () => {
  expect(
    resolveSettingsTarget({ section: 'message-display', settingId: 'message-decoration' }),
  ).toMatchObject({ section: 'chat-messages', settingId: 'message-bubble' });
  expect(resolveSettingsTarget({ section: 'intent-sense', item: '运行方式' }).settingId).toBe(
    'intent-engine',
  );
  expect(
    resolveSettingsTarget({ section: 'interaction-profile', item: '运行方式' }).settingId,
  ).toBe('profile-engine');
});
it('旧独立 TTS 入口定位 API 页内的语音分区，而非只打开页首 LLM', () => {
  expect(resolveSettingsTarget({ section: 'tts' })).toMatchObject({
    section: 'agentlab',
    settingId: 'tts-providers',
  });
});
