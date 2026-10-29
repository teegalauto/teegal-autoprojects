/**
 * 可用工具注册表
 * 统一管理所有可供 Auto 流程使用的工具
 * 每次版本发布时更新此文件即可
 */

/**
 * 工具令牌类型
 * - gather: 可在 Summary/Gather 阶段调用的工具（简单查询类）
 * - execution: 可在 Reaction/Execution 阶段调用的工具（复杂执行类）
 */
export type ToolToken = 'gather' | 'execution';

export interface ToolDefinition {
  id?: number;
  name: string;
  displayName?: string; // 🔥 用户友好的显示名称
  description?: string;
  tokens?: ToolToken[];
  params?: string; // 🔥 关键参数名（如 "projectId, filePath"），帮助 LLM 正确传参
  isExtension?: boolean; // 🔥 扩展工具标记（基础项目动态注册的），prompt 列表中加 * 标识
}

/**
 * 🔥 工具 ID 映射表（惰性计算）
 * 用于快速查找工具 ID 与名称的对应关系
 * 使用惰性计算避免初始化顺序问题
 */
let _toolIdMapCache: Record<number, string> | null = null;

function getToolIdMap(): Record<number, string> {
  if (_toolIdMapCache === null) {
    _toolIdMapCache = {};
    for (const tool of AVAILABLE_TOOLS) {
      if (tool.id !== undefined) {
        _toolIdMapCache[tool.id] = tool.name;
      }
    }
    for (const tool of EXTENSION_TOOLS) {
      if (tool.id !== undefined) {
        _toolIdMapCache[tool.id] = tool.name;
      }
    }
  }
  return _toolIdMapCache;
}

/**
 * 🔥 工具 ID 映射表（惰性生成）
 * @deprecated 请使用 getAllToolIds() 或其他辅助函数
 */
export const TOOL_ID_MAP: Record<number, string> = new Proxy({} as Record<number, string>, {
  get(target, prop: string | symbol) {
    if (typeof prop === 'string') {
      return getToolIdMap()[parseInt(prop, 10)];
    }
    return undefined;
  },
  ownKeys() {
    return Object.keys(getToolIdMap());
  },
  getOwnPropertyDescriptor(target, prop: string | symbol) {
    if (typeof prop === 'string') {
      return Object.getOwnPropertyDescriptor(getToolIdMap(), prop);
    }
    return undefined;
  }
});

/**
 * 🔥 根据工具名称获取工具 ID
 * 支持从 AVAILABLE_TOOLS 中查找
 */
export function getToolIdByName(name: string): number | undefined {
  // 先从 AVAILABLE_TOOLS 中查找
  const tool = AVAILABLE_TOOLS.find(t => t.name === name);
  if (tool?.id !== undefined) {
    return tool.id;
  }
  // 再从 EXTENSION_TOOLS 中查找
  const extTool = EXTENSION_TOOLS.find(t => t.name === name);
  if (extTool?.id !== undefined) {
    return extTool.id;
  }
  return undefined;
}

/**
 * 🔥 根据工具 ID 获取工具名称
 * 支持从 AVAILABLE_TOOLS 和 EXTENSION_TOOLS 中查找
 */
export function getToolNameById(id: number): string | undefined {
  // 先从 AVAILABLE_TOOLS 中查找
  const tool = AVAILABLE_TOOLS.find(t => t.id === id);
  if (tool) {
    return tool.name;
  }
  // 再从 EXTENSION_TOOLS 中查找
  const extTool = EXTENSION_TOOLS.find(t => t.id === id);
  if (extTool) {
    return extTool.name;
  }
  return undefined;
}

/**
 * 🔥 根据工具名称获取用户友好的显示名称
 * 如果没有定义 displayName，返回 name
 */
