import type { AgentLabProviderModel, ModelMetadata, ModelReasoningControl } from './types';

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function mergeModelDetails(
  base: Record<string, unknown>,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(detail).map(([key, value]) => [
      key,
      value && typeof value === 'object' && !Array.isArray(value)
        ? mergeModelDetails(record(base[key]), record(value))
        : value,
    ]),
  ]);
}
function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => record(current)[key], value);
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

/** 仅解析声明字段；缺失、null 与明确 false 分开，不按模型名称补全。 */
export function parseModelMetadata(raw: Record<string, unknown>, source = 'models'): ModelMetadata {
  const capabilities: ModelMetadata['capabilities'] = {
    chat: 'unknown',
    embedding: 'unknown',
    vision: 'unknown',
  };
  const set = (key: keyof typeof capabilities, value: unknown) => {
    if (typeof value === 'boolean') capabilities[key] = value ? 'supported' : 'unsupported';
  };
  const kind = raw.kind ?? raw.type ?? raw.model_type;
  if (
    typeof kind === 'string' &&
    ['chat', 'llm', 'language', 'embedding', 'embeddings', 'image', 'decision'].includes(kind)
  ) {
    set('chat', kind === 'chat' || kind === 'llm' || kind === 'language');
    set('embedding', kind === 'embedding' || kind === 'embeddings');
  }
  const methods = strings(raw.supportedGenerationMethods);
  if (Object.keys(record(at(raw, 'api_capabilities.anthropic_messages'))).length) set('chat', true);
  if (methods) {
    set('chat', methods.includes('generateContent'));
    set('embedding', methods.includes('embedContent') || methods.includes('batchEmbedContents'));
  }
  const declared = strings(raw.capabilities);
  if (declared) {
    set(
      'chat',
      declared.includes('completion') || declared.includes('chat') || declared.includes('TG'),
    );
    set(
      'embedding',
      declared.some((value) => ['embedding', 'embeddings', 'TR', 'ME'].includes(value)),
    );
    set('vision', declared.includes('vision') || declared.includes('VU'));
  }
  for (const [key, paths] of Object.entries({
    chat: ['capabilities.completion_chat', 'capabilities.chat'],
    embedding: ['capabilities.embedding'],
    vision: ['supports_image_in', 'capabilities.vision', 'capabilities.image_input.supported'],
  }) as Array<[keyof typeof capabilities, string[]]>) {
    for (const path of paths) set(key, at(raw, path));
  }
  const input =
    strings(at(raw, 'chat.modalities.input')) ??
    strings(raw.input_modalities) ??
    strings(at(raw, 'architecture.input_modalities')) ??
    strings(at(raw, 'modalities.input')) ??
    strings(at(raw, 'inference_metadata.request_modality'));
  if (input)
    set(
      'vision',
      input.some((value) => ['image', 'image_url'].includes(value)),
    );
  if (typeof kind === 'string' && ['embedding', 'embeddings', 'image', 'decision'].includes(kind))
    set('vision', false);

  const reasoning: ModelMetadata['reasoning'] = { controls: [] };
  const control = (
    kind: ModelReasoningControl['kind'],
    source: string,
    value: unknown,
    defaults?: unknown,
  ) => {
    const obj = record(value);
    const values = Array.isArray(value) || value === null ? value : obj.values;
    const entry: ModelReasoningControl = { kind, source };
    if (values === null) entry.values = null;
    else if (Array.isArray(values))
      entry.values = values.filter((item): item is string | number | boolean =>
        ['string', 'number', 'boolean'].includes(typeof item),
      );
    const def = defaults === undefined ? obj.default : defaults;
    if (def === null || ['string', 'number', 'boolean'].includes(typeof def))
      entry.default = def as string | number | boolean | null;
    if (typeof obj.min === 'number') entry.min = obj.min;
    if (typeof obj.max === 'number') entry.max = obj.max;
    reasoning.controls.push(entry);
    reasoning.supported = true;
  };
  for (const path of [
    'supports_reasoning',
    'capabilities.thinking.supported',
    'reasoning.supported',
  ]) {
    const supported = at(raw, path);
    if (typeof supported === 'boolean') reasoning.supported = supported;
  }
  if (
    declared?.includes('thinking') ||
    declared?.includes('Reasoning') ||
    strings(raw.tags)?.includes('reasoning')
  )
    reasoning.supported = true;
  for (const [path, valuesKey, defaultKey] of [
    ['chat.reasoning.effort', 'supported', 'default'],
    ['effort', 'supported_levels', 'default_level'],
    ['reasoning', 'supported_efforts', 'default_effort'],
    ['capabilities.reasoning', 'allowed_options', 'default'],
  ]) {
    const obj = record(at(raw, path!));
    if (Object.hasOwn(obj, valuesKey!)) {
      const values = obj[valuesKey!];
      // OpenRouter 的 null 表示接受网关全部 effort，其他来源的 null 保持未知。
      if (Array.isArray(values) || (path === 'reasoning' && values === null)) {
        const toggle =
          Array.isArray(values) &&
          values.length > 0 &&
          values.every((v) => typeof v === 'boolean' || v === 'on' || v === 'off');
        control(toggle ? 'toggle' : 'effort', `${path}.${valuesKey}`, values, obj[defaultKey!]);
      }
    }
  }
  if (Array.isArray(raw.reasoning_levels))
    control('effort', 'reasoning_levels', raw.reasoning_levels);
  const thinking = record(raw.thinking);
  if (Array.isArray(thinking.values)) {
    control(
      thinking.values.every((v) => typeof v === 'boolean') ? 'toggle' : 'effort',
      'thinking.values',
      thinking.values,
      thinking.default,
    );
  }
  const effort = record(at(raw, 'capabilities.effort'));
  const levels = Object.entries(effort)
    .filter(([key, value]) => key !== 'supported' && record(value).supported === true)
    .map(([key]) => key);
  if (levels.length) control('effort', 'capabilities.effort', levels);
  if (Array.isArray(raw.reasoning_options)) {
    for (const option of raw.reasoning_options) {
      const obj = record(option);
      if (obj.type === 'effort' || obj.type === 'toggle' || obj.type === 'budget_tokens') {
        control(obj.type === 'budget_tokens' ? 'budget' : obj.type, 'reasoning_options', obj);
      }
    }
  }
  for (const path of ['chat.reasoning.budget_tokens', 'reasoning.max_tokens']) {
    if (at(raw, path) && typeof at(raw, path) === 'object') control('budget', path, at(raw, path));
  }
  if (at(raw, 'reasoning.supports_max_tokens') === true)
    control('budget', 'reasoning.supports_max_tokens', {});
  for (const path of ['chat.reasoning.adaptive', 'capabilities.thinking.types.adaptive']) {
    if (at(raw, path) === true || record(at(raw, path)).supported === true)
      control('adaptive', path, {});
  }
  const types = record(at(raw, 'capabilities.thinking.types'));
  const toggles = Object.entries(types)
    .filter(
      ([key, value]) =>
        ['enabled', 'disabled'].includes(key) &&
        (value === true || record(value).supported === true),
    )
    .map(([key]) => key);
  if (toggles.length) control('toggle', 'capabilities.thinking.types', toggles);
  for (const path of ['chat.reasoning.mandatory', 'reasoning.mandatory']) {
    if (typeof at(raw, path) === 'boolean') reasoning.mandatory = at(raw, path) as boolean;
  }
  if (typeof at(raw, 'reasoning.default_enabled') === 'boolean')
    control('toggle', 'reasoning.default_enabled', {}, at(raw, 'reasoning.default_enabled'));
  return { capabilities, reasoning, raw, source, fetchedAt: Date.now() };
}

