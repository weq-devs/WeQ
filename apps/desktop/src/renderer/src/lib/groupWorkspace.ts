import type { GroupWorkspaceTab } from './profileNavigation';

export const GROUP_WORKSPACE_SECTIONS = [
  ['profile', '群资料'],
  ['members', '成员'],
  ['content', '群内容'],
  ['management', '群管理'],
] as const;
export type GroupWorkspaceSection = (typeof GROUP_WORKSPACE_SECTIONS)[number][0];
export const GROUP_CONTENT_SECTIONS = [
  ['announcements', '公告'],
  ['todos', '待办'],
  ['albums', '相册'],
  ['files', '文件'],
  ['essence', '精华'],
  ['sign', '打卡'],
] as const;
export type GroupContentSection = (typeof GROUP_CONTENT_SECTIONS)[number][0];

export function groupContentSection(section?: GroupWorkspaceTab): GroupContentSection {
  return GROUP_CONTENT_SECTIONS.find(([key]) => key === section)?.[0] ?? 'announcements';
}

/** 旧资料与历史入口归入群资料，资源定位仍保留原来的子分区。 */
export function groupWorkspaceSection(section?: GroupWorkspaceTab): GroupWorkspaceSection {
  if (section === 'members' || section === 'management') return section;
  if (section === 'content' || GROUP_CONTENT_SECTIONS.some(([key]) => key === section))
    return 'content';
  return 'profile';
}
