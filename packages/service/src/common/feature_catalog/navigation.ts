import { defineFeature } from './model';

/** 客户端按导航键绑定目标与版位。名称、检索词和功能身份由这里维护。 */
export const NAVIGATION_FEATURES = {
  announcements: defineFeature('general.announcements', 'general', '官方公告'),
  home: defineFeature('general.home', 'general', '主页'),
  messages: defineFeature('messages.inbox', 'messages', '消息', ['聊天', '会话'], {
    summary: '浏览会话、定位未读并打开聊天记录。',
    tools: ['list_conversations', 'get_messages'],
    docs: ['guide/chat-view.md#feature-messages.inbox'],
  }),
  contacts: defineFeature('contacts.directory', 'contacts', '联系人', ['好友', '群聊']),
  collections: defineFeature('collections.inbox', 'collections', '收藏'),
  qzone: defineFeature('qzone.timeline', 'qzone', 'QQ 空间', ['说说', '相册']),
  mail: defineFeature('mail.inbox', 'mail', 'QQ 邮箱', ['邮件']),
  channel: defineFeature('channels.inbox', 'channels', 'QQ 频道', ['频道']),
  'guild-direct': defineFeature('channels.direct-messages', 'channels', '频道私聊', [], {
    tools: ['list_guild_direct_sessions', 'get_guild_direct_messages'],
    docs: ['guide/album-qzone.md#feature-channels.direct-messages'],
  }),
  annual: defineFeature('analysis.annual-report', 'analysis', '年度报告', ['年度总结']),
  dressup: defineFeature('appearance.catalog', 'appearance', '个性装扮', ['装扮商城']),
  tasks: defineFeature('export.tasks', 'export', '任务', ['导出进度', '下载任务']),
  assistant: defineFeature('assistant.chat', 'assistant', 'WeQ 助手', ['AI 助手', '智能助手']),
  analysis: defineFeature('analysis.workspace', 'analysis', '分析', ['聊天分析', '统计']),
  'analysis-reports': defineFeature('analysis.saved-reports', 'analysis', '分析报告', [
    '历史报告',
    '已保存报告',
    '查看分析结果',
  ]),
  export: defineFeature('export.workspace', 'export', '导出', ['导出聊天记录', '备份聊天']),
  viewer: defineFeature('export.viewer', 'export', '导出查看器', ['打开导出', 'JSON', 'JSONL']),
  composition: defineFeature('messages.composition', 'messages', '合成聊天记录', ['合并转发']),
  backfill: defineFeature('messages.history-backfill', 'messages', '拉取漫游消息', [
    '漫游消息',
    '补全聊天记录',
  ]),
  settings: defineFeature('settings.workspace', 'settings', '设置', [], {
    docs: ['guide/settings.md'],
  }),
  tools: defineFeature('general.workspace', 'general', '应用'),
  more: defineFeature('general.more', 'general', '更多'),
  'friend-notice': defineFeature('contacts.friend-notices', 'contacts', '好友通知'),
  'group-notice': defineFeature('groups.notices', 'groups', '群通知'),
  'group-intersection': defineFeature('groups.intersection', 'groups', '群交集', [
    '群成员重合',
    '关系图谱',
  ]),
};
