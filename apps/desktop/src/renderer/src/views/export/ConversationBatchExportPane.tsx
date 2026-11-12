import { useMemo, useRef, useState } from 'react';
import { Check, Download, MessagesSquare } from 'lucide-react';
import {
  conversationBatchTargets,
  type ContentSelection,
  type ConversationBatchTarget,
} from '../../../../shared/content_selection';
import { trpc, client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { ServerSavePrompt } from '../../components/ServerSavePrompt';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import type { ExportAuthorizationIndicatorState } from './authorization';
import { ExportLightbox, type LightboxResult } from './ExportLightbox';
import { StructuredExportControls } from './StructuredExportControls';
import { ExportReportControl } from './ExportReportControl';
import { TimeRangePicker } from './TimeRangePicker';
import { DEFAULT_OPTIONS, FULL_FORMATS, BACKEND_FORMATS, type ExportFormat } from './types';
import { preflightChatExport } from './chatExport';
import {
  isGeneratedConversationTarget,
  planConversationBatchExport,
  startConversationBatchExport,
} from './conversationBatchExport';
import '../../styles/conversation-batch-export.css';

const LABELS: Record<ConversationBatchTarget['kind'], string> = {
  c2c: 'QQ 私聊',
  group: 'QQ 群聊',
  official: '公众号',
  service: '服务号',
  guild: '频道私聊',
  persona: '好友克隆',
  cloneGroup: '克隆群',
  assistant: 'WeQ 助手',
};

export function ConversationBatchExportPane({
  initialSelection,
  onClose,
  onAuthorizationChange,
}: {
  initialSelection: ContentSelection;
  onClose?: () => void;
  onAuthorizationChange?: (state: ExportAuthorizationIndicatorState | null) => void;
}) {
  const parsed = useMemo(() => {
    try {
      return { targets: conversationBatchTargets(initialSelection), error: '' };
    } catch (error) {
      return { targets: [], error: error instanceof Error ? error.message : String(error) };
    }
  }, [initialSelection]);
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const { binding, prepareSave, isCurrent, serverLocation, chooseServerLocation, picking } =
    useExportSavePolicy();
  const presets = trpc.bootstrap.getExportPresets.useQuery();
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(new Set<string>());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [options, setOptions] = useState(() => structuredClone(DEFAULT_OPTIONS));
  const [formats, setFormats] = useState<ExportFormat[]>(['json']);
  const pending = parsed.targets.filter((target) => !created.has(target.id));
  const generatedOnly = parsed.targets.every(isGeneratedConversationTarget);
  const hasQq = pending.some((target) => !isGeneratedConversationTarget(target));
  const canRoam = pending.some((target) => target.kind === 'c2c' || target.kind === 'group');

  async function submit(result: LightboxResult) {
    if (submitting.current || !binding || !pending.length || parsed.error) return;
    submitting.current = true;
    setBusy(true);
    let taskCreated = false;
    try {
      const plan = planConversationBatchExport(pending, result.formats, result.options.chatlab);
      if (!plan.targets.length) {
        dialog.error('当前格式不适用', '这些会话不支持所选格式，请选择 JSON、TXT 或其他可用格式。');
        return;
      }
      if (plan.unsupported.length) {
        const lines = plan.unsupported.map(({ target, formats: unsupported }) => {
          const compatible = plan.targets.find((item) => item.target.id === target.id)?.formats;
          return `${target.name}（${LABELS[target.kind]}）：不支持 ${result.options.chatlab && isGeneratedConversationTarget(target) ? 'ChatLab' : unsupported.map((format) => format.toUpperCase()).join('、')}，${compatible?.length ? `仅导出 ${compatible.map((format) => format.toUpperCase()).join('、')}` : '本次跳过'}`;
        });
        const confirmed = await dialog.confirm('部分会话不支持所选格式', lines.join('\n'), {
          okLabel: '按上述范围导出',
          cancelLabel: '返回修改',
          tone: 'warning',
        });
        if (!confirmed || !isCurrent()) return;
      }
      if (
        hasQq &&
        !(await preflightChatExport(dialog, result.options, { messageCompletion: canRoam }))
      )
        return;
      const savePolicy = await prepareSave(undefined, { kind: 'bundle', name: '会话批量导出' });
      if (!savePolicy || !isCurrent()) return;
      if (result.saveAsDefault)
        await client.bootstrap.setExportPreset.mutate({
          variant: 'full',
          formats: result.formats,
          options: result.options,
        });
      const outcome = await startConversationBatchExport({
        plan,
        options: result.options,
        binding: { ...binding },
        savePolicy,
        isCurrent,
      });
      taskCreated = outcome.created.length > 0;
      if (taskCreated) result.authorization?.commit();
      if (!isCurrent()) return;
      setCreated(
        (current) => new Set([...current, ...outcome.created.map((item) => item.target.id)]),
      );
      setFailures(Object.fromEntries(outcome.failed.map((item) => [item.target.id, item.reason])));
      await utils.account.listExportTasks.invalidate();
      if (!outcome.failed.length && outcome.created.length === pending.length) onClose?.();
    } catch (error) {
      if (isCurrent())
        dialog.error('启动批量导出失败', error instanceof Error ? error.message : String(error));
    } finally {
      if (!taskCreated) result.authorization?.cancel();
      submitting.current = false;
      setBusy(false);
    }
  }

  if (parsed.error || !parsed.targets.length)
    return (
      <div className="weq-conversation-batch-export" role="alert">
        {parsed.error || '没有选中的会话。'}
      </div>
    );

  return (
    <section className="weq-conversation-batch-export" aria-label="会话批量导出">
      {serverLocation ? (
        <ServerSavePrompt name={serverLocation.name} onChoose={chooseServerLocation} />
      ) : null}
      <ul className="weq-conversation-batch-targets" aria-label="本次导出会话">
        {parsed.targets.map((target) => (
          <li key={target.id}>
            {created.has(target.id) ? <Check size={15} /> : <MessagesSquare size={15} />}
            <span className="weq-conversation-batch-target-name">{target.name}</span>
            <small>{created.has(target.id) ? '已创建任务' : LABELS[target.kind]}</small>
            {failures[target.id] ? <p role="alert">{failures[target.id]}</p> : null}
          </li>
        ))}
      </ul>
      {generatedOnly ? (
        <div className="weq-conversation-batch-generated">
          <TimeRangePicker
            value={options.range}
            onChange={(range) => setOptions((current) => ({ ...current, range }))}
            mode="single"
          />
          <div className="weq-conversation-batch-formats" role="group" aria-label="导出格式">
            {FULL_FORMATS.filter((format) =>
              (BACKEND_FORMATS as readonly string[]).includes(format.value),
            ).map((format) => (
              <label key={format.value}>
                <input
                  type="checkbox"
                  checked={formats.includes(format.value)}
                  disabled={busy}
                  onChange={(event) =>
                    setFormats((current) =>
                      event.target.checked
                        ? [...current, format.value]
                        : current.filter((value) => value !== format.value),
                    )
                  }
                />
                {format.label}
              </label>
            ))}
          </div>
          <StructuredExportControls
            domain="generatedParameters"
            options={options}
            formats={formats}
            disabled={busy}
            onRequireJson={() =>
              setFormats((current) => (current.includes('json') ? current : [...current, 'json']))
            }
            onChange={(patch) => setOptions((current) => ({ ...current, ...patch }))}
          />
          <ExportReportControl
            checked={options.includeIntegrityReport ?? false}
            onChange={(includeIntegrityReport) =>
              setOptions((current) => ({ ...current, includeIntegrityReport }))
            }
            disabled={busy}
          />
          <footer className="weq-conversation-batch-foot">
            <span>{pending.length} 个待导出会话</span>
            <button
              type="button"
              className="weq-exp-primary"
              disabled={busy || picking || !binding || !pending.length || !formats.length}
              onClick={() => void submit({ formats, options })}
            >
              <Download size={15} />
              {busy ? '准备中…' : '开始导出'}
            </button>
          </footer>
        </div>
      ) : presets.isLoading ? (
        <LoadingIndicator>读取导出配置</LoadingIndicator>
      ) : (
        <ExportLightbox
          embedded
          variant={canRoam ? 'full' : 'guild'}
          headline="会话批量导出"
          summary={`${pending.length} 个会话`}
          initialOptions={presets.data?.full?.options}
          initialFormats={presets.data?.full?.formats}
          allowContinuation={false}
          submitting={busy}
          disabled={picking || !binding || !pending.length}
          onClose={() => onClose?.()}
          onConfirm={submit}
          onAuthorizationChange={onAuthorizationChange}
        />
      )}
    </section>
  );
}
