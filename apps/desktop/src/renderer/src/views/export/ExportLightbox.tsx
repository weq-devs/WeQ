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
 *   5. 图片识别 —— 图片文字识别（自动 OCR）、在线识别；模型与并发统一在设置调整。
 *   6. 扩展功能 —— 导出后自动保存、语音转写（需已配置转录模型）。
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import { usePageState } from '../../components/PageSnapshots';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import {
  CalendarClock,
  Check,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Loader2,
  ListFilter,
  RefreshCw,
  UserRound,
  Undo2,
  X,
  ShieldAlert,
} from 'lucide-react';
import { Card, Row, Toggle } from '../../components/settings/controls';
import { client } from '../../trpc/client';
import { useDialog } from '../../components/Dialog';
import { ocrReadiness, type OcrReadiness } from './preflight';
import { useExportAuthorization, type ExportAuthorizationIndicatorState } from './authorization';
import { BaselinePicker } from './BaselinePicker';
import { useRemoteClient } from '../../lib/remoteClient';
import { ExportReportControl } from './ExportReportControl';
import {
  BusinessExportDetails,
  ExportFormatHint,
  structuredExportOptions,
} from './StructuredExportControls';
import { ExportContentSelector } from './ExportContentSelector';
import {
  normalizeExportContent,
  exportContentFlags,
  hasExportContent,
  hasExportResources,
  requiresStructuredExport,
  addedStructuredContent,
  withoutStructuredContent,
  type ExportContentPolicy,
} from '@weq/service/export-content';
import { exportContentPolicyInput } from '../../../../shared/export_content';
import '../../styles/chat-export-continuation.css';
import { Segmented } from './widgets';
import { TimeRangePicker } from './TimeRangePicker';
import type { CalendarTarget } from '../../lib/messageCalendar';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import {
  DEFAULT_OPTIONS,
  DEFAULT_SCHEDULE,
  FRIEND_FORMATS,
  FULL_FORMATS,
  MEMBER_FORMATS,
  QZONE_FORMATS,
  type ExportFormat,
  type ExportOptions,
  type Schedule,
} from './types';

export type LightboxVariant = 'full' | 'guild' | 'qzone' | 'scheduled' | 'album' | 'contacts';

/** 把（可能来自旧预设的）partial 选项补齐成完整 {@link ExportOptions}。 */
function normalizeLightboxOptions(partial?: Partial<ExportOptions>): ExportOptions {
  const options = {
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
  const content = normalizeExportContent(options.content, options);
  return { ...options, profile: 'full', content, ...exportContentFlags(content) };
}

export interface LightboxResult {
  authorization?: { commit: () => void; cancel: () => void };
  baselineDirectory?: string;
  baselineByConversation?: Record<string, string>;
  saveAsDefault?: boolean;
  /** 灯箱里多选的导出格式（至少一种）。 */
  formats: ExportFormat[];
  options: ExportOptions;
  schedule?: Schedule;
  downloadPath?: string | null;
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
      <Toggle
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        label={typeof label === 'string' ? label : undefined}
      />
    </div>
  );
}

