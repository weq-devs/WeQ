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
  const text = input.singleToken ? '' : (options.text ?? input.body).trim();
  return {
    payloadBody: `${text}${tokens.join('')}`,
    empty: !text && tokens.length === 0,
    clearsBody: !input.singleToken && !options.keepBody,
  };
}
