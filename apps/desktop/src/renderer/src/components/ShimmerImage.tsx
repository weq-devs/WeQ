/**
 * 图片带 shimmer 加载占位：图片字节未就绪时，在图片底下显示一块 shimmer 扫光
 * （复用全局 `.weq-shimmer-block`），加载完成后图片自然盖住它。
 *
 * 渲染为「shimmer 块 + <img>」两个同级元素，不改动调用方的布局结构——只需
 * 保证父容器 `position: relative`（绝大多数缩略图 / 封面容器已具备，见各 CSS）。
 * `src` 变化（含失败回退换源）时会重置 shimmer；`onLoad` / `onError` 与调用方
 * 的处理器合并执行，失败时撤掉 shimmer 避免一直闪烁（调用方通常随后换源或
 * 显示兜底图标）。
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type ReactElement,
} from 'react';

export function ShimmerImage({
  className,
  alt = '',
  onLoad,
  onError,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement>): ReactElement {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const src = rest.src;

  // src 变化（首次挂载 / 失败回退换源）时重置；已缓存完成的直接显示，避免闪一下。
  useLayoutEffect(() => {
    setLoaded(false);
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setLoaded(true);
    }
  }, [src]);

  return (
    <>
      {!loaded ? <span className="weq-shimmer-block" aria-hidden /> : null}
      <img
        ref={imgRef}
        className={className}
        alt={alt}
        onLoad={(event) => {
          setLoaded(true);
          onLoad?.(event);
        }}
        onError={(event) => {
          setLoaded(true);
          onError?.(event);
        }}
        {...rest}
      />
    </>
  );
}
