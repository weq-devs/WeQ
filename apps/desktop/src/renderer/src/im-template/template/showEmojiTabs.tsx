/**
 * 表情面板的两个新分栏：**自定义表情** 与 **QQ 秀表情**。
 *
 * 两者共用一个流程 —— 选一张本机图片、读成字节、直接发出去。差别只有一处：
 * QQ 秀表情还要先选一个 action（目录里的表情包），发送时把那套互动包定义
 * （`pic.11.35/36`）一起带上，收端才会渲染成 QQ 秀表情而不是普通图片。
 *
 * 为什么「直接发」而不是插进输入框：协议层的 `image` 元素必须先上传拿到 msgInfo
 * 才能拼成 `commonElem`，插入输入框意味着要在点发送键的那一刻才上传，失败也没法
 * 回退。面板里点选即发，失败就地提示，链路最短。
 */

import { useCallback, useRef, useState } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { cn } from './classNames';
import { qqShowUrl } from '../../lib/resourceUrl';

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

/** 统一的错误文案：把主进程抛出来的中文提示原样展示，未知错误给兜底。 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '发送失败，请稍后重试。';
}

// ─────────────────────────── 自定义表情 ───────────────────────────

type RecentEntry = {
  md5: string;
  fileName: string;
  fileSize: number;
  width: number;
  height: number;
  picFormat: number;
  usedAt: number;
};

export function CustomEmojiTab({ ctx, onSent }: { ctx: SendContext; onSent: () => void }) {
  const utils = trpc.useUtils();
  const recent = trpc.account.emojiPanel.customEmojiRecent.useQuery(undefined, {
    staleTime: 10_000,
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendCustom = trpc.account.emojiPanel.sendCustomEmoji.useMutation();

  const submit = useCallback(
    async (file: File) => {
      setError(null);
      if (file.size > MAX_BYTES) {
        setError('图片超过 10 MB，请换一张。');
        return;
      }
      setSending(true);
      try {
        await sendCustom.mutateAsync({
          peerType: ctx.peerType,
          targetId: ctx.targetId,
          ...(ctx.tempGroupCode ? { tempGroupCode: ctx.tempGroupCode } : {}),
          source: await fileToBytes(file),
          fileName: file.name,
        });
        await utils.account.emojiPanel.customEmojiRecent.invalidate();
        onSent();
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setSending(false);
      }
    },
    [ctx, onSent, sendCustom, utils],
  );

  const picker = useImagePicker((file) => {
    if (ctx.disabled) {
      setError(ctx.disabledHint);
      return;
    }
    void submit(file);
  });

  const entries = (recent.data ?? []) as RecentEntry[];

  return (
    <div className={cn('show-emoji-tab')}>
      {picker.element}

      <button
        type="button"
        className={cn('show-emoji-upload')}
        onClick={picker.open}
        disabled={ctx.disabled || sending}
        title={ctx.disabled ? ctx.disabledHint : '选择一张图片或 GIF 作为表情发送'}
      >
        {sending ? (
          <Loader2 size={18} className={cn('show-emoji-spin')} />
        ) : (
          <ImagePlus size={18} />
        )}
        <span>{sending ? '发送中…' : '选择图片或 GIF'}</span>
      </button>
      <p className={cn('show-emoji-hint')}>支持 JPG / PNG / GIF / WebP，单张不超过 10 MB</p>

      {error ? <p className={cn('show-emoji-error')}>{error}</p> : null}

      {entries.length > 0 ? (
        <section className={cn('show-emoji-section')}>
          <h4>最近上传</h4>
          <div className={cn('show-emoji-recent-list')}>
            {entries.map((entry) => (
              <RecentCell key={entry.md5} entry={entry} onPick={() => picker.open()} />
            ))}
          </div>
          <p className={cn('show-emoji-hint')}>点选历史记录会重新打开文件选择器</p>
        </section>
      ) : null}
    </div>
  );
}

/**
 * 「最近上传」的一格。
 *
 * 索引只存元数据（md5 / 文件名 / 大小），不存字节 —— 原图可能几十 MB，复制进
 * 账号目录不划算。所以这里画的是**文件名 + 大小**的紧凑条目，点一下重新选文件；
 * 真正的重发走同一次「选图 → 上传」流程，确保发出去的一定是用户当下确认的那张。
 */
function RecentCell({ entry, onPick }: { entry: RecentEntry; onPick: () => void }) {
  const name = entry.fileName || entry.md5;
  return (
    <button
      type="button"
      className={cn('show-emoji-recent')}
      title={`${name}（点选重新选择图片）`}
      onClick={onPick}
    >
      <ImagePlus size={14} />
      <span className={cn('show-emoji-recent-name')}>{name}</span>
    </button>
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
  const [error, setError] = useState<string | null>(null);
  const sendShow = trpc.account.emojiPanel.sendShowEmoji.useMutation();

  const submit = useCallback(
    async (file: File, pack: ShowEmojiPack) => {
      setError(null);
      if (file.size > MAX_BYTES) {
        setError('图片超过 10 MB，请换一张。');
        return;
      }
      setSending(true);
      try {
        await sendShow.mutateAsync({
          peerType: ctx.peerType,
          targetId: ctx.targetId,
          source: await fileToBytes(file),
          packId: pack.id,
          // 接龙类的不同变体是不同关卡，默认用第一个。
          variant: 0,
          fileName: file.name,
        });
        await utils.account.emojiPanel.customEmojiRecent.invalidate();
        onSent();
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setSending(false);
        setPending(null);
        pendingRef.current = null;
      }
    },
    [ctx, onSent, sendShow, utils],
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

      {error ? <p className={cn('show-emoji-error')}>{error}</p> : null}

      {catalog.isLoading ? <div className={cn('emoji-state')}>加载中…</div> : null}
      {!catalog.isLoading && groups.length === 0 ? (
        <div className={cn('emoji-state')}>没有可用的 QQ 秀表情</div>
      ) : null}

      {groups.map((group) => (
        <section className={cn('show-emoji-section')} key={group.type}>
          <h4>
            {group.typeName}
            <span className={cn('show-emoji-count')}>{group.packs.length}</span>
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
                    setError(ctx.disabledHint);
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
