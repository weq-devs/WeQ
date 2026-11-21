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
  contacts: defineFeature('contacts.directory', 'contacts', '联系人', ['好友', '群聊'], {
    summary: '从好友和群目录查找已有联系人。',
    context: ['account'],
    navigation: 'search',
    tools: ['list_buddies', 'list_groups', 'find_contact'],
  }),
  collections: defineFeature('collections.inbox', 'collections', '收藏', [], {
    summary: '查看已有本地收藏，页面在有可用票据时补充在线结果。',
    context: ['account'],
    navigation: 'search',
    tools: ['list_collections', 'search_local_resources', 'get_local_collection'],
  }),
  qzone: defineFeature('qzone.timeline', 'qzone', 'QQ 空间', ['说说', '相册'], {
    context: ['account'],
    navigation: 'search',
    tools: ['get_qzone_profile'],
  }),
  mail: defineFeature('mail.inbox', 'mail', 'QQ 邮箱', ['邮件'], {
    context: ['account'],
    navigation: 'search',
    tools: ['list_mail_folders', 'list_mail_messages'],
  }),
  channel: defineFeature('channels.inbox', 'channels', 'QQ 频道', ['频道']),
  'guild-direct': defineFeature('channels.direct-messages', 'channels', '频道私聊', [], {
    tools: ['list_guild_direct_sessions', 'get_guild_direct_messages'],
    docs: ['guide/album-qzone.md#feature-channels.direct-messages'],
  }),
  annual: defineFeature('analysis.annual-report', 'analysis', '年度报告', ['年度总结']),
  dressup: defineFeature('appearance.catalog', 'appearance', '个性装扮', ['装扮商城']),
  tasks: defineFeature('export.tasks', 'export', '任务', ['导出进度', '下载任务'], {
    context: ['account'],
    navigation: 'search',
  }),
  assistant: defineFeature('assistant.chat', 'assistant', 'WeQ 助手', ['AI 助手', '智能助手']),
  analysis: defineFeature('analysis.workspace', 'analysis', '分析', ['聊天分析', '统计'], {
    context: ['account'],
    navigation: 'search',
  }),
  'analysis-reports': defineFeature(
    'analysis.saved-reports',
    'analysis',
    '分析报告',
    ['历史报告', '已保存报告', '查看分析结果'],
    {
      context: ['account'],
      navigation: 'search',
      docs: ['guide/saved-reports-and-content-export.md#feature-analysis.saved-reports'],
    },
  ),
  export: defineFeature('export.workspace', 'export', '导出', ['导出聊天记录', '备份聊天'], {
    context: ['account'],
    navigation: 'search',
  }),
  viewer: defineFeature('export.viewer', 'export', '导出查看器', ['打开导出', 'JSON', 'JSONL'], {
    navigation: 'search',
  }),
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
  'friend-notice': defineFeature('contacts.friend-notices', 'contacts', '好友通知', ['好友申请'], {
    context: ['account'],
    navigation: 'search',
  }),
  'group-notice': defineFeature('groups.notices', 'groups', '群通知', ['入群申请'], {
    context: ['account'],
    navigation: 'search',
  }),
  'group-intersection': defineFeature(
    'groups.intersection',
    'groups',
    '群交集',
    ['群成员重合', '关系图谱'],
    {
      context: ['account'],
      navigation: 'search',
      docs: ['guide/relation-graph.md#feature-groups.intersection'],
    },
  ),
};
