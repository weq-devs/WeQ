/**
 * 64205 — Column in group_bulletin table.
 *
 * Structure:
 * Root Message (The BLOB itself)
 *   64205: GroupBulletinBody
 *     60001: groupCode
 *     64202: GroupBulletinDetail
 *       ...
 */

import { ProtoField, ScalarType } from '../../core';

export const GroupBulletinContentItemWire = {
  textContent: ProtoField(64452, ScalarType.STRING, { optional: true }),
};

export const GroupBulletinContentContainerWire = {
  items: ProtoField(64242, () => GroupBulletinContentItemWire, { repeat: true }),
};

export const GroupBulletinDetailWire = {
  groupCode: ProtoField(60001, ScalarType.INT64, { optional: true }),
  publisherUid: ProtoField(64221, ScalarType.STRING, { optional: true }),
  fid: ProtoField(64223, ScalarType.STRING, { optional: true }),
  msgTime: ProtoField(64225, ScalarType.INT64, { optional: true }),
  ctime: ProtoField(64226, ScalarType.INT64, { optional: true }),
  contentContainer: ProtoField(64227, () => GroupBulletinContentContainerWire, { optional: true }),
};

export const GroupBulletinBodyWire = {
  groupCode: ProtoField(60001, ScalarType.INT64, { optional: true }),
  detail: ProtoField(64202, () => GroupBulletinDetailWire, { optional: true }),
};

/** This is the root schema to use for bulletinCodec.decode(blob) */
export const GroupBulletinBody = {
  /** The BLOB root contains field 64205. */
  body: ProtoField(64205, () => GroupBulletinBodyWire, { optional: true }),
};
