import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArchiveRestore,
  Download,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import type { WeqBackupPart, WeqBackupSummary, WeqRestoreChoice } from '@weq/service';
import { snapshotWeqClientSettings } from '@weq/service/backup-client';
import { client } from '../../trpc/client';
import { backupClientId } from '../../lib/backupClientRestore';
import { useToast } from '../Toast';
import { SectionHeader } from './controls';
import '../../styles/backup.css';

const PARTS: WeqBackupPart[] = ['settings', 'accounts', 'api', 'clones'];
const LABELS: Record<WeqBackupPart, string> = {
  settings: '通用与界面设置',
  accounts: '账号配置与偏好',
  api: 'API 配置与凭据',
  clones: '克隆体与助手数据',
};
export const backupApi = {
  inventory: () => client.bootstrap.backupInventory.query(),
  export: (input: Parameters<typeof client.bootstrap.backupExport.mutate>[0]) =>
    client.bootstrap.backupExport.mutate(input),
  pick: () => client.bootstrap.backupPick.mutate(),
  begin: (name: string, bytes: number) =>
    client.bootstrap.backupBeginUpload.mutate({ name, bytes }),
  chunk: (id: string, offset: number, data: string) =>
    client.bootstrap.backupUploadChunk.mutate({ id, offset, data }),
  finish: (id: string) => client.bootstrap.backupFinishUpload.mutate({ id }),
  prepare: (sourceId: string, choice: WeqRestoreChoice) =>
    client.bootstrap.backupPrepare.mutate({ sourceId, ...choice }),
  stage: (previewId: string) => client.bootstrap.backupStage.mutate({ previewId }),
  defaults: (clientId: string) => client.bootstrap.backupDefaults.mutate({ clientId }),
  dispose: (id: string) => client.bootstrap.backupDiscardPreview.mutate({ id }),
  cancel: () => client.bootstrap.backupCancel.mutate(),
  restart: () => client.bootstrap.backupRestart.mutate(),
  reveal: (id: string) => client.bootstrap.backupRevealExport.mutate({ id }),
  claim: (id: string, clientId: string) =>
    client.bootstrap.backupClaimClient.mutate({ id, clientId }),
  skip: (id: string) => client.bootstrap.backupSkipClient.mutate({ id }),
};
type BackupApi = typeof backupApi;
type Inventory = Awaited<ReturnType<BackupApi['inventory']>>;
type Source = NonNullable<Awaited<ReturnType<BackupApi['pick']>>>;
type Preview = Awaited<ReturnType<BackupApi['prepare']>>;
type Exported = NonNullable<Awaited<ReturnType<BackupApi['export']>>>;
function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="weq-backup-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}
function Summary({ value }: { value: WeqBackupSummary }) {
  return (
    <>
      <div className="weq-backup-summary">
        <span>
          {new Date(value.createdAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          })}
          （北京时间）
        </span>
        {value.parts.map((part) => (
          <span key={part.part}>
            {LABELS[part.part]} · {part.files} 个文件 · {(part.bytes / 1024).toFixed(1)} KiB
          </span>
        ))}
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
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [parts, setParts] = useState<WeqBackupPart[]>(['settings']);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [clones, setClones] = useState<string[]>([]);
  const [includeClient, setIncludeClient] = useState(true);
  const [source, setSource] = useState<Source | null>(null);
  const [choice, setChoice] = useState<WeqRestoreChoice>({
    parts: [],
    conflict: 'skip',
    keepLocalPaths: true,
    includeClient: true,
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [exported, setExported] = useState<Exported | null>(null);
  const [confirm, setConfirm] = useState<'defaults' | 'restart' | 'claim' | 'skip' | null>(null);
  const [busy, setBusy] = useState<string | null>('正在读取');
  const [error, setError] = useState<string | null>(null);
  const sourceId = useRef<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast((s) => s.push);
  const refresh = useCallback(
    async (initial = false) => {
      const result = await api.inventory();
      if (!alive.current) return;
      setInventory(result);
      if (initial) {
        setAccounts(result.accounts.map((a) => a.configId));
        setClones(result.cloneScopes);
      }
    },
    [api],
  );
  useEffect(() => {
    alive.current = true;
    void refresh(true)
      .catch((e: unknown) => {
        if (alive.current) setError(String(e));
      })
      .finally(() => {
        if (alive.current) setBusy(null);
      });
    return () => {
      alive.current = false;
      generation.current++;
      if (sourceId.current) void api.dispose(sourceId.current).catch(() => {});
    };
  }, [api, refresh]);
  async function act(label: string, run: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (alive.current) setError(message);
      toast({ tone: 'error', title: '备份与恢复操作失败', detail: message });
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  function change(patch: Partial<WeqRestoreChoice>) {
    setChoice((previous) => ({ ...previous, ...patch }));
    setPreview(null);
  }
  async function accept(pick: () => Promise<Source | null>) {
    const seq = ++generation.current;
    setPreview(null);
    let result: Source | null;
    try {
      result = await pick();
    } catch (error) {
      if (sourceId.current) await api.dispose(sourceId.current).catch(() => {});
      sourceId.current = null;
      if (alive.current && seq === generation.current) setSource(null);
      throw error;
    }
    if (!result) return;
    if (!alive.current || seq !== generation.current) {
      await api.dispose(result.id);
      return;
    }
    const previous = sourceId.current;
    sourceId.current = result.id;
    if (previous) await api.dispose(previous);
    setSource(result);
    setPreview(null);
    setChoice({
      parts: result.summary.parts.map((p) => p.part),
      accountConfigIds: result.summary.accountConfigIds,
      cloneConfigIds: result.summary.cloneConfigIds,
      conflict: 'skip',
      keepLocalPaths: true,
      includeClient: true,
    });
  }
  async function upload(file: File) {
    if (!inventory || file.size < 1 || file.size > inventory.maxArchiveBytes)
      throw new Error('请选择不超过 260 MiB 的非空 WeQ 备份');
    await accept(async () => {
      const id = await api.begin(file.name, file.size);
      sourceId.current = id;
      try {
        for (let offset = 0; offset < file.size; offset += inventory.chunkBytes) {
          if (!alive.current) throw new Error('备份上传已取消');
          const bytes = new Uint8Array(
            await file.slice(offset, offset + inventory.chunkBytes).arrayBuffer(),
          );
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          await api.chunk(id, offset, btoa(binary));
          if (alive.current)
            setBusy(
              `正在上传 ${Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100))}%`,
            );
        }
        return await api.finish(id);
      } catch (e) {
        await api.dispose(id).catch(() => {});
        if (sourceId.current === id) sourceId.current = null;
        throw e;
      }
    });
  }
  const pending = inventory?.restore.pending;
  const result = inventory?.restore.result;
  const importValid =
    source &&
    choice.parts.length > 0 &&
    (!choice.parts.includes('accounts') || Boolean(choice.accountConfigIds?.length)) &&
    (!choice.parts.includes('clones') || Boolean(choice.cloneConfigIds?.length));
  const exportValid =
    parts.length > 0 &&
    (!parts.includes('accounts') || accounts.length > 0) &&
    (!parts.includes('clones') || clones.length > 0);
  const targets = [
    ...new Set([
      ...(source?.summary.accountConfigIds ?? []),
      ...(source?.summary.cloneConfigIds ?? []),
    ]),
  ];
  return (
    <div className="weq-set weq-backup" aria-busy={Boolean(busy)}>
      <SectionHeader icon={<ArchiveRestore size={17} />} title="备份与恢复" />
      <p className="weq-set-note">
        备份不加密，可能包含 API 密钥、账号数据库密钥、克隆对话和记忆。请妥善保管；不包含 QQ
        原始数据库、漫游缓存或本机应用锁密钥。
      </p>
      {error ? (
        <p className="weq-backup-error" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="weq-set-note">
          {busy}
        </p>
      ) : null}
      <div className="weq-backup-actions">
        <button
          type="button"
          className="weq-set-btn"
          disabled={Boolean(busy)}
          onClick={() => void act('正在读取', () => refresh())}
        >
          <RefreshCw size={14} />
          刷新状态
        </button>
      </div>
      {result ? (
        <section className="weq-backup-band">
          <h4>{result.status === 'applied' ? '最近一次恢复已应用' : '最近一次恢复失败'}</h4>
          <p>
            {result.error ||
              `已应用 ${result.applied.length} 项，跳过 ${result.skipped.length} 项。`}
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
                  disabled={Boolean(busy)}
                  onClick={() => setConfirm('claim')}
                >
                  改在此设备恢复
                </button>
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={Boolean(busy)}
                  onClick={() => setConfirm('skip')}
                >
                  保留本机界面偏好
                </button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      <section className="weq-backup-band">
        <h4>导出备份</h4>
        <fieldset disabled={Boolean(busy) || !inventory}>
          <legend>备份范围</legend>
          <div className="weq-backup-choices">
            {PARTS.map((part) => (
              <Check
                key={part}
                label={LABELS[part]}
                checked={parts.includes(part)}
                onChange={() => setParts(toggle(parts, part))}
              />
            ))}
          </div>
          {parts.includes('settings') ? (
            <Check
              label="包含此设备的界面偏好"
              checked={includeClient}
              onChange={setIncludeClient}
            />
          ) : null}
          {parts.includes('accounts') ? (
            <fieldset>
              <legend>账号</legend>
              <div className="weq-backup-scopes">
                {inventory?.accounts.length ? (
                  inventory.accounts.map((a) => (
                    <Check
                      key={a.configId}
                      label={`${a.displayName} · ${a.configId}`}
                      checked={accounts.includes(a.configId)}
                      onChange={() => setAccounts(toggle(accounts, a.configId))}
                    />
                  ))
                ) : (
                  <p>暂无账号配置</p>
                )}
              </div>
            </fieldset>
          ) : null}
          {parts.includes('clones') ? (
            <fieldset>
              <legend>克隆数据域</legend>
              <div className="weq-backup-scopes">
                {inventory?.cloneScopes.length ? (
                  inventory.cloneScopes.map((id) => (
                    <Check
                      key={id}
                      label={id}
                      checked={clones.includes(id)}
                      onChange={() => setClones(toggle(clones, id))}
                    />
                  ))
                ) : (
                  <p>暂无克隆数据</p>
                )}
              </div>
            </fieldset>
          ) : null}
        </fieldset>
        <div className="weq-backup-actions">
          <button
            type="button"
            className="weq-set-btn"
            disabled={Boolean(busy) || !inventory || !exportValid}
            onClick={() =>
              void act('正在导出', async () => {
                const out = await api.export({
                  parts,
                  accountConfigIds: accounts,
                  cloneConfigIds: clones,
                  includeClient,
                  client:
                    parts.includes('settings') && includeClient
                      ? snapshotWeqClientSettings(localStorage)
                      : {},
                });
                if (out) {
                  if (alive.current) setExported(out);
                  toast({ tone: 'success', title: 'WeQ 备份已导出' });
                }
              })
            }
          >
            <Download size={14} />
            导出备份
          </button>
          {exported?.downloadUrl ? (
            <a className="weq-set-btn" href={exported.downloadUrl} download>
              下载备份文件
            </a>
          ) : null}
          {exported?.canReveal ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={Boolean(busy)}
              onClick={() =>
                void act('正在定位', async () => {
                  await api.reveal(exported.id);
                })
              }
            >
              <FolderOpen size={14} />
              显示备份文件
            </button>
          ) : null}
        </div>
        {exported ? (
          <>
            <p>已保存：{exported.path}</p>
            <Summary value={exported.summary} />
          </>
        ) : null}
      </section>
      <section className="weq-backup-band">
        <h4>导入备份</h4>
        <div className="weq-backup-actions">
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void act('正在读取备份', () => upload(file));
            }}
          />
          <button
            type="button"
            className="weq-set-btn"
            disabled={
              Boolean(busy) || !inventory || Boolean(pending) || Boolean(result?.clientPending)
            }
            onClick={() =>
              inventory?.canPickFile
                ? void act('正在读取备份', () => accept(api.pick))
                : input.current?.click()
            }
          >
            <Upload size={14} />
            选择备份文件
          </button>
        </div>
        {source ? (
          <>
            <p>{source.name}</p>
            <Summary value={source.summary} />
            <fieldset disabled={Boolean(busy) || Boolean(pending)}>
              <legend>恢复范围</legend>
              <div className="weq-backup-choices">
                {source.summary.parts.map(({ part }) => (
                  <Check
                    key={part}
                    label={LABELS[part]}
                    checked={choice.parts.includes(part)}
                    onChange={() => change({ parts: toggle(choice.parts, part) })}
                  />
                ))}
              </div>
              {choice.parts.includes('settings') ? (
                <Check
                  label="恢复界面偏好到此设备"
                  checked={choice.includeClient !== false}
                  onChange={(next) => change({ includeClient: next })}
                />
              ) : null}
              {choice.parts.includes('accounts') ? (
                <fieldset>
                  <legend>账号配置</legend>
                  <div className="weq-backup-scopes">
                    {source.summary.accountConfigIds.map((id) => (
                      <Check
                        key={id}
                        label={id}
                        checked={choice.accountConfigIds?.includes(id) ?? true}
                        onChange={() =>
                          change({
                            accountConfigIds: toggle(
                              choice.accountConfigIds ?? source.summary.accountConfigIds,
                              id,
                            ),
                          })
                        }
                      />
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {choice.parts.includes('clones') ? (
                <fieldset>
                  <legend>克隆数据域</legend>
                  <div className="weq-backup-scopes">
                    {source.summary.cloneConfigIds.map((id) => (
                      <Check
                        key={id}
                        label={id}
                        checked={choice.cloneConfigIds?.includes(id) ?? true}
                        onChange={() =>
                          change({
                            cloneConfigIds: toggle(
                              choice.cloneConfigIds ?? source.summary.cloneConfigIds,
                              id,
                            ),
                          })
                        }
                      />
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {targets
                .filter(
                  (id) =>
                    (choice.parts.includes('accounts') && choice.accountConfigIds?.includes(id)) ||
                    (choice.parts.includes('clones') && choice.cloneConfigIds?.includes(id)),
                )
                .map((id) => (
                  <div key={id} className="weq-backup-map">
                    <label htmlFor={`backup-scope-${id}`}>数据域 {id}</label>
                    <select
                      id={`backup-scope-${id}`}
                      value={choice.scopeMap?.[id] ?? id}
                      onChange={(e) =>
                        change({ scopeMap: { ...choice.scopeMap, [id]: e.target.value } })
                      }
                    >
                      <option value={id}>原数据域 {id}</option>
                      {inventory?.accounts
                        .filter((a) => a.configId !== id && a.uin === id.split('_')[0])
                        .map((a) => (
                          <option key={a.configId} value={a.configId}>
                            {a.displayName} · {a.configId}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
              <legend>同名数据处理</legend>
              <select
                aria-label="同名数据处理"
                value={choice.conflict}
                onChange={(e) =>
                  change({ conflict: e.target.value === 'skip' ? 'skip' : 'overwrite' })
                }
              >
                <option value="skip">跳过已有账号、克隆和 API 项</option>
                <option value="overwrite">覆盖所选数据域</option>
              </select>
              <p>
                通用设置总会应用。覆盖不合并克隆对话；显式映射到另一份本机账号配置时，保留该账号的接入信息与运行凭据。
              </p>
              <Check
                label="保留本机导出目录与图片库路径"
                checked={choice.keepLocalPaths !== false}
                onChange={(next) => change({ keepLocalPaths: next })}
              />
            </fieldset>
            <div className="weq-backup-actions">
              <button
                type="button"
                className="weq-set-btn"
                disabled={Boolean(busy) || Boolean(pending) || !importValid}
                onClick={() =>
                  void act('正在校验恢复范围', async () => {
                    const seq = generation.current;
                    const value = await api.prepare(source.id, {
                      ...choice,
                      ...(choice.parts.includes('settings') && choice.includeClient !== false
                        ? { clientId: backupClientId(localStorage) }
                        : {}),
                    });
                    if (alive.current && seq === generation.current) setPreview(value);
                  })
                }
              >
                <ArchiveRestore size={14} />
                预览恢复
              </button>
            </div>
          </>
        ) : null}
        {preview ? (
          <div className="weq-backup-review">
            <h4>确认恢复范围</h4>
            <Summary value={preview.summary} />
            <p>
              将应用 {preview.planned.length} 项，跳过 {preview.skipped.length}{' '}
              项。暂存后重启应用，不立即修改正在运行的服务。
            </p>
            <ul className="weq-backup-list">
              {[
                ...preview.planned.map((text) => `应用：${text}`),
                ...preview.skipped.map((text) => `跳过：${text}`),
                ...preview.warnings,
              ].map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <div className="weq-backup-actions">
              <button
                type="button"
                className="weq-set-btn"
                disabled={Boolean(busy)}
                onClick={() => setPreview(null)}
              >
                返回修改
              </button>
              <button
                type="button"
                className="weq-set-btn"
                disabled={Boolean(busy) || Boolean(pending)}
                onClick={() =>
                  void act('正在暂存恢复', async () => {
                    await api.stage(preview.id);
                    sourceId.current = null;
                    setSource(null);
                    setPreview(null);
                    await refresh();
                    toast({ tone: 'success', title: '恢复已暂存，重启后应用' });
                  })
                }
              >
                确认并暂存
              </button>
            </div>
          </div>
        ) : null}
      </section>
      <section className="weq-backup-band">
        <h4>恢复默认设置</h4>
        <p>仅重置通用设置、导出预设与此设备界面偏好；不会删除账号、API 配置或克隆数据。</p>
        <button
          type="button"
          className="weq-set-btn"
          disabled={
            Boolean(busy) || !inventory || Boolean(pending) || Boolean(result?.clientPending)
          }
          onClick={() => setConfirm('defaults')}
        >
          <RotateCcw size={14} />
          恢复默认设置
        </button>
      </section>
      {pending ? (
        <section className="weq-backup-band">
          <h4>{pending.phase === 'ready' ? '已暂存，等待重启' : '恢复暂存未完成'}</h4>
          <Summary value={pending.summary} />
          <p>
            正在运行的服务尚未使用这份备份。
            {inventory?.canRestart
              ? '重启 WeQ 后应用。'
              : '请由服务管理器重启 WeQ 服务后应用，刷新网页不会应用。'}
          </p>
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
            {inventory?.canRestart ? (
              <button
                type="button"
                className="weq-set-btn"
                disabled={Boolean(busy)}
                onClick={() => setConfirm('restart')}
              >
                <RefreshCw size={14} />
                重启 WeQ
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      {confirm ? (
        <div className="weq-backup-review" role="region" aria-label="确认操作">
          <h4>
            确认
            {confirm === 'defaults'
              ? '恢复默认设置'
              : confirm === 'restart'
                ? '重启 WeQ'
                : confirm === 'claim'
                  ? '在此设备恢复界面偏好'
                  : '放弃界面偏好恢复'}
          </h4>
          <p>
            {confirm === 'defaults'
              ? '重启后恢复通用设置、导出预设和此设备的界面偏好。API、账号配置、克隆体和本机应用锁密钥会保留。'
              : confirm === 'restart'
                ? '请先保存正在编辑的内容。重启会关闭当前账号与在途任务，随后应用已暂存的数据。'
                : confirm === 'claim'
                  ? '将覆盖当前设备的界面偏好并重新加载，原发起设备不会再应用这份界面偏好。'
                  : '已恢复的 WeQ 数据不会撤销；所有设备均不再应用本次备份的界面偏好。'}
          </p>
          <div className="weq-backup-actions">
            <button
              type="button"
              className="weq-set-btn"
              disabled={Boolean(busy)}
              onClick={() => setConfirm(null)}
            >
              返回
            </button>
            <button
              type="button"
              className="weq-set-btn"
              disabled={Boolean(busy)}
              onClick={() =>
                void act('正在处理', async () => {
                  if (confirm === 'defaults') {
                    await api.defaults(backupClientId(localStorage));
                    sourceId.current = null;
                    setSource(null);
                    setPreview(null);
                  } else if (confirm === 'restart') await api.restart();
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
                  setConfirm(null);
                  await refresh();
                })
              }
            >
              确认
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
