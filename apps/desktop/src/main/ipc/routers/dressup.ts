/**
 * `account.dressup.*` —— 个性装扮(气泡 / 字体 / 头像挂件 / 聊天背景 / 浮屏挂件)。
 *
 * 商城那三类(气泡 / 字体 / 头像挂件)在线要求各不相同,这是本路由分工的主线:
 *
 *  - **排行榜**:优先打商城接口(要 pskey);没有在线实例时回退到仓库里存的一份静态
 *    响应 `resources/dress/ranking-*.json`。所以离线账号照样能浏览一个
 *    可用的目录 —— 气泡渲染只要 itemId 就够,字体 / 挂件的安装也走本地离线 bundle。
 *  - **搜索**:必须在线,没有兜底(搜索结果没法预存)。离线时明确报错。
 *  - **安装/启用**:三类都**默认离线可用** —— 资源先走本地离线 bundle
 *    (QQ 自带那批装扮资源,见 nt_helper 的 queryDressResourceUrl),本地没有的款
 *    才回退到在线换链(气泡走 scupdate / 字体走手Q 专属包 / 挂件走 scupdate 的
 *    other.zip 帧动画)。所以这里**不再按 qqOnline 兜一层错** —— 装得上装不上由
 *    服务层的本地 → 在线两级解析如实决定。
 *
 * 聊天背景与浮屏挂件则**一律离线可用**:QQ 同款背景的直链 bootstrap 时已存进 config,
 * 自定义背景是本地图片 / 视频,浮屏挂件是仓库里 bundle 的 Lottie。
 */
import {
  OperationError,
  developmentDressToolsEnabled,
  requireDevelopmentDressTools,
} from '@weq/service';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pickedBrowserFiles } from '../../browser_files';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observable } from '@trpc/server/observable';
import {
  describeExportOutput,
  exportOutputFileName,
  getHost,
  subscribeDressIndexResources,
} from '@weq/service';
import { z } from 'zod/v3';
import {
  DressAppId,
  normalizeMallItems,
  scanQqShowGallery,
  toPeerDress,
  type DressMallItem,
  type QqShowGalleryEvent,
} from '@weq/service';
import {
  accountEventBus,
  getAppContext,
  requireAttachEnabled,
  type AccountServices,
} from '../../context/app_context';
import { fullModeAllowed } from '../../context/full_mode';
import { resolveResource } from '../../resource';
import { procedure, router } from '../trpc';
import { buildDecorationBundle, buildDecorationFile } from './dressup_export';
import { runDressDownload } from './dressup_download';
import {
  bindExportSaveRequest,
  exportAccountBindingInput,
  exportSavePolicyInput,
  prepareExportDestination,
} from './export_save';

function requireServices(
  expected: { expectedAccountUin?: string; expectedAccountConfigId?: string } = {},
): AccountServices {
  const ctx = getAppContext();
  if (
    (expected.expectedAccountUin &&
      String(ctx.account?.context.uin) !== expected.expectedAccountUin) ||
    (expected.expectedAccountConfigId &&
      ctx.services?.accountConfig.getRecord()?.configId !== expected.expectedAccountConfigId)
  )
    throw new Error('账号或数据源已切换，请重新读取资料');
  if (!ctx.services) {
    throw new OperationError(
      'No account session open — call bootstrap.openAccount first.',
      'expected',
    );
  }
  return ctx.services;
}

