/**
 * Static backup import panel — shown inside 「新的开始」 under the "本地备份" tab.
 *
 * Flow:
 *   1. User picks a directory (the standard OS folder dialog).
 *   2. 「测试打开」 probes profile_info_v6 with no key. If the db is plain
 *      SQLite we resolve the self row (UIN + nick + avatar) and show the
 *      confirmation card.
 *   3. If the probe reports `needKey`, a key field appears inline (the
 *      failure UX — no modal). User enters the SQLCipher key and re-tests.
 *   4. On success, 「进入」 opens the account via `openStaticAccount`. We do
 *      NOT persist auto-enter here — static accounts already save themselves
 *      into the accounts/ directory on the backend.
 */

import { useState, type ReactElement } from 'react';
import { ArrowRight, Database, FolderSearch, HelpCircle, KeyRound, Loader2 } from 'lucide-react';
import { client } from '../../trpc/client';
import { useDialog } from '../../components/Dialog';
import { QqAvatar } from '../../components/QqAvatar';
import { isCompleteKey } from './KeyField';
import qqLogoUrl from '@resources/img/QQ.png';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Probe =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ready'; preview: { uin: string; displayName: string; avatarUrl: string } }
  | { kind: 'needKey' }
  | { kind: 'badKey' }
  | { kind: 'badDb'; error: string };

type Stage = 'picking' | 'probing' | 'done';

export function StaticBackupPanel({ onEntered }: { onEntered: (uin: string) => void }): ReactElement {
  const showError = useDialog((s) => s.showError);

  const [dirPath, setDirPath] = useState<string>('');
  const [key, setKey] = useState<string>('');
  const [stage, setStage] = useState<Stage>('picking');
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' });

  async function pickDir(): Promise<void> {
    const picked = await client.bootstrap.pickStaticDbDir.mutate();
    if (!picked) return;
    setDirPath(picked);
    setKey('');
    setProbe({ kind: 'idle' });
    setStage('picking');
  }

  async function testOpen(): Promise<void> {
    if (!dirPath) return;
    setStage('probing');
    setProbe({ kind: 'probing' });
    try {
      const r = await client.bootstrap.testStaticDir.mutate({
        dirPath,
        ...(isCompleteKey(key) ? { dbKey: key } : {}),
      });
      if (!r.ok) {
        setProbe({ kind: 'badDb', error: r.error });
        setStage('picking');
        return;
      }
      if (r.needKey) {
        setProbe({ kind: 'needKey' });
        setStage('picking');
        return;
      }
      setProbe({ kind: 'ready', preview: r.preview });
      setStage('done');
    } catch (e) {
      setProbe({ kind: 'badDb', error: errMsg(e) });
      setStage('picking');
    }
  }

  async function enter(): Promise<void> {
    if (probe.kind !== 'ready') return;
    try {
      await client.bootstrap.openStaticAccount.mutate({
        dirPath,
        preview: probe.preview,
        ...(isCompleteKey(key) ? { dbKey: key } : {}),
      });
      onEntered(probe.preview.uin);
    } catch (e) {
      showError('打开失败', errMsg(e));
    }
  }

  return (
    <div className="weq-static-backup">
      <div className="weq-static-backup-head">
        {probe.kind === 'ready' ? (
          <>
            <span className="weq-static-backup-avatar-wrap">
              <QqAvatar
                uin={probe.preview.uin}
                url={probe.preview.avatarUrl || null}
                size={140}
                className="weq-acct-avatar"
              />
              <span className="weq-static-badge is-lg" title="静态离线账号" aria-label="静态离线账号">
                <Database size={13} strokeWidth={2.2} aria-hidden />
              </span>
            </span>
            <div className="weq-static-backup-title">
              {probe.preview.displayName || probe.preview.uin}
            </div>
          </>
        ) : (
          <>
            <img src={qqLogoUrl} alt="" width={140} height={140} className="weq-static-backup-logo" aria-hidden />
            <div className="weq-static-backup-title">导入本地数据库</div>
          </>
        )}
      </div>

      <div className="weq-static-help">
        <HelpCircle size={15} strokeWidth={1.8} aria-hidden />
        <span>
          导入非 QQ 本体的实际目录（来自手机备份，或其他工具解密的文件夹）。
          数据库需全部平铺在该目录中；无法查看和下载媒体。
        </span>
      </div>

      <label className="weq-static-row">
        <span className="weq-static-label">
          <FolderSearch size={15} strokeWidth={1.8} aria-hidden />
          数据库目录
        </span>
        <span className="weq-static-inputwrap">
          <input
            className="weq-static-input"
            value={dirPath}
            readOnly
            placeholder="请选择包含 nt_msg.db / profile_info.db 的目录"
          />
          <button type="button" className="weq-action-primary" onClick={() => void pickDir()}>
            浏览…
          </button>
        </span>
      </label>

      {(probe.kind === 'needKey' || probe.kind === 'badKey') && (
        <label className="weq-static-row">
          <span className="weq-static-label">
            <KeyRound size={15} strokeWidth={1.8} aria-hidden />
            数据库密钥
          </span>
          <span className="weq-static-inputwrap">
            <input
              className={`weq-static-input ${probe.kind === 'badKey' ? 'is-error' : ''}`}
              value={key}
              spellCheck={false}
              autoComplete="off"
              placeholder="16 位 SQLCipher 密钥（不输则按 SQLite 直接打开）"
              onChange={(e) => {
                setKey(e.target.value.trim());
                if (probe.kind === 'badKey') setProbe({ kind: 'needKey' });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void testOpen();
              }}
            />
            <button
              type="button"
              className="weq-action-primary"
              onClick={() => void testOpen()}
              disabled={!dirPath}
            >
              重新测试
            </button>
          </span>
          <span className="weq-static-hint">
            {probe.kind === 'badKey'
              ? '密钥不正确或数据库格式不符，请检查后重试。'
              : '检测到加密数据库，请输入 16 位密钥后重新测试。'}
          </span>
        </label>
      )}

      <div className="weq-static-actions">
        {probe.kind !== 'ready' ? (
          <button
            type="button"
            className="weq-action-primary"
            onClick={() => void testOpen()}
            disabled={!dirPath || stage === 'probing'}
          >
            {stage === 'probing' ? (
              <Loader2 className="animate-spin" size={15} strokeWidth={1.8} aria-hidden />
            ) : (
              <Database size={15} strokeWidth={1.8} aria-hidden />
            )}
            测试打开
          </button>
        ) : (
          <button type="button" className="weq-action-primary" onClick={() => void enter()}>
            <ArrowRight size={15} strokeWidth={1.85} aria-hidden />
            进入
          </button>
        )}
      </div>

      {probe.kind === 'badDb' && (
        <div className="weq-static-error">打开失败：{probe.error}</div>
      )}
    </div>
  );
}