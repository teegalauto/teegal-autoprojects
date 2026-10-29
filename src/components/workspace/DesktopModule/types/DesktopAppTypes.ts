export interface CodeVersion {
  content: string;        // 代码内容
  timestamp: Date;      // 时间戳
  version: string;      // 版本号
}



export interface DesktopApp {
  id: string;
  name: string;
  description: string;
  current_code?: string;    // 当前代码版本
  previous_code?: string;   // 上一个代码版本
  code: string;             // 保持兼容性，指向最新代码
  code_version?: string;    // 代码版本号
  config: DesktopAppConfig;
  env_vars?: Record<string, string>; // 🔥 环境变量存储
  working_dir?: string;     // 🔥 工作目录
  preview?: string;          // 预览结果（HTML/JSON）
  structured_preview?: {     // 🔥 新增：解析后的结构化数据
    output?: string;
    files?: Record<string, any>;
    charts?: any[];
    timestamp?: string;
  };
  // 🔥 App 市场相关字段
  definition?: string;       // JSON: 运行环境定义
  interface_spec?: string;   // JSON: 接口规范
  market_status?: 'local' | 'outworking';  // 市场状态：local=本地，outworking=出门工作中
  // 🔥 项目类型：normal=普通项目，system_base=系统基础项目（不可删除，如扩展工具）
  app_type?: 'normal' | 'system_base';
  // 🔥 项目场景类型（LLM upsert_project 声明）：training | inference | shortfilm | agent | general；NULL=未分类
  project_type?: string | null;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
}

export interface DesktopAppConfig {
  datasetPath?: string;      // 数据集路径
  runtime?: string;          // 运行时环境
  dependencies?: string[];   // 依赖库
  autoRun?: boolean;         // 是否自动运行
  autoRunInterval?: number;  // 🔥 自动运行间隔（秒）
}

export interface DesktopAppExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  preview?: string;
  executionTime?: number;
}