import { SETTINGS_ITEM_TARGETS, settingsGroupFor, SETTINGS_PAGE_LABELS } from './navigation';
import { SETTINGS_KEYWORDS } from './keywords';
import { SETTINGS_FIELDS } from './fields';

export * from './navigation';
export { SETTINGS_PAGE_ALIASES } from './keywords';
export * from './fields';
export * from './global';

/** 公开目录不包含当前值；MCP、搜索和文档均从这里枚举设置身份。 */
export const SETTINGS_CATALOG = SETTINGS_ITEM_TARGETS.map((item) => ({
  ...item,
  aliases: [...new Set([...(item.aliases ?? []), ...(SETTINGS_KEYWORDS[item.id] ?? [])])],
  path: ['设置', settingsGroupFor(item.section).label, SETTINGS_PAGE_LABELS[item.section]],
  fields: SETTINGS_FIELDS.filter((field) => field.settingId === item.id),
}));

const byId = new Map(SETTINGS_CATALOG.map((item) => [item.id, item]));
export function findSettingDefinition(id: string) {
  return byId.get(id);
}
export function settingDefinition(id: string) {
  const entry = byId.get(id);
  if (!entry) throw new Error(`设置未登记：${id}`);
  return entry;
}

export function listSettings(options: { page?: string; query?: string } = {}) {
  if (options.page && !Object.hasOwn(SETTINGS_PAGE_LABELS, options.page))
    throw new Error(`未知设置页面：${options.page}`);
  const query = options.query?.trim().toLocaleLowerCase();
  return SETTINGS_CATALOG.filter(
    (item) =>
      (!options.page || item.section === options.page) &&
      (!query ||
        [item.id, item.label, ...item.aliases, ...item.path].some((text) =>
          text.toLocaleLowerCase().includes(query),
        )),
  ).map(({ id, section, label, aliases, path, desktopOnly, fields }) => ({
    id,
    page: section,
    label,
    aliases,
    path,
    desktopOnly: desktopOnly === true,
    reset: fields.map(
      ({
        id,
        card,
        label,
        scope,
        source,
        key,
        directory,
        stopsService,
        desktopOnly,
        remoteUnsupported,
      }) => ({
        id,
        card,
        label,
        scope,
        defaultSource: `${source}:${key}`,
        directory: directory === true,
        stopsService: stopsService === true,
        desktopOnly: desktopOnly === true,
        remoteUnsupported: remoteUnsupported === true,
      }),
    ),
  }));
}
