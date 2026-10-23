/**
 * 🔥 项目查看器独立窗口页面（浏览器式多 tab）
 * Electron 下点击项目卡片时在独立 BrowserWindow 中打开；窗口已存在时新项目以 tab 加入
 * 路由: #/app-viewer?appId=xxx&name=xxx
 * 窗口标题固定为 WorkBees（项目名在 tab 和 viewer 内显示，改名互不影响）
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X, Minus, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DesktopAppViewer } from '@/components/workspace/DesktopModule/DesktopAppViewer';
import { ServicePreview } from '@/components/workspace/DesktopModule/ServicePreview';
import { useAuth } from '@/context/AuthContext';

/**
 * 🔥 tab 双形态：
 * - app 型：项目查看器（DesktopAppViewer，带工具栏），key=appId
 * - url 型：本地服务预览（ServicePreview 裸 webview，console 埋点入日志池），key=url
 */
interface AppTab {
  type: 'app' | 'url';
  appId?: string;
  url?: string;
  name: string;
}

const tabKey = (t: { appId?: string; url?: string }) => t.appId || t.url || '';

const AppViewerPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const initAppId = searchParams.get('appId') || '';
  const initUrl = searchParams.get('url') || '';
  const initName = searchParams.get('name') || '';
  const conversationId = searchParams.get('conversationId') || null;
  const { user } = useAuth();

  // 🔥 多 tab 状态：初始 tab 来自 URL，后续 tab 来自主进程 IPC
  const [tabs, setTabs] = useState<AppTab[]>(
    initAppId ? [{ type: 'app', appId: initAppId, name: initName }]
    : initUrl ? [{ type: 'url', url: initUrl, name: initName }]
    : []
  );
  const [activeKey, setActiveKey] = useState<string>(initAppId || initUrl);

  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
  const isMac = isElectron && (window as any).electron?.platform === 'darwin';
  const [isMaximized, setIsMaximized] = useState(false);

  // 监听最大化状态
  useEffect(() => {
    if (!isElectron) return;
    const check = async () => {
      if ((window as any).electron?.window) {
        setIsMaximized(await (window as any).electron.window.isMaximized());
      }
    };
    check();
    const interval = setInterval(check, 500);
    return () => clearInterval(interval);
  }, [isElectron]);

  // 🔥 监听主进程"新增 tab"（点击另一个项目卡片 / 收编 localhost 链接时）
  useEffect(() => {
    const electron = (window as any).electron;
    if (!electron?.onAddAppTab) return;
    return electron.onAddAppTab(({ appId, url, name }: { appId?: string; url?: string; name?: string }) => {
      const incoming: AppTab = appId
        ? { type: 'app', appId, name: name || '' }
        : { type: 'url', url, name: name || '' };
      const key = tabKey(incoming);
      setTabs(prev => {
        if (prev.some(t => tabKey(t) === key)) {
          return prev; // 已打开：仅激活（下方 setActiveKey）
        }
        return [...prev, incoming];
      });
      setActiveKey(key);
    });
  }, []);

  // 🔥 通过 localStorage storage 事件通知主窗口刷新项目列表（跨窗口）
  const notifyMainWindow = useCallback((appId: string) => {
    try {
      localStorage.setItem('desktopAppUpdatedSignal', JSON.stringify({ appId, t: Date.now() }));
    } catch { /* 忽略 */ }
  }, []);

  // 关闭单个 tab：全部关闭则关窗口
  const closeTab = useCallback((key: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => tabKey(t) === key);
      const next = prev.filter(t => tabKey(t) !== key);
      if (key === activeKey) {
        // 激活相邻 tab；没有 tab 则关窗口
        if (next.length === 0) {
          (window as any).electron?.window?.close();
        } else {
          const fallback = next[Math.min(idx, next.length - 1)];
          setActiveKey(tabKey(fallback));
        }
      }
      notifyMainWindow(key); // 关 tab 也刷新主窗口列表（项目可能被改过）
      return next;
    });
  }, [activeKey, notifyMainWindow]);

  // 窗口关闭前通知主窗口刷新
  useEffect(() => {
    const handler = () => tabs.forEach(t => notifyMainWindow(tabKey(t)));
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [tabs, notifyMainWindow]);

  if (!initAppId && !initUrl) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400">
        缺少 appId 或 url 参数
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white">
      {/* 🔥 Chrome 式顶栏：tab 直接顶格（项目名在 tab 上），右侧窗口控制，无独立标题栏 */}
      <div
        className="flex items-end gap-1 px-2 pt-1.5 bg-gray-50 border-b flex-shrink-0"
        style={isElectron ? { WebkitAppRegion: 'drag' } as any : {}}
      >
        {/* macOS 红绿灯留白 */}
        {isMac && <div className="w-16 shrink-0" />}

        {/* 项目 tab 栏（浏览器式）—— 🔥 no-drag：drag 区会吞掉 tab 点击/关闭事件；tab 区不拉伸，右侧留 drag 空白 */}
        <div
          className="flex items-end gap-1 min-w-0 overflow-x-auto shrink"
          style={isElectron ? { WebkitAppRegion: 'no-drag' } as any : {}}
        >
          {tabs.map(tab => {
            const key = tabKey(tab);
            return (
              <div
                key={key}
                onClick={() => setActiveKey(key)}
                className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg cursor-pointer text-xs max-w-44 min-w-0 transition-colors ${
                  key === activeKey
                    ? 'bg-white text-gray-800 border border-b-0 border-gray-200 font-medium'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                {/* 🔥 url 型加服务标记，与项目 tab 视觉区分 */}
                {tab.type === 'url' && <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" title="本地服务预览" />}
                <span className="truncate select-none">{tab.name || key.slice(0, 12)}</span>
                {/* 🔥 常显 ghost 关闭按钮（不依赖 hover，避免用户找不到） */}
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(key); }}
                  className={`shrink-0 flex items-center justify-center h-4 w-4 rounded transition-colors ${
                    key === activeKey
                      ? 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                      : 'text-gray-400 hover:bg-gray-300 hover:text-gray-600'
                  }`}
                  title="关闭"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* 🔥 drag 垫片：tab 右侧空白区拖动窗口（Chrome 式），最少留 80px 保证抓得到 */}
        <div className="flex-1 min-w-20 h-full" />

        {/* 右侧窗口控制 */}
        <div
          className="flex items-center gap-1 self-center pl-1 shrink-0"
          style={isElectron ? { WebkitAppRegion: 'no-drag' } as any : {}}
        >
          {isElectron && !isMac && (
            <>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                onClick={() => (window as any).electron?.window?.minimize()}>
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                onClick={() => (window as any).electron?.window?.maximize()}>
                <Square className={`h-3 w-3 ${isMaximized ? 'rotate-90' : ''}`} />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 hover:bg-red-500 hover:text-white"
                onClick={() => (window as any).electron?.window?.close()}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Viewer 主体：全部保持挂载（keep-alive），激活的显示，其余隐藏——切换 tab 不丢编辑状态 */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map(tab => {
          const key = tabKey(tab);
          return (
            <div key={key} className="absolute inset-0" style={{ display: key === activeKey ? 'block' : 'none' }}>
              {tab.type === 'app' ? (
                <DesktopAppViewer
                  appId={tab.appId!}
                  userId={user?.id || ''}
                  isOpen={key === activeKey}
                  onClose={() => closeTab(key)}
                  onAppUpdated={() => notifyMainWindow(key)}
                  conversationId={conversationId}
                  embedded
                />
              ) : (
                <ServicePreview appId={tab.appId || ''} url={tab.url!} bare />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AppViewerPage;
