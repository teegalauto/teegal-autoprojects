import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { MessageData } from './types';
import MessageContent from './MessageContent';
import MessageIcon from './MessageIcon';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/hooks/workspace/useWorkspace';

interface SessionMessageGroupProps {
  sessionId: string;
  messages: MessageData[];
  defaultExpanded?: boolean;
}

const getLastMessageSummary = (messages: MessageData[]): string => {
  // 🔥 从后往前找第一条有内容的消息：reactor 多工具轮中只有首个工具挂推理文案（content），
  // 同轮其余 callId 的消息 content 为空串——直接取最后一条会经常拿到空摘要
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // 🔥 根据 apiRole 决定取 content 还是 result
    // summarizer 优先取 result，reactor 优先取 content
    const content = (m.apiRole === 'summarizer' ? m.result || m.content : m.content || m.result) || '';
    const trimmed = content.trim();
    if (trimmed) {
      return trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
    }
  }
  return '';
};

/**
 * 🔥 根据消息列表的 apiRole 获取显示名称
 */
const getGroupDisplayName = (messages: MessageData[]): string => {
  if (messages.length === 0) return 'SubAgent';
  // 检查所有消息中是否有 summarizer
  const hasSummarizer = messages.some(m => m.apiRole === 'summarizer');
  if (hasSummarizer) {
    return 'DeepSearch';
  }
  return 'SubAgent';
};

/**
 * 🔥 格式化时间差为 xxh xxm xxs 格式（窄空格）
 */
const formatDuration = (ms: number): string => {
  if (ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const s = seconds % 60;
  const m = minutes % 60;
  const h = hours;

  if (h > 0) {
    return `${h}h\u2009${m}m\u2009${s}s`;
  } else if (m > 0) {
    return `${m}m\u2009${s}s`;
  } else {
    return `${s}s`;
  }
};

export const SessionMessageGroup: React.FC<SessionMessageGroupProps> = ({
  sessionId,
  messages,
  defaultExpanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [now, setNow] = useState(Date.now());
  const { summaryHandler } = useWorkspace();

  // 🔥 从 SummaryHandler 获取 session 状态
  const [sessionStatus, setSessionStatus] = useState<{ status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown'; startTime?: Date; endTime?: Date }>({ status: 'unknown' });

  // 🔥 定期刷新 session 状态
  useEffect(() => {
    const refreshStatus = () => {
      if (summaryHandler) {
        setSessionStatus(summaryHandler.getSessionStatus(sessionId));
      }
    };

    // 立即刷新一次
    refreshStatus();

    // 如果 session 正在运行，每秒刷新一次
    if (sessionStatus.status === 'running') {
      const interval = setInterval(refreshStatus, 1000);
      return () => clearInterval(interval);
    }
  }, [summaryHandler, sessionId, sessionStatus.status]);

  // 🔥 判断是否正在运行（基于 SummaryHandler 的状态）
  const isRunning = sessionStatus.status === 'running';

  // 🔥 获取开始时间（优先使用 SummaryHandler 的记录，否则使用第一条消息时间）
  const startTime = useMemo(() => {
    if (sessionStatus.startTime) {
      return new Date(sessionStatus.startTime).getTime();
    }
    if (messages.length === 0) return null;
    const firstMessage = messages[0];
    return firstMessage.timestamp ? new Date(firstMessage.timestamp).getTime() : null;
  }, [sessionStatus.startTime, messages]);

  // 🔥 获取结束时间（优先使用 SummaryHandler 的记录）
  const endTime = useMemo(() => {
    if (sessionStatus.endTime) {
      return new Date(sessionStatus.endTime).getTime();
    }
    return null;
  }, [sessionStatus.endTime]);

  // 🔥 实时更新计时器（只在 Session 运行时更新）
  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning]);

  // 🔥 计算持续时间
  const duration = useMemo(() => {
    if (!startTime) return 0;
    if (endTime) {
      // Session 已结束，使用 SummaryHandler 记录的结束时间
      return endTime - startTime;
    }
    if (!isRunning && messages.length > 0) {
      // Session 已结束（从数据库加载，没有 SummaryHandler 记录），使用最后一条消息的时间戳
      const lastMessage = messages[messages.length - 1];
      const lastTime = lastMessage.timestamp ? new Date(lastMessage.timestamp).getTime() : null;
      if (lastTime) {
        return lastTime - startTime;
      }
    }
    // Session 运行中，使用当前时间
    return now - startTime;
  }, [startTime, endTime, isRunning, messages, now]);

  const handleKillSession = () => {
    if (summaryHandler && sessionId) {
      summaryHandler.killSession(sessionId);
    }
  };

  if (messages.length === 0) return null;

  return (
    <div className="relative pl-4 mb-3 before:absolute before:left-0 before:top-4 before:bottom-2 before:w-0.5 before:bg-gray-200 dark:before:bg-gray-700 before:rounded-full">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 py-1 text-left group"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors" />
        )}

        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 group-hover:text-gray-700 dark:group-hover:text-gray-300 transition-colors">
          {getGroupDisplayName(messages)}
        </span>

        <span className="text-xs text-gray-300 dark:text-gray-600">
          ·
        </span>

        <span className="text-xs text-gray-400 dark:text-gray-500">
          {messages.length}条
        </span>

        {/* 🔥 计时器 */}
        {startTime && (
          <>
            <span className="text-xs text-gray-300 dark:text-gray-600">
              ·
            </span>
            <span className={cn(
              "text-xs font-mono",
              isRunning
                ? "text-blue-500 dark:text-blue-400"
                : "text-gray-400 dark:text-gray-500"
            )}>
              {formatDuration(duration)}
            </span>
          </>
        )}

        {!isExpanded && (
          <>
            <span className="text-xs text-gray-300 dark:text-gray-600">
              ·
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[200px]">
              {getLastMessageSummary(messages)}
            </span>
          </>
        )}

        {summaryHandler && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleKillSession();
            }}
            className={cn(
              'ml-auto p-1 rounded',
              'text-gray-300 dark:text-gray-600',
              'hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20',
              'transition-colors'
            )}
            title="终止此 Session"
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
        )}
      </button>

      {/* 消息列表 */}
      {isExpanded && (
        <div className="mt-1">
          {messages.map((message, index) => (
            <div 
              key={message.id} 
              className={cn(
                "py-1.5",
                index > 0 && "border-t border-gray-100 dark:border-gray-800"
              )}
            >
              <MessageContent
                message={message}
                icon={
                  <MessageIcon
                    apiRole={message.apiRole}
                    status={message.status}
                    iconText={message.iconText}
                  />
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SessionMessageGroup;
