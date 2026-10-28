export interface MessageReadWindow {
  owner: string;
  generation: number;
}

export interface MessagePageStage<T> {
  rows: T[];
  complete: boolean;
  reuseLocal?: boolean;
}
