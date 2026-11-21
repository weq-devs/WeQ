import { defineFeature, type FeatureDefinition } from './model';

export const TASK_PANEL_FEATURES = {
  tasks: defineFeature('export.tasks.current', 'export', '当前任务', ['任务列表', '任务进度'], {
    parentId: 'export.tasks',
    context: ['account'],
    navigation: 'search',
    summary: '查看现有任务的状态、步骤和日志。',
    docs: ['guide/export.md#feature-export.tasks.current'],
  }),
  schedules: defineFeature('export.tasks.schedules', 'export', '定时任务', ['管理定时计划'], {
    parentId: 'export.tasks',
    context: ['account'],
    navigation: 'search',
    summary: '查看和管理已建立的定时导出计划。',
    docs: ['guide/export.md#feature-export.tasks.schedules'],
  }),
};

export type TaskPanelTab = keyof typeof TASK_PANEL_FEATURES;

function operation(
  id: string,
  domain: 'export' | 'analysis' | 'assistant',
  label: string,
  summary: string,
  details: Partial<
    Pick<FeatureDefinition, 'parentId' | 'context' | 'docs' | 'tools' | 'navigation'>
  > = {},
) {
  return defineFeature(`${domain}.${id}`, domain, label, [], {
    summary,
    context: ['account'],
    navigation: 'context',
    ...details,
  });
}

export const OPERATION_FEATURES = [
  operation('selection.exact', 'export', '精确选择导出', '沿用选定的对象身份与范围提交导出。', {
    parentId: 'export.workspace',
    context: ['account', 'content'],
    docs: ['guide/saved-reports-and-content-export.md#feature-export.selection.exact'],
  }),
  operation('result.save', 'export', '保存导出结果', '使用任务中已生成的产物，沿用各端保存方式。', {
    parentId: 'export.tasks',
    context: ['account', 'content'],
  }),
  operation('task.control', 'export', '暂停或继续任务', '对已选任务使用本身支持的控制操作。', {
    parentId: 'export.tasks',
    context: ['account', 'content'],
  }),
  operation('group', 'analysis', '群聊分析', '统计选定群的消息活动，沿用当前数据源与范围。', {
    context: ['account', 'group'],
    tools: ['get_group_activity'],
    docs: ['guide/analytics.md#feature-analysis.group'],
  }),
  operation('buddy', 'analysis', '私聊分析', '对选定好友会话生成统计与报告。', {
    context: ['account', 'contact'],
    tools: ['get_buddy_analytics'],
    docs: ['guide/analytics.md#feature-analysis.buddy'],
  }),
  operation('group-member', 'analysis', '群成员分析', '按当前群、成员及时间范围分析消息。', {
    context: ['account', 'group', 'contact'],
  }),
  operation(
    'activity-ranking',
    'analysis',
    '好友与群聊活跃排行',
    '按时间范围比较私聊消息量与群活跃度。',
    {
      navigation: undefined,
      tools: ['rank_friends_by_activity', 'rank_my_groups_by_activity'],
    },
  ),
  operation(
    'activity-period',
    'analysis',
    '按日与时段统计消息',
    '通过实际时间范围查看分布或比较两段统计。',
    {
      navigation: undefined,
      tools: ['get_daily_digest', 'get_period_overview', 'compare_periods'],
    },
  ),
  operation(
    'report-image.save',
    'analysis',
    '保存分析长图',
    '由支持图片导出桥接的宿主捕获报告统计快照。',
    {
      context: ['account', 'content'],
      docs: ['guide/analytics.md#feature-analysis.report-image.save'],
    },
  ),
  operation(
    'task.control',
    'assistant',
    '停止或恢复助手任务',
    '在当前任务的原操作区管理正在生成或可恢复的结果。',
  ),
  operation('message-image', 'assistant', '分析聊天图片', '按消息身份读取图片并进行识别。', {
    context: ['account', 'message'],
    navigation: undefined,
    tools: ['analyze_chat_image'],
  }),
  operation(
    'attachment-image',
    'assistant',
    '查看助手附件原图',
    '向助手提供图片后，可按附件查看具体细节。',
    {
      context: ['account', 'content'],
      navigation: undefined,
      tools: ['analyze_attached_image'],
    },
  ),
  operation(
    'report-artifact',
    'assistant',
    '生成报告文件',
    '助手生成文档后通过附件卡片提供查看与另存。',
    {
      navigation: undefined,
      tools: ['write_report'],
    },
  ),
  operation(
    'investigation',
    'assistant',
    '调查计划与工作笔记',
    '助手工具更新调查过程中使用的工作区信息。',
    {
      navigation: undefined,
      tools: ['update_investigation_plan', 'update_work_notes'],
    },
  ),
] as const;
