import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { writeFileAtomicSync } from '../common/atomic_write';
import { isWeqBackgroundName } from '../common/backup_account_paths';
import type { CallBackground } from './call_background';

export interface DressConversation {
  kind: 'c2c' | 'group';
  conv: string;
}

export type DressConversationSlot = 'callbg' | 'background' | 'screen';
export type DressConversationChoices = {
  callbg: CallBackground;
  background: ({ source: 'qq' } | { source: 'custom'; file: string }) & { opacity: number };
  screen: { widgetId: string; opacity: number };
};
export type DressConversationChange = {
  [K in DressConversationSlot]: {
    slot: K;
    value: DressConversationChoices[K] | 'off' | null;
  };
}[DressConversationSlot];

export type DressConversationEntry = DressConversation & {
  title: string;
} & { [K in DressConversationSlot]?: DressConversationChoices[K] | 'off' };

function dressConversationKey({ kind, conv }: DressConversation): string {
  return `${kind}:${conv}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOpacity(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function isCallBackground(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.itemId === 'number' &&
    Number.isSafeInteger(value.itemId) &&
    value.itemId > 0 &&
    typeof value.name === 'string' &&
    typeof value.imageUrl === 'string' &&
    typeof value.videoUrl === 'string' &&
    Boolean(value.imageUrl || value.videoUrl)
  );
}

function isChatBackground(value: unknown): boolean {
  return (
    record(value) &&
    isOpacity(value.opacity) &&
    (value.source === 'qq' ||
      (value.source === 'custom' &&
        typeof value.file === 'string' &&
        isWeqBackgroundName(value.file)))
  );
}

function isScreenWidget(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.widgetId === 'string' &&
    /^[0-9]+$/.test(value.widgetId) &&
    isOpacity(value.opacity)
  );
}

export function isDressConversationEntries(
  value: unknown,
): value is Record<string, DressConversationEntry> {
  if (!record(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (!record(entry)) return false;
    const { kind, conv, title, callbg, background, screen } = entry;
    if (
      (kind !== 'c2c' && kind !== 'group') ||
      typeof conv !== 'string' ||
      !conv ||
      conv.length > 128 ||
      typeof title !== 'string' ||
      !title ||
      title.length > 256 ||
      key !== dressConversationKey({ kind, conv })
    )
      return false;
    return (
      (callbg === undefined ||
        (kind === 'c2c' && (callbg === 'off' || isCallBackground(callbg)))) &&
      (background === undefined || background === 'off' || isChatBackground(background)) &&
      (screen === undefined || screen === 'off' || isScreenWidget(screen))
    );
  });
}

export function dressConversationBackgroundFiles(entries: Record<string, DressConversationEntry>) {
  const files = new Set<string>();
  for (const { background } of Object.values(entries))
    if (background && background !== 'off' && background.source === 'custom')
      files.add(background.file);
  return files;
}

/** 按账号数据源保存。缺少任意一项时，该项跟随全局。 */
export class DressConversationStore {
  private readonly path: string;

  constructor(private readonly directory: string) {
    this.path = join(directory, 'dress-conversations.json');
  }

  read(): Record<string, DressConversationEntry> {
    if (!existsSync(this.path)) return {};
    const saved: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!isDressConversationEntries(saved)) throw new Error('会话装扮配置无效');
    return saved;
  }

  get(conversation: DressConversation): DressConversationEntry | undefined {
    return this.read()[dressConversationKey(conversation)];
  }

  set(conversation: DressConversation & { title: string }, change: DressConversationChange) {
    const entries = this.read();
    const key = dressConversationKey(conversation);
    const entry = { ...entries[key], ...conversation };
    if (change.value === null) delete entry[change.slot];
    else Object.assign(entry, { [change.slot]: change.value });
    if (entry.callbg || entry.background || entry.screen) entries[key] = entry;
    else delete entries[key];
    if (!isDressConversationEntries(entries)) throw new Error('会话装扮配置无效');
    writeFileAtomicSync(this.path, JSON.stringify(entries));
    return entries;
  }

  setOpacity(
    conversation: DressConversation & { title: string },
    slot: 'background' | 'screen',
    opacity: number,
  ) {
    const entry = this.get(conversation);
    if (slot === 'background' && entry?.background && entry.background !== 'off')
      return this.set(conversation, { slot, value: { ...entry.background, opacity } });
    if (slot === 'screen' && entry?.screen && entry.screen !== 'off')
      return this.set(conversation, { slot, value: { ...entry.screen, opacity } });
    throw new Error('请先单独选择这个会话的装扮');
  }

  setBackgroundFile(conversation: DressConversation & { title: string }, source: string) {
    const bytes = readFileSync(source);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = `bg-${hash}${extname(source).toLowerCase()}`;
    if (!isWeqBackgroundName(file)) throw new Error('不支持这类背景文件');
    const target = join(this.directory, file);
    if (!existsSync(target)) writeFileAtomicSync(target, bytes);
    const previous = this.get(conversation)?.background;
    return this.set(conversation, {
      slot: 'background',
      value: {
        source: 'custom',
        file,
        opacity: previous && previous !== 'off' ? previous.opacity : 1,
      },
    });
  }

  backgroundFile(conversation: DressConversation, stamp: string): string | null {
    const choice = this.get(conversation)?.background;
    if (!choice || choice === 'off' || choice.source !== 'custom') return null;
    if (choice.file !== stamp || !isWeqBackgroundName(stamp)) return null;
    const path = join(this.directory, stamp);
    return existsSync(path) ? path : null;
  }
}
