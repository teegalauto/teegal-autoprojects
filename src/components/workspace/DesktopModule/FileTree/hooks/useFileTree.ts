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
import { getAppBasePath, getCodePath } from '@/utils/apptool/AppPathHelper';

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

const CACHE_TTL = 10 * 1000; // 10秒内不重复加载（无感刷新上线后重扫无视觉副作用，频率可提高）

/**
 * 🔥 变更列表独立缓存：listAppCodeChanges 是全树逐文件 readFile+hash 的重操作
 * （数千文件），focus/拖动等高频触发源必须在短 TTL 内复用结果，否则连续全树
 * hash 直接卡死。文件变更事件（trainProjectFilesChanged）走 forceChanges 强刷。
 */
interface ChangesCache {
  changes: FileHistory[];
  timestamp: number;
  codePath: string; // 🔥 归属校验：导入/取消导入会更换 codePath，目录变了缓存必须作废
}
const changesCache = new Map<string, ChangesCache>();
const CHANGES_TTL = 10 * 1000; // 10秒内复用变更列表

/**
 * 🔥 按绝对路径把旧树中已加载的 children 继承到新扫描结果上。
 * read-directory 是单层扫描：root 重扫若直接整树替换，展开目录的 children 会被清空，
 * 视觉上就是"整树收起再重新展开"（有感刷新）。继承旧 children 后，
 * 随后的 loadSubDirectory 仍会刷新这些目录的内容。
 */
