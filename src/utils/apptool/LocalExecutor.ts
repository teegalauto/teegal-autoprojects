/**
 * LocalExecutor - 本地代码执行器
 *
 * 封装 CpuExecutionService，执行结果自动保存到 ExecutionLog
 * 供 DesktopAppViewer 的"代码执行"按钮调用
 */

import { executeCpuTask, CpuExecutionOptions, CpuExecutionResult } from './CpuExecutionService';
import { resolveCredentialEnv, LeaseCredentialError } from './AppExecutionService';
import { getAppBasePath } from './AppPathHelper';
import { executionLogStorage, desktopAppStorage } from '@/services/storage';

export interface LocalExecuteOptions {
  code: string;
  language?: 'python' | 'node' | 'shell' | 'auto';
  timeout?: number;
  workingDir?: string;
  appId: string;
  userId: string;
  isMultiFile?: boolean;
  mainFile?: string;
}

export interface LocalExecuteResult {
  logId: string;
  success: boolean;
  output: string;
  error: string | null;
  exitCode: number | null;
  duration: number;
}

/**
 * 执行本地代码并记录日志
 */
export async function executeLocalCode(
  options: LocalExecuteOptions,
  onProgress?: (progress: { type: string; data?: string }) => void
): Promise<LocalExecuteResult> {
  const { appId, userId, language = 'auto' } = options;
  const logId = crypto.randomUUID();

  // 🔥 根据语言类型设置 execution_mode（默认值）
  let executionMode: 'python' | 'npm' | 'shell' = 'python';
  if (language === 'node') executionMode = 'npm';
  else if (language === 'shell') executionMode = 'shell';

  // 1. 创建执行日志（status=running）
  await executionLogStorage.create({
    id: logId,
    app_id: appId,
    user_id: userId,
    execution_mode: executionMode,
    command: null,
    work_dir: options.workingDir || null,
    stdout_output: null,
    stderr_output: null,
    exit_code: null,
    duration: null,
    status: 'running',
    error_message: null,
  });

  // 2. 🔥 凭据注入：与 GPU/App 执行共用 resolveCredentialEnv（扫描代码引用的环境变量名 → 匹配凭据 → 注入）
  //    多文件项目 code 可能为空（项目模式）→ 补读入口候选文件内容一起扫描
  let scanTarget = options.code || '';
  if (options.isMultiFile && !scanTarget.trim() && options.mainFile) {
    try {
      const electron = (window as any).electron;
      const basePath = await getAppBasePath(options.appId);
      const fullPath = `${basePath}\\${options.mainFile.replace(/\//g, '\\')}`;
      const r = await electron?.userpcFile?.read?.(fullPath);
      if (r?.success && r?.data?.content) scanTarget = r.data.content;
    } catch {
      // 读不到入口文件就只扫 code（可能为空 → 无注入，等同无凭据引用）
    }
  }
  let credentialEnv: Record<string, string> = {};
  try {
    credentialEnv = await resolveCredentialEnv(options.userId, scanTarget);
  } catch (e: any) {
    // 官方租约类错误（余额不足等）：直接失败并明确告知，不留 running 日志孤儿
    const msg = e instanceof LeaseCredentialError ? e.message : `凭据解析失败: ${e?.message || e}`;
    await executionLogStorage.update(logId, {
      status: 'failed',
      error_message: msg,
      duration: 0,
    });
    return { logId, success: false, output: '', error: msg, exitCode: null, duration: 0 };
  }

  // 3. 执行代码
  const cpuOptions: CpuExecutionOptions = {
    code: options.code,
    language: options.language,
    timeout: options.timeout,
    workingDir: options.workingDir,
    appId: options.appId,
    isMultiFile: options.isMultiFile,
    mainFile: options.mainFile,
    // 🔥 凭据环境变量（执行时注入，值不进 LLM）
    env: credentialEnv,
  };

  let result: CpuExecutionResult;
  try {
    result = await executeCpuTask(cpuOptions, onProgress);
  } catch (err: any) {
    // 执行异常
    await executionLogStorage.update(logId, {
      status: 'failed',
      error_message: err.message || '执行异常',
      duration: Date.now() - Date.now(), // 近似
    });
    return {
      logId,
      success: false,
      output: '',
      error: err.message || '执行异常',
      exitCode: null,
      duration: 0,
    };
  }

  // 3. 更新执行日志
  const isSuccess = result.success;
  const duration = result.executionTime || 0;

  // 🔥 根据实际执行类型更新 execution_mode
  let finalExecutionMode = executionMode;
  if (result.executionType) {
    // npm-dev, npm-start, npm-build, ts-node → npm
    // python → python
    // node → npm
    // shell → shell
    if (result.executionType.startsWith('npm') || result.executionType === 'node' || result.executionType === 'ts-node') {
      finalExecutionMode = 'npm';
    } else if (result.executionType === 'python') {
      finalExecutionMode = 'python';
    } else if (result.executionType === 'shell') {
      finalExecutionMode = 'shell';
    }
  }

  await executionLogStorage.update(logId, {
    status: isSuccess ? 'success' : 'failed',
    execution_mode: finalExecutionMode,  // 🔥 更新为实际执行类型
    stdout_output: result.output || '',
    stderr_output: result.error || '',
    exit_code: result.exitCode ?? (isSuccess ? 0 : 1),
    duration,
    error_message: isSuccess ? null : (result.error || null),
  });

  // 🔥 更新 app 的 updatedAt，使经常执行的项目排在列表前面
  try {
    await desktopAppStorage.update(appId, {});
  } catch (e) {
    // 不影响主流程
  }

  return {
    logId,
    success: isSuccess,
    output: result.output || '',
    error: result.error || null,
    exitCode: result.exitCode ?? (isSuccess ? 0 : 1),
    duration,
  };
}

/**
 * 🔥 认领 appId 在后台执行完毕的结果并补写进 executionlog
 *
 * 场景：RunDev 后项目窗口被关闭/刷新，渲染进程的更新 promise 随之丢失，
 * 计算类脚本在 main 进程后台继续跑完，结果暂存 appPendingResults；
 * 由项目窗口（DesktopAppViewer 挂载）或主窗口卡片（DesktopAppCard 轮询）调用本函数认领补写。
 *
 * 返回 true = 已认领并补写；false = 无待认领结果 / 无 running 记录（正常路径已更新过，结果丢弃）
 */
export async function claimPendingExecutionResult(appId: string): Promise<boolean> {
  const electron = (window as any).electron;
  const pending = await electron?.claimAppResult?.(appId);
  if (!pending) return false;

  const logs = await executionLogStorage.getByAppId(appId);
  const runningLog = (logs || []).find((l: any) => l.status === 'running');
  if (!runningLog) return false;

  const updates: Record<string, any> = {
    status: pending.exitCode === 0 ? 'success' : 'failed',
    stdout_output: pending.output || '',
    exit_code: pending.exitCode,
    error_message: pending.exitCode === 0 ? null : `进程在窗口关闭期间执行完毕，退出码 ${pending.exitCode}`,
  };
  // 🔥 main 进程记录的执行耗时（注册进程时记 startedAt，close 时算出），补上后列表才显示秒数
  if (pending.duration != null) updates.duration = pending.duration;

  await executionLogStorage.update(runningLog.id, updates);
  console.log(`📋 [LOCAL-EXEC] 已认领后台执行结果，补写执行记录: exitCode=${pending.exitCode}${pending.duration != null ? `, 耗时 ${(pending.duration / 1000).toFixed(1)}s` : ''}`);
  return true;
}
