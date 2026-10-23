/**
 * 🔥 服务实时预览（运行日志池前端入口）
 *
 * 用 <webview> 渲染项目运行中的服务页面（如 http://localhost:5173），
 * 页面 console 经 console-message 事件转发主进程运行日志池（[trace] 埋点采集）——
 * LLM 通过 get_task_detail(appId) 拉到的轨迹因此包含前端日志。
 * 无标记的 console 不入池（意图过滤，主进程端统一筛选）。
 */

import React, { useEffect, useRef } from 'react';

const ElectronWebview = 'webview' as any; // Electron webview tag（React 无内置类型）

interface ServicePreviewProps {
  appId: string;
  url: string;
  /** 🔥 裸渲染：AppViewerPage url 型 tab 用——tab 栏已显示地址，页内"服务预览"头部多余 */
  bare?: boolean;
}

export const ServicePreview: React.FC<ServicePreviewProps> = ({ appId, url, bare }) => {
  const webviewRef = useRef<any>(null);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !(window as any).electron) return;
    // 🔥 appId 空守卫：url 型 tab（viewer 收编 localhost 链接）没有项目身份，转发是无效 IPC
    if (!appId) return;

    // console-message：页面 console 流 → 主进程运行日志池（主进程端按 [trace] 筛选）
    const onConsole = (e: any) => {
      try {
        (window as any).electron.appendAppTrace(appId, String(e?.message || ''));
      } catch { /* 转发失败不影响页面本身 */ }
    };
    wv.addEventListener('console-message', onConsole);
    return () => wv.removeEventListener('console-message', onConsole);
  }, [appId, url]);

  return (
    <div className="w-full h-full flex flex-col">
      {/* 头部（绿点+地址）只在嵌入场景显示（DesktopAppViewer service 子页里它是唯一地址标识） */}
      {!bare && (
        <div className="bg-gray-100 dark:bg-gray-800 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 border-b flex items-center gap-2 shrink-0">
          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
          <span>服务预览</span>
          <span className="font-mono">{url}</span>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ElectronWebview
          ref={webviewRef}
          src={url}
          style={{ width: '100%', height: '100%' }}
          allowpopups={'true' as any}
        />
      </div>
    </div>
  );
};
