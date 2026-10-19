/** 统一导出工具：内容选择与执行配置；任务工具独立管理执行结果和计划。 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useMultiSelection } from '../hooks/useMultiSelection';
import {
  Bookmark,
  CalendarClock,
  Contact,
  Database,
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  Images,
  FolderOpen,
  Layers,
  Link2,
  MapPin,
  MessagesSquare,
  Music,
  Pause,
  Play,
  Radio,
  RotateCw,
  Search,
  Smile,
  Trash2,
  Users,
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { useToast } from '../components/Toast';
import { isDataline, deviceAvatarDataUri } from '../lib/deviceAvatar';
import { fixProfileAvatarUrl } from '../lib/avatarResolver';
import { classifyChatType, datalineName, toChatTypeNumber } from '@weq/codec';
import type { ExportPresets } from '@weq/service';
import { Segmented } from './export/widgets';
import { ChipsSkeleton, PickerListSkeleton, ScheduleListSkeleton } from './export/ExportSkeleton';
import { ConversationPicker } from './export/ConversationPicker';
import { SingleSelectPicker } from './export/SingleSelectPicker';
import { EmojiPackExportPane } from './export/EmojiPackExportPane';
import { TaskList, type UiFailure, type UiLogLine, type UiTask } from './export/TaskList';
import { RoamingBackfillPanel } from '../components/RoamingBackfillPanel';
import { CloneTasksPane } from './agentlab/CloneTasksPane';
import { preflightExportEstimate } from './export/preflight';
import { ExportLightbox, type LightboxResult, type LightboxVariant } from './export/ExportLightbox';
import { AlbumExportLightbox, type AlbumExportResult } from './export/AlbumExportLightbox';
import {
  GroupFileExportLightbox,
  type GroupFileExportResult,
} from './export/GroupFileExportLightbox';
import { FailureLightbox } from './export/FailureLightbox';
import { ocrReadiness, preflightQqOnline } from './export/preflight';
import {
  buildChatExportMedia,
  preflightChatExport,
  startChatExportTasks,
} from './export/chatExport';
import {
  COLLECTION_FORMATS,
  DEFAULT_OPTIONS,
  chatKind,
  convAvatarUrl,
  fmtCount,
  groupAvatarUrl,
  type ExportFormat,
  type ExportMode,
  type ExportOptions,
  type PickItem,
  type ScheduledTask,
} from './export/types';
import '../styles/export.css';
import { MessageScopePicker } from './export/MessageScopePicker';
import { ExportSaveActions } from '../components/ExportSaveActions';
import { ServerSavePrompt } from '../components/ServerSavePrompt';
import { SaveResultLocation } from './export/SaveResultLocation';
import { IS_WEB } from '../lib/target';
import type { ContentSelection } from '../../../shared/content_selection';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { DatabasePlainExport } from './export/DatabasePlainExport';
import { useViewState } from '../state/view';
import { useExportCollections } from '../hooks/useExportCollections';
import {
  initialContactScope,
  initialConversationIds,
  initialExportMode,
  initialGuildScope,
  initialQzoneScope,
} from './export/exportScope';
import { ContactScopePicker } from './export/ContactScopePicker';
import { GeneratedExportPane } from './export/GeneratedExportPane';
import { QzoneScopePicker } from './export/QzoneScopePicker';
import '../styles/unified-export.css';
import { useTabActive } from '../components/RetainedTabs';

interface ModeDef {
  id: ExportMode;
  label: string;
  desc: string;
  icon: ReactNode;
}

const MODES: ModeDef[] = [
  {
    id: 'database',
    label: '明文数据库',
    desc: '原始 SQLite 数据库副本',
    icon: <Database size={18} />,
  },
  {
    id: 'full',
    label: '聊天消息导出',
    desc: 'JSON / JSONL / XLSX / CSV / TXT / HTML',
    icon: <MessagesSquare size={18} />,
  },
  {
    id: 'guild',
    label: '频道私聊数据',
    desc: '本地频道私聊 · 完整消息格式（不支持漫游拉取）',
    icon: <Radio size={18} />,
  },
  {
    id: 'generated',
    label: '克隆与助手对话',
    desc: '本地生成记录',
    icon: <MessagesSquare size={18} />,
  },
  {
    id: 'qzone',
    label: 'QQ空间导出',
    desc: '空间说说 · JSON / TXT / HTML',
    icon: <Globe size={18} />,
  },
  {
    id: 'contacts',
    label: '导出联系人',
    desc: '联系人名单 / 群聊名单 / 群成员名单',
    icon: <Contact size={18} />,
  },
  { id: 'collection', label: '导出收藏', desc: 'QQ 收藏导出为表格', icon: <Bookmark size={18} /> },
  { id: 'album', label: '群相册导出', desc: '批量下载群相册', icon: <Images size={18} /> },
  { id: 'groupfile', label: '群文件导出', desc: '批量下载群文件', icon: <FolderOpen size={18} /> },
  {
    id: 'emojipack',
    label: '导出表情包',
    desc: '自己的 / 收到的自定义表情',
    icon: <Smile size={18} />,
  },
];

/** Recent-contact wire shape we actually read here. */
interface ConvWire {
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  targetDisplayName: string;
  messageCount?: number;
}

/** account.getSelfProfile wire 里本页用到的字段（自己的空间选项）。 */
interface SelfProfileWire {
  uid: string;
  uin: string;
  nick: string;
  avatarUrl: string;
}

interface GroupWire {
  groupCode: string;
  groupName: string;
  memberCount: number;
}

/** 频道私聊会话 wire 行（serde.guildDirectSessionToWire 输出，取导出用到的字段）。 */
interface GuildSessionWire {
  nodeId: string;
  peerTinyId: string;
  guildName?: string;
  peerNick: string;
  peerAvatarUrl: string | null;
  messageCount?: number;
}

/** 导出收藏预览行：从 `CollectionItemWire` 投影出展示用的标题/摘要/来源。 */
interface CollectionPreviewItem {
  cid: string;
  kind: string;
  /** 主行：标题（链接/视频/图文标题、文件名、地点名…）。 */
  title: string;
  /** 次行：正文摘要 / 补充信息。 */
  sub: string;
  /** 来源（收藏者昵称 / 群名）。 */
  source: string;
  /** 收藏时间（ms）。 */
  collectTime: number;
}

/** `account.listCollections` wire 里预览要读的字段（与 CollectionDialog 的声明对齐）。 */
interface CollectionItemWire {
  cid: string;
  kind: string;
  collectTime: number;
  authorName: string;
  groupName: string;
  text: string;
  link: { url: string; title: string; publisher: string; brief: string } | null;
  gallery: { pics: unknown[] } | null;
  audio: { duration: number; stt: string } | null;
  video: { title: string; duration: number; fileName: string } | null;
  file: { name: string; size: string } | null;
  location: { name: string; address: string; latitude: number; longitude: number } | null;
  richMedia: { title: string; subTitle: string; brief: string } | null;
}

/** 秒 → `M:SS` / `S"`（0/空留空）。 */
function fmtSeconds(sec: number): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${s}"`;
}

/** QQ 空间导出格式收窄：html 直通，其余非 txt 一律回退 json。 */
function qzoneFormatOf(f: ExportFormat): 'json' | 'txt' | 'html' {
  if (f === 'txt') return 'txt';
  if (f === 'html') return 'html';
  return 'json';
}

/** wire → 预览行：每种 kind 收敛出「标题 + 摘要」（对齐收藏弹窗各卡片的主信息）。 */
function collectionPreview(it: CollectionItemWire): CollectionPreviewItem {
  let title = '';
  let sub = '';
  switch (it.kind) {
    case 'text':
      title = it.text || '(空文本)';
      break;
    case 'link':
      title = it.link?.title || it.link?.url || '链接';
      sub = it.link?.brief || it.link?.publisher || it.link?.url || '';
      break;
    case 'gallery': {
      const n = it.gallery?.pics.length ?? 0;
      title = `图片 × ${n}`;
      break;
    }
    case 'audio': {
      const dur = fmtSeconds((it.audio?.duration ?? 0) / 1000);
      title = dur ? `语音 · ${dur}` : '语音';
      sub = it.audio?.stt ?? '';
      break;
    }
    case 'video': {
      title = it.video?.title || it.video?.fileName || '视频';
      const dur = fmtSeconds(it.video?.duration ?? 0);
      sub = dur ? `时长 ${dur}` : '';
      break;
    }
    case 'file':
      title = it.file?.name || '文件';
      break;
    case 'location':
      title = it.location?.name || '未命名地点';
      sub =
        it.location?.address ||
        (it.location && (it.location.latitude || it.location.longitude)
          ? `${it.location.latitude.toFixed(5)}, ${it.location.longitude.toFixed(5)}`
          : '');
      break;
    case 'richMedia':
      title =
        it.richMedia?.title || it.richMedia?.subTitle || it.richMedia?.brief || '(无文本内容)';
      sub = it.richMedia?.title || it.richMedia?.subTitle ? (it.richMedia?.brief ?? '') : '';
      break;
    default:
      title = '未知类型';
  }
  return {
    cid: it.cid,
    kind: it.kind,
    title,
    sub,
    source: [it.authorName, it.groupName].filter(Boolean).join(' · '),
    collectTime: it.collectTime,
  };
}