export function getToolDisplayName(toolName: string): string {
  // 先从 AVAILABLE_TOOLS 中查找
  const tool = AVAILABLE_TOOLS.find(t => t.name === toolName);
  if (tool) {
    return tool.displayName || tool.name;
  }
  // 再从 EXTENSION_TOOLS 中查找
  const extTool = EXTENSION_TOOLS.find(t => t.name === toolName);
  if (extTool) {
    return extTool.displayName || extTool.name;
  }
  // 如果找不到，返回原名称
  return toolName;
}

/**
 * 🔥 获取工具的稳定 ID（别名，等同于 getToolIdByName）
 * 无论传入当前名称还是历史名称，都返回数字 ID
 */
export function getToolStableId(toolName: string): number | undefined {
  return getToolIdByName(toolName);
}

/**
 * 🔥 获取当前名称（别名，等同于 getToolNameById）
 * 从 toolId 获取当前使用的名称
 */
export function getToolCurrentName(toolId: number): string | undefined {
  return getToolNameById(toolId);
}

/**
 * 🔥 标准化工具名称
 * 将任意名称转换为当前名称
 */
export function normalizeToolName(toolName: string): string {
  const id = getToolIdByName(toolName);
  if (id !== undefined) {
    return getToolNameById(id) || toolName;
  }
  return toolName;
}

/**
 * 🔥 检查两个工具名称是否指向同一个工具
 */
export function isSameTool(toolName1: string, toolName2: string): boolean {
  const id1 = getToolIdByName(toolName1);
  const id2 = getToolIdByName(toolName2);
  return id1 !== undefined && id2 !== undefined && id1 === id2;
}

/**
 * 🔥 获取所有已注册的工具 ID 列表
 */
export function getAllToolIds(): number[] {
  return Object.keys(getToolIdMap()).map(id => parseInt(id));
}

/**
 * 🔥 核心工具注册表 - 供 Reaction 架构动态选择
 */
