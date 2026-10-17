/**
 * 意图感知语料库与上下文语用推理层（Pragmatic Corpus & Context Calibrator）。
 *
 * 解决单句字面分类器在中文互联网聊天（QQ/微信）中的典型误判：
 *   1. 夸张式赞叹 / 正话反说：如上文展示牛逼成果、神操作、高分作品，下文回复
 *      「吓哭了」「看傻了」「给跪了」「头皮发麻」「恐怖如斯」「太变态了」「怪物吧」，
 *      字面含「吓/哭/傻/恐怖/变态/怪物」，实为极度惊叹与佩服（intent=praise, emotion=admiration）。
 *   2. 程度副词化的「死 / 哭 / 疯 / 麻」：
 *      - 「笑死 / 笑哭 / 笑发财了 / 蚌埠住了」→ 玩梗 + 开心（而非低落/焦虑）
 *      - 「羡慕哭了 / 馋哭了 / 慕了」→ 夸赞 + 赞叹（而非低落）
 *      - 「感动哭了 / 泪目 / 太好哭了」→ 夸赞/分享 + 亲昵/赞叹（而非低落）
 *      - 「累死 / 困死 / 人麻了 / 燃尽了 / CPU烧了」→ 吐槽 + 疲惫
 *   3. 反语与阴阳怪气：
 *      - 「好好好 / 行行行 / 啊对对对 / 你开心就好 / 我真的会谢 / 栓Q」→ 吐槽 + 生气/平静（而非开心/夸赞）
 *   4. 短促黑话与语境依赖词：
 *      - 「卧槽 / wc / 逆天 / 离谱 / ？？？ / 6 / 666 / 夯 / 权威 / 仙品 / 细糠 / 包的 / 尊嘟假嘟」
 *      结合前序消息（上文成果 vs 上文吐槽 vs 上文提问）动态消歧。
 */

import type { EmotionKind, IntentKind } from './intent_sense';

export interface IntentContextTurn {
  /** true = 我方发出；false = 对方发出。 */
  mine: boolean;
  /** 纯文本（含表情转写）。 */
  text: string;
  /** 发送时间戳（秒，可选）。 */
  sendTime?: number;
}

export type UpstreamContextSignal =
  | 'achievement' // 炫耀成果、牛逼操作、技术突破、高分喜报、神仙作品
  | 'danger_or_horror' // 真实惊吓、恐怖事物、意外险情、噩耗
  | 'trouble_or_vent' // 倒霉诉苦、报错崩溃、加班受挫
  | 'humor_or_meme' // 搞笑整活、段子玩梗
  | 'affection_or_care' // 关心问候、温情投喂、示好
  | 'question_or_invite' // 提问请教、邀约商量
  | 'neutral';

export interface PragmaticAnalysis {
  /** 识别出的上文语境类型。 */
  upstreamSignal: UpstreamContextSignal;
  /** 命中的语料规则 ID（无命中为 null）。 */
  ruleId: string | null;
  /** 注入给模型（Laya / LLM）的简明语用提示（无命中但有显著上文时也会生成）。 */
  promptHint: string | null;
  /** 高置信度语用修正先验（用于校准模型字面误判）。 */
  override: {
    intent: IntentKind;
    emotion: EmotionKind;
    intensity: number;
    sentiment: number;
    minConfidence: number;
    /** true = 强规则直接覆盖；false = 仅当模型误判为反方向（如把赞叹判成负面情绪）时校准。 */
    hard: boolean;
  } | null;
}

// ── 上文语境特征词库 ────────────────────────────────────────────────────────

