/**
 * Train Project File Tools
 * 项目文件操作工具集 + 训练任务工具
 *
 * 🔥 项目文件操作：
 * - list_project_files: 列出文件树
 * - read_project_file: 读取单个文件
 * - save_project_file: 保存/创建文件
 * - edit_project_file: 局部编辑文件（search/replace，节省 token）
 * - delete_project_file: 删除文件
 *
 * 🔥 训练任务工具：
 * - list_train_tasks / get_train_task_detail: 已合并入 TaskHistoryTools（list_tasks / get_task_detail，本文件执行器仍保留供分发）
 * - stop_gpu_train: 停止 GPU 训练
 * - upsert_project: 创建/更新项目（不带 projectId=创建；带 projectId=更新 name/description）
 */

import { AutoStep, AutoToolResult } from "../auto/types";
import { BASE_PROJECT_ID } from '../auto/BaseProjectToolLoader';
import { desktopAppStorage } from '@/services/storage';
import { desktopAppEventService } from '@/services/events/DesktopAppEventService';
import { v4 as uuidv4 } from 'uuid';
import { getUserDataPath, getAppBasePath, getAppHistoryPath, getCodePath } from './AppPathHelper';
import { resolveProjectId } from './ProjectIdResolver';
import { DOC_PARSE_EXTS, BINARY_TRAP_EXTS, parseDocFile, docReadError } from './docParser';

// ============================================================================
// 🔥 更新 app 的 updatedAt（touch 活跃度），使经常使用的项目排在列表前面
async function touchAppUpdatedAt(appId: string): Promise<void> {
  try { await desktopAppStorage.update(appId, {}); } catch (e) {}
}

/**
 * 🔥 .json 文件自动 pretty-print（save/edit_project_file 共用）
 * LLM 常写紧凑单行 JSON（省 token 但打开没法看），保存前格式化为 2 空格缩进；
 * 解析失败（JSON 不合法）或已是多行格式则原样返回，不拦截保存。
 */
function prettyPrintJsonIfNeeded(filePath: string, content: string): string {
  if (!filePath.toLowerCase().endsWith('.json') || !content) return content;
  try {
    const parsed = JSON.parse(content);
    const pretty = JSON.stringify(parsed, null, 2);
    // 只有原本是紧凑/无缩进格式时才重排，避免反复保存产生无意义 diff
    return pretty !== content ? pretty : content;
  } catch {
    return content;
  }
}

/**
 * 🔥 基础项目 tools/ 文件变更后触发热重载（await 确保下一轮 prompt 必然包含新工具）
 * save/edit/delete_project_file 三条写路径统一调用。
 * 之前只挂在 save 上：registry.json 已存在时 LLM 走 edit 更新 → 不重载 → 工具不进 prompt。
 */
async function triggerBaseToolReload(fullAppId: string, filePath: string, userId?: string): Promise<void> {
  if (fullAppId !== BASE_PROJECT_ID || !filePath.replace(/\\/g, '/').startsWith('tools/') || !userId) {
    return;
  }
  try {
    const { loadBaseProjectTools } = await import('@/utils/auto/BaseProjectToolLoader');
    const count = await loadBaseProjectTools(String(userId), true);
    console.log(`[BASE-TOOLS] 基础项目工具已热重载: ${count} 个工具生效`);
  } catch (e) {
    console.warn('[BASE-TOOLS] 基础项目工具热重载失败:', e);
  }
}

// 类型定义
// ============================================================================

export interface FileNode {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  ext?: string;
  size?: number;
  children?: FileNode[];
}

export interface FileHistory {
  fileName: string;
  version: {
    versionName: string;
    path: string;
    createdAt: string;
  };
}

export interface ListFilesResult {
  files: FileNode[];
  history: FileHistory[];
}

export interface ReadFileResult {
  content: string;
  language: string;
  size: number;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 扫描目录获取文件树（递归扫描所有层级）
 */
async function scanDirectory(dir: string): Promise<FileNode[]> {
  try {
    const electron = (window as any).electron;

    // 🔥 使用递归扫描 API，获取完整的嵌套文件树
    if (electron?.readDirectoryRecursive) {
      const result = await electron.readDirectoryRecursive(dir, { maxDepth: 10 });
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
    console.error('[scanDirectory] 扫描失败:', dir, error);
    return [];
  }
}

/**
 * 扫描 history 目录
 */
async function scanHistoryDirectory(dir: string): Promise<FileHistory[]> {
  try {
    const electron = (window as any).electron;

    if (!electron?.readDirectory) return [];

    const result = await electron.readDirectory(dir);
    if (!result.success) return [];

    const histories: FileHistory[] = [];
    await scanHistoryRecursive(dir, '', histories);
    return histories;
  } catch (error) {
    console.error('[scanHistoryDirectory] 扫描失败:', dir, error);
    return [];
  }
}

/**
 * 递归扫描 history 目录
 */
async function scanHistoryRecursive(
  currentDir: string,
  relativePath: string,
  histories: FileHistory[]
): Promise<void> {
  try {
    const electron = (window as any).electron;
    if (!electron?.readDirectory) return;

    const result = await electron.readDirectory(currentDir);
    if (!result.success || !result.files) return;

    for (const item of result.files) {
      if (item.type === 'directory') {
        const newRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
        await scanHistoryRecursive(item.path, newRelativePath, histories);
      } else if (item.type === 'file' && item.name.match(/^v\d+\./)) {
        const fileName = relativePath || item.name.replace(/^v\d+\./, '');
        histories.push({
          fileName,
          version: {
            versionName: item.name,
            path: item.path,
            createdAt: item.modifiedTime || new Date().toISOString(),
          },
        });
      }
    }
  } catch (error) {
    console.error('[scanHistoryRecursive] 扫描失败:', currentDir, error);
  }
}

/**
 * 🔥 需要过滤的目录名（不区分大小写）
 * 与 main.ts read-directory-recursive 保持一致
 */
const IGNORED_DIRS = new Set([
  'node_modules', '__pycache__', '.venv', 'venv', 'env',
  '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt',
  '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'logs', 'wandb', 'runs', 'checkpoints', '.ipynb_checkpoints',
  'history',
]);

/**
 * 🔥 递归过滤隐藏文件和特殊目录
 * 过滤自身及所有子节点中的无用条目
 */
function filterFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter(node => {
      // 过滤隐藏文件（以 . 开头）
      if (node.name.startsWith('.')) return false;
      // 过滤缓存/依赖目录
      if (node.type === 'directory' && IGNORED_DIRS.has(node.name.toLowerCase())) return false;
      return true;
    })
    .map(node => {
      // 🔥 递归过滤子节点
      if (node.children && node.children.length > 0) {
        return { ...node, children: filterFileNodes(node.children) };
      }
      return node;
    });
}

/**
 * 排序文件节点（目录优先）
 */
function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 🔥 read_project_file 路径定位兜底
 * LLM 传的 filePath 可能是裸文件名（server.ts）或层级猜错的相对路径——
 * 典型如 base-bootcode：仓库 clone 在项目子目录 teegal-autoprojects/ 下，
 * 从项目根拼路径必然差层。按请求在项目文件树中定位真实文件：
 * 唯一命中 → 返回真实相对路径；多个命中 → 返回候选列表；没有 → none
 * （扫描根与 read 的 baseDir 同为 getAppBasePath，relativePath 与拼接路径一致）
 */
async function relocateProjectFile(
  fullAppId: string,
  filePath: string
): Promise<{ status: 'unique'; relativePath: string } | { status: 'multiple'; candidates: string[] } | { status: 'none' }> {
  try {
    const filesDir = await getAppBasePath(fullAppId);
    const rootNodes = filterFileNodes(await scanDirectory(filesDir));
    const files: FileNode[] = [];
    const collect = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') files.push(n);
        if (n.children) collect(n.children);
      }
    };
    collect(rootNodes);
    if (files.length === 0) return { status: 'none' };

    const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const wanted = norm(filePath);
    const baseName = wanted.split('/').pop() || wanted;

    const matched = files.filter((n) => {
      const rel = norm(n.relativePath || n.name);
      return rel === wanted || rel.endsWith(`/${wanted}`) || n.name.toLowerCase() === baseName;
    });

    if (matched.length === 1) {
      return { status: 'unique', relativePath: (matched[0].relativePath || matched[0].name).replace(/\\/g, '/') };
    }
    if (matched.length > 1) {
      return { status: 'multiple', candidates: matched.map((n) => (n.relativePath || n.name).replace(/\\/g, '/')) };
    }
    return { status: 'none' };
  } catch {
    return { status: 'none' };
  }
}

/**
 * 获取语言类型
 */
function getLanguage(ext: string): string {
  const languages: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    txt: 'text',
    html: 'html',
    css: 'css',
    sql: 'sql',
    sh: 'bash',
  };
  return languages[ext.toLowerCase()] || 'text';
}

// ============================================================================
// 🔥 文件骨架（活地图）
// ============================================================================

const OUTLINE_MAX_DEFS = 60;      // 最多列出的顶层定义数（超出省略，防大文件骨架膨胀）
const OUTLINE_LINE_MAX_CHARS = 80; // 单条签名截断长度

// 🔥 顶层定义识别正则（单文件骨架 与 项目符号索引 skeleton 共用）
const OUTLINE_DEF_PATTERNS: Record<string, RegExp[]> = {
  py: [
    /^(async\s+def|def|class)\s+\w/,   // 顶层定义（无缩进，类方法不进骨架保持小）
    /^if\s+__name__/,
  ],
  ts: [
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*\w/,
    /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w/,
    /^(?:export\s+)?(?:interface|enum)\s+\w/,
    /^(?:export\s+)?type\s+\w+\s*=/,
    /^(?:export\s+)?const\s+\w+[^=\n]*=\s*(?:async\s+)?(?:function\b|\()/, // 箭头函数/组件形态
  ],
  go: [
    /^func\s+(?:\([^)]*\)\s*)?\w/,
    /^type\s+\w+\s+(?:struct|interface)\b/,
  ],
};
OUTLINE_DEF_PATTERNS.tsx = OUTLINE_DEF_PATTERNS.ts;
OUTLINE_DEF_PATTERNS.jsx = OUTLINE_DEF_PATTERNS.js;
const OUTLINE_CODE_EXTS = Object.keys(OUTLINE_DEF_PATTERNS);

/**
 * 抓顶层定义行（行号+签名原文）。扩展名不认识返回 null（调用方不附骨架）；
 * 认识但抓不到定义返回空 defs（totalLines 仍有效，项目索引场景只列文件名）。
 */
function extractDefs(
  content: string,
  ext: string,
  maxChars = OUTLINE_LINE_MAX_CHARS
): { defs: string[]; totalLines: number } | null {
  const patterns = OUTLINE_DEF_PATTERNS[ext.toLowerCase()];
  if (!patterns) return null;

  const lines = content.split('\n');
  const defs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (patterns.some((re) => re.test(line))) {
      const text = line.length > maxChars ? line.slice(0, maxChars) + '…' : line;
      defs.push(`${i + 1} ${text.trim()}`);
    }
  }
  return { defs, totalLines: lines.length };
}

