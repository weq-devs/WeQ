import type { ExportTask } from '../account/export/task_manager';

/** 仅用于展示，不参与文件命名、任务身份或断点。 */
export interface TaskDisplay {
  action: string;
  subject?: string;
  /** 仅程序生成的读数使用数字字体，名称按普通文本显示。 */
  numericSubject?: boolean;
  context?: string;
  category?: string;
  fileName?: boolean;
}

export const taskInlineText = (value: string) => value.replace(/\s+/gu, ' ').trim();

export function taskDisplayTitle(display: TaskDisplay): string {
  const subject = taskInlineText(display.subject ?? '');
  return `${display.action}${subject ? ` · ${subject}` : ''}`;
}

export function taskNoticeTitle(display: TaskDisplay): string {
  // 通知不提供完整原名阅读区；过长的单对象名留在任务详情。
  return (display.subject?.length ?? 0) > 80 ? display.action : taskDisplayTitle(display);
}

export function roamingTaskDisplay(targets: readonly { name: string }[]): TaskDisplay {
  return {
    action: '拉取漫游消息',
    subject:
      targets.length === 1 ? targets[0]!.name : `${targets.length.toLocaleString('en-US')} 个会话`,
    numericSubject: targets.length !== 1,
  };
}

type DisplaySource = Pick<ExportTask, 'name' | 'kind'> &
  Partial<
    Pick<
      ExportTask,
      | 'display'
      | 'resource'
      | 'resourceOnly'
      | 'qzone'
      | 'qzonePosts'
      | 'qzoneAlbums'
      | 'contacts'
      | 'collection'
      | 'marketpack'
      | 'emojipack'
      | 'guild'
      | 'filter'
      | 'range'
      | 'scheduleName'
    >
  > & {
    generated?: Pick<NonNullable<ExportTask['generated']>, 'target' | 'title' | 'sessionTitle'>;
    isQzone?: boolean;
    isContacts?: boolean;
    isCollection?: boolean;
    isMarketPack?: boolean;
    isEmojiPack?: boolean;
    isGuild?: boolean;
    isGenerated?: boolean;
  };

const RESOURCE_ACTIONS = {
  'group-files': '导出群文件',
  'group-albums': '导出群相册',
  'qzone-albums': '导出 QQ 空间相册',
  database: '导出明文数据库',
  'assistant-artifact': '保存助手报告',
  'market-image': '保存商城表情',
  'mail-attachment': '保存邮件附件',
  'mail-messages': '导出邮件',
  decoration: '保存装扮素材',
  'favorite-emoji': '导出收藏表情',
  'annual-report': '导出年度报告',
  'analytics-report': '导出分析长图',
  'persona-bot': '导出克隆机器人',
  composition: '导出合成聊天记录',
  media: '保存媒体文件',
} satisfies Record<NonNullable<ExportTask['resource']>['kind'], string>;

