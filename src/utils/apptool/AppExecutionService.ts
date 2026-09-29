/**
 * App Execution Service
 * 统一的应用执行服务层，供 RunGpuTrainTool 和 DesktopAppViewer 复用
 * 
 * 执行模式：
 * - GPU 任务 → 后端 GPUExecutor（必须通过后端访问阿里云 ECI）
 * - CPU 任务 → 前端 CpuExecutionService（直接本地执行，无需后端）
 * 
 * 🔥 支持多文件项目：
 * - 自动扫描项目目录
 * - 打包所有文件发送给后端
 * - 后端解压后执行
 */

import { appDatabaseService } from "./AppDatabaseService";
import { getBackendUrl } from "@/config/api";
import { executeCpuTask, CpuExecutionResult } from "./CpuExecutionService";
import { importantObjectTracker } from "../auto/context/ImportantObjectTracker";
import { getProjectCode, ProjectFile } from './ProjectPackager';

/**
 * 🔥 官方租约凭据解析失败（余额不足 / 服务未配置等）
 * 必须传导给 LLM/用户——代码引用了该凭据，缺值执行必然失败，
 * 静默吞掉会让 LLM 只看到厂商 401 而误判原因
 */
export class LeaseCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseCredentialError';
  }
}

/**
 * 🔥 凭据注入（轻量版）：扫描代码中的环境变量引用，匹配 CredentialManager 凭据
 *
 * 设计原则：
 * - 值永不进 LLM/prompt，只在执行层注入
 * - 无引用不注入，零开销
 * - 匹配模式：os.environ['X'] / os.getenv('X') / process.env.X / $env:X
 */
const ENV_REF_PATTERNS = [
  /os\.environ(?:\.get)?\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,   // Python os.environ['X']
  /os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*[,)]/g,      // Python os.environ.get('X')
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*[,)]/g,            // Python os.getenv('X')
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,                            // Node process.env.X
  /\$env:([A-Za-z_][A-Za-z0-9_]*)/g,                                    // PowerShell $env:X
];