export const AVAILABLE_TOOLS: ToolDefinition[] = [
  // 🔥 信息获取类
  { id: 1, name: "web_search", displayName: "智能搜索", tokens: ["gather", "execution"], params: "query" },
  { id: 2, name: "web_url_reader", displayName: "网页/图片/视频阅读", tokens: ["gather", "execution"], params: "url, instruction(想了解什么,如\"描述这张图\";普通网页可省;图片支持本地绝对路径,截图后直接传路径即可看图)" },
  { id: 3, name: "list_projects", displayName: "列出项目", tokens: ["gather", "execution"], params: "" },
  { id: 4, name: "get_account_info", displayName: "获取账户信息", tokens: ["gather", "execution"], params: "" },
  // 🔥 check_user_credits 已合并到 get_account_info（一次调用返回账户信息+积分余额）
  { id: 5, name: "call_memory", displayName: "回忆记忆", tokens: ["gather", "execution"], params: "query | projectId+query?" },
  { id: 6, name: "use_guide", displayName: "查阅使用指南", tokens: ["gather", "execution"], params: "query" },

  // 🔥 项目文件操作工具
  { id: 7, name: "list_project_files", displayName: "列出项目文件树", tokens: ["gather", "execution"], params: "projectId, mode?(tree=文件树+depth | search=query搜文件名+内容 | skeleton=全项目定义索引+行号,改码前先看)" },
  { id: 8, name: "read_project_file", displayName: "读取项目文件", tokens: ["gather", "execution"], params: "projectId, filePath | files[](批量), pattern?(支持a|b|c或数组; 附结构地图+行号), offset?, limit?(定点; 结果带续读坐标)" },
  { id: 9, name: "save_project_file", displayName: "保存项目文件", tokens: ["gather", "execution"], params: "projectId, filePath, content" },
  { id: 10, name: "edit_project_file", displayName: "编辑项目文件", tokens: ["gather", "execution"], params: "projectId, edits[{filePath,oldText,newText}](每项必带filePath)" },
  { id: 11, name: "delete_project_file", displayName: "删除项目文件", tokens: ["gather", "execution"], params: "projectId, filePath" },

  // 🔥 代码执行工具（local=本地 / cloud=云端）
  { id: 12, name: "run_project_onlocal", displayName: "本地执行项目代码", tokens: ["gather", "execution"], params: "projectId(短id可; 只传=自动探测入口执行整个项目), mainFile?(指定入口)。进程随项目窗口存活,长任务/服务自动转后台不阻塞" },
  { id: 13, name: "run_project_oncloud", displayName: "云端运行项目代码", tokens: ["gather", "execution"], params: "projectId, instanceType(S5.*=CPU，GN*/ecs.*=GPU), wait?(默认true，false=稍后用户自己看结果)。仅跑码,不可部署" },
  { id: 14, name: "userpc_shell", displayName: "执行shell命令", tokens: ["gather", "execution"], params: "command, credentialName?(py长脚本须加 -u，静默会被判死; 后台常驻进程禁止弹原生命令行窗口)" },
  { id: 15, name: "userpc_run_python", displayName: "运行Python脚本", tokens: ["gather", "execution"], params: "code, credentialName?(凭据注入; 联网必带timeout≤30; Popen常驻进程必须CREATE_NO_WINDOW, 禁弹原生命令行窗口)" },

  // 🔥 任务历史工具（合并版：云端训练 train + 本地执行 localrun 双源，见 TaskHistoryTools）
  { id: 16, name: "list_tasks", displayName: "列出任务/日志", tokens: ["gather", "execution"], params: "projectId, type?(train=云端训练|localrun=本地执行|缺省=两源合并), morePage?(如'11-20')" },
  { id: 17, name: "get_task_detail", displayName: "获取任务/日志详情", tokens: ["gather", "execution"], params: "taskId(双源命中:先训练后本地执行,回执带来源) | appId(运行日志池:[trace]埋点增量,单次≤4000字)" },
  { id: 18, name: "stop_gpu_train", displayName: "停止GPU训练", tokens: ["gather", "execution"], params: "taskId" },
  { id: 19, name: "update_train_task_remark", displayName: "更新训练备注", tokens: ["gather", "execution"], params: "taskId, remark" },

  // 🔥 云端资源（实例类型 / 常驻实例 / 云端文件）
  { id: 20, name: "list_instance_types", displayName: "查询云端实例类型列表", tokens: ["gather", "execution"], params: "" },
  { id: 21, name: "list_cloud_files", displayName: "查询云端文件列表", tokens: ["gather", "execution"], params: "" },
  // 🔥 常驻实例租赁：开机云端实例（带公钥免密）→ userpc_shell 直接 ssh 操作 → close 关机结算
  // projectId 可选：登记项目归属（list 可看出"项目专属机"，跨项目不复用）
  { id: 22, name: "ssh_instance", displayName: "常驻实例操作", tokens: ["execution"], params: "action?(默认activate: activate开机/close关机/list列表/add绑定自有机器/register登记预览域名), instanceType?(activate必传,如S5.MEDIUM4), instanceId?(close必传/activate复用指定实例), projectId?(登记归属,短id/完整id), host/username/password?(add必传,用户自有服务器), host+port?(register必传,已部署web服务的机子IP与端口,换官方HTTPS预览域名), port?(add可选,默认22)" },

  // 🔥 项目与账户管理
  // 创建/更新项目元信息（不带 projectId=创建；带 projectId=更新 name/description，让 LLM 维护项目自述）
  { id: 23, name: "upsert_project", displayName: "创建/更新项目", tokens: ["gather", "execution"], params: "name, description, projectId?(传入则为更新模式)" },
  // 🔥 凭据管理工具（LLM 只能看到凭据名称，看不到明文值；param 型参数可写）
  { id: 24, name: "list_credentials", displayName: "查询凭据/设置参数", tokens: ["gather", "execution"], params: "action?(list=查凭据与参数; set=改参数,传name+value,仅限param型)" },

  // 🔥 文件上传工具（从扩展工具迁移为内置工具）
  { id: 25, name: "uploadfiletooss", displayName: "上传文件到云端", tokens: ["gather", "execution"], params: "localPath（或任意包含本地文件路径的参数）" },
  // 🔥 实例直连：执行命令 / 写文件 / 推文件（Node spawn 免转义；细节报错自解释，完整用法见 use_guide）
  { id: 26, name: "ssh_remote", displayName: "实例直连执行", tokens: ["execution"], params: "instanceId, command | remotePath+content | filePath 或 filePaths[](批量) 或 localPath + remotePath, timeout?" },
  // 🔥 电脑操作（Windows）：感知屏幕返回编号候选表 → 选号执行，坐标由定位层产出（LLM 只选号不碰坐标）
  // 暂停注册：实战 7 轮暴露 LLM 操作成功率低（乱跑/幻觉编号/时序错位），定位层与工具本体保留待改进后再启用
  // { id: 27, name: "computeruse", displayName: "电脑操作", tokens: ["execution"], params: "action(focus窗口置前|perceive感知屏幕|click点id|type输text|key按键|seq多步编排), window?(窗口名筛,perceive/focus用,如\"微信\"), filter?(perceive文字筛), annotated?(图标无文字时出编号标注图,web_url_reader认编号再click), id?(click编号来自最近感知), expect?(click防呆:预期文字如\"李佩琦\",不符拒点), text?(type支持中文), key?(enter/esc/ctrl+s等), steps?(seq一轮跑完:[{do:type,text:x},{do:key,key:enter}]); click/key/focus执行后自动回传最新感知(弹新窗时自动全屏兜底)无需单独perceive,核验只看sense; 严禁pyautogui模拟坐标点击" },
];

