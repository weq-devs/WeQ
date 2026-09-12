/**
 * Hardcoded structural templates for the WeQ助手 fabricated account — captured
 * verbatim (byte-for-byte, base64) from a real QQ 游戏中心 message (public
 * account, chatType=103, msgType=11, single ARK card) in a live nt_msg.db.
 *
 * Why hardcoded: the previous implementation cloned these rows at runtime from
 * whatever QQ 游戏中心 account happened to exist in the *user's own* database
 * (a fixed `TEMPLATE_UID`). Accounts that never received a game-center push
 * have no such rows, and the whole flow threw before writing anything. The
 * structural shape of these tables is identical across the QQ builds we ship
 * against, so we ship the captured rows instead and override only the identity
 * + content columns at insert time — exactly the columns the dynamic clone
 * used to override. The captured account's uid/uin/nick/avatar path never
 * survive into a fabricated row.
 *
 * Column order in each template MUST equal the table's PRAGMA declaration
 * order; `WeqAssistantService.cloneAndInsert` verifies that at runtime and
 * throws loudly if a QQ update reshapes a table (re-capture this file then)
 * rather than silently inserting shifted rows.
 */

import { Buffer } from 'node:buffer';
import type { SqlValue } from '@weq/native';

/** One template row: `[column, value]` pairs in PRAGMA declaration order. */
export type TemplateRow = readonly (readonly [column: string, value: SqlValue])[];

const b64Bytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));

/** The captured account's uid — a PLACEHOLDER: every identity column that
 * carries it (48902/40020/40021) is overridden with our own uid at insert. */
const TEMPLATE_UID = 'u_-PBswiplK-7J7bmaQLA-mA';

