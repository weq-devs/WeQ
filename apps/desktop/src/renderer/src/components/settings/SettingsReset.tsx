import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw, Loader2 } from 'lucide-react';
import { Modal } from '../Dialog';
import { client, trpc } from '../../trpc/client';
import { DEFAULT_THEME_SETTINGS as themeDefaults, useThemeStore } from '../../state/theme';
import {
  SETTINGS_RESET_CARDS,
  resetCards,
  type SettingsResetTarget,
  type SettingsResetItem,
  type SettingsResetResult,
  type SettingsResetCardId,
} from '../../../../shared/settings_reset';
import { SettingsResetContext, type ResetSave } from './resetContext';
import { SETTINGS_PAGE_LABELS } from './navigation';
import '../../styles/settings-reset.css';
import { changePreference, preferenceValue } from '../../lib/clientPreferences';
import { preferenceDefaults, type PreferenceKey } from '@weq/service/client-preferences';

interface LocalEntry extends SettingsResetItem {
  apply: () => void | Promise<void>;
}
function localEntries(target: SettingsResetTarget): LocalEntry[] {
  const cards = new Set(resetCards(target).map(([, card]) => card));
  const theme = useThemeStore.getState();
  const all: Array<LocalEntry & { card: SettingsResetCardId }> = [];
  const add = (
    card: SettingsResetCardId,
    id: string,
    label: string,
    current: unknown,
    defaultValue: unknown,
    apply: () => void | Promise<void>,
  ) => all.push({ card, id: `${card}:${id}`, label, current, defaultValue, apply, scope: '全局' });
  const resetPreference = async (name: PreferenceKey) => {
    if (!(await changePreference(name, preferenceDefaults[name])))
      throw new Error('设置未保存，请重试');
  };
  add('theme-mode', 'preference', '基础模式', theme.preference, themeDefaults.preference, () =>
    resetPreference('preference'),
  );
  add('theme-accent', 'accent', '主题色', theme.accent, themeDefaults.accent, () =>
    resetPreference('accent'),
  );
  add(
    'theme-background',
    'background',
    '界面背景',
    theme.background,
    themeDefaults.background,
    () => resetPreference('background'),
  );
  add(
    'theme-components',
    'style',
    '组件风格',
    theme.componentStyle,
    themeDefaults.componentStyle,
    () => resetPreference('componentStyle'),
  );
  add('theme-components', 'density', '界面密度', theme.density, themeDefaults.density, () =>
    resetPreference('density'),
  );
  add(
    'privacy-mode',
    'enabled',
    '隐私模式',
    preferenceValue('privacyMode'),
    preferenceDefaults.privacyMode,
    () => resetPreference('privacyMode'),
  );
  add(
    'privacy-mode',
    'capture',
    '截图临时隐私模式',
    preferenceValue('capturePrivacy'),
    preferenceDefaults.capturePrivacy,
    () => resetPreference('capturePrivacy'),
  );
  add('web-notifications', 'enabled', '网页通知', preferenceValue('webNotifications'), false, () =>
    resetPreference('webNotifications'),
  );
  add(
    'reading',
    'keepConversationPositionOnHover',
    '鼠标停留时保持会话位置',
    preferenceValue('keepConversationPositionOnHover'),
    preferenceDefaults.keepConversationPositionOnHover,
    () => resetPreference('keepConversationPositionOnHover'),
  );
  add(
    'unread',
    'message-notifications',
    '新消息系统通知',
    preferenceValue('messageNotifications'),
    false,
    () => resetPreference('messageNotifications'),
  );
  add(
    'unread',
    'application-badge',
    '应用图标未读角标',
    preferenceValue('applicationBadge'),
    true,
    () => resetPreference('applicationBadge'),
  );
  return all.filter((entry) => cards.has(entry.card));
}
const differs = (item: SettingsResetItem) =>
  JSON.stringify(item.current) !== JSON.stringify(item.defaultValue);
