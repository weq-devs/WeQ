import type { RepeatElement } from './messageRepeat';

export interface MentionIdentity {
  uid?: string;
  uin?: string;
  nick?: string | null;
}

/** 发出的提及只使用昵称；显示名可能含私有备注，不能作为回退。 */
export function mentionName(person: MentionIdentity): string {
  return person.nick?.trim() || person.uin?.trim() || person.uid || '';
}

/** 按唯一身份查昵称，绝不沿用来源文字或本地备注。 */
export function resolveMentionLabels(
  elements: RepeatElement[],
  people: readonly MentionIdentity[],
): RepeatElement[] {
  return elements.map((element) => {
    const data = element.data ?? {};
    if (element.type === 'at') {
      const uid = typeof data.atTargetUid === 'string' ? data.atTargetUid : '';
      const uin = String(data.atTargetUin ?? '');
      const person = people.find((candidate) =>
        uid ? candidate.uid === uid : Boolean(uin) && candidate.uin === uin,
      );
      const label =
        uid === 'all' || data.all === true ? '全体成员' : mentionName(person ?? { uid, uin });
      const suffix =
        typeof data.textContent === 'string' ? (/\s+$/u.exec(data.textContent)?.[0] ?? '') : '';
      return {
        ...element,
        data: {
          ...data,
          textContent: `@${label}${suffix}`,
          ...(!uid && person?.uid ? { atTargetUid: person.uid } : {}),
        },
      };
    }
    if (element.type === 'reply' && Array.isArray(data.origElements))
      return {
        ...element,
        data: { ...data, origElements: resolveMentionLabels(data.origElements, people) },
      };
    return element;
  });
}

/** 发送计划使用 kind 形状，引用中的元素也需递归转换，解析后恢复原发送结构。 */
export async function resolveSendMentions(
  elements: unknown[],
  resolve: (elements: RepeatElement[]) => Promise<RepeatElement[]>,
): Promise<unknown[]> {
  function toRepeat(element: unknown): RepeatElement {
    const data = element as Record<string, unknown>;
    return {
      type: typeof data.kind === 'string' ? data.kind : undefined,
      data:
        data.kind === 'reply' && Array.isArray(data.origElements)
          ? { ...data, origElements: data.origElements.map(toRepeat) }
          : data,
    };
  }
  function toSend(element: RepeatElement): unknown {
    const data = element.data ?? {};
    return element.type === 'reply' && Array.isArray(data.origElements)
      ? { ...data, origElements: data.origElements.map(toSend) }
      : data;
  }
  const pending = elements.map(toRepeat);
  if (!pending.some((element) => element.type === 'at' || element.type === 'reply'))
    return elements;
  return (await resolve(pending)).map(toSend);
}
