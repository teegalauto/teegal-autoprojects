/**
 * User PC Tool: Execute Command (userpc_shell)
 *
 * 功能：在用户个人电脑上执行指定的命令
 *
 * 使用场景：
 * - 安装 Python 依赖包（pip install）
 * - 检查系统信息
 * - 运行简单的系统命令
 *
 * ⚠️ 请根据系统类型使用正确的 Shell 语法
 */

// ============================================================================
// 🔥 锥误消息管理模块
// ============================================================================

interface ErrorMessage {
  title: string;
  reason?: string;
  suggestion: string;
}

/**
 * 🔥 检测当前操作系统平台
 */
function getPlatform(): 'windows' | 'mac' | 'linux' {
  if (typeof navigator !== 'undefined') {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('win')) return 'windows';
    if (platform.includes('mac')) return 'mac';
  }
  return 'linux'; // 默认 Linux/Unix
}

/**
 * 🔥 获取平台相关的路径示例
 */
function getHomePathExample(): string {
  const platform = getPlatform();
  return platform === 'windows' ? 'C:\\Users\\[用户名]\\Downloads' : '~/Downloads';
}

/**
 * 🔥 获取平台相关的列目录命令
 */
function getListDirCommand(): string {
  return getPlatform() === 'windows' ? 'dir' : 'ls';
}

/**
 * 格式化错误消息
 */
function formatErrorMessage(error: ErrorMessage): string {
  return `${error.title}\n\n【问题】${error.reason}\n\n【建议】${error.suggestion}`;
}

