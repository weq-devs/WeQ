import { searchNameRank } from '@weq/service/search-policy';
import type { MainView } from '../../im-template/template/types';
import { AI_SETTING_ITEMS } from '../settings/aiSettingsCatalog';
import {
  SETTINGS_PAGE_LABELS,
  resolveSettingsTarget,
  settingsGroupFor,
  type SectionId,
  type SettingsPageId,
} from '../settings/navigation';
export { SETTINGS_PAGE_LABELS } from '../settings/navigation';

export type SearchableTool = 'export' | 'viewer' | 'analysis' | 'tasks' | 'assistant';
export interface ToolSearchRequest {
  scope: string;
  tool: SearchableTool;
  revision: number;
}
export type AppSearchTarget =
  | { kind: 'view'; view: MainView }
  | { kind: 'tool'; tool: SearchableTool }
  | { kind: 'setting'; section: SectionId; item?: string; settingId?: string }
  | { kind: 'composition' }
  | { kind: 'dressup' };

export interface AppSearchEntry {
  id: string;
  title: string;
  path: string;
  keywords: readonly string[];
  target: AppSearchTarget;
}

// 这里只保存公开的界面名称与入口，不读取设置值、账号资料或凭据。
const PAGE_ALIASES: Partial<Record<SettingsPageId, string[]>> = {
  global: ['窗口行为', '通知'],
  'weq-storage': ['默认保存', '存储与网络', 'storage', 'saving'],
  'chat-messages': ['消息显示', 'message-display'],
  'call-recording': ['通话与录音'],
  account: ['接入与监听', '账号接入与消息'],
  accounts: ['账号管理', '媒体来源', 'media'],
  credentials: ['账号凭据'],
  diagnostics: ['高级诊断'],
  'database-repair': ['损坏处理'],
  'database-tolerance': ['损坏处理与容错', '容错记录', 'database-status'],
  'database-management': ['维护工具', 'maintenance'],
  'qq-storage': ['QQ 存储管理', '资源管理', '本地缓存'],
  privacy: ['隐私与应用锁', '应用锁', '隐私模式', 'applock'],
  'resource-loading': ['资源下载网络', '网络', 'CDN'],
  assistant: ['公众号推送', 'QQ 公众号'],
  sse: ['SSE 消息推送'],
  backup: ['设置备份', '备份与恢复'],
};

