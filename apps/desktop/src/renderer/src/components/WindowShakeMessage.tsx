import { FaceEmoji } from './FaceEmoji';

/**
 * 私聊「窗口抖动」的本地乐观渲染。
 *
 * 收端 QQ 会把 `serviceType=2` 的窗口抖动丢弃，所以这条消息只有发送方在**发出去那一下**
 * 能看到。它不是灰条 —— 画成一枚会轻微抖动的「戳一戳」贴纸（`resources/pokeemoji`），
 * 与收到的真实戳一戳同款。样式见 index.css 的 `.weq-window-shake`。
 */
export function WindowShakeMessage() {
  return (
    <div className="weq-window-shake" role="img" aria-label="窗口抖动" title="窗口抖动">
      <FaceEmoji element={{ faceId: 0, subType: 5 }} size={72} />
    </div>
  );
}
