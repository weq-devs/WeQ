import { CircleHelp, UserRound, UserRoundCheck, Users, UsersRound } from 'lucide-react';
import { useContext } from 'react';
import {
  groupRelationship,
  personRelationship,
  relationshipLabels,
  RelationshipDirectoryContext,
  type GroupIdentity,
  type PersonIdentity,
  type Relationship,
} from '../lib/contactRelationship';
import '../styles/relationship-status.css';

const icons = {
  self: UserRound,
  friend: UserRoundCheck,
  nonfriend: UserRound,
  member: UsersRound,
  nonmember: Users,
  unknown: CircleHelp,
};

export function RelationshipStatus({
  status,
  group = false,
  detail,
  compact = false,
}: {
  status: Relationship;
  group?: boolean;
  detail?: string | null;
  compact?: boolean;
}) {
  const Icon = icons[status];
  const label = group && status === 'unknown' ? '入群状态待确认' : relationshipLabels[status];
  return (
    <span
      className={`weq-relationship-status${compact ? ' is-compact' : ''}`}
      data-relationship={status}
      title={status === 'unknown' ? '本地通讯录未能确认关系' : '根据当前账号的本地通讯录'}
    >
      <Icon size={compact ? 12 : 14} aria-hidden="true" />
      <span>{label}</span>
      {detail ? <span className="weq-relationship-detail">· {detail}</span> : null}
    </span>
  );
}

export function PersonRelationshipStatus({
  person,
  compact,
}: {
  person: PersonIdentity & {
    categoryName?: string | null;
    clone?: boolean;
    identityLabel?: string;
  };
  compact?: boolean;
}) {
  const directory = useContext(RelationshipDirectoryContext);
  if (person.clone || person.identityLabel === '设备') return null;
  const status = personRelationship(person, directory);
  const friend =
    directory?.friends.get(person.uid || person.id || '') ??
    directory?.friends.get(person.identityValue || '');
  return (
    <RelationshipStatus
      status={status}
      compact={compact}
      detail={!compact && status === 'friend' ? friend?.categoryName || person.categoryName : null}
    />
  );
}

export function GroupRelationshipStatus({
  group,
  compact,
}: {
  group: GroupIdentity;
  compact?: boolean;
}) {
  const directory = useContext(RelationshipDirectoryContext);
  const status = groupRelationship(group, directory);
  const current = directory?.groups.get(group.identityValue || group.id || '');
  const role = current ? current.role : group.roleKnown === true ? group.role : null;
  const label =
    role === 'owner' ? '群主' : role === 'admin' ? '管理员' : role === 'member' ? '成员' : null;
  return (
    <RelationshipStatus
      status={status}
      group
      compact={compact}
      detail={!compact && status === 'member' ? label : null}
    />
  );
}