/** 上文提到「很牛逼的东西 / 做出了很牛逼的成果 / 秀操作 / 喜报」的强信号。 */
const UPSTREAM_ACHIEVEMENT_RE =
  /牛逼|牛[哇啊批bB]|太牛|太强|强无敌|逆天|炸裂|神作|神级|封神|天花板|王炸|黑科技|大招|绝活|硬核|大佬|巨佬|大神|天才|神仙|做出来|做出了|搞定了|写完了|开发完|手搓|自研|重构|开源|上线|发版|跑通|优化了|提升了|提速|倍|毫秒|零延迟|满分|第一名?|冠军|金奖|一等奖|特等奖|拿下了|上岸|录取|录了|过了|通关|全成就|无伤|单刷|速通|破纪录|世界纪录|中奖|欧皇|出金|双黄|满命|毕业了|发paper|顶会|中了|录用|涨薪|加薪|拿到\s*offer|offer\s*到手|mvp|五杀|超神|全连|完美|成果|作品|战绩|业绩|突破|搞出|整出|弄出|研究出|训出|训练出/i;

/** 上文为真实恐怖、虫蛇惊吓、险情或倒霉事故（此时「吓哭了/吓死」是真害怕）。 */
const UPSTREAM_DANGER_HORROR_RE =
  /鬼片|恐怖片|贞子|咒怨|闹鬼|撞鬼|灵异|停尸|墓地|半夜.*响|走夜路|尾随|变态跟踪|蟑螂|老鼠|蜘蛛|蜈蚣|蛇|虫子|车祸|追尾|着火|地震|爆炸|进医院|急诊|手术|骨折|流血|报警|警察|被骗|盗刷|做噩梦|噩梦|吓人|诡异|惊悚/;

/** 上文为诉苦、崩溃、倒霉、报错、受挫。 */
const UPSTREAM_TROUBLE_VENT_RE =
  /崩了|挂了|报错|bug|死机|蓝屏|丢了|白写了|白干|重做|返工|加班|通宵|熬夜|累死|烦死|气死|难受|崩溃|倒霉|惨|挂科|落榜|被拒|被骂|挨批|扣钱|亏了|失业|裁员|分手|裂开|麻了|天塌了|丸辣|完蛋|芭比q|寄了|凉了/i;

/** 上文为搞笑、整活、沙雕日常。 */
const UPSTREAM_HUMOR_RE =
  /哈哈|笑死|笑哭|2333|xswl|整活|段子|笑话|沙雕|搞笑|逗死|社死|离谱他妈|笑发财|蚌埠住了|绷不住了/i;

/** 上文为温情关心、示好、投喂。 */
const UPSTREAM_AFFECTION_RE =
  /给你带|给你买|请你吃|请你喝|辛苦啦|辛苦了|早点睡|早点休息|注意身体|多喝热水|照顾好自己|想你|爱你|喜欢你|抱抱|摸摸|贴贴|乖|宝贝|宝子|暖心|礼物|惊喜/;

/** 上文为提问、求助、邀约。 */
const UPSTREAM_QUESTION_INVITE_RE =
  /[？?]|吗$|呢$|怎么|如何|为什么|为啥|多少|几个|哪[里个家]|要不要|去不去|来不来|约不约|一起去|吃啥|玩啥|有空吗|在吗/;

/**
 * 分析前序对话，提取最显著的上文语境信号。
 * 越靠近当前消息的轮次权重越高（优先看最近 1~3 条）。
 */
export function detectUpstreamSignal(context: readonly IntentContextTurn[]): UpstreamContextSignal {
  if (!context || context.length === 0) return 'neutral';
  const recent = context.slice(-4);
  // 倒序扫描：紧邻的上一条消息优先级最高
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i]?.text.trim() ?? '';
    if (!t) continue;
    if (UPSTREAM_DANGER_HORROR_RE.test(t)) return 'danger_or_horror';
    if (UPSTREAM_ACHIEVEMENT_RE.test(t)) return 'achievement';
    if (UPSTREAM_TROUBLE_VENT_RE.test(t)) return 'trouble_or_vent';
    if (UPSTREAM_AFFECTION_RE.test(t)) return 'affection_or_care';
    if (UPSTREAM_HUMOR_RE.test(t)) return 'humor_or_meme';
    if (UPSTREAM_QUESTION_INVITE_RE.test(t)) return 'question_or_invite';
  }
  return 'neutral';
}

// ── 中文互联网语用规则库 ────────────────────────────────────────────────────

