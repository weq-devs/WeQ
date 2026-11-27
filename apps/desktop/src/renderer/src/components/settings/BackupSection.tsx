import { NumericText } from '../NumericText';
import { preciseTimeFormatter as eventTimeFormatter } from '@weq/time';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { ArchiveRestore, Download, RefreshCw, RotateCcw, Upload, X } from 'lucide-react';
import type { WeqBackupPart, WeqBackupSummary, WeqDefaultsChoice } from '@weq/service';
import { snapshotWeqClientLayout, type WeqSelectiveBackup } from '@weq/service/backup-client';
import { usePrivacyStore } from '../../state/privacy';
import { FormSelect } from '../FormSelect';
import { BackupDisclosure, BackupExportOptions } from './BackupExportOptions';
import { backupClientId } from '../../lib/backupClientRestore';
import { useToast } from '../Toast.shared';
import { Card, SectionHeader } from './controls';
import { BeforeLoginSettingsContext } from './controls.shared';
import { useTabActive } from '../RetainedTabs.shared';
import { Modal } from '../Dialog';
import { settlePreferenceWrites } from '../../lib/clientPreferences';
import { DefaultsOptions, type DefaultsInfo } from './DefaultsOptions';
import { DEFAULTS_DESCRIPTION } from './DefaultsOptions.shared';
import { useRenderDocument } from '../../lib/renderDocument';
import { describeLogPruneImpact } from '../../lib/settingsResetPreview';
import '../../styles/backup.css';
import {
  backupApi,
  BACKUP_SECTION_LABELS,
  canExportBackup,
  createBackupSelection,
  selectedBackupSecrets,
} from './BackupSection.shared';

const LABELS: Record<WeqBackupPart, string> = {
  settings: '通用设置',
  accounts: '账号配置与偏好',
  api: 'API 配置与凭据',
  clones: '克隆体与助手数据',
};
type BackupApi = typeof backupApi;
type Inventory = Awaited<ReturnType<BackupApi['inventory']>>;
type Source = NonNullable<Awaited<ReturnType<BackupApi['pick']>>>;
type Preview = Awaited<ReturnType<BackupApi['prepare']>>;

function downloadClient() {
  try {
    return backupClientId(localStorage);
  } catch {
    return undefined;
  }
}