/**
 * 抓顶层定义行（行号+签名原文），LLM 一次掌握文件全局，省"读完→觉得不够→再读"的往返轮次。
 * 保守策略：按扩展名选正则，语言不认识或抓不到 → 返回空串（不附），宁可缺失不可错误。
 * 附挂时机：pattern 命中 / pattern 未命中报错 / 整读截断（整读到位时内容全有，不附）。
 */
function buildFileOutline(content: string, ext: string): string {
  const extracted = extractDefs(content, ext);
  if (!extracted || extracted.defs.length === 0) return ''; // 语言不认识或抓不到 → 不附

  const lines = content.split('\n');

  // imports 区间：头部最后一行 import 的行号（集中头部，只扫前 200 行）
  const importRe = /^(?:import\b|from\s+\S+\s+import\b|const\s+\w+\s*=\s*require\(|using\s+\w+)/;
  let lastImport = 0;
  for (let i = 0; i < lines.length && i < 200; i++) {
    if (importRe.test(lines[i])) lastImport = i + 1;
  }

  const parts: string[] = [`🗺 文件结构（共 ${lines.length} 行）:`];
  if (lastImport > 0) parts.push(`  1-${lastImport} imports`);
  parts.push(...extracted.defs.slice(0, OUTLINE_MAX_DEFS).map((d) => `  ${d}`));
  if (extracted.defs.length > OUTLINE_MAX_DEFS) {
    parts.push(`  …（其余 ${extracted.defs.length - OUTLINE_MAX_DEFS} 个定义省略，可按行号 offset 读取）`);
  }
  return parts.join('\n');
}

// ============================================================================
// 🔥 项目符号索引（skeleton 模式）：整项目骨架，每代码文件一行
// ============================================================================

const SKELETON_MAX_FILES = 300;             // 最多索引的代码文件数（超出提示缩小范围）
const SKELETON_MAX_FILE_CHARS = 200 * 1024; // 单文件超此大小跳过（数据/生成文件）
const SKELETON_DEF_MAX_CHARS = 40;          // 项目级签名截短（比单文件骨架 80 更紧）
const SKELETON_MAX_MESSAGE = 12000;         // 输出预算：与 read_project_file 整读上限对齐（单回执过大会叠加并行调用撑爆 prompt，60KB+ 会触发网关 502）

/**
 * 遍历文件树收集代码文件，分批并发读取后抓顶层定义，每文件压成一行：
 *   supervised.py (412行): 18 class TrainConfig | 48 def load_data
 * 行号可直接用于 read_project_file 的 offset/pattern 精读。
 * 实时现算（本地文件+正则，毫秒~百毫秒级），不做缓存——文件一改缓存即脏，失效逻辑不划算。
 */
async function buildProjectSkeleton(files: FileNode[], filesDir: string): Promise<string> {
  const electron = (window as any).electron;

  // 先序遍历收集代码文件（树序=目录组织），顺带统计非代码文件。
  // ext 缺失时从文件名兜底推断
  const codeFiles: FileNode[] = [];
  let nonCodeCount = 0;
  const collect = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.type === 'file') {
        const ext = (node.ext || node.name.split('.').pop() || '').toLowerCase();
        if (OUTLINE_CODE_EXTS.includes(ext)) codeFiles.push(node);
        else nonCodeCount++;
      } else if (node.children) {
        collect(node.children);
      }
    }
  };
  collect(files);

  const truncatedFiles = codeFiles.length > SKELETON_MAX_FILES;
  const workList = codeFiles.slice(0, SKELETON_MAX_FILES);

  const rows: string[] = [];
  let totalDefs = 0;
  let totalLines = 0;
  let skippedBig = 0;
  let failed = 0;

  // 分批并发读（每批 50）
  const CHUNK = 50;
  for (let i = 0; i < workList.length; i += CHUNK) {
    const batch = workList.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map(async (node) => {
      try {
        const fullPath = `${filesDir}\\${node.relativePath.replace(/\//g, '\\')}`;
        const r = await electron.userpcFile.read(fullPath);
        return r?.success ? (r.data?.content || '') : null;
      } catch {
        return null;
      }
    }));
    for (let j = 0; j < batch.length; j++) {
      const node = batch[j];
      const content = results[j];
      if (content === null) { failed++; continue; }
      if (content.length > SKELETON_MAX_FILE_CHARS) { skippedBig++; continue; }
      const ext = (node.ext || node.name.split('.').pop() || '').toLowerCase();
      const extracted = extractDefs(content, ext, SKELETON_DEF_MAX_CHARS);
      if (!extracted) continue; // 理论不可达（collect 已按扩展名筛），防御性跳过
      totalLines += extracted.totalLines;
      if (extracted.defs.length === 0) {
        rows.push(`  ${node.relativePath} (${extracted.totalLines}行)`); // 无顶层定义：只列名+行数
      } else {
        totalDefs += extracted.defs.length;
        rows.push(`  ${node.relativePath} (${extracted.totalLines}行): ${extracted.defs.join(' | ')}`);
      }
    }
  }

  const parts: string[] = [`🗺 项目符号索引（代码文件 ${codeFiles.length} 个 / 定义 ${totalDefs} 个 / 共 ${totalLines} 行）:`];
  parts.push(...rows);
  if (nonCodeCount > 0) parts.push(`—— 另有 ${nonCodeCount} 个非代码文件，用 tree 模式查看 ——`);
  if (failed > 0) parts.push(`—— ${failed} 个文件读取失败已跳过 ——`);
  if (skippedBig > 0) parts.push(`—— 跳过 ${skippedBig} 个超大文件（>200KB）——`);
  if (truncatedFiles) parts.push(`⚠️ 代码文件过多，仅索引前 ${SKELETON_MAX_FILES} 个，建议用 depth 缩小范围或对子目录单独调用`);

  let message = parts.join('\n');
  if (message.length > SKELETON_MAX_MESSAGE) {
    message = message.slice(0, SKELETON_MAX_MESSAGE) + '\n⚠️ 索引过长已截断，建议用 depth 缩小范围或对子目录单独调用';
  }
  return message;
}

// ============================================================================
// 工具实现
// ============================================================================

/**
 * 🔥 辅助函数：从参数中提取 appId/projectId
 * 支持多种参数名：appId, app_id, projectId, project_id, id
 * 支持从 query 字符串中提取 UUID
 * 校验 UUID 格式（8-4-4-4-12），缩写或不完整的 ID 会报错
 */
function extractAppId(params: any, stepAppId?: string): string | undefined {
  // 🔥 支持多种参数名
  let appId = stepAppId ||
    params?.appId || params?.appid || params?.app_id ||
    params?.projectId || params?.projectid || params?.project_id ||
    params?.id;

  // 🔥 从 query 字符串中提取 UUID
  if (!appId && params?.query) {
    const uuidMatch = (params.query as string).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (uuidMatch) appId = uuidMatch[1];
  }

  return appId;
}

/**
 * 🔥 解析 projectId 已抽取为共享实现：见 ./ProjectIdResolver.ts
 * （UUID / 8位前缀 / 固定ID如 base-extensiontool 均可解析）
 */

/**
 * 🔥 search 模式：在文件树中递归查找名称匹配的文件（大小写不敏感）
 * 返回匹配节点 + 相对路径 + 父目录节点（用于列出同级文件）
 */
interface FileSearchHit {
  node: FileNode;
  relPath: string;
  parentNode: FileNode | null;
}

function searchFileNodes(
  nodes: FileNode[],
  queryLower: string,
  parentNode: FileNode | null,
  parentRel: string,
  hits: FileSearchHit[],
  depth = 0
): void {
  if (depth > 12 || hits.length > 50) return; // 防御：超深/超多时停止
  for (const node of nodes) {
    const rel = parentRel ? `${parentRel}/${node.name}` : node.name;
    if (node.name.toLowerCase().includes(queryLower)) {
      hits.push({ node, relPath: rel, parentNode });
    }
    if (node.children) {
      searchFileNodes(node.children, queryLower, node, rel, hits, depth + 1);
    }
  }
}

/**
 * 🔥 search 模式：文件名 + 文件内容双搜索
 * - 文件名命中：相对路径 + 同级文件 + 上级目录（原有逻辑）
 * - 内容命中：按文件分组（每文件最多3行片段带行号，同一文件50处匹配也只送一条）
 *   LLM 看到片段后可自行 read_project_file 读全文
 */
async function buildFileSearchResult(files: FileNode[], query: string): Promise<string> {
  const hits: FileSearchHit[] = [];
  searchFileNodes(files, query.toLowerCase(), null, '', hits);

  const parts: string[] = [];

  // ---------- 1. 文件名命中 ----------
  if (hits.length > 0) {
    const MAX_MATCHES = 15;
    const shown = hits.slice(0, MAX_MATCHES);
    parts.push(`### 文件名包含「${query}」的文件（${hits.length} 个${hits.length > MAX_MATCHES ? `，只显示前 ${MAX_MATCHES}` : ''}）`);

    const shownParents = new Set<string>();
    for (const hit of shown) {
      const parentKey = hit.parentNode?.path || '(根目录)';
      const isNewParent = !shownParents.has(parentKey);
      shownParents.add(parentKey);

      parts.push(`\n${hit.relPath}${hit.node.type === 'directory' ? '/' : ''}`);

      if (isNewParent && hit.parentNode?.children) {
        const siblings = hit.parentNode.children
          .slice(0, 30)
          .map(c => (c.name.toLowerCase().includes(query.toLowerCase()) ? `${c.name} ←匹配` : c.name));
        parts.push(`  同级（${hit.parentNode.name}/）：${siblings.join(', ')}`);
      }
    }
  }

  // ---------- 2. 内容命中（grep）----------
  const contentParts = await searchFileContents(files, query);
  if (contentParts) {
    parts.push(`\n${contentParts}`);
  }

  if (parts.length === 0) {
    return `文件名和内容中均未找到「${query}」。可尝试更换关键词，或用 mode='tree' 查看文件树。`;
  }
  return parts.join('\n');
}

/**
 * 🔥 内容搜索：遍历项目文件 grep 关键词，按文件分组返回片段
 * - 跳过二进制/大文件（>512KB）/超长行文件
 * - 每文件最多 3 行片段（带行号），最多 15 个文件，最多扫描 400 个文件（防大项目拖慢）
 */
