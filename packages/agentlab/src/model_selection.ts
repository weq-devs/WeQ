import type { AgentLabDefaultModelRef, AgentLabModelSelection, AgentLabEndpoint } from './types';
export type { AgentLabModelRef, AgentLabModelSelection } from './types';
export const DEFAULT_MODEL_SELECTION_KEY = 'default';

export function isDefaultModelSelection(value: unknown): value is AgentLabDefaultModelRef {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'useDefault') &&
    'useDefault' in value &&
    value.useDefault === true
  );
}

/** 旧空值不升级为默认；混合引用与未知格式不猜测使用意图。 */
export function normalizeModelSelection(value: unknown): AgentLabModelSelection | null {
  if (isDefaultModelSelection(value)) return { useDefault: true };
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'useDefault' in value)
    return null;
  if (
    !('providerId' in value) ||
    !('model' in value) ||
    typeof value.providerId !== 'string' ||
    typeof value.model !== 'string'
  )
    return null;
  const providerId = value.providerId.trim(),
    model = value.model.trim();
  return providerId && model && !providerId.includes('\0') && !model.includes('\0')
    ? { providerId, model }
    : null;
}

export function modelSelectionKey(value: AgentLabModelSelection | null | undefined): string {
  if (!value) return '';
  return isDefaultModelSelection(value)
    ? DEFAULT_MODEL_SELECTION_KEY
    : JSON.stringify([value.providerId, value.model]);
}

export function assertEmbeddingModelIdentity(
  persona: { embeddingModelIdentity?: string },
  endpoint: AgentLabEndpoint | null,
): void {
  if (
    persona.embeddingModelIdentity &&
    persona.embeddingModelIdentity !== (endpoint?.modelIdentity ?? endpoint?.model)
  )
    throw new Error('默认向量模型已更改或不可用，请重新训练克隆体后再使用向量检索');
}
