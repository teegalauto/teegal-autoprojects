import { useState, useCallback, useRef, useEffect } from 'react';
import { desktopAppStorage } from '@/services/storage';
import { DesktopApp } from '@/components/workspace/DesktopModule/types/DesktopAppTypes';
import { desktopAppEventService } from '@/services/events/DesktopAppEventService';
import { mapDbAppToDesktopApp } from '@/utils/workspace/desktopAppUtils';

interface DesktopAppCacheOptions {
  pageSize?: number;
}

interface DesktopAppCacheState {
  apps: DesktopApp[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  totalCount: number;
}

export const useDesktopAppCache = (userId?: string, options: DesktopAppCacheOptions = {}) => {
  const { pageSize = 4 } = options;
  
  const [state, setState] = useState<DesktopAppCacheState>({
    apps: [],
    loading: false,
    error: null,
    hasMore: true,
    totalCount: 0,
  });

  const cacheRef = useRef<Map<string, DesktopApp[]>>(new Map());
  const totalCountRef = useRef<number>(0);
  // 🔥 拉取成功标记：后端冷启动兜底重试用
  const fetchSucceededRef = useRef(false);
  // 🔥 当前已加载数量 ref：keepCount 刷新时按它拉取（避免闭包过期 + 不把 fetchApps 依赖挂上 state）
  const appsLengthRef = useRef(0);
  appsLengthRef.current = state.apps.length;

  const fetchApps = useCallback(async (silent = false, appType?: 'normal' | 'system_base', keepCount = false) => {
    if (!userId) {
      setState(prev => ({ ...prev, loading: false }));
      return;
    }

    try {
      if (!silent) {
        setState(prev => ({ ...prev, loading: true, error: null }));
      }

      // 🔥 keepCount：刷新时保留已加载的分页数量（跨窗口联动/更新事件重拉时，不把已展开的列表缩回第一页）
      const fetchCount = keepCount ? Math.max(pageSize, appsLengthRef.current) : pageSize;

      // 🔥 使用本地存储服务获取应用列表（appType 可选类型过滤）
      const desktopApps = await desktopAppStorage.getByUserId(userId, fetchCount, 0, appType);
      const count = desktopApps.length;

      const mappedApps = desktopApps?.map((dbApp: any) => mapDbAppToDesktopApp(dbApp)) || [];

      // 🔥 修复：当返回数量等于 pageSize 时，认为可能还有更多数据
      const hasMore = count >= fetchCount;

      setState({
        apps: mappedApps,
        loading: false,
        error: null,
        hasMore,
        totalCount: count,
      });

      cacheRef.current.set(userId, mappedApps);
      totalCountRef.current = count;
      // 🔥 拉取成功（含"新用户项目为空"）：标记成功，冷启动兜底不再重试
      fetchSucceededRef.current = true;

    } catch (err: any) {
      // 🔥 拉取失败（如后端未就绪）：标记失败，允许冷启动兜底重试
      fetchSucceededRef.current = false;
      setState(prev => ({
        ...prev,
        loading: false,
        error: err.message,
      }));
    }
  }, [userId, pageSize]);

  const loadMoreApps = useCallback(async (appType?: 'normal' | 'system_base') => {
    if (!userId || state.loading || !state.hasMore) return;

    try {
      setState(prev => ({ ...prev, loading: true }));

      // 🔥 使用本地存储服务加载更多应用（appType 可选类型过滤）
      const desktopApps = await desktopAppStorage.getByUserId(userId, pageSize, state.apps.length, appType);

      const mappedApps = desktopApps?.map((dbApp: any) => mapDbAppToDesktopApp(dbApp)) || [];

      // 🔥 修复：当返回数量等于 pageSize 时，认为可能还有更多数据
      const hasMore = mappedApps.length >= pageSize;

      setState(prev => ({
        ...prev,
        apps: [...prev.apps, ...mappedApps],
        loading: false,
        hasMore,
      }));

      cacheRef.current.set(userId, [...state.apps, ...mappedApps]);

    } catch (err: any) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: err.message,
      }));
    }
  }, [userId, state.apps.length, state.hasMore, state.loading, state.totalCount, pageSize]);

  const updateAppInCache = useCallback((appId: string, updates: Partial<DesktopApp>) => {
    setState(prev => ({
      ...prev,
      apps: prev.apps.map(app => 
        app.id === appId ? { ...app, ...updates } : app
      ),
    }));

    const cachedApps = cacheRef.current.get(userId || '');
    if (cachedApps) {
      cacheRef.current.set(userId || '', cachedApps.map(app => 
        app.id === appId ? { ...app, ...updates } : app
      ));
    }
  }, [userId]);

  const addAppToCache = useCallback((newApp: DesktopApp) => {
    setState(prev => {
      // 🔥 去重：基础项目创建广播等场景可能重复触发，已存在则不重复插入
      if (prev.apps.some(app => app.id === newApp.id)) return prev;
      return {
        ...prev,
        apps: [newApp, ...prev.apps],
        totalCount: prev.totalCount + 1,
      };
    });

    const cachedApps = cacheRef.current.get(userId || '');
    if (cachedApps && !cachedApps.some(app => app.id === newApp.id)) {
      cacheRef.current.set(userId || '', [newApp, ...cachedApps]);
    }
  }, [userId]);

  const removeAppFromCache = useCallback((appId: string) => {
    setState(prev => ({
      ...prev,
      apps: prev.apps.filter(app => app.id !== appId),
      totalCount: Math.max(0, prev.totalCount - 1),
    }));

    const cachedApps = cacheRef.current.get(userId || '');
    if (cachedApps) {
      cacheRef.current.set(userId || '', cachedApps.filter(app => app.id !== appId));
    }
  }, [userId]);

  const clearCache = useCallback(() => {
    setState({
      apps: [],
      loading: false,
      error: null,
      hasMore: true,
      totalCount: 0,
    });
    cacheRef.current.clear();
    totalCountRef.current = 0;
  }, []);

  // 🔥 用户身份变更（切换账号/登出）：立即清空上一用户的项目列表，避免残留旧数据；
  //    切换到新用户时清空后由调用方的 fetchApps effect 自动重拉
  const lastUserIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastUserIdRef.current === userId) return;
    lastUserIdRef.current = userId;
    clearCache();
    fetchSucceededRef.current = false;
  }, [userId, clearCache]);

  // 🔥 后端冷启动兜底：与 useConversationHistory 一致——本地缓存恢复登录比后端启动快，
  //    首次拉取可能撞上后端未就绪（报错/空列表且成功标记未置位），每 5s 重试直到成功。
  //    新用户"成功但项目为空"同样会置成功标记，不会无限重试。
  useEffect(() => {
    if (!userId) return;
    const timer = setInterval(() => {
      if (!fetchSucceededRef.current) {
        fetchApps(true);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [userId, fetchApps]);

  const refreshApp = useCallback(async (appId: string) => {
    if (!userId) return;

    try {
      // 🔥 使用本地存储服务刷新应用
      const data = await desktopAppStorage.getById(appId);

      if (!data) return null;

      const mappedApp = mapDbAppToDesktopApp(data);

      updateAppInCache(appId, mappedApp);
      return mappedApp;
    } catch (err: any) {
      console.error('Error refreshing app:', err);
      return null;
    }
  }, [userId, updateAppInCache]);

  useEffect(() => {
    const unsubscribeAppCreated = desktopAppEventService.subscribe('app_created', (event) => {
      if (event.userId === userId && event.data) {
        addAppToCache(event.data);
      }
    });

    const unsubscribeAppUpdated = desktopAppEventService.subscribe('app_updated', (event) => {
      if (event.userId === userId && event.data) {
        updateAppInCache(event.appId, event.data);
      }
    });

    const unsubscribeAppDeleted = desktopAppEventService.subscribe('app_deleted', (event) => {
      if (event.userId === userId) {
        removeAppFromCache(event.appId);
      }
    });

    const unsubscribeAppRefreshed = desktopAppEventService.subscribe('app_refreshed', (event) => {
      if (event.userId === userId && event.data) {
        updateAppInCache(event.appId, event.data);
      }
    });

    return () => {
      unsubscribeAppCreated();
      unsubscribeAppUpdated();
      unsubscribeAppDeleted();
      unsubscribeAppRefreshed();
    };
  }, [userId, addAppToCache, updateAppInCache, removeAppFromCache]);

  return {
    apps: state.apps,
    loading: state.loading,
    error: state.error,
    hasMore: state.hasMore,
    totalCount: state.totalCount,
    fetchApps,
    loadMoreApps,
    updateAppInCache,
    addAppToCache,
    removeAppFromCache,
    clearCache,
    refreshApp,
  };
};
