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
 * 🔥 工具侧自愈（shell 通道通用）：命令/可执行文件"找不到"类失败附结构化自救指引。
 * 真实案例：本机无 ffmpeg 时 manim 渲染连续 3 轮 WinError 2 原样重试，最后才想到 imageio-ffmpeg
 * ——教学错误把这类环境坑压到一轮解决。非"找不到"类失败返回空串，不膨胀其他错误回传。
 */
export function buildCommandNotFoundHint(stderrText: string): string {
  if (!stderrText) return '';
  const text = stderrText.slice(-8000);
  const winCmd = /无法将“([^”]+)”项识别为|'([^']+)' is not recognized as/.exec(text);
  // 🔥 CategoryInfo 行是纯 ASCII：PowerShell 中文报错被编码错配打成乱码时仍可命中
  const catNotFound = /ObjectNotFound: \(([^:)]+):/.exec(text);
  const nixCmd = /(?:^|\n)\s*(?:bash: |sh: )?(\S+): command not found/.exec(text);
  const pySpawn = /FileNotFoundError: \[WinError 2\]/.test(text);
  const pyCwd = /NotADirectoryError: \[WinError 267\]/.test(text);
  if (!winCmd && !nixCmd && !pySpawn && !pyCwd && !catNotFound) return '';

  const missing = winCmd?.[1] || winCmd?.[2] || nixCmd?.[1] || catNotFound?.[1] || '';
  const whichCmd = missing
    ? (getPlatform() === 'windows' ? 'where.exe ' + missing : 'which ' + missing)
    : 'where.exe / which 目标命令';

  const lines = [
    '',
    '',
    '💡 环境诊断（命令/可执行文件未找到；同一错误不要原样重试，先诊断再改命令）:',
    '1. 定位: 先跑 ' + whichCmd + ' 确认是否存在；pip 安装的工具用 pip show <包名> 看 Location',
    '2. pip 类 CLI 通常没有独立启动器，模块方式调用最稳: python -m <模块名>',
  ];
  if (pyCwd) lines.push('3. WinError 267 = cwd 指向不存在的目录: 先 os.path.exists 检查或列举父目录确认真实路径');
  return lines.join('\n');
}

/**
 * 🔥 凭据解析（userpc_shell / userpc_run_python 共用）：
 * credentialName → IPC 查凭据 → platform 型走官方租约运行时取值 → {env_var: value} 供环境变量注入
 */
