interface ReplyText {
  isReply: boolean;
  content: string;
  replyToUin?: string;
  replyToNickname?: string;
}

/** Project an automatic reply recipient into the label, without changing the source text. */
export function qzoneReplyPresentation<T extends ReplyText>(comment: T, parentUin?: string): T {
  if (!comment.isReply) return comment;
  const prefix = comment.content.match(/^@\{uin:([1-9]\d{4,19}),nick:([^}]*)\}\s*/);
  if (!prefix) return comment;
  const recipient = prefix[1]!;
  const automatic = /(?:^|,)who:1(?:,|$)/.test(prefix[2]!);
  const matches = comment.replyToUin
    ? recipient === comment.replyToUin
    : automatic || recipient === parentUin;
  if (!matches) return comment;
  const nickname = prefix[2]!.replace(/,(?:who|type|uin):.*$/, '');
  return {
    ...comment,
    content: comment.content.slice(prefix[0].length),
    replyToUin: recipient,
    replyToNickname: comment.replyToNickname || nickname,
  };
}
