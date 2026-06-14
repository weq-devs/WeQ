/**
 * QR-login dialog. Shows the scannable code in place of the avatar slot with
 * the account identity beneath and a live status line.
 */

import { type ReactElement } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { QqAvatar } from '../../components/QqAvatar';
import { QrImage } from '../../components/QrImage';

export function QrDialog({
  uin,
  name,
  avatarUrl,
  status,
  qrUrl,
  onClose,
}: {
  uin: string;
  name: string;
  avatarUrl: string | null;
  status: string;
  qrUrl: string | null;
  onClose: () => void;
}): ReactElement {
  return (
    <Modal onClose={onClose} labelledBy="weq-qr-title" width="min(23.5rem, calc(100vw - 3rem))">
      <div className="weq-qr-dialog">
        <header className="weq-qr-dialog-head">
          <div>
            <p className="text-[13px] font-medium text-[#0099ff]">扫码登录</p>
            <h3 id="weq-qr-title" className="weq-display mt-1 text-[21px] font-normal leading-tight text-[#0f2d4c]">
              QQ 安全验证
            </h3>
          </div>
        </header>
        <div className="weq-qr-dialog-body">
          <div className="weq-qr-frame">
            {qrUrl ? (
              <QrImage url={qrUrl} size={154} />
            ) : (
              <Loader2 className="animate-spin text-[#0099ff]" size={28} strokeWidth={1.7} aria-label="正在获取二维码" />
            )}
          </div>
          <div className="weq-qr-profile">
            <QqAvatar uin={uin} url={avatarUrl} size={44} />
            <div className="weq-qr-profile-main">
              <div className="weq-qr-profile-top">
                <div className="weq-qr-name">{name}</div>
                <div className="weq-qr-status">{status}</div>
              </div>
              <div className="weq-qr-identity">
                <span className="weq-number">{uin}</span>
                <span>手机 QQ 扫码确认</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
