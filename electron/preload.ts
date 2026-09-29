import { contextBridge, ipcRenderer } from 'electron';

// 🔥 Headless 分身：页面脚本运行前注入部署人凭据（主进程 headless-auth.json → localStorage）。
// AuthContext 随后照常从 localStorage 恢复登录态 → 模型/桥/执行链零改动可用。
// 部署人身份权威：文件存在即覆盖（谁部署用谁的身份）。
try {
  const _isHeadless = (process.argv || []).includes('--headless') || process.env?.TEEGAL_HEADLESS === '1';
  if (_isHeadless) {
    const _auth = ipcRenderer.sendSync('headless:auth:get');
    if (_auth?.accessToken) {
      localStorage.setItem('cloud_access_token', _auth.accessToken);
      if (_auth.refreshToken) localStorage.setItem('cloud_refresh_token', _auth.refreshToken);
      if (_auth.user) localStorage.setItem('teegal-user', JSON.stringify(_auth.user));
      console.log('🧬 [PRELOAD] 已注入部署人凭据（headless-auth.json → localStorage）');
    }
  }
} catch { /* 注入失败按未登录走 */ }

/**
 * Electron Preload Script
 * 
 * 这个脚本在渲染进程启动前运行，用于安全地暴露 Electron API 给前端
 * 遵循最小权限原则，只暴露必要的功能
 */

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electron', {
  /**
   * 获取后端服务地址
   */
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  /**
   * 获取应用版本
   */
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  /**
   * 检查是否在 Electron 环境中运行
   */
  isElectron: true,

  /**
   * 获取平台信息
   */
  platform: process.platform,

  /**
   * 🔥 获取系统环境信息
   */
  getSystemInfo: () => ({
    platform: process.platform,  // 'win32', 'darwin', 'linux'
    platformName: process.platform === 'win32' ? 'Windows' : 
                 process.platform === 'darwin' ? 'macOS' : 'Linux'
  }),

  /**
   * 🔥 获取日志内容
   */
  getLogContent: () => ipcRenderer.invoke('get-log-content'),

  /**
   * 🔥 获取日志文件路径
   */
  getLogPath: () => ipcRenderer.invoke('get-log-path'),

  /**
   * 🔥 获取用户数据目录路径
   */
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),

  /**
   * 🔥 自动更新 API
   */
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    // 🔥 自定义更新源管理
    setSourceUrl: (url: string) => ipcRenderer.invoke('updater:setSourceUrl', url),
    getSourceUrl: () => ipcRenderer.invoke('updater:getSourceUrl'),
    onUpdateChecking: (callback: () => void) => ipcRenderer.on('updater:update-checking', callback),
    onUpdateAvailable: (callback: (event: any, data: any) => void) => ipcRenderer.on('updater:update-available', callback),
    onUpdateNotAvailable: (callback: () => void) => ipcRenderer.on('updater:update-not-available', callback),
    onUpdateProgress: (callback: (event: any, data: any) => void) => ipcRenderer.on('updater:update-progress', callback),
    onUpdateReady: (callback: (event: any, data: any) => void) => ipcRenderer.on('updater:update-ready', callback),
    onUpdateInstalling: (callback: (event: any, data: any) => void) => ipcRenderer.on('updater:update-installing', callback),
    onUpdateError: (callback: (event: any, data: any) => void) => ipcRenderer.on('updater:update-error', callback),
  },

  /**
   * 🔥 打开外部链接
   */
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  /**
   * 🔥 打开文件或文件夹
   * 使用系统默认程序打开文件，或打开文件夹
   */
  openPath: (filePath: string) => ipcRenderer.invoke('shell:open-path', filePath),

  /**
   * 🔥 在文件资源管理器中显示文件/文件夹
   * 打开文件资源管理器并高亮显示指定文件/文件夹
   */
  showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:show-item-in-folder', fullPath),

  /**
   * 🔥 窗口控制 API
   */
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    getSize: () => ipcRenderer.invoke('window-get-size'),
    setSize: (width: number, height: number) => ipcRenderer.invoke('window-set-size', { width, height }),
  },

  /**
   * 🔥 打开项目查看器独立窗口（同一 appId 复用已有窗口）
   */
  openAppViewerWindow: (opts: { appId: string; name?: string }) =>
    ipcRenderer.invoke('open-app-viewer-window', opts),

  /**
   * 🔥 监听主进程发来的"新增项目 tab"（viewer 窗口已存在时，新项目以 tab 加入）
   */
  onAddAppTab: (callback: (data: { appId: string; name?: string }) => void) => {
    const listener = (_e: unknown, data: { appId: string; name?: string }) => callback(data);
    ipcRenderer.on('app-viewer:add-tab', listener);
    return () => ipcRenderer.removeListener('app-viewer:add-tab', listener);
  },

  /**
   * 🔥 基础项目工具目录监视：启动主进程 fs.watch（幂等，tools/ 有任何写入即广播）
   * 🔥 多账号隔离：传入当前用户基础项目的实际 appId（可能带 userId 后缀）
   */
  watchBaseTools: (appId?: string) => ipcRenderer.invoke('watch-base-tools', appId),

  /**
   * 🔥 监听主进程广播的"基础项目 tools/ 目录已变更"（任何写入方式触发），渲染进程据此热重载工具
   */
  onBaseToolsChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('base-tools:changed', listener);
    return () => ipcRenderer.removeListener('base-tools:changed', listener);
  },

  /**
   * 🔥 Headless 分身：接收主进程转发的 agent query（POST /api/agent/query → IPC），
   * 渲染进程执行编排后必须调用 agentQueryResult 回包（reqId 配对）
   */
  onAgentQuery: (callback: (payload: { reqId: string; userQuery: string }) => void) => {
    const listener = (_: any, payload: { reqId: string; userQuery: string }) => callback(payload);
    ipcRenderer.on('agent:query', listener);
    return () => ipcRenderer.removeListener('agent:query', listener);
  },

  /**
   * 🔥 Headless 分身：渲染进程受理回包（reqId 配对主进程的等待 promise）
   */
  agentQueryResult: (result: { reqId: string; ok: boolean; error?: string }) => {
    ipcRenderer.send('agent:query:result', result);
  },

  /**
   * 🔥 Headless 分身：任务真正收尾的终态回包（写入主进程内存注册表，GET /api/agent/result 可轮询）
   */
  agentQueryFinal: (payload: { reqId: string; ok: boolean; error?: string; summary?: string }) => {
    ipcRenderer.send('agent:query:final', payload);
  },

  /**
   * 🔥 Headless 分身模式标记（渲染进程据此决定是否订阅 agent query）
   */
  isHeadless: (() => {
    try {
      return (process.argv || []).includes('--headless') || process.env?.TEEGAL_HEADLESS === '1';
    } catch {
      return false;
    }
  })(),

  /**
   * 🔥 本地存储 API（SQLite）
   */
  localStorage: {
    // Conversation 操作
    createConversation: (data: any) => ipcRenderer.invoke('local-storage:conversation:create', data),
    getConversationsByUserId: (userId: string, limit?: number, offset?: number) => 
      ipcRenderer.invoke('local-storage:conversation:getByUserId', { userId, limit, offset }),
    getConversationById: (id: string) => ipcRenderer.invoke('local-storage:conversation:getById', id),
    updateConversation: (id: string, updates: any) => 
      ipcRenderer.invoke('local-storage:conversation:update', { id, updates }),
    deleteConversation: (id: string) => ipcRenderer.invoke('local-storage:conversation:delete', id),
    
    // Message 操作
    createMessage: (data: any) => ipcRenderer.invoke('local-storage:message:create', data),
    getMessagesByConversationId: (conversationId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('local-storage:message:getByConversationId', { conversationId, limit, offset }),
    createBatchMessages: (messages: any[]) => ipcRenderer.invoke('local-storage:message:createBatch', messages),
    getMessageCount: (conversationId: string) => ipcRenderer.invoke('local-storage:message:getCount', conversationId),
    updateMessageByCallId: (data: { conversationId: string; callId: string; updates: any }) =>
      ipcRenderer.invoke('local-storage:message:updateByCallId', data),
    getCoordMessages: (conversationId: string, widthIndex: number, depth: number) =>
      ipcRenderer.invoke('local-storage:message:getCoordMessages', { conversationId, widthIndex, depth }),
    getSessionMessages: (conversationId: string, sessionId: string) =>
      ipcRenderer.invoke('local-storage:message:getSessionMessages', { conversationId, sessionId }),
    
    // ExecutionSnapshot 操作
    createExecutionSnapshot: (data: any) => ipcRenderer.invoke('local-storage:execution-snapshot:create', data),
    getExecutionSnapshotById: (id: string) => ipcRenderer.invoke('local-storage:execution-snapshot:getById', id),
    getExecutionSnapshotsByConversationId: (conversationId: string) =>
      ipcRenderer.invoke('local-storage:execution-snapshot:getByConversationId', conversationId),
    updateExecutionSnapshot: (id: string, updates: any) =>
      ipcRenderer.invoke('local-storage:execution-snapshot:update', { id, updates }),
    deleteExecutionSnapshot: (id: string) => ipcRenderer.invoke('local-storage:execution-snapshot:delete', id),

    // DesktopApp 操作
    createDesktopApp: (data: any) => ipcRenderer.invoke('local-storage:desktop-app:create', data),
    getDesktopAppsByUserId: (userId: string, limit?: number, offset?: number, appType?: 'normal' | 'system_base', baseFirst?: boolean) =>
      ipcRenderer.invoke('local-storage:desktop-app:getByUserId', { userId, limit, offset, appType, baseFirst }),
    getDesktopAppById: (id: string) => ipcRenderer.invoke('local-storage:desktop-app:getById', id),
    updateDesktopApp: (id: string, updates: any) => ipcRenderer.invoke('local-storage:desktop-app:update', { id, updates }),
    deleteDesktopApp: (id: string) => ipcRenderer.invoke('local-storage:desktop-app:delete', id),
    
    // TrainingTask 操作
    createTrainingTask: (data: any) => ipcRenderer.invoke('local-storage:training-task:create', data),
    getTrainingTasksByUserId: (userId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('local-storage:training-task:getByUserId', { userId, limit, offset }),
    getTrainingTasksByAppId: (appId: string) => ipcRenderer.invoke('local-storage:training-task:getByAppId', appId),
    getTrainingTaskSummariesByAppId: (appId: string) => ipcRenderer.invoke('local-storage:training-task:getSummaryByAppId', appId),
    getTrainingTaskById: (id: string) => ipcRenderer.invoke('local-storage:training-task:getById', id),
    updateTrainingTask: (id: string, updates: any) => ipcRenderer.invoke('local-storage:training-task:update', { id, updates }),
    deleteTrainingTask: (id: string) => ipcRenderer.invoke('local-storage:training-task:delete', id),

    // ExecutionLog 操作
    createExecutionLog: (data: any) => ipcRenderer.invoke('local-storage:execution-log:create', data),
    getExecutionLogsByAppId: (appId: string) => ipcRenderer.invoke('local-storage:execution-log:getByAppId', appId),
    getExecutionLogSummariesByAppId: (appId: string) => ipcRenderer.invoke('local-storage:execution-log:getSummaryByAppId', appId),
    getExecutionLogById: (id: string) => ipcRenderer.invoke('local-storage:execution-log:getById', id),
    updateExecutionLog: (id: string, updates: any) => ipcRenderer.invoke('local-storage:execution-log:update', { id, updates }),
    deleteExecutionLog: (id: string) => ipcRenderer.invoke('local-storage:execution-log:delete', id),

    // 🔥 Credential 操作（凭据管理，safeStorage 加密）
    // listCredentials: 获取所有凭据（带明文 value，给 UI 用）
    listCredentials: (userId: string) => ipcRenderer.invoke('local-storage:credential:list', { userId }),
    // listCredentialsMeta: 获取凭据元数据（不含 value，给 LLM 用）
    listCredentialsMeta: (userId: string) => ipcRenderer.invoke('local-storage:credential:list-meta', { userId }),
    // getCredentialByName: 根据名称获取凭据明文（给工具注入用）
    getCredentialByName: (name: string, userId: string) => ipcRenderer.invoke('local-storage:credential:get-by-name', { name, userId }),
    // createCredential: 创建凭据/参数（IPC 层根据 type 决定是否加密 value）
    // 🔥 type: 'env'（加密，注入环境变量）| 'param'（明文，代码读取）
    // 🔥 source: 'user'（默认，用户自维护）| 'platform'（官方租约，值运行时下发不落库）
    createCredential: (data: { userId: string; name: string; type: 'env' | 'param'; description?: string; envVar: string; value: string; source?: 'user' | 'platform'; provider?: string }) =>
      ipcRenderer.invoke('local-storage:credential:create', {
        user_id: data.userId,
        name: data.name,
        type: data.type,
        description: data.description,
        env_var: data.envVar,
        value: data.value,
        source: data.source,
        provider: data.provider,
      }),
    // updateCredential: 更新凭据/参数（IPC 层根据 type 决定是否加密 value）
    updateCredential: (id: string, updates: { name?: string; type?: 'env' | 'param'; description?: string; envVar?: string; value?: string }) =>
      ipcRenderer.invoke('local-storage:credential:update', {
        id,
        updates: {
          name: updates.name,
          type: updates.type,
          description: updates.description,
          env_var: updates.envVar,
          value: updates.value,
        },
      }),
    // deleteCredential: 删除凭据
    deleteCredential: (id: string) => ipcRenderer.invoke('local-storage:credential:delete', { id }),
  },

  /**
   * 🔥 本地文件存储 API
   */
  saveLocalFile: (data: { conversationId: string; fileName: string; content: string; mimeType?: string }) => 
    ipcRenderer.invoke('local-file:save', data),
  readLocalFile: (data: { localPath: string }) => 
    ipcRenderer.invoke('local-file:read', data),
  deleteLocalFile: (data: { localPath: string }) => 
    ipcRenderer.invoke('local-file:delete', data),
  checkLocalFileExists: (data: { localPath: string }) => 
    ipcRenderer.invoke('local-file:exists', data),
  appendLocalFile: (data: { localPath: string; content: string }) => 
    ipcRenderer.invoke('local-file:append', data),
  getLocalFilesByConversation: (data: { conversationId: string }) => 
    ipcRenderer.invoke('local-file:getByConversation', data),
  cleanupConversationFiles: (data: { conversationId: string }) => 
    ipcRenderer.invoke('local-file:cleanup', data),
  downloadUrl: (data: { url: string; mimeType?: string }) => 
    ipcRenderer.invoke('local-file:download-url', data),

  /**
   * 🔥 App 代码文件存储 API
   * 🔥 codePath 参数：导入项目时传入自定义路径，null/undefined 时使用默认路径
   */
  saveAppCodeFile: (data: { appId: string; fileName: string; content: string; codePath?: string }) => 
    ipcRenderer.invoke('app-code:save', data),
  readAppCodeFile: (data: { appId: string; fileName: string; codePath?: string }) => 
    ipcRenderer.invoke('app-code:read', data),
  checkAppCodeFileExists: (data: { appId: string; fileName: string; codePath?: string }) => 
    ipcRenderer.invoke('app-code:exists', data),
  copyAppCodeFile: (data: { appId: string; sourceFileName: string; targetFileName: string; codePath?: string }) => 
    ipcRenderer.invoke('app-code:copy', data),
  forkAppCodeDir: (data: { sourceAppId: string; targetAppId: string; codePath?: string }) => 
    ipcRenderer.invoke('app-code:fork', data),
  deleteAppCodeFile: (data: { appId: string; fileName: string; isDirectory?: boolean; codePath?: string }) =>
    ipcRenderer.invoke('app-code:delete', data),
  renameAppCodeFile: (data: { appId: string; oldFileName: string; newFileName: string; codePath?: string }) =>
    ipcRenderer.invoke('app-code:rename', data),
  commitAppCodeHistory: (data: { appId: string; fileName?: string; codePath?: string }) =>
    ipcRenderer.invoke('app-code:commit', data),
  saveAppCodeHistory: (data: { appId: string; fileName: string; codePath?: string }) =>
    ipcRenderer.invoke('app-code:save-history', data),
  readAppCodeHistory: (data: { appId: string; fileName: string; codePath?: string }) =>
    ipcRenderer.invoke('app-code:read-history', data),
  checkAppCodeDirExists: (data: { appId: string; dirPath: string; codePath?: string }) =>
    ipcRenderer.invoke('app-code:dir-exists', data),
  ensureAppCodeDir: (data: { appId: string; dirPath: string; codePath?: string }) =>
    ipcRenderer.invoke('app-code:ensure-dir', data),
  copyAppCodeDir: (data: { appId: string; sourceDir: string; targetDir: string; codePath?: string }) =>
    ipcRenderer.invoke('app-code:copy-dir', data),
  // 🔥 文件变化监听（fs.watch + 去抖动，用于检测工具系统之外的文件修改）
  watchAppCodeDir: (data: { appId: string; codePath?: string }) =>
    ipcRenderer.invoke('watch-app-code-dir', data),
  unwatchAppCodeDir: (data: { appId: string }) =>
    ipcRenderer.invoke('unwatch-app-code-dir', data),
  onAppCodeChanged: (callback: (data: { appId: string; filename: string }) => void) => {
    const handler = (_event: any, data: { appId: string; filename: string }) => callback(data);
    ipcRenderer.on('app-code-changed', handler);
    return () => ipcRenderer.removeListener('app-code-changed', handler);
  },

  /**
   * 🔥 目录扫描 API
   */
  readDirectory: (dirPath: string) =>
    ipcRenderer.invoke('read-directory', dirPath),
  readDirectoryRecursive: (dirPath: string, options?: { maxDepth?: number }) =>
    ipcRenderer.invoke('read-directory-recursive', dirPath, options),

  /**
   * 🔥 文件/目录选择对话框
   */
  showOpenDialog: (options: Electron.OpenDialogOptions) => 
    ipcRenderer.invoke('show-open-dialog', options),

  /**
   * 🔥 User Storage API（动态表管理）
   * 🔥 支持用户隔离，通过 userId 区分不同用户的数据
   */
  userStorage: {
    createTable: (data: { tableName: string; columns: any[]; replaceIfExists?: boolean; userId: string }) => 
      ipcRenderer.invoke('user-storage:create-table', data),
    getTables: (data: { userId: string }) => ipcRenderer.invoke('user-storage:get-tables', data),
    getTableSchema: (data: { tableName: string; userId: string }) => ipcRenderer.invoke('user-storage:get-table-schema', data),
    getTableData: (data: { tableName: string; limit?: number; offset?: number; userId: string }) => 
      ipcRenderer.invoke('user-storage:get-table-data', data),
    insert: (data: { tableName: string; data: any; userId: string }) => ipcRenderer.invoke('user-storage:insert', data),
    update: (data: { tableName: string; data: any; where?: any; userId: string }) => ipcRenderer.invoke('user-storage:update', data),
    delete: (data: { tableName: string; where?: any; clearAll?: boolean; userId: string }) => ipcRenderer.invoke('user-storage:delete', data),
    dropTable: (data: { tableName: string; userId: string }) => ipcRenderer.invoke('user-storage:drop-table', data),
    alterTable: (data: { tableName: string; addColumns?: any[]; dropColumns?: string[]; renameTo?: string; userId: string }) => 
      ipcRenderer.invoke('user-storage:alter-table', data),
    executeSQL: (data: { sql: string; userId: string }) => ipcRenderer.invoke('user-storage:execute-sql', data),
  },
  
  /**
   * 🔥 系统命令执行 API
   */
  systemCommand: (params: { command: string; timeout?: number; workingDir?: string }) => 
    ipcRenderer.invoke('system:execute-command', params),
  
  /**
   * 🔥 系统命令执行 API（流式输出版本）
   * 支持实时输出反馈，用于长时间运行的命令
   */
  systemCommandStream: (params: {
    command: string;
    timeout?: number;
    workingDir?: string;
    env?: Record<string, string>; // 🔥 额外环境变量（凭据注入）
    executionId: string;
    appId?: string; // 🔥 项目 ID：main 进程按 appId 登记进程，用于重新执行时杀旧、关窗口时释放
    onOutput: (data: { type: string; data?: string; exitCode?: number; success?: boolean; error?: string; message?: string; timestamp: number }) => void;
  }) => {
    const { command, timeout, workingDir, env, executionId, appId, onOutput } = params;

    // 设置一次性监听器来接收输出
    const listener = (_: any, outputData: any) => {
      if (outputData.executionId === executionId) {
        onOutput(outputData);
        // 如果命令完成或出错，移除监听器
        if (outputData.type === 'close' || outputData.type === 'error' || outputData.type === 'timeout') {
          ipcRenderer.removeListener('system:command-output', listener);
        }
      }
    };

    ipcRenderer.on('system:command-output', listener);

    // 发送执行命令
    ipcRenderer.send('system:execute-command-stream', {
      command,
      timeout,
      workingDir,
      env, // 🔥 凭据环境变量注入
      executionId,
      appId // 🔥 项目 ID 透传给 main 进程登记
    });

    // 返回取消函数
    return {
      cancel: () => {
        // 🔥 发送取消命令请求
        // 注意：不移除监听器，等待 close 消息来正常结束
        ipcRenderer.send('system:cancel-command', { executionId });
      }
    };
  },

  /**
   * 🔥 释放 appId 的后台服务进程（关闭项目窗口时调用）
   */
  stopAppService: (appId: string) => {
    ipcRenderer.send('system:stop-app-service', { appId });
  },

  /**
   * 🔥 查询 appId 的后台进程状态（渲染进程据此显示/隐藏 Stop 按钮、轮询等待后台结果）
   */
  queryAppService: (appId: string): Promise<{ running: boolean; isService: boolean }> => {
    return ipcRenderer.invoke('system:query-app-service', { appId });
  },

  /**
   * 🔥 认领 appId 在后台执行完毕的结果（打开项目窗口时调用，取走即清）
   * 用于补写"窗口关闭期间跑完"的执行记录
   */
  claimAppResult: (appId: string): Promise<{ exitCode: number; output: string; duration?: number } | null> => {
    return ipcRenderer.invoke('system:claim-app-result', { appId });
  },

  /**
   * 🔥 发送 IPC 消息（用于终止命令等场景）
   */
  send: (channel: string, data: any) => {
    ipcRenderer.send(channel, data);
  },

  /**
   * 🔥 屏幕截图 API
   * 截取用户当前屏幕
   */
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  /**
   * 🔥 通用文件操作 API（UserPC 文件管理）
   * 支持任意路径的文件读写操作
   */
  userpcFile: {
    read: (filePath: string, encoding?: 'utf-8' | 'base64') => ipcRenderer.invoke('userpc:file:read', { filePath, encoding }),
    write: (filePath: string, content: string) => ipcRenderer.invoke('userpc:file:write', { filePath, content }),
    delete: (filePath: string) => ipcRenderer.invoke('userpc:file:delete', { filePath }),
    exists: (filePath: string) => ipcRenderer.invoke('userpc:file:exists', { filePath }),
  },
});

