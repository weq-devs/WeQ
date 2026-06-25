/**
 * 导出中心（单页）。
 *
 * 布局：左侧窄栏为导出模式；右侧为该模式的选择面板 + 操作条；下方为任务列表。
 *
 *   1. 完整消息格式  — 选会话 → 选格式(json/jsonl/xlsx/csv/txt) → 灯箱细项 → 导出
 *   2. 解密数据库    — 选库 → 选导出路径 → 解出原始 sqlite
 *   3. ChatLab 格式  — 同 1，格式限 json/jsonl
 *   4. HTML 格式     — 尚未实现：右栏显示占位空状态，底部按钮禁用
 *   5. 定时导出任务  — 同 1，灯箱多一个定时设置
 *   6. 群相册导出    — 选群 → 灯箱选目录/相册/时间
 *
 * 后端目前仅 `account.startExport`（json/jsonl/txt 纯消息流）就绪；其余流程在
 * 前端把配置收集齐后给出「后端待接入」提示，待后端补齐后改为真实调用即可。
 */

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  CalendarClock,
  DatabaseZap,
  FileCode2,
  FlaskConical,
  Images,
  MessagesSquare,
  Pause,
  Play,
  Trash2,
  Zap,
} from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { Segmented } from './export/widgets';
import { ConversationPicker } from './export/ConversationPicker';
import { SingleSelectPicker } from './export/SingleSelectPicker';
import { TaskList, type UiTask, type UiFailure } from './export/TaskList';
import { ExportLightbox, type LightboxResult, type LightboxVariant } from './export/ExportLightbox';
import { DatabasePicker, type DbPickItem } from './export/DatabasePicker';
import { DecryptLightbox, type DecryptLightboxResult } from './export/DecryptLightbox';
import { AlbumExportLightbox, type AlbumExportResult } from './export/AlbumExportLightbox';
import { FailureLightbox } from './export/FailureLightbox';
import {
  CHATLAB_FORMATS,
  FULL_FORMATS,
  chatKind,
  convAvatarUrl,
  fmtBytes,
  fmtCount,
  groupAvatarUrl,
  isBackendFormat,
  type BackendFormat,
  type ExportFormat,
  type ExportMode,
  type ExportOptions,
  type PickItem,
  type ScheduledTask,
} from './export/types';
import '../styles/export.css';

interface ModeDef {
  id: ExportMode;
  label: string;
  desc: string;
  icon: ReactNode;
}

const MODES: ModeDef[] = [
  { id: 'full', label: '完整消息格式', desc: 'JSON / JSONL / XLSX / CSV / TXT', icon: <MessagesSquare size={18} /> },
  { id: 'decrypt', label: '解密数据库', desc: '导出原始 SQLite 供研究', icon: <DatabaseZap size={18} /> },
  { id: 'chatlab', label: 'ChatLab 格式', desc: '供 AI 分析的结构化 JSON', icon: <FlaskConical size={18} /> },
  { id: 'html', label: '导出为 HTML', desc: '单个会话的网页记录', icon: <FileCode2 size={18} /> },
  { id: 'scheduled', label: '定时导出任务', desc: '按计划自动导出', icon: <CalendarClock size={18} /> },
  { id: 'album', label: '群相册导出', desc: '批量下载群相册', icon: <Images size={18} /> },
];

/** Recent-contact wire shape we actually read here. */
interface ConvWire {
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  targetDisplayName: string;
  messageCount?: number;
}

interface GroupWire {
  groupCode: string;
  groupName: string;
  memberCount: number;
}