// ── captured blobs ──────────────────────────────────────────────────────────
/** c2c 40800 body — the ARK message body (arkData gets swapped out at insert). */
const BODY_40800_B64 =
  'gvYT2wvI/BXQ7viPt8bIxWrQ/BUK6rEXxgt7ImFwcCI6ImNvbS50ZW5jZW50LmdhbWVjZW50ZXIubWFsbCIsImRlc2MiOiJR' +
  'UeaJi+a4uOa2iOaBryIsIm1ldGEiOnsidGVtcGxhdGUzIjp7Il9fcHJlbG9hZEZpZWxkcyI6ImNvdmVyVXJsIiwiYWN0SWQi' +
  'OjMwODI1MjEsImFjdFRpdGxlIjoiNy8zMC3pppblj5HmtLvliqjpobXpnaLvvIjkuLvpobXvvIkiLCJhZElkIjoiMjk3NDM2' +
  'OCIsImFwcGlkIjoiMTExMjQ2MzQ4OCIsImFya1R5cGUiOiJwdWJTaW5nbGVQaWNBcmsiLCJidXNpQ29udGVudCI6bnVsbCwi' +
  'YnV0dG9uVHlwZSI6MCwiY29udGVudFRleHQiOiJRUeS4k+WxnueZvuS4h1HluIHnrYnkvaDnk5zliIYiLCJjb3ZlclVybCI6' +
  'Imh0dHBzOi8vaW1nLmdhbWVjZW50ZXIucXEuY29tL29hc2lzL1hqZHptL2M5NGE2MjRmZmQ4MjQwOTc3MmQwYWY0ZWI2NjJl' +
  'N2I3LmpwZyIsImZlZWRJZCI6NDA0MjUxNTksImZpZCI6NDA0MjUxNTksImZpdmVfZWxlbWVudF9zd2l0Y2giOmZhbHNlLCJp' +
  'c19jb2xvcmZ1bCI6ZmFsc2UsInN0eWxlVHlwZSI6MSwidGltZSI6IjE3ODUxNTY2ODEiLCJ0aXRsZSI6IuWkp+aOjOmXqOmm' +
  'luWPkeS4iue6v+S4i+i9veaKojg4OFHluIEiLCJ1cmwiOiJodHRwczovL3lvdXhpLmdhbWVjZW50ZXIucXEuY29tL2NvbXBv' +
  'c2UtaDUvbWllLWFjdC9nYW1lY2VudGVyX3RlbXBsYXRlX3N1YnNjcmliZS9pbmRleC5odG1sP2FkaWQ9Mjk3NDM2OFx1MDAy' +
  'NmFkdGFnPWd6aF9zXzI5NzQzNjhfc180MDQyNTE1OVx1MDAyNmFwcGlkPTExMTI0NjM0ODhcdTAwMjZmaWQ9NDA0MjUxNTlc' +
  'dTAwMjZvYXNpc19hY3RpZD0zMDgyNTIxXHUwMDI2b3Blbl9rdWlrbHlfaW5mbz0lN0IlMjJ1cmwlMjIlM0ElMjIlM0ZGRlJP' +
  'TVNDSEVNQSUzRCUyNmFjdF9pZCUzRDMwODI1MjFfMTExMjQ2MzQ4OF9BODJtU2slMjZhZHRhZyUzRGd6aF9zXzI5NzQzNjhf' +
  'c180MDQyNTE1OSUyNl9nZW5fZnJvbSUzRHFnYSUyMiUyQyUyMnBhZ2VfbmFtZSUyMiUzQSUyMlFRR2FtZUNlbnRlclRlbXBs' +
  'YXRlU3Vic2NyaWJlJTIyJTJDJTIyYnVuZGxlX25hbWUlMjIlM0ElMjJnYW1lY2VudGVyX3RlbXBsYXRlX3N1YnNjcmliZSUy' +
  'MiUyQyUyMmtyX3R1cmJvX2Rpc3BsYXklMjIlM0ElMjIzMDgyNTIxXzExMTI0NjM0ODhfQTgybVNrJTIyJTJDJTIya3JfbWlu' +
  'X3Jlc192ZXJzaW9uJTIyJTNBJTIyMTU0OTAlMjIlN0RcdTAwMjZwYWdlX25hbWU9UVFHYW1lQ2VudGVyVGVtcGxhdGVTdWJz' +
  'Y3JpYmVcdTAwMjZwdWJBY2NvdW50QXBwaWQ9MTExMjQ2MzQ4OFx1MDAyNnFxcGxheT0xXHUwMDI2cXFwbGF5SGlkZT0xXHUw' +
  'MDI2cmVzdGFnPTI5NzQzNjgifX0sInByb21wdCI6IuWkp+aOjOmXqOmmluWPkeS4iue6v+S4i+i9veaKojg4OFHluIEiLCJz' +
  'b3VyY2VOYW1lIjoiMTExMjQ2MzQ4OCIsInZlciI6IjAuMC4zLjY3IiwidmlldyI6InB1YkFkQXJrVmlldyIsImNvbmZpZyI6' +
  'eyJjdGltZSI6MTc4NzQ2NTAwOCwidG9rZW4iOiJlM2M1NjIwYWEyM2U5OTA5YWQzOTg5OGU3MzhlZGJiNiJ9fQ==';

