// 站点导航与侧栏的唯一来源。
// 只列「进站」的页面：常青文档（guide / tools / database / develop 的常青部分）。
// 带日期的过程记录收进 docs/notes/ 或随功能页一起维护，不进侧栏。

/** 顶部导航 */
export const nav = [
  { text: '使用手册', link: '/guide/', activeMatch: '/guide/' },
  { text: '数据库', link: '/database/', activeMatch: '/database/' },
  { text: '工具箱', link: '/tools/', activeMatch: '/tools/' },
  { text: '开发', link: '/develop/', activeMatch: '/develop/' },
  {
    text: '下载',
    link: 'https://github.com/weq-devs/WeQ/releases',
  },
  {
    text: '关于',
    items: [
      { text: '贡献指南', link: 'https://github.com/weq-devs/WeQ/blob/dev/CONTRIBUTING.md' },
      { text: '更新记录', link: 'https://github.com/weq-devs/WeQ/blob/dev/CHANGELOG.md' },
      { text: '问题反馈', link: 'https://github.com/weq-devs/WeQ/issues' },
    ],
  },
];

/**
 * 使用手册侧栏：按「进入软件 → 装好环境 → 逐个内容源 → 分析 → 工具」排列，
 * 与软件自己的左栏（消息 / 联系人 / 空间 / 频道 / 邮箱 / 收藏 / 装扮）对齐。
 *
 * 归类原则：
 *  - 安装、权限、平台差异 → 「安装与平台」，不放在开始使用里；
 *  - 按界面入口分组，「功能」不往入门里塞；
 *  - 会真实改写 QQ 侧数据的入口单独标注（QQ 在线操作）。
 */
export const guideSidebar = [
  {
    text: '开始使用',
    collapsed: false,
    items: [
      { text: '快速上手', link: '/guide/getting-started' },
      { text: '支持的 QQ 版本', link: '/guide/supported-versions' },
      { text: '主界面与账号', link: '/guide/homepage' },
    ],
  },
  {
    text: '安装与平台',
    collapsed: false,
    items: [
      { text: 'macOS 安装与首次打开', link: '/guide/macos-install' },
      { text: 'macOS 数据读取授权', link: '/guide/macos-data-access' },
      { text: 'Arch Linux 安装（AUR）', link: '/guide/arch-install' },
      { text: 'QQ 调试副本（macOS）', link: '/guide/macos-debug-copy' },
    ],
  },
  {
    text: '消息',
    collapsed: false,
    items: [
      { text: '消息页', link: '/guide/chat-view' },
      { text: '消息编辑与删除', link: '/guide/message-edit' },
      { text: '防撤回', link: '/guide/anti-recall' },
      { text: '意图感知', link: '/guide/intent-sense' },
    ],
  },
  {
    text: '联系人',
    collapsed: false,
    items: [
      { text: '联系人排序与分组', link: '/guide/contact-directory' },
      { text: '资料历史', link: '/guide/contact-history' },
      { text: '个人资料扩展', link: '/guide/profile-extras' },
      { text: '群交集图谱', link: '/guide/relation-graph' },
      { text: '我的名片与资料页', link: '/guide/self-profile' },
      { text: 'QQ 在线操作（资料 / 群管理）', link: '/guide/qq-actions' },
    ],
  },
  {
    text: '导出与资源',
    collapsed: false,
    items: [
      { text: '统一导出', link: '/guide/export' },
      { text: '我的收藏', link: '/guide/collection' },
      { text: '表情与装扮资源', link: '/guide/emoji-resources' },
    ],
  },
  {
    text: '空间与邮箱',
    collapsed: false,
    items: [
      { text: '空间、相册与频道', link: '/guide/album-qzone' },
      { text: 'QQ 邮箱', link: '/guide/qqmail' },
    ],
  },
  {
    text: '分析与智能',
    collapsed: false,
    items: [
      { text: '聊天分析与年度报告', link: '/guide/analytics' },
      { text: 'AgentLab（克隆 / 群聊）', link: '/guide/agentlab' },
      { text: 'WeQ 助手', link: '/guide/assistant' },
      { text: 'MCP 服务器', link: '/guide/mcp-server' },
      { text: 'OneBot / cc-connect', link: '/guide/onebot-cc-connect' },
      { text: '语音转文字', link: '/guide/voice-transcribe' },
      { text: '模型设置', link: '/guide/model-resources' },
    ],
  },
  {
    text: '工具与设置',
    collapsed: false,
    items: [
      { text: '维护与诊断工具', link: '/guide/wonderful-tools' },
      { text: '本地资源页', link: '/guide/database-view' },
      { text: '性能监视', link: '/guide/performance-monitor' },
      { text: 'Web 服务与手机连接', link: '/guide/remote-web' },
      { text: 'QQ NT 外观预设', link: '/guide/qqnt-appearance' },
      { text: '设置总览', link: '/guide/settings' },
    ],
  },
];

