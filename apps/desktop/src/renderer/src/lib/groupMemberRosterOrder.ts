import { create } from 'zustand';
import {
  GROUP_MEMBER_PRIORITIZE_ADMINS_DEFAULT,
  groupMemberDefaultDescending,
  type GroupMemberSort,
  type GroupMemberSortView,
} from '../../../shared/group_member_order';

type RosterOrder = { sort: GroupMemberSort; descending: boolean; prioritizeAdmins: boolean };
const defaultOrder: RosterOrder = {
  sort: 'displayName',
  descending: false,
  prioritizeAdmins: GROUP_MEMBER_PRIORITIZE_ADMINS_DEFAULT,
};
const useRosterOrder = create<Record<string, RosterOrder>>(() => ({}));

function writeRosterOrder(key: string, patch: Partial<RosterOrder>) {
  useRosterOrder.setState((orders) => ({
    [key]: { ...(orders[key] ?? defaultOrder), ...patch },
  }));
}

export function openRosterSort(
  account: string,
  group: string,
  { sort, descending, prioritizeAdmins }: { sort: GroupMemberSort } & GroupMemberSortView,
) {
  const key = JSON.stringify([account, group, false]);
  const current = useRosterOrder.getState()[key] ?? defaultOrder;
  writeRosterOrder(key, {
    sort,
    descending:
      descending ??
      (current.sort === sort ? current.descending : groupMemberDefaultDescending(sort)),
    prioritizeAdmins: prioritizeAdmins ?? current.prioritizeAdmins,
  });
}

export function useGroupMemberRosterOrder(account: string, group: string, generated = false) {
  const key = JSON.stringify([account, group, generated]);
  const order = useRosterOrder((orders) => orders[key] ?? defaultOrder);
  const changeOrder = (patch: Partial<RosterOrder>) => writeRosterOrder(key, patch);
  return { order, changeOrder };
}
