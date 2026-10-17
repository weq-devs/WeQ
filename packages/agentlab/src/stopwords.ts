/**
 * 词云 / 常用语 / 口头禅共用的停用词与 token 归一化。
 *
 * 参考常见中文 / 英文停用词表整理，但**不整份照搬**：通用表里混着
 * 「欢迎」「开始」「问题」「今天」「结果」这类正常聊天内容词，直接全量过滤
 * 会把词云洗空。这里只保留虚词、代词、连词、介词、语气词、口语填充词和
 * 纯语法短语；「谢谢」「加油」「晚安」这类可能真的是口头禅的词刻意保留。
 */

/** 中文虚词 / 口语填充词。按语义分组，方便以后继续补。 */
const CHINESE_STOPWORDS = `
  的 了 是 我 你 他 她 它 们 您 您们 咱们 俺 俺们 人家 人们 人人 他人 别人 旁人
  各位 诸位 自个儿 彼此 对方 双方 本身 本人 各自 各个 各地 各种 各级
  在 也 都 就 不 和 与 及 以及 或 或者 或是 抑或 而 而且 并 并且 但 但是
  然而 不过 只是 因为 所以 因此 因而 于是 然后 如果 假如 假使 倘若 要是
  虽然 虽说 尽管 即使 即便 哪怕 无论 不管 只要 只有 除非 除了 既然 由于
  以致 以至 以便 以免 免得 否则 不然 要不 要么 与其 宁可 宁愿 不如
  也就是说 换句话说 换言之 总之 总而言之 综上所述
  啊 吧 呢 吗 哦 嗯 哈 呀 么 嘛 啦 咯 呐 呗 哇 哟 咧 嘞 喽 嘻 嘿 喂 喏
  唉 哎 哎呀 哎哟 噢 喔 诶 呃 额
  什么 怎么 怎样 怎么样 怎么办 为什么 为何 如何 哪 哪个 哪些 哪里 哪儿
  哪天 哪年 哪样 哪边 谁 谁人 何时 何处 何以 多少 几 几时 几度 是否
  能否 可否 难道 岂止 岂非
  这个 那个 这 那 这些 那些 这样 那样 这般 那般 这么 那么 这里 那里
  这儿 那儿 这边 那边 此 此外 此后 此时 此次 此间 其中 其它 其他 其余
  之一 之类
  一个 一下 一些 一点 一定 一般 一起 一边 一面 一旦 一次 一样 一切
  全部 全都 所有 有些 有的 每 每个 各 任何
  现在 目前 当前 当时 此时 那时 之后 之前 以后 以前 后来 将来 未来
  已经 曾 曾经 正 正在 将要 快要 刚 刚才 刚好 恰巧 常常 往往 总是
  一直 始终 仍然 仍旧 依然 只 仅仅 仅 几乎 差不多 大约 大概 也许 或许
  应当 必须 能够 能 可以 应该 可能 其实 感觉 觉得 知道 时候 大家 自己
  我们 你们 他们 这种 不是 就是 还是 只是
  才 再 挺 别 不要 不用 不必 不能 不会 并非 并不 没 没有
  反正 到底 究竟 毕竟 果然 居然 竟然 难怪 未必
  对 对于 关于 为 为了 把 被 让 给 跟 向 从 自 由 往 朝 沿着 按照
  依照 依据 根据 通过 经过 随着 趁着 针对 至于 距 离 当 当着
  哈哈 嘿嘿 呵呵 好的
`;

/** 英文功能词 / 缩写。中文聊天里夹英文时同样会污染词云。 */
const ENGLISH_STOPWORDS = `
  a an the and or but if then than that this these those there here when where why how
  what which who whom whose i me my mine myself you your yours yourself he him his himself
  she her hers herself it its itself we us our ours ourselves they them their theirs
  themselves am is are was were be been being have has had having do does did doing done
  can could will would shall should may might must ought not no nor so as at by for from
  in into of off on onto out over per via with without about above below between during
  before after again further once only own same too very just also even still yet already
  always never sometimes often usually ever however therefore thus hence meanwhile
  otherwise instead rather quite im ive dont cant wont isnt arent wasnt werent
  i'm i've i'll i'd you're you've you'll you'd he's she's it's we're we've we'll we'd
  they're they've they'll they'd that's there's what's let's didn't doesn't couldn't
  shouldn't wouldn't haven't hasn't hadn't
  don't don’t lol haha ok okay yes
`;

const STOPWORDS = new Set(
  `${CHINESE_STOPWORDS} ${ENGLISH_STOPWORDS}`.trim().split(/\s+/).filter(Boolean),
);

/**
 * 单字虚词：代词、语气词、助词、系动词、介词、连词和光杆副词。
 * 一个短词如果**全部**由这些字组成（我的 / 你是 / 就是…），在词云里通常只是
 * 语法连接，直接丢掉；含至少一个实词字的词（中国 / 喜欢 / 好人）会保留。
 */
const FUNCTION_CHARS = new Set<string>(
  (
    '我你他她它您咱们的了着过得地是在和与跟把被让给将对向从这那哪啊呀吧呢吗哦嗯哈嘛' +
    '啦咯呐之其此也都就还又才只很太更挺不没别么麽要会能可好有个把且并而或如若因故则' +
    '啥谁'
  ).split(''),
);

function isAllFunctionChars(word: string): boolean {
  for (const ch of word) {
    if (!FUNCTION_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * 把一个原始 token 归一化成可进词云的形式；该丢的返回 null。
 *
 * 规则与原来 `segmentWords` 的口径一致：至少两个字符、不能是纯数字、
 * 必须含中文或英文字母；停用词 / 纯虚词短词丢弃。
 */
export function normalizeChatToken(raw: string): string | null {
  const w = raw.trim().toLowerCase();
  if (w.length < 2) return null;
  if (/^\d+$/.test(w)) return null;
  if (!/[一-鿿a-z]/i.test(w)) return null;
  if (STOPWORDS.has(w)) return null;
  if (w.length <= 3 && isAllFunctionChars(w)) return null;
  return w;
}
