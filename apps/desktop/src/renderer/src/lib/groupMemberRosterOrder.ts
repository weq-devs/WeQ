import { create } from 'zustand';
import {
  GROUP_MEMBER_PRIORITIZE_ADMINS_DEFAULT,
  type GroupMemberSort,
} from '../../../shared/group_member_order';

type RosterOrder = { sort: GroupMemberSort; descending: boolean; prioritizeAdmins: boolean };
const defaultOrder: RosterOrder = {
  sort: 'displayName',
  descending: false,
  prioritizeAdmins: GROUP_MEMBER_PRIORITIZE_ADMINS_DEFAULT,
};
const useRosterOrder = create<Record<string, RosterOrder>>(() => ({}));

export function useGroupMemberRosterOrder(account: string, group: string, generated = false) {
  const key = JSON.stringify([account, group, generated]);
  const order = useRosterOrder((orders) => orders[key] ?? defaultOrder);
  const changeOrder = (patch: Partial<RosterOrder>) =>
    useRosterOrder.setState((orders) => ({
      [key]: { ...(orders[key] ?? defaultOrder), ...patch },
    }));
  return { order, changeOrder };
}