export function exportTaskDisplay(task: DisplaySource): TaskDisplay {
  if (task.display) return task.display;
  if (task.resourceOnly)
    return {
      action: '导出聊天资源',
      subject: task.generated?.title ?? task.name,
      category:
        task.generated || task.isGenerated
          ? '本地生成对话'
          : task.guild || task.isGuild
            ? '频道私聊'
            : { group: '群聊', c2c: '私聊', official: '官方号', service: '服务号' }[task.kind],
    };
  if (task.resource) {
    const kind = task.resource.kind;
    const action = RESOURCE_ACTIONS[kind] ?? '导出资源';
    if (kind === 'mail-messages') return { action };
    if (kind === 'favorite-emoji') return { action, context: '在线收藏快照' };
    const output = task.resource.output;
    const fileName = [
      'media',
      'mail-attachment',
      'market-image',
      'decoration',
      'database',
    ].includes(kind);
    return {
      action,
      subject:
        fileName && output
          ? `${output.name}${output.extension ? `.${output.extension}` : ''}`
          : task.name,
      fileName,
    };
  }
  if (task.marketpack || task.isMarketPack) {
    const packs = task.marketpack?.packs;
    const count = packs?.length ?? 0;
    return {
      action: '下载商城表情包',
      subject: count > 1 ? `${count} 套` : (packs?.[0]?.name ?? task.name),
      numericSubject: count > 1,
    };
  }
  if (task.emojipack || task.isEmojiPack) {
    const scopes = task.emojipack?.scopes;
    return {
      action: '导出表情图片',
      subject: scopes?.length === 1 ? (scopes[0] === 'own' ? '我的表情' : '收到的表情') : undefined,
      context: scopes?.length === 2 ? '我的表情、收到的表情' : undefined,
    };
  }
  if (task.qzone || task.isQzone)
    return {
      action: task.qzoneAlbums
        ? task.qzonePosts === false
          ? '导出 QQ 空间相册'
          : '导出 QQ 空间内容'
        : '导出 QQ 空间说说',
      subject: task.name,
      context: task.qzoneAlbums && task.qzonePosts !== false ? '说说、相册' : undefined,
    };
  if (task.contacts || task.isContacts) {
    const selection = task.contacts;
    if (selection?.scope === 'group')
      return {
        action: '导出群成员',
        subject: selection.groupName ?? task.name,
        context: selection.uids ? `指定 ${selection.uids.length} 人` : '全部成员',
      };
    if (selection?.scope === 'groups')
      return {
        action: '导出群聊名单',
        subject: selection.groupIds ? `${selection.groupIds.length} 个群` : undefined,
        numericSubject: true,
        context: selection.groupIds ? undefined : '全部群聊',
      };
    return {
      action: selection ? '导出好友名单' : '导出联系人名单',
      subject: selection?.uids ? `${selection.uids.length} 人` : undefined,
      numericSubject: true,
      context: !selection
        ? undefined
        : selection.categoryIds?.length
          ? `选定 ${selection.categoryIds.length} 个分组`
          : selection?.uids
            ? undefined
            : '全部好友',
    };
  }
  if (task.collection || task.isCollection)
    return {
      action: '导出收藏',
      subject: task.collection?.cids ? `${task.collection.cids.length} 项` : undefined,
      numericSubject: true,
      context: !task.collection
        ? undefined
        : task.collection.kinds?.length
          ? `选定 ${task.collection.kinds.length} 类`
          : '全部收藏',
    };
  const generated = task.generated;
  return {
    action:
      generated?.target.kind === 'assistant'
        ? '导出助手对话'
        : generated?.target.kind === 'group'
          ? '导出克隆群对话'
          : generated
            ? '导出克隆对话'
            : task.isGenerated
              ? '导出本地生成对话'
              : '导出聊天记录',
    subject: generated
      ? generated.target.kind === 'assistant'
        ? generated.sessionTitle
        : generated.title
      : task.name,
    context:
      [
        task.filter?.forwardTarget?.records
          ? `聊天记录内所选 ${task.filter.forwardTarget.records.length} 条消息`
          : task.filter?.forwardTarget
            ? '聊天记录卡片内容'
            : task.filter?.messageIds
              ? `指定 ${task.filter.messageIds.length} 条消息`
              : generated?.sessionTitle,
        task.scheduleName ? `定时执行 · ${task.scheduleName}` : undefined,
        task.range && (task.range.start !== null || task.range.end !== null)
          ? `${task.range.start !== null ? taskDate(task.range.start * 1000) : '不限起始'} 至 ${task.range.end !== null ? taskDate(task.range.end * 1000) : '不限结束'}`
          : undefined,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
  };
}

const DATE = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const taskDate = (time: number) => (Number.isFinite(time) ? DATE.format(time) : '');
const CREATED = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
export const taskCreatedLabel = (time: number) =>
  Number.isFinite(time) ? CREATED.format(time) : '';
