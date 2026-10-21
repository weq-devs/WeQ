import { useState } from 'react';
import { FavoriteBundleExport } from './FavoriteBundleExport';
import { FavoriteBundleImport } from './FavoriteBundleImport';
import { useQQAction, withQQAccountScope } from './shared';
import '../../styles/emoji-pack-formats.css';

function FavoriteBundleControlsBody({ onChanged }: { onChanged: () => Promise<void> }) {
  const action = useQQAction('favorite-picker-bundle');
  const [busy, setBusy] = useState(false);
  return (
    <div className="weq-favorite-bundle-controls" role="toolbar" aria-label="收藏表情导入导出">
      <strong>收藏表情</strong>
      <FavoriteBundleImport
        binding={action.binding}
        available={action.available && !action.pending}
        onBusyChange={setBusy}
        onChanged={onChanged}
      />
      <FavoriteBundleExport binding={action.binding} disabled={action.disabled || busy} />
    </div>
  );
}

export const FavoriteBundleControls = withQQAccountScope(FavoriteBundleControlsBody);
