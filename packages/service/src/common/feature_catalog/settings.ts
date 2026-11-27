import {
  SETTINGS_CATALOG,
  SETTINGS_PAGE_ALIASES,
  SETTINGS_PAGE_LABELS,
  settingsPagePath,
  type SettingsPageId,
} from '../settings_catalog';
import type { FeatureDefinition } from './model';

export function settingFeatureId(id: string) {
  return `setting:${id}`;
}

function settingsPageFeatureId(page: SettingsPageId) {
  return `settings.page.${page}`;
}

const pageDetails: Partial<
  Record<SettingsPageId, Pick<FeatureDefinition, 'summary' | 'docs' | 'tools'>>
> = {
  'database-management': {
    summary: '设置 QQ 数据库的监听与读取，查看体检和修复入口，浏览或导出数据库。',
    docs: ['guide/settings.md', 'guide/database-view.md'],
  },
  credentials: {
    summary: '查看 QQ 会话凭据与在线能力相关配置。',
    docs: ['guide/settings.md'],
    tools: ['get_web_tokens', 'get_client_key', 'get_download_rkeys', 'get_ptlogin_jump_url'],
  },
  remote: {
    summary: '查看本机浏览器访问地址，配对手机和管理已配对设备。',
    docs: ['guide/remote-web.md'],
  },
  mcp: {
    summary: '启停 MCP 服务器，查看连接信息或安装到本机 AI 客户端。',
    docs: ['guide/mcp-server.md'],
    tools: [
      'list_features',
      'get_feature',
      'list_settings',
      'list_capabilities',
      'get_capability',
      'call_capability',
    ],
  },
  accounts: {
    summary: '查看和切换已配置的 QQ 账号与数据源。',
    docs: ['guide/settings.md'],
    tools: ['list_accounts', 'switch_account', 'select_open_account'],
  },
  recognition: {
    summary: '配置图中文字识别、语音转写及相关模型。',
    docs: ['guide/settings.md', 'guide/voice-transcribe.md'],
    tools: ['get_ocr_status', 'ocr_image_text'],
  },
  onebot: {
    summary: '管理当前 QQ 账号的 OneBot 运行状态和网络连接，可接入 cc-connect。',
    docs: ['guide/onebot-cc-connect.md'],
  },
  sse: {
    summary: '管理消息事件推送目标，并设置推送防抖和大量消息阈值。',
    docs: ['guide/settings.md'],
  },
  assistant: {
    summary: '配置 QQ 公众号推送及资源服务，WeQ 运行期间提供资源。',
    docs: ['guide/settings.md'],
  },
  backup: {
    summary: '选择设置、账号配置、草稿或助手数据导出，并按选择范围预览和恢复。',
    docs: ['guide/settings.md'],
  },
  version: {
    summary: '查看版本和内置组件，管理桌面端的更新检查和安装。',
    docs: ['guide/settings.md'],
  },
  logs: {
    summary: '查看应用日志和性能记录，设置历史保留方式。',
    docs: ['guide/performance-monitor.md'],
  },
};

export const SETTINGS_PAGE_FEATURES = (Object.keys(SETTINGS_PAGE_LABELS) as SettingsPageId[]).map(
  (page) =>
    ({
      id: settingsPageFeatureId(page),
      kind: 'setting-page',
      domain: 'settings',
      label: SETTINGS_PAGE_LABELS[page],
      aliases: [page, ...(SETTINGS_PAGE_ALIASES[page] ?? [])],
      settingsPage: page,
      page,
      path: settingsPagePath(page),
      ...pageDetails[page],
    }) satisfies FeatureDefinition & { page: SettingsPageId; path: string[] },
);

export const SETTING_FEATURES = SETTINGS_CATALOG.map(
  (setting) =>
    ({
      id: settingFeatureId(setting.id),
      kind: 'setting',
      domain: 'settings',
      label: setting.label,
      aliases: setting.aliases,
      parentId: settingsPageFeatureId(setting.section),
      settingId: setting.id,
      settingsPage: setting.section,
      page: setting.section,
      path: setting.path,
      desktopOnly: setting.desktopOnly === true,
      ...(setting.id === 'llm-default-model' ? { operation: 'default-chat-model' as const } : {}),
      ...(setting.id === 'database-manager'
        ? {
            tools: [
              'list_databases',
              'list_db_tables',
              'get_db_columns',
              'execute_sql',
              'query_sqlite_file',
              'decode_blob',
              'decode_db_blob',
            ],
          }
        : {}),
      ...(setting.id === 'anti-recall'
        ? { tools: ['get_anti_recall_status', 'set_anti_recall'] }
        : {}),
    }) satisfies FeatureDefinition & {
      settingId: string;
      page: SettingsPageId;
      path: string[];
      desktopOnly: boolean;
    },
);
