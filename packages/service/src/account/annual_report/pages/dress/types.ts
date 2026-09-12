/** 年度装扮（dress）数据契约 —— 「你最喜欢使用的装扮」。 */

/** 一款被用过的装扮（单件，用于「一共穿过几款」这类概述）。 */
export type DressItemUsage = {
  /** 商城 itemId。渲染侧据此拼预览图 / 走 weq-media 资源协议。 */
  itemId: number;
  /** 用这款装扮发出的消息条数。 */
  count: number;
  /**
   * 款名。只有本地「已装」清单里记过商城元数据的那几款拿得到（装的那一刻记下的），
   * 其余为空串 —— 渲染层不显示编号，只是不写名字。
   */
  name: string;
};

/**
 * 一「套」装扮 —— 气泡 + 字体 + 挂件的一个具体组合，外加当时用它说过的真话。
 *
 * 这是这一页的主单位。40801 那一列记的本来就是一套，所以按套聚合才能还原「那年
 * 我发出去的消息长什么样」；拆成三张榜就变成数据面板了。
 */
export type DressOutfit = {
  /** 稳定标识（`bubbleId:fontId:widgetId`），渲染侧当 key 用。 */
  key: string;
  /** 0 = 这套没穿这一项。 */
  bubbleId: number;
  fontId: number;
  widgetId: number;
  /** 各项的款名，没记过元数据的为空串。 */
  bubbleName: string;
  fontName: string;
  widgetName: string;
  /** 穿这套发出的消息条数。 */
  count: number;
  /** 穿这套时说过的真实消息（纯文本、已截断）。报告拿它重画当年的气泡。 */
  samples: string[];
  /** 这套第一次 / 最后一次出现的时间（unix 秒）。0 = 未知。 */
  firstTime: number;
  lastTime: number;
};

/** 三类装扮共用的一组榜单（概述用；主体展示走 {@link DressOutfit}）。 */
export type DressKindData = {
  /**
   * 该类用过的款式，按条数降序（并列时 itemId 升序，保证稳定）。
   * **可能被截断**（见 compute 的 `MAX_ITEMS_PER_KIND`）——「一共用过几款」要读
   * {@link DressKindData.distinct}，不能读 `items.length`。
   */
  items: DressItemUsage[];
  /** 该类总共装点了多少条消息。截断前求和，所以与 items 的长度无关。 */
  total: number;
  /**
   * 该类一共用过多少**款** —— 报告里「这一年你换过 N 款气泡」的那个数。
   * 不受 items 截断影响。
   */
  distinct: number;
};

/** 年度装扮页数据。 */
export type DressPageData = {
  /** 统计口径。`ALL_TIME_YEAR`（0）= 「历史以来」。 */
  year: number;
  /** 我在这段时间里发出的消息总数 —— 装扮覆盖率的分母。 */
  totalSent: number;
  /**
   * 至少带一项装扮的消息条数。不是三类之和：一条消息可以同时有气泡 + 字体 + 挂件。
   */
  decorated: number;
  /**
   * 穿过的套装，按条数降序。`outfits[0]` 就是「这一年我最爱这身」。
   * **可能被截断**（见 compute 的 `MAX_OUTFITS`）——「换过几身」读 {@link outfitCount}。
   */
  outfits: DressOutfit[];
  /** 一共换过多少身，不受 `outfits` 截断影响。 */
  outfitCount: number;
  bubble: DressKindData;
  font: DressKindData;
  widget: DressKindData;
};
