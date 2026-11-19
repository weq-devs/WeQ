import { useState } from 'react';
import { List } from 'lucide-react';
import { Card, Row, Toggle } from './controls';
import type { useAiFeatureSettings } from './useAiFeatureSettings';
import { SuggestionFallbackDialog } from './SuggestionFallbackDialog';

export function SuggestionFallbackPanel({
  settings,
}: {
  settings: ReturnType<typeof useAiFeatureSettings>;
}) {
  const { status, disabled, patch } = settings;
  const [open, setOpen] = useState(false);
  return (
    <Card title="回退内容" icon={<List size={15} strokeWidth={1.8} />}>
      <Row
        settingId="suggestions-fallback-enabled"
        control={
          <Toggle
            label="启用回退内容"
            checked={status.data?.suggestionFallbackEnabled === true}
            indeterminate={!status.data}
            disabled={disabled}
            onChange={(suggestionFallbackEnabled) => void patch({ suggestionFallbackEnabled })}
          />
        }
      />
      <Row
        settingId="suggestions-fallback-texts"
        control={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            aria-label="管理回退内容列表"
            aria-haspopup="dialog"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <List size={14} aria-hidden />
            管理
          </button>
        }
      />
      <SuggestionFallbackDialog settings={settings} open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}
