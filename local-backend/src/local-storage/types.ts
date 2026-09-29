/**
 * 本地存储数据类型定义（SQLite）
 */

export interface Conversation {
  id: string;
  user_id: string;
  title: string | null;
  agent_id: string | null;
  status: 'idle' | 'active' | 'completed' | 'archived' | 'deleted';
  execution_count: number;
  result: string | null;
  is_flagged: boolean;
  flagged_at: number | null;
  is_broadcast: boolean;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'auto';
  content: string;
  files: any[];
  metadata: Record<string, any>;
  // 🔥 新字段
  api_role?: 'summarizer' | 'reactor';
  result?: string;
  status?: 'pending' | 'streaming' | 'completed' | 'failed';
  call_id?: string;
  icon_text?: string;
  session_id?: string;   // 会话 ID，用于区分不同执行流程
  memory?: string;       // 🔥 记忆（来自 memory++）
  created_at: number;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

/**
 * Desktop App 类型定义
 */
export interface DesktopApp {
  id: string;
  name: string;
  description: string | null;
  code: string;
  config: Record<string, any>;
  preview: string | null;
  user_id: string;
  current_code: string | null;
  previous_code: string | null;
  env_vars: Record<string, any>;
  // 🔥 App 市场相关字段
  definition: string | null;      // JSON: 运行环境定义（包依赖、数据库表等）
  interface_spec: string | null;  // JSON: 接口规范（参数定义）
  market_status: 'local' | 'outworking';  // 市场状态：local=本地，outworking=出门工作中
  // 🔥 模型可视化数据
  model_visualization: string | null;  // JSON: 缓存的模型架构可视化数据
  // 🔥 导入项目：自定义代码路径（非空时文件操作指向此目录，而非默认的 apps/{appId}）
  code_path: string | null;
  // 🔥 项目类型：normal=普通项目，system_base=基础项目（不可删除，系统级，list_projects 排在最前）
  app_type: 'normal' | 'system_base';
  created_at: number;
  updated_at: number;
}

/**
 * Training Task 类型定义
 */
export interface TrainingTask {
  id: string;
  app_id: string | null;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  code_snapshot: string | null;
  stdout_output: string | null;
  charts_json: any[];
  files_json: Record<string, any>;
  model_oss_url: string | null;
  instance_type: string | null;
  gpu_instance_id: string | null;
  gpu_instance_region: string | null;  // 🔥 实例创建时的 region（用于 stop）
  duration: number | null;
  cost: number | null;
  error_message: string | null;
  // 🔥 训练标记：best/breakthrough/baseline/experimental/pending_optimization/failed_valuable
  flag: 'best' | 'breakthrough' | 'baseline' | 'experimental' | 'pending_optimization' | 'failed_valuable' | null;
  // 🔥 训练备注/阶段总结（最多200字，LLM 和用户都可写）
  remark: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Execution Log 类型定义 - 本地代码执行记录
 */
export interface ExecutionLog {
  id: string;
  app_id: string | null;
  user_id: string;
  execution_mode: 'python' | 'npm' | 'shell';  // 执行模式
  command: string | null;           // 执行的命令
  work_dir: string | null;          // 工作目录
  stdout_output: string | null;     // 标准输出
  stderr_output: string | null;     // 标准错误
  exit_code: number | null;         // 退出码
  duration: number | null;          // 执行时长（毫秒）
  status: 'running' | 'success' | 'failed' | 'cancelled';
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface DSEFile {
  id: string;
  user_id: string;
  file_name: string;
  file_size: number;
  file_type: string;        // image/zip/csv/model/other
  oss_url: string;          // 云端 URL
  oss_path: string;         // OSS 存储路径
  local_path: string | null; // 原始本地路径
  dataset_id: string | null; // 所属数据集 ID
  dataset_name: string | null; // 所属数据集名称
  created_at: number;
  updated_at: number;
}

/**
 * 凭据（加密存储，LLM 不可见 value）
 */
export interface Credential {
  id: string;
  user_id: string;
  name: string;              // 凭据名称（LLM 可见，如 "ssh_aliyun"）
  type: string;              // ssh_password | api_key | env_var | token
  description: string;       // 描述（LLM 可见）
  env_var: string;           // 环境变量名（如 "SSHPASS"）
  encrypted_value: string;   // 加密后的值（LLM 不可见；platform 型存空串）
  source?: string;           // 凭据来源：user（用户自维护，默认）| platform（官方租约，值运行时下发）
  provider?: string;         // platform 型的厂商标识（如 volcengine-ark），租约接口按此分发
  created_at: number;
  updated_at: number;
}