function display(value: unknown): string {
  if (value === true) return '开启';
  if (value === false) return '关闭';
  if (value === '' || value === null || value === undefined) return '默认／未设置';
  if (Array.isArray(value)) return value.length ? value.map(display).join('、') : '空列表';
  if (typeof value === 'object') {
    const data = value as Record<string, unknown>;
    if ('windowSeconds' in data && 'maxPages' in data)
      return `${data.windowSeconds} 秒内最多 ${data.maxPages} 页`;
    if ('debounceMs' in data) return `防抖 ${data.debounceMs} 毫秒，阈值 ${data.massThreshold}`;
    if ('showTags' in data)
      return `标签${display(data.showTags)}，问候语${display(data.showGreeting)}，一言${display(data.showHitokoto)}；屏蔽词：${display(data.blockedWords)}`;
    if (data.useDefault) return '使用默认模型';
    if (typeof data.model === 'string') return `${data.providerId} · ${data.model}`;
    return typeof data.name === 'string' ? data.name : JSON.stringify(value);
  }
  const labels: Record<string, string> = {
    off: '关闭',
    all: '永久全选',
    selected: '按会话选择',
    api: 'API 模型',
    local: '本地模型',
    heuristic: '本地统计',
    auto: '自动',
    manual: '手动',
    mixed: '双方混合',
    self: '仅本端',
    peer: '仅对方',
    home: '主页',
    messages: '消息',
    last: '上次页面',
    space: '空间',
    profile: '名片',
    totp: '验证器',
    system: '系统默认',
    tray: '最小化到托盘',
    quit: '退出',
    ask: '每次询问',
    comfortable: '舒适',
    compact: '紧凑',
    plain: '纯净',
    qqnt: 'QQ NT',
  };
  return typeof value === 'string' ? (labels[value] ?? value) : String(value);
}
export function SettingsResetButton({ card }: { card?: SettingsResetCardId }) {
  const context = useContext(SettingsResetContext);
  if (!context) return null;
  // 恢复入口只保留页面级一个：同一页的卡片级入口与页面级措辞不同、功能重叠。
  if (card) return null;
  const label = '恢复本页默认设置';
  return (
    <button
      type="button"
      className="weq-set-btn weq-set-btn-soft weq-settings-reset-button"
      aria-label={label}
      title={label}
      onClick={() => context.open({ page: context.page })}
    >
      <RotateCcw size={14} aria-hidden />
      <span>恢复本页默认</span>
    </button>
  );
}