// 类型声明（供 TypeScript 使用）
declare global {
  interface Window {
    electron: {
      getBackendUrl: () => Promise<string>;
      getAppVersion: () => Promise<string>;
      isElectron: boolean;
      platform: string;
      // 🔥 窗口控制方法
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        getSize: () => Promise<[number, number]>;
        setSize: (width: number, height: number) => void;
      };
      // 🔥 打开项目查看器独立窗口
      openAppViewerWindow: (opts: { appId: string; name?: string }) => Promise<{ success: boolean; reused?: boolean; error?: string }>;
      // 🔥 监听主进程"新增项目 tab"
      onAddAppTab: (callback: (data: { appId: string; name?: string }) => void) => () => void;
      // 🔥 基础项目工具目录监视（fs.watch 热重载，appId 多账号隔离）
      watchBaseTools: (appId?: string) => Promise<{ success: boolean; reused?: boolean; error?: string }>;
      onBaseToolsChanged: (callback: () => void) => () => void;
      // 🔥 Headless 分身：agent query 桥（HTTP 入口 → 渲染进程编排）
      onAgentQuery: (callback: (payload: { reqId: string; userQuery: string }) => void) => () => void;
      agentQueryResult: (result: { reqId: string; ok: boolean; error?: string }) => void;
      isHeadless: boolean;
      // 🔥 本地存储方法
      localStorage: {
        createConversation: (data: any) => Promise<any>;
        getConversationsByUserId: (userId: string, limit?: number, offset?: number) => Promise<any[]>;
        getConversationById: (id: string) => Promise<any | null>;
        updateConversation: (id: string, updates: any) => Promise<boolean>;
        deleteConversation: (id: string) => Promise<boolean>;
        createMessage: (data: any) => Promise<any>;
        getMessagesByConversationId: (conversationId: string, limit?: number, offset?: number) => Promise<any[]>;
        createBatchMessages: (messages: any[]) => Promise<any[]>;
        getMessageCount: (conversationId: string) => Promise<number>;
        updateMessageByCallId: (data: { conversationId: string; callId: string; updates: any }) => Promise<boolean>;
        getCoordMessages: (conversationId: string, widthIndex: number, depth: number) => Promise<any[]>;
        getSessionMessages: (conversationId: string, sessionId: string) => Promise<any[]>;
        // ExecutionSnapshot 操作
        createExecutionSnapshot: (data: any) => Promise<any>;
        getExecutionSnapshotById: (id: string) => Promise<any | null>;
        getExecutionSnapshotsByConversationId: (conversationId: string) => Promise<any[]>;
        updateExecutionSnapshot: (id: string, updates: any) => Promise<boolean>;
        deleteExecutionSnapshot: (id: string) => Promise<boolean>;
        // DesktopApp 操作
        createDesktopApp: (data: any) => Promise<any>;
        getDesktopAppsByUserId: (userId: string, limit?: number, offset?: number, appType?: 'normal' | 'system_base', baseFirst?: boolean) => Promise<any[]>;
        getDesktopAppById: (id: string) => Promise<any | null>;
        updateDesktopApp: (id: string, updates: any) => Promise<any | null>;
        deleteDesktopApp: (id: string) => Promise<boolean>;
        // TrainingTask 操作
        createTrainingTask: (data: any) => Promise<any>;
        getTrainingTasksByUserId: (userId: string, limit?: number, offset?: number) => Promise<any[]>;
        getTrainingTasksByAppId: (appId: string) => Promise<any[]>;
        getTrainingTaskSummariesByAppId: (appId: string) => Promise<any[]>;
        getTrainingTaskById: (id: string) => Promise<any | null>;
        updateTrainingTask: (id: string, updates: any) => Promise<any | null>;
        deleteTrainingTask: (id: string) => Promise<boolean>;
        // ExecutionLog 操作
        createExecutionLog: (data: any) => Promise<any>;
        getExecutionLogsByAppId: (appId: string) => Promise<any[]>;
        getExecutionLogSummariesByAppId: (appId: string) => Promise<any[]>;
        getExecutionLogById: (id: string) => Promise<any | null>;
        updateExecutionLog: (id: string, updates: any) => Promise<any | null>;
        deleteExecutionLog: (id: string) => Promise<boolean>;
        // 🔥 Credential 操作（凭据管理，safeStorage 加密）
        listCredentials: (userId: string) => Promise<any[]>;
        listCredentialsMeta: (userId: string) => Promise<any[]>;
        getCredentialByName: (name: string, userId: string) => Promise<any | null>;
        createCredential: (data: { userId: string; name: string; type: 'env' | 'param'; description?: string; envVar: string; value: string; source?: 'user' | 'platform'; provider?: string }) =>
          Promise<{ success: boolean; data?: any; error?: string; code?: string }>;
        updateCredential: (id: string, updates: { name?: string; type?: 'env' | 'param'; description?: string; envVar?: string; value?: string }) =>
          Promise<{ success: boolean; data?: any; error?: string; code?: string }>;
        deleteCredential: (id: string) => Promise<boolean>;
      };
      // 🔥 本地文件存储方法
      saveLocalFile: (data: { conversationId: string; fileName: string; content: string; mimeType?: string }) => Promise<{ success: boolean; localPath?: string; error?: string }>;
      readLocalFile: (data: { localPath: string }) => Promise<{ success: boolean; content?: string; error?: string }>;
      deleteLocalFile: (data: { localPath: string }) => Promise<{ success: boolean; error?: string }>;
      checkLocalFileExists: (data: { localPath: string }) => Promise<{ exists: boolean }>;
      getLocalFilesByConversation: (data: { conversationId: string }) => Promise<{ files: string[] }>;
      cleanupConversationFiles: (data: { conversationId: string }) => Promise<{ success: boolean; error?: string }>;
      downloadUrl: (data: { url: string; mimeType?: string }) => Promise<{ success: boolean; base64?: string; size?: number; error?: string }>;
      // 🔥 Tool Storage 方法
      toolStorage: {
        createTable: (data: any) => Promise<any>;
        getTables: () => Promise<any[]>;
        getTableSchema: (data: { tableName: string }) => Promise<any>;
        getTableData: (data: { tableName: string; limit?: number; offset?: number }) => Promise<any[]>;
        insert: (data: { tableName: string; data: any }) => Promise<any>;
        update: (data: { tableName: string; data: any; where?: any }) => Promise<any>;
        delete: (data: { tableName: string; where?: any }) => Promise<any>;
        dropTable: (data: { tableName: string }) => Promise<any>;
        alterTable: (data: { tableName: string; addColumns?: any[]; dropColumns?: string[]; renameTo?: string }) => Promise<any>;
      };
      // 🔥 系统命令执行方法
      systemCommand: (params: { command: string; timeout?: number; workingDir?: string }) => Promise<{
        success: boolean;
        output: string;
        error: string;
        exitCode: number;
        isHighRisk: boolean;
      }>;
      // 🔥 系统命令执行方法（流式输出版本）
      systemCommandStream: (params: {
        command: string;
        timeout?: number;
        workingDir?: string;
        env?: Record<string, string>;
        executionId: string;
        appId?: string; // 🔥 项目 ID：main 进程按 appId 登记进程，用于重新执行时杀旧、关窗口时释放
        onOutput: (data: { type: string; data?: string; exitCode?: number; success?: boolean; error?: string; message?: string; timestamp: number }) => void;
      }) => { cancel: () => void };
      // 🔥 释放 appId 的后台服务进程（关闭项目窗口时调用）
      stopAppService: (appId: string) => void;
      // 🔥 查询 appId 的后台进程状态（据此显示/隐藏 Stop 按钮、轮询等待后台结果）
      queryAppService: (appId: string) => Promise<{ running: boolean; isService: boolean }>;
      // 🔥 认领 appId 在后台执行完毕的结果（打开项目窗口时调用，取走即清）
      claimAppResult: (appId: string) => Promise<{ exitCode: number; output: string; duration?: number } | null>;
      // 🔥 发送 IPC 消息
      send: (channel: string, data: any) => void;
      // 🔥 打开外部链接
      openExternal: (url: string) => Promise<{ success: boolean }>;
      // 🔥 打开文件或文件夹
      openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      // 🔥 在文件资源管理器中显示文件/文件夹
      showItemInFolder: (fullPath: string) => Promise<{ success: boolean; error?: string }>;
      // 🔥 获取系统环境信息
      getSystemInfo: () => {
        platform: string;
        platformName: string;
        isWindows: boolean;
        isMac: boolean;
        isLinux: boolean;
        defaultShell: string;
        shellType: string;
        recommendedCommandPrefix: string;
        homeDir: string;
        userName: string;
      };
      // 🔥 获取日志
      getLogContent: () => Promise<string>;
      getLogPath: () => Promise<string>;
      // 🔥 自动更新
      updater: {
        check: () => Promise<{ success: boolean; updateInfo?: any; error?: string }>;
        download: () => Promise<{ success: boolean; error?: string }>;
        install: () => Promise<{ success: boolean; error?: string }>;
        getStatus: () => Promise<{ status: string; progress: number }>;
        onUpdateChecking: (callback: () => void) => void;
        onUpdateAvailable: (callback: (data: { version: string; releaseDate?: string; releaseNotes?: string; downloadUrl?: string; requiresManualInstall?: boolean }) => void) => void;
        onUpdateNotAvailable: (callback: () => void) => void;
        onUpdateProgress: (callback: (data: { progress: number }) => void) => void;
        onUpdateReady: (callback: (data: { version: string }) => void) => void;
        onUpdateInstalling: (callback: (data: { version: string }) => void) => void;
        onUpdateError: (callback: (data: { message: string }) => void) => void;
      };
      // 🔥 屏幕截图
      captureScreen: () => Promise<{ success: boolean; imageUrl?: string; screenWidth?: number; screenHeight?: number; scaleFactor?: number; error?: string }>;
      // 🔥 通用文件操作（UserPC 文件管理）
      userpcFile: {
        read: (filePath: string, encoding?: 'utf-8' | 'base64') => Promise<{ success: boolean; data?: { content: string; filePath: string; size: number; encoding?: 'utf-8' | 'base64'; ext?: string }; error?: string }>;
        write: (filePath: string, content: string) => Promise<{ success: boolean; data?: { filePath: string; message: string }; error?: string }>;
        delete: (filePath: string) => Promise<{ success: boolean; data?: { filePath: string; message: string }; error?: string }>;
        exists: (filePath: string) => Promise<{ success: boolean; data?: { exists: boolean; isFile: boolean; isDirectory: boolean; size: number }; error?: string }>;
      };
    };
  }
}