type SettingDefinition = readonly [section: SectionId, item: string, ...aliases: string[]];
const SETTING_ITEMS: readonly SettingDefinition[] = [
  ...AI_SETTING_ITEMS.map(
    (item): SettingDefinition => [item.section, item.label, ...(item.aliases ?? [])],
  ),
  ['home', '个性标签', '主页标签'],
  ['home', '问候语', '主页问候'],
  ['home', '一言', 'hitokoto'],
  ['home', '一言屏蔽词', '屏蔽词', '过滤句子'],
  ['global', '关闭按钮行为', '关闭窗口', '最小化到托盘', '退出应用'],
  ['global', '成功通知停留时长', '通知时间'],
  ['global', '失败通知停留时长', '通知时间'],
  ['global', '默认发送正在输入状态', '正在输入', '打字状态'],
  ['startup', '开机自动启动 WeQ', '自启动'],
  ['startup', '自启时显示窗口', '启动显示窗口', '隐藏启动'],
  ['call-recording', '录音来源', '录音模式', '双方混合', '仅本端', '仅对方'],
  ['call-recording', '同时录电脑声音', '系统音频'],
  ['call-recording', '保存位置', '录音目录'],
  ['saving', '默认保存方式', '导出保存方式'],
  ['saving', '保存位置', '默认导出目录', '默认保存目录'],
  ['appearance', '基础模式', '浅色模式', '深色模式', '暗色模式', '跟随系统'],
  ['appearance', '主题色', '强调色', '主色', '颜色'],
  ['appearance', '界面背景', '聊天背景', '壁纸'],
  ['appearance', '组件风格', '皮肤'],
  ['message-display', '从第一条新消息开始阅读', '第一条未读'],
  ['message-display', '发送消息后定位到最新消息', '发送后跳转'],
  ['message-display', '使用 QQ 账号设置的个性字体发送消息', '发送字体'],
  ['message-display', '群助手显示总消息数'],
  ['message-display', '自定义消息显示'],
  ['message-display', '显示消息汇总红点', '未读红点'],
  ['message-display', '纯文本消息渲染 Markdown', '富文本'],
  ['message-display', '聊天头像挂件'],
  ['message-display', '显示消息序号（seq）', '消息序号'],
  ['message-display', '显示发送时间（精确到秒）', '消息时间'],
  ['message-display', '消息气泡', '消息装扮', '气泡'],
  ['message-display', '消息字体', '字体', '聊天字体'],
  ['message-display', '链接预览卡片', '网页预览'],
  ['message-display', '无封面时网页截图', '链接截图'],
  ['applock', '启用应用锁', '锁屏', '隐私锁'],
  ['applock', '隐私模式', '隐藏个人信息'],
  ['privacy', '在菜单中截图瞬间临时启用隐私模式', '截图隐私'],
  ['applock', '解锁方式', 'Touch ID', 'Windows Hello', '验证器'],
  ['applock', '无操作自动上锁', '空闲自动锁定'],
  ['accounts', '现有配置', '自动进入账号'],
  ['account', '启用数据库监听', '自动刷新消息'],
  ['account', '同步已读状态到 QQ'],
  ['account', '手动标记时上报已读位置'],
  ['account', '自动读取 QQ 内存（完整功能）', '完整模式'],
  ['account', '进入受限模式时横幅提醒', '受限横幅'],
  ['anti-recall', '防撤回', 'anti-recall'],
  ['rkey', '外部 RKEY', '外部 rKey 服务器'],
  ['qzone', '在线翻页限速', '空间翻页频率'],
  ['mail', '显示未读邮件数'],
  ['mail', '新邮件提醒'],
  ['storage', '优先使用 CDN', '下载加速'],
  ['storage', '缓存目录', '缓存位置'],
  ['storage', 'WeQ 存储管理', '清理数据', '释放空间'],
  ['media', '关联本机媒体目录', '本地图片目录'],
  ['media', '允许使用外部安卓图片缓存', 'Android 图片'],
  ['backup', '导出备份', '备份配置'],
  ['backup', '导入备份', '恢复备份'],
  ['backup', '恢复默认设置', '重置设置', '恢复出厂'],
  ['database', '数据库异常时弹窗提醒', '损坏提醒'],
  ['database', '数据库宽容级别', '容错级别', '严格模式'],
  ['database-status', '降级账本'],
  ['database-status', '已放弃的表（隔离中）'],
  ['agentlab', 'TTS 语音合成', '语音合成', '朗读', '音色'],
  ['agentlab', '已保存的 provider', 'API Key', 'Base URL', '服务商'],
  ['agentlab', '默认模型', 'LLM 默认模型'],
  ['clone-settings', '克隆体配置', '克隆提示词', '克隆语音', '发言意愿'],
  ['intent-sense', '启用意图感知'],
  ['intent-sense', '意图感知运行方式', '本地意图模型'],
  ['intent-sense', '意图模型资源（全局）', '意图模型资源', '使用下载镜像', 'hf-mirror.com 镜像'],
  ['intent-sense', '自己发送后分析'],
  ['reply-suggestions', '启用推荐回复'],
  ['reply-suggestions', '推荐回复 API 模型'],
  ['reply-suggestions', '常驻显示'],
  ['reply-suggestions', '悬停显示'],
  ['reply-suggestions', '自己发送后推荐回复'],
  ['interaction-profile', '启用互动画像'],
  ['voice', '本地语音模型', '语音转文字', 'ASR', '转写'],
  ['ocr', 'QQ 在线 OCR', '文字识别'],
  ['ocr', '识别模型'],
  ['ocr', '筛图模型'],
  ['mcp', '启用 MCP 服务器'],
  ['mcp', 'MCP 端口'],
  ['remote', '启用 Web 服务', '浏览器访问'],
  ['remote', '启动 WeQ 时自动开启 Web 服务'],
  ['sse', '推送调优', '防抖毫秒', '大量消息阈值'],
  ['assistant', '启用 WeQ 助手', '公众号推送'],
  ['credentials', '数据库密钥'],
  ['credentials', '会话密钥'],
  ['credentials', '下载 rKey'],
  ['credentials', 'ClientKey'],
  ['logs', '日志保留时长'],
  ['logs', '日志文件夹'],
  ['maintenance', '本地缓存'],
  ['maintenance', '数据库管理', '数据库浏览'],
  ['maintenance', '存储占用'],
  ['maintenance', '清理缓存'],
  ['maintenance', '数据库修复', '修复数据库'],
  ['maintenance', '导出明文数据库', '数据库解密'],
  ['maintenance', '密钥扫描'],
  ['maintenance', '其它设备密钥', '其他设备密钥'],
  ['diagnostics', 'ntqq 抓包'],
  ['diagnostics', 'Protobuf / JCE 逆向'],
];

