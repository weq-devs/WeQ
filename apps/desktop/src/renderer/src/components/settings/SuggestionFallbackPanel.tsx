import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { List, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  DEFAULT_SUGGESTION_FALLBACK_TEXTS,
  MAX_SUGGESTION_FALLBACK_TEXTS,
  MAX_SUGGESTION_FALLBACK_LENGTH,
  validateSuggestionFallbackTexts,
} from '@weq/service/intent-context';
import { Card, Row, Toggle } from './controls';
import type { useAiFeatureSettings } from './useAiFeatureSettings';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots';

const schema = z.array(z.object({ id: z.string(), text: z.string() })).nullable();
let rowId = 0;
const rowsFor = (texts: readonly string[]) =>
  texts.map((text) => ({ id: `suggestion-${Date.now()}-${++rowId}`, text }));

export function SuggestionFallbackPanel({
  settings,
}: {
  settings: ReturnType<typeof useAiFeatureSettings>;
}) {
  const { status, disabled, patch } = settings;
  const texts = status.data?.suggestionFallbackTexts;
  const [draft, setDraft] = usePageState('suggestion-fallback-texts', null, schema, true);
  const baseline = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!texts) return;
    const encoded = JSON.stringify(texts);
    const before = baseline.current;
    setDraft((current) =>
      current === null || JSON.stringify(current.map((row) => row.text)) === before
        ? rowsFor(texts)
        : current,
    );
    baseline.current = encoded;
  }, [texts, setDraft]);
  const values = draft?.map((row) => row.text) ?? [];
  usePageDraftConfirmation(
    'suggestion-fallback-texts',
    texts && JSON.stringify(values) === JSON.stringify(texts) ? draft : undefined,
  );
  let error: string | null = null;
  try {
    validateSuggestionFallbackTexts(values);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  const busy = disabled || draft === null;
  return (
    <Card title="回退内容" icon={<List size={15} strokeWidth={1.8} />}>
      <Row
        settingId="suggestions-fallback-enabled"
        label="启用回退内容"
        control={
          <Toggle
            label="启用回退内容"
            checked={status.data?.suggestionFallbackEnabled !== false}
            indeterminate={!status.data}
            disabled={disabled}
            onChange={(suggestionFallbackEnabled) => void patch({ suggestionFallbackEnabled })}
          />
        }
      />
      <form
        className="weq-suggestion-fallback"
        data-setting-id="suggestions-fallback-texts"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !error)
            void patch({ suggestionFallbackTexts: validateSuggestionFallbackTexts(values) });
        }}
      >
        <h4 className="weq-set-card-title">回退内容列表</h4>
        {draft?.map((row, index) => (
          <div className="weq-suggestion-fallback-row" key={row.id}>
            <input
              className="weq-set-input"
              aria-label={`回退内容 ${index + 1}`}
              value={row.text}
              maxLength={MAX_SUGGESTION_FALLBACK_LENGTH}
              disabled={busy}
              onChange={(event) =>
                setDraft(
                  (current) =>
                    current?.map((entry) =>
                      entry.id === row.id ? { ...entry, text: event.target.value } : entry,
                    ) ?? null,
                )
              }
            />
            <button
              type="button"
              className="weq-set-iconbtn"
              title="删除回退内容"
              aria-label={`删除回退内容 ${index + 1}`}
              disabled={busy}
              onClick={() =>
                setDraft((current) => current?.filter((entry) => entry.id !== row.id) ?? null)
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {draft?.length === 0 ? <p className="weq-set-note">暂无回退内容</p> : null}
        {error ? (
          <p role="alert" className="weq-set-note">
            {error}
          </p>
        ) : null}
        <div className="weq-suggestion-fallback-actions">
          <button
            type="button"
            className="weq-set-iconbtn"
            title="添加回退内容"
            aria-label="添加回退内容"
            disabled={busy || values.length >= MAX_SUGGESTION_FALLBACK_TEXTS}
            onClick={() => setDraft((current) => [...(current ?? []), ...rowsFor([''])])}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            className="weq-set-iconbtn"
            title="恢复默认列表"
            aria-label="恢复默认回退内容列表"
            disabled={busy}
            onClick={() => setDraft(rowsFor(DEFAULT_SUGGESTION_FALLBACK_TEXTS))}
          >
            <RotateCcw size={15} />
          </button>
          <button type="submit" className="weq-set-btn" disabled={busy || !!error}>
            <Save size={14} />
            保存
          </button>
        </div>
      </form>
    </Card>
  );
}
