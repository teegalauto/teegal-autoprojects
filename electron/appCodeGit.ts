/**
 * App 代码目录 git 快照（isomorphic-git，纯 JS 实现，无需系统安装 git）
 *
 * 🔥 设计（业界通用模式：Cline/Cursor 的影子 git，Aider 的直接 git）：
 * - 「接受修改」 = snapshotApp/snapshotFile：工作区变更 → 过滤后 add + commit（checkpoint）
 * - 「变更列表」 = listChanges：相对 HEAD 的变更文件（statusMatrix，ChangeList 数据源）
 * - 「旧版本」   = getHeadFileContent：文件在最近一次 checkpoint 的内容（diff/回退用）
 * - 「版本历史」 = listCheckpoints：git log 时间线（可往上追任意版本）
 * - 「回滚」     = restoreTo：分支指针强移 + 工作区重置（等价 reset --hard）
 *
 * 过滤：媒体/大文件/依赖目录不进库（LLM 不改媒体素材，二进制无 delta 价值，
 * 进库只会让对象库膨胀）——漏掉的文本文件下次 checkpoint 自动补上。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as git from 'isomorphic-git';
import ignore from 'ignore';

/** 🔥 项目级忽略：根 .gitignore 语义解析 + 内置兜底名单合并（checkpoint 与变更追踪共用） */
function loadProjectIgnores(dir: string): ReturnType<typeof ignore> {
  const ig = ignore();
  // 内置兜底（项目没写 .gitignore 或写漏时仍然有效）
  ig.add([
    'node_modules/', '.git/', '.teegal/', '.bbone-tagalong/', 'history/',
    'dist*/', 'build*/', 'out/', 'release/', 'logs/', 'tmp/', 'temp/', 'data/',
    'media/', // manim 等渲染管线的标准产物目录（media/videos/、media/texts/...）
    '__pycache__/', '.venv/', 'venv/', '.next/', '.nuxt/', '.cache/',
    '.pytest_cache/', '.mypy_cache/', 'wandb/', 'runs/', 'checkpoints/',
    '*.log', '*.tsbuildinfo', '*.pak', '*.asar', '*.exe', '*.dll',
    '.env*', '.ds_store', 'thumbs.db',
  ]);
  try {
    ig.add(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'));
  } catch { /* 无 .gitignore 用兜底 */ }
  return ig;
}

const AUTHOR = { name: 'Teegal', email: 'teegal@local' };
const BRANCH = 'main';

/** 🔥 Teegal checkpoint 独立 git 目录：绝不复用项目已有 .git（防 checkpoint 混入用户版本历史） */
function gitDir(dir: string): string {
  return path.join(dir, '.teegal', 'appgit');
}

/** 不纳入快照的目录（依赖/构建产物/运行时缓存） */
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'release', '__pycache__', '.pytest_cache',
  'venv', '.venv', 'env', '.git', 'history', '.teegal', '.bbone-tagalong',
  'tmp', 'temp', 'data', 'logs', 'media',
]);

/** 文件名黑名单（敏感/运行时噪音，无论扩展名） */
const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db']);
const IGNORED_FILE_PREFIXES = ['.env'];

function isIgnoredFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_FILES.has(lower) || IGNORED_FILE_PREFIXES.some((pre) => lower.startsWith(pre));
}

/** 目录名前缀黑名单（dist 家族：dist / dist-server / dist-electron / ...） */
const IGNORED_DIR_PREFIXES = ['dist'];

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name) || IGNORED_DIR_PREFIXES.some((pre) => name.toLowerCase().startsWith(pre));
}

/** 不纳入快照的扩展（媒体/二进制/模型权重） */
const IGNORED_EXT = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
  '.psd', '.ai', '.sketch', '.fig', '.prproj', '.aep', '.drp', '.blend',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj',
  '.pak', '.asar', '.log', '.tsbuildinfo',
  '.pth', '.onnx', '.safetensors', '.ckpt', '.pt', '.pb', '.h5', '.npz', '.npy',
  '.db', '.sqlite', '.sqlite3',
]);

