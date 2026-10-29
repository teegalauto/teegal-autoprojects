/**
 * Desktop App DAO - 桌面应用数据访问层
 */

import { localDatabase } from '../database';
import { DesktopApp } from '../types';
import path from 'path';
import fs from 'fs';

/**
 * 🔥 基础项目固定 ID：本地库按用户隔离，固定 ID 让 LLM 无需知道 userId 即可直接引用
 * 命名带用途（extensiontool），后续新增其他类型基础项目（如 base-xxx）不会冲突
 */
export const BASE_PROJECT_ID = 'base-extensiontool';

/**
 * 🔥 BootCode 基础项目固定 ID：存放 Teegal 开源源码（fork 自 teegal-autoprojects）
 * 与扩展工具项目（base-extensiontool）同为 system_base，按 ID 前缀互相区分
 */
export const BOOT_PROJECT_ID = 'base-bootcode';
const BOOT_PROJECT_PREFIX = BOOT_PROJECT_ID + '%'; // SQL LIKE 用

/**
 * 🔥 判断是否基础项目 ID（多账号兼容）
 * 首个账号沿用固定 ID base-extensiontool；后续账号为 base-extensiontool-{userId}
 * （本地库是同一 SQLite 文件，多平台账号共用，基础项目必须按 user_id 归属隔离）
 */
export function isBaseProjectId(id: string): boolean {
  return id === BASE_PROJECT_ID || id.startsWith(BASE_PROJECT_ID + '-');
}

/**
 * 🔥 迁移基础项目：DB id 更新 + 磁盘 apps 目录同步重命名
 * （文件在 {userDataPath}/apps/{appId}/ 下，只改 DB 不搬目录会导致已种文件"丢失"）
 */
function migrateBaseProjectDir(oldId: string, targetId: string = BASE_PROJECT_ID): void {
  // apps 根目录 = USER_DATA_DIR/apps（与前端 AppPathHelper 的 getUserDataPath 一致）
  const appsRoot = process.env.USER_DATA_DIR
    ? path.join(process.env.USER_DATA_DIR, 'apps')
    : null;
  if (!appsRoot) return;
  const oldDir = path.join(appsRoot, oldId);
  const newDir = path.join(appsRoot, targetId);
  try {
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      console.log(`[DesktopAppDAO] 基础项目目录已迁移: ${oldDir} → ${newDir}`);
    }
  } catch (e) {
    console.warn(`[DesktopAppDAO] 基础项目目录迁移失败（文件将走种子重建）:`, e);
  }
}

export class DesktopAppDAO {
  /**
   * 创建新应用
   */
  create(app: Omit<DesktopApp, 'created_at' | 'updated_at'>): DesktopApp {
    const db = localDatabase.getDb();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO desktop_apps (
        id, name, description, code, config, preview, user_id,
        current_code, previous_code, env_vars,
        definition, interface_spec, market_status, model_visualization,
        code_path, app_type, project_type,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      app.id,
      app.name,
      app.description || null,
      app.code,
      JSON.stringify(app.config || {}),
      app.preview || null,
      app.user_id,
      app.current_code || null,
      app.previous_code || null,
      JSON.stringify(app.env_vars || {}),
      app.definition || null,
      app.interface_spec || null,
      app.market_status || 'local',
      app.model_visualization || null,
      app.code_path || null,
      app.app_type || 'normal',
      app.project_type || null,
      now,
      now
    );

    return {
      ...app,
      app_type: app.app_type || 'normal',
      project_type: app.project_type || null,
      created_at: now,
      updated_at: now
    };
  }

  /**
   * 根据 ID 获取应用
   */
  getById(id: string): DesktopApp | null {
    const db = localDatabase.getDb();
    const stmt = db.prepare('SELECT * FROM desktop_apps WHERE id = ?');
    const row = stmt.get(id) as any;

    if (!row) return null;

    return this.parseAppRow(row);
  }