// 🔥 扩展工具存储（动态添加）
const EXTENSION_TOOLS: ToolDefinition[] = [];

/**
 * 🔥 注册扩展工具
 * 
 * 由扩展工具系统调用，将动态生成的 Tools 添加到可用工具列表
 */
export function registerExtensionTools(tools: ToolDefinition[]): void {
  for (const tool of tools) {
    tool.isExtension = true; // 🔥 统一打扩展标记（prompt 列表中以 * 标识）
    // 检查是否已存在
    const existingIndex = EXTENSION_TOOLS.findIndex(t => t.name === tool.name);
    if (existingIndex >= 0) {
      // 更新已存在的工具
      EXTENSION_TOOLS[existingIndex] = tool;
    } else {
      // 添加新工具
      EXTENSION_TOOLS.push(tool);
    }
  }
  console.log(`🔧 [AvailableToolsRegistry] 已注册 ${tools.length} 个扩展工具`);
}

/**
 * 🔥 注销扩展工具
 * 
 * 扩展被禁用或卸载时调用
 */
export function unregisterExtensionTools(toolNames: string[]): void {
  for (let i = EXTENSION_TOOLS.length - 1; i >= 0; i--) {
    if (toolNames.includes(EXTENSION_TOOLS[i].name)) {
      EXTENSION_TOOLS.splice(i, 1);
    }
  }
  console.log(`🔧 [AvailableToolsRegistry] 已注销 ${toolNames.length} 个扩展工具`);
}

/**
 * 🔥 注册单个扩展工具
 * 
 * 由 LLM 动态生成的工具调用
 */
export function registerTool(tool: ToolDefinition): void {
  tool.isExtension = true; // 🔥 统一打扩展标记（prompt 列表中以 * 标识）
  const existingIndex = EXTENSION_TOOLS.findIndex(t => t.name === tool.name);
  if (existingIndex >= 0) {
    EXTENSION_TOOLS[existingIndex] = tool;
    console.log(`🔧 [AvailableToolsRegistry] 更新扩展工具: ${tool.name}`);
  } else {
    EXTENSION_TOOLS.push(tool);
    console.log(`🔧 [AvailableToolsRegistry] 注册扩展工具: ${tool.name}`);
  }
}

