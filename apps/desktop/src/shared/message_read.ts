export interface MessageReadWindow {
  owner: string;
  generation: number;
}

export interface MessageDbNotice {
  at: number;
  /** 已确认有新消息的会话。文件变更缺少目标时省略。 */
  targets?: Array<{ kind: 'c2c' | 'group'; conv: string }>;
  /** 同一轮文件变化已有定向消息，未知的同序号替换等留到合并校准。 */
  backgroundReconcile?: true;
  /** WeQ 已写入草稿。只刷新草稿读取。 */
  draftChanged?: true;
}

export interface MessagePageStage<T> {
  rows: T[];
  complete: boolean;
  reuseLocal?: boolean;
}
