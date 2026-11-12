import type { ExportSavePolicy, GeneratedContentTarget } from '@weq/service';
import { client } from '../../trpc/client';
import type { ConversationBatchTarget } from '../../../../shared/content_selection';
import { buildChatExportMedia } from './chatExport';
import { ocrReadiness } from './preflight';
import { structuredExportOptions } from './StructuredExportControls';
import { isBackendFormat, type ExportFormat, type ExportOptions } from './types';
import { normalizeExportContent } from '@weq/service/export-content';

export interface ConversationExportPlan {
  targets: Array<{
    target: ConversationBatchTarget;
    formats: Exclude<ExportFormat, 'vcard'>[];
  }>;
  unsupported: Array<{ target: ConversationBatchTarget; formats: ExportFormat[] }>;
}

export function isGeneratedConversationTarget(target: ConversationBatchTarget): boolean {
  return target.kind === 'persona' || target.kind === 'cloneGroup' || target.kind === 'assistant';
}

/** 对不适用的格式逐对象列明，由调用方确认后执行，不能静默漏掉来源。 */
export function planConversationBatchExport(
  targets: readonly ConversationBatchTarget[],
  formats: readonly ExportFormat[],
  chatlab = false,
): ConversationExportPlan {
  const plan: ConversationExportPlan = { targets: [], unsupported: [] };
  const selectedFormats = [...new Set(formats)];
  for (const original of targets) {
    const target = { ...original };
    const supported = selectedFormats.filter(
      (format): format is Exclude<ExportFormat, 'vcard'> =>
        format !== 'vcard' &&
        (!isGeneratedConversationTarget(target) || (!chatlab && isBackendFormat(format))),
    );
    const supportedSet = new Set<ExportFormat>(supported);
    const unsupported = selectedFormats.filter((format) => !supportedSet.has(format));
    if (unsupported.length) plan.unsupported.push({ target, formats: unsupported });
    if (supported.length) plan.targets.push({ target, formats: supported });
  }
  return plan;
}

interface ExportBinding {
  expectedAccountUin: string;
  expectedAccountConfigId: string;
}

async function generatedTarget(
  target: ConversationBatchTarget,
  binding: ExportBinding,
): Promise<GeneratedContentTarget> {
  if (target.kind === 'assistant') {
    if (!target.sessionId) throw new Error('助手会话身份缺失，请重新选择。');
    return { kind: 'assistant', ownerId: 'assistant', sessionId: target.sessionId };
  }
  if (target.kind !== 'persona' && target.kind !== 'cloneGroup')
    throw new Error('会话不是本地生成对话。');
  const kind = target.kind === 'cloneGroup' ? 'group' : 'persona';
  const ownerId = target.ownerId;
  if (!ownerId) throw new Error('克隆对象身份缺失，请重新选择。');
  if (target.sessionId !== undefined) return { kind, ownerId, sessionId: target.sessionId };
  const conversations = await client.account.generatedConversations.query(binding);
  const matches = conversations.filter((item) => item.kind === kind && item.ownerId === ownerId);
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? '克隆长期对话尚未归一，请先打开该克隆后重试。'
        : '克隆对话不存在或还没有持久化记录。',
    );
  return { kind, ownerId, sessionId: matches[0]!.sessionId };
}

export interface ConversationBatchExportResult {
  created: Array<{ target: ConversationBatchTarget; taskId: string }>;
  failed: Array<{ target: ConversationBatchTarget; reason: string }>;
}

/** 同一份冻结选区分别进入原有消息、频道和生成记录管线；失败对象可单独重试。 */
export async function startConversationBatchExport({
  plan,
  options,
  binding,
  savePolicy,
  isCurrent,
}: {
  plan: ConversationExportPlan;
  options: ExportOptions;
  binding: ExportBinding;
  savePolicy: ExportSavePolicy;
  isCurrent: () => boolean;
}): Promise<ConversationBatchExportResult> {
  const frozen = structuredClone({ plan, options, binding, savePolicy });
  const result: ConversationBatchExportResult = { created: [], failed: [] };
  const hasQq = frozen.plan.targets.some(({ target }) => !isGeneratedConversationTarget(target));
  const ocrPrefilter =
    hasQq && frozen.options.ocrImages ? (await ocrReadiness()).filterReady : false;
  for (const { target, formats } of frozen.plan.targets) {
    if (!isCurrent()) {
      result.failed.push({ target, reason: '账号或数据源已切换，未创建此任务。' });
      continue;
    }
    try {
      let taskId: string;
      if (isGeneratedConversationTarget(target)) {
        const generated = await generatedTarget(target, frozen.binding);
        let messageIds: string[] | undefined;
        if (frozen.options.range.start !== null || frozen.options.range.end !== null) {
          const content = await client.account.generatedConversation.query({
            ...frozen.binding,
            target: generated,
          });
          const { start, end } = frozen.options.range;
          messageIds = content.messages
            .filter(
              (message) =>
                (start === null || message.ts >= start * 1000) &&
                (end === null || message.ts <= end * 1000),
            )
            .map((message) => message.id);
        }
        if (!isCurrent()) throw new Error('账号或数据源已切换，未创建此任务。');
        taskId = await client.account.startGeneratedExport.mutate({
          ...frozen.binding,
          savePolicy: frozen.savePolicy,
          target: generated,
          formats: formats.filter(isBackendFormat),
          messageIds,
          ...structuredExportOptions(frozen.options, formats),
          includeIntegrityReport: frozen.options.includeIntegrityReport ?? false,
        });
      } else {
        const messageCompletion = target.kind === 'c2c' || target.kind === 'group';
        const content = normalizeExportContent(
          frozen.options.content,
          frozen.options,
          !messageCompletion,
        );
        const media = buildChatExportMedia(
          { ...frozen.options, content },
          {
            messageCompletion,
            ocrPrefilter,
          },
        );
        const common = {
          ...frozen.binding,
          savePolicy: frozen.savePolicy,
          name: target.name,
          format: formats[0]!,
          formats,
          exportAvatar: frozen.options.exportAvatar,
          dress: { ...frozen.options.dress },
          chatlab: frozen.options.chatlab,
          media,
          range: { start: frozen.options.range.start, end: frozen.options.range.end },
          ...structuredExportOptions(frozen.options, formats, frozen.options.chatlab),
          includeIntegrityReport: frozen.options.includeIntegrityReport ?? false,
        };
        if (target.kind === 'guild') {
          taskId = await client.account.guildDirectStartExport.mutate({
            ...common,
            nodeId: target.ownerId ?? target.id,
          });
        } else if (
          target.kind === 'c2c' ||
          target.kind === 'group' ||
          target.kind === 'official' ||
          target.kind === 'service'
        ) {
          taskId = await client.account.startExport.mutate({
            ...common,
            content,
            completeAvatar: frozen.options.completeAvatar,
            kind: target.kind,
            conv: target.ownerId ?? target.id,
            total: 0,
          });
        } else throw new Error('不支持的会话来源，请重新选择。');
      }
      result.created.push({ target, taskId });
    } catch (error) {
      result.failed.push({
        target,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
