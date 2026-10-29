import React, { useEffect, useRef, useCallback, useMemo, useState, useLayoutEffect } from 'react';
import { Message } from '../types/ChatTypes';
import MessageBubble from './MessageBubble';
import ProcessingIndicator from './ProcessingIndicator';
import WaveformLoader from "@/components/ui/waveform-loader";
import { useTranslation } from "react-i18next";
import { useAuth } from '@/context/AuthContext';
import { SessionMessageGroup } from './ChatMessageItem/SessionMessageGroup';
import { MessageData } from './ChatMessageItem/types';
import { TraceReportApi } from '@/services/cloud/CloudApiClient';
import { ApiClient } from '@/utils/ApiClient';
import { Clapperboard, ArrowUpCircle, Check, Loader2, XCircle } from 'lucide-react';
import { isInjectedMessage } from '@/utils/auto/context/RoundMemory';

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

// ============================================================================
// 🔥 回合轨迹复制/上报
// 回合 = 一条 user 消息到下一条 user 消息之前的全部消息（消息流天然分段）：
// 无需"回合终止符"——正常收尾/中途 abort/关机全都自动成立（复制边界=数组切片）。
// ============================================================================

// 单段文本截断上限：终端输出可能极大，超限截断并标注原长
const TRACE_TEXT_CAP = 8000;

const capTraceText = (text: string): string =>
  text.length > TRACE_TEXT_CAP ? `${text.slice(0, TRACE_TEXT_CAP)}…(截断，共${text.length}字)` : text;

const formatTimestampHMS = (ts: Message['timestamp']): string => {
  const d = ts instanceof Date ? ts : new Date(ts || Date.now());
  return d.toTimeString().slice(0, 8);
};

/**
 * 把一个回合的消息切片格式化为可粘贴给 LLM 研究的轨迹文本
 * - summarizer 取 result（最终报告），reactor 取 content（动作描述）+ result（工具输出）
 * - 空文本消息跳过，段落间空行分隔
 */
const formatRoundTrace = (round: Message[]): string => {
  const lines: string[] = [];
  round.forEach((m, idx) => {
    const time = formatTimestampHMS(m.timestamp);
    const label = m.apiRole
      ? `${m.apiRole}${m.iconText ? `·${m.iconText}` : ''}`
      : m.role;
    if (m.apiRole === 'summarizer') {
      const text = m.result || m.content || '';
      if (text) lines.push(`[${idx}] ${label} ${time}\n${capTraceText(text)}`);
    } else if (m.apiRole === 'reactor') {
      const text = m.content || '';
      if (text) lines.push(`[${idx}] ${label} ${time}\n${capTraceText(text)}`);
      if (m.result) lines.push(`[输出] ${capTraceText(m.result)}`);
    } else {
      const text = m.content || '';
      if (text) lines.push(`[${idx}] ${label} ${time}\n${capTraceText(text)}`);
    }
  });
  return lines.join('\n\n');
};

/**
 * 回合切片：锚点消息（回合内任意消息，如组头按钮传组内首条）→ 所在回合全部消息。
 * 从锚点向前扫到最近的 user 消息即回合起点，到下一条 user 消息前即回合终点。
 * 🔥 注入消息（process 内用户追加，content 带「---✅ 消息已加入队列」）不是回合起点，
 *    与 RoundMemory.splitRounds 的回合分割语义对齐，否则复制/上报轨迹的回合边界会被注入消息切碎。
 */
const getRoundSlice = (messages: Message[], anchorId: string): Message[] | null => {
  const isRoundStart = (m: Message) => m.role === 'user' && !isInjectedMessage(m);
  const idx = messages.findIndex((m) => m.id === anchorId);
  if (idx < 0) return null;
  let start = idx;
  while (start > 0 && !isRoundStart(messages[start])) start--;
  if (!isRoundStart(messages[start])) return null;
  let end = messages.length;
  for (let i = start + 1; i < messages.length; i++) {
    if (isRoundStart(messages[i])) { end = i; break; }
  }
  return messages.slice(start, end);
};

