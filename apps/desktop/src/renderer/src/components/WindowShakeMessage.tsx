import { FaceEmoji } from './FaceEmoji';

/**
 * 私聊「窗口抖动」的本地乐观渲染。
 *
 * 收端 QQ 会把 `serviceType=2` 的窗口抖动丢弃，所以这条消息只有发送方在**发出去那一下**
 * 能看到。它不是灰条 —— 而是**自己发出的一条消息**，画面就是那枚会轻轻抖动的
 * 「戳一戳」超级表情（`resources/pokeemoji`），与收到的真实戳一戳同款，落在自己那一侧。
 *
 * 由 `QqMessageContent` 在 `sticker-only` 容器里渲染（不带气泡底板，与超级表情一致）。
 * 样式见 index.css 的 `.weq-window-shake`。
 */
export function WindowShakeMessage() {
  return (
    <div className="weq-window-shake" role="img" aria-label="窗口抖动" title="窗口抖动">
      <FaceEmoji element={{ faceId: 0, subType: 5 }} size={72} />
    </div>
  );
}
