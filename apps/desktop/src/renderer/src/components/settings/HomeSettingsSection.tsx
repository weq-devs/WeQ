import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots.shared';
import { pageValue } from '../../lib/pageSnapshots';
import { House, ListFilter } from 'lucide-react';
import { AutoSave } from './AutoSave';
import {
  DEFAULT_HOME_SETTINGS,
  normalizeHomeSettings,
  type HomeSettings,
} from '@weq/service/home-settings';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { useDialog } from '../Dialog.shared';
import { Modal } from '../Dialog';
import { Card, Row, Toggle } from './controls';
import { SaveStatusSlotContext } from './controls.shared';
import { REVEAL_SETTING_EVENT } from './searchTarget';
import '../../styles/settings-home.css';

export function HomeSettingsSection() {
  const active = useTabActive();
  const utils = trpc.useUtils();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const save = trpc.bootstrap.setHomeSettings.useMutation();
  const showError = useDialog((s) => s.showError);
  const home = settings.data?.home;
  const savedWords = (home?.blockedWords ?? []).join('\n');
  const previous = useRef(savedWords);
  const [words, setWords] = usePageState('home:words', savedWords, pageValue.string, true);
  useEffect(() => {
    const before = previous.current;
    setWords((draft) => (draft === before ? savedWords : draft));
    previous.current = savedWords;
  }, [savedWords, setWords]);
  const blockedWords = normalizeHomeSettings({ blockedWords: words.split(/\r?\n/) }).blockedWords;
  usePageDraftConfirmation(
    'home:words',
    home
      ? JSON.stringify(blockedWords) === JSON.stringify(home.blockedWords)
        ? words
        : savedWords
      : undefined,
  );
  const valid = blockedWords.length <= 1000 && blockedWords.every((word) => word.length <= 200);
  const disabled = !home;
  const showHitokoto = home?.showHitokoto ?? false;
  const [wordsOpen, setWordsOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const wordsId = useId();
  const editorOpen = active && showHitokoto && wordsOpen;
  const closeWords = useCallback(() => {
    trigger.current?.focus({ preventScroll: true });
    setWordsOpen(false);
  }, []);

  useLayoutEffect(() => {
    const button = trigger.current;
    if (!active || !showHitokoto || !button) {
      setWordsOpen(false);
      return;
    }
    const reveal = () => {
      if (editorOpen) input.current?.focus({ preventScroll: true });
      else setWordsOpen(true);
    };
    button.addEventListener(REVEAL_SETTING_EVENT, reveal);
    return () => button.removeEventListener(REVEAL_SETTING_EVENT, reveal);
  }, [active, editorOpen, showHitokoto]);
  useEffect(() => {
    if (editorOpen) input.current?.focus({ preventScroll: true });
  }, [editorOpen]);

  async function update(patch: Partial<Omit<HomeSettings, 'blockedWords'>>) {
    try {
      const result = await save.mutateAsync(patch);
      utils.bootstrap.getSettings.setData(undefined, (current) =>
        current ? { ...current, home: result } : current,
      );
    } catch (error) {
      showError('保存主页设置失败', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="weq-set">
      {settings.isError && <p role="alert">{settings.error.message}</p>}
      <Card title="主页" icon={<House size={16} strokeWidth={1.8} />}>
        {(
          [
            ['preferQqShow', '优先展示 QQ 秀', 'home-prefer-qqshow'],
            ['showTags', '个性标签', 'home-tags'],
            ['showGreeting', '问候语', 'home-greeting'],
          ] as const
        ).map(([key, label, id]) => (
          <Row
            key={key}
            settingId={id}
            label={label}
            control={
              <Toggle
                label={label}
                checked={(home ?? DEFAULT_HOME_SETTINGS)[key]}
                disabled={disabled}
                onChange={(enabled) => void update({ [key]: enabled })}
              />
            }
          />
        ))}
        <Row
          settingId="home-hitokoto"
          control={
            <div
              className="weq-home-hitokoto-controls"
              data-setting-fallback={
                !showHitokoto && !settings.isLoading ? 'home-blocked-words' : undefined
              }
            >
              <Toggle
                label="一言"
                checked={(home ?? DEFAULT_HOME_SETTINGS).showHitokoto}
                disabled={disabled}
                onChange={(enabled) => void update({ showHitokoto: enabled })}
              />
              {showHitokoto ? (
                <button
                  ref={trigger}
                  type="button"
                  className="weq-set-iconbtn"
                  title="一言屏蔽词"
                  aria-label="一言屏蔽词"
                  aria-haspopup="dialog"
                  aria-expanded={editorOpen}
                  aria-controls={wordsId}
                  data-setting-id="home-blocked-words"
                  onClick={(event) => {
                    if (editorOpen) closeWords();
                    else {
                      event.currentTarget.focus({ preventScroll: true });
                      setWordsOpen(true);
                    }
                  }}
                >
                  <ListFilter size={16} aria-hidden />
                </button>
              ) : null}
            </div>
          }
        />
        <Modal
          open={editorOpen}
          presentation="popover"
          anchor={editorOpen ? trigger.current : undefined}
          width={320}
          labelledBy={`${wordsId}-label`}
          className="weq-home-words-popover"
          onClose={closeWords}
        >
          <SaveStatusSlotContext.Provider value={null}>
            <AutoSave
              value={blockedWords}
              saved={home?.blockedWords ?? []}
              ready={!!home}
              valid={valid}
              reset={() => setWords(savedWords)}
              save={async (nextWords) => {
                const result = await save.mutateAsync({ blockedWords: nextWords });
                utils.bootstrap.getSettings.setData(undefined, (current) =>
                  current ? { ...current, home: result } : current,
                );
                // 首页与设置共用缓存；屏蔽词修改后立即淘汰旧句子。
                await utils.account.sampleHitokoto.invalidate();
              }}
            >
              <div className="weq-set-text-field">
                <label className="weq-set-row-label" id={`${wordsId}-label`} htmlFor={wordsId}>
                  一言屏蔽词
                </label>
                <textarea
                  id={wordsId}
                  ref={input}
                  aria-label="一言屏蔽词（每行一个）"
                  aria-invalid={!valid || undefined}
                  className="weq-set-input"
                  rows={5}
                  value={words}
                  placeholder="每行一个屏蔽词"
                  onChange={(event) => setWords(event.target.value)}
                />
                {!valid && <p>最多 1000 个屏蔽词，每个不超过 200 字。</p>}
              </div>
            </AutoSave>
          </SaveStatusSlotContext.Provider>
        </Modal>
      </Card>
    </div>
  );
}
