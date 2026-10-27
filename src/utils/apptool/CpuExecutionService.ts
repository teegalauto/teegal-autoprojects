/**
 * CPU Execution Service
 * 🔥 前端直接执行 CPU 任务 - 简单直接，像 userpc_run_python 一样
 * 
 * 特点：
 * - 直接通过 Electron shell 执行，不包装用户代码
 * - 支持 Python、Node、Shell 等多种命令
 * - 简单直接，不自动捕获 charts/files
 * - 🔥 支持多文件项目：直接使用项目目录作为工作目录
 */

import { executeCommandStream } from "@/utils/systemtools/executeCommand";
import { ProjectFile } from './ProjectPackager';
import { getAppBasePath } from './AppPathHelper';

export interface CpuExecutionOptions {
  code: string;
  language?: 'python' | 'node' | 'shell' | 'auto';
  timeout?: number;
  workingDir?: string;
  appId?: string;
  userId?: string;
  // 🔥 新增：多文件支持
  isMultiFile?: boolean;
  projectFiles?: ProjectFile[];
  mainFile?: string;
  /** 🔥 凭据环境变量（执行时注入，值不进 LLM） */
  env?: Record<string, string>;
}

export interface CpuExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  exitCode?: number;
  // 🔥 新增：实际执行类型（python, node, npm-dev 等）
  executionType?: 'python' | 'node' | 'npm-dev' | 'npm-start' | 'npm-build' | 'ts-node' | 'shell';
}

interface StreamOutput {
  type: 'stdout' | 'stderr' | 'close' | 'error' | 'start' | 'timeout';
  data?: string;
  exitCode?: number;
  error?: string;
  success?: boolean;
  message?: string;
  timestamp?: number;
}

/**
 * 🔥 平台判定：Windows → PowerShell 语法（$env:TEMP / .ps1），
 * macOS/Linux → bash 语法（/tmp、base64 -d、python3）。preload 暴露 process.platform
 */
const isWinPlatform = (): boolean => (window as any).electron?.platform === 'win32';

/**
 * 🔥 检测代码语言
 */
