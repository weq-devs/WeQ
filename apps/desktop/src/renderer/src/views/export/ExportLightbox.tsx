import { NumericText } from '../../components/NumericText';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { z } from 'zod/v3';
import { usePageState } from '../../components/PageSnapshots.shared';
import {
  CalendarClock,
  Check,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Loader2,
  ListFilter,
  UserRound,
  Undo2,
  X,
  ShieldAlert,
} from 'lucide-react';
import { Card, Row, Toggle } from '../../components/settings/controls';
import { client, trpc } from '../../trpc/client';
import { useDialog } from '../../components/Dialog.shared';
import { requestOpenSettings, type SettingsSection } from '../../lib/callSettingsBridge';
import { useExportAuthorization, type ExportAuthorizationIndicatorState } from './authorization';
import { BaselinePicker } from './BaselinePicker';
import { useRemoteClient } from '../../lib/remoteClient';
import { ExportReportControl } from './ExportReportControl';
import { BusinessExportDetails, ExportFormatHint } from './StructuredExportControls';
import { structuredExportOptions } from './StructuredExportControls.shared';
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
import { SegmentedControl } from '../../components/SegmentedControl';
import { CheckPillGroup } from '../../components/settings/controls';
import { TimeRangePicker } from './TimeRangePicker';
import type { CalendarTarget } from '../../lib/messageCalendar';
import { OverlayLayer } from '../../components/OverlayLayer';
import {
  DEFAULT_OPTIONS,
  DEFAULT_SCHEDULE,
  explicitChatlabFormats,
  FRIEND_FORMATS,
  FULL_FORMATS,
  MEMBER_FORMATS,
  QZONE_FORMATS,
  type ExportFormat,
  type ExportOptions,
  type Schedule,
} from './types';

function SettingsLink({ section, children }: { section: SettingsSection; children: ReactNode }) {
  return (
    <button
      type="button"
      className="weq-set-btn weq-set-btn-sm"
      onClick={() => requestOpenSettings(section)}
    >
      {children}
    </button>
  );
}

function RecognitionRow({
  label,
  checked,
  outcome,
  needsModel,
  modelLink,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  outcome: string;
  needsModel?: boolean;
  modelLink: SettingsSection;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Row
      label={label}
      desc={
        <>
          {outcome}
          {needsModel ? (
            <>
              {' '}
              <SettingsLink section={modelLink}>查看增强包</SettingsLink>
            </>
          ) : null}
        </>
      }
      control={<Toggle label={label} checked={checked} disabled={disabled} onChange={onChange} />}
    />
  );
}

export type LightboxVariant = 'full' | 'guild' | 'qzone' | 'scheduled' | 'album' | 'contacts';

/** 把（可能来自旧预设的）partial 选项补齐成完整 {@link ExportOptions}。 */
function normalizeLightboxOptions(partial?: Partial<ExportOptions>): ExportOptions {
  const options = {
    ...DEFAULT_OPTIONS,
    ...partial,
    chatlab: false,
    range: { ...DEFAULT_OPTIONS.range, ...partial?.range },
    mediaKinds: { ...DEFAULT_OPTIONS.mediaKinds, ...partial?.mediaKinds },
    dress: { ...DEFAULT_OPTIONS.dress, ...partial?.dress },
    // 在线路线只用于本次导出。
    onlineTranscribe: false,
    onlineOcr: false,
    voicePriority: undefined,
    ocrPriority: undefined,
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
  useRecordedSenderName: z.boolean().optional(),
});

