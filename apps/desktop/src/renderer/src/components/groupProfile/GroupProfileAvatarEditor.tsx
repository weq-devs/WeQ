import { ImageUp } from 'lucide-react';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../trpc/client';
import { refreshGroupAvatar } from '../../hooks/useAvatarUrl';
import { useQQAction } from '../qq-actions/shared';
import { useDialog } from '../Dialog';

export function GroupProfileAvatarEditor({ groupCode }: { groupCode: string }) {
  const action = useQQAction(`group-avatar:${groupCode}`);
  const mutation = trpc.account.qqWrite.groupAvatar.useMutation();
  const cache = useQueryClient();
  const showError = useDialog((state) => state.showError);
  const error = action.error || (action.result?.error ? action.result.text : '');
  useEffect(() => {
    if (error) showError('群头像修改失败', error);
  }, [error, showError]);
  return (
    <div className="weq-group-avatar-edit">
      <button
        type="button"
        className="weq-profile-field-history"
        title="更换群头像"
        aria-label="更换群头像"
        disabled={action.disabled}
        onClick={() => {
          void (async () => {
            const file = await action.pickImage();
            if (!file) return;
            if (
              await action.perform((binding) =>
                mutation.mutateAsync({ ...binding, groupId: Number(groupCode), source: file.path }),
              )
            ) {
              refreshGroupAvatar(groupCode);
              void cache.invalidateQueries({ queryKey: ['group-profile'] });
            }
          })();
        }}
      >
        <ImageUp size={14} />
      </button>
    </div>
  );
}