interface CorpusRule {
  id: string;
  /** 匹配当前消息文本。 */
  match: (text: string, norm: string, upstream: UpstreamContextSignal) => boolean;
  /** 生成给模型的语用解释。 */
  gloss: string;
  intent: IntentKind;
  emotion: EmotionKind;
  intensity: number;
  sentiment: number;
  minConfidence: number;
  hard: boolean;
}

/** 去除首尾标点与空白的归一化文本。 */
function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/^[\s~～!！.。,，、?？"“”'‘’（）()【】\[\]]+|[\s~～!！.。,，、?？"“”'‘’（）()【】\[\]]+$/g, '')
    .toLowerCase();
}

/** 消息自身是否含真实恐怖/危险描述。 */
function hasSelfDangerContext(text: string): boolean {
  return UPSTREAM_DANGER_HORROR_RE.test(text);
}

/**
 * 核心语料规则表（按优先级从高到低匹配）。
 */
const CORPUS_RULES: readonly CorpusRule[] = [
  // 1. 夸张惊叹/恐惧化赞叹（如「吓哭了」「给跪了」「看傻了」「恐怖如斯」「这是人能做出来的」）
  {
    id: 'hyperbolic_awe_kneel',
    match: (text, norm) =>
      /给?跪了|给.*跪了|滑跪|五体投地|膝盖给你|献上膝盖|妈妈问我为什么跪着|大佬受我一拜|膜拜大佬|顶礼膜拜|神乎其技|恐怖如斯|这是人能做出来的|碳基生物能|什么神仙|人形外挂|开了[吧？?]?$|绝对开了/.test(
        text,
      ) || /^(跪了|给跪了|膜拜|orz|sto|otz|恐怖如斯)$/.test(norm),
    gloss:
      '中文网络夸张式赞叹（「跪了/恐怖如斯/这是人能做出来的」等），表达极度佩服与惊叹，并非恐惧或卑微，应判为夸赞(praise)与赞叹(admiration)。',
    intent: 'praise',
    emotion: 'admiration',
    intensity: 88,
    sentiment: 88,
    minConfidence: 0.9,
    hard: true,
  },
  {
    id: 'hyperbolic_awe_cry_shock',
    match: (text, norm, upstream) => {
      if (upstream === 'danger_or_horror' || hasSelfDangerContext(text)) return false;
      // 明确带正面形容词的「X哭了 / X到窒息 / 救命太X了」
      if (
        /(帅|美|强|牛|香|甜|爽|秀|神|酷|绝|好|棒|仙|好看|好听)哭了/.test(text) ||
        /(帅|美|强|牛|绝|好看|好听)到窒息/.test(text) ||
        /救命.*(太强|太牛|太帅|太美|太好|太绝|好帅|好美|好强|怎么这么)/.test(text)
      ) {
        return true;
      }
      // 「吓哭了 / 看哭了 / 看傻了 / 惊呆了 / 头皮发麻 / 太变态了 / 太残暴了 / 怪物吧」
      const isShockCry =
        /^(吓哭了?|看哭了?|听哭了?|给我看哭了|直接看哭|看傻了?|人看傻了|看呆了?|惊呆了?|头皮发麻|起鸡皮疙瘩|汗毛倒立|太变态了[吧啊]?|太残暴了[吧啊]?|太凶残了[吧啊]?|怪物吧|纯纯怪物|非人类[吧啊]?|太恐怖了[吧啊]?|吓死我了.*太强)$/.test(
          norm,
        ) ||
        (/吓哭了|看哭了|看傻了|头皮发麻|太变态了|太残暴了|怪物吧/.test(text) &&
          (upstream === 'achievement' || /太强|牛逼|大佬|神|离谱|逆天|绝了|卧槽|wc/i.test(text)));
      if (!isShockCry) return false;
      // 若上文是倒霉/诉苦且非成果，则不走赞叹
      if (upstream === 'trouble_or_vent' && !/太强|牛|神|大佬/.test(text)) return false;
      return true;
    },
    gloss:
      '网络语境下的夸张赞叹（「吓哭了/看傻了/头皮发麻/太变态了/怪物吧」）：面对牛逼成果或厉害表现时的反语式惊叹，绝非字面的恐惧/焦虑/悲伤，而是强烈的夸赞(praise)与赞叹(admiration)！',
    intent: 'praise',
    emotion: 'admiration',
    intensity: 86,
    sentiment: 85,
    minConfidence: 0.88,
    hard: true,
  },
  {
    id: 'envy_cry_praise',
    match: (text) =>
      /羡慕哭了|馋哭了|酸死我了|实名羡慕|慕了慕了|^慕了$|眼泪从嘴角流|柠檬精|我酸了/.test(text),
    gloss:
      '「羡慕哭了/馋哭了/慕了」属于以羡慕口吻表达对对方成果或美食/好事的夸赞与向往，并非悲伤，应判为夸赞(praise)与赞叹(admiration)。',
    intent: 'praise',
    emotion: 'admiration',
    intensity: 78,
    sentiment: 76,
    minConfidence: 0.85,
    hard: true,
  },
  {
    id: 'direct_acclaim_slang',
    match: (text, norm) =>
      /^(牛逼|nb|牛哇|牛啊|牛的|牛批|太牛了[吧啊]?|6+|666+|6啊|太6了|yyds|永远的神|tql|太强了[吧啊]?|强啊|强无敌|巨强|超强|绝了|太绝了|绝绝子|神中神|顶中顶|太顶了|天花板|封神|原地封神|泰裤辣|太酷了|好厉害|太厉害了|还得是你|不愧是你|瑞思拜|respect|仙品|细糠|太权威了|权威|夯|夯爆了|真神|好活|好活当赏|大佬牛逼|大佬666|大佬太强了)$/i.test(
        norm,
      ) ||
      /牛逼plus|牛逼克拉斯|永远的神|原地封神|神中神|顶中顶|不愧是你|还得是你/i.test(text),
    gloss:
      '典型的中文网络直接夸赞与捧场用语（「牛逼/666/yyds/绝了/神中神/不愧是你/权威/夯」），表达强烈的夸赞(praise)与赞叹(admiration)。',
    intent: 'praise',
    emotion: 'admiration',
    intensity: 82,
    sentiment: 85,
    minConfidence: 0.9,
    hard: true,
  },
  // 2. 语境依赖的感叹词（「卧槽 / wc / 逆天 / 离谱 / ？？？」紧跟在上文牛逼成果之后）
  {
    id: 'context_exclamation_after_achievement',
    match: (_text, norm, upstream) =>
      upstream === 'achievement' &&
      /^(卧槽+|wc+|woc+|我靠+|我去+|我勒个去|我滴妈|我的天|天哪|天啊|神了|不是哥们|不是吧|啊[？?]+|[？?]{1,8}|逆天|太逆天了|离谱|太离谱了|真假|真的假的|夺少|多少[？?]*)$/i.test(
        norm,
      ),
    gloss:
      '上文刚提到厉害的成果或突破，此处的感叹（「卧槽/wc/逆天/离谱/？？？」）是受到震撼后的惊叹与捧场，应判为夸赞(praise)与赞叹(admiration)，而非生气或负面吐槽。',
    intent: 'praise',
    emotion: 'admiration',
    intensity: 84,
    sentiment: 80,
    minConfidence: 0.85,
    hard: true,
  },
  // 3. 「笑死 / 笑哭 / 蚌埠住了」狂喜玩梗（字面有死/哭，实为大笑）
  {
    id: 'laugh_to_death_meme',
    match: (text, norm) =>
      /笑死|笑哭|笑发财|笑不活|笑疯了|笑劈叉|笑出猪叫|笑拉了|乐死|乐疯了|逗死我了|给我整笑了|蚌埠住了|绷不住了|xswl/i.test(
        text,
      ) || /^(哈哈+|2333+|hhhh+|笑死|乐|草|艹)$/i.test(norm),
    gloss:
      '「笑死/笑哭/笑发财了/蚌埠住了/哈哈哈」是中文网络表达极度好笑的常用语，字面含「死/哭」但绝非悲伤或恐惧，应判为玩梗(joke)与开心(joy)。',
    intent: 'joke',
    emotion: 'joy',
    intensity: 76,
    sentiment: 75,
    minConfidence: 0.86,
    hard: false,
  },
  // 4. 「感动哭了 / 泪目 / 贴贴 / awsl」温情与亲昵（字面有哭/死，实为感动亲昵）
  {
    id: 'touched_affection_cry',
    match: (text, norm) =>
      /感动哭了|看泪目了|^泪目$|太好哭了|太暖了[吧啊]?|心软软|好温柔|神仙友谊|神仙爱情|awsl|阿伟死了|甜哭了|嗑到了|磕到了|磕死我了|贴贴|抱抱你|摸摸头|么么哒|爱你哟|比心/i.test(
        text,
      ) || /^(泪目|awsl|贴贴|抱抱|摸摸|么么哒|比心)$/i.test(norm),
    gloss:
      '「感动哭了/泪目/awsl/贴贴/甜哭了」表达温暖感动或亲昵喜爱，并非悲伤低落，应判为亲昵(affection)。',
    intent: 'chat',
    emotion: 'affection',
    intensity: 75,
    sentiment: 80,
    minConfidence: 0.84,
    hard: false,
  },
  // 5. 阴阳怪气与反语（「好好好 / 行行行 / 啊对对对 / 我真的会谢 / 栓Q」）
  {
    id: 'sarcastic_agreement_vent',
    match: (text, norm, upstream) =>
      /^(好好好+|行行行+|啊对对对+|昂对对对+|对对对+|你开心就好|那你很棒棒哦|真是谢谢你[啊呢]?|我真的会谢|栓q|大可不必|就这[？?]*|给你鼓掌)$/i.test(
        norm,
      ) ||
      (/我真的会谢|那你很棒棒哦|啊对对对/.test(text) && upstream !== 'achievement'),
    gloss:
      '「好好好/行行行/啊对对对/你开心就好/我真的会谢/栓Q」属于中文网络典型的反语与敷衍式吐槽，表面用正面词，实则表达无奈、不满或调侃，应判为吐槽(vent)与生气(anger)或负面倾向。',
    intent: 'vent',
    emotion: 'anger',
    intensity: 62,
    sentiment: -50,
    minConfidence: 0.82,
    hard: true,
  },
  // 6. 打工人/学生党「麻了 / 燃尽 / 躺平 / CPU烧了」疲惫吐槽
  {
    id: 'exhausted_numb_fatigue',
    match: (text, norm) =>
      /人麻了|累麻了|累死|困死|累瘫|燃尽了|电量耗尽|大脑宕机|cpu\s*烧了|cpu\s*干烧|不想上班|不想上学|不想动弹|命苦|纯纯牛马|早八人|已老实求放过/i.test(
        text,
      ) || /^(麻了|累了|困了|乏了|躺平|摆烂|燃尽了)$/i.test(norm),
    gloss:
      '「麻了/燃尽了/大脑宕机/牛马/累死」表达精力耗尽与倦怠，应判为吐槽(vent)与疲惫(fatigue)。',
    intent: 'vent',
    emotion: 'fatigue',
    intensity: 68,
    sentiment: -55,
    minConfidence: 0.82,
    hard: false,
  },
  // 7. 「汗流浃背 / 丸辣 / 天塌了 / 破防了」焦虑或崩溃吐槽
  {
    id: 'panic_or_collapse_vent',
    match: (text, norm, upstream) =>
      upstream !== 'achievement' &&
      (/汗流浃背了|慌得一批|急死我了|丸辣|天塌了|心态崩了|芭比q了|小丑竟是我自己|终究是我扛下了所有/i.test(
        text,
      ) ||
        /^(丸辣|天塌了|裂开了|寄了|凉了|完蛋|汗流浃背了)$/.test(norm)),
    gloss:
      '「丸辣/天塌了/裂开了/汗流浃背了/小丑竟是我自己」表达遭遇挫折时的抓狂、自嘲或焦虑，应判为吐槽(vent)与焦虑(anxiety)或低落(sadness)。',
    intent: 'vent',
    emotion: 'anxiety',
    intensity: 72,
    sentiment: -62,
    minConfidence: 0.8,
    hard: false,
  },
  // 8. 「尊嘟假嘟 / 细说 / 展开讲讲 / 蹲后续」吃瓜与好奇追问
  {
    id: 'curious_gossip_probe',
    match: (text, norm) =>
      /尊嘟假嘟|细说|展开说说|展开讲讲|有瓜[？?]*|吃瓜|蹲一个|蹲后续|前排围观|求科普|求教程|怎么个事/i.test(
        text,
      ) || /^(尊嘟假嘟|细说|蹲|吃瓜|真的假的[？?]*)$/.test(norm),
    gloss:
      '「尊嘟假嘟/细说/展开讲讲/蹲一个」表达强烈的好奇心与追问意图，应判为提问(question)与好奇(curiosity)。',
    intent: 'question',
    emotion: 'curiosity',
    intensity: 64,
    sentiment: 20,
    minConfidence: 0.84,
    hard: false,
  },
  // 9. 「包的 / 冲冲冲 / 安排 / 搞起」爽快约定与响应
  {
    id: 'confident_plan_agree',
    match: (_text, norm) =>
      /^(包的|必须的|那必须|安排|搞起|冲+|冲冲冲|走起|妥妥的|一言为定|不见不散)$/.test(norm),
    gloss:
      '「包的/冲冲冲/安排/搞起」表示爽快答应、响应约定或干劲十足，应判为约定(plan)与兴奋(excitement)。',
    intent: 'plan',
    emotion: 'excitement',
    intensity: 70,
    sentiment: 65,
    minConfidence: 0.82,
    hard: false,
  },
];

