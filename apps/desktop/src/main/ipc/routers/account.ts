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
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { msgToWire, groupMsgToWire, recentContactToWire } from '../serde';
import type { AccountSession } from '@weq/account';

function requireSession(): AccountSession {
  const ctx = getAppContext();
  if (!ctx.account) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.account;
}

export const accountRouter = router({
  /** Recent conversations (recent_contact_v3_table), newest first. */
  listRecentContacts: procedure.query(async () => {
    const contacts = await requireSession().recentContacts.getRecentContact(200);
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
      const all = await requireSession().c2cMsgs.listMessagesWithTarget(
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
      const all = await requireSession().groupMsgs.listMessagesWithTarget(
        input.targetGroupCode,
        input.limit,
        input.offset,
      );
      return all.map(groupMsgToWire);
    }),
});
