import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Image, LoaderCircle } from 'lucide-react';
import type { MailApi } from './api';
import { inlineMailImages, mailDocument, mailExternalLink } from './content';
import { useThemeStore } from '../../state/theme';

export function MailBody({ html, api }: { html: string; api: MailApi }) {
  const [images, setImages] = useState(false);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const resolved = useThemeStore((state) => state.resolved);
  const accent = useThemeStore((state) => state.accent);
  const documentHtml = useMemo(() => mailDocument(html, images, sources), [html, images, sources]);

  useEffect(() => {
    setImages(false);
    setSources({});
    setImageError('');
  }, [html]);
  useEffect(() => {
    if (!images) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const ids = inlineMailImages(html);
    let index = 0,
      budget = 0;
    setLoading(ids.length > 0);
    setImageError('');
    const load = async (): Promise<void> => {
      while (index < ids.length && !controller.signal.aborted) {
        const id = ids[index++]!;
        try {
          const result = await api.image(id, controller.signal);
          if (controller.signal.aborted) return;
          budget += result.base64.length * 0.75;
          if (budget > 30 * 1024 * 1024) {
            setImageError('部分图片超过加载大小上限。');
            return;
          }
          if (
            !/^image\/(?:png|jpeg|gif|webp)$/.test(result.mime) ||
            !/^[A-Za-z0-9+/=]+$/.test(result.base64)
          )
            continue;
          setSources((current) => ({
            ...current,
            [id]: `data:${result.mime};base64,${result.base64}`,
          }));
        } catch {
          if (!controller.signal.aborted) setImageError('部分图片暂时无法加载。');
        }
      }
    };
    void Promise.all([load(), load()]).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [images, html, api]);

  const applyTheme = useCallback((): void => {
    const doc = frame.current?.contentDocument,
      parent = container.current;
    if (!doc || !parent) return;
    const marker = document.createElement('span');
    marker.style.cssText = 'position:absolute;visibility:hidden';
    marker.style.setProperty('--mail-user-accent', accent || 'var(--weq-accent-effective)');
    marker.style.color = 'color-mix(in srgb, var(--mail-user-accent) 40%, var(--weq-fg-primary))';
    parent.append(marker);
    doc.documentElement.style.setProperty('--mail-fg', getComputedStyle(parent).color);
    doc.documentElement.style.setProperty('--mail-accent', getComputedStyle(marker).color);
    doc.documentElement.style.setProperty('--mail-scheme', resolved);
    marker.remove();
  }, [resolved, accent]);
  useLayoutEffect(() => {
    applyTheme();
  }, [applyTheme]);
  useEffect(() => () => cleanup.current?.(), []);

  return (
    <div className="weq-mail-body" ref={container}>
      <div className="weq-mail-image-tools">
        <button
          type="button"
          aria-pressed={images}
          onClick={() => {
            setImages((value) => !value);
            setSources({});
          }}
          title={images ? '隐藏远程图片' : '显示远程图片'}
        >
          {loading ? <LoaderCircle size={15} className="weq-mail-spin" /> : <Image size={15} />}
          {images ? '隐藏图片' : '显示图片'}
        </button>
        {imageError ? <span role="status">{imageError}</span> : null}
      </div>
      <iframe
        ref={frame}
        title="邮件正文"
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={documentHtml}
        onLoad={() => {
          cleanup.current?.();
          applyTheme();
          const doc = frame.current?.contentDocument;
          if (!doc) return;
          const click = (event: MouseEvent): void => {
            const target = event.target as Element | null;
            const link = typeof target?.closest === 'function' ? target.closest('a') : null;
            if (!link) return;
            event.preventDefault();
            const href = link.getAttribute('href') ?? '';
            if (href.startsWith('#')) {
              try {
                doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
              } catch {}
              return;
            }
            const url = mailExternalLink(href);
            if (url) void api.openLink(url).catch(() => setImageError('无法打开邮件中的链接。'));
          };
          doc.addEventListener('click', click);
          const imageFailed = (event: Event): void => {
            const target = event.target as HTMLImageElement | null;
            if (target?.tagName === 'IMG') {
              target.removeAttribute('src');
              setImageError('部分图片暂时无法加载。');
            }
          };
          doc.addEventListener('error', imageFailed, true);
          cleanup.current = () => {
            doc.removeEventListener('click', click);
            doc.removeEventListener('error', imageFailed, true);
          };
        }}
      />
    </div>
  );
}
