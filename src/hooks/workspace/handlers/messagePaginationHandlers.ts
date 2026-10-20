import { Message } from '@/components/workspace/types/ChatTypes';

import { mapDbAttachmentsToFileAttachments } from './message/messageMappers';
import { messageStorage, storageMode } from '@/services/storage';

/**
 * 🔥 消息分页加载器 - 支持懒加载和虚拟滚动
 * 
 * 排序策略：
 * - 数据库统一返回 DESC 顺序（按 created_at 从新到旧）
 * - 前端反转后显示 ASC 顺序（最上面 = 最早的消息，最下面 = 最新的消息）
 * - 这样分页查询时，limit 20 offset 0 返回的是最新的 20 条
 * 
 * 主要特性：
 * - 初始加载最新20条消息
 * - 上滑时加载更早的消息
 * - 缓存已加载范围，避免重复查询
 * - 支持计算总消息数
 */

const MESSAGES_PER_PAGE = 50;

interface PaginationState {
  conversationId: string;
  totalCount: number; // 总消息数
  loadedMessages: Message[];
  isLoading: boolean;
  hasMore: boolean; // 是否还有更多消息
  oldestTimestamp: Date | null; // 已加载最早的消息时间戳
  newestTimestamp: Date | null; // 已加载最新的消息时间戳
  currentOffset: number; // 当前已加载的偏移量（用于分页）
}

// 全局分页状态缓存
const paginationStateMap = new Map<string, PaginationState>();

/**
 * 格式化数据库消息为前端消息对象
 * 兼容 SQLite (时间戳number) 和 ISO 字符串两种格式
 */
const formatDatabaseMessages = (dbMessages: any[]): Message[] => {
  return dbMessages.map(msg => {
    // 🔥 兼容处理：SQLite 返回的是时间戳数字，历史数据可能是 ISO 字符串
    const createdAt = msg.created_at;
    let timestamp: Date;

    if (typeof createdAt === 'number') {
      // SQLite 格式：时间戳（毫秒）
      timestamp = new Date(createdAt);
    } else if (typeof createdAt === 'string') {
      // ISO 字符串
      timestamp = new Date(createdAt);
    } else {
      // 默认使用当前时间
      timestamp = new Date();
    }
    
    // 🔥 解析 metadata（SQLite 存储为 JSON 字符串）
    let metadata = msg.metadata || {};
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch (e) {
        metadata = {};
      }
    }
    
    return {
      id: msg.id,
      role: msg.role as 'user' | 'assistant' | 'system' | 'auto',
      content: msg.content,
      timestamp: timestamp,
      files: mapDbAttachmentsToFileAttachments(msg.files as any[] || []),
      apiRole: msg.api_role,
      result: msg.result,
      status: msg.status,
      callId: msg.call_id,
      iconText: msg.icon_text,
      sessionId: msg.session_id,
      memory: msg.memory,
      metadata: {
        // 🔥 保留 DB metadata（含 source 标签），再叠加加载上下文字段
        ...(metadata as Record<string, any>),
        conversationId: msg.conversation_id,
        isSnapshotMode: msg.role === 'auto'
      },
      source: (metadata as any)?.source // 🔥 userQuery 来源标签（'email'=离线邮件指挥，缺省 chat）
    };
  });
};

/**
 * 🔥 初始化分页状态 - 仅加载最新20条消息
 */
export const initializeMessagePagination = async (
  conversationId: string,
  setMessages: (callback: (prev: Message[]) => Message[]) => void,
  setIsProcessing?: (isProcessing: boolean) => void
): Promise<void> => {
  if (!conversationId || conversationId === 'null' || conversationId === 'undefined') {
    console.error('❌ [MESSAGE-PAGINATION] 无效的conversationId:', conversationId);
    setMessages(() => []);
    setIsProcessing?.(false);
    return;
  }

  try {
    const [messages, totalCount] = await Promise.all([
      messageStorage.getByConversationId(conversationId, MESSAGES_PER_PAGE, 0),
      messageStorage.getCount(conversationId)
    ]);

    if (messages && messages.length > 0) {
      const reversedMessages = [...messages].reverse();
      const formattedMessages = formatDatabaseMessages(reversedMessages);

      const state: PaginationState = {
        conversationId,
        totalCount: totalCount || 0,
        loadedMessages: formattedMessages,
        isLoading: false,
        hasMore: (totalCount || 0) > MESSAGES_PER_PAGE,
        oldestTimestamp: formattedMessages[0]?.timestamp || null,
        newestTimestamp: formattedMessages[formattedMessages.length - 1]?.timestamp || null,
        currentOffset: formattedMessages.length
      };

      paginationStateMap.set(conversationId, state);

      setMessages(() => {
        state.loadedMessages = formattedMessages;
        return formattedMessages;
      });
    } else {
      paginationStateMap.set(conversationId, {
        conversationId,
        totalCount: 0,
        loadedMessages: [],
        isLoading: false,
        hasMore: false,
        oldestTimestamp: null,
        newestTimestamp: null,
        currentOffset: 0
      });

      setMessages(() => []);
    }
  } catch (error) {
    console.error('❌ [MESSAGE-PAGINATION] 初始化异常:', error);
    setMessages(() => []);
    setIsProcessing?.(false);
  }
};

/**
 * 🔥 加载更早的消息 - 上滑时调用
 * 
 * @param conversationId - 对话ID
 * @param setMessages - 消息更新回调
 * @returns 是否成功加载了更多消息
 */