const optionsSnapshot = z.object({
  content: exportContentPolicyInput.optional(),
  exportMessages: z.boolean().optional(),
  completeAvatar: z.boolean().optional(),
  completeDressKinds: z
    .object({ bubble: z.boolean(), font: z.boolean(), widget: z.boolean() })
    .optional(),
  profile: z.enum(['basic', 'full']).optional(),
  extra: z
    .object({
      qzoneInteractions: z.boolean(),
      collectionProperties: z.boolean(),
      mailProperties: z.boolean(),
      generatedParameters: z.boolean(),
      directoryProperties: z.boolean(),
      resourceProperties: z.boolean(),
    })
    .partial()
    .optional(),
  incrementalSupport: z.boolean().optional(),
  includeIntegrityReport: z.boolean().optional(),
  range: z.object({
    preset: z.enum(['all', 'today', '7d', '30d', '1y', 'custom']),
    start: z.number().nullable(),
    end: z.number().nullable(),
  }),
  mediaKinds: z.object({
    image: z.boolean(),
    voice: z.boolean(),
    video: z.boolean(),
    file: z.boolean(),
    sysface: z.boolean(),
  }),
  dress: z.object({ bubble: z.boolean(), font: z.boolean(), widget: z.boolean() }),
  exportMedia: z.boolean(),
  qzoneInteractions: z.boolean(),
  qzonePosts: z.boolean().optional(),
  qzoneAlbums: z.boolean().optional(),
  completeMessages: z.boolean(),
  exportAvatar: z.boolean(),
  completeMedia: z.boolean(),
  downloadVideo: z.boolean(),
  downloadFile: z.boolean(),
  downloadPtt: z.boolean(),
  completeDress: z.boolean(),
  transcribeVoice: z.boolean(),
  onlineTranscribe: z.boolean(),
  onlineConcurrency: z.number(),
  ocrImages: z.boolean(),
  onlineOcr: z.boolean(),
  ocrConcurrency: z.number(),
  autoSave: z.boolean(),
  chatlab: z.boolean(),
});