export function ExportTool({
  surface = 'export',
  initialSelection,
  initialMode,
  onClose,
  fixedScope = false,
  lockMode = false,
  contentListRevision,
  onOpenClone,
}: {
  surface?: 'export' | 'tasks';
  initialSelection?: ContentSelection;
  initialMode?: ExportMode;
  onClose?: () => void;
  fixedScope?: boolean;
  /** 由入口（如维护工具）锁死导出类型：不渲染「内容种类」切换器，模式不可更改。 */
  lockMode?: boolean;
  /** 全局入口再次打开时回到内容列表，保留草稿中的选择。 */
  contentListRevision?: number;
  onOpenClone?: (id: string) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const accountUin = useViewState((state) => state.openedUin);
  const active = useTabActive();
  const dialog = useAppDialog();
  const pushToast = useToast((s) => s.push);
  const mounted = useRef(true);
  const saveLocationPending = useRef<((directory: string | null) => void) | null>(null);
  const [saveLocationTask, setSaveLocationTask] = useState<UiTask | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveLocationPending.current?.(null);
    };
  }, []);
  const {
    settings: globalSettings,
    picking: pickingSaveDirectory,
    prepareSave,
    serverLocation,
    chooseServerLocation,
    isCurrent,
  } = useExportSavePolicy();
  const saveIntent = useRef<import('@weq/service').ExportSavePolicy | undefined>(undefined);

  const tasks = trpc.account.listExportTasks.useQuery();
  const schedules = trpc.account.listSchedules.useQuery();

  const [mode, setMode] = useState<ExportMode>(
    initialMode === 'scheduled' ? 'full' : (initialMode ?? initialExportMode(initialSelection)),
  );
  const exportAccount = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active,
  });
  const conversations = trpc.account.listConversationsWithCount.useQuery(undefined, {
    enabled: active && surface === 'export' && (mode === 'full' || mode === 'qzone'),
  });
  const selfProfile = trpc.account.getSelfProfile.useQuery(undefined, {
    enabled: active && surface === 'export' && mode === 'qzone',
  });
  const [execution, setExecution] = useState<'now' | 'scheduled'>(
    initialMode === 'scheduled' ? 'scheduled' : 'now',
  );
  const [taskTab, setTaskTab] = useState<'tasks' | 'schedules' | 'roaming' | 'clones'>('tasks');
  // 频道私聊会话列表（guild_msg.db；只在该模式下加载）。
  const guildSessions = trpc.account.guildDirectListSessions.useQuery(undefined, {
    enabled: active && surface === 'export' && mode === 'guild',
  });
  const [chatSelection, setChatSelection] = useState<Set<string>>(
    () => new Set(initialConversationIds(initialSelection)),
  );
  const [qzoneInitial] = useState(() => initialQzoneScope(initialSelection));
  const [spaceSelection, setSpaceSelection] = useState<Set<string>>(
    () => new Set(qzoneInitial.uin ? [qzoneInitial.uin] : []),
  );
  const [postSelections, setPostSelections] = useState<Record<string, string[]>>(() =>
    qzoneInitial.uin && qzoneInitial.tids !== undefined
      ? { [qzoneInitial.uin]: [...qzoneInitial.tids] }
      : {},
  );
  const [spaceScopeUin, setSpaceScopeUin] = useState<string | null>(() =>
    qzoneInitial.tids !== undefined ? (qzoneInitial.uin ?? null) : null,
  );
  const convSelection = mode === 'qzone' ? spaceSelection : chatSelection;
  const setConvSelection = mode === 'qzone' ? setSpaceSelection : setChatSelection;
  const [messageSelections, setMessageSelections] = useState<Record<string, string[]>>(() => {
    if (initialSelection?.owner.kind !== 'messages' || initialSelection.scope.type !== 'items')
      return {};
    const conv = initialSelection.owner.container.slice(
      initialSelection.owner.container.indexOf(':') + 1,
    );
    return { [conv]: [...initialSelection.scope.ids] };
  });
  const [scopeConversationId, setScopeConversationId] = useState<string | null>(() =>
    initialSelection?.owner.kind === 'messages' && initialSelection.scope.type === 'items'
      ? (initialConversationIds(initialSelection)[0] ?? null)
      : null,
  );
  /** 频道私聊多选：id = nodeId（与普通会话 uid 空间不同，分开存。） */
  const [guildInitial] = useState(() => initialGuildScope(initialSelection));
  const [guildSelection, setGuildSelection] = useState<Set<string>>(
    () => new Set(guildInitial.nodeIds),
  );
  const [guildMessageSelections, setGuildMessageSelections] = useState(guildInitial.messageIds);
  const [guildScopeId, setGuildScopeId] = useState<string | null>(
    () => guildInitial.nodeIds[0] ?? null,
  );
  /** 任务面板展开/收起（默认收起）。 */
  const [taskPanelExpanded, setTaskPanelExpanded] = useState(true);
  /** 新任务到达时，强制选中该任务。 */
  const [autoSelectTaskId, setAutoSelectTaskId] = useState<string | null>(null);
  /** 导出联系人：好友 or 群成员。 */
  const [contactInitial] = useState(() => initialContactScope(initialSelection));
  const [contactScope, setContactScope] = useState<'friends' | 'group' | 'groups'>(
    contactInitial.scope,
  );
  const [groupListIds, setGroupListIds] = useState<string[] | undefined>(
    contactInitial.groupListIds,
  );
  const [friendUids, setFriendUids] = useState<string[] | undefined>(contactInitial.friendUids);
  /** 好友导出：选中的分组 id（空 = 全部好友）。 */
  const [catSelection, setCatSelection] = useState<Set<number>>(new Set());
  /** 群成员导出：选中的群号。 */
  const [contactGroupIds, setContactGroupIds] = useState<Set<string>>(
    () => new Set(contactInitial.groupIds),
  );
  const [memberUids, setMemberUids] = useState<Record<string, string[]>>(contactInitial.memberUids);
  const [memberScopeGroupId, setMemberScopeGroupId] = useState<string | null>(
    () => Object.keys(contactInitial.memberUids)[0] ?? null,
  );
  const groups = trpc.account.exportGroupDirectory.useQuery(undefined, {
    enabled:
      active &&
      surface === 'export' &&
      ((mode === 'contacts' && contactScope !== 'friends') ||
        mode === 'album' ||
        mode === 'groupfile'),
  });
  /** 导出收藏：选中的收藏类型（空 = 全部）。 */
  const [collectionKinds, setCollectionKinds] = useState<Set<string>>(new Set());
  const [collectionIds, setCollectionIds] = useState<string[] | undefined>(() =>
    initialSelection?.owner.kind === 'collections' && initialSelection.scope.type === 'items'
      ? [...initialSelection.scope.ids]
      : undefined,
  );
  const [filteredCollectionIds, setFilteredCollectionIds] = useState<string[]>([]);
  /** 收藏预览：加载一次全部收藏（含展示摘要），按类型计数 + 下方列表预览。 */
  const collectionSource = useExportCollections(
    active && mode === 'collection' && surface === 'export',
    accountUin,
  );
  const collectionItems = useMemo(
    () => collectionSource.items.map(collectionPreview),
    [collectionSource.items],
  );
  const collectionLoading = collectionSource.loading;

  const friendsEnabled =
    active && surface === 'export' && mode === 'contacts' && contactScope === 'friends';
  const categories = trpc.account.listCategories.useQuery(undefined, { enabled: friendsEnabled });
  const friendDirectory = trpc.account.contactsExportPreview.useQuery(
    { scope: 'friends' },
    { enabled: friendsEnabled },
  );
  const memberDirectory = trpc.account.contactsExportPreview.useQuery(
    { scope: 'group', groupCode: memberScopeGroupId ?? '1' },
    {
      enabled:
        active &&
        surface === 'export' &&
        mode === 'contacts' &&
        contactScope === 'group' &&
        Boolean(memberScopeGroupId && contactGroupIds.has(memberScopeGroupId)),
    },
  );
  const [albumOutputDir, setAlbumOutputDir] = useState<string | null>(null);
  const [albumExport, setAlbumExport] = useState<{ group: PickItem } | null>(null);
  const [albumGroupId, setAlbumGroupId] = useState<string | null>(null);
  const [fileOutputDir, setFileOutputDir] = useState<string | null>(null);
  const [fileExport, setFileExport] = useState<{ group: PickItem } | null>(null);
  const [fileGroupId, setFileGroupId] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('json');
  const fixedMessages =
    fixedScope &&
    (initialSelection?.owner.kind === 'messages' ||
      initialSelection?.owner.kind === 'conversations');
  const [editingList, setEditingList] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxVariant | null>(fixedMessages ? 'full' : null);
  useEffect(() => {
    if (contentListRevision === undefined) return;
    setLightbox(null);
    setEditingList(false);
  }, [contentListRevision]);
  const [submitting, setSubmitting] = useState(false);
  /** 各模式最近一次导出的灯箱配置快照，打开面板时自动回填。 */
  const [exportPresets, setExportPresets] = useState<ExportPresets | null>(null);
  /** Media-completion failure detail, when the user opens a task's failure list. */
  const [failureView, setFailureView] = useState<{ name: string; failures: UiFailure[] } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void client.bootstrap.getExportPresets
      .query()
      .then((p) => {
        if (!cancelled) setExportPresets(p);
      })
      .catch(() => {
        // 缓存读不出来就按默认配置打开，不影响导出。
        if (!cancelled) setExportPresets({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 好友空间 only json/txt/html; 联系人受子类限制 — clamp。
  useEffect(() => {
    if (mode === 'qzone' && format !== 'json' && format !== 'txt' && format !== 'html')
      setFormat('json');
    if (mode === 'contacts') {
      const allowed =
        contactScope === 'friends'
          ? ['json', 'jsonl', 'csv', 'xlsx', 'txt', 'vcard']
          : ['json', 'jsonl', 'csv', 'xlsx', 'txt'];
      if (!allowed.includes(format)) setFormat('csv');
    }
    if (mode === 'collection' && !['json', 'csv', 'xlsx', 'txt'].includes(format))
      setFormat('json');
    // vcard 仅联系人可用；离开联系人模式时清掉，避免带进消息/定时导出。
    if (mode !== 'contacts' && format === 'vcard') setFormat('json');
  }, [mode, contactScope, format]);

  // Live task progress: invalidate the list whenever the backend ticks.
  useEffect(() => {
    const sub = client.account.onExportProgress.subscribe(undefined, {
      onData: (progress) => {
        void utils.account.listExportTasks.invalidate();
        if (progress.notice) {
          pushToast({ tone: 'warning', title: '消息补全', message: progress.notice, ttl: 5000 });
        }
      },
      onError: (err) => console.error('[export] progress subscription error', err),
    });
    return () => sub.unsubscribe();
  }, [utils, pushToast]);

  const convItems = useMemo<PickItem[]>(() => {
    return ((conversations.data ?? []) as ConvWire[]).map((c) => {
      const kind = chatKind(c.chatType);
      const count = Number(c.messageCount ?? 0);
      const dataline = isDataline(c.chatType);
      const name =
        c.targetDisplayName || (dataline ? datalineName(c.targetUid) : null) || c.targetUid;
      return {
        id: c.targetUid,
        name,
        // 数据线（我的手机/我的电脑）无 QQ 头像，用自绘设备图标兜底。
        avatarUrl: dataline
          ? deviceAvatarDataUri(c.targetUid)
          : convAvatarUrl(kind, c.targetUid, c.targetUin),
        kind,
        uin: c.targetUin,
        total: count,
        meta: `${fmtCount(count)} 条 · ${kind === 'group' ? '群聊' : '私聊'}`,
      };
    });
  }, [conversations.data]);

  // 频道私聊选择列表：id = nodeId，总数取会话本地消息计数。
  const guildItems = useMemo<PickItem[]>(() => {
    return ((guildSessions.data ?? []) as GuildSessionWire[]).map((c) => {
      const count = Number(c.messageCount ?? 0);
      return {
        id: c.nodeId,
        name: c.peerNick || c.peerTinyId,
        avatarUrl: c.peerAvatarUrl,
        total: count,
        meta: `${fmtCount(count)} 条 · 频道私聊`,
      };
    });
  }, [guildSessions.data]);

  // QQ 空间导出目标：自己的空间（置顶）+ 私聊好友（排除群聊、公众号、服务号，且需有效 uin）。
  const friendItems = useMemo<PickItem[]>(() => {
    const self = selfProfile.data as SelfProfileWire | null | undefined;
    const raw = (conversations.data ?? []) as ConvWire[];
    // 导出自己时能看到自己的私密说说，与好友的只读视角不同。
    const mine: PickItem[] =
      self?.uin && self.uin !== '0'
        ? [
            {
              id: self.uin,
              name: self.nick?.trim() ? `${self.nick}（我）` : '我的空间',
              // 资料库存的头像是 `qh.qlogo.cn/g?b=qq&ek=...&s=`（空 s= 会 400，
              // 且该域已加进渲染层 CSP）—— 先补成 s=0 直接使用；没有存档头像
              // 再按 uin 拼公共 CDN 兜底，避免回退成昵称首字符。
              avatarUrl:
                fixProfileAvatarUrl(self.avatarUrl) || convAvatarUrl('c2c', self.uid, self.uin),
              kind: 'c2c',
              uin: self.uin,
              total: 0,
              meta: '自己的空间 · 说说',
            },
          ]
        : [];
    const friends: PickItem[] = raw
      .filter((c) => {
        // 排除公众号(103)/服务号(118)：wire 的 chatType 既可能是枚举名字符串
        // （如 KCHATTYPETEMPPUBLICACCOUNT），也可能是数字 —— Number() 直接比较
        // 会漏掉字符串形态，官方号因此混进列表。统一转数字再判。
        const chatTypeNum = toChatTypeNumber(c.chatType);
        if (chatTypeNum === 103 || chatTypeNum === 118) return false;
        // 排除群聊：不能按子串判 —— 群聊发起的临时会话
        // KCHATTYPETEMPC2CFROMGROUP（100）名字里含 'GROUP'，但它其实是私聊，
        // 有有效 uin 就该出现在这里。
        if (classifyChatType(c.chatType) === 'group') return false;
        // 需要有效的uin
        return c.targetUin && c.targetUin !== '0';
      })
      .map((c) => ({
        id: c.targetUin,
        name: c.targetDisplayName || c.targetUid,
        avatarUrl: convAvatarUrl('c2c', c.targetUid, c.targetUin),
        kind: 'c2c' as const,
        uin: c.targetUin,
        total: Number(c.messageCount ?? 0),
        // 导出的内容是目标空间的说说，不是私聊消息 —— 别拿聊天条数当说明。
        meta: '好友空间 · 说说',
      }));
    const byUin = new Map<string, PickItem>();
    for (const item of [...mine, ...friends]) if (!byUin.has(item.id)) byUin.set(item.id, item);
    const items = [...byUin.values()];
    if (qzoneInitial.uin && !items.some((item) => item.id === qzoneInitial.uin))
      items.unshift({
        id: qzoneInitial.uin,
        uin: qzoneInitial.uin,
        name: `空间 ${qzoneInitial.uin}`,
        avatarUrl: convAvatarUrl('c2c', '', qzoneInitial.uin),
        kind: 'c2c',
        meta: '当前空间 · 说说',
      });
    return items;
  }, [conversations.data, selfProfile.data, qzoneInitial.uin]);

  const groupItems = useMemo<PickItem[]>(() => {
    return ((groups.data ?? []) as GroupWire[]).map((g) => ({
      id: g.groupCode,
      name: g.groupName || g.groupCode,
      avatarUrl: groupAvatarUrl(g.groupCode),
      kind: 'group',
      meta: `${fmtCount(g.memberCount || 0)} 人`,
    }));
  }, [groups.data]);

  // 好友分组 chips（导出联系人 · 好友）。
  const catItems = useMemo<Array<{ id: number; name: string; count: number }>>(() => {
    return ((categories.data ?? []) as Array<{ id: number; name: string; buddyCount: number }>).map(
      (c) => ({ id: c.id, name: c.name || `分组${c.id}`, count: Number(c.buddyCount ?? 0) }),
    );
  }, [categories.data]);

  const friendTotal = friendDirectory.data?.length ?? catItems.reduce((sum, c) => sum + c.count, 0);

  // 收藏类型计数（导出收藏）：全部 + 每种 kind。
  const collectionCounts = useMemo(() => {
    const items = collectionItems ?? [];
    const c: Record<string, number> = { all: items.length };
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, [collectionItems]);

  const friendPreview = useMemo(() => {
    const rows = friendDirectory.data ?? [];
    return (
      catSelection.size ? rows.filter((row) => catSelection.has(row.categoryId)) : [...rows]
    ).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }, [friendDirectory.data, catSelection]);
  const memberScopeGroup =
    memberScopeGroupId && contactGroupIds.has(memberScopeGroupId)
      ? {
          id: memberScopeGroupId,
          name:
            groupItems.find((item) => item.id === memberScopeGroupId)?.name ?? memberScopeGroupId,
        }
      : null;

  const uiTasks = useMemo<UiTask[]>(() => {
    // Defensive: the IPC payload can momentarily be a non-array during a main
    // process restart / error envelope — never let that white-screen the view.
    const rows = Array.isArray(tasks.data) ? (tasks.data as UiTask[]) : [];
    return rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      format: t.format,
      formats: (t as { formats?: string[] }).formats,
      status: t.status,
      progress: t.progress,
      current: t.current,
      total: t.total,
      error: t.error,
      filePath: t.filePath,
      bundleDir: t.bundleDir,
      canResume: t.canResume,
      resumeMode: t.resumeMode,
      reportPath: t.reportPath,
      save: t.save,
      avatarCount: t.avatarCount,
      stages: t.stages,
      logs: (t as { logs?: UiLogLine[] }).logs ?? [],
      isQzone: Boolean((t as { qzone?: boolean }).qzone),
      isContacts: Boolean((t as { contacts?: unknown }).contacts),
      isCollection: Boolean((t as { collection?: unknown }).collection),
      isGuild: Boolean((t as { guild?: unknown }).guild),
      isGenerated: Boolean((t as { generated?: unknown }).generated),
      generatedResources: t.generatedResources,
      // 沿用既有任务的商城表情内容标记，历史下载结果仍可读取。
      isMarketPack: (t as unknown as { conv?: string }).conv === 'marketpack',
      // conv === 'emojipack' 是导出表情包任务的 sentinel（task_manager 内设定）。
      isEmojiPack: (t as unknown as { conv?: string }).conv === 'emojipack',
    }));
  }, [tasks.data]);

  // 新任务到达时自动展开任务栏并选中新任务。
  const prevTaskIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(uiTasks.map((t) => t.id));
    const prevIds = prevTaskIdsRef.current;
    // 找出新增的任务 id（当前有但之前没有的）
    const newIds: string[] = [];
    for (const id of currentIds) {
      if (!prevIds.has(id)) newIds.push(id);
    }
    if (newIds.length > 0 && prevIds.size > 0) {
      setTaskPanelExpanded(true);
      setAutoSelectTaskId(newIds[newIds.length - 1]!);
    }
    prevTaskIdsRef.current = currentIds;
  }, [uiTasks]);

  // ---- task actions (existing backend) ----
  const refetchTasks = (): void => void tasks.refetch();

  const onPause = (t: UiTask): void =>
    void client.account.pauseExportTask.mutate({ taskId: t.id }).then(refetchTasks);
  const onCancel = (t: UiTask): void =>
    void client.account.cancelExportTask.mutate({ taskId: t.id }).then(refetchTasks);
  const onDelete = async (t: UiTask): Promise<void> => {
    if (t.status === 'completed' && t.save?.status !== 'saved') {
      const confirmed = await dialog.confirm(
        '删除尚未保存的结果',
        `「${t.name}」尚未保存到目标位置，删除会移除任务及其导出缓存。`,
        { okLabel: '删除', cancelLabel: '保留', tone: 'warning' },
      );
      if (!confirmed) return;
    }
    try {
      const deleted = await client.account.deleteExportTask.mutate({ taskId: t.id });
      if (!deleted) dialog.info('暂时无法删除', '任务仍在执行或保存，请等待当前步骤收尾。');
      refetchTasks();
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  };

  /** 把单个已完成任务保存到用户选择的位置（不再使用默认目录记忆，每次都弹路径）。 */
  async function saveTask(
    t: UiTask,
  ): Promise<{ status: 'saved'; path: string } | { status: 'cancelled' | 'failed' }> {
    try {
      const account = exportAccount.data;
      if (!account?.uin || !account.configId) throw new Error('账号资料尚未就绪，请稍后重试。');
      const binding = {
        expectedAccountUin: account.uin,
        expectedAccountConfigId: account.configId,
      };
      let selected: string | null | undefined;
      let directory: string | undefined;
      if (IS_WEB) {
        selected = await new Promise<string | null>((resolve) => {
          saveLocationPending.current?.(null);
          saveLocationPending.current = resolve;
          setSaveLocationTask(t);
        });
        if (selected === null || !mounted.current) return { status: 'cancelled' };
        const policy = await client.bootstrap.prepareExportSave.mutate({
          mode: 'before',
          directory: selected || undefined,
        });
        if (!policy?.directory || !mounted.current) return { status: 'cancelled' };
        directory = policy.directory;
      }
      const path = await client.account.saveExportTaskOutput.mutate({
        ...binding,
        taskId: t.id,
        ...(directory ? { directory } : {}),
      });
      if (path === null || !mounted.current) return { status: 'cancelled' };
      refetchTasks();
      return { status: 'saved', path };
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
      return { status: 'failed' };
    }
  }

  const onDownload = async (t: UiTask): Promise<void> => {
    const saved = await saveTask(t);
    if (saved.status === 'saved')
      pushToast({ tone: 'success', title: '导出结果已保存', detail: saved.path });
  };

  async function downloadInBrowser(t: UiTask): Promise<void> {
    try {
      const download = await client.account.exportTaskDownload.mutate({ taskId: t.id });
      if (!download || !mounted.current) return;
      const anchor = document.createElement('a');
      anchor.href = download.url;
      anchor.download = '';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      dialog.error('下载失败', error instanceof Error ? error.message : String(error));
    }
  }

  /** 一键把全部已完成任务逐个保存（每个都弹选择路径，不再记忆默认目录）。 */
  const onSaveAll = async (): Promise<void> => {
    const completed = uiTasks.filter((t) => t.status === 'completed');
    if (completed.length === 0) return;
    const failed: string[] = [];
    let okCount = 0;
    let cancelled = false;
    for (const t of completed) {
      const saved = await saveTask(t);
      if (saved.status === 'saved') okCount += 1;
      else if (saved.status === 'failed') failed.push(t.name);
      else {
        cancelled = true;
        break;
      }
    }
    refetchTasks();
    if (failed.length > 0) {
      dialog.error(
        '部分任务保存失败',
        `成功 ${okCount} 个，失败 ${failed.length} 个：${failed.slice(0, 8).join('、')}${failed.length > 8 ? '…' : ''}`,
      );
    } else if (cancelled) {
      dialog.info('已取消保存', `已保存 ${okCount} 个任务，其余已生成结果仍保留在任务列表中。`);
    } else {
      dialog.success('批量保存完成', `已保存 ${okCount} 个导出任务。`);
    }
  };

  // ---- primary action per mode ----
  function onPrimary(intent?: import('@weq/service').ExportSavePolicy): void {
    saveIntent.current = intent;
    if (editingList) {
      setEditingList(false);
      return;
    }
    if (mode === 'album') {
      if (!albumGroupId) return;
      openAlbumExport();
      return;
    }
    if (mode === 'groupfile') {
      if (!fileGroupId) return;
      const group = groupItems.find((it) => it.id === fileGroupId);
      if (group) setFileExport({ group });
      return;
    }
    if (mode === 'contacts') {
      if (
        contactScope === 'group' &&
        (!contactGroupIds.size || [...contactGroupIds].some((id) => memberUids[id]?.length === 0))
      )
        return;
      if (contactScope === 'friends' && friendUids?.length === 0) return;
      if (contactScope === 'groups' && groupListIds?.length === 0) return;
      setLightbox('contacts');
      return;
    }
    if (mode === 'collection') {
      void runCollectionExport();
      return;
    }
    if (mode === 'guild') {
      if (guildSelection.size === 0) return;
      setLightbox('guild');
      return;
    }
    if (convSelection.size === 0) return;
    if (
      mode === 'full' &&
      execution === 'scheduled' &&
      [...convSelection].some((id) => messageSelections[id] !== undefined)
    )
      return;
    setLightbox(
      mode === 'full' && execution === 'scheduled'
        ? 'scheduled'
        : mode === 'qzone'
          ? 'qzone'
          : 'full',
    );
  }

  /** QQ 空间导出：每个选中目标（好友 / 自己）起一个说说导出任务（json/txt/html 多选 + 配图）。 */
  async function runQzoneExport(options: ExportOptions, formats: ExportFormat[]): Promise<void> {
    const intent = saveIntent.current;
    const targets = friendItems
      .filter((it) => convSelection.has(it.id))
      .map((item) => ({
        ...item,
        tids: postSelections[item.id] === undefined ? undefined : [...postSelections[item.id]!],
      }));
    const account = exportAccount.data;
    if (
      targets.length === 0 ||
      !account ||
      exportAccount.isFetching ||
      targets.some((target) => target.tids?.length === 0)
    )
      return;
    const binding = { expectedAccountUin: account.uin, expectedAccountConfigId: account.configId };
    const ok = await preflightQqOnline(dialog);
    if (!ok) return;

    const range = targets.some((target) => target.tids !== undefined)
      ? { start: null, end: null }
      : { start: options.range.start, end: options.range.end };
    setSubmitting(true);
    try {
      const savePolicy = await prepareSave(intent);
      if (!savePolicy) return;
      for (const t of targets) {
        if (!isCurrent()) return;
        if (!t.uin) continue;
        const fmt0 = qzoneFormatOf(formats[0] ?? 'json');
        await client.account.startQzoneExport.mutate({
          ...binding,
          savePolicy,
          targetUin: t.uin,
          tids: t.tids,
          name: t.name,
          format: fmt0,
          formats: formats.map(qzoneFormatOf),
          // HTML 需要完整渲染：只要选了 HTML 就强制下载配图 + 拉取评论/点赞
          // （灯箱里也会锁定勾选）。
          downloadMedia: options.exportMedia || formats.includes('html'),
          includeInteraction: options.qzoneInteractions || formats.includes('html'),
          range: t.tids === undefined ? range : undefined,
        });
      }
      setConvSelection(new Set());
      setLightbox(null);
      refetchTasks();
    } catch (e) {
      dialog.error('启动空间导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** 导出联系人：好友列表（可按分组过滤）或某群成员列表；灯箱多选格式 + 可选头像。 */
  async function runContactsExport(options: ExportOptions, formats: ExportFormat[]): Promise<void> {
    const intent = saveIntent.current;
    const account = exportAccount.data;
    if (!account?.uin || !account.configId) {
      dialog.error('账号资料尚未就绪', '请稍后重试。');
      return;
    }
    const binding = { expectedAccountUin: account.uin, expectedAccountConfigId: account.configId };
    // 联系人格式收窄到 startContactsExport 接受的集合（灯箱 chips 已保证）。
    const cfmts = [...formats] as Array<'json' | 'jsonl' | 'csv' | 'xlsx' | 'txt' | 'vcard'>;
    const cats = [...catSelection];
    const groupIds = groupListIds === undefined ? undefined : [...groupListIds];
    const selectedFriends = friendUids === undefined ? undefined : [...friendUids];
    const selectedGroups = [...contactGroupIds].map((id) => ({
      id,
      name: groupItems.find((item) => item.id === id)?.name ?? id,
      uids: memberUids[id] === undefined ? undefined : [...memberUids[id]!],
    }));
    setSubmitting(true);
    try {
      const savePolicy = await prepareSave(intent);
      if (!savePolicy || !isCurrent()) return;
      // 多格式合并为同一个任务：所有格式写进同一 bundle，头像只带一份。
      if (contactScope === 'groups') {
        await client.account.startContactsExport.mutate({
          ...binding,
          savePolicy,
          scope: 'groups',
          name: groupIds ? `群聊名单_${groupIds.length}个群` : '全部群聊名单',
          groupIds,
          format: cfmts[0] === 'vcard' ? 'csv' : (cfmts[0] ?? 'csv'),
          formats: cfmts.map((f) => (f === 'vcard' ? 'csv' : f)),
        });
      } else if (contactScope === 'friends') {
        await client.account.startContactsExport.mutate({
          ...binding,
          savePolicy,
          scope: 'friends',
          name: selectedFriends
            ? `好友_精确${selectedFriends.length}人`
            : cats.length
              ? `好友_${cats.length}个分组`
              : '全部好友',
          format: cfmts[0] ?? 'csv',
          formats: cfmts,
          exportAvatar: options.exportAvatar,
          ...(selectedFriends
            ? { uids: selectedFriends }
            : cats.length
              ? { categoryIds: cats }
              : {}),
        });
      } else {
        for (const g of selectedGroups) {
          if (!isCurrent()) return;
          await client.account.startContactsExport.mutate({
            ...binding,
            savePolicy,
            scope: 'group',
            groupCode: g.id,
            name: `${g.name}_群成员`,
            format: cfmts[0] === 'vcard' ? 'csv' : (cfmts[0] ?? 'csv'),
            formats: cfmts.map((f) => (f === 'vcard' ? 'csv' : f)) as typeof cfmts,
            exportAvatar: options.exportAvatar,
            ...(g.uids ? { uids: g.uids } : {}),
          });
        }
      }
      setLightbox(null);
      refetchTasks();
    } catch (e) {
      dialog.error('启动联系人导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** 导出收藏：全部或按类型过滤，格式 json/csv/xlsx/txt（图片仅写 URL，不下载）。 */
  async function runCollectionExport(): Promise<void> {
    const intent = saveIntent.current;
    const cfmt = format as 'json' | 'csv' | 'xlsx' | 'txt';
    const kinds = [...collectionKinds];
    const cids = [...(collectionIds ?? filteredCollectionIds)];
    if (cids.length === 0) return;
    setSubmitting(true);
    try {
      const savePolicy = await prepareSave(intent);
      if (!savePolicy) return;
      await client.account.startCollectionExport.mutate({
        savePolicy,
        name: kinds.length ? `收藏_${kinds.length}类` : '全部收藏',
        format: cfmt,
        cids,
      });
      setCollectionKinds(new Set());
      refetchTasks();
    } catch (e) {
      dialog.error('启动收藏导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function runFullExport(
    options: ExportOptions,
    opts: { formats?: ExportFormat[] } = {},
  ): Promise<void> {
    const intent = saveIntent.current;
    const targets = convItems
      .filter((it) => convSelection.has(it.id))
      .map((item) => ({
        ...item,
        ...(messageSelections[item.id] !== undefined
          ? {
              messageIds: [...messageSelections[item.id]!],
              total: messageSelections[item.id]!.length,
            }
          : {}),
      }));
    const formats = opts.formats && opts.formats.length > 0 ? opts.formats : [format];
    if (!targets.length || targets.some((target) => target.messageIds?.length === 0)) return;
    const precise = targets.some((target) => target.messageIds !== undefined);
    const effectiveOptions: ExportOptions = precise
      ? {
          ...options,
          completeMessages: false,
          range: { preset: 'all', start: null, end: null },
        }
      : options;
    // 前置检查（补全消息 / 媒体补全确认 / 语音模型）与任务创建都走共用逻辑，
    // 聊天页顶栏的快捷导出灯箱用的是同一套。
    const ok = await preflightChatExport(dialog, effectiveOptions);
    if (!ok) return;
    if (
      !(await preflightExportEstimate(
        dialog,
        targets.map((t) => ({ ...t, kind: t.kind ?? 'c2c' })),
        {
          range: { start: effectiveOptions.range.start, end: effectiveOptions.range.end },
          formats,
          exportMedia: options.exportMedia,
        },
      ))
    )
      return;

    setSubmitting(true);
    try {
      const savePolicy = await prepareSave(intent);
      if (!savePolicy) return;
      await startChatExportTasks(targets, effectiveOptions, formats, format, { savePolicy });
      if (fixedMessages) onClose?.();
      else {
        setConvSelection(new Set());
        setLightbox(null);
      }
      refetchTasks();
    } catch (e) {
      dialog.error('启动导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 频道私聊导出：消息源走 guild_msg.db，与完整消息同款格式 /
   * 媒体 / 装扮 / 头像；唯一差异 = 不支持漫游消息拉取
   * （completeMessages 恒 false）。
   */
  async function runGuildDirectExport(
    options: ExportOptions,
    opts: { formats?: ExportFormat[] } = {},
  ): Promise<void> {
    const intent = saveIntent.current;
    const targets = guildItems
      .filter((it) => guildSelection.has(it.id))
      .map((item) => ({
        ...item,
        messageIds:
          guildMessageSelections[item.id] === undefined
            ? undefined
            : [...guildMessageSelections[item.id]!],
      }));
    if (!targets.length || targets.some((target) => target.messageIds?.length === 0)) return;
    // null bounds = open-ended; both null (全部时间) means no filtering.
    const range = { start: options.range.start, end: options.range.end };
    const formats = opts.formats && opts.formats.length > 0 ? opts.formats : [format];
    // 频道私聊没有漫游缓存可拉，补全消息恒关闭；其余检查与聊天消息同款。
    const media = buildChatExportMedia(options, {
      messageCompletion: false,
      // 筛图模型当下下好没有（实时状态，不进持久化预设）。
      ocrPrefilter: options.ocrImages ? (await ocrReadiness()).filterReady : false,
    });
    const ok = await preflightChatExport(dialog, options, { messageCompletion: false });
    if (!ok) return;

    setSubmitting(true);
    try {
      const savePolicy = await prepareSave(intent);
      if (!savePolicy) return;
      for (const t of targets) {
        // 多格式合并为同一个任务：所有格式写进同一 bundle，媒体/头像/装扮只带一份。
        if (!isCurrent()) return;
        const fmt0 = formats[0] ?? format;
        await client.account.guildDirectStartExport.mutate({
          savePolicy,
          nodeId: t.id,
          messageIds: t.messageIds,
          name: t.name,
          format: fmt0 as Exclude<ExportFormat, 'vcard'>,
          formats: formats as Exclude<ExportFormat, 'vcard'>[],
          exportAvatar: options.exportAvatar,
          ...(options.dress.bubble || options.dress.font || options.dress.widget
            ? { dress: options.dress }
            : {}),
          ...(options.chatlab ? { chatlab: true } : {}),
          media,
          range: t.messageIds === undefined ? range : undefined,
        });
      }
      setGuildSelection(new Set());
      setLightbox(null);
      refetchTasks();
    } catch (e) {
      dialog.error('启动频道私聊导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function openAlbumExport(): void {
    if (!albumGroupId) return;
    const group = groupItems.find((it) => it.id === albumGroupId);
    if (!group) return;
    setAlbumExport({ group });
  }

  async function runAlbumExport(result: AlbumExportResult): Promise<void> {
    if (!albumExport) return;
    setSubmitting(true);
    try {
      const exported = await client.account.exportGroupAlbums.mutate({
        groupCode: albumExport.group.id,
        outputDir: result.outputDir,
        albums: result.selectedAlbums.map((album) => ({ id: album.id, title: album.title })),
        concurrency: 4,
      });
      if (exported.failed.length === 0) {
        setAlbumGroupId(null);
        setAlbumExport(null);
        dialog.success('群相册导出完成', `已保存 ${exported.ok} 个文件到：${exported.outputDir}`);
      } else {
        dialog.error(
          '部分相册媒体导出失败',
          `成功 ${exported.ok} 个，失败 ${exported.failed.length} 个。${exported.failed[0]?.fileName ?? ''}${exported.failed[0]?.error ? `：${exported.failed[0].error}` : ''}`,
        );
      }
    } catch (e) {
      dialog.error('群相册导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function runGroupFileExport(result: GroupFileExportResult): Promise<void> {
    if (!fileExport) return;
    setSubmitting(true);
    try {
      const exported = await client.account.exportGroupFiles.mutate({
        groupCode: fileExport.group.id,
        outputDir: result.outputDir,
        files: result.selectedFiles.map((f) => ({
          fileId: f.fileId,
          fileName: f.fileName,
          busId: f.busId,
          path: f.path,
        })),
        concurrency: 4,
      });
      if (exported.failed.length === 0) {
        setFileGroupId(null);
        setFileExport(null);
        dialog.success('群文件导出完成', `已保存 ${exported.ok} 个文件到：${exported.outputDir}`);
      } else {
        dialog.error(
          '部分群文件导出失败',
          `成功 ${exported.ok} 个，失败 ${exported.failed.length} 个。${exported.failed[0]?.fileName ?? ''}${exported.failed[0]?.error ? `：${exported.failed[0].error}` : ''}`,
        );
      }
    } catch (e) {
      dialog.error('群文件导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onLightboxConfirm(result: LightboxResult): Promise<void> {
    // 单次配置只留在工具草稿，用户明确勾选时才更新全局默认。
    if (
      result.saveAsDefault &&
      (lightbox === 'full' ||
        lightbox === 'guild' ||
        lightbox === 'scheduled' ||
        lightbox === 'qzone' ||
        lightbox === 'contacts')
    ) {
      // 频道私聊与完整消息同款灯箱，配置共享。
      rememberPreset(lightbox === 'guild' ? 'full' : lightbox, result);
    }
    if (lightbox === 'full') {
      void runFullExport(result.options, { formats: result.formats });
      return;
    }
    if (lightbox === 'guild') {
      void runGuildDirectExport(result.options, { formats: result.formats });
      return;
    }
    if (lightbox === 'qzone') {
      void runQzoneExport(result.options, result.formats);
      return;
    }
    if (lightbox === 'contacts') {
      void runContactsExport(result.options, result.formats);
      return;
    }
    if (lightbox === 'scheduled') {
      await runCreateSchedule(result);
      return;
    }
    // album — config collected, backend pending.
    setLightbox(null);
    dialog.info('配置已记录', '群相册导出后端待接入，已记录本次导出配置。');
  }

  /** 保存某个导出模式的最近一次灯箱配置，供下次打开自动回填。 */
  function rememberPreset(
    variant: 'full' | 'scheduled' | 'qzone' | 'contacts',
    result: LightboxResult,
  ): void {
    void client.bootstrap.setExportPreset
      .mutate({
        variant,
        formats: result.formats,
        options: result.options,
        ...(variant === 'scheduled' && result.schedule ? { schedule: result.schedule } : {}),
      })
      .then((next) => setExportPresets(next))
      .catch(() => {
        // 缓存写入失败只影响下次自动回填，这里静默跳过。
      });
  }

  /** Persist a scheduled template. Mirrors the per-task `media/range` shape
   *  from `runFullExport` so a triggered run reproduces the same output. */
  async function runCreateSchedule(result: LightboxResult): Promise<void> {
    const intent = saveIntent.current;
    const targets = convItems.filter((it) => convSelection.has(it.id));
    if (targets.length === 0) {
      dialog.error('未选择会话', '请先选择至少一个会话再创建定时任务。');
      return;
    }
    if (!result.schedule) {
      dialog.error('缺少定时配置', '定时设置未填写完整。');
      return;
    }
    setSubmitting(true);
    try {
      const savePolicy = await prepareSave(intent);
      if (!savePolicy) return;
      await client.account.createSchedule.mutate({
        name: `定时 · ${targets[0]!.name}${targets.length > 1 ? ` 等 ${targets.length} 个` : ''}`,
        // 主格式 = 第一份；多选的全部格式存进 formats，触发时媒体只带一份。
        format: (result.formats[0] ?? format) as Exclude<ExportFormat, 'vcard'>,
        formats: result.formats as Exclude<ExportFormat, 'vcard'>[],
        conversations: targets.map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind ?? 'c2c',
          total: t.total ?? 0,
        })),
        chatlab: result.options.chatlab,
        schedule: result.schedule,
        options: {
          savePolicy,
          range: {
            preset: result.options.range.preset,
            start: result.options.range.start,
            end: result.options.range.end,
          },
          exportMedia: result.options.exportMedia,
          mediaKinds: result.options.mediaKinds,
          completeMessages: result.options.completeMessages,
          exportAvatar: result.options.exportAvatar,
          completeMedia: result.options.completeMedia,
          downloadVideo: result.options.downloadVideo,
          downloadFile: result.options.downloadFile,
          downloadPtt: result.options.downloadPtt,
          completeDress: result.options.completeDress,
          transcribeVoice: result.options.transcribeVoice,
          dress: result.options.dress,
          autoSave: result.options.autoSave,
        },
        enabled: true,
      });
      setLightbox(null);
      setConvSelection(new Set());
      void utils.account.listSchedules.invalidate();
    } catch (e) {
      dialog.error('创建定时任务失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** Action handlers for the scheduled-mode list. */
  async function onToggleSchedule(s: ScheduledTask): Promise<void> {
    try {
      await client.account.setScheduleEnabled.mutate({ id: s.id, enabled: !s.enabled });
      void utils.account.listSchedules.invalidate();
    } catch (e) {
      dialog.error('更新定时任务失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDeleteSchedule(s: ScheduledTask): Promise<void> {
    const ok = await dialog.confirm(
      '删除定时任务',
      `确认删除「${s.name}」？该调度将不再触发；历史已生成的导出任务不会被删除。`,
      { okLabel: '删除', cancelLabel: '返回', tone: 'warning' },
    );
    if (!ok) return;
    try {
      await client.account.deleteSchedule.mutate({ id: s.id });
      void utils.account.listSchedules.invalidate();
    } catch (e) {
      dialog.error('删除定时任务失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function onRunScheduleNow(s: ScheduledTask): Promise<void> {
    try {
      await client.account.runScheduleNow.mutate({ id: s.id });
      void utils.account.listExportTasks.invalidate();
      void utils.account.listSchedules.invalidate();
      dialog.success('已触发', '本次导出任务已加入队列，状态在下方任务列表查看。');
    } catch (e) {
      dialog.error('立即运行失败', e instanceof Error ? e.message : String(e));
    }
  }

  const activeMode = MODES.find((m) => m.id === mode)!;
  // 底部格式 chips 只保留给不走灯箱的导出收藏；
  // 完整消息 / QQ空间 / 定时的格式选择已移入灯箱多选。
  const showFormatChips = mode === 'collection';
  const formatOptions = COLLECTION_FORMATS;
  // QQ空间导出只列目标空间（自己 + 好友）；其余多选模式用全部会话。
  const pickerItems = mode === 'qzone' ? friendItems : convItems;
  const scopeConversation =
    mode === 'full' &&
    execution === 'now' &&
    scopeConversationId &&
    convSelection.has(scopeConversationId)
      ? convItems.find((item) => item.id === scopeConversationId)
      : mode === 'qzone' && spaceScopeUin && spaceSelection.has(spaceScopeUin)
        ? friendItems.find((item) => item.id === spaceScopeUin)
        : undefined;

  const primaryLabel =
    mode === 'full' && execution === 'scheduled'
      ? '新建定时任务'
      : mode === 'album'
        ? '导出相册'
        : mode === 'groupfile'
          ? '导出群文件'
          : mode === 'qzone'
            ? '导出空间'
            : mode === 'contacts'
              ? contactScope === 'groups'
                ? '导出群聊名单'
                : '导出联系人'
              : mode === 'collection'
                ? '导出收藏'
                : '导出';

  const primaryDisabled =
    mode === 'qzone'
      ? !exportAccount.data ||
        exportAccount.isFetching ||
        !spaceSelection.size ||
        [...spaceSelection].some((id) => postSelections[id]?.length === 0)
      : mode === 'album'
        ? !albumGroupId
        : mode === 'groupfile'
          ? !fileGroupId
          : mode === 'contacts'
            ? contactScope === 'group'
              ? !contactGroupIds.size ||
                [...contactGroupIds].some((id) => memberUids[id]?.length === 0)
              : contactScope === 'groups'
                ? groupListIds?.length === 0 || groups.isError || groups.isLoading
                : friendUids?.length === 0
            : mode === 'collection'
              ? collectionLoading || (collectionIds ?? filteredCollectionIds).length === 0
              : mode === 'guild'
                ? guildSelection.size === 0 ||
                  [...guildSelection].some((id) => guildMessageSelections[id]?.length === 0)
                : convSelection.size === 0 ||
                  (mode === 'full' &&
                    [...convSelection].some((id) =>
                      execution === 'scheduled'
                        ? messageSelections[id] !== undefined
                        : messageSelections[id]?.length === 0,
                    ));

  const preciseMemberGroups = [...contactGroupIds].filter((id) => memberUids[id] !== undefined);
  const memberScopeSummary = preciseMemberGroups.length
    ? `${preciseMemberGroups.length} 个群使用精确成员集合，共 ${preciseMemberGroups.reduce((total, id) => total + memberUids[id]!.length, 0)} 位已选成员；其余 ${contactGroupIds.size - preciseMemberGroups.length} 个群导出整群成员。`
    : undefined;

  // Lightbox summary line.
  const lightboxSummary = (() => {
    if (lightbox === 'album') {
      const g = groupItems.find((it) => it.id === albumGroupId);
      return g ? `群相册 · ${g.name}` : '群相册';
    }
    if (lightbox === 'contacts') {
      if (contactScope === 'groups')
        return groupListIds ? `已选 ${groupListIds.length} 个群聊` : '全部本地群聊名单';
      if (contactScope === 'group') {
        return `${contactGroupIds.size} 个群`;
      }
      if (friendUids !== undefined) return `精确选中 ${friendUids.length} 位好友`;
      const n = catSelection.size;
      return n ? `${n} 个分组` : '全部好友';
    }
    const n = lightbox === 'guild' ? guildSelection.size : convSelection.size;
    return lightbox === 'qzone' ? `${n} 个空间` : `${n} 个会话`;
  })();

  const lightboxHeadline =
    lightbox === 'scheduled'
      ? '新建定时导出任务'
      : lightbox === 'album'
        ? '导出群相册'
        : lightbox === 'qzone'
          ? '导出 QQ 空间'
          : lightbox === 'guild'
            ? '导出频道私聊消息'
            : lightbox === 'contacts'
              ? contactScope === 'friends'
                ? '导出好友列表'
                : contactScope === 'groups'
                  ? '导出群聊名单'
                  : '导出群成员列表'
              : '导出聊天记录';

  return (
    <div className={`weq-exp weq-export-tool is-${surface}`}>
      {serverLocation && (
        <ServerSavePrompt name={serverLocation.name} onChoose={chooseServerLocation} />
      )}
      {saveLocationTask ? (
        <SaveResultLocation
          key={saveLocationTask.id}
          name={saveLocationTask.name}
          onChoose={(directory) => {
            saveLocationPending.current?.(directory);
            saveLocationPending.current = null;
            setSaveLocationTask(null);
          }}
          onCancel={() => {
            saveLocationPending.current?.(null);
            saveLocationPending.current = null;
            setSaveLocationTask(null);
          }}
        />
      ) : null}
      {surface === 'export' && ((!lightbox && !fixedMessages) || editingList) ? (
        <div className="weq-exp-top">
          {/* 右侧选择面板 */}
          <section className="weq-exp-pane">
            <header className="weq-exp-pane-head">
              <div className="weq-exp-pane-title">
                {lockMode ? (
                  <>
                    <strong>{activeMode.label}</strong>
                    <span>{activeMode.desc}</span>
                  </>
                ) : (
                  <>
                    <label htmlFor="weq-export-content-kind">内容种类</label>
                    <select
                      id="weq-export-content-kind"
                      value={mode}
                      disabled={submitting || editingList}
                      onChange={(event) => {
                        const selected = MODES.find((item) => item.id === event.target.value);
                        if (selected) setMode(selected.id);
                      }}
                    >
                      {MODES.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <span>{activeMode.desc}</span>
                  </>
                )}
              </div>
            </header>

            {mode === 'full' && !editingList ? (
              <div className="weq-export-execution">
                <Segmented<'now' | 'scheduled'>
                  value={execution}
                  onChange={setExecution}
                  options={[
                    { value: 'now', label: '立即导出', icon: <Play size={13} /> },
                    { value: 'scheduled', label: '定时执行', icon: <CalendarClock size={13} /> },
                  ]}
                />
                {execution === 'scheduled' &&
                [...convSelection].some((id) => messageSelections[id] !== undefined) ? (
                  <span role="status">精确消息集合不能转换为定时范围，请使用立即导出。</span>
                ) : null}
              </div>
            ) : null}

            <div className="weq-exp-pane-body">
              {mode === 'generated' ? (
                <GeneratedExportPane
                  initialSelection={initialSelection}
                  prepareSave={prepareSave}
                  isCurrent={isCurrent}
                  onStarted={refetchTasks}
                  disabled={pickingSaveDirectory || globalSettings.isLoading}
                />
              ) : mode === 'database' ? (
                accountUin ? (
                  <DatabasePlainExport key={accountUin} accountUin={accountUin} />
                ) : (
                  <div role="status">请先进入账号</div>
                )
              ) : mode === 'emojipack' ? (
                <EmojiPackExportPane
                  onStarted={refetchTasks}
                  prepareSave={prepareSave}
                  disabled={pickingSaveDirectory || globalSettings.isLoading}
                />
              ) : mode === 'full' || mode === 'qzone' ? (
                <div
                  className={`weq-export-message-layout${scopeConversation ? ' has-scope' : ''}`}
                >
                  <ConversationPicker
                    items={pickerItems}
                    loading={conversations.isLoading}
                    selected={convSelection}
                    onChange={setConvSelection}
                    scopeSelections={mode === 'full' ? messageSelections : postSelections}
                    scopeLabel={mode === 'qzone' ? '说说范围' : '消息范围'}
                    scopeUnit={mode === 'qzone' ? '条说说' : '条消息'}
                    onEditScope={
                      (mode === 'full' && execution === 'now') || mode === 'qzone'
                        ? (item) => {
                            setConvSelection(new Set([...convSelection, item.id]));
                            if (mode === 'qzone') setSpaceScopeUin(item.id);
                            else setScopeConversationId(item.id);
                          }
                        : undefined
                    }
                    emptyText={mode === 'qzone' ? '暂无空间目标' : undefined}
                  />
                  {scopeConversation ? (
                    <section
                      className="weq-export-scope-panel"
                      aria-label={mode === 'qzone' ? '当前空间说说范围' : '当前会话消息范围'}
                    >
                      <header>
                        <strong title={scopeConversation.name}>
                          {scopeConversation.name} · {mode === 'qzone' ? '说说范围' : '消息范围'}
                        </strong>
                        <button
                          type="button"
                          aria-label={mode === 'qzone' ? '关闭说说范围' : '关闭消息范围'}
                          title={mode === 'qzone' ? '关闭说说范围' : '关闭消息范围'}
                          onClick={() =>
                            mode === 'qzone' ? setSpaceScopeUin(null) : setScopeConversationId(null)
                          }
                        >
                          <X size={15} />
                        </button>
                      </header>
                      {mode === 'qzone' ? (
                        <QzoneScopePicker
                          key={scopeConversation.id}
                          selfUin={exportAccount.data?.uin ?? ''}
                          hostUin={scopeConversation.id}
                          selected={postSelections[scopeConversation.id]}
                          onChange={(ids) =>
                            setPostSelections((current) => {
                              const next = { ...current };
                              if (ids === undefined) delete next[scopeConversation.id];
                              else next[scopeConversation.id] = [...ids];
                              return next;
                            })
                          }
                        />
                      ) : (
                        <MessageScopePicker
                          key={`chat:${scopeConversation.kind ?? 'c2c'}:${scopeConversation.id}`}
                          kind={scopeConversation.kind ?? 'c2c'}
                          conv={scopeConversation.id}
                          selected={messageSelections[scopeConversation.id]}
                          onChange={(ids) =>
                            setMessageSelections((current) => {
                              const next = { ...current };
                              if (ids === undefined) delete next[scopeConversation.id];
                              else next[scopeConversation.id] = [...ids];
                              return next;
                            })
                          }
                        />
                      )}
                    </section>
                  ) : null}
                </div>
              ) : mode === 'guild' ? (
                <div
                  className={`weq-export-message-layout${guildScopeId && guildSelection.has(guildScopeId) ? ' has-scope' : ''}`}
                >
                  <ConversationPicker
                    items={guildItems}
                    loading={guildSessions.isLoading}
                    selected={guildSelection}
                    onChange={setGuildSelection}
                    scopeSelections={guildMessageSelections}
                    onEditScope={(item) => {
                      setGuildSelection(new Set([...guildSelection, item.id]));
                      setGuildScopeId(item.id);
                    }}
                    emptyText="暂无频道私聊会话（需本机有 QQ 频道私聊记录）"
                  />
                  {guildScopeId && guildSelection.has(guildScopeId) ? (
                    <section className="weq-export-scope-panel" aria-label="频道私聊消息范围">
                      <header>
                        <strong>
                          {guildItems.find((item) => item.id === guildScopeId)?.name ??
                            guildScopeId}{' '}
                          · 消息范围
                        </strong>
                        <button
                          type="button"
                          title="关闭消息范围"
                          aria-label="关闭消息范围"
                          onClick={() => setGuildScopeId(null)}
                        >
                          <X size={15} />
                        </button>
                      </header>
                      <MessageScopePicker
                        key={`guild:${guildScopeId}`}
                        kind="guild"
                        conv={guildScopeId}
                        selected={guildMessageSelections[guildScopeId]}
                        onChange={(ids) =>
                          setGuildMessageSelections((current) => {
                            const next = { ...current };
                            if (ids === undefined) delete next[guildScopeId];
                            else next[guildScopeId] = [...ids];
                            return next;
                          })
                        }
                      />
                    </section>
                  ) : null}
                </div>
              ) : mode === 'contacts' ? (
                <div className="weq-exp-contacts">
                  <div className="weq-exp-contacts-switch">
                    <Segmented<'friends' | 'group' | 'groups'>
                      value={contactScope}
                      onChange={setContactScope}
                      options={[
                        { value: 'friends', label: '联系人名单', icon: <UserRound size={13} /> },
                        { value: 'groups', label: '群聊名单', icon: <Users size={13} /> },
                        { value: 'group', label: '群成员名单', icon: <Users size={13} /> },
                      ]}
                    />
                  </div>
                  {contactScope !== 'friends' && groups.isError ? (
                    <div className="weq-search-failure" role="status">
                      <span>群目录读取失败</span>
                      <button
                        type="button"
                        title="重试读取群目录"
                        aria-label="重试读取群目录"
                        onClick={() => void groups.refetch()}
                      >
                        <RotateCw size={14} />
                      </button>
                    </div>
                  ) : null}
                  {contactScope === 'friends' ? (
                    <>
                      <details className="weq-export-contact-categories">
                        <summary>
                          好友分组 ·{' '}
                          {catSelection.size ? `已选 ${catSelection.size} 个分组` : '全部好友'}
                        </summary>
                        <CategoryChips
                          items={catItems}
                          total={friendTotal}
                          loading={categories.isLoading}
                          selected={catSelection}
                          onChange={setCatSelection}
                        />
                      </details>
                      <ContactScopePicker
                        items={friendPreview}
                        loading={friendDirectory.isLoading}
                        error={friendDirectory.isError}
                        onRetry={() => void friendDirectory.refetch()}
                        selected={friendUids}
                        onChange={setFriendUids}
                        conditionLabel={
                          catSelection.size ? `所选 ${catSelection.size} 个好友分组` : '全部好友'
                        }
                      />
                    </>
                  ) : contactScope === 'groups' ? (
                    <ConversationPicker
                      items={groupItems}
                      loading={groups.isLoading}
                      selected={new Set(groupListIds ?? groupItems.map((item) => item.id))}
                      onChange={(ids) => setGroupListIds([...ids])}
                      emptyText="暂无群聊"
                    />
                  ) : (
                    <div
                      className={`weq-export-message-layout${memberScopeGroup ? ' has-scope' : ''}`}
                    >
                      <ConversationPicker
                        items={groupItems}
                        loading={groups.isLoading}
                        selected={contactGroupIds}
                        onChange={setContactGroupIds}
                        scopeSelections={memberUids}
                        scopeLabel="群成员范围"
                        scopeUnit="位成员"
                        onEditScope={(item) => {
                          setContactGroupIds(new Set([...contactGroupIds, item.id]));
                          setMemberScopeGroupId(item.id);
                        }}
                        emptyText="暂无群聊"
                      />
                      {memberScopeGroup ? (
                        <section
                          className="weq-export-scope-panel weq-export-contact-panel"
                          aria-label="当前群成员范围"
                        >
                          <header>
                            <strong title={`${memberScopeGroup.name} · 群成员范围`}>
                              {memberScopeGroup.name} · 群成员范围
                            </strong>
                            <button
                              type="button"
                              title="关闭群成员范围"
                              aria-label="关闭群成员范围"
                              onClick={() => setMemberScopeGroupId(null)}
                            >
                              <X size={15} />
                            </button>
                          </header>
                          <ContactScopePicker
                            key={memberScopeGroup.id}
                            items={memberDirectory.data ?? []}
                            loading={memberDirectory.isLoading}
                            error={memberDirectory.isError}
                            onRetry={() => void memberDirectory.refetch()}
                            selected={memberUids[memberScopeGroup.id]}
                            onChange={(ids) =>
                              setMemberUids((previous) => {
                                const next = { ...previous };
                                if (ids === undefined) delete next[memberScopeGroup.id];
                                else next[memberScopeGroup.id] = [...ids];
                                return next;
                              })
                            }
                            conditionLabel="整群成员"
                          />
                        </section>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : mode === 'collection' ? (
                <>
                  {collectionSource.error ? (
                    <div role="status" className="weq-search-failure">
                      <span>收藏加载失败</span>
                      <button
                        type="button"
                        aria-label="重试加载收藏"
                        title="重试加载收藏"
                        onClick={collectionSource.retry}
                      >
                        <RotateCw size={14} />
                      </button>
                    </div>
                  ) : null}
                  <CollectionScope
                    items={collectionItems ?? []}
                    counts={collectionCounts}
                    loading={collectionLoading}
                    selected={collectionKinds}
                    onChange={setCollectionKinds}
                    selectedIds={collectionIds}
                    onSelectedIdsChange={setCollectionIds}
                    onFilteredIdsChange={setFilteredCollectionIds}
                  />
                </>
              ) : mode === 'album' ? (
                <SingleSelectPicker
                  items={groupItems}
                  loading={groups.isLoading}
                  selectedId={albumGroupId}
                  onSelect={setAlbumGroupId}
                  searchPlaceholder="搜索群名称或群号"
                  emptyText="暂无群聊"
                />
              ) : mode === 'groupfile' ? (
                <SingleSelectPicker
                  items={groupItems}
                  loading={groups.isLoading}
                  selectedId={fileGroupId}
                  onSelect={setFileGroupId}
                  searchPlaceholder="搜索群名称或群号"
                  emptyText="暂无群聊"
                />
              ) : null}
            </div>

            {/* 商城表情下载 / 导出表情包自带底部操作条，隐藏导出中心的通用 footer。 */}
            {mode !== 'emojipack' && mode !== 'database' && mode !== 'generated' ? (
              <footer className="weq-exp-pane-foot">
                {mode === 'full' && execution === 'scheduled' ? (
                  <span className="weq-exp-foot-hint">
                    {convSelection.size > 0
                      ? `已选 ${convSelection.size} 个会话`
                      : '请先选择至少一个会话'}
                  </span>
                ) : showFormatChips ? (
                  <div className="weq-exp-foot-format">
                    <span className="weq-exp-foot-label">格式</span>
                    <Segmented<ExportFormat>
                      value={format}
                      onChange={setFormat}
                      options={formatOptions}
                      small
                    />
                  </div>
                ) : mode === 'full' || mode === 'qzone' || mode === 'guild' ? (
                  <span className="weq-exp-foot-hint">
                    {mode === 'qzone'
                      ? convSelection.size > 0
                        ? `已选 ${convSelection.size} 个空间 · 灯箱内选择格式与媒体`
                        : '请先选择要导出的空间'
                      : mode === 'guild'
                        ? guildSelection.size > 0
                          ? `已选 ${guildSelection.size} 个会话 · 频道私聊仅本地消息，不支持漫游拉取`
                          : '请先选择至少一个频道私聊会话'
                        : convSelection.size > 0
                          ? `已选 ${convSelection.size} 个会话 · 灯箱内选择格式与内容`
                          : '请先选择至少一个会话'}
                  </span>
                ) : mode === 'contacts' ? (
                  <span className="weq-exp-foot-hint">
                    {contactScope === 'friends'
                      ? friendUids !== undefined
                        ? `精确选中 ${friendUids.length} 位好友`
                        : catSelection.size > 0
                          ? `已选 ${catSelection.size} 个分组 · 灯箱内选择格式与头像`
                          : '全部好友 · 灯箱内选择格式与头像'
                      : contactScope === 'groups'
                        ? groupListIds
                          ? `已选 ${groupListIds.length} 个群聊`
                          : '全部本地群聊名单'
                        : contactGroupIds.size
                          ? `已选 ${contactGroupIds.size} 个群`
                          : '请先选择群'}
                  </span>
                ) : (
                  <span className="weq-exp-foot-hint">
                    {mode === 'album'
                      ? '选择一个群，下一步选择相册与时间范围'
                      : mode === 'groupfile'
                        ? '选择一个群，下一步选择要下载的文件'
                        : ''}
                  </span>
                )}
                <div className="weq-save-action-group">
                  <button
                    type="button"
                    className="weq-exp-primary"
                    disabled={
                      primaryDisabled ||
                      submitting ||
                      globalSettings.isLoading ||
                      pickingSaveDirectory
                    }
                    onClick={() => onPrimary()}
                  >
                    {primaryLabel}
                  </button>
                  {mode !== 'album' && mode !== 'groupfile' && (
                    <ExportSaveActions
                      disabled={
                        primaryDisabled ||
                        submitting ||
                        globalSettings.isLoading ||
                        pickingSaveDirectory
                      }
                      onSelect={(intent) => onPrimary(intent)}
                    />
                  )}
                </div>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}

      {/* 底部任务列表（可折叠覆盖层） */}
      {surface === 'tasks' && !saveLocationTask ? (
        <>
          <Segmented<'tasks' | 'schedules' | 'roaming' | 'clones'>
            value={taskTab}
            onChange={setTaskTab}
            options={[
              { value: 'tasks', label: '执行任务' },
              { value: 'roaming', label: '漫游拉取' },
              { value: 'clones', label: '好友克隆' },
              { value: 'schedules', label: '定时计划' },
            ]}
          />
          {taskTab === 'clones' ? (
            <CloneTasksPane onOpenPersona={onOpenClone} />
          ) : taskTab === 'roaming' ? (
            <RoamingBackfillPanel surface="tasks" />
          ) : taskTab === 'schedules' ? (
            <div className="weq-exp-sched-list">
              {schedules.isLoading ? (
                <ScheduleListSkeleton />
              ) : schedules.isError ? (
                <div role="status">
                  定时计划加载失败
                  <button
                    type="button"
                    title="重试加载计划"
                    aria-label="重试加载计划"
                    onClick={() => void schedules.refetch()}
                  >
                    <RotateCw size={14} />
                  </button>
                </div>
              ) : (schedules.data ?? []).length === 0 ? (
                <div className="weq-exp-sched-empty">
                  <strong>暂无定时计划</strong>
                </div>
              ) : (
                (schedules.data as ScheduledTask[]).map((s) => (
                  <ScheduleRow
                    key={s.id}
                    schedule={s}
                    onToggle={() => void onToggleSchedule(s)}
                    onDelete={() => void onDeleteSchedule(s)}
                    onRunNow={() => void onRunScheduleNow(s)}
                  />
                ))
              )}
            </div>
          ) : (
            <TaskList
              tasks={uiTasks}
              onPause={onPause}
              onResume={(t) => {
                void client.account.resumeExportTask
                  .mutate({ taskId: t.id })
                  .then((ok) => {
                    if (!ok)
                      dialog.error(
                        t.resumeMode === 'restart' ? '无法重新执行' : '无法继续',
                        t.resumeMode === 'restart'
                          ? '任务仍在收尾，请稍后重试。'
                          : '任务仍在收尾，或没有可验证的断点。',
                      );
                    refetchTasks();
                  })
                  .catch((e) => dialog.error('续作失败', String(e)));
              }}
              onReport={(t) => {
                void client.account.revealExportReport
                  .mutate({ taskId: t.id })
                  .catch((e) => dialog.error('打开报告失败', String(e)));
              }}
              onCancel={onCancel}
              onDownload={(t) => void onDownload(t)}
              onOpenSaved={
                !IS_WEB
                  ? (t, reveal) => {
                      const account = exportAccount.data;
                      if (!account?.uin || !account.configId) return;
                      void client.account.openSavedExportOutput
                        .mutate({
                          taskId: t.id,
                          reveal,
                          expectedAccountUin: account.uin,
                          expectedAccountConfigId: account.configId,
                        })
                        .catch((error) =>
                          dialog.error(
                            '打开保存结果失败',
                            error instanceof Error ? error.message : String(error),
                          ),
                        );
                    }
                  : undefined
              }
              onBrowserDownload={IS_WEB ? (t) => void downloadInBrowser(t) : undefined}
              onDelete={onDelete}
              onSaveAll={() => void onSaveAll()}
              onShowFailures={(t, failures) => setFailureView({ name: t.name, failures })}
              autoSelectId={autoSelectTaskId}
              isExpanded={taskPanelExpanded}
              onToggleExpanded={() => setTaskPanelExpanded((v) => !v)}
            />
          )}
        </>
      ) : null}

      {failureView ? (
        <FailureLightbox
          taskName={failureView.name}
          failures={failureView.failures}
          onClose={() => setFailureView(null)}
        />
      ) : null}

      {lightbox ? (
        <ExportLightbox
          embedded
          hidden={editingList}
          onEditList={
            fixedMessages && initialSelection?.owner.kind === 'conversations'
              ? () => setEditingList(true)
              : undefined
          }
          scopeSummary={
            lightbox === 'qzone' &&
            [...spaceSelection].some((id) => postSelections[id] !== undefined)
              ? [...spaceSelection]
                  .map(
                    (id) =>
                      `${friendItems.find((item) => item.id === id)?.name ?? id}：${postSelections[id] === undefined ? '空间全部说说' : `精确选中 ${postSelections[id]!.length} 条说说`}`,
                  )
                  .join('；')
              : lightbox === 'guild' &&
                  [...guildSelection].some((id) => guildMessageSelections[id] !== undefined)
                ? [...guildSelection]
                    .map(
                      (id) =>
                        `${guildItems.find((item) => item.id === id)?.name ?? id}：${guildMessageSelections[id] === undefined ? '会话全部消息' : `精确选中 ${guildMessageSelections[id]!.length} 条消息`}`,
                    )
                    .join('；')
                : lightbox === 'contacts' && contactScope === 'group'
                  ? memberScopeSummary
                  : lightbox === 'full' &&
                      [...convSelection].some((id) => messageSelections[id] !== undefined)
                    ? [...convSelection]
                        .map(
                          (id) =>
                            `${convItems.find((item) => item.id === id)?.name ?? id}：${messageSelections[id] === undefined ? '会话全部消息' : `精确选中 ${messageSelections[id]!.length} 条消息`}`,
                        )
                        .join('；')
                    : undefined
          }
          variant={lightbox}
          headline={lightboxHeadline}
          summary={lightboxSummary}
          contactScope={contactScope}
          calendarTargets={
            ['full', 'chatlab', 'scheduled'].includes(lightbox)
              ? convItems
                  .filter((item) => convSelection.has(item.id))
                  .map((item) => ({
                    kind: item.kind === 'group' ? 'group' : 'c2c',
                    conv: item.id,
                  }))
              : undefined
          }
          // 优先回填最近一次导出的配置；联系人导出默认不下载头像（大群头像量大）。
          initialOptions={
            lightbox !== 'album'
              ? (exportPresets?.[lightbox === 'guild' ? 'full' : lightbox]?.options ??
                (lightbox === 'contacts'
                  ? { ...DEFAULT_OPTIONS, exportAvatar: false }
                  : DEFAULT_OPTIONS))
              : undefined
          }
          initialFormats={
            lightbox !== 'album'
              ? exportPresets?.[lightbox === 'guild' ? 'full' : lightbox]?.formats
              : undefined
          }
          initialSchedule={exportPresets?.scheduled?.schedule}
          submitting={submitting}
          disabled={
            fixedMessages &&
            (!convItems.some((item) => convSelection.has(item.id)) ||
              Object.values(messageSelections).some((ids) => ids?.length === 0))
          }
          onPickPath={async () => {
            dialog.info('选择目录', '目录选择接口待接入，开始导出时将使用系统对话框。');
            return null;
          }}
          onClose={() => (fixedMessages ? onClose?.() : setLightbox(null))}
          onConfirm={onLightboxConfirm}
        />
      ) : null}

      {albumExport ? (
        <AlbumExportLightbox
          groupCode={albumExport.group.id}
          groupName={albumExport.group.name}
          outputDir={albumOutputDir}
          submitting={submitting}
          onPickPath={async () => {
            const picked = await client.account.pickGroupAlbumExportDir.mutate();
            if (picked) setAlbumOutputDir(picked);
            return picked;
          }}
          onClose={() => setAlbumExport(null)}
          onConfirm={(result) => void runAlbumExport(result)}
        />
      ) : null}

      {fileExport ? (
        <GroupFileExportLightbox
          groupCode={fileExport.group.id}
          groupName={fileExport.group.name}
          outputDir={fileOutputDir}
          submitting={submitting}
          onPickPath={async () => {
            const picked = await client.account.pickGroupFileExportDir.mutate();
            if (picked) setFileOutputDir(picked);
            return picked;
          }}
          onClose={() => setFileExport(null)}
          onConfirm={(result) => void runGroupFileExport(result)}
        />
      ) : null}
    </div>
  );
}

/** 好友分组多选 chips（导出联系人 · 好友）。空选 = 全部好友。 */
function CategoryChips({
  items,
  total,
  loading,
  selected,
  onChange,
}: {
  items: Array<{ id: number; name: string; count: number }>;
  total: number;
  loading: boolean;
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}): ReactElement {
  const allActive = selected.size === 0;
  const multi = useMultiSelection({ ids: items.map((item) => item.id), selected, onChange });
  return (
    <div className="weq-exp-cats" {...multi.rootProps}>
      <div className="weq-exp-cats-head">
        <strong>好友分组</strong>
        <small>{allActive ? `全部好友 · ${total} 人` : `已选 ${selected.size} 个分组`}</small>
      </div>
      {loading ? (
        <ChipsSkeleton />
      ) : items.length === 0 ? (
        <div className="weq-exp-cats-empty">
          <small>暂无分组数据</small>
          {selected.size ? (
            <button
              type="button"
              className="weq-exp-tool"
              title="清空分组筛选"
              aria-label="清空分组筛选"
              onClick={() => onChange(new Set())}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      ) : (
        <div className="weq-exp-cats-list">
          <button
            type="button"
            className={`weq-exp-chip${allActive ? ' is-active' : ''}`}
            onClick={() => onChange(new Set())}
          >
            全部好友 <b>{total}</b>
          </button>
          {items.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`weq-exp-chip${selected.has(c.id) ? ' is-active' : ''}`}
              {...multi.itemProps(c.id)}
            >
              {c.name} <b>{c.count}</b>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 收藏类型多选（导出收藏）。空选 = 全部收藏。顺序与「我的收藏」弹窗一致。 */
const COLLECTION_KIND_FILTERS: Array<{ id: string; label: string }> = [
  { id: 'richMedia', label: '图文' },
  { id: 'link', label: '链接' },
  { id: 'gallery', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'audio', label: '语音' },
  { id: 'file', label: '文件' },
  { id: 'location', label: '位置' },
  { id: 'text', label: '文本' },
  { id: 'unknown', label: '其他' },
];

const COLLECTION_KIND_LABEL: Record<string, string> = Object.fromEntries(
  COLLECTION_KIND_FILTERS.map((k) => [k.id, k.label]),
);

/** 收藏 kind → 行图标（对齐「我的收藏」弹窗的 kindIcon）。 */
function collectionKindIcon(kind: string, size = 15): ReactElement {
  switch (kind) {
    case 'link':
      return <Link2 size={size} strokeWidth={1.8} />;
    case 'gallery':
      return <ImageIcon size={size} strokeWidth={1.8} />;
    case 'video':
      return <Film size={size} strokeWidth={1.8} />;
    case 'audio':
      return <Music size={size} strokeWidth={1.8} />;
    case 'file':
      return <FileText size={size} strokeWidth={1.8} />;
    case 'location':
      return <MapPin size={size} strokeWidth={1.8} />;
    case 'richMedia':
      return <Layers size={size} strokeWidth={1.8} />;
    default:
      return <Bookmark size={size} strokeWidth={1.8} />;
  }
}

/** 收藏时间 → `YYYY/MM/DD`（预览行尾注）。 */
function fmtCollectDay(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 收藏类型 chips + 预览列表（导出收藏）。跟随类型 chips：未选类型显示全部收藏，
 * 选了类型则只显示这些类型下的条目 —— 和「导出联系人」的分组 chips + 好友预览
 * 同构，只读，让用户选完类型「心里有数」。可搜索标题 / 摘要 / 来源。
 */
function CollectionScope({
  items,
  counts,
  loading,
  selected,
  onChange,
  selectedIds,
  onSelectedIdsChange,
  onFilteredIdsChange,
}: {
  items: CollectionPreviewItem[];
  counts: Record<string, number>;
  loading: boolean;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  selectedIds?: string[];
  onSelectedIdsChange: (ids: string[] | undefined) => void;
  onFilteredIdsChange: (ids: string[]) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const total = counts.all ?? 0;
  const allActive = selected.size === 0;
  // 只展示实际有内容的类型 chips。
  const kinds = COLLECTION_KIND_FILTERS.filter((k) => (counts[k.id] ?? 0) > 0);
  const typesMulti = useMultiSelection({ ids: kinds.map((item) => item.id), selected, onChange });

  // 预览行 = 类型过滤 × 搜索（标题 / 摘要 / 来源）。
  const scoped = useMemo(
    () => (allActive ? items : items.filter((it) => selected.has(it.kind))),
    [items, allActive, selected],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((it) => `${it.title} ${it.sub} ${it.source}`.toLowerCase().includes(q));
  }, [scoped, query]);
  const itemsMulti = useMultiSelection({
    ids: filtered.map((item) => item.cid),
    selected: new Set(selectedIds ?? filtered.map((item) => item.cid)),
    onChange: (next) => onSelectedIdsChange([...next]),
  });
  useEffect(() => {
    onFilteredIdsChange(filtered.map((item) => item.cid));
  }, [filtered, onFilteredIdsChange]);

  return (
    <div className="weq-exp-contacts">
      <div className="weq-exp-cats" {...typesMulti.rootProps}>
        <div className="weq-exp-cats-head">
          <strong>收藏类型</strong>
          <small>
            {loading
              ? '加载中…'
              : allActive
                ? `全部收藏 · ${fmtCount(total)} 条`
                : `已选 ${selected.size} 类 · ${fmtCount(scoped.length)} 条`}
          </small>
        </div>
        {loading ? (
          <ChipsSkeleton />
        ) : total === 0 ? (
          <div className="weq-exp-cats-empty">
            <small>还没有任何收藏</small>
          </div>
        ) : (
          <div className="weq-exp-cats-list">
            <button
              type="button"
              className={`weq-exp-chip${allActive ? ' is-active' : ''}`}
              onClick={() => onChange(new Set())}
            >
              全部收藏 <b>{total}</b>
            </button>
            {kinds.map((k) => (
              <button
                key={k.id}
                type="button"
                className={`weq-exp-chip${selected.has(k.id) ? ' is-active' : ''}`}
                {...typesMulti.itemProps(k.id)}
              >
                {k.label} <b>{counts[k.id] ?? 0}</b>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="weq-exp-friends" {...itemsMulti.rootProps}>
        <div className="weq-exp-friends-head">
          <strong>{allActive ? '全部收藏' : '所选类型'}</strong>
          <small>{loading ? '加载中…' : `${fmtCount(filtered.length)} 条`}</small>
        </div>
        <label className="weq-message-scope-mode">
          <input
            type="checkbox"
            checked={selectedIds !== undefined}
            onChange={(event) => onSelectedIdsChange(event.target.checked ? [] : undefined)}
          />
          <span>
            {selectedIds === undefined
              ? '导出全部筛选结果'
              : `精确选中 ${selectedIds.length} 条收藏`}
          </span>
        </label>
        <div className="weq-exp-search">
          <Search size={15} aria-hidden />
          <input
            placeholder="搜索标题 / 内容 / 来源"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button type="button" title="清空" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          ) : null}
        </div>
        <div className="weq-exp-list">
          {loading ? (
            <PickerListSkeleton rows={6} />
          ) : filtered.length === 0 ? (
            <div className="weq-exp-list-state">
              <span>
                {query ? '没有匹配的收藏' : allActive ? '还没有任何收藏' : '所选类型下暂无收藏'}
              </span>
            </div>
          ) : (
            filtered.map((it) => (
              <div key={it.cid} className="weq-exp-row is-static" {...itemsMulti.itemProps(it.cid)}>
                <input
                  type="checkbox"
                  aria-label={`选择收藏 ${it.title}`}
                  checked={selectedIds === undefined || selectedIds.includes(it.cid)}
                  readOnly
                />
                <span className="weq-exp-col-icon" data-kind={it.kind}>
                  {collectionKindIcon(it.kind)}
                </span>
                <span className="weq-exp-row-meta">
                  <strong title={it.title}>{it.title}</strong>
                  {it.sub || it.source ? (
                    <small title={it.sub || undefined}>
                      {[it.sub, it.source].filter(Boolean).join(' · ')}
                    </small>
                  ) : null}
                </span>
                <span className="weq-exp-col-side">
                  <span className="weq-exp-col-kind">
                    {COLLECTION_KIND_LABEL[it.kind] ?? '其他'}
                  </span>
                  {fmtCollectDay(it.collectTime) ? (
                    <small>{fmtCollectDay(it.collectTime)}</small>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Format unix seconds as `MM/DD HH:mm` for the schedule row. */
function fmtRunAt(sec: number | null): string {
  if (sec == null) return '—';
  const d = new Date(sec * 1000);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact relative-time hint for the "下次运行" label. */
function fmtRel(sec: number | null): string {
  if (sec == null) return '已停止';
  const diff = sec - Math.floor(Date.now() / 1000);
  if (diff <= 0) return '即将触发';
  if (diff < 60) return `还有 ${diff} 秒`;
  if (diff < 3600) return `还有 ${Math.floor(diff / 60)} 分`;
  if (diff < 86400) return `还有 ${Math.floor(diff / 3600)} 小时`;
  return `还有 ${Math.floor(diff / 86400)} 天`;
}

function outcomeLabel(t: { outcome: string; skipReason?: string }): string {
  switch (t.outcome) {
    case 'running':
      return '运行中';
    case 'completed':
      return '完成';
    case 'partial':
      return '部分';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '取消';
    case 'skipped':
      if (t.skipReason === 'QQ 离线') return '跳过·离线';
      if (t.skipReason === '上次任务未结束') return '跳过·冲突';
      if (t.skipReason === '已暂停') return '跳过·暂停';
      if (t.skipReason === '未选择会话') return '跳过·空';
      return '跳过';
    default:
      return t.outcome;
  }
}

function scheduleSummary(s: ScheduledTask): string {
  const cadence =
    s.schedule.mode === 'daily' ? `每天 ${s.schedule.time}` : `每 ${s.schedule.intervalHours} 小时`;
  const range =
    s.options.range.preset === 'all'
      ? '全部时间'
      : s.options.range.preset === 'today'
        ? '今天'
        : s.options.range.preset === 'custom'
          ? `自定义时间`
          : `最近 ${s.options.range.preset}`;
  const media =
    [
      s.options.exportAvatar ? '头像' : null,
      s.options.exportMedia ? '媒体' : null,
      s.options.dress && (s.options.dress.bubble || s.options.dress.font || s.options.dress.widget)
        ? '装扮'
        : null,
      s.options.transcribeVoice ? '转写' : null,
    ]
      .filter(Boolean)
      .join('·') || '纯文本';
  return `${cadence} · ${range} · ${media}`;
}

function ScheduleRow({
  schedule,
  onToggle,
  onDelete,
  onRunNow,
}: {
  schedule: ScheduledTask;
  onToggle: () => void;
  onDelete: () => void;
  onRunNow: () => void;
}): ReactElement {
  const next = schedule.nextRunAt;
  const formats = schedule.formats?.length ? schedule.formats : [schedule.format];
  return (
    <div className={`weq-exp-sched-card${schedule.enabled ? '' : ' is-disabled'}`}>
      <div className="weq-exp-sched-card-main">
        <div className="weq-exp-sched-card-top">
          <span className="weq-exp-sched-card-name">{schedule.name}</span>
          <span className={`weq-exp-sched-card-tag${schedule.enabled ? '' : ' is-off'}`}>
            {schedule.enabled ? '运行中' : '已暂停'}
          </span>
          {formats.map((f) => (
            <span key={f} className="weq-exp-sched-card-tag">
              {f.toUpperCase()}
            </span>
          ))}
        </div>
        <div className="weq-exp-sched-card-meta">
          <span>
            会话 <b>{schedule.conversations.length}</b>
          </span>
          <span>
            节奏 <b>{scheduleSummary(schedule)}</b>
          </span>
          <span>
            下次 <b>{fmtRunAt(next)}</b> · {fmtRel(next)}
          </span>
        </div>
        {schedule.history.length > 0 ? (
          <div
            className="weq-exp-sched-card-history"
            title={schedule.history.map((t) => `${fmtRunAt(t.at)} ${outcomeLabel(t)}`).join('\n')}
          >
            最近触发：
            {schedule.history.slice(0, 8).map((t, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                key={`${t.at}-${i}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
              >
                <span className={`weq-exp-sched-card-history-dot is-${t.outcome}`} />
                <span>{outcomeLabel(t)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="weq-exp-sched-card-actions">
        <button
          type="button"
          onClick={onToggle}
          title={schedule.enabled ? '暂停' : '启用'}
          aria-label={schedule.enabled ? '暂停' : '启用'}
        >
          {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" onClick={onRunNow} title="立即运行" aria-label="立即运行">
          <Zap size={14} />
        </button>
        <button
          type="button"
          className="is-danger"
          onClick={onDelete}
          title="删除"
          aria-label="删除"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