/** 数据库侧栏：按数据库分节。 */
export const databaseSidebar = [
  {
    text: '总览',
    items: [{ text: '数据库一览与字段约定', link: '/database/' }],
  },
  {
    text: 'nt_msg.db — 聊天记录',
    collapsed: false,
    items: [
      { text: '总览', link: '/database/nt_msg/' },
      { text: '消息行', link: '/database/nt_msg/row' },
      { text: '会话列表', link: '/database/nt_msg/40800' },
      { text: '未读状态', link: '/database/nt_msg/unread-info' },
      { text: '隐藏会话', link: '/database/nt_msg/hidden-session' },
      { text: '已删会话', link: '/database/nt_msg/deleted-session' },
      { text: '草稿', link: '/database/nt_msg/draft-storage' },
      { text: '最近联系', link: '/database/nt_msg/recent-contact' },
      { text: '最近联系置顶', link: '/database/nt_msg/recent-contact-top' },
    ],
  },
  {
    text: 'profile_info.db — 资料',
    collapsed: false,
    items: [{ text: '总览', link: '/database/profile_info/' }],
  },
  {
    text: '其他数据库',
    collapsed: false,
    items: [
      { text: 'guild — QQ 频道', link: '/database/guild' },
      { text: 'group_info.db — 群资料', link: '/database/group_info' },
      { text: 'collection.db — 收藏', link: '/database/collection' },
      { text: 'emoji.db — 表情', link: '/database/emoji' },
      { text: 'login.db — 账号列表', link: '/database/login' },
      { text: 'misc.db — 杂项', link: '/database/misc' },
      { text: 'fts — 全文搜索索引', link: '/database/fts' },
    ],
  },
];

/** 工具箱侧栏。 */
export const toolsSidebar = [
  {
    text: '工具箱',
    collapsed: false,
    items: [
      { text: '总览', link: '/tools/' },
      { text: '头像缓存路径预测', link: '/tools/avatar' },
      { text: '数据库密钥计算', link: '/tools/db-key' },
      { text: '商城表情：密钥与解密', link: '/tools/marketface' },
      { text: 'login.db 在线检查', link: '/tools/login-db' },
      { text: '数据目录与设备 guid', link: '/tools/paths' },
    ],
  },
];

/**
 * 开发者侧栏。原理已经并入这里 —— 导航上只有一个「开发」入口，
 * 「原理」是其中一组页面，不再单独占一个顶级栏目。
 */
export const developSidebar = [
  {
    text: '上手',
    items: [
      { text: '开发者入口', link: '/develop/' },
      { text: '测试约定', link: '/develop/testing' },
      { text: '开发控制台日志', link: '/develop/development-console-logging' },
      { text: '原生二进制与资源分发', link: '/develop/native-artifacts' },
      { text: 'QQ 本机消息同步', link: '/develop/qq-local-sync' },
      { text: '长期授权集成', link: '/develop/long-term-authorization' },
    ],
  },
  {
    text: 'Native 能力',
    items: [{ text: 'nt_helper.node 接口', link: '/develop/nt-helper-interface' }],
  },
  {
    text: '原理',
    collapsed: false,
    items: [
      { text: '总览', link: '/develop/principles/' },
      { text: '数据库解密流程', link: '/develop/principles/db-decrypt' },
      { text: '商城表情解密', link: '/develop/principles/mface-decrypt' },
      { text: '头像 Hash 定位公式', link: '/develop/principles/avatar-hash' },
      { text: 'gpro 频道库密钥', link: '/develop/principles/gpro-database' },
      { text: 'FTF 字体分析与转换', link: '/develop/principles/ftf2ttf' },
    ],
  },
  {
    text: '协议与消息',
    items: [
      { text: '发消息', link: '/develop/send-message' },
      { text: '图文 Ark 卡片发送', link: '/develop/ark-send' },
      { text: '推荐联系人 / 群卡片', link: '/develop/contact-ark' },
      { text: 'AI 声聊', link: '/develop/ai-voice' },
      { text: '群报名 / 群收集表', link: '/develop/group-signup' },
    ],
  },
  {
    text: '内容读取',
    items: [
      { text: '群扩展资料读取', link: '/develop/group-profile-extensions' },
      { text: '联系人与群资料历史', link: '/develop/contact-history' },
      { text: '本地文字识别模型', link: '/develop/ocr-models' },
    ],
  },
  {
    text: '导出与存储',
    items: [
      { text: '统一导出格式', link: '/develop/export-format/README' },
      { text: 'WeQ 存储管理', link: '/develop/storage-management' },
    ],
  },
  {
    text: '远端与平台',
    items: [{ text: 'Web 服务与手机连接', link: '/guide/remote-web' }],
  },
  {
    text: '贡献',
    collapsed: false,
    items: [
      {
        text: '贡献指南',
        link: 'https://github.com/weq-devs/WeQ/blob/dev/CONTRIBUTING.md',
      },
      {
        text: '更新记录',
        link: 'https://github.com/weq-devs/WeQ/blob/dev/CHANGELOG.md',
      },
    ],
  },
];
