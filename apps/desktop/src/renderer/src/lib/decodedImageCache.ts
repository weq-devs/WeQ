/**
 * 装扮帧的预解码缓存（有界 LRU）。
 *
 * 背景：动态挂件/气泡/字体炫彩都是「一串 PNG，CSS `@keyframes` 逐帧切换」。浏览器
 * 只有在帧图片**解码完并有人持有**时才能直接合成；帧被丢掉后每一圈动画都会逐帧
 * 重新解码 —— 肉眼看就是高频闪烁（见历史修复 65cb537e 的注释）。
 *
 * 这里要同时满足两个互相拉扯的约束：
 *
 *  1. **有界**：早先是全局 `liveImages` 永久强引用，浏览装扮列表会持续累积（见 38686072）。
 *  2. **正在播的帧不能被淘汰**：淘汰会把 `src` 摘掉，等于主动丢掉解码结果；而注入的
 *     `@keyframes` 一直有效，丢掉在播的帧就退回「每圈逐帧重解码」—— 38686072 为了
 *     加有界缓存，把这条不变量丢了，频闪随之回归。
 *
 * 所以引入两个语义：
 *
 *  - {@link PinOwner}：**在播帧**。被 pin 的帧永不参与淘汰（`dispose` 除外）。同款装扮
 *    有多个持有者时靠计数，全部归还后才回到普通 LRU。淘汰不动时（全在播）容忍短暂
 *    超额 —— 字节预算约束的是**可选预热**，不是牺牲观感的理由。
 *  - `required` 预热：**开播前置条件**。队列超过 `maxPending` 时，可选预热直接放行
 *    （跳过热身不影响正确性），必达预热继续排队并等真结果 —— 「等全部帧就绪再开播」
 *    这条门控不能假成功。
 */

export const DECORATION_DECODE_LIMITS = {
  maxBytes: 64 * 1024 * 1024,
  maxImages: 256,
  maxConcurrent: 4,
  maxPending: 512,
  timeoutMs: 15_000,
} as const;

type FrameImage = Pick<
  HTMLImageElement,
  'src' | 'naturalWidth' | 'naturalHeight' | 'decode' | 'removeAttribute'
>;
type Limits = { [K in keyof typeof DECORATION_DECODE_LIMITS]: number };

/**
 * 一批正在播的帧的持有凭据。{@link pin} 追加、{@link release} 整批归还。
 */
export interface PinOwner {
  /** 追加标记为在播（后到的帧 / 新注入的同款）。 */
  pin(urls: readonly string[]): void;
  /** 归还这一份凭据。还有别的持有者时帧继续不参与淘汰。 */
  release(): void;
}

type Job = {
  url: string;
  required: boolean;
  resolve(): void;
  reject(error: unknown): void;
};