/** 单文件大小上限（字节） */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** 递归展开 HEAD 树 → { filepath: blobOid }（空仓返回空 Map） */
async function headTreeMap(dir: string, ig?: ReturnType<typeof ignore>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const commits = await git.log({ fs, dir, gitdir: gitDir(dir), depth: 1 });
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      const tree = await git.readTree({ fs, dir, gitdir: gitDir(dir), oid: treeOid });
      for (const e of tree.tree) {
        const p = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type === 'tree') {
          if (isIgnoredDir(e.path) || (ig && ig.ignores(`${p}/`))) continue;
          await walk(e.oid, p);
        } else if (e.type === 'blob') {
          if (isIgnoredFileName(e.path) || IGNORED_EXT.has(path.extname(e.path).toLowerCase())) continue;
          if (ig && ig.ignores(p)) continue;
          result.set(p, e.oid);
        }
      }
    };
    await walk(commits[0].commit.tree, '');
  } catch {
    // 空仓（无 commit）
  }
  return result;
}

/** 递归收集工作区可跟踪文件路径（忽略目录不进入，忽略扩展/大文件跳过） */
async function listWorkdirFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const full = rel ? path.join(dir, rel) : dir;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnoredDir(e.name)) continue;
        await walk(p);
      } else if (e.isFile()) {
        if (isIgnoredFileName(e.name)) continue;
        if (IGNORED_EXT.has(path.extname(e.name).toLowerCase())) continue;
        try {
          if (fs.statSync(path.join(dir, p)).size > MAX_FILE_BYTES) continue;
        } catch { continue; }
        files.push(p);
      }
    }
  };
  await walk('');
  return files;
}

/**
 * 工作区文件 → { filepath: blobOid }（hash 级对比用）。
 * ⚠️ 不用 statusMatrix：其内部按秒级 mtime 做 stat 缓存（racy-git），同秒内同尺寸
 * 改写会漏检——LLM 快速连续写文件的场景会真实踩中。这里自扫目录 + hashBlob，
 * 忽略目录不递归进入（比 statusMatrix 全树遍历快）。
 */
async function workdirOids(dir: string, ig: ReturnType<typeof ignore>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const p of await listWorkdirFiles(dir)) {
    if (ig.ignores(p)) continue;
    try {
      const content = await fs.promises.readFile(path.join(dir, p));
      const { oid } = await git.hashBlob({ object: new Uint8Array(content) });
      result.set(p, oid);
    } catch { /* 读取失败跳过 */ }
  }
  return result;
}

/** 原始变更计算（不做 ensureRepo，供 ensureRepo 基线提交复用，避免递归） */
async function computeChanges(dir: string): Promise<AppFileChange[]> {
  const ig = loadProjectIgnores(dir);
  const head = await headTreeMap(dir, ig);
  const work = await workdirOids(dir, ig);
  const changes: AppFileChange[] = [];
  for (const [p, oid] of work) {
    const headOid = head.get(p);
    if (!headOid) changes.push({ fileName: p, changeType: 'added' });
    else if (headOid !== oid) changes.push({ fileName: p, changeType: 'modified' });
  }
  for (const p of head.keys()) {
    if (!work.has(p)) changes.push({ fileName: p, changeType: 'deleted' });
  }
  return changes;
}

/** 相对 HEAD 的变更文件列表（hash 级对比，供变更记录面板渲染） */
export interface AppFileChange {
  fileName: string; // 相对 appDir 的路径（正斜杠）
  changeType: 'added' | 'modified' | 'deleted';
}

export async function listChanges(dir: string): Promise<AppFileChange[]> {
  await ensureRepo(dir);
  return computeChanges(dir);
}

/** 用户真实 git 仓库的 gitdir（与 Teegal checkpoint 库完全独立） */
function externalGitDir(dir: string): string {
  return path.join(dir, '.git');
}

