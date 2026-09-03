/**
 * `account.dressup.*` —— 个性装扮(气泡 / 字体 / 头像挂件 / 聊天背景 / 浮屏挂件)。
 *
 * 商城那三类(气泡 / 字体 / 头像挂件)在线要求各不相同,这是本路由分工的主线:
 *
 *  - **排行榜**:优先打商城接口(要 pskey);没有在线实例时回退到仓库里存的一份静态
 *    响应 `resources/dress/ranking-*.json`。所以离线 / ninebird 账号照样能浏览一个
 *    可用的目录 —— 气泡渲染只要 itemId 就够,字体 / 挂件的安装也走本地离线 bundle。
 *  - **搜索**:必须在线,没有兜底(搜索结果没法预存)。离线时明确报错。
 *  - **安装/启用**:三类都**默认离线可用** —— 资源先走本地离线 bundle
 *    (QQ 自带那批装扮资源,见 nt_helper 的 queryDressResourceUrl),本地没有的款
 *    才回退到在线换链(气泡走 scupdate / 字体走手Q 专属包 / 挂件走 scupdate 的
 *    other.zip 帧动画)。所以这里**不再按 qqOnline 兜一层错** —— 装得上装不上由
 *    服务层的本地 → 在线两级解析如实决定。
 *
 * 聊天背景与浮屏挂件则**一律离线可用**:QQ 同款背景的直链 bootstrap 时已存进 config,
 * 自定义背景是本地文件,浮屏挂件是仓库里 bundle 的 Lottie。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observable } from '@trpc/server/observable';
import { getHost } from '@weq/service';
import { z } from 'zod';
import { DressAppId, normalizeMallItems, toPeerDress, type DressMallItem } from '@weq/service';
import {
  accountEventBus,
  getAppContext,
  requireInjectEnabled,
  type AccountServices,
} from '../../context/app_context';
import { resolveResource } from '../../resource';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** 该账号是否有在线且已注入的 QQ 实例。完全离线模式下视为不可用。 */
function qqOnline(services = requireServices()): boolean {
  const record = services.accountConfig.getRecord();
  if (!(record?.qqOnline && record.qqPid)) return false;
  return getAppContext().bootstrap?.userConfig.getSettings().autoInjectQq ?? true;
}

/** 仅要求在线 QQ 实例（不要求注入）—— 走 Web CGI 的接口用（pt_login 可兜底）。 */
function webQqOnline(services = requireServices()): boolean {
  const record = services.accountConfig.getRecord();
  return Boolean(record?.qqOnline && record.qqPid);
}

const OFFLINE_HINT = '需要先登录该账号的 QQ 客户端 —— 装扮商城搜索要通过在线实例获取凭证。';

const PEER_HOME_HINT =
  '获取失败 —— 个性主页要拿该账号的 QQ 会员票据去查，请确认这个账号的 QQ 客户端正在运行。';

const PEER_STATS_HINT =
  '获取失败 —— 个性主页的 QQ 等级与获赞要发 OIDB 包，请确认这个账号的 QQ 客户端正在运行。';

const PEER_QQ_SHOW_HINT = '获取失败 —— QQ 秀形象要发 OIDB 包，请确认这个账号的 QQ 客户端正在运行。';

const kindInput = z.enum(['bubble', 'font', 'widget']);
type DressKindInput = z.infer<typeof kindInput>;

function appIdFor(kind: DressKindInput): DressAppId {
  if (kind === 'bubble') return DressAppId.Bubble;
  return kind === 'font' ? DressAppId.Font : DressAppId.Widget;
}

/**
 * 静态排行榜兜底。存的是接口的**原始响应**,与联网路径共用
 * {@link normalizeMallItems} 解析(不必维护两套形状)。文件缺失/损坏时回空数组 ——
 * 装扮页会显示空列表而不是崩掉。
 */