export function SettingsResetProvider({ page, children }: { page: string; children: ReactNode }) {
  const utils = trpc.useUtils();
  const queues = useRef(new Map<SettingsResetCardId, Set<ResetSave>>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [dialog, setDialog] = useState<{
    target: SettingsResetTarget;
    source: string | null;
    items: SettingsResetItem[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [results, setResults] = useState<SettingsResetResult[]>([]);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = cancelButton.current;
    if (
      !busy &&
      button &&
      button.ownerDocument.activeElement === button.closest('.weq-dialog-layer')
    )
      button.focus();
  }, [busy]);
  const supported = SETTINGS_RESET_CARDS.some(([id]) => id === page);
  if (!supported) return <>{children}</>;
  const saves = (card: SettingsResetCardId) => {
    let set = queues.current.get(card);
    if (!set) {
      set = new Set();
      queues.current.set(card, set);
    }
    return set;
  };
  const open = async (target: SettingsResetTarget) => {
    setDialog({ target, source: null, items: [] });
    setBusy(true);
    setError('');
    setDirectories([]);
    setResults([]);
    try {
      const preview = await client.settingsReset.preview.query(target);
      if (!alive.current) return;
      setDialog({
        target,
        source: preview.source,
        items: [
          ...preview.items.filter(
            (item) => !localEntries(target).some((local) => local.id === item.id),
          ),
          ...localEntries(target).map(({ apply: _apply, ...item }) => item),
        ],
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!dialog || busy) return;
    const active = dialog;
    const failed = results.filter((result) => !result.ok).map((result) => result.id);
    const retry = failed.length ? failed : undefined;
    const relevant = resetCards(active.target).flatMap(([, card]) => [...saves(card)]);
    setBusy(true);
    setError('');
    try {
      await Promise.all(relevant.map((save) => save.suspend()));
      const localIds = new Set(localEntries(active.target).map((item) => item.id));
      const completed = await client.settingsReset.restore.mutate({
        ...active.target,
        source: active.source,
        directories,
        retry: retry?.filter((id) => !localIds.has(id)),
      });
      if (!alive.current) return;
      for (const item of localEntries(active.target)) {
        if (!differs(item) || (retry && !retry.includes(item.id))) continue;
        try {
          await item.apply();
          completed.push({ id: item.id, ok: true });
        } catch (reason) {
          completed.push({ id: item.id, ok: false, error: String(reason) });
        }
      }
      setResults((before) => [
        ...before.filter((item) => !completed.some((next) => next.id === item.id)),
        ...completed,
      ]);
      const cards = new Set(resetCards(active.target).map(([, card]) => card));
      const refresh: Promise<unknown>[] = [];
      if (active.target.page !== 'appearance')
        refresh.push(utils.bootstrap.getSettings.invalidate());
      if (cards.has('mcp')) refresh.push(utils.bootstrap.getMcpStatus.invalidate());
      if (cards.has('assistant')) refresh.push(utils.bootstrap.getWeqAssistantStatus.invalidate());
      if (cards.has('onebot') || cards.has('onebot-servers'))
        refresh.push(utils.bootstrap.getOneBotStatus.invalidate());
      if (cards.has('sse-targets') || cards.has('sse-tuning'))
        refresh.push(utils.bootstrap.getSsePushStatus.invalidate());
      if (cards.has('startup-system'))
        refresh.push(utils.bootstrap.getAutostartStatus.invalidate());
      if (cards.has('auto-enter')) refresh.push(utils.bootstrap.getAutoEnter.invalidate());
      if (cards.has('api-default'))
        refresh.push(utils.bootstrap.getAgentLabDefaultModel.invalidate());
      if (cards.has('typing')) refresh.push(utils.bootstrap.getTypingStatusSettings.invalidate());
      if ([...cards].some((card) => /^(intent|suggestion|profile)-/.test(card)))
        refresh.push(
          utils.account.intentSense.getStatus.invalidate(),
          utils.account.intentSense.listMessageAnalyses.invalidate(),
          utils.account.intentSense.getSuggestions.invalidate(),
          utils.account.intentSense.getProfile.invalidate(),
        );
      if (cards.has('recall-scope')) refresh.push(utils.account.antiRecall.getStatus.invalidate());
      if (cards.has('native-media')) refresh.push(utils.account.getAccountConfig.invalidate());
      if (cards.has('db-tolerance')) refresh.push(utils.account.getDbTolerance.invalidate());
      if (cards.has('mail')) refresh.push(utils.mail.preferences.invalidate());
      if (cards.has('remote')) refresh.push(utils.remote.status.invalidate());
      if (cards.has('web')) refresh.push(utils.remote.webStatus.invalidate());
      if (cards.has('update'))
        refresh.push(
          utils.update.getInterval.invalidate(),
          utils.update.getPrerelease.invalidate(),
        );
      await Promise.all(refresh);
      // 查询回读与 React 提交完成后再同步草稿，防止用恢复前的缓存重置输入。
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (const [, card] of resetCards(active.target)) {
        saves(card).forEach((save) => {
          const failures = completed.some(
            (item) =>
              item.id.startsWith(`${card}:`) &&
              !item.ok &&
              (!save.keys || save.keys.includes(item.id.slice(card.length + 1))),
          );
          if (!failures) save.reset();
        });
      }
      if (completed.every((item) => item.ok)) setDialog(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      relevant.forEach((save) => {
        save.release();
      });
      setBusy(false);
    }
  };
  const changed =
    dialog?.items.filter(
      (item) => differs(item) && (!item.directory || directories.includes(item.id)),
    ) ?? [];
  const label = dialog?.target.card
    ? SETTINGS_RESET_CARDS.find(([, card]) => card === dialog.target.card)?.[2]
    : dialog
      ? SETTINGS_PAGE_LABELS[dialog.target.page]
      : '本页';
  return (
    <SettingsResetContext.Provider
      value={{
        page: page as SettingsResetTarget['page'],
        saves,
        open: (target) => void open(target),
      }}
    >
      {children}
      {dialog ? (
        <Modal
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          width={520}
          className="weq-message-modal weq-settings-reset-modal"
          labelledBy="weq-settings-reset-title"
        >
          <div className="weq-dialog">
            <div className="weq-dialog-head">
              <h3 id="weq-settings-reset-title" className="weq-dialog-title">
                恢复{label}默认设置？
              </h3>
            </div>
            <div className="weq-dialog-body">
              {busy ? (
                <p role="status">
                  <Loader2 className="weq-spin" size={14} />
                  正在处理…
                </p>
              ) : null}
              <div className="weq-settings-reset-items">
                {dialog.items
                  .filter((item) => !item.directory)
                  .map((item) => (
                    <div key={item.id} className="weq-settings-reset-item">
                      <strong>
                        {item.label}
                        <small>{item.scope}</small>
                      </strong>
                      <span>
                        {differs(item)
                          ? `${display(item.current)} → ${display(item.defaultValue)}`
                          : `已是默认：${display(item.defaultValue)}`}
                      </span>
                    </div>
                  ))}
                {dialog.items
                  .filter((item) => item.directory && differs(item))
                  .map((item) => (
                    <label key={item.id} className="weq-defaults-row">
                      <span>
                        {item.label}
                        <small>{display(item.current)}</small>
                      </span>
                      <select
                        aria-label={item.label}
                        disabled={busy}
                        value={directories.includes(item.id) ? 'reset' : 'keep'}
                        onChange={(event) =>
                          setDirectories((before) =>
                            event.target.value === 'reset'
                              ? [...before, item.id]
                              : before.filter((id) => id !== item.id),
                          )
                        }
                      >
                        <option value="keep">保留当前</option>
                        <option value="reset">恢复默认</option>
                      </select>
                    </label>
                  ))}
              </div>
              {changed.some((item) => item.stopsService) ? (
                <p>
                  将停用：
                  {changed
                    .filter((item) => item.stopsService)
                    .map((item) => item.label)
                    .join('、')}
                  。
                </p>
              ) : null}
              {directories.length ? <p>仅更改目录设置，不迁移或删除已有文件。</p> : null}
              {!busy && !changed.length && !error ? <p>当前已是默认设置。</p> : null}
              {results.length ? (
                <div role="status">
                  <p>
                    已完成 {results.filter((item) => item.ok).length} 项，失败{' '}
                    {results.filter((item) => !item.ok).length} 项。
                  </p>
                  {results
                    .filter((item) => !item.ok)
                    .map((item) => (
                      <p role="alert" key={item.id}>
                        {dialog.items.find((entry) => entry.id === item.id)?.label}
                        ：未能恢复，可重试。
                        {item.error ? (
                          <details className="weq-settings-reset-detail">
                            <summary>技术详情</summary>
                            <pre>{item.error}</pre>
                          </details>
                        ) : null}
                      </p>
                    ))}
                </div>
              ) : null}
              {error ? (
                <div role="alert" className="weq-settings-reset-error">
                  <p>
                    {dialog.items.length
                      ? '恢复默认设置没有完成，请重试。'
                      : '没能读取要恢复的设置项，请重试。'}
                  </p>
                  <details className="weq-settings-reset-detail">
                    <summary>技术详情</summary>
                    <pre>{error}</pre>
                  </details>
                </div>
              ) : null}
            </div>
            <div className="weq-modal-actions weq-dialog-foot">
              <button
                ref={cancelButton}
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              {error && !dialog.items.length ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={busy}
                  onClick={() => void open(dialog.target)}
                >
                  重新读取
                </button>
              ) : null}
              <button
                type="button"
                className="weq-set-btn"
                disabled={
                  busy ||
                  (!changed.length && !results.some((item) => !item.ok)) ||
                  (!!error && !dialog.items.length)
                }
                onClick={() => void apply()}
              >
                {results.some((item) => !item.ok) ? '重试失败项' : '确认恢复默认'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </SettingsResetContext.Provider>
  );
}
