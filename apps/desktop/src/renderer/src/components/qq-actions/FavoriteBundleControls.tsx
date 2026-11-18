import { useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { useDialog } from '../Dialog.shared';
import { FavoriteBundleExport } from './FavoriteBundleExport';
import { FavoriteBundleImport } from './FavoriteBundleImport';
import { useQQAction, withQQAccountScope } from './shared.shared';
import '../../styles/emoji-pack-formats.css';

function FavoriteBundleControlsBody({ onChanged }: { onChanged: () => Promise<void> }) {
  const action = useQQAction('favorite-picker-bundle');
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    await utils.account.qqActions.favorites.invalidate();
    await onChanged();
  };
  return (
    <div className="weq-favorite-bundle-controls" role="toolbar" aria-label="收藏表情导入导出">
      <strong>收藏表情</strong>
      <FavoriteBundleImport
        binding={action.binding}
        available={action.available && !action.pending && !action.busy}
        onBusyChange={setBusy}
        onChanged={refresh}
        showLabel
        onImportImage={async () => {
          try {
            const file = await action.pickImage();
            if (!file) return;
            let addedEmojiId: string | undefined;
            await action.perform(
              async (binding) => {
                const result = await client.account.qqActions.favorite.mutate({
                  ...binding,
                  action: 'add',
                  path: file.path,
                });
                addedEmojiId = result.emojiId;
                return result;
              },
              refresh,
              undefined,
              {
                readback: async () => {
                  const rows = await client.account.qqActions.favorites.query(action.binding!);
                  return Boolean(addedEmojiId && rows.some((row) => row.emojiId === addedEmojiId));
                },
              },
            );
          } catch (error) {
            useDialog
              .getState()
              .showError('导入图片失败', error instanceof Error ? error.message : String(error));
          }
        }}
      />
      <FavoriteBundleExport binding={action.binding} disabled={action.disabled || busy} showLabel />
    </div>
  );
}

export const FavoriteBundleControls = withQQAccountScope(FavoriteBundleControlsBody);
