import { useEffect, useRef } from 'react';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';
import { House, Loader2, Save } from 'lucide-react';
import {
  DEFAULT_HOME_SETTINGS,
  normalizeHomeSettings,
  type HomeSettings,
} from '@weq/service/home-settings';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';
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
  const pushToast = useToast((s) => s.push);
  const home = settings.data?.home;
  const savedWords = (home?.blockedWords ?? []).join('\n');
  const previous = useRef(savedWords);
  const [words, setWords] = usePageState('home:words', savedWords, pageValue.string, true);
  usePageDraftConfirmation('home:words', home ? savedWords : undefined);
  useEffect(() => {
    const before = previous.current;
    setWords((draft) => (draft === before ? savedWords : draft));
    previous.current = savedWords;
  }, [savedWords, setWords]);
  const blockedWords = normalizeHomeSettings({ blockedWords: words.split(/\r?\n/) }).blockedWords;
  const valid = blockedWords.length <= 1000 && blockedWords.every((word) => word.length <= 200);
  const disabled = !home || save.isLoading;

  async function update(patch: Partial<HomeSettings>) {
    try {
      const result = await save.mutateAsync(patch);
      utils.bootstrap.getSettings.setData(undefined, (current) =>
        current ? { ...current, home: result } : current,
      );
      // 首页与设置共用缓存；屏蔽词修改后立即淘汰旧句子。
      if (patch.blockedWords) {
        await utils.account.sampleHitokoto.invalidate();
        setWords(result.blockedWords.join('\n'));
        pushToast({ tone: 'success', title: '一言屏蔽词已保存' });
      }
    } catch (error) {
      showError('保存主页设置失败', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader title="主页" icon={<House size={16} strokeWidth={1.8} />} />
      {settings.isError && <p role="alert">{settings.error.message}</p>}
      <Card title="主页显示">
        {(
          [
            ['showTags', '个性标签', 'home-tags'],
            ['showGreeting', '问候语', 'home-greeting'],
            ['showHitokoto', '一言', 'home-hitokoto'],
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
      </Card>
      <Card title="一言屏蔽词" settingId="home-blocked-words">
        <form
          className="weq-home-words"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && valid) void update({ blockedWords });
          }}
        >
          <textarea
            aria-label="一言屏蔽词（每行一个）"
            className="weq-set-input"
            rows={6}
            value={words}
            disabled={disabled}
            placeholder="每行一个屏蔽词"
            onChange={(event) => setWords(event.target.value)}
          />
          {!valid && <p role="alert">最多 1000 个屏蔽词，每个不超过 200 字。</p>}
          <button
            type="submit"
            className="weq-set-btn"
            disabled={disabled || !valid || words === savedWords}
          >
            {save.isLoading ? <Loader2 size={14} className="weq-spin" /> : <Save size={14} />}保存
          </button>
        </form>
      </Card>
    </div>
  );
}
