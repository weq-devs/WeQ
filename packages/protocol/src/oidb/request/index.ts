/** 请求处理：加群申请 / 好友申请 / 可疑好友申请。 */
export {
  SendGroupJoinRequest,
  JOIN_REQUEST_FIELD1,
  JOIN_REQUEST_SOURCE_ID,
} from './send-group-join-request';
export type { SendGroupJoinRequestParams } from './send-group-join-request';
export {
  FetchGroupRequests,
  FetchFilteredGroupRequests,
  SetGroupRequest,
  GROUP_REQUEST_OPERATION_TYPE,
  groupRequestOperationType,
} from './group-requests';
export type {
  GroupRequest,
  GroupRequestUser,
  GroupRequestPage,
  FetchGroupRequestsParams,
  SetGroupRequestParams,
} from './group-requests';
export {
  HandleFriendRequest,
  FetchDoubtFriendRequests,
  RejectDoubtFriendRequest,
  ApproveDoubtFriendRequest,
} from './friend-requests';
export type {
  HandleFriendRequestParams,
  DoubtFriendRequest,
  FetchDoubtFriendRequestsParams,
  RejectDoubtFriendRequestParams,
  ApproveDoubtFriendRequestParams,
} from './friend-requests';
export { GetGroupJoinInfo } from './get-group-join-info';
export type { GroupJoinInfo } from './get-group-join-info';