/** 读外部 git 某提交的树 → { filepath: blobOid }（与 headTreeMap 同款过滤；读不到返回空 Map） */
async function externalTreeMap(dir: string, commitOid: string, ig: ReturnType<typeof ignore>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const { commit } = await git.readCommit({ fs, dir, gitdir: externalGitDir(dir), oid: commitOid });
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      const tree = await git.readTree({ fs, dir, gitdir: externalGitDir(dir), oid: treeOid });
      for (const e of tree.tree) {
        const p = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type === 'tree') {
          if (isIgnoredDir(e.path) || ig.ignores(`${p}/`)) continue;
          await walk(e.oid, p);
        } else if (e.type === 'blob') {
          if (isIgnoredFileName(e.path) || IGNORED_EXT.has(path.extname(e.path).toLowerCase())) continue;
          if (ig.ignores(p)) continue;
          result.set(p, e.oid);
        }
      }
    };
    await walk(commit.tree, '');
  } catch { /* 无 .git / 对象缺失 → 空 */ }
  return result;
}

/**
 * 外部 git 提交自动补账：用户在自己的 .git 提交后，同一批文件在变更面板里
 * 仍被列为待确认（两本账的缝隙）。这里检测外部 HEAD 变动，把本次外部提交
 * 涉及的文件自动 checkpoint 进 Teegal 库（精确模式：agent 未审改动不受影响）。
 * 基线存 .teegal/appgit/external-head；首次缺失只记录基线不补账（防升级后整树吞入）。
 */
export async function syncExternalCommits(dir: string): Promise<string[]> {
  const headFile = path.join(gitDir(dir), 'external-head');
  let extOid = '';
  try {
    extOid = await git.resolveRef({ fs, dir, gitdir: externalGitDir(dir), ref: 'HEAD' });
  } catch { return []; } // 无外部 git / 无提交
  let lastSeen = '';
  try { lastSeen = stripBom(fs.readFileSync(headFile, 'utf8')).trim(); } catch { /* 首次 */ }
  if (!lastSeen || lastSeen === extOid) {
    if (!lastSeen) {
      try {
        fs.mkdirSync(gitDir(dir), { recursive: true });
        fs.writeFileSync(headFile, extOid); // 首次只记基线
      } catch { /* 忽略 */ }
    }
    return [];
  }

  const ig = loadProjectIgnores(dir);
  const [oldTree, newTree] = await Promise.all([
    externalTreeMap(dir, lastSeen, ig),
    externalTreeMap(dir, extOid, ig),
  ]);
  if (oldTree.size === 0 && newTree.size > 0) {
    try { fs.writeFileSync(headFile, extOid); } catch { /* 忽略 */ }
    return []; // 旧基线读不到（GC/重克隆）→ 算不出增量，只推进基线
  }

  const changed: AppFileChange[] = [];
  for (const [p, oid] of newTree) {
    const prev = oldTree.get(p);
    if (prev !== oid) changed.push({ fileName: p, changeType: prev ? 'modified' : 'added' });
  }
  for (const p of oldTree.keys()) {
    if (!newTree.has(p)) changed.push({ fileName: p, changeType: 'deleted' });
  }
  if (changed.length === 0) {
    try { fs.writeFileSync(headFile, extOid); } catch { /* 忽略 */ }
    return [];
  }

  await ensureRepo(dir);
  const synced: string[] = [];
  for (const c of changed) {
    try {
      if (c.changeType === 'deleted') {
        await git.remove({ fs, dir, gitdir: gitDir(dir), filepath: c.fileName });
      } else {
        await git.add({ fs, dir, gitdir: gitDir(dir), filepath: c.fileName }); // 读工作区当前内容
      }
      synced.push(c.fileName);
    } catch (e: any) {
      console.warn('⚠️ [APP-GIT] 外部补账跳过文件:', c.fileName, e.message);
    }
  }
  if (synced.length > 0) {
    const oid = await git.commit({ fs, dir, gitdir: gitDir(dir), message: `外部 git 提交自动确认 ${extOid.slice(0, 7)}`, author: AUTHOR });
    console.log(`✅ [APP-GIT] 外部 git 提交自动补账 ${synced.length} 个文件:`, oid.slice(0, 7));
  }
  try { fs.writeFileSync(headFile, extOid); } catch { /* 忽略 */ }
  return synced;
}