async function searchFileContents(files: FileNode[], query: string): Promise<string | null> {
  const electron = (window as any).electron;
  if (!electron?.userpcFile?.read) return null;

  // 🔥 收集所有文件（带相对路径）
  const allFiles: { node: FileNode; relPath: string }[] = [];
  const collect = (nodes: FileNode[], parentRel: string) => {
    for (const node of nodes) {
      const rel = parentRel ? `${parentRel}/${node.name}` : node.name;
      if (node.type === 'file') allFiles.push({ node, relPath: rel });
      if (node.children) collect(node.children, rel);
    }
  };
  collect(files, '');

  // 🔥 跳过二进制/压缩产物（搜了也没意义还浪费 IO）
  const SKIP_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib', 'pt', 'pth', 'onnx', 'bin', 'h5', 'lock', 'woff', 'woff2', 'ttf', 'mp4', 'mp3', 'wav', 'csv'];
  const queryLower = query.toLowerCase();
  const MAX_SCAN = 400;      // 最多扫描文件数
  const MAX_HIT_FILES = 15;  // 最多返回文件数
  const MAX_LINES_PER_FILE = 3;

  const hitFiles: { relPath: string; lines: { no: number; text: string }[]; total: number }[] = [];
  let scanned = 0;

  for (const { node, relPath } of allFiles) {
    if (hitFiles.length >= MAX_HIT_FILES || scanned >= MAX_SCAN) break;
    const ext = (node.name.split('.').pop() || '').toLowerCase();
    if (SKIP_EXTS.includes(ext)) continue;
    if ((node.size || 0) > 512 * 1024) continue; // 跳过大文件

    scanned++;
    try {
      const r = await electron.userpcFile.read(node.path);
      if (!r?.success || !r?.data?.content) continue;
      const lines = r.data.content.split('\n');
      const matched: { no: number; text: string }[] = [];
      let total = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          total++;
          if (matched.length < MAX_LINES_PER_FILE) {
            // 截断超长行，防止 minified 文件一行刷屏
            const text = lines[i].trim().slice(0, 200);
            matched.push({ no: i + 1, text });
          }
          if (total >= 200) break; // 单文件 200 处封顶
        }
      }
      if (matched.length > 0) {
        hitFiles.push({ relPath, lines: matched, total });
      }
    } catch (e) {
      // 单文件读取失败跳过
    }
  }

  if (hitFiles.length === 0) return null;

  const out = [`### 内容包含「${query}」的文件（${hitFiles.length} 个文件命中）`];
  for (const f of hitFiles) {
    out.push(`\n${f.relPath}（${f.total} 处匹配）`);
    for (const l of f.lines) {
      out.push(`  L${l.no}: ${l.text}`);
    }
  }
  out.push(`\n💡 用 read_project_file 读取上述文件全文（可配 pattern 精确定位）`);
  return out.join('\n');
}

/**
 * 列出训练项目的文件树
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 文件树结构
 */
export async function executeListProjectFilesTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: list_project_files(projectId='xxx') 或 list_project_files(projectId='xxx', depth=1)",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  // 🔥 depth 参数：控制文件树展开深度，默认2层
  // depth=1 只看顶层，depth=2 展开一层子目录，depth=0/不限制则全量展开
  const rawDepth = params?.depth !== undefined ? parseInt(params.depth) : 2;
  const maxDepth = isNaN(rawDepth) ? 2 : rawDepth;

  try {
    console.log(`[LIST-FILES] 获取文件树: appId=${fullAppId}, depth=${maxDepth}`);

    const filesDir = await getAppBasePath(fullAppId);
    const historyDir = await getAppHistoryPath(fullAppId);

    // 扫描文件目录
    const allFiles = await scanDirectory(filesDir);
    let files = sortFileNodes(filterFileNodes(allFiles.filter(f => f.name !== 'history')));

    // 🔥 如果顶层只有一个目录（导入的 git 项目常见），自动展开为项目根
    // 避免 "repo-name/" 出现在每个路径前缀，浪费大量 token
    if (files.length === 1 && files[0].type === 'directory' && files[0].children) {
      files = sortFileNodes(filterFileNodes(files[0].children));
    }

    // 扫描历史目录
    const history = await scanHistoryDirectory(historyDir);

    // 🔥 统计文件总数
    const countFiles = (nodes: FileNode[]): number => {
      let count = 0;
      for (const node of nodes) {
        if (node.type === 'file') count++;
        if (node.children) count += countFiles(node.children);
      }
      return count;
    };
    const fileCount = countFiles(files);

    // 🔥 阅读模式分发：tree（默认，纯文件树）/ search（按文件名搜索+局部上下文）/ skeleton（项目符号索引）
    // 容错：只传了 query 没传 mode 时，自动按 search 处理（传什么参数就是什么模式）
    let mode = String(params?.mode || (params?.query ? 'search' : 'tree')).toLowerCase();
    if (mode !== 'tree' && mode !== 'search' && mode !== 'skeleton') {
      mode = params?.query ? 'search' : 'tree'; // 未知 mode 值兜底（含历史 overview，归默认 tree）
    }
    const query = params?.query ? String(params.query).trim() : '';

    if (mode === 'skeleton') {
      console.log(`[LIST-FILES] 项目符号索引: ${fileCount} 个文件（含非代码）`);
      const skeletonMessage = await buildProjectSkeleton(files, filesDir);
      return {
        success: true,
        data: { type: 'skeleton', appId: fullAppId, fileCount, message: skeletonMessage },
      };
    }

    if (mode === 'search') {
      if (!query) {
        return {
          success: false,
          error: "search 模式需要 query 参数。用法: list_project_files(projectId='xxx', mode='search', query='config')",
        };
      }
      const searchMessage = await buildFileSearchResult(files, query);
      return {
        success: true,
        data: { type: 'search', appId: fullAppId, query, message: searchMessage },
      };
    }

    // 🔥 构建紧凑的 tree 格式（受 depth 限制）
    // 类似 `tree` 命令输出，层级靠缩进表达，文件名不重复路径前缀
    const buildTree = (nodes: FileNode[], currentDepth: number): string[] => {
      const lines: string[] = [];
      for (const node of nodes) {
        if (node.type === 'file') {
          lines.push(node.name);
        } else if (node.type === 'directory' || node.children) {
          if (maxDepth > 0 && currentDepth >= maxDepth) {
            const childFiles = countFiles([node]);
            const subDirs = (node.children || []).filter(c => c.type === 'directory' || c.children).length;
            const hint = subDirs > 0
              ? `${node.name}/ (${childFiles}个文件, ${subDirs}个子目录, 用depth=${currentDepth + 1}展开)`
              : `${node.name}/ (${childFiles}个文件, 用depth=${currentDepth + 1}展开)`;
            lines.push(hint);
          } else {
            const childLines = buildTree(node.children || [], currentDepth + 1);
            if (childLines.length > 0) {
              lines.push(`${node.name}/`);
              for (const cl of childLines) {
                lines.push(`  ${cl}`);
              }
            } else {
              lines.push(`${node.name}/ (空)`);
            }
          }
        }
      }
      return lines;
    };

    const treeLines = buildTree(files, 1);

    console.log(`[LIST-FILES] 获取成功: ${fileCount} 个文件, depth=${maxDepth}, 树${treeLines.length}行`);

    // 🔥 输出大小保护：限制消息长度，防止撑爆 LLM 上下文
    const MAX_MESSAGE_LENGTH = 30000; // 约 8K tokens
    let treeMessage = `项目包含 ${fileCount} 个文件，${history.length} 个历史版本\n\n`;
    const treeText = treeLines.join('\n');

    if (treeText.length > MAX_MESSAGE_LENGTH) {
      treeMessage += treeText.slice(0, MAX_MESSAGE_LENGTH);
      treeMessage += `\n\n⚠️ 文件列表过长已截断（共${fileCount}个文件）。请使用 depth 参数缩小范围，或用 read_project_file 按需读取。`;
    } else {
      treeMessage += treeText;
      if (maxDepth > 0 && maxDepth < 10) {
        treeMessage += `\n\n💡 提示：当前显示 depth=${maxDepth} 层，使用 list_project_files(projectId='${appId}', depth=${maxDepth + 1}) 展开更多。`;
      }
    }

    // 🔥 大项目指引：指向其他阅读模式，避免 LLM 逐层遍历文件树
    if (fileCount > 30) {
      treeMessage += `\n\n💡 这是大项目（${fileCount}个文件）。建议：mode='skeleton' 看全项目定义索引；mode='search', query='关键词' 按文件名/内容搜索定位。`;
    }

    // 🔥 不再返回扁平路径数组 files[]
    // tree 格式已经通过缩进表达了层级关系，agent 可从 tree 推导路径
    // 扁平数组每个文件都重复完整前缀，token 浪费严重
    return {
      success: true,
      data: {
        type: 'fileTree',
        appId: fullAppId,
        fileCount,
        depth: maxDepth,
        historyCount: history.length,
        history: history.map(h => ({
          fileName: h.fileName,
          version: h.version.versionName,
        })),
        message: treeMessage,
      },
    };
  } catch (error) {
    console.error('[LIST-FILES] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取文件树失败",
    };
  }
}

/**
 * 读取训练项目的单个文件
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 文件内容
 */
