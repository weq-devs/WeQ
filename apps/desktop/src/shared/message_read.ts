export interface MessageReadWindow {
  owner: string;
  generation: number;
}

export interface MessageDbNotice {
  at: number;
  /** 已确认有新消息的会话。文件变更缺少目标时省略。 */
  targets?: Array<{ kind: 'c2c' | 'group'; conv: string }>;
}

export interface MessagePageStage<T> {
  rows: T[];
  complete: boolean;
  reuseLocal?: boolean;
}
