const purposes = new Map([
  ['nt_msg.db', '聊天记录、会话状态与草稿'],
  ['profile_info.db', '联系人资料、好友分组与申请'],
  ['group_info.db', '群资料、成员、公告与精华'],
  ['guild_msg.db', 'QQ 频道消息与动态'],
  ['guild1.db', 'QQ 频道资料、成员与权限'],
  ['buddy_msg_fts.db', '私聊搜索索引'],
  ['group_msg_fts.db', '群聊搜索索引'],
  ['data_line_msg_fts.db', '「我的设备」消息搜索索引'],
  ['discuss_msg_fts.db', '讨论组搜索索引'],
  ['msg_fts.db', '临时会话搜索索引'],
  ['collection.db', 'QQ 收藏与分组'],
  ['emoji.db', 'QQ 表情资料'],
  ['file_assistant.db', '文件助手记录与下载路径'],
  ['files_in_chat.db', '聊天文件清单'],
  ['rich_media.db', '聊天媒体文件信息'],
  ['nt_flash_transfer.db', 'QQ 闪传文件与下载记录'],
  ['misc.db', '好友在线状态等杂项缓存'],
  ['settings.db', '设置与功能开关'],
  ['login.db', '本机登录过的账号'],
  ['bc_09.db', '运行统计上报记录'],
  ['recent_contact.db', '最近会话（推测）'],
  ['rdelivery.db', '远程配置缓存（推测）'],
  ['yffm.db', '用途未确认'],
]);

export function qqDatabasePurpose(name: string): string | undefined {
  return purposes.get(name.toLowerCase());
}
