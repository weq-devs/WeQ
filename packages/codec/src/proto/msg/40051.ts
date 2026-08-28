/**
 * 40051 — the recent-contact preview column (`recent_contact_v3_table`).
 *
 * The BLOB wraps one or more PreviewElementWire under repeated tag 40051: the
 * latest message rendered as elements, plus the conversation-list display text
 * (49093). Analogous to MsgBody for 40800. Real-world rows can carry MORE than
 * one element — e.g. bot markdown messages are stored as `[markdown, text]`
 * where the trailing TEXT element is the plain-text fallback the list shows.
 */

import { ProtoField } from '../../core';
import { PreviewElementWire } from './element';

export const RecentContactBody = {
  preview: ProtoField(40051, () => PreviewElementWire, { repeat: true }),
};
