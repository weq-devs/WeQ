import { parseWeqBackupJson, type WeqBackupBundle } from './backup_bundle';
import {
  validateWeqAppSettings,
  validateWeqApiSettings,
  validateWeqAccountSettings,
} from './backup_settings';
import { validateWeqClientSettings } from '../common/backup_client';
import { normalizeExportPresets } from './user_config';
import { validateWeqAccountPreference } from './backup_accounts';
import {
  WEQ_ACCOUNT_SETTING_FILES,
  type WeqAccountSettingFile,
} from '../common/backup_account_paths';
import { normalizeCloneGeneration, CLONE_GENERATION_KEYS } from '@weq/agentlab';

function invalid(path: string): never {
  throw new Error(`备份数据结构无效：${path}`);
}
function row(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string): void {
  if (typeof value !== 'string') invalid(path);
}
function number(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path);
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path);
  return value;
}
function strings(value: unknown, path: string): void {
  for (const item of array(value, path)) text(item, path);
}
function ref(value: unknown, path: string): void {
  const entry = row(value, path);
  text(entry.providerId, path);
  text(entry.model, path);
}
function session(value: unknown, path: string): void {
  const entry = row(value, path);
  for (const key of ['id', 'title']) text(entry[key], `${path}.${key}`);
  for (const key of ['createdAt', 'updatedAt'])
    if (entry[key] !== undefined) number(entry[key], `${path}.${key}`);
}
function plan(value: unknown, path: string): void {
  const entry = row(value, path);
  text(entry.title, path);
  text(entry.question, path);
  for (const step of array(entry.steps, path)) {
    const item = row(step, path);
    text(item.id, path);
    text(item.title, path);
    if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed')
      invalid(path);
  }
}
function assistantStep(value: unknown, path: string): void {
  const entry = row(value, path);
  switch (entry.kind) {
    case 'thinking':
    case 'text_delta':
    case 'reasoning_delta':
    case 'final':
      text(entry.text, path);
      break;
    case 'error':
      text(entry.message, path);
      break;
    case 'aborted':
      break;
    case 'tool_call':
      text(entry.id, path);
      text(entry.name, path);
      break;
    case 'tool_result':
      text(entry.id, path);
      text(entry.name, path);
      text(entry.preview, path);
      if (typeof entry.ok !== 'boolean') invalid(path);
      break;
    case 'notes':
      strings(entry.notes, path);
      break;
    case 'plan':
      plan(entry.plan, path);
      break;
    case 'compaction':
      text(entry.summary, path);
      number(entry.foldedTurns, path);
      break;
    case 'artifact': {
      const artifact = row(entry.artifact, path);
      for (const key of ['id', 'name', 'mime']) text(artifact[key], path);
      if (
        artifact.kind !== 'html' &&
        artifact.kind !== 'markdown' &&
        artifact.kind !== 'text' &&
        artifact.kind !== 'export'
      )
        invalid(path);
      number(artifact.bytes, path);
      break;
    }
    default:
      invalid(path);
  }
}
function sticker(value: unknown, path: string): void {
  const entry = row(value, path);
  for (const key of ['md5', 'fileName', 'cdnToken', 'description', 'scenario'])
    text(entry[key], `${path}.${key}`);
  number(entry.count, `${path}.count`);
  if (entry.contexts !== undefined) strings(entry.contexts, `${path}.contexts`);
}
function conversation(value: unknown, path: string): void {
  const entry = row(value, path);
  if (entry.role !== 'user' && entry.role !== 'assistant') invalid(`${path}.role`);
  text(entry.text, `${path}.text`);
  number(entry.ts, `${path}.ts`);
  if (entry.id !== undefined) text(entry.id, `${path}.id`);
  if (entry.toolsUsed !== undefined) strings(entry.toolsUsed, `${path}.toolsUsed`);
  if (entry.steps !== undefined)
    for (const step of array(entry.steps, `${path}.steps`)) assistantStep(step, `${path}.steps`);
}
function groupMessage(value: unknown, path: string): void {
  const entry = row(value, path);
  for (const key of ['id', 'groupId', 'senderId', 'text']) text(entry[key], `${path}.${key}`);
  if (entry.senderKind !== 'user' && entry.senderKind !== 'persona') invalid(`${path}.senderKind`);
  number(entry.ts, `${path}.ts`);
  if (entry.mentions !== undefined) strings(entry.mentions, `${path}.mentions`);
  if (entry.replyToId !== undefined) text(entry.replyToId, `${path}.replyToId`);
  if (entry.actions !== undefined)
    for (const action of array(entry.actions, `${path}.actions`)) {
      const item = row(action, path);
      if (item.kind === 'sticker') sticker(item.sticker, path);
      else if (item.kind === 'text' || item.kind === 'voice') text(item.text, path);
      else invalid(`${path}.actions.kind`);
    }
}
function buckets(
  value: unknown,
  path: string,
  validate: (value: unknown, path: string) => void,
): void {
  for (const [key, list] of Object.entries(row(value, path)))
    for (const entry of array(list, `${path}.${key}`)) validate(entry, `${path}.${key}`);
}

