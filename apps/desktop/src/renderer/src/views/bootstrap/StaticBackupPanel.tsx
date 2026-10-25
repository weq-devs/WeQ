/** 本地备份的目录发现、账号预览与密钥确认；选择账号后才真正打开会话。 */

import { useState, useRef, useEffect, useId, type ReactElement } from 'react';
import { ArrowRight, Database, FolderSearch, KeyRound, Loader2, Smartphone, X } from 'lucide-react';
import { client } from '../../trpc/client';
import { Modal, useDialog } from '../../components/Dialog';
import { QqAvatar } from '../../components/QqAvatar';
import { KEY_LEN_HINT } from './KeyField';
import qqLogoUrl from '@resources/img/QQ.png';
import '../../styles/static-backup-scan.css';

type ScanResult = Awaited<ReturnType<typeof client.bootstrap.scanStaticDirs.mutate>>;
type Candidate = ScanResult['candidates'][number];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Probe =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | {
      kind: 'ready';
      preview: { uin: string; uid: string; displayName: string; avatarUrl: string };
      /** 密钥由后端自动获取或复用，不是用户手输。 */
      derived: boolean;
      /** 安卓手机备份目录（自动推导出密钥）。 */
      mobile: boolean;
      keySource?: string;
    }
  | { kind: 'needKey'; error?: string }
  | { kind: 'badKey'; error: string }
  | { kind: 'badDb'; error: string };

type Stage = 'picking' | 'probing' | 'entering' | 'done';