export function modelFromMetadata(
  raw: Record<string, unknown>,
  source?: string,
): AgentLabProviderModel | null {
  const id = raw.id ?? raw.key ?? raw.model ?? raw.name;
  if (typeof id !== 'string' || !id.trim()) return null;
  const label = raw.display_name ?? raw.name;
  const metadata = parseModelMetadata(raw, source);
  const reasoningEfforts = modelReasoningEfforts(metadata);
  return {
    id: id.trim(),
    label: typeof label === 'string' && label !== id ? label : undefined,
    capabilities: (
      Object.keys(metadata.capabilities) as Array<keyof typeof metadata.capabilities>
    ).filter((key) => metadata.capabilities[key] === 'supported'),
    metadata,
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  };
}

/** 原生控制仅存元数据，不因档位同名就当作兼容 API 的 reasoning_effort。 */
export function modelReasoningEfforts(metadata: ModelMetadata): string[] | undefined {
  const effort = metadata.reasoning.controls.find((item) => item.kind === 'effort');
  if (
    effort &&
    [
      'thinking.values',
      'capabilities.reasoning.allowed_options',
      'capabilities.effort',
      'reasoning_levels',
    ].includes(effort.source)
  )
    return [];
  if (Array.isArray(effort?.values))
    return effort.values.filter((value): value is string => typeof value === 'string');
  if (metadata.reasoning.supported === false || (!effort && metadata.reasoning.controls.length > 0))
    return [];
  return undefined;
}
