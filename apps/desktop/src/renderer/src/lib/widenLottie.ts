/**
 * 把竖屏浮屏挂件的画布「加宽」到聊天区的宽高比 —— 拉范围,不拉比例。
 *
 * ## 要解决什么
 *
 * `resources/dress/screen/*` 全是手机端的 720×1280(9:16)。桌面聊天区通常是 16:9 上下的
 * 横向矩形,而播放器用的是 `xMidYMid meet`(见 ChatBackdrop),也就是**按高边贴合**:
 * 容器高 700 时动画只占 `700 × 720/1280 ≈ 394px` 宽,两侧大片空白。
 *
 * 换成 `slice`(cover) 并不能解决 —— 那会按宽边定标(900px 宽 → 放大 1.25 倍)再纵向裁掉
 * 一大半,变成又大又只剩中间一条。**问题不在缩放模式,在画布本身是 9:16。**
 *
 * 所以这里改画布:把 `w` 从 720 撑到 `1280 × 容器宽高比`(**高度 1280 不动**),`meet` 于是
 * 正好铺满,而定标用的高边没变 → 挂件的视觉大小与原来逐像素一致。加宽后左边会空出来,
 * 再把飘落粒子横向平铺填上 —— 这就是「改变动画范围」而不是拉伸。
 *
 * ## 怎么区分「能平铺的粒子」和「不能动的主体」
 *
 * 不硬编码挂件白名单(素材是扫目录来的,加一款就得改代码),而是量每个顶层图层的实际像素
 * 足迹与位移。10 款素材实测下来只有挂件 4(星星摆件 + 飘落花瓣)和 10(整幅居中插画)含主体,
 * 其余 8 款是纯粒子 —— 与人工判断完全一致。
 *
 * ## 为什么整段包进 precomp,而不是逐图层改坐标
 *
 * 平移/镜像如果直接写到原图层上,就得遍历改 `ks.p` 的每一个关键帧(位置多半是 animated),
 * 既容易漏(`i`/`o`/`ti`/`to` 那几组切线)又难验证。改成把整段原封不动搬进一个 precomp、
 * 只在**引用它的那一个** `ty:0` 图层上做变换,则是**零关键帧改写**:内部时序、`ip`/`op`
 * 窗口、父子关系全部原样保留,镜像也只是引用层 `ks.s.x = -100` 绕画布中心翻一下。
 *
 * 分段按顶层数组的**连续同类段**(run-length)来切,而不是「粒子全归一堆、主体全归一堆」——
 * lottie 顶层数组顺序就是绘制顺序,挂件 4 是 `[花瓣][星][花瓣][光]` 交错的,归堆会把星和光
 * 提到所有花瓣之上,观感就变了。按段切则层序完全不变。
 */

/** 素材原始画布宽度。所有 `resources/dress/screen/*` 都是 720×1280。 */
const SOURCE_WIDTH = 720;

/**
 * 横向最多平铺几块。
 *
 * 挂件 6 有 63 个顶层图层,3 块就是 189 个 SVG 节点 —— 再多会开始掉帧,而超宽窗口下
 * 多铺出来的那几块本来也只是重复。超过上限就让块变宽(粒子间距拉开),而不是加块数。
 */
const MAX_TILES = 3;

/** 判定为「主体」的像素足迹门槛。挂件 4 的星星是 550–792,花瓣最大 147。 */
const SUBJECT_FOOTPRINT = 288;

/**
 * 「小幅摆动的中等尺寸元件」也算主体。
 *
 * 挂件 4 的「左星」足迹只有 226(够不着 288),但它全程只在 38px 范围内轻微浮动 —— 那是
 * 摆件的一部分,平铺出去会凭空多出几颗星。真粒子的位移都在 400 以上(整屏飘落)。
 */
const SUBJECT_MAX_TRAVEL = 60;
const SUBJECT_MIN_FOOTPRINT = 150;

/**
 * 大位移一律判成粒子,不论多大。
 *
 * 光看尺寸会误判:挂件 9 有几片「柠檬片」足迹 314(压过 288 门槛),但位移 872 —— 那是整屏
 * 飘落的大颗粒,当主体钉在中间就不飘了。摆件类的位移都在 60 以内,量级差一个数量级。
 */
const PARTICLE_MIN_TRAVEL = 400;

/** 平铺块之间的纵向错位幅度,避免并排的克隆体在同一水平线上露出规律。 */
const TILE_JITTER_Y = 60;

type LottieLayer = {
  ind?: number;
  ty?: number;
  refId?: string;
  parent?: number;
  w?: number;
  h?: number;
  ip?: number;
  op?: number;
  ks?: { p?: LottieProp; s?: LottieProp; [key: string]: unknown };
  /** 其余 lottie 字段(nm/sr/ao/bm/ddd/st…)原样透传,这里只关心上面几个。 */
  [key: string]: unknown;
};