function persona(value: unknown, path: string, id: string): void {
  const stored = row(value, path);
  const item = row(stored.persona, `${path}.persona`);
  if (item.id !== id || (item.sourceKind !== 'c2c' && item.sourceKind !== 'group')) invalid(path);
  for (const key of ['id', 'ownerId', 'name', 'sourceId', 'sourceTitle'])
    text(item[key], `${path}.${key}`);
  if (item.customPrompt !== undefined) text(item.customPrompt, `${path}.customPrompt`);
  if (item.voiceCloneEnabled !== undefined && typeof item.voiceCloneEnabled !== 'boolean')
    invalid(`${path}.voiceCloneEnabled`);
  if (item.generation !== undefined) {
    const generation = row(item.generation, `${path}.generation`);
    const normalized = normalizeCloneGeneration(generation);
    for (const [key, value] of Object.entries(generation))
      if (
        !CLONE_GENERATION_KEYS.includes(key as (typeof CLONE_GENERATION_KEYS)[number]) ||
        value !== normalized[key as keyof typeof normalized]
      )
        invalid(`${path}.generation.${key}`);
  }
  for (const [name, booleanKeys, numberKey, min, max] of [
    ['willing', ['gatePrivate', 'mustReplyOnMention'], 'level', 0, 100],
    ['typo', ['enabled'], 'intensity', 0, 1],
  ] as const)
    if (item[name] !== undefined) {
      const options = row(item[name], `${path}.${name}`);
      for (const key of booleanKeys)
        if (options[key] !== undefined && typeof options[key] !== 'boolean')
          invalid(`${path}.${name}.${key}`);
      const value = options[numberKey];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      )
        invalid(`${path}.${name}.${numberKey}`);
    }
  for (const key of ['corpusMessageCount', 'pairCount', 'createdAt', 'updatedAt'])
    number(item[key], `${path}.${key}`);
  const models = row(item.models, `${path}.models`);
  ref(models.chat, `${path}.models.chat`);
  for (const key of ['embedding', 'vision', 'voiceClone'])
    if (models[key] !== undefined) ref(models[key], `${path}.models.${key}`);
  const profile = row(item.profile, `${path}.profile`);
  for (const key of ['styleSummary', 'voiceUsageSummary', 'relationshipSummary'])
    text(profile[key], `${path}.profile.${key}`);
  number(profile.voiceRatio, `${path}.profile.voiceRatio`);
  strings(profile.topTerms, `${path}.profile.topTerms`);
  if (typeof profile.extractedByLlm !== 'boolean') invalid(`${path}.profile.extractedByLlm`);
  if (profile.extractError !== undefined)
    text(profile.extractError, `${path}.profile.extractError`);
  const card = row(profile.card, `${path}.profile.card`);
  for (const key of ['tone', 'punctuationStyle', 'addressing'])
    text(card[key], `${path}.profile.card.${key}`);
  for (const key of ['personalityTraits', 'catchphrases', 'topics'])
    strings(card[key], `${path}.profile.card.${key}`);
  const deep = row(profile.deep, `${path}.profile.deep`);
  text(deep.relationship, `${path}.profile.deep.relationship`);
  for (const key of ['facts', 'reactionPatterns', 'boundaries'])
    strings(deep[key], `${path}.profile.deep.${key}`);
  if (deep.sharedEvents !== undefined)
    strings(deep.sharedEvents, `${path}.profile.deep.sharedEvents`);
  const stats = row(item.stats, `${path}.stats`);
  for (const key of [
    'sourceMessageCount',
    'friendMessageCount',
    'avgFriendMsgChars',
    'avgFriendBurst',
    'turnCount',
    'pairCount',
    'corpusChars',
  ])
    number(stats[key], `${path}.stats.${key}`);
  if (stats.groupStyleMessageCount !== undefined)
    number(stats.groupStyleMessageCount, `${path}.stats.groupStyleMessageCount`);
  for (const pair of array(item.fewShots, `${path}.fewShots`)) {
    const entry = row(pair, path);
    text(entry.prompt, path);
    text(entry.reply, path);
  }
  for (const pair of array(stored.pairs, `${path}.pairs`)) {
    const entry = row(pair, path);
    for (const key of ['id', 'prompt', 'reply']) text(entry[key], `${path}.pairs.${key}`);
    for (const key of ['replies', 'keywords']) strings(entry[key], `${path}.pairs.${key}`);
    if (entry.embedding !== undefined)
      for (const n of array(entry.embedding, path)) number(n, path);
  }
  for (const entry of array(item.stickers, `${path}.stickers`)) sticker(entry, `${path}.stickers`);
  if (item.systemFaces !== undefined) strings(item.systemFaces, `${path}.systemFaces`);
  if (item.styleVariants !== undefined) strings(item.styleVariants, `${path}.styleVariants`);
  if (item.expressions !== undefined)
    for (const expression of array(item.expressions, path)) {
      const entry = row(expression, path);
      text(entry.situation, path);
      text(entry.style, path);
      number(entry.count, path);
    }
  if (item.voiceProfile !== undefined) {
    const voice = row(item.voiceProfile, path);
    number(voice.ratio, `${path}.voiceProfile.ratio`);
    text(voice.scenarioSummary, `${path}.voiceProfile.scenarioSummary`);
    if (voice.refClips !== undefined)
      for (const clip of array(voice.refClips, path)) {
        const entry = row(clip, path);
        text(entry.path, path);
        text(entry.text, path);
        if (entry.durationMs !== undefined) number(entry.durationMs, path);
      }
  }
  if (item.voice !== undefined) {
    const voice = row(item.voice, path);
    text(voice.providerId, path);
    if (voice.mode !== 'clone' && voice.mode !== 'preset') invalid(`${path}.voice.mode`);
    if (voice.voice !== undefined) text(voice.voice, path);
  }
}

