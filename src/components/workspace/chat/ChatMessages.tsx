import React, { useEffect, useRef, useCallback, useMemo, useState, useLayoutEffect } from 'react';
import { Message } from '../types/ChatTypes';
import MessageBubble from './MessageBubble';
import ProcessingIndicator from './ProcessingIndicator';
import WaveformLoader from "@/components/ui/waveform-loader";
import { useTranslation } from "react-i18next";
import { useAuth } from '@/context/AuthContext';
import { SessionMessageGroup } from './ChatMessageItem/SessionMessageGroup';
import { MessageData } from './ChatMessageItem/types';

interface ChatMessagesProps {
  messages: Message[];
  isProcessing: boolean;
  onFileView?: (file: any) => void;
  onFileDownload?: (file: any) => void;
  currentConversationId?: string | null;
  onPlanApprove?: (planId: string) => void;
  onPlanReject?: (planId: string, feedback: string) => void;
  onStepInput?: (stepId: string, input: Record<string, any>) => void;
  onLoadMore?: () => Promise<boolean>;
}

/**
 * 滚动状态枚举
 * - initial: 初始化状态，需要检测内容高度决定是否滚动到底部
 * - following: 跟随模式，自动滚动到底部（isProcessing 或用户在底部）
 * - browsing: 浏览模式，用户往上拖动查看历史，不自动滚动
 * - loading: 加载历史消息模式，保持用户位置
 */
type ScrollState = 'initial' | 'following' | 'browsing' | 'loading';

/**
 * 聊天消息组件
 * 
 * 统一设计方案：
 * 1. 排列方式：始终使用 justify-start（从顶部排列），避免跷跷板效应
 * 2. 滚动逻辑：
 *    - 初始化：内容填满容器 → 滚动到底部；否则不滚动
 *    - isProcessing：强制滚动到底部（跟随最新消息）
 *    - 用户在底部（距离 < 100px）：进入 following 模式，自动滚动
 *    - 用户离开底部（距离 > 150px）：进入 browsing 模式，不自动滚动
 *    - 加载更多：保持用户位置
 * 3. 自动加载：内容高度 < 容器高度时，自动加载更多历史消息（总量上限500条）
 */
