/**
 * 40051 — the recent-contact preview column (`recent_contact_v3_table`).
 *
 * The BLOB wraps a single PreviewElementWire under tag 40051: the latest
 * message rendered as an element, plus the conversation-list display text
 * (49093). Analogous to MsgBody for 40800, but a single nested element rather
 * than a repeated list.
 */

import { ProtoField } from '../../core';
import { PreviewElementWire } from './element';

export const RecentContactBody = {
  preview: ProtoField(40051, () => PreviewElementWire, { optional: true }),
};