function cloneData(value: unknown, path: string): void {
  const name = path.split('/')[2]!;
  if (name === 'reports') return;
  if (name === 'assistant_runs') {
    const entry = row(value, path);
    if (
      entry.schemaVersion !== 1 ||
      typeof entry.sessionId !== 'string' ||
      `${entry.sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)}.json` !==
        path.split('/')[3]
    )
      invalid(path);
    const messages = array(entry.messages, path);
    if (messages.length < 2 || (entry.status !== 'running' && entry.status !== 'aborted'))
      invalid(path);
    for (const message of messages) {
      const item = row(message, path);
      text(item.role, path);
      if (item.tool_call_id !== undefined) text(item.tool_call_id, path);
      if (item.tool_calls !== undefined && item.tool_calls !== null)
        for (const call of array(item.tool_calls, path)) {
          const tool = row(call, path),
            fn = row(tool.function, path);
          text(tool.id, path);
          text(tool.type, path);
          text(fn.name, path);
          text(fn.arguments, path);
        }
    }
    text(entry.question, path);
    text(entry.basePrompt, path);
    if (entry.workspace !== undefined) {
      const workspace = row(entry.workspace, path);
      strings(workspace.notes, path);
      if (workspace.plan !== undefined && workspace.plan !== null) plan(workspace.plan, path);
    }
    if (entry.summary !== undefined) text(entry.summary, path);
    for (const key of ['toolCallCount', 'startedAt', 'updatedAt'])
      if (entry[key] !== undefined) number(entry[key], path);
    return;
  }
  if (name === 'assistant_sessions.json') {
    for (const entry of array(value, path)) session(entry, path);
    return;
  }
  if (name === 'usage.json') {
    for (const item of array(value, path)) {
      const entry = row(item, path);
      text(entry.model, path);
      text(entry.scope, path);
      number(entry.ts, path);
      for (const key of ['promptTokens', 'completionTokens', 'totalTokens'])
        if (entry[key] !== null && entry[key] !== undefined) number(entry[key], path);
    }
    return;
  }
  if (name === 'conversations.json') {
    buckets(value, path, conversation);
    return;
  }
  if (name === 'sessions.json') {
    buckets(value, path, session);
    return;
  }
  if (name === 'group_session_messages.json') {
    buckets(value, path, groupMessage);
    return;
  }
  if (name === 'memories.json') {
    buckets(value, path, (value, where) => {
      const entry = row(value, where);
      for (const key of ['id', 'text']) text(entry[key], where);
      strings(entry.keywords, where);
      if (entry.aboutId !== undefined) text(entry.aboutId, where);
      if (
        entry.aboutKind !== undefined &&
        entry.aboutKind !== 'user' &&
        entry.aboutKind !== 'persona'
      )
        invalid(where);
      if (entry.embedding !== undefined)
        for (const item of array(entry.embedding, where)) number(item, where);
      for (const key of ['accessCount', 'createdAt', 'lastAccessedAt']) number(entry[key], where);
    });
    return;
  }
  if (name === 'notes.json') {
    for (const note of Object.values(row(value, path))) {
      const entry = row(note, path);
      strings(entry.corrections, path);
      strings(entry.episodes, path);
    }
    return;
  }
  if (name === 'assistant.json') {
    const entry = row(value, path);
    if (entry.model !== undefined) ref(entry.model, path);
    for (const key of ['customPrompt', 'mcpServers'])
      if (entry[key] !== undefined) text(entry[key], path);
    if (
      entry.reasoningEffort !== undefined &&
      !['off', 'low', 'medium', 'high'].includes(String(entry.reasoningEffort))
    )
      invalid(path);
    return;
  }
  if (name === 'groups.json') {
    const groups = row(value, path);
    for (const group of Object.values(row(groups.groups ?? {}, path))) {
      const entry = row(group, path);
      for (const key of ['id', 'name', 'ownerId']) text(entry[key], path);
    }
    for (const memberList of Object.values(row(groups.members ?? {}, path)))
      for (const member of array(memberList, path)) {
        const entry = row(member, path);
        for (const key of ['memberId', 'groupId', 'displayName']) text(entry[key], path);
        number(entry.joinedAt, path);
        if (entry.kind !== 'user' && entry.kind !== 'persona') invalid(path);
      }
    buckets(groups.messages ?? {}, path, groupMessage);
    return;
  }
  if (name === 'relations.json') {
    for (const relation of Object.values(row(value, path))) {
      const entry = row(relation, path);
      text(entry.subjectPersonaId, path);
      text(entry.objectId, path);
      if (entry.objectKind !== 'user' && entry.objectKind !== 'persona') invalid(path);
      for (const key of [
        'affinity',
        'familiarity',
        'mood',
        'interactionCount',
        'lastInteractAt',
        'updatedAt',
      ])
        number(entry[key], path);
    }
    return;
  }
  persona(value, path, name.slice(0, -5));
}