function detectLanguage(code: string): 'python' | 'node' | 'shell' {
  const trimmed = code.trim();

  // 根据 shebang 检测
  if (trimmed.startsWith('#!/usr/bin/env python') ||
      trimmed.startsWith('#!/usr/bin/python')) {
    return 'python';
  }
  if (trimmed.startsWith('#!/usr/bin/env node')) {
    return 'node';
  }

  // 🔥 按行匹配（而非只看第一行）：python/node 脚本常以注释或 docstring 开头，
  // 只看开头会把它们误判为 shell → 写 .sh 临时文件 → Windows 弹"选择打开方式"
  const pyMatch = /^\s*(import |from |def |class |print\()/m.test(trimmed);
  if (pyMatch) {
    return 'python';
  }

  const nodeMatch = /^\s*(const |let |var |require\(|function |async |export )/m.test(trimmed);
  if (nodeMatch) {
    return 'node';
  }

  return 'shell';
}

/**
 * 🔥 剥离 ANSI 颜色/控制码（Vite 等工具的彩色输出直接显示会变成 [32m[1m 之类的乱码）
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * 🔥 释放 appId 的后台服务进程（关闭项目窗口时调用）
 * 进程注册表在 main 进程（不受渲染窗口刷新/重载影响）：
 * - 服务类（dev server，检测到访问地址后脱管常驻）→ 杀整棵进程树
 * - 计算类（main.py 推理等）→ 自己跑完已退出，main 侧登记已清理，此调用无操作
 */
export function stopAppService(appId?: string): void {
  if (!appId) return;
  (window as any).electron?.stopAppService?.(appId);
}

/**
 * 🔥 从（滚动缓冲的）stdout 中检测开发服务器地址
 * - Vite: "  ➜  Local:   `http://localhost:5173/`"（⚠️ URL 包在反引号里）
 * - Webpack: "Project is running at http://localhost:8080"
 * - Streamlit: "Local URL: http://localhost:8501" / Gradio: "Running on local URL: http://127.0.0.1:7860"
 * ⚠️ 必须传入跨 chunk 拼接的缓冲区：stdout 分片边界任意，
 * Vite 的 URL 常被拆成 "http://local" + "host:8082/" 两个 chunk，逐 chunk 匹配会漏检。
 * 同时剥离 ANSI 颜色码，避免颜色码插在 URL 中间导致漏检。
 */
function detectServerUrl(buffer: string): string | null {
  const clean = stripAnsi(buffer).replace(/\r/g, '');
  // 带 "Local:" 标签的（Vite/Streamlit），兼容反引号/引号包裹
  const labeled = clean.match(/Local:\s*[`'"]?(https?:\/\/[^\s`'"]+)/i);
  if (labeled) return labeled[1];
  // 直接输出 localhost 地址的（Flask/Gradio/普通 print）
  const direct = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i);
  return direct ? direct[0] : null;
}

/**
 * 🔥 核心执行函数 - 简单直接，不包装代码
 */
export async function executeCpuTask(
  options: CpuExecutionOptions,
  onProgress?: (progress: { type: string; data?: string }) => void
): Promise<CpuExecutionResult> {
  const startTime = Date.now();
  const {
    code,
    language = 'auto',
    timeout = 1800,
    workingDir,
    appId,
    isMultiFile = false,
    projectFiles = [],
    mainFile = 'main.py',
    env,
  } = options;

  // 🔥 多文件项目：直接使用项目目录作为工作目录
  if (isMultiFile && appId) {
    return await executeMultiFileProject(appId, mainFile, timeout, onProgress, env);
  }

  // 🔥 单文件：原有逻辑
  const detectedLang = language === 'auto' ? detectLanguage(code) : language;

  // 生成临时文件名
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substr(2, 9);
  let tempFileName: string;
  let command: string;

  const isWin = isWinPlatform();

  switch (detectedLang) {
    case 'python':
      tempFileName = `teegal_${timestamp}_${randomId}.py`;
      break;
    case 'node':
      tempFileName = `teegal_${timestamp}_${randomId}.js`;
      break;
    default:
      // 🔥 shell 多行代码：Windows（PowerShell）下必须用 .ps1（.sh 会被 Windows 当成
      // 无关联文件 → `&` 调用时弹出"选择用什么应用打开"）；macOS/Linux 用 .sh 交 bash 执行
      tempFileName = `teegal_${timestamp}_${randomId}.${isWin ? 'ps1' : 'sh'}`;
  }

  const tempFilePath = isWin ? `$env:TEMP\\${tempFileName}` : `/tmp/${tempFileName}`;

  // 使用 Base64 编码避免转义问题
  const codeBase64 = btoa(unescape(encodeURIComponent(code)));

  // 构建命令：写入文件 -> 执行
  if (isWin) {
    if (detectedLang === 'python') {
      command = `Remove-Item -Path "${tempFilePath}" -ErrorAction SilentlyContinue; [System.IO.File]::WriteAllText("${tempFilePath}", [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${codeBase64}"))); python "${tempFilePath}"`;
    } else if (detectedLang === 'node') {
      command = `Remove-Item -Path "${tempFilePath}" -ErrorAction SilentlyContinue; [System.IO.File]::WriteAllText("${tempFilePath}", [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${codeBase64}"))); node "${tempFilePath}"`;
    } else {
      // Shell 模式 - 直接执行代码作为命令
      // 如果是多行，先写入 .ps1 再执行（执行环境是 PowerShell）
      if (code.includes('\n')) {
        command = `Remove-Item -Path "${tempFilePath}" -ErrorAction SilentlyContinue; [System.IO.File]::WriteAllText("${tempFilePath}", [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${codeBase64}"))); powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFilePath}"`;
      } else {
        // 单行命令直接执行
        command = code;
      }
    }
  } else {
    // 🔥 macOS/Linux：bash 语法，base64 解码写文件后执行
    // （python3：macOS 12+ 不自带 python 命令；base64 -d 在 macOS/Linux 通用）
    const writeCmd = `printf '%s' '${codeBase64}' | base64 -d > "${tempFilePath}"`;
    if (detectedLang === 'python') {
      command = `rm -f "${tempFilePath}"; ${writeCmd}; python3 "${tempFilePath}"`;
    } else if (detectedLang === 'node') {
      command = `rm -f "${tempFilePath}"; ${writeCmd}; node "${tempFilePath}"`;
    } else if (code.includes('\n')) {
      command = `rm -f "${tempFilePath}"; ${writeCmd}; bash "${tempFilePath}"`;
    } else {
      // 单行命令直接执行
      command = code;
    }
  }

  onProgress?.({ type: 'start', data: `${detectedLang} ${tempFileName}` });

  // 执行命令
  return new Promise((resolve) => {
    const outputLines: string[] = [];
    let exitCode = 0;
    // 🔥 检测到的服务地址（草稿代码里起 Flask/Streamlit 等服务时提前结束 Run 状态）
    let detectedUrl: string | null = null;
    // 🔥 跨 chunk 滚动缓冲区：stdout 分片边界任意，URL 可能被拆开，拼接后检测
    let urlDetectBuffer = '';

    const streamHandle = executeCommandStream({
      command,
      timeout,
      workingDir,
      env, // 🔥 凭据环境变量注入
      appId, // 🔥 main 进程按 appId 登记进程：重新执行时杀旧、关窗口时释放
      onOutput: (data: StreamOutput) => {
        if (data.type === 'stdout' && data.data) {
          const cleanData = stripAnsi(data.data); // 🔥 剥离 ANSI 颜色码，避免日志乱码
          outputLines.push(cleanData);
          onProgress?.({ type: 'stdout', data: cleanData });

          // 🔥 与项目模式同一规则：脚本打印 localhost 地址 = 服务器类进程（不会退出）
          // → 检测到即"启动成功"，提前 resolve；普通脚本不打印 → 仍等退出返回完整结果
          if (!detectedUrl && (detectedLang === 'python' || detectedLang === 'node')) {
            urlDetectBuffer = (urlDetectBuffer + cleanData).slice(-400);
            const url = detectServerUrl(urlDetectBuffer);
            if (url) {
              detectedUrl = url;
              console.log(`🎯 [CPU-EXEC] 检测到服务地址: ${url}，1.5s 后提前结束 Run 状态（进程继续后台运行）`);
              onProgress?.({ type: 'url', data: detectedUrl });
              // 🔥 服务器类进程脱管：取消超时看门狗，常驻运行到用户关窗口/重新 Run 才终止
              (window as any).electron?.send?.('system:detach-command', { executionId: streamHandle.executionId });
              setTimeout(() => {
                resolve({
                  success: true,
                  output: outputLines.join('\n') + `\n\n✅ 服务已启动: ${detectedUrl}`,
                  executionTime: Date.now() - startTime,
                  exitCode: 0,
                  executionType: detectedLang,
                });
              }, 1500);
            }
          }
        } else if (data.type === 'stderr' && data.data) {
          outputLines.push(`[stderr] ${data.data}`);
          onProgress?.({ type: 'stderr', data: data.data });
        } else if (data.type === 'close') {
          exitCode = data.exitCode || 0;
          onProgress?.({ type: 'complete', data: `Exit code: ${exitCode}` });

          resolve({
            success: exitCode === 0,
            output: outputLines.join('\n'),
            error: exitCode !== 0 ? `执行失败，退出码: ${exitCode}` : undefined,
            executionTime: Date.now() - startTime,
            exitCode,
            executionType: detectedLang,  // 🔥 单文件执行使用 detectedLang
          });
        } else if (data.type === 'error') {
          outputLines.push(`[error] ${data.error}`);
        }
      }
    });

    // 超时处理
    setTimeout(() => {
      resolve({
        success: false,
        error: '执行超时',
        output: outputLines.join('\n'),
        executionTime: Date.now() - startTime,
        exitCode: -1,
        executionType: detectedLang,  // 🔥 单文件执行使用 detectedLang
      });
    }, timeout * 1000 + 5000);
  });
}

/**
 * 🔥 执行指定目录下的命令（如 npm run build）
 */
export async function executeCommandInDir(
  command: string,
  workingDir: string,
  options?: {
    timeout?: number;
    env?: Record<string, string>;
  },
  onProgress?: (progress: { type: string; data?: string }) => void
): Promise<CpuExecutionResult> {
  const startTime = Date.now();
  const timeout = options?.timeout || 1800;

  // 构建环境变量（🔥 Windows → PowerShell $env: 前缀；macOS/Linux → bash 命令级前缀）
  let fullCommand = command;
  if (options?.env && Object.keys(options.env).length > 0) {
    const entries = Object.entries(options.env);
    if (isWinPlatform()) {
      const envVars = entries
        .map(([key, value]) => `$env:${key} = "${value}"`)
        .join('; ');
      fullCommand = `${envVars}; ${command}`;
    } else {
      const envVars = entries
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
      fullCommand = `${envVars} ${command}`;
    }
  }

  onProgress?.({ type: 'start', data: command });

  return new Promise((resolve) => {
    const outputLines: string[] = [];

    executeCommandStream({
      command: fullCommand,
      timeout,
      workingDir,
      onOutput: (data: StreamOutput) => {
        if (data.type === 'stdout' && data.data) {
          outputLines.push(data.data);
          onProgress?.({ type: 'stdout', data: data.data });
        } else if (data.type === 'stderr' && data.data) {
          outputLines.push(`[stderr] ${data.data}`);
          onProgress?.({ type: 'stderr', data: data.data });
        } else if (data.type === 'close') {
          const exitCode = data.exitCode || 0;
          onProgress?.({ type: 'complete', data: `Exit code: ${exitCode}` });
          
          resolve({
            success: exitCode === 0,
            output: outputLines.join('\n'),
            error: exitCode !== 0 ? `执行失败，退出码: ${exitCode}` : undefined,
            executionTime: Date.now() - startTime,
            exitCode
          });
        }
      }
    });

    setTimeout(() => {
      resolve({
        success: false,
        error: '执行超时',
        output: outputLines.join('\n'),
        executionTime: Date.now() - startTime,
        exitCode: -1
      });
    }, timeout * 1000 + 5000);
  });
}

/**
 * 🔥 检查本地 Python 是否可用
 */
export async function checkPythonAvailability(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    let output = '';
    
    executeCommandStream({
      // 🔥 macOS 12+ 不自带 python 命令，POSIX 检测 python3
      command: isWinPlatform() ? 'python --version' : 'python3 --version',
      timeout: 10,
      onOutput: (data: StreamOutput) => {
        if (data.type === 'stdout' && data.data) {
          output += data.data;
        } else if (data.type === 'close') {
          const versionMatch = output.match(/Python\s+(\d+\.\d+\.\d+)/);
          resolve({
            available: data.exitCode === 0,
            version: versionMatch ? versionMatch[1] : undefined
          });
        }
      }
    });

    setTimeout(() => {
      resolve({ available: false });
    }, 5000);
  });
}

/**
 * 🔥 检查 npm/Node 是否可用
 */
export async function checkNpmAvailability(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    let output = '';
    
    executeCommandStream({
      command: 'npm --version',
      timeout: 10,
      onOutput: (data: StreamOutput) => {
        if (data.type === 'stdout' && data.data) {
          output += data.data;
        } else if (data.type === 'close') {
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          resolve({
            available: data.exitCode === 0,
            version: versionMatch ? versionMatch[1] : undefined
          });
        }
      }
    });

    setTimeout(() => {
      resolve({ available: false });
    }, 5000);
  });
}

