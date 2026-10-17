import type { RepeatElement } from './messageRepeat';

export interface MentionIdentity {
  uid?: string;
  uin?: string;
  name: string;
}

/** 名称只来自当前账号的身份表，绝不按复制来的备注文字猜人。 */
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
        uid === 'all' || data.all === true ? '全体成员' : person?.name || person?.uin || uid || uin;
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