export async function executeReadProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 入口日志：记录原始参数
  console.log(`[READ-FILE] 🔍 入口参数:`, JSON.stringify(params));
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);
  console.log(`[READ-FILE] 🔍 提取 appId: ${appId}`);
  
  // 提取 filePath（let：路径定位兜底命中后会被改写为真实相对路径）
  let filePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;
  console.log(`[READ-FILE] 🔍 提取 filePath: ${filePath}`);

  // 🔥 提取可选的搜索参数：字符串=单个（正则语义，可写 a|b|c）；数组=多关键词（逐个转义后拼 OR 正则）
  const patternRaw = params?.pattern || params?.search || params?.query;
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = Array.isArray(patternRaw)
    ? patternRaw
        .filter((k: any) => typeof k === 'string' && k.trim())
        .map((k: string) => escapeRegExp(k.trim()))
        .join('|')
    : patternRaw;
  if (pattern) {
    console.log(`[READ-FILE] 🔍 提取 pattern: ${pattern}`);
  }

  // 🔥 提取可选的行号范围参数（支持多种参数名风格）
  // LLM 常见习惯：offset/limit, startLine/endLine, lineNumber, start/end
  let offset: number | undefined;
  let limit: number | undefined;
  
  // 方式1: offset + limit（最常见）
  if (params?.offset) offset = parseInt(params.offset, 10);
  if (params?.limit) limit = parseInt(params.limit, 10);
  
  // 方式2: startLine + endLine
  if (params?.startLine) offset = parseInt(params.startLine, 10);
  if (params?.endLine && offset) limit = parseInt(params.endLine, 10) - offset + 1;
  
  // 方式3: start + end
  if (params?.start && !offset) offset = parseInt(params.start, 10);
  if (params?.end && offset) limit = parseInt(params.end, 10) - offset + 1;
  
  // 方式4: lineNumber（单行）
  if (params?.lineNumber) {
    offset = parseInt(params.lineNumber, 10);
    limit = 1;
  }
  if (params?.line) {
    offset = parseInt(params.line, 10);
    limit = 1;
  }
  
  if (offset !== undefined || limit !== undefined) {
    console.log(`[READ-FILE] 🔍 行号范围: offset=${offset}, limit=${limit}`);
  }

  if (!appId) {
    console.warn(`[READ-FILE] ❌ 失败原因: 缺少 projectId 参数`);
    return {
      success: false,
      error: "缺少 projectId 参数。用法: read_project_file(projectId='xxx', filePath='main.py')",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    console.warn(`[READ-FILE] ❌ 失败原因: projectId 解析失败 - ${resolveError}`);
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;
  console.log(`[READ-FILE] 🔍 解析后完整 projectId: ${fullAppId}`);

  // 🔥 批量读取：params.files 数组一次读多个文件（训练项目典型"几个 py 文件"从 N 轮并 1 轮）。
  // 每文件默认前 60 行（≈2500 字符，防 N 文件叠加撑爆单轮），超限自带续读坐标可定点补读；
  // LLM 显式传了 limit 则尊重传入值
  const filesRaw = params?.files || params?.filePaths || params?.file_list;
  if (Array.isArray(filesRaw) && filesRaw.length > 0) {
    const files = filesRaw.filter((f: any) => typeof f === 'string' && f.trim()).slice(0, 5);
    if (files.length === 0) {
      return { success: false, error: "files 数组为空。用法: read_project_file(projectId='xxx', files=['train.py','config.py'])" };
    }
    const parts: string[] = [];
    const errors: string[] = [];
    // 🔥 剥掉批量参数再递归单文件：files 残留会让递归调用再次命中批量分支 → 无限自我调用永不返回
    const { files: _f, filePaths: _fp, file_list: _fl, ...restParams } = params;
    for (let i = 0; i < files.length; i++) {
      const f = files[i].trim();
      const single = await executeReadProjectFileTool(
        { ...step, toolParams: { ...restParams, filePath: f, offset: params?.offset, limit: params?.limit || 60 } } as AutoStep,
        _planId,
        context
      );
      if (single.success) {
        parts.push(`=== 文件 ${i + 1}/${files.length}: ${f}${single.data?.lineInfo || ''} ===\n${single.data?.content || ''}`);
      } else {
        errors.push(`- ${f}: ${single.error}`);
      }
    }
    const okCount = parts.length;
    const summary = `📂 批量读取 ${files.length} 个文件：成功 ${okCount}，失败 ${files.length - okCount}${errors.length ? `\n${errors.join('\n')}` : ''}\n\n${parts.join('\n\n')}`;
    return {
      success: okCount > 0,
      ...(okCount > 0 ? {
        data: {
          type: 'fileContent',
          appId: fullAppId,
          filePath: files.join(', '),
          content: summary,
          language: 'text' as const,
          size: summary.length,
          lineInfo: `（批量 ${okCount}/${files.length} 个文件，每文件默认前 60 行，未读完的部分按各文件续读坐标补读）`,
          message: `批量读取 ${okCount}/${files.length} 个文件成功`,
        },
      } : {}),
      error: okCount > 0 ? undefined : `全部读取失败:\n${errors.join('\n')}`,
    };
  }

  if (!filePath) {
    console.warn(`[READ-FILE] ❌ 失败原因: 缺少 filePath 参数`);
    return {
      success: false,
      error: "缺少 filePath 参数。用法: read_project_file(projectId='xxx', filePath='main.py')",
    };
  }

  try {
    console.log(`[READ-FILE] 📖 开始读取: appId=${fullAppId}, filePath=${filePath}`);

    const electron = (window as any).electron;

    if (!electron?.userpcFile) {
      return {
        success: false,
        error: "非 Electron 环境，无法读取文件",
      };
    }

    const baseDir = await getAppBasePath(fullAppId);
    
    // 标准化路径
    const normalizedPath = filePath.replace(/\//g, '\\');
    const fullPath = `${baseDir}\\${normalizedPath}`;

    // 读取文件
    let result = await electron.userpcFile.read(fullPath);

    if (!result.success) {
      // 🔥 路径定位兜底：LLM 传的 filePath 可能是裸文件名（server.ts）或层级猜错的
      // 相对路径——典型如 base-bootcode 仓库套层项目，文件在 teegal-autoprojects/ 子目录下
      const relocated = await relocateProjectFile(fullAppId, filePath);
      if (relocated.status === 'unique') {
        console.log(`[READ-FILE] 🔁 路径定位兜底: ${filePath} → ${relocated.relativePath}`);
        filePath = relocated.relativePath;
        result = await electron.userpcFile.read(`${baseDir}\\${filePath.replace(/\//g, '\\')}`);
        if (!result.success) {
          return { success: false, error: result.error || `文件不存在: ${filePath}` };
        }
      } else if (relocated.status === 'multiple') {
        const list = relocated.candidates.slice(0, 10).join('\n  ');
        return {
          success: false,
          error: `文件不存在: ${filePath}。项目内找到 ${relocated.candidates.length} 个同名/同路径文件，请用完整相对路径重试：\n  ${list}`,
        };
      } else {
        return { success: false, error: result.error || `文件不存在: ${filePath}` };
      }
    }

    const content = result.data?.content || '';
    const ext = filePath.split('.').pop() || 'txt';
    const language = getLanguage(ext);

    // 🔥 文档分流：主进程对二进制返回 base64——不分流时 LLM 收到的是 12000 字符纯噪音。
    // docx/xlsx/xls/pdf 提取文本后返回；其余二进制明确报错+指引（图片/zip 不硬读）
    if (result.data?.encoding === 'base64') {
      const extLower = ext.toLowerCase();
      if (DOC_PARSE_EXTS.includes(extLower)) {
        const parsed = await parseDocFile(content, extLower);
        if (parsed) {
          // 回执预算与 read 整读上限对齐（解析层的 60KB/500行/50页是提取预算，这里统一收口）
          let text = parsed.text;
          let note = parsed.note;
          if (text.length > 12000) {
            text = `${text.slice(0, 12000)}\n...[已截断，原文 ${parsed.text.length} 字符]`;
            note += '（内容已截断）';
          }
          console.log(`[READ-FILE] 文档提取: ${filePath}, ${text.length} 字符`);
          return {
            success: true,
            data: {
              type: 'fileContent',
              appId: fullAppId,
              filePath,
              content: `${note}\n\n${text}`,
              language: 'text',
              size: text.length,
              totalSize: parsed.text.length,
              lineInfo: `（${note}）`,
              message: `读取文档 "${filePath}" 成功（已提取文本）`,
            },
          };
        }
        // 解析失败 → 落到下面的二进制报错（宁可缺失不可错误）
      }
      // 解析失败或不支持 → 分层指引（docReadError 按类型给最短处理路径）
      return { success: false, error: docReadError(extLower) };
    }

    // 🔥 高危二进制（主进程 base64 名单外）：utf-8 硬读是纯乱码，显式拦截
    if (BINARY_TRAP_EXTS.includes(ext.toLowerCase())) {
      return { success: false, error: docReadError(ext.toLowerCase()) };
    }

    // 🔥 按 pattern/offset/limit 截取内容
    let displayContent = content;
    let lineInfo = '';

    // 🔥 优先使用 pattern 搜索
    if (pattern) {
      const lines = content.split('\n');
      const outline = buildFileOutline(content, ext);

      try {
        const regex = new RegExp(pattern, 'i'); // 不区分大小写

        // 🔥 找到所有匹配行
        const matchIndices: number[] = [];
        for (let idx = 0; idx < lines.length; idx++) {
          if (regex.test(lines[idx])) {
            matchIndices.push(idx);
          }
          // 🔥 最多搜索 100 个匹配，避免大文件卡死
          if (matchIndices.length >= 100) break;
        }

        if (matchIndices.length === 0) {
          // 🔥 未命中：附上文件结构地图，LLM 可看着地图换关键词重试（省一轮盲猜）
          return {
            success: false,
            error: `未找到匹配内容: pattern="${pattern}"${outline ? `\n\n${outline}\n\n💡 可看着结构换关键词重试；也可传数组一次带多个关键词` : ''}`,
          };
        }

        const contextLines = limit || 20; // 每个匹配往后取的行数
        const BEFORE_LINES = 3; // 命中行往前固定带 3 行（函数签名/赋值上下文常在命中行之前）
        const MAX_TOTAL_LINES = 1000; // 🔥 搜索结果总行数预算：命中密集时自动收缩每处上下文，防止覆盖整个大文件

        // 🔥 将命中区间合并（重叠/相邻的区间合为一段，消除相邻命中导致的重复内容）
        const mergeRanges = (indices: number[], ctx: number): Array<[number, number]> => {
          const merged: Array<[number, number]> = [];
          for (const idx of indices) {
            const start = Math.max(0, idx - BEFORE_LINES);
            const end = Math.min(lines.length, idx + ctx);
            const last = merged[merged.length - 1];
            if (last && start <= last[1]) {
              last[1] = Math.max(last[1], end); // 与上一段重叠/相邻，扩展
            } else {
              merged.push([start, end]);
            }
          }
          return merged;
        };
        const totalLinesOf = (ranges: Array<[number, number]>) =>
          ranges.reduce((sum, r) => sum + (r[1] - r[0]), 0);

        let ctx = contextLines;
        let mergedRanges = mergeRanges(matchIndices, ctx);
        // 🔥 总行数超预算时逐级减半收缩上下文（下限 20 行），命中越多每处取得越少
        while (totalLinesOf(mergedRanges) > MAX_TOTAL_LINES && ctx > 20) {
          ctx = Math.max(20, Math.floor(ctx / 2));
          mergedRanges = mergeRanges(matchIndices, ctx);
        }

        // 🔥 每行带行号前缀，LLM 可直接引用精确行号，省"专门拿行号"的整轮读取
        const results = mergedRanges.map(([start, end]) =>
          `--- 第 ${start + 1}-${end} 行 ---\n${lines.slice(start, end).map((l, i) => `${start + i + 1}→${l}`).join('\n')}`
        );

        const body = results.join('\n\n');
        displayContent = outline ? `${outline}\n\n${body}` : body;
        lineInfo = `（搜索 "${pattern}" 匹配 ${matchIndices.length} 处，合并为 ${mergedRanges.length} 段，每处带前${BEFORE_LINES}后${ctx}行，行号已标注${outline ? '，附文件结构地图' : ''}，共 ${totalLinesOf(mergedRanges)} 行）`;

        console.log(`[READ-FILE] 搜索匹配: "${pattern}" 匹配 ${matchIndices.length} 处，合并为 ${mergedRanges.length} 段，每处带前${BEFORE_LINES}后${ctx}行${outline ? '（附骨架）' : ''}`);
      } catch (e) {
        return {
          success: false,
          error: `正则表达式错误: pattern="${pattern}", 错误信息: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    // 🔥 否则使用 offset/limit 定点读取
    else if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const startLine = Math.max(0, (offset || 1) - 1); // offset 从 1 开始，转换为 0-based index
      const lineCount = limit || 50; // 默认 50 行

      const selectedLines = lines.slice(startLine, startLine + lineCount);
      // 🔥 每行带行号前缀（与 pattern 命中段格式一致），LLM 可直接引用精确行号
      displayContent = selectedLines.map((l, i) => `${startLine + i + 1}→${l}`).join('\n');

      const endLine = Math.min(lines.length, startLine + lineCount);
      // 🔥 续读游标：LLM 不用自己算下一页从哪开始（忘了算就得从头读，白费一轮）
      lineInfo = `（第 ${startLine + 1}-${endLine} 行，共 ${lines.length} 行${endLine < lines.length ? `。续读: offset=${endLine + 1}` : '，已到文件末尾'}）`;

      console.log(`[READ-FILE] 按行号截取: ${startLine + 1}-${endLine} 行`);
    }
    // 🔥 整读上限：无 pattern/offset/limit 的默认整读限制单文件返回量。
    // 单轮并行整读几个大文件会瞬间撑爆上下文（60KB+ prompt 会触发上游网关 60s 超时 502）。
    // 截断到整行 + 提示续读：中小文件仍一读到位（省轮次），大文件自动降级为精读
    else {
      const MAX_FULL_READ_CHARS = 12000;
      if (content.length > MAX_FULL_READ_CHARS) {
        let cut = content.slice(0, MAX_FULL_READ_CHARS);
        const lastNl = cut.lastIndexOf('\n');
        if (lastNl > 0) cut = cut.slice(0, lastNl); // 截到整行，保持行完整性
        const totalLines = content.split('\n').length;
        const keptLines = cut.split('\n').length;
        const outline = buildFileOutline(content, ext);
        displayContent = outline ? `${outline}\n\n${cut}` : cut; // 🔥 附骨架：LLM 知道未返回的后半段有什么
        lineInfo = `（全文共 ${content.length} 字符/${totalLines} 行，超整读上限，已返回前 ${keptLines} 行${outline ? '，附文件结构地图' : ''}。续读：offset=${keptLines + 1}；精读：用 pattern 搜关键类/函数定义）`;
        console.log(`[READ-FILE] 整读截断: ${filePath} ${content.length} → ${cut.length} 字符${outline ? '（附骨架）' : ''}`);
      } else {
        // 🔥 已读标签：明确告知已完整读取，防 LLM 拿不准而整轮重读
        lineInfo = `（全文共 ${content.length} 字符/${content.split('\n').length} 行，已完整读取，无需续读）`;
      }
    }

    console.log(`[READ-FILE] 读取成功: ${filePath}${lineInfo}, 大小: ${displayContent.length} 字符`);

    return {
      success: true,
      data: {
        type: 'fileContent',
        appId: fullAppId,
        filePath,
        content: displayContent,
        language,
        size: displayContent.length,
        totalSize: content.length,
        lineInfo,
        message: `读取文件 "${filePath}" 成功`,
      },
    };
  } catch (error) {
    console.error('[READ-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "读取文件失败",
    };
  }
}

/**
 * 保存/创建训练项目文件
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 操作结果
 */
export async function executeSaveProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string; conversationId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);
  
  // 提取 filePath
  const filePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;
  
  // 提取 content
  let content = params?.content || params?.code;

  // 🔥 检查 content 是否是 JSON 字符串（被转义了）
  // 如果 content 以引号开头，可能是 JSON.stringify 转义后的字符串
  if (content && typeof content === 'string') {
    // 检查是否是 JSON 字符串格式（以 " 开头，包含转义字符）
    const trimmedContent = content.trim();
    if (trimmedContent.startsWith('"') && trimmedContent.endsWith('"')) {
      try {
        // 尝试解析 JSON 字符串
        const parsedContent = JSON.parse(trimmedContent);
        if (typeof parsedContent === 'string') {
          console.log(`[SAVE-FILE] 检测到 JSON 字符串格式，已解析: 原长度=${content.length}, 解析后长度=${parsedContent.length}`);
          content = parsedContent;
        }
      } catch (e) {
        // 解析失败，保持原样
        console.warn(`[SAVE-FILE] JSON 字符串解析失败，保持原样`);
      }
    }
    
    // 🔥 检测并修复字面量转义序列（\n → 真正的换行）
    // LLM 常见问题：在 JSON 参数中输出 "content": "line1\\nline2"
    // JSON.parse 后得到 "line1\nline2"（字面量 \n，两个字符），而非真正的换行
    // 判断标准：content 包含字面量 \n 但没有真正的换行符 → 说明是转义残留
    const hasLiteralEscape = /\\[nrt]/.test(content);
    const hasRealNewline = content.includes('\n');
    if (hasLiteralEscape && !hasRealNewline) {
      try {
        // 用 JSON.parse 解码转义序列
        const decodedContent = JSON.parse(`"${content}"`);
        if (typeof decodedContent === 'string' && decodedContent.includes('\n')) {
          console.log(`[SAVE-FILE] 修复字面量转义: 原长度=${content.length}, 修复后长度=${decodedContent.length}`);
          content = decodedContent;
        }
      } catch (e) {
        // JSON.parse 失败，手动替换常见转义
        content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
        console.log(`[SAVE-FILE] 手动修复字面量转义`);
      }
    }

    // 🔥 解码 Unicode 转义序列（如 \u5f00\u76d8 -> 开盘）
    // LLM 可能输出 Unicode 转义的中文字符
    if (content.includes('\\u')) {
      try {
        // 使用 JSON.parse 来解码 Unicode 转义
        const decodedContent = JSON.parse(`"${content}"`);
        if (typeof decodedContent === 'string') {
          console.log(`[SAVE-FILE] 检测到 Unicode 转义，已解码: 原长度=${content.length}, 解码后长度=${decodedContent.length}`);
          content = decodedContent;
        }
      } catch (e) {
        // 解析失败，尝试手动解码
        content = content.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });
        console.log(`[SAVE-FILE] 手动解码 Unicode 转义完成`);
      }
    }
  }

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: save_project_file(projectId='xxx', filePath='main.py', content='...')",
    };
  }

  // 🔥 .json 文件自动 pretty-print：LLM 常写紧凑单行 JSON（省 token 但没法看），
  // 保存前格式化为 2 空格缩进；解析失败（JSON 不合法）则原样保存不拦截
  content = prettyPrintJsonIfNeeded(filePath, content);

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  if (!filePath) {
    return {
      success: false,
      error: "缺少 filePath 参数。用法: save_project_file(projectId='xxx', filePath='main.py', content='...')",
    };
  }

  if (!content || typeof content !== 'string') {
    return {
      success: false,
      error: "缺少 content 参数。用法: save_project_file(projectId='xxx', filePath='main.py', content='...')",
    };
  }

  try {
    console.log(`[SAVE-FILE] 保存文件: appId=${fullAppId}, filePath=${filePath}`);

    const electron = (window as any).electron;

    if (!electron?.saveAppCodeFile) {
      return {
        success: false,
        error: "非 Electron 环境，无法保存文件",
      };
    }

    const codePath = await getCodePath(fullAppId);
    
    // 标准化路径
    const normalizedPath = filePath.replace(/\//g, '\\');

    // 检查文件是否存在
    const existsResult = await electron.checkAppCodeFileExists({ appId: fullAppId, fileName: normalizedPath, codePath: codePath || undefined });
    const isNewFile = !existsResult?.exists;

    console.log(`[SAVE-FILE] 文件存在检查: exists=${existsResult?.exists}, isNewFile=${isNewFile}`);

    // 保存文件（历史版本备份已在 electron 主进程中处理）
    const result = await electron.saveAppCodeFile({ appId: fullAppId, fileName: normalizedPath, content, codePath: codePath || undefined });

    if (!result?.success) {
      return {
        success: false,
        error: result?.error || "保存失败",
      };
    }

    console.log(`[SAVE-FILE] 保存成功: ${filePath}`);

    // 🔥 热重载：保存的是基础项目的 tools/ 文件（工具代码或 registry.json）时，
    // 自动重新加载动态工具；await 确保下一轮 prompt 的工具列表必然包含新工具
    await triggerBaseToolReload(fullAppId, filePath, context?.userId);

    // 🔥 发送事件通知 FileTree 刷新 + DesktopAppCard 显示修改图标
    window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
      detail: { appId: fullAppId, filePath, action: 'save' }
    }));

    // 🔥 touch 活跃度
    await touchAppUpdatedAt(fullAppId);

    return {
      success: true,
      data: {
        type: 'fileSaved',
        appId: fullAppId,
        filePath,
        isNewFile,
        size: content.length,
        message: isNewFile 
          ? `创建文件 "${filePath}" 成功` 
          : `保存文件 "${filePath}" 成功`,
      },
    };
  } catch (error) {
    console.error('[SAVE-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "保存文件失败",
    };
  }
}

/**
 * 删除训练项目文件
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 操作结果
 */
export async function executeDeleteProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);
  
  // 提取 filePath
  const filePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: delete_project_file(projectId='xxx', filePath='old.py')",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  if (!filePath) {
    return {
      success: false,
      error: "缺少 filePath 参数。用法: delete_project_file(projectId='xxx', filePath='old.py')",
    };
  }

  try {
    console.log(`[DELETE-FILE] 删除文件: appId=${fullAppId}, filePath=${filePath}`);

    const electron = (window as any).electron;

    if (!electron?.userpcFile?.delete) {
      return {
        success: false,
        error: "非 Electron 环境，无法删除文件",
      };
    }

    const baseDir = await getAppBasePath(fullAppId);

    // 标准化路径
    const normalizedPath = filePath.replace(/\//g, '\\');
    const fullPath = `${baseDir}\\${normalizedPath}`;

    // 检查文件是否存在
    const existsResult = await electron.userpcFile.exists(fullPath);

    if (!existsResult?.success || !existsResult?.data?.exists) {
      return {
        success: false,
        error: `文件不存在: ${filePath}`,
      };
    }

    // 删除文件
    const result = await electron.userpcFile.delete(fullPath);

    if (!result?.success) {
      return {
        success: false,
        error: result?.error || "删除失败",
      };
    }

    // 同时删除 history 中的备份（history 始终在默认路径下）
    const historyDir = await getAppHistoryPath(fullAppId);
    const historyPath = `${historyDir}\\${normalizedPath}`;
    try {
      const historyExists = await electron.userpcFile.exists(historyPath);
      if (historyExists?.success && historyExists?.data?.exists) {
        await electron.userpcFile.delete(historyPath);
      }
    } catch (e) {
      // history 删除失败不影响主流程
    }

    console.log(`[DELETE-FILE] 删除成功: ${filePath}`);

    // 🔥 热重载：删除的是基础项目的 tools/ 文件时，同步刷新动态工具（registry 清理后注销旧工具）
    await triggerBaseToolReload(fullAppId, filePath, context?.userId);

    // 🔥 发送事件通知 FileTree 刷新
    window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
      detail: { appId: fullAppId, filePath, action: 'delete' }
    }));

    // 🔥 touch 活跃度
    await touchAppUpdatedAt(fullAppId);

    return {
      success: true,
      data: {
        type: 'fileDeleted',
        appId: fullAppId,
        filePath,
        message: `删除文件 "${filePath}" 成功`,
      },
    };
  } catch (error) {
    console.error('[DELETE-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "删除文件失败",
    };
  }
}

// ============================================================================
// edit_project_file: 局部编辑文件（search/replace 模式）
// ============================================================================

/**
 * 局部编辑项目文件（edit_project_file）
 *
 * 🔥 使用 search/replace 模式，只传需要修改的代码片段，不需要传整个文件内容
 * 支持多个 edits，按顺序依次应用
 * 比save_project_file更省token，尤其适合大文件的局部修改
 *
 * 用法:
 *   edit_project_file(projectId='xxx', filePath='main.py', edits=[
 *     {oldText: 'lr=0.001', newText: 'lr=0.0001'},
 *     {oldText: 'epochs=10', newText: 'epochs=50'}
 *   ])
 *
 * 也可以单个编辑:
 *   edit_project_file(projectId='xxx', filePath='main.py', oldText='lr=0.001', newText='lr=0.0001')
 */
/**
 * 🔥 edit 失败时在文件中找最接近 oldText 的片段（按行窗口 + 压缩空白前缀相似度）
 * 让 LLM 一次拿到「正确原文 + 行号」，避免 失败→再read→再edit 的 3 轮重试
 */
function suggestSimilarSnippet(
  content: string,
  oldText: string
): { lineStart: number; lineEnd: number; snippet: string } | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const compress = (t: string) => t.replace(/\s+/g, ' ').trim();
  const target = compress(oldText);
  if (!target) return null;
  const probe = target.slice(0, 60); // 比较用前 60 字符
  const oldLineCount = oldText.replace(/\r\n/g, '\n').split('\n').length;
  const winSize = Math.min(Math.max(oldLineCount, 1), 30);

  let best: { idx: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const cw = compress(lines.slice(i, i + winSize).join('\n'));
    let score = 0;
    for (let len = Math.min(probe.length, cw.length); len >= 15; len--) {
      if (cw.includes(probe.slice(0, len))) {
        score = len;
        break;
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { idx: i, score };
  }
  if (!best || best.score < 15) return null;

  const snippet = lines.slice(best.idx, best.idx + winSize).join('\n');
  return {
    lineStart: best.idx + 1,
    lineEnd: Math.min(lines.length, best.idx + winSize),
    snippet: snippet.length > 400 ? snippet.slice(0, 400) + '\n...' : snippet,
  };
}

/**
 * 对单个文件应用一组 edits：读 → 逐个应用（精确/规范化/模糊三层匹配）→ 保存
 * 供 edit_project_file 使用：跨文件批量时按文件分组调用
 */
async function applyEditsToSingleFile(
  fullAppId: string,
  filePath: string,
  fileEdits: Array<{ oldText: string; newText: string }>,
  context?: { userId?: string; conversationId?: string }
): Promise<{ success: boolean; message: string; applied: number; failed: number }> {
  const electron = (window as any).electron;
  const codePath = await getCodePath(fullAppId);
  const normalizedPath = filePath.replace(/\//g, '\\');

  // 1. 读取当前文件内容
  const readResult = await electron.readAppCodeFile({ appId: fullAppId, fileName: normalizedPath, codePath: codePath || undefined });
  if (!readResult?.success) {
    return { success: false, message: `读取文件失败: ${readResult?.error || '文件不存在'}`, applied: 0, failed: fileEdits.length };
  }

  let content: string = readResult.content || '';
  const appliedEdits: string[] = [];
  const failedEdits: string[] = [];
  // 🔥 记录每个成功 edit 的 diff 片段（用于返回值展示）
  const diffParts: string[] = [];

  // 🔥 diff 收缩到变化邻域：对齐 old/new 公共前缀/后缀行，只渲染变化行 ±2 行上下文。
  // oldText/newText 是 LLM 自己刚发的内容，全量回显是纯重复；但执行历史里 params 被截断
  // 到 100 字符，diff 是后续轮次回看"改了什么"的唯一载体——保留变化邻域即够，全文用 read
  const shrinkDiff = (oldText: string, newText: string): string => {
    const oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
    const newLines = newText.replace(/\r\n/g, '\n').split('\n');

    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix++;

    if (prefix + suffix >= oldLines.length && prefix + suffix >= newLines.length) return ''; // 无实际变化

    const CTX = 2;
    const parts: string[] = [];
    if (prefix > CTX) parts.push(`  …（前 ${prefix - CTX} 行未变）`);
    for (let i = Math.max(0, prefix - CTX); i < prefix; i++) parts.push(`  ${oldLines[i]}`);
    for (let i = prefix; i < oldLines.length - suffix; i++) parts.push(`- ${oldLines[i]}`);
    for (let i = prefix; i < newLines.length - suffix; i++) parts.push(`+ ${newLines[i]}`);
    const ctxEnd = Math.min(oldLines.length, oldLines.length - suffix + CTX);
    for (let i = oldLines.length - suffix; i < ctxEnd; i++) parts.push(`  ${oldLines[i]}`);
    if (suffix > CTX) parts.push(`  …（后 ${suffix - CTX} 行未变）`);
    return parts.join('\n');
  };

  // 🔥 规范化空白符的匹配函数：忽略行尾空白和换行符差异
  const normalizeForMatch = (text: string): string => {
    return text.replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  };

  // 2. 按顺序应用每个 edit
  for (let i = 0; i < fileEdits.length; i++) {
    let { oldText, newText } = fileEdits[i];

    // 🔥 预清洗：LLM 把 read 回执的行号前缀（123→内容）逐字复制进 oldText——空白容错救不了
    // 这种坑，会直接匹配失败→重读→重编。行首 `数字→` 在真实代码里概率极低，可安全检测剥离
    const stripped = oldText.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/^\s*\d+→/, '')).join('\n');
    const nonEmptyLines = stripped.split('\n').filter(l => l.trim());
    if (stripped !== oldText && nonEmptyLines.length >= 2) {
      const hitCount = oldText.replace(/\r\n/g, '\n').split('\n').filter(l => /^\s*\d+→/.test(l)).length;
      if (hitCount / nonEmptyLines.length >= 0.6) oldText = stripped;
    }

    // 精确匹配
    if (content.includes(oldText)) {
      content = content.replace(oldText, newText);
      appliedEdits.push(`编辑${i + 1}: 成功替换`);
      diffParts.push(shrinkDiff(oldText, newText));
      continue;
    }

    // 🔥 容错匹配：规范化空白符后再匹配
    const normalizedContent = normalizeForMatch(content);
    const normalizedOldText = normalizeForMatch(oldText);

    if (normalizedContent.includes(normalizedOldText)) {
      // 找到规范化匹配的位置，在原内容中定位并替换
      const normStartIdx = normalizedContent.indexOf(normalizedOldText);
      // 计算原始内容中对应的起止位置
      let charCount = 0;
      let origStartIdx = 0;
      let origEndIdx = 0;
      let found = false;

      for (let ci = 0; ci < content.length; ci++) {
        const normalizedChar = normalizeForMatch(content[ci]);
        for (const ch of normalizedChar) {
          if (charCount === normStartIdx) {
            origStartIdx = ci;
          }
          charCount++;
          if (charCount === normStartIdx + normalizedOldText.length) {
            origEndIdx = ci + 1;
            found = true;
            break;
          }
        }
        if (found) break;
      }

      if (found) {
        content = content.substring(0, origStartIdx) + newText + content.substring(origEndIdx);
        appliedEdits.push(`编辑${i + 1}: 成功替换（规范化匹配）`);
        diffParts.push(shrinkDiff(oldText, newText));
        continue;
      }
    }

    // 🔥 最后尝试：模糊匹配（跳过空白符差异）
    // 将 oldText 和 content 都压缩空白符后匹配
    const compressWhitespace = (text: string): string => {
      return text.replace(/\s+/g, ' ').trim();
    };

    const compressedContent = compressWhitespace(content);
    const compressedOldText = compressWhitespace(oldText);

    if (compressedContent.includes(compressedOldText)) {
      // 模糊匹配成功，但无法精确定位，使用精确的 oldText 匹配结果
      // 这种情况下，我们提示 LLM 提供更精确的 oldText
      failedEdits.push(`编辑${i + 1}: 内容存在但空白符差异过大。请以 read_project_file 的原文逐字作为 oldText 重试`);
      continue;
    }

    // 🔥 失败兜底：给出文件中最接近的片段 + 行号，让 LLM 下一次 edit 直接命中（省 3 轮重试）
    const hint = suggestSimilarSnippet(content, oldText);
    if (hint) {
      failedEdits.push(
        `编辑${i + 1}: 未找到精确匹配。文件第 ${hint.lineStart}-${hint.lineEnd} 行有最接近的内容：\n---\n${hint.snippet}\n---\n请逐字复制以上原文作为 oldText 重试（保留缩进，不要自行改写）`
      );
    } else {
      failedEdits.push(`编辑${i + 1}: 未找到匹配的代码片段 (oldText前50字符: "${oldText.substring(0, 50)}...")。文件中无相似内容，请先 read_project_file 确认后再改`);
    }
  }

  // 3. 如果有成功的编辑，保存文件
  const hasChanges = appliedEdits.length > 0;

  if (hasChanges) {
    // 🔥 .json 自动 pretty-print（与 save_project_file 一致）
    content = prettyPrintJsonIfNeeded(filePath, content);
    const saveResult = await electron.saveAppCodeFile({ appId: fullAppId, fileName: normalizedPath, content, codePath: codePath || undefined });

    if (!saveResult?.success) {
      return { success: false, message: `编辑成功但保存失败: ${saveResult?.error || '未知错误'}`, applied: appliedEdits.length, failed: failedEdits.length };
    }

    console.log(`[EDIT-FILE] 编辑保存成功: ${filePath}, 成功${appliedEdits.length}项, 失败${failedEdits.length}项`);

    // 🔥 热重载：编辑的是基础项目的 tools/ 文件时（典型：LLM 用 edit 更新已存在的 registry.json），
    // 同步重新加载动态工具——之前此路径无钩子，是"工具注册了但不进 prompt"的根因
    await triggerBaseToolReload(fullAppId, filePath, context?.userId);

    // 🔥 发送事件通知 FileTree 刷新 + DesktopAppCard 显示修改图标
    window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
      detail: { appId: fullAppId, filePath, action: 'save' }
    }));

    // 🔥 touch 活跃度
    await touchAppUpdatedAt(fullAppId);
  }

  // 4. 构造结果
  const resultParts: string[] = [];
  if (appliedEdits.length > 0) {
    resultParts.push(`✅ 成功 ${appliedEdits.length} 项:\n${appliedEdits.join('\n')}`);
  }
  if (failedEdits.length > 0) {
    resultParts.push(`❌ 失败 ${failedEdits.length} 项:\n${failedEdits.join('\n')}`);
  }

  // 🔥 如果有成功的编辑，附带变化邻域 diff（markdown diff 代码块，前端可高亮渲染）。
  // 收缩是按公共前缀/后缀对齐裁掉未变部分，变化区完整保留——不会诱发 LLM 重读确认
  const diffText = diffParts.filter(Boolean).join('\n');
  if (diffText.trim()) {
    resultParts.push(`\`\`\`diff\n${diffText}\n\`\`\``);
  }

  return { success: hasChanges, message: resultParts.join('\n\n'), applied: appliedEdits.length, failed: failedEdits.length };
}

/**
 * 🔥 从 edits 内容推断目标文件（顶层 filePath 缺省时的自动定位）。
 * oldText 是 LLM 从 read 回执逐字复制的，全项目唯一包含它的文件即目标。
 * 两级探针：精确全文匹配 → 最长单行 trim 匹配（缩进差异兜底）。
 * 唯一命中返回 file；多命中/零命中返回 candidates/allFiles（调用方报错附清单，省一轮 list）。
 */
async function inferEditTargetFile(
  baseDir: string,
  edits: Array<{ oldText: string }>
): Promise<{ file?: string; candidates: string[]; allFiles: string[] }> {
  const electron = (window as any).electron;
  const stripLineNo = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/^\s*\d+→/, '')).join('\n');
  const exact = stripLineNo(edits[0]?.oldText || '');
  const probeLine = exact.split('\n').map(l => l.trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';

  const nodes = await scanDirectory(baseDir);
  const files: FileNode[] = [];
  const walk = (list: FileNode[]) => { for (const n of list) { if (n.type === 'file') files.push(n); if (n.children?.length) walk(n.children); } };
  walk(nodes);

  const SKIP = new Set([...BINARY_TRAP_EXTS, ...DOC_PARSE_EXTS, 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'zip', 'rar', '7z', 'gz', 'tar', 'pdf']);
  const exactHits: string[] = [];
  const lineHits: string[] = [];
  const allFiles: string[] = [];
  for (const f of files) {
    const rel = f.relativePath || f.path;
    const ext = (f.ext || f.name.split('.').pop() || '').toLowerCase();
    allFiles.push(rel);
    if (SKIP.has(ext) || (f.size ?? 0) > 200 * 1024) continue;
    try {
      const r = await electron.userpcFile.read(`${baseDir}\\${rel.replace(/\//g, '\\')}`);
      if (!r.success) continue;
      const content: string = stripLineNo(r.data?.content || '');
      if (exact && content.includes(exact)) { exactHits.push(rel); continue; }
      if (probeLine && content.includes(probeLine)) lineHits.push(rel);
    } catch { /* skip */ }
  }
  const candidates = exactHits.length ? exactHits : lineHits;
  return { file: candidates.length === 1 ? candidates[0] : undefined, candidates, allFiles };
}

export async function executeEditProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string; conversationId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  // 🔥 提取 projectId
  const appId = extractAppId(params, step.appId);

  // 提取 filePath（推荐写法：每项 edit 自带 filePath，显式无歧义。
  // 顶层 filePath 仅作兼容兜底；全缺省时按 oldText 内容指纹自动定位）
  let defaultFilePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: edit_project_file(projectId='xxx', filePath='main.py', edits=[{oldText:'...', newText:'...'}])",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  // 🔥 提取 edits：支持数组和单个 oldText/newText 两种形式；每个 edit 可带 filePath（跨文件批量）
  let edits: Array<{ filePath?: string; oldText: string; newText: string }> = [];

  if (Array.isArray(params?.edits)) {
    edits = params.edits.filter((e: any) => e.oldText && e.newText !== undefined).map((e: any) => ({
      filePath: e.filePath || e.file_path || undefined,
      oldText: String(e.oldText),
      newText: String(e.newText),
    }));
  } else if (params?.oldText !== undefined) {
    // 单个编辑模式
    edits = [{ oldText: String(params.oldText), newText: String(params.newText ?? '') }];
  }

  if (edits.length === 0) {
    return {
      success: false,
      error: "缺少 edits 参数。用法: edit_project_file(projectId='xxx', filePath='main.py', edits=[{oldText:'...', newText:'...'}]) 或 edit_project_file(projectId='xxx', filePath='main.py', oldText='...', newText='...')",
    };
  }

  const editsMissingFp = edits.filter((e: any) => !e.filePath);
  if (!defaultFilePath && editsMissingFp.length > 0) {
    // 🔥 顶层 filePath 必带（=默认文件，跨文件时内项覆盖）。LLM 偶发漏传时
    // 按 oldText 内容指纹定位兜底（唯一命中即成功，不浪费轮次；失败报错附清单）
    const baseDir = await getAppBasePath(fullAppId);
    const inferred = await inferEditTargetFile(baseDir, editsMissingFp);
    if (inferred.file) {
      console.log(`[EDIT-FILE] 🔎 顶层 filePath 缺省，内容指纹定位: ${inferred.file}`);
      defaultFilePath = inferred.file;
    } else {
      const hint = inferred.candidates.length > 1
        ? `oldText 内容命中多个文件: ${inferred.candidates.join(', ')}`
        : `oldText 未命中任何文件。项目文件: ${inferred.allFiles.slice(0, 30).join(', ')}${inferred.allFiles.length > 30 ? ` …等 ${inferred.allFiles.length} 个` : ''}`;
      return {
        success: false,
        error: `edits 每项必须带 filePath（一个 edit 声明一个文件的修改）。无法自动定位：${hint}`,
      };
    }
  }

  try {
    console.log(`[EDIT-FILE] 编辑文件: appId=${fullAppId}, filePath=${defaultFilePath || '(per-edit)'}, edits=${edits.length}`);

    const electron = (window as any).electron;

    if (!electron?.readAppCodeFile || !electron?.saveAppCodeFile) {
      return {
        success: false,
        error: "非 Electron 环境，无法编辑文件",
      };
    }

    // 🔥 跨文件批量：每个 edit 可带 filePath（缺省用顶层 filePath），按文件分组后逐文件应用——
    // 多文件多处修改 1 轮 1 工具完成，不再「1 文件 1 轮」
    const groups = new Map<string, Array<{ oldText: string; newText: string }>>();
    for (const e of edits) {
      const fp = e.filePath || defaultFilePath;
      if (!fp) continue; // 前置校验已兜底
      const arr = groups.get(fp);
      if (arr) arr.push({ oldText: e.oldText, newText: e.newText });
      else groups.set(fp, [{ oldText: e.oldText, newText: e.newText }]);
    }

    const fileMessages: string[] = [];
    let totalApplied = 0;
    let totalFailed = 0;
    let anySuccess = false;

    for (const [fp, fileEdits] of groups) {
      const r = await applyEditsToSingleFile(fullAppId, fp, fileEdits, context);
      totalApplied += r.applied;
      totalFailed += r.failed;
      if (r.success) anySuccess = true;
      fileMessages.push(`📁 ${fp}\n${r.message}`);
    }

    // 🔥 TS 改动自闭环提示：LLM 看到后可自行跑 tsc 并按报错自纠（Python 等直接运行即可，无需此提示）
    if (anySuccess && [...groups.keys()].some((fp) => /\.(ts|tsx)$/i.test(fp))) {
      fileMessages.push('💡 涉及 TS 文件：建议跑 npx tsc --noEmit 验证（可选，报错可自纠）');
    }

    return {
      success: anySuccess,
      data: {
        type: 'fileEdited',
        appId: fullAppId,
        filePath: defaultFilePath || [...groups.keys()][0] || '',
        appliedCount: totalApplied,
        failedCount: totalFailed,
        message: fileMessages.join('\n\n'),
      },
    };
  } catch (error) {
    console.error('[EDIT-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "编辑文件失败",
    };
  }
}

// ============================================================================
// 训练任务历史工具
// ============================================================================

/**
 * 训练任务列表项（简化版）
 */
export interface TrainTaskListItem {
  id: string;
  app_id: string | null;
  status: string;
  instance_type: string | null;
  duration: number | null;
  cost: number | null;
  flag: string | null;
  remark: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 训练任务详情（完整版）
 */
export interface TrainTaskDetail {
  id: string;
  app_id: string | null;
  user_id: string;
  status: string;
  stdout_output: string | null;
  charts_json: any[];
  files_json: Record<string, any>;
  model_oss_url: string | null;
  instance_type: string | null;
  gpu_instance_id: string | null;
  duration: number | null;
  cost: number | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 列出训练任务
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 任务列表（简化版）
 */
export async function executeListTrainTasksTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);

  if (!appId) {
    return {
      success: false,
      error: "缺少 appId/projectId 参数。用法: list_tasks(appId='xxx')",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  try {
    console.log(`[LIST-TASKS] 获取训练任务列表: appId=${fullAppId}`);

    // 🔥 使用 trainingTaskStorage 而不是直接 fetch
    const { trainingTaskStorage } = await import('@/services/storage');
    const tasks = await trainingTaskStorage.getByAppId(fullAppId);

    // 🔥 只返回简化字段，不返回 stdout_output、charts_json 等大字段
    const simplifiedTasks: TrainTaskListItem[] = tasks.map((task: any) => ({
      id: task.id,
      app_id: task.app_id,
      status: task.status,
      instance_type: task.instance_type,
      duration: task.duration,
      cost: task.cost,
      flag: task.flag,
      remark: task.remark,  // 🔥 训练备注
      created_at: task.created_at,
      updated_at: task.updated_at,
    }));

    console.log(`[LIST-TASKS] 获取成功: ${simplifiedTasks.length} 个任务`);

    const totalCount = simplifiedTasks.length;

    // 🔥 分页：解析 morePage 参数（格式如 "11-20"）
    const morePage = params?.morePage || params?.more_page;
    let startIdx = 0;
    let endIdx = 10;
    if (morePage && typeof morePage === 'string') {
      const match = morePage.match(/^(\d+)-(\d+)$/);
      if (match) {
        startIdx = Math.max(0, parseInt(match[1]) - 1);
        endIdx = Math.min(totalCount, parseInt(match[2]));
      }
    }

    const pagedTasks = simplifiedTasks.slice(startIdx, endIdx);

    // 🔥 构造更友好的返回信息
    let taskSummary = `项目共有 ${totalCount} 个训练任务，当前展示第 ${startIdx + 1}-${Math.min(endIdx, totalCount)} 个：\n\n`;
    pagedTasks.forEach((task, index) => {
      taskSummary += `${startIdx + index + 1}. 任务ID: ${task.id}\n`;
      taskSummary += `   状态: ${task.status}\n`;
      if (task.flag) taskSummary += `   标记: ${task.flag}\n`;
      if (task.remark) taskSummary += `   备注: ${task.remark}\n`;
      if (task.duration) taskSummary += `   时长: ${task.duration}秒\n`;
      if (task.cost) taskSummary += `   费用: ¥${task.cost}\n`;
      taskSummary += `   创建时间: ${new Date(task.created_at).toLocaleString()}\n\n`;
    });

    taskSummary += `\n💡 提示：使用 get_task_detail(taskId='完整的UUID') 获取任务详情`;
    if (totalCount > 10 && !morePage) {
      taskSummary += `\n⚠️ 总共有 ${totalCount} 个任务，默认返回最近 10 个。如需查看更早任务，请使用 list_tasks(appId='${appId}', type='train', morePage='11-20')`;
    }

    return {
      success: true,
      data: {
        type: 'taskList',
        appId: fullAppId,
        tasks: pagedTasks,
        taskCount: totalCount,
        message: taskSummary,
      },
    };
  } catch (error) {
    console.error('[LIST-TASKS] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取训练任务列表失败",
    };
  }
}

/**
 * 获取训练任务详情
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 任务详情（完整版）
 */
export async function executeGetTrainTaskDetailTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 提取 taskId
  const taskId = params?.taskId || params?.taskid || params?.task_id || params?.id;

  if (!taskId) {
    return {
      success: false,
      error: "缺少 taskId 参数。用法: get_train_task_detail(taskId='xxx')",
    };
  }

  try {
    console.log(`[TASK-DETAIL] 获取训练任务详情: taskId=${taskId}`);

    // 🔥 使用 trainingTaskStorage 而不是直接 fetch
    const { trainingTaskStorage } = await import('@/services/storage');
    const task = await trainingTaskStorage.getById(taskId);

    if (!task) {
      return {
        success: false,
        error: `训练任务不存在: ${taskId}`,
      };
    }

    console.log(`[TASK-DETAIL] 获取成功: taskId=${taskId}, status=${task.status}`);

    // 🔥 构造更友好的返回信息
    let outputSummary = '';
    if (task.stdout_output && task.stdout_output.length > 0) {
      const lines = task.stdout_output.split('\n');
      outputSummary = `\n\n📝 输出日志摘要 (共${lines.length}行):\n`;
      outputSummary += `前10行:\n${lines.slice(0, 10).join('\n')}\n`;
      if (lines.length > 10) {
        outputSummary += `...\n后10行:\n${lines.slice(-10).join('\n')}\n`;
      }
      // 🔥 日志完整性提示
      if (lines.length >= 9000) {
        outputSummary += `\n⚠️ 注意：日志行数接近或超过云端日志服务上限（约10000行），早期轮次的日志可能已被截断。\n`;
        outputSummary += `如需完整日志，请查看 OSS 中的 full_log.txt 文件（如果训练脚本有保存）。\n`;
      }
    }

    const chartsCount = Array.isArray(task.charts_json) ? task.charts_json.length : 0;
    const filesCount = task.files_json && typeof task.files_json === 'object' ? Object.keys(task.files_json).length : 0;

    return {
      success: true,
      data: {
        type: 'taskDetail',
        taskId,
        task: {
          id: task.id,
          app_id: task.app_id,
          status: task.status,
          stdout_output: task.stdout_output,
          charts_json: task.charts_json,
          files_json: task.files_json,
          model_oss_url: task.model_oss_url,
          instance_type: task.instance_type,
          gpu_instance_id: task.gpu_instance_id,
          duration: task.duration,
          cost: task.cost,
          error_message: task.error_message,
          flag: task.flag,
          remark: task.remark,  // 🔥 训练备注
          created_at: task.created_at,
          updated_at: task.updated_at,
        },
        message: `任务状态: ${task.status}${task.flag ? ` | 标记: ${task.flag}` : ''}${task.remark ? ` | 备注: ${task.remark}` : ''}${outputSummary}\n\n📊 图表数量: ${chartsCount}\n📁 文件数量: ${filesCount}`,
      },
    };
  } catch (error) {
    console.error('[TASK-DETAIL] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取训练任务详情失败",
    };
  }
}

/**
 * 🔥 更新训练任务备注（训练阶段总结/评估备注）
 *
 * 让 LLM 或用户为训练任务添加备注，记录主要修改内容、训练结果等
 * 便于后续迭代时快速了解每次训练的重点和结论
 *
 * @param step - AutoStep，需要 taskId + remark 参数
 * @param _planId - 计划ID（未使用）
 * @returns 更新结果
 */
export async function executeUpdateTrainTaskRemarkTool(
  step: AutoStep,
  _planId: string,
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  const taskId = params?.taskId || params?.taskid || params?.task_id || params?.id;
  const remark = params?.remark || params?.note || params?.comment;

  if (!taskId) {
    return {
      success: false,
      error: "缺少 taskId 参数。用法: update_train_task_remark(taskId='xxx', remark='本次训练主要修改了kl离散度，loss从2.3降到1.8')",
    };
  }
  if (!remark || typeof remark !== 'string') {
    return {
      success: false,
      error: "缺少 remark 参数。用法: update_train_task_remark(taskId='xxx', remark='备注内容（最多200字）')",
    };
  }

  // 🔥 限制备注长度（200字）
  const trimmedRemark = remark.trim().slice(0, 200);

  try {
    const { trainingTaskStorage } = await import('@/services/storage');
    await trainingTaskStorage.update(taskId, { remark: trimmedRemark });

    console.log(`[UPDATE-REMARK] 任务 ${taskId} 备注已更新: ${trimmedRemark}`);

    return {
      success: true,
      data: {
        type: 'remarkUpdated',
        taskId,
        remark: trimmedRemark,
        message: `任务备注已更新: ${trimmedRemark}`,
      },
    };
  } catch (error) {
    console.error('[UPDATE-REMARK] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "更新训练备注失败",
    };
  }
}

/**
 * 🔥 停止 GPU 训练任务
 *
 * 调用后端 /api/codeexecution/stop 接口，停止云端 ECI 实例并更新任务状态
 *
 * @param step - AutoStep，需要 taskId 参数
 * @param _planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 停止结果
 */
export async function executeStopGpuTrainTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  // 🔥 提取 taskId（支持多种参数名）
  const taskId = params?.taskId || params?.taskid || params?.task_id || params?.id;
  // 🔥 提取停止原因（可选，用户手动 kill 时填写）
  const reason = params?.reason || '';

  if (!taskId) {
    return {
      success: false,
      error: "缺少 taskId 参数。用法: stop_gpu_train(taskId='xxx')。可以使用 list_tasks 先获取 taskId。",
    };
  }

  try {
    console.log(`[STOP-GPU-TRAIN] 停止训练任务: taskId=${taskId}`);

    // 🔥 先查询任务状态，只有 running/pending 的任务才能停止
    const { trainingTaskStorage } = await import('@/services/storage');
    const task = await trainingTaskStorage.getById(taskId);

    if (!task) {
      return {
        success: false,
        error: `训练任务不存在: ${taskId}`,
      };
    }

    // 🔥 检查任务状态
    if (task.status === 'success' || task.status === 'failed' || task.status === 'stopped') {
      return {
        success: false,
        error: `任务已完成（状态: ${task.status}），无需停止。`,
        data: {
          type: 'taskStatus',
          taskId,
          status: task.status,
        },
      };
    }

    // 🔥 通过 AppExecutionService 统一调用后端停止接口
    const { appExecutionService } = await import('./AppExecutionService');
    const result = await appExecutionService.stopGpuTask(taskId, task.app_id);

    if (result.success) {
      const reasonText = reason ? ` 原因: ${reason}` : '';
      return {
        success: true,
        data: {
          type: 'taskStopped',
          taskId,
          message: `训练任务已停止。云端实例已释放，不再计费。${reasonText}`,
        },
      };
    } else {
      return {
        success: false,
        error: result.error || '停止训练失败',
      };
    }
  } catch (error) {
    console.error('[STOP-GPU-TRAIN] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "停止训练任务失败",
    };
  }
}

/**
 * 🔥 upsert_project：创建项目 / 更新项目元信息（name、description）
 * - 带 projectId（支持 8 位短 ID）→ 更新模式，只改 name/description
 * - 不带 projectId → 创建模式
 * 项目 description 是 LLM 跨会话理解项目的唯一线索（list_projects 回传），值得单独维护
 */
// 🔥 GPU 训练代码规范提示：随 upsert_project 创建模式的返回下发给 LLM（约 130 字），
//    创建项目后正是 LLM 决定下一步的时机，先讲清规范可大幅减少训练代码返工
//    （产物不存 _OUTPUT_DIR / 不输出结果 JSON / 云端下载数据集走外网卡死，是最高频的三类错误）
const TRAIN_CODE_SPEC_HINT = `⚠️ GPU训练代码三规则：①产物（模型/图表）保存到系统注入的 _OUTPUT_DIR（用 os.path.join 拼路径，勿用相对路径）；②finally 中 print 一行 JSON：{"success":true,"output":"摘要","files":["_OUTPUT_DIR/best.pt"],"charts":["_OUTPUT_DIR/x.png"]}；③云端外网受限，数据集用 list_cloud_files 返回的内网地址下载；完整模板见 use_guide('GPU训练代码约束')`;

export async function executeUpsertProjectTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string; conversationId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  const userId = context?.userId;

  if (!userId) {
    return {
      success: false,
      error: "缺少 userId，无法操作项目",
    };
  }

  const projectId = params?.projectId || params?.appId || params?.id;

  // ---------- 更新模式 ----------
  if (projectId) {
    const resolved = { id: '' };
    const resolveError = await resolveProjectId(String(projectId), resolved, userId);
    if (resolveError) {
      return { success: false, error: resolveError };
    }

    // 🔥 基础项目保护：元信息（name/description）是系统资产，不允许 LLM 修改
    // 基础项目内的文件（README/工具等）可正常用 save_project_file/edit_project_file 修改
    if (resolved.id === BASE_PROJECT_ID) {
      return {
        success: false,
        error: "扩展工具项目（base-extensiontool）是系统项目，不允许修改其元信息（name/description）。如需增删工具或修改内容，请用 save_project_file/edit_project_file 操作项目内的文件。",
      };
    }

    const updates: { name?: string; description?: string } = {};
    const newName = params?.name || params?.projectName || params?.project_name;
    const newDesc = params?.description || params?.desc;
    if (newName) updates.name = String(newName);
    if (newDesc) updates.description = String(newDesc);

    if (!updates.name && !updates.description) {
      return {
        success: false,
        error: "更新项目需至少提供 name 或 description（projectId 只用于定位项目）",
      };
    }

    const updated = await desktopAppStorage.update(resolved.id, updates);
    if (!updated) {
      return { success: false, error: "项目不存在或更新失败" };
    }

    const u = updated as any;
    return {
      success: true,
      data: {
        type: 'projectUpdated',
        appId: resolved.id.substring(0, 8),
        name: u.name,
        description: u.description,
        message: `项目 "${u.name}" 元信息已更新`,
      },
    };
  }

  // ---------- 创建模式 ----------
  // 🔥 提取参数（支持多种参数名）
  const name = params?.name || params?.projectName || params?.project_name || `新应用 ${new Date().toLocaleTimeString()}`;
  const description = params?.description || params?.desc || '通过 LLM 工具创建的训练项目';

  try {
    console.log(`[CREATE-PROJECT] 创建项目: name="${name}", userId=${userId}`);

    // 🔥 与 QuickCreateApp / AppDatabaseService.createDesktopApp 逻辑一致
    const newApp = {
      id: uuidv4(),
      name,
      description,
      current_code: '',
      code: '',
      config: {},
      env_vars: {},
      preview: '',
      user_id: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const data = await desktopAppStorage.create(newApp);

    if (!data) {
      return {
        success: false,
        error: "创建项目失败：数据库返回空",
      };
    }

    const appId = (data as any).id || (data as any).appId;

    console.log(`[CREATE-PROJECT] 创建成功: appId=${appId}`);

    // 🔥 通知 UI 刷新（与 QuickCreateApp 一致）
    try {
      desktopAppEventService.emitAppCreated(appId, userId, data);
    } catch (e) {
      // 事件通知失败不影响主流程
    }

    return {
      success: true,
      data: {
        type: 'projectCreated',
        appId,
        name,
        description,
        message: `项目 "${name}" 创建成功。appId: ${appId}\n\n现在可以使用 save_project_file(appId='${appId}', filePath='main.py', content='...') 写入代码文件，然后用 run_project_oncloud(projectId='${appId}', instanceType='...') 在云端运行。\n\n${TRAIN_CODE_SPEC_HINT}`,
        nextSteps: {
          saveFile: `save_project_file(appId='${appId}', filePath='main.py', content='...')`,
          listFiles: `list_project_files(appId='${appId}')`,
          runTrain: `run_project_oncloud(projectId='${appId}', instanceType='...')`,
        },
      },
    };
  } catch (error) {
    console.error('[CREATE-PROJECT] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "创建训练项目失败",
    };
  }
}