const UPSTREAM_SIGNAL_DESC: Record<UpstreamContextSignal, string | null> = {
  achievement:
    '上文刚提到非常厉害的成果、技术突破、高分战绩或作品展示；下文若是「吓哭了/看傻了/跪了/恐怖如斯/太变态了/卧槽/逆天/？？？」等字面惊恐或反常词汇，均属中文语境下的夸张式赞叹（intent=praise, emotion=admiration, sentiment>0），切勿误判为恐惧/焦虑/低落！',
  danger_or_horror: '上文涉及真实惊吓、恐怖事物或险情，下文的害怕/担心属于真实的焦虑紧张(anxiety)。',
  trouble_or_vent: '上文正在诉苦、抱怨报错或倒霉经历，下文多为共情安慰、追问原因或跟着吐槽。',
  humor_or_meme: '上文在整活搞笑或讲段子，下文的夸张反应多为玩梗(joke)与开心(joy)。',
  affection_or_care: '上文表达了关心、照顾或温情示好，下文回应通常带有暖心、亲昵(affection)或开心(joy)。',
  question_or_invite: '上文提出了问题或邀约，下文通常是回答告知(info)或约定响应(plan)。',
  neutral: null,
};

/**
 * 结合前序对话上下文对单条消息做语用预分析。
 */
