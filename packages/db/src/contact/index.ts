/**
 * `contact` — recent-contact / conversation-list accessors.
 *
 * Reads `recent_contact_v3_table` and decodes the 40051 preview BLOB through
 * `@weq/codec`, surfacing the typed `RecentContact` shape from `types.ts`.
 */

export { RecentContactDb } from './recent_contact';
export type { RecentContactDbOptions } from './recent_contact';
export type { RecentContact } from './types';