/**
 * 🔥 检测环境可用性（根据命令类型）
 * @param commandType 命令类型：python, node, npm-dev, npm-start 等
 * @returns 检测结果和下载链接
 */
export async function checkEnvironmentAvailability(commandType: string): Promise<{
  available: boolean;
  name: string;
  downloadUrl: string;
}> {
  if (commandType === 'python') {
    const result = await checkPythonAvailability();
    return {
      available: result.available,
      name: 'Python',
      downloadUrl: 'https://www.python.org/downloads/',
    };
  }
  
  if (commandType.startsWith('node') || commandType.startsWith('npm') || commandType === 'ts-node') {
    const result = await checkNpmAvailability();
    return {
      available: result.available,
      name: 'Node.js',
      downloadUrl: 'https://nodejs.org/en/download/',
    };
  }
  
  // 默认认为可用
  return { available: true, name: '', downloadUrl: '' };
}

/**
 * 🔥 检查 Node.js 是否可用
 */
export async function checkNodeAvailability(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    let output = '';
    
    executeCommandStream({
      command: 'node --version',
      timeout: 10,
      onOutput: (data: StreamOutput) => {
        if (data.type === 'stdout' && data.data) {
          output += data.data;
        } else if (data.type === 'close') {
          const versionMatch = output.match(/v(\d+\.\d+\.\d+)/);
          resolve({
            available: data.exitCode === 0,
            version: versionMatch ? versionMatch[1] : undefined
          });
        }
      }
    });

    setTimeout(() => {
      resolve({ available: false });
    }, 5000);
  });
}

