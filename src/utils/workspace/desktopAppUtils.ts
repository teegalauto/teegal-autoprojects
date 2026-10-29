import { DesktopApp } from '@/components/workspace/DesktopModule/types/DesktopAppTypes';

/**
 * 🚀 核心助手：解析结构化的 preview 数据
 */
export const parsePreview = (preview: any) => {
  if (!preview) return { preview: '', structured_preview: undefined };

  try {
    const parsed = typeof preview === 'string' ? JSON.parse(preview) : preview;
    // 判断是否是 SmartExecutor 存入的结构化格式
    if (parsed && typeof parsed === 'object' && (parsed.files || parsed.charts || parsed.output || parsed.preview)) {
      return {
        preview: parsed.output || parsed.preview || '', 
        structured_preview: parsed
      };
    }
  } catch (e) {
    // 非 JSON 格式，继续使用原始 preview
  }
  
  return { preview: typeof preview === 'string' ? preview : '', structured_preview: undefined };
};

/**
 * 🚀 将数据库原始对象映射为前端 DesktopApp 对象
 */
export const mapDbAppToDesktopApp = (dbApp: any): DesktopApp => {
  const { preview, structured_preview } = parsePreview(dbApp.preview);

  return {
    id: dbApp.id,
    name: dbApp.name,
    description: dbApp.description,
    current_code: dbApp.current_code,
    previous_code: dbApp.previous_code,
    code: dbApp.current_code || dbApp.code || '',
    config: dbApp.config || {},
    env_vars: dbApp.env_vars || {},
    preview: preview,
    structured_preview: structured_preview,
    createdAt: new Date(dbApp.created_at),
    updatedAt: new Date(dbApp.updated_at),
    userId: dbApp.user_id,
    // 🔥 App 市场相关字段
    market_status: dbApp.market_status || 'local',
    definition: dbApp.definition || null,
    interface_spec: dbApp.interface_spec || null,
    // 🔥 项目类型：normal=普通项目，system_base=系统基础项目（不可删除）
    app_type: dbApp.app_type || 'normal',
    // 🔥 项目场景类型（training/inference/shortfilm/agent/general）：AppCard 标签数据源，
    //    漏映射会导致落库了类型但卡片永远不显示标签
    project_type: dbApp.project_type || null,
  };
};
