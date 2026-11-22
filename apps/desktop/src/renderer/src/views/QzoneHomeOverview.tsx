import { useQuery } from '@tanstack/react-query';
import type { QzoneProfile } from '@weqbot/protocol/web';
import { Pencil, RefreshCw, Save, UserRound } from 'lucide-react';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { EditorDialog } from '../components/EditorDialog';
import { NumericText } from '../components/NumericText';
import { QzoneInlineText } from '../components/QzoneEmoji';
import { ActionFeedback } from '../components/qq-actions/shared';
import { useQQAction } from '../components/qq-actions/shared.shared';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { client, trpc } from '../trpc/client';
import { LoadingStatus } from './qzoneShared';
import { QzonePageContext } from './qzoneShared.shared';

const personalLabels = {
  nickname: '昵称',
  signature: '签名',
  gender: '性别',
  age: '年龄',
  birthday: '生日',
  constellation: '星座',
  region: '所在地',
  hometown: '家乡',
  relationship: '感情状况',
  bloodType: '血型',
  occupation: '职业',
  company: '公司',
  companyRegion: '公司所在地',
  companyAddress: '公司详细地址',
} satisfies Record<keyof QzoneProfile['personal'] | 'relationship', string>;

function OverviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-privacy-sensitive>{children}</dd>
    </div>
  );
}

function OverviewError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <p className="weq-qzn-error" role="status">
      {message}{' '}
      <button type="button" className="weq-retry-button" onClick={retry}>
        <RefreshCw size={14} aria-hidden />
        重试
      </button>
    </p>
  );
}