type LottieProp = { a?: number; k?: unknown; [key: string]: unknown };

type LottieAsset = { id?: string; w?: number; h?: number; layers?: LottieLayer[] };

type LottieJson = {
  w?: number;
  h?: number;
  ip?: number;
  op?: number;
  assets?: LottieAsset[];
  layers?: LottieLayer[];
};

/** 关键帧数组里出现过的所有 `[x, y]`,用来量一个图层跑了多远。 */
function keyframeVectors(prop: LottieProp | undefined): Array<[number, number]> {
  if (!prop || prop.a === 0 || !Array.isArray(prop.k)) return [];
  const out: Array<[number, number]> = [];
  for (const frame of prop.k as Array<{ s?: unknown; e?: unknown }>) {
    for (const value of [frame?.s, frame?.e]) {
      if (Array.isArray(value) && typeof value[0] === 'number') {
        // y 缺省按 0 —— 一维属性(如只有 x 的位置)在下游只参与取极值,不会算错方向。
        out.push([value[0], typeof value[1] === 'number' ? value[1] : 0]);
      }
    }
  }
  return out;
}

/** 图层的横向缩放系数(取动画过程中的最大值)。 */
function scaleFactor(layer: LottieLayer): number {
  const scale = layer.ks?.s;
  if (!scale) return 1;
  if (scale.a === 0) {
    return Array.isArray(scale.k) && typeof scale.k[0] === 'number'
      ? Math.abs(scale.k[0]) / 100
      : 1;
  }
  let max = 0;
  for (const vec of keyframeVectors(scale)) max = Math.max(max, Math.abs(vec[0]) / 100);
  return max || 1;
}

