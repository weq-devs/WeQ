import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
type QzoneOutput = inferRouterOutputs<AppRouter>['account']['qzone'];
export type QzoneEmotion = QzoneOutput['posts']['list'][number];
export type QzoneFeed = QzoneOutput['feeds']['feeds'][number];
export type QzoneInteraction = QzoneOutput['interactions'];
export type QzoneLikesResult = QzoneOutput['likes'];

export type QzoneForwardPage = QzoneOutput['forwards'];