function openBackupDownload(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

function summaryLabels(summary: WeqBackupSummary) {
  return (
    summary.sections?.map((section) => BACKUP_SECTION_LABELS[section]) ??
    summary.parts.map(({ part }) => LABELS[part])
  );
}
function importScopes(summary: WeqBackupSummary, inventory: Inventory) {
  if (!summary.sections) return [];
  return [...new Set([...summary.accountConfigIds, ...summary.cloneConfigIds])]
    .filter((id) => !inventory.accounts.some(({ configId }) => configId === id))
    .map((id) => ({
      id,
      targets: inventory.accounts.filter(({ uin }) => uin === id.split('_')[0]),
    }))
    .filter(({ targets }) => targets.length);
}

function Summary({ value }: { value: WeqBackupSummary }) {
  return (
    <>
      <div className="weq-backup-summary">
        <span>
          {
            <span className="weq-number weq-number-inherit">
              {eventTimeFormatter.format(new Date(value.createdAt))}
            </span>
          }
          （北京时间）
        </span>
        {value.sections ? (
          <span>{summaryLabels(value).join('、')}</span>
        ) : (
          value.parts.map((part) => (
            <span key={part.part}>
              {LABELS[part.part]} ·{' '}
              <span className="weq-number weq-number-inherit">{part.files}</span> 个文件 ·{' '}
              <span className="weq-number weq-number-inherit">
                {(part.bytes / 1024).toFixed(1)}
              </span>{' '}
              KiB
            </span>
          ))
        )}
      </div>
      {value.warnings.length ? (
        <ul className="weq-backup-list">
          {value.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function BackupSection({ api = backupApi }: { api?: BackupApi }) {
  const active = useTabActive();
  const beforeLogin = useContext(BeforeLoginSettingsContext);
  const activity = useRef(active);
  activity.current = active;
  const document = useRenderDocument();
  const readSequence = useRef(0);
  const privacy = usePrivacyStore((state) => state.effective);
  const [exportSelection, setExportSelection] = useState<WeqSelectiveBackup | null>(null);
  const [scopeMap, setScopeMap] = useState<Record<string, string>>({});
  const [activateServices, setActivateServices] = useState(false);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [preview, setPreview] = useState<(Preview & { name: string }) | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    'export' | 'import' | 'defaults' | 'apply' | 'claim' | 'skip' | null
  >(null);
  const [defaultsInfo, setDefaultsInfo] = useState<DefaultsInfo | null>(null);
  const [defaultsChoice, setDefaultsChoice] = useState<WeqDefaultsChoice>({});
  const [busy, setBusy] = useState<string | null>('正在读取');
  const [error, setError] = useState<string | null>(null);
  const acting = useRef(false);
  const sourceId = useRef<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const defaultsFailed = useRef(false);
  useEffect(() => {
    if (!confirm || busy) return;
    if (confirm === 'import' || (confirm === 'defaults' && defaultsInfo?.logPrune))
      cancelButton.current?.focus();
    else if (!confirmButton.current?.disabled) confirmButton.current?.focus();
  }, [confirm, busy, defaultsInfo?.logPrune]);
  const toast = useToast((s) => s.push);
  const refresh = useCallback(async () => {
    if (!activity.current) return;
    const request = ++readSequence.current;
    const result = await api.inventory(downloadClient());
    if (!alive.current || !activity.current || readSequence.current !== request) return;
    setInventory(result);
  }, [api]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readSequence.current++;
      generation.current++;
      if (sourceId.current) void api.dispose(sourceId.current).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void refresh()
      .catch((e: unknown) => {
        if (current && alive.current) setError(String(e));
      })
      .finally(() => {
        if (current && alive.current) setBusy((value) => (value === '正在读取' ? null : value));
      });
    return () => {
      current = false;
      readSequence.current++;
    };
  }, [active, refresh]);
  async function act(label: string, run: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(label);
    setError(null);
    try {
      await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (alive.current) {
        setError(message);
        toast({ tone: 'error', title: '备份与恢复操作失败', detail: message });
      }
    } finally {
      acting.current = false;
      if (alive.current) setBusy(null);
    }
  }
  async function discardSource() {
    const id = sourceId.current;
    sourceId.current = null;
    if (id) await api.dispose(id).catch(() => {});
  }

  async function prepareImport(pick: () => Promise<Source | null>) {
    const seq = ++generation.current;
    let source: Source | null = null;
    try {
      source = await pick();
      if (!source || !alive.current || seq !== generation.current) return;
      sourceId.current = source.id;
      setBusy('正在校验备份');
      const parts = source.summary.parts.map(({ part }) => part);
      const review = await api.prepare(source.id, {
        parts,
        conflict: 'skip',
        keepLocalPaths: true,
        includeClient: true,
        ...(parts.includes('settings') ? { clientId: backupClientId(localStorage) } : {}),
      });
      if (!alive.current || seq !== generation.current) return;
      if (
        !review.planned.length &&
        (!inventory || !importScopes(review.summary, inventory).length)
      ) {
        toast({ tone: 'info', title: '备份没有可导入的内容', detail: '本机已有数据已保留。' });
        return;
      }
      setPreview({ ...review, name: source.name });
      setScopeMap({});
      setActivateServices(false);
      setConfirm('import');
      source = null; // 确认弹窗接管来源的生命周期。
    } finally {
      if (source) {
        if (sourceId.current === source.id) sourceId.current = null;
        await api.dispose(source.id).catch(() => {});
      }
    }
  }

  async function upload(file: File): Promise<Source> {
    if (!inventory || file.size < 1 || file.size > inventory.maxArchiveBytes)
      throw new Error('请选择不超过 260 MiB 的非空 WeQ 备份');
    const id = await api.begin(file.name, file.size);
    sourceId.current = id;
    try {
      for (let offset = 0; offset < file.size; offset += inventory.chunkBytes) {
        if (!alive.current) throw new Error('备份上传已取消');
        const bytes = new Uint8Array(
          await file.slice(offset, offset + inventory.chunkBytes).arrayBuffer(),
        );
        if (!alive.current) throw new Error('备份上传已取消');
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await api.chunk(id, offset, btoa(binary));
        if (alive.current)
          setBusy(
            `正在上传 ${Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100))}%`,
          );
      }
      if (!alive.current) throw new Error('备份上传已取消');
      setBusy('正在校验备份内容');
      return await api.finish(id);
    } finally {
      if (sourceId.current === id) sourceId.current = null;
      await api.dispose(id).catch(() => {});
    }
  }

  async function exportBackup(selection: WeqSelectiveBackup) {
    await settlePreferenceWrites();
    const out = await api.export({
      selection,
      client: selection.sections.includes('layout') ? snapshotWeqClientLayout(localStorage) : {},
      downloadClient: downloadClient(),
    });
    if (!out || !alive.current) return false;
    if (out.downloadUrl) openBackupDownload(out.downloadUrl);
    setDownloadUrl(out.downloadUrl);
    setExportMessage(out.downloadUrl ? '备份已生成。' : `已保存到 ${out.path}`);
    toast({
      tone: out.summary.warnings.length ? 'warning' : 'success',
      title: 'WeQ 备份已导出',
      detail: out.summary.warnings.join('；') || undefined,
    });
    void refresh().catch(() => undefined);
    return true;
  }

  async function downloadPreviousBackup() {
    const clientId = downloadClient();
    if (!clientId) throw new Error('此浏览器没有保留下载记录。');
    const result = await api.download(clientId);
    if (alive.current) openBackupDownload(result.url);
  }

  async function refreshImport(nextMap: Record<string, string>, activate: boolean) {
    if (!preview || !sourceId.current) throw new Error('备份预览已失效，请重新选择文件');
    const parts = preview.summary.parts.map(({ part }) => part);
    const review = await api.prepare(sourceId.current, {
      parts,
      conflict: 'skip',
      includeClient: true,
      keepLocalPaths: true,
      scopeMap: nextMap,
      activateServices: activate,
      ...(parts.includes('settings') ? { clientId: backupClientId(localStorage) } : {}),
    });
    if (alive.current) setPreview({ ...review, name: preview.name });
    return review;
  }

  const exportSecrets =
    confirm === 'export' && exportSelection ? selectedBackupSecrets(exportSelection) : [];
  const pending = inventory?.restore.pending;
  const result = inventory?.restore.result;
  const confirmation = confirm
    ? {
        export: {
          title: '选择备份内容',
          message: '',
          action: '保存备份',
          progress: '正在导出…',
        },
        import: {
          title: '导入这份备份？',
          message: '确认后会关闭当前账号并刷新界面，请先保存正在编辑的内容。',
          action: '确认导入',
          progress: '正在导入…',
        },
        defaults: {
          title: '恢复全局默认设置？',
          message: '将关闭当前账号并刷新各端界面，无需重启 WeQ。请先保存正在编辑的内容。',
          action: defaultsInfo?.logPrune ? '恢复并删除' : '确认恢复默认',
          progress: '正在恢复…',
        },
        apply: {
          title: '应用待恢复数据？',
          message:
            '请先保存正在编辑的内容。将关闭当前账号、应用已暂存的数据并刷新界面，无需重启 WeQ。',
          action: '应用恢复',
          progress: '正在恢复…',
        },
        claim: {
          title: '认领界面恢复回执？',
          message: '将恢复所选共享设置及当前设备布局并重新加载，原发起设备不再重复应用。',
          action: '在此设备恢复',
          progress: '正在恢复…',
        },
        skip: {
          title: '保留本机界面偏好？',
          message: '已恢复的 WeQ 数据不会撤销；所有设备均不再应用本次备份的界面偏好。',
          action: '保留本机界面偏好',
          progress: '正在处理…',
        },
      }[confirm]
    : null;
  function openConfirmation(value: NonNullable<typeof confirm>) {
    setError(null);
    setConfirm(value);
    if (value === 'export' && inventory) setExportSelection(createBackupSelection(inventory));
    if (value === 'defaults') {
      defaultsFailed.current = false;
      setDefaultsInfo(null);
      setDefaultsChoice({});
      void readDefaultsInfo();
    }
  }
  async function readDefaultsInfo() {
    await act('正在读取恢复范围', async () => {
      await settlePreferenceWrites();
      const info = await api.defaultsInfo();
      if (alive.current) setDefaultsInfo(info);
    });
  }
  function closeConfirmation() {
    if (confirm === 'import') {
      setPreview(null);
      void discardSource();
      setError(null);
    }
    setConfirm(null);
    if (defaultsFailed.current) window.location.reload();
  }
  const importBlocked =
    beforeLogin || Boolean(busy || !inventory || pending || result?.clientPending);
  return (
    <div className="weq-set weq-backup" aria-busy={Boolean(busy)}>
      <SectionHeader
        page="backup"
        title="配置备份与恢复"
        desc={beforeLogin ? '打开账号后可导入备份、应用恢复或恢复全局默认设置。' : undefined}
        actions={
          (!inventory && error) || pending || result?.clientPending ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={Boolean(busy)}
              onClick={() => void act('正在读取', refresh)}
            >
              <RefreshCw size={14} aria-hidden />
              刷新状态
            </button>
          ) : undefined
        }
      />
      {error && !confirm ? (
        <p className="weq-backup-error" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="weq-set-note">
          {busy}
        </p>
      ) : null}
      {result && (result.status === 'failed' || result.clientPending) ? (
        <Card
          title={result.status === 'failed' ? '最近一次恢复失败' : '界面偏好待恢复'}
          icon={<ArchiveRestore size={15} strokeWidth={1.8} />}
        >
          <p>
            {result.error || (
              <NumericText>{`已应用 ${result.applied.length} 项，跳过 ${result.skipped.length} 项。`}</NumericText>
            )}
          </p>
          {result.warnings.length ? (
            <ul className="weq-backup-list">
              {result.warnings.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
          {result.clientPending ? (
            <>
              <p>界面偏好等待原发起设备确认。也可明确改在当前设备恢复，或放弃这次界面偏好恢复。</p>
              <div className="weq-backup-actions">
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={beforeLogin || Boolean(busy)}
                  onClick={() => openConfirmation('claim')}
                >
                  改在此设备恢复
                </button>
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={Boolean(busy)}
                  onClick={() => openConfirmation('skip')}
                >
                  保留本机界面偏好
                </button>
              </div>
            </>
          ) : null}
        </Card>
      ) : null}
      <Card>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file && !importBlocked)
              void act('正在读取备份', () => prepareImport(() => upload(file)));
          }}
        />
        <div className="weq-backup-actions weq-backup-file-actions">
          <button
            type="button"
            className="weq-set-btn"
            data-setting-id="backup-import"
            disabled={importBlocked}
            onClick={() =>
              inventory?.canPickFile
                ? void act('正在读取备份', () => prepareImport(api.pick))
                : input.current?.click()
            }
          >
            <Upload size={14} aria-hidden />
            导入备份
          </button>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-primary"
            data-setting-id="backup-export"
            disabled={Boolean(busy) || !inventory}
            onClick={() => openConfirmation('export')}
          >
            <Download size={14} aria-hidden />
            导出备份
          </button>
        </div>
        <p className="weq-set-note">选择要保存的设置和数据，生成一份可在 WeQ 导入的 ZIP。</p>
        {exportMessage || inventory?.previousDownload ? (
          <p className="weq-set-note" role="status">
            {exportMessage ?? '备份已生成。'}{' '}
            {inventory?.previousDownload ? (
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={Boolean(busy)}
                onClick={() => void act('正在核对备份文件', downloadPreviousBackup)}
              >
                重新下载备份
              </button>
            ) : downloadUrl ? (
              <a href={downloadUrl} download>
                重新下载
              </a>
            ) : null}
          </p>
        ) : null}
      </Card>
      <Card
        title="恢复全局默认设置"
        icon={<RotateCcw size={15} strokeWidth={1.8} />}
        settingId="weq-config-management"
      >
        <p>{DEFAULTS_DESCRIPTION}</p>
        <div className="weq-backup-actions">
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            disabled={importBlocked}
            onClick={() => openConfirmation('defaults')}
            data-danger="solid"
          >
            <RotateCcw size={14} aria-hidden />
            恢复全局默认设置
          </button>
        </div>
      </Card>
      {pending ? (
        <Card
          title={pending.phase === 'ready' ? '存在待恢复数据' : '恢复暂存未完成'}
          icon={<ArchiveRestore size={15} strokeWidth={1.8} />}
        >
          <Summary value={pending.summary} />
          <p>正在运行的服务尚未使用这份备份，可直接应用恢复，无需重启。</p>
          <div className="weq-backup-actions">
            <button
              type="button"
              className="weq-set-btn"
              disabled={Boolean(busy)}
              onClick={() =>
                void act('正在取消', async () => {
                  await api.cancel();
                  await refresh();
                })
              }
            >
              <X size={14} />
              取消待恢复任务
            </button>
            {pending.phase === 'ready' ? (
              <button
                type="button"
                className="weq-set-btn weq-set-btn-primary"
                disabled={beforeLogin || Boolean(busy)}
                onClick={() => openConfirmation('apply')}
              >
                <RefreshCw size={14} />
                应用恢复
              </button>
            ) : null}
          </div>
        </Card>
      ) : null}
      {confirm && confirmation ? (
        <Modal
          centered
          dismissOnOutside={false}
          onClose={busy ? undefined : closeConfirmation}
          labelledBy="weq-backup-confirm-title"
          width={confirm === 'defaults' || confirm === 'export' || confirm === 'import' ? 520 : 400}
          className="weq-message-modal weq-defaults-modal"
        >
          <div className="weq-dialog" aria-busy={Boolean(busy)}>
            <div className="weq-dialog-head">
              <h3 id="weq-backup-confirm-title" className="weq-dialog-title">
                {confirmation.title}
              </h3>
            </div>
            <div className="weq-dialog-body">
              {confirm === 'export' && inventory && exportSelection ? (
                <BackupExportOptions
                  inventory={inventory}
                  selection={exportSelection}
                  onChange={setExportSelection}
                  disabled={Boolean(busy)}
                />
              ) : null}
              {confirm === 'import' && preview ? (
                <>
                  <p>
                    <strong>{preview.name}</strong>
                  </p>
                  <p>{summaryLabels(preview.summary).join('、')}</p>
                  {inventory
                    ? importScopes(preview.summary, inventory).map(({ id, targets }, index) => (
                        <label className="weq-set-row weq-defaults-row" key={id}>
                          <span className="weq-set-row-main">
                            备份来源 {privacy ? index + 1 : id}
                          </span>
                          <FormSelect
                            value={scopeMap[id] ?? ''}
                            aria-label={`恢复备份来源 ${index + 1} 到`}
                            disabled={Boolean(busy)}
                            onChange={(event) => {
                              const next = { ...scopeMap };
                              if (event.target.value) next[id] = event.target.value;
                              else delete next[id];
                              void act('正在检查恢复范围', async () => {
                                await refreshImport(next, activateServices);
                                setScopeMap(next);
                              });
                            }}
                          >
                            <option value="">沿用备份中的来源</option>
                            {targets.map((account, targetIndex) => (
                              <option key={account.configId} value={account.configId}>
                                {privacy ? `来源 ${targetIndex + 1}` : account.displayName}
                                {account.static ? ' · 静态备份' : ' · QQ 账号'}
                                {account.dataDir && !privacy ? ` · ${account.dataDir}` : ''}
                              </option>
                            ))}
                          </FormSelect>
                        </label>
                      ))
                    : null}
                  {preview.summary.sections?.includes('services') &&
                  inventory?.canActivateServices ? (
                    <>
                      <label className="weq-backup-account-choice">
                        <input
                          type="checkbox"
                          checked={activateServices}
                          disabled={Boolean(busy)}
                          onChange={(event) => setActivateServices(event.target.checked)}
                        />
                        恢复服务启用状态
                      </label>
                      {preview.services?.length ? (
                        <p>备份中已启用 {preview.services.join('、')}。</p>
                      ) : null}
                      {activateServices ? <p>恢复服务状态可能影响正在使用的连接。</p> : null}
                    </>
                  ) : null}
                  <p>
                    {preview.summary.sections
                      ? '将应用备份中所选的内容。'
                      : preview.summary.parts.some(({ part }) => part === 'settings')
                        ? '备份中的通用设置会应用，本机目录会保留。'
                        : '本机目录会保留。'}
                    {preview.skipped.length ? (
                      <NumericText>{`将跳过 ${preview.skipped.length} 项已有数据。`}</NumericText>
                    ) : null}
                  </p>
                </>
              ) : null}
              {confirm === 'defaults' && defaultsInfo ? (
                <>
                  <DefaultsOptions
                    info={defaultsInfo}
                    choice={defaultsChoice}
                    onChange={setDefaultsChoice}
                    disabled={Boolean(busy)}
                  />
                  <p>性能记录的保存时长和容量上限会保留。</p>
                  {defaultsInfo.logPrune ? (
                    <p>{describeLogPruneImpact(defaultsInfo.logPrune)}</p>
                  ) : null}
                </>
              ) : null}
              {confirmation.message ? <p>{confirmation.message}</p> : null}
              {confirm === 'import' && preview?.warnings.length ? (
                <details>
                  <BackupDisclosure>查看导入提示</BackupDisclosure>
                  <ul className="weq-backup-list">
                    {preview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {error ? (
                <p role="alert" className="weq-backup-error">
                  {error}
                </p>
              ) : null}
              {confirm === 'defaults' && !defaultsInfo && !busy && error ? (
                <button
                  type="button"
                  className="weq-action-soft"
                  onClick={() => void readDefaultsInfo()}
                >
                  重新读取恢复范围
                </button>
              ) : null}
            </div>
            {exportSecrets.length ? (
              <p className="weq-backup-secret" role="status">
                未加密的 ZIP 将包含 {exportSecrets.join('、')}。
              </p>
            ) : null}
            <div className="weq-dialog-foot">
              <button
                type="button"
                className="weq-action-soft"
                disabled={Boolean(busy)}
                ref={cancelButton}
                onClick={closeConfirmation}
              >
                取消
              </button>
              <button
                type="button"
                className="weq-action-primary"
                data-weq-dialog-confirm={
                  confirm === 'import' || (confirm === 'defaults' && defaultsInfo?.logPrune)
                    ? undefined
                    : true
                }
                ref={confirmButton}
                data-danger={
                  confirm === 'defaults' || confirm === 'apply' || confirm === 'import'
                    ? 'solid'
                    : undefined
                }
                disabled={
                  Boolean(busy) ||
                  (confirm === 'defaults' && !defaultsInfo) ||
                  (confirm === 'export' &&
                    (!exportSelection || !canExportBackup(exportSelection))) ||
                  (confirm === 'import' &&
                    (!preview ||
                      (!preview.planned.length && !activateServices) ||
                      Boolean(pending) ||
                      Boolean(result?.clientPending)))
                }
                onClick={() =>
                  void act(confirmation.progress, async () => {
                    if (confirm === 'export' && exportSelection) {
                      if (await exportBackup(exportSelection)) setConfirm(null);
                      return;
                    }
                    if (confirm === 'import' && preview) {
                      const checked = activateServices
                        ? await refreshImport(scopeMap, true)
                        : preview;
                      const restored = await api.stage(checked.id).catch(async (error: unknown) => {
                        await refresh().catch(() => {});
                        throw error;
                      });
                      sourceId.current = null;
                      setPreview(null);
                      setConfirm(null);
                      toast({
                        tone: restored.warnings.length ? 'warning' : 'success',
                        title: '备份已导入',
                        detail: restored.warnings.join('；') || undefined,
                      });
                    } else if (confirm === 'defaults') {
                      await settlePreferenceWrites();
                      const clientId = backupClientId(localStorage);
                      const prune = defaultsInfo?.logPrune?.confirmation;
                      const restored = await api
                        .defaults(clientId, defaultsChoice, ...(prune ? [prune] : []))
                        .catch(async (error: unknown) => {
                          defaultsFailed.current = true;
                          if (error instanceof TRPCClientError && error.data?.code === 'CONFLICT') {
                            setDefaultsInfo(null);
                            setDefaultsInfo(await api.defaultsInfo());
                          }
                          throw error;
                        });
                      defaultsFailed.current = false;
                      if (restored.warnings.length)
                        toast({
                          tone: 'warning',
                          title: '设置已恢复，部分操作未完成',
                          detail: restored.warnings.join('；'),
                        });
                    } else if (confirm === 'apply') await api.apply();
                    else if (result) {
                      const ok =
                        confirm === 'claim'
                          ? await api.claim(result.id, backupClientId(localStorage))
                          : await api.skip(result.id);
                      if (!ok) throw new Error('恢复回执已变化，请刷新状态');
                      if (confirm === 'claim') {
                        window.location.reload();
                        return;
                      }
                    }
                    await refresh();
                    setConfirm(null);
                  })
                }
              >
                {busy ? (
                  <span className="weq-number weq-number-inherit">{confirmation.progress}</span>
                ) : (
                  confirmation.action
                )}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
