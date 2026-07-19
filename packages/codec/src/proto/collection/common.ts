/**
 * Shared sub-structures used across collection (收藏) summaries.
 *
 * These three structs are reused by more than one summary variant, so they
 * live here rather than beside a single column:
 *
 *  - {@link AuthorInfo}  — the owner/author identity block. Appears both as the
 *    top-level `180004` column body and, nested, as `PicInfo.owner` (180559).
 *  - {@link PicInfo}     — an image descriptor (uri / md5 / dimensions / owner).
 *    Reused by link cover, richMedia gallery, video preview.
 *  - {@link FileInfo}    — a stored-file descriptor. Reused by file summary and
 *    video store-file.
 *
 * Field tags were recovered by decoding real `collection.db` blobs with the
 * schema-free decoder and aligning them against napcat's `get_collection_list`
 * (which calls QQ's native parser — its field *names* are authoritative).
 */

import { ProtoField, ScalarType } from '../../core';

/** Owner / author identity. Same shape wherever an "owner" appears. */
export const AuthorInfo = {
  /** Tag 18504: Source group id (0 for non-group origins). */
  groupId: ProtoField(18504, ScalarType.UINT64, { optional: true }),
  /** Tag 18505: Source group name. */
  groupName: ProtoField(18505, ScalarType.STRING, { optional: true }),
  /** Tag 18506: Owner uid (`u_...`). */
  uid: ProtoField(18506, ScalarType.STRING, { optional: true }),
  /** Tag 180500: Owner type (1 = user, 2 = group-origin, ...). */
  type: ProtoField(180500, ScalarType.INT32, { optional: true }),
  /** Tag 180501: Owner numeric id (QQ number). */
  numId: ProtoField(180501, ScalarType.UINT64, { optional: true }),
  /** Tag 180503: Owner string id (QID / personal id). */
  strId: ProtoField(180503, ScalarType.STRING, { optional: true }),
};

/** Image descriptor. Base tag 180550, one field per index. */
export const PicInfo = {
  /** Tag 180550: Download uri (collector CDN). */
  uri: ProtoField(180550, ScalarType.STRING, { optional: true }),
  /** Tag 180551: MD5 (16 raw bytes). */
  md5: ProtoField(180551, ScalarType.BYTES, { optional: true }),
  /** Tag 180552: SHA1 (20 raw bytes). */
  sha1: ProtoField(180552, ScalarType.BYTES, { optional: true }),
  /** Tag 180553: File name. */
  name: ProtoField(180553, ScalarType.STRING, { optional: true }),
  /** Tag 180554: Note. */
  note: ProtoField(180554, ScalarType.STRING, { optional: true }),
  /** Tag 180555: Width in px. */
  width: ProtoField(180555, ScalarType.INT32, { optional: true }),
  /** Tag 180556: Height in px. */
  height: ProtoField(180556, ScalarType.INT32, { optional: true }),
  /** Tag 180557: Byte size. */
  size: ProtoField(180557, ScalarType.INT32, { optional: true }),
  /** Tag 180558: Pic type. */
  type: ProtoField(180558, ScalarType.INT32, { optional: true }),
  /** Tag 180559: Owner identity. */
  owner: ProtoField(180559, () => AuthorInfo, { optional: true }),
  /** Tag 180560: Server pic id (`NNNN/uuid`). */
  picId: ProtoField(180560, ScalarType.STRING, { optional: true }),
  /** Tag 180561: Local save path (runtime-filled). */
  savePath: ProtoField(180561, ScalarType.STRING, { optional: true }),
};

/** Stored-file descriptor. Base tag 180600, one field per index. */
export const FileInfo = {
  /** Tag 180600: Source kind. */
  src: ProtoField(180600, ScalarType.INT32, { optional: true }),
  /** Tag 180601: Owner numeric id. */
  uid: ProtoField(180601, ScalarType.UINT64, { optional: true }),
  /** Tag 180602: Business id. */
  bid: ProtoField(180602, ScalarType.INT32, { optional: true }),
  /** Tag 180603: File id (server path). */
  fid: ProtoField(180603, ScalarType.STRING, { optional: true }),
  /** Tag 180604: File name. */
  name: ProtoField(180604, ScalarType.STRING, { optional: true }),
  /** Tag 180605: Byte size. */
  size: ProtoField(180605, ScalarType.INT64, { optional: true }),
  /** Tag 180606: MD5 (raw bytes). */
  md5: ProtoField(180606, ScalarType.BYTES, { optional: true }),
  /** Tag 180607: SHA1 (raw bytes). */
  sha1: ProtoField(180607, ScalarType.BYTES, { optional: true }),
  /** Tag 180608: Category. */
  category: ProtoField(180608, ScalarType.INT32, { optional: true }),
  /** Tag 180609: NT uid. */
  ntUid: ProtoField(180609, ScalarType.STRING, { optional: true }),
  /** Tag 180610: Save path. */
  savePath: ProtoField(180610, ScalarType.STRING, { optional: true }),
  /** Tag 180611: Default local path (runtime-filled). */
  defaultPath: ProtoField(180611, ScalarType.STRING, { optional: true }),
  /** Tag 180612: Thumbnail path. */
  thumbPicPath: ProtoField(180612, ScalarType.STRING, { optional: true }),
};