/**
 * 🔥 执行多文件项目
 * 智能检测项目类型：
 * - 有 package.json 且有 scripts.dev/start → npm run dev/start
 * - Python 文件 → python
 * - Node/TS 文件 → node/npx ts-node
 */
async function executeMultiFileProject(
  appId: string,
  mainFile: string,
  timeout: number,
  onProgress?: (progress: { type: string; data?: string }) => void,
  env?: Record<string, string> // 🔥 凭据环境变量（执行时注入）
): Promise<CpuExecutionResult> {
  const startTime = Date.now();
  const electron = (window as any).electron;

  // 🔥 获取用户数据路径
  let userDataPath = '';
  if (electron?.getUserDataPath) {
    userDataPath = await electron.getUserDataPath();
    if (userDataPath.endsWith('\\dev') || userDataPath.endsWith('/dev')) {
      userDataPath = userDataPath.slice(0, -4);
    }
  }

  if (!userDataPath) {
    return {
      success: false,
      error: '无法获取用户数据路径',
      executionTime: 0,
    };
  }

  // 🔥 项目目录（支持导入项目的自定义路径）
  const projectDir = await getAppBasePath(appId);

  // 🔥 入口自动探测：执行语义是"执行整个项目"，mainFile 只是候选参考。
  // UI 场景下 mainFile 是"当前浏览的文件"（用户可能只是在看 .env.example，或浏览代码刚生成的视频/图片），
  // 不可靠；当 mainFile 不存在或不可执行时，按优先级扫描项目根目录找真实入口
  // ⚠️ 拦截策略：只对"入口候选"把关，项目里的其他内容（生成的媒体等）永远不参与执行也不拦截
  let effectiveMainFile = mainFile;
  const fileExists = async (p: string): Promise<boolean> => {
    try {
      const r = await electron?.userpcFile?.read?.(p);
      return !!r?.success;
    } catch (e) {
      return false;
    }
  };

  // 🔥 非可执行扩展名（文档/配置/媒体/二进制等，不能作为程序入口）
  const NON_EXECUTABLE_EXTS = [
    // 文档/数据/配置
    'md', 'txt', 'rst', 'log', 'csv', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'env', 'lock', 'example', 'sample', 'template', 'pdf',
    // 图片/视频/音频（代码生成的素材不是入口）
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico',
    'mp4', 'webm', 'mov', 'avi', 'mkv', 'flv',
    'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac',
    // 二进制/压缩包/办公文档
    'exe', 'dll', 'so', 'dylib', 'pyc', 'pyd',
    'zip', 'rar', '7z', 'tar', 'gz',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  ];

  // 🔥 mainFile「不可执行」也触发入口探测：浏览生成视频时按 Run，应自动找到 main.py 执行，
  // 而不是拒绝报错（否则与注释声明的"不可执行时扫描真实入口"意图矛盾）
  const mainFileExt = mainFile?.split('.').pop()?.toLowerCase() || '';
  const mainFileExecutable = !!mainFile && mainFileExt !== '' && !NON_EXECUTABLE_EXTS.includes(mainFileExt);
  // 🔥 路径拼接按平台选分隔符（Mac/Linux 用 /，Windows 用 \）——硬编码 \ 会让
  // macOS 上 fileExists 永远失败 → 入口探测失效 → 多文件项目无法运行
  const sep = isWinPlatform() ? '\\' : '/';
  const joinPath = (name: string) => `${projectDir}${sep}${name}`;
  const mainFileOk = mainFileExecutable && await fileExists(joinPath(mainFile));
  if (!mainFileOk) {
    // 🔥 按惯例优先级探测入口（根目录 → 常见子目录 src/）
    const ENTRY_CANDIDATES = [
      'main.py', 'app.py', 'run.py', 'server.py', 'manage.py', 'cli.py', 'index.py',
      'index.js', 'index.mjs', 'app.js', 'server.js', 'main.js',
      'index.ts', 'app.ts', 'main.ts',
      'src/main.py', 'src/app.py', 'src/main.js', 'src/app.js', 'src/index.js', 'src/index.ts',
    ];
    let detected: string | null = null;
    for (const candidate of ENTRY_CANDIDATES) {
      if (await fileExists(joinPath(candidate))) {
        detected = candidate;
        break;
      }
    }
    if (detected) {
      effectiveMainFile = detected;
      console.log(`🔥 [RUN-LOCAL] mainFile「${mainFile || '(空)'}」无效，自动探测到项目入口: ${detected}`);
    }
    // 探测不到就保留原 mainFile 走后面的非可执行拦截（给出明确错误）
  }

  const mainFilePath = joinPath(effectiveMainFile);

  // 🔥 构建执行命令
  let command: string;
  let commandType: string;

  // 🔥 优先检测 package.json（Node/npm 项目）
  try {
    const packageJsonPath = joinPath('package.json');
    const packageJsonResult = await electron?.userpcFile?.read?.(packageJsonPath);
    
    if (packageJsonResult?.success && packageJsonResult?.data?.content) {
      const packageJson = JSON.parse(packageJsonResult.data.content);

      // 🔥 优先使用 npm scripts
      if (packageJson.scripts?.dev) {
        command = 'npm run dev';
        commandType = 'npm-dev';
      } else if (packageJson.scripts?.start) {
        command = 'npm run start';
        commandType = 'npm-start';
      } else if (packageJson.scripts?.build) {
        command = 'npm run build';
        commandType = 'npm-build';
      }
    }
  } catch (err) {
    // 无 package.json 或解析失败，按文件扩展名处理
  }

  // 🔥 如果没有 npm script，按文件扩展名处理
  if (!command) {
    const ext = effectiveMainFile.split('.').pop()?.toLowerCase();

    // 🔥 非可执行文件直接拒绝（此前会兜底当 python 跑，README.md/.env.example/图片传进来就报 SyntaxError，误导排查方向）
    // 注意走到这里说明 mainFile 经过入口探测仍不可执行，说明整个项目都没有可识别的入口
    if (NON_EXECUTABLE_EXTS.includes(ext || '') || !ext) {
      return {
        success: false,
        error: `无法确定项目入口：项目根目录没有 package.json，也未探测到 main.py/app.py/run.py/index.js 等常见入口文件——真实项目很可能在子目录（或尚未创建）。
下一步（不要逐个读取根目录文件确认，根目录已确认没有入口）：
1. list_project_files 看文件树，定位含 package.json 或入口文件的子目录
2. 用 userpc_shell 进入该子目录拉起（如 cd <子目录> && npm run dev）
3. 或 run_project_onlocal(projectId, mainFile='子目录/入口文件') 传完整相对路径指定入口`,
        executionTime: Date.now() - startTime,
      };
    }

    // 🔥 macOS 12+ 不自带 python 命令，POSIX 统一用 python3
    const pythonBin = isWinPlatform() ? 'python' : 'python3';
    if (ext === 'py') {
      command = `${pythonBin} "${mainFilePath}"`;
      commandType = 'python';
    } else if (ext === 'js' || ext === 'mjs') {
      command = `node "${mainFilePath}"`;
      commandType = 'node';
    } else if (ext === 'ts') {
      command = `npx ts-node "${mainFilePath}"`;
      commandType = 'ts-node';
    } else {
      // 🔥 未知扩展名禁止兜底当 python 跑：猜错类型只会产出莫名 SyntaxError 或卡死，
      // 且执行日志被打上 python 标误导排查。明确报错让上层选对执行方式（run_project_onlocal
      // 指定 mainFile / userpc_shell 进项目目录手工拉起）。
      return {
        success: false,
        error: `无法识别的项目入口「${effectiveMainFile}」(.${ext})。可执行类型：.py/.js/.mjs/.ts，或项目根目录带 package.json（scripts.dev/start/build 自动识别）。若项目入口在子目录或需多服务启动，请用 userpc_shell 进入项目目录手工拉起。`,
        executionTime: Date.now() - startTime,
      };
    }
  }

  // 🔥 检测环境是否可用
  const envCheck = await checkEnvironmentAvailability(commandType);
  if (!envCheck.available) {
    const errorMsg = `电脑未安装 ${envCheck.name}，无法执行。\n下载地址: ${envCheck.downloadUrl}`;
    return {
      success: false,
      error: errorMsg,
      executionTime: 0,
      executionType: commandType as any,  // 🔥 返回执行类型
    };
  }

  onProgress?.({ type: 'start', data: `执行 ${commandType === 'python' ? mainFile : command}` });

  // 🔥 执行命令
    return new Promise((resolve) => {
      const outputLines: string[] = [];
      let detectedUrl: string | null = null;  // 🔥 检测到的 URL
      // 🔥 跨 chunk 滚动缓冲区：stdout 分片边界任意（Vite 的 URL 常被拆成
      // "http://local" + "host:8082/" 两个 chunk），拼接后检测才不漏
      let urlDetectBuffer = '';

      const streamHandle = executeCommandStream({
        command,
        timeout,
        workingDir: projectDir,  // 🔥 使用项目目录作为工作目录
        env, // 🔥 凭据环境变量注入
        appId, // 🔥 main 进程按 appId 登记进程：重新执行时杀旧、关窗口时释放
        onOutput: (data: StreamOutput) => {
          if (data.type === 'stdout' && data.data) {
            const cleanData = stripAnsi(data.data); // 🔥 剥离 ANSI 颜色码，避免日志乱码
            outputLines.push(cleanData);
            onProgress?.({ type: 'stdout', data: cleanData });

            // 🔥 检测开发服务器 URL（npm run dev / python web 服务输出）
            // Vite: "Local:   `http://localhost:5173/`"（URL 包在反引号里）
            // Webpack: "Project is running at http://localhost:8080"
            // Streamlit: "Local URL: http://localhost:8501"
            // Gradio: "Running on local URL:  http://127.0.0.1:7860"
            if (!detectedUrl && (commandType.startsWith('npm-') || commandType === 'python')) {
              urlDetectBuffer = (urlDetectBuffer + cleanData).slice(-400);
              const url = detectServerUrl(urlDetectBuffer);
              if (url) {
                detectedUrl = url;
                console.log(`🎯 [RUN-LOCAL] 检测到服务地址: ${url}，1.5s 后提前结束 Run 状态（进程继续后台运行）`);
                onProgress?.({ type: 'url', data: detectedUrl });
                // 🔥 服务器类进程脱管：取消超时看门狗，常驻运行到用户关窗口/重新 Run 才终止
                (window as any).electron?.send?.('system:detach-command', { executionId: streamHandle.executionId });

                // 🔥 服务器类进程不会退出，等 close 会让 Run 按钮永远转圈（10 分钟后被误判超时）。
                // 检测到访问地址即视为启动成功：延迟 1.5s（多收集几行启动日志）后提前 resolve，
                // Run 按钮恢复、执行日志记录"已启动+地址"；进程继续后台运行，
                // 预览面板继续流式接收 stdout（终端效果）。
                // 普通脚本不打印 localhost 地址 → 不触发 → 仍等进程退出返回完整结果
                setTimeout(() => {
                  if (serviceGuard) clearTimeout(serviceGuard);
                  resolve({
                    success: true,
                    output: outputLines.join('\n') + `\n\n✅ 服务已启动: ${detectedUrl}`,
                    executionTime: Date.now() - startTime,
                    exitCode: 0,
                    executionType: commandType as any,
                  });
                }, 1500);
              }
            }
          } else if (data.type === 'stderr' && data.data) {
            outputLines.push(`[stderr] ${data.data}`);
            onProgress?.({ type: 'stderr', data: data.data });
          } else if (data.type === 'close') {
            const exitCode = data.exitCode || 0;
            onProgress?.({ type: 'complete', data: `Exit code: ${exitCode}` });
            if (serviceGuard) clearTimeout(serviceGuard);

            resolve({
              success: exitCode === 0,
              output: outputLines.join('\n'),
              error: exitCode !== 0 ? `执行失败，退出码: ${exitCode}` : undefined,
              executionTime: Date.now() - startTime,
              exitCode,
              executionType: commandType as any,  // 🔥 返回执行类型
            });
          }
        }
      });

    // 🔥 90s 无条件兜底脱管（结构性保证：绝不卡死在 Run 等待）——不枚举执行类型（穷举必漏：
    //    先漏 ts-node、再漏任何新增类型），只认时间：90s 内既未检测到访问地址、进程也未退出，
    //    即脱管转后台并交还控制权。宁可提前交还（长任务转后台，LLM 靠 get_task_detail 轮询
    //    日志确认结果，超 90s 的构建同理），绝不占死 LLM 执行通道等满 timeout（默认 600s）。
    const SERVICE_WAIT_CAP_MS = 90_000;
    const serviceGuard = setTimeout(() => {
      if (detectedUrl) return; // 已检测到地址提前 resolve，无需兜底
      (window as any).electron?.send?.('system:detach-command', { executionId: streamHandle.executionId });
      resolve({
        success: true,
        output: outputLines.join('\n') + `\n\n⏱️ 已运行 ${SERVICE_WAIT_CAP_MS / 1000}s：未检测到访问地址、进程也未退出。进程已转后台继续运行（不再阻塞等待）——本次返回仅代表启动成功，不代表任务完成，切勿向用户谎报完成。\n- 推理/训练等长任务：仍在后台跑，用 get_task_detail 轮询增量输出，直到日志出现退出码才算结束\n- 服务类：用 get_task_detail 查日志确认实际监听端口/地址\n- 若预期它应很快退出：可能卡住了，查日志排查`,
        executionTime: Date.now() - startTime,
        exitCode: 0,
        executionType: commandType as any,
      });
    }, SERVICE_WAIT_CAP_MS);

    // 超时处理
    setTimeout(() => {
      resolve({
        success: false,
        error: '执行超时',
        output: outputLines.join('\n'),
        executionTime: Date.now() - startTime,
        exitCode: -1,
        executionType: commandType as any,  // 🔥 返回执行类型
      });
    }, timeout * 1000 + 5000);
  });
}
