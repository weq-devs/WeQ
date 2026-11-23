// @ts-nocheck
/**
 * 输入框「闪传」—— 把一组本地文件当**一条 QQ 闪传（fileset）消息**发出去。
 *
 * 与「发送文件」不是一回事：文件是普通消息的元素，闪传是一条 fileset 卡片（收端点开
 * 在闪传浏览弹窗里看文件清单，14 天有效、主文件后台传完）。所以这里也不走输入框的
 * 元素 token 通路 —— 与 Ark 面板同款：面板收齐文件 + 封面，交给应用层去发。
 *
 * 交互：
 *   1. 点工具栏「QQ闪传」直接打开多选文件框；输入区也可追加文件，或拖入文件和文件夹。
 *   2. 选好点「确认」→ 弹一张灯箱卡片：封面预览 + 文件清单，封面可以自己换（≤ 1MB，
 *      PNG / JPEG 原图直通，不重绘不压缩）；
 *   3. 点「发送」→ 应用层走 fileset 协议（封面先就绪、主文件后台传）。
 *
 * 面板本身像语音条一样**内联进输入框**（占掉正文编辑区那一行，见
 * styles/flash-composer.css 的 `@media (min-width: 761px)` 段），不再是从输入框
 * 上沿弹出来的卡片；小屏装不下时仍是浮层。灯箱 `createPortal` 到 `document.body`：
 * `.composer` 上有 `backdrop-filter`，会把 `position: fixed` 的包含块拽成输入框那一格，
 * 挂在里面的话灯箱就永远贴在底部。
 *
 * 封面有两种来源：**默认封面**由渲染层用 canvas 拼（主进程没有 canvas）—— 拿
 * `resources/fileicon` 里的类型图标拼一张 480×270 的 PNG，`weq-asset://` 的图标先
 * fetch 成 blob 再画（blob 是同源，canvas 不会被污染），拿不到就退回「色块 + 扩展名」；
 * **用户自定义封面**原样直通 —— 只校验大小（≤ 1MB）与格式（PNG / JPEG），不做任何
 * 绘制 / 压缩 / 转码，字节原封不动交给主进程落盘上传。
 *
 * 面板自己不碰 trpc / 协议；样式见 styles/flash-composer.css，颜色全走主题 token。
 */