  /**
   * 获取用户的所有应用
   * 🔥 默认：纯更新时间排序（活跃度优先，UI 展示）
   * 🔥 baseFirst=true：基础项目（system_base）置顶（仅供 LLM 的 list_projects 工具，
   *    防止项目太多时基础项目被淹没在 100 条限制外，LLM 看不到）
   * 🔥 指定 appType（'normal' | 'system_base'）：按类型过滤 + 纯更新时间排序（UI 筛选用）
   */
  getByUserId(userId: string, limit = 100, offset = 0, appType?: 'normal' | 'system_base', baseFirst?: boolean): DesktopApp[] {
    const db = localDatabase.getDb();

    if (appType) {
      const stmt = db.prepare(`
        SELECT * FROM desktop_apps
        WHERE user_id = ? AND app_type = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(userId, appType, limit, offset) as any[];
      return rows.map(row => this.parseAppRow(row));
    }

    if (baseFirst) {
      const stmt = db.prepare(`
        SELECT * FROM desktop_apps
        WHERE user_id = ?
        ORDER BY CASE WHEN app_type = 'system_base' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(userId, limit, offset) as any[];
      return rows.map(row => this.parseAppRow(row));
    }

    const stmt = db.prepare(`
      SELECT * FROM desktop_apps
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(userId, limit, offset) as any[];

    return rows.map(row => this.parseAppRow(row));
  }

  /**
   * 更新应用
   */
  update(id: string, updates: Partial<Omit<DesktopApp, 'id' | 'created_at'>>): DesktopApp | null {
    const db = localDatabase.getDb();
    const now = Date.now();

    // 🔥 基础项目：name 由系统定义，外部（含 LLM）不可修改；改名迁移走 ensureBaseProject 内部 SQL
    const current = this.getById(id);
    if (current?.app_type === 'system_base' && updates.name !== undefined) {
      delete updates.name;
    }

    // 构建动态更新语句
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.code !== undefined) {
      fields.push('code = ?');
      values.push(updates.code);
    }
    if (updates.config !== undefined) {
      fields.push('config = ?');
      values.push(JSON.stringify(updates.config));
    }
    if (updates.preview !== undefined) {
      fields.push('preview = ?');
      values.push(updates.preview);
    }
    if (updates.current_code !== undefined) {
      fields.push('current_code = ?');
      values.push(updates.current_code);
    }
    if (updates.previous_code !== undefined) {
      fields.push('previous_code = ?');
      values.push(updates.previous_code);
    }
    if (updates.env_vars !== undefined) {
      fields.push('env_vars = ?');
      values.push(JSON.stringify(updates.env_vars));
    }
    // 🔥 App 市场相关字段
    if (updates.definition !== undefined) {
      fields.push('definition = ?');
      values.push(updates.definition);
    }
    if (updates.interface_spec !== undefined) {
      fields.push('interface_spec = ?');
      values.push(updates.interface_spec);
    }
    if (updates.market_status !== undefined) {
      fields.push('market_status = ?');
      values.push(updates.market_status);
    }
    if (updates.model_visualization !== undefined) {
      fields.push('model_visualization = ?');
      values.push(updates.model_visualization);
    }
    if (updates.code_path !== undefined) {
      fields.push('code_path = ?');
      values.push(updates.code_path);
    }
    // 🔥 项目类型（通常不修改，但保留更新能力）
    if (updates.app_type !== undefined) {
      fields.push('app_type = ?');
      values.push(updates.app_type);
    }
    // 🔥 项目场景类型（upsert_project 的 type 参数：training/inference/shortfilm/agent/general）
    if (updates.project_type !== undefined) {
      fields.push('project_type = ?');
      values.push(updates.project_type);
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = db.prepare(`
      UPDATE desktop_apps 
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    const result = stmt.run(...values);

    if (result.changes === 0) {
      return null;
    }

    return this.getById(id);
  }

  /**
   * 删除应用
   * 🔥 基础项目（system_base）不可删除
   */
  delete(id: string): boolean {
    const db = localDatabase.getDb();
    // 先查项目类型，基础项目拒绝删除
    const app = this.getById(id);
    if (app?.app_type === 'system_base') {
      console.warn(`[DesktopAppDAO] 基础项目 ${id} 不可删除`);
      return false;
    }
    const stmt = db.prepare('DELETE FROM desktop_apps WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * 解析数据库行
   */
  private parseAppRow(row: any): DesktopApp {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      code: row.code,
      config: JSON.parse(row.config || '{}'),
      preview: row.preview,
      user_id: row.user_id,
      current_code: row.current_code,
      previous_code: row.previous_code,
      env_vars: JSON.parse(row.env_vars || '{}'),
      // 🔥 App 市场相关字段
      definition: row.definition,
      interface_spec: row.interface_spec,
      market_status: row.market_status || 'local',
      // 🔥 模型可视化数据
      model_visualization: row.model_visualization,
      // 🔥 导入项目：自定义代码路径
      code_path: row.code_path || null,
      // 🔥 项目类型
      app_type: row.app_type || 'normal',
      // 🔥 项目场景类型
      project_type: row.project_type || null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  /**
   * 🔥 查历史遗留的扩展工具基础项目（app_type=system_base 且 ID 非标准格式）
   * 仅用于一次性迁移（base-{userId} / base-project → base-extensiontool），新代码勿调用
   */
  private getLegacyBaseProject(userId: string): DesktopApp | null {
    const db = localDatabase.getDb();
    const stmt = db.prepare(`
      SELECT * FROM desktop_apps
      WHERE user_id = ? AND app_type = 'system_base' AND id != ? AND id NOT LIKE ?
      LIMIT 1
    `);
    const row = stmt.get(userId, BASE_PROJECT_ID, BOOT_PROJECT_PREFIX) as any;
    if (!row) return null;
    return this.parseAppRow(row);
  }

  /**
   * 🔥 通用：创建系统项目（app_type=system_base）
   * 每个用途的 base 项目用各自的固定 ID，按 ID 查询/创建，互不干扰
   * 新增其他 base 项目（如 base-xxx）时调用本方法即可
   */
  createSystemProject(projectId: string, userId: string, name: string, description: string, code: string): DesktopApp {
    const existing = this.getById(projectId);
    if (existing) return existing;

    const now = Date.now();
    const db = localDatabase.getDb();
    db.prepare(`
      INSERT INTO desktop_apps (
        id, name, description, code, config, preview, user_id,
        current_code, previous_code, env_vars,
        definition, interface_spec, market_status, model_visualization,
        code_path, app_type,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      name,
      description,
      code,
      JSON.stringify({}),
      null,
      userId,
      null,
      null,
      JSON.stringify({}),
      null,
      null,
      'local',
      null,
      null,
      'system_base',
      now,
      now
    );
    console.log(`[DesktopAppDAO] 已为用户 ${userId} 创建系统项目 ${projectId}`);
    return this.getById(projectId)!;
  }

  /**
   * 🔥 确保扩展工具基础项目存在（不存在则创建，含历史 ID 迁移）
   * 🔥 按 user_id 归属隔离：本地库是同一 SQLite 文件，多平台账号共用，
   *    旧实现按固定 ID 查导致 B 账号复用 A 账号的项目（UI 按 user_id 过滤后看不到，工具却加载了）
   * 现规则：每个用户一个基础项目——首账号沿用固定 ID（兼容老数据），后登录账号为 base-extensiontool-{userId}
   * 文件初始化由前端 BaseProjectToolLoader 负责。
   */
  /**
   * 🔥 查找用户自己的基础项目（含 legacy 兼容），无则返回 null
   * 供 ensure 接口判断"本次是否新建"，前端据此广播 app_created 实时刷新项目列表
   */
  findUserBaseProject(userId: string): DesktopApp | null {
    const db = localDatabase.getDb();
    const mine = db.prepare(`
      SELECT * FROM desktop_apps
      WHERE user_id = ? AND (app_type = 'system_base' OR id = ?) AND id NOT LIKE ?
      LIMIT 1
    `).get(userId, BASE_PROJECT_ID, BOOT_PROJECT_PREFIX) as any;
    if (mine) return this.parseAppRow(mine);
    return this.getLegacyBaseProject(userId);
  }

  ensureBaseProject(userId: string): DesktopApp {
    const db = localDatabase.getDb();

    // 1. 🔥 按归属查当前用户自己的基础项目
    //    （兼容老数据：更早的 base 项目 app_type 可能未标 system_base，用 id=固定ID 兜住）
    //    🔥 排除 BootCode 项目（同为 system_base，按 ID 前缀互斥）
    const mine = db.prepare(`
      SELECT * FROM desktop_apps
      WHERE user_id = ? AND (app_type = 'system_base' OR id = ?) AND id NOT LIKE ?
      LIMIT 1
    `).get(userId, BASE_PROJECT_ID, BOOT_PROJECT_PREFIX) as any;
    if (mine) {
      const app = this.parseAppRow(mine);
      if (app.name === '基础项目') {
        db.prepare(`UPDATE desktop_apps SET name = '扩展工具', updated_at = ? WHERE id = ?`).run(Date.now(), app.id);
        return this.getById(app.id)!;
      }
      return app;
    }

    // 2. 本用户可用的基础项目 ID：固定 ID 未被其他账号占用则沿用，被占用则带 userId 后缀
    const fixedTaken = !!this.getById(BASE_PROJECT_ID);
    const projectId = fixedTaken ? `${BASE_PROJECT_ID}-${userId}` : BASE_PROJECT_ID;

    // 3. 历史迁移：该用户自己的 legacy（base-{userId}/base-project）→ projectId（含磁盘目录搬移）
    const legacy = this.getLegacyBaseProject(userId);
    if (legacy) {
      migrateBaseProjectDir(legacy.id, projectId);
      db.prepare(`UPDATE desktop_apps SET id = ?, user_id = ? WHERE id = ?`).run(projectId, userId, legacy.id);
      console.log(`[DesktopAppDAO] 扩展工具项目 ID 已迁移: ${legacy.id} → ${projectId}`);
      const migrated = this.getById(projectId)!;
      if (migrated.name === '基础项目') {
        db.prepare(`UPDATE desktop_apps SET name = '扩展工具', updated_at = ? WHERE id = ?`).run(Date.now(), projectId);
        return this.getById(projectId)!;
      }
      return migrated;
    }

    // 4. 全新创建
    return this.createSystemProject(
      projectId,
      userId,
      '扩展工具',
      '系统扩展工具项目，存放 LLM 动态注册的工具。不可删除，可修改工具文件。',
      '# 扩展工具\n\n此项目存放动态注册的工具。在 tools/registry.json 中登记工具，对应 .js 文件为工具执行体。'
    );
  }

  /**
   * 🔥 查找用户自己的 BootCode 项目（base-bootcode / base-bootcode-{userId}），无则返回 null
   * 按 ID 前缀区分（与扩展工具项目同为 system_base，app_type 无法区分两者）
   */
  findUserBootProject(userId: string): DesktopApp | null {
    const db = localDatabase.getDb();
    const mine = db.prepare(`
      SELECT * FROM desktop_apps
      WHERE user_id = ? AND (id = ? OR id LIKE ?)
      LIMIT 1
    `).get(userId, BOOT_PROJECT_ID, BOOT_PROJECT_PREFIX) as any;
    if (mine) return this.parseAppRow(mine);
    return null;
  }

  /**
   * 🔥 确保 BootCode 项目存在（不存在则创建，含多账号后缀规则）
   * 多账号规则与扩展工具项目一致：首账号沿用固定 ID，后登录账号为 base-bootcode-{userId}
   * 文件初始化（拉取开源仓库）由前端 BootProjectLoader 负责
   */
  ensureBootProject(userId: string): DesktopApp {
    // 1. 按归属查当前用户自己的 BootCode 项目
    const mine = this.findUserBootProject(userId);
    if (mine) return mine;

    // 2. 固定 ID 未被其他账号占用则沿用，被占用则带 userId 后缀
    const fixedTaken = !!this.getById(BOOT_PROJECT_ID);
    const projectId = fixedTaken ? `${BOOT_PROJECT_ID}-${userId}` : BOOT_PROJECT_ID;

    // 3. 全新创建
    return this.createSystemProject(
      projectId,
      userId,
      'BootCode 源码',
      'Teegal 开源源码项目（teegal-autoprojects）：本系统的完整源代码，系统首次初始化时自动从开源仓库拉取。不可删除，可自由阅读和修改——这就是你可以自己写自己的 Agent 的入口。',
      '# BootCode\n\n此项目存放 Teegal 开源源码。首次初始化时系统会自动从开源仓库拉取完整源码；若目录为空，说明拉取未完成，重启应用会自动重试。'
    );
  }

  // ==========================================================================
  // 🔥 项目记忆（project_memory）：任务完成时的 ReAct 过程笔记按项目存档
  //    接手项目先读档案（call_memory 传 projectId）快速建立熟悉度，免重读全部代码
  // ==========================================================================

  /** 笔记预算：超出从头部丢最老轮次（早期结论通常已被后续笔记延续整合），丢时头部提示 */
  private static readonly PROJECT_NOTE_BUDGET = 4000;

  /** 时间衰减：半衰期 30 天（与客户端 CallMemoryTool 回合打分同手感） */
  private static readonly PM_DECAY_LAMBDA = Math.log(2) / (30 * 24 * 3600 * 1000);

  /**
   * 项目 id 归一化：短 id / 任意 id 前缀查库解析为完整 UUID；解析失败按原样返回
   * （写入与查询双端都过这里，短 id 存进去也能对上）
   */
  private normalizeProjectId(rawId: string): string {
    if (!rawId) return rawId;
    const lower = rawId.toLowerCase();
    const exact = this.getById(rawId) || this.getById(lower);
    if (exact) return exact.id;
    const db = localDatabase.getDb();
    const row = db.prepare(
      `SELECT id FROM desktop_apps WHERE LOWER(id) LIKE ? AND user_id IS NOT NULL LIMIT 2`
    ).get(`${lower.replace(/[%_]/g, '\\$&')}%`) as any;
    // 命中多条（前缀歧义）时无法确定，按原样返回由调用方决定
    if (Array.isArray(row)) return rawId;
    return row?.id || rawId;
  }

  /**
   * 保存一条项目记忆（每任务每项目一条；多项目任务由调用方按归属多次调用）
   * writeNote 超预算从头部截断保尾部，头部提示已截断
   */
  saveProjectMemory(params: {
    projectId: string;
    userId: string;
    userQuery: string;
    writeNote: string;
    conversationId?: string;
  }): void {
    const db = localDatabase.getDb();
    let note = params.writeNote || '';
    if (note.length > DesktopAppDAO.PROJECT_NOTE_BUDGET) {
      note = `[笔记头部已截断，仅保留最近部分]\n${note.slice(-DesktopAppDAO.PROJECT_NOTE_BUDGET)}`;
    }
    db.prepare(`
      INSERT INTO project_memory (project_id, user_id, user_query, write_note, conversation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.normalizeProjectId(params.projectId),
      params.userId,
      (params.userQuery || '').slice(0, 4000),
      note,
      params.conversationId || null,
      Date.now()
    );
  }

  /**
   * 查询项目记忆：
   * - 无 query：时间倒序拉最近 limit 条（接手项目翻档案场景）
   * - 有 query：user_query(权重4) + write_note(权重2) 子串打分 × 时间衰减，取 top limit（定向查场景）
     数据量级为每项目几十条，内存扫描即可，无需 FTS
   */
  queryProjectMemory(params: {
    userId: string;
    projectId: string;
    query?: string;
    limit?: number;
  }): Array<{ userQuery: string; writeNote: string; conversationId: string | null; createdAt: number; score?: number }> {
    const db = localDatabase.getDb();
    const pid = this.normalizeProjectId(params.projectId);
    // 前缀兼容：完整 id 相等 或 以短 id 为前缀（存量短 id 数据）
    const rows = db.prepare(`
      SELECT user_query, write_note, conversation_id, created_at
      FROM project_memory
      WHERE user_id = ? AND (project_id = ? OR project_id LIKE ?)
      ORDER BY created_at DESC
      LIMIT 200
    `).all(params.userId, pid, `${pid.replace(/[%_]/g, '\\$&')}%`) as any[];

    if (rows.length === 0) return [];

    const limit = Math.min(params.limit || 5, 20);
    const q = (params.query || '').trim().toLowerCase();

    // 🔥 "上次/最近"类查询快捷路径：语义就是要最近档案，直接时间倒序（打分反而绕远）
    if (!q || /(上次|上一次|最近|之前怎么|前几次)/.test(q)) {
      return rows.slice(0, limit).map(r => ({
        userQuery: r.user_query,
        writeNote: r.write_note,
        conversationId: r.conversation_id,
        createdAt: r.created_at,
      }));
    }

    // 打分：分词逐词命中 Σ 权重×log(1+次数) × 时间衰减
    // 🔥 整串匹配对中文必空手（"chat-agent上次部署方案细节"原样出现在档案里的概率为零），
    // 必须切词：英文/数字词整体提取（信息量大权重高）+ 中文滑窗 bigram
    const tokens = this.tokenizeQuery(q);
    if (tokens.length === 0) {
      return rows.slice(0, limit).map(r => ({
        userQuery: r.user_query,
        writeNote: r.write_note,
        conversationId: r.conversation_id,
        createdAt: r.created_at,
      }));
    }

    const scored = rows.map(r => {
      const uq = (r.user_query || '').toLowerCase();
      const note = (r.write_note || '').toLowerCase();
      let raw = 0;
      for (const t of tokens) {
        const weight = /^[a-z0-9]/.test(t) ? 4 : 1.5; // 英文词精确信息量大；中文 bigram 误命中率高权重低
        const c = this.countOccurrences(uq, t) + this.countOccurrences(note, t);
        if (c > 0) raw += weight * Math.log(1 + c);
      }
      const decay = Math.exp(-DesktopAppDAO.PM_DECAY_LAMBDA * Math.max(0, Date.now() - r.created_at));
      return {
        userQuery: r.user_query,
        writeNote: r.write_note,
        conversationId: r.conversation_id,
        createdAt: r.created_at,
        score: raw * decay,
      };
    }).filter(r => (r.score || 0) > 0);

    // 🔥 零分兜底：关键词全没命中时退回时间倒序，绝不返回空（LLM 至少拿到最近档案可推断）
    if (scored.length === 0) {
      return rows.slice(0, limit).map(r => ({
        userQuery: r.user_query,
        writeNote: r.write_note,
        conversationId: r.conversation_id,
        createdAt: r.created_at,
      }));
    }

    scored.sort((a, b) => (b.score || 0) - (a.score || 0));
    return scored.slice(0, limit);
  }

  /**
   * 🔥 查询分词：英文/数字词（≥2字符，含连字符/点，如 chat-agent、v2.1）整体提取；
   * 中文段按 2 字滑窗切 bigram（中文无空格分隔，bigram 是无词典分词的最低配可用方案，
   * 多 token 汇总分后真命中档案在多数 token 上都有分，排名自然靠前）
   */
  private tokenizeQuery(q: string): string[] {
    const tokens = new Set<string>();
    for (const w of q.match(/[a-z0-9][a-z0-9._-]*/gi) || []) {
      if (w.length >= 2) tokens.add(w.toLowerCase());
    }
    // 剔除英文/数字/标点后的剩余中文段滑窗
    for (const seg of q.split(/[a-z0-9\s\p{P}]+/iu)) {
      if (!/[\u4e00-\u9fa5]/.test(seg)) continue;
      for (let i = 0; i + 2 <= seg.length; i++) tokens.add(seg.slice(i, i + 2));
    }
    return [...tokens];
  }

  private countOccurrences(text: string, needle: string): number {
    if (!text || !needle) return 0;
    let count = 0;
    let pos = text.indexOf(needle);
    while (pos !== -1) {
      count++;
      pos = text.indexOf(needle, pos + needle.length);
    }
    return count;
  }
}

// 导出单例
export const desktopAppDAO = new DesktopAppDAO();