export function analyzePragmatics(
  text: string,
  context: readonly IntentContextTurn[] = [],
): PragmaticAnalysis {
  const trimmed = text.trim();
  if (!trimmed) {
    return { upstreamSignal: 'neutral', ruleId: null, promptHint: null, override: null };
  }
  const upstream = detectUpstreamSignal(context);
  const norm = normalizeText(trimmed);

  for (const rule of CORPUS_RULES) {
    if (rule.match(trimmed, norm, upstream)) {
      const upstreamNote = UPSTREAM_SIGNAL_DESC[upstream];
      return {
        upstreamSignal: upstream,
        ruleId: rule.id,
        promptHint: upstreamNote ? `${upstreamNote} ${rule.gloss}` : rule.gloss,
        override: {
          intent: rule.intent,
          emotion: rule.emotion,
          intensity: rule.intensity,
          sentiment: rule.sentiment,
          minConfidence: rule.minConfidence,
          hard: rule.hard,
        },
      };
    }
  }

  return {
    upstreamSignal: upstream,
    ruleId: null,
    promptHint: UPSTREAM_SIGNAL_DESC[upstream],
    override: null,
  };
}

/** 负面情绪集合（用于检测字面分类器是否把正向反语/夸张赞叹误判成了负面情绪）。 */
const NEGATIVE_EMOTIONS: ReadonlySet<EmotionKind> = new Set([
  'sadness',
  'anger',
  'anxiety',
  'fatigue',
]);