export function ExportLightbox({
  embedded = false,
  hidden = false,
  onEditList,
  scopeSummary,
  variant,
  headline,
  summary,
  contactScope = 'friends',
  qzoneContent,
  calendarTargets,
  initialOptions,
  initialFormats,
  initialBaselineDirectory,
  initialSchedule = DEFAULT_SCHEDULE,
  submitting = false,
  disabled = false,
  onPickPath,
  onClose,
  onConfirm,
  onAuthorizationChange,
}: {
  embedded?: boolean;
  hidden?: boolean;
  onEditList?: () => void;
  scopeSummary?: string;
  variant: LightboxVariant;
  headline: string;
  summary: string;
  /** 联系人导出范围（决定灯箱内可选格式：好友含 vCard）。 */
  contactScope?: 'friends' | 'group' | 'groups';
  qzoneContent?: import('./types').QzoneExportContent;
  calendarTargets?: CalendarTarget[];
  /**
   * 回填的上次配置（可能来自持久化预设 —— 旧版本缺 `onlineTranscribe` 等新字段，
   * 也可能是个 partial）。用 {@link normalizeLightboxOptions} 补全默认值。
   */
  initialOptions?: Partial<ExportOptions>;
  /** 上次使用的导出格式；缺失或不在当前变体可选范围内时退回默认格式。 */
  initialFormats?: ExportFormat[];
  initialBaselineDirectory?: string;
  initialSchedule?: Schedule;
  submitting?: boolean;
  disabled?: boolean;
  /** Optional async directory picker; returns the chosen path or null. */
  onPickPath?: () => Promise<string | null>;
  /**
   * 传入后不展示「导出后自动保存」开关，改为展示这句提示 —— 该能力依赖导出页
   * 的任务列表，从聊天页快捷打开灯箱时用不到。
   */
  autoSaveHint?: string;
  onClose: () => void;
  onConfirm: (result: LightboxResult) => void;
  onAuthorizationChange?: (state: ExportAuthorizationIndicatorState | null) => void;
}): ReactElement {
  const remote = useRemoteClient();
  useEscapeToClose(() => {
    if (!embedded && !hidden) onClose();
  });
  const [opts, setOpts] = usePageState<ExportOptions>(
    `export:options:${variant}:${contactScope}`,
    () => {
      const value = normalizeLightboxOptions(initialOptions);
      return contactScope === 'groups' ? { ...value, exportAvatar: false } : value;
    },
    optionsSnapshot,
    true,
  );
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [requestingFormat, setRequestingFormat] = useState(false);
  const confirmDialog = useDialog((state) => state.confirm);
  const [schedule, setSchedule] = usePageState<Schedule>(
    `export:schedule:${variant}`,
    initialSchedule,
    z.object({ mode: z.enum(['daily', 'interval']), time: z.string(), intervalHours: z.number() }),
    true,
  );
  const [path, setPath] = useState<string | null>(null);
  const [pickingPath, setPickingPath] = useState(false);
  const [baselineDirectory, setBaselineDirectory] = useState<string | undefined>(
    initialBaselineDirectory,
  );
  const [pickingBaseline, setPickingBaseline] = useState(false);
  const [baselineByConversation, setBaselineByConversation] = useState<Record<string, string>>();

  // 灯箱打开时探测：QQ 在线实例（4.1 可点击前提）+ 语音转录模型（5.2 前提）。
  const [qqOnline, setQqOnline] = useState<boolean | null>(null);
  const [attachEnabled, setAttachEnabled] = useState<boolean | null>(null);
  const [voiceModelReady, setVoiceModelReady] = useState<boolean | null>(null);
  /** 在线功能在确认导出时授权；选择开关本身不启动抓包。 */
  const authorization = useExportAuthorization(opts, ['full', 'guild'].includes(variant));
  const authorizationAction = useRef<() => void>(() => {});
  authorizationAction.current = () => {
    void authorization.prepare(opts).then((value) => {
      if (value) setOpts(value);
    });
  };
  useEffect(() => {
    onAuthorizationChange?.({
      needed: authorization.needsElevation,
      request: () => authorizationAction.current(),
    });
    return () => onAuthorizationChange?.(null);
  }, [authorization.needsElevation, onAuthorizationChange]);
  /** 图片文字识别的前置状态（在线可用 / 本地模型 / 筛图模型）。 */
  const [ocrReady, setOcrReady] = useState<OcrReadiness | null>(null);
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

  const isAlbum = variant === 'album';
  const isQzone = variant === 'qzone';
  const wantQzonePosts = qzoneContent ? qzoneContent !== 'albums' : opts.qzonePosts !== false;
  const wantQzoneAlbums = qzoneContent ? qzoneContent !== 'posts' : Boolean(opts.qzoneAlbums);
  const isGuild = variant === 'guild';
  const isScheduled = variant === 'scheduled';
  const isContacts = variant === 'contacts';
  const isMessageFlow = !isAlbum && !isQzone && !isContacts;
  const contentPolicy = normalizeExportContent(opts.content, opts, isGuild);
  const validationId = useId();

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
  const [formats, setFormats] = usePageState<ExportFormat[]>(
    `export:formats:${variant}:${contactScope}`,
    () => {
      if (initialFormats?.length === 0) return [];
      const allowed = initialFormats?.filter((f) => formatOptions.some((o) => o.value === f));
      return allowed && allowed.length > 0 ? allowed : [formatOptions[0]!.value];
    },
    z.array(
      z.custom<ExportFormat>((value) =>
        [...FULL_FORMATS, ...FRIEND_FORMATS, ...QZONE_FORMATS].some(
          (format) => format.value === value,
        ),
      ),
    ),
    true,
  );

  /** QQ 空间 HTML 导出靠本地配图 + 评论/点赞渲染：选中 HTML 时锁定
   *  「下载配图」与「评论与点赞」为开。 */
  const htmlForced = isQzone && formats.includes('html');
  const selectionError =
    !isAlbum &&
    !formats.length &&
    !(
      isMessageFlow &&
      (hasExportResources(contentPolicy) || requiresStructuredExport(contentPolicy))
    )
      ? '请至少选择一种导出格式'
      : isMessageFlow && !hasExportContent(contentPolicy)
        ? '请至少选择一项导出内容'
        : null;

  function patch(next: Partial<ExportOptions>): void {
    setOpts((o) => ({ ...o, ...next }));
  }

  async function askForJson(): Promise<boolean> {
    return confirmDialog(
      '所选数据需要 JSON/JSONL',
      '是否同时选中 WeQ JSON 格式？不添加时保留资源选择，不启用依赖结构化格式的数据。',
      { okLabel: '选中 JSON', cancelLabel: '不添加 JSON', tone: 'info' },
    );
  }

  async function changeContent(content: ExportContentPolicy): Promise<void> {
    let next = content;
    if (
      (opts.chatlab || !formats.some((format) => format === 'json' || format === 'jsonl')) &&
      addedStructuredContent(contentPolicy, next)
    ) {
      setRequestingFormat(true);
      try {
        if (await askForJson()) {
          setFormats((current) => (current.includes('json') ? current : [...current, 'json']));
          patch({ chatlab: false });
        } else next = withoutStructuredContent(next);
      } finally {
        setRequestingFormat(false);
      }
    }
    patch({ content: next, ...exportContentFlags(next) });
  }

  // 切到 HTML 时自动补开配图下载 + 评论/点赞拉取，避免产出渲染不全的 html。
  useEffect(() => {
    if (!htmlForced) return;
    setOpts((o) => ({ ...o, exportMedia: true, qzoneInteractions: true }));
  }, [htmlForced, setOpts]);

  /** 在线转录先记本次选择，确认导出时再就绪抓包。 */
  async function toggleOnlineTranscribe(v: boolean): Promise<void> {
    if (!v) {
      patch({ onlineTranscribe: false });
      void authorization.releaseCapture().catch(() => undefined);
      return;
    }
    patch({ onlineTranscribe: true });
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

  async function confirm(): Promise<void> {
    if (confirming || requestingFormat || submitting || disabled || selectionError) return;
    if (
      !remote &&
      baselineDirectory &&
      baselineByConversation &&
      calendarTargets?.some(
        (target) => !Object.hasOwn(baselineByConversation, `${target.kind}:${target.conv}`),
      )
    ) {
      setPickingBaseline(true);
      return;
    }
    setConfirming(true);
    try {
      const settings = isMessageFlow ? await client.bootstrap.getSettings.query() : null;
      let selectedFormats = formats,
        selectedContent = contentPolicy,
        selectedChatlab = opts.chatlab;
      if (
        isMessageFlow &&
        requiresStructuredExport(selectedContent) &&
        (selectedChatlab ||
          !selectedFormats.some((format) => format === 'json' || format === 'jsonl'))
      ) {
        if (await askForJson()) {
          selectedFormats = selectedFormats.includes('json')
            ? selectedFormats
            : [...selectedFormats, 'json'];
          selectedChatlab = false;
          setFormats(selectedFormats);
        } else {
          selectedContent = withoutStructuredContent(selectedContent);
          patch({ content: selectedContent, ...exportContentFlags(selectedContent) });
        }
      }
      if (isMessageFlow && !selectedFormats.length && !hasExportResources(selectedContent)) return;
      const prepared = await authorization.prepare(
        isQzone && qzoneContent
          ? {
              ...opts,
              qzonePosts: qzoneContent !== 'albums',
              qzoneAlbums: qzoneContent !== 'posts',
            }
          : isMessageFlow
            ? {
                ...opts,
                ocrConcurrency: settings?.ocr.onlineConcurrency ?? opts.ocrConcurrency,
                onlineConcurrency:
                  settings?.voiceTranscribe.onlineConcurrency ?? opts.onlineConcurrency,
                chatlab: selectedChatlab,
                content: selectedContent,
                ...exportContentFlags(selectedContent),
              }
            : opts,
      );
      if (!prepared) return;
      setOpts(prepared);
      await onConfirm({
        authorization: {
          commit: () => authorization.commit(prepared),
          cancel: () => {
            void authorization.releaseCapture().catch(() => {});
          },
        },
        baselineDirectory:
          !remote && selectedFormats.some((format) => format === 'json' || format === 'jsonl')
            ? baselineDirectory
            : undefined,
        baselineByConversation:
          !remote && selectedFormats.some((format) => format === 'json' || format === 'jsonl')
            ? baselineByConversation
            : undefined,
        saveAsDefault,
        formats: selectedFormats,
        options: {
          ...prepared,
          ...structuredExportOptions(prepared, selectedFormats, prepared.chatlab),
        },
        schedule: isScheduled ? schedule : undefined,
        downloadPath: isAlbum ? path : undefined,
      });
    } finally {
      setConfirming(false);
    }
  }

  /** ChatLab 只支持 JSON / JSONL。 */
  const chatlabAllowed = formats.every((f) => f === 'json' || f === 'jsonl');

  function toggleChatlab(v: boolean): void {
    if (v) {
      // 开启 ChatLab 时只保留 json / jsonl（优先 json）。
      const kept = formats.filter((f) => f === 'json' || f === 'jsonl');
      setFormats(kept.length > 0 ? kept : ['json']);
      const content = withoutStructuredContent(contentPolicy);
      patch({ chatlab: true, incrementalSupport: false, content, ...exportContentFlags(content) });
    } else {
      patch({ chatlab: false });
    }
  }
  const formatSelection = useMultiSelection({
    enabled: !hidden,
    ids: formatOptions
      .filter((format) => !opts.chatlab || format.value === 'json' || format.value === 'jsonl')
      .map((format) => format.value),
    selected: new Set(formats),
    disabled: submitting,
    onChange: (next) => {
      setFormats(formatOptions.map((format) => format.value).filter((value) => next.has(value)));
    },
    onExit: onClose,
  });

  const imageRecognition = isMessageFlow ? (
    <div className="weq-exp-image-recognition">
      <Row
        label="图片文字识别"
        desc={
          ocrReady && !ocrReady.localReady && !ocrReady.onlineCapable
            ? ocrReady.localEngineBlocker ||
              '需要在线 QQ，或先在「设置 → AI 功能 → 图片识别」下好本地识别模型'
            : '识别图片里的文字，写出 ocr.json（含像素坐标框）并把文字回写进导出文件'
        }
        control={
          <Toggle
            checked={opts.ocrImages}
            disabled={Boolean(ocrReady && !ocrReady.localReady && !ocrReady.onlineCapable)}
            onChange={(v) => patch({ ocrImages: v, ...(v ? {} : { onlineOcr: false }) })}
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
                <Toggle checked={opts.onlineOcr} onChange={(v) => patch({ onlineOcr: v })} />
              }
            />
          ) : null}
          {ocrReady && !ocrReady.localReady && !ocrReady.localEngineBlocker ? (
            <p className="weq-exp-block-hint">
              未下载本地识别模型，在线识别失败时无法回退；可在「设置 → AI 功能 → 图片识别」下载。
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      className={embedded ? 'weq-export-options' : 'modal-scrim weq-exp-modal-scrim'}
      hidden={hidden}
      style={hidden ? { display: 'none' } : undefined}
      role="presentation"
      onMouseDown={embedded ? undefined : closeFromScrim(onClose)}
    >
      <section
        className="weq-exp-dialog is-wide"
        data-export-variant={variant}
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-exp-dialog-head">
          <div className="weq-exp-dialog-title">
            <strong>{headline}</strong>
            <span title={summary}>{summary}</span>
          </div>
          {onEditList ? (
            <button
              type="button"
              className="weq-exp-edit-list"
              onClick={onEditList}
              disabled={submitting}
            >
              <ListFilter size={15} />
              编辑列表
            </button>
          ) : null}
          <div className="weq-exp-default-actions">
            <button
              type="button"
              className="weq-exp-edit-list"
              aria-pressed={saveAsDefault}
              disabled={submitting || saveAsDefault}
              title="导出时将当前配置设为此类内容的默认配置"
              onClick={() => setSaveAsDefault(true)}
            >
              {saveAsDefault ? <Check size={15} /> : null}
              设为默认
            </button>
            {saveAsDefault ? (
              <button
                type="button"
                className="weq-exp-edit-list"
                disabled={submitting}
                onClick={() => setSaveAsDefault(false)}
              >
                <Undo2 size={15} />
                撤销
              </button>
            ) : null}
          </div>
          {authorization.needsElevation && !onAuthorizationChange ? (
            <button
              type="button"
              className="weq-exp-edit-list weq-export-needs-elevation"
              onClick={() => {
                void authorization.prepare(opts).then((value) => {
                  if (value) setOpts(value);
                });
              }}
            >
              <ShieldAlert size={15} />
              需要提权
            </button>
          ) : null}
          <button type="button" className="weq-exp-dialog-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-exp-dialog-body">
          {!remote &&
          variant === 'full' &&
          !opts.chatlab &&
          formats.some((format) => format === 'json' || format === 'jsonl') ? (
            <div className="weq-export-baseline">
              <span>继续更新归档</span>
              <input
                aria-label="继续更新的归档文件或文件夹"
                value={baselineDirectory ?? ''}
                placeholder="未选择"
                readOnly
                disabled={submitting}
              />
              <button
                type="button"
                className="weq-exp-tool"
                title="选择增量基线文件夹"
                aria-label="选择增量基线文件夹"
                disabled={pickingBaseline || submitting}
                onClick={() => setPickingBaseline(true)}
              >
                <FolderOpen size={15} />
              </button>
              {baselineDirectory ? (
                <button
                  type="button"
                  className="weq-exp-tool"
                  title="清除增量基线"
                  aria-label="清除增量基线"
                  disabled={submitting}
                  onClick={() => {
                    setBaselineDirectory(undefined);
                    setBaselineByConversation(undefined);
                  }}
                >
                  <X size={15} />
                </button>
              ) : null}
            </div>
          ) : null}
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
                  <Card title={contactScope === 'groups' ? '群聊名单' : '导出联系人'}>
                    <div className="weq-exp-placeholder">
                      <span>
                        {contactScope === 'groups'
                          ? '群号、群名称、群备注、人数、群主 UID、创建时间与离群标记'
                          : '导出好友列表 / 群成员列表（QQ号、昵称、备注、分组、角色等）'}
                      </span>
                      <small>
                        {contactScope === 'groups'
                          ? '本地群资料目录，创建时间按北京时间记录。'
                          : '数据来自本地资料库，无需在线 QQ。开启「导出头像」后，头像存入同目录 avatars/ 子文件夹（导出结果保存为文件夹）。'}
                      </small>
                    </div>
                  </Card>
                )}
              </div>

              {/* 右列：格式 + 内容 + 扩展 */}
              <div className="weq-exp-col">
                {isQzone ? (
                  <Card title="QQ 空间导出">
                    <div className="weq-exp-placeholder">
                      <span>导出自己或其他空间的说说与相册</span>
                      <small>
                        需登录该账号的 QQ 客户端。配图与视频存入 media/；HTML
                        格式会强制下载媒体并本地引用（离线可看）；评论与点赞从动态页解析，仅覆盖翻到的动态，可能不全。
                      </small>
                    </div>
                  </Card>
                ) : null}

                {/* 导出格式（多选；相册的格式仍走外部选择器） */}
                {!isAlbum ? (
                  <Card title="导出格式" action={opts.chatlab ? undefined : <ExportFormatHint />}>
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
                {!isAlbum && !(isContacts && contactScope === 'groups') ? (
                  <Card title="导出内容">
                    {variant === 'qzone' ? (
                      <BusinessExportDetails
                        domain="qzoneInteractions"
                        formats={formats}
                        onRequireJson={() =>
                          setFormats((current) =>
                            current.includes('json') ? current : [...current, 'json'],
                          )
                        }
                        options={opts}
                        disabled={submitting}
                        onChange={patch}
                      />
                    ) : null}
                    {isQzone ? (
                      <>
                        <MasterRow
                          icon={<ImageIcon size={17} />}
                          label="下载媒体（配图 / 视频）"
                          desc={
                            htmlForced
                              ? 'HTML 导出需要本地媒体，已随格式强制开启'
                              : '说说与相册的配图、视频存入公共 media/ 目录'
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
                          checked={wantQzonePosts && (htmlForced || opts.qzoneInteractions)}
                          disabled={htmlForced || !wantQzonePosts}
                          onChange={(v) => patch({ qzoneInteractions: v })}
                        />
                      </>
                    ) : isContacts ? (
                      contactScope === 'groups' ? null : (
                        <MasterRow
                          icon={<UserRound size={17} />}
                          label="头像"
                          desc="联系人头像存入 avatars/ 子目录"
                          checked={opts.exportAvatar}
                          onChange={(v) => patch({ exportAvatar: v })}
                        />
                      )
                    ) : (
                      <ExportContentSelector
                        value={contentPolicy}
                        guild={isGuild}
                        disabled={submitting || confirming || requestingFormat}
                        onChange={(content) => {
                          void changeContent(content);
                        }}
                      />
                    )}
                  </Card>
                ) : null}

                <Card title="扩展功能">
                  {imageRecognition}
                  {isMessageFlow ? (
                    <>
                      <Row
                        label="语音转写"
                        desc={
                          voiceModelReady === false
                            ? '需先在「设置 → AI 功能 → 语音识别」下载模型'
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
                              ? authorization.armed
                                ? '已就绪：优先用 QQ 服务端转写，漏包 / 过期回退本地'
                                : '待就绪：导出前准备官方转写抓包'
                              : '优先用 QQ 服务端转写（需保持 QQ 在线）'
                          }
                          control={
                            <Toggle
                              checked={opts.onlineTranscribe}
                              disabled={authorization.busy}
                              onChange={(v) => void toggleOnlineTranscribe(v)}
                            />
                          }
                        />
                      ) : null}
                      <p className="weq-exp-block-hint">
                        识别并发、筛图模型和转录并发请在「设置 → AI 功能」中调整。
                      </p>
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
                    </>
                  ) : null}
                  <ExportReportControl
                    checked={opts.includeIntegrityReport ?? false}
                    onChange={(v) => patch({ includeIntegrityReport: v })}
                    disabled={submitting}
                  />
                </Card>

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
          <span
            className="weq-exp-dialog-foot-note"
            id={validationId}
            role={selectionError ? 'status' : undefined}
          >
            {selectionError
              ? selectionError
              : isMessageFlow
                ? `${formats.length ? `${formats.length} 种格式` : '仅资源'}${opts.exportMedia ? ' · 含媒体' : ''}${opts.exportAvatar ? ' · 头像' : ''}${
                    opts.dress.bubble || opts.dress.font || opts.dress.widget ? ' · 装扮' : ''
                  }`
                : isQzone
                  ? `${wantQzonePosts ? '空间' : ''}${wantQzonePosts && wantQzoneAlbums ? ' + ' : ''}${wantQzoneAlbums ? '相册' : ''} · ${formats.length} 种格式${opts.exportMedia ? ' · 含媒体' : ''}${wantQzonePosts && opts.qzoneInteractions ? ' · 含评论/赞' : ''}`
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
            disabled={
              submitting || disabled || confirming || requestingFormat || Boolean(selectionError)
            }
            title={selectionError ?? undefined}
            aria-describedby={selectionError ? validationId : undefined}
          >
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            {isScheduled ? '创建定时任务' : '开始导出'}
          </button>
        </footer>
      </section>
      {pickingBaseline ? (
        <BaselinePicker
          initialDirectory={baselineDirectory}
          targets={calendarTargets}
          onClose={() => setPickingBaseline(false)}
          onSelect={(selection) => {
            setBaselineDirectory(selection?.directory);
            setBaselineByConversation(selection?.byConversation);
            setPickingBaseline(false);
          }}
        />
      ) : null}
      {authorization.dialog}
    </div>
  );
}
