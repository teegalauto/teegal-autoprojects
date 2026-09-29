/**
 * 本地 SQLite 数据库服务
 * 
 * 用于存储需要本地访问的数据：
 * - 工作区数据
 * - 聊天历史（conversations & messages）
 * - 本地文件缓存
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class LocalDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dataDir?: string) {
    // 数据库文件路径
    let dbDir: string;
    
    if (dataDir) {
      // 使用传入的数据目录
      dbDir = dataDir;
    } else if (process.env.USER_DATA_DIR) {
      // 🔥 Electron 生产环境：使用环境变量指定的用户数据目录
      dbDir = path.join(process.env.USER_DATA_DIR, 'data');
    } else {
      // 开发环境：存储在项目根目录的 data 文件夹
      const projectRoot = path.resolve(__dirname, '..', '..', '..');
      dbDir = path.join(projectRoot, 'data');
    }
    
    // 确保目录存在
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    // 🔥 统一命名为 teegal.db；首次启动时自动迁移旧命名的 bbone-tagalong.db（含 WAL 伴生文件）
    const newDbPath = path.join(dbDir, 'teegal.db');
    const legacyDbPath = path.join(dbDir, 'bbone-tagalong.db');
    try {
      if (fs.existsSync(legacyDbPath) && !fs.existsSync(newDbPath)) {
        fs.renameSync(legacyDbPath, newDbPath);
        for (const suffix of ['-wal', '-shm']) {
          const legacySide = legacyDbPath + suffix;
          if (fs.existsSync(legacySide)) {
            fs.renameSync(legacySide, newDbPath + suffix);
          }
        }
        console.log('📁 已迁移旧数据库文件: bbone-tagalong.db -> teegal.db');
      }
    } catch (e) {
      console.warn('⚠️ 旧数据库文件迁移失败，忽略:', e);
    }
    this.dbPath = newDbPath;
    console.log('📁 SQLite 数据库路径:', this.dbPath);
  }

  /**
   * 初始化数据库连接
   */
  connect(): void {
    if (this.db) {
      console.log('⚠️ 数据库已连接');
      return;
    }

    try {
      this.db = new Database(this.dbPath);
      console.log('✅ SQLite 数据库连接成功');
      
      // 启用外键约束
      this.db.pragma('foreign_keys = ON');
      
      // WAL 模式（提升并发性能）
      this.db.pragma('journal_mode = WAL');
      
      // 初始化表结构
      this.initTables();
    } catch (error) {
      console.error('❌ 数据库连接失败:', error);
      throw error;
    }
  }

  /**
   * 数据库迁移：检查并更新表结构
   */
  private migrateDatabase(): void {
    if (!this.db) {
      throw new Error('数据库未连接');
    }

    console.log('🔄 检查数据库迁移...');

    try {
      // 🔥 检查 desktop_apps 表是否需要迁移（添加新字段）
      const desktopAppsExists = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='desktop_apps'
      `).get();

      if (desktopAppsExists) {
        const columns = this.db.prepare(`PRAGMA table_info(desktop_apps)`).all() as any[];
        const columnNames = columns.map((col: any) => col.name);

        // 添加缺失的字段
        if (!columnNames.includes('definition')) {
          console.log('🔄 添加 definition 字段到 desktop_apps 表...');
          this.db.exec(`ALTER TABLE desktop_apps ADD COLUMN definition TEXT;`);
        }
        if (!columnNames.includes('interface_spec')) {
          console.log('🔄 添加 interface_spec 字段到 desktop_apps 表...');
          this.db.exec(`ALTER TABLE desktop_apps ADD COLUMN interface_spec TEXT;`);
        }
        if (!columnNames.includes('market_status')) {
          console.log('🔄 添加 market_status 字段到 desktop_apps 表...');
          this.db.exec(`ALTER TABLE desktop_apps ADD COLUMN market_status TEXT DEFAULT 'local';`);
        }
        if (!columnNames.includes('model_visualization')) {
          console.log('🔄 添加 model_visualization 字段到 desktop_apps 表...');
          this.db.exec(`ALTER TABLE desktop_apps ADD COLUMN model_visualization TEXT;`);
        }
        if (!columnNames.includes('code_path')) {
          console.log('🔄 添加 code_path 字段到 desktop_apps 表...');
          this.db.exec(`ALTER TABLE desktop_apps ADD COLUMN code_path TEXT;`);
        }
      }

      // 🔥 检查 messages 表是否需要迁移
      const messagesTableExists = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='messages'
      `).get();

      if (messagesTableExists) {
        const messageColumns = this.db.prepare(`PRAGMA table_info(messages)`).all() as any[];
        const messageColumnNames = messageColumns.map((col: any) => col.name);

        // 🔥 添加新字段到 messages 表
        if (!messageColumnNames.includes('api_role')) {
          console.log('🔄 添加 api_role 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN api_role TEXT;`);
        }
        if (!messageColumnNames.includes('result')) {
          console.log('🔄 添加 result 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN result TEXT;`);
        }
        if (!messageColumnNames.includes('status')) {
          console.log('🔄 添加 status 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN status TEXT;`);
        }
        if (!messageColumnNames.includes('call_id')) {
          console.log('🔄 添加 call_id 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN call_id TEXT;`);
        }
        if (!messageColumnNames.includes('icon_text')) {
          console.log('🔄 添加 icon_text 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN icon_text TEXT;`);
        }
        if (!messageColumnNames.includes('width_index')) {
          console.log('🔄 添加 width_index 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN width_index INTEGER DEFAULT 0;`);
        }
        if (!messageColumnNames.includes('depth')) {
          console.log('🔄 添加 depth 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN depth INTEGER DEFAULT 0;`);
        }
        if (!messageColumnNames.includes('session_id')) {
          console.log('🔄 添加 session_id 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN session_id TEXT;`);
        }
        if (!messageColumnNames.includes('memory')) {
          console.log('🔄 添加 memory 字段到 messages 表...');
          this.db.exec(`ALTER TABLE messages ADD COLUMN memory TEXT;`);
        }
      }

      // 🔥 检查 execution_logs 表是否存在，不存在则创建
      const executionLogsExists = this.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='execution_logs'
      `).get();

      if (!executionLogsExists) {
        console.log('🔄 创建 execution_logs 表...');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS execution_logs (
            id TEXT PRIMARY KEY,
            app_id TEXT,
            user_id TEXT NOT NULL,
            execution_mode TEXT NOT NULL DEFAULT 'python',
            command TEXT,
            work_dir TEXT,
            stdout_output TEXT,
            stderr_output TEXT,
            exit_code INTEGER,
            duration INTEGER,
            status TEXT NOT NULL DEFAULT 'running',
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_execution_logs_app_id ON execution_logs(app_id);`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_execution_logs_user_id ON execution_logs(user_id);`);
        console.log('✅ execution_logs 表创建完成');
      }
    } catch (error) {
      console.error('⚠️ 数据库迁移失败:', error);
      // 不抛出错误，继续初始化
    }
  }

  /**
   * 初始化数据库表结构
   */
  private initTables(): void {
    if (!this.db) {
      throw new Error('数据库未连接');
    }

    console.log('📋 初始化数据库表结构...');

    // 先执行迁移
    this.migrateDatabase();

    // 创建 conversations 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        agent_id TEXT,
        status TEXT DEFAULT 'active',
        execution_count INTEGER DEFAULT 0,
        result TEXT,
        is_flagged INTEGER DEFAULT 0,
        flagged_at INTEGER,
        is_broadcast INTEGER DEFAULT 0,
        metadata TEXT, -- JSON: 存储其他扩展字段
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 创建 messages 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL, -- user, assistant, system, auto
        content TEXT NOT NULL,
        files TEXT, -- JSON: 文件附件列表
        metadata TEXT, -- JSON: 其他元数据
        -- 🔥 新字段
        api_role TEXT, -- API 调用角色: summarizer, reactor
        result TEXT, -- 执行结果
        status TEXT, -- 消息状态: pending, streaming, completed, failed
        call_id TEXT, -- 关联的 API 调用 ID
        icon_text TEXT, -- Icon 旁边的文本
        session_id TEXT, -- 🔥 会话 ID，用于区分不同执行流程
        memory TEXT, -- 🔥 记忆（来自 memory++）
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);

    // 🔥 创建全文搜索表（FTS5）用于高效搜索消息内容
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        content='messages',
        content_rowid='rowid'
      );
    `);

    // 🔥 创建触发器：自动同步到 FTS 表（合并 content 和 result 字段）
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, conversation_id)
        VALUES (new.rowid, COALESCE(new.content, '') || ' ' || COALESCE(new.result, ''), new.conversation_id);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        UPDATE messages_fts SET content = COALESCE(new.content, '') || ' ' || COALESCE(new.result, '') WHERE rowid = old.rowid;
      END;
    `);

    // 🔥 重建 FTS 索引以包含 result 字段（仅首次运行时执行）
    try {
      const ftsRebuildFlag = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fts_rebuild_done'`).get();
      if (!ftsRebuildFlag) {
        console.log('🔄 首次检测到 FTS 需要重建，正在重建 FTS 索引以包含 result 字段...');
        this.db.exec(`
          INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
        `);
        this.db.exec(`CREATE TABLE IF NOT EXISTS fts_rebuild_done (id INTEGER PRIMARY KEY)`);
        this.db.exec(`INSERT INTO fts_rebuild_done (id) VALUES (1)`);
        console.log('✅ FTS 索引重建完成');
      }
    } catch (e) {
      console.warn('⚠️ FTS 索引重建失败（可能表不存在）:', e);
    }

    // 创建 execution_snapshots 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_snapshots (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        status TEXT NOT NULL,
        result_files TEXT DEFAULT '[]', -- JSON: 结果文件列表
        metadata TEXT DEFAULT '{}', -- JSON: 元数据
        created_at INTEGER,
        result_token INTEGER,
        result_cost REAL,
        updated_at INTEGER,
        result_parameters TEXT,
        task_id TEXT,
        task_status TEXT DEFAULT 'completed',
        polling_count INTEGER DEFAULT 0,
        estimated_completion_time INTEGER,
        last_polled_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);

    // 🔥 创建 desktop_apps 表（桌面应用）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        code TEXT NOT NULL,
        config TEXT DEFAULT '{}', -- JSON: 应用配置
        preview TEXT,
        user_id TEXT NOT NULL,
        current_code TEXT,
        previous_code TEXT,
        env_vars TEXT DEFAULT '{}', -- JSON: 环境变量
        -- 🔥 App 市场相关字段
        definition TEXT, -- JSON: 运行环境定义
        interface_spec TEXT, -- JSON: 接口规范
        market_status TEXT DEFAULT 'local', -- local | outworking (出门工作中，锁住不可编辑)
        -- 🔥 模型可视化数据
        model_visualization TEXT, -- JSON: 缓存的模型架构可视化数据
        -- 🔥 导入项目：自定义代码路径
        code_path TEXT, -- 导入项目的本地路径，NULL时使用默认 apps/{appId} 目录
        -- 🔥 项目类型：normal=普通项目，system_base=基础项目（不可删除，系统级）
        app_type TEXT NOT NULL DEFAULT 'normal',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 🔥 创建 training_tasks 表（训练任务）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS training_tasks (
        id TEXT PRIMARY KEY,
        app_id TEXT,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
        code_snapshot TEXT,
        stdout_output TEXT,
        charts_json TEXT DEFAULT '[]', -- JSON: 图表数据
        files_json TEXT DEFAULT '{}', -- JSON: 文件数据
        model_oss_url TEXT,
        instance_type TEXT,
        gpu_instance_id TEXT,
        duration INTEGER,
        cost REAL,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (app_id) REFERENCES desktop_apps(id) ON DELETE CASCADE
      );
    `);

    // 🔥 创建 ssh_resources 表（用户侧 SSH 资源中心：cloud 租赁 / workstation 预留）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ssh_resources (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        app_id TEXT DEFAULT '',
        name TEXT DEFAULT '',
        source TEXT NOT NULL DEFAULT 'cloud', -- cloud | workstation
        provider TEXT DEFAULT 'tencent',
        instance_type TEXT DEFAULT '',
        region TEXT DEFAULT '',
        host TEXT DEFAULT '',
        port INTEGER DEFAULT 22,
        username TEXT DEFAULT 'root',
        credential_name TEXT DEFAULT '',
        cloud_rental_id TEXT DEFAULT '',
        cloud_instance_id TEXT DEFAULT '',
        price_per_hour REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'booting', -- booting, running, closed, error
        remark TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);

    // 🔥 已有库补 app_id 列（项目归属，区分"项目专属机"）
    try {
      this.db.exec(`ALTER TABLE ssh_resources ADD COLUMN app_id TEXT DEFAULT '';`);
    } catch { /* 列已存在 */ }

    // 创建 execution_logs 表（本地代码执行记录）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_logs (
        id TEXT PRIMARY KEY,
        app_id TEXT,
        user_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'python',
        command TEXT,
        work_dir TEXT,
        stdout_output TEXT,
        stderr_output TEXT,
        exit_code INTEGER,
        duration INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 🔥 创建 dse_files 表（数据环境文件记录）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dse_files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_type TEXT NOT NULL DEFAULT 'other',
        oss_url TEXT NOT NULL,
        oss_path TEXT NOT NULL DEFAULT '',
        local_path TEXT,
        dataset_id TEXT,
        dataset_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 🔥 凭据表（加密存储，LLM 不可见 value）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'env_var',
        description TEXT NOT NULL DEFAULT '',
        env_var TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        provider TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 🔥 旧库迁移：凭据表补充 source / provider 字段（官方租约型凭据）
    const credTableExists = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='credentials'
    `).get();
    if (credTableExists) {
      const credColumns = this.db.prepare(`PRAGMA table_info(credentials)`).all() as any[];
      const credColumnNames = credColumns.map((col: any) => col.name);
      if (!credColumnNames.includes('source')) {
        console.log('🔄 添加 source 字段到 credentials 表...');
        this.db.exec(`ALTER TABLE credentials ADD COLUMN source TEXT NOT NULL DEFAULT 'user';`);
      }
      if (!credColumnNames.includes('provider')) {
        console.log('🔄 添加 provider 字段到 credentials 表...');
        this.db.exec(`ALTER TABLE credentials ADD COLUMN provider TEXT;`);
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_execution_snapshots_conversation_id ON execution_snapshots(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_execution_snapshots_task_id ON execution_snapshots(task_id) WHERE task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_execution_snapshots_created_at ON execution_snapshots(created_at);
      CREATE INDEX IF NOT EXISTS idx_desktop_apps_user_id ON desktop_apps(user_id);
      CREATE INDEX IF NOT EXISTS idx_desktop_apps_created_at ON desktop_apps(created_at);
      CREATE INDEX IF NOT EXISTS idx_training_tasks_app_id ON training_tasks(app_id);
      CREATE INDEX IF NOT EXISTS idx_training_tasks_user_id ON training_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_execution_logs_app_id ON execution_logs(app_id);
      CREATE INDEX IF NOT EXISTS idx_execution_logs_user_id ON execution_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_dse_files_user_id ON dse_files(user_id);
      CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON credentials(user_id);
      CREATE INDEX IF NOT EXISTS idx_dse_files_dataset_id ON dse_files(dataset_id);
    `);

    // 🔥 迁移：为 training_tasks 表添加 flag 字段（如果不存在）
    try {
      const columns = this.db.prepare('PRAGMA table_info(training_tasks)').all() as any[];
      const hasFlagColumn = columns.some(col => col.name === 'flag');
      if (!hasFlagColumn) {
        this.db.exec('ALTER TABLE training_tasks ADD COLUMN flag TEXT DEFAULT NULL');
        console.log('✅ 已为 training_tasks 表添加 flag 字段');
      }
    } catch (error) {
      console.warn('⚠️ 检查/添加 flag 字段失败:', error);
    }

    // 🔥 迁移：为 training_tasks 表添加 gpu_instance_region 字段（如果不存在）
    try {
      const columns = this.db.prepare('PRAGMA table_info(training_tasks)').all() as any[];
      const hasRegionColumn = columns.some(col => col.name === 'gpu_instance_region');
      if (!hasRegionColumn) {
        this.db.exec('ALTER TABLE training_tasks ADD COLUMN gpu_instance_region TEXT DEFAULT NULL');
        console.log('✅ 已为 training_tasks 表添加 gpu_instance_region 字段');
      }
    } catch (error) {
      console.warn('⚠️ 检查/添加 gpu_instance_region 字段失败:', error);
    }

    // 🔥 迁移：为 training_tasks 表添加 remark 字段（训练备注/阶段总结）
    try {
      const columns = this.db.prepare('PRAGMA table_info(training_tasks)').all() as any[];
      const hasRemarkColumn = columns.some(col => col.name === 'remark');
      if (!hasRemarkColumn) {
        this.db.exec('ALTER TABLE training_tasks ADD COLUMN remark TEXT DEFAULT NULL');
        console.log('✅ 已为 training_tasks 表添加 remark 字段');
      }
    } catch (error) {
      console.warn('⚠️ 检查/添加 remark 字段失败:', error);
    }

    // 🔥 迁移：为 desktop_apps 表添加 app_type 字段（项目类型：normal | system_base）
    try {
      const columns = this.db.prepare('PRAGMA table_info(desktop_apps)').all() as any[];
      const hasAppTypeColumn = columns.some(col => col.name === 'app_type');
      if (!hasAppTypeColumn) {
        this.db.exec("ALTER TABLE desktop_apps ADD COLUMN app_type TEXT NOT NULL DEFAULT 'normal'");
        console.log('✅ 已为 desktop_apps 表添加 app_type 字段');
      }
    } catch (error) {
      console.warn('⚠️ 检查/添加 app_type 字段失败:', error);
    }

    console.log('✅ 数据库表结构初始化完成（含 FTS5 全文搜索）');
  }

  /**
   * 获取数据库实例
   */
  getDb(): Database.Database {
    if (!this.db) {
      throw new Error('数据库未连接，请先调用 connect()');
    }
    return this.db;
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('✅ 数据库连接已关闭');
    }
  }

  /**
   * 检查数据库是否已连接
   */
  isConnected(): boolean {
    return this.db !== null;
  }

}

// 导出单例
export const localDatabase = new LocalDatabase();