/** c2c 40601 — game-center ad tracking/extension blob, kept verbatim (QQ tolerates it). */
const EXT_40601_B64 =
  'mgHICIADAogDApIDCFFR5omL5ri44gOoCHsib2FjX3RyaWdnbGUiOiJhZF9pZD0yOTc0MzY4XHUwMDI2YnVzaV9pZD1idXNp' +
  'U3RyJTNEZmlkJTI1M0Q0MDQyNTE1OSUyNTI2Y2lkJTI1M0QwJTI1MjZjb250ZW50SUQlMjUzRCUyNnBhc3NUaHJvdWdoJTNE' +
  'JTI1N0IlMjUyMnRyYWNlX2lkJTI1MjIlMjUzQSUyNTIyYzFiMTIwZmIwNjIyOWZhMzA0MGY1ODhmODVjZjAyNjclMjUyMiUy' +
  'NTJDJTI1MjJyY21kX3RzJTI1MjIlMjUzQTE3ODc0NjUwMDgwMjQlMjUyQyUyNTIycHVycG9zZSUyNTIyJTI1M0ElMjUyMjEl' +
  'MjUyMiUyNTJDJTI1MjJyY19yZWFzb24lMjUyMiUyNTNBJTI1MjI1JTI1MjIlMjUyQyUyNTIyY29zdCUyNTIyJTI1M0ExNzcl' +
  'MjUyQyUyNTIyY2F0ZWdvcnklMjUyMiUyNTNBJTI1MjJxbmV3JTI1MjIlMjU3RFx1MDAyNmJ1c2lfaW5mbz0lN0IlMjJfX3gl' +
  'MjIlM0ElMjIzNyUyMiUyQyUyMl9idCUyMiUzQSUyMjIlMjIlMkMlMjJfcG9zJTIyJTNBJTIyMTU3JTIyJTJDJTIyX3RyJTIy' +
  'JTNBJTIyMTc4NzQ2NTAwODIxNyUyMiUyQyUyMmFzX3RzJTIyJTNBMTI1MS4wNiUyQyUyMnBfc2l6ZSUyMiUzQTElMkMlMjJw' +
  'YWNrX3RpbWUlMjIlM0EyMDI2MDgyMzE0JTJDJTIycG9saWN5X2lkJTIyJTNBMTIzMjAzNjklMkMlMjJwcmNfc2l6ZSUyMiUz' +
  'QTElMkMlMjJyY19zaXplJTIyJTNBMSUyQyUyMnRpYW5zaHVfZm9vdGFnZWlkJTIyJTNBMTY0Nzk5MyU3RCIsImdhbWVfZXh0' +
  'cmEiOiJ7XCJleHRfanNvblwiOntcImRlc2NcIjpcIuS7meeVjOWkp+aOjOmXqFwiLFwiaFwiOjcwMCxcImljb25cIjpcImh0' +
  'dHBzOi8vaW1nLmdhbWVjZW50ZXIucXEuY29tL2djX2ltZy9nYy9mb3JtYWwvY29tbW9uLzExMTI0NjM0ODgvdGh1bUltZy5w' +
  'bmc/dj0xNzg0Nzc1ODYzMjIzXCIsXCJ0ZW1wbGF0ZV9pZFwiOlwidGVtcGxhdGVfaWRcIixcIndcIjo2OTB9LFwic29ydGVk' +
  'X2NvbmZpZ3NcIjpbe1wiYXBwX2lkXCI6MTExMjQ2MzQ4OH0se1widGFza19pZFwiOlwiMjk3NDM2OFwifSx7XCJvdGhlcl9p' +
  'ZFwiOlwiYWR0YWcuc3lnenpoLnFhcHBcIn1dfSIsInNob3dfaW5fYXBwX2Jhbm5lciI6MCwic2hvd19tc2dfbGlzdF9oaWdo' +
  'bGlnaHQiOjB9oAfQiqj8u/H2qD8=';

/** c2c 40600 — small binary blob, kept verbatim. */
const C40600_B64 = 'wukTBKjRFAA=';

/** c2c 40801 — small binary blob, kept verbatim. */
const C40801_B64 = 'ivYTEOihFNHu+I+3xsjFavChFAA=';

/** recent 40051 — recent-contact preview blob (overridden with our own preview at insert). */
const PREVIEW_40051_B64 =
  'mscTpwHQ/BUKqvwXJeWkp+aOjOmXqOmmluWPkeS4iue6v+S4i+i9veaKojg4OFHluIHa/Bd2ewogICAiYXBwIiA6ICJjb20u' +
  'dGVuY2VudC5nYW1lY2VudGVyLm1hbGwiLAogICAiYml6c3JjIiA6ICIiLAogICAicHJvbXB0IiA6ICLlpKfmjozpl6jpppbl' +
  'j5HkuIrnur/kuIvovb3miqI4ODhR5biBIgp9Cg==';

/** recent 41128 — small binary blob, kept verbatim. */
const RC41128_B64 = 'wooUAA==';

/** recent 41131 — small binary blob, kept verbatim. */
const RC41131_B64 = '2ooUBLCiFAA=';

/** recent 41150 — small binary blob, kept verbatim. */
const RC41150_B64 = '8osUCOCNFACQ0BQA';

// ── decoded bodies ──────────────────────────────────────────────────────────

/** The captured ARK message body — decoded once, swapped arkData at insert. */
export const GAME_CENTER_BODY_40800 = b64Bytes(BODY_40800_B64);

