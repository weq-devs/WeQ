/** 本地备份的目录发现、账号预览与密钥确认。 */

import { useState, useRef, useEffect, useId, type FormEvent, type ReactElement } from 'react';
import { ArrowRight, FolderOpen, FolderSearch, KeyRound, Loader2 } from 'lucide-react';
import { client } from '../../trpc/client';
import { useDialog } from '../../components/Dialog.shared';
import { NumericText } from '../../components/NumericText';
import { QqAvatar } from '../../components/QqAvatar';
import { FolderScanStatus } from '../../components/FolderScanStatus';
import { KEY_LEN_HINT } from './KeyField.shared';
import type { BackupScanCandidate as Candidate } from '../../../../main/static_backup';
import '../../styles/static-backup-scan.css';

type Phase = 'input' | 'scanning' | 'recursive' | 'results';
type Action = 'browse' | 'verify' | 'enter';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StaticBackupPanel({
  heading,
  onEntered,
  onBusyChange,
  disabled = false,
}: {
  heading: ReactElement;
  onEntered: (uin: string) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const [phase, setPhase] = useState<Phase>('input');
  const [action, setAction] = useState<Action | null>(null);
  const [path, setPath] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [notice, setNotice] = useState('');
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState('');
  const scanId = useRef(0);
  const scanSub = useRef<{ unsubscribe(): void } | null>(null);
  const mounted = useRef(true);
  const inputId = useId();
  const busy = action !== null;
  const working = busy || disabled;
  const selected =
    candidates.find((candidate) => candidate.dirPath === selectedPath) ?? candidates[0];
  const probe = selected?.probe;

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scanId.current++;
      scanSub.current?.unsubscribe();
      scanSub.current = null;
    };
  }, []);

  function returnToInput(message = '') {
    setPath('');
    setPhase('input');
    setNotice(message);
  }

  function startScan(dirPath: string, recursive: boolean) {
    const id = ++scanId.current;
    scanSub.current?.unsubscribe();
    setPath(dirPath);
    setPhase('scanning');
    setCandidates([]);
    setSelectedPath('');
    setNotice('');
    setKey('');
    setKeyError('');

    let found = false;
    const onError = (error: unknown) => {
      if (id !== scanId.current) return;
      scanSub.current = null;
      setPhase(found ? 'results' : 'input');
      setNotice(`无法完成扫描：${errMsg(error)}`);
    };
    try {
      scanSub.current = client.bootstrap.scanStaticDirsProgress.subscribe(
        { dirPath, recursive },
        {
          onData(event) {
            if (id !== scanId.current) return;
            if (event.kind === 'candidate') {
              found = true;
              const candidate = event.candidate;
              setCandidates((items) =>
                items.some((item) => item.dirPath === candidate.dirPath)
                  ? items.map((item) => (item.dirPath === candidate.dirPath ? candidate : item))
                  : [...items, candidate],
              );
              return;
            }
            scanSub.current = null;
            const partial = event.truncated || event.unreadable > 0;
            if (found) {
              setPhase('results');
              if (partial) setNotice('部分文件夹未能扫描。可选择更具体的文件夹重试。');
            } else if (!recursive) {
              setPhase('recursive');
            } else {
              returnToInput(
                partial
                  ? '未找到 QQ 备份，部分文件夹未能扫描。请选择更具体的文件夹。'
                  : '未找到 QQ 备份，请输入其他路径或浏览文件夹。',
              );
            }
          },
          onError,
        },
      );
    } catch (error) {
      onError(error);
    }
  }

  async function browse(): Promise<void> {
    if (working) return;
    setAction('browse');
    try {
      const picked = await client.bootstrap.pickStaticDbDir.mutate();
      if (picked && mounted.current) startScan(picked, false);
    } catch (error) {
      if (mounted.current) showError('无法选择文件夹', errMsg(error));
    } finally {
      if (mounted.current) setAction(null);
    }
  }

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    const dirPath = path.trim();
    if (dirPath) startScan(dirPath, false);
    else void browse();
  }

  async function verifyKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected || !probe?.ok || !probe.needKey || !key || working) return;
    setAction('verify');
    setKeyError('');
    try {
      const result = await client.bootstrap.testStaticDir.mutate({
        dirPath: selected.dirPath,
        dbKey: key,
      });
      if (!mounted.current) return;
      if (!result.ok || result.needKey) {
        setKeyError(result.error || '该密钥无法打开备份。');
        return;
      }
      setCandidates((items) =>
        items.map((item) =>
          item.dirPath === selected.dirPath
            ? { ...item, probe: { ...result, derivedKey: result.derivedKey ?? key } }
            : item,
        ),
      );
    } catch (error) {
      if (mounted.current) setKeyError(errMsg(error));
    } finally {
      if (mounted.current) setAction(null);
    }
  }

  async function enter(): Promise<void> {
    if (!selected || !probe?.ok || probe.needKey || working) return;
    setAction('enter');
    try {
      await client.bootstrap.openStaticAccount.mutate({
        dirPath: selected.dirPath,
        preview: probe.preview,
        ...(probe.derivedKey ? { dbKey: probe.derivedKey } : {}),
        ...(probe.mobile ? { mobile: true } : {}),
      });
      if (mounted.current) onEntered(probe.preview.uin);
    } catch (error) {
      if (mounted.current) showError('打开失败', errMsg(error));
    } finally {
      if (mounted.current) setAction(null);
    }
  }

  return (
    <div className="weq-static-backup">
      <div className="weq-account-section-head">
        {heading}
        {phase !== 'input' && (
          <button
            type="button"
            className="weq-icon-button"
            aria-label="浏览其他文件夹"
            title="浏览其他文件夹"
            disabled={working}
            onClick={() => void browse()}
          >
            <FolderOpen size={15} aria-hidden />
          </button>
        )}
      </div>

      <div className="weq-static-backup-body">
        {phase === 'input' ? (
          <form className="weq-static-row" onSubmit={submitPath}>
            <label className="weq-static-label" htmlFor={inputId}>
              账号文件夹
            </label>
            <div className="weq-static-inputwrap">
              <input
                id={inputId}
                className="weq-static-input"
                value={path}
                onChange={(event) => {
                  setPath(event.target.value);
                  setNotice('');
                }}
                disabled={working}
                placeholder="输入文件夹路径"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="weq-action-primary" disabled={working}>
                {path.trim() ? (
                  <FolderSearch size={15} aria-hidden />
                ) : (
                  <FolderOpen size={15} aria-hidden />
                )}
                {path.trim() ? '扫描' : '浏览'}
              </button>
            </div>
          </form>
        ) : phase !== 'results' ? (
          <div className="weq-backup-root-path" title={path}>
            {path}
          </div>
        ) : null}
        {notice && (
          <p className="weq-static-hint" role="status">
            {notice}
          </p>
        )}
        {phase === 'scanning' && <FolderScanStatus count={candidates.length} unit="个账号目录" />}
        {phase === 'recursive' && (
          <>
            <p className="weq-static-hint" role="status">
              当前文件夹及下一级未找到 QQ 备份。要继续扫描所有子文件夹吗？
            </p>
            <div className="weq-static-actions">
              <button
                type="button"
                className="weq-action-soft"
                disabled={working}
                onClick={() => returnToInput()}
              >
                重新选择
              </button>
              <button
                type="button"
                className="weq-action-primary"
                disabled={working}
                onClick={() => startScan(path, true)}
              >
                <FolderSearch size={15} aria-hidden />
                扫描子文件夹
              </button>
            </div>
          </>
        )}

        {candidates.length > 0 && (
          <fieldset className="weq-backup-candidates" aria-label="备份账号目录" disabled={working}>
            {candidates.map((candidate) => (
              <BackupCandidateRow
                key={candidate.dirPath}
                candidate={candidate}
                group={inputId}
                checked={selected?.dirPath === candidate.dirPath}
                onSelect={() => {
                  setSelectedPath(candidate.dirPath);
                  setKey('');
                  setKeyError('');
                }}
              />
            ))}
          </fieldset>
        )}

        {probe?.ok &&
          (probe.needKey ? (
            <form className="weq-static-row" onSubmit={(event) => void verifyKey(event)}>
              <label className="weq-static-label" htmlFor={`${inputId}-key`}>
                数据库密钥
              </label>
              <div className="weq-static-inputwrap">
                <input
                  id={`${inputId}-key`}
                  className={keyError ? 'weq-static-input is-error' : 'weq-static-input'}
                  value={key}
                  disabled={working}
                  placeholder={`${KEY_LEN_HINT} 位密钥`}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    setKey(event.target.value.trim());
                    setKeyError('');
                  }}
                />
                <button type="submit" className="weq-action-primary" disabled={!key || working}>
                  {action === 'verify' ? (
                    <Loader2 className="weq-spin" size={15} aria-hidden />
                  ) : (
                    <KeyRound size={15} aria-hidden />
                  )}
                  {action === 'verify' ? '验证中…' : '验证密钥'}
                </button>
              </div>
              {keyError ? (
                <p className="weq-backup-candidate-error" role="alert">
                  {keyError}
                </p>
              ) : probe.error ? (
                <p className="weq-static-hint">{probe.error}</p>
              ) : null}
            </form>
          ) : (
            <div className="weq-static-actions">
              <button
                type="button"
                className="weq-action-primary"
                disabled={working}
                onClick={() => void enter()}
              >
                {action === 'enter' ? (
                  <Loader2 className="weq-spin" size={15} aria-hidden />
                ) : (
                  <ArrowRight size={15} aria-hidden />
                )}
                {action === 'enter' ? '正在打开…' : '进入'}
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

function BackupCandidateRow({
  candidate,
  group,
  checked,
  onSelect,
}: {
  candidate: Candidate;
  group: string;
  checked: boolean;
  onSelect: () => void;
}): ReactElement {
  const { dirPath, probe, databaseCount, databaseBytes, sizePending, sizeError, mediaDir } =
    candidate;
  const preview = probe?.ok && !probe.needKey ? probe.preview : null;
  const name = !probe ? '正在识别账号' : probe.ok ? '加密备份' : '无法读取备份';
  return (
    <label className="weq-backup-candidate" data-selected={checked}>
      <input type="radio" name={group} checked={checked} onChange={onSelect} />
      {preview && <QqAvatar uin={preview.uin} size={32} url={preview.avatarUrl || null} />}
      <span className="weq-backup-candidate-info">
        <strong>
          {preview ? (
            <NumericText>{`${preview.displayName || preview.uin} · ${preview.uin}`}</NumericText>
          ) : (
            name
          )}
        </strong>
        <span className="weq-backup-path">{dirPath}</span>
        <span>
          {databaseCount === null ? (
            '正在读取数据库数量'
          ) : (
            <NumericText>{`${databaseCount} 个数据库`}</NumericText>
          )}
          {' · '}
          {databaseBytes === null ? (
            sizePending ? (
              '大小统计中'
            ) : (
              '大小未能读取'
            )
          ) : (
            <NumericText>
              {`${(sizePending ? '已统计 ' : '') + (databaseBytes / 1024 / 1024).toFixed(1)} MB`}
            </NumericText>
          )}
          {' · '}
          {mediaDir ? '含本地媒体' : '未找到媒体目录'}
        </span>
        {sizeError && <span className="weq-backup-candidate-error">{sizeError}</span>}
        {probe && !probe.ok && <span className="weq-backup-candidate-error">{probe.error}</span>}
      </span>
    </label>
  );
}