function staticRank(kind: DressKindInput): DressMallItem[] {
  const path = resolveResource('dress', `ranking-${kind}.json`);
  if (!path) return [];
  try {
    return normalizeMallItems(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return [];
  }
}

/**
 * 排除的挂件。
 *
 * `9` 是 10 款里唯一带 After Effects 表达式的(64 处:58 个 `loopOutDuration` +
 * 3 个 `transform.opacity` + 3 个 `transform.scale`)。渲染侧只能用 `lottie_light`
 * —— 完整版靠 `eval` 求表达式,而 CSP 的 `script-src` 不含 `unsafe-eval`(见
 * renderer/index.html),不该为一款挂件把它放开。
 *
 * 而 light 版没有求值器,那 58 个 loopOut 里有 41 个的关键帧在 op=150 之前就结束了,
 * 后半段本来靠表达式循环补 —— 实际效果是动一秒、僵五秒。所以不上架。
 * 要救它得离线把 loopOut 烘焙成显式关键帧。
 */
const EXCLUDED_WIDGETS = new Set(['9']);

/**
 * 仓库里 bundle 的浮屏挂件目录名。
 *
 * 扫目录而不是硬编码列表 —— 加减素材时不必改代码。要求目录里有 `fullscreen.json`
 * (Lottie 本体),否则不算一款可用的挂件。
 */
function listScreenWidgets(): string[] {
  const root = resolveResource('dress', 'screen');
  if (!root) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !EXCLUDED_WIDGETS.has(e.name))
      .filter((e) => existsSync(join(root, e.name, 'fullscreen.json')))
      .map((e) => e.name)
      .sort((a, b) => Number(a) - Number(b));
  } catch {
    return [];
  }
}

