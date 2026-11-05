/**
 * 群通话「敬请期待」提示。
 *
 * 群聊里的通话按钮暂时只弹这个面板 —— 群通话的协议链路还在收尾（入房、订阅、
 * 媒体互通都通了，但挂断、成员状态同步、跨端编码器还没验证完），
 * 与其放一个半成品入口，不如先给个明确的预期。
 *
 * 视觉上跟设置页的锁定卡片一致：虚线描边 + 主题色淡底，深浅色都跟着 token 走。
 */

import type { ReactElement } from 'react';
import { PhoneCall, Sparkles, Video } from 'lucide-react';
import { Modal } from './Dialog';

export function GroupCallComingSoon({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  if (!open) return null;

  return (
    <Modal onClose={onClose} labelledBy="group-call-coming-soon" width={380}>
      <div className="weq-group-call-soon">
        <div className="weq-group-call-soon-icons" aria-hidden>
          <span className="weq-group-call-soon-icon">
            <PhoneCall size={20} strokeWidth={1.8} />
          </span>
          <span className="weq-group-call-soon-icon">
            <Video size={20} strokeWidth={1.8} />
          </span>
        </div>

        <h2 id="group-call-coming-soon" className="weq-group-call-soon-title">
          群通话
          <span className="weq-group-call-soon-badge">
            <Sparkles size={11} strokeWidth={2} aria-hidden />
            敬请期待
          </span>
        </h2>

        <p className="weq-group-call-soon-desc">
          多人语音与视频通话正在做最后的联调。
          <br />
          打开后可以直接在群里发起，支持中途邀请成员。
        </p>

        <button type="button" className="weq-group-call-soon-action" onClick={onClose}>
          知道了
        </button>
      </div>
    </Modal>
  );
}
