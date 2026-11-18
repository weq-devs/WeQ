/**
 * 表情面板的两个新分栏：**自定义表情** 与 **QQ 秀表情**。
 *
 * 自定义表情把本机图片交给输入框；QQ 秀先选动作，再选图直接发送，
 * 图片同时携带对应的互动包定义（`pic.11.35/36`）。
 */

import { useCallback, useRef, useState } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { cn } from './classNames';
import { qqShowUrl } from '../../lib/resourceUrl';
import { useToast } from '../../components/Toast.shared';

/** 单张图片上限 10 MB —— 与 IPC 侧的限制保持一致。 */
const MAX_BYTES = 10 * 1024 * 1024;

/** 允许的图片格式（协议层按 magic 探测，这里只做前置拦截）。 */
const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/bmp';

interface SendContext {
  peerType: 'c2c' | 'group';
  targetId: string;
  tempGroupCode?: string;
  disabled: boolean;
  disabledHint: string;
}

/** 把 File 读成 Uint8Array（走 ArrayBuffer，避免 base64 往返）。 */
async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** 文件选择器：同一个 input 复用，选完清空 value 以便重选同一个文件。 */
function useImagePicker(onPick: (file: File) => void) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // `onPick` 每次渲染都是新函数，但 input 的 onChange 只在选完文件时执行一次，
  // 用 ref 保证它拿到的永远是最新的回调，而不是挂载时闭包里的旧值。
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const open = useCallback(() => inputRef.current?.click(), []);
  const element = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      className={cn('emoji-file-input')}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // 清空，否则连续选同一个文件不会再触发 change。
        event.currentTarget.value = '';
        if (file) pickRef.current(file);
      }}
    />
  );
  return { open, element };
}

/** 统一文案：把主进程抛出来的中文提示原样展示，未知错误给兜底。 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '发送失败，请稍后重试。';
}

/**
 * 统一的错误出口：失败一律走右下角 toast。
 *
 * 面板窄、层级又压在输入框上方，就地插一行红字既挤又容易被忽略；发送是「点一下
 * 就结束了」的一次性操作，结果该跟其它发送路径一样落在 toast 上。
 */
function useSendFailureToast(): (error: unknown) => void {
  const pushToast = useToast((state) => state.push);
  return useCallback(
    (error: unknown) => {
      pushToast({ tone: 'error', title: '表情发送失败', detail: errorText(error) });
    },
    [pushToast],
  );
}

// ─────────────────────────── 自定义表情 ───────────────────────────

export function CustomEmojiTab({
  disabled,
  disabledHint,
  onInsert,
}: {
  disabled: boolean;
  disabledHint?: string;
  onInsert?: (file: File) => void;
}) {
  const [error, setError] = useState('');
  const picker = useImagePicker((file) => {
    if (disabled) return;
    if (!file.size || file.size > MAX_BYTES) {
      setError(file.size ? '图片超过 10 MB，请换一张。' : '图片文件为空，请换一张。');
    } else {
      setError('');
      onInsert?.(file);
    }
  });

  return (
    <div className="show-emoji-tab show-emoji-custom">
      <header className="emoji-section-head">
        <h3>自定义表情</h3>
      </header>
      {picker.element}
      <button
        type="button"
        className={cn('show-emoji-upload')}
        onClick={picker.open}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
      >
        <ImagePlus size={24} />
        <span>选择图片或 GIF</span>
        <span className="show-emoji-hint">将图片以表情形式放入输入框</span>
      </button>
      {error ? (
        <p role="alert" className="show-emoji-hint">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────── QQ 秀表情 ───────────────────────────

type ShowEmojiPack = {
  id: string;
  seq: number;
  name: string;
  type: number;
  typeName: string;
  iconUrl: string;
  actionPackId: string;
  actionName: string;
  elementIds: string[];
  variants: unknown[];
};

type ShowEmojiGroup = { type: number; typeName: string; packs: ShowEmojiPack[] };

export function ShowEmojiTab({ ctx, onSent }: { ctx: SendContext; onSent: () => void }) {
  const utils = trpc.useUtils();
  const catalog = trpc.account.emojiPanel.showEmojiCatalog.useQuery(undefined, {
    staleTime: Infinity,
  });
  const [pending, setPending] = useState<ShowEmojiPack | null>(null);
  // `pending` 的镜像：`picker.open()` 之后文件选择器会异步回调，那时闭包里拿到的
  // 还是上一轮的 state（setPending 尚未生效），所以用 ref 读到最新值。
  const pendingRef = useRef<ShowEmojiPack | null>(null);
  const [sending, setSending] = useState(false);
  const sendShow = trpc.account.emojiPanel.sendShowEmoji.useMutation();
  const toastFailure = useSendFailureToast();

  const submit = useCallback(
    async (file: File, pack: ShowEmojiPack) => {
      if (file.size > MAX_BYTES) {
        toastFailure(new Error('图片超过 10 MB，请换一张。'));
        return;
      }
      setSending(true);
      try {
        await sendShow.mutateAsync({
          peerType: ctx.peerType,
          targetId: ctx.targetId,
          ...(ctx.tempGroupCode ? { tempGroupCode: ctx.tempGroupCode } : {}),
          source: await fileToBytes(file),
          packId: pack.id,
          // 接龙类的不同变体是不同关卡，默认用第一个。
          variant: 0,
          fileName: file.name,
        });
        await utils.account.emojiPanel.customEmojiRecent.invalidate();
        onSent();
      } catch (cause) {
        toastFailure(cause);
      } finally {
        setSending(false);
        setPending(null);
        pendingRef.current = null;
      }
    },
    [ctx, onSent, sendShow, toastFailure, utils],
  );

  const picker = useImagePicker((file) => {
    const pack = pendingRef.current;
    if (!pack) return;
    void submit(file, pack);
  });

  const groups = (catalog.data ?? []) as ShowEmojiGroup[];

  return (
    <div className={cn('show-emoji-tab')}>
      {picker.element}

      <p className={cn('show-emoji-hint')}>
        先选一个动作，再选择图片；图片会与这个动作的效果一起发出
      </p>

      {catalog.isLoading ? <div className={cn('emoji-state')}>加载中…</div> : null}
      {!catalog.isLoading && groups.length === 0 ? (
        <div className={cn('emoji-state')}>没有可用的 QQ 秀表情</div>
      ) : null}

      {groups.map((group) => (
        <section className={cn('show-emoji-section')} key={group.type}>
          <h4>
            {group.typeName}
            <span className={cn('show-emoji-count')}>
              <span className="weq-number weq-number-inherit">{group.packs.length}</span>
            </span>
          </h4>
          <div className={cn('show-emoji-grid')}>
            {group.packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                className={cn('show-emoji-action', pending?.id === pack.id ? 'active' : '')}
                title={`${pack.name}（${pack.actionName}）`}
                disabled={ctx.disabled || sending}
                onClick={() => {
                  if (ctx.disabled) {
                    toastFailure(new Error(ctx.disabledHint));
                    return;
                  }
                  setPending(pack);
                  pendingRef.current = pack;
                  picker.open();
                }}
              >
                <img
                  src={qqShowUrl(pack.iconUrl)}
                  alt={pack.name}
                  draggable={false}
                  referrerPolicy="no-referrer"
                />
                <span className={cn('show-emoji-action-name')}>{pack.name}</span>
                {sending && pending?.id === pack.id ? (
                  <span className={cn('show-emoji-action-busy')}>
                    <Loader2 size={16} className={cn('show-emoji-spin')} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
