import {
  addSignatureComment,
  deleteSignatureComment,
  setSignatureLike,
  uploadPersonalityPhoto,
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
  type SignatureTarget,
  type TrpcNative,
} from '@weq/protocol';

const operations = {
  addSignatureComment,
  deleteSignatureComment,
  setSignatureLike,
  uploadPersonalityPhoto,
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
};
/** 写入只执行一次；相册目录同步单独报告，避免重复上传。 */
export class ProfileInteractionWrites {
  private busy = false;
  constructor(
    private readonly nt: TrpcNative,
    private readonly selfUin: string,
    private readonly resolvePid: () => number,
    private readonly api = operations,
  ) {}
  private async write<T>(run: (pid: number, current: () => void) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('请等待当前资料操作完成');
    const pid = this.resolvePid();
    const current = () => {
      if (this.resolvePid() !== pid) throw new Error('QQ 运行时已切换，请重新打开资料');
    };
    this.busy = true;
    try {
      current();
      const result = await run(pid, current);
      current();
      return result;
    } finally {
      this.busy = false;
    }
  }
  signatureLike(uin: string, signature: SignatureTarget, liked: boolean) {
    return this.write(async (pid) => {
      await this.api.setSignatureLike(this.nt, pid, uin, signature, liked);
      return { state: 'accepted' as const };
    });
  }
  signatureComment(uin: string, feedId: string, text: string, replyId?: string) {
    return this.write(async (pid) => ({
      state: 'accepted' as const,
      commentId: await this.api.addSignatureComment(
        this.nt,
        pid,
        uin,
        this.selfUin,
        feedId,
        text,
        replyId,
      ),
    }));
  }
  removeSignatureComment(uin: string, signature: SignatureTarget, commentId: string) {
    return this.write(async (pid, current) => {
      if (uin !== this.selfUin) {
        const history = await this.api.getSignatureHistory(this.nt, pid, uin, signature.createdAt);
        current();
        const comment = history.items
          .find((item) => item.id === signature.id)
          ?.commentItems?.find((item) => item.id === commentId);
        if (comment?.fromUin !== this.selfUin) throw new Error('只能删除自己发布的评论');
      }
      await this.api.deleteSignatureComment(
        this.nt,
        pid,
        uin,
        this.selfUin,
        signature.id,
        commentId,
      );
      return { state: 'accepted' as const };
    });
  }
  uploadPhoto(
    uin: string,
    labelId: string,
    source: Uint8Array,
    batch?: { count: number; index: number; timestamp: number },
  ) {
    return this.write(async (pid, current) => {
      if (uin !== this.selfUin) throw new Error('请选择自己的标签相册');
      const directory = await this.api.getPersonalityLabels(this.nt, pid, uin);
      current();
      if (!directory.labels.some((label) => label.id === labelId))
        throw new Error('标签已变化，请刷新后选择');
      const photo = await this.api.uploadPersonalityPhoto(this.nt, pid, {
        uin,
        labelId,
        source,
        ...batch,
        beforeSend: current,
      });
      current();
      let observed = false;
      try {
        const after = await this.api.getPersonalityLabels(this.nt, pid, uin);
        current();
        observed =
          after.labels
            .find((label) => label.id === labelId)
            ?.photos.some((item) => item.id === photo.photoId) ?? false;
        if (!observed) {
          const first = await this.api.getPersonalityPhotos(this.nt, pid, uin, labelId);
          current();
          observed = first.items.some((item) => item.id === photo.photoId);
        }
      } catch {
        current();
      }
      return { state: 'accepted' as const, ...photo, observed };
    });
  }
}
