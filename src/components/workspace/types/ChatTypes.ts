
export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  content: string; // 统一使用content存储base64数据
  url?: string; // 保留url属性用于兼容
  mimeType?: string; // 添加mimeType支持
  size?: number; // 🔥 添加size属性，修复构建错误
  // 🔥 新增：文件URL传递和缓存支持
  storageUrl?: string; // 存储服务的HTTP URL
  isUploaded?: boolean; // 文件是否已上传到存储服务
  uploadTimestamp?: number; // 上传时间戳，用于缓存控制
  // 🔥 新增：上传进度相关字段
  uploadProgress?: number; // 0-100
  uploadStatus?: 'pending' | 'uploading' | 'success' | 'error';
  uploadError?: string;
  // 🔥 新增：文件分析结果支持
  fileAnalysisResult?: string; // 文件分析结果
  analysisTimestamp?: number; // 分析时间戳
  dimensions?: {
    width: number;
    height: number;
  };
  // 🔥 新增：通用元数据字段，用于存储额外信息（如 AI 分析结果、标签等）
  metadata?: Record<string, any>;
  // 🔥 新增：文件来源标记，用于区分文件产生方式
  // user_message: 消息界面上传的文件
  // step_output: 执行流程输出的文件
  // edit: 编辑原始文件后的文件（手动或LLM编辑）
  // user_upload: ExecutionPanel直接上传的文件
  source?: 'user_message' | 'step_output' | 'edit' | 'user_upload';
  // 🔥 新增：PPTX下载URL（当文件为PDF预览时，pptUrl用于下载PPTX）
  pptUrl?: string; // PPTX文件下载地址（仅PDF预览文件使用）
  // 🔥 新增：本地文件路径（Electron 本地存储模式使用）
  localPath?: string; // 本地文件绝对路径，如：C:\\Users\\...\\data\\files\\{conversationId}\\{fileId}_{name}
  // 废弃字段，保持向后兼容但不再使用
  preview?: string;
  base64?: string;
  thumbnailBase64?: string;
  originalBase64?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'auto'; // 🔥 新增auto role
  content: string;
  timestamp: Date;
  files?: FileAttachment[];
  metadata?: Record<string, any>; // 添加metadata字段

  // 🔥 新字段：API 调用角色（与 EnvironmentRole 对应）
  apiRole?: 'summarizer' | 'reactor';

  // 🔥 新字段：执行结果（API 调用后填充）
  result?: string;

  // 🔥 新字段：消息状态
  status?: 'pending' | 'streaming' | 'completed' | 'failed';

  // 🔥 新字段：关联的 API 调用 ID（用于更新同一条消息）
  callId?: string;

  // 🔥 新字段：Icon 旁边的文本（前端显示，可动态更新）
  iconText?: string;

  // 🔥 新字段：会话 ID（用于分组显示，每个 AutoHandler 唯一）
  sessionId?: string;

  // 🔥 新字段：记忆（来自 memory++）
  memory?: string;

  // 🔥 userQuery 来源标签：'chat'（聊天输入，缺省）| 'email'（离线邮件指挥）| 未来 IM 渠道扩展
  // 持久化在 messages.metadata JSON 的 source 字段，渲染时非 chat 来源在时间戳旁显示来源图标
  source?: string;

  // 🔥 保留旧字段用于向后兼容
  phase_data?: {
    phase: string;
    phase_key: string;
    phasestext: Array<{phaseText: string; status: string}>;
    phase_result?: string;
    adjustmentInfo?: {
      explanation?: string;
      newStepsCount?: number;
    };
  };

  // System message properties
  type?: 'dispatch' | 'execution' | 'result' | 'error' | 'parameter_collection' | 'info';
  agentInfo?: {
    name?: string;
    type?: string;
    agentId?: string;
    executionId?: string;
    inputRequirements?: any[];
    [key: string]: any;
  };
  agentName?: string;
  parametersData?: Record<string, any>;
  isParameterizedExecution?: boolean;
}
