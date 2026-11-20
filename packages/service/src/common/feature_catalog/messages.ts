import { defineFeature, type FeatureDefinition } from './model';

function directory(id: string, label: string, summary: string) {
  return defineFeature(`messages.directory.${id}`, 'messages', label, [], {
    parentId: 'messages.inbox',
    context: ['account'],
    navigation: 'search',
    summary,
  });
}

export const CONVERSATION_VIEW_FEATURES = {
  all: directory('all', '全部会话', '平铺各来源的会话，范围跟随隐藏和删除会话设置。'),
  groupAssistant: directory('group-assistant', '群助手', '查看 QQ 已归入群助手的群。'),
  official: directory('official', '公众号', '打开公众号的具体会话并阅读本地消息。'),
  service: directory('service', '服务号', '打开服务号的具体会话并阅读本地消息。'),
  hidden: directory('hidden', '已隐藏会话', '在专用视图中查看隐藏的会话。'),
  deleted: directory('deleted', '已删除会话', '在专用视图中查看仍可读取的已删除会话。'),
};

const messageFeature = (
  id: string,
  label: string,
  summary: string,
  details: Partial<Omit<FeatureDefinition, 'id' | 'kind' | 'domain' | 'label' | 'aliases'>> = {},
) =>
  defineFeature(`messages.${id}`, 'messages', label, [], {
    parentId: 'messages.inbox',
    context: ['account', 'message'],
    summary,
    ...details,
  });

export const CONVERSATION_CALENDAR_FEATURE = defineFeature(
  'messages.calendar',
  'messages',
  '会话日历',
  ['会话总日历', '聊天日期'],
  {
    parentId: 'messages.inbox',
    context: ['account'],
    navigation: 'search',
    summary: '按当前会话视图统计本地消息，选择日期可定位原记录。',
    docs: ['guide/chat-view.md#feature-messages.calendar'],
  },
);

export const MESSAGE_FEATURES = [
  messageFeature(
    'system-emoji-catalog',
    '在线系统表情目录',
    '从表情面板查看 QQ 在线目录或查询单个表情。',
    {
      context: ['account', 'conversation'],
      navigation: 'context',
    },
  ),
  messageFeature(
    'ai-voice-catalog',
    '群聊在线声线',
    '在群聊 AI 声聊面板浏览当前群的声线、试听并发送。',
    {
      context: ['account', 'group'],
      navigation: 'context',
    },
  ),
  messageFeature(
    'translate-en-zh',
    '翻译英文消息',
    '在消息菜单请求 QQ 翻译，并在原消息下方查看译文。',
    { navigation: 'context' },
  ),
  messageFeature('history.search', '搜索聊天记录', '按关键词检索消息内容，也可限定在指定会话。', {
    context: ['account'],
    tools: ['search_messages', 'search_in_conversation'],
    docs: ['guide/chat-view.md#feature-messages.history.search'],
  }),
  messageFeature(
    'conversation.preview',
    '预览会话',
    '在浮窗查看具体会话的本地记录，保留当前聊天与读状态。',
    {
      context: ['account', 'conversation'],
      navigation: 'context',
      docs: ['guide/chat-view.md#feature-messages.conversation.preview'],
    },
  ),
  messageFeature('devices', '我的设备', '查看数据线会话，区分本机和其他设备的消息。', {
    context: ['account'],
    tools: ['list_dataline_conversations', 'get_dataline_messages'],
    docs: ['guide/chat-view.md#feature-messages.devices'],
  }),
  messageFeature('unread', '标记已读或未读', '按会话处理已读状态，手动未读保留提醒。', {
    context: ['account', 'conversation'],
    navigation: 'context',
  }),
  messageFeature('important', '重要消息', '在群聊中查看并定位提及、回复、文件等重要消息。', {
    context: ['account', 'group'],
    navigation: 'context',
  }),
  messageFeature('forward.inspect', '查看合并转发', '打开聊天记录卡片并查看其中的消息。', {
    navigation: 'context',
    tools: ['get_forward_messages'],
  }),
  messageFeature('forward.send', '转发消息', '选择目标后转发，可多选逐条转发或合并转发。', {
    navigation: 'context',
  }),
  messageFeature('recall', '撤回消息', '在 QQ 在线且有相应权限时撤回适用的消息。', {
    navigation: 'context',
  }),
  messageFeature(
    'recall.history',
    '查看已撤回消息',
    '查看符合当前防撤回设置且已有记录的撤回消息。',
    {
      context: ['account', 'conversation'],
      navigation: 'context',
      tools: ['list_recalled_messages', 'get_anti_recall_status'],
    },
  ),
  messageFeature('local-edit', '修改本地记录', '从消息菜单打开原始元素编辑器。', {
    navigation: 'context',
  }),
  messageFeature(
    'local-delete',
    '本地删除消息',
    '可恢复地删除本地消息，按实际来源处理数据库或缓存。',
    { navigation: 'context' },
  ),
  messageFeature(
    'local-delete.history',
    '查看本地删除记录',
    '从会话查看旧记录，按来源恢复或定位。',
    {
      context: ['account', 'conversation'],
      navigation: 'context',
      tools: ['list_deleted_messages'],
    },
  ),
  messageFeature('media.save', '保存消息媒体', '按所选端的保存方式另存媒体或文件。', {
    navigation: 'context',
  }),
] as const;
