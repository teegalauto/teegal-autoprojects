import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { desktopAppEventService } from '@/services/events/DesktopAppEventService';

import { DesktopApp } from './types/DesktopAppTypes';
import { DesktopAppCard } from './DesktopAppCard';
import { DesktopAppViewer } from './DesktopAppViewer';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Trash2, AtSign, GitFork } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useDesktopApp } from '@/hooks/workspace/desktopapp/useDesktopApp';
import { useDesktopAppCache } from '@/hooks/workspace/desktopapp/useDesktopAppCache';
import { appDatabaseService } from '@/utils/apptool/AppDatabaseService';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { sshListActive } from '@/utils/systemtools/sshInstance';

interface DesktopPanelProps {
  userId?: string;
  conversationId?: string | null;
  /** 🔥 项目类型筛选：normal=普通项目，system_base=基础项目，undefined=全部 */
  appTypeFilter?: 'normal' | 'system_base';
}

export const DesktopPanel: React.FC<DesktopPanelProps> = ({ userId, conversationId, appTypeFilter }) => {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [fileAppId, setFileAppId] = useState<string | null>(null);
  const [fileInitialApp, setFileInitialApp] = useState<DesktopApp | null>(null);
  const [isFileAppViewerOpen, setIsFileAppViewerOpen] = useState(false);
  const { 
    apps, 
    loading, 
    error, 
    hasMore, 
    totalCount,
    fetchApps, 
    loadMoreApps,
    updateAppInCache,
    addAppToCache,
    removeAppFromCache,
    refreshApp
  } = useDesktopAppCache(userId || user?.id, { pageSize: 6 });

  const { deleteApp: deleteAppHook } = useDesktopApp(userId || user?.id);

  // 🔥 常驻信号源：有活跃常驻实例的项目 appId 集合（卡片段落序号圈变绿，不加新标签）
  const [residentAppIds, setResidentAppIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchApps(true, appTypeFilter);
  }, [fetchApps, appTypeFilter]);

  useEffect(() => {
    const uid = userId || user?.id;
    if (!uid) return;
    sshListActive(uid)
      .then(r => {
        if (r.ok) {
          setResidentAppIds(new Set(
            (r.instances || []).map((i: any) => i.app_id).filter(Boolean)
          ));
        }
      })
      .catch(() => { /* 常驻信号失败不影响面板 */ });
  }, [userId, user?.id, apps]);

  const handleAppDelete = useCallback(async (id: string) => {
    try {
      const success = await deleteAppHook(id);
      if (success) {
        removeAppFromCache(id);
      }
    } catch (error) {
      console.error('Failed to delete desktop app:', error);
    }
  }, [deleteAppHook, removeAppFromCache]);

  // 🔥 拆分版本：创建新应用并复制源应用的文件（含 history）
  const handleAppFork = useCallback(async (sourceApp: DesktopApp) => {
    try {
      const currentUserId = userId || user?.id;
      if (!currentUserId) return;

      // 1. 在数据库中创建新应用（元数据）
      const newApp = await appDatabaseService.createDesktopApp({
        name: `${sourceApp.name} (分支)`,
        description: sourceApp.description,
        code: sourceApp.code || '',
        current_code: sourceApp.current_code || sourceApp.code || '',
        config: sourceApp.config,
        env_vars: sourceApp.env_vars,
      }, currentUserId);

      if (!newApp) {
        console.error('Failed to create forked app in database');
        return;
      }

      // 2. 复制源应用的整个代码目录（含 history）
      const electron = (window as any).electron;
      if (electron?.forkAppCodeDir) {
        const result = await electron.forkAppCodeDir({
          sourceAppId: sourceApp.id,
          targetAppId: newApp.id,
        });
        if (!result?.success) {
          console.error('Failed to fork app code directory:', result?.error);
        }
      }

      // 3. 刷新应用列表
      fetchApps(true, undefined, true);

      // 4. 通知其他组件
      desktopAppEventService.emitAppCreated(newApp.id, currentUserId, { code: newApp.code || '' });
    } catch (error) {
      console.error('Failed to fork desktop app:', error);
    }
  }, [userId, user, fetchApps]);

  const handleAppUpdated = useCallback(async (appId: string) => {
    const updatedApp = await refreshApp(appId);
    if (updatedApp) {
      updateAppInCache(appId, updatedApp);
    }
  }, [refreshApp, updateAppInCache]);

  useEffect(() => {
    const currentUserId = userId || user?.id;

    // 🔥 监听文件树变化（替代已删除的 codeEditEventService.code_updated）
    const handleFilesChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.appId) {
        handleAppUpdated(detail.appId);
      }
    };
    window.addEventListener('trainProjectFilesChanged', handleFilesChanged);

    // 🔥 订阅应用创建事件（替代已删除的 codeEditEventService.app_created）
    const unsubscribeAppCreated = desktopAppEventService.subscribe('app_created', (event) => {
      console.log('📡 [DesktopPanel] 收到 app_created 事件:', event);
      if (currentUserId && event.userId === currentUserId) {
        console.log('📡 [DesktopPanel] userId 匹配，刷新应用列表');
        fetchApps(true, undefined, true);
      } else {
        console.log('📡 [DesktopPanel] userId 不匹配:', { currentUserId, eventUserId: event.userId });
      }
    });

    // 🔥 监听打开文件事件（替代已删除的 codeEditEventService.open_file）
    const handleOpenFile = async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const filePath = detail?.filePath;
      if (!filePath) return;

      console.log('📂 [DesktopPanel] 收到 openProjectFile 事件:', filePath);
      try {
        const electron = (window as any).electron;
        if (electron?.userpcFile?.read) {
          const result = await electron.userpcFile.read(filePath);
          if (result.success) {
            const fileContent = result.data?.content || result.content || '';
            const fileName = filePath.split(/[\\/]/).pop() || filePath;

            const getRuntime = (fp: string): string => {
              if (fp.endsWith('.py')) return 'python';
              if (fp.endsWith('.html')) return 'html';
              return 'javascript';
            };

            const tempAppData = {
              name: fileName,
              description: `本地文件: ${filePath}`,
              code: fileContent,
              config: {
                datasetPath: filePath,
                runtime: getRuntime(filePath),
                dependencies: [],
                autoRun: false
              },
              user_id: userId || user?.id || ''
            };

            const tempApp = await appDatabaseService.createDesktopApp(tempAppData, userId || user?.id || '');
            if (tempApp) {
              // 🔥 Electron：viewer 走独立窗口；Web：降级原 Dialog
              const electronApi = (window as any).electron;
              if (electronApi?.openAppViewerWindow) {
                electronApi.openAppViewerWindow({ appId: tempApp.id, name: tempApp.name });
              } else {
                setFileInitialApp(tempApp);
                setFileAppId(tempApp.id);
                setIsFileAppViewerOpen(true);
              }
            }
          } else {
            console.error('读取文件失败:', result.error);
            alert(`无法读取文件: ${result.error}`);
          }
        } else {
          console.warn('Electron userpcFile.read API 不可用');
        }
      } catch (error) {
        console.error('打开文件失败:', error);
      }
    };
    window.addEventListener('openProjectFile', handleOpenFile);

    const handleDesktopAppUpdated = () => {
      console.log('📡 [DesktopPanel] 收到 desktopAppUpdated 事件，刷新列表');
      fetchApps(true, undefined, true);
    };
    window.addEventListener('desktopAppUpdated', handleDesktopAppUpdated);

    // 🔥 跨窗口联动：独立 viewer 窗口更新/关闭时通过 localStorage storage 事件通知（同源窗口共享）
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'desktopAppUpdatedSignal' && e.newValue) {
        fetchApps(true, undefined, true);
      }
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('trainProjectFilesChanged', handleFilesChanged);
      unsubscribeAppCreated();
      window.removeEventListener('openProjectFile', handleOpenFile);
      window.removeEventListener('desktopAppUpdated', handleDesktopAppUpdated);
      window.removeEventListener('storage', handleStorage);
    };
  }, [userId, user?.id, handleAppUpdated, fetchApps]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollTop + clientHeight >= scrollHeight * 0.9 && hasMore && !loading) {
      loadMoreApps(appTypeFilter);
    }
  }, [hasMore, loading, loadMoreApps, appTypeFilter]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-500">
        <p>{t('workspace.desktopModule.desktopAppViewer.errorOccurred')}: {error}</p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 h-full flex flex-col">
      <ScrollArea className="flex-1" onScroll={handleScroll}>
        <div className="p-4">
          {loading && apps.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <div className="flex items-center space-x-2">
                <div className="animate-spin h-4 w-4 border-2 border-gray-300 border-t-blue-600 rounded-full"></div>
                <span className="text-sm text-gray-500">{t('workspace.desktopModule.codeEditor.loading')}</span>
              </div>
            </div>
          ) : apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-gray-300">
              <p>{t('workspace.desktopModule.desktopAppViewer.noAppsFound')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {apps.map((app, idx) => (
                <div key={app.id} className="w-full min-w-0 flex-shrink-0 flex flex-col">
                  <DesktopAppCard
                    app={app}
                    index={idx + 1}
                    hasResident={residentAppIds.has(app.id)}
                    onAppUpdated={handleAppUpdated}
                    onAppDeleted={handleAppDelete}
                    conversationId={conversationId}
                  />
                  <div className="flex gap-1 mt-1 justify-center">
                    <button
                      onClick={() => {
                        if (app?.id) {
                          const event = new CustomEvent('insertAppReference', {
                            detail: { projectId: app.id.substring(0, 8) }
                          });
                          window.dispatchEvent(event);
                        }
                      }}
                      className="p-1 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      title={t('workspace.desktopModule.desktopPanel.referenceApp')}
                    >
                      <AtSign size={14} />
                    </button>
                    <button
                      onClick={() => handleAppFork(app)}
                      className="p-1 text-gray-600 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors"
                      title={t('workspace.desktopModule.desktopPanel.splitVersion')}
                    >
                      <GitFork size={14} />
                    </button>
                    <button
                      onClick={() => {
                        // 🔥 系统基础项目（如扩展工具）不可删除，直接提示，不进确认流程
                        if (app.app_type === 'system_base') {
                          toast.info(t('workspace.desktopModule.desktopPanel.systemProjectNoDelete'));
                          return;
                        }
                        if (window.confirm(t('workspace.desktopModule.desktopAppCard.deleteDescription'))) {
                          handleAppDelete(app.id);
                        }
                      }}
                      className={`p-1 rounded transition-colors ${
                        app.app_type === 'system_base'
                          ? 'text-gray-300 cursor-not-allowed'
                          : 'text-gray-600 hover:text-red-600 hover:bg-red-50'
                      }`}
                      title={app.app_type === 'system_base' ? t('workspace.desktopModule.desktopPanel.systemProjectTitle') : t('workspace.desktopModule.desktopAppCard.deleteApp')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
              
              {hasMore && (
                <div className="flex justify-center py-4">
                  <button
                    onClick={() => loadMoreApps(appTypeFilter)}
                    className="text-sm text-blue-500 hover:text-blue-700"
                    disabled={loading}
                  >
                    {loading ? t('workspace.desktopModule.codeEditor.loading') : t('workspace.desktopModule.desktopAppViewer.loadingApps')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {fileAppId && (
        <Dialog open={isFileAppViewerOpen} onOpenChange={setIsFileAppViewerOpen}>
          <DialogContent className="w-[95vw] max-w-6xl h-[85vh] p-0" hideCloseButton>
            <DialogHeader className="sr-only">
              <DialogTitle>{t('workspace.desktopModule.desktopPanel.fileViewerTitle')}</DialogTitle>
            </DialogHeader>
            <DesktopAppViewer
              appId={fileAppId}
              userId={userId || user?.id || ''}
              isOpen={isFileAppViewerOpen}
              onClose={() => {
                setIsFileAppViewerOpen(false);
                setFileAppId(null);
                setFileInitialApp(null);
              }}
              initialApp={fileInitialApp || undefined}
              onAppUpdated={() => {}}
              conversationId={conversationId}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