/** 正面情绪集合（用于检测字面分类器是否把阴阳怪气反语误判成了正面情绪）。 */
const POSITIVE_EMOTIONS: ReadonlySet<EmotionKind> = new Set([
  'joy',
  'excitement',
  'admiration',
  'affection',
]);

export interface RawEngineSenseOutput {
  intent: IntentKind;
  emotion: EmotionKind;
  intensity: number;
  sentiment: number;
  confidence: number;
}

/**
 * 用语料库与上下文规则对引擎（Laya 本地模型或 API 大模型）的原始输出做后置校准。
 *
 * - 若命中强规则（`hard: true`，如「吓哭了」「给跪了」「恐怖如斯」「啊对对对」），
 *   修正字面误判的 intent / emotion，并保证 sentiment 与 intensity 符号及量级一致。
 * - 若命中软规则（`hard: false`，如「笑死」「泪目」「麻了」），当模型因字面词根
 *   （如「死/哭」）误判到相反情感极性时予以纠正，否则保留模型细粒度判断并微调情感分。
 */
export function calibrateIntentSense(
  raw: RawEngineSenseOutput,
  text: string,
  context: readonly IntentContextTurn[] = [],
): RawEngineSenseOutput {
  const prag = analyzePragmatics(text, context);
  const ov = prag.override;
  if (!ov) {
    // 即使未命中特定黑话词条，若上文是显著牛逼成果且当前消息很短、含感叹号/问号，
    // 而模型把「太离谱了吧！」「不是吧！」之类误判成了 anxiety/sadness，也做温和纠偏：
    if (
      prag.upstreamSignal === 'achievement' &&
      NEGATIVE_EMOTIONS.has(raw.emotion) &&
      /离谱|逆天|夸张|疯了|神|绝|吓|哭|跪|傻|呆/.test(text) &&
      !hasSelfDangerContext(text)
    ) {
      return {
        intent: 'praise',
        emotion: 'admiration',
        intensity: Math.max(raw.intensity, 80),
        sentiment: Math.max(raw.sentiment, 75),
        confidence: Math.max(raw.confidence, 0.82),
      };
    }
    return raw;
  }

  if (ov.hard) {
    return {
      intent: ov.intent,
      emotion: ov.emotion,
      intensity: ov.sentiment >= 0 ? Math.max(raw.intensity, ov.intensity) : Math.max(raw.intensity, ov.intensity),
      sentiment:
        ov.sentiment >= 0
          ? Math.max(raw.sentiment, ov.sentiment)
          : Math.min(raw.sentiment, ov.sentiment),
      confidence: Math.max(raw.confidence, ov.minConfidence),
    };
  }

  // 软规则：当模型极性跑偏，或未识别出该网络黑话对应的细分意图/情绪类别时予以校准
  const modelWentNegativeOnPositive =
    ov.sentiment > 0 && (NEGATIVE_EMOTIONS.has(raw.emotion) || raw.sentiment < 0);
  const modelWentPositiveOnNegative =
    ov.sentiment < 0 && (POSITIVE_EMOTIONS.has(raw.emotion) || raw.sentiment > 15);
  const categoryMissed = raw.emotion !== ov.emotion || raw.intent !== ov.intent;

  if (modelWentNegativeOnPositive || modelWentPositiveOnNegative || categoryMissed) {
    return {
      intent: ov.intent,
      emotion: ov.emotion,
      intensity: Math.max(raw.intensity, ov.intensity),
      sentiment:
        modelWentNegativeOnPositive || modelWentPositiveOnNegative
          ? ov.sentiment
          : ov.sentiment >= 0
            ? Math.max(raw.sentiment, ov.sentiment)
            : Math.min(raw.sentiment, ov.sentiment),
      confidence: Math.max(raw.confidence, ov.minConfidence),
    };
  }

  return raw;
}