const ChatMessages: React.FC<ChatMessagesProps> = ({ 
  messages, 
  isProcessing, 
  onFileView, 
  onFileDownload,
  currentConversationId,
  onPlanApprove,
  onPlanReject,
  onStepInput,
  onLoadMore,
}) => {
  // 🔥 在组件顶层调用 hooks（不能在条件分支中调用）
  const { isLoading: isAuthLoading } = useAuth();
  const { t } = useTranslation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  
  // 🔥 统一的滚动状态管理
  const scrollStateRef = useRef<ScrollState>('initial');
  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);
  
  // 🔥 对话切换相关
  const prevConversationIdRef = useRef<string | null>(null);
  const autoLoadAttemptsRef = useRef(0); // 保留用于调试计数

  // 🔥 填充式加载：移除固定5次限制，改为总量上限
  // 当 ReAct 子消息被折叠时，20 条原始消息可能只渲染为 1 行，
  // 需要持续加载直到视觉上填满容器
  const MAX_INITIAL_LOAD = 500; // 原始消息总量安全上限
  const isLoadingMoreRef = useRef(false); // 并发加载互斥锁
  
  // 🔥 内容高度状态（用于判断是否需要滚动到底部）
  const [contentFillsContainer, setContentFillsContainer] = useState(false);

  // 🔥 滚动到底部
  const scrollToBottom = useCallback((behavior: 'smooth' | 'auto' = 'smooth') => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: behavior
      });
    }
  }, []);

  // 🔥 检测用户是否在底部
  const isUserAtBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < 100;
  }, []);

  // 🔥 检测内容是否填满容器（使用 useLayoutEffect 确保测量时机正确）
  const checkContentHeight = useCallback(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content) return false;

    const contentHeight = content.scrollHeight;
    const containerHeight = container.clientHeight;
    return contentHeight >= containerHeight;
  }, []);

  // 🔥 分组消息
  const { groupedMessages, ungroupedMessages } = useMemo(() => {
    const grouped: Map<string, { sessionId: string; messages: MessageData[]; firstTimestamp: number }> = new Map();
    const ungrouped: Message[] = [];

    for (const message of messages) {
      if (message.role === 'user') {
        ungrouped.push(message);
        continue;
      }

      if (message.role === 'auto' && 
          (message.apiRole === 'reactor' || message.apiRole === 'summarizer') &&
          message.sessionId) {
        const sessionId = message.sessionId;
        
        if (!grouped.has(sessionId)) {
          const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : (message.timestamp || Date.now());
          grouped.set(sessionId, { sessionId, messages: [], firstTimestamp: timestamp });
        }
        grouped.get(sessionId)!.messages.push({
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
          memory: message.memory,
        });
      } else {
        ungrouped.push(message);
      }
    }

    return { groupedMessages: grouped, ungroupedMessages: ungrouped };
  }, [messages]);

  // 🔥 构建渲染列表
  const renderItems = useMemo(() => {
    const items: Array<
      | { type: 'ungrouped'; message: Message }
      | { type: 'grouped'; groupKey: string; groupData: { sessionId: string; messages: MessageData[]; firstTimestamp: number } }
    > = [];

    for (const message of ungroupedMessages) {
      items.push({ type: 'ungrouped', message });
    }

    for (const [groupKey, groupData] of groupedMessages.entries()) {
      items.push({ type: 'grouped', groupKey, groupData });
    }

    items.sort((a, b) => {
      const getTimestamp = (item: typeof items[0]): number => {
        if (item.type === 'ungrouped') {
          const ts = item.message.timestamp;
          return ts instanceof Date ? ts.getTime() : (ts || 0);
        }
        return item.groupData.firstTimestamp;
      };
      return getTimestamp(a) - getTimestamp(b);
    });

    return items;
  }, [ungroupedMessages, groupedMessages]);

  // 🔥 场景1：对话切换时重置状态
  useEffect(() => {
    if (currentConversationId !== prevConversationIdRef.current) {
      scrollStateRef.current = 'initial';
      prevConversationIdRef.current = currentConversationId;
      autoLoadAttemptsRef.current = 0;
      isLoadingMoreRef.current = false; // 🔥 重置加载锁
      setContentFillsContainer(false);
    }
  }, [currentConversationId]);

  // 🔥 场景2：isProcessing 状态变化
  useEffect(() => {
    if (isProcessing) {
      // isProcessing 开始时，强制进入 following 模式
      scrollStateRef.current = 'following';
      scrollToBottom('smooth');
    }
  }, [isProcessing, scrollToBottom]);

  // 🔥 场景3：消息变化时的滚动处理（使用 useLayoutEffect 确保测量时机）
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content || messages.length === 0) return;

    // 🔥 检测内容是否填满容器
    const fillsContainer = checkContentHeight();
    setContentFillsContainer(fillsContainer);

    // 根据滚动状态决定行为
    const state = scrollStateRef.current;

    if (state === 'initial') {
      // 初始化：如果内容填满容器，滚动到底部；否则不滚动
      if (fillsContainer) {
        scrollToBottom('auto');
      }
      scrollStateRef.current = 'following';
    } else if (state === 'following') {
      // 跟随模式：如果内容填满容器，自动滚动到底部
      if (fillsContainer) {
        scrollToBottom('smooth');
      }
    } else if (state === 'loading') {
      // 加载模式：恢复用户位置
      const prevHeight = prevScrollHeightRef.current;
      const prevTop = prevScrollTopRef.current;
      const newHeight = container.scrollHeight;
      const heightDiff = newHeight - prevHeight;
      container.scrollTop = prevTop + heightDiff;
      scrollStateRef.current = 'browsing'; // 加载完成后进入浏览模式
    }
    // browsing 模式：不做任何滚动
  }, [messages, renderItems, scrollToBottom, checkContentHeight]);

  // 🔥 场景4：自动加载更多内容（内容不够填满容器时）
  // 🔥 修复：移除固定5次重试限制，改为总消息量上限
  // 当 ReAct 子消息被折叠时，20 条原始消息可能只渲染为 1 行，
  // 导致 contentFillsContainer 为 false，需要持续加载直到视觉上填满容器
  useEffect(() => {
    if (!currentConversationId || currentConversationId === 'null') return;
    if (messages.length === 0) return;
    if (!onLoadMore) return;
    if (scrollStateRef.current !== 'initial' && scrollStateRef.current !== 'following') return;
    if (contentFillsContainer) return; // 🔥 内容已填满容器，不需要加载
    if (messages.length >= MAX_INITIAL_LOAD) return; // 🔥 总量安全上限
    if (isLoadingMoreRef.current) return; // 🔥 防止并发加载

    // 🔥 使用 requestAnimationFrame 确保 DOM 布局完成后再检测
    // 避免在 React 批量更新期间重复触发
    const rafId = requestAnimationFrame(() => {
      // 再次检查 DOM 高度（React 可能在 raf 之前已更新了 DOM）
      const fillsNow = checkContentHeight();
      if (fillsNow) {
        setContentFillsContainer(true);
        return;
      }

      isLoadingMoreRef.current = true;
      autoLoadAttemptsRef.current++; // 保留计数用于调试
      onLoadMore().then((hasMore) => {
        isLoadingMoreRef.current = false;
        if (!hasMore) {
          // 没有更多消息可加载了，标记内容已填满以停止后续尝试
          setContentFillsContainer(true);
        }
      });
    });

    return () => cancelAnimationFrame(rafId);
  }, [currentConversationId, messages.length, onLoadMore, contentFillsContainer, checkContentHeight]);

  // 🔥 场景5：用户滚动处理
  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // 用户滚动到底部：进入 following 模式
    if (distanceFromBottom < 100) {
      scrollStateRef.current = 'following';
      return;
    }

    // 用户往上拖动超过 150px：进入 browsing 模式
    if (distanceFromBottom > 150 && scrollStateRef.current !== 'loading') {
      scrollStateRef.current = 'browsing';
    }

    // 滚动到顶部：加载更多历史消息
    if (scrollTop <= 50 && onLoadMore && scrollStateRef.current !== 'loading') {
      scrollStateRef.current = 'loading';
      prevScrollHeightRef.current = scrollHeight;
      prevScrollTopRef.current = scrollTop;

      const success = await onLoadMore();
      if (!success) {
        scrollStateRef.current = 'browsing';
      }
    }
  }, [onLoadMore]);

  // 🔥 空conversationId时不渲染消息
  if (!currentConversationId || currentConversationId === 'null') {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center text-gray-400">
          {isAuthLoading ? (
            <>
              <p className="text-sm mb-3">{t('workspace.chatMessages.initializing', '正在初始化')}</p>
              <div className="flex items-center justify-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-[initPulse_1.4s_ease-in-out_infinite]" />
                <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-[initPulse_1.4s_ease-in-out_0.2s_infinite]" />
                <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-[initPulse_1.4s_ease-in-out_0.4s_infinite]" />
                <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-[initPulse_1.4s_ease-in-out_0.6s_infinite]" />
              </div>
              <style>{`
                @keyframes initPulse {
                  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
                  40% { opacity: 1; transform: scale(1.2); }
                }
              `}</style>
            </>
          ) : (
            <p className="text-lg mb-2">{t('workspace.chatMessages.greeting')}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 max-h-full overflow-hidden relative">
      <div
        ref={scrollContainerRef}
        className="h-full w-full overflow-y-auto overflow-x-hidden bg-gray-100"
        onScroll={handleScroll}
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d1d5db transparent',
        }}
      >
        {/* 🔥 始终使用 justify-start（从顶部排列），避免跷跷板效应
            ⚠️ 禁止加 min-h-full：它会让 content.scrollHeight 恒 ≥ 容器高，
            checkContentHeight 永远判定"已填满"，初始不满屏自动补载机制失效
            （两行内容+大片空白+滚动条拖不动的根因） */}
        <div
          ref={contentRef}
          className="p-4 space-y-1 flex flex-col justify-start"
        >
          {messages.length === 0 ? (
            <div className="flex items-center justify-center" style={{ height: 'calc(100vh - 200px)' }}>
              <WaveformLoader size={32} color="#10B981" />
            </div>
          ) : (
            <>
              {renderItems.map((item) => {
                if (item.type === 'ungrouped') {
                  return (
                    <MessageBubble
                      key={item.message.id}
                      message={item.message}
                      conversationId={currentConversationId}
                      onFileView={onFileView}
                      onFileDownload={onFileDownload}
                      onPlanApprove={onPlanApprove}
                      onPlanReject={onPlanReject}
                      onStepInput={onStepInput}
                    />
                  );
                } else {
                  return (
                    <SessionMessageGroup
                      key={`session-${item.groupKey}`}
                      sessionId={item.groupData.sessionId}
                      messages={item.groupData.messages}
                    />
                  );
                }
              })}
              {isProcessing && <ProcessingIndicator />}
            </>
          )}
        </div>
      </div>

      {/* 上下渐隐遮罩 */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-gray-100/70 to-transparent" />
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-gray-100/70 to-transparent" />
    </div>
  );
};

export default ChatMessages;