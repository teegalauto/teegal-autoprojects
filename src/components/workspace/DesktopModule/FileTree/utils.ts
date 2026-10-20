/**
 * FileTree 工具函数
 * 
 * 🔥 git 化架构（isomorphic-git 快照）：
 * - 工作目录：当前版本（可直接编辑）
 * - HEAD：最近一次「接受修改」checkpoint
 * - 变更列表/旧版本内容/时间线均由 git 承载
 * 
 * 🔥 跨平台：所有文件操作通过 Electron IPC API（主进程 Node.js fs），
 * 不依赖 PowerShell/Bash 命令，Windows/macOS/Linux 通用。
 * 路径使用 / 分隔符，主进程 path.join 自动适配平台。
 */

import { FileNode, FileHistory, FileVersion, FileOperationResult } from './types';
import { getCodePath } from '@/utils/apptool/AppPathHelper';

/**
 * 格式化文件大小
 */
export function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 解析 GitHub URL
 */
export function parseRepoUrl(url: string): { owner: string; name: string } | null {
  try {
    const patterns = [
      /github\.com\/([^\/]+)\/([^\/\.]+)/,
      /github\.com:([^\/]+)\/([^\/\.]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return { owner: match[1], name: match[2] };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 获取文件扩展名对应的图标颜色
 */
export function getFileIconColor(ext: string): string {
  const colors: Record<string, string> = {
    py: '#3572A5',      // Python
    js: '#F7DF1E',      // JavaScript
    ts: '#3178C6',      // TypeScript
    json: '#292929',    // JSON
    md: '#083FA1',      // Markdown
    txt: '#B3B3B3',     // Text
    yaml: '#CB171E',    // YAML
    yml: '#CB171E',     // YAML
    dxf: '#E07020',     // DXF (CAD 2D)
    stl: '#20A0E0',     // STL (CAD 3D mesh)
    step: '#20A0E0',    // STEP (CAD 3D solid)
    stp: '#20A0E0',     // STP
    svg: '#FFB13B',     // SVG
    obj: '#20A0E0',     // OBJ (3D mesh)
  };
  return colors[ext] || '#6B7280';
}

/**
 * 判断是否是代码文件
 */
export function isCodeFile(ext: string): boolean {
  const codeExtensions = ['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'cpp', 'c', 'go', 'rs', 'rb', 'php'];
  return codeExtensions.includes(ext.toLowerCase());
}

/**
 * 排序文件节点（目录优先，然后按名称）
 * 🔥 递归排序：子目录的 children 同样目录优先（展开后不再乱序）
 */
export function sortFileNodes(nodes: FileNode[]): FileNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of sorted) {
    if (node.children && node.children.length > 0) {
      node.children = sortFileNodes(node.children);
    }
  }
  return sorted;
}

/**
 * 🔥 需要过滤的目录名（不区分大小写）
 * 这些目录通常包含大量文件，不应在文件树中显示
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  'release',      // 🔥 electron-builder 打包产物（resources.pak/app.asar.unpacked 等）
  'tmp', 'temp', 'data', 'logs',
  'dist-server', 'dist-electron',
  'history',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'logs',
  'wandb',        // 🔥 W&B 实验跟踪目录，训练时会产生大量文件
  'runs',         // 🔥 TensorBoard 运行目录
  'checkpoints',  // 🔥 模型 checkpoint 目录
  '.ipynb_checkpoints',
]);

/**
 * 过滤不需要显示的文件和目录
 * 🔥 过滤隐藏文件、缓存目录、虚拟环境等
 */
export function filterFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.filter(node => {
    // 过滤隐藏文件（以 . 开头）
    if (node.name.startsWith('.')) return false;
    // 🔥 过滤缓存目录、虚拟环境等（不区分大小写）
    if (IGNORED_DIRS.has(node.name.toLowerCase())) return false;
    return true;
  });
}

/**
 * 🔥 Diff 行切分（git numstat 语义，ChangeList 统计与 DiffViewer 渲染共用同一实现）：
 * - 空内容 = 0 行（''.split('\n') 会产生幻影空行，导致新文件凭空多算一条 deleted）
 * - 末尾换行符不产生额外行（'a\n' = 1 行；'a\n\n' = 2 行，末尾空行是真实行）
 * - 剥 BOM（electron 写文件为 UTF-8 with BOM，两侧 BOM 不一致会导致首行误判为变更）
 * - CRLF→LF、去行尾空白
 */
export function splitDiffLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/^\uFEFF/, '').split('\n').map(l => l.replace(/\r$/, '').trimEnd());
  if (lines.length > 1 && lines[lines.length - 1] === '' && /\n$/.test(content)) {
    lines.pop();
  }
  return lines;
}

