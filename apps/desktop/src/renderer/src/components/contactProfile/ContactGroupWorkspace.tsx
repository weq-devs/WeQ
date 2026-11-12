import { useContext, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { DEFAULT_CONTACT_CARD } from '@weq/service/contact-card';
import { ExternalLink } from 'lucide-react';
import type { Contact } from '../../im-template/template/types';
import { ConversationDirectoryContext } from '../../lib/conversationDirectory';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { DraftCloseContext, useDraftClose } from '../../lib/draftClose';
import { ContactGroupContent } from './ContactContent';
import { ContactActions } from './ContactActions';
import { ContactEmptyState, ContactInlineError } from './ContactRow';
import { ContactWorkspaceNavigationContext } from '../../lib/profileNavigation';
import { sharedGroupConversation } from '../ark/groupShareCard';
import { avatarFromGroupCode } from '../../lib/avatarResolver';

const rememberedGroups = new Map<string, string>();

export function ContactGroupWorkspace({ contact }: { contact: Contact }) {
  const session = useQQWriteSession(`contact-groups:${contact.id}`, true);
  const scope = JSON.stringify([session.binding, contact.uid || contact.id]);
  return <GroupWorkspace key={scope} contact={contact} scope={scope} binding={session.binding} />;
}

function GroupWorkspace({
  contact,
  scope,
  binding,
}: {
  contact: Contact;
  scope: string;
  binding: ReturnType<typeof useQQWriteSession>['binding'];
}) {
  const active = useTabActive();
  const directory = useContext(ConversationDirectoryContext);
  const navigate = useContext(ContactWorkspaceNavigationContext);
  const drafts = useContext(DraftCloseContext);
  const closing = useDraftClose(() => {}, null);
  useEffect(() => {
    const read = () => {
      const states = [...closing.drafts].map((reader) => reader());
      return {
        dirty: states.some((state) => state.dirty),
        busy: states.some((state) => state.busy),
      };
    };
    drafts?.add(read);
    return () => {
      drafts?.delete(read);
    };
  }, [drafts, closing.drafts]);
  const uid = contact.uid || contact.id;
  const [selected, setSelected] = useState(
    contact.profileContext?.groupCode || rememberedGroups.get(scope),
  );
  const groups = useInfiniteQuery({
    queryKey: ['contact-user-groups', binding, uid],
    queryFn: ({ pageParam = 0 }) =>
      client.account.listUserGroups.query({ ...binding, uid, limit: 100, offset: pageParam }),
    getNextPageParam: (last, pages) => (last.length === 100 ? pages.length * 100 : undefined),
    enabled: active && Boolean(binding) && /^u_/.test(uid),
    ...PROFILE_QUERY_OPTIONS,
  });
  const rows = [
    ...new Map(
      (groups.data?.pages.flat() ?? []).map((member) => [member.groupCode, member]),
    ).values(),
  ];
  const codes = [
    ...new Set([
      ...(contact.profileContext ? [contact.profileContext.groupCode] : []),
      ...rows.map((member) => member.groupCode),
    ]),
  ];
  const code = selected && codes.includes(selected) ? selected : codes[0];
  const detail = useQuery({
    queryKey: ['contact-group-detail', binding, code],
    queryFn: () => client.account.getGroupDetail.query({ ...binding, groupCode: code! }),
    enabled: active && Boolean(binding && code),
    ...PROFILE_QUERY_OPTIONS,
  });
  const name = (value: string) => {
    if (value === code && detail.data?.groupName) return detail.data.groupName;
    if (value === contact.profileContext?.groupCode)
      return contact.profileContext.groupName || value;
    const conversation = directory?.real?.find(
      (item) => item.type === 'group' && item.id === value,
    );
    return conversation?.type === 'group' ? conversation.group.name : value;
  };
  const row = rows.find((member) => member.groupCode === code);
  const source =
    contact.profileContext?.groupCode === code ? contact.profileContext?.member : undefined;
  const date = (seconds: number | null | undefined) =>
    seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
  const person: Contact = {
    ...contact,
    profileContext: code
      ? {
          groupCode: code,
          groupName: name(code),
          member: row
            ? {
                card: row.card,
                customTitle: row.customTitle,
                role: detail.data
                  ? detail.data.ownerUid === uid
                    ? 'owner'
                    : row.adminFlag > 0
                      ? 'admin'
                      : 'member'
                  : source?.role,
                memberLevel: row.memberLevel,
                joinedAt: date(row.joinTime) ?? '',
                lastSpeakAt: date(row.lastSpeakTime),
                muteUntil: date(row.muteUntil),
              }
            : source,
        }
      : undefined,
  };
  return (
    <DraftCloseContext.Provider value={closing.drafts}>
      <div className="weq-contact-group-workspace">
        <div className="weq-profile-group-picker">
          <label htmlFor={`contact-group-${uid}`}>群聊</label>
          <div className="weq-profile-group-target">
            <select
              id={`contact-group-${uid}`}
              value={code ?? ''}
              disabled={!codes.length}
              onChange={(event) => {
                const next = event.target.value;
                void closing.confirmLeave(() => {
                  setSelected(next);
                  rememberedGroups.delete(scope);
                  rememberedGroups.set(scope, next);
                  if (rememberedGroups.size > 200)
                    rememberedGroups.delete(rememberedGroups.keys().next().value!);
                });
              }}
            >
              {!codes.length ? (
                <option value="">{groups.isFetching ? '正在读取群聊…' : '暂无群聊'}</option>
              ) : (
                codes.map((value) => (
                  <option key={value} value={value}>
                    {name(value)}
                    {name(value) !== value ? `（${value}）` : ''}
                  </option>
                ))
              )}
            </select>
            {code && navigate ? (
              <button
                type="button"
                className="weq-profile-group-link"
                title="查看所选群资料"
                aria-label="查看所选群资料"
                onClick={() => {
                  const known = directory?.real?.find(
                    (item) => item.type === 'group' && item.id === code,
                  );
                  const conversation =
                    known?.type === 'group'
                      ? known
                      : sharedGroupConversation({
                          code,
                          name: name(code),
                          avatar: avatarFromGroupCode(code) ?? '',
                        });
                  void closing.confirmLeave(() => navigate({ kind: 'group', conversation }));
                }}
              >
                <ExternalLink size={16} />
              </button>
            ) : null}
          </div>
        </div>
        {groups.error ? (
          <ContactInlineError
            message="所在群读取失败，已有资料保留。"
            onRetry={() => void groups.refetch()}
            retrying={groups.isFetching}
          />
        ) : null}
        {groups.hasNextPage ? (
          <button
            className="weq-profile-section-action"
            type="button"
            disabled={groups.isFetching}
            onClick={() => void groups.fetchNextPage()}
          >
            加载更多群聊
          </button>
        ) : null}
        {code ? (
          <div key={code}>
            {detail.error ? (
              <ContactInlineError
                message="群资料读取失败"
                onRetry={() => void detail.refetch()}
                retrying={detail.isFetching}
              />
            ) : null}
            {row || source ? (
              <ContactGroupContent person={person} settings={DEFAULT_CONTACT_CARD} full />
            ) : (
              <ContactEmptyState>
                {groups.isFetching ? '正在读取群内资料…' : '没有已保存的成员资料。'}
              </ContactEmptyState>
            )}
            <ContactActions person={person} groupOnly />
          </div>
        ) : !groups.isFetching && !groups.error ? (
          <ContactEmptyState>没有可显示的群内资料。</ContactEmptyState>
        ) : null}
      </div>
    </DraftCloseContext.Provider>
  );
}
