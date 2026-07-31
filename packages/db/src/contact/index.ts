/**
 * `contact` — recent-contact / conversation-list accessors.
 *
 * Reads `recent_contact_v3_table` and decodes the 40051 preview BLOB through
 * `@weq/codec`, surfacing the typed `RecentContact` shape from `types.ts`.
 * `recent_contact_top_table` (置顶会话) is read alongside as `RecentContactTop`.
 */

export { RecentContactDb } from './recent_contact';
export type { RecentContactDbOptions } from './recent_contact';
export { RecentContactTopDb } from './recent_contact_top';
export type { RecentContactTopDbOptions } from './recent_contact_top';
export type { RecentContact, RecentContactTop } from './types';
export { UidMappingDb, UidMap } from './uid_mapping';
export type { UidMappingDbOptions, UidMappingRow } from './uid_mapping';
