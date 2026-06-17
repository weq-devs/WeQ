/**
 * Account-scoped router — only usable once `bootstrap.openAccount`
 * resolved. Every procedure asserts an account session is open and
 * throws otherwise.
 *
 * `bigint` fields (uin / msgId / msgSeq / sendTime) are stringified at the IPC
 * boundary (see `../serde.ts`). The renderer `BigInt(s)`-es seq values back for
 * cursor arithmetic; most other fields are displayed as text.
 *
 * Messages load as a *seq window* (see MsgService): `listLatest` for the newest
 * page, `listBefore` to page up, `listFrom` to re-read the loaded window live.
 */

import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { getAppContext, dbEventBus, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { toRenderElements, type NewMessages, type DbChange } from '@weq/service';
import {
  buddyRequestToWire,
  buddyToWire,
  categoryToWire,
  c2cMsgToWire,
  forwardRecordToWire,
  groupBulletinToWire,
  groupMsgToWire,
  recentContactToWire,
  userProfileToWire,
  groupDetailToWire,
  groupEssenceToWire,
  groupMemberToWire,
  groupMemberLevelInfoToWire,
  msgSearchHitToWire,
  onlineStatusToWire,
  type ChatMsgWire,
} from '../serde';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** Wire payload pushed to the renderer when nt_msg.db gains new rows. */
export interface NewMessagesWire {
  messages: ChatMsgWire[];
}

type ChatKind = 'c2c' | 'group';

const convInput = z.object({
  kind: z.enum(['c2c', 'group']),
  /** Conversation key: peer uid (c2c) or group code (group). */
  conv: z.string().min(1),
});

const pageInput = z.object({
  limit: z.number().int().min(1).max(2000).default(100),
  offset: z.number().int().min(0).default(0),
});

const groupPageInput = pageInput.extend({
  groupCode: z.string().min(1),
});

async function fetchLatest(kind: ChatKind, conv: string, limit: number): Promise<ChatMsgWire[]> {
  const msgs = requireServices().msgs;
  return kind === 'group'
    ? (await msgs.getGroupLatest(conv, limit)).map(groupMsgToWire)
    : (await msgs.getC2cLatest(conv, limit)).map(c2cMsgToWire);
}

async function fetchBefore(
  kind: ChatKind,
  conv: string,
  beforeSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const msgs = requireServices().msgs;
  return kind === 'group'
    ? (await msgs.getGroupBefore(conv, beforeSeq, limit)).map(groupMsgToWire)
    : (await msgs.getC2cBefore(conv, beforeSeq, limit)).map(c2cMsgToWire);
}

async function fetchFrom(
  kind: ChatKind,
  conv: string,
  sinceSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const msgs = requireServices().msgs;
  return kind === 'group'
    ? (await msgs.getGroupFrom(conv, sinceSeq, limit)).map(groupMsgToWire)
    : (await msgs.getC2cFrom(conv, sinceSeq, limit)).map(c2cMsgToWire);
}

export const accountRouter = router({
  /** Recent conversations (recent_contact_v3_table), newest first. */
  listRecentContacts: procedure.query(async () => {
    const contacts = await requireServices().recentContacts.getRecentContact(200);
    return contacts.map(recentContactToWire);
  }),

  /** Newest page of a conversation (open / switch-into), newest-first. */
  listLatest: procedure
    .input(convInput.extend({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(({ input }) => fetchLatest(input.kind, input.conv, input.limit)),

  /** The page just older than `beforeSeq` (scroll up), newest-first. */
  listBefore: procedure
    .input(
      convInput.extend({
        beforeSeq: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(({ input }) => fetchBefore(input.kind, input.conv, BigInt(input.beforeSeq), input.limit)),

  /** Re-read everything with seq >= `sinceSeq` (live refresh of the window). */
  listFrom: procedure
    .input(
      convInput.extend({
        sinceSeq: z.string().min(1),
        limit: z.number().int().min(1).max(1000).default(500),
      }),
    )
    .query(({ input }) => fetchFrom(input.kind, input.conv, BigInt(input.sinceSeq), input.limit)),

  /** Get detailed profile for the currently logged-in user. */
  getSelfProfile: procedure.query(async () => {
    const profile = await requireServices().profile.getSelfProfile();
    return profile ? userProfileToWire(profile) : null;
  }),

  /** List QQ buddies from profile_info.db. */
  listBuddies: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 200, offset: 0 };
      const buddies = await requireServices().profile.listBuddies(page.limit, page.offset);
      return buddies.map(buddyToWire);
    }),

  /** List QQ buddy categories. */
  listCategories: procedure.query(async () => {
    const categories = await requireServices().profile.listCategories();
    return categories.map(categoryToWire);
  }),

  /** List QQ buddy request notifications. */
  listBuddyRequests: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      const requests = await requireServices().profile.listBuddyRequests(page.limit, page.offset);
      return requests.map(buddyRequestToWire);
    }),

  /** Get detailed profile by NT uid. */
  getProfile: procedure
    .input(z.object({ uid: z.string().min(1) }))
    .query(async ({ input }) => {
      const profile = await requireServices().profile.getProfile(input.uid);
      return profile ? userProfileToWire(profile) : null;
    }),

  /** Get detailed profile by QQ uin. */
  getProfileByUin: procedure
    .input(z.object({ uin: z.string().min(1) }))
    .query(async ({ input }) => {
      const profile = await requireServices().profile.getProfileByUin(BigInt(input.uin));
      return profile ? userProfileToWire(profile) : null;
    }),

  /** List cached user profiles. */
  listProfiles: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      const profiles = await requireServices().profile.listProfiles(page.limit, page.offset);
      return profiles.map(userProfileToWire);
    }),

  /** Get group metadata and latest announcement. */
  getGroupDetail: procedure
    .input(z.object({ groupCode: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await requireServices().groupInfo.getGroupDetail(BigInt(input.groupCode));
      return detail ? groupDetailToWire(detail) : null;
    }),

  /** List all groups from group_info.db. */
  listAllGroups: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      const groups = await requireServices().groupInfo.listAllGroups(page.limit, page.offset);
      return groups.map(groupDetailToWire);
    }),

  /** List group announcements. */
  listGroupBulletins: procedure
    .input(groupPageInput)
    .query(async ({ input }) => {
      const bulletins = await requireServices().groupInfo.getGroupBulletins(
        BigInt(input.groupCode),
        input.limit,
        input.offset,
      );
      return bulletins.map(groupBulletinToWire);
    }),

  /** List group essence messages. */
  listGroupEssenceMessages: procedure
    .input(groupPageInput)
    .query(async ({ input }) => {
      const essence = await requireServices().groupInfo.getEssenceMessages(
        BigInt(input.groupCode),
        input.limit,
        input.offset,
      );
      return essence.map(groupEssenceToWire);
    }),

  /** Get group member level definitions. */
  getGroupMemberLevelInfo: procedure
    .input(z.object({ groupCode: z.string().min(1) }))
    .query(async ({ input }) => {
      const info = await requireServices().groupInfo.getMemberLevelInfo(BigInt(input.groupCode));
      return info ? groupMemberLevelInfoToWire(info) : null;
    }),

  /** List members of a group. */
  listGroupMembers: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.listMembersInGroup(
        BigInt(input.groupCode),
        input.limit ?? 100,
        input.offset ?? 0,
      );
      return members.map(groupMemberToWire);
    }),

  /**
   * Batch-resolve group members by uid. Lets the renderer fill in display
   * names for message senders that fall outside the loaded member page,
   * without blocking on a full member fetch.
   */
  getGroupMembersByUids: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        uids: z.array(z.string().min(1)).min(1).max(200),
      }),
    )
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.getMembersByUids(
        BigInt(input.groupCode),
        input.uids,
      );
      return members.map(groupMemberToWire);
    }),

  /** List groups a specific user belongs to. */
  listUserGroups: procedure
    .input(
      z.object({
        uid: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const groups = await requireServices().groupInfo.listUserGroups(
        input.uid,
        input.limit ?? 100,
        input.offset ?? 0,
      );
      return groups.map(groupMemberToWire);
    }),

  /** Get formatted online status for a user. */
  getOnlineStatus: procedure
    .input(z.object({ uid: z.string().min(1) }))
    .query(async ({ input }) => {
      const status = await requireServices().onlineStatus.getOnlineStatus(input.uid);
      return status ? onlineStatusToWire(status) : null;
    }),

  /** Search message FTS indexes. */
  searchMessages: procedure
    .input(
      z.object({
        scope: z.enum(['all', 'buddy', 'group', 'files']).default('all'),
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      const search = requireServices().msgSearch;
      const hits =
        input.scope === 'buddy'
          ? await search.searchBuddy(input.keyword, input.limit)
          : input.scope === 'group'
            ? await search.searchGroup(input.keyword, input.limit)
            : input.scope === 'files'
              ? await search.searchFiles(input.keyword, input.limit)
              : [
                  ...(await search.searchBuddy(input.keyword, input.limit)),
                  ...(await search.searchGroup(input.keyword, input.limit)),
                ]
                  .sort((a, b) => Number(b.sendTime - a.sendTime))
                  .slice(0, input.limit);
      return hits.map(msgSearchHitToWire);
    }),

  /** Search within the open conversation. */
  searchConversationMessages: procedure
    .input(
      convInput.extend({
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      const search = requireServices().msgSearch;
      const hits =
        input.kind === 'group'
          ? await search.searchInGroupConversation(input.conv, input.keyword, input.limit)
          : await search.searchInBuddyConversation(input.conv, input.keyword, input.limit);
      return hits.map(msgSearchHitToWire);
    }),

  /** Get merged-forward / quote-reply cache for one message. */
  getForwardMessages: procedure
    .input(z.object({ kind: z.enum(['c2c', 'group']), msgId: z.string().min(1) }))
    .query(async ({ input }) => {
      const service = requireServices().forwardMsgs;
      const records =
        input.kind === 'group'
          ? await service.getGroupForward(BigInt(input.msgId))
          : await service.getC2cForward(BigInt(input.msgId));
      return records.map(forwardRecordToWire);
    }),

  /**
   * Live "nt_msg.db changed" ping (debounced). Carries no payload beyond a
   * timestamp — the renderer responds by re-reading the open conversation's
   * loaded seq window. This is what makes group inserts, recalls and sticker
   * reactions show up without the (unreliable for groups) msgId delta.
   */
  onDbChanged: procedure.subscription(() => {
    return observable<{ at: number }>((emit) => {
      const handler = (file: DbChange): void => {
        emit.next({ at: file.at });
      };
      dbEventBus.on('changed', handler);
      return () => {
        dbEventBus.off('changed', handler);
      };
    });
  }),

  /**
   * Live push of newly-inserted messages (rowid-delta). Reserved for unread /
   * popup notifications — the open conversation is kept fresh by `onDbChanged`,
   * not this. Fires only when new rows actually landed.
   */
  onNewMessages: procedure.subscription(() => {
    return observable<NewMessagesWire>((emit) => {
      const handler = (change: NewMessages): void => {
        const messages: ChatMsgWire[] = [
          ...change.c2c.map((m) => c2cMsgToWire({ ...m, elements: toRenderElements(m.elements) })),
          ...change.group.map((m) =>
            groupMsgToWire({ ...m, elements: toRenderElements(m.elements) }),
          ),
        ];
        emit.next({ messages });
      };
      dbEventBus.on('new', handler);
      return () => {
        dbEventBus.off('new', handler);
      };
    });
  }),
});