import { ToolbarLabel } from '../../components/CompactToolbar';
import { observeCompactToolbar } from '../../components/CompactToolbar.shared';
import { NumericText } from '../../components/NumericText';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTabActive } from '../../components/RetainedTabs.shared';
import type { RefObject } from 'react';
import {
  ArrowLeft,
  ImagePlus,
  Loader2,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { useOverlayLayer } from '../../lib/overlayStack';
import { cn } from './classNames';
import { dataTransferHasFiles } from './composerMedia';
import { fileExtIcon } from '../../lib/groupFile';
import { fileIconUrl } from '../../lib/resourceUrl';
import { IS_WEB } from '../../lib/target.shared';
import { stageAccountFile } from '../../lib/accountFilePicker';
import { formatBytes } from '../../lib/format';
import { type FlashDraftFile, flashDescOf, composeFlashCover } from './flashComposer.shared';

/** 交给应用层的闪传载荷。 */
export interface FlashSendPayload {
  files: FlashDraftFile[];
  /** fileset 标题（卡片名）；空串 = 让服务层按文件名 / 数量拼。 */
  name: string;
  /**
   * 封面（`data:image/png;base64,…` 或 `data:image/jpeg;base64,…`）；空串 = 不带封面。
   * 默认封面是渲染层 canvas 拼的 PNG；用户自定义封面是原图**直通**（不重绘 / 不压缩）。
   */
  coverDataUrl: string;
}

/**
 * 用户自定义封面的「直通」格式闸：只认 PNG / JPEG（按字节 magic 探测，不看扩展名 /
 * MIME —— 有些相机导出的图后缀或 MIME 都不准）。这两个格式对应缩略图的两种 appid，
 * 其它格式（WebP / GIF / BMP…）没有对应槽位，直通不了，只能拒绝。
 */
async function sniffCoverType(file: File): Promise<'png' | 'jpeg' | null> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

// ── 文件收集（拖拽 / 选择）─────────────────────────────────────────────────────

/**
 * 把一个 File 变成草稿文件。
 *
 * 路径走 `window.weq.pathForFile`（Electron `webUtils`）：闪传要主进程按**路径**读文件
 * （大文件不落内存），剪贴板之类没有落盘来源的东西拿不到路径 —— 那种直接跳过。
 */
async function toDraft(file: File): Promise<FlashDraftFile | null> {
  const path = window.weq?.pathForFile?.(file) ?? '';
  if (!path) {
    if (!IS_WEB) return null;
    const staged = await stageAccountFile(file);
    return { path: staged.path, name: staged.fileName, size: staged.size };
  }
  return { path, name: file.name || path.split(/[\\/]/).pop() || path, size: file.size ?? 0 };
}

/** 递归展开拖进来的目录（`webkitGetAsEntry`）。 */
async function collectEntries(items: DataTransferItemList | null): Promise<File[]> {
  if (!items) return [];
  const roots: FileSystemEntry[] = [];
  for (let index = 0; index < items.length; index++) {
    const entry = items[index]?.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const directoryEntries = roots.filter(
    (entry): entry is FileSystemDirectoryEntry => entry.isDirectory,
  );
  // 没有目录就没有异步展开，直接同步拿 files（同步上下文里才能读 items）。
  if (directoryEntries.length === 0) {
    const files: File[] = [];
    for (let index = 0; index < items.length; index++) {
      const file = items[index]?.getAsFile?.();
      if (file) files.push(file);
    }
    return files;
  }

  const out: File[] = [];
  const readAll = async (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
    const batch: FileSystemEntry[] = [];
    // readEntries 一次最多回 100 条，要读到空为止。
    for (;;) {
      const chunk = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (chunk.length === 0) return batch;
      batch.push(...chunk);
    }
  };
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
      for (const child of children) await walk(child);
    }
  };
  for (const entry of roots) await walk(entry);
  return out;
}

// ── 组件 ────────────────────────────────────────────────────────────────────

