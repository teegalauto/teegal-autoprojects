import { useState, useEffect, useCallback } from 'react';
import { desktopAppStorage } from '@/services/storage';
import { DesktopApp, CodeVersion } from '@/components/workspace/DesktopModule/types/DesktopAppTypes';
import { desktopAppEventService } from '@/services/events/DesktopAppEventService';
import { mapDbAppToDesktopApp, parsePreview } from '@/utils/workspace/desktopAppUtils';
import { appDatabaseService } from '@/utils/apptool/AppDatabaseService';

/**
 * 🔥 已迁移到本地存储
 */
export const useDesktopApp = (userId?: string) => {
  const [apps, setApps] = useState<DesktopApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 获取用户的所有desktop app
  const fetchApps = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const desktopApps = await desktopAppStorage.getByUserId(userId);

      // 将数据库字段映射到DesktopApp类型
      const mappedApps = desktopApps?.map((dbApp: any) => mapDbAppToDesktopApp(dbApp)) || [];

      setApps(mappedApps);
    } catch (err: any) {
      setError(err.message);
      console.error('Error fetching desktop apps:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // 删除desktop app
  const deleteApp = useCallback(async (id: string) => {
    try {
      const success = await desktopAppStorage.delete(id);
      if (!success) throw new Error('删除失败');

      // 🔥 物理清理磁盘目录（幂等，失败不影响删除结果；外部导入项目的用户自有目录不会被触碰）
      try {
        const electron = (window as any).electron;
        await electron?.deleteAppDir?.(id);
      } catch (e) {
        console.warn('[USE-DESKTOP-APP] 磁盘目录清理失败（不影响删除）:', e);
      }

      setApps(prev => prev.filter(app => app.id !== id));
      return true;
    } catch (err: any) {
      setError(err.message);
      console.error('Error deleting desktop app:', err);
      return false;
    }
  }, []);

  // 创建desktop app
  const createApp = useCallback(async (appData: Omit<DesktopApp, 'id' | 'userId' | 'createdAt' | 'updatedAt'>) => {
    if (!userId) return null;
    try {
      setLoading(true);
      const { appDatabaseService } = await import('@/utils/apptool/AppDatabaseService');
      const newApp = await appDatabaseService.createDesktopApp(appData, userId);
      if (newApp) {
        setApps(prev => [newApp, ...prev]);
      }
      return newApp;
    } catch (err: any) {
      setError(err.message);
      console.error('Error creating desktop app:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  // 获取单个应用的详情（包含代码版本）
  // 🔥 使用 appDatabaseService 从文件加载代码
  const getAppDetail = useCallback(async (id: string) => {
    if (!userId) return null;
    
    try {
      // 🔥 使用 appDatabaseService 从文件加载代码
      const app = await appDatabaseService.getDesktopApp(id, userId);
      return app;
    } catch (err) {
      console.error('Error fetching app detail:', err);
      return null;
    }
  }, [userId]);

  // 🔥 核心改进：订阅应用创建事件，实现 UI 实时同步
  // 将其放在最后，避免干扰前面的 Hook 顺序
  useEffect(() => {
    if (!userId) return;

    const unsubscribe = desktopAppEventService.subscribe('app_created', (event) => {
      if (event.userId === userId) {
        console.log('📢 [useDesktopApp] 监听到新应用创建，正在同步至列表:', event.appId);

        // 1. 获取新应用的完整数据（因为事件里只有 appId 和 data）
        // 这里我们可以复用 getAppDetail
        getAppDetail(event.appId).then(newApp => {
          if (newApp) {
            setApps(prev => {
              // 防止重复添加
              if (prev.some(a => a.id === newApp.id)) return prev;
              return [newApp, ...prev];
            });
          }
        });
      }
    });

    return () => unsubscribe();
  }, [userId, getAppDetail]);

  return {
    apps,
    loading,
    error,
    fetchApps,
    getAppDetail,
    createApp,
    deleteApp,
  };
};