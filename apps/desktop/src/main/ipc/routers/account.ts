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
  c2cMsgToWire,
  groupMsgToWire,
  recentContactToWire,
  userProfileToWire,
  groupDetailToWire,
  groupMemberToWire,
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

  /** Get group metadata and latest announcement. */
  getGroupDetail: procedure
    .input(z.object({ groupCode: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await requireServices().groupInfo.getGroupDetail(BigInt(input.groupCode));
      return detail ? groupDetailToWire(detail) : null;
    }),

  /** List members of a group. */
  listGroupMembers: procedure
    .input(z.object({ groupCode: z.string().min(1), limit: z.number().optional() }))
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.listMembersInGroup(
        BigInt(input.groupCode),
        input.limit ?? 2000,
      );
      return members.map(groupMemberToWire);
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