export function StaticBackupPanel({
  onEntered,
}: {
  onEntered: (uin: string) => void;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);

  const [dirPath, setDirPath] = useState<string>('');
  const [key, setKey] = useState<string>('');
  const [stage, setStage] = useState<Stage>('picking');
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' });
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [notice, setNotice] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftPath, setDraftPath] = useState('');
  const pickerTitleId = useId();
  const busy = stage === 'probing' || stage === 'entering';
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function selectCandidate(candidate: Candidate) {
    setDirPath(candidate.dirPath);
    setKey('');
    const r = candidate.probe;
    if (!r.ok) {
      setProbe({ kind: 'badDb', error: r.error });
      setStage('picking');
    } else if (r.needKey) {
      setProbe({ kind: 'needKey', error: r.error });
      setStage('picking');
    } else {
      setKey(r.derivedKey ?? '');
      setProbe({
        kind: 'ready',
        preview: r.preview,
        derived: !!r.derivedKey && r.keySource !== 'manual',
        mobile: r.mobile,
        keySource: r.keySource,
      });
      setStage('done');
    }
  }

  function openPicker() {
    setDraftPath(dirPath || candidates[0]?.dirPath || '');
    setPickerOpen(true);
  }

  function confirmDirectory() {
    const candidate = candidates.find((item) => item.dirPath === draftPath);
    if (!candidate || busy) return;
    selectCandidate(candidate);
    setPickerOpen(false);
  }

  async function pickDir(): Promise<void> {
    setStage('probing');
    try {
      const picked = await client.bootstrap.pickStaticDbDir.mutate();
      if (!picked || !mounted.current) return;
      setDirPath('');
      setKey('');
      setCandidates([]);
      setPickerOpen(false);
      setDraftPath('');
      setNotice('');
      setProbe({ kind: 'probing' });
      let result = await client.bootstrap.scanStaticDirs.mutate({ dirPath: picked });
      if (!mounted.current) return;
      if (!result.candidates.length) {
        const recursive = await confirm(
          '递归扫描账号目录？',
          '当前文件夹及下一级未找到 QQ 数据库，是否扫描所有子文件夹？大目录可能需要较长时间。',
          { okLabel: '递归扫描', cancelLabel: '取消' },
        );
        if (!mounted.current) return;
        if (!recursive) {
          setProbe({ kind: 'idle' });
          return;
        }
        result = await client.bootstrap.scanStaticDirs.mutate({ dirPath: picked, recursive: true });
      }
      if (!mounted.current) return;
      setCandidates(result.candidates);
      if (result.truncated || result.unreadable)
        setNotice('部分目录未扫描，请选择更具体的文件夹。');
      if (result.candidates.length === 1) selectCandidate(result.candidates[0]!);
      else {
        setProbe(
          result.candidates.length
            ? { kind: 'idle' }
            : { kind: 'badDb', error: '没有找到 QQ 数据库目录。' },
        );
        if (result.candidates.length) {
          setDraftPath(result.candidates[0]!.dirPath);
          setPickerOpen(true);
        }
      }
    } catch (e) {
      if (mounted.current) setProbe({ kind: 'badDb', error: errMsg(e) });
    } finally {
      if (mounted.current) setStage((s) => (s === 'probing' ? 'picking' : s));
    }
  }

  async function testOpen(): Promise<void> {
    if (!dirPath) return;
    setStage('probing');
    setProbe({ kind: 'probing' });
    try {
      // 只要填了东西就原样送后端 —— 长度不合规也要让后端去判对错，
      // 静默丢弃会让用户以为「输了密钥但没反应」。
      const r = await client.bootstrap.testStaticDir.mutate({
        dirPath,
        ...(key ? { dbKey: key } : {}),
      });
      if (!r.ok) {
        // 带着密钥仍打不开 —— 归为密钥错，保留输入框让用户改，并把后端的
        // 真实原因一起显示出来（否则用户连"是不是没点到按钮"都分不清）。
        setProbe(key ? { kind: 'badKey', error: r.error } : { kind: 'badDb', error: r.error });
        setStage('picking');
        return;
      }
      if (r.needKey) {
        setProbe({ kind: 'needKey', error: r.error });
        setStage('picking');
        return;
      }
      // 后端取得的密钥留给真正打开会话时使用。
      if ('derivedKey' in r && r.derivedKey) setKey(r.derivedKey);
      setProbe({
        kind: 'ready',
        preview: r.preview,
        derived: !!r.derivedKey && r.keySource !== 'manual',
        mobile: 'mobile' in r && !!r.mobile,
        keySource: r.keySource,
      });
      setCandidates((items) =>
        items.map((item) => (item.dirPath === dirPath ? { ...item, probe: r } : item)),
      );
      setStage('done');
    } catch (e) {
      // 网络/IPC 层异常：填了密钥就留在密钥态，否则当作目录问题。
      setProbe(key ? { kind: 'badKey', error: errMsg(e) } : { kind: 'badDb', error: errMsg(e) });
      setStage('picking');
    }
  }

  async function enter(): Promise<void> {
    if (probe.kind !== 'ready' || busy) return;
    setStage('entering');
    try {
      await client.bootstrap.openStaticAccount.mutate({
        dirPath,
        preview: probe.preview,
        ...(key ? { dbKey: key } : {}),
        ...(probe.mobile ? { mobile: true } : {}),
      });
      onEntered(probe.preview.uin);
    } catch (e) {
      showError('打开失败', errMsg(e));
      setStage('done');
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
              <span
                className="weq-static-badge is-lg"
                title={probe.mobile ? 'Android 手机备份账号' : '静态离线账号'}
                aria-label={probe.mobile ? 'Android 手机备份账号' : '静态离线账号'}
              >
                {probe.mobile ? (
                  <Smartphone size={13} strokeWidth={2.2} aria-hidden />
                ) : (
                  <Database size={13} strokeWidth={2.2} aria-hidden />
                )}
              </span>
            </span>
            <div className="weq-static-backup-title">
              {probe.preview.displayName || probe.preview.uin}
            </div>
          </>
        ) : (
          <>
            <img
              src={qqLogoUrl}
              alt=""
              width={140}
              height={140}
              className="weq-static-backup-logo"
              aria-hidden
            />
            <div className="weq-static-backup-title">导入本地数据库</div>
          </>
        )}
      </div>

      <label className="weq-static-row">
        <span className="weq-static-label">
          <FolderSearch size={15} strokeWidth={1.8} aria-hidden />
          账号文件夹
        </span>
        <span className="weq-static-inputwrap">
          <input
            className="weq-static-input"
            value={dirPath}
            readOnly
            placeholder="Tencent Files、账号目录或数据库目录"
          />
          <button
            type="button"
            className="weq-action-primary"
            disabled={busy}
            onClick={() => void pickDir()}
          >
            浏览…
          </button>
        </span>
      </label>

      {stage === 'probing' && (
        <div role="status" className="weq-static-hint">
          正在扫描与验证…
        </div>
      )}
      {candidates.length > 0 && (
        <button
          type="button"
          className="weq-action-soft weq-backup-picker-trigger"
          disabled={busy}
          onClick={openPicker}
        >
          <FolderSearch size={15} aria-hidden />
          {dirPath ? '切换' : '选择'}账号目录（{candidates.length}）
        </button>
      )}
      {pickerOpen && (
        <Modal
          onClose={() => setPickerOpen(false)}
          centered
          dismissOnOutside={false}
          labelledBy={pickerTitleId}
          className="weq-backup-picker"
          layerClassName="weq-backup-picker-layer"
        >
          <div className="weq-dialog-head weq-backup-picker-head">
            <FolderSearch size={18} aria-hidden />
            <h3 className="weq-dialog-title" id={pickerTitleId}>
              账号目录（{candidates.length}）
            </h3>
            <button
              type="button"
              className="weq-dialog-x"
              aria-label="关闭账号目录"
              title="关闭"
              onClick={() => setPickerOpen(false)}
            >
              <X size={18} aria-hidden />
            </button>
          </div>
          <div className="weq-backup-picker-list">
            <fieldset className="weq-backup-candidates" disabled={busy} aria-label="备份账号目录">
              {candidates.map((candidate) => {
                const preview =
                  candidate.probe.ok && !candidate.probe.needKey ? candidate.probe.preview : null;
                return (
                  <label
                    key={candidate.dirPath}
                    className="weq-backup-candidate"
                    data-selected={draftPath === candidate.dirPath}
                  >
                    <input
                      type="radio"
                      name={pickerTitleId}
                      checked={draftPath === candidate.dirPath}
                      onChange={() => setDraftPath(candidate.dirPath)}
                    />
                    {preview && (
                      <QqAvatar uin={preview.uin} size={36} url={preview.avatarUrl || null} />
                    )}
                    <span className="weq-backup-candidate-info">
                      <strong>
                        {preview
                          ? `${preview.displayName || preview.uin} · ${preview.uin}`
                          : '加密账号（待验证）'}
                      </strong>
                      <span className="weq-backup-path">{candidate.dirPath}</span>
                      <span>
                        {candidate.databaseCount} 个数据库 ·{' '}
                        {(candidate.databaseBytes / 1024 / 1024).toFixed(1)} MB ·{' '}
                        {candidate.mediaDir ? '含本地媒体' : '未找到媒体目录'}
                      </span>
                      {!candidate.probe.ok && (
                        <span className="weq-backup-candidate-error">{candidate.probe.error}</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {notice && <div className="weq-backup-picker-notice">{notice}</div>}
          </div>
          <div className="weq-dialog-foot weq-backup-picker-foot">
            <button type="button" className="weq-action-soft" onClick={() => setPickerOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="weq-action-primary"
              disabled={busy || !draftPath}
              onClick={confirmDirectory}
            >
              <ArrowRight size={15} aria-hidden />
              使用此目录
            </button>
          </div>
        </Modal>
      )}
      {notice && <div className="weq-static-hint">{notice}</div>}

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
              placeholder={`${KEY_LEN_HINT} 位 SQLCipher 密钥（不输则按 SQLite 直接打开）`}
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
              disabled={!dirPath || stage === 'probing'}
            >
              {stage === 'probing' ? (
                <Loader2 className="animate-spin" size={15} strokeWidth={1.8} aria-hidden />
              ) : (
                <KeyRound size={15} strokeWidth={1.8} aria-hidden />
              )}
              {stage === 'probing' ? '验证中…' : '验证密钥'}
            </button>
          </span>
          <span className={probe.kind === 'badKey' ? 'weq-static-error' : 'weq-static-hint'}>
            {probe.kind === 'badKey'
              ? `密钥验证失败：${probe.error}`
              : probe.error
                ? `自动获取密钥未成功：${probe.error}。可输入密钥后重新测试。`
                : `检测到加密数据库，请输入 ${KEY_LEN_HINT} 位密钥后重新测试。`}
          </span>
        </label>
      )}

      <div className="weq-static-actions">
        {probe.kind === 'ready' ? (
          <button
            type="button"
            className="weq-action-primary"
            disabled={busy}
            onClick={() => void enter()}
          >
            <ArrowRight size={15} strokeWidth={1.85} aria-hidden />
            进入
          </button>
        ) : probe.kind === 'needKey' || probe.kind === 'badKey' ? null : (
          // 密钥态下验证按钮已经和输入框同行了，这里不再重复一个。
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
            {stage === 'probing' ? '验证中…' : '测试打开'}
          </button>
        )}
      </div>

      {probe.kind === 'ready' && probe.derived && (
        <div className="weq-static-hint">
          {probe.keySource === 'other-device'
            ? '已通过同账号配置自动获取并验证其他设备密钥。'
            : '已自动获取并验证数据库密钥。'}
        </div>
      )}

      {probe.kind === 'badDb' && <div className="weq-static-error">打开失败：{probe.error}</div>}
    </div>
  );
}