export function QzoneHomeOverview({
  binding,
  hostUin,
  blogCount,
}: {
  binding: QQWriteBinding;
  hostUin: string;
  blogCount?: number;
}) {
  const { active, refresh } = useContext(QzonePageContext);
  const [dialog, setDialog] = useState<'personal' | 'edit' | null>(null);
  const profile = trpc.account.qqActions.qzoneSpaceProfile.useQuery(
    { ...binding, hostUin },
    { enabled: active, retry: false, refetchOnWindowFocus: false },
  );
  const target = {
    selfUin: binding.expectedAccountUin,
    expectedAccountConfigId: binding.expectedAccountConfigId,
    hostUin,
  };
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  const metadata = useQuery({
    queryKey: ['qzone-home-metadata', target, refresh],
    enabled: active,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      run(
        (requestId) => client.account.qzone.homeMetadata.query({ ...target, requestId }),
        true,
        signal,
      ),
  });
  const profileData = profile.data;
  const data = metadata.data;
  const counts = [
    ['累计访问', data?.totalCount],
    ['今日访问', data?.todayCount],
    ['说说', data?.postCount],
    ['日志', blogCount],
    ['相册', data?.albumCount],
    ['照片', data?.photoCount],
    ['留言', data?.messageCount],
  ] as const;
  const name = profileData?.name.trim();
  const description = profileData?.description.trim();
  const greeting = data?.greeting;
  const canEdit = hostUin === target.selfUin && Boolean(profileData);
  return (
    <header className="weq-qzn-home-overview">
      <div className="weq-qzn-home-heading">
        <div className="weq-qzn-home-title">
          <h2 data-privacy-sensitive={Boolean(name) || undefined}>
            <QzoneInlineText content={name || 'QQ 空间'} />
          </h2>
          {description ? (
            <p data-privacy-sensitive>
              <QzoneInlineText content={description} />
            </p>
          ) : null}
        </div>
        <div className="weq-qzn-home-tools">
          <button
            type="button"
            className="weq-set-btn"
            aria-haspopup="dialog"
            onClick={() => setDialog('personal')}
          >
            <UserRound size={14} aria-hidden />
            个人资料
          </button>
          {canEdit ? (
            <button
              type="button"
              className="weq-set-btn"
              aria-label="编辑空间资料"
              title="编辑空间资料"
              aria-haspopup="dialog"
              onClick={() => setDialog('edit')}
            >
              <Pencil size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {counts.some(([, value]) => value != null) ? (
        <dl className="weq-qzn-home-stats" aria-label="空间统计">
          {counts.map(([label, value]) =>
            value == null ? null : (
              <OverviewRow key={label} label={label}>
                <NumericText>{value.toLocaleString('zh-CN')}</NumericText>
              </OverviewRow>
            ),
          )}
        </dl>
      ) : null}
      {greeting ? (
        <p className="weq-qzn-home-greeting">
          <span>主人寄语</span>
          <span data-privacy-sensitive>
            <QzoneInlineText content={greeting} />
          </span>
        </p>
      ) : null}
      {profile.error ? (
        <OverviewError message={profile.error.message} retry={() => void profile.refetch()} />
      ) : null}
      {metadata.isFetching && !data ? <LoadingStatus text="正在读取空间统计…" /> : null}
      {metadata.error ? (
        <OverviewError
          message={metadata.error instanceof Error ? metadata.error.message : '空间统计读取失败'}
          retry={() => void metadata.refetch()}
        />
      ) : null}
      {dialog === 'personal' ? (
        <EditorDialog title="个人资料" onClose={() => setDialog(null)} width={440}>
          {profileData ? <PersonalProfile profile={profileData} /> : null}
          {profile.isFetching && !profileData ? <LoadingStatus text="正在读取个人资料…" /> : null}
          {profile.error ? (
            <OverviewError message={profile.error.message} retry={() => void profile.refetch()} />
          ) : null}
        </EditorDialog>
      ) : null}
      {dialog === 'edit' && canEdit ? (
        <EditSpaceProfile hostUin={hostUin} binding={binding} onClose={() => setDialog(null)} />
      ) : null}
    </header>
  );
}

function PersonalProfile({ profile }: { profile: QzoneProfile }) {
  const personal = { ...profile.personal, relationship: profile.relationship };
  const rows = (Object.keys(personalLabels) as (keyof typeof personalLabels)[]).flatMap((key) => {
    const value = personal[key];
    if (value == null || value === '') return [];
    return (
      <OverviewRow key={key} label={personalLabels[key]}>
        {typeof value === 'string' ? (
          <QzoneInlineText content={value} />
        ) : (
          <NumericText>{value}</NumericText>
        )}
      </OverviewRow>
    );
  });
  return rows.length ? (
    <dl className="weq-qzn-personal-profile">{rows}</dl>
  ) : (
    <p className="weq-qzn-status">暂无可见的个人资料</p>
  );
}

function EditSpaceProfile({
  hostUin,
  binding,
  onClose,
}: {
  hostUin: string;
  binding: QQWriteBinding;
  onClose: () => void;
}) {
  const action = useQQAction(`qzone-space-profile:${hostUin}`, 'failure-only');
  const query = trpc.account.qqActions.qzoneSpaceProfile.useQuery(
    { ...binding, hostUin },
    { enabled: false },
  );
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const profile = draft ?? query.data;
  return (
    <EditorDialog title="空间资料" onClose={onClose} draft={draft} busy={action.pending}>
      {query.isFetching && !query.data ? <LoadingStatus /> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {profile ? (
        <form
          className="weq-qzn-space-profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !draft ||
              action.disabled ||
              !query.data ||
              action.binding?.expectedAccountConfigId !== binding.expectedAccountConfigId ||
              action.binding?.expectedAccountUin !== binding.expectedAccountUin
            )
              return;
            const patch = {
              ...(draft.name === query.data.name ? {} : { name: draft.name }),
              ...(draft.description === query.data.description
                ? {}
                : { description: draft.description }),
            };
            if (!Object.keys(patch).length) {
              setDraft(null);
              return;
            }
            void action.perform(
              (binding) =>
                client.account.qqActions.updateQzoneSpaceProfile.mutate({
                  ...binding,
                  hostUin,
                  ...patch,
                }),
              undefined,
              undefined,
              {
                requireReadback: true,
                readback: async () => {
                  const result = await query.refetch();
                  if (result.error) throw result.error;
                  const matched =
                    result.data?.name === draft.name &&
                    result.data?.description === draft.description;
                  if (matched) setDraft(null);
                  return matched;
                },
              },
            );
          }}
        >
          <label className="weq-set-text-field">
            <span className="weq-set-row-label">空间名称</span>
            <input
              className="weq-set-input"
              value={profile.name}
              maxLength={80}
              onChange={(event) =>
                setDraft({ name: event.target.value, description: profile.description })
              }
            />
          </label>
          <label className="weq-set-text-field">
            <span className="weq-set-row-label">空间说明</span>
            <textarea
              className="weq-set-input"
              rows={3}
              value={profile.description}
              maxLength={512}
              onChange={(event) =>
                setDraft({ name: profile.name, description: event.target.value })
              }
            />
          </label>
          <div className="weq-qq-action-bar">
            <button
              type="submit"
              className="weq-set-btn weq-set-btn-primary"
              disabled={action.disabled || !draft}
            >
              <Save size={15} aria-hidden />
              保存资料
            </button>
          </div>
        </form>
      ) : null}
      <ActionFeedback action={action} />
    </EditorDialog>
  );
}