// 🔥 token 计数格式化：1234 → 1.2k、1234567 → 1.23M（回合末尾「| token: xx」用）
const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

/**
 * 🔥 回合末尾工具行：复制/上报整个回合轨迹，挂在本回合最后一个渲染项下方（用户习惯位置）。
 * 正常收尾=最终 summarizer/SubAgent 卡片下面；abort/关机后最后剩什么就挂什么下面。
 * tokens>0 时追加「| token: xx」——本回合全部 LLM 调用消耗（local-backend token-usage 按 sessionId 聚合）。
 */
const RoundTraceActions: React.FC<{
  onCopy: () => Promise<void>;
  onReport: () => Promise<boolean>;
  tokens?: number;
}> = ({ onCopy, onReport, tokens }) => {
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');

  return (
    <div className="flex items-center gap-0.5 mb-3">
      <button
        onClick={async () => {
          try {
            await onCopy();
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch { /* 忽略 */ }
        }}
        className="p-1 rounded text-gray-400 dark:text-gray-500 hover:text-gray-700 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 dark:hover:text-gray-300 transition-colors"
        title={copied ? '已复制本回合完整轨迹' : '复制本回合完整轨迹'}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Clapperboard className="w-3.5 h-3.5" />}
      </button>
      <button
        disabled={state !== 'idle'}
        onClick={async () => {
          if (state !== 'idle') return; // pending 防重入；done 锁定——同一回合上报一次即止（防频繁上报打爆服务端）
          setState('pending');
          try {
            const ok = await onReport();
            if (ok) {
              setState('done'); // 成功后锁定不回退（绿对勾常驻），失败才恢复可点
            } else {
              setState('error');
              setTimeout(() => setState('idle'), 2000);
            }
          } catch {
            setState('error');
            setTimeout(() => setState('idle'), 2000);
          }
        }}
        className="p-1 rounded text-gray-400 dark:text-gray-500 hover:text-gray-700 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 dark:hover:text-gray-300 transition-colors disabled:cursor-default"
        title={state === 'done'
          ? '已上报，服务端保留 7 天'
          : state === 'error'
          ? '上报失败，请稍后重试'
          : '上报本回合轨迹'}
      >
        {state === 'pending' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : state === 'done' ? (
          <Check className="w-3.5 h-3.5 text-green-500" />
        ) : state === 'error' ? (
          <XCircle className="w-3.5 h-3.5 text-red-400" />
        ) : (
          <ArrowUpCircle className="w-3.5 h-3.5" />
        )}
      </button>
      {typeof tokens === 'number' && tokens > 0 && (
        <span
          className="ml-1 text-[11px] text-gray-400 dark:text-gray-500 select-none"
          title="本回合 LLM 调用总 token（输入+输出，输入含缓存命中部分，搜索场景输入会偏大）"
        >
          | Token: {formatTokenCount(tokens)}
        </span>
      )}
    </div>
  );
};

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

  // 🔥 回合 token 消耗：local-backend 的 token-usage 按 react sessionId 聚合每次 LLM 调用记录，
  // 回合内 session group 的 key 就是 react sessionId，按 key 求和即为该回合总消耗。
  // 拉取时机：挂载 / isProcessing 翻转（任务结束必拉，拿最终值）/ 消息增长（10s 节流防刷请求）。
  // 无记录（旧消息、纯聊天无 react 会话）→ Map 空 → 按钮行不显示「| token: xx」。
  const [sessionTokens, setSessionTokens] = useState<Map<string, number>>(new Map());
  const [summaryByKey, setSummaryByKey] = useState<Map<string, number>>(new Map());
  const lastFetchAtRef = useRef(0);
  const wasProcessingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fetchAggregates = async () => {
      // 任务刚结束（false 翻转）绕过节流，拿最终 token 数；其余 10s 节流
      const force = !isProcessing && wasProcessingRef.current;
      wasProcessingRef.current = isProcessing;
      const now = Date.now();
      if (!force && now - lastFetchAtRef.current < 10_000) return;
      lastFetchAtRef.current = now;
      try {
        // 🔥 窗口取 365 天：对话里的历史回合可能跨越数日前（此前 days=2，两天前的回合
        // session 聚合查不到 → 历史回合一律不显示 token，被误读成"全累加到最后回合"）
        const resp = await ApiClient.llm.sessionAggregates(365);
        const list = resp?.data;
        if (cancelled || !Array.isArray(list)) return;
        const map = new Map<string, number>();
        for (const agg of list) {
          if (agg?.sessionId && typeof agg.totalTokens === 'number') {
            map.set(agg.sessionId, agg.totalTokens);
          }
        }
        setSessionTokens(map);
      } catch { /* 增强功能，拉取失败静默 */ }

      // 🔥 summary token 按回合时间窗聚合：thinking/最终报告记录键是 conversationId（无法按
      // session 归属），前端发回合时间窗，后端求窗口内 summary 记录总和（含纯聊天回合）
      const rounds = roundMetaRef.current;
      if (!cancelled && currentConversationId && rounds.length > 0) {
        try {
          const resp2 = await ApiClient.llm.summaryWindows(
            String(currentConversationId),
            rounds.map(r => ({ startTs: r.startTs, endTs: r.endTs }))
          );
          const totals = resp2?.data;
          if (!cancelled && Array.isArray(totals)) {
            const m = new Map<string, number>();
            rounds.forEach((r, i) => {
              if ((totals[i] || 0) > 0) m.set(r.key, totals[i]);
            });
            setSummaryByKey(m);
          }
        } catch { /* 同上，静默 */ }
      }
    };
    fetchAggregates();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProcessing, messages.length]);

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

  // 🔥 回合末尾标记：每回合最后一个渲染项（下一条 user 消息出现前的最后一项）。
  // 渲染列表天然分段，无需"回合终止符"；abort/关机后最后剩什么，按钮就挂什么下面
  // 🔥 注入消息（isInjectedMessage）不是回合起点，不触发封口——它属于当前回合内部，
  //    作为普通渲染项参与"最后渲染项"竞争，轨迹按钮随回合推进后移
  const roundEndKeys = useMemo(() => {
    const keys = new Set<string>();
    let last: string | null = null;
    for (const item of renderItems) {
      if (item.type === 'ungrouped' && item.message.role === 'user' && !isInjectedMessage(item.message)) {
        if (last) keys.add(last);
        last = null;
      } else {
        last = item.type === 'ungrouped' ? item.message.id : `session-${item.groupKey}`;
      }
    }
    // 🔥 闸门只作用于最后一段（正在行进的回合）：isProcessing（与发送按钮同源的准确行进信号）+
    //    消息 status 兜底（streaming 僵死超 10 分钟放行）。历史回合（前面封口段）不受影响，按钮常驻
    if (last && !isProcessing) {
      const lastMsg = messages[messages.length - 1];
      const lastTs = lastMsg?.timestamp ? new Date(lastMsg.timestamp).getTime() : 0;
      const isStreaming = !!lastMsg
        && (lastMsg.status === 'streaming' || lastMsg.status === 'pending')
        && Date.now() - lastTs < 10 * 60 * 1000;
      if (!isStreaming) keys.add(last);
    }
    return keys;
  }, [renderItems, messages, isProcessing]);

  // 🔥 每回合元数据：回合分割与 roundEndKeys 完全同构（user 消息封口，注入消息不封口）。
  // key = roundEndKeys 同款 itemKey；sessions = 回合内 session group 的 react sessionId 列表；
  // startTs/endTs = 回合时间窗（summary 记录键是 conversationId，按窗聚合 thinking/最终报告 token）
  const roundMeta = useMemo(() => {
    const rounds: Array<{ key: string; sessions: string[]; startTs: number; endTs: number }> = [];
    let sessions: string[] = [];
    let last: string | null = null;
    let startTs = 0;
    const itemTs = (item: (typeof renderItems)[number]): number =>
      item.type === 'ungrouped'
        ? Number(item.message.timestamp || 0)
        : Number(item.groupData.messages?.[0]?.timestamp || 0);
    const flush = (endTs: number) => {
      if (last) rounds.push({ key: last, sessions: [...sessions], startTs, endTs });
      sessions = [];
    };
    for (const item of renderItems) {
      if (item.type === 'ungrouped' && item.message.role === 'user' && !isInjectedMessage(item.message)) {
        flush(startTs > 0 ? itemTs(item) - 1 : Date.now());
        startTs = itemTs(item);
        last = null;
      } else {
        if (item.type !== 'ungrouped') sessions.push(item.groupKey);
        if (startTs === 0) startTs = itemTs(item);
        last = item.type === 'ungrouped' ? item.message.id : `session-${item.groupKey}`;
      }
    }
    flush(Date.now()); // 最后一段：未封口回合，窗口到当下（行进中 token 随轮次增长）
    return rounds;
  }, [renderItems]);

  // 供 effect 读取最新值（roundMeta 不能进 effect deps，否则每轮重渲染都会发请求）
  const roundMetaRef = useRef(roundMeta);
  roundMetaRef.current = roundMeta;

  // 🔥 回合 token 总消耗 = reactor（session 聚合）+ summarizer（时间窗聚合）；无记录则无键不显示
  const roundTokenMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of roundMeta) {
      const total = r.sessions.reduce((s, id) => s + (sessionTokens.get(id) || 0), 0)
        + (summaryByKey.get(r.key) || 0);
      if (total > 0) map.set(r.key, total);
    }
    return map;
  }, [roundMeta, sessionTokens, summaryByKey]);

  // 🔥 复制/上报回合轨迹（按钮行挂在回合末尾渲染项下方，锚点=该渲染项首条消息）
  const handleCopyRoundTrace = useCallback(async (anchorId: string) => {
    const round = getRoundSlice(messages, anchorId);
    if (!round) return;
    try {
      await navigator.clipboard.writeText(formatRoundTrace(round));
    } catch (err) {
      console.error('复制回合轨迹失败:', err);
    }
  }, [messages]);

  // 🔍 上报回合轨迹到 homeweb（服务端保留 7 天）；返回是否成功供按钮反馈
  const handleReportTrace = useCallback(async (anchorId: string): Promise<boolean> => {
    const round = getRoundSlice(messages, anchorId);
    if (!round || !currentConversationId || currentConversationId === 'null') return false;
    try {
      const res = await TraceReportApi.report({ conversationId: currentConversationId, trace: formatRoundTrace(round) });
      return !!res?.success;
    } catch (err) {
      console.error('上报回合轨迹失败:', err);
      return false;
    }
  }, [messages, currentConversationId]);

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
        className="h-full w-full overflow-y-auto overflow-x-hidden bg-white"
        onScroll={handleScroll}
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d4d4d4 transparent',
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
                const itemKey = item.type === 'ungrouped' ? item.message.id : `session-${item.groupKey}`;
                const anchorId = item.type === 'ungrouped'
                  ? item.message.id
                  : item.groupData.messages[0]?.id;
                const isRoundEnd = roundEndKeys.has(itemKey);
                return (
                  <React.Fragment key={itemKey}>
                    {item.type === 'ungrouped' ? (
                      <MessageBubble
                        message={item.message}
                        conversationId={currentConversationId}
                        onFileView={onFileView}
                        onFileDownload={onFileDownload}
                        onPlanApprove={onPlanApprove}
                        onPlanReject={onPlanReject}
                        onStepInput={onStepInput}
                      />
                    ) : (
                      <SessionMessageGroup
                        sessionId={item.groupData.sessionId}
                        messages={item.groupData.messages}
                      />
                    )}
                    {isRoundEnd && anchorId && (
                      <RoundTraceActions
                        onCopy={() => handleCopyRoundTrace(anchorId)}
                        onReport={() => handleReportTrace(anchorId)}
                        tokens={roundTokenMap.get(itemKey)}
                      />
                    )}
                  </React.Fragment>
                );
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