/** 扫描工作区变更 → 暂存（add/remove）。返回是否有变更（原始层，不做 ensureRepo） */
async function stageAll(dir: string): Promise<boolean> {
  const changes = await computeChanges(dir);
  for (const c of changes) {
    try {
      if (c.changeType === 'deleted') {
        await git.remove({ fs, dir, gitdir: gitDir(dir), filepath: c.fileName });
      } else {
        await git.add({ fs, dir, gitdir: gitDir(dir), filepath: c.fileName });
      }
    } catch (e: any) {
      console.warn('⚠️ [APP-GIT] 处理文件失败（跳过）:', c.fileName, e.message);
    }
  }
  return changes.length > 0;
}

/** 确保目录是 git 仓库且有基线 checkpoint（空仓 → 提交当前全量文件为「初始版本」） */
export async function ensureRepo(dir: string): Promise<void> {
  if (!fs.existsSync(path.join(gitDir(dir), 'HEAD'))) {
    fs.mkdirSync(gitDir(dir), { recursive: true });
    await git.init({ fs, dir, gitdir: gitDir(dir), defaultBranch: BRANCH });
    console.log('✅ [APP-GIT] 初始化仓库:', dir);
  }
  try {
    await git.log({ fs, dir, gitdir: gitDir(dir), depth: 1 });
  } catch {
    // 空仓库 → 把当前工作区提交为「初始版本」基线（后续变更相对它计算）。
    // ⚠️ 不能调 snapshotApp（其内部调 ensureRepo 会无限递归）
    try {
      await stageAll(dir);
      const oid = await git.commit({ fs, dir, gitdir: gitDir(dir), message: '初始版本', author: AUTHOR });
      console.log('✅ [APP-GIT] 初始基线 checkpoint:', oid.slice(0, 7));
    } catch (e: any) {
      console.warn('⚠️ [APP-GIT] 初始基线提交失败:', e.message);
    }
  }
}

/** 工作区变更 → 过滤 → add/remove → commit（无变更则跳过） */
export async function snapshotApp(dir: string, message: string): Promise<{ committed: boolean; oid: string }> {
  await ensureRepo(dir);
  const changed = await stageAll(dir);
  if (!changed) {
    return { committed: false, oid: '' };
  }
  const oid = await git.commit({ fs, dir, gitdir: gitDir(dir), message, author: AUTHOR });
  console.log('✅ [APP-GIT] checkpoint:', message, oid.slice(0, 7));
  return { committed: true, oid };
}

/** 单文件 checkpoint（接受单个文件：add/remove 该文件后 commit，hash 级判重） */
export async function snapshotFile(dir: string, relPath: string, message: string): Promise<{ committed: boolean; oid: string }> {
  await ensureRepo(dir);
  const normalized = relPath.replace(/\\/g, '/');
  // 过滤规则与全量快照一致
  if (normalized.split('/').some(p => IGNORED_DIRS.has(p))) return { committed: false, oid: '' };
  if (IGNORED_EXT.has(path.extname(normalized).toLowerCase())) return { committed: false, oid: '' };
  const full = path.join(dir, normalized);
  if (fs.existsSync(full) && fs.statSync(full).size > MAX_FILE_BYTES) return { committed: false, oid: '' };

  const headOid = (await headTreeMap(dir)).get(normalized);
  if (!fs.existsSync(full)) {
    if (!headOid) return { committed: false, oid: '' }; // 两边都不存在，无事可做
    await git.remove({ fs, dir, gitdir: gitDir(dir), filepath: normalized }); // 工作区已删除 → 提交删除
  } else {
    const content = await fs.promises.readFile(full);
    const { oid } = await git.hashBlob({ object: new Uint8Array(content) });
    if (headOid === oid) return { committed: false, oid: '' }; // 与 HEAD 一致，无需提交
    await git.add({ fs, dir, gitdir: gitDir(dir), filepath: normalized });
  }
  const oid = await git.commit({ fs, dir, gitdir: gitDir(dir), message, author: AUTHOR });
  console.log('✅ [APP-GIT] checkpoint(单文件):', message, oid.slice(0, 7));
  return { committed: true, oid };
}

