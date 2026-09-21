/**
 * QQ 消息 markdown 的渲染修正插件（remark 层）：换行 + `==高亮==`。
 *
 * 这两件事都是「QQ 客户端这么显示、标准 CommonMark 不这么显示」，所以统一在 mdast 层
 * 改，而不是去改文字本身、也不去动 streamdown 的 rehype 链 —— 那条链带
 * rehype-raw / sanitize / harden，聊天内容不可信，不能为了加个效果把它换掉。
 *
 * ── 换行 ──────────────────────────────────────────────────────────────────
 * QQ 把消息 markdown 里的**每一个单换行**都渲染成换行，而 CommonMark 段内的单换行是
 * softbreak —— 落到 HTML 只是个 `\n`，被浏览器折叠成空格，于是「一行一条」的消息
 * （机器人排行榜之类）会整段挤成一行。行尾也不一定是 LF：本机某条群消息的
 * markdownContent 里 12 个换行有 11 个是单独的 CR、只有 1 个 LF，而 CR / LF / CRLF
 * 都被 marked 统一识别成行尾、全是 softbreak。所以要修的是「softbreak 没渲染成换行」，
 * 与用哪种换行符无关。
 *
 * ── ==高亮== ──────────────────────────────────────────────────────────────
 * `==文字==` 是 QQ 自己的高亮语法（标准 markdown 没有），得翻成 `<mark>` 才画得出来。
 *
 * 两个插件都只重写 text 节点，于是天然碰不到代码：代码块 / 行内代码是 value-only 的
 * `code` / `inlineCode` 节点，没有 children；块级元素之间的空行也不进 text 节点，
 * 列表 / 引用 / 表格的结构不会被塞进多余的 <br>。
 */

/**
 * mdast 节点的最小形态：只用得到 type / value / children，不值得为一个插件把
 * @types/mdast 拉成直接依赖。
 */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/**
 * 递归重建 children，把每个 text 节点交给 `replace`；返回 null 表示保持原样。
 * 只递归有 children 的节点，所以 `code` / `inlineCode`（value-only）永远不会被改写。
 */
function replaceTextNodes(node: MdastNode, replace: (value: string) => MdastNode[] | null): void {
  if (!Array.isArray(node.children)) return;
  const out: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const replaced = replace(child.value);
      if (replaced) {
        out.push(...replaced);
        continue;
      }
    }
    replaceTextNodes(child, replace);
    out.push(child);
  }
  node.children = out;
}

/**
 * 段内单换行 → `<br>`（对齐 QQ 客户端的表现）。
 *
 * 参数类型故意写成 `unknown`：unified 的 transformer 会把整棵 mdast 树交进来，这里
 * 只读 children / value。
 */
export function remarkQqLineBreaks(): (tree: unknown) => void {
  return (tree) => {
    replaceTextNodes(tree as MdastNode, (value) => {
      if (!/[\r\n]/.test(value)) return null;
      const out: MdastNode[] = [];
      value.split(/\r\n?|\n/).forEach((line, i) => {
        if (i > 0) out.push({ type: 'break' });
        if (line) out.push({ type: 'text', value: line });
      });
      return out;
    });
  };
}

/**
 * `==高亮==` → `<mark>`（QQ 的高亮语法）。
 *
 * `.split` 带捕获组，所以只替成对的 `==…==`：未闭合的 `==没闭合`、以及 `a == b` 这种
 * 单个等号都保持原样。高亮体内的文字不参与 markdown 解析（它是 text 节点里的原文），
 * 因此 `==**粗**==` 这种被 marked 拆成 text('==') + strong + text('==') 的写法不处理、
 * 原样显示 —— QQ 的 `==` 本来就是给纯文字用的，跨节点配对不值得再写一套状态机。
 *
 * `<mark>` 在 hast-util-sanitize 的默认白名单里，不需要额外开 streamdown 的
 * allowedTags；实测 `<script>` 与 `javascript:` 链接仍然被 harden 拦掉。
 */
export function remarkQqHighlight(): (tree: unknown) => void {
  return (tree) => {
    replaceTextNodes(tree as MdastNode, (value) => {
      if (!value.includes('==')) return null;
      const out: MdastNode[] = [];
      for (const part of value.split(/(==[^=\r\n]+==)/)) {
        if (!part) continue;
        const match = /^==([^=\r\n]+)==$/.exec(part);
        if (match) {
          out.push(
            { type: 'html', value: '<mark>' },
            { type: 'text', value: match[1] ?? '' },
            { type: 'html', value: '</mark>' },
          );
        } else {
          out.push({ type: 'text', value: part });
        }
      }
      return out;
    });
  };
}
