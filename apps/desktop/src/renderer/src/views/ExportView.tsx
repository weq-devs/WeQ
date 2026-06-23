/**
 * 导出中心（单页）。
 *
 * 布局：左侧窄栏为五种导出模式；右侧为该模式的选择面板 + 操作条；下方为任务列表。
 *
 *   1. 完整消息格式  — 选会话 → 选格式(json/jsonl/xlsx/csv/txt) → 灯箱细项 → 导出
 *   2. 解密数据库    — 选库 → 选导出路径 → 解出原始 sqlite
 *   3. ChatLab 格式  — 同 1，格式限 json/jsonl
 *   4. 定时导出任务  — 同 1，灯箱多一个定时设置
 *   5. 群相册导出    — 选群 → 灯箱选目录/相册/时间
 *
 * 后端目前仅 `account.startExport`（json/jsonl/txt 纯消息流）就绪；其余流程在
 * 前端把配置收集齐后给出「后端待接入」提示，待后端补齐后改为真实调用即可。
 */

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  CalendarClock,
  DatabaseZap,
  FlaskConical,
  Images,
  MessagesSquare,
} from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useDialog } from '../components/Dialog';
import { Segmented } from './export/widgets';
import { ConversationPicker } from './export/ConversationPicker';
import { SingleSelectPicker } from './export/SingleSelectPicker';
import { TaskList, type UiTask } from './export/TaskList';
import { ExportLightbox, type LightboxResult, type LightboxVariant } from './export/ExportLightbox';
import {
  CHATLAB_FORMATS,
  FULL_FORMATS,
  chatKind,
  convAvatarUrl,
  fmtCount,
  groupAvatarUrl,
  isBackendFormat,
  type ExportFormat,
  type ExportMode,
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
  const showInfo = useDialog((s) => s.showInfo);
  const showError = useDialog((s) => s.showError);

  const conversations = trpc.account.listConversationsWithCount.useQuery();
  const groups = trpc.account.listAllGroups.useQuery({ limit: 2000 });
  const tasks = trpc.account.listExportTasks.useQuery();

  const [mode, setMode] = useState<ExportMode>('full');
  const [convSelection, setConvSelection] = useState<Set<string>>(new Set());
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

  const uiTasks = useMemo<UiTask[]>(() => {
    return ((tasks.data ?? []) as UiTask[]).map((t) => ({
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
    if (!t.filePath) return;
    try {
      const fmt = isBackendFormat(t.format as ExportFormat) ? (t.format as 'json' | 'jsonl' | 'txt') : 'json';
      const ok = await client.account.saveExportFile.mutate({
        sourcePath: t.filePath,
        defaultName: `${t.name}.${t.format}`,
        format: fmt,
      });
      if (ok) {
        await client.account.deleteExportTask.mutate({ taskId: t.id });
        refetchTasks();
      }
    } catch (e) {
      showError('保存失败', e instanceof Error ? e.message : String(e));
    }
  };

  // ---- primary action per mode ----
  function onPrimary(): void {
    if (mode === 'decrypt') {
      showInfo('解密数据库', '数据库列表与解密导出的后端尚未接入。前端已就绪，待 service 层补齐 listDatabases / decryptDatabase 后即可启用。');
      return;
    }
    if (mode === 'album') {
      if (!albumGroupId) return;
      setLightbox('album');
      return;
    }
    if (convSelection.size === 0) return;
    setLightbox(mode === 'scheduled' ? 'scheduled' : mode === 'chatlab' ? 'chatlab' : 'full');
  }

  async function runFullExport(): Promise<void> {
    const targets = convItems.filter((it) => convSelection.has(it.id));
    if (!isBackendFormat(format)) {
      showInfo(
        '格式待接入',
        `${format.toUpperCase()} 导出的后端尚未接入。已收集 ${targets.length} 个会话的导出配置（时间范围、媒体选项等）。`,
      );
      return;
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
        });
      }
      setConvSelection(new Set());
      setLightbox(null);
      refetchTasks();
    } catch (e) {
      showError('启动导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function onLightboxConfirm(result: LightboxResult): void {
    if (lightbox === 'full') {
      void runFullExport();
      return;
    }
    // chatlab / scheduled / album — config collected, backend pending.
    const detail =
      lightbox === 'scheduled'
        ? `定时任务配置已记录（${result.schedule?.mode === 'daily' ? `每天 ${result.schedule.time}` : `每 ${result.schedule?.intervalHours} 小时`}）。定时调度后端待接入。`
        : lightbox === 'chatlab'
          ? 'ChatLab 导出器后端待接入，已记录本次导出配置。'
          : '群相册导出后端待接入，已记录本次导出配置。';
    setLightbox(null);
    showInfo('配置已记录', detail);
  }

  const activeMode = MODES.find((m) => m.id === mode)!;
  const isConvMode = mode === 'full' || mode === 'chatlab' || mode === 'scheduled';
  const formatOptions = mode === 'chatlab' ? CHATLAB_FORMATS : FULL_FORMATS;

  const primaryLabel =
    mode === 'scheduled'
      ? '新建定时任务'
      : mode === 'album'
        ? '导出相册'
        : mode === 'decrypt'
          ? '解密并导出'
          : mode === 'chatlab'
            ? '导出 ChatLab'
            : '导出';

  const primaryDisabled =
    mode === 'decrypt'
      ? false
      : mode === 'album'
        ? !albumGroupId
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
    lightbox === 'scheduled' ? '新建定时导出任务' : lightbox === 'album' ? '导出群相册' : '导出聊天记录';

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
            {isConvMode ? (
              <ConversationPicker
                items={convItems}
                loading={conversations.isLoading}
                selected={convSelection}
                onChange={setConvSelection}
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
              <SingleSelectPicker
                items={[]}
                loading={false}
                selectedId={null}
                onSelect={() => undefined}
                searchPlaceholder="搜索数据库文件"
                emptyText="未发现数据库"
                hint="数据库目录扫描接口待接入。接入后这里会列出账号数据目录下的全部 .db 文件。"
              />
            )}
          </div>

          <footer className="weq-exp-pane-foot">
            {isConvMode ? (
              <div className="weq-exp-foot-format">
                <span className="weq-exp-foot-label">格式</span>
                <Segmented<ExportFormat> value={format} onChange={setFormat} options={formatOptions} small />
              </div>
            ) : (
              <span className="weq-exp-foot-hint">
                {mode === 'album' ? '选择一个群，下一步选择相册与时间范围' : '选择数据库后导出解密副本'}
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
            showInfo('选择目录', '目录选择接口待接入，开始导出时将使用系统对话框。');
            return null;
          }}
          onClose={() => setLightbox(null)}
          onConfirm={onLightboxConfirm}
        />
      ) : null}
    </div>
  );
}
