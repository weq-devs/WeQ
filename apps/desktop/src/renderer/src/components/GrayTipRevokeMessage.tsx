interface GrayTipRevokeMessageProps {
    element: {
      type: 'grayTipRevoke';
      data?: {
        recallSenderNick?: string;
        recallRevokeNick?: string;
        recallDisplayText?: string;
      };
    };
  }
  
  export function GrayTipRevokeMessage({ element }: GrayTipRevokeMessageProps) {
    const { recallSenderNick, recallRevokeNick, recallDisplayText } = element.data || {};
  
    if (!recallRevokeNick || !recallSenderNick) {
      return (
          <div className="text-center text-gray-500 text-xs py-2">
              {'占位空消息'}
          </div>
      );
    }
  
    const isSamePerson = recallRevokeNick === recallSenderNick;
  
    return (
      <div className="text-center text-gray-500 text-xs py-2">
        {isSamePerson ? (
          <>
            <span className="text-blue-500">{recallSenderNick}</span>
            <span className="px-1">撤回了一条消息</span>
            {recallDisplayText && <span className="text-gray-400">{recallDisplayText}</span>}          </>
        ) : (
          <>
            <span className="text-blue-500">{recallRevokeNick}</span>
            <span className="px-1">撤回了一条群成员</span>
            <span className="text-blue-500 px-1">{recallSenderNick}</span>
            <span className="px-1">的消息</span>
          </>
        )}
      </div>
    );
  }
  