function mergePrevChildren(fresh: FileNode[], prev: FileNode[] | undefined): FileNode[] {
  // 🔥 prev 可为 undefined（未加载过的目录 node.children 就是 undefined）或空数组，无旧可继承
  if (!prev || prev.length === 0) return fresh;
  const prevMap = new Map(prev.map(n => [n.path, n]));
  return fresh.map(n => {
    if (n.type !== 'directory') return n;
    const old = prevMap.get(n.path);
    return old?.children ? { ...n, children: old.children } : n;
  });
}

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

  // 🔥 项目代码根目录（绝对路径）：scanDirectory/loadSubDirectory 用它计算每个节点的 relativePath
  // 主进程 read-directory 不返回 relativePath，若缺省回退到裸文件名，
  // 会导致嵌套目录/文件的新建落点、删除路径全部错到根目录
  const basePathRef = useRef<string>('');
  const toRelativePath = (absolutePath: string): string => {
    // 🔥 统一分隔符后比较：getAppBasePath 可能返回混合分隔符（teegal/apps/{id}），
    // 而主进程 path.join 输出全反斜杠——直接 startsWith 会失败 → 回退裸文件名，
    // 多级目录前缀被丢（复制相对路径 b/c.py 变 c.py、嵌套文件删除也中招）
    const base = basePathRef.current.replace(/[\\/]+$/, '');
    const norm = (p: string) => p.replace(/\\/g, '/');
    if (base && norm(absolutePath).startsWith(norm(base))) {
      const rel = norm(absolutePath).slice(norm(base).length).replace(/^\/+/, '');
      return rel || '';
    }
    return absolutePath.split(/[\\/]/).pop() || '';
  };

  // 🔥 使用 ref 保存最新的 expandedDirs，避免 refresh 函数依赖 expandedDirs 导致频繁重建
  const expandedDirsRef = useRef(expandedDirs);
  useEffect(() => {
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs]);

  /**
   * 加载文件树
   */
  const loadFileTree = useCallback(async (silent = false, forceChanges = false, freshScan = false) => {
    if (!appId) return;

    // 🔥 检查缓存是否未过期，未过期则跳过（freshScan=强制重扫，绕过 TTL 但保留旧缓存作 diff 基准）
    const cached = fileTreeCache.get(appId);
    if (!freshScan && cached && Date.now() - cached.timestamp < CACHE_TTL && !forceChanges) {
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
      basePathRef.current = filesDir;

      // 🔥 加载 files 目录（当前版本）
      const allFiles = await scanDirectory(filesDir);
      const files = allFiles.filter(f => f.name !== 'history'); // 🔥 兼容：隐藏旧版 history 目录残留

      // 🔥 继承旧树的已展开 children，避免整树替换造成"收起再展开"的有感刷新
      const prevCache = fileTreeCache.get(appId);
      const mergedFiles = prevCache ? mergePrevChildren(files, prevCache.files) : files;

      // 🔥 加载相对 HEAD 的变更文件列表（git status）；短 TTL 内复用，forceChanges 强刷
      const changes = await loadChanges(forceChanges);

      const sortedFiles = sortFileNodes(filterFileNodes(mergedFiles));
      const sortedChanges = changes;

      // 🔥 静默 diff：树结构与变更列表均无变化时完全不 setState（零重渲染）；
      // 有变化才更新——节点按 path 复用 DOM，只有新增/删除的条目有视觉变化
      const filesJson = JSON.stringify(sortedFiles);
      const changesJson = JSON.stringify(sortedChanges);
      const unchanged = !!prevCache
        && JSON.stringify(prevCache.files) === filesJson
        && JSON.stringify(prevCache.changes) === changesJson;
      if (!unchanged) {
        setState({
          files: sortedFiles,
          changes: sortedChanges,
          loading: false,
          error: '',
        });
      }

      // 🔥 写入缓存
      fileTreeCache.set(appId, {
        files: sortedFiles,
        changes: sortedChanges,
        timestamp: Date.now(),
      });

      console.log('[FileTree] 加载完成:', {
        filesCount: sortedFiles.length,
        changesCount: sortedChanges.length,
        silent: !!unchanged,
      });

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
            relativePath: toRelativePath(f.path),
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
  const loadChanges = async (force = false): Promise<FileHistory[]> => {
    try {
      const electron = (window as any).electron;
      if (!electron?.listAppCodeChanges) return [];

      // 🔥 传入 codePath：导入项目的 git 仓库在自定义目录，不传会读到默认 apps/<appId> 目录，
      // 导致导入项目里（尤其新建子文件夹的文件）的变更永远查不出来
      const cp = await getCodePath(appId);
      const codePath = cp || '';

      // 🔥 短 TTL 内复用上次结果（全树 hash 重操作，见 changesCache 注释）；
      // codePath 变了（重新导入/取消导入）立即作废
      const cached = changesCache.get(appId);
      if (!force && cached && cached.codePath === codePath
          && Date.now() - cached.timestamp < CHANGES_TTL) {
        return cached.changes;
      }

      const result = await electron.listAppCodeChanges({ appId, codePath: cp || undefined });
      const list: any[] = result?.success ? (result.changes || []) : [];

      const mapped = list.map(c => ({
        fileName: c.fileName,
        filePath: '',
        version: {
          versionName: c.changeType || 'modified',
          path: '',
          createdAt: '',
        },
        changeType: c.changeType || 'modified',
      }));
      changesCache.set(appId, { changes: mapped, timestamp: Date.now(), codePath });
      return mapped;
    } catch (error) {
      console.error('[FileTree] 加载变更列表失败:', error);
      return [];
    }
  };

  // 🔥 相对路径 → 绝对路径归一化（expandedDirs/toggleDir 均以绝对路径为键；
  // resolveTargetDir 等场景传入的是相对路径，需先转换）
  const toAbsolutePath = (p: string): string => {
    // 🔥 绝对路径直接返回：Windows 盘符（C:\）、UNC（\\）、POSIX（/开头，macOS/Linux）；
    // 缺 POSIX 判定会把 Mac 的绝对路径当相对路径拼出 doubling 垃圾路径，
    // readDirectory 必败 → 目录永远点不开（Mac 独有的文件树展开 bug 根因）
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')) return p;
    const base = basePathRef.current.replace(/[\\/]+$/, '');
    return base ? `${base}/${p.replace(/^[\\/]+/, '')}` : p;
  };

  /**
   * 展开/折叠目录
   */
  const toggleDir = useCallback(async (path: string) => {
    const absPath = toAbsolutePath(path);
    const isCurrentlyExpanded = expandedDirs.has(absPath);

    if (isCurrentlyExpanded) {
      // 折叠
      setExpandedDirs(prev => {
        const newSet = new Set(prev);
        newSet.delete(absPath);
        return newSet;
      });
    } else {
      // 展开 - 先加载子目录，失败则不展开（避免"展开图标但无内容"的假亮）
      const children = await loadSubDirectory(absPath);
      if (!children) return;
      setExpandedDirs(prev => {
        const newSet = new Set(prev);
        newSet.add(absPath);
        return newSet;
      });
      // 🔥 一致性兜底：子树中"标记展开但内容为空"的目录递归补载，
      // 让 expandedDirs 状态与树数据保持一致（历史假态/意外清空的自愈）
      await ensureExpandedChildrenLoaded(children);
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
        relativePath: toRelativePath(f.path),
        type: f.type,
        ext: f.ext,
        size: f.size,
        children: f.type === 'directory' ? [] : undefined,
      })));

      // 找到对应的节点并添加 children
      let mergedChildren = children;
      setState(prev => {
        const updateNodeChildren = (nodes: FileNode[]): FileNode[] => {
          return nodes.map(node => {
            if (node.path === dirPath) {
              // 🔥 继承旧树中已加载的深层 children：read-directory 是单层扫描，fresh 的
              // 嵌套目录 children 是空 []；直接替换会清掉深层已加载内容，而 expandedDirs
              // 仍标记展开 → 出现"图标展开但内容为空"的假态（收起上级再展开必现）
              mergedChildren = mergePrevChildren(children, node.children);
              return JSON.stringify(node.children) === JSON.stringify(mergedChildren)
                ? node
                : { ...node, children: mergedChildren };
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

      return mergedChildren;
    } catch (error) {
      console.error('[FileTree] 加载子目录失败:', dirPath, error);
      return null;
    }
  };

  /**
   * 🔥 递归补载"标记展开但内容为空"的目录，恢复 expandedDirs 与树数据的一致性。
   * 正常路径靠 loadSubDirectory 的深层 children 继承即可恢复；本兜底覆盖
   * 数据意外丢失的场景（继承源本身为空等）。
   */
  const ensureExpandedChildrenLoaded = async (nodes: FileNode[]): Promise<void> => {
    for (const n of nodes) {
      if (n.type !== 'directory') continue;
      if (expandedDirsRef.current.has(n.path) && (!n.children || n.children.length === 0)) {
        const sub = await loadSubDirectory(n.path);
        if (sub) await ensureExpandedChildrenLoaded(sub);
      } else if (n.children?.length) {
        await ensureExpandedChildrenLoaded(n.children);
      }
    }
  };

  /**
   * 判断目录是否展开
   */
  const isDirExpanded = useCallback((path: string) => {
    return expandedDirs.has(toAbsolutePath(path));
  }, [expandedDirs]);

  /**
   * 刷新文件树
   * 🔥 强制刷新（忽略缓存），用于文件变更事件
   * 🔥 forceChanges=true 强刷变更列表（agent 改完文件/接受修改后必须重算全树 hash）；
   * 缺省复用 10s TTL 内的变更列表（focus/拖动触发，避免连续全树 hash 卡死）
   * 🔥 使用 ref 读取 expandedDirs，避免函数依赖 expandedDirs 导致重建
   */
  const refresh = useCallback(async (opts?: { forceChanges?: boolean }) => {
    // 🔥 强制重扫（freshScan 绕过 TTL），但绝不能删缓存：prevCache 是 children 继承与
    //    静默 diff 的基准，删了它 diff 永远 miss → 每次刷新整树重挂（有感刷新）
    await loadFileTree(true, opts?.forceChanges ?? false, true);

    // 🔥 保存当前展开的目录（从 ref 读取）
    const currentExpandedDirs = new Set(expandedDirsRef.current);

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
          // 🔥 agent 改完文件/接受修改：变更列表必须强刷（绕过 10s TTL 重算全树 hash）
          refreshRef.current({ forceChanges: true });
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

  // 🔥 窗口聚焦时静默刷新：用户在系统文件管理器新建/删除文件后切回应用即可看到，
  // 不需要重新导入/重进项目（refresh 自带清缓存 + 保展开态）
  // 🔥 60s 新鲜度阈值：alt-tab 切窗口（几分钟内）不重扫，离开较久才刷新——
  //    每次聚焦全量重扫所有展开目录既卡又造成目录"不稳定"的观感；应用内改动走事件刷新不受影响
  const lastFocusRefreshRef = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 60000) return;
      lastFocusRefreshRef.current = now;
      refreshRef.current();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

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
