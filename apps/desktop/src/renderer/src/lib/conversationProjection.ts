import type { Conversation } from '../im-template/template/types';

/** 当前映射上下文内复用不可变输入；弱键不延长离开查询缓存的资料或会话生命周期。 */
export function createConversationProjection<Detail extends object>(
  projectGroup: (detail: Detail, previous?: Conversation) => Conversation,
) {
  const groups = new WeakMap<
    Detail,
    {
      withoutPrevious?: Conversation;
      previous: WeakMap<Conversation, Conversation>;
    }
  >();
  const memberships = new WeakMap<Conversation, { listed: boolean; row: Conversation }>();
  return {
    group(detail: Detail, previous?: Conversation): Conversation {
      let entry = groups.get(detail);
      if (!entry) {
        entry = { previous: new WeakMap() };
        groups.set(detail, entry);
      }
      const cached = previous ? entry.previous.get(previous) : entry.withoutPrevious;
      if (cached) return cached;
      const row = projectGroup(detail, previous);
      if (previous) entry.previous.set(previous, row);
      else entry.withoutPrevious = row;
      return row;
    },
    membership(row: Conversation, listed: boolean): Conversation {
      if (row.type !== 'group') return row;
      if (row.group.membershipKnown && row.group.listed === listed) return row;
      const previous = memberships.get(row);
      if (previous?.listed === listed) return previous.row;
      const projected: Conversation = {
        ...row,
        group: { ...row.group, listed, membershipKnown: true },
      };
      memberships.set(row, { listed, row: projected });
      return projected;
    },
  };
}
