/**
 * 文件树节点组件
 * 
 * 🔥 支持右键菜单：复制路径、复制完整信息、删除、重命名
 * 🔥 有历史版本的文件显示特殊颜色
 */

import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, FileCode, FileText, Trash2, Edit2, Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FileNode, FileHistory } from '../types';
import { getFileIconColor, isCodeFile, deleteFile, renameFile } from '../utils';
import { useToast } from '@/hooks/use-toast';

interface FileTreeNodeProps {
  node: FileNode;
  level: number;
  isExpanded: boolean;
  onToggle: () => void;
  onSelect: (node: FileNode) => void;
  selectedPath?: string;
  appId: string;
  onRefresh: () => void;
  // 🔥 子节点展开状态管理
  expandedDirs?: Set<string>;
  toggleDir?: (path: string) => void;
  // 🔥 相对 HEAD 的变更文件列表（用于标记有未接受修改的文件）
  changes?: FileHistory[];
}

export const FileTreeNode = React.memo(function FileTreeNode({
  node,
  level,
  isExpanded,
  onToggle,
  onSelect,
  selectedPath,
  appId,
  onRefresh,
  expandedDirs,
  toggleDir,
  changes = [],
}: FileTreeNodeProps) {
  const { toast } = useToast();
  const { t } = useTranslation();
  const isSelected = selectedPath === node.path;
  const isDir = node.type === 'directory';
  const ext = node.ext || '';

  // 🔥 从完整路径中提取相对路径
  // node.path 格式: C:\Users\...\apps\{appId}\autogo\README.md
  // 需要提取: autogo/README.md
  const getRelativePath = (fullPath: string): string => {
    // 🔥 找到 apps\{appId}\ 后面的部分
    const match = fullPath.match(/apps\\[^\\]+\\(.+)$/);
    if (match) {
      // 🔥 将 \ 替换为 /
      return match[1].replace(/\\/g, '/');
    }
    // 🔥 如果匹配失败，返回文件名
    return fullPath.split(/[\\/]/).pop() || '';
  };

  // 🔥 完整路径 = node.path（电脑上的实际路径）
  const fullPath = node.path;
  
  // 🔥 相对路径（给 LLM 用）
  const relativePath = getRelativePath(node.path);
  
  // 🔥 检查当前文件是否有未接受的修改（相对 HEAD 有变更）
  const hasChanges = !isDir && changes.some(h => {
    // 🔥 使用相对路径匹配
    return h.fileName === relativePath;
  });

  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(node.name);

  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 🔥 点击外部关闭菜单
  useEffect(() => {
    if (!showContextMenu) return;
    
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const isInside = target.closest('[data-context-menu="true"]');
      if (!isInside) {
        setShowContextMenu(false);
      }
    };
    
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleMouseDown);
    }, 10);
    
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [showContextMenu]);

  // 🔥 重命名时自动聚焦
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const handleClick = () => {
    if (isRenaming) return;
    
    if (isDir) {
      onToggle();
    } else {
      onSelect(node);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 🔥 只记录原始光标位置，实际尺寸的边界修正见下方 useLayoutEffect
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  // 🔥 菜单挂载后按实测尺寸修正位置：
  // 旧逻辑硬编码 menuHeight=60，但真实菜单约 170px，文件在底部时菜单必然溢出屏幕
  // useLayoutEffect 在绘制前执行，不会产生可见跳动
  useLayoutEffect(() => {
    if (!showContextMenu || !contextMenuRef.current) return;
    const menu = contextMenuRef.current;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let x = contextMenuPosition.x;
    let y = contextMenuPosition.y;
    if (x + mw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - mw - 8);
    if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8);
    if (x !== contextMenuPosition.x || y !== contextMenuPosition.y) {
      setContextMenuPosition({ x, y });
    }
  }, [showContextMenu, contextMenuPosition]);

  const handleDelete = async () => {
    setShowContextMenu(false);

    // 🔥 使用 relativePath 而不是 name，确保嵌套目录中的文件也能正确删除 history
    const result = await deleteFile(appId, node.relativePath || node.name, isDir);
    if (result.success) {
      onRefresh();
    }
  };

  const handleRename = async () => {
    setShowContextMenu(false);
    setIsRenaming(true);
  };

  // 🔥 复制完整路径（电脑上的实际路径）
  const handleCopyFullPath = async () => {
    setShowContextMenu(false);

    try {
      await navigator.clipboard.writeText(fullPath);
      toast({
        title: t('workspace.desktopModule.fileTree.copiedFullPath'),
        description: fullPath,
        duration: 2000,
      });
    } catch (error) {
      // 降级方案
      const textArea = document.createElement('textarea');
      textArea.value = fullPath;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);

      toast({
        title: t('workspace.desktopModule.fileTree.copiedFullPath'),
        description: fullPath,
        duration: 2000,
      });
    }
  };

  // 🔥 复制相对路径（给 LLM 用）
  const handleCopyRelativePath = async () => {
    setShowContextMenu(false);

    try {
      await navigator.clipboard.writeText(relativePath);
      toast({
        title: t('workspace.desktopModule.fileTree.copiedRelativePath'),
        description: relativePath,
        duration: 2000,
      });
    } catch (error) {
      const textArea = document.createElement('textarea');
      textArea.value = relativePath;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);

      toast({
        title: t('workspace.desktopModule.fileTree.copiedRelativePath'),
        description: relativePath,
        duration: 2000,
      });
    }
  };

  // 🔥 复制完整信息（包含 appId 和相对路径，给 LLM 用）
  const handleCopyFullInfo = async () => {
    setShowContextMenu(false);

    const fullInfo = `projectId: ${appId.substring(0, 8)}\nfilePath: ${relativePath}`;

    try {
      await navigator.clipboard.writeText(fullInfo);
      toast({
        title: t('workspace.desktopModule.fileTree.copiedFullInfo'),
        description: t('workspace.desktopModule.fileTree.copiedProjectFile'),
        duration: 2000,
      });
    } catch (error) {
      const textArea = document.createElement('textarea');
      textArea.value = fullInfo;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);

      toast({
        title: t('workspace.desktopModule.fileTree.copiedFullInfo'),
        description: t('workspace.desktopModule.fileTree.copiedProjectFile'),
        duration: 2000,
      });
    }
  };

  const handleRenameSubmit = async () => {
    if (!newName.trim() || newName === node.name) {
      setIsRenaming(false);
      setNewName(node.name);
      return;
    }

    const result = await renameFile(appId, node.name, newName.trim());
    if (result.success) {
      onRefresh();
    } else {
      setNewName(node.name);
    }
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
      setNewName(node.name);
    }
  };

  const getIcon = () => {
    if (isDir) {
      return isExpanded ? (
        <FolderOpen className="w-3.5 h-3.5 text-blue-500" />
      ) : (
        <Folder className="w-3.5 h-3.5 text-blue-500" />
      );
    }

    if (isCodeFile(ext)) {
      return (
        <FileCode
          className="w-3.5 h-3.5"
          style={{ color: getFileIconColor(ext) }}
        />
      );
    }

    if (ext === 'md' || ext === 'txt') {
      return (
        <FileText
          className="w-3.5 h-3.5"
          style={{ color: getFileIconColor(ext) }}
        />
      );
    }

    return <File className="w-3.5 h-3.5 text-gray-400" />;
  };

  return (
    <div>
      {/* 节点行 */}
      <div
        className={`relative flex items-center gap-1 py-1 px-1 rounded cursor-pointer hover:bg-gray-100 ${
          isSelected ? 'bg-blue-50 text-blue-600' : ''
        }`}
        style={{ paddingLeft: `${level * 12 + 4}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* 🔥 层级参考线：每层一条轻微竖线（与缩进对齐，相邻行同 x 连成引导线） */}
        {Array.from({ length: level }).map((_, i) => (
          <span
            key={i}
            className="absolute top-0 bottom-0 w-px bg-gray-200"
            style={{ left: `${i * 12 + 7}px` }}
          />
        ))}
        {/* 展开/折叠图标 */}
        {isDir && (
          <span className="w-3.5 h-3.5 flex items-center justify-center">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-gray-400" />
            ) : (
              <ChevronRight className="w-3 h-3 text-gray-400" />
            )}
          </span>
        )}
        {!isDir && <span className="w-3.5" />}

        {/* 文件/目录图标 */}
        {getIcon()}

        {/* 名称 */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            className="flex-1 text-xs bg-transparent border border-blue-500 rounded px-1 focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span 
            className={`text-xs truncate flex-1 ${hasChanges && !isDir ? 'text-green-600 font-medium' : ''}`}
            title={hasChanges && !isDir ? t('workspace.desktopModule.fileTree.hasHistoryVersion') : undefined}
          >
            {node.name}
          </span>
        )}
      </div>

      {/* 右键菜单 - 🔥 通过 Portal 挂到 document.body：
          本组件渲染在 Dialog 内，DialogContent 的 translate-x/y-[-50%] 居中 transform
          会让 position:fixed 退化为相对弹窗定位（菜单恒定下移、滚到底部时跑出视野）。
          Portal 挂到 body 后 fixed 恢复相对屏幕定位 */}
      {showContextMenu && createPortal(
        <div
          ref={contextMenuRef}
          data-context-menu="true"
          className="fixed bg-white border border-gray-200 rounded shadow-lg py-1 z-[9999]"
          style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {/* 🔥 复制路径选项 - 仅文件显示 */}
          {!isDir && (
            <>
              <button
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 w-full"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleCopyFullPath();
                }}
              >
                <Copy className="w-3 h-3" />
                {t('workspace.desktopModule.fileTree.copyFullPath')}
              </button>
              <button
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 w-full"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleCopyRelativePath();
                }}
              >
                <Copy className="w-3 h-3" />
                {t('workspace.desktopModule.fileTree.copyRelativePath')}
              </button>
              <button
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 w-full"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleCopyFullInfo();
                }}
              >
                <Check className="w-3 h-3" />
                {t('workspace.desktopModule.fileTree.copyFullInfo')}
              </button>
              <div className="border-t border-gray-100 my-1" />
            </>
          )}
          <button
            className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 w-full"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleDelete();
            }}
          >
            <Trash2 className="w-3 h-3" />
            {t('workspace.desktopModule.fileTree.delete')}
          </button>
          <button
            className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 w-full"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleRename();
            }}
          >
            <Edit2 className="w-3 h-3" />
            {t('workspace.desktopModule.fileTree.rename')}
          </button>
        </div>,
        document.body
      )}

      {/* 子节点 */}
      {isDir && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              isExpanded={expandedDirs?.has(child.path) ?? false}
              onToggle={() => toggleDir?.(child.path)}
              onSelect={onSelect}
              selectedPath={selectedPath}
              appId={appId}
              onRefresh={onRefresh}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
              changes={changes}
            />
          ))}
        </div>
      )}
    </div>
  );
});
