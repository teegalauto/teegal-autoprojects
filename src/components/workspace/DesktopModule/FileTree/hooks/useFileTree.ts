/**
 * 文件树状态管理 Hook
 * 
 * 🔥 git 化架构（isomorphic-git 快照）：
 * - 工作目录：当前版本（可直接编辑）
 * - HEAD：最近一次「接受修改」checkpoint
 * - changes：相对 HEAD 的变更文件列表（ChangeList 数据源）
 * 
 * 🔥 跨平台：所有目录操作通过 Electron IPC API（read-directory），
 * 不依赖 PowerShell/Bash 命令，Windows/macOS/Linux 通用。
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { FileNode, FileHistory, FileVersion, FileTreeState } from '../types';
import { sortFileNodes, filterFileNodes } from '../utils';
import { getAppBasePath } from '@/utils/apptool/AppPathHelper';

/**
 * 🔥 模块级缓存：按 appId 缓存文件树数据
 * 
 * 避免每次打开 Dialog 都重新扫描目录：
 * - 首次打开：正常加载（显示 loading）
 * - 再次打开：立即返回缓存数据，后台静默刷新
 */
interface FileTreeCache {
  files: FileNode[];
  changes: FileHistory[];
  timestamp: number;
}
const fileTreeCache = new Map<string, FileTreeCache>();

const CACHE_TTL = 30 * 1000; // 30秒内不重复加载

