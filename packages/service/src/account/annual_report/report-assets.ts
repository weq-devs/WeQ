/**
 * 年度报告导出共用的一套「协议资源寻址」。
 *
 * 屏幕版渲染时资源由 Chromium 直接加载（weq-media:// / weq-asset://），自包含
 * HTML（HTML / PDF / 长图 / 分享图四份产物共用）则必须先拿到字节内联。renderer
 * 的 exportHtml 负责拼文档、主进程只负责把它渲染成 PDF / PNG，两侧引用的是同一
 * 批数据契约 —— 这里把「什么数据对应哪条 URL」收成一份，就不会各自造 URL、慢慢
 * 跑偏。
 *
 * 只收真正打算在静态产物里画的资源：装扮气泡/挂件帧、好友与同路人头像、QQ 系统
 * 表情 APNG、自定义表情图。字体不在此列（ttf 体量大、satori/自包含 HTML 都很难
 * 整批内联），导出版对装扮字体会退回衬线栈而不是缺字。
 *
 * URL 前缀不写死：桌面主进程与 Electron 渲染层传自定义 scheme（weq-media:// /
 * weq-asset://），web 渲染层传 HTTP 挂载前缀（/_media/ / /_asset/）。两侧共享的
 * 是「哪条数据 → 哪条地址」的规则，具体可寻址形式由调用方注入。
 */

/**
 * 「戳一戳」页主体贴图用哪一张 —— `resources/pokeemoji/<id>.png`（共 0-6）。
 *
 * 0/1 是同一张 200×180、播两遍的贴图，2-6 是 120×120 无限循环的那组；主体要
 * 显大，所以取分辨率最高的 0。想换风格只改这一个常量，三端（屏幕版 / HTML 导出 /
 * satori 长图）会一起换。
 */
export const REPORT_POKE_FIGURE_ID = 0;

/** `resources/pokeemoji/` 里可用的最大 id，越界一律退回 0。 */
const POKE_FIGURE_MAX_ID = 6;

/** 收集器接受的极简 slide 形状 —— 主进程 / renderer 两侧各自的数据都有这两个字段。 */
export type ReportExportAssetSlide = {
  pageId: string;
  data: unknown;
};

/** 地址前缀：`scheme://host` 与 `/_mount/` 在第一个斜杠前的写法上不同。 */
export interface ReportAssetUrlPrefixes {
  /** `weq-media://`（桌面）或 `/_media/`（web）。 */
  mediaPrefix: string;
  /** `weq-asset://`（桌面）或 `/_asset/`（web）。 */
  assetPrefix: string;
}

/**
 * 按前缀造一份报告资源寻址工具。
 *
 * 主进程（satori 长图 / PDF / HTML 落盘）与 renderer exportHtml（自包含 HTML）
 * 各自绑定自己进程里可寻址的形式；web 渲染层用它把 URL 发回服务端解析时同样
 * 走 `/_media/…` / `/_asset/…`，服务端把它们归一成自定义协议再交给原 handler。
 */
