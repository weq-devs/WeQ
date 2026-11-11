import { replaceEqualDeep } from '@tanstack/react-query';
import type { Conversation, ConversationPreference } from '../im-template/template/types';

export interface ConversationDirectoryState {
  unreadCount?: number;
  highlights: Conversation['highlights'];
  pinnedAt?: number;
  pinStateKnown: boolean;
  activityTime: number;
}

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
  const directoryRows = new WeakMap<
    Conversation,
    ConversationDirectoryState & { defaults: Readonly<ConversationPreference>; row: Conversation }
  >();
  return {
    directory(
      row: Conversation,
      state: Readonly<ConversationDirectoryState>,
      defaults: Readonly<ConversationPreference>,
    ): Conversation {
      const { unreadCount, highlights, pinnedAt, pinStateKnown, activityTime } = state;
      if (
        unreadCount === undefined &&
        !highlights &&
        pinnedAt === undefined &&
        !activityTime &&
        !pinStateKnown
      ) {
        directoryRows.delete(row);
        return row;
      }
      const previous = directoryRows.get(row);
      if (
        previous &&
        previous.defaults === defaults &&
        Object.is(previous.unreadCount, unreadCount) &&
        previous.highlights === highlights &&
        Object.is(previous.pinnedAt, pinnedAt) &&
        previous.pinStateKnown === pinStateKnown &&
        Object.is(previous.activityTime, activityTime)
      )
        return previous.row;
      const projected: Conversation = {
        ...row,
        activityTime,
        ...(pinStateKnown
          ? {
              pinStateKnown: true,
              pinnedAt,
              preference: { ...defaults, ...row.preference, pinned: pinnedAt !== undefined },
            }
          : {}),
        ...(unreadCount === undefined ? {} : { unreadCount }),
        ...(pinnedAt === undefined
          ? {}
          : {
              preference: { ...defaults, ...row.preference, pinned: true },
              pinnedAt,
            }),
        highlights,
      };
      const shared = previous ? replaceEqualDeep(previous.row, projected) : projected;
      directoryRows.set(row, { ...state, defaults, row: shared });
      return shared;
    },
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
