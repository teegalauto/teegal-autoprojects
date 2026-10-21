/**
 * FileTree 模块主入口
 * 
 * 🔥 git 化架构（isomorphic-git 快照）：
 * - 工作目录：当前版本（可直接编辑）
 * - HEAD：最近一次「接受修改」checkpoint
 * - changes：相对 HEAD 的变更文件列表（ChangeList 数据源）
 */

import React, { useState } from 'react';
import { Loader2, AlertCircle, RefreshCw, Plus, FileText, FolderOpen, FolderInput, FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { CloneButton } from './components/CloneButton';
import { FileTreeNode } from './components/FileTreeNode';
import { ChangeList } from './components/ChangeList';
import { useFileTree } from './hooks/useFileTree';
import { FileNode, FileHistory } from './types';
import { createFile, createFolder, saveFile, deleteFile, renameFile, getHistoryContent, formatSize } from './utils';
import { getAppBasePath, getCodePath, setCodePathVerified, getUserDataPath } from '@/utils/apptool/AppPathHelper';
import { useToast } from '@/hooks/use-toast';

// 🔥 导出子模块
export { CloneButton } from './components/CloneButton';
export { FileTreeNode } from './components/FileTreeNode';
export { ChangeList } from './components/ChangeList';
export { useFileTree, clearFileTreeCache } from './hooks/useFileTree';
export { useGitClone } from './hooks/useGitClone';
export { createFile, createFolder, saveFile, deleteFile, renameFile, getHistoryContent, getCurrentFileContent } from './utils';

// 🔥 类型导出
export type { FileNode, FileHistory, FileOperationResult } from './types';

/**
 * FileTree 组件
 */
interface FileTreeProps {
  appId: string;
  onFileSelect?: (file: FileNode) => void;
  onViewHistory?: (fileName: string, content: string) => void;
  onViewDiff?: (fileName: string, oldCode: string, newCode: string) => void;
  onFileHandled?: (fileName: string, action: 'accept' | 'revert') => void;
}

export function FileTree({ appId, onFileSelect, onViewHistory, onViewDiff, onFileHandled }: FileTreeProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    files,
    changes,
    loading,
    error,
    expandedDirs,
    toggleDir,
    isDirExpanded,
    refresh,
  } = useFileTree(appId);

  const [selectedPath, setSelectedPath] = useState<string>('');
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [newInputMode, setNewInputMode] = useState<'file' | 'folder' | null>(null);
  const [newFileName, setNewFileName] = useState('main.py');
  const [importedPath, setImportedPath] = useState<string | null>(null);

  // 🔥 克隆期间轮询刷新：慢网络克隆耗时长，静默刷新让用户看到 repo 目录出现、文件落盘
  const [isCloning, setIsCloning] = useState(false);
  React.useEffect(() => {
    if (!isCloning) return;
    const timer = setInterval(() => { refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [isCloning, refresh]);

  // 🔥 初始化时读取 code_path
  React.useEffect(() => {
    const loadImportedPath = async () => {
      const cp = await getCodePath(appId);
      setImportedPath(cp);
    };
    loadImportedPath();
  }, [appId]);

  const handleFileSelect = (node: FileNode) => {
    setSelectedPath(node.path);
    // 🔥 目录选中仅作为新建文件/文件夹的落点，不触发编辑器打开
    if (node.type === 'directory') return;
    setSelectedChange(null); // 🔥 点击当前文件 → 清空变更记录选中
    onFileSelect?.(node);
  };

  const handleCloneSuccess = () => {
    // 🔥 整个 repo 刚落盘：变更列表强刷（一批 added 需立即入列）
    refresh({ forceChanges: true });
  };

  // 🔥 导入本地项目文件夹（跨平台：Windows/macOS 的 openDirectory 对话框）
  const handleImportFolder = async () => {
    const electron = (window as any).electron;
    if (!electron?.showOpenDialog) return;

    try {
      const result = await electron.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: t('workspace.desktopModule.fileTree.selectProjectFolder'),
        // 🔥 默认打开用户主目录，避开"文档"下无子目录时显示
        // "没有与搜索条件匹配的项"造成的困惑（选当前目录其实也能导入）
        defaultPath: await getUserDataPath(),
      });

      if (result.canceled || !result.filePaths?.[0]) return;

      const selectedPath = result.filePaths[0];
      // 🔥 写入并回读校验：IPC 链路每层吞错，不校验会出现 UI 显示已导入但 DB 没写入
      const ok = await setCodePathVerified(appId, selectedPath);
      if (!ok) {
        toast({
          title: t('workspace.desktopModule.fileTree.importFailedTitle'),
          description: t('workspace.desktopModule.fileTree.importFailedDesc'),
          variant: 'destructive',
          duration: 4000,
        });
        return;
      }
      setImportedPath(selectedPath);
      toast({
        title: t('workspace.desktopModule.fileTree.importSuccessTitle'),
        description: selectedPath,
        duration: 2500,
      });
      refresh();
    } catch (error) {
      console.error('[FileTree] 导入文件夹失败:', error);
      toast({
        title: t('workspace.desktopModule.fileTree.importFailedTitle'),
        description: String(error),
        variant: 'destructive',
        duration: 4000,
      });
    }
  };

  // 🔥 取消导入（恢复默认路径）
  const handleCancelImport = async () => {
    try {
      const ok = await setCodePathVerified(appId, null);
      if (!ok) {
        toast({
          title: t('workspace.desktopModule.fileTree.importFailedTitle'),
          description: t('workspace.desktopModule.fileTree.importFailedDesc'),
          variant: 'destructive',
          duration: 4000,
        });
        return;
      }
      setImportedPath(null);
      refresh();
    } catch (error) {
      console.error('[FileTree] 取消导入失败:', error);
    }
  };

  // 🔥 解析新建目标目录：选中目录 → 该目录；选中文件 → 其父目录；无选中 → 根目录
  const resolveTargetDir = (): string => {
    if (!selectedPath) return '';
    const find = (nodes: FileNode[]): FileNode | null => {
      for (const n of nodes) {
        if (n.path === selectedPath) return n;
        if (n.children) {
          const r = find(n.children);
          if (r) return r;
        }
      }
      return null;
    };
    const found = find(files);
    if (!found) return '';
    if (found.type === 'directory') return found.relativePath || found.name;
    const parts = (found.relativePath || found.name).split('/');
    parts.pop();
    return parts.join('/');
  };

  const handleCreateNew = async () => {
    if (!newFileName.trim()) return;

    const dir = resolveTargetDir();
    const targetName = dir ? `${dir}/${newFileName.trim()}` : newFileName.trim();

    const result = newInputMode === 'folder'
      ? await createFolder(appId, targetName)
      : await createFile(appId, targetName);

    if (result.success) {
      console.log('[FileTree] 创建成功:', targetName, newInputMode === 'folder' ? '(目录)' : '(文件)');
      setNewFileName(newInputMode === 'folder' ? '' : 'main.py');
      setNewInputMode(null);
      // 🔥 落点目录未展开时自动展开，让用户立刻看到新建结果（新建=新变更，强刷列表）
      if (dir && !isDirExpanded(dir)) {
        await refresh({ forceChanges: true });
        toggleDir(dir);
      } else {
        await refresh({ forceChanges: true });
      }
    } else {
      console.error('[FileTree] 创建失败:', result.error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
        <span className="text-xs text-gray-400 ml-2">{t('workspace.desktopModule.fileTree.loadingTree')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-2">
        <div className="flex items-center gap-2 text-xs text-red-500 mb-2">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7"
          onClick={() => refresh()}
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          {t('workspace.desktopModule.fileTree.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-3 space-y-3">
      {/* Clone Repository 按钮 */}
      <CloneButton appId={appId} onCloneSuccess={handleCloneSuccess} onCloningChange={setIsCloning} />

      {/* files 目录 */}
      <div>
        <div className="flex items-center justify-between mb-2 pl-1">
          <span className="text-xs font-medium text-gray-600">{t('workspace.desktopModule.fileTree.currentFiles')}</span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={handleImportFolder}
              title={t('workspace.desktopModule.fileTree.importProject')}
            >
              <FolderInput className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={() => setNewInputMode(newInputMode === 'file' ? null : 'file')}
              title={t('workspace.desktopModule.fileTree.newFile')}
            >
              <Plus className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={() => {
                setNewFileName('');
                setNewInputMode(newInputMode === 'folder' ? null : 'folder');
              }}
              title={t('workspace.desktopModule.fileTree.newFolder')}
            >
              <FolderPlus className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* 🔥 导入状态提示 */}
        {importedPath && (
          <div className="flex items-center text-xs text-green-500 mb-1 px-1" title={importedPath}>
            <FolderInput className="w-3 h-3 mr-1 shrink-0" />
            <span className="truncate">{importedPath.length > 30 ? `${importedPath.slice(0, 30)}...` : importedPath}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 px-1 ml-1 shrink-0"
              onClick={handleCancelImport}
              title={t('workspace.desktopModule.fileTree.cancelImport')}
            >
              <X className="w-2 h-2" />
            </Button>
          </div>
        )}

        {/* 新建文件/文件夹输入框 */}
        {newInputMode && (
          <div className="flex items-center gap-1 mb-2 px-1">
            {newInputMode === 'folder'
              ? <FolderPlus className="w-3 h-3 text-gray-400" />
              : <FileText className="w-3 h-3 text-gray-400" />}
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateNew();
                if (e.key === 'Escape') setNewInputMode(null);
              }}
              className="flex-1 text-xs bg-transparent border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 focus:outline-none focus:border-blue-500"
              placeholder={newInputMode === 'folder'
                ? t('workspace.desktopModule.fileTree.folderNamePlaceholder')
                : t('workspace.desktopModule.fileTree.fileNamePlaceholder')}
              autoFocus
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={handleCreateNew}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>
        )}

        {files.length === 0 ? (
          <div className="text-xs text-gray-400 py-2 text-center">
            {t('workspace.desktopModule.fileTree.noFiles')}
            <br />
            <span className="text-gray-300">{t('workspace.desktopModule.fileTree.noFilesHint')}</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {files.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                level={0}
                isExpanded={isDirExpanded(node.path)}
                onToggle={() => toggleDir(node.path)}
                onSelect={handleFileSelect}
                selectedPath={selectedPath}
                appId={appId}
                onRefresh={refresh}
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
                changes={changes}
              />
            ))}
          </div>
        )}
      </div>

      {/* 变更记录 */}
      <ChangeList
        appId={appId}
        changes={changes}
        onRefresh={refresh}
        onViewDiff={onViewDiff}
        selectedFileName={selectedChange}
        onSelectionChange={(fileName) => {
          setSelectedChange(fileName);
          if (fileName) setSelectedPath(''); // 🔥 点击变更记录 → 清空当前文件选中
        }}
        onFileHandled={onFileHandled}
      />
    </div>
  );
}

/**
 * 🔥 兼容旧接口的包装组件
 * 用于 DesktopAppViewer 等使用旧接口的地方
 */
interface LegacyFileTreeProps {
  appId: string;
  onFileSelect: (filePath: string, content: string) => void;
  selectedFile?: string;
  onRefresh?: () => void;
  onViewHistory?: (fileName: string, content: string) => void;
  onViewDiff?: (fileName: string, oldCode: string, newCode: string) => void;
  onFileHandled?: (fileName: string, action: 'accept' | 'revert') => void;
}

export const LegacyFileTree: React.FC<LegacyFileTreeProps> = ({ appId, onFileSelect, selectedFile, onRefresh, onViewHistory, onViewDiff, onFileHandled }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    files,
    changes,
    loading,
    error,
    expandedDirs,
    toggleDir,
    isDirExpanded,
    refresh,
  } = useFileTree(appId);

  const [selectedPath, setSelectedPath] = useState<string>('');
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [newInputMode, setNewInputMode] = useState<'file' | 'folder' | null>(null);
  const [newFileName, setNewFileName] = useState('main.py');
  const [importedPath, setImportedPath] = useState<string | null>(null);
  const hasAutoSelected = React.useRef(false); // 🔥 防止重复自动选择

  // 🔥 克隆期间轮询刷新：慢网络克隆耗时长，静默刷新让用户看到 repo 目录出现、文件落盘
  const [isCloning, setIsCloning] = useState(false);
  React.useEffect(() => {
    if (!isCloning) return;
    const timer = setInterval(() => { refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [isCloning, refresh]);

  // 🔥 初始化时读取 code_path
  React.useEffect(() => {
    const loadImportedPath = async () => {
      const cp = await getCodePath(appId);
      setImportedPath(cp);
    };
    loadImportedPath();
  }, [appId]);

  // 🔥 导入本地项目文件夹（跨平台：Windows/macOS 的 openDirectory 对话框）
  const handleImportFolder = async () => {
    const electron = (window as any).electron;
    if (!electron?.showOpenDialog) return;

    try {
      const result = await electron.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: t('workspace.desktopModule.fileTree.selectProjectFolder'),
        // 🔥 默认打开用户主目录，避开空目录造成的"没有匹配项"困惑
        defaultPath: await getUserDataPath(),
      });

      if (result.canceled || !result.filePaths?.[0]) return;

      const selectedPath = result.filePaths[0];
      // 🔥 写入并回读校验：IPC 链路每层吞错，不校验会出现 UI 显示已导入但 DB 没写入
      const ok = await setCodePathVerified(appId, selectedPath);
      if (!ok) {
        toast({
          title: t('workspace.desktopModule.fileTree.importFailedTitle'),
          description: t('workspace.desktopModule.fileTree.importFailedDesc'),
          variant: 'destructive',
          duration: 4000,
        });
        return;
      }
      setImportedPath(selectedPath);
      toast({
        title: t('workspace.desktopModule.fileTree.importSuccessTitle'),
        description: selectedPath,
        duration: 2500,
      });
      refresh();
    } catch (error) {
      console.error('[LegacyFileTree] 导入文件夹失败:', error);
      toast({
        title: t('workspace.desktopModule.fileTree.importFailedTitle'),
        description: String(error),
        variant: 'destructive',
        duration: 4000,
      });
    }
  };

  // 🔥 取消导入（恢复默认路径）
  const handleCancelImport = async () => {
    try {
      const ok = await setCodePathVerified(appId, null);
      if (!ok) {
        toast({
          title: t('workspace.desktopModule.fileTree.importFailedTitle'),
          description: t('workspace.desktopModule.fileTree.importFailedDesc'),
          variant: 'destructive',
          duration: 4000,
        });
        return;
      }
      setImportedPath(null);
      refresh();
    } catch (error) {
      console.error('[LegacyFileTree] 取消导入失败:', error);
    }
  };

  // 🔥 文件选择处理函数
  const handleFileSelect = async (node: FileNode) => {
    setSelectedPath(node.path);
    setSelectedChange(null); // 🔥 点击当前文件 → 清空变更记录选中
    if (node.type === 'file') {
      const ext = node.path.split('.').pop()?.toLowerCase() || '';
      // 🔥 媒体/PDF 免门禁：查看器走 teegal-file:// 流式协议（磁盘按需读，支持 seek），
      // 文件多大都不占渲染进程内存，直接交给查看器
      const STREAMABLE_EXT = new Set([
        'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v',
        'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac',
        'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico',
        'pdf',
      ]);
      if (STREAMABLE_EXT.has(ext)) {
        onFileSelect(node.path, '');
        return;
      }
      // 🔥 超大文件不读内容（保命层）：读入几十 MB 的二进制/日志会把渲染进程卡死——
      // 选中高亮 + 提示即可，内容置空；不支持的类型（.pt 等）由上层渲染兜底提示页
      const MAX_PREVIEW_SIZE = 2 * 1024 * 1024; // 2MB
      if (node.size && node.size > MAX_PREVIEW_SIZE) {
        onFileSelect(node.path, '');
        toast({
          title: t('workspace.desktopModule.fileTree.fileTooLargeTitle'),
          description: t('workspace.desktopModule.fileTree.fileTooLargeDesc', { size: formatSize(node.size) }),
          variant: 'destructive',
        });
        return;
      }
      // 🔥 读取文件内容
      try {
        const electron = (window as any).electron;
        if (electron?.userpcFile) {
          const result = await electron.userpcFile.read(node.path);
          console.log('[LegacyFileTree] 读取结果:', result?.success, result?.data?.content?.substring(0, 50));
          // 🔥 注意：userpcFile.read 返回 { success, data: { content } }
          // 🔥 空文件也应该能读取成功
          if (result.success) {
            onFileSelect(node.path, result.data?.content || '');
          } else {
            console.error('[LegacyFileTree] 读取失败:', result?.error);
          }
        }
      } catch (error) {
        console.error('[FileTree] 读取文件失败:', error);
      }
    }
  };

  // 🔥 暴露 refresh 方法给父组件
  React.useEffect(() => {
    if (onRefresh) {
      // 通过 window 暴露 refresh 方法
      (window as any).__fileTreeRefresh = refresh;
    }
  }, [refresh, onRefresh]);

  // 🔥 自动选择第一个文件（只在首次加载时）
  React.useEffect(() => {
    if (loading || error || hasAutoSelected.current) return;
    if (selectedFile) return; // 🔥 如果已经有选中的文件，不需要自动选择
    if (files.length === 0) return;

    // 🔥 找到第一个文件（递归查找），跳过大文件（>1MB）
    const MAX_AUTO_SELECT_SIZE = 1024 * 1024; // 1MB
    const findFirstFile = (nodes: FileNode[]): FileNode | null => {
      for (const node of nodes) {
        if (node.type === 'file') {
          // 🔥 跳过大文件，避免读取模型权重、日志等大文件导致内存暴涨
          if (node.size && node.size > MAX_AUTO_SELECT_SIZE) continue;
          return node;
        }
        if (node.children && node.children.length > 0) {
          const found = findFirstFile(node.children);
          if (found) return found;
        }
      }
      return null;
    };

    const firstFile = findFirstFile(files);
    if (firstFile) {
      console.log('[LegacyFileTree] 自动选择第一个文件:', firstFile.path, `(${firstFile.size || 0} bytes)`);
      hasAutoSelected.current = true;
      handleFileSelect(firstFile);
    }
  }, [loading, error, files, selectedFile]);

  const handleOpenFolder = async () => {
    const electron = (window as any).electron;
    if (!electron?.openPath) return;
    try {
      // 🔥 支持导入项目：打开实际的代码目录
      const appCodeDir = await getAppBasePath(appId);
      await electron.openPath(appCodeDir);
    } catch (error) {
      console.error('[FileTree] 打开文件夹失败:', error);
    }
  };

  // 🔥 解析新建目标目录：选中目录 → 该目录；选中文件 → 其父目录；无选中 → 根目录
  const resolveTargetDir = (): string => {
    if (!selectedPath) return '';
    const find = (nodes: FileNode[]): FileNode | null => {
      for (const n of nodes) {
        if (n.path === selectedPath) return n;
        if (n.children) {
          const r = find(n.children);
          if (r) return r;
        }
      }
      return null;
    };
    const found = find(files);
    if (!found) return '';
    if (found.type === 'directory') return found.relativePath || found.name;
    const parts = (found.relativePath || found.name).split('/');
    parts.pop();
    return parts.join('/');
  };

  const handleCreateNew = async () => {
    if (!newFileName.trim()) return;

    const dir = resolveTargetDir();
    const targetName = dir ? `${dir}/${newFileName.trim()}` : newFileName.trim();

    const result = newInputMode === 'folder'
      ? await createFolder(appId, targetName)
      : await createFile(appId, targetName);

    if (result.success) {
      console.log('[FileTree] 创建成功:', targetName, newInputMode === 'folder' ? '(目录)' : '(文件)');
      setNewFileName(newInputMode === 'folder' ? '' : 'main.py');
      setNewInputMode(null);
      // 🔥 落点目录未展开时自动展开，让用户立刻看到新建结果（新建=新变更，强刷列表）
      if (dir && !isDirExpanded(dir)) {
        await refresh({ forceChanges: true });
        toggleDir(dir);
      } else {
        await refresh({ forceChanges: true });
      }
    } else {
      console.error('[FileTree] 创建失败:', result.error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
        <span className="text-xs text-gray-400 ml-2">{t('workspace.desktopModule.fileTree.loadingTree')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-2">
        <div className="flex items-center gap-2 text-xs text-red-500 mb-2">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7"
          onClick={() => refresh()}
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          {t('workspace.desktopModule.fileTree.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-3 space-y-3 pl-2">
      {/* Clone Repository 按钮 */}
      <CloneButton appId={appId} onCloneSuccess={refresh} onCloningChange={setIsCloning} />

      {/* files 目录 */}
      <div>
        <div className="flex items-center justify-between mb-2 pl-1">
          <span className="text-xs font-medium text-gray-600">{t('workspace.desktopModule.fileTree.currentFiles')}</span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={handleImportFolder}
              title={t('workspace.desktopModule.fileTree.importProject')}
            >
              <FolderInput className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={handleOpenFolder}
              title={t('workspace.desktopModule.fileTree.openFileLocation')}
            >
              <FolderOpen className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={() => setNewInputMode(newInputMode === 'file' ? null : 'file')}
              title={t('workspace.desktopModule.fileTree.newFile')}
            >
              <Plus className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={() => {
                setNewFileName('');
                setNewInputMode(newInputMode === 'folder' ? null : 'folder');
              }}
              title={t('workspace.desktopModule.fileTree.newFolder')}
            >
              <FolderPlus className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* 🔥 导入状态提示 */}
        {importedPath && (
          <div className="flex items-center text-xs text-green-500 mb-1 px-1" title={importedPath}>
            <FolderInput className="w-3 h-3 mr-1 shrink-0" />
            <span className="truncate">{importedPath.length > 30 ? `${importedPath.slice(0, 30)}...` : importedPath}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 px-1 ml-1 shrink-0"
              onClick={handleCancelImport}
              title={t('workspace.desktopModule.fileTree.cancelImport')}
            >
              <X className="w-2 h-2" />
            </Button>
          </div>
        )}

        {/* 新建文件/文件夹输入框 */}
        {newInputMode && (
          <div className="flex items-center gap-1 mb-2 px-1">
            {newInputMode === 'folder'
              ? <FolderPlus className="w-3 h-3 text-gray-400" />
              : <FileText className="w-3 h-3 text-gray-400" />}
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateNew();
                if (e.key === 'Escape') setNewInputMode(null);
              }}
              className="flex-1 text-xs bg-transparent border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 focus:outline-none focus:border-blue-500"
              placeholder={newInputMode === 'folder'
                ? t('workspace.desktopModule.fileTree.folderNamePlaceholder')
                : t('workspace.desktopModule.fileTree.fileNamePlaceholder')}
              autoFocus
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1"
              onClick={handleCreateNew}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>
        )}

        {files.length === 0 ? (
          <div className="text-xs text-gray-400 py-2 text-center">
            {t('workspace.desktopModule.fileTree.noFiles')}
            <br />
            <span className="text-gray-300">{t('workspace.desktopModule.fileTree.noFilesHint')}</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {files.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                level={0}
                isExpanded={isDirExpanded(node.path)}
                onToggle={() => toggleDir(node.path)}
                onSelect={handleFileSelect}
                selectedPath={selectedPath}
                appId={appId}
                onRefresh={refresh}
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
                changes={changes}
              />
            ))}
          </div>
        )}
      </div>

      {/* 变更记录 */}
      <ChangeList
        appId={appId}
        changes={changes}
        onRefresh={refresh}
        onViewDiff={onViewDiff}
        selectedFileName={selectedChange}
        onSelectionChange={(fileName) => {
          setSelectedChange(fileName);
          if (fileName) setSelectedPath(''); // 🔥 点击变更记录 → 清空当前文件选中
        }}
        onFileHandled={onFileHandled}
      />
    </div>
  );
};

export default FileTree;