/**
 * 🔥 注销单个扩展工具
 */
export function unregisterTool(toolName: string): void {
  const index = EXTENSION_TOOLS.findIndex(t => t.name === toolName);
  if (index >= 0) {
    EXTENSION_TOOLS.splice(index, 1);
    console.log(`🔧 [AvailableToolsRegistry] 注销扩展工具: ${toolName}`);
  }
}

/**
 * 🔥 获取所有可用工具（包括扩展工具）
 */
export function getAllAvailableTools(): ToolDefinition[] {
  return [...AVAILABLE_TOOLS, ...EXTENSION_TOOLS];
}

/**
 * 🔥 根据令牌获取工具列表
 * 
 * @param token 工具令牌：'gather' | 'execution'
 * @returns 匹配该令牌的工具列表
 * 
 * 使用示例：
 * - getToolsByToken('gather')    // 获取所有可在 Summary/Gather 阶段调用的工具
 * - getToolsByToken('execution') // 获取所有可在 Reaction/Execution 阶段调用的工具
 * 
 * 🔥 包含扩展工具
 */
export function getToolsByToken(token: ToolToken): ToolDefinition[] {
  return getAllAvailableTools().filter(tool => tool.tokens?.includes(token));
}

/**
 * 🔥 获取工具名称列表（按令牌过滤）
 * 
 * @param token 可选的令牌过滤
 * @returns 工具名称数组
 * 
 * 🔥 包含扩展工具
 */
export function getToolNames(token?: ToolToken): string[] {
  if (token) {
    return getToolsByToken(token).map(tool => tool.name);
  }
  return getAllAvailableTools().map(tool => tool.name);
}

/**
 * 检查工具是否支持简化 query 调用（基于 gather 令牌）
 */
export function isSimpleQueryTool(toolName: string): boolean {
  const tool = getToolByName(toolName);
  return tool?.tokens?.includes('gather') ?? false;
}

/**
 * 根据工具名称获取工具定义
 * 🔥 包含扩展工具
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return getAllAvailableTools().find(t => t.name === name);
}

/**
 * 生成工具系统摘要（不含 skills，避免 LLM 误解）
 * 用于 AutoPlanner 阶段的概览信息传递
 * 
 * @param token 可选的令牌过滤，只返回该令牌的工具。默认返回 execution 类型的工具
 */
export function getToolsSummary(token?: ToolToken): { name: string }[] {
  const tools = token ? getToolsByToken(token) : getToolsByToken('execution');
  return tools.map(tool => ({
    name: tool.name
  }));
}

/**
 * 获取 gather 类型的工具列表
 * 用于 Summary 阶段，让 LLM 知道可以调用哪些 gather 工具来收集信息
 * 
 * @returns gather 类型工具的简要信息列表
 */
export function getGatherToolsSummary(): { name: string; params?: string; isExtension?: boolean }[] {
  return getToolsByToken('gather').map(tool => ({
    name: tool.name,
    params: tool.params,
    isExtension: tool.isExtension
  }));
}

/**
 * 🔥 获取 execution 类型的工具列表（含参数名）
 * 用于传递给后端，让 Summary 助手知道后端有哪些执行能力
 * 
 * @returns execution 类型工具的名称和参数列表
 */
export function getExecutionToolNames(): string[] {
  return getToolsByToken('execution').map(tool => tool.name);
}

/**
 * 🔥 获取 execution 类型的工具列表（含参数名）
 * 用于 EnvironmentBuilder 构建工具列表段落
 */
export function getExecutionToolsWithParams(): { name: string; params?: string; isExtension?: boolean }[] {
  return getToolsByToken('execution').map(tool => ({
    name: tool.name,
    params: tool.params,
    isExtension: tool.isExtension
  }));
}