export function ExportLightbox({
  embedded = false,
  hidden = false,
  onEditList,
  scopeSummary,
  localMessagesOnly = false,
  variant,
  headline,
  summary,
  contactScope = 'friends',
  qzoneContent,
  calendarTargets,
  initialOptions,
  initialFormats,
  initialBaselineDirectory,
  allowContinuation = true,
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
  localMessagesOnly?: boolean;
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
  allowContinuation?: boolean;
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

  const isAlbum = variant === 'album';
  const isQzone = variant === 'qzone';
  const wantQzonePosts = qzoneContent ? qzoneContent !== 'albums' : opts.qzonePosts !== false;
  const wantQzoneAlbums = qzoneContent ? qzoneContent !== 'posts' : Boolean(opts.qzoneAlbums);
  const isScheduled = variant === 'scheduled';
  const isContacts = variant === 'contacts';
  const isMessageFlow = !isAlbum && !isQzone && !isContacts;
  const validationId = useId();
  const resources = trpc.bootstrap.localModelResources.useQuery(undefined, {
    enabled: isMessageFlow && !hidden,
  });
  const models = resources.data;
  const localVoiceReady = models?.voice.some(
    (model) => model.id === models.selected.voice && model.downloaded && !model.downloading,
  );
  const localOcrReady =
    !models?.engineBlocker &&
    models?.ocr.some(
      (model) => model.id === models.selected.ocr && model.downloaded && !model.downloading,
    );
  const noMessageBackfill = variant === 'guild' || localMessagesOnly;
  const contentPolicy = normalizeExportContent(opts.content, opts, noMessageBackfill);
  const authorizationOptions: ExportOptions = {
    ...opts,
    // 在确认导出前也能预览是否需要授权。实际优先级在确认时读取。
    voicePriority: isScheduled ? undefined : 'local',
    ocrPriority: isScheduled ? undefined : 'qq',
    completeMessages: !noMessageBackfill && opts.completeMessages,
  };
  /** 在线功能在确认导出时授权；选择开关本身不启动抓包。 */
  const authorization = useExportAuthorization(
    authorizationOptions,
    !hidden && !isScheduled && isMessageFlow,
    { voice: localVoiceReady === true, ocr: localOcrReady === true },
  );
  const authorizationAction = useRef<() => void>(() => {});
  authorizationAction.current = () => {
    void authorization.prepare(authorizationOptions).then((value) => {
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
    `export:output-formats:${variant}:${contactScope}`,
    () => {
      if (initialFormats?.length === 0) return [];
      const allowed =
        initialFormats &&
        explicitChatlabFormats(initialFormats, initialOptions?.chatlab).filter((f) =>
          formatOptions.some((option) => option.value === f),
        );
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
        : isMessageFlow &&
            contentPolicy.messages === 'none' &&
            formats.some((value) => value === 'chatlab.json' || value === 'chatlab.jsonl')
          ? 'ChatLab 需要导出消息正文，请选择消息正文或移除 ChatLab 格式'
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
      !formats.some((format) => format === 'json' || format === 'jsonl' || format === 'jsonl.gz') &&
      addedStructuredContent(contentPolicy, next)
    ) {
      setRequestingFormat(true);
      try {
        if (await askForJson()) {
          setFormats((current) => (current.includes('json') ? current : [...current, 'json']));
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
      allowContinuation &&
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
      let selectedFormats = formats;
      let selectedContent = contentPolicy;
      if (
        isMessageFlow &&
        requiresStructuredExport(selectedContent) &&
        !selectedFormats.some(
          (format) => format === 'json' || format === 'jsonl' || format === 'jsonl.gz',
        )
      ) {
        if (await askForJson()) {
          selectedFormats = selectedFormats.includes('json')
            ? selectedFormats
            : [...selectedFormats, 'json'];
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
                voicePriority: isScheduled
                  ? undefined
                  : (settings?.voiceTranscribe?.priority ?? 'local'),
                ocrPriority: isScheduled ? undefined : (settings?.ocr?.priority ?? 'qq'),
                ocrConcurrency: settings?.ocr?.onlineConcurrency ?? opts.ocrConcurrency,
                onlineConcurrency:
                  settings?.voiceTranscribe?.onlineConcurrency ?? opts.onlineConcurrency,
                chatlab: false,
                ...(isScheduled
                  ? { ocrImages: false, onlineOcr: false, onlineTranscribe: false }
                  : {}),
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
          allowContinuation &&
          !remote &&
          selectedFormats.some(
            (format) => format === 'json' || format === 'jsonl' || format === 'jsonl.gz',
          )
            ? baselineDirectory
            : undefined,
        baselineByConversation:
          allowContinuation &&
          !remote &&
          selectedFormats.some(
            (format) => format === 'json' || format === 'jsonl' || format === 'jsonl.gz',
          )
            ? baselineByConversation
            : undefined,
        saveAsDefault,
        formats: selectedFormats,
        options: {
          ...prepared,
          ...structuredExportOptions(prepared, selectedFormats),
        },
        schedule: isScheduled ? schedule : undefined,
        downloadPath: isAlbum ? path : undefined,
      });
    } finally {
      setConfirming(false);
    }
  }

  const Surface = embedded ? 'div' : OverlayLayer;
  return (
    <Surface
      className={embedded ? 'weq-export-options' : 'modal-scrim weq-exp-modal-scrim'}
      {...(embedded
        ? { hidden, style: hidden ? { display: 'none' } : undefined }
        : { open: !hidden, onClose })}
      role="presentation"
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
          {allowContinuation &&
          !remote &&
          variant === 'full' &&
          formats.some(
            (format) => format === 'json' || format === 'jsonl' || format === 'jsonl.gz',
          ) ? (
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
                  <Card title="导出格式" action={<ExportFormatHint />}>
                    <CheckPillGroup<ExportFormat>
                      options={formatOptions.map((f) => ({ value: f.value, label: f.label }))}
                      selected={formats}
                      onChange={(next) => setFormats(next)}
                      disabled={submitting}
                    />
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
                        {wantQzonePosts ? (
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
                        ) : null}
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
                        localMessagesOnly={noMessageBackfill}
                        disabled={submitting || confirming || requestingFormat}
                        onChange={(content) => {
                          void changeContent(content);
                        }}
                      />
                    )}
                  </Card>
                ) : null}

                {isMessageFlow ? (
                  <div className="weq-exp-recognition">
                    <Card
                      title="识别与转写"
                      action={<SettingsLink section="recognition">识别设置</SettingsLink>}
                    >
                      {isScheduled ? (
                        <p className="weq-exp-block-hint">
                          图片文字识别与 QQ 在线转写仅在立即导出时可选。
                        </p>
                      ) : (
                        <RecognitionRow
                          label="图片文字识别"
                          checked={opts.ocrImages}
                          outcome="将识别出的文字与消息一起保存。"
                          needsModel={
                            opts.ocrImages &&
                            localOcrReady === false &&
                            authorization.state?.access.qqOnline === false &&
                            !models?.engineBlocker
                          }
                          modelLink="enhancementText"
                          disabled={submitting || confirming || authorization.busy}
                          onChange={(ocrImages) => patch({ ocrImages })}
                        />
                      )}
                      <RecognitionRow
                        label="语音转写"
                        checked={opts.transcribeVoice}
                        outcome="先使用已有转写，再处理没有文字的语音。"
                        needsModel={
                          opts.transcribeVoice &&
                          localVoiceReady === false &&
                          (isScheduled || authorization.state?.access.qqOnline === false)
                        }
                        modelLink="enhancementVoice"
                        disabled={submitting || confirming || authorization.busy}
                        onChange={(transcribeVoice) => patch({ transcribeVoice })}
                      />
                    </Card>
                  </div>
                ) : null}
                <Card>
                  {isMessageFlow &&
                  variant !== 'guild' &&
                  (!calendarTargets || calendarTargets.some((target) => target.kind === 'group')) &&
                  contentPolicy.messages !== 'none' ? (
                    <Row
                      label="群聊发送者名称"
                      control={
                        <SegmentedControl<'current' | 'recorded'>
                          label="群聊发送者名称"
                          disabled={submitting || confirming || authorization.busy}
                          value={opts.useRecordedSenderName ? 'recorded' : 'current'}
                          options={[
                            { value: 'current', label: '当前称呼' },
                            { value: 'recorded', label: '消息中的称呼' },
                          ]}
                          onChange={(value) =>
                            patch({ useRecordedSenderName: value === 'recorded' })
                          }
                        />
                      }
                    />
                  ) : null}
                  <ExportReportControl
                    plain
                    checked={opts.includeIntegrityReport ?? false}
                    onChange={(v) => patch({ includeIntegrityReport: v })}
                    disabled={submitting}
                  />
                </Card>

                {/* 定时设置 */}
                {isScheduled ? (
                  <Card title="定时设置">
                    <SegmentedControl<Schedule['mode']>
                      label="定时方式"
                      value={schedule.mode}
                      onChange={(mode) => setSchedule((s) => ({ ...s, mode }))}
                      options={[
                        { value: 'daily', label: '每天定时' },
                        { value: 'interval', label: '间隔执行' },
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
            {selectionError ? (
              selectionError
            ) : isMessageFlow ? (
              <NumericText>{`${formats.length ? `${formats.length} 种格式` : '仅资源'}${opts.exportMedia ? ' · 含媒体' : ''}${opts.exportAvatar ? ' · 头像' : ''}${
                opts.dress.bubble || opts.dress.font || opts.dress.widget ? ' · 装扮' : ''
              }`}</NumericText>
            ) : isQzone ? (
              <NumericText>{`${wantQzonePosts ? '空间' : ''}${wantQzonePosts && wantQzoneAlbums ? ' + ' : ''}${wantQzoneAlbums ? '相册' : ''} · ${formats.length} 种格式${opts.exportMedia ? ' · 含媒体' : ''}${wantQzonePosts && opts.qzoneInteractions ? ' · 含评论/赞' : ''}`}</NumericText>
            ) : isContacts ? (
              <NumericText>{`${formats.length} 种格式${opts.exportAvatar ? ' · 含头像' : ''}`}</NumericText>
            ) : null}
          </span>
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="weq-exp-btn is-primary"
            data-weq-dialog-confirm={!embedded || undefined}
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
    </Surface>
  );
}
