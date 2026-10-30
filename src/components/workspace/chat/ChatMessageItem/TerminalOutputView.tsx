import React, { useState, useRef, useEffect } from 'react';
import { Copy, Check, Loader2, Square, ChevronDown, ChevronRight } from 'lucide-react';

interface TerminalOutputData {
  type: 'terminal';
  command?: string;
  outputs?: string[];
  exitCode?: number | null;
  executionTime?: number;
  error?: string;
  status?: 'streaming' | 'completed' | 'failed';
  executionId?: string;
}

const MAX_DISPLAY_LINES = 100;

export const isTerminalOutput = (result: string): boolean => {
  if (!result) return false;
  try {
    const parsed = JSON.parse(result);
    return parsed?.type === 'terminal';
  } catch {
    return false;
  }
};

export const parseTerminalOutput = (result: string): TerminalOutputData | null => {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    if (parsed?.type === 'terminal') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

interface TerminalOutputViewProps {
  result: string;
  callId?: string;
}

export const TerminalOutputView: React.FC<TerminalOutputViewProps> = ({ result, callId }) => {
  const [copied, setCopied] = useState(false);
  // 🔥 默认收起：完整终端输出看的人少，收起态在标题栏保留一条实时摘要（最后一行非空输出）
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevOutputsLengthRef = useRef(0);

  const data = parseTerminalOutput(result);
  const outputs = data?.outputs ?? [];

  // 🔥 hooks 必须在条件 return 之前调用（React hooks 规则）
  useEffect(() => {
    if (outputs.length > prevOutputsLengthRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevOutputsLengthRef.current = outputs.length;
  }, [outputs.length]);

  if (!data) return null;

  const { command, exitCode, executionTime, error, status, executionId } = data;
  const displayOutputs = outputs.slice(-MAX_DISPLAY_LINES);
  const hasMore = outputs.length > MAX_DISPLAY_LINES;
  const isStreaming = status === 'streaming';

  // 🔥 收起态摘要：error 优先，否则从尾部找最后一条非空输出（与 SessionMessageGroup 摘要同风格）——
  //    流式时随 result 推送实时刷新，让用户不展开也能瞄到终端在干什么
  const collapsedSummary = (() => {
    if (error) return `错误: ${error}`;
    for (let i = outputs.length - 1; i >= 0; i--) {
      const line = (outputs[i] || '').trim();
      if (line) return line;
    }
    return '';
  })();

  const handleCopy = async () => {
    const textToCopy = outputs.join('\n');
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  const handleTerminate = () => {
    // 🔥 使用 executionId 而不是 callId 来发送取消请求
    if (executionId && (window as any).electron?.send) {
      (window as any).electron.send('system:cancel-command', { executionId });
      console.log('🛑 [TERMINAL] 请求终止命令:', executionId);
    }
  };

  const isSuccess = exitCode === 0 || (exitCode === null && !error && !isStreaming);
  const statusColor = isSuccess ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  const bgColor = isSuccess ? 'bg-green-600' : 'bg-red-600';

  return (
    <div className="bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 font-mono text-xs">
      <div
        className="bg-gray-100 dark:bg-gray-800 px-3 py-2 flex items-center justify-between border-b border-gray-200 dark:border-gray-700 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0" />
          )}
          <span className="text-gray-600 dark:text-gray-300 font-semibold whitespace-nowrap">终端输出</span>
          {isStreaming && (
            <Loader2 className="w-3 h-3 text-blue-500 dark:text-blue-400 animate-spin ml-1 shrink-0" />
          )}
        </div>
        {/* 🔥 收起态摘要：占据剩余空间单行截断（流式实时刷新），展开时不显示避免与正文重复 */}
        {!isExpanded && collapsedSummary && (
          <span className="flex-1 min-w-0 truncate text-gray-400 dark:text-gray-500 ml-2 mr-2">
            {collapsedSummary}
          </span>
        )}
        <div className="flex items-center gap-2">
          {executionTime && (
            <span className="text-gray-400 dark:text-gray-500">{(executionTime / 1000).toFixed(1)}s</span>
          )}
          {exitCode !== null && exitCode !== undefined && (
            <span className={`px-1.5 py-0.5 rounded text-white text-[10px] ${bgColor}`}>
              {isSuccess ? '✓' : `✗ ${exitCode}`}
            </span>
          )}
          {isStreaming && (
            <span className="px-1.5 py-0.5 rounded text-white text-[10px] bg-blue-600">
              执行中
            </span>
          )}
          {isStreaming && executionId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleTerminate();
              }}
              className="text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
              title="终止命令"
            >
              <Square className="w-3 h-3 fill-current" />
              <span className="text-[10px]">终止</span>
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            className="text-gray-400 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            title="复制全部输出"
          >
            {copied ? (
              <Check className="w-3 h-3 text-green-500 dark:text-green-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div
          ref={scrollRef}
          className="p-3 max-h-[200px] overflow-y-auto bg-white dark:bg-gray-950 leading-relaxed"
        >
          {command && (
            <div className="text-gray-500 dark:text-gray-400 mb-2 pb-2 border-b border-gray-200 dark:border-gray-800">
              <span className="text-gray-400 dark:text-gray-500">$</span> {command}
            </div>
          )}
          {hasMore && (
            <div className="text-gray-400 dark:text-gray-500 mb-2">
              ... 省略前 {outputs.length - MAX_DISPLAY_LINES} 行
            </div>
          )}
          {displayOutputs.map((line, i) => (
            <div key={i} className={`${statusColor} whitespace-pre-wrap break-all`}>
              {line}
            </div>
          ))}
          {isStreaming && (
            <div className="text-blue-500 dark:text-blue-400 mt-2 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>等待输出...</span>
            </div>
          )}
          {error && (
            <div className="text-red-600 dark:text-red-400 mt-2 border-t border-gray-200 dark:border-gray-700 pt-2">
              错误: {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TerminalOutputView;