/** 扫描代码文本，提取引用的环境变量名 */
function scanEnvVarNames(code: string): Set<string> {
  const names = new Set<string>();
  if (!code) return names;
  for (const pattern of ENV_REF_PATTERNS) {
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * 解析代码引用的凭据环境变量：只返回凭据表中存在的 env 型凭据
 * 值不写日志、不进 prompt，仅用于执行注入
 * （GPU 容器执行 / 本地 CPU 执行 / LocalExecutor 共用）
 */
export async function resolveCredentialEnv(
  userId: string,
  codeContent: string,
  projectFiles?: ProjectFile[]
): Promise<Record<string, string>> {
  try {
    const electron = (window as any).electron;
    if (!electron?.localStorage?.getCredentialByName) return {};

    // 汇总单文件代码 + 多文件项目所有文件的引用
    const names = scanEnvVarNames(codeContent || '');
    if (projectFiles?.length) {
      for (const f of projectFiles) {
        const content = (f as any).content;
        if (typeof content === 'string') {
          for (const n of scanEnvVarNames(content)) names.add(n);
        }
      }
    }
    if (names.size === 0) return {};

    // 逐个查凭据（env 型才注入；param 型是明文参数，不走环境变量；platform 型值由租约服务下发）
    const env: Record<string, string> = {};
    for (const name of names) {
      const credential = await electron.localStorage.getCredentialByName(name, userId);
      if (!credential || credential.type === 'param') continue;
      let credValue: string;
      if (credential.source === 'platform' && credential.provider) {
        const { resolvePlatformCredential } = await import('../../services/cloud/CredentialLeaseService');
        try {
          credValue = await resolvePlatformCredential(userId, credential.provider);
        } catch (e: any) {
          throw new LeaseCredentialError(e?.message || '官方凭据解析失败');
        }
      } else if (credential.value) {
        credValue = credential.value;
      } else {
        continue;
      }
      env[credential.env_var || name] = credValue;
    }
    if (Object.keys(env).length > 0) {
      console.log(`🔑 [APP-EXECUTION-SERVICE] 注入凭据环境变量: ${Object.keys(env).join(', ')}`);
    }
    return env;
  } catch (error) {
    if (error instanceof LeaseCredentialError) throw error; // 租约类错误必须传导，不吞
    console.warn('[APP-EXECUTION-SERVICE] 凭据注入跳过:', error);
    return {};
  }
}

// 🔥 执行选项
export interface AppExecutionOptions {
  appId: string;
  userId: string;
  conversationId?: string;
  isGpu?: boolean;
  gpuInstanceType?: string;
  gpuProvider?: string;
  config?: {
    autoRun?: boolean;
    env_vars?: Record<string, string>;
    [key: string]: any;
  };
  files?: any[];
  code?: string;
  workingDir?: string;
  // 🔥 新增：入口文件
  entryPoint?: string;
}

// 🔥 执行结果
export interface AppExecutionResult {
  success: boolean;
  executionMode: 'local' | 'container' | 'gpu';
  output?: string;
  error?: string;
  errorCode?: string;
  executionTime?: number;
  lastExecutedAt?: string;
  taskId?: string;
  appId?: string;
  gpuStatus?: string;
  gpuInstanceType?: string;
  charts?: any[];
  files?: any[];
  actions?: any[];
  type?: 'appExecution';
  // 🔥 新增：多文件信息
  isMultiFile?: boolean;
  projectFiles?: ProjectFile[];
  mainFile?: string;
}

// 🔥 执行进度回调
export type ExecutionProgressCallback = (progress: { type: string; data?: string }) => void;

/**
 * 🔥 获取 ECS 后端 URL（使用统一配置）
 */
const getEcsUrl = (): string => {
  return getBackendUrl();
};

/**
 * 🔥 获取代码内容（处理多种格式）
 */
const extractCodeContent = (codeInput: any): string => {
  if (typeof codeInput === 'string') return codeInput;
  if (codeInput?.content) return codeInput.content;
  return '';
};

/**
 * 🔥 解码 Python json.dumps 产生的 Unicode 转义序列
 * Python 使用 ensure_ascii=True 时，非 ASCII 字符会被转义为 \uXXXX 格式
 */
const decodeUnicode = (str: string | undefined): string => {
  if (!str) return '';
  try {
    // 方法1: 使用 JSON.parse 解码（如果字符串是有效的 JSON 转义格式）
    // 先尝试直接解码
    return JSON.parse(`"${str}"`).replace(/\n/g, '\n').replace(/\r/g, '\r');
  } catch {
    // 方法2: 正则替换处理 \uXXXX 转义
    return str.replace(/\\u([\d\w]{4})/gi, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
  }
};

/**
 * 🔥 核心执行函数
 * @param options 执行选项
 * @param onProgress 进度回调（仅 CPU 本地执行时有效）
 * @returns 执行结果
 */
export const executeApp = async (
  options: AppExecutionOptions,
  onProgress?: ExecutionProgressCallback
): Promise<AppExecutionResult> => {
  let {
    appId,
    userId,
    conversationId,
    isGpu = false,
    gpuInstanceType, // 🔥 移除默认值，必须传入
    gpuProvider = 'aliyun',
    config = {},
    files = [],
    code: providedCode,
    workingDir,
    entryPoint,
  } = options;

  try {
    // 🔥 1. 获取代码内容
    let codeContent: string;
    let isMultiFile = false;
    let projectFiles: ProjectFile[] = [];
    let mainFile = 'main.py';
    let zipBase64: string | undefined;
    
    if (providedCode) {
      // 直接使用传入的代码
      codeContent = extractCodeContent(providedCode);
    } else {
      // 🔥 从项目目录获取代码（支持多文件）
      console.log(`🚀 [APP-EXECUTION-SERVICE] 获取项目代码: appId=${appId}`);
      
      const projectCode = await getProjectCode(appId);
      
      if (!projectCode.code) {
        return {
          success: false,
          executionMode: isGpu ? 'gpu' : 'local',
          error: `项目代码为空: ${appId}`,
        };
      }
      
      codeContent = projectCode.code;
      isMultiFile = projectCode.isMultiFile;
      projectFiles = projectCode.files;
      mainFile = projectCode.mainFile;
      zipBase64 = projectCode.zipBase64;
      
      console.log(`🚀 [APP-EXECUTION-SERVICE] 项目代码获取完成: isMultiFile=${isMultiFile}, files=${projectFiles.length}, mainFile=${mainFile}`);
      
      // 🔥 从数据库获取 app 配置（env_vars 已废弃，凭据注入见 resolveCredentialEnv）
      const app = await appDatabaseService.getDesktopApp(appId, userId);

      if (app) {
        if (!config.autoRun && app.config?.autoRun) {
          config = { ...config, autoRun: app.config.autoRun };
        }

        // 获取 workingDir（如果 app 有指定）
        if (!options.workingDir && app.working_dir) {
          options.workingDir = app.working_dir;
        }
      }
    }

    if (!codeContent) {
      return {
        success: false,
        executionMode: isGpu ? 'gpu' : 'local',
        error: "应用代码为空，无法执行",
      };
    }

    // 🔥 2. 判断执行模式
    // GPU 任务 → 后端执行（必须通过后端访问阿里云 ECI）
    // CPU 任务 → 前端本地执行（直接调用本地 Python，无需后端）

    // 🔥 凭据注入：扫描代码引用的环境变量名，匹配的凭据解析为注入值（GPU=容器 env_vars，本地=进程 env）
    let credentialEnv: Record<string, string>;
    try {
      credentialEnv = await resolveCredentialEnv(userId, codeContent, isMultiFile ? projectFiles : undefined);
    } catch (error: any) {
      // 官方租约类错误（余额不足等）直接终止执行并明确告知，而不是让代码跑到厂商 401 才失败
      return {
        success: false,
        executionMode: isGpu ? 'gpu' : 'local',
        error: error?.message || '凭据解析失败',
      };
    }

    if (isGpu) {
      const gpuConfig = Object.keys(credentialEnv).length > 0
        ? { ...config, env_vars: { ...(config.env_vars || {}), ...credentialEnv } }
        : config;
      return await executeGpuTask(codeContent, {
        appId,
        userId,
        conversationId,
        gpuInstanceType,
        gpuProvider,
        config: gpuConfig,
        isMultiFile,
        projectFiles,
        mainFile,
        zipBase64,
        entryPoint: entryPoint || mainFile,
      });
    } else {
      return await executeLocalTask(codeContent, {
        appId,
        userId,
        conversationId,
        workingDir,
        config,
        onProgress,
        isMultiFile,
        projectFiles,
        mainFile,
        credentialEnv,
      });
    }
  } catch (error) {
    console.error('❌ [APP-EXECUTION-SERVICE] 执行异常:', error);
    return {
      success: false,
      executionMode: isGpu ? 'gpu' : 'local',
      error: error instanceof Error ? error.message : "执行失败",
    };
  }
};

/**
 * 🔥 执行 GPU 任务（走后端）
 */
async function executeGpuTask(
  codeContent: string,
  options: {
    appId: string;
    userId: string;
    conversationId?: string;
    gpuInstanceType: string;
    gpuProvider: string;
    config: any;
    // 🔥 新增：多文件支持
    isMultiFile?: boolean;
    projectFiles?: ProjectFile[];
    mainFile?: string;
    zipBase64?: string;
    entryPoint?: string;
  }
): Promise<AppExecutionResult> {
  const { 
    appId, 
    userId, 
    conversationId, 
    gpuInstanceType, 
    gpuProvider, 
    config,
    isMultiFile = false,
    projectFiles = [],
    mainFile = 'main.py',
    zipBase64,
    entryPoint = 'main.py',
  } = options;
  
  const backendUrl = getEcsUrl();
  const executeUrl = `${backendUrl}/api/code-execution/execute`;
  const taskId = crypto.randomUUID();

  console.log(`🚀 [APP-EXECUTION-SERVICE] 发起 GPU 执行请求: taskId=${taskId}, provider=${gpuProvider}, isMultiFile=${isMultiFile}`);

  // 🔥 构建请求体
  const requestBody: any = {
    gpuNeeded: true,
    gpuInstanceType,
    gpuProvider,
    taskId,
    appId,
    userId,
    conversationId,
    config,
    // 🔥 多文件支持
    isMultiFile,
    entryPoint,
    mainFile,
  };

  if (isMultiFile && zipBase64) {
    // 🔥 多文件：发送打包后的 base64
    requestBody.codePackage = zipBase64;
    requestBody.files = projectFiles.map(f => ({
      path: f.path,
      size: f.size,
    }));
    console.log(`🚀 [APP-EXECUTION-SERVICE] 发送多文件包: ${projectFiles.length} 个文件, base64 长度 ${zipBase64.length}`);
  } else {
    // 🔥 单文件：发送代码内容
    requestBody.code = codeContent;
  }

  const response = await fetch(executeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const result = await response.json();
  console.log(`✅ [APP-EXECUTION-SERVICE] GPU 执行完成:`, result.success ? '成功' : '失败');

  // 🔥 任务已在执行中（重复提交），提前返回 streaming 状态
  if (result.success && (result.status === 'pending' || result.status === 'running')) {
    console.log(`⏳ [APP-EXECUTION-SERVICE] 任务已在执行中: taskId=${taskId}`);
    return {
      success: true,
      type: 'appExecution',
      executionMode: 'gpu',
      taskId: result.taskId || taskId,
      appId,
      gpuInstanceType,
      gpuStatus: 'streaming',
      output: undefined,
    };
  }

  // 🔥 提取执行结果中的重要对象（文件路径、appId 等）
  if (conversationId) {
    importantObjectTracker.extractFromExecutionResult(conversationId, {
      ...result,
      appId,
      taskId,
    });
  }

  if (result.success) {
    return {
      success: true,
      type: 'appExecution',
      executionMode: 'gpu',
      output: decodeUnicode(result.output),
      charts: result.charts,
      files: result.files,
      actions: result.actions,
      executionTime: result.executionTime,
      lastExecutedAt: result.lastExecutedAt || new Date().toISOString(),
      taskId: result.taskId || taskId,
      gpuStatus: result.gpuStatus,
      gpuInstanceType: result.gpuInstanceType,
      // 🔥 多文件信息
      isMultiFile,
      projectFiles,
      mainFile,
    };
  } else {
    return {
      success: false,
      type: 'appExecution',
      executionMode: 'gpu',
      error: result.error || '执行失败',
      errorCode: result.errorCode,
      taskId,
      isMultiFile,
      projectFiles,
      mainFile,
    };
  }
}

/**
 * 🔥 执行本地 CPU 任务（走前端）
 */
async function executeLocalTask(
  codeContent: string,
  options: {
    appId: string;
    userId: string;
    conversationId?: string;
    workingDir?: string;
    config: any;
    onProgress?: ExecutionProgressCallback;
    // 🔥 新增：多文件支持
    isMultiFile?: boolean;
    projectFiles?: ProjectFile[];
    mainFile?: string;
    /** 🔥 凭据环境变量（执行时注入，值不进 LLM） */
    credentialEnv?: Record<string, string>;
  }
): Promise<AppExecutionResult> {
  const {
    appId,
    userId,
    conversationId,
    workingDir,
    config,
    onProgress,
    isMultiFile = false,
    projectFiles = [],
    mainFile = 'main.py',
    credentialEnv,
  } = options;

  console.log(`🚀 [APP-EXECUTION-SERVICE] 发起本地 CPU 执行: appId=${appId}, isMultiFile=${isMultiFile}`);

  // 🔥 调用前端 CPU 执行服务 - 简单直接，不包装代码
  const result = await executeCpuTask({
    code: codeContent,
    language: 'auto',  // 自动检测语言
    timeout: 1800,
    workingDir,
    appId,
    userId,
    // 🔥 多文件支持
    isMultiFile,
    projectFiles,
    mainFile,
    // 🔥 凭据注入
    env: credentialEnv,
  }, onProgress);

  console.log(`✅ [APP-EXECUTION-SERVICE] 本地 CPU 执行完成:`, result.success ? '成功' : '失败');

  // 🔥 从输出中提取可能的文件路径
  if (conversationId && result.output) {
    // 尝试从输出中提取路径
    const pathMatches = result.output.match(/[A-Za-z]:[\\/][^\s\"]+|[~\/][^\s\"]+/g);
    if (pathMatches) {
      pathMatches.forEach(path => {
        if (path.includes('.') || path.includes('output')) {
          importantObjectTracker.addObject(conversationId, path, 'path', 'CPU执行输出中提取的路径');
        }
      });
    }
  }

  return {
    success: result.success,
    type: 'appExecution',
    executionMode: 'local',
    output: result.output,
    error: result.error,
    executionTime: result.executionTime,
    lastExecutedAt: new Date().toISOString(),
    // 🔥 多文件信息
    isMultiFile,
    projectFiles,
    mainFile,
  };
}

/**
 * 🔥 检测代码是否需要 GPU 资源
 * 基于代码内容中的特征关键词判断 + 训练规模检测
 */
export const checkGpuRequirement = (code: string): {
  requiresGPU: boolean;
  reason?: string;
  estimate: {
    duration: number;
    cost: number;
    costPerMinute: number;
    instanceType: string;
  };
} => {
  const codeLower = code.toLowerCase();
  
  const cpuExplicitPatterns = [
    /map_location\s*=\s*['"]?cpu['"]?/i,
    /map_location\s*=\s*torch\.device\s*\(\s*['"]cpu['"]\s*\)/i,
    /device\s*=\s*['"]cpu['"]/i,
    /torch\.device\s*\(\s*['"]cpu['"]\s*\)/i,
    /with\s+tf\.device\s*\(\s*['"]\/cpu:\d*['"]\s*\)/i,
    /cuda_visible_devices\s*=\s*['"]{2}/i,
    /os\.environ\s*\[\s*['"]cuda_visible_devices['"]\s*\]\s*=\s*['"]{2}/i,
    /\.to\s*\(\s*['"]cpu['"]\s*\)/i,
    // 🔥 移除 .cpu() 模式，因为 tensor.cpu() 只是数据转移操作，不代表模型在 CPU 上运行
    // /\.cpu\s*\(\s*\)/i,
  ];
  
  const hasExplicitCpu = cpuExplicitPatterns.some(pattern => pattern.test(code));
  
  if (hasExplicitCpu) {
    return {
      requiresGPU: false,
      reason: '代码中明确指定了 CPU 设备',
      estimate: {
        duration: 5,
        cost: 0,
        costPerMinute: 0,
        instanceType: 'cpu',
      },
    };
  }
  
  const gpuKeywords = [
    'torch.nn',
    'torch.cuda',
    'tensorflow',
    'keras',
    '.to(device)',
    '.cuda()',
    'gpu_training',
    'model.train()',
    'nn.Module',
    'cuda',
    'layers.conv2d',
    'tensorflow.keras',
    'fit_generator',
    "device('cuda')",
    'deepspeed',
    'huggingface',
    'transformers',
    'pytorch',
    // 🔥 强化学习/RL 库
    'stable_baselines3',
    'sb3',
    'gymnasium',
    'gym.make',
    'ray.rllib',
    'ray.tune',
    'tianshou',
    'cleanrl',
    'envpool',
    // 🔥 科学计算/加速库
    'cupy',
    'numba.cuda',
    'jax',
    'paddle',
    'megengine',
    'onnxruntime',
    // 🔥 分布式训练
    'torch.distributed',
    'torch.nn.parallel',
    'DistributedDataParallel',
    'horovod',
    // 🔥 模型推理
    'vllm',
    'triton',
    'tensorrt',
  ];
  const hasGpuIntention = gpuKeywords.some(keyword => codeLower.includes(keyword));
  
  let isHeavy = false;
  const epochMatch = codeLower.match(/epochs\s*[:=]\s*(\d+)/);
  if (epochMatch && parseInt(epochMatch[1]) > 5) isHeavy = true;
  
  const trainMatch = codeLower.includes('model.fit') || 
                     codeLower.includes('trainer.train()') || 
                     codeLower.includes('optim.step()');
  if (trainMatch) isHeavy = true;

  const requiresGPU = hasGpuIntention || isHeavy;
  
  let estimatedMinutes = 5;
  
  if (codeLower.length > 200) estimatedMinutes = 15;
  if (codeLower.length > 500) estimatedMinutes = 30;
  if (codeLower.includes('epochs') || codeLower.includes('for epoch')) {
    estimatedMinutes = Math.max(estimatedMinutes, 20);
  }

  // 🔥 使用合理的默认价格估算（约10元/小时，对应T4）
  const defaultPricePerHour = 10.0;
  const costPerMinute = defaultPricePerHour / 60;

  return {
    requiresGPU,
    reason: requiresGPU 
      ? (hasGpuIntention ? '检测到深度学习模型组件，未指定CPU设备' : '检测到较大规模训练任务')
      : undefined,
    estimate: {
      duration: estimatedMinutes,
      cost: estimatedMinutes * costPerMinute,
      costPerMinute,
      instanceType: 'T4 1卡（约10元/小时）', // 🔥 描述性文本，不硬编码具体实例类型
    },
  };
};

/**
 * 🔥 停止 GPU 训练任务
 * 统一入口：前端 UI 和 LLM tool 都调用此方法
 */
async function stopGpuTask(taskId: string, appId?: string, reason?: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const backendUrl = getBackendUrl();
    const response = await fetch(`${backendUrl}/api/code-execution/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, appId, reason }),  // 🔥 传入 reason
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[APP-EXECUTION-SERVICE] 停止任务失败: HTTP ${response.status}`, errorText);
      return { success: false, error: `停止训练失败: HTTP ${response.status}` };
    }

    const result = await response.json();
    console.log(`[APP-EXECUTION-SERVICE] 停止任务结果:`, result);
    return { success: result.success, error: result.error };
  } catch (error) {
    console.error('[APP-EXECUTION-SERVICE] 停止任务异常:', error);
    return { success: false, error: error instanceof Error ? error.message : '停止训练任务失败' };
  }
}

export const appExecutionService = {
  execute: executeApp,
  stopGpuTask,
  checkGpuRequirement,
};

export default appExecutionService;
