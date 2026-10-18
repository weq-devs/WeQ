/**
 * 导出灯箱：在右侧选好对象后弹出，收集本次导出的细项后确认。
 *
 * 重构后是「宽面板 + 分板块」：左侧一列放时间范围、补全选项与图片识别，右侧一列放
 * 导出格式 / 导出内容 / 扩展功能，底部为操作条。所有配置都在本组件内部
 * draft，只有点「开始导出」才回传给父组件。
 *
 * 板块：
 *   1. 时间范围 —— 常驻精简月历，预设区间直接在日历上高亮。
 *   2. 导出格式 —— 多选（至少一种；媒体只导出一份，不会随格式重复）。
 *   3. 导出内容 —— 消息（必选）/ 媒体资源（子选项：图片·语音·视频·文件·
 *      QQ系统表情）/ 头像 / 装扮数据（子选项：气泡·字体·挂件）。
 *   4. 补全选项 —— 补全媒体资源（需在线 QQ + 已选导出媒体）、漫游消息、
 *      本地未缓存的装扮资源。
 *   5. 图片识别 —— 图片文字识别（自动 OCR）、在线识别与并发、筛图模型下载。
 *      单独一栏（左列、补全选项下面）：它不依赖「导出什么」，只跟「跑不跑识别」有关，
 *      而且面板里**只放筛图模型** —— 出文字的识别模型统一在「设置 → 图片识别」里下。
 *   6. 扩展功能 —— 导出后自动保存、语音转写（需已配置转录模型）。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import {
  CalendarClock,
  Check,
  Download,
  FileText,
  Film,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCw,
  ScanText,
  Smile,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { Card, Row, Toggle } from '../../components/settings/controls';
import { client } from '../../trpc/client';
import { useToast } from '../../components/Toast';
import { ocrReadiness, type OcrReadiness } from './preflight';
import { Segmented } from './widgets';
import { TimeRangePicker } from './TimeRangePicker';
import type { CalendarTarget } from '../../lib/messageCalendar';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import {
  DEFAULT_MEDIA_KINDS,
  DEFAULT_OPTIONS,
  DEFAULT_SCHEDULE,
  FRIEND_FORMATS,
  FULL_FORMATS,
  MEDIA_KIND_LABELS,
  MEMBER_FORMATS,
  QZONE_FORMATS,
  type ExportFormat,
  type ExportOptions,
  type MediaKinds,
  type Schedule,
} from './types';

export type LightboxVariant = 'full' | 'guild' | 'qzone' | 'scheduled' | 'album' | 'contacts';

/** 把（可能来自旧预设的）partial 选项补齐成完整 {@link ExportOptions}。 */
function normalizeLightboxOptions(partial?: Partial<ExportOptions>): ExportOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...partial,
    range: { ...DEFAULT_OPTIONS.range, ...partial?.range },
    mediaKinds: { ...DEFAULT_OPTIONS.mediaKinds, ...partial?.mediaKinds },
    dress: { ...DEFAULT_OPTIONS.dress, ...partial?.dress },
    // 在线转录是会话态：每次都要重新点开关 arm，不从持久化预设回填。
    onlineTranscribe: false,
    // 同理：在线识别依赖当下 QQ 在线（离线时开关会被隐藏），不沿用上次的选择。
    onlineOcr: false,
  };
}

export interface LightboxResult {
  saveAsDefault?: boolean;
  /** 灯箱里多选的导出格式（至少一种）。 */
  formats: ExportFormat[];
  options: ExportOptions;
  schedule?: Schedule;
  downloadPath?: string | null;
}

/** 每种媒体子选项的展示图标。 */
const MEDIA_ICONS: Record<keyof MediaKinds, ReactElement> = {
  image: <ImageIcon size={13} />,
  voice: <Mic size={13} />,
  video: <Film size={13} />,
  file: <FileText size={13} />,
  sysface: <Smile size={13} />,
};

/** 补全选项（4.1）的四种媒体。 */
const COMPLETE_KINDS = [
  { key: 'completeMedia' as const, label: '图片' },
  { key: 'downloadPtt' as const, label: '语音' },
  { key: 'downloadVideo' as const, label: '视频' },
  { key: 'downloadFile' as const, label: '文件/群文件' },
];

