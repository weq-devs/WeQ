const MAX_IN_FLIGHT_FRAMES = 16;
const MAX_IN_FLIGHT_BYTES = 2 * 1024 * 1024;
const MAX_FRAMES_PER_MEMBER = 2;

/** 渲染器确认消费后才释放额度。某条预测链断开后从下一个关键帧恢复。 */
export class GroupVideoDeliveryQueue {
  private sequence = 0;
  private bytes = 0;
  private readonly pending = new Map<number, { uin: number; bytes: number }>();
  private readonly pendingByMember = new Map<number, number>();
  private readonly synchronized = new Set<number>();

  offer(uin: number, keyframe: boolean, bytes: number): number | undefined {
    if (!keyframe && !this.synchronized.has(uin)) return;
    const count = this.pendingByMember.get(uin) ?? 0;
    if (
      count >= MAX_FRAMES_PER_MEMBER ||
      this.pending.size >= MAX_IN_FLIGHT_FRAMES ||
      this.bytes + bytes > MAX_IN_FLIGHT_BYTES
    ) {
      this.synchronized.delete(uin);
      return;
    }
    const seq = ++this.sequence;
    this.synchronized.add(uin);
    this.pending.set(seq, { uin, bytes });
    this.pendingByMember.set(uin, count + 1);
    this.bytes += bytes;
    return seq;
  }

  acknowledge(seq: number): void {
    const frame = this.pending.get(seq);
    if (!frame) return;
    this.pending.delete(seq);
    this.bytes -= frame.bytes;
    const count = this.pendingByMember.get(frame.uin)!;
    if (count === 1) this.pendingByMember.delete(frame.uin);
    else this.pendingByMember.set(frame.uin, count - 1);
  }
}