export function useFileTree(appId: string) {
  const [state, setState] = useState<FileTreeState>(() => {
    // 🔥 初始化时先读缓存，避免白屏
    const cached = fileTreeCache.get(appId);
    if (cached) {
      return {
        files: cached.files,
        changes: cached.changes,
        loading: false, // 有缓存时不显示 loading
        error: '',
      };
    }
    return {
      files: [],
      changes: [],
      loading: true,
      error: '',
    };
  });

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // 🔥 使用 ref 保存最新的 expandedDirs，避免 refresh 函数依赖 expandedDirs 导致频繁重建
  const expandedDirsRef = useRef(expandedDirs);
  useEffect(() => {
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs]);

  /**
   * 加载文件树
   */
  const loadFileTree = useCallback(async (silent = false) => {
    if (!appId) return;

    // 🔥 检查缓存是否未过期，未过期则跳过
    const cached = fileTreeCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('[FileTree] 使用缓存，跳过加载:', appId);
      setState({
        files: cached.files,
        changes: cached.changes,
        loading: false,
        error: '',
      });
      return;
    }

    // 🔥 silent 模式不设置 loading: true，避免子组件（ChangeList）因卸载丢失状态
    if (!silent) {
      setState(prev => ({ ...prev, loading: true, error: '' }));
    }

    try {
      const electron = (window as any).electron;

      // 🔥 获取文件目录（支持导入项目的自定义路径）
      const filesDir = await getAppBasePath(appId);

      // 🔥 加载 files 目录（当前版本）
      const allFiles = await scanDirectory(filesDir);
      const files = allFiles.filter(f => f.name !== 'history'); // 🔥 兼容：隐藏旧版 history 目录残留

      // 🔥 加载相对 HEAD 的变更文件列表（git status）
      const changes = await loadChanges();

      const sortedFiles = sortFileNodes(filterFileNodes(files));
      const sortedChanges = changes;

      setState({
        files: sortedFiles,
        changes: sortedChanges,
        loading: false,
        error: '',
      });

      // 🔥 写入缓存
      fileTreeCache.set(appId, {
        files: sortedFiles,
        changes: sortedChanges,
        timestamp: Date.now(),
      });

      console.log('[FileTree] 加载完成:', { filesCount: sortedFiles.length, changesCount: sortedChanges.length });

    } catch (error: any) {
      console.error('[FileTree] 加载失败:', error);
      setState(prev => ({
        ...prev,
        loading: false,
        error: error.message || '加载文件树失败',
      }));
    }
  }, [appId]);

  /**
   * 扫描目录
   * 🔥 跨平台：使用 Electron IPC API（read-directory），不依赖 PowerShell
   */
  const scanDirectory = async (dir: string): Promise<FileNode[]> => {
    try {
      const electron = (window as any).electron;

      if (electron?.readDirectory) {
        const result = await electron.readDirectory(dir);
        if (result.success && result.files) {
          return result.files.map((f: any) => ({
            name: f.name,
            path: f.path,
            relativePath: f.relativePath || f.name,
            type: f.type,
            ext: f.ext,
            size: f.size,
            children: f.children,
          }));
        }
      }

      return [];

    } catch (error) {
      console.error('[FileTree] 扫描目录失败:', dir, error);
      return [];
    }
  };

  /**
   * 🔥 加载相对 HEAD 的变更文件列表（git status）
   * 复用 FileHistory 结构：fileName=相对路径，version.versionName=changeType
   */
  const loadChanges = async (): Promise<FileHistory[]> => {
    try {
      const electron = (window as any).electron;
      if (!electron?.listAppCodeChanges) return [];

      const result = await electron.listAppCodeChanges({ appId });
      const list: any[] = result?.success ? (result.changes || []) : [];

      return list.map(c => ({
        fileName: c.fileName,
        filePath: '',
        version: {
          versionName: c.changeType || 'modified',
          path: '',
          createdAt: '',
        },
      }));
    } catch (error) {
      console.error('[FileTree] 加载变更列表失败:', error);
      return [];
    }
  };

  /**
   * 展开/折叠目录
   */
  const toggleDir = useCallback(async (path: string) => {
    const isCurrentlyExpanded = expandedDirs.has(path);
    
    if (isCurrentlyExpanded) {
      // 折叠
      setExpandedDirs(prev => {
        const newSet = new Set(prev);
        newSet.delete(path);
        return newSet;
      });
    } else {
      // 展开 - 先加载子目录，失败则不展开（避免"展开图标但无内容"的假亮）
      const children = await loadSubDirectory(path);
      if (!children) return;
      setExpandedDirs(prev => {
        const newSet = new Set(prev);
        newSet.add(path);
        return newSet;
      });
    }
  }, [expandedDirs]);

  /**
   * 加载子目录
   * 🔥 返回加载到的 children（失败返回 null），调用方据此决定是否亮展开态
   */
  const loadSubDirectory = async (dirPath: string): Promise<FileNode[] | null> => {
    try {
      const electron = (window as any).electron;

      if (!electron?.readDirectory) return null;

      const result = await electron.readDirectory(dirPath);
      if (!result.success || !result.files) return null;

      const children = sortFileNodes(result.files.map((f: any) => ({
        name: f.name,
        path: f.path,
        relativePath: f.relativePath || f.name,
        type: f.type,
        ext: f.ext,
        size: f.size,
        children: f.type === 'directory' ? [] : undefined,
      })));

      // 找到对应的节点并添加 children
      setState(prev => {
        const updateNodeChildren = (nodes: FileNode[]): FileNode[] => {
          return nodes.map(node => {
            if (node.path === dirPath) {
              return { ...node, children };
            }
            if (node.children) {
              return {
                ...node,
                children: updateNodeChildren(node.children),
              };
            }
            return node;
          });
        };

        return {
          ...prev,
          files: updateNodeChildren(prev.files),
        };
      });

      return children;
    } catch (error) {
      console.error('[FileTree] 加载子目录失败:', dirPath, error);
      return null;
    }
  };

  /**
   * 判断目录是否展开
   */
  const isDirExpanded = useCallback((path: string) => {
    return expandedDirs.has(path);
  }, [expandedDirs]);

  /**
   * 刷新文件树
   * 🔥 强制刷新（忽略缓存），用于文件变更事件
   * 🔥 使用 ref 读取 expandedDirs，避免函数依赖 expandedDirs 导致重建
   */
  const refresh = useCallback(async () => {
    // 🔥 强制刷新前清除缓存
    fileTreeCache.delete(appId);

    // 🔥 保存当前展开的目录（从 ref 读取）
    const currentExpandedDirs = new Set(expandedDirsRef.current);

    // 🔥 静默刷新：不设 loading: true，避免 ChangeList 被卸载丢失 diffStats
    await loadFileTree(true);

    // 🔥 重新加载已展开目录的子目录；读取失败的目录（被删/瞬时不可用）从展开态移除，
    // 避免"展开图标但无内容"的残留假亮
    const failedDirs: string[] = [];
    for (const dirPath of currentExpandedDirs) {
      const ok = await loadSubDirectory(dirPath);
      if (!ok) failedDirs.push(dirPath);
    }
    if (failedDirs.length > 0) {
      setExpandedDirs(prev => {
        const newSet = new Set(prev);
        failedDirs.forEach(p => newSet.delete(p));
        return newSet;
      });
    }

    // 🔥 恢复展开状态（剔除读取失败的目录）
    const restored = new Set(currentExpandedDirs);
    failedDirs.forEach(p => restored.delete(p));
    setExpandedDirs(restored);
  }, [loadFileTree, appId]);

  /**
   * 初始加载
   * 🔥 只依赖 appId，不依赖 loadFileTree（loadFileTree 只依赖 appId，引用稳定）
   */
  useEffect(() => {
    const cached = fileTreeCache.get(appId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      // 🔥 缓存未过期，跳过加载
      console.log('[FileTree] 使用缓存，跳过加载:', appId);
      return;
    }
    // 🔥 无缓存或已过期，静默刷新（不显示 loading，避免闪烁）
    loadFileTree();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  /**
   * 🔥 如果顶层只有一个文件夹，自动展开
   * 多个顶层节点时不自动展开
   */
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    // 🔥 切换 appId 时重置
    autoExpandedRef.current = false;
  }, [appId]);
  useEffect(() => {
    const tryAutoExpand = async () => {
      if (state.loading || state.files.length === 0) return;
      if (autoExpandedRef.current) return; // 只自动展开一次

      if (state.files.length === 1 && state.files[0].type === 'directory') {
        const dirPath = state.files[0].path;
        // 🔥 读取成功才亮展开态并锁定（失败不锁定，下次 effect 自动重试）
        const children = await loadSubDirectory(dirPath);
        if (children) {
          autoExpandedRef.current = true;
          setExpandedDirs(prev => {
            const newSet = new Set(prev);
            newSet.add(dirPath);
            return newSet;
          });
        }
      }
    };
    tryAutoExpand();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loading, state.files]);

  /**
   * 🔥 监听 agent 文件操作事件，自动刷新（带防抖）
   * agent 短时间内可能保存多个文件，防抖避免频繁刷新
   * 🔥 只依赖 appId，refresh 通过 ref 调用，避免函数引用变化导致重新注册
   */
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const handleFilesChanged = (event: CustomEvent) => {
      const { appId: changedAppId } = event.detail || {};
      
      // 只刷新当前 appId 的文件树
      if (changedAppId === appId) {
        // 🔥 防抖：500ms 内多次事件只执行一次刷新
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
        }
        refreshTimerRef.current = setTimeout(() => {
          console.log('[FileTree] 收到文件变更事件，刷新文件树（防抖）');
          refreshRef.current();
          refreshTimerRef.current = null;
        }, 500);
      }
    };

    window.addEventListener('trainProjectFilesChanged', handleFilesChanged as EventListener);
    
    return () => {
      window.removeEventListener('trainProjectFilesChanged', handleFilesChanged as EventListener);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [appId]);

  return {
    ...state,
    expandedDirs,
    toggleDir,
    isDirExpanded,
    refresh,
    loadFileTree,
  };
}

/**
 * 🔥 清除指定 appId 的文件树缓存
 * 在删除应用时调用，避免残留缓存
 */
export function clearFileTreeCache(appId?: string) {
  if (appId) {
    fileTreeCache.delete(appId);
  } else {
    fileTreeCache.clear();
  }
}
