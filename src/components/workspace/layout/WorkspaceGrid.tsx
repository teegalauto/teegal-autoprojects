import React, { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { FileAttachment } from "../types/ChatTypes";
import OptimizedChatPanel from "../chat/OptimizedChatPanel";
import { DesktopPanel } from "../DesktopModule/DesktopPanel";
import { QuickCreateApp } from "../DesktopModule/QuickCreateApp";
import DSEPanel from "../DSEModule/DSEPanel";
import { X, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

type SidePanelType = 'desktop' | 'dse' | null;

interface WorkspaceGridProps {
  messages: any[];
  isProcessing: boolean;
  currentConversationId?: string | null;
  userId?: string;
  onLoadMoreMessages?: () => Promise<boolean>;
  onSendMessage: (
    message: string,
    files?: FileAttachment[],
    parameters?: Record<string, any>,
  ) => Promise<void>;
  onNewChat: () => void;
  onCancel: () => void;
}

const DESKTOP_PANEL_WIDTH = 500;

const WorkspaceGrid = ({
  messages,
  isProcessing,
  currentConversationId,
  userId,
  onLoadMoreMessages,
  onSendMessage,
  onNewChat,
  onCancel,
}: WorkspaceGridProps) => {
  const { t } = useTranslation();
  const { isLoading: isAuthLoading } = useAuth();
  const [sidePanel, setSidePanel] = useState<SidePanelType>(null);
  // 🔥 项目列表筛选：all=全部，normal=普通项目，system_base=基础项目（如扩展工具）
  const [appTypeFilter, setAppTypeFilter] = useState<'all' | 'normal' | 'system_base'>('all');
  // 🔥 筛选下拉菜单开合状态：打开期间头部临时取消 drag（点击外部收菜单需要 DOM 事件，
  // drag 区会吞掉点击——这是当初"整个头部 drag 导致菜单收不回"的根因），关闭后恢复大区域可拖
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState<number>(700);
  const originalSizeRef = useRef<{ width: number; height: number } | null>(null);
  // 🔥 过渡锁：窗口尺寸跳变瞬间（含紧随的 resize 事件），resize handler 不重算 chatWidth，
  // 否则 setSize → resize → setChatWidth 会让 chat 区重排一次（抖动元凶之一）
  const animatingRef = useRef(false);
  // 🔥 sidePanel 的同步镜像：resize handler 读它判断面板开合，避免闭包过期读到旧 state
  const sidePanelRef = useRef<SidePanelType | null>(null);
  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

  // 初始化时获取窗口宽度 + 监听窗口 resize
  useEffect(() => {
    const initWidth = async () => {
      if (isElectron && (window as any).electron?.window) {
        const size = await (window as any).electron.window.getSize();
        setChatWidth(size[0]);
      } else {
        setChatWidth(window.innerWidth);
      }
    };
    initWidth();

    // 🔥 监听窗口 resize（最大化/还原/手动拖拽边缘）；过渡期间的 resize 是我们自己发的，跳过
    // 🔥 读 sidePanelRef（同步 ref）而不是闭包里的 sidePanel：setSize 的 resize 事件可能命中
    // 旧闭包（sidePanel 还是旧值），把 chatWidth 多算/少算 500px，导致 chat 被拖长或挤压
    const handleResize = async () => {
      if (animatingRef.current) return;
      const panelOpen = sidePanelRef.current !== null;
      if (isElectron && (window as any).electron?.window) {
        const size = await (window as any).electron.window.getSize();
        const newWindowWidth = size[0];
        // 侧边栏打开时，chatWidth = 窗口宽度 - 侧边栏宽度；否则 = 窗口宽度
        setChatWidth(panelOpen ? newWindowWidth - DESKTOP_PANEL_WIDTH : newWindowWidth);
        // 🔥 用户手动拖拽窗口（非过渡期）时同步"原始尺寸"：
        // 否则切换/关闭面板时会按旧记录 setSize，把用户刚调好的尺寸拽回去（窗口突然变大/变小）
        if (panelOpen && originalSizeRef.current) {
          originalSizeRef.current = { width: newWindowWidth - DESKTOP_PANEL_WIDTH, height: size[1] };
        }
      } else {
        setChatWidth(panelOpen ? window.innerWidth - DESKTOP_PANEL_WIDTH : window.innerWidth);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isElectron]);

  // 🔥 通用侧边栏切换
  // 抖动最小化方案（瞬移版）：
  // 1. 先挂 Panel（在窗口外被 overflow-hidden 裁掉，不可见）→ 一次 setSize 瞬移到位，Panel 露出
  // 2. 过渡期间 animatingRef 锁住 resize handler，chatWidth 全程不变，chat 区零重排
  // 3. 锁延迟 150ms 释放（吞掉 setSize 触发的 resize 事件链）
  const toggleSidePanel = useCallback(async (panelType: SidePanelType) => {
    const isOpen = sidePanel === panelType;
    const newState = isOpen ? null : panelType;
    // 🔥 同步镜像：让 resize handler 立刻看到最新开合状态（不等 effect 重注册）
    sidePanelRef.current = newState;

    // 🔥 面板间直接切换（desktop ↔ dse）：两者同宽（500px），窗口尺寸保持不动，仅替换内容。
    // 不走下面的开/关分支——那里会按 originalSizeRef 记录 setSize，若用户中途拖过窗口就会尺寸跳变
    if (newState && sidePanel && sidePanel !== panelType) {
      setSidePanel(newState);
      return;
    }

    if (isElectron) {
      const electronWindow = (window as any).electron?.window;
      if (electronWindow) {
        try {
          if (newState) {
            // 打开：记录原尺寸 → 先挂 Panel（不可见）→ 瞬移扩窗
            const currentSize = await electronWindow.getSize();

            if (!originalSizeRef.current) {
              originalSizeRef.current = { width: currentSize[0], height: currentSize[1] };
            }

            setChatWidth(originalSizeRef.current.width);
            setSidePanel(newState); // Panel 渲染在窗口外（被 overflow-hidden 裁掉）
            animatingRef.current = true;
            const newWidth = originalSizeRef.current.width + DESKTOP_PANEL_WIDTH;
            await electronWindow.setSize(newWidth, currentSize[1]); // 一次到位
            setTimeout(() => { animatingRef.current = false; }, 150);
          } else {
            // 关闭：瞬移缩窗（Panel 被右侧裁掉，chat 因 flexShrink:0 不动）→ 卸载 Panel
            animatingRef.current = true;
            if (originalSizeRef.current) {
              await electronWindow.setSize(
                originalSizeRef.current.width,
                originalSizeRef.current.height
              );
              originalSizeRef.current = null;
            }
            setSidePanel(null);
            setTimeout(() => { animatingRef.current = false; }, 150);
          }
          return;
        } catch (error) {
          animatingRef.current = false;
          console.error('[WorkspaceGrid] Error:', error);
        }
      }
    }

    setSidePanel(newState);
  }, [sidePanel, isElectron]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* 🔥 使用固定宽度而不是 flex-1，防止重排 */}
      {/* 🔥 flexShrink:0 关键：窗口跳变瞬间 chat+Panel 总宽会超出窗口，若无此属性 chat 会被 flex 挤压一帧（消息气泡全部重排 = 强烈抖动），加上后超宽部分被 overflow-hidden 裁掉、chat 纹丝不动 */}
      <div 
        className="min-w-0 bg-white"
        style={{ width: chatWidth, flexShrink: 0 }}
      >
        <OptimizedChatPanel
          messages={messages}
          isProcessing={isProcessing}
          onSendMessage={onSendMessage}
          onCancel={onCancel}
          currentConversationId={currentConversationId}
          onLoadMoreMessages={onLoadMoreMessages}
          onOpenDesktop={() => toggleSidePanel('desktop')}
          isDesktopOpen={sidePanel === 'desktop'}
          onOpenDSE={() => toggleSidePanel('dse')}
          isDSEOpen={sidePanel === 'dse'}
        />
      </div>

      {sidePanel && (
        <div className="w-[500px] flex-shrink-0 h-full bg-white border-l shadow-lg">
          <div
            className="flex items-center justify-between px-4 py-2 border-b h-12"
            // 🔥 h-12 与 ChatHeader 锁同一高度（48px）：此处不锁会被内容撑成 ~45px，两侧头部有视觉差；
            // 下方内容区 h-[calc(100%-48px)] 也是按 48px 设计的
            // 🔥 整个头部默认 drag（恢复大可拖区域，之前缩到只剩标题导致侧边栏头部几乎拖不动窗口）；
            // 仅筛选菜单打开期间临时取消 drag：点击外部收菜单需要 DOM 点击事件，drag 区会吞掉点击
            // （当初"整个头部 drag 导致菜单收不回"的根因）。所有交互元素（创建/筛选/关闭）单独 no-drag
            style={isElectron && !filterMenuOpen ? { WebkitAppRegion: 'drag' } as any : {}}
          >
            <div className="flex items-center gap-2">
              <h3 className="font-medium">
                {sidePanel === 'desktop' ? t('workspace.workspaceGrid.projectsTitle') : t('workspace.workspaceGrid.filesTitle')}
              </h3>
              {sidePanel === 'desktop' && <QuickCreateApp />}
              {/* 🔥 项目类型筛选：普通项目 / 基础项目（如扩展工具） */}
              {sidePanel === 'desktop' && (
                <DropdownMenu open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`h-7 px-2 text-xs gap-1 ${
                        appTypeFilter !== 'all' ? 'text-blue-600 hover:text-blue-700' : 'text-gray-500 hover:text-gray-700'
                      }`}
                      style={isElectron ? { WebkitAppRegion: 'no-drag' } as any : {}}
                    >
                      <ChevronDown className="h-3 w-3" />
                      {appTypeFilter === 'normal' ? t('workspace.workspaceGrid.filterNormal') : appTypeFilter === 'system_base' ? t('workspace.workspaceGrid.filterSystemBase') : t('workspace.workspaceGrid.filterAll')}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setAppTypeFilter('all')}>{t('workspace.workspaceGrid.filterAll')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAppTypeFilter('normal')}>{t('workspace.workspaceGrid.filterNormal')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAppTypeFilter('system_base')}>{t('workspace.workspaceGrid.filterSystemBase')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleSidePanel(sidePanel)}
              style={isElectron ? { WebkitAppRegion: 'no-drag' } as any : {}}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-[calc(100%-48px)] overflow-hidden">
            {/* 🔥 面板刷新 key：初始化/登录态切换（isLoading 翻转）时强制重挂载。
                初始化期间打开的面板可能因后端未就绪拉取失败，且 userId 不变不会触发重新拉取，
                chat 区会随状态刷新而面板不会（此前需手动收起再展开） */}
            {sidePanel === 'desktop' && (
              <DesktopPanel
                key={`desktop-${isAuthLoading ? 'loading' : 'ready'}`}
                userId={userId}
                conversationId={currentConversationId}
                appTypeFilter={appTypeFilter === 'all' ? undefined : appTypeFilter}
              />
            )}
            {sidePanel === 'dse' && (
              <DSEPanel
                key={`dse-${isAuthLoading ? 'loading' : 'ready'}`}
                userId={userId}
                conversationId={currentConversationId}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkspaceGrid;
