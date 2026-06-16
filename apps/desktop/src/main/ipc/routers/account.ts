/**
 * Account-scoped router — only usable once `bootstrap.openAccount`
 * resolved. Every procedure asserts an account session is open and
 * throws otherwise.
 *
 * `bigint` fields (uin / msgId / sendTime) are stringified at the IPC
 * boundary (see `../serde.ts`). The renderer is responsible for
 * `BigInt(s)`-ing them back if it needs arithmetic — most code just
 * displays them as text.
 */

import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { getAppContext, newMessageBus, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { toRenderElements, type NtMsgChange } from '@weq/service';
import {
  msgToWire,
  groupMsgToWire,
  recentContactToWire,
  userProfileToWire,
  groupDetailToWire,
  groupMemberToWire,
  type C2cMsgWire,
  type GroupMsgWire,
} from '../serde';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** Wire payload pushed to the renderer when nt_msg.db gains new messages. */
export interface NewMessagesWire {
  c2c: C2cMsgWire[];
  group: GroupMsgWire[];
}

export const accountRouter = router({
  /** Recent conversations (recent_contact_v3_table), newest first. */
  listRecentContacts: procedure.query(async () => {
    const contacts = await requireServices().recentContacts.getRecentContact(200);
    return contacts.map(recentContactToWire);
  }),

  /**
   * Paginated c2c messages with one conversation target (peer uid, column
   * 40021), newest first. UID is used instead of uin because uin can be
   * missing/zero on some rows.
   */
  listC2cMessages: procedure
    .input(
      z.object({
        targetUid: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const all = await requireServices().msgs.getC2cMessages(
        input.targetUid,
        input.limit,
        input.offset,
      );
      return all.map(msgToWire);
    }),

  /** Paginated group messages in one group (group code, column 40021), newest first. */
  listGroupMessages: procedure
    .input(
      z.object({
        targetGroupCode: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const all = await requireServices().msgs.getGroupMessages(
        input.targetGroupCode,
        input.limit,
        input.offset,
      );
      return all.map(groupMsgToWire);
    }),

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
   * Live push of new messages observed in the account's `nt_msg.db`.
   *
   * Driven by the process-wide DbWatch hook (see app_context). Emits the new
   * c2c/group messages (already element-rendered + IPC-serialized) so the
   * renderer can append to the open conversation and refresh its contact list
   * without polling. Fires only when the diff actually found new rows.
   */
  onNewMessages: procedure.subscription(() => {
    return observable<NewMessagesWire>((emit) => {
      console.log('[DbWatch] renderer subscribed to onNewMessages');
      const handler = (change: NtMsgChange): void => {
        console.log(
          `[DbWatch] push to renderer → c2c=${change.c2c.length} group=${change.group.length}`,
        );
        emit.next({
          c2c: change.c2c.map((m) =>
            msgToWire({ ...m, elements: toRenderElements(m.elements) }),
          ),
          group: change.group.map((m) =>
            groupMsgToWire({ ...m, elements: toRenderElements(m.elements) }),
          ),
        });
      };
      newMessageBus.on('new', handler);
      return () => {
        console.log('[DbWatch] renderer unsubscribed from onNewMessages');
        newMessageBus.off('new', handler);
      };
    });
  }),
});