export function ExportView(): ReactElement {
  const utils = trpc.useUtils();
  const dialog = useAppDialog();

  const conversations = trpc.account.listConversationsWithCount.useQuery();
  const databases = trpc.account.listDatabases.useQuery();
  const groups = trpc.account.listAllGroups.useQuery({ limit: 2000 });
  const tasks = trpc.account.listExportTasks.useQuery();
  const schedules = trpc.account.listSchedules.useQuery();

  const [mode, setMode] = useState<ExportMode>('full');
  const [convSelection, setConvSelection] = useState<Set<string>>(new Set());
  const [dbSelection, setDbSelection] = useState<Set<string>>(new Set());
  const [decryptLightboxOpen, setDecryptLightboxOpen] = useState(false);
  const [decryptOutputDir, setDecryptOutputDir] = useState<string | null>(null);
  const [albumOutputDir, setAlbumOutputDir] = useState<string | null>(null);
  const [albumExport, setAlbumExport] = useState<{ group: PickItem } | null>(null);
  const [albumGroupId, setAlbumGroupId] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [lightbox, setLightbox] = useState<LightboxVariant | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Media-completion failure detail, when the user opens a task's failure list. */
  const [failureView, setFailureView] = useState<{ name: string; failures: UiFailure[] } | null>(null);

  // ChatLab only emits json/jsonl — clamp the chip when entering that mode.
  useEffect(() => {
    if (mode === 'chatlab' && format !== 'json' && format !== 'jsonl') setFormat('json');
  }, [mode, format]);

  // Live task progress: invalidate the list whenever the backend ticks.
  useEffect(() => {
    const sub = client.account.onExportProgress.subscribe(undefined, {
      onData: () => void utils.account.listExportTasks.invalidate(),
      onError: (err) => console.error('[export] progress subscription error', err),
    });
    return () => sub.unsubscribe();
  }, [utils]);

  const convItems = useMemo<PickItem[]>(() => {
    return ((conversations.data ?? []) as ConvWire[]).map((c) => {
      const kind = chatKind(c.chatType);
      const count = Number(c.messageCount ?? 0);
      return {
        id: c.targetUid,
        name: c.targetDisplayName || c.targetUid,
        avatarUrl: convAvatarUrl(kind, c.targetUid, c.targetUin),
        kind,
        total: count,
        meta: `${fmtCount(count)} 条 · ${kind === 'group' ? '群聊' : '私聊'}`,
      };
    });
  }, [conversations.data]);

  const groupItems = useMemo<PickItem[]>(() => {
    return ((groups.data ?? []) as GroupWire[]).map((g) => ({
      id: g.groupCode,
      name: g.groupName || g.groupCode,
      avatarUrl: groupAvatarUrl(g.groupCode),
      kind: 'group',
      meta: `${fmtCount(g.memberCount || 0)} 人`,
    }));
  }, [groups.data]);

  const dbItems = useMemo<DbPickItem[]>(() => {
    return ((databases.data ?? []) as DbPickItem[]).map((db) => ({
      name: db.name,
      path: db.path,
      bytes: Number(db.bytes ?? 0),
    }));
  }, [databases.data]);

  const selectedDbs = useMemo(
    () => dbItems.filter((it) => dbSelection.has(it.path)),
    [dbItems, dbSelection],
  );

  const selectedDbBytes = useMemo(
    () => selectedDbs.reduce((sum, it) => sum + it.bytes, 0),
    [selectedDbs],
  );

  const uiTasks = useMemo<UiTask[]>(() => {
    // Defensive: the IPC payload can momentarily be a non-array during a main
    // process restart / error envelope — never let that white-screen the view.
    const rows = Array.isArray(tasks.data) ? (tasks.data as UiTask[]) : [];
    return rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      format: t.format,
      status: t.status,
      progress: t.progress,
      current: t.current,
      total: t.total,
      error: t.error,
      filePath: t.filePath,
      bundleDir: t.bundleDir,
      avatarCount: t.avatarCount,
      stages: t.stages,
    }));
  }, [tasks.data]);

  // ---- task actions (existing backend) ----
  const refetchTasks = (): void => void tasks.refetch();

  const onPause = (t: UiTask): void =>
    void client.account.pauseExportTask.mutate({ taskId: t.id }).then(refetchTasks);
  const onCancel = (t: UiTask): void =>
    void client.account.cancelExportTask.mutate({ taskId: t.id }).then(refetchTasks);
  const onDelete = (t: UiTask): void =>
    void client.account.deleteExportTask.mutate({ taskId: t.id }).then(refetchTasks);

  const onDownload = async (t: UiTask): Promise<void> => {
    try {
      let ok = false;
      if (t.bundleDir) {
        // Avatar bundle: copy the whole folder (message file + avatars/) out.
        ok = await client.account.saveExportBundle.mutate({ taskId: t.id });
      } else if (t.filePath) {
        const fmt: BackendFormat = isBackendFormat(t.format as ExportFormat)
          ? (t.format as BackendFormat)
          : 'json';
        ok = await client.account.saveExportFile.mutate({
          sourcePath: t.filePath,
          defaultName: `${t.name}.${t.format}`,
          format: fmt,
        });
      }
      if (ok) {
        await client.account.deleteExportTask.mutate({ taskId: t.id });
        refetchTasks();
      }
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  };

  // ---- primary action per mode ----
  function onPrimary(): void {
    if (mode === 'decrypt') {
      if (dbSelection.size === 0) return;
      setDecryptLightboxOpen(true);
      return;
    }
    if (mode === 'album') {
      if (!albumGroupId) return;
      openAlbumExport();
      return;
    }
    if (convSelection.size === 0) return;
    setLightbox(mode === 'scheduled' ? 'scheduled' : mode === 'chatlab' ? 'chatlab' : 'full');
  }

  /**
   * Pre-flight for 补全缺失媒体: needs an online QQ (to harvest a fresh rkey).
   * Returns false to abort the export. Offline → hard block; global 媒体补全 off
   * → warn but allow; then force one fresh rkey harvest.
   */
  async function preflightMediaCompletion(): Promise<boolean> {
    let online = false;
    try {
      online = (await client.account.getGroupAlbumAccessState.query()).qqOnline;
    } catch (e) {
      dialog.error('检查在线状态失败', e instanceof Error ? e.message : String(e));
      return false;
    }
    if (!online) {
      await dialog.info(
        '无法补全媒体',
        '未检测到在线的 QQ 实例。补全缺失媒体需要登录该账号的 QQ 客户端以获取下载凭证（rkey）。请登录后重试，或关闭「补全缺失媒体」后继续导出。',
      );
      return false;
    }
    let globalOn = true;
    try {
      globalOn = (await client.bootstrap.getSettings.query()).mediaCompletion.enabled;
    } catch {
      /* treat as on; the forced harvest below still runs */
    }
    if (!globalOn) {
      const ok = await dialog.confirm(
        '媒体补全未开启',
        '全局设置中的「媒体补全（rkey）」已关闭，后台不会持续刷新下载凭证，可能有大量图片无法补全。是否仍要继续？',
        { okLabel: '继续导出', cancelLabel: '返回', tone: 'warning' },
      );
      if (!ok) return false;
    }
    // Explicit one-shot rkey refresh right before exporting.
    try {
      await client.account.refreshRkeys.mutate();
    } catch {
      /* best-effort; export proceeds with whatever rkeys exist */
    }
    return true;
  }

  /**
   * Pre-flight for 语音自动转写: a transcription model must be selected *and*
   * fully downloaded (设置 → 语音转录). Returns false to abort, pointing the user
   * at the settings page — mirrors the per-message transcribe checks.
   */
  async function preflightVoiceTranscribe(): Promise<boolean> {
    let modelId = '';
    try {
      modelId = (await client.bootstrap.getSettings.query()).voiceTranscribe.modelId;
    } catch (e) {
      dialog.error('检查语音模型失败', e instanceof Error ? e.message : String(e));
      return false;
    }
    if (!modelId) {
      await dialog.info(
        '未配置语音模型',
        '「语音自动转写」需要先下载并选择一个转录模型。请前往「设置 → 语音转录」下载模型后重试，或关闭「语音自动转写」后继续导出。',
      );
      return false;
    }
    try {
      const models = await client.bootstrap.voiceModels.query();
      const model = models.find((m) => m.id === modelId);
      if (!model?.downloaded) {
        await dialog.info(
          '语音模型未下载',
          `转录模型「${model?.name ?? modelId}」尚未下载完成。请前往「设置 → 语音转录」完成下载后重试，或关闭「语音自动转写」后继续导出。`,
        );
        return false;
      }
    } catch (e) {
      dialog.error('检查语音模型失败', e instanceof Error ? e.message : String(e));
      return false;
    }
    return true;
  }

  async function runFullExport(options: ExportOptions, opts: { chatlab?: boolean } = {}): Promise<void> {
    const targets = convItems.filter((it) => convSelection.has(it.id));
    // null bounds = open-ended; both null (全部时间) means no filtering.
    const range = { start: options.range.start, end: options.range.end };
    const media = {
      exportMedia: options.exportMedia,
      completeMedia: options.exportMedia && options.completeMedia,
      downloadVideo: options.exportMedia && options.completeMedia && options.downloadVideo,
      downloadFile: options.exportMedia && options.completeMedia && options.downloadFile,
      transcribeVoice: options.transcribeVoice,
    };

    if (media.completeMedia) {
      const ok = await preflightMediaCompletion();
      if (!ok) return;
    } else if (media.exportMedia) {
      const ok = await dialog.confirm(
        '未开启媒体补全',
        '已开启「导出媒体文件」但未开启「补全缺失媒体」。本地缓存中缺失的图片 / 视频 / 文件不会从云端下载，可能有大量媒体无法导出。是否继续？',
        { okLabel: '继续导出', cancelLabel: '返回', tone: 'warning' },
      );
      if (!ok) return;
    }

    // 语音转写需要已下载的转录模型，缺失则提示去设置页（不阻断其它导出选项）。
    if (media.transcribeVoice) {
      const ok = await preflightVoiceTranscribe();
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      for (const t of targets) {
        await client.account.startExport.mutate({
          kind: t.kind ?? 'c2c',
          conv: t.id,
          name: t.name,
          format,
          total: t.total ?? 0,
          exportAvatar: options.exportAvatar,
          ...(opts.chatlab ? { chatlab: true } : {}),
          media,
          range,
        });
      }
      setConvSelection(new Set());
      setLightbox(null);
      refetchTasks();
    } catch (e) {
      dialog.error('启动导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function runDecryptExport(result: DecryptLightboxResult): Promise<void> {
    const targets = selectedDbs;
    if (targets.length === 0) return;

    if (result.mode === 'fast') {
      let loggedIn = false;
      try {
        loggedIn = await client.account.isQqLoggedIn.query();
      } catch (e) {
        dialog.error('检查登录状态失败', e instanceof Error ? e.message : String(e));
        return;
      }
      if (loggedIn) {
        const ok = await dialog.confirm(
          '快速解密风险',
          '检测到当前 QQ 账号仍处于登录状态。快速解密可能导致导出的数据库损坏；安全保存更适合 QQ 在线时使用。是否仍继续快速解密？',
          { okLabel: '继续快速解密', cancelLabel: '返回修改', tone: 'warning' },
        );
        if (!ok) return;
      }
    }

    setSubmitting(true);
    try {
      const decrypted = await client.account.decryptDatabases.mutate({
        mode: result.mode,
        outputDir: result.outputDir,
        concurrency: 3,
        items: targets.map((db) => ({ dbPath: db.path, name: db.name })),
      });
      const okCount = decrypted.filter((r) => r.ok).length;
      const failed = decrypted.filter((r) => !r.ok);
      setDecryptOutputDir(result.outputDir);
      if (failed.length === 0) {
        setDbSelection(new Set());
        setDecryptLightboxOpen(false);
        dialog.info('解密完成', `已解密 ${okCount} 个数据库到：${result.outputDir}`);
      } else {
        dialog.error(
          '部分数据库解密失败',
          `成功 ${okCount} 个，失败 ${failed.length} 个。${failed[0]?.name ?? ''}${failed[0]?.error ? `：${failed[0].error}` : ''}`,
        );
      }
    } catch (e) {
      dialog.error('解密失败', e instanceof Error ? e.message : String(e));
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
        dialog.info('群相册导出完成', `已保存 ${exported.ok} 个文件到：${exported.outputDir}`);
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

  async function onLightboxConfirm(result: LightboxResult): Promise<void> {
    if (lightbox === 'full') {
      void runFullExport(result.options);
      return;
    }
    if (lightbox === 'chatlab') {
      void runFullExport(result.options, { chatlab: true });
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

  /** Persist a scheduled template. Mirrors the per-task `media/range` shape
   *  from `runFullExport` so a triggered run reproduces the same output. */
  async function runCreateSchedule(result: LightboxResult): Promise<void> {
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
      await client.account.createSchedule.mutate({
        name: `定时 · ${targets[0]!.name}${targets.length > 1 ? ` 等 ${targets.length} 个` : ''}`,
        format,
        conversations: targets.map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind ?? 'c2c',
          total: t.total ?? 0,
        })),
        chatlab: false,
        schedule: result.schedule,
        options: {
          range: {
            preset: result.options.range.preset,
            start: result.options.range.start,
            end: result.options.range.end,
          },
          exportMedia: result.options.exportMedia,
          exportAvatar: result.options.exportAvatar,
          completeMedia: result.options.completeMedia,
          downloadVideo: result.options.downloadVideo,
          downloadFile: result.options.downloadFile,
          transcribeVoice: result.options.transcribeVoice,
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
      dialog.info('已触发', '本次导出任务已加入队列，状态在下方任务列表查看。');
    } catch (e) {
      dialog.error('立即运行失败', e instanceof Error ? e.message : String(e));
    }
  }

  const activeMode = MODES.find((m) => m.id === mode)!;
  const isMultiConvMode = mode === 'full' || mode === 'chatlab' || mode === 'scheduled';
  const formatOptions = mode === 'chatlab' ? CHATLAB_FORMATS : FULL_FORMATS;

  const primaryLabel =
    mode === 'scheduled'
      ? '新建定时任务'
      : mode === 'album'
        ? '导出相册'
        : mode === 'decrypt'
          ? '解密并导出'
          : mode === 'html'
            ? '导出 HTML'
            : mode === 'chatlab'
              ? '导出 ChatLab'
              : '导出';

  const primaryDisabled =
    mode === 'decrypt'
      ? dbSelection.size === 0
      : mode === 'album'
        ? !albumGroupId
        : mode === 'html'
          ? true
          : convSelection.size === 0;

  // Lightbox summary line.
  const lightboxSummary = (() => {
    if (lightbox === 'album') {
      const g = groupItems.find((it) => it.id === albumGroupId);
      return g ? `群相册 · ${g.name}` : '群相册';
    }
    const n = convSelection.size;
    return `${n} 个会话 · ${format.toUpperCase()}`;
  })();

  const lightboxHeadline =
    lightbox === 'scheduled'
      ? '新建定时导出任务'
      : lightbox === 'album'
        ? '导出群相册'
        : lightbox === 'chatlab'
          ? '导出 ChatLab 格式'
          : '导出聊天记录';

  return (
    <div className="weq-exp">
      <div className="weq-exp-top">
        {/* 左侧模式栏 */}
        <nav className="weq-exp-modes" aria-label="导出模式">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`weq-exp-mode${m.id === mode ? ' is-active' : ''}`}
              onClick={() => setMode(m.id)}
            >
              <span className="weq-exp-mode-icon">{m.icon}</span>
              <span className="weq-exp-mode-text">
                <strong>{m.label}</strong>
                <small>{m.desc}</small>
              </span>
            </button>
          ))}
        </nav>

        {/* 右侧选择面板 */}
        <section className="weq-exp-pane">
          <header className="weq-exp-pane-head">
            <div className="weq-exp-pane-title">
              <strong>{activeMode.label}</strong>
              <span>{activeMode.desc}</span>
            </div>
          </header>

          <div className="weq-exp-pane-body">
            {mode === 'scheduled' ? (
              <div className="weq-exp-sched">
                <div className="weq-exp-sched-head">
                  <div className="weq-exp-sched-head-text">
                    <strong>定时导出任务</strong>
                    <small>选择上方会话与格式后点击「新建定时任务」创建调度；下方为已存在的调度列表。</small>
                  </div>
                </div>
                <ConversationPicker
                  items={convItems}
                  loading={conversations.isLoading}
                  selected={convSelection}
                  onChange={setConvSelection}
                />
                <div className="weq-exp-sched-list">
                  {schedules.isLoading ? (
                    <div className="weq-exp-sched-empty"><small>加载中…</small></div>
                  ) : (schedules.data ?? []).length === 0 ? (
                    <div className="weq-exp-sched-empty">
                      <strong>暂无定时任务</strong>
                      <small>选好会话和格式后，点击下方「新建定时任务」开始创建。</small>
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
              </div>
            ) : isMultiConvMode ? (
              <ConversationPicker
                items={convItems}
                loading={conversations.isLoading}
                selected={convSelection}
                onChange={setConvSelection}
              />
            ) : mode === 'html' ? (
              <div className="weq-exp-empty">
                <span className="weq-exp-empty-icon" aria-hidden>
                  <FileCode2 size={28} strokeWidth={1.7} />
                </span>
                <strong className="weq-exp-empty-title">HTML 导出尚未实现</strong>
                <p className="weq-exp-empty-desc">
                  单个会话的网页化导出正在规划中。当前可使用「完整消息格式」导出为 JSON / JSONL / TXT / CSV / XLSX，
                  或导出为「ChatLab 格式」供 AI 分析。
                </p>
                <span className="weq-exp-empty-tag">等待后期补全</span>
              </div>
            ) : mode === 'album' ? (
              <SingleSelectPicker
                items={groupItems}
                loading={groups.isLoading}
                selectedId={albumGroupId}
                onSelect={setAlbumGroupId}
                searchPlaceholder="搜索群名称或群号"
                emptyText="暂无群聊"
              />
            ) : (
              <DatabasePicker
                items={dbItems}
                loading={databases.isLoading}
                selected={dbSelection}
                onChange={setDbSelection}
              />
            )}
          </div>

          <footer className="weq-exp-pane-foot">
            {mode === 'scheduled' ? (
              <span className="weq-exp-foot-hint">
                {convSelection.size > 0
                  ? `已选 ${convSelection.size} 个会话 · ${format.toUpperCase()} · 点击新建定时任务`
                  : '请先选择至少一个会话'}
              </span>
            ) : isMultiConvMode ? (
              <div className="weq-exp-foot-format">
                <span className="weq-exp-foot-label">格式</span>
                <Segmented<ExportFormat> value={format} onChange={setFormat} options={formatOptions} small />
              </div>
            ) : (
              <span className="weq-exp-foot-hint">
                {mode === 'album'
                  ? '选择一个群，下一步选择相册与时间范围'
                  : mode === 'html'
                    ? 'HTML 导出尚未实现，等待后期补全'
                    : dbSelection.size > 0
                      ? `已选 ${dbSelection.size} 个数据库 · ${fmtBytes(selectedDbBytes)}`
                      : '选择数据库后导出解密副本'}
              </span>
            )}
            <button type="button" className="weq-exp-primary" disabled={primaryDisabled} onClick={onPrimary}>
              {primaryLabel}
            </button>
          </footer>
        </section>
      </div>

      {/* 底部任务列表 */}
      <TaskList
        tasks={uiTasks}
        onPause={onPause}
        onCancel={onCancel}
        onDownload={(t) => void onDownload(t)}
        onDelete={onDelete}
        onShowFailures={(t, failures) => setFailureView({ name: t.name, failures })}
      />

      {failureView ? (
        <FailureLightbox
          taskName={failureView.name}
          failures={failureView.failures}
          onClose={() => setFailureView(null)}
        />
      ) : null}

      {lightbox ? (
        <ExportLightbox
          variant={lightbox}
          headline={lightboxHeadline}
          summary={lightboxSummary}
          submitting={submitting}
          onPickPath={async () => {
            dialog.info('选择目录', '目录选择接口待接入，开始导出时将使用系统对话框。');
            return null;
          }}
          onClose={() => setLightbox(null)}
          onConfirm={onLightboxConfirm}
        />
      ) : null}

      {decryptLightboxOpen ? (
        <DecryptLightbox
          count={selectedDbs.length}
          totalBytes={selectedDbBytes}
          outputDir={decryptOutputDir}
          submitting={submitting}
          formatBytes={fmtBytes}
          onPickPath={async () => {
            const picked = await client.account.pickDecryptOutputDir.mutate();
            if (picked) setDecryptOutputDir(picked);
            return picked;
          }}
          onClose={() => setDecryptLightboxOpen(false)}
          onConfirm={(result) => void runDecryptExport(result)}
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
    case 'completed': return '完成';
    case 'partial': return '部分';
    case 'failed': return '失败';
    case 'cancelled': return '取消';
    case 'skipped':
      if (t.skipReason === 'QQ 离线') return '跳过·离线';
      if (t.skipReason === '上次任务未结束') return '跳过·冲突';
      if (t.skipReason === '已暂停') return '跳过·暂停';
      if (t.skipReason === '未选择会话') return '跳过·空';
      return '跳过';
    default: return t.outcome;
  }
}

function scheduleSummary(s: ScheduledTask): string {
  const cadence = s.schedule.mode === 'daily'
    ? `每天 ${s.schedule.time}`
    : `每 ${s.schedule.intervalHours} 小时`;
  const range = s.options.range.preset === 'all'
    ? '全部时间'
    : s.options.range.preset === 'today'
      ? '今天'
      : s.options.range.preset === 'custom'
        ? `自定义时间`
        : `最近 ${s.options.range.preset}`;
  const media = [
    s.options.exportAvatar ? '头像' : null,
    s.options.exportMedia ? '媒体' : null,
    s.options.transcribeVoice ? '转写' : null,
  ].filter(Boolean).join('·') || '纯文本';
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
  return (
    <div className={`weq-exp-sched-card${schedule.enabled ? '' : ' is-disabled'}`}>
      <div className="weq-exp-sched-card-main">
        <div className="weq-exp-sched-card-top">
          <span className="weq-exp-sched-card-name">{schedule.name}</span>
          <span className={`weq-exp-sched-card-tag${schedule.enabled ? '' : ' is-off'}`}>
            {schedule.enabled ? '运行中' : '已暂停'}
          </span>
          <span className="weq-exp-sched-card-tag">{schedule.format.toUpperCase()}</span>
        </div>
        <div className="weq-exp-sched-card-meta">
          <span>会话 <b>{schedule.conversations.length}</b></span>
          <span>节奏 <b>{scheduleSummary(schedule)}</b></span>
          <span>下次 <b>{fmtRunAt(next)}</b> · {fmtRel(next)}</span>
        </div>
        {schedule.history.length > 0 ? (
          <div className="weq-exp-sched-card-history" title={schedule.history.map((t) => `${fmtRunAt(t.at)} ${outcomeLabel(t)}`).join('\n')}>
            最近触发：
            {schedule.history.slice(0, 8).map((t, i) => (
              <span key={`${t.at}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span className={`weq-exp-sched-card-history-dot is-${t.outcome}`} />
                <span>{outcomeLabel(t)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="weq-exp-sched-card-actions">
        <button type="button" onClick={onToggle} title={schedule.enabled ? '暂停' : '启用'} aria-label={schedule.enabled ? '暂停' : '启用'}>
          {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" onClick={onRunNow} title="立即运行" aria-label="立即运行">
          <Zap size={14} />
        </button>
        <button type="button" className="is-danger" onClick={onDelete} title="删除" aria-label="删除">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
