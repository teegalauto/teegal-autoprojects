/**
 * AppPathHelper - 应用路径解析工具
 * 
 * 统一管理应用文件路径的解析逻辑，支持导入项目（code_path）模式。
 * 
 * - code_path = NULL（默认）：文件在 userDataPath/apps/{appId}/ 下
 * - code_path = '/Users/xxx/my-project'：文件在用户指定的目录下
 * - history 始终在默认路径下，不受 code_path 影响
 */

import { desktopAppStorage } from '@/services/storage';

// ============================================================================
// 内存缓存
// ============================================================================

/** code_path 缓存：appId → code_path（null 表示使用默认路径） */
const codePathCache = new Map<string, string | null>();

/**
 * 清除指定 appId 的缓存（在 code_path 更新时调用）
 */
export function clearCodePathCache(appId: string): void {
  codePathCache.delete(appId);
}

// ============================================================================
// 基础路径工具
// ============================================================================

/**
 * 获取用户数据路径
 */
export async function getUserDataPath(): Promise<string> {
  const electron = (window as any).electron;
  
  if (electron?.getUserDataPath) {
    let userDataPath = await electron.getUserDataPath();
    if (userDataPath.endsWith('\\dev') || userDataPath.endsWith('/dev')) {
      userDataPath = userDataPath.slice(0, -4);
    }
    return userDataPath;
  }
  
  return process.cwd();
}

/** 单层目录穿透缓存：appId → 穿透后的真实内容根路径 */
const contentRootCache = new Map<string, string>();

/**
 * 🔥 单层目录自动穿透（git clone 场景）
 * clone 仓库时会在项目目录下套一层仓库名（apps/{id}/OpenMontage/...），
 * 而所有路径工具（read/save/edit/执行）都以 apps/{id} 为根拼相对路径 → 全部差一层。
 * 规则：项目根下只有一个子目录且没有任何文件时，自动下钻到该目录作为内容根。
 * 结果缓存，目录结构变化（极少）时重启即恢复。
 */
async function drillDownSingleChildDir(basePath: string): Promise<string> {
  const cached = contentRootCache.get(basePath);
  if (cached) return cached;

  const electron = (window as any).electron;
  try {
    if (electron?.readDirectory) {
      const result = await electron.readDirectory(basePath);
      if (result?.success && Array.isArray(result.data)) {
        const entries = result.data as Array<{ name: string; type?: string; isDirectory?: boolean }>;
        const dirs = entries.filter(e => e.type === 'directory' || e.isDirectory);
        const files = entries.filter(e => !(e.type === 'directory' || e.isDirectory));
        // 🔥 条件：恰好一个子目录 + 零个文件（clone 的典型特征；正常项目根都有文件，不会误穿透）
        if (dirs.length === 1 && files.length === 0) {
          const drilled = `${basePath}/${dirs[0].name}`.replace(/\\/g, '/');
          contentRootCache.set(basePath, drilled);
          console.log(`🔥 [AppPathHelper] 检测到 clone 套层结构，内容根穿透: ${basePath} → ${drilled}`);
          return drilled;
        }
      }
    }
  } catch (e) {
    // 读取失败按原路径处理
  }
  contentRootCache.set(basePath, basePath);
  return basePath;
}

/**
 * 获取 App 的基础路径（文件操作根目录）
 * 有 code_path 返回 code_path，否则返回默认的 userDataPath/apps/{appId}
 * 🔥 默认路径模式下做单层目录穿透（git clone 套层兼容）
 */
export async function getAppBasePath(appId: string): Promise<string> {
  const codePath = await getCodePath(appId);
  if (codePath) {
    return codePath;
  }
  const userDataPath = await getUserDataPath();
  const basePath = `${userDataPath}/apps/${appId}`;
  return drillDownSingleChildDir(basePath);
}

/**
 * 获取 App 的默认路径（不查 DB，用于 history 等固定位置）
 */
export async function getAppDefaultPath(appId: string): Promise<string> {
  const userDataPath = await getUserDataPath();
  return `${userDataPath}/apps/${appId}`;
}

/**
 * 🔥 项目内容根提示：穿透后的内容根相对项目默认根的子目录名（如 'chat-agent'）
 * - 无套层/外部 code_path 项目返回 ''（内容根即项目根）
 * - 供环境注入（重要对象段）附带显示，LLM 不用跑一轮 list_project_files 就能写对
 *   read/push 的相对路径前缀（git clone 套层场景的相对路径是 'chat-agent/src/api.ts' 而非 'src/api.ts'）
 */
export async function getProjectRootHint(appId: string): Promise<string> {
  try {
    if (await getCodePath(appId)) return '';
    const base = await getAppDefaultPath(appId);
    const root = await getAppBasePath(appId);
    return root.slice(base.length).replace(/^[\\/]/, '').replace(/[\\/]+$/, '');
  } catch {
    return '';
  }
}

/**
 * 获取 App 的 history 目录路径（始终在默认路径下）
 */
export async function getAppHistoryPath(appId: string): Promise<string> {
  const defaultPath = await getAppDefaultPath(appId);
  return `${defaultPath}/history`;
}

/**
 * 获取 code_path 值（用于传给 Electron IPC）
 * 返回 null 表示使用默认路径
 * 使用内存缓存避免频繁 DB 查询
 */
export async function getCodePath(appId: string): Promise<string | null> {
  // 先查缓存
  if (codePathCache.has(appId)) {
    return codePathCache.get(appId)!;
  }

  try {
    const app = await desktopAppStorage.getById(appId);
    const codePath = app?.code_path || null;
    codePathCache.set(appId, codePath);
    return codePath;
  } catch (e) {
    // 🔥 查询失败时不缓存 null：后端未就绪时返回的空值会被缓存住，
    // 之后即使后端就绪也一直读到 null（导入绑定"消失"的元凶之一）。
    // 缓存 miss 让下次调用重查 DB。
    if (codePathCache.has(appId)) {
      codePathCache.delete(appId);
    }
    return null;
  }
}

/**
 * 🔥 写入 code_path 并回读校验（导入/取消导入专用）
 * update 走的 IPC 链路每层都吞错（失败返回 null 不抛出），
 * 不校验的话 UI 会显示"已导入"但 DB 里根本没写进去。
 * 返回 true = DB 确认写入成功；false = 写入失败。
 */
export async function setCodePathVerified(appId: string, codePath: string | null): Promise<boolean> {
  try {
    await desktopAppStorage.update(appId, { code_path: codePath ?? null });
    clearCodePathCache(appId);
    // 🔥 回读校验：确认 DB 真的写入了
    const app = await desktopAppStorage.getById(appId);
    const saved = app?.code_path ?? null;
    const ok = (saved ?? null) === (codePath ?? null);
    if (!ok) {
      console.error(`[AppPathHelper] code_path 写入校验失败: 期望=${codePath} 实际=${saved}`);
    }
    // 无论成败都刷新缓存为 DB 真实值，避免脏缓存
    codePathCache.set(appId, saved);
    return ok;
  } catch (e) {
    console.error('[AppPathHelper] setCodePathVerified 异常:', e);
    return false;
  }
}
