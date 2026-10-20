import React, { useRef, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { splitDiffLines, computeDiffLines, computeDiffStats } from './FileTree/utils';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Undo2, GitCommit } from 'lucide-react';

interface DiffViewerProps {
  oldCode: string;
  newCode: string;
  onRevert?: () => void; // 🔥 回退回调
  onAccept?: () => void; // 🔥 接受回调（=commit，清空历史版本）
}

interface DiffLine {
  type: 'added' | 'deleted' | 'unchanged';
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  oldCode,
  newCode,
  onRevert,
  onAccept
}) => {
  const { t } = useTranslation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // 🔥 记录 scroll container 的可视区域高度（减去水平滚动条），用于 minimap 精确映射
  const [viewHeight, setViewHeight] = useState(0);

  // 🔥 同步测量 scroll container 的 clientHeight（包含水平滚动条扣除）
  useLayoutEffect(() => {
    const measure = () => {
      if (scrollContainerRef.current) {
        setViewHeight(scrollContainerRef.current.clientHeight);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (scrollContainerRef.current) {
      observer.observe(scrollContainerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  // 🔥 滚动时更新位置，驱动 minimap viewport indicator 同步
  // ⚠️ 必须放在下方两个 early return 之前：否则"无历史版本/代码一致"的渲染只执行 6 个 hook，
  // 加载到历史版本后走完整路径变成 7 个 → hook 数不一致 → React error #300（Rendered more hooks）
  const rafRef = useRef(0);
  const handleScroll = useCallback(() => {
    if (rafRef.current) return; // 🔥 rAF 节流：滚动事件高频触发，避免每帧全量重渲染
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (scrollContainerRef.current) {
        setScrollTop(scrollContainerRef.current.scrollTop);
      }
    });
  }, []);

  // 🔥 diff 计算结果缓存：只在内容变化时重算（曾裸跑在 render 体内，
  // 滚动一行就全量重算 LCS + 重渲染上万行 DOM 直接卡死）
  const diffLines: DiffLine[] | null = useMemo(
    () => computeDiffLines(oldCode, newCode),
    [oldCode, newCode]
  );

  // 1. 无历史版本且当前内容也为空，才无从对比
  // 🔥 新文件场景（oldCode 为空、newCode 有内容）：与空串对比，走下方 diff 渲染全部显示为新增（全绿）
  if (!oldCode && !newCode) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 bg-gray-50/50">
        <div className="text-sm font-medium">暂无历史版本记录</div>
      </div>
    );
  }

  // 2. 如果代码完全一致（先标准化行尾符再比较）
  const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalize(oldCode) === normalize(newCode)) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 bg-gray-50/50">
        <div className="text-sm font-medium">当前版本与上一版本完全一致</div>
      </div>
    );
  }

  // 🔥 文件过大（裁剪公共前后缀后仍超 LCS 规模护栏）：不做逐行对比，宁缺毋滥。
  // 工具栏（接受/回退）照常可用——操作不依赖 diff 结果
  if (diffLines === null) {
    const oldCount = splitDiffLines(oldCode).length;
    const newCount = splitDiffLines(newCode).length;
    const { added, deleted } = computeDiffStats(oldCode, newCode);
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 bg-gray-50/50 gap-3">
        <div className="text-sm font-medium">文件过大，暂不支持逐行对比</div>
        <div className="text-xs text-gray-400">
          旧版本 {oldCount} 行 / 新版本 {newCount} 行 ·
          <span className="text-green-600"> +{added}</span>
          <span className="text-red-600"> -{deleted}</span>
          ，可在编辑器中直接查看内容
        </div>
        {(onRevert || onAccept) && (
          <div className="flex gap-2">
            {onRevert && (
              <Button variant="outline" size="sm" onClick={onRevert} className="h-7 px-2 text-xs">
                <Undo2 className="w-3.5 h-3.5 mr-1" />
                回退
              </Button>
            )}
            {onAccept && (
              <Button variant="outline" size="sm" onClick={onAccept} className="h-7 px-2 text-xs">
                <GitCommit className="w-3.5 h-3.5 mr-1" />
                接受
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  // 🔥 统计新增/删除行数
  const addedCount = diffLines.filter(l => l.type === 'added').length;
  const deletedCount = diffLines.filter(l => l.type === 'deleted').length;

  // 🔥 minimap 修改标记采样：变更行过多时抽稀到 ≤400 个标记（每行一个 div 曾上万节点）
  const changedCount = diffLines.filter(l => l.type !== 'unchanged').length;
  const minimapStride = Math.max(1, Math.ceil(changedCount / 400));
  const minimapMarkers: { type: 'added' | 'deleted'; topPercent: number }[] = [];
  let changedSeen = 0;
  for (let idx = 0; idx < diffLines.length; idx++) {
    const l = diffLines[idx];
    if (l.type === 'unchanged') continue;
    if (changedSeen % minimapStride === 0) {
      minimapMarkers.push({ type: l.type, topPercent: (idx / diffLines.length) * 100 });
    }
    changedSeen++;
  }

  // 🔥 点击 minimap 跳转（点击位置居中显示，基于 viewHeight 映射区域）
  const handleMinimapClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrollContainerRef.current) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    
    const scrollContainer = scrollContainerRef.current;
    const mapHeight = viewHeight || rect.height; // 🔥 用 scroll container 的可视高度，而非 minimap 高度
    const percentage = clickY / mapHeight;
    
    const scrollRange = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    scrollContainer.scrollTop = percentage * scrollRange - scrollContainer.clientHeight / 2;
  };

  // 🔥 滚动回调已移至组件顶部（early return 之前），见上方 handleScroll 定义

  return (
    <div className="diff-viewer w-full h-full bg-white overflow-hidden flex flex-col relative">
      {/* 🔥 顶部工具栏：回退 + 接受按钮 */}
      {(onRevert || onAccept) && (
        <div className="flex items-center justify-center px-4 py-2 bg-gray-50 border-b border-gray-200 sticky top-0 z-10 gap-8">
          <div className="text-xs text-gray-500">
            <span className="text-green-600">+{addedCount}</span>
            <span className="mx-1 text-red-600">-{deletedCount}</span>
          </div>
          <div className="flex gap-2">
            {onRevert && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRevert}
                className="h-7 px-2 text-xs bg-white hover:bg-amber-50 hover:text-amber-700 hover:border-amber-300 transition-colors"
              >
                <Undo2 className="w-3.5 h-3.5 mr-1" />
                回退
              </Button>
            )}
            {onAccept && (
              <Button
                variant="outline"
                size="sm"
                onClick={onAccept}
                className="h-7 px-2 text-xs bg-white hover:bg-green-50 hover:text-green-700 hover:border-green-300 transition-colors"
              >
                <GitCommit className="w-3.5 h-3.5 mr-1" />
                接受
              </Button>
            )}
          </div>
        </div>
      )}
      
      {/* 🔥 主内容区域：diff 内容 + minimap */}
      <div className="flex-1 flex overflow-hidden">
        {/* 🔥 diff 内容 */}
        <div 
          ref={scrollContainerRef}
          className="font-mono text-sm min-w-0 flex-1 overflow-auto"
          onScroll={handleScroll}
        >
          {diffLines.map((line, index) => (
            <div 
              key={`${line.oldLineNumber}-${line.newLineNumber}-${index}`} 
              className={`flex border-b border-gray-100 last:border-b-0 min-w-fit ${
                line.type === 'added' ? 'bg-green-50 text-green-800' : 
                line.type === 'deleted' ? 'bg-red-50 text-red-800 line-through' : 
                'bg-white'
              }`}
            >
              <div className="w-12 flex-shrink-0 bg-gray-50 text-right pr-2 text-xs text-gray-400 border-r border-gray-200 py-1 select-none">
                {line.oldLineNumber !== null ? line.oldLineNumber : ''}
              </div>
              <div className="w-12 flex-shrink-0 bg-gray-50 text-right pr-2 text-xs text-gray-400 border-r border-gray-200 py-1 select-none">
                {line.newLineNumber !== null ? line.newLineNumber : ''}
              </div>
              <div className="px-4 py-1 font-mono whitespace-pre text-sm">
                <span>{line.content}</span>
              </div>
            </div>
          ))}
        </div>
        
        {/* 🔥 Minimap：显示修改概览 + 可视区域指示器 */}
        <div 
          ref={minimapRef}
          className="w-3 bg-gray-100 border-l border-gray-200 relative cursor-pointer flex-shrink-0"
          onClick={handleMinimapClick}
          title="点击跳转到对应位置"
        >
          {/* 🔥 修改标记 — 映射区域高度 = scroll container 的 clientHeight（viewHeight），排除水平滚动条偏差 */}
          <div className="absolute left-0 right-0 overflow-hidden" style={{ height: viewHeight || undefined, top: 0 }}>
            {minimapMarkers.map((m, index) => {
              return (
                <div
                  key={index}
                  className={`absolute left-0 right-0 ${
                    m.type === 'added' ? 'bg-green-400' : 'bg-red-400'
                  }`}
                  style={{
                    top: `${m.topPercent}%`,
                    height: `${Math.max((minimapStride * 100) / diffLines.length, 1)}px`
                  }}
                />
              );
            })}
          </div>
          {/* 🔥 当前可视区域指示器 — 用 viewHeight 作为映射基准，像素级精确 */}
          {(() => {
            const container = scrollContainerRef.current;
            if (!container) return null;
            const mapH = viewHeight || (minimapRef.current?.clientHeight || 1);
            const scale = mapH / container.scrollHeight;
            return (
              <div 
                className="absolute left-0 right-0 bg-blue-400 opacity-20 pointer-events-none"
                style={{
                  top: `${scrollTop * scale}px`,
                  height: `${Math.max(container.clientHeight * scale, 4)}px`
                }}
              />
            );
          })()}
        </div>
      </div>
    </div>
  );
};

export default DiffViewer;