/** 一个小型多选 chip 组。 */
function KindChips({
  options,
  selected,
  onChange,
  disabled,
}: {
  options: Array<{ key: string; label: ReactNode }>;
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}): ReactElement {
  const multi = useMultiSelection({
    ids: options.map((option) => option.key),
    selected,
    onChange,
    disabled,
  });
  return (
    <div className={`weq-exp-kinds${disabled ? ' is-disabled' : ''}`} {...multi.rootProps}>
      {options.map((opt) => {
        const on = selected.has(opt.key);
        return (
          <button
            key={opt.key}
            type="button"
            className={`weq-exp-kind${on ? ' is-on' : ''}`}
            disabled={disabled}
            {...multi.itemProps(opt.key)}
            aria-pressed={on}
          >
            {on ? <Check size={12} /> : <span className="weq-exp-kind-dot" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 「大按钮」样式的主开关行：图标 + 标题 + 说明 + 开关。 */
function MasterRow({
  icon,
  label,
  desc,
  checked,
  onChange,
  disabled,
  badge,
}: {
  icon: ReactNode;
  label: ReactNode;
  desc?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  badge?: ReactNode;
}): ReactElement {
  return (
    <div className={`weq-exp-master${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
      <span className="weq-exp-master-icon">{icon}</span>
      <span className="weq-exp-master-main">
        <span className="weq-exp-master-label">
          {label}
          {badge ? <span className="weq-exp-master-badge">{badge}</span> : null}
        </span>
        {desc ? <span className="weq-exp-master-desc">{desc}</span> : null}
      </span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/** 补全选项的统一样式行：步骤徽标 + 标题/说明 + 右侧控件（chips 或开关）。 */
function StepRow({
  step,
  title,
  desc,
  control,
  wide,
}: {
  step: string;
  title: ReactNode;
  desc?: ReactNode;
  control: ReactNode;
  /** true = 控件独占下一行（chips 类多选项）。 */
  wide?: boolean;
}): ReactElement {
  return (
    <div className="weq-exp-step-row">
      <div className="weq-exp-step-head">
        <span className="weq-exp-block-step">{step}</span>
        <span className="weq-exp-step-main">
          <span className="weq-exp-step-title">{title}</span>
          {desc ? <span className="weq-exp-step-desc">{desc}</span> : null}
        </span>
        {!wide ? <span className="weq-exp-step-ctrl">{control}</span> : null}
      </div>
      {wide ? <div className="weq-exp-step-wide">{control}</div> : null}
    </div>
  );
}

/**
 * 图片文字识别里的一个模型小行：名字 / 说明 / 体积 + 「下载」按钮或下载进度条。
 * 复用设置页那套 `weq-model*` 样式（同一个应用里的模型卡片长得一样）。
 */
function OcrModelRow({
  name,
  sizeLabel,
  downloaded,
  selected,
  progress,
  disabled,
  onDownload,
}: {
  name: string;
  sizeLabel: string;
  downloaded: boolean;
  selected: boolean;
  /** 正在下载时的进度（0-100 + 字节数），未下载时为 null。 */
  progress: { percent: number; downloadedBytes: number; totalBytes: number } | null;
  disabled: boolean;
  onDownload: () => void;
}): ReactElement {
  const pct = progress ? Math.round(progress.percent) : 0;
  return (
    <div className={`weq-model${selected ? ' is-selected' : ''}`}>
      <div className="weq-model-main">
        <div className="weq-model-head">
          <span className="weq-model-name">{name}</span>
          {downloaded ? <span className="weq-set-badge weq-set-badge-ok">已下载</span> : null}
          {selected ? <span className="weq-set-badge weq-set-badge-ok">当前模型</span> : null}
        </div>
        <span className="weq-model-size weq-number">约 {sizeLabel}</span>
        {progress ? (
          <div className="weq-set-progress">
            <div className="weq-set-progress-track">
              <div className="weq-set-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="weq-set-progress-meta weq-number">
              <span>{pct}%</span>
              <span>
                {fmtMb(progress.downloadedBytes)} / {fmtMb(progress.totalBytes)}
              </span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="weq-model-actions">
        {downloaded ? null : progress ? (
          <button type="button" className="weq-set-btn weq-set-btn-sm" disabled>
            <Loader2 size={12} strokeWidth={2} className="weq-spin" aria-hidden />
            下载中
          </button>
        ) : (
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            onClick={onDownload}
            disabled={disabled}
          >
            <Download size={12} strokeWidth={1.8} aria-hidden />
            下载
          </button>
        )}
      </div>
    </div>
  );
}

/** 字节 → "x.x MB"（下载进度条用）。 */
function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 面板里要显示的一个 OCR 模型（识别 / 筛图各一类）。 */
interface OcrModelRowData {
  id: string;
  kind: 'ocr' | 'filter';
  name: string;
  sizeLabel: string;
  downloaded: boolean;
}

/** 正在下载的 OCR 模型进度。 */
interface OcrModelProgress {
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
}

export function ExportLightbox({
  embedded = false,
  scopeSummary,
  variant,
  headline,
  summary,
  contactScope = 'friends',
  calendarTargets,
  initialOptions,
  initialFormats,
  initialSchedule = DEFAULT_SCHEDULE,
  submitting = false,
  onPickPath,
  onClose,
  onConfirm,
}: {
  embedded?: boolean;
  scopeSummary?: string;
  variant: LightboxVariant;
  headline: string;
  summary: string;
  /** 联系人导出范围（决定灯箱内可选格式：好友含 vCard）。 */
  contactScope?: 'friends' | 'group';
  calendarTargets?: CalendarTarget[];
  /**
   * 回填的上次配置（可能来自持久化预设 —— 旧版本缺 `onlineTranscribe` 等新字段，
   * 也可能是个 partial）。用 {@link normalizeLightboxOptions} 补全默认值。
   */
  initialOptions?: Partial<ExportOptions>;
  /** 上次使用的导出格式；缺失或不在当前变体可选范围内时退回默认格式。 */
  initialFormats?: ExportFormat[];
  initialSchedule?: Schedule;
  submitting?: boolean;
  /** Optional async directory picker; returns the chosen path or null. */
  onPickPath?: () => Promise<string | null>;
  /**
   * 传入后不展示「导出后自动保存」开关，改为展示这句提示 —— 该能力依赖导出页
   * 的任务列表，从聊天页快捷打开灯箱时用不到。
   */
  autoSaveHint?: string;
  onClose: () => void;
  onConfirm: (result: LightboxResult) => void;
}): ReactElement {
  useEscapeToClose(() => {
    if (!embedded) onClose();
  });
  const pushToast = useToast((s) => s.push);
  const [opts, setOpts] = useState<ExportOptions>(() => normalizeLightboxOptions(initialOptions));
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [schedule, setSchedule] = useState<Schedule>(initialSchedule);
  const [path, setPath] = useState<string | null>(null);
  const [pickingPath, setPickingPath] = useState(false);

  // 灯箱打开时探测：QQ 在线实例（4.1 可点击前提）+ 语音转录模型（5.2 前提）。
  const [qqOnline, setQqOnline] = useState<boolean | null>(null);
  const [attachEnabled, setAttachEnabled] = useState<boolean | null>(null);
  const [voiceModelReady, setVoiceModelReady] = useState<boolean | null>(null);
  /** 在线转录 arm 中（点开关时 run）。 */
  const [armingOnline, setArmingOnline] = useState(false);
  /** 图片文字识别的前置状态（在线可用 / 本地模型 / 筛图模型）。 */
  const [ocrReady, setOcrReady] = useState<OcrReadiness | null>(null);
  /** OCR 模型清单（含已选中的模型 id）—— 面板里直接下载用。 */
  const [ocrModels, setOcrModels] = useState<OcrModelRowData[]>([]);
  /** 本机没有可用推理引擎时的原因（如 macOS Intel）—— 非空就不摆下载入口。 */
  const [ocrEngineBlocker, setOcrEngineBlocker] = useState<string | null>(null);
  /** 当前选中的 OCR 模型 id（识别 / 筛图各一个）。 */
  const [ocrSelected, setOcrSelected] = useState<{ ocr: string; filter: string }>({
    ocr: '',
    filter: '',
  });
  /** 正在下载的 OCR 模型进度（key = 模型 id）。 */
  const [ocrProgress, setOcrProgress] = useState<Record<string, OcrModelProgress>>({});
  // 订阅只该建一次；这两个引用会被订阅回调用到，通过 ref 取最新值避免重建订阅。
  const ocrModelsRef = useRef<OcrModelRowData[]>([]);
  ocrModelsRef.current = ocrModels;
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  /** 本次灯箱是否已确认导出 —— 未确认就关闭时把在线转录的抓包收掉。 */
  const submittedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void client.account.getGroupAlbumAccessState.query().then((s) => {
      if (cancelled) return;
      setQqOnline(s.qqOnline);
      setAttachEnabled(s.attachEnabled);
    });
    void ocrReadiness().then((r) => {
      if (!cancelled) setOcrReady(r);
    });
    void (async () => {
      try {
        const [models, settings] = await Promise.all([
          client.bootstrap.ocrModels.query(),
          client.bootstrap.getSettings.query(),
        ]);
        if (cancelled) return;
        setOcrEngineBlocker(models.engineBlocker);
        setOcrModels(
          models.models
            // 面板里只放**筛图**模型：它是在线 / 离线共有的前置步骤，下不下都不影响
            // 「有没有在识别」这件事。出文字那份识别模型只在「设置 → 图片识别」里下 ——
            // 放在这里会让人以为「下了它就能纯离线跑」，从而把在线开关的逻辑搅乱。
            .filter((m) => m.kind === 'filter')
            .map((m) => ({
              id: m.id,
              kind: m.kind as 'ocr' | 'filter',
              name: m.name,
              sizeLabel: m.sizeLabel,
              downloaded: m.downloaded,
            })),
        );
        setOcrSelected({
          ocr: settings.ocr.modelId,
          filter: settings.ocr.filterModelId,
        });
      } catch {
        /* 模型清单读不到就不显示下载区 */
      }
    })();
    void (async () => {
      try {
        const settings = await client.bootstrap.getSettings.query();
        const modelId = settings.voiceTranscribe.modelId;
        if (!modelId) {
          if (!cancelled) setVoiceModelReady(false);
          return;
        }
        const models = await client.bootstrap.voiceModels.query();
        const model = models.find((m) => m.id === modelId);
        if (!cancelled) setVoiceModelReady(Boolean(model?.downloaded));
      } catch {
        if (!cancelled) setVoiceModelReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 灯箱关闭时若没确认导出、却开着在线转录 —— 把抓包会话收掉，别留个 root 抓包在后台。
  useEffect(() => {
    return () => {
      if (submittedRef.current) return;
      void client.account.onlineTranscribeDisarm.mutate().catch(() => undefined);
    };
  }, []);

  // OCR 模型下载进度（与设置页同一个订阅流）：下完就**顺手设为当前模型**，
  // 用户点「下载」即完成「下载 + 选用」两步（没有模型的场景就是奔着这个来的）。
  useEffect(() => {
    const sub = client.bootstrap.onOcrModelProgress.subscribe(undefined, {
      onData: (p) => {
        if (p.done) {
          setOcrProgress((prev) => {
            const next = { ...prev };
            delete next[p.id];
            return next;
          });
          const model = ocrModelsRef.current.find((m) => m.id === p.id);
          void (async () => {
            try {
              if (model)
                await client.bootstrap.setOcrModel.mutate({ kind: model.kind, modelId: p.id });
              const [models, readiness] = await Promise.all([
                client.bootstrap.ocrModels.query(),
                ocrReadiness(),
              ]);
              setOcrEngineBlocker(models.engineBlocker);
              setOcrModels(
                models.models
                  .filter((m) => m.kind === 'filter')
                  .map((m) => ({
                    id: m.id,
                    kind: m.kind as 'ocr' | 'filter',
                    name: m.name,
                    sizeLabel: m.sizeLabel,
                    downloaded: m.downloaded,
                  })),
              );
              setOcrReady(readiness);
            } catch (e) {
              pushToastRef.current({
                tone: 'error',
                title: '模型选用失败',
                detail: e instanceof Error ? e.message : String(e),
                ttl: 6000,
              });
            }
          })();
          return;
        }
        if (p.error) {
          setOcrProgress((prev) => {
            const next = { ...prev };
            delete next[p.id];
            return next;
          });
          pushToastRef.current({
            tone: 'error',
            title: '模型下载失败',
            detail: p.error,
            ttl: 6000,
          });
          return;
        }
        setOcrProgress((prev) => ({
          ...prev,
          [p.id]: {
            percent: p.percent,
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes,
          },
        }));
      },
      onError: (err) => console.error('[ocr] progress subscription error', err),
    });
    return () => sub.unsubscribe();
  }, []);

  /**
   * 在面板里下载一个筛图模型（下完自动设为当前模型）。
   *
   * 只认 `filter`：出文字的识别模型**不给在导出面板下载**（那会让人以为"下了就能纯离线"，
   * 而它其实是「在线拿不到时的兜底」，该在「设置 → 图片识别」里单独决定），所以这里
   * 兜一层 —— 万一哪天 UI 漏了一行，也不会从面板把那份模型拖下来。
   */
  async function downloadOcrModel(id: string): Promise<void> {
    const model = ocrModelsRef.current.find((m) => m.id === id);
    if (model && model.kind !== 'filter') {
      pushToast({
        tone: 'warning',
        title: '识别模型请在设置页下载',
        detail: '导出面板只提供筛图模型；出文字的识别模型在「设置 → 图片识别」里下载。',
        ttl: 6000,
      });
      return;
    }
    try {
      setOcrProgress((prev) => ({
        ...prev,
        [id]: { percent: 0, downloadedBytes: 0, totalBytes: 0 },
      }));
      await client.bootstrap.downloadOcrModel.mutate({ id });
    } catch (e) {
      setOcrProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      pushToast({
        tone: 'error',
        title: '启动下载失败',
        detail: e instanceof Error ? e.message : String(e),
        ttl: 6000,
      });
    }
  }

  const isAlbum = variant === 'album';
  const isQzone = variant === 'qzone';
  const isGuild = variant === 'guild';
  const isScheduled = variant === 'scheduled';
  const isContacts = variant === 'contacts';
  const isMessageFlow = !isAlbum && !isQzone && !isContacts;

  /** 该变体可选的格式。 */
  const formatOptions = useMemo(
    () =>
      variant === 'qzone'
        ? QZONE_FORMATS
        : variant === 'contacts'
          ? contactScope === 'friends'
            ? FRIEND_FORMATS
            : MEMBER_FORMATS
          : FULL_FORMATS,
    [variant, contactScope],
  );
  const [formats, setFormats] = useState<ExportFormat[]>(() => {
    const allowed = initialFormats?.filter((f) => formatOptions.some((o) => o.value === f));
    return allowed && allowed.length > 0 ? allowed : [formatOptions[0]!.value];
  });

  /** QQ 空间 HTML 导出靠本地配图 + 评论/点赞渲染：选中 HTML 时锁定
   *  「下载配图」与「评论与点赞」为开。 */
  const htmlForced = isQzone && formats.includes('html');

  function patch(next: Partial<ExportOptions>): void {
    setOpts((o) => ({ ...o, ...next }));
  }

  // 切到 HTML 时自动补开配图下载 + 评论/点赞拉取，避免产出渲染不全的 html。
  useEffect(() => {
    if (!htmlForced) return;
    setOpts((o) => ({ ...o, exportMedia: true, qzoneInteractions: true }));
  }, [htmlForced]);

  /**
   * 开关在线转录：开启前先 arm 抓包会话（Windows 缺 Npcap / 未提权 / 离线都会
   * 抛错，这里弹 toast 提示）。只有 arm 成功才置 true —— 保证后续导出可在线转写。
   */
  async function toggleOnlineTranscribe(v: boolean): Promise<void> {
    if (!v) {
      patch({ onlineTranscribe: false });
      void client.account.onlineTranscribeDisarm.mutate().catch(() => undefined);
      return;
    }
    setArmingOnline(true);
    try {
      const support = await client.wonderfulTools.captureSupport.query();
      if (!support.available) {
        pushToast({
          tone: 'warning',
          title: '抓包后端不可用',
          detail: support.hint || '在线转录需要能抓本机网卡（Windows 需安装 Npcap）。',
          ttl: 6000,
        });
        return;
      }
      await client.account.onlineTranscribeArm.mutate({});
      patch({ onlineTranscribe: true });
      pushToast({ tone: 'success', title: '在线转录已开启', ttl: 2600 });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '在线转录开启失败',
        detail: e instanceof Error ? e.message : String(e),
        ttl: 6000,
      });
    } finally {
      setArmingOnline(false);
    }
  }

  async function pickPath(): Promise<void> {
    if (!onPickPath) return;
    setPickingPath(true);
    try {
      const chosen = await onPickPath();
      if (chosen) setPath(chosen);
    } finally {
      setPickingPath(false);
    }
  }

  function confirm(): void {
    submittedRef.current = true;
    onConfirm({
      saveAsDefault,
      formats,
      options: opts,
      schedule: isScheduled ? schedule : undefined,
      downloadPath: isAlbum ? path : undefined,
    });
  }

  const selectedMediaKinds = new Set(
    (Object.keys(MEDIA_KIND_LABELS) as Array<keyof MediaKinds>).filter((k) => opts.mediaKinds[k]),
  );
  const selectedDressKinds = new Set(
    ['bubble', 'font', 'widget'].filter((k) => opts.dress[k as keyof typeof opts.dress]),
  );
  const hasDress = opts.dress.bubble || opts.dress.font || opts.dress.widget;
  const selectedCompleteKinds = new Set(
    COMPLETE_KINDS.filter((c) => opts[c.key]).map((c) => c.key),
  );
  /** ChatLab 只支持 JSON / JSONL。 */
  const chatlabAllowed = formats.every((f) => f === 'json' || f === 'jsonl');

  function toggleChatlab(v: boolean): void {
    if (v) {
      // 开启 ChatLab 时只保留 json / jsonl（优先 json）。
      const kept = formats.filter((f) => f === 'json' || f === 'jsonl');
      setFormats(kept.length > 0 ? kept : ['json']);
      patch({ chatlab: true });
    } else {
      patch({ chatlab: false });
    }
  }
  const formatSelection = useMultiSelection({
    ids: formatOptions
      .filter((format) => !opts.chatlab || format.value === 'json' || format.value === 'jsonl')
      .map((format) => format.value),
    selected: new Set(formats),
    disabled: submitting,
    onChange: (next) => {
      if (!next.size) {
        setFormats((current) => [...current]);
        pushToast({ tone: 'warning', title: '至少保留一种导出格式', ttl: 3200 });
        return;
      }
      setFormats(formatOptions.map((format) => format.value).filter((value) => next.has(value)));
    },
    onExit: onClose,
  });

  return (
    <div
      className={embedded ? 'weq-export-options' : 'modal-scrim weq-exp-modal-scrim'}
      role="presentation"
      onMouseDown={embedded ? undefined : closeFromScrim(onClose)}
    >
      <section
        className="weq-exp-dialog is-wide"
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-exp-dialog-head">
          <div className="weq-exp-dialog-title">
            <strong>{headline}</strong>
            <span title={summary}>{summary}</span>
          </div>
          <label>
            <input
              type="checkbox"
              checked={saveAsDefault}
              onChange={(event) => setSaveAsDefault(event.target.checked)}
            />
            设为此类内容的默认配置
          </label>
          <button type="button" className="weq-exp-dialog-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-exp-dialog-body">
          {isAlbum ? (
            <div className="weq-exp-album-pane">
              <Card title="下载目录">
                <Row
                  label={
                    <span className="weq-exp-path" title={path ?? undefined}>
                      <FolderOpen size={14} aria-hidden />
                      <span className="weq-exp-path-txt">{path ?? '未选择，开始导出时选择'}</span>
                    </span>
                  }
                  control={
                    <button
                      type="button"
                      className="weq-exp-btn"
                      disabled={pickingPath}
                      onClick={() => void pickPath()}
                    >
                      {pickingPath ? (
                        <Loader2 size={14} className="weq-exp-spin" />
                      ) : (
                        <FolderOpen size={14} />
                      )}
                      选择目录
                    </button>
                  }
                />
              </Card>

              <Card title="相册选择">
                <div className="weq-exp-placeholder">
                  <span>相册列表将从群空间加载</span>
                  <small>该接口尚未接入，目前默认导出全部相册</small>
                </div>
              </Card>

              <Card title="时间范围">
                <TimeRangePicker
                  value={opts.range}
                  onChange={(range) => patch({ range })}
                  mode="single"
                />
              </Card>
            </div>
          ) : (
            <>
              {/* 左列：时间范围 + 补全选项 */}
              <div className="weq-exp-col">
                {!isContacts ? (
                  <Card
                    title={
                      scopeSummary
                        ? isQzone
                          ? '精确说说范围'
                          : isContacts
                            ? '精确联系人范围'
                            : '精确消息范围'
                        : '时间范围'
                    }
                  >
                    {scopeSummary ? (
                      <p>{scopeSummary}</p>
                    ) : (
                      <TimeRangePicker
                        value={opts.range}
                        onChange={(range) => patch({ range })}
                        mode={isScheduled ? 'scheduled' : 'single'}
                        calendarTargets={calendarTargets}
                      />
                    )}
                  </Card>
                ) : (
                  <Card title="导出联系人">
                    <div className="weq-exp-placeholder">
                      <span>导出好友列表 / 群成员列表（QQ号、昵称、备注、分组、角色等）</span>
                      <small>
                        数据来自本地资料库，无需在线 QQ。开启「导出头像」后，头像存入同目录 avatars/
                        子文件夹（导出结果保存为文件夹）。
                      </small>
                    </div>
                  </Card>
                )}

                {/* 补全选项（仅完整消息 / 定时；空间/联系人/相册无消息补全维度） */}
                {isMessageFlow ? (
                  <Card title="补全选项">
                    <StepRow
                      step="4.1"
                      title="补全缺失的媒体资源"
                      desc={
                        !opts.exportMedia || !qqOnline
                          ? !opts.exportMedia
                            ? '需先开启「导出内容 → 媒体资源」'
                            : qqOnline === null
                              ? '正在检查 QQ 在线状态…'
                              : '需登录在线 QQ 实例后可用'
                          : '本地缓存缺失时从云端补齐'
                      }
                      control={
                        <KindChips
                          options={COMPLETE_KINDS}
                          selected={selectedCompleteKinds}
                          onChange={(next) =>
                            patch({
                              completeMedia: next.has('completeMedia'),
                              downloadPtt: next.has('downloadPtt'),
                              downloadVideo: next.has('downloadVideo'),
                              downloadFile: next.has('downloadFile'),
                            })
                          }
                          disabled={!opts.exportMedia || !qqOnline}
                        />
                      }
                      wide
                    />
                    <StepRow
                      step="4.2"
                      title={isGuild ? '拉取漫游消息' : '补充拉取的漫游消息'}
                      desc={
                        isGuild
                          ? '频道私聊仅导出本机已有的消息记录，不支持漫游消息拉取'
                          : '扫描本地缓存中的漫游消息一并导出（未在线时也会读取缓存数据库）'
                      }
                      control={
                        <Toggle
                          checked={isGuild ? false : opts.completeMessages}
                          disabled={isGuild}
                          onChange={(v) => patch({ completeMessages: v })}
                        />
                      }
                    />
                    <StepRow
                      step="4.3"
                      title="下载本地未缓存的装扮资源"
                      desc={
                        !hasDress
                          ? '需先在「导出内容 → 装扮数据」勾选类别'
                          : '装扮导出时在线补齐缺失资源（关闭则只导出已缓存的部分）'
                      }
                      control={
                        <Toggle
                          checked={opts.completeDress}
                          disabled={!hasDress}
                          onChange={(v) => patch({ completeDress: v })}
                        />
                      }
                    />
                  </Card>
                ) : null}

                {/* 图片文字识别 —— 独立一栏，跟「补全选项」并列（不再塞在「扩展功能」里） */}
                {isMessageFlow ? (
                  <Card title="图片识别">
                    <Row
                      label="图片文字识别"
                      desc={
                        ocrReady && !ocrReady.localReady && !ocrReady.onlineCapable
                          ? ocrReady.localEngineBlocker ||
                            '需要在线 QQ，或先在「设置 → 图片识别」下好本地识别模型'
                          : '识别图片里的文字，写出 ocr.json（含像素坐标框）并把文字回写进导出文件'
                      }
                      control={
                        <Toggle
                          checked={opts.ocrImages}
                          disabled={Boolean(
                            ocrReady && !ocrReady.localReady && !ocrReady.onlineCapable,
                          )}
                          onChange={(v) =>
                            patch({ ocrImages: v, ...(v ? {} : { onlineOcr: false }) })
                          }
                        />
                      }
                    />
                    {opts.ocrImages ? (
                      <>
                        {ocrReady?.onlineCapable ? (
                          <Row
                            label="在线识别"
                            desc={
                              opts.onlineOcr
                                ? '已就绪：优先让 QQ 服务端识别（更快），没拿到的回退本地模型'
                                : '优先让 QQ 服务端识别（需保持 QQ 在线；连续失败会自动回退本地模型）'
                            }
                            control={
                              <Toggle
                                checked={opts.onlineOcr}
                                onChange={(v) => patch({ onlineOcr: v })}
                              />
                            }
                          />
                        ) : null}
                        {opts.onlineOcr ? (
                          <Row
                            label="识别并发"
                            desc="同时向 QQ 服务端发起的识别请求数"
                            control={
                              <span className="weq-exp-num">
                                <input
                                  type="number"
                                  min={1}
                                  max={32}
                                  value={opts.ocrConcurrency}
                                  onChange={(e) =>
                                    patch({
                                      ocrConcurrency: Math.max(
                                        1,
                                        Math.min(32, Number(e.target.value) || 1),
                                      ),
                                    })
                                  }
                                />
                              </span>
                            }
                          />
                        ) : null}
                        {ocrReady && !ocrReady.localReady && !ocrEngineBlocker ? (
                          <p className="weq-exp-block-hint">
                            没下本地识别模型：在线那条腿拿不到的图不会回退，可能会少字。识别模型在
                            「设置 → 图片识别」里下载。
                          </p>
                        ) : null}
                        <div className="weq-exp-ocr-models">
                          <p className="weq-exp-block-hint">
                            <ScanText size={12} aria-hidden />{' '}
                            {ocrEngineBlocker ??
                              (ocrReady?.filterReady
                                ? '已开启预筛选：先用超轻量模型甩掉没有文字的图，快很多。'
                                : '建议下载筛图模型（1.7 MB）：先甩掉风景 / 人像这类没有文字的图，识别会快很多。')}
                          </p>
                          {ocrEngineBlocker
                            ? null
                            : ocrModels.map((m) => (
                                <OcrModelRow
                                  key={m.id}
                                  name={`${m.name}（筛图）`}
                                  sizeLabel={m.sizeLabel}
                                  downloaded={m.downloaded}
                                  selected={ocrSelected.filter === m.id}
                                  progress={ocrProgress[m.id] ?? null}
                                  disabled={Boolean(ocrProgress[m.id])}
                                  onDownload={() => void downloadOcrModel(m.id)}
                                />
                              ))}
                          {ocrEngineBlocker ? null : (
                            <p className="weq-exp-block-hint">
                              「筛图」只判断图里有没有文字（识别前先筛一遍）；不下载也能识别，只是每张图
                              都会跑一遍识别模型。下载完成会自动设为当前模型。出文字的**识别模型**在
                              「设置 →
                              图片识别」里下载：它是在线拿不到时的兜底，两条腿的逻辑不放在这里选。
                            </p>
                          )}
                        </div>
                      </>
                    ) : null}
                  </Card>
                ) : null}
              </div>

              {/* 右列：格式 + 内容 + 扩展 */}
              <div className="weq-exp-col">
                {isQzone ? (
                  <Card title="QQ 空间导出">
                    <div className="weq-exp-placeholder">
                      <span>
                        导出该空间的说说（内容 / 时间 / 评论数 / 配图 / 视频；可选导出自己）
                      </span>
                      <small>
                        需登录该账号的 QQ 客户端。配图与视频存入 media/；HTML
                        格式会强制下载媒体并本地引用（离线可看）；评论与点赞从动态页解析，仅覆盖翻到的动态，可能不全。
                      </small>
                    </div>
                  </Card>
                ) : null}

                {/* 导出格式（多选；相册的格式仍走外部选择器） */}
                {!isAlbum ? (
                  <Card title="导出格式">
                    <div className="weq-exp-format-grid" {...formatSelection.rootProps}>
                      {formatOptions.map((f) => {
                        const on = formats.includes(f.value);
                        const blocked = opts.chatlab && f.value !== 'json' && f.value !== 'jsonl';
                        return (
                          <button
                            key={f.value}
                            type="button"
                            className={`weq-exp-format${on ? ' is-on' : ''}${blocked ? ' is-blocked' : ''}`}
                            {...formatSelection.itemProps(f.value, blocked)}
                            aria-pressed={on}
                            disabled={blocked}
                          >
                            {on ? <Check size={13} /> : null}
                            {f.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="weq-exp-block-hint">
                      {isMessageFlow
                        ? '多选时每个格式各产出一份消息文件，媒体资源只导出一份，不会重复。'
                        : '多选时每个格式各产出一份文件。'}
                    </p>
                  </Card>
                ) : null}

                {/* 导出内容 */}
                {!isAlbum ? (
                  <Card title="导出内容">
                    {isQzone ? (
                      <>
                        <MasterRow
                          icon={<ImageIcon size={17} />}
                          label="下载媒体（配图 / 视频）"
                          desc={
                            htmlForced
                              ? 'HTML 导出需要本地媒体，已随格式强制开启'
                              : '说说正文始终导出；配图与视频开启后存入 media/ 子目录'
                          }
                          checked={opts.exportMedia}
                          disabled={htmlForced}
                          onChange={(v) => patch({ exportMedia: v })}
                        />
                        <MasterRow
                          icon={<Heart size={17} />}
                          label="评论与点赞"
                          desc={
                            htmlForced
                              ? 'HTML 导出包含评论与点赞，已随格式强制开启'
                              : '按说说逐条补拉评论（含回复）与点赞用户，写进导出文件（尽力而为，可能不全）'
                          }
                          checked={htmlForced || opts.qzoneInteractions}
                          disabled={htmlForced}
                          onChange={(v) => patch({ qzoneInteractions: v })}
                        />
                      </>
                    ) : isContacts ? (
                      <MasterRow
                        icon={<UserRound size={17} />}
                        label="头像"
                        desc="联系人头像存入 avatars/ 子目录"
                        checked={opts.exportAvatar}
                        onChange={(v) => patch({ exportAvatar: v })}
                      />
                    ) : (
                      <>
                        <MasterRow
                          icon={<MessageSquare size={17} />}
                          label="消息"
                          desc="聊天记录正文（必选，始终导出）"
                          checked
                          disabled
                          onChange={() => undefined}
                          badge="必选"
                        />
                        <MasterRow
                          icon={<ImageIcon size={17} />}
                          label="媒体资源"
                          desc="图片 / 语音 / 视频 / 文件 / QQ系统表情"
                          checked={opts.exportMedia}
                          onChange={(v) => {
                            patch({
                              exportMedia: v,
                              // 开启时默认全选子类；关闭时清空。
                              mediaKinds: v
                                ? { ...DEFAULT_MEDIA_KINDS }
                                : {
                                    image: false,
                                    voice: false,
                                    video: false,
                                    file: false,
                                    sysface: false,
                                  },
                            });
                          }}
                        />
                        {opts.exportMedia ? (
                          <div className="weq-exp-kinds-wrap">
                            <KindChips
                              options={(
                                Object.keys(MEDIA_KIND_LABELS) as Array<keyof MediaKinds>
                              ).map((k) => ({
                                key: k,
                                label: (
                                  <>
                                    {MEDIA_ICONS[k]}
                                    {MEDIA_KIND_LABELS[k]}
                                  </>
                                ),
                              }))}
                              selected={selectedMediaKinds}
                              onChange={(next) =>
                                patch({
                                  mediaKinds: {
                                    image: next.has('image'),
                                    voice: next.has('voice'),
                                    video: next.has('video'),
                                    file: next.has('file'),
                                    sysface: next.has('sysface'),
                                  },
                                })
                              }
                            />
                          </div>
                        ) : null}

                        <MasterRow
                          icon={<UserRound size={17} />}
                          label="头像"
                          desc="发送者头像存入 avatars/ 子目录"
                          checked={opts.exportAvatar}
                          onChange={(v) => patch({ exportAvatar: v })}
                        />

                        <MasterRow
                          icon={<Sparkles size={17} />}
                          label="装扮数据"
                          desc="气泡 / 字体 / 挂件（仅会话实际使用到的款）"
                          checked={opts.dress.bubble || opts.dress.font || opts.dress.widget}
                          onChange={(v) =>
                            patch({
                              dress: v
                                ? { bubble: true, font: true, widget: true }
                                : { bubble: false, font: false, widget: false },
                            })
                          }
                        />
                        {opts.dress.bubble || opts.dress.font || opts.dress.widget ? (
                          <div className="weq-exp-kinds-wrap">
                            <KindChips
                              options={[
                                { key: 'bubble', label: '气泡' },
                                { key: 'font', label: '字体' },
                                { key: 'widget', label: '挂件' },
                              ]}
                              selected={selectedDressKinds}
                              onChange={(next) =>
                                patch({
                                  dress: {
                                    bubble: next.has('bubble'),
                                    font: next.has('font'),
                                    widget: next.has('widget'),
                                  },
                                })
                              }
                            />
                          </div>
                        ) : null}
                      </>
                    )}
                  </Card>
                ) : null}

                {/* 扩展功能 */}
                {isMessageFlow ? (
                  <Card title="扩展功能">
                    <Row
                      label="语音转写"
                      desc={
                        voiceModelReady === false
                          ? '需先在「设置 → 语音转录」下载并选择模型'
                          : '将语音消息转录为文字一并保存'
                      }
                      control={
                        <Toggle
                          checked={opts.transcribeVoice}
                          disabled={voiceModelReady === false}
                          onChange={(v) => patch({ transcribeVoice: v })}
                        />
                      }
                    />
                    {opts.transcribeVoice && qqOnline && attachEnabled ? (
                      <Row
                        label="在线转录"
                        desc={
                          opts.onlineTranscribe
                            ? '已就绪：优先用 QQ 服务端转写，漏包 / 过期回退本地'
                            : '优先用 QQ 服务端转写（需保持 QQ 在线）'
                        }
                        control={
                          <Toggle
                            checked={opts.onlineTranscribe}
                            disabled={armingOnline}
                            onChange={(v) => void toggleOnlineTranscribe(v)}
                          />
                        }
                      />
                    ) : null}
                    {opts.transcribeVoice && opts.onlineTranscribe ? (
                      <Row
                        label="转录并发"
                        desc="同时向 QQ 发起的转写请求数"
                        control={
                          <span className="weq-exp-num">
                            <input
                              type="number"
                              min={1}
                              max={32}
                              value={opts.onlineConcurrency}
                              onChange={(e) =>
                                patch({
                                  onlineConcurrency: Math.max(
                                    1,
                                    Math.min(32, Number(e.target.value) || 1),
                                  ),
                                })
                              }
                            />
                          </span>
                        }
                      />
                    ) : null}
                    <Row
                      label="ChatLab 格式"
                      desc={
                        chatlabAllowed
                          ? '导出为 ChatLab 交换格式（成员 / 角色 / 消息已标准化）'
                          : '仅支持 JSON / JSONL 格式'
                      }
                      control={
                        <Toggle
                          checked={opts.chatlab}
                          disabled={!chatlabAllowed}
                          onChange={(v) => toggleChatlab(v)}
                        />
                      }
                    />
                  </Card>
                ) : null}

                {/* 定时设置 */}
                {isScheduled ? (
                  <Card title="定时设置">
                    <Segmented
                      value={schedule.mode}
                      onChange={(mode) =>
                        setSchedule((s) => ({ ...s, mode: mode as Schedule['mode'] }))
                      }
                      options={[
                        { value: 'daily', label: '每天定时', icon: <CalendarClock size={13} /> },
                        { value: 'interval', label: '间隔执行', icon: <RefreshCw size={13} /> },
                      ]}
                    />
                    {schedule.mode === 'daily' ? (
                      <Row
                        label="执行时间"
                        desc="每天到点自动导出一次"
                        control={
                          <span className="weq-exp-num">
                            <CalendarClock size={14} aria-hidden />
                            <input
                              type="time"
                              value={schedule.time}
                              onChange={(e) => setSchedule((s) => ({ ...s, time: e.target.value }))}
                            />
                          </span>
                        }
                      />
                    ) : (
                      <Row
                        label="执行间隔"
                        desc="每隔指定小时数自动导出一次"
                        control={
                          <span className="weq-exp-num">
                            <span>每</span>
                            <input
                              type="number"
                              min={1}
                              max={168}
                              value={schedule.intervalHours}
                              onChange={(e) =>
                                setSchedule((s) => ({
                                  ...s,
                                  intervalHours: Math.max(1, Number(e.target.value) || 1),
                                }))
                              }
                            />
                            <span>小时</span>
                          </span>
                        }
                      />
                    )}
                  </Card>
                ) : null}
              </div>
            </>
          )}
        </div>

        <footer className="weq-exp-dialog-foot">
          <span className="weq-exp-dialog-foot-note">
            {isMessageFlow
              ? `${formats.length} 种格式${opts.exportMedia ? ' · 含媒体' : ''}${opts.exportAvatar ? ' · 头像' : ''}${
                  opts.dress.bubble || opts.dress.font || opts.dress.widget ? ' · 装扮' : ''
                }`
              : isQzone
                ? `${formats.length} 种格式${opts.exportMedia ? ' · 含配图' : ''}${opts.qzoneInteractions ? ' · 含评论/赞' : ''}`
                : isContacts
                  ? `${formats.length} 种格式${opts.exportAvatar ? ' · 含头像' : ''}`
                  : null}
          </span>
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="weq-exp-btn is-primary"
            onClick={confirm}
            disabled={submitting}
          >
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            {isScheduled ? '创建定时任务' : '开始导出'}
          </button>
        </footer>
      </section>
    </div>
  );
}