/** 位移幅度 —— 取 x/y 两轴里跑得更远的那个。静止图层为 0。 */
function positionTravel(layer: LottieLayer): number {
  const vectors = keyframeVectors(layer.ks?.p);
  if (!vectors.length) return 0;
  const xs = vectors.map((v) => v[0]);
  const ys = vectors.map((v) => v[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/**
 * 图层在画布上占多宽(像素)。
 *
 * 图片层直接查 asset 的 `w`;预合成层要递归取内部最宽的那一个,再乘上自己的缩放 ——
 * 挂件 4 的花瓣全是「一张 90px 图 + 缩放」包在 precomp 里,不递归的话会全部被当成
 * 720 宽的满屏层。
 */
function footprintWidth(json: LottieJson, layer: LottieLayer, depth: number): number {
  if (depth > 5) return SOURCE_WIDTH;
  const scale = scaleFactor(layer);
  if (layer.ty === 2) {
    const asset = json.assets?.find((a) => a.id === layer.refId);
    return asset?.w ? asset.w * scale : 0;
  }
  if (layer.ty === 0) {
    const asset = json.assets?.find((a) => a.id === layer.refId);
    if (!asset?.layers) return SOURCE_WIDTH;
    let max = 0;
    for (const child of asset.layers) max = Math.max(max, footprintWidth(json, child, depth + 1));
    return max * scale;
  }
  return 0;
}

/** 位移幅度的递归版 —— 预合成层自己不动、内部元件在飘的情况很常见。 */
function effectiveTravel(json: LottieJson, layer: LottieLayer, depth: number): number {
  if (depth > 5) return 0;
  let travel = positionTravel(layer);
  if (layer.ty === 0) {
    const asset = json.assets?.find((a) => a.id === layer.refId);
    if (asset?.layers) {
      const scale = scaleFactor(layer);
      for (const child of asset.layers) {
        travel = Math.max(travel, effectiveTravel(json, child, depth + 1) * scale);
      }
    }
  }
  return travel;
}

/**
 * 主体 = 够大、或者「中等大小 + 几乎不动」;但大幅飘动的一律算粒子。
 *
 * 位移优先于尺寸 —— 一个东西满屏乱飘,再大也是粒子(挂件 9 的柠檬片)。
 */
function isSubject(json: LottieJson, layer: LottieLayer): boolean {
  const travel = effectiveTravel(json, layer, 0);
  if (travel > PARTICLE_MIN_TRAVEL) return false;
  const width = footprintWidth(json, layer, 0);
  if (width > SUBJECT_FOOTPRINT) return true;
  return width > SUBJECT_MIN_FOOTPRINT && travel < SUBJECT_MAX_TRAVEL;
}

/**
 * 确定性的纵向错位。
 *
 * 刻意不用 `Math.random()`:同一个挂件在聊天页和装扮页预览里、以及每次重挂载后,都该长得
 * 一模一样,否则窗口一缩放挂件就整体跳一下。
 */
function jitterY(widgetId: string, segment: number, tile: number): number {
  let hash = 2166136261;
  const seed = `${widgetId}:${segment}:${tile}`;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (((hash >>> 0) % 1000) / 999 - 0.5) * 2 * TILE_JITTER_Y;
}

/** 造一个引用 `refId` 的顶层预合成图层,变换全部写死在它身上。 */
function referenceLayer(args: {
  ind: number;
  refId: string;
  centerX: number;
  offsetY: number;
  mirrored: boolean;
  height: number;
  ip: number;
  op: number;
}): LottieLayer {
  return {
    ddd: 0,
    ind: args.ind,
    ty: 0,
    nm: args.refId,
    refId: args.refId,
    sr: 1,
    ks: {
      o: { a: 0, k: 100, ix: 11 },
      r: { a: 0, k: 0, ix: 10 },
      p: { a: 0, k: [args.centerX, args.height / 2 + args.offsetY, 0], ix: 2 },
      // 锚点放在原画布中心 —— 镜像才会绕中轴翻,而不是绕左上角翻到画布外面去。
      a: { a: 0, k: [SOURCE_WIDTH / 2, args.height / 2, 0], ix: 1 },
      s: { a: 0, k: [args.mirrored ? -100 : 100, 100, 100], ix: 6 },
    },
    ao: 0,
    w: SOURCE_WIDTH,
    h: args.height,
    ip: args.ip,
    op: args.op,
    st: 0,
    bm: 0,
  };
}

/**
 * 按容器宽高比加宽挂件画布,并横向平铺粒子。
 *
 * @param source   原始 `fullscreen.json`(不会被修改 —— 内部先做浅结构拷贝)
 * @param widgetId 挂件目录名,只用来给纵向错位播种
 * @param aspect   容器的 宽/高。≤ 素材原比例时原样返回(装扮页那个 9:16 的预览格就走这条)
 */
export function widenLottie(source: unknown, widgetId: string, aspect: number): unknown {
  if (!source || typeof source !== 'object') return source;
  const json = source as LottieJson;
  const height = json.h ?? 0;
  const width = json.w ?? 0;
  if (!height || !width || !Array.isArray(json.layers) || !Number.isFinite(aspect)) return source;

  const targetWidth = Math.round(height * aspect);
  // 只加宽、不压窄:比素材还窄的容器(预览格正好等宽)保持原样,`meet` 本来就处理得很好。
  if (targetWidth <= width) return source;

  // 顶层图层之间一旦有父子引用,拆段就会把 parent 指向切断(`ind` 在 precomp 内外不通用)。
  // 实测 10 款素材的顶层都没有 parent(挂件 9/11 的父子关系都在 precomp 内部),这里只是
  // 兜底:遇到就退化成「只加宽画布、不平铺」,至少不会画错。
  const hasTopLevelParent = json.layers.some((l) => l.parent != null);

  const clone: LottieJson = { ...json };
  const assets: LottieAsset[] = [...(json.assets ?? [])];

  if (hasTopLevelParent) {
    clone.w = targetWidth;
    clone.layers = [
      referenceLayer({
        ind: 1,
        refId: 'weq_whole',
        centerX: targetWidth / 2,
        offsetY: 0,
        mirrored: false,
        height,
        ip: json.ip ?? 0,
        op: json.op ?? 0,
      }),
    ];
    clone.assets = [...assets, { id: 'weq_whole', layers: json.layers }];
    return clone;
  }

  // 把顶层切成「连续同类」的段,保住绘制顺序(挂件 4 是 花瓣→星→花瓣→光 交错的)。
  const segments: Array<{ subject: boolean; layers: LottieLayer[] }> = [];
  for (const layer of json.layers) {
    const subject = isSubject(json, layer);
    const last = segments[segments.length - 1];
    if (last && last.subject === subject) last.layers.push(layer);
    else segments.push({ subject, layers: [layer] });
  }

  const tiles = Math.min(MAX_TILES, Math.max(1, Math.ceil(targetWidth / width)));
  const tileWidth = targetWidth / tiles;
  const topLayers: LottieLayer[] = [];
  let nextInd = 1;

  segments.forEach((segment, segmentIndex) => {
    const refId = `weq_seg_${segmentIndex}`;
    assets.push({ id: refId, layers: segment.layers });

    // 主体只放一份、居中 —— 平铺出去会凭空多出几个摆件。
    const count = segment.subject ? 1 : tiles;
    for (let tile = 0; tile < count; tile += 1) {
      topLayers.push(
        referenceLayer({
          ind: nextInd,
          refId,
          centerX: segment.subject ? targetWidth / 2 : (tile + 0.5) * tileWidth,
          offsetY: segment.subject ? 0 : jitterY(widgetId, segmentIndex, tile),
          // 相邻块水平翻转,并排三份才不会一眼看出是同一段动画复制的。
          mirrored: !segment.subject && tile % 2 === 1,
          height,
          ip: json.ip ?? 0,
          op: json.op ?? 0,
        }),
      );
      nextInd += 1;
    }
  });

  clone.w = targetWidth;
  clone.assets = assets;
  clone.layers = topLayers;
  return clone;
}