/** nt_uid_mapping_table row — 4 cols: 48901, 48902, 48912, 1002. Overridden at insert: 48901/48902/1002; 48912 forced NULL. */
export const MAPPING_ROW_TEMPLATE: TemplateRow = [
  ['48901', 1n],
  ['48902', TEMPLATE_UID],
  ['48912', null],
  ['1002', 2747277822n],
];

/** c2c_msg_table row — 38 cols in PRAGMA order. Overridden at insert: 40001/40002/40020/40021/40027/40030/40033/40050/40058/40800; 40801/40900/40062 forced NULL. */
export const C2C_ROW_TEMPLATE: TemplateRow = [
  ['40001', 7677267594134304594n],
  ['40002', 3981705907n],
  ['40003', 0n],
  ['40010', 103n],
  ['40011', 11n],
  ['40012', 0n],
  ['40013', 0n],
  ['40020', TEMPLATE_UID],
  ['40026', 0n],
  ['40021', TEMPLATE_UID],
  ['40027', 1n],
  ['40040', 0n],
  ['40041', 2n],
  ['40050', 1787465008n],
  ['40052', 0n],
  ['40090', ''],
  ['40093', ''],
  ['40800', GAME_CENTER_BODY_40800],
  ['40900', null],
  ['40105', 0n],
  ['40005', 13966n],
  ['40058', 1787414400n],
  ['40006', 72057598019633843n],
  ['40100', 0n],
  ['40600', b64Bytes(C40600_B64)],
  ['40060', 0n],
  ['40850', 0n],
  ['40851', 0n],
  ['40601', b64Bytes(EXT_40601_B64)],
  ['40801', b64Bytes(C40801_B64)],
  ['40605', null],
  ['40030', 2747277822n],
  ['40033', 2747277822n],
  ['40062', null],
  ['40083', 0n],
  ['40084', 0n],
  ['40008', 0n],
  ['40009', 0n],
];

/**
 * recent_contact_v3_table row — 63 cols in PRAGMA order. Overridden at insert:
 * 41102/40010/40011/40027/40021/40020/40030/40033/40001/40094/40050/41136/40051
 * (+ 41110 only when an avatar file is written). The captured 41110 (a real
 * user's local avatar path) is scrubbed to NULL so it never leaks.
 */
export const RECENT_ROW_TEMPLATE: TemplateRow = [
  ['40055', 1n],
  ['40010', 103n],
  ['40027', 1n],
  ['40021', TEMPLATE_UID],
  ['40030', 2747277822n],
  ['40051', b64Bytes(PREVIEW_40051_B64)],
  ['40041', 2n],
  ['41102', 7634696482402400534n],
  ['40056', ''],
  ['40050', 1787465008n],
  ['40003', 0n],
  ['40094', 'QQ游戏中心'],
  ['40093', ''],
  ['40090', ''],
  ['40095', ''],
  ['40096', ''],
  ['40001', 7677267594134304594n],
  ['41103', 0n],
  ['41104', 0n],
  ['40020', TEMPLATE_UID],
  ['40033', 2747277822n],
  ['41220', 0n],
  ['40600', null],
  ['41106', 0n],
  ['41107', 0n],
  ['41108', 0n],
  ['41110', null],
  ['40011', 11n],
  ['41114', 0n],
  ['41115', null],
  ['41116', null],
  ['42261', 0n],
  ['41124', 0n],
  ['41123', 0n],
  ['41130', 0n],
  ['41136', 1787465008n],
  ['41131', b64Bytes(RC41131_B64)],
  ['40022', ''],
  ['41127', ''],
  ['40092', ''],
  ['40091', ''],
  ['40014', 0n],
  ['41126', 0n],
  ['41128', b64Bytes(RC41128_B64)],
  ['41133', 0n],
  ['41134', 0n],
  ['41135', ''],
  ['49102', 0n],
  ['49103', 0n],
  ['41132', 0n],
  ['41138', 0n],
  ['41137', 0n],
  ['41144', 0n],
  ['41147', 0n],
  ['41146', 0n],
  ['41148', null],
  ['60001', null],
  ['41150', b64Bytes(RC41150_B64)],
  ['40005', 13966n],
  ['40002', 3981705907n],
  ['40006', 72057598019633843n],
  ['41158', 0n],
  ['41159', 0n],
];
