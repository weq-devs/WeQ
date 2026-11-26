import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { TRPCClientError } from '@trpc/client';
import { SETTINGS_FIELDS } from '@weq/service/settings-catalog';
import { RotateCcw } from 'lucide-react';
import { Modal } from '../Dialog';
import { LoadingIndicator } from '../LoadingIndicator';
import { SegmentedControl } from '../SegmentedControl';
import { client, trpc } from '../../trpc/client';
import {
  SETTINGS_RESET_CARDS,
  resetCards,
  isLogPolicyResetItem,
  settingsResetScopeLabel,
  type SettingsResetTarget,
  type SettingsResetItem,
  type SettingsResetResult,
  type SettingsResetCardId,
} from '../../../../shared/settings_reset';
import { SettingsResetContext, type ResetSave } from './resetContext';
import { SETTINGS_PAGE_LABELS, settingsSectionFor } from './navigation';
import '../../styles/settings-reset.css';
import { acceptPreferences, settlePreferenceWrites } from '../../lib/clientPreferences';
import {
  describeLogPruneImpact,
  describeSettingsReset,
  formatResetValue,
} from '../../lib/settingsResetPreview';
import { IS_WEB } from '../../lib/target.shared';
import { useRemoteClient } from '../../lib/remoteClient';

const differs = (item: SettingsResetItem) =>
  JSON.stringify(item.current) !== JSON.stringify(item.defaultValue);
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
      data-danger="outline"
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
  const remote = useRemoteClient();
  const queues = useRef(new Map<SettingsResetCardId, Set<ResetSave>>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [dialog, setDialog] = useState<
    | (Awaited<ReturnType<typeof client.settingsReset.preview.query>> & {
        target: SettingsResetTarget;
      })
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [results, setResults] = useState<SettingsResetResult[]>([]);
  const failed = results.filter((result) => !result.ok).map((result) => result.id);
  const retriesLogPolicy = failed.some(isLogPolicyResetItem);
  const logPrune = !failed.length || retriesLogPolicy ? dialog?.logPrune : null;
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = confirmButton.current;
    if (
      !busy &&
      button &&
      !button.disabled &&
      button.ownerDocument.activeElement === button.closest('.weq-dialog-layer')
    )
      (logPrune ? cancelButton.current : button)?.focus();
  }, [busy, logPrune]);
  const supported = SETTINGS_RESET_CARDS.some(
    ([id, card]) =>
      id === page &&
      (!IS_WEB ||
        remote ||
        SETTINGS_FIELDS.some((field) => field.card === card && !field.desktopOnly)),
  );
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
    setDialog({ target, source: null, items: [], revision: '', logPrune: null });
    setBusy(true);
    setError('');
    setNotice('');
    setDirectories([]);
    setResults([]);
    try {
      await settlePreferenceWrites();
      const preview = await client.settingsReset.preview.query(target);
      if (!alive.current) return;
      setDialog({ target, ...preview });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const refreshPreview = async (active: NonNullable<typeof dialog>) => {
    const preview = await client.settingsReset.preview.query(active.target);
    if (!alive.current) return;
    setDialog({ target: active.target, ...preview });
    if (preview.source !== active.source) {
      setResults([]);
      setDirectories([]);
    } else {
      setDirectories((before) =>
        before.filter((id) => preview.items.some((item) => item.id === id)),
      );
    }
  };
  const apply = async () => {
    if (!dialog || busy) return;
    const active = dialog;
    const retry = failed.length ? failed : undefined;
    const relevant = resetCards(active.target).flatMap(([, card]) => [...saves(card)]);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await Promise.all(relevant.map((save) => save.suspend()));
      await settlePreferenceWrites();
      const completed = await client.settingsReset.restore.mutate({
        ...active.target,
        source: active.source,
        revision: active.revision,
        pruneConfirmation: logPrune?.confirmation,
        directories,
        retry,
      });
      if (!alive.current) return;
      setResults((before) => [
        ...before.filter((item) => !completed.some((next) => next.id === item.id)),
        ...completed,
      ]);
      const cards = new Set(resetCards(active.target).map(([, card]) => card));
      const refresh: Promise<unknown>[] = [
        client.clientState.snapshot.query().then(acceptPreferences),
      ];
      if (active.target.page !== 'appearance')
        refresh.push(utils.bootstrap.getSettings.invalidate());
      if (cards.has('mcp')) refresh.push(utils.bootstrap.getMcpStatus.invalidate());
      if (cards.has('assistant')) refresh.push(utils.bootstrap.getWeqAssistantStatus.invalidate());
      if (cards.has('assistant-config'))
        refresh.push(utils.account.getAssistantConfig.invalidate());
      if (cards.has('performance-recording'))
        refresh.push(utils.performanceMonitor.status.invalidate());
      if (cards.has('logs')) {
        refresh.push(utils.help.getNativeDebugLog.invalidate(), utils.help.logStorage.invalidate());
      }
      if (cards.has('onebot')) refresh.push(utils.bootstrap.getOneBotStatus.invalidate());
      if (cards.has('qq-client-sync'))
        refresh.push(utils.bootstrap.getQqClientSyncStatus.invalidate());
      if (cards.has('sse-targets') || cards.has('sse-tuning'))
        refresh.push(utils.bootstrap.getSsePushStatus.invalidate());
      if (cards.has('startup-system'))
        refresh.push(utils.bootstrap.getAutostartStatus.invalidate());
      if (cards.has('auto-enter')) refresh.push(utils.bootstrap.getAutoEnter.invalidate());
      if (cards.has('api-default'))
        refresh.push(
          utils.bootstrap.getAgentLabDefaultModel.invalidate(),
          utils.bootstrap.getDefaultVisionModel.invalidate(),
          utils.bootstrap.getDefaultEmbeddingModel.invalidate(),
        );
      if (cards.has('typing')) refresh.push(utils.bootstrap.getTypingStatusSettings.invalidate());
      if (cards.has('intent-basic'))
        refresh.push(
          utils.bootstrap.localModelResources.invalidate(),
          utils.bootstrap.getLocalEngine.invalidate(),
        );
      if ([...cards].some((card) => /^(intent|suggestion|profile)-/.test(card)))
        refresh.push(
          utils.account.intentSense.getStatus.invalidate(),
          utils.account.intentSense.listMessageAnalyses.invalidate(),
          utils.account.intentSense.getSuggestions.invalidate(),
          utils.account.intentSense.getProfile.invalidate(),
        );
      if (cards.has('recall-scope')) refresh.push(utils.account.antiRecall.getStatus.invalidate());
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
      else await refreshPreview(active);
    } catch (reason) {
      if (reason instanceof TRPCClientError && reason.data?.code === 'CONFLICT') {
        try {
          await refreshPreview(active);
          setNotice(reason.message);
        } catch (readError) {
          setDialog({ ...active, items: [], revision: '', logPrune: null });
          setError(readError instanceof Error ? readError.message : String(readError));
        }
      } else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      relevant.forEach((save) => {
        save.release();
      });
      setBusy(false);
    }
  };
  const changed =
    dialog?.items.filter(
      (item) =>
        (!failed.length ||
          failed.includes(item.id) ||
          (retriesLogPolicy && isLogPolicyResetItem(item.id))) &&
        differs(item) &&
        (!item.directory || directories.includes(item.id)),
    ) ?? [];
  const label = dialog?.target.card
    ? SETTINGS_RESET_CARDS.find(([, card]) => card === dialog.target.card)?.[2]
    : dialog
      ? SETTINGS_PAGE_LABELS[settingsSectionFor(dialog.target.page)]
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
                  <LoadingIndicator>正在处理…</LoadingIndicator>
                </p>
              ) : null}
              {notice ? <p role="status">{notice}</p> : null}
              <div className="weq-settings-reset-items">
                {dialog.items
                  .filter((item) => !item.directory)
                  .map((item) => (
                    <div key={item.id} className="weq-settings-reset-item">
                      <strong>
                        {item.label}
                        {item.scope !== '全局' && (
                          <small>{settingsResetScopeLabel(item.scope)}</small>
                        )}
                      </strong>
                      <dl className="weq-settings-reset-preview">
                        {describeSettingsReset(item).map((line) => (
                          <div key={line.label}>
                            <dt>{line.label}</dt>
                            <dd>{line.text}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                {dialog.items
                  .filter((item) => item.directory && differs(item))
                  .map((item) => (
                    <div key={item.id} className="weq-set-row weq-defaults-row">
                      <span className="weq-set-row-main">
                        <span className="weq-set-row-label">{item.label}</span>
                        <small className="weq-set-row-desc">
                          {formatResetValue(item.current, item.id)}
                        </small>
                      </span>
                      <SegmentedControl<'keep' | 'reset'>
                        label={item.label}
                        value={directories.includes(item.id) ? 'reset' : 'keep'}
                        disabled={busy}
                        onChange={(choice) =>
                          setDirectories((before) =>
                            choice === 'reset'
                              ? [...before, item.id]
                              : before.filter((id) => id !== item.id),
                          )
                        }
                        options={[
                          { value: 'keep', label: '保留当前' },
                          { value: 'reset', label: '恢复默认' },
                        ]}
                      />
                    </div>
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
              {changed.some((item) => item.id === 'qq-client-sync:proxy') ? (
                <p>停用 QQ 代理前，请先在 QQ 的「网络设置」中恢复直连。</p>
              ) : null}
              {directories.length ? <p>仅更改目录设置，不迁移或删除已有文件。</p> : null}
              {dialog.target.page === 'logs' ? <p>性能记录的保存时长和容量上限会保留。</p> : null}
              {dialog.target.page === 'mail' ? <p>新邮件提醒可在「通知与提醒」恢复默认。</p> : null}
              {logPrune ? <p>{describeLogPruneImpact(logPrune)}</p> : null}
              {!busy && !changed.length && !error ? <p>当前已是默认设置。</p> : null}
              {results.length ? (
                <div role="status">
                  <p>
                    已完成{' '}
                    {
                      <span className="weq-number weq-number-inherit">
                        {results.filter((item) => item.ok).length}
                      </span>
                    }{' '}
                    项，失败{' '}
                    {
                      <span className="weq-number weq-number-inherit">
                        {results.filter((item) => !item.ok).length}
                      </span>
                    }{' '}
                    项。
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
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                ref={cancelButton}
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
                data-danger="outline"
                data-weq-dialog-confirm={logPrune ? undefined : true}
                ref={confirmButton}
                disabled={
                  busy ||
                  (!changed.length && !results.some((item) => !item.ok)) ||
                  (!!error && !dialog.items.length)
                }
                onClick={() => void apply()}
              >
                {logPrune
                  ? '恢复并删除'
                  : results.some((item) => !item.ok)
                    ? '重试失败项'
                    : '确认恢复默认'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </SettingsResetContext.Provider>
  );
}