/** 仅缓存装扮预热帧。RGBA 估算不等于整个浏览器／GPU 的实际占用。 */
export function createDecodedImageCache(
  limits: Limits = DECORATION_DECODE_LIMITS,
  createImage: () => FrameImage = () => new Image(),
) {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new RangeError('预解码缓存限制必须为正整数');
  const retained = new Map<string, { image: FrameImage; bytes: number }>();
  const pending = new Map<string, Promise<void>>();
  /** url → 持有它的 pin 数。> 0 的帧不参与淘汰。 */
  const pinned = new Map<string, number>();
  const queue: Job[] = [];
  /** url → 在途任务。`require` 撞上先入队的可选预热时把它升级成必达（见 {@link enqueue}）。 */
  const inFlight = new Map<string, Job>();
  /**
   * 已被队列上限挡在外面、正在等空位的必达任务。
   *
   * 不能直接塞进 `queue`：`maxPending` 是队列的硬上限，必达任务只是「不被跳过」，
   * 不是「可以无视上限」—— 首屏几十条消息同时注入时那样会把队列顶爆。
   */
  const requiredWaiting: Job[] = [];
  const controller = new AbortController();
  let retainedBytes = 0;
  let active = 0;
  let disposed = false;
  const releaseImage = (image: FrameImage) => image.removeAttribute('src');

  /**
   * 淘汰一个**未 pin** 的旧帧。
   *
   * 返回 false 表示当前没有可淘汰项（剩下的都在播）—— 调用方据此容忍超预算，
   * 而不是硬砸一个正在播的帧。
   */
  const evictOldest = (): boolean => {
    for (const [url, entry] of retained) {
      if ((pinned.get(url) ?? 0) > 0) continue;
      retained.delete(url);
      retainedBytes -= entry.bytes;
      releaseImage(entry.image);
      return true;
    }
    return false;
  };

  /**
   * 解一张帧并放进缓存。
   *
   * 失败时有两条出路：可选预热静默（CSS 会按需取图），必达预热 reject（调用方据此
   * 决定要不要开播）。**失败绝不能走提前 return** —— 最后那段 `throw failure` 是
   * 唯一的出口，绕过它就让必达预热的失败变成一次静默成功（历史上踩过）。
   */
  const load = async (job: Job): Promise<void> => {
    const { url } = job;
    let image: FrameImage | undefined;
    let kept = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let failure: unknown = null;
    try {
      image = createImage();
      image.src = url;
      const decoded = await Promise.race([
        image.decode().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), limits.timeoutMs);
        }),
        new Promise<boolean>((resolve) => {
          abort = () => resolve(false);
          controller.signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
      const bytes = image.naturalWidth * image.naturalHeight * 4;
      if (disposed) {
        // 已 dispose：不落缓存，交给 finally 收尾。
      } else if (!decoded) {
        failure = new Error(`装扮帧预解码失败: ${url}`);
      } else if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limits.maxBytes) {
        failure = new Error(`装扮帧尺寸异常: ${url}`);
      } else if (!retain(url, image, bytes, job.required)) {
        // 预算不够、又全是不可淘汰的帧：可选预热放弃保留（它本来只是热身），
        // 必达预热由 retain 内部容忍超额。
        kept = false;
      } else {
        kept = true;
      }
    } catch (error) {
      failure = error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) controller.signal.removeEventListener('abort', abort);
      if (image && !kept) releaseImage(image);
    }
    // 可选预热失败不阻止 CSS 按需取图；必达预热要把失败告诉等待开播的调用方。
    if (failure && job.required && !disposed) throw failure;
  };

  /**
   * 把一个解好的帧放进缓存，返回是否保留了它。
   *
   * 超预算时先淘汰；淘汰不动（剩下的都在播）时分两种：
   *   - 必达预热：容忍超额。这批帧马上要开播，宁可超预算也不能让它在第一圈逐帧
   *     重解码（见模块头）。
   *   - 可选预热：放弃。否则每次「顺手热一下」都能挤进一个不可淘汰的帧，预算就永久
   *     失效 —— 那等于把 38686072 要修的无界累积请回来。
   */
  const retain = (url: string, image: FrameImage, bytes: number, required: boolean): boolean => {
    let overflowed = false;
    while (retained.size >= limits.maxImages || retainedBytes + bytes > limits.maxBytes) {
      if (!evictOldest()) {
        overflowed = true;
        break;
      }
    }
    if (overflowed && !required) return false;
    retained.set(url, { image, bytes });
    retainedBytes += bytes;
    return true;
  };

  /** 队列腾出空位时，把被上限挡住的必达任务补进去（保持先后顺序）。 */
  const admitRequired = (): void => {
    while (!disposed && queue.length < limits.maxPending && requiredWaiting.length > 0) {
      const job = requiredWaiting.shift();
      if (!job) break;
      queue.push(job);
    }
  };

  const pump = (): void => {
    admitRequired();
    while (!disposed && active < limits.maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      active++;
      // 落定后才释放并发槽并继续排空 —— 不能在 while 里递归，active 此时还没减。
      const settle = (error?: unknown) => {
        pending.delete(job.url);
        inFlight.delete(job.url);
        active--;
        // 按**落定这一刻**的 required 决定成败：任务在途期间可能被 require 升格
        // （见 upgradeInFlight），升格后失败就必须 reject，否则门控又变成假成功。
        if (error !== undefined && job.required) job.reject(error);
        else job.resolve();
        pump();
      };
      void load(job).then(
        () => settle(),
        (error) => settle(error),
      );
    }
  };

  /**
   * 入队并返回等待 promise。
   *
   * 队列已满时：可选预热直接放行（跳过热身不影响正确性），必达预热转到
   * {@link requiredWaiting} 等空位 —— 不假成功，也不顶爆队列。
   */
  const enqueue = (url: string, required: boolean): Promise<void> => {
    if (queue.length >= limits.maxPending && !required) return Promise.resolve();
    let job: Job | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      job = { url, required, resolve, reject };
      if (queue.length >= limits.maxPending) requiredWaiting.push(job);
      else queue.push(job);
    });
    pending.set(url, promise);
    if (job) inFlight.set(url, job);
    pump();
    return promise;
  };

  /**
   * 同一个 URL 已在途、但先到的是可选预热、现在有人要 `require` 时，把那个任务升格成
   * 必达：否则调用方 await 到的还是「失败也 resolve」的旧 promise，门控等于没生效。
   */
  const upgradeInFlight = (url: string): Promise<void> => {
    const job = inFlight.get(url);
    if (job) job.required = true;
    return pending.get(url) ?? Promise.resolve();
  };

  return {
    /**
     * 可选预热：失败、超时、队列满都静默放行。
     *
     * 它的语义是「顺手把可能用到的帧热一下」，不是「渲染的前提」——所以队列满了
     * 直接跳过不会让调用方卡住。需要前提语义的地方用 {@link require}。
     */
    preload(url: string): Promise<void> {
      if (disposed) return Promise.resolve();
      const cached = retained.get(url);
      if (cached) {
        retained.delete(url);
        retained.set(url, cached);
        return Promise.resolve();
      }
      const running = pending.get(url);
      if (running) return running;
      return enqueue(url, false);
    },

    /**
     * 必达预热：队列满时继续排队，解码失败/超时会 reject。
     *
     * 给「动画开播前必须等帧就绪」这条门控用 —— 假成功会让动画在第一圈逐帧解码。
     */
    require(url: string): Promise<void> {
      if (disposed) return Promise.resolve();
      const cached = retained.get(url);
      if (cached) {
        retained.delete(url);
        retained.set(url, cached);
        return Promise.resolve();
      }
      if (pending.has(url)) return upgradeInFlight(url);
      return enqueue(url, true);
    },

    /**
     * 把这批帧标记为「正在播」。归还之前它们不参与淘汰。
     *
     * 同款装扮可能被多次注入（聊天页 + 合并转发窗口 + 年度报告），每个调用方各持
     * 一份凭据；只要还有一份没归还，帧就一直留着。
     */
    pin(urls: readonly string[]): PinOwner {
      const owned: string[] = [];
      const add = (list: readonly string[]) => {
        for (const url of list) {
          pinned.set(url, (pinned.get(url) ?? 0) + 1);
          owned.push(url);
        }
      };
      add(urls);
      let released = false;
      return {
        pin: add,
        release: () => {
          if (released) return;
          released = true;
          for (const url of owned.splice(0)) {
            const next = (pinned.get(url) ?? 0) - 1;
            if (next > 0) pinned.set(url, next);
            else pinned.delete(url);
          }
          // 解除 pin 后可能已超预算，把腾出来的名额还给 LRU。
          while (retained.size > limits.maxImages || retainedBytes > limits.maxBytes) {
            if (!evictOldest()) break;
          }
        },
      };
    },

    stats() {
      let pinnedImages = 0;
      for (const url of retained.keys()) if ((pinned.get(url) ?? 0) > 0) pinnedImages++;
      return {
        retainedImages: retained.size,
        retainedBytes,
        pinnedImages,
        activeDecodes: active,
        pendingImages: queue.length,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const job of [...queue.splice(0), ...requiredWaiting.splice(0)]) {
        pending.delete(job.url);
        inFlight.delete(job.url);
        job.resolve();
      }
      // dispose 是唯一会动在播帧的路径(退出/热重载时本来就要全部丢掉)。
      for (const entry of retained.values()) releaseImage(entry.image);
      retained.clear();
      retainedBytes = 0;
      pinned.clear();
    },
  };
}

export const decorationImageCache = createDecodedImageCache();