async function resolveCredentialEnv(
  credentialName: string | undefined,
  userId: string | undefined
): Promise<{ env?: Record<string, string>; error?: string }> {
  if (!credentialName) return {};
  if (!userId) return { error: `传入 credentialName="${credentialName}" 但缺少用户身份，无法解析凭据` };
  try {
    const electron = (window as any).electron;
    if (!electron?.localStorage?.getCredentialByName) return {};
    const credential = await electron.localStorage.getCredentialByName(credentialName, userId);
    if (!credential) {
      return { error: `凭据 "${credentialName}" 不存在或值为空` };
    }
    let credValue: string;
    if (credential.source === 'platform' && credential.provider) {
      const { resolvePlatformCredential } = await import('../../services/cloud/CredentialLeaseService');
      credValue = await resolvePlatformCredential(userId, credential.provider);
    } else if (credential.value) {
      credValue = credential.value;
    } else {
      return { error: `凭据 "${credentialName}" 不存在或值为空` };
    }
    console.log(`🔑 [CREDENTIAL] 已注入凭据 "${credentialName}" → 环境变量 ${credential.env_var}${credential.source === 'platform' ? '（官方租约）' : ''}`);
    return { env: { [credential.env_var]: credValue } };
  } catch (error: any) {
    console.error('❌ [CREDENTIAL] 获取凭据失败:', error);
    return { error: `获取凭据 "${credentialName}" 失败: ${error.message}` };
  }
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
 * 🔥 总时长兜底（统一 30 分钟）：判死职责已移交主进程活跃度看门狗
 * （无输出 120s 判挂起，见 main.ts system:execute-command-stream）。
 * 不再按命令类型收紧总上限——那会误杀持续输出日志的渲染/训练类长任务
 * （实测 manim -qh 渲染 6 分钟被 120s 上限击杀）；挂起类由无输出阈值终止
 */
function inferTimeout(_command: string): number {
  return 1800;
}

// 🔥 原样重试短路：同一命令（空白归一化+剥掉重定向装饰后）连续失败 2 次，第 3 次执行前直接拒绝。
//    实测 chat-agent 轨迹：测试失败输出一字不差仍连跑 4 轮（含化装重试 |Out-String、*>文件），每轮零新信息纯烧轮次。
//    拦截报错强制 LLM 转向读代码/写诊断脚本定位根因；逃生口=修改命令实质（加诊断输出/调参数），
//    修改后归一化串不同自动解锁。成功即清除计数；Map 超限整表清空防泄漏。
const RETRY_FAIL_LIMIT = 2;
const _cmdFailCounts = new Map<string, number>();
const normalizeCommandForRetry = (c: string): string => c
  .replace(/\s*\|>\s*\S+|\s*>\s*\S+\s+2>&1|\s+2>&1\s*>\s*\S+|\s*\|\s*Out-String|\s*\|\s*Select-Object\s+-Last\s+\d+/gi, '')
  .replace(/\s+/g, ' ')
  .trim();
const recordCommandFailure = (cmd: string): void => {
  const key = normalizeCommandForRetry(cmd);
  _cmdFailCounts.set(key, (_cmdFailCounts.get(key) || 0) + 1);
  if (_cmdFailCounts.size > 100) _cmdFailCounts.clear();
};
const recordCommandSuccess = (cmd: string): void => {
  _cmdFailCounts.delete(normalizeCommandForRetry(cmd));
};

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

  // 🔥 凭据注入：如果提供了 credentialName，通过共用函数获取凭据并准备环境变量
  const cred = await resolveCredentialEnv(credentialName, context?.userId);
  if (cred.error) {
    return {
      success: false,
      error: cred.error,
      metadata: { toolName: 'userpc_shell' },
    };
  }
  const credentialEnv = cred.env;

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

  // 🔥 Windows 无 sshpass（Linux 工具）：短路返回平台指引——PowerShell 的 CommandNotFoundException
  //    会让 LLM 乱猜（改 paramiko / 怀疑凭据冲突），结构化指引把它一次拉回正确通道
  if (getPlatform() === 'windows' && /^\s*sshpass\s/.test(command)) {
    const msg = formatErrorMessage({
      title: '❌ Windows 没有 sshpass（这是 Linux 工具）',
      reason: 'sshpass 在 Windows 上不存在，命令无法执行',
      suggestion: `SSH 到远程机的正确方式：
1. 首选：直接写裸 ssh 命令，平台自动补公钥免密参数：ssh user@host '命令'（userpc_shell 传 credentialName=凭据名 可注入 SSHPASS）
2. 公钥未生效需密码通道时，用 plink（userpc_shell 传 credentialName=凭据名）：
   & "$env:USERPROFILE\\.teegal\\bin\\plink.exe" -ssh -batch -pw $env:SSHPASS user@host "命令"
3. 或先用 ssh_instance（action=activate / add）获取当下真实可用的命令模板`
    });
    return {
      success: false,
      error: msg,
      data: {
        type: 'terminal',
        command,
        outputs: [msg],
        exitCode: -1,
        executionTime: 0,
        error: msg,
      },
      metadata: { toolName: 'userpc_shell' },
    };
  }

  // 🔥 批量杀进程短路（两种模式）：Teegal 自身（dev/打包）就跑在 node 进程链上，LLM 写
  //    "重启=先杀旧"脚本时按 cmdline 宽匹配（如 'workbees-Qoder' in cmdline）或按端口反查爬
  //    进程树选杀目标，实测把 electron/vite/backend 全圈进去、一条脚本杀死宿主应用。
  //    python 脚本经 base64 藏在命令里，先解码再扫。组合判定：
  //    ① 脚本"进程枚举 + kill 原语"同时出现 → 短路（精确 PID kill、纯枚举查看均放行）
  //    ② 按映像名整族杀（taskkill /IM node.exe、Stop-Process -Name node）→ 一条命令灭全家，必拦
  {
    const b64 = [...command.matchAll(/FromBase64String\("([A-Za-z0-9+/=]+)"\)/g)]
      .map(m => { try { return atob(m[1]); } catch { return ''; } })
      .join('\n');
    const scan = command + '\n' + b64;
    const scriptKill = /\.kill\(\)|os\.kill\(|TerminateProcess/.test(scan)
      && /process_iter|Get-CimInstance|wmic\s+process/.test(scan);
    const nameKill = /taskkill[^&|;]*(\/IM|-IM)\s+"?(node|npm|python|electron)\.exe/i.test(scan)
      || /Stop-Process\s+(-Name|-name)\s+"?(node|npm|python|electron)"/.test(scan);
    if (scriptKill || nameKill) {
      const msg = formatErrorMessage({
        title: '❌ 批量杀进程已被拦截（自杀防护）',
        reason: '检测到"进程枚举 + kill"或"按映像名整族杀"——Teegal 应用本身就运行在 node 进程链上，宽匹配会把它自己一起杀掉（应用直接自杀关闭）',
        suggestion: `安全做法：
1. 先枚举打印候选 PID 与完整 cmdline，人工确认目标清单里不含 Teegal 自身进程
2. 用精确 PID 逐个杀（psutil.Process(pid).kill() 不受限制），禁止按 cmdline 子串宽匹配圈杀
3. 杀完打印存活列表核验，再进行后续启动步骤`
      });
      return {
        success: false,
        error: msg,
        data: {
          type: 'terminal',
          command,
          outputs: [msg],
          exitCode: -1,
          executionTime: 0,
          error: msg,
        },
        metadata: { toolName: 'userpc_shell' },
      };
    }
  }

  // 🔥 短 id 拼假路径短路：LLM 拿 8 位短 id 拼 Teegal 项目目录（apps\5677661e）——apps\ 下目录
  //    以完整 UUID（36位带连字符）命名，短 id 路径必然不存在。实测会连烧 8 轮 shell 乱猜
  //    （换目录、全盘 dir 超时），前置拦截一次拉回正道：路径从工具回执拿，别猜
  if (/apps[\\/]+[0-9a-fA-F]{1,31}(?![0-9a-fA-F-])/.test(command)) {
    const msg = formatErrorMessage({
      title: '❌ 命令中检测到「短 id 拼项目路径」（该路径必然不存在）',
      reason: 'Teegal 的 apps\\ 目录以完整 UUID（36位带连字符）命名，命令里的 8 位短 id（如 apps\\5677661e）拼出的目录不存在，执行只会反复报「找不到路径」',
      suggestion: `正确做法：
1. 项目真实本地路径从工具回执获取：list_projects 会返回 code_path
2. 文件读取/编辑用 list_project_files / read_project_file / save_project_file（projectId 传短 id 即可，自动解析完整路径）
3. 启动/执行项目用 run_project_onlocal(projectId=...)，不要用 shell 猜路径后手工拉起`
    });
    return {
      success: false,
      error: msg,
      data: {
        type: 'terminal',
        command,
        outputs: [msg],
        exitCode: -1,
        executionTime: 0,
        error: msg,
      },
      metadata: { toolName: 'userpc_shell' },
    };
  }

  // 🔥 原样重试短路：同一命令连续失败 2 次后拒绝执行（记录点在 close/timeout/非 electron 的 resolve 处）
  if ((_cmdFailCounts.get(normalizeCommandForRetry(command)) || 0) >= RETRY_FAIL_LIMIT) {
    const msg = formatErrorMessage({
      title: `❌ 同一命令已连续失败 ${RETRY_FAIL_LIMIT} 次，原样重试已被拦截`,
      reason: '该命令与上一次实质相同（仅空白/重定向装饰差异），失败输出也一致——再跑一次不会产生任何新信息，只会继续烧轮次',
      suggestion: `正确做法：
1. 失败信息已具备定位条件时：改用 read_project_file 读相关代码、或写诊断脚本打印中间状态，定位根因后修代码，再跑测试
2. 确信是偶发问题（网络抖动/端口刚释放）必须重试：请修改命令实质（加诊断输出、调整参数），修改后的命令不受此限制`
    });
    return {
      success: false,
      error: msg,
      data: {
        type: 'terminal',
        command,
        outputs: [msg],
        exitCode: -1,
        executionTime: 0,
        error: msg,
      },
      metadata: { toolName: 'userpc_shell' },
    };
  }

  // 🔥 macOS/Linux 无 plink（Windows 工具）：对称短路返回平台指引——bash 的 command not found
  //    同样会让 LLM 乱猜（装 putty / 改 paramiko），结构化指引把它一次拉回正确通道
  if (getPlatform() !== 'windows' && /^\s*plink\b/.test(command)) {
    const msg = formatErrorMessage({
      title: '❌ macOS/Linux 没有 plink（这是 Windows 工具）',
      reason: 'plink 在 macOS/Linux 上默认不存在，命令无法执行',
      suggestion: `SSH 到远程机的正确方式：
1. 首选：直接写裸 ssh 命令，平台自动补公钥免密参数：ssh user@host '命令'（userpc_shell 传 credentialName=凭据名 可注入 SSHPASS）
2. 公钥未生效需密码通道时（userpc_shell 传 credentialName=凭据名，SSHPASS 自动注入）：
   - Linux：sshpass -e ssh user@host "命令"
   - macOS：expect -c 'set timeout 30; spawn ssh user@host "命令"; expect "*assword:*" { send $env(SSHPASS)\\r; exp_continue } eof'
3. 或先用 ssh_instance（action=activate / add）获取当下真实可用的命令模板`
    });
    return {
      success: false,
      error: msg,
      data: {
        type: 'terminal',
        command,
        outputs: [msg],
        exitCode: -1,
        executionTime: 0,
        error: msg,
      },
      metadata: { toolName: 'userpc_shell' },
    };
  }

  // 🔥 SSHPASS 密码凭据 + 裸 ssh 命令防呆：ssh.exe（Windows）与 POSIX 的 ssh 都不消费 SSHPASS
  //    环境变量（那是 sshpass/plink 的机制）。公钥未生效的机器上裸 ssh 会卡在密码提示直到超时
  //    （LLM 只看到"命令执行超时"，无法自诊断）。追加 -o BatchMode=yes：公钥已生效照常成功；
  //    未生效秒败（Permission denied），失败输出里附带平台对应的密码通道模板引导自救。
  let sshPasswordGuard: { credentialName?: string; host?: string; user?: string } | null = null;
  if (
    typeof window !== 'undefined' &&
    /^ssh\s/.test(command) &&
    !/plink|sshpass|expect\b|BatchMode/i.test(command)
  ) {
    const target = command.match(/(\S+)@(\S+)/);
    // 🔥 双平台统一补 BatchMode + ConnectTimeout——公钥已生效则一次免密成功；未生效立即失败并
    //    附自救指引，不再挂满超时。
    //    -i 仅 Windows 需要（-NoProfile/服务化环境 HOME/USERPROFILE 解析不可靠，见 sshInstance.sshIdentityArg）；
    //    macOS/Linux 的 ssh 原生读取 ~/.ssh/id_* 默认私钥，不注入 -i。已带 -i 的命令不覆盖 LLM 指定的密钥。
    command = command.replace(/^ssh\s/, 'ssh -o BatchMode=yes -o ConnectTimeout=10 ');
    if (navigator.userAgent.includes('Windows')) {
      const hostIdx = target ? command.indexOf(target[0]) : -1;
      const argsPart = hostIdx > 0 ? command.slice(0, hostIdx) : command;
      if (!/\s-i\s/.test(argsPart)) {
        command = command.replace(/^ssh\s/, 'ssh -i "$env:USERPROFILE\\.ssh\\id_ed25519" ');
      }
    }
    sshPasswordGuard = target
      ? { credentialName: credentialName || undefined, user: target[1], host: target[2] }
      : { credentialName: credentialName || undefined };
    console.log(`🔑 [EXECUTE-COMMAND-TOOL] 裸 ssh → 规范化 (BatchMode${navigator.userAgent.includes('Windows') ? ' + -i' : ''})${target ? ` (${target[1]}@${target[2]})` : ''}`);
  }

  onProgress?.({ type: 'start', data: command });

  const isElectron = typeof window !== 'undefined' && (window as any).electron?.systemCommandStream;

  return new Promise<AutoToolResult>((resolve) => {
    const outputLines: string[] = [];
    let isResolved = false;
    let cancelReason: string | null = null;
    let streamCancel: (() => void) | null = null;
    const streamStartTime = Date.now(); // 🔥 timeout 路径显示实际耗时（idle 120s 被杀不该显示成总超时 1800s）

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
            // 🔥 plink 失败却报 exitCode 0（cmd /c 管道包装吃掉真实退出码）——轨迹实证三例全 0✓：
            //    "plink: 'SHA256:...' is not a valid format"（参数错）、"FATAL ERROR: Configured password was
            //    not accepted"（密码错）、"FATAL ERROR: Network error"（不可达）。plink 错误行都有
            //    "plink: "/"FATAL ERROR: " 前缀，按前缀改判，不会误伤正常 echo 输出
            const plinkAuthFailed = /\bplink\b/i.test(command)
              && outputLines.some(l => /plink: |FATAL ERROR: |Configured password was not accepted/i.test(l));
            // 🔥 假成功降级：PS5 的 CommandNotFoundException 不改退出码（exitCode 照样 0），
            //    但 && / | 链上该段之后的命令实际没执行（实测 npm install | tail -5 整条空跑却报成功）。
            //    参数绑定类同理（mvrls5kd 轨迹实证）：cmd 语法 cd /d 在 PS 下报"找不到接受实际参数"，
            //    && 链短路，后面的 npm install 整条静默跳过却报 success:true。"成功"比"失败"更毒——
            //    LLM 会跳过后续步骤。识别即降级失败并给等价命令/语法指引
            const commandNotFound = outputLines.some(l => /CommandNotFoundException|无法将".*"项识别为 cmdlet|无法将“.*”项识别为 cmdlet/i.test(l));
            const psInvocationFailed = commandNotFound
              || outputLines.some(l => /找不到接受实际参数|ParameterBindingException|PositionalParameterNotFound/i.test(l));
            const isSuccess = data.exitCode === 0 && !plinkAuthFailed && !psInvocationFailed;

            // 🔥 原样重试短路记账：成败都记（失败累计、成功清零）
            if (isSuccess) { recordCommandSuccess(command); } else { recordCommandFailure(command); }

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
                  executionTime: Date.now() - streamStartTime,
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

            // 🔥 裸 ssh 被 BatchMode 快速失败时的自救指引（有凭据给平台对应的密码通道模板，无凭据指回绑定流程）
            const guardHint = (!isSuccess && sshPasswordGuard)
              ? (sshPasswordGuard.credentialName
                ? (navigator.userAgent.includes('Windows')
                  ? `\n\n💡 SSH 密码凭据无法被 ssh 自动使用（Windows 无 sshpass，ssh 不读 SSHPASS），公钥免密未生效。两种解法：
1. plink 密码通道: & "$env:USERPROFILE\\.teegal\\bin\\plink.exe" -ssh -batch -pw $env:SSHPASS ${sshPasswordGuard.user}@${sshPasswordGuard.host} "命令" （userpc_shell 继续传 credentialName=${sshPasswordGuard.credentialName}）
2. 修复公钥免密: 在常驻面板重新绑定该机器（或 ssh_instance action=add），绑定流程会自动注入公钥`
                  : `\n\n💡 SSH 密码凭据无法被 ssh 自动使用（ssh 不读 SSHPASS 环境变量），公钥免密未生效。两种解法：
1. 密码通道（userpc_shell 继续传 credentialName=${sshPasswordGuard.credentialName}，SSHPASS 自动注入）：
   - Linux: sshpass -e ssh ${sshPasswordGuard.user}@${sshPasswordGuard.host} "命令"
   - macOS: expect -c 'set timeout 30; spawn ssh ${sshPasswordGuard.user}@${sshPasswordGuard.host} "命令"; expect "*assword:*" { send $env(SSHPASS)\\r; exp_continue } eof'
2. 修复公钥免密: 在常驻面板重新绑定该机器（或 ssh_instance action=add），绑定流程会自动注入公钥`)
                : `\n\n💡 ssh 公钥免密未生效（BatchMode 下立即失败而非挂起等密码）。解法：用 ssh_instance（action=activate 复用 / action=add 绑定）获取当下真实可用的命令模板——activate 会重新探测并自动修复公钥免密，返回的模板直接照抄，不要凭记忆拼 ssh 命令`)
              : '';
            // 🔥 命令/可执行文件"找不到"类失败：附环境诊断自救配方（工具侧自愈）
            const notFoundHint = (!isSuccess && data.exitCode !== null)
              ? buildCommandNotFoundHint(outputLines.join('\n'))
              : '';
            // 🔥 PS5 假成功降级后的等价命令指引：Unix 管道工具在 PS5 不存在
            const psNotFoundHint = commandNotFound
              ? '\n\n💡 PowerShell 5 没有 tail/head/grep/wc 等 Unix 命令（报 CommandNotFoundException，且 && / | 链上该段之后的命令实际未执行）。等价替换：tail -N → Select-Object -Last N；grep → Select-String；wc -l → (Measure-Object -Line).Lines。修正后整条重跑'
              : '';
            // 🔥 参数绑定类假成功降级后的语法指引（cmd 语法混进 PowerShell 等场景）
            const psBindingHint = (!commandNotFound && psInvocationFailed)
              ? '\n\n💡 这是 PowerShell 参数绑定错误（命令语法在该 shell 下不合法，&& 链上后续命令实际未执行）。常见错配：cmd 的 cd /d → PowerShell 直接 cd "路径"（无需 /d）；带引号的路径没加调用运算符 → & "路径" 参数。修正语法后整条重跑'
              : '';
            // 🔥 PowerShell 语法自救：带引号的可执行路径要用 & 调用（LLM 抄激活模板常丢 &，同一 ParserError 连环烧轮）
            const stderrText = outputLines.join('\n');
            const psSyntaxHint = (!isSuccess && /UnexpectedToken|意外的标记/.test(stderrText) && /^\s*["'][^"']+\.(exe|ps1|bat|cmd)["']\s+-/.test(command))
              ? '\n\n💡 PowerShell 中带引号的可执行文件路径必须用调用运算符 &：& "C:\\path\\tool.exe" 参数（直接 "路径" 参数会报"意外的标记"）'
              : (!isSuccess && /TerminatorExpectedAtEndOfString|字符串缺少终止符/.test(stderrText) && /[^\x00-\x7F]/.test(command))
              ? '\n\n💡 命令含中文/全角字符，引号被编码错配破坏。含此类字符的路径操作改用 userpc_run_python（unicode 安全，可 os.path.exists 定位真实目录）'
              : (!isSuccess && /Out-File|DirectoryNotFoundException/.test(stderrText) && command.includes('>'))
              ? '\n\n💡 远端命令里的 > 被本地 PowerShell 吞成 Out-File 了（在本地写了个不存在路径）。管道传给 plink/ssh 的整条远端命令必须放进引号内：plink host "cat > /remote/path"，远端重定向不能裸露在引号外'
              : '';
            resolve({
              success: isSuccess,
              error: isSuccess ? undefined : `命令执行失败（退出码: ${data.exitCode}）\n${outputLines.filter(l => l.startsWith('[stderr]')).join('\n')}${guardHint}${notFoundHint}${psNotFoundHint}${psBindingHint}${psSyntaxHint}`,
              data: {
                type: 'terminal',
                command,
                outputs: outputLines,
                exitCode: data.exitCode,
                executionTime: Date.now() - streamStartTime,
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
            recordCommandFailure(command); // 🔥 原样重试短路记账：超时也是失败
            // 🔥 透传主进程的区分文案：总时长超时 vs 无输出挂起终止（LLM 据此选择不同自救策略）
            const timeoutMsg = data.error || '命令执行超时';
            // 🔥 自愈指引：只讲问题 + 机制 + 怎么构建命令（不导向具体工具，shell 可能跑的并非项目内容）
            //    挂点定位真实案例：验证脚本 4 连挂各烧 120s——outputs 里"段标题已打印、结果行没来"
            //    就是挂点，LLM 却盲猜"缺网络超时"，加了定位指引后一轮可锁定
            const idleHint = timeoutMsg.includes('无输出')
              ? '\n\n💡 机制说明：命令有输出就一直等待，仅当长时间无输出才判定卡死并终止。挂点定位：看 outputs 最后一段——标题已打印但没有对应结果行 = 挂在那段里，优先排查该段的无超时网络请求（urllib/requests 显式传 timeout）和对 node_modules 等大目录的递归扫描（glob/rglob 会走几万文件，先 print 再扫或排除 node_modules）。其他常见原因：等交互输入、依赖/路径卡住、shell 里手写 python 未加 -u（平台 run_python 已自动加）。重跑前加分段打印让每步进度可见。'
              : '';
            resolve({
              success: false,
              error: timeoutMsg + idleHint,
              data: {
                type: 'terminal',
                command,
                outputs: outputLines,
                exitCode: -1,
                executionTime: Date.now() - streamStartTime,
                error: timeoutMsg + idleHint,
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
            executionTime: Date.now() - streamStartTime,
            error: '命令执行超时',
          },
          metadata: {
            toolName: 'userpc_shell'
          }
        });
      }, timeout * 1000 + 10000);
    } else {
      handleExecuteCommand({ command, timeout, workingDir }).then(async (result) => {
        // 🔥 原样重试短路记账（非 Electron 分支同样生效）
        if (result.success) { recordCommandSuccess(command); } else { recordCommandFailure(command); }
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
  onProgress?: (progress: ExecuteCommandProgress) => void,
  context?: { userId?: string }
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

  // 🔥 凭据注入：与 userpc_shell 同通道（credentialName → env_var 环境变量）。
  //    原实现无注入通道，LLM 用 paramiko 消费 SSHPASS 时拿到空值 → AuthenticationException
  //    被误判为"密码错/凭据冲突"，白白烧轮次排查
  const credentialName = params.credentialName;
  // 🔥 fail-fast：脚本用 SSH 密码认证但未传 credentialName —— SSHPASS 必为空，执行必然失败。
  //    真实案例：同一会话 7 连"0✓+仅提示"烧轮（LLM 幻觉"密码已注入"），提示拉不回来就直接拦，
  //    让"不执行+错误说明"替代"空跑假成功"
  if (!credentialName && /SSHPASS|sshpass|paramiko/i.test(code)) {
    return {
      success: false,
      error: '❌ 未执行：脚本使用 SSH 密码认证（SSHPASS/paramiko/sshpass）但未传 credentialName——SSHPASS 环境变量为空，执行必然失败。传 credentialName=凭据名 后重试（凭据名用 list_credentials 查询，SSH 密码凭据注入后变量名为 SSHPASS）',
      metadata: { toolName: 'userpc_run_python' },
    };
  }
  const cred = await resolveCredentialEnv(credentialName, context?.userId);
  if (cred.error) {
    return { success: false, error: cred.error, metadata: { toolName: 'userpc_run_python' } };
  }
  const credentialEnv = cred.env;

  // 🔥 脚本读环境变量但未传 credentialName：输出尾部附提示，把 LLM 一次拉回正确通道
  //    （真实案例：MiniMax 视频生成连环 6 轮 KeyError/NoneType，源头只是不知道能传凭据）
  //    注：SSHPASS/paramiko/sshpass 已在上面 fail-fast 拦截，这里只兜一般环境变量读取
  const sshHint = !credentialName && /os\.environ\[|os\.getenv\(/.test(code)
    ? '\n💡 提示: 脚本读取了环境变量但未传 credentialName——本工具传 credentialName=凭据名 即可将凭据注入环境变量（凭据名用 list_credentials 查询）；SSH 密码凭据注入后变量名为 SSHPASS'
    : '';

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
    // 🔥 python -u：管道模式下 stdout 默认块缓冲，脚本不退出一个字都出不来（LLM 写长循环/
    //    递归扫描时全程零输出像挂死，最后还被空闲看门狗连有用输出一起杀掉）——关缓冲实时流
    command = `Remove-Item -Path "${tempFilePath}" -ErrorAction SilentlyContinue; [System.IO.File]::WriteAllText("${tempFilePath}", [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${codeBase64}"))); python -u "${tempFilePath}"`;
  } else {
    // macOS/Linux: 使用 Bash 语法
    tempFilePath = `/tmp/${tempFileName}`;
    command = `rm -f "${tempFilePath}" && echo '${codeBase64}' | base64 -d > "${tempFilePath}" && python3 -u "${tempFilePath}"`;
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

      // 🔥 渲染层第二道空闲判死：只杀"不动的"（150s 无任何输出），在动的永不误杀。
      //    正常时主进程 120s 空闲看门狗先开火并发 timeout 事件（本函数已处理），此定时器
      //    仅在事件丢失/taskkill 失败/close 不来时兜底；有输出就续期
      let rendererIdle: ReturnType<typeof setTimeout> | undefined;
      const armRendererIdle = () => {
        if (rendererIdle) clearTimeout(rendererIdle);
        rendererIdle = setTimeout(() => {
          try { streamResult.cancel(); } catch { /* 已结束则忽略 */ }
          resolve({
            success: false,
            error: '命令 150s 无输出，判定挂起，已被本地兜底终止',
            data: {
              type: 'terminal',
              command: `python ${tempFileName}`,
              outputs: [...outputLines, '[timeout] 本地兜底：150s 无输出，判定挂起已中止'],
              exitCode: -1,
              executionTime: Date.now() - pyStartTime,
              executionId: streamResult.executionId,
            },
            metadata: { toolName: 'userpc_run_python' }
          });
        }, 150000);
      };

      // 🔥 实际耗时：正常完成/被杀路径都报真实 elapsed（此前全部硬编码 0，UI 时间列无效）
      const pyStartTime = Date.now();
      const streamResult = executeCommandStream({
        command,
        timeout,
        env: credentialEnv, // 🔥 注入凭据环境变量（与 userpc_shell 同通道）
        onOutput: (data) => {
          // 🔥 进度事件携带 executionId：前端流式卡片的"终止"按钮依赖它发 system:cancel-command
          //    （userpc_shell 一路都带，本工具此前全程漏带 → run_python 执行中无法手工终止）
          if (data.type === 'start') {
            // start 即首推：静默脚本（python 未开 -u 时代/纯 sleep）也能立刻出现带终止按钮的卡片
            onProgress?.({ type: 'start', data: '命令开始执行...', executionId: streamResult.executionId });
            armRendererIdle();
          } else if (data.type === 'stdout' && data.data) {
            outputLines.push(data.data);
            onProgress?.({ type: 'stdout', data: data.data, executionId: streamResult.executionId });
            armRendererIdle(); // 🔥 有输出就续期：在动的永不误杀
          } else if (data.type === 'stderr' && data.data) {
            outputLines.push(`[stderr] ${data.data}`);
            onProgress?.({ type: 'stderr', data: data.data, executionId: streamResult.executionId });
            armRendererIdle(); // 🔥 有输出就续期：在动的永不误杀
          } else if (data.type === 'close') {
            if (rendererIdle) clearTimeout(rendererIdle);
            const hasStderr = outputLines.some(line => line.includes('[stderr]'));
            if (sshHint) outputLines.push(sshHint);
            onProgress?.({ type: 'complete', exitCode: data.exitCode });
            resolve({
              success: data.exitCode === 0,
              data: {
                type: 'terminal',
                command: `python ${tempFileName}`,
                outputs: outputLines,
                exitCode: data.exitCode,
                executionTime: Date.now() - pyStartTime,
                message: 'Python 代码执行完成',
                executionId: streamResult.executionId,
              },
              error: data.exitCode !== 0
                ? `执行失败，退出码: ${data.exitCode}${hasStderr ? '。错误输出: ' + outputLines.filter(l => l.includes('[stderr]')).join('; ') : ''}${buildCommandNotFoundHint(outputLines.join('\n'))}`
                : undefined,
              metadata: { toolName: 'userpc_run_python' }
            });
          } else if (data.type === 'timeout') {
            if (rendererIdle) clearTimeout(rendererIdle);
            // 🔥 主进程空闲看门狗开火回执：killTree 异步、close 可能延迟——渲染层立即按超时
            //    落账弃轮，绝不等 close（此前该事件被 switch 静默忽略，看门狗杀了进程渲染层
            //    也不知道，干等到自己的兜底超时）
            outputLines.push(`[timeout] ${data.error || '命令无输出，已被看门狗终止'}`);
            onProgress?.({ type: 'complete', exitCode: -1, executionId: streamResult.executionId });
            resolve({
              success: false,
              error: data.error || '命令无输出，已被看门狗终止',
              data: {
                type: 'terminal',
                command: `python ${tempFileName}`,
                outputs: outputLines,
                exitCode: -1,
                executionTime: Date.now() - pyStartTime,
                executionId: streamResult.executionId,
              },
              metadata: { toolName: 'userpc_run_python' }
            });
          } else if (data.type === 'error') {
            outputLines.push(`[error] ${data.error}`);
          }
        }
      });

      armRendererIdle(); // 🔥 启动即武装：覆盖"零输出直接挂死"场景（此前硬顶 timeout 秒会误杀在动的长任务）

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

