import { defineFeature, type FeatureDefinition } from './model';

type Details = Partial<Pick<FeatureDefinition, 'tools' | 'docs'>>;

function contact(id: string, label: string, summary: string, details: Details = {}) {
  return defineFeature(`contacts.${id}`, 'contacts', label, [], {
    parentId: 'contacts.directory',
    summary,
    context: ['account', 'contact'],
    navigation: 'context',
    ...details,
  });
}

function group(id: string, label: string, summary: string, details: Details = {}) {
  return defineFeature(`groups.${id}`, 'groups', label, [], {
    summary,
    context: ['account', 'group'],
    navigation: 'context',
    ...details,
  });
}

export const CONTACT_GROUP_FEATURES = [
  defineFeature('contacts.directory.order', 'contacts', '联系人排序与分组', [], {
    parentId: 'contacts.directory',
    summary: '分别调整好友和群聊列表的分组及排序。',
    context: ['account'],
    navigation: 'context',
    docs: ['guide/contact-directory.md#feature-contacts.directory.order'],
  }),
  contact('profile', '联系人名片与资料', '先显示本地资料，沿用设置中的名片内容及顺序。', {
    tools: ['get_user_profile'],
    docs: ['guide/contact-card.md#feature-contacts.profile'],
  }),
  contact('shared-groups', '共同群', '查看与指定联系人共同加入的群。', {
    tools: ['list_user_groups'],
  }),
  contact('profile-history', '联系人资料历史', '查看已有观察记录的字段历史。'),
  contact('signatures', '签名历史', '从签名值查看既有历史记录。'),
  contact('education', '教育经历', '从学校字段查看可取得的完整经历。'),
  contact('directory.filter', '联系人筛选', '在好友列表按好友关系和在线状态组合筛选。', {
    docs: ['guide/contact-directory.md#feature-contacts.directory.filter'],
  }),
  contact('remove-friend', '删除好友', '从好友名片删除关系；本地聊天历史继续可查。'),
  contact('remark', '编辑联系人备注', '通过已有备注行编辑好友备注。'),
  contact('buddy-group', '好友分组', '将选定好友移到已有分组。'),
  group('profile', '群名片与群资料', '查看群基本资料、角色和已有群状态。', {
    tools: ['get_group_info'],
    docs: ['guide/contact-card.md#feature-groups.profile'],
  }),
  group('members', '群成员', '从群资料或聊天侧栏搜索并分页浏览成员。', {
    tools: ['list_group_members'],
  }),
  group('announcements', '群公告', '在当前群的公告入口查看公告。', {
    tools: ['get_group_bulletins'],
    docs: ['guide/album-qzone.md#feature-groups.announcements'],
  }),
  group('todos', '群待办', '查看指定群的待办项目。'),
  group('essence', '群精华', '查看已设为精华的群消息。', {
    tools: ['get_group_essence'],
    docs: ['guide/album-qzone.md#feature-groups.essence'],
  }),
  group('sign', '群打卡', '在群聊侧栏打开原有打卡入口。'),
  group('files', '群文件', '在绑定当前群的资源窗口浏览文件夹与文件。', {
    docs: ['guide/album-qzone.md#feature-groups.files'],
  }),
  group('files.manage', '群文件管理', '选定文件后，按当前账号和群权限使用已有文件操作。', {
    docs: ['guide/qq-actions.md#feature-groups.files.manage'],
  }),
  group(
    'admin-verification',
    '收取入群验证',
    '群主可在管理员权限里调整单个管理员收取入群验证的状态。',
  ),
  group('management', '群管理', '在当前群的会话设置查看适用的管理操作。'),
  group('nickname', '我的群昵称与头衔', '在当前群资料或会话设置中查看和编辑可操作的字段。'),
  group('remark', '编辑群备注', '通过群身份区的备注行提交修改。'),
  defineFeature('groups.honor', 'groups', '读取群荣誉榜单', [], {
    summary: '查询指定群的荣誉类型和榜单。',
    context: ['account', 'group'],
    tools: ['get_group_honor'],
  }),
] as const;