/**
 * 🔥 LCS diff 统计（共享实现：ChangeList 的 +N -N 与 DiffViewer 显示的统计同源，保证数字一致）
 */
/** 🔥 LCS 规模护栏：裁剪公共前后缀后剩余行列乘积超过此值放弃逐行 diff。
 *  2500 万格 = 5000×5000，Int32Array 扁平矩阵峰值约 100MB 可承受
 *  （1.3万行×1.3万行=1.7亿格 number[][] 曾直接撑爆渲染进程） */
const DIFF_CELL_LIMIT = 25_000_000;

export interface DiffLine {
  type: 'added' | 'deleted' | 'unchanged';
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

/**
 * 逐行 diff（LCS）：先裁剪公共前缀/后缀再算，规模超限返回 null（调用方降级处理，宁缺毋滥）
 */
export function computeDiffLines(oldCode: string, newCode: string): DiffLine[] | null {
  const oldLines = splitDiffLines(oldCode);
  const newLines = splitDiffLines(newCode);

  // 🔥 裁剪公共前缀/后缀：常见编辑只动中间一小段，大幅缩小 LCS 规模
  let start = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (start < minLen && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }

  const m = endOld - start;
  const n = endNew - start;
  if (m * n > DIFF_CELL_LIMIT) return null;

  // 行内容 → 整数 id：内层循环每格从字符串比较降为数字比较（5000² 规模从秒级降到百毫秒级）
  const ids = new Map<string, number>();
  const toId = (l: string): number => {
    let v = ids.get(l);
    if (v === undefined) { v = ids.size + 1; ids.set(l, v); }
    return v;
  };
  const a = oldLines.slice(start, endOld).map(toId);
  const b = newLines.slice(start, endNew).map(toId);

  // 扁平 Int32Array 矩阵（同规模 number[][] 嵌套数组内存约 3.5 倍）
  const W = n + 1;
  const dp = new Int32Array((m + 1) * W);
  for (let i = 1; i <= m; i++) {
    const row = i * W, prev = row - W;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[row + j] = dp[prev + j - 1] + 1;
      } else {
        const up = dp[prev + j], left = dp[row + j - 1];
        dp[row + j] = up >= left ? up : left;
      }
    }
  }

  // 回溯（倒序收集后 reverse）；行号映射回原文件（offset=start）
  const tail: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      tail.push({ type: 'unchanged', oldLineNumber: start + i, newLineNumber: start + j, content: oldLines[start + i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * W + j - 1] >= dp[(i - 1) * W + j])) {
      tail.push({ type: 'added', oldLineNumber: null, newLineNumber: start + j, content: newLines[start + j - 1] });
      j--;
    } else {
      tail.push({ type: 'deleted', oldLineNumber: start + i, newLineNumber: null, content: oldLines[start + i - 1] });
      i--;
    }
  }
  const head = oldLines.slice(0, start).map((content, idx) => ({
    type: 'unchanged' as const, oldLineNumber: idx + 1, newLineNumber: idx + 1, content,
  }));
  const footOffset = start + m; // 旧文件后缀起点
  const foot = oldLines.slice(endOld).map((content, idx) => ({
    type: 'unchanged' as const, oldLineNumber: footOffset + idx + 1, newLineNumber: endNew + idx + 1, content,
  }));
  return [...head, ...tail.reverse(), ...foot];
}

