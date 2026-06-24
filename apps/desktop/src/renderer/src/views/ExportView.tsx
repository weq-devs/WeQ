/**
 * 导出中心（单页）。
 *
 * 布局：左侧窄栏为导出模式；右侧为该模式的选择面板 + 操作条；下方为任务列表。
 *
 *   1. 完整消息格式  — 选会话 → 选格式(json/jsonl/xlsx/csv/txt) → 灯箱细项 → 导出
 *   2. 解密数据库    — 选库 → 选导出路径 → 解出原始 sqlite
 *   3. ChatLab 格式  — 同 1，格式限 json/jsonl
 *   4. HTML 格式     — 单选会话 → 灯箱选择时间范围
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
} from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { Segmented } from './export/widgets';
import { ConversationPicker } from './export/ConversationPicker';
import { SingleSelectPicker } from './export/SingleSelectPicker';
import { TaskList, type UiTask } from './export/TaskList';
import { ExportLightbox, type LightboxResult, type LightboxVariant } from './export/ExportLightbox';
import { DatabasePicker, type DbPickItem } from './export/DatabasePicker';
import { DecryptLightbox, type DecryptLightboxResult } from './export/DecryptLightbox';
import { AlbumExportLightbox, type AlbumExportResult } from './export/AlbumExportLightbox';
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

  const [mode, setMode] = useState<ExportMode>('full');
  const [convSelection, setConvSelection] = useState<Set<string>>(new Set());
  const [dbSelection, setDbSelection] = useState<Set<string>>(new Set());
  const [decryptLightboxOpen, setDecryptLightboxOpen] = useState(false);
  const [decryptOutputDir, setDecryptOutputDir] = useState<string | null>(null);
  const [albumOutputDir, setAlbumOutputDir] = useState<string | null>(null);
  const [albumExport, setAlbumExport] = useState<{ group: PickItem } | null>(null);
  const [htmlConvId, setHtmlConvId] = useState<string | null>(null);
  const [albumGroupId, setAlbumGroupId] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [lightbox, setLightbox] = useState<LightboxVariant | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    if (mode === 'html') {
      if (!htmlConvId) return;
      setLightbox('html');
      return;
    }
    if (convSelection.size === 0) return;
    setLightbox(mode === 'scheduled' ? 'scheduled' : mode === 'chatlab' ? 'chatlab' : 'full');
  }

  async function runFullExport(options: ExportOptions): Promise<void> {
    const targets = convItems.filter((it) => convSelection.has(it.id));
    // null bounds = open-ended; both null (全部时间) means no filtering.
    const range = { start: options.range.start, end: options.range.end };
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

  function onLightboxConfirm(result: LightboxResult): void {
    if (lightbox === 'full') {
      void runFullExport(result.options);
      return;
    }
    // chatlab / html / scheduled / album — config collected, backend pending.
    const detail =
      lightbox === 'scheduled'
        ? `定时任务配置已记录（${result.schedule?.mode === 'daily' ? `每天 ${result.schedule.time}` : `每 ${result.schedule?.intervalHours} 小时`}）。定时调度后端待接入。`
        : lightbox === 'html'
          ? 'HTML 导出后端尚未实现，已记录本次导出的会话与时间范围。'
        : lightbox === 'chatlab'
          ? 'ChatLab 导出器后端待接入，已记录本次导出配置。'
          : '群相册导出后端待接入，已记录本次导出配置。';
    setLightbox(null);
    dialog.info('配置已记录', detail);
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
          ? !htmlConvId
          : convSelection.size === 0;

  // Lightbox summary line.
  const lightboxSummary = (() => {
    if (lightbox === 'album') {
      const g = groupItems.find((it) => it.id === albumGroupId);
      return g ? `群相册 · ${g.name}` : '群相册';
    }
    if (lightbox === 'html') {
      const c = convItems.find((it) => it.id === htmlConvId);
      return c ? `HTML · ${c.name}` : 'HTML';
    }
    const n = convSelection.size;
    return `${n} 个会话 · ${format.toUpperCase()}`;
  })();

  const lightboxHeadline =
    lightbox === 'scheduled'
      ? '新建定时导出任务'
      : lightbox === 'album'
        ? '导出群相册'
        : lightbox === 'html'
          ? '导出 HTML 聊天记录'
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
            {isMultiConvMode ? (
              <ConversationPicker
                items={convItems}
                loading={conversations.isLoading}
                selected={convSelection}
                onChange={setConvSelection}
              />
            ) : mode === 'html' ? (
              <SingleSelectPicker
                items={convItems}
                loading={conversations.isLoading}
                selectedId={htmlConvId}
                onSelect={setHtmlConvId}
                searchPlaceholder="搜索会话名称或号码"
                emptyText="暂无可导出的会话"
              />
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
            {isMultiConvMode ? (
              <div className="weq-exp-foot-format">
                <span className="weq-exp-foot-label">格式</span>
                <Segmented<ExportFormat> value={format} onChange={setFormat} options={formatOptions} small />
              </div>
            ) : (
              <span className="weq-exp-foot-hint">
                {mode === 'album'
                  ? '选择一个群，下一步选择相册与时间范围'
                  : mode === 'html'
                    ? '选择一个会话，下一步选择时间范围'
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
      <TaskList tasks={uiTasks} onPause={onPause} onCancel={onCancel} onDownload={(t) => void onDownload(t)} onDelete={onDelete} />

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