const ErrorMessages = {
  // 参数相关错误
  MISSING_PARAMETER: (params: { hasCommandParam?: boolean; hasQueryParam?: boolean }): ErrorMessage => {
    let reason = '';
    if (params.hasCommandParam) {
      reason = 'command 参数值为空';
    } else if (params.hasQueryParam) {
      reason = 'query 参数值为空';
    } else {
      reason = '未提供 query 或 command 参数';
    }

    return {
      title: '❌ 缺少必需参数',
      reason,
      suggestion: '请使用 query 参数传递完整命令字符串'
    };
  },

  INVALID_PARAMETER_TYPE: (actualType: string): ErrorMessage => ({
    title: '❌ 参数格式错误',
    reason: `command/query 必须是字符串类型，但收到的是 ${actualType}`,
    suggestion: '请确保 query 参数是字符串，不要嵌套对象'
  }),

  // 命令复杂度错误
  COMPLEX_SCRIPT: (reason: string, suggestion: string): ErrorMessage => ({
    title: '❌ 命令格式不支持',
    reason,
    suggestion
  }),

  // 执行错误
  COMMAND_NOT_RECOGNIZED: (command?: string): ErrorMessage => {
    const isSingleWord = command && !command.includes(' ') && !command.includes('"') && !command.includes("'");
    const looksLikeDomain = command && (command.includes('.') || command.includes('huggingface') || command.includes('github'));
    const looksLikePath = command && (/^[a-zA-Z0-9_-]+$/.test(command) || command.includes('/') || command.includes('\\'));
    const looksLikeFileOrDir = command && !command.includes(' ') && (/\./.test(command) || /^[a-zA-Z0-9_-]+$/.test(command));
    
    if (isSingleWord && looksLikeDomain) {
      return {
        title: '❌ 无效的命令格式',
        reason: `"${command}" 不是一个可执行的系统命令。这看起来像一个域名或工具名称，而非完整的命令。`,
        suggestion: '请使用完整的命令格式。如果要访问网站，请使用 curl 或 python -c "import urllib.request; ..."'
      };
    }
    
    // 🔥 检测是否看起来像路径或文件名
    if (isSingleWord && (looksLikePath || looksLikeFileOrDir)) {
      return {
        title: '❌ 无效的命令格式',
        reason: `"${command}" 不是一个可执行的系统命令。这看起来像一个文件路径或目录名，而非可执行命令。`,
        suggestion: `如果要查看目录内容，请使用 ${getListDirCommand()} 命令；如果要执行文件，请使用对应的解释器`
      };
    }
    
    return {
      title: '❌ 命令无法识别',
      reason: `"${command || '未知命令'}" 不是系统内置命令，也未安装该工具`,
      suggestion: '请使用已安装的命令，或通过 python -c 执行复杂操作'
    };
  },

  FILE_NOT_FOUND: (command?: string): ErrorMessage => {
    // 🔥 检测是否包含 Teegal 平台路径
    const teegalPatterns = [
      { pattern: /\/teegal\//i, name: 'Teegal 目录' },
      { pattern: /\\teegal\\/i, name: 'Teegal 目录' },
      { pattern: /\/app\/[a-z0-9-]+/i, name: 'App 目录' },
      { pattern: /\/workspace\//i, name: 'Workspace 目录' },
      { pattern: /\/tmp\/invest_/i, name: 'Invest 临时目录' },
      { pattern: /\/tmp\/locaal-/i, name: '本地执行临时目录' },
      { pattern: /\/home\/web\//i, name: 'Home Web 目录' },
      { pattern: /C:\\.*\\teegal\\/i, name: 'Windows Teegal 目录' },
    ];

    const homePath = getHomePathExample();

    for (const { pattern, name } of teegalPatterns) {
      if (command && pattern.test(command)) {
        return {
          title: '❌ 路径范围错误',
          reason: `命令中包含 "${name}" 路径 (${command.match(pattern)?.[0]})，这是 Teegal 平台的路径，但 userpc_shell 工具只在 UserPC（用户本地电脑）上执行`,
          suggestion: `Teegal 平台和 UserPC 是两个独立的执行环境，文件不互通。

【正确做法】
1. 如果要在 Teegal 平台运行代码：使用 "apprun" 工具直接执行 App
2. 如果要在 UserPC 运行：先将文件下载到 UserPC（如 ${homePath}），或直接在 UserPC 创建文件

【示例】
- Teegal 平台运行: 使用 apprun 工具，传入 appId
- UserPC 运行 Python: 确保文件在 UserPC 本地路径（如 ${homePath}/script.py）`
        };
      }
    }

    return {
      title: '❌ 路径或文件不存在',
      reason: '指定的路径或文件不存在',
      suggestion: '请使用正确的路径格式'
    };
  },

  EXECUTION_FAILED: (exitCode: number, command?: string): ErrorMessage => {
    // 🔥 检测是否包含 Teegal 平台路径
    const teegalPatterns = [
      { pattern: /\/teegal\//i, name: 'Teegal 目录' },
      { pattern: /\\teegal\\/i, name: 'Teegal 目录' },
      { pattern: /\/app\/[a-z0-9-]+/i, name: 'App 目录' },
      { pattern: /\/workspace\//i, name: 'Workspace 目录' },
      { pattern: /\/tmp\/invest_/i, name: 'Invest 临时目录' },
      { pattern: /\/tmp\/locaal-/i, name: '本地执行临时目录' },
      { pattern: /\/home\/web\//i, name: 'Home Web 目录' },
      { pattern: /C:\\.*\\teegal\\/i, name: 'Windows Teegal 目录' },
    ];

    const homePath = getHomePathExample();
    const platform = getPlatform();
    const shellName = platform === 'windows' ? 'PowerShell' : 'Bash';

    for (const { pattern, name } of teegalPatterns) {
      if (command && pattern.test(command)) {
        return {
          title: '❌ 路径范围错误',
          reason: `命令中包含 "${name}" 路径 (${command.match(pattern)?.[0]})，这是 Teegal 平台的路径，但 userpc_shell 工具只在 UserPC（用户本地电脑）上执行`,
          suggestion: `Teegal 平台和 UserPC 是两个独立的执行环境，文件不互通。

【正确做法】
1. 如果要在 Teegal 平台运行代码：使用 "apprun" 工具直接执行 App
2. 如果要在 UserPC 运行：先将文件下载到 UserPC（如 ${homePath}），或直接在 UserPC 创建文件

【示例】
- Teegal 平台运行: 使用 apprun 工具，传入 appId
- UserPC 运行 Python: 确保文件在 UserPC 本地路径（如 ${homePath}/script.py）`
        };
      }
    }

    return {
      title: `❌ 命令执行失败（退出码: ${exitCode}）`,
      reason: '命令执行过程中发生错误，可能是语法错误或命令不存在',
      suggestion: `请检查命令语法是否正确，当前系统应使用 ${shellName} 语法`
    };
  },

  SECURITY_BLOCKED: (reason: string): ErrorMessage => ({
    title: '❌ 命令被安全系统阻止',
    reason,
    suggestion: '该命令可能存在安全风险，请手动执行或联系管理员'
  }),

  ENVIRONMENT_NOT_SUPPORTED: (): ErrorMessage => ({
    title: '❌ 当前环境不支持系统命令执行',
    reason: '系统命令执行仅在 Electron 桌面应用中可用',
    suggestion: '请在 Electron 桌面应用中使用此功能'
  })
};

// ============================================================================

export interface ExecuteCommandParams {
  command: string;           // 要执行的命令
  timeout?: number;          // 超时时间（秒），默认 1800（30分钟）
  workingDir?: string;       // 工作目录（可选）
}

export interface ExecuteCommandResult {
  success: boolean;
  message: string;
  output?: string;
  error?: string;
  exitCode?: number;
  executionTime?: number;
  isEmptyResult?: boolean;  // 🔥 标记是否为空结果（如找不到文件）
}

/**
 * 🔥 检测危险命令
 */
function detectDangerousCommand(command: string): ErrorMessage | null {
  const lowerCmd = command.toLowerCase();

  // 🔥 检测从根目录开始的递归搜索
  const dangerousPatterns = [
    // Windows 根目录递归
    { pattern: /glob\.glob\s*\(\s*['"]c:\\\\['"][^)]*recursive\s*=\s*true/i, reason: '从 C 盘根目录递归搜索会遍历整个磁盘，导致超时' },
    { pattern: /os\.path\.join\s*\(\s*['"]c:\\\\['"][^)]*\*\*/i, reason: '从 C 盘根目录开始的路径拼接可能导致全盘扫描' },
    // Linux/Mac 根目录递归
    { pattern: /glob\.glob\s*\(\s*['"]\/['"][^)]*\*\*[^)]*recursive/i, reason: '从根目录递归搜索会遍历整个文件系统，导致超时' },
    // 通用危险模式
    { pattern: /for\s+\w+\s+in\s+\[[^\]]*['"]c:\\\\['"][^\]]*\]\s*.*glob\.glob.*recursive/i, reason: '从 C 盘根目录开始递归搜索会遍历整个磁盘' },
  ];

  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(command)) {
      const examplePath = getPlatform() === 'windows'
        ? 'C:\\\\Users\\\\xxx\\\\Downloads\\\\*.txt'
        : '~/Downloads/*.txt';
      return {
        title: '❌ 危险命令被阻止',
        reason: `检测到可能导致系统卡死的操作: ${reason}`,
        suggestion: `如需查找文件，请使用已知路径或限制搜索范围（如特定目录），避免从根目录开始递归搜索。例如：glob.glob("${examplePath}")`
      };
    }
  }

  return null;
}

/**
 * 🔥 执行系统命令 - 使用 Electron IPC
 * ⚠️ 已移除所有安全检查，允许执行任意命令
 */
export async function handleExecuteCommand(
  params: ExecuteCommandParams
): Promise<ExecuteCommandResult> {
  const startTime = Date.now();
  const { command, timeout = 1800, workingDir } = params;

  // 🔥 检测危险命令
  const dangerCheck = detectDangerousCommand(command);
  if (dangerCheck) {
    return {
      success: false,
      message: formatErrorMessage(dangerCheck),
      exitCode: -1,
      executionTime: 0
    };
  }

  console.log('⚡ [EXECUTE-COMMAND-TOOL] 执行命令:', command);

  // 直接使用原始命令，不做任何转换
  
  // 4️⃣ 通过 Electron IPC 调用系统命令
  // 注意：在 Electron 环境中使用 window.electron.systemCommand
  // 在非 Electron 环境（如纯 Web 或后端）中需要其他方式
  try {

    
    // 检测是否在 Electron 环境中
    if (typeof window !== 'undefined' && (window as any).electron?.systemCommand) {
      console.log('   🔄 通过 Electron IPC 调用系统命令...');
      
      const result = await (window as any).electron.systemCommand({
        command: command,  // 🔥 使用规范化后的命令
        timeout,
        workingDir
      });
      
      const executionTime = Date.now() - startTime;
      

      
      if (result.success) {
        return {
          success: true,
          message: `✅ 命令执行成功`,
          output: result.output,
          exitCode: result.exitCode,
          executionTime
        };
      } else {
        // 🔥 分析错误并给出建议
        const errorStr = (result.error || '').toLowerCase();
        const outputStr = (result.output || '').toLowerCase();

        // 🔥 检测是否是"找不到文件"或"查询结果为空"的情况 - 这种情况应该算作成功，只是结果为空
        const isFileNotFound = errorStr.includes('找不到') ||
                               errorStr.includes('cannot find') ||
                               errorStr.includes('no such file') ||
                               errorStr.includes('file not found') ||
                               errorStr.includes('could not find files') ||
                               /�Ҳ����ļ�/.test(result.error || ''); // 乱码形式的"找不到文件"
        
        // 🔥 检测是否是语法错误（如 ./models 在 Windows 上无效）
        const isSyntaxError = errorStr.includes('语法') || 
                              errorStr.includes('syntax') ||
                              errorStr.includes('无效') ||
                              errorStr.includes('invalid');

        if (isFileNotFound && !isSyntaxError) {
          // 🔥 "找不到文件"是正常执行结果，不是错误，返回 success: true
          const emptyResultMessage = formatErrorMessage({
            title: '⚠️ 未找到匹配的文件',
            reason: `命令执行成功，但未找到符合 "${command}" 的文件或目录`,
            suggestion: '这是正常的查询结果（空结果）。请检查：1) 路径是否正确 2) 文件是否存在 3) 通配符模式是否正确'
          });

          return {
            success: true,  // 🔥 关键：返回成功，不触发重试
            message: emptyResultMessage,
            output: result.output,
            error: null,  // 清空 error，表示没有错误
            exitCode: result.exitCode,
            executionTime,
            isEmptyResult: true  // 🔥 标记为空结果
          };
        }

        let error: ErrorMessage;

        if (errorStr.includes('不是内部或外部命令') || errorStr.includes('not recognized') || errorStr.includes('��ʱ��')) {
          error = ErrorMessages.COMMAND_NOT_RECOGNIZED(command);
        } else if (command.includes('pip') && (outputStr.includes('not found') || outputStr.includes('package(s) not found'))) {
          // 🔥 pip 包不存在的情况
          error = {
            title: `❌ pip 包不存在`,
            reason: `命令 "${command}" 执行成功，但指定的包未安装`,
            suggestion: '该包可能未安装，或者名称拼写错误。你可以尝试安装它'
          };
        } else {
          error = ErrorMessages.EXECUTION_FAILED(result.exitCode, command);
        }

        return {
          success: false,
          message: formatErrorMessage(error),
          output: result.output,
          error: result.error,
          exitCode: result.exitCode,
          executionTime
        };
      }
    } else {
      // 非 Electron 环境，返回错误提示
      const error = ErrorMessages.ENVIRONMENT_NOT_SUPPORTED();
      const formattedError = formatErrorMessage(error);
      return {
        success: false,
        message: formattedError,
        error: formattedError,  // 🔥 传递完整错误信息
        executionTime: Date.now() - startTime
      };
    }
  } catch (error) {
    const executionTime = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const errorObj = ErrorMessages.EXECUTION_FAILED(1, command);
    const formattedError = formatErrorMessage({
      ...errorObj,
      reason: errorMsg
    });
    
    console.error('❌ [EXECUTE-COMMAND-TOOL] 执行异常:', error);
    
    return {
      success: false,
      message: formattedError,
      error: formattedError,  // 🔥 传递完整错误信息
      executionTime
    };
  }
}

/**
 * 执行命令工具（供 ToolHandler 调用）
 */
interface AutoStep {
  toolParams?: Record<string, any>;
  parameters?: Record<string, any>;
}

interface AutoToolResult {
  success: boolean;
  data?: any;
  error?: string | null;
  metadata?: Record<string, any>;
}

export interface ExecuteCommandProgress {
  type: 'stdout' | 'stderr' | 'start' | 'complete';
  data?: string;
  exitCode?: number;
  executionId?: string;  // 🔥 流式执行 ID，用于终止命令
}

/**
 * 🔥 根据命令类型推断超时时间
 */
function inferTimeout(command: string): number {
  const lowerCmd = command.toLowerCase();
  
  // 下载类命令 - 较长超时（10分钟）
  if (/curl|wget|download|git clone|npm install|pip install/.test(lowerCmd)) {
    return 600;
  }
  
  // 分析/处理脚本类 - 中等超时（2分钟）
  if (/python.*\.py|node.*\.js|分析|parse|analyze/.test(lowerCmd)) {
    return 120;
  }
  
  // 文件操作类 - 短超时（30秒）
  if (/read|write|cat|copy|move|remove|delete|list/.test(lowerCmd)) {
    return 30;
  }
  
  // 默认 - 中等超时（3分钟）
  return 180;
}

export async function executeExecuteCommandTool(
  step: AutoStep,
  _planId: string,
  onProgress?: (progress: ExecuteCommandProgress) => void,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  console.log('⚡ [EXECUTE-COMMAND-TOOL] 执行系统命令工具');

  const params = step.toolParams || {};

  let command = params.query || params.command;
  // 🔥 根据命令类型推断超时时间
  const inferredTimeout = command ? inferTimeout(command) : 180;
  const timeout = params.timeout || inferredTimeout;
  const workingDir = params.workingDir;
  const credentialName = params.credentialName;

  console.log('📋 [EXECUTE-COMMAND-TOOL] 参数:', {
    query: params.query,
    command: params.command,
    timeout,
    workingDir,
    credentialName
  });

  // 🔥 凭据注入：如果提供了 credentialName，通过 IPC 获取凭据并准备环境变量
  let credentialEnv: Record<string, string> | undefined;
  if (credentialName && context?.userId) {
    try {
      const electron = (window as any).electron;
      if (electron?.localStorage?.getCredentialByName) {
        const credential = await electron.localStorage.getCredentialByName(credentialName, context.userId);
        if (credential) {
          // 🔥 platform 型凭据：值由官方租约服务运行时下发（厂商临时 key），LLM 零感知
          let credValue: string;
          if (credential.source === 'platform' && credential.provider) {
            const { resolvePlatformCredential } = await import('../../services/cloud/CredentialLeaseService');
            credValue = await resolvePlatformCredential(context.userId, credential.provider);
          } else if (credential.value) {
            credValue = credential.value;
          } else {
            return {
              success: false,
              error: `凭据 "${credentialName}" 不存在或值为空`,
              metadata: { toolName: 'userpc_shell' },
            };
          }
          credentialEnv = { [credential.env_var]: credValue };
          console.log(`🔑 [EXECUTE-COMMAND-TOOL] 已注入凭据 "${credentialName}" → 环境变量 ${credential.env_var}${credential.source === 'platform' ? '（官方租约）' : ''}`);
        } else {
          return {
            success: false,
            error: `凭据 "${credentialName}" 不存在或值为空`,
            metadata: { toolName: 'userpc_shell' },
          };
        }
      }
    } catch (error: any) {
      console.error('❌ [EXECUTE-COMMAND-TOOL] 获取凭据失败:', error);
      return {
        success: false,
        error: `获取凭据 "${credentialName}" 失败: ${error.message}`,
        metadata: { toolName: 'userpc_shell' },
      };
    }
  }

  if (!command) {
    const hasCommandParam = 'command' in params;
    const hasQueryParam = 'query' in params;

    const error = ErrorMessages.MISSING_PARAMETER({ hasCommandParam, hasQueryParam });

    return {
      success: false,
      error: formatErrorMessage(error),
      metadata: {
        toolName: 'userpc_shell',
      },
    };
  }

  if (typeof command !== 'string') {
    const error = ErrorMessages.INVALID_PARAMETER_TYPE(typeof command);

    return {
      success: false,
      error: formatErrorMessage(error),
      metadata: {
        toolName: 'userpc_shell',
      },
    };
  }

  command = command.trim();

  onProgress?.({ type: 'start', data: command });

  const isElectron = typeof window !== 'undefined' && (window as any).electron?.systemCommandStream;

  return new Promise<AutoToolResult>((resolve) => {
    const outputLines: string[] = [];
    let isResolved = false;
    let cancelReason: string | null = null;
    let streamCancel: (() => void) | null = null;

    if (isElectron) {
      console.log('🖥️ [EXECUTE-COMMAND-TOOL] 使用 Electron 流式执行');
      const streamResult = executeCommandStream({
        command,
        timeout,
        workingDir,
        env: credentialEnv, // 🔥 注入凭据环境变量
        onOutput: (data) => {
          console.log('📥 [EXECUTE-COMMAND-TOOL] 收到输出:', data.type, data.data?.substring(0, 100));
          if (data.type === 'start') {
            // 🔥 命令开始执行，立即通知前端
            onProgress?.({ type: 'start', data: data.message || '命令开始执行...', executionId: streamResult.executionId });
          } else if (data.type === 'stdout' && data.data) {
            outputLines.push(data.data);
            onProgress?.({ type: 'stdout', data: data.data, executionId: streamResult.executionId });
          } else if (data.type === 'stderr' && data.data) {
            outputLines.push(`[stderr] ${data.data}`);
            onProgress?.({ type: 'stderr', data: data.data, executionId: streamResult.executionId });
          } else if (data.type === 'close') {
            if (isResolved) return;
            isResolved = true;
            const finalOutput = outputLines.join('\n');
            const isSuccess = data.exitCode === 0;

            console.log('📥 [EXECUTE-COMMAND-TOOL] close 事件:', { exitCode: data.exitCode, isSuccess, outputLines: outputLines.length });

            onProgress?.({ type: 'complete', exitCode: data.exitCode });

            // 🔥 检测是否被用户取消（exitCode 为 null 表示进程被强制终止）
            const isCancelled = data.exitCode === null || cancelReason !== null;
            console.log('📥 [EXECUTE-COMMAND-TOOL] 是否取消:', { isCancelled, exitCode: data.exitCode, cancelReason, cancelled: (data as any).cancelled });

            // 🔥 检测是否被用户取消（exitCode 为 null 或被标记为 cancelled）
            const wasCancelledByUser = isCancelled || (data as any).cancelled === true;
            if (wasCancelledByUser) {
              resolve({
                success: false,
                error: cancelReason ? `命令被用户终止: ${cancelReason}` : '命令被用户终止',
                data: {
                  type: 'terminal',
                  command,
                  outputs: outputLines,
                  exitCode: data.exitCode ?? -2,
                  executionTime: 0,
                  error: cancelReason ? `用户终止原因: ${cancelReason}` : '用户主动终止命令',
                  executionId: streamExecutionId,
                },
                metadata: {
                  toolName: 'userpc_shell',
                  cancelledByUser: true,
                  cancelReason: cancelReason || '用户主动终止'
                }
              });
              return;
            }

            resolve({
              success: isSuccess,
              error: isSuccess ? undefined : `命令执行失败（退出码: ${data.exitCode}）\n${outputLines.filter(l => l.startsWith('[stderr]')).join('\n')}`,
              data: {
                type: 'terminal',
                command,
                outputs: outputLines,
                exitCode: data.exitCode,
                executionTime: 0,
                message: isSuccess ? '命令执行成功' : `命令执行失败（退出码: ${data.exitCode}）`,
                executionId: streamExecutionId,
              },
              metadata: {
                toolName: 'userpc_shell'
              }
            });
          } else if (data.type === 'error') {
            outputLines.push(`[error] ${data.error}`);
          } else if (data.type === 'timeout') {
            if (isResolved) return;
            isResolved = true;
            resolve({
              success: false,
              error: '命令执行超时',
              data: {
                type: 'terminal',
                command,
                outputs: outputLines,
                exitCode: -1,
                executionTime: timeout * 1000,
                error: '命令执行超时',
              },
              metadata: {
                toolName: 'userpc_shell'
              }
            });
          }
        }
      });

      streamCancel = streamResult?.cancel || null;
      const streamExecutionId = streamResult?.executionId;

      setTimeout(() => {
        if (isResolved) return;
        isResolved = true;
        resolve({
          success: false,
          error: '命令执行超时',
          data: {
            type: 'terminal',
            command,
            outputs: outputLines,
            exitCode: -1,
            executionTime: timeout * 1000,
            error: '命令执行超时',
          },
          metadata: {
            toolName: 'userpc_shell'
          }
        });
      }, timeout * 1000 + 10000);
    } else {
      handleExecuteCommand({ command, timeout, workingDir }).then(async (result) => {
        resolve({
          success: result.success,
          data: {
            type: 'terminal',
            command,
            outputs: result.output ? [result.output] : [],
            exitCode: result.exitCode,
            executionTime: result.executionTime,
            message: result.message,
          },
          error: result.error,
          metadata: {
            toolName: 'userpc_shell'
          }
        });
      }).catch((error) => {
        resolve({
          success: false,
          error: String(error),
          data: {
            type: 'terminal',
            command,
            outputs: [],
            exitCode: -1,
            executionTime: 0,
            error: String(error),
          },
          metadata: {
            toolName: 'userpc_shell'
          }
        });
      });
    }
  });
}

/**
 * 🔥 流式命令执行接口
 * 支持实时输出反馈，用于长时间运行的命令（如下载、编译等）
 */
export interface StreamCommandOptions {
  command: string;
  timeout?: number;
  workingDir?: string;
  env?: Record<string, string>; // 🔥 额外环境变量（如凭据注入）
  appId?: string; // 🔥 项目 ID：main 进程按 appId 登记进程，用于重新执行时杀旧、关窗口时释放
  onOutput: (data: { type: 'start' | 'stdout' | 'stderr' | 'close' | 'error' | 'timeout'; data?: string; exitCode?: number; success?: boolean; error?: string; message?: string; timestamp: number }) => void;
}

/**
 * 🔥 流式命令执行结果
 */
export interface StreamCommandResult {
  cancel: () => void;
  executionId: string;
}

/**
 * 🔥 执行系统命令（流式输出版本）
 * 支持实时输出反馈，用于长时间运行的命令（如下载、编译等）
 * 
 * @param options - 命令选项，包含 command, timeout, workingDir, onOutput 回调
 * @returns 包含 cancel 函数和 executionId 的对象
 */
export function executeCommandStream(options: StreamCommandOptions): StreamCommandResult {
  const { command, timeout = 1800, workingDir, env, appId, onOutput } = options;

  // 生成唯一的执行 ID
  const executionId = `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log('🚀 [executeCommandStream] 开始执行:', { executionId, command: command.substring(0, 50) });

  // 检测是否在 Electron 环境中
  const electron = (window as any).electron;
  console.log('🔍 [executeCommandStream] Electron 环境检测:', { hasElectron: !!electron, hasStream: !!electron?.systemCommandStream });

  if (typeof window !== 'undefined' && electron?.systemCommandStream) {
    console.log('✅ [executeCommandStream] 调用 Electron systemCommandStream');
    const { cancel } = electron.systemCommandStream({
      command,
      timeout,
      workingDir,
      env, // 🔥 额外环境变量（凭据注入）
      executionId,
      appId, // 🔥 项目 ID：main 进程按 appId 登记（重新执行杀旧/关窗口释放）
      onOutput: (data: any) => {
        console.log('📤 [executeCommandStream] Electron 回调:', data.type);
        onOutput(data);
      }
    });

    return {
      cancel,
      executionId
    };
  } else {
    // 非 Electron 环境，返回错误
    onOutput({
      type: 'error',
      error: '流式命令执行仅在 Electron 环境中可用',
      timestamp: Date.now()
    });
    
    return {
      cancel: () => {},
      executionId
    };
  }
}

/**
 * 🔥 执行 Python 代码工具
 * 直接在用户电脑上执行 Python 代码
 */
export async function executeRunPythonTool(
  step: AutoStep,
  _planId: string,
  onProgress?: (progress: ExecuteCommandProgress) => void
): Promise<AutoToolResult> {
  console.log('⚡ [RUN-PYTHON-TOOL] 执行 Python 代码工具');

  const params = step.toolParams || {};
  const code = params.query || params.code;
  const timeout = params.timeout || 1800;

  if (!code || typeof code !== 'string') {
    return {
      success: false,
      error: '缺少 code 参数或类型不正确',
      metadata: { toolName: 'userpc_run_python' }
    };
  }

  const tempFileName = `teegal_script_${Date.now()}.py`;

  // 🔥 使用 Base64 编码避免所有 Shell 转义问题
  // 使用 btoa 进行 Base64 编码（浏览器兼容）
  const codeBase64 = btoa(unescape(encodeURIComponent(code)));

  // 🔥 跨平台适配：根据操作系统构建不同的命令
  const isWindows = navigator.platform.toLowerCase().includes('win');
  let command: string;
  let tempFilePath: string;

  if (isWindows) {
    // Windows: 使用 PowerShell 语法
    tempFilePath = `$env:TEMP\\${tempFileName}`;
    command = `Remove-Item -Path "${tempFilePath}" -ErrorAction SilentlyContinue; [System.IO.File]::WriteAllText("${tempFilePath}", [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${codeBase64}"))); python "${tempFilePath}"`;
  } else {
    // macOS/Linux: 使用 Bash 语法
    tempFilePath = `/tmp/${tempFileName}`;
    command = `rm -f "${tempFilePath}" && echo '${codeBase64}' | base64 -d > "${tempFilePath}" && python3 "${tempFilePath}"`;
  }

  console.log('📋 [RUN-PYTHON-TOOL] 执行 Python 代码:', {
    codeLength: code.length,
    timeout,
    tempFile: tempFilePath,
    platform: isWindows ? 'windows' : 'macos/linux'
  });

  onProgress?.({ type: 'start', data: `python ${tempFileName}` });

  try {
    const result = await new Promise<AutoToolResult>((resolve) => {
      const outputLines: string[] = [];
      
      const streamResult = executeCommandStream({
        command,
        timeout,
        onOutput: (data) => {
          if (data.type === 'stdout' && data.data) {
            outputLines.push(data.data);
            onProgress?.({ type: 'stdout', data: data.data });
          } else if (data.type === 'stderr' && data.data) {
            outputLines.push(`[stderr] ${data.data}`);
            onProgress?.({ type: 'stderr', data: data.data });
          } else if (data.type === 'close') {
            const hasStderr = outputLines.some(line => line.includes('[stderr]'));
            onProgress?.({ type: 'complete', exitCode: data.exitCode });
            resolve({
              success: data.exitCode === 0,
              data: {
                type: 'terminal',
                command: `python ${tempFileName}`,
                outputs: outputLines,
                exitCode: data.exitCode,
                executionTime: 0,
                message: 'Python 代码执行完成',
              },
              error: data.exitCode !== 0 
                ? `执行失败，退出码: ${data.exitCode}${hasStderr ? '。错误输出: ' + outputLines.filter(l => l.includes('[stderr]')).join('; ') : ''}` 
                : undefined,
              metadata: { toolName: 'userpc_run_python' }
            });
          } else if (data.type === 'error') {
            outputLines.push(`[error] ${data.error}`);
          }
        }
      });

      setTimeout(() => {
        resolve({
          success: false,
          error: 'Python 代码执行超时',
          data: {
            type: 'terminal',
            command: `python ${tempFileName}`,
            outputs: outputLines,
            exitCode: -1,
            executionTime: timeout * 1000,
            error: 'Python 代码执行超时',
          },
          metadata: { toolName: 'userpc_run_python' }
        });
      }, timeout * 1000 + 5000);
    });

    return result;
  } catch (error) {
    return {
      success: false,
      error: String(error),
      data: {
        type: 'terminal',
        command: `python ${tempFileName}`,
        outputs: [],
        exitCode: -1,
        executionTime: 0,
        error: String(error),
      },
      metadata: { toolName: 'userpc_run_python' }
    };
  }
}

