import { useId, useState } from 'react';
import { ThumbsUp, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { client, trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { ActionFeedback, ActionIcon, useQQAction, withQQAccountScope } from './shared';
import '../../styles/profile-like.css';

interface ProfileLikeProps {
  uid: string;
  uin: string;
  name: string;
}

function ProfileLikeDialogBody({
  uid,
  uin,
  name,
  onClose,
}: ProfileLikeProps & { onClose: () => void }) {
  const a = useQQAction(`profile-like:${uid}`);
  const utils = trpc.useUtils();
  const titleId = useId();
  const [count, setCount] = useState('1');
  const number = Number(count);
  const valid = count.trim() !== '' && Number.isInteger(number) && number >= 1 && number <= 20;
  const self = a.binding?.expectedAccountUin === uin;
  return (
    <Modal width={340} labelledBy={titleId} onClose={a.pending ? undefined : onClose} centered>
      <form
        className="weq-profile-like-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (a.disabled || !valid || self) return;
          void a.perform(
            (binding) =>
              client.account.qqActions.profileLike.mutate({ ...binding, uid, count: number }),
            () => utils.account.dressup.peerStats.invalidate({ uin, uid }),
          );
        }}
      >
        <header>
          <h3 id={titleId}>{name} · 资料卡点赞</h3>
          <ActionIcon label="关闭资料卡点赞" disabled={a.pending} onClick={onClose}>
            <X size={16} />
          </ActionIcon>
        </header>
        <div className="weq-profile-like-controls">
          <label>
            <span>次数</span>
            <input
              aria-label="资料卡点赞次数"
              type="number"
              min={1}
              max={20}
              step={1}
              value={count}
              disabled={a.disabled || self}
              onChange={(event) => setCount(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="weq-set-iconbtn"
            aria-label="提交资料卡点赞"
            title="提交资料卡点赞"
            disabled={a.disabled || !valid || self}
          >
            <ThumbsUp size={17} />
          </button>
        </div>
        {self && <p role="status">不能给自己点赞</p>}
        {!a.available && <p role="status">QQ 在线能力未就绪</p>}
        <ActionFeedback action={a} />
      </form>
    </Modal>
  );
}

const ProfileLikeDialog = withQQAccountScope(ProfileLikeDialogBody);

/** 打开编辑器不发请求；目标变化会销毁次数草稿与旧结果。 */
function ProfileLikeActionBody(props: ProfileLikeProps) {
  const [open, setOpen] = useState(false);
  const self = useViewState((state) => state.openedUin) === props.uin;
  if (self || !/^u_[A-Za-z0-9_-]+$/.test(props.uid) || !/^[1-9]\d{4,19}$/.test(props.uin))
    return null;
  return (
    <>
      <ActionIcon label="赞资料卡" onClick={() => setOpen(true)}>
        <ThumbsUp size={14} />
      </ActionIcon>
      {open && <ProfileLikeDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ProfileLikeAction(props: ProfileLikeProps) {
  return <ProfileLikeActionBody key={`${props.uid}:${props.uin}`} {...props} />;
}
