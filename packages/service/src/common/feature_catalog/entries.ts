import { defineFeature, type FeatureDefinition } from './model';
import { NAVIGATION_FEATURES } from './navigation';

function exportFeature<M extends string>(
  id: string,
  mode: M,
  label: string,
  aliases: readonly string[],
  details: Pick<FeatureDefinition, 'summary' | 'docs'> = {},
) {
  return {
    ...defineFeature(id, 'export', label, aliases, {
      parentId: NAVIGATION_FEATURES.export.id,
      ...details,
    }),
    mode,
  };
}

export const EXPORT_FEATURES = [
  exportFeature('export.chat-history', 'full', '聊天消息导出', ['完整消息导出'], {
    summary: '从要导出的会话和范围开始，生成聊天记录文件。',
    docs: ['guide/export.md#feature-export.chat-history'],
  }),
  exportFeature('export.schedule', 'scheduled', '定时导出', ['定时任务', '自动备份']),
  exportFeature('export.channel-direct-messages', 'guild', '频道私聊数据', ['导出频道私聊']),
  exportFeature('export.generated-chats', 'generated', '克隆与助手对话', [
    '导出克隆对话',
    '导出助手会话',
  ]),
  exportFeature('export.qzone-posts', 'qzone', 'QQ 空间导出', ['导出说说']),
  exportFeature('export.contacts', 'contacts', '导出联系人', ['好友名单', '群成员名单', 'vCard']),
  exportFeature('export.collections', 'collection', '导出收藏', ['收藏导出']),
  exportFeature('export.mail', 'mail', '邮件导出', ['导出邮件']),
  exportFeature('export.emoji-packs', 'emojipack', '导出表情包', ['表情包导出']),
  exportFeature('export.group-albums', 'album', '群相册导出', ['群相册']),
  exportFeature('export.group-files', 'groupfile', '群文件导出', ['群文件']),
  exportFeature('export.database', 'database', '明文数据库', ['数据库导出']),
  exportFeature('export.clone-bot', 'persona-bot', '克隆体机器人', ['克隆机器人导出']),
  exportFeature('export.qzone-albums', 'qzone', '个人空间相册', ['空间相册导出']),
] as const;

function dressFeature<K extends string>(
  id: string,
  kind: K,
  label: string,
  aliases: readonly string[] = [],
) {
  return {
    ...defineFeature(id, 'appearance', label, aliases, {
      parentId: NAVIGATION_FEATURES.dressup.id,
    }),
    dressKind: kind,
  };
}

export const DRESS_FEATURES = [
  dressFeature('appearance.bubble', 'bubble', '气泡商城', ['聊天气泡', '气泡']),
  dressFeature('appearance.font', 'font', '字体商城', ['个性字体', '字体']),
  dressFeature('appearance.avatar-widget', 'widget', '头像挂件', ['挂件商城']),
  dressFeature('appearance.call-background', 'callbg', '通话背景'),
  dressFeature('appearance.chat-background', 'background', 'QQ 聊天背景', ['聊天背景商城']),
  dressFeature('appearance.emoji-market', 'emoji', '商城表情', ['表情商城']),
  dressFeature('appearance.red-packet-cover', 'redpack', '红包封面', ['红包皮肤', '红包']),
] as const;

export const WORKSPACE_FEATURES = {
  clones: defineFeature('assistant.clones', 'assistant', '好友克隆', ['克隆聊天']),
  createClone: defineFeature('assistant.clones.create', 'assistant', '新建好友克隆', ['创建克隆']),
  createCloneGroup: defineFeature('assistant.clone-groups.create', 'assistant', '新建克隆体群聊', [
    '克隆群聊',
  ]),
  selfProfile: defineFeature('contacts.self-profile', 'contacts', '我的资料', [
    '本人资料',
    '个人资料',
  ]),
  selfProfileEdit: defineFeature(
    'contacts.self-profile.edit',
    'contacts',
    '编辑我的资料',
    ['编辑本人资料'],
    {
      parentId: 'contacts.self-profile',
      context: ['account'],
      operation: 'profile-write',
    },
  ),
  giftWall: defineFeature('contacts.self-gift-wall', 'contacts', '礼物墙', ['我的礼物墙', '礼物'], {
    parentId: 'contacts.self-profile',
  }),
};

/** 代表上下文及纯工具能力，未绑定全局搜索入口。 */
export const CONTEXT_FEATURES = [
  defineFeature('groups.albums', 'groups', '群相册', [], {
    summary: '从指定群查看群相册及其媒体。',
    context: ['account', 'group'],
    navigation: 'context',
    operation: 'album-list',
    tools: ['get_group_albums'],
    docs: ['guide/album-qzone.md#feature-groups.albums'],
  }),
  defineFeature('messages.locate', 'messages', '定位原消息', [], {
    parentId: NAVIGATION_FEATURES.messages.id,
    summary: '用当前数据源的会话与消息身份打开原消息。',
    context: ['account', 'message'],
    navigation: 'context',
    tools: ['get_message_details'],
  }),
  defineFeature('messages.image.preview', 'messages', '预览聊天图片', ['查看图片'], {
    parentId: NAVIGATION_FEATURES.messages.id,
    summary: '打开消息中的图片，可以使用已经缓存的原图。',
    context: ['account', 'message'],
    operation: 'chat-image',
  }),
  defineFeature('maintenance.message-performance', 'maintenance', '消息性能快照', [], {
    summary: '读取消息库排队和耗时统计。',
    context: ['account'],
    tools: ['get_message_performance'],
    docs: ['guide/mcp-server.md#feature-maintenance.message-performance'],
  }),
] as const;
