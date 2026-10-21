import type { Message } from '../../im-template/template/types';
import {
  createEmptyDraft,
  mfId,
  segLabel,
  segHasContent,
  segsToRenderElements,
  senderAvatarUrl,
  type MfDraft,
  type MfNode,
  type MfSeg,
  createNode,
  coerceDraft,
  MAX_COMPOSITION_DEPTH,
} from './model';

export interface CompositionBinding {
  expectedAccountUin: string;
  expectedAccountConfigId: string;
}
export interface CompositionRequest {
  id: string;
  draft: MfDraft;
  pending?: boolean;
  error?: string;
}
export const COMPOSITION_DRAG_TYPE = 'application/x-weq-composition-entry';

/** 单份坏记录留在原存储并单独反馈，不让列表归一化异常卸载整个合成窗口。 */
export function readCompositionEntries(raw: readonly unknown[]): {
  drafts: MfDraft[];
  rejected: { id: string; title: string; error: string }[];
} {
  if (!Array.isArray(raw))
    return {
      drafts: [],
      rejected: [{ id: 'invalid-list', title: '记录列表', error: '素材列表损坏' }],
    };
  const drafts: MfDraft[] = [],
    rejected: { id: string; title: string; error: string }[] = [];
  for (const [index, value] of raw.entries())
    try {
      drafts.push(coerceDraft(value as Parameters<typeof coerceDraft>[0]));
    } catch (cause) {
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      rejected.push({
        id: typeof record.id === 'string' && record.id ? record.id : `invalid-${index}`,
        title: typeof record.title === 'string' && record.title ? record.title : '损坏记录',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  return { drafts, rejected };
}

/** 落点是移动前的消息间隙；向后移动时扣除原节点占据的位置。 */
export function moveCompositionNode(nodes: MfNode[], id: string, at: number): MfNode[] {
  const from = nodes.findIndex((node) => node.id === id);
  if (from < 0 || !Number.isInteger(at)) return nodes;
  const slot = Math.max(0, Math.min(at, nodes.length));
  const to = slot > from ? slot - 1 : slot;
  if (to === from) return nodes;
  const next = [...nodes];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function compositionInsertionError(
  draft: MfDraft,
  entry: MfDraft,
  kind: 'material' | 'history',
  flatten = false,
): string | null {
  let source: MfDraft, target: MfDraft;
  try {
    source = coerceDraft(entry);
    target = coerceDraft(draft);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const contains = (segments: MfSeg[]): boolean =>
    segments.some(
      (segment) =>
        segment.t === 'node' &&
        (segment.sourceCompositionId === target.id || contains(segment.segs)),
    );
  if (
    source.id === target.id ||
    source.nodes.some((node) => node.sourceCompositionId === target.id || contains(node.segs))
  )
    return '不能插入自身或形成循环嵌套的记录';
  if (!source.nodes.length) return '记录中没有可插入的消息';
  const depth = (segments: MfSeg[]): number =>
    Math.max(0, ...segments.map((segment) => (segment.t === 'node' ? 1 + depth(segment.segs) : 0)));
  const added = kind === 'history' && !flatten ? 1 : 0;
  if (source.nodes.some((node) => depth(node.segs) + added >= MAX_COMPOSITION_DEPTH))
    return `合成内容最多支持 ${MAX_COMPOSITION_DEPTH} 层嵌套`;
  return null;
}

/** 插入的是独立快照；来源标记随嵌套保留，用于拦截间接回环。 */
export function insertCompositionEntry(
  draft: MfDraft,
  entry: MfDraft,
  kind: 'material' | 'history',
  at = draft.nodes.length,
  flatten = false,
): MfDraft {
  const problem = compositionInsertionError(draft, entry, kind, flatten);
  if (problem) throw new Error(problem);
  const copies = appendCompositionNodes({ ...draft, nodes: [] }, entry.nodes).nodes;
  const inserted =
    kind === 'history' && !flatten && copies.length
      ? [
          {
            ...createNode(
              copies[0]!.sender,
              copies.map((node) => ({
                t: 'node' as const,
                id: mfId('seg'),
                userUin: node.sender.uin,
                nickname: node.sender.name,
                time: node.time,
                segs: node.segs,
                ...(node.decoration ? { decoration: node.decoration } : {}),
                ...(node.sourceCompositionId
                  ? { sourceCompositionId: node.sourceCompositionId }
                  : {}),
              })),
            ),
            sourceCompositionId: entry.id,
          },
        ]
      : copies;
  const nodes = [...draft.nodes];
  nodes.splice(Math.max(0, Math.min(at, nodes.length)), 0, ...inserted);
  return { ...draft, nodes, updatedAt: Math.floor(Date.now() / 1000) };
}

/** 同一身份仅保留优先来源，旧历史与草稿不再作为两套列表展示。 */
export function compositionRecords(...sources: readonly (readonly MfDraft[])[]): MfDraft[] {
  const records = new Map<string, MfDraft>();
  for (const source of sources)
    for (const record of source) if (!records.has(record.id)) records.set(record.id, record);
  return [...records.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
  );
}

export function appendCompositionNodes(draft: MfDraft, nodes: readonly MfNode[]): MfDraft {
  const copies = structuredClone(coerceDraft({ ...draft, nodes: [...nodes] }).nodes);
  const identify = (segments: MfSeg[]) => {
    for (const segment of segments) {
      segment.id = mfId('seg');
      if (segment.t === 'node') identify(segment.segs);
    }
  };
  for (const node of copies) {
    node.id = mfId('node');
    identify(node.segs);
  }
  return { ...draft, updatedAt: Math.floor(Date.now() / 1000), nodes: [...draft.nodes, ...copies] };
}

export function compositionText(draft: MfDraft): string {
  const text = (segments: readonly MfSeg[]): string =>
    segments
      .map((segment) => {
        if (segment.t === 'text') return segment.text;
        if (segment.t === 'at')
          return segment.all ? '@全体成员' : `@${segment.name || segment.uin || segment.uid}`;
        if (segment.t === 'markdown') return segment.content;
        if (segment.t === 'reply')
          return `> ${segment.senderName || ''} ${segment.summary || '引用消息'}\n`;
        if (segment.t === 'node') return `\n${segment.nickname}\n${text(segment.segs)}\n`;
        return `[${segLabel(segment)}]`;
      })
      .join('');
  return draft.nodes.map((node) => `${node.sender.name}\n${text(node.segs)}`).join('\n\n');
}

export function compositionMessages(draft: MfDraft): Message[] {
  return draft.nodes
    .filter((node) => node.segs.some(segHasContent))
    .map(
      (node) =>
        ({
          id: node.id,
          conversationId: draft.id,
          senderId: node.sender.uid || node.sender.uin,
          sender: {
            id: node.sender.uid || node.sender.uin,
            uid: node.sender.uid,
            identityLabel: 'QQ',
            identityValue: node.sender.uin,
            username: node.sender.uid || node.sender.uin,
            displayName: node.sender.name,
            avatarUrl: senderAvatarUrl(node.sender.uin),
          },
          createdAt: new Date(node.time * 1000).toISOString(),
          body: compositionText({ ...createEmptyDraft(), nodes: [node] }),
          qqElements: segsToRenderElements(node.segs),
        }) as Message,
    );
}