/** 读文件在 HEAD（最近一次 checkpoint）中的内容（变更对比/回退用；新文件无提交版本返回 null） */
export async function getHeadFileContent(dir: string, relPath: string): Promise<string | null> {
  await ensureRepo(dir);
  const normalized = relPath.replace(/\\/g, '/');
  try {
    const commits = await git.log({ fs, dir, gitdir: gitDir(dir), filepath: normalized, depth: 1 });
    if (commits.length === 0) return null; // HEAD 中不存在此文件（新文件）
    const blob = await git.readBlob({ fs, dir, gitdir: gitDir(dir), oid: commits[0].oid, filepath: normalized });
    return stripBom(Buffer.from(blob.blob).toString('utf-8'));
  } catch {
    return null;
  }
}

/** checkpoint 时间线（新→旧）；oid 为完整哈希（UI 显示时自行截短，回滚时用完整值稳妥） */
export interface CheckpointInfo {
  oid: string;
  message: string;
  timestamp: number; // 毫秒
}

export async function listCheckpoints(dir: string, limit: number = 50): Promise<CheckpointInfo[]> {
  await ensureRepo(dir);
  const commits = await git.log({ fs, dir, gitdir: gitDir(dir), depth: limit });
  return commits.map(c => ({
    oid: c.oid,
    message: (c.commit.message || '').trim().split('\n')[0],
    timestamp: c.commit.author.timestamp * 1000,
  }));
}

/** 读指定 checkpoint 中某文件的内容（只读查看，不影响工作区） */
export async function getFileAt(dir: string, oid: string, relPath: string): Promise<string | null> {
  await ensureRepo(dir);
  try {
    const blob = await git.readBlob({ fs, dir, gitdir: gitDir(dir), oid, filepath: relPath.replace(/\\/g, '/') });
    return stripBom(Buffer.from(blob.blob).toString('utf-8'));
  } catch {
    return null; // 该 checkpoint 中不存在此文件
  }
}

/** 回滚整个项目到指定 checkpoint（分支指针强移 + 工作区重置，等价 reset --hard） */
export async function restoreTo(dir: string, oid: string): Promise<void> {
  await ensureRepo(dir);
  // 回滚前工作区中可跟踪的文件（用于清理目标版本中不存在的文件）
  const workBefore = await listWorkdirFiles(dir);

  // 先把工作区检出到目标版本（force 覆盖已跟踪文件）
  await git.checkout({ fs, dir, gitdir: gitDir(dir), ref: oid, force: true });
  // HEAD 此时 detached，把 main 指回目标版本并检回 main（后续 checkpoint 落在 main 上）
  await git.branch({ fs, dir, gitdir: gitDir(dir), ref: BRANCH, object: oid, force: true, checkout: true });

  // 清理目标版本中不存在的文件（已接受过的后继版本文件 + 未接受的新文件）。
  // 媒体等不可跟踪文件不在 workBefore 中，不会被误删。
  for (const fp of workBefore) {
    try {
      await git.readBlob({ fs, dir, gitdir: gitDir(dir), oid, filepath: fp }); // 目标版本存在 → 保留
    } catch {
      try {
        const full = path.join(dir, fp);
        if (fs.existsSync(full)) await fs.promises.unlink(full); // ⚠️ promises 版：同步 unlinkSync 在 Electron 40 上对中文路径会原生崩溃
      } catch { /* 删除失败忽略 */ }
    }
  }
  console.log('✅ [APP-GIT] 已回滚到:', oid.slice(0, 7));
}