/** 该账号是否有在线且已注入的 QQ 实例。完全离线模式下视为不可用。 */
function qqOnline(services = requireServices()): boolean {
  const record = services.accountConfig.getRecord();
  if (!(record?.qqOnline && record.qqPid)) return false;
  return fullModeAllowed(getAppContext());
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

const kindInput = z.enum(['bubble', 'font', 'widget', 'callbg']);
type DressKindInput = z.infer<typeof kindInput>;

function appIdFor(kind: DressKindInput): DressAppId {
  if (kind === 'bubble') return DressAppId.Bubble;
  if (kind === 'font') return DressAppId.Font;
  if (kind === 'callbg') return DressAppId.CallBackground;
  return DressAppId.Widget;
}

/**
 * 通话背景**没有在线排行榜**（`GetItemLikeRank` 对 appId 17 任何 rankType 都回空），
 * 所以这一类一律读仓库里的静态快照，不去打接口。
 */
const STATIC_ONLY_KINDS: ReadonlySet<DressKindInput> = new Set(['callbg']);

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

const opacityInput = z.number().min(0).max(1);
const dressConversationInput = exportAccountBindingInput.extend({
  kind: z.enum(['c2c', 'group']),
  conv: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(256),
});
const offOrGlobal = z.union([z.literal('off'), z.null()]);
const callBackgroundInput = z
  .object({
    itemId: z.number().int().positive(),
    name: z.string(),
    imageUrl: z.string(),
    videoUrl: z.string(),
  })
  .refine(({ imageUrl, videoUrl }) => Boolean(imageUrl || videoUrl), '这款通话背景没有可用素材');
const conversationChangeInput = z.discriminatedUnion('slot', [
  z.object({ slot: z.literal('callbg'), value: z.union([offOrGlobal, callBackgroundInput]) }),
  z.object({
    slot: z.literal('background'),
    value: z.union([offOrGlobal, z.object({ source: z.literal('qq'), opacity: opacityInput })]),
  }),
  z.object({
    slot: z.literal('screen'),
    value: z.union([offOrGlobal, z.object({ widgetId: z.string().min(1), opacity: opacityInput })]),
  }),
]);

async function pickBackgroundFile(services: AccountServices, path?: string) {
  return (
    (path ? pickedBrowserFiles.requirePath(services, path) : undefined) ??
    (await getHost().pickFile({
      title: '选择聊天背景图 / 视频',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm', 'mov'],
    }))
  );
}

function emitAppearanceChanged() {
  accountEventBus.emit('dressChanged', { at: Date.now(), appearanceOnly: true });
}

/**
 * 仓库里 bundle 的浮屏挂件目录名。
 *
 * 扫目录而不是硬编码列表 —— 加减素材时不必改代码。要求目录里有 `fullscreen.json`
 * (Lottie 本体),否则不算一款可用的挂件。
 */
export function listScreenWidgets(): string[] {
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
    return observable<{ at: number; appearanceOnly?: boolean }>((emit) => {
      const handler = (e: { at: number; appearanceOnly?: boolean }): void => {
        emit.next(e);
      };
      accountEventBus.on('dressChanged', handler);
      const unsubscribeIndex = subscribeDressIndexResources(({ state }) => {
        if (state.status === 'ready') emit.next({ at: Date.now() });
      });
      return () => {
        accountEventBus.off('dressChanged', handler);
        unsubscribeIndex();
      };
    });
  }),

  getState: procedure.query(() => {
    const services = requireServices();
    const savedManifest = services.dressInstall.read();
    // 保留已装清单与用户选择，普通模式仅停止任意装扮覆盖，不删除缓存和配置。
    const manifest = developmentDressToolsEnabled()
      ? savedManifest
      : { ...savedManifest, activeBubble: 0, activeFont: 0, activeWidget: 0 };
    const record = services.accountConfig.getRecord();
    return {
      qqOnline: qqOnline(services),
      manifest,
      conversationOverrides: services.dressConversations?.read() ?? {},
      indexResources: services.dressInstall.indexResources(),
      cachedBubbles: [
        ...new Set([manifest.activeBubble, record?.homeDress?.bubbleId ?? 0]),
      ].flatMap((id) => {
        const skin = id ? services.dressInstall.messageBubble(id) : undefined;
        return skin ? [skin] : [];
      }),
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
        /** 通话背景(个性装扮「来电」)。WeQ 侧可以覆盖成用户自己选的那款。 */
        callBgId: record?.homeDress?.callBgId ?? 0,
        callBgName: record?.homeDress?.callBgName ?? '',
        callBgUrl: record?.homeDress?.callBgUrl ?? '',
        callBgVideoUrl: record?.homeDress?.callBgVideoUrl ?? '',
      },
    };
  }),

  retryIndex: procedure
    .input(z.object({ kind: z.enum(['bubble', 'font', 'widget']) }))
    .mutation(async ({ input }) => {
      const services = requireServices();
      const ok = await services.dressInstall.retryIndex(input.kind);
      if (!ok) throw new Error('装扮离线索引下载失败，请查看任务列表后重试');
      return services.dressInstall.indexResources();
    }),

  /**
   * 排行榜。在线走接口,离线回退静态资源;`source` 告诉前端这批是哪来的,
   * 以便提示「离线目录」。
   */
  rank: procedure
    .input(z.object({ kind: kindInput, pageIndex: z.number().int().min(1).optional() }))
    .query(async ({ input }) => {
      requireDevelopmentDressTools();
      const services = requireServices();
      if (!STATIC_ONLY_KINDS.has(input.kind) && webQqOnline(services)) {
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
      requireDevelopmentDressTools();
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
      requireDevelopmentDressTools();
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
      requireDevelopmentDressTools();
      return requireServices().dressInstall.installFont(input.itemId, input.name, input.previewUrl);
    }),

  removeComposerFont: procedure
    .input(z.object({ itemId: z.number().int().positive().max(0xffff) }))
    .mutation(({ input }) => {
      requireDevelopmentDressTools();
      requireServices();
      const config = getAppContext().bootstrap?.userConfig;
      if (!config) throw new Error('配置尚未就绪');
      const composerFont = config.removeComposerFont(input.itemId);
      emitAppearanceChanged();
      return composerFont;
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
      requireDevelopmentDressTools();
      return requireServices().dressInstall.installWidget(
        input.itemId,
        input.name,
        input.previewUrl,
      );
    }),

  /**
   * 切换生效的装扮。`itemId` 传 0 表示取消该项、回到默认外观。
   *
   * 通话背景不走这里 —— 它没有「安装」概念，用 {@link setCallBackground}。
   */
  setActive: procedure
    .input(
      z.object({ kind: z.enum(['bubble', 'font', 'widget']), itemId: z.number().int().min(0) }),
    )
    .mutation(({ input }) => {
      if (input.itemId) requireDevelopmentDressTools();
      return requireServices().dressInstall.setActive(input.kind, input.itemId);
    }),

  /** 切换作用范围：仅自己、替代无装扮或覆盖全部。 */
  setScope: procedure
    .input(
      z.object({
        kind: z.enum(['bubble', 'font', 'widget']).optional(),
        scope: z.enum(['mine', 'fallback', 'all']),
      }),
    )
    .mutation(({ input }) => {
      requireDevelopmentDressTools();
      const manifest = requireServices().dressInstall.setScope(input.scope, input.kind);
      emitAppearanceChanged();
      return manifest;
    }),

  setConversationOverride: procedure
    .input(dressConversationInput.and(conversationChangeInput))
    .mutation(({ input }) => {
      const { slot, value } = input;
      const services = requireServices(input);
      if (slot === 'callbg') {
        requireDevelopmentDressTools();
        if (input.kind !== 'c2c') throw new Error('通话背景适用于私聊');
      } else if (slot === 'background' && value && value !== 'off') {
        if (!services.accountConfig.getRecord()?.homeDress?.chatBgUrl)
          throw new Error('QQ 尚未设置聊天背景');
      } else if (
        slot === 'screen' &&
        value &&
        value !== 'off' &&
        !listScreenWidgets().includes(value.widgetId)
      ) {
        throw new Error('找不到这款浮屏挂件');
      }
      const result = services.dressConversations.set(
        { kind: input.kind, conv: input.conv, title: input.title },
        input,
      );
      emitAppearanceChanged();
      return result;
    }),

  setConversationOpacity: procedure
    .input(
      dressConversationInput.extend({
        slot: z.enum(['background', 'screen']),
        opacity: opacityInput,
      }),
    )
    .mutation(({ input }) => {
      const result = requireServices(input).dressConversations.setOpacity(
        { kind: input.kind, conv: input.conv, title: input.title },
        input.slot,
        input.opacity,
      );
      emitAppearanceChanged();
      return result;
    }),

  pickConversationBackground: procedure
    .input(dressConversationInput.extend({ path: z.string().min(1).optional() }))
    .mutation(async ({ input }) => {
      const services = requireServices(input);
      const picked = await pickBackgroundFile(services, input.path);
      if (!picked) return null;
      if (requireServices(input) !== services) throw new Error('账号或数据源已切换，请重新选择');
      const result = services.dressConversations.setBackgroundFile(
        { kind: input.kind, conv: input.conv, title: input.title },
        picked,
      );
      emitAppearanceChanged();
      return result;
    }),

  /**
   * 选一张本地图 / 一段本地视频当聊天背景 —— 打系统文件框,选中后拷进本账号的装扮目录
   * 并立即生效。视频(mp4/webm/mov)由渲染层用 `<video>` 循环播放,见 ChatBackdrop。
   * 用户取消时返回当前清单(不报错,那不是失败)。
   */
  pickBackground: procedure
    .input(z.object({ path: z.string().min(1) }).optional())
    .mutation(async ({ input }) => {
      const services = requireServices();
      const picked = await pickBackgroundFile(services, input?.path);
      if (!picked) return services.dressInstall.read();
      return services.dressInstall.setCustomBackground(picked);
    }),

  /** 切换背景来源(不用 / QQ 同款 / 自定义)。 */
  setBackground: procedure
    .input(z.object({ source: z.enum(['none', 'qq', 'custom']) }))
    .mutation(({ input }) => {
      return requireServices().dressInstall.setBackground(input.source);
    }),

  /**
   * 选定通话背景。
   *
   * 与气泡/字体不同，这里**不装任何东西** —— 通话背景只是一张远程图 / 一段远程
   * 视频，通话窗口直接引它的 URL 就够。所以只把选择记进账号快照，`callBgCheckedAt`
   * 一并写上，让通话流程知道「这一项已经定了，不必再去查询」。
   *
   * 传空 itemId 表示恢复默认（清掉选择）。
   */
  setCallBackground: procedure
    .input(
      z.object({
        itemId: z.number().int().min(0),
        name: z.string().optional(),
        imageUrl: z.string().optional(),
        videoUrl: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      if (input.itemId) requireDevelopmentDressTools();
      const services = requireServices();
      const record = services.accountConfig.getRecord();
      if (!record) throw new Error('账号配置不可用，请重新打开账号');
      // 热门目录可离线浏览，直接使用时可能还没有 QQ 装扮快照。
      const dress = record.homeDress ?? {
        widgetUrl: '',
        cardUrl: '',
        cardVideoUrl: '',
        screenUrl: '',
        tags: [],
      };
      services.accountConfig.setHomeDress({
        ...dress,
        callBgId: input.itemId || undefined,
        callBgName: input.itemId ? (input.name ?? '') : undefined,
        callBgUrl: input.itemId ? (input.imageUrl ?? '') : undefined,
        callBgVideoUrl: input.itemId ? (input.videoUrl ?? '') : undefined,
        // 用户亲手定了，标记成「已确定」——后续通话直接用，不再联网覆盖。
        callBgCheckedAt: Date.now(),
      });
      return services.accountConfig.getRecord()?.homeDress ?? null;
    }),

  /** 背景不透明度由服务端限制在 0–1。 */
  setBackgroundOpacity: procedure.input(z.object({ opacity: z.number() })).mutation(({ input }) => {
    return requireServices().dressInstall.setBackgroundOpacity(input.opacity);
  }),

  setWidgetOpacity: procedure
    .input(z.object({ opacity: z.number().min(0).max(1) }))
    .mutation(({ input }) => requireServices().dressInstall.setWidgetOpacity(input.opacity)),

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
   * localOnly=true 只读取已缓存的气泡参数，其他两项返回 null，不触发下载。
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
        localOnly: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      // 首次绘制只读现有气泡，不等待字体、挂件或未缓存资源的下载。
      if (input.localOnly) {
        return {
          bubble: services.dressInstall.localBubble(input.bubbleId),
          font: null,
          widget: null,
        };
      }
      const resolved = await services.msgDecoration.resolve(input);
      const cached = services.dressInstall.messageBubble?.(input.bubbleId);
      return cached ? { ...resolved, bubble: cached } : resolved;
    }),

  /** 先选装扮下载目录，再由任务获取素材并按实际格式命名。 */
  download: procedure
    .input(
      exportAccountBindingInput.extend({
        kind: kindInput,
        items: z
          .array(
            z.object({
              itemId: z.number().int().positive(),
              name: z.string().max(512),
              mediaUrl: z
                .string()
                .url()
                .max(4096)
                .regex(/^https?:\/\//i)
                .optional(),
            }),
          )
          .min(1),
        savePolicy: exportSavePolicyInput.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireDevelopmentDressTools();
      const { kind } = input;
      const services = requireServices(input);
      const items = [...new Map(input.items.map((item) => [item.itemId, item])).values()];
      if (kind === 'callbg' && items.some((item) => !item.mediaUrl))
        throw new Error('通话背景素材地址不可用');
      const check = bindExportSaveRequest(
        {
          expectedAccountUin:
            input.expectedAccountUin ?? getAppContext().account?.context.uin.toString(),
          expectedAccountConfigId:
            input.expectedAccountConfigId ?? services.accountConfig.getRecord()?.configId,
        },
        () => {
          const ctx = getAppContext();
          return {
            uin: ctx.account?.context.uin.toString(),
            configId: ctx.services?.accountConfig.getRecord()?.configId,
            services: ctx.services,
          };
        },
      );
      const label = {
        bubble: '聊天气泡',
        font: '聊天字体',
        widget: '头像挂件',
        callbg: '通话背景',
      }[kind];
      const batch = items.length > 1;
      const name = batch ? `${label} · ${items.length} 款` : items[0]!.name || label;
      const bundleName = `WeQ-${label}-${items.length}款.zip`;
      const settings = getAppContext().bootstrap?.userConfig.getSettings();
      const policy = await prepareExportDestination(
        input.savePolicy ?? { mode: settings?.exportSaveMode ?? 'before' },
        settings?.defaultExportDir,
        getHost(),
        { kind: 'directory' },
        check,
        'dressup:download',
        '选择装扮下载文件夹',
      );
      if (!policy) return null;
      check();
      return services.exportManager.startResourceExport({
        kind: 'decoration',
        name,
        display: { action: '下载装扮', subject: name },
        output: { kind: 'file', name, extension: '' },
        fileNameFromResult: true,
        networkTransfer: { batch },
        savePolicy: policy,
        run: (context) => runDressDownload(services, kind, items, bundleName, context, check),
      });
    }),

  /**
   * 把一条消息的装扮资源另存到用户选定位置。
   *
   * `kind` 省略 = 三项打成一个 zip；传 `kind` = 只存那一项（字体 / 静态图给
   * 原生文件，多帧动画才是 zip）。根据真实产物调用公共保存准备，再创建资源任务。
   * Web 浏览器下载独立指定，不把服务器保存冒充本机下载。
   */
  saveMsgDecoration: procedure
    .input(
      z
        .object({
          bubbleId: z.number().int().min(0).default(0),
          fontId: z.number().int().min(0).default(0),
          widgetId: z.number().int().min(0).default(0),
          kind: z.enum(['font', 'bubble', 'widget']).optional(),
          savePolicy: exportSavePolicyInput.optional(),
          browserDownload: z.boolean().optional(),
        })
        .extend(exportAccountBindingInput.shape),
    )
    .mutation(async ({ input }) => {
      requireDevelopmentDressTools();
      const services = requireServices();
      const context = getAppContext();
      const current = bindExportSaveRequest(
        {
          expectedAccountUin: input.expectedAccountUin ?? context.account?.context.uin.toString(),
          expectedAccountConfigId:
            input.expectedAccountConfigId ?? services.accountConfig.getRecord()?.configId,
        },
        () => {
          const ctx = getAppContext();
          return {
            uin: ctx.account?.context.uin.toString(),
            configId: ctx.services?.accountConfig.getRecord()?.configId,
            services: ctx.services,
          };
        },
      );
      const ids = { bubbleId: input.bubbleId, fontId: input.fontId, widgetId: input.widgetId };
      const exportFile = input.kind
        ? await buildDecorationFile(services, ids, input.kind)
        : await buildDecorationBundle(services, ids);
      current();
      const host = getHost();
      if (input.browserDownload) {
        if (!host.exportRoot || !host.registerDownload) throw new Error('当前环境不支持浏览器下载');
        const target = await host.pickSaveTarget({
          defaultName: exportFile.fileName,
          locationKey: 'dressup',
        });
        if (!target) return { mode: 'cancelled' as const };
        current();
        await writeFile(target.path, exportFile.bytes, { flag: 'wx' });
        current();
        return {
          mode: 'browser' as const,
          downloadId: target.downloadId,
          name: exportFile.fileName,
        };
      }
      const output = describeExportOutput(
        { kind: 'file', name: exportFile.fileName, fileName: exportFile.fileName },
        { avatar: false, transcribe: false, ocr: false, dress: false },
      );
      if (output.kind !== 'file') throw new Error('装扮输出形态无效');
      const settings = context.bootstrap?.userConfig.getSettings();
      const policy = await prepareExportDestination(
        input.savePolicy ?? { mode: settings?.exportSaveMode ?? 'before' },
        settings?.defaultExportDir,
        host,
        output,
        current,
        `dressup:${input.kind ?? 'bundle'}`,
      );
      if (!policy) return { mode: 'cancelled' as const };
      current();
      const fileName = exportOutputFileName(output);
      const taskId = await services.exportManager.startResourceExport({
        kind: 'decoration',
        name: output.name,
        output,
        savePolicy: policy,
        run: async ({ directory, signal }) => {
          current();
          signal.throwIfAborted();
          await writeFile(join(directory, fileName), exportFile.bytes, { flag: 'wx', signal });
          current();
          signal.throwIfAborted();
          return { total: 1, ok: 1, failed: [], fileName };
        },
      });
      return { mode: 'task' as const, taskId };
    }),

  /**
   * 他人的个性主页素材(挂件 / 名片 / 浮屏)。
   *
   * **不预先按 qqOnline 短路** —— 那个标记只说明「本次会话注入过」,票据可能还在有效期内,
   * 也可能标记为真而实际已过期。一律先打一次,让服务端告诉我们行不行;失败再统一转成
   * 「需要在线实例」的提示。慢(SSR 页面几秒)但语义准确。
   */
  peerHome: procedure
    .input(z.object({ uin: z.string().regex(/^\d{5,}$/) }).merge(exportAccountBindingInput))
    .query(async ({ input }) => {
      const services = requireServices(input);
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
      if (requireServices(input) !== services) throw new Error('账号已切换，请重新读取资料');
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
    .input(
      z
        .object({
          uin: z.string().regex(/^\d{5,}$/),
          uid: z.string(),
          fields: z
            .array(z.enum(['level', 'likeCount']))
            .min(1)
            .max(2)
            .optional(),
          scope: z.string().optional(),
        })
        .merge(exportAccountBindingInput),
    )
    .query(async ({ input }) => {
      requireAttachEnabled();
      const services = requireServices(input);
      try {
        const result = await services.peerStats.getPeerStats(input.uin, input.uid, input.fields);
        if (requireServices(input) !== services) throw new Error('账号已切换，请重新读取资料');
        return result;
      } catch {
        throw new Error(PEER_STATS_HINT);
      }
    }),

  /**
   * 聊天消息里出现过的成员的 QQ 秀 URL（uin → 形象）。
   *
   * 本地映射命中时不联网，直接返回；未命中才逐个查 QQ。离线时返回已缓存的
   * 记录（过期记录也保留），完全没有的 uin 不出现在结果里。
   */
  chatQqShows: procedure
    .input(z.object({ uins: z.array(z.string().regex(/^\d{5,20}$/)).max(120) }))
    .query(({ input }) => requireServices().qqShow.resolve(input.uins)),

  /**
   * 他人的 QQ 秀形象（0xFE1_3，透明全身像 URL）。
   *
   * 与聊天头像共用同一份本地映射：有效期内直接读缓存（离线也能显示个性主页），
   * 过期才重新发包；查询失败时回退到过期记录，失败提示只在前端静默处理。
   */
  peerQqShow: procedure
    .input(z.object({ uin: z.string().regex(/^\d{5,}$/) }).merge(exportAccountBindingInput))
    .query(async ({ input }) => {
      const services = requireServices(input);
      try {
        const result = await services.qqShow.resolveOne(input.uin);
        if (requireServices(input) !== services) throw new Error('账号已切换，请重新读取资料');
        return result;
      } catch {
        throw new Error(PEER_QQ_SHOW_HINT);
      }
    }),

  /**
   * QQ 秀展柜：扫描 `images/<uin>/101…` 的整段历史形象，边扫边推。
   *
   * 与 `0xFE1_3` 无关（那条只给当前形象）—— 这里直接枚举 CDN 上的版本号，
   * 连续 10 个序号取不到才收尾。事件流：`item`（每命中一张就推）→ `progress`
   * → `done`。取消订阅即 abort，扫描会尽快停下。
   */
  qqShowGallery: procedure
    .input(z.object({ uin: z.string().regex(/^\d{5,20}$/) }))
    .subscription(({ input }) => {
      return observable<QqShowGalleryEvent>((emit) => {
        const controller = new AbortController();
        const cache = getAppContext().bootstrap?.avatarCache;
        if (!cache) {
          emit.next({
            kind: 'done',
            found: 0,
            scanned: 0,
            truncated: false,
            error: '媒体缓存不可用，无法扫描 QQ 秀',
          });
          emit.complete();
          return () => {};
        }
        void scanQqShowGallery(input.uin, {
          cache,
          signal: controller.signal,
          emit: (event) => emit.next(event),
        })
          .catch((error: unknown) => {
            emit.next({
              kind: 'done',
              found: 0,
              scanned: 0,
              truncated: false,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => emit.complete());
        return () => controller.abort();
      });
    }),
});