/** 在展示导入预览与暂存前检查业务形状，不能用 ZIP 校验成功代替业务可加载。 */
export function validateWeqBackupData(bundle: WeqBackupBundle): void {
  for (const file of bundle.files) {
    if (!file.path.endsWith('.json')) continue;
    const value = parseWeqBackupJson(file.data);
    if (file.path === 'settings/app.json') validateWeqAppSettings(value);
    else if (file.path === 'settings/client.json') validateWeqClientSettings(value);
    else if (file.path === 'settings/export-presets.json') {
      const input = row(value, file.path);
      const normalized = normalizeExportPresets(value);
      if (Object.keys(input).some((key) => !Object.hasOwn(normalized, key))) invalid(file.path);
    } else if (file.path === 'api/settings.json') validateWeqApiSettings(value);
    else if (file.path.startsWith('accounts/')) {
      if (file.path.split('/').length === 2)
        validateWeqAccountSettings(value, file.path.split('/')[1]!.slice(0, -5));
      else if (WEQ_ACCOUNT_SETTING_FILES.includes(file.path.split('/')[2] as WeqAccountSettingFile))
        validateWeqAccountPreference(file.path.split('/')[2] as WeqAccountSettingFile, value);
    } else if (file.path.startsWith('clones/')) cloneData(value, file.path);
  }
}