export function FlashComposer({
  panelRef,
  filesInputRef,
  canSend,
  sendHint,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  filesInputRef: RefObject<HTMLInputElement | null>;
  canSend: boolean;
  sendHint: string;
  /** 交回应用层发送（走 fileset 协议）；**抛出即失败**，面板保留已选文件。 */
  onSend: (payload: FlashSendPayload) => Promise<void>;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FlashDraftFile[]>([]);
  const [name, setName] = useState('');
  const [cover, setCover] = useState<string | null>(null);
  const [coverTouched, setCoverTouched] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tabActive = useTabActive();
  const lightboxLayer = useOverlayLayer(tabActive && lightbox);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (!tabActive || !files.length) return;
    const target = lightbox
      ? sendButtonRef.current?.disabled
        ? titleInputRef.current
        : sendButtonRef.current
      : confirmButtonRef.current;
    target?.focus({ preventScroll: true });
  }, [files, lightbox, tabActive]);

  const desc = useMemo(() => flashDescOf(files), [files]);
  const title =
    name.trim() ||
    (files.length === 1 ? files[0]?.name : `${files[0]?.name ?? ''}等${files.length}个文件`);

  /** 文件列表变了就重拼默认封面（用户手动换过就不动它）。 */
  useEffect(() => {
    if (coverTouched) return;
    if (files.length === 0) {
      setCover(null);
      return;
    }
    let cancelled = false;
    setCoverBusy(true);
    void composeFlashCover(files).then((dataUrl) => {
      if (cancelled) return;
      setCover(dataUrl);
      setCoverBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [files, coverTouched]);

  /**
   * 灯箱挂在 `document.body` 上（不在本组件 DOM 子树里），所以 Esc 得自己听：
   * 开着就只把灯箱收起来，退回文件框，草稿一点不丢。chatPane 那一层看到
   * `.flash-lightbox` 会主动让路（见那边的 closeFlashOnEscape）。
   */
  useLayoutEffect(() => {
    if (!tabActive || !lightbox) return;
    function onEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setLightbox(false);
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [lightbox, tabActive]);

  /** 追加一批文件（拖拽 / 选择共用）；按路径去重。 */
  const addFiles = useCallback((incoming: FlashDraftFile[]) => {
    if (incoming.length === 0) return;
    setFiles((current) => {
      const seen = new Set(current.map((file) => file.path));
      const next = [...current];
      for (const file of incoming) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        next.push(file);
      }
      return next;
    });
    setError(null);
  }, []);

  const addFromFiles = useCallback(
    async (picked: File[] | FileList | null) => {
      if (!picked) return;
      try {
        const draft: FlashDraftFile[] = [];
        let skipped = 0;
        for (const file of Array.from(picked)) {
          const item = await toDraft(file);
          if (item) draft.push(item);
          else skipped += 1;
        }
        addFiles(draft);
        if (skipped > 0) {
          setError(`${skipped} 个文件拿不到本机路径（剪切板 / 虚拟位置不支持闪传），已跳过。`);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [addFiles],
  );

  /**
   * 换封面：用户选的图**直通** —— 只校验大小（≤ 1MB）与格式（PNG / JPEG），字节原样
   * 交给主进程落盘上传，不做任何 canvas 重绘 / 压缩 / 转码。封面必须在 0x93d7 发消息
   * 之前就绪，重绘既费时又改变画质，直通才是用户贴什么就发什么。
   */
  async function handlePickCover(file: File): Promise<void> {
    if (file.size > 1024 * 1024) {
      setError('封面图不能超过 1 MB。');
      return;
    }
    // 直通只收 PNG / JPEG：主进程按 magic 探测格式（其余格式没有对应缩略图 appid）。
    const type = await sniffCoverType(file);
    if (type === null) {
      setError('封面只支持 PNG / JPEG 图片。');
      return;
    }
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) {
      setError('读不出这张图片。');
      return;
    }
    setCover(dataUrl);
    setCoverTouched(true);
    setError(null);
  }

  async function restoreCover(): Promise<void> {
    setCoverTouched(false);
    setCoverBusy(true);
    const composed = await composeFlashCover(files);
    setCoverBusy(false);
    setCover(composed);
  }

  /**
   * 拖拽落点铺满**整个输入区**（文件框 + 外面那一圈空白 + 工具栏）：文件框内联进
   * 输入框以后它就是这一格唯一认文件的东西，而事件可能落在 `.composer` 自己身上。
   * 在捕获阶段就截下来，既轮不到 chatPane 把文件铺成「只能单独发」的卡片，
   * 也不会让浏览器直接打开拖进来的文件。
   */
  useEffect(() => {
    const host = rootRef.current?.closest('.composer');
    if (!host) return;

    const inHost = (event: globalThis.DragEvent): boolean => {
      const target = event.target;
      return target instanceof Node && host.contains(target);
    };

    function over(event: globalThis.DragEvent): void {
      if (!dataTransferHasFiles(event.dataTransfer) || !inHost(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    }
    function drop(event: globalThis.DragEvent): void {
      if (!dataTransferHasFiles(event.dataTransfer) || !inHost(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      // 文件 / 文件夹都走 items（目录要靠 webkitGetAsEntry 递归展开）。
      const items = event.dataTransfer?.items ?? null;
      void collectEntries(items).then(addFromFiles);
    }

    function leave(event: globalThis.DragEvent): void {
      // 在输入区内部挪动时 relatedTarget 还在里面（dragover / dragleave 会成对地
      // 在子元素上来回刷），不算离开。
      const next = event.relatedTarget as Node | null;
      if (next && host.contains(next)) return;
      setDragging(false);
    }

    function done(): void {
      setDragging(false);
    }

    host.addEventListener('dragover', over, true);
    host.addEventListener('drop', drop, true);
    host.addEventListener('dragleave', leave, true);
    window.addEventListener('dragend', done);
    window.addEventListener('blur', done);
    return () => {
      host.removeEventListener('dragover', over, true);
      host.removeEventListener('drop', drop, true);
      host.removeEventListener('dragleave', leave, true);
      window.removeEventListener('dragend', done);
      window.removeEventListener('blur', done);
    };
  }, [addFromFiles]);

  async function submit(): Promise<void> {
    if (files.length === 0 || !canSend || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend({
        files,
        name: name.trim(),
        coverDataUrl: cover ?? '',
      });
      onClose();
    } catch (err) {
      // 失败不吞已选内容：错误显示在灯箱里，用户改一改就能重发。
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  return (
    <div
      className={cn('flash-composer', dragging && 'is-dragging')}
      ref={(node) => {
        rootRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.repeat) event.preventDefault();
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (lightbox) setLightbox(false);
          else onClose();
        }
      }}
    >
      {/*
        整块输入框就是落点：没有图标、没有说明、没有一排小按钮。空的时候它占满整格、
        中间只有一句「点击打开文件选择」；已经有文件时就留一行，点它还能源源不断地加。
      */}
      <div className={cn('flash-composer-body')}>
        {files.length > 0 ? (
          <ul className={cn('flash-file-list')}>
            {files.map((file) => (
              <li key={file.path}>
                <img src={fileIconUrl(fileExtIcon(file.name))} alt="" loading="lazy" />
                <span className={cn('flash-file-name')} title={file.path}>
                  {file.name}
                </span>
                <em>
                  <span className="weq-number weq-number-inherit">{formatBytes(file.size)}</span>
                </em>
                <button
                  type="button"
                  className={cn('flash-file-remove')}
                  title="移除"
                  aria-label={`移除 ${file.name}`}
                  onClick={() =>
                    setFiles((current) => current.filter((item) => item.path !== file.path))
                  }
                >
                  <X size={12} strokeWidth={2.4} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div
          className={cn('flash-picker')}
          onClick={() => filesInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.repeat) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              filesInputRef.current?.click();
            }
          }}
        >
          <Zap size={22} strokeWidth={1.6} aria-hidden="true" />
          <span>点击打开文件选择</span>
          {/* 读不出本机路径的文件（剪贴板 / 虚拟位置）挑出来时才出现，别无其它说明文字。 */}
          {error && !lightbox ? <em className={cn('flash-error')}>{error}</em> : null}
        </div>
      </div>

      {files.length > 0 ? (
        <footer className={cn('flash-composer-foot')}>
          <button
            ref={confirmButtonRef}
            type="button"
            className={cn('flash-btn primary')}
            onClick={() => setLightbox(true)}
          >
            确认
          </button>
        </footer>
      ) : null}

      {/* 隐藏的文件选择器：多选；整个文件夹走拖拽那条路（递归展开）。 */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          addFromFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={coverInputRef}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handlePickCover(file);
        }}
      />

      {/*
        灯箱 `createPortal` 到 body：`.composer` 带 `backdrop-filter`，会给
        `position: fixed` 的子孙另开一个包含块（就是输入框那一格），挂在里面的话
        `inset: 0` 只盖住输入区，卡片跟着掉到屏幕底部。挂到 body 才是整屏居中。
      */}
      {lightbox && tabActive
        ? createPortal(
            <div
              className={cn('flash-lightbox')}
              style={{ zIndex: lightboxLayer }}
              role="dialog"
              aria-modal="true"
              aria-label="闪传封面"
              // 点灯箱外的空白退回文件框（同输入框里的媒体预览灯箱）；草稿都还在。
              onMouseDown={(event) => {
                if (event.target !== event.currentTarget || sending) return;
                setLightbox(false);
              }}
            >
              <div className={cn('flash-lightbox-card')}>
                <div className={cn('flash-lightbox-cover')}>
                  {cover ? (
                    <img src={cover} alt="闪传封面预览" />
                  ) : (
                    <span className={cn('flash-lightbox-cover-empty')}>
                      {coverBusy ? (
                        <Loader2 size={18} className={cn('flash-spin')} />
                      ) : (
                        <Sparkles size={18} strokeWidth={1.7} />
                      )}
                    </span>
                  )}
                  {coverBusy ? (
                    <span className={cn('flash-lightbox-cover-busy')}>
                      <Loader2 size={16} className={cn('flash-spin')} />
                    </span>
                  ) : null}
                </div>

                <div className={cn('flash-lightbox-body')}>
                  <div className={cn('flash-lightbox-row')}>
                    <span className={cn('flash-lightbox-label')}>标题</span>
                    <input
                      ref={titleInputRef}
                      type="text"
                      className={cn('flash-lightbox-input')}
                      value={name}
                      maxLength={120}
                      placeholder={title}
                      spellCheck={false}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  <div className={cn('flash-lightbox-meta')}>
                    <span>
                      <NumericText>{desc}</NumericText>
                    </span>
                    <span className={cn('flash-lightbox-sep')}>·</span>
                    <span>封面 {cover ? '已就绪' : '未设置'}</span>
                  </div>
                  <ul className={cn('flash-lightbox-files')}>
                    {files.slice(0, 6).map((file) => (
                      <li key={file.path}>
                        <img src={fileIconUrl(fileExtIcon(file.name))} alt="" loading="lazy" />
                        <span title={file.path}>{file.name}</span>
                        <em>
                          <span className="weq-number weq-number-inherit">
                            {formatBytes(file.size)}
                          </span>
                        </em>
                      </li>
                    ))}
                    {files.length > 6 ? (
                      <li className={cn('flash-lightbox-more')}>
                        …还有{' '}
                        <span className="weq-number weq-number-inherit">{files.length - 6}</span> 个
                      </li>
                    ) : null}
                  </ul>
                  {error ? <span className={cn('flash-error')}>{error}</span> : null}
                </div>

                <div ref={observeCompactToolbar} className={cn('flash-lightbox-actions')}>
                  <button
                    type="button"
                    className={cn('flash-btn ghost')}
                    title="上传一张自己的封面（PNG / JPEG，≤ 1 MB，原图直通）"
                    onClick={() => coverInputRef.current?.click()}
                  >
                    <ImagePlus size={14} />
                    <ToolbarLabel>换封面</ToolbarLabel>
                  </button>
                  <button
                    type="button"
                    className={cn('flash-btn ghost')}
                    title="按文件类型重新拼一张封面"
                    disabled={coverBusy}
                    onClick={() => void restoreCover()}
                  >
                    <RotateCcw size={14} />
                    <ToolbarLabel>默认封面</ToolbarLabel>
                  </button>
                  <button
                    title="返回"
                    type="button"
                    className={cn('flash-btn ghost')}
                    onClick={() => setLightbox(false)}
                  >
                    <ArrowLeft size={14} aria-hidden />
                    <ToolbarLabel>返回</ToolbarLabel>
                  </button>
                  <button
                    ref={sendButtonRef}
                    type="button"
                    className={cn('flash-btn primary')}
                    title={canSend ? '发送闪传' : sendHint}
                    disabled={sending || !canSend}
                    onClick={() => void submit()}
                  >
                    {sending ? (
                      <Loader2 size={14} className={cn('flash-spin')} />
                    ) : (
                      <SendHorizontal size={14} />
                    )}
                    {sending ? '发送中…' : '发送'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
export type { FlashDraftFile } from './flashComposer.shared';