/** +N -N 统计：永远有值——超 LCS 护栏时降级为行多重集对比（超大文件的徽标也有数，代价是整块移动的行不计入） */
export function computeDiffStats(oldCode: string, newCode: string): { added: number; deleted: number } {
  const diffLines = computeDiffLines(oldCode, newCode);
  if (diffLines) {
    let added = 0, deleted = 0;
    for (const l of diffLines) {
      if (l.type === 'added') added++;
      else if (l.type === 'deleted') deleted++;
    }
    return { added, deleted };
  }
  // 降级：按行内容多重集匹配（O(n) 无矩阵），与 LCS 口径的差异只在"整块移动的行"上
  const oldCount = new Map<string, number>();
  for (const l of splitDiffLines(oldCode)) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let added = 0, deleted = 0;
  for (const l of splitDiffLines(newCode)) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else added++;
  }
  for (const c of oldCount.values()) deleted += c;
  return { added, deleted };
}

/**
 * 🔥 新建文件
 * 跨平台：通过 Electron IPC API（app-code:save）
 */
export async function createFile(
  appId: string,
  fileName: string,
  content: string = '',
  codePath?: string
): Promise<FileOperationResult> {
  try {
    const electron = (window as any).electron;

    if (!electron?.saveAppCodeFile) {
      return { success: false, error: '非 Electron 环境' };
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);

    // 🔥 检查文件是否已存在
    const existsResult = await electron.checkAppCodeFileExists({ appId, fileName, codePath: cp });
    if (existsResult?.exists) {
      return { success: false, error: '文件已存在' };
    }

    // 🔥 创建文件
    const result = await electron.saveAppCodeFile({ appId, fileName, content, codePath: cp });
    if (!result?.success) {
      return { success: false, error: result?.error || '创建失败' };
    }

    console.log(`[createFile] 已创建文件: ${fileName}`);
    return { success: true };

  } catch (error: any) {
    console.error('[createFile] 创建失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔥 新建文件夹
 * 跨平台：通过 Electron IPC API（app-code:ensure-dir），支持嵌套路径（recursive mkdir）
 */
export async function createFolder(
  appId: string,
  dirPath: string,
  codePath?: string
): Promise<FileOperationResult> {
  try {
    const electron = (window as any).electron;

    if (!electron?.ensureAppCodeDir) {
      return { success: false, error: '非 Electron 环境' };
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);
    const result = await electron.ensureAppCodeDir({ appId, dirPath, codePath: cp });
    if (!result?.success) {
      return { success: false, error: result?.error || '创建文件夹失败' };
    }

    console.log(`[createFolder] 已创建文件夹: ${dirPath}`);
    return { success: true };

  } catch (error: any) {
    console.error('[createFolder] 创建文件夹失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔥 删除文件或文件夹
 * 跨平台：通过 Electron IPC API（app-code:delete），主进程用 Node.js fs
 */
export async function deleteFile(
  appId: string,
  fileName: string,
  isDirectory: boolean = false,
  codePath?: string
): Promise<FileOperationResult> {
  try {
    const electron = (window as any).electron;

    if (!electron?.deleteAppCodeFile) {
      return { success: false, error: '非 Electron 环境' };
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);

    // 🔥 使用跨平台 IPC API 删除（同时删除 history 中的版本）
    const result = await electron.deleteAppCodeFile({ appId, fileName, isDirectory, codePath: cp });

    if (!result?.success) {
      return { success: false, error: result?.error || '删除失败' };
    }

    console.log(`[deleteFile] 已删除: ${fileName}`);
    return { success: true };

  } catch (error: any) {
    console.error('[deleteFile] 删除失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔥 重命名文件
 * 跨平台：通过 Electron IPC API（app-code:rename），主进程用 Node.js fs
 */
export async function renameFile(
  appId: string,
  oldFileName: string,
  newFileName: string,
  codePath?: string
): Promise<FileOperationResult> {
  try {
    const electron = (window as any).electron;

    if (!electron?.renameAppCodeFile) {
      return { success: false, error: '非 Electron 环境' };
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);

    // 🔥 使用跨平台 IPC API 重命名（同时重命名 history 中的版本）
    const result = await electron.renameAppCodeFile({ appId, oldFileName, newFileName, codePath: cp });

    if (!result?.success) {
      return { success: false, error: result?.error || '重命名失败' };
    }

    console.log(`[renameFile] 已重命名: ${oldFileName} -> ${newFileName}`);
    return { success: true };

  } catch (error: any) {
    console.error('[renameFile] 重命名失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 保存文件（git 化：仅写工作区；「接受修改」的 checkpoint 由 commitFiles 落 git）
 */
export async function saveFile(
  appId: string,
  fileName: string,
  content: string,
  codePath?: string
): Promise<FileOperationResult> {
  try {
    const electron = (window as any).electron;

    if (!electron?.saveAppCodeFile) {
      return { success: false, error: '非 Electron 环境' };
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);

    // 🔥 如果 fileName 是完整路径（包含 userDataPath），提取相对路径
    let relativeFileName = fileName;
    // 🔥 统一用 / 作为分隔符比较
    const normalizedFileName = fileName.replace(/\\/g, '/');
    if (normalizedFileName.includes('/apps/')) {
      // 从路径中提取 appId 之后的部分
      const match = normalizedFileName.match(/\/apps\/[^/]+\/(.+)/);
      if (match) {
        relativeFileName = match[1];
      }
    }

    // 🔥 写入新内容（使用相对路径）
    const result = await electron.saveAppCodeFile({ appId, fileName: relativeFileName, content, codePath: cp });
    if (!result?.success) {
      return { success: false, error: result?.error || '保存失败' };
    }

    console.log(`[saveFile] 已保存文件: ${relativeFileName}`);
    return { success: true };

  } catch (error: any) {
    console.error('[saveFile] 保存失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔥 Commit - git checkpoint（接受修改 = 快照当前工作区全量变更）
 * 跨平台：通过 Electron IPC API（app-code:commit）
 */
export async function commitFiles(appId: string, fileName?: string, codePath?: string): Promise<FileOperationResult> {
  try {
    const electron = (window as any).electron;

    if (!electron?.commitAppCodeHistory) {
      return { success: false, error: '非 Electron 环境' };
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);

    // 🔥 如果 fileName 是完整路径（包含 /apps/），提取相对路径（与 saveFile 逻辑一致）
    let relativeFileName = fileName;
    if (fileName) {
      const normalizedFileName = fileName.replace(/\\/g, '/');
      if (normalizedFileName.includes('/apps/')) {
        const match = normalizedFileName.match(/\/apps\/[^/]+\/(.+)/);
        if (match) {
          relativeFileName = match[1];
        }
      }
    }

    // 🔥 使用跨平台 IPC API 清空 history
    const result = await electron.commitAppCodeHistory({ appId, fileName: relativeFileName, codePath: cp });

    if (!result?.success) {
      return { success: false, error: result?.error || '清空失败' };
    }

    // 🔥 触发事件通知文件树刷新
    window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
      detail: { appId }
    }));

    return { success: true };

  } catch (error: any) {
    console.error('[commitFiles] 清空失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔥 获取文件的历史版本内容
 * 跨平台：通过 Electron IPC API（app-code:read-history）
 */
export async function getHistoryContent(
  appId: string,
  fileName: string,
  codePath?: string
): Promise<string | null> {
  try {
    const electron = (window as any).electron;

    if (!electron?.readAppCodeHistory) {
      return null;
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);

    // 🔥 如果 fileName 是完整路径，提取相对路径
    let relativeFileName = fileName;
    const normalizedFileName = fileName.replace(/\\/g, '/');
    if (normalizedFileName.includes('/apps/')) {
      const match = normalizedFileName.match(/\/apps\/[^/]+\/(.+)/);
      if (match) {
        relativeFileName = match[1];
      }
    }

    // 🔥 使用跨平台 IPC API 读取历史版本
    const result = await electron.readAppCodeHistory({ appId, fileName: relativeFileName, codePath: cp });

    if (result?.success) {
      const content = result.content ?? '';
      console.log('[getHistoryContent] 读取成功，内容长度:', content.length);
      return content;
    }

    console.log('[getHistoryContent] 历史版本不存在:', relativeFileName);
    return null;

  } catch (error) {
    console.error('[getHistoryContent] 获取失败:', error);
    return null;
  }
}

/**
 * 🔥 checkpoint 时间线（git log，新→旧）
 * 跨平台：通过 Electron IPC API（app-code:git-log）
 */
export async function listCheckpointTimeline(
  appId: string,
  limit: number = 50,
  codePath?: string
): Promise<{ oid: string; message: string; timestamp: number }[]> {
  try {
    const electron = (window as any).electron;
    if (!electron?.listAppCodeCheckpoints) return [];

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);
    const result = await electron.listAppCodeCheckpoints({ appId, limit, codePath: cp });
    return result?.success ? (result.checkpoints || []) : [];
  } catch (error) {
    console.error('[listCheckpointTimeline] 获取失败:', error);
    return [];
  }
}

/**
 * 🔥 回滚整个项目到指定 checkpoint（未接受的修改将丢失）
 * 跨平台：通过 Electron IPC API（app-code:git-restore）
 */
export async function restoreToCheckpoint(
  appId: string,
  oid: string,
  codePath?: string
): Promise<FileOperationResult> {
  try {
    const electron = (window as any).electron;
    if (!electron?.restoreAppCodeTo) {
      return { success: false, error: '非 Electron 环境' };
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);
    const result = await electron.restoreAppCodeTo({ appId, oid, codePath: cp });

    if (!result?.success) {
      return { success: false, error: result?.error || '回滚失败' };
    }

    // 🔥 通知文件树刷新
    window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
      detail: { appId }
    }));

    return { success: true };
  } catch (error: any) {
    console.error('[restoreToCheckpoint] 回滚失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔥 获取当前文件内容
 * 跨平台：通过 Electron IPC API（app-code:read）
 */
export async function getCurrentFileContent(
  appId: string,
  fileName: string,
  codePath?: string
): Promise<string | null> {
  try {
    const electron = (window as any).electron;

    if (!electron?.readAppCodeFile || !electron?.checkAppCodeFileExists) {
      return null;
    }

    const cp = codePath ?? ((await getCodePath(appId)) || undefined);

    // 🔥 如果 fileName 是完整路径，提取相对路径
    let relativeFileName = fileName;
    const normalizedFileName = fileName.replace(/\\/g, '/');
    if (normalizedFileName.includes('/apps/')) {
      const match = normalizedFileName.match(/\/apps\/[^/]+\/(.+)/);
      if (match) {
        relativeFileName = match[1];
      }
    }

    // 🔥 检查文件是否存在
    const existsResult = await electron.checkAppCodeFileExists({ appId, fileName: relativeFileName, codePath: cp });
    if (!existsResult?.exists) {
      console.log('[getCurrentFileContent] 文件不存在:', relativeFileName);
      return null;
    }

    // 🔥 使用跨平台 IPC API 读取
    const result = await electron.readAppCodeFile({ appId, fileName: relativeFileName, codePath: cp });

    if (result?.success) {
      const content = result.content ?? '';
      console.log('[getCurrentFileContent] 读取成功:', relativeFileName, '内容长度:', content.length);
      return content;
    }

    console.log('[getCurrentFileContent] 读取失败:', relativeFileName, result);
    return null;
  } catch (error) {
    console.error('[getCurrentFileContent] 获取失败:', error);
    return null;
  }
}
