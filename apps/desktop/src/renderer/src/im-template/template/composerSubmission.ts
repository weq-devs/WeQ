export type ComposerSubmitOptions = {
  extraTokens?: string[];
  text?: string;
  keepBody?: boolean;
  omitQuote?: boolean;
};

/** 提交时捕获正文与槽位；独立附件不带走正文，也不改变现有 token 顺序。 */
export function composerSubmission(input: {
  body: string;
  singleToken: string | null;
  quoteToken: string | null;
  options?: ComposerSubmitOptions;
}) {
  const options = input.options ?? {};
  const tokens = [
    ...(!options.omitQuote && input.quoteToken ? [input.quoteToken] : []),
    ...(input.singleToken ? [input.singleToken] : []),
    ...(options.extraTokens ?? []),
  ];
  const text = input.singleToken ? '' : (options.text ?? input.body);
  // QQ 接受空白正文，但只有引用时仍需一段非空文本；不回写输入框或草稿。
  const quoteOnly = !text && !options.omitQuote && input.quoteToken && tokens.length === 1;
  return {
    payloadBody: `${quoteOnly ? ' ' : text}${tokens.join('')}`,
    empty: !text && tokens.length === 0,
    clearsBody: !input.singleToken && !options.keepBody,
  };
}
