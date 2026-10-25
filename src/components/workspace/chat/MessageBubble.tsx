import React from 'react';
import { Message, FileAttachment } from '../types/ChatTypes';
import UserMessageBubble from './UserMessageBubble';
import { ChatMessageItem } from './ChatMessageItem';

interface MessageBubbleProps {
  message: Message;
  conversationId?: string | null;
  isProcessing?: boolean;
  onFileView?: (file: FileAttachment) => void;
  onFileDownload?: (file: FileAttachment) => void;
  onPlanApprove?: (planId: string) => void;
  onPlanReject?: (planId: string, feedback: string) => void;
  onStepInput?: (stepId: string, input: Record<string, any>) => void;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  conversationId,
  isProcessing = false,
  onFileView,
  onFileDownload,
  onPlanApprove,
  onPlanReject,
  onStepInput
}) => {
  // 🔥 Auto 类型消息 - 使用 ChatMessageItem 组件
  if (message.role === 'auto') {
    return (
      <ChatMessageItem
        message={{
          id: message.id,
          role: message.role,
          content: message.content || '',
          timestamp: message.timestamp,
          files: message.files,
          metadata: message.metadata,
          apiRole: message.apiRole,
          result: message.result,
          status: message.status,
          callId: message.callId,
          iconText: message.iconText,
          sessionId: message.sessionId,
          memory: message.memory,
        }}
        isStreaming={message.status === 'streaming'}
      />
    );
  }

  if (message.role === 'user') {
    return (
      <UserMessageBubble
        message={message}
        onFileView={onFileView}
        onFileDownload={onFileDownload}
      />
    );
  }

  return (
    <ChatMessageItem
      message={{
        id: message.id,
        role: message.role,
        content: message.content || '',
        timestamp: message.timestamp,
        files: message.files,
        metadata: message.metadata,
        apiRole: message.apiRole,
        result: message.result,
        status: message.status,
        callId: message.callId,
        iconText: message.iconText,
        sessionId: message.sessionId,
        memory: message.memory,
      }}
      isStreaming={message.status === 'streaming'}
    />
  );
};

export default MessageBubble;
