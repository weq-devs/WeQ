import { normaliseContactsFormats } from './contacts_export';
import { sanitizeSegment } from '../../common/path_sanitize';

export interface ExportOutputPlan {
  kind: 'messages' | 'contacts' | 'bundle' | 'file';
  name: string;
  format?: string;
  formats?: string[];
  targetCount?: number;
  contactScope?: 'friends' | 'group' | 'groups';
  exportAvatar?: boolean;
  media?: {
    exportMedia?: boolean;
    transcribeVoice?: boolean;
    ocrImages?: boolean;
    mediaKinds?: { sysface?: boolean };
  };
  dress?: { bubble?: boolean; font?: boolean; widget?: boolean };
}
export interface ExportOutputCapabilities {
  avatar: boolean;
  transcribe: boolean;
  ocr: boolean;
  dress: boolean;
}
export type ExportOutputShape =
  | { kind: 'directory' }
  | { kind: 'file'; name: string; extension: string };
export const EXPORT_EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/i;

export function exportOutputFileName(
  output: Extract<ExportOutputShape, { kind: 'file' }>,
  fallback = 'export',
): string {
  if (!EXPORT_EXTENSION_PATTERN.test(output.extension)) throw new Error('输出扩展名无效。');
  return `${sanitizeSegment(output.name, fallback, { maxLen: 120 })}.${output.extension}`;
}

/** 与消息写入管线共用，能力不可用时不伪造实际不存在的额外产物。 */
export function messageOutputFlags(
  plan: Pick<ExportOutputPlan, 'format' | 'formats' | 'exportAvatar' | 'media' | 'dress'>,
  capabilities: ExportOutputCapabilities,
) {
  const wantAvatars = Boolean(plan.exportAvatar && capabilities.avatar);
  const wantMedia = Boolean(plan.media?.exportMedia);
  const wantTranscribe = Boolean(plan.media?.transcribeVoice && capabilities.transcribe);
  const wantOcr = Boolean(plan.media?.ocrImages && capabilities.ocr);
  const wantDress = Boolean(
    (plan.dress?.bubble || plan.dress?.font || plan.dress?.widget) && capabilities.dress,
  );
  const wantSysFaces = Boolean(plan.media?.mediaKinds?.sysface);
  const isBundle =
    wantAvatars ||
    wantMedia ||
    wantTranscribe ||
    wantOcr ||
    wantDress ||
    wantSysFaces ||
    plan.format === 'html' ||
    (plan.formats?.length ?? 1) > 1;
  return { wantAvatars, wantMedia, wantTranscribe, wantOcr, wantDress, wantSysFaces, isBundle };
}

export function describeExportOutput(
  plan: ExportOutputPlan,
  capabilities: ExportOutputCapabilities,
): ExportOutputShape {
  if (
    plan.targetCount !== undefined &&
    (!Number.isSafeInteger(plan.targetCount) || plan.targetCount <= 0)
  )
    throw new Error('未选择有效的输出目标。');
  if (plan.kind === 'bundle' || (plan.targetCount ?? 1) > 1) return { kind: 'directory' };
  const formats = plan.formats?.length ? plan.formats : plan.format ? [plan.format] : [];
  if (!formats.length) throw new Error('单文件输出需要确定格式。');
  let normalized = formats;
  let bundle = formats.length > 1;
  if (plan.kind === 'messages') bundle = messageOutputFlags(plan, capabilities).isBundle;
  if (plan.kind === 'contacts') {
    if (!plan.contactScope) throw new Error('名单输出需要确定范围。');
    if (plan.contactScope === 'groups' && plan.exportAvatar)
      throw new Error('群聊名单不支持下载联系人头像。');
    normalized = normaliseContactsFormats(formats, plan.contactScope !== 'friends');
    bundle = normalized.length > 1 || Boolean(plan.exportAvatar && capabilities.avatar);
  }
  if (bundle) return { kind: 'directory' };
  const format = normalized[0]!;
  const extension = format === 'vcard' ? 'vcf' : format;
  if (!EXPORT_EXTENSION_PATTERN.test(extension)) throw new Error('输出扩展名无效。');
  return { kind: 'file', name: plan.name, extension };
}
