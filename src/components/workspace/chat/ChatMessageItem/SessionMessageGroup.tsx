import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { MessageData } from './types';
import MessageContent from './MessageContent';
import MessageIcon from './MessageIcon';
import { cn } from '@/lib/utils';
import { SummaryHandler } from '@/hooks/workspace/handlers/SummaryHandler';

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
    // 🔥 summarizer 的正文在 result（总结文本）；reactor 只认 content——
    //    空 content 的工具回包不回退到 result（那是工具原始输出 JSON，如 {success,type,...}），
    //    跳过后向后扫描自然落在上一条有 content 的消息上，即"沿用上一个有 content 的"
    const content = (m.apiRole === 'summarizer' ? m.result || m.content : m.content) || '';
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

  // 🔥 从 SummaryHandler 类级账本获取 session 状态（static 账本，任何组件直接查——
  //    不再经由 useWorkspace 的 summaryHandler：那是每组件独立的 Hook 实例，
  //    本组件拿到的永远是 null，导致计时器只能走兜底——0s 定格/假活跃窗口的根源）
  const [sessionStatus, setSessionStatus] = useState<{ status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown'; startTime?: Date; endTime?: Date }>({ status: 'unknown' });

  // 🔥 定期刷新 session 状态
  const lastLoggedStatusRef = useRef<string>('');
  const mountLoggedRef = useRef(false);
  // 🔍 挂载标记：组件渲染即打（区别于状态 log）——探针哑火时区分「组件没渲染」vs「effect 没跑」
  if (!mountLoggedRef.current) {
    mountLoggedRef.current = true;
    console.log(`[SESSION-TIMER] 挂载: ${sessionId.slice(0, 8)} | 消息数=${messages.length}`);
  }
  useEffect(() => {
    const refreshStatus = () => {
      const next = SummaryHandler.getSessionStatus(sessionId);
      // 🔍 排查「计时器不停」：只在状态变化时打印，一轮运行即能看到 status/endTime 的真实流转
      if (next.status !== lastLoggedStatusRef.current) {
        console.log(`[SESSION-TIMER] ${sessionId.slice(0, 8)}: ${lastLoggedStatusRef.current || '(init)'} → ${next.status} | endTime=${next.endTime ? next.endTime.toISOString() : '无'}`);
        lastLoggedStatusRef.current = next.status;
      }
      setSessionStatus(next);
    };

    // 立即刷新一次
    refreshStatus();

    // 如果 session 正在运行，每秒刷新一次
    if (sessionStatus.status === 'running') {
      const interval = setInterval(refreshStatus, 1000);
      return () => clearInterval(interval);
    }
  }, [sessionId, sessionStatus.status, messages]);

  // 🔥 判断是否正在运行（基于 SummaryHandler 的 session 自身状态——
  //    计时器终点必须落在该 session 自己的完成时刻，不能联动 isProcessing：那是整个轮次
  //    （summarizer+reactor 串联多个 session）的行进信号，session A 完成后 reactor 还在跑 B，
  //    联动会让 A 的计时器陪跑到轮次结束）
  const isRunning = sessionStatus.status === 'running';

  // 🔥 实时活动感知：组内跨轮间隙（LLM 思考中）没有新消息，但消息仍会继续到来——
  //    只认 SummaryHandler 状态会让计时器在间隙里冻结、下轮落地时跳变（真实墙钟被切碎）。
  //    活跃窗口只服务 unknown（历史回放/状态链拿不到）：completed/failed/killed/滞留 running 一律不进
  const LIVE_WINDOW_MS = 5 * 60 * 1000;
  const lastMsgTime = useMemo(() => {
    if (messages.length === 0) return null;
    const last = messages[messages.length - 1];
    return last.timestamp ? new Date(last.timestamp).getTime() : null;
  }, [messages]);

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

  const isLive = isRunning
    // 🔥 窗口只给 unknown（历史回放/状态链缺失）；status 明确是终态或 running（被 isProcessing 修正过）都不进
    || (sessionStatus.status === 'unknown' && !endTime
        && !!lastMsgTime && now - lastMsgTime < LIVE_WINDOW_MS);

  // 🔥 实时更新计时器（活跃期间持续走字，含跨轮思考间隙）
  useEffect(() => {
    if (!isLive) return;

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, [isLive]);

  // 🔥 计算持续时间（墙钟语义：运行/活跃 → now-start 走字；已结束 → 终点-start 定格）
  const duration = useMemo(() => {
    if (!startTime) return 0;
    if (endTime) {
      // Session 已结束，使用 SummaryHandler 记录的结束时间（sessionList 兜底后有真实终态）
      return endTime - startTime;
    }
    if (isLive) {
      // 运行中或仍在活跃窗口内，跟随当前时间
      return now - startTime;
    }
    // 冷加载/已终结且无终态记录：退化为消息跨度（最后一条消息时间）
    return lastMsgTime ? Math.max(0, lastMsgTime - startTime) : 0;
  }, [startTime, endTime, isLive, lastMsgTime, now]);

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
            <span className="text-xs font-mono text-gray-400 dark:text-gray-500">
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