export function createReportAssetUrls(prefixes: ReportAssetUrlPrefixes): {
  reportDressBubbleUrl: (itemId: number, frame?: number) => string;
  reportDressPendantUrl: (itemId: number, frame?: number) => string;
  reportAvatarUrl: (uin: unknown) => string;
  reportGroupAvatarUrl: (groupCode: unknown) => string;
  reportEmojiFaceUrl: (faceId: number) => string;
  reportPokeFigureUrl: (pokeId: number) => string;
  reportCustomPicUrl: (pic: {
    sendTimeMs?: unknown;
    fileName?: unknown;
    fileToken?: unknown;
    md5?: unknown;
    originalUrl?: unknown;
    subType?: unknown;
  }) => string;
  collectReportAssetUrls: (slides: ReportExportAssetSlide[]) => string[];
} {
  /** `<mediaPrefix><kind>?<query>` —— 与 renderer `mediaUrl()` 同一形状。 */
  function mediaUrl(kind: string, params: Record<string, string | number>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return `${prefixes.mediaPrefix}${kind}?${q.toString()}`;
  }

  /** 装扮气泡九宫格 PNG（`frame` 有值时取整泡帧动画的那一帧做静态底）。 */
  function reportDressBubbleUrl(itemId: number, frame?: number): string {
    return frame && frame > 0
      ? mediaUrl('dressbubble', { id: itemId, frame })
      : mediaUrl('dressbubble', { id: itemId });
  }

  /** 头像挂件动画的某一帧（静态产物只取第一帧，不播 keyframes）。 */
  function reportDressPendantUrl(itemId: number, frame = 1): string {
    return mediaUrl('dresspendant', { id: itemId, frame });
  }

  /** 好友 / 群友头像：优先本地缓存，CDN 兜底（与屏幕版同一条 fb 规则）。 */
  function reportAvatarUrl(uin: unknown): string {
    const value = String(uin ?? '');
    if (!/^\d+$/.test(value)) return '';
    return mediaUrl('avatar', {
      scope: 'user',
      uin: value,
      v: 'big',
      fb: `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${value}`,
    });
  }

  /**
   * 群头像：`scope=group` 的 `uid` 就是群号（与 renderer 的 avatarFromGroupCode
   * 同一条 CDN 规则）。同路人页的共同群徽记用它 —— 只画群头像，不画群名。
   */
  function reportGroupAvatarUrl(groupCode: unknown): string {
    const value = String(groupCode ?? '');
    if (!/^\d+$/.test(value)) return '';
    return mediaUrl('avatar', {
      scope: 'group',
      uid: value,
      v: 'big',
      fb: `https://p.qlogo.cn/gh/${value}/${value}/0`,
    });
  }

  /** QQ 系统表情的静态 APNG（FaceEmoji 的非动画路径同一个文件）。 */
  function reportEmojiFaceUrl(faceId: number): string {
    return `${prefixes.assetPrefix}emoji/${faceId}/apng/${faceId}.png`;
  }

  /** 「戳一戳」表情贴图（`resources/pokeemoji/<id>.png`，越界退回 0）。 */
  function reportPokeFigureUrl(pokeId: number): string {
    const id = Number.isInteger(pokeId) && pokeId >= 0 && pokeId <= POKE_FIGURE_MAX_ID ? pokeId : 0;
    return `${prefixes.assetPrefix}pokeemoji/${id}.png`;
  }

  /** 自定义表情图：复刻 VoicePage FavePic 拼 `weq-media://pic` 参数的规则。 */
  function reportCustomPicUrl(pic: {
    sendTimeMs?: unknown;
    fileName?: unknown;
    fileToken?: unknown;
    md5?: unknown;
    originalUrl?: unknown;
    subType?: unknown;
  }): string {
    const params: Record<string, string | number> = {
      t: Number(pic.sendTimeMs ?? 0),
      name: String(pic.fileName ?? ''),
    };
    if (pic.fileToken) params.token = String(pic.fileToken);
    if (pic.md5) params.md5 = String(pic.md5);
    if (pic.originalUrl) params.orig = String(pic.originalUrl);
    // subType 1 的自定义表情按聊天同款「收到表情」路径寻址。
    if (Number(pic.subType) === 1) params.recv = '1';
    return mediaUrl('pic', params);
  }

  /**
   * 收集整份导出真正要画出来的协议图片 URL。
   *
   * 失败/缺席不在这里报错：收集到的每一条都允许解析失败，调用方各自退回排印表达。
   */
  function collectReportAssetUrls(slides: ReportExportAssetSlide[]): string[] {
    const urls = new Set<string>();

    const addAvatar = (value: unknown): void => {
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const uin = record.peerUin ?? record.uin;
        const url = reportAvatarUrl(uin);
        if (url) urls.add(url);
        for (const nested of Object.values(record)) addAvatar(nested);
      } else if (Array.isArray(value)) {
        for (const item of value) addAvatar(item);
      }
    };

    for (const slide of slides) {
      const data = (slide.data ?? {}) as Record<string, unknown>;

      if (slide.pageId === 'dress') {
        const outfits = (data.outfits ?? []) as Array<{ bubbleId?: number; widgetId?: number }>;
        for (const outfit of outfits) {
          if (Number(outfit.bubbleId) > 0) {
            urls.add(reportDressBubbleUrl(Number(outfit.bubbleId)));
          }
          if (Number(outfit.widgetId) > 0) {
            urls.add(reportDressPendantUrl(Number(outfit.widgetId)));
          }
        }
        const collectKind = (value: unknown, kind: 'bubble' | 'widget'): void => {
          const items = (value as { items?: Array<{ itemId?: number }> } | undefined)?.items ?? [];
          for (const item of items) {
            if (Number(item.itemId) <= 0) continue;
            if (kind === 'bubble') urls.add(reportDressBubbleUrl(Number(item.itemId)));
            else urls.add(reportDressPendantUrl(Number(item.itemId)));
          }
        };
        collectKind(data.bubble, 'bubble');
        collectKind(data.widget, 'widget');
      } else if (slide.pageId === 'voice') {
        const faces = (data.faces ?? []) as Array<{ faceId?: number }>;
        for (const face of faces) {
          if (Number(face.faceId) > 0) urls.add(reportEmojiFaceUrl(Number(face.faceId)));
        }
        if (data.pic)
          urls.add(reportCustomPicUrl(data.pic as Parameters<typeof reportCustomPicUrl>[0]));
      } else if (slide.pageId === 'poke') {
        urls.add(reportPokeFigureUrl(REPORT_POKE_FIGURE_ID));
      }

      if (
        slide.pageId === 'friends' ||
        slide.pageId === 'openers' ||
        slide.pageId === 'months' ||
        slide.pageId === 'mate'
      ) {
        addAvatar(data);
      }

      // 同路人页的共同群徽记：群头像走 group scope（群号即 uid），与人物头像
      // 分开收集 —— `addAvatar` 只认 uin，群号不是 QQ 号。
      if (slide.pageId === 'mate') {
        const groups =
          (data.top as { groups?: Array<{ groupCode?: unknown }> } | null)?.groups ?? [];
        for (const group of groups) {
          const url = reportGroupAvatarUrl(group.groupCode);
          if (url) urls.add(url);
        }
      }
    }

    return [...urls];
  }

  return {
    reportDressBubbleUrl,
    reportDressPendantUrl,
    reportAvatarUrl,
    reportGroupAvatarUrl,
    reportEmojiFaceUrl,
    reportPokeFigureUrl,
    reportCustomPicUrl,
    collectReportAssetUrls,
  };
}