function settingEntry(section: SectionId, item?: string, keywords: string[] = []): AppSearchEntry {
  const resolved = resolveSettingsTarget({ section, item });
  const page = SETTINGS_PAGE_LABELS[resolved.section];
  return {
    id: `setting:${resolved.section}:${resolved.settingId ?? item ?? ''}`,
    title: item ? (resolved.item ?? item) : page,
    path: ['设置', settingsGroupFor(resolved.section).label, page].join(' / '),
    keywords: [...keywords, ...(item ? [item] : (PAGE_ALIASES[resolved.section] ?? []))],
    target: { kind: 'setting', ...resolved },
  };
}

const feature = (
  title: string,
  target: AppSearchTarget,
  ...keywords: string[]
): AppSearchEntry => ({
  id: `feature:${title}`,
  title,
  path: '功能',
  target,
  keywords,
});

function uniqueEntries(entries: AppSearchEntry[]): AppSearchEntry[] {
  const unique = new Map<string, AppSearchEntry>();
  for (const entry of entries) {
    const previous = unique.get(entry.id);
    unique.set(
      entry.id,
      previous ? { ...previous, keywords: [...previous.keywords, ...entry.keywords] } : entry,
    );
  }
  return [...unique.values()];
}

export const APP_SEARCH_ENTRIES: readonly AppSearchEntry[] = uniqueEntries([
  feature('首页', { kind: 'view', view: 'home' }),
  feature('消息', { kind: 'view', view: 'messages' }, '聊天', '会话'),
  feature('联系人', { kind: 'view', view: 'contacts' }, '好友', '群聊'),
  feature('收藏', { kind: 'view', view: 'collections' }),
  feature('QQ 空间', { kind: 'view', view: 'qzone' }, '说说', '相册'),
  feature('QQ 邮箱', { kind: 'view', view: 'mail' }, '邮件'),
  feature('频道', { kind: 'view', view: 'channel' }, '频道私聊'),
  feature('好友克隆', { kind: 'view', view: 'agentlab' }, '克隆聊天'),
  feature('年度报告', { kind: 'view', view: 'annual' }, '年度总结'),
  feature('导出', { kind: 'tool', tool: 'export' }, '导出聊天记录', '备份聊天'),
  feature('导出查看器', { kind: 'tool', tool: 'viewer' }, '打开导出', 'JSON', 'JSONL'),
  feature('分析与报告', { kind: 'tool', tool: 'analysis' }, '聊天分析', '统计'),
  feature('任务', { kind: 'tool', tool: 'tasks' }, '导出进度', '下载任务'),
  feature('WeQ 助手', { kind: 'tool', tool: 'assistant' }, 'AI 助手', '智能助手'),
  feature('合成聊天记录', { kind: 'composition' }, '合并转发'),
  feature('个性装扮', { kind: 'dressup' }, '气泡', '字体', '商城表情', '通话背景'),
  ...Object.keys(SETTINGS_PAGE_LABELS).map((section) =>
    settingEntry(section as keyof typeof SETTINGS_PAGE_LABELS, undefined, [section]),
  ),
  ...SETTING_ITEMS.map(([section, item, ...aliases]) => settingEntry(section, item, aliases)),
]);

export function searchAppEntries(keyword: string): AppSearchEntry[] {
  const query = keyword.trim();
  if (!query) return [];
  return APP_SEARCH_ENTRIES.map((entry, index) => ({
    entry,
    index,
    rank:
      searchNameRank(query, entry.title) * 10 ||
      searchNameRank(query, ...entry.keywords) * 2 ||
      searchNameRank(query, entry.path),
  }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(({ entry }) => entry);
}
