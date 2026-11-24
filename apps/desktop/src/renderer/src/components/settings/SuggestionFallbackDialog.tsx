import { useEffect, useId, useRef } from 'react';
import { z } from 'zod/v3';
import { List, Plus, Trash2, X } from 'lucide-react';
import {
  MAX_SUGGESTION_FALLBACK_TEXTS,
  MAX_SUGGESTION_FALLBACK_LENGTH,
  validateSuggestionFallbackTexts,
} from '@weq/service/intent-context';
import { Modal } from '../Dialog';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots.shared';
import { AutoSave } from './AutoSave';
import { SaveStatusSlotContext } from './controls.shared';
import type { useAiFeatureSettings } from './useAiFeatureSettings';
import '../../styles/model-settings.css';

const schema = z.array(z.object({ id: z.string(), text: z.string() })).nullable();
let rowId = 0;
const rowsFor = (texts: readonly string[]) =>
  texts.map((text) => ({ id: `suggestion-${Date.now()}-${++rowId}`, text }));

export function SuggestionFallbackDialog({
  settings,
  open,
  onClose,
}: {
  settings: ReturnType<typeof useAiFeatureSettings>;
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
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
  let error: string | null = null;
  let normalized = values;
  try {
    normalized = validateSuggestionFallbackTexts(values);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  usePageDraftConfirmation(
    'suggestion-fallback-texts',
    !error && texts && JSON.stringify(normalized) === JSON.stringify(texts) ? draft : undefined,
  );
  const busy = disabled || draft === null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width={560}
      className="weq-message-modal weq-suggestion-fallback-modal"
    >
      <div className="weq-dialog">
        <header className="weq-dialog-head">
          <span className="weq-dialog-icon" aria-hidden>
            <List size={18} />
          </span>
          <h3 id={titleId} className="weq-dialog-title">
            回退内容列表
          </h3>
          <button
            type="button"
            className="weq-dialog-x"
            title="关闭回退内容列表"
            aria-label="关闭回退内容列表"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="weq-dialog-body">
          <SaveStatusSlotContext.Provider value={null}>
            <AutoSave
              value={normalized}
              saved={texts ?? []}
              ready={!busy}
              valid={!error}
              reset={() => setDraft(rowsFor(texts ?? []))}
              save={(next) =>
                patch({ suggestionFallbackTexts: validateSuggestionFallbackTexts(next) }, true)
              }
            >
              <div className="weq-suggestion-fallback">
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
                      data-danger="outline"
                      type="button"
                      className="weq-set-iconbtn"
                      title="删除回退内容"
                      aria-label={`删除回退内容 ${index + 1}`}
                      disabled={busy}
                      onClick={() =>
                        setDraft(
                          (current) => current?.filter((entry) => entry.id !== row.id) ?? null,
                        )
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
                </div>
              </div>
            </AutoSave>
          </SaveStatusSlotContext.Provider>
        </div>
      </div>
    </Modal>
  );
}
