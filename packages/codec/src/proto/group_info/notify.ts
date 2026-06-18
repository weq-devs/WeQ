import { ProtoField, ScalarType } from '../../core';

/**
 * 61004: Group information
 */
export const GroupNotifyGroupInfo = {
  groupUin: ProtoField(60001, ScalarType.INT64),
  groupName: ProtoField(60007, ScalarType.STRING, { optional: true }),
};

export const GroupNotifyGroupInfoColumn = {
  body: ProtoField(61004, () => GroupNotifyGroupInfo),
};

/**
 * 61005/61006/61007: User information (Operator/Operated/Actor)
 */
export const GroupNotifyUserInfo = {
  uid: ProtoField(1000, ScalarType.STRING),
  nick: ProtoField(20002, ScalarType.STRING, { optional: true }),
};

export const GroupNotifyOperatedColumn = {
  body: ProtoField(61005, () => GroupNotifyUserInfo),
};

export const GroupNotifyOperatorColumn = {
  body: ProtoField(61006, () => GroupNotifyUserInfo),
};

export const GroupNotifyActorColumn = {
  body: ProtoField(61007, () => GroupNotifyUserInfo),
};
