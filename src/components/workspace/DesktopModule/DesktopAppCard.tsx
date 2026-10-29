import React, { useState, useEffect, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { DesktopApp } from './types/DesktopAppTypes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import DesktopAppViewer from './DesktopAppViewer';
import { trainingTaskStorage, executionLogStorage } from '@/services/storage';
import { claimPendingExecutionResult } from '@/utils/apptool/LocalExecutor';

interface DesktopAppCardProps {
  app: DesktopApp;
  index?: number;
  /** 🔥 该项目是否有活跃常驻实例（序号圈变绿色信号，不加新标签保持简洁） */
  hasResident?: boolean;
  onAppUpdated: (appId: string) => void;
  onAppDeleted: (id: string) => void;
  conversationId?: string | null;
}

export const DesktopAppCard = memo(({ app, index, hasResident, onAppUpdated, onAppDeleted, conversationId }: DesktopAppCardProps) => {
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [showEditIcon, setShowEditIcon] = useState(false);
  // 🔥 ref 跟踪 isViewerOpen，供 useEffect 回调里读取最新值（避免闭包过期）
  const isViewerOpenRef = useRef(false);
  isViewerOpenRef.current = isViewerOpen;
  const [latestTask, setLatestTask] = useState<{ status: string; created_at: number; type: 'training' } | null>(null);
  const [latestExecution, setLatestExecution] = useState<{ status: string; created_at: number } | null>(null);
  // 🔥 是否有过训练/执行记录（用于推断项目类型）
  const [hasTrainingRecord, setHasTrainingRecord] = useState(false);
  const [hasExecutionRecord, setHasExecutionRecord] = useState(false);
  
  const { t } = useTranslation();

  const loadLatestTask = async () => {
    try {
      // 🔥 使用轻量级查询，不加载 stdout_output/charts_json/files_json 等大字段
      const tasks = await trainingTaskStorage.getSummaryByAppId(app.id);
      if (tasks && tasks.length > 0) {
        const latest = tasks[0] as any;
        setLatestTask({
          status: latest.status,
          created_at: latest.created_at,
          type: 'training'
        });
        setHasTrainingRecord(true);
      } else {
        setLatestTask(null);
        setHasTrainingRecord(false);
      }
    } catch (err) {
      // 忽略错误
    }
  };

  // 🔥 有"执行中"记录时的兜底同步（主窗口没有 viewer 帮忙认领，card 自己来）：
  // 1. 后台进程已跑完（RunDev 后窗口被关闭，结果暂存在 main 进程等认领）→ 认领补写执行记录（含耗时），
  //    card 才能翻转为成功/失败，不用等用户重新打开 viewer
  // 2. 进程不在且无结果可认领：超过宽限期（90s，覆盖日志创建到进程注册的毫秒级间隙）→
  //    应用重启等原因造成的僵尸 running 记录（appPendingResults 是内存 Map，重启即丢），标记为"已取消"
  const syncRunningExecution = async () => {
    try {
      const electron = (window as any).electron;
      if (!electron?.queryAppService) return;
      const info = await electron.queryAppService(app.id);
      if (info?.running) return; // 进程真的还在跑（计算类/服务类都算）
      if (await claimPendingExecutionResult(app.id)) return;
      const logs = await executionLogStorage.getByAppId(app.id);
      const runningLogs = (logs || []).filter((l: any) => l.status === 'running');
      const newestRunningAt = Math.max(...runningLogs.map((l: any) => l.created_at || 0), 0);
      if (Date.now() - newestRunningAt > 90_000) {
        for (const log of runningLogs) {
          await executionLogStorage.update(log.id, {
            status: 'cancelled',
            error_message: '执行中断（应用重启或结果丢失）',
          });
        }
      }
    } catch { /* Electron API 不可用时忽略 */ }
  };

  // 🔥 加载最新的 CPU 执行状态
  const loadLatestExecution = async () => {
    try {
      let logs = await executionLogStorage.getSummaryByAppId(app.id);
      // 🔥 存在"执行中"记录：先兜底同步（认领后台结果/清理僵尸），再重读最新状态
      if (logs && logs.some(l => l.status === 'running')) {
        await syncRunningExecution();
        logs = await executionLogStorage.getSummaryByAppId(app.id);
      }
      if (logs && logs.length > 0) {
        const latest = logs[0] as any;
        setLatestExecution({
          status: latest.status,
          created_at: latest.created_at
        });
        setHasExecutionRecord(true);
      } else {
        setLatestExecution(null);
        setHasExecutionRecord(false);
      }
    } catch (err) {
      // 忽略错误
    }
  };

  // 🔥 项目类型标签：落库 project_type（LLM upsert_project 声明的场景类型）优先；
  //    存量项目无落库值时退回运行记录推断（training > inference），general/未知不显示
  const getProjectType = (): { type: string; label: string; color: string } => {
    const pt = app.project_type;
    if (pt && pt !== 'general') {
      const byType: Record<string, { label: string; color: string }> = {
        training: { label: t('workspace.desktopModule.desktopAppCard.trainingLabel'), color: 'bg-orange-100 text-orange-700' },
        inference: { label: t('workspace.desktopModule.desktopAppCard.inferenceLabel'), color: 'bg-purple-100 text-purple-700' },
        shortfilm: { label: t('workspace.desktopModule.desktopAppCard.shortfilmLabel'), color: 'bg-pink-100 text-pink-700' },
        agent: { label: t('workspace.desktopModule.desktopAppCard.agentLabel'), color: 'bg-blue-100 text-blue-700' },
      };
      const hit = byType[pt];
      if (hit) return { type: pt, ...hit };
    }
    if (hasTrainingRecord) {
      return { type: 'training', label: t('workspace.desktopModule.desktopAppCard.trainingLabel'), color: 'bg-orange-100 text-orange-700' };
    }
    if (hasExecutionRecord) {
      return { type: 'inference', label: t('workspace.desktopModule.desktopAppCard.inferenceLabel'), color: 'bg-purple-100 text-purple-700' };
    }
    return { type: 'normal', label: '', color: '' };
  };

  // 🔥 获取当前应该显示的状态（优先显示运行中的任务）
  const getDisplayStatus = (): { status: string; label: string; type: 'training' | 'execution' } | null => {
    // 优先显示运行中的任务
    if (latestExecution?.status === 'running') {
      return { status: 'running', label: t('workspace.desktopModule.desktopAppCard.statusExecuting'), type: 'execution' };
    }
    if (latestTask?.status === 'running') {
      return { status: 'running', label: t('workspace.desktopModule.desktopAppCard.statusTraining'), type: 'training' };
    }
    // 其次显示最新的任务（执行或训练）
    const executionTime = latestExecution?.created_at || 0;
    const trainingTime = latestTask?.created_at || 0;
    
    if (executionTime > trainingTime && latestExecution) {
      const label = latestExecution.status === 'success' ? t('workspace.desktopModule.desktopAppCard.statusExecSuccess') :
                    latestExecution.status === 'failed' ? t('workspace.desktopModule.desktopAppCard.statusExecFailed') :
                    latestExecution.status === 'cancelled' ? t('workspace.desktopModule.desktopAppCard.statusCancelled') : null;
      return label ? { status: latestExecution.status, label, type: 'execution' } : null;
    }
    if (trainingTime > 0 && latestTask) {
      const label = latestTask.status === 'success' ? t('workspace.desktopModule.desktopAppCard.statusTrainingDone') :
                    latestTask.status === 'failed' ? t('workspace.desktopModule.desktopAppCard.statusTrainingFailed') : null;
      return label ? { status: latestTask.status, label, type: 'training' } : null;
    }
    return null;
  };

  useEffect(() => {
    if (app.id) {
      loadLatestTask();
      loadLatestExecution();
    }
  }, [app.id, app.updatedAt]);

  // 🔥 定期刷新任务状态（每15秒，减少轮询频率）
  useEffect(() => {
    if (!app.id) return;

    const interval = setInterval(() => {
      loadLatestTask();
      loadLatestExecution();
    }, 15000);

    return () => clearInterval(interval);
  }, [app.id]);

  // 🔥 fs.watch 兜底监听：检测工具系统之外的文件修改（如 LLM 用 Python 直接修改文件）
  // 项目被收起时也能收到通知 → 显示红点
  useEffect(() => {
    if (!app.id) return;

    const electron = (window as any).electron;
    if (!electron?.watchAppCodeDir || !electron?.onAppCodeChanged) return;

    electron.watchAppCodeDir({ appId: app.id });

    const cleanup = electron.onAppCodeChanged((data: { appId: string; filename: string }) => {
      if (data.appId !== app.id) return;
      // 🔥 文件系统被动监听（fs.watch）：只在 viewer 打开时通知编辑器/FileTree 刷新，不亮红点
      // 避免读取文件、Windows 索引/Defender 扫描等噪声误亮红点惊吓用户
      // 真正的代码修改由工具系统（save/edit/delete）触发，dispatch 时带 action 字段才会亮红点
      if (!isViewerOpenRef.current) return;
      window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
        detail: { appId: app.id }
      }));
    });

    return () => {
      cleanup();
      electron.unwatchAppCodeDir({ appId: app.id });
    };
  }, [app.id]);

  useEffect(() => {
    // 🔥 监听文件树变化（替代已删除的 codeEditEventService.code_updated）
    const handleFilesChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.appId !== app.id) return;
      // 🔥 红点只由工具写操作（save/edit/delete，带 action）触发
      // 文件系统被动监听（无 action）不亮红点，避免读取等噪声惊吓用户
      if (!detail?.action) return;
      if (isViewerOpenRef.current) return;
      setShowEditIcon(true);
      onAppUpdated(app.id);
      window.dispatchEvent(new CustomEvent('desktop-app-updated', {
        detail: { appId: app.id }
      }));
    };

    window.addEventListener('trainProjectFilesChanged', handleFilesChanged);
    return () => window.removeEventListener('trainProjectFilesChanged', handleFilesChanged);
  }, [app.id, onAppUpdated]);

  return (
    <>
      <Card className={`w-full flex flex-col hover:shadow-md transition-shadow cursor-pointer relative`} onClick={() => {
        // 🔥 Electron：项目 viewer 走独立窗口（不淹没 chat）；Web：降级原 Dialog
        const electron = (window as any).electron;
        if (electron?.openAppViewerWindow) {
          electron.openAppViewerWindow({ appId: app.id, name: app.name });
        } else {
          setIsViewerOpen(true);
        }
        setShowEditIcon(false);
      }}>
        {showEditIcon && (
          <div className="absolute -top-1 -right-1 z-10 w-3 h-3 bg-red-500 rounded-full shadow-sm" title={t('workspace.desktopModule.desktopAppCard.codeUpdated')} />
        )}
        <CardHeader className="pb-2 relative">
          {getDisplayStatus() && (
            <div className="absolute top-2 right-2 flex items-center gap-1">
              {/* 🔥 状态降权为「圆点+灰字」：type 徽章（左下）是有色身份标签，执行状态是瞬态信号，
                  同用 100/700 色阶会打架。圆点保留红/绿/黄/蓝语义，running 用脉冲 */}
              <span className="flex items-center gap-1 text-[9px] leading-none text-gray-400 dark:text-gray-500">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  getDisplayStatus()!.status === 'success' ? 'bg-green-500' :
                  getDisplayStatus()!.status === 'failed' ? 'bg-red-400' :
                  getDisplayStatus()!.status === 'cancelled' ? 'bg-yellow-500' :
                  'bg-blue-500 animate-pulse'
                }`} />
                {getDisplayStatus()!.label}
              </span>
            </div>
          )}
          {index !== undefined && (
            <div
              className={`absolute top-1.5 left-1.5 z-10 w-6 h-6 rounded-md flex items-center justify-center text-xs font-medium transition-colors ${
                hasResident ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-400' : 'bg-gray-200/90 text-gray-600'
              }`}
              title={hasResident ? '该项目有常驻实例运行中' : undefined}
            >
              {index}
            </div>
          )}
          <CardTitle className="text-sm font-medium truncate">
            {app.name}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 pt-2">
          <div className="text-xs text-gray-500 break-words flex items-center gap-1.5">
            <span>{t('workspace.desktopModule.desktopAppCard.updated')}{new Date(app.updatedAt).toLocaleDateString()}</span>
            {getProjectType().type !== 'normal' && (
              <span className={`text-[8px] px-1.5 py-0.5 rounded-full shrink-0 ${getProjectType().color}`}>
                {getProjectType().label}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={isViewerOpen} onOpenChange={(open) => {
        setIsViewerOpen(open);
        if (!open) {
          loadLatestTask();
          loadLatestExecution();
        }
      }}>
        <DialogContent className="w-[95vw] max-w-6xl h-[85vh] p-0" hideCloseButton>
          <DialogHeader className="sr-only">
            <DialogTitle>{app.name}</DialogTitle>
            <DialogDescription>
              {t('workspace.desktopModule.desktopAppViewer.appDetails')}
            </DialogDescription>
          </DialogHeader>
          <DesktopAppViewer
            appId={app.id}
            userId={app.userId}
            isOpen={isViewerOpen}
            onClose={() => setIsViewerOpen(false)}
            initialApp={app}
            onAppUpdated={(appId) => onAppUpdated(appId)}
            conversationId={conversationId}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}, (prevProps, nextProps) => {
  // 🔥 安全比较 updatedAt：处理 undefined、字符串、Date 等多种情况
  const getTimestamp = (date: Date | string | undefined): number => {
    if (!date) return 0;
    if (typeof date === 'string') return new Date(date).getTime();
    if (date instanceof Date) return date.getTime();
    return 0;
  };

  return (
    prevProps.app.id === nextProps.app.id &&
    getTimestamp(prevProps.app.updatedAt) === getTimestamp(nextProps.app.updatedAt) &&
    prevProps.app.name === nextProps.app.name &&
    prevProps.app.project_type === nextProps.app.project_type &&
    prevProps.index === nextProps.index &&
    prevProps.hasResident === nextProps.hasResident
  );
});

export default DesktopAppCard;
