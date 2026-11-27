import type { RenderElement } from '@weq/service';
import type { ChatMsgWire } from './serde';

type FileTip = Extract<RenderElement, { type: 'grayTipFileRecv' }>['data'];

/** Call with the merged history of one conversation, including the gray tip. */
export function resolveFileTransferTip(
  rows: readonly ChatMsgWire[],
  tipId: string,
  tipSeq: string,
  self: { uid: string; uin: string },
) {
  const tip = rows.find((row) => row.msgId === tipId && row.msgSeq === tipSeq);
  if (!tip || tip.deletedKind || tip.recall) return null;
  const file = (tip.elements as RenderElement[]).find(
    (element) => element.type === 'grayTipFileRecv',
  )?.data;
  if (!file?.fileToken || !Number.isSafeInteger(file.fileSize) || Number(file.fileSize) < 0)
    return null;

  const matches = rows.filter(
    (row) =>
      row.kind === tip.kind &&
      row.conv === tip.conv &&
      (row.msgId !== tipId || row.msgSeq !== tipSeq) &&
      BigInt(row.msgSeq) > 0n &&
      Number(row.sendTime) <= Number(tip.sendTime) &&
      (row.elements as RenderElement[]).some((element) => matchesFile(element, file)),
  );
  const [original] = matches;
  if (!original || matches.length !== 1 || original.deletedKind || original.recall) return null;

  const author = (row: ChatMsgWire) => {
    if ((self.uid && row.senderUid === self.uid) || (self.uin && row.senderUin === self.uin))
      return 'self';
    if (row.senderUid === tip.conv || row.senderUin === tip.conv) return 'peer';
  };
  const sender = tip.kind === 'c2c' ? author(original) : undefined;
  const receiver = tip.kind === 'c2c' ? author(tip) : undefined;
  return {
    msgId: original.msgId,
    msgSeq: original.msgSeq,
    direction: sender && receiver && sender !== receiver ? sender : null,
  };
}

function matchesFile(element: RenderElement, file: FileTip): boolean {
  return (
    (element.type === 'file' || element.type === 'onlineFile') &&
    element.data.fileToken === file.fileToken &&
    element.data.fileSize === file.fileSize
  );
}
