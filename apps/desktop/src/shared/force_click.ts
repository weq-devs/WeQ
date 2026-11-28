export const FORCE_CLICK_CHANNEL = 'window:force-click';
export const FORCE_CLICK_RESULT_CHANNEL = 'window:force-click-result';

export type ForceClickRequest = {
  id: number;
  x: number;
  y: number;
  deadline: number;
};

export type ForceClickBridge = (handler: (request: ForceClickRequest) => boolean) => () => void;