export const dressupRouter = router({
  /** 装扮页进场状态:在线与否 + 本地清单(已装/生效)。 */
  /**
   * 主进程改过清单了(开机同步)。前端收到就 invalidate getState —— 同步是网络往返,
   * 必然晚于首屏那次查询几秒,不推的话会一直显示「已装 0」直到 staleTime 过期。
   */
  onChanged: procedure.subscription(() => {
    return observable<{ at: number }>((emit) => {
      const handler = (e: { at: number }): void => {
        emit.next(e);
      };
      accountEventBus.on('dressChanged', handler);
      return () => {
        accountEventBus.off('dressChanged', handler);
      };
    });
  }),

  getState: procedure.query(() => {
    const services = requireServices();
    const manifest = services.dressInstall.read();
    const record = services.accountConfig.getRecord();
    return {
      qqOnline: qqOnline(services),
      manifest,
      /** 自己在 QQ 里正在用的那几款(bootstrap 时从 getSelfDress 存下的)。 */
      own: {
        bubbleId: record?.homeDress?.bubbleId ?? 0,
        bubbleName: record?.homeDress?.bubbleName ?? '',
        bubblePreviewUrl: record?.homeDress?.bubblePreviewUrl ?? '',
        fontId: record?.homeDress?.fontId ?? 0,
        fontName: record?.homeDress?.fontName ?? '',
        fontPreviewUrl: record?.homeDress?.fontPreviewUrl ?? '',
        widgetId: record?.homeDress?.widgetId ?? 0,
        widgetName: record?.homeDress?.widgetName ?? '',
        widgetPreviewUrl: record?.homeDress?.widgetPreviewUrl ?? '',
        /** 聊天背景是直链(目录段是服务端 nonce,推不出来),空串表示没设。 */
        chatBgUrl: record?.homeDress?.chatBgUrl ?? '',
      },
    };
  }),

  /**
   * 排行榜。在线走接口,离线回退静态资源;`source` 告诉前端这批是哪来的,
   * 以便提示「离线目录」。
   */
  rank: procedure
    .input(z.object({ kind: kindInput, pageIndex: z.number().int().min(1).optional() }))
    .query(async ({ input }) => {
      const services = requireServices();
      if (webQqOnline(services)) {
        try {
          const items = await services.webQuery.getDressRank(
            appIdFor(input.kind),
            input.pageIndex ?? 1,
          );
          return { items, source: 'network' as const };
        } catch {
          // 在线但接口失败(票据过期/风控)——静态兜底比空列表有用。
          return { items: staticRank(input.kind), source: 'static' as const };
        }
      }
      return { items: staticRank(input.kind), source: 'static' as const };
    }),

  /** 搜索。必须在线 —— 没有可预存的兜底。 */
  search: procedure
    .input(
      z.object({
        kind: kindInput,
        keyword: z.string().min(1).max(50),
        pageIndex: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      if (!webQqOnline(services)) throw new Error(OFFLINE_HINT);
      return services.webQuery.searchDress(
        appIdFor(input.kind),
        input.keyword,
        input.pageIndex ?? 0,
      );
    }),

  /**
   * 装一款气泡。
   *
   * 只凭 itemId 走唯一下载链:先查本地离线 bundle(zip),没有才回退 protocol 换链
   * (那一步才需要在线 QQ 实例)。不再有商城 material / CDN 直链路径。
   *
   * 款名 / 预览图:渲染用不到,但装完之后「我的装扮」只剩 itemId 可查,
   * 不在这一刻记下来就再也补不回来了(商城没有按 id 查详情的接口)。
   */
  installBubble: procedure
    .input(
      z.object({
        itemId: z.number().int().positive(),
        name: z.string().optional(),
        previewUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const skin = await requireServices().dressInstall.installBubble(input.itemId, {
        name: input.name,
        previewUrl: input.previewUrl,
      });
      if (!skin) {
        throw new Error(
          qqOnline()
            ? '这款气泡的资源解析失败(可能已下架或格式特殊)'
            : '这款气泡需要登录该账号的 QQ 客户端才能获取资源地址。',
        );
      }
      return skin;
    }),

  /**
   * 装一款字体。不再要求在线 —— 本地离线 bundle 有就直接装(见共享缓存的 installFont:
   * 本地 bundle 优先、protocol 兜底),本地没有才会换在线包,失败由服务层如实报错。
   */
  installFont: procedure
    .input(
      z.object({
        itemId: z.number().int().positive(),
        name: z.string().default(''),
        previewUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return requireServices().dressInstall.installFont(input.itemId, input.name, input.previewUrl);
    }),

  /**
   * 装一款头像挂件。与字体同款策略:资源先走本地离线 bundle(不需要在线实例),
   * 本地没有才回退 protocol 换链,失败由服务层如实报错(见 installWidget)。
   *
   * 款名 / 预览图与气泡同理:装完「我的装扮」只剩 itemId 可查,不在这一刻记下来就
   * 再也补不回来了。
   */
  installWidget: procedure
    .input(
      z.object({
        itemId: z.number().int().positive(),
        name: z.string().default(''),
        previewUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return requireServices().dressInstall.installWidget(
        input.itemId,
        input.name,
        input.previewUrl,
      );
    }),

  /** 切换生效的装扮。`itemId` 传 0 表示取消该项、回到默认外观。 */
  setActive: procedure
    .input(z.object({ kind: kindInput, itemId: z.number().int().min(0) }))
    .mutation(({ input }) => {
      return requireServices().dressInstall.setActive(input.kind, input.itemId);
    }),

  /** 切换作用范围:`mine` 只渲染自己的消息,`all` 连对方的一起渲染。 */
  setScope: procedure.input(z.object({ scope: z.enum(['mine', 'all']) })).mutation(({ input }) => {
    return requireServices().dressInstall.setScope(input.scope);
  }),

  /**
   * 选一张本地图当聊天背景 —— 打系统文件框,选中后拷进本账号的装扮目录并立即生效。
   * 用户取消时返回当前清单(不报错,那不是失败)。
   */
  pickBackground: procedure.mutation(async () => {
    const services = requireServices();
    const picked = await getHost().pickFile({
      title: '选择聊天背景图',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
    });
    if (!picked) return services.dressInstall.read();
    return services.dressInstall.setCustomBackground(picked);
  }),

  /** 切换背景来源(不用 / QQ 同款 / 自定义)。 */
  setBackground: procedure
    .input(z.object({ source: z.enum(['none', 'qq', 'custom']) }))
    .mutation(({ input }) => {
      return requireServices().dressInstall.setBackground(input.source);
    }),

  /** 背景不透明度。服务端再 clamp 一次,不信前端的滑块范围。 */
  setBackgroundOpacity: procedure.input(z.object({ opacity: z.number() })).mutation(({ input }) => {
    return requireServices().dressInstall.setBackgroundOpacity(input.opacity);
  }),

  /**
   * 选一款浮屏挂件(空串 = 不叠)。
   *
   * 白名单校验:id 是要拼进 `weq-asset://dress/screen/<id>/` 的,虽然那个 protocol
   * 自己有越界检查,这里也不该把任意字符串放过去 —— 只认真实存在的那几个目录。
   */
  setWidget: procedure.input(z.object({ widgetId: z.string() })).mutation(({ input }) => {
    const id = input.widgetId;
    if (id && !listScreenWidgets().includes(id)) {
      throw new Error(`未知的挂件 id: ${id}`);
    }
    return requireServices().dressInstall.setWidget(id);
  }),

  /** 可选的浮屏挂件列表(仓库里 bundle 的那批)。 */
  widgets: procedure.query(() => {
    return listScreenWidgets().map((id) => ({ id }));
  }),

  /**
   * 解析一条消息的装扮（来自 DB 列 40801）的渲染参数。
   *
   * 同一 itemId 在 service 层有内存缓存：首次需要异步解析（bubble / font 可能要下载
   * 资源），之后恒定命中缓存——前端应以 staleTime: Infinity 查询。
   *
   * font 与 bubble 同样是「按需下载」：资源只进共享缓存（fetch 版，不写「已装」清单），
   * 未缓存过就走 scupdate 下载（需要在线实例，没有在线实例时该条 fontFile 为 null，
   * 前端不渲染自定义字体，不报错）。
   * widget 优先走 scupdate 换真实动画帧（other.zip → aio_file.zip，同样需要在线实例，
   * 不设「静态 aio_50.png」中间兜底），拿不到时直接回退到按 itemId 拼 CDN URL 的
   * 猜测（成功率不保证，但好过没有）；两种情况 `widget` 字段恒非 null（widgetId > 0
   * 时），用 `widget.animated` 区分该走 CSS 帧动画还是普通 `<img src>`。
   */
  resolveMsgDecoration: procedure
    .input(
      z.object({
        bubbleId: z.number().int().min(0).default(0),
        fontId: z.number().int().min(0).default(0),
        widgetId: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      return services.msgDecoration.resolve(input);
    }),

  /**
   * 他人的个性主页素材(挂件 / 名片 / 浮屏)。
   *
   * **不预先按 qqOnline 短路** —— 那个标记只说明「本次会话注入过」,票据可能还在有效期内,
   * 也可能标记为真而实际已过期。一律先打一次,让服务端告诉我们行不行;失败再统一转成
   * 「需要在线实例」的提示。慢(SSR 页面几秒)但语义准确。
   */
  peerHome: procedure
    .input(z.object({ uin: z.string().regex(/^\d{5,}$/) }))
    .query(async ({ input }) => {
      const services = requireServices();
      if (!webQqOnline(services)) throw new Error(PEER_HOME_HINT);
      let dress: Awaited<ReturnType<typeof services.webQuery.getFriendDress>>;
      try {
        dress = await services.webQuery.getFriendDress(input.uin);
      } catch {
        throw new Error(PEER_HOME_HINT);
      }
      // null = 页面抠不出 __INITIAL_ASYNCDATA__(未登录态 / 风控 / 页面改版),
      // 与网络失败同因同果,给同一句提示。
      if (!dress) throw new Error(PEER_HOME_HINT);
      return toPeerDress(dress);
    }),

  /**
   * 他人的个性主页统计（QQ 等级 + 资料卡累计获赞）。
   *
   * 走两条 OIDB：0xFE1_2 按 uin 查等级、0x7ED_12 按 uid 查 voteInfo 累计获赞。
   * 与 peerHome 同属「个性主页」数据，同样需要在线实例发包；失败统一转成
   * 「需要在线实例」的提示，前端静默不渲染该行即可。
   */
  peerStats: procedure
    .input(z.object({ uin: z.string().regex(/^\d{5,}$/), uid: z.string().min(1) }))
    .query(async ({ input }) => {
      requireInjectEnabled();
      const services = requireServices();
      try {
        return await services.peerStats.getPeerStats(input.uin, input.uid);
      } catch {
        throw new Error(PEER_STATS_HINT);
      }
    }),

  /**
   * 他人的 QQ 秀形象（0xFE1_3，透明全身像 URL）。
   *
   * 与 peerStats 同属「个性主页」数据，需要在线实例发包；失败统一转成
   * 「需要在线实例」的提示，前端静默回退到头像+挂件即可。
   */
  peerQqShow: procedure
    .input(z.object({ uin: z.string().regex(/^\d{5,}$/) }))
    .query(async ({ input }) => {
      requireInjectEnabled();
      const services = requireServices();
      try {
        return await services.peerStats.getQqShow(input.uin);
      } catch {
        throw new Error(PEER_QQ_SHOW_HINT);
      }
    }),
});
