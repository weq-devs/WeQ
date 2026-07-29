/**
 * `account.dressup.*` —— 个性装扮(气泡 / 字体)。
 *
 * 三块能力,在线要求各不相同,这是本路由分工的主线:
 *
 *  - **排行榜**:优先打商城接口(要 pskey);没有在线实例时回退到仓库里存的一份静态
 *    响应 `resources/dress/ranking-*.json`。所以离线 / ninebird 账号照样能浏览一个
 *    可用的气泡目录 —— 气泡渲染只要 itemId 就够。
 *  - **搜索**:必须在线,没有兜底(搜索结果没法预存)。离线时明确报错。
 *  - **安装/启用**:气泡不需在线(资源外链纯 itemId 可预测);字体必须在线(要发手Q
 *    独有的 scupdate 包换下载链)。前端据 `getState().qqOnline` 决定禁用哪些按钮,
 *    这里再兜一层错,免得前端漏判。
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DressAppId, normalizeMallItems, type DressMallItem } from '@weq/service';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { resolveResource } from '../../resource';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** 该账号是否有在线且已注入的 QQ 实例。 */
function qqOnline(services = requireServices()): boolean {
  const record = services.accountConfig.getRecord();
  return Boolean(record?.qqOnline && record.qqPid);
}

const OFFLINE_HINT =
  '需要先登录该账号的 QQ 客户端 —— 装扮商城搜索与字体下载都要通过在线实例获取凭证。';

const kindInput = z.enum(['bubble', 'font']);
type DressKindInput = z.infer<typeof kindInput>;

/**
 * 商城条目自带的权威九宫格参数,由前端从列表项原样回传。
 *
 * 之所以让前端带回来而不是后端再查一遍:外链推不出来(见 service 的 bubble_skin 模块头),
 * 而列表响应里已经有了 —— 再查一次商城接口纯属浪费,而且离线时根本查不了。
 */
const bubbleMaterial = z.object({
  staticAll: z.string().min(1),
  animationAll: z.string(),
  zoomPointX: z.number().int().positive(),
  zoomPointY: z.number().int().positive(),
  color: z.string(),
});

function appIdFor(kind: DressKindInput): DressAppId {
  return kind === 'bubble' ? DressAppId.Bubble : DressAppId.Font;
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

export const dressupRouter = router({
  /** 装扮页进场状态:在线与否 + 本地清单(已装/生效)。 */
  getState: procedure.query(() => {
    const services = requireServices();
    const manifest = services.dressInstall.read();
    const record = services.accountConfig.getRecord();
    return {
      qqOnline: qqOnline(services),
      manifest,
      /** 自己在 QQ 里正在用的那两款(bootstrap 时从 getSelfDress 存下的)。 */
      own: {
        bubbleId: record?.homeDress?.bubbleId ?? 0,
        fontId: record?.homeDress?.fontId ?? 0,
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
      if (qqOnline(services)) {
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
      if (!qqOnline(services)) throw new Error(OFFLINE_HINT);
      return services.webQuery.searchDress(
        appIdFor(input.kind),
        input.keyword,
        input.pageIndex ?? 0,
      );
    }),

  /**
   * 装一款气泡。
   *
   * `material` 是商城条目自带的权威参数(外链/拉伸点/文字色)。**给了就不需要在线 QQ**
   * —— 外链推不出来,但 material 里就有。前端从列表项原样回传即可。
   * 不给时(只有 itemId,如「QQ 正在用的那款」)会回退 protocol,那才需要在线实例。
   */
  installBubble: procedure
    .input(
      z.object({
        itemId: z.number().int().positive(),
        material: bubbleMaterial.nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const skin = await requireServices().dressInstall.installBubble(
        input.itemId,
        input.material ?? null,
      );
      if (!skin) {
        throw new Error(
          qqOnline()
            ? '这款气泡的资源解析失败(可能已下架或格式特殊)'
            : '这款气泡需要登录该账号的 QQ 客户端才能获取资源地址。',
        );
      }
      return skin;
    }),

  /** 装一款字体。必须在线(见模块头)。 */
  installFont: procedure
    .input(z.object({ itemId: z.number().int().positive(), name: z.string().default('') }))
    .mutation(async ({ input }) => {
      const services = requireServices();
      if (!qqOnline(services)) throw new Error(OFFLINE_HINT);
      return services.dressInstall.installFont(input.itemId, input.name);
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
});
