/**
 * FileTree 模块类型定义
 *
 * 🔥 git 化架构（isomorphic-git 快照）：
 * - 工作目录：当前版本（可直接编辑）
 * - HEAD：最近一次「接受修改」checkpoint
 * - changes：相对 HEAD 的变更文件列表（ChangeList 数据源）
 */

export interface FileNode {
  name: string;
  path: string;
  relativePath: string;  // 相对于 files 目录
  type: 'file' | 'directory';
  ext?: string;
  size?: number;
  children?: FileNode[];
  content?: string;
}

/**
 * 🔥 单个文件的历史版本（只保留一个）
 */
export interface FileHistory {
  fileName: string;        // 文件名，如 main.py
  filePath: string;        // files 目录下的完整路径
  version: FileVersion;    // 上一个 commit 版本
}

/**
 * 🔥 单个版本
 */
export interface FileVersion {
  versionName: string;     // v1, v2, v3...
  path: string;            // history/{filename}/v{n}.{ext} 的完整路径
  createdAt: string;       // 创建时间
}

/**
 * 🔥 文件树状态
 */
export interface FileTreeState {
  files: FileNode[];       // 工作目录文件（当前版本）
  changes: FileHistory[];  // 相对 HEAD 的变更文件列表（fileName=相对路径）
  loading: boolean;
  error: string;
}

export interface CloneOptions {
  repoUrl: string;
  appId: string;
  shallow?: boolean;       // 浅克隆（--depth 1）
  targetPath?: string;     // 克隆到 files 下的子目录名
}

export interface CloneResult {
  success: boolean;
  repoName?: string;
  error?: string;
}

/**
 * 🔥 文件操作结果
 */
export interface FileOperationResult {
  success: boolean;
  error?: string;
}
