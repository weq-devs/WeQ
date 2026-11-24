import { useEffect, useState } from 'react';
import { Modal } from './Dialog';
import { useDialog } from './Dialog.shared';
import {
  cacheMiB,
  clearRemoteDataCache,
  refreshRemoteDataCacheStatus,
  setRemoteDataCacheLimit,
  stopRemoteDataCacheWrites,
  syncRemoteDataCacheLimit,
  type RemoteDataCacheStatus,
} from '../lib/remoteDataCache';
import { clearLegacyNativeCache } from '../lib/remoteCacheBridge';
import { clearLegacyBusinessCache } from '../lib/webBusinessCacheStore';
import { clearLegacyAvatarCache } from '../lib/webAvatarCache';
import { useRemoteClient } from '../lib/remoteClient';

declare global {
  interface Window {
    weqOpenLocalCache?: () => void;
    weqLocalCacheChanged?: (cleared: boolean) => void;
  }
}

async function clearLegacyCachesAndReload() {
  stopRemoteDataCacheWrites();
  await Promise.allSettled([
    clearLegacyBusinessCache(),
    clearLegacyAvatarCache(),
    clearLegacyNativeCache(),
  ]);
  location.reload();
}

export function RemoteDataCacheDialog() {
  const remote = useRemoteClient();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!remote) return;
    window.weqOpenLocalCache = () => setOpen(true);
    window.weqLocalCacheChanged = (cleared) => {
      if (cleared) void clearLegacyCachesAndReload();
      else void syncRemoteDataCacheLimit().catch(() => undefined);
    };
    return () => {
      delete window.weqOpenLocalCache;
      delete window.weqLocalCacheChanged;
    };
  }, [remote]);
  return open ? <CacheDialog onClose={() => setOpen(false)} /> : null;
}

function CacheDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<RemoteDataCacheStatus>();
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void refreshRemoteDataCacheStatus()
      .then((value) => {
        if (!active) return;
        if (!value) {
          setNotice('更新 WeQ Remote 安装包后即可管理本机缓存。');
          return;
        }
        setStatus(value);
        setLimit(String(value.limit / cacheMiB));
      })
      .catch(() => {
        if (active) setNotice('暂时无法读取本机缓存，请重试。');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const changed = Boolean(status && Number(limit) * cacheMiB !== status.limit);
  const validLimit =
    Number.isInteger(Number(limit)) && Number(limit) >= 16 && Number(limit) <= 4096;
  async function saveLimit() {
    setBusy(true);
    try {
      setStatus(await setRemoteDataCacheLimit(Number(limit) * cacheMiB));
      setNotice('缓存上限已保存。');
    } catch {
      setNotice('保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    const confirmed = await useDialog
      .getState()
      .confirm(
        '清除业务缓存',
        '清除这台手机为当前电脑保存的聊天、图片和其他业务缓存。重新连接后会按需补回。',
        { danger: 'solid', okLabel: '清除' },
      );
    if (!confirmed) return;
    setBusy(true);
    try {
      await clearRemoteDataCache();
      await clearLegacyCachesAndReload();
    } catch {
      setNotice('清除失败，请重试。');
      setBusy(false);
    }
  }

  return (
    <Modal title="本机缓存" width={420} onClose={onClose}>
      <div className="weq-dialog-body">
        {status ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (changed && validLimit && !busy) void saveLimit();
            }}
          >
            <p>当前电脑的业务缓存已用 {(status.bytes / cacheMiB).toFixed(1)} MiB。</p>
            <label>
              缓存上限（MiB）
              <input
                className="weq-set-input"
                type="number"
                min={16}
                max={4096}
                step={1}
                value={limit}
                disabled={busy}
                onChange={(event) => setLimit(event.target.value)}
              />
            </label>
            <p>超出上限时优先清理最久未使用的数据。网页代码由版本更新单独管理。</p>
            <div className="weq-dialog-actions">
              <button
                type="button"
                className="weq-set-btn"
                data-danger="solid"
                disabled={busy}
                onClick={() => void clear()}
              >
                清除业务缓存
              </button>
              <button
                type="submit"
                className="weq-set-btn weq-set-btn-primary"
                disabled={busy || !changed || !validLimit}
              >
                保存上限
              </button>
            </div>
          </form>
        ) : busy ? (
          <p>正在读取本机缓存…</p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </div>
    </Modal>
  );
}