export const loadMoreMessagesBackward = async (
  conversationId: string,
  setMessages: (callback: (prev: Message[]) => Message[]) => void
): Promise<boolean> => {
  const state = paginationStateMap.get(conversationId);
  
  if (!state) return false;
  if (state.isLoading) return false;
  if (!state.hasMore) return false;

  state.isLoading = true;

  try {
    // 🔥 使用 offset 加载更早的消息（数据库返回 DESC 顺序：新→旧）
    const olderMessages = await messageStorage.getByConversationId(
      conversationId, 
      MESSAGES_PER_PAGE, 
      state.currentOffset
    );

    if (!olderMessages || olderMessages.length === 0) {
      state.hasMore = false;
      state.isLoading = false;
      return false;
    }

    // 🔥 数据库返回 DESC 顺序（新→旧），需要反转为 ASC 顺序
    const reversedOlderMessages = [...olderMessages].reverse();
    const formattedOlderMessages = formatDatabaseMessages(reversedOlderMessages);

    // 更新分页状态（新加载的消息放在前面，因为它们是更早的消息）
    // 🔥 去重：避免重复添加已存在的消息
    const existingIds = new Set(state.loadedMessages.map(m => m.id));
    const uniqueOlderMessages = formattedOlderMessages.filter(m => !existingIds.has(m.id));
    
    state.loadedMessages = [...uniqueOlderMessages, ...state.loadedMessages];
    state.oldestTimestamp = formattedOlderMessages[0]?.timestamp || state.oldestTimestamp;
    state.currentOffset += olderMessages.length;
    state.hasMore = olderMessages.length === MESSAGES_PER_PAGE;

    // 🔥 修复：使用回调函数保留实时消息
    setMessages((prev: Message[]) => {
      // 🔥 合并历史消息和实时消息
      const prevIds = new Set(prev.map(m => m.id));
      const uniqueNewOlderMessages = formattedOlderMessages.filter(m => !prevIds.has(m.id));
      return [...uniqueNewOlderMessages, ...prev];
    });
    state.isLoading = false;
    return true;
  } catch (error) {
    state.isLoading = false;
    return false;
  }
};

/**
 * 🔥 加载更新的消息 - 下滑时调用（可选，用于实时消息）
 */
export const loadMoreMessagesForward = async (
  conversationId: string,
  setMessages: (callback: (prev: Message[]) => Message[]) => void
): Promise<boolean> => {

  const state = paginationStateMap.get(conversationId);
  
  if (!state || !state.newestTimestamp) {
    return false;
  }

  state.isLoading = true;

  try {
    // 🔥 使用统一的存储服务加载更新的消息（支持本地/在线双模式）
    // 注意：本地存储暂时不支持基于时间戳的分页，加载所有消息
    const allMessages = await messageStorage.getByConversationId(conversationId, 1000, 0);
    
    // 过滤出比当前最新消息更新的消息
    const newerMessages = allMessages.filter((msg: any) => {
      const msgTime = new Date(msg.created_at).getTime();
      return msgTime > state.newestTimestamp!.getTime();
    }).sort((a: any, b: any) => 
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ).slice(0, MESSAGES_PER_PAGE);

    if (!newerMessages || newerMessages.length === 0) {
      state.isLoading = false;
      return false;
    }

    const formattedNewerMessages = formatDatabaseMessages(newerMessages);

    // 更新分页状态
    // 🔥 去重：避免重复添加已存在的消息
    const existingIds = new Set(state.loadedMessages.map(m => m.id));
    const uniqueNewerMessages = formattedNewerMessages.filter(m => !existingIds.has(m.id));
    
    state.loadedMessages = [...state.loadedMessages, ...uniqueNewerMessages];
    state.newestTimestamp = formattedNewerMessages[formattedNewerMessages.length - 1]?.timestamp || state.newestTimestamp;


    setMessages(() => [...state.loadedMessages]);
    state.isLoading = false;
    return true;
  } catch (error) {
    state.isLoading = false;
    return false;
  }
};

/**
 * 🔥 清理指定对话的分页状态
 */
export const clearPaginationState = (conversationId: string): void => {
  paginationStateMap.delete(conversationId);
};

/**
 * 🔥 获取分页统计信息（用于调试和状态显示）
 */
export const getPaginationStats = (conversationId: string) => {
  const state = paginationStateMap.get(conversationId);

  if (!state) {
    return null;
  }

  return {
    conversationId,
    loadedCount: state.loadedMessages.length,
    totalCount: state.totalCount,
    loadedPercentage: state.totalCount > 0
      ? Math.round((state.loadedMessages.length / state.totalCount) * 100)
      : 0,
    hasMore: state.hasMore,
    isLoading: state.isLoading,
    oldestTime: state.oldestTimestamp?.toISOString(),
    newestTime: state.newestTimestamp?.toISOString()
  };
};

/**
 * 🔥 获取已缓存的消息快照（缓存命中时回填界面用）
 * 场景：切换账号/切回历史会话时 messages 已被清空，若分页缓存命中直接 return 不回填，
 * 界面会因 messages.length === 0 永远显示加载动画（ChatMessages 的 WaveformLoader）
 */
export const getCachedLoadedMessages = (conversationId: string): Message[] | null => {
  const state = paginationStateMap.get(conversationId);
  if (!state || state.loadedMessages.length === 0) return null;
  return state.loadedMessages;
};
