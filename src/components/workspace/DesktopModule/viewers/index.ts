/**
 * viewers 模块统一出口
 *
 * 集中管理所有文件预览器和文件类型判断函数
 * - 新增文件格式时只需在此处扩展，DesktopAppViewer 不再需要修改判断逻辑
 */

import { isCadFile } from './CadPreview';
import { isImageFile } from './ImageViewer';
import { isVideoFile } from './VideoViewer';
import { isPdfFile } from './PdfViewer';
import { isOfficeFile } from './OfficeViewer';
import { isAudioFile } from './AudioViewer';
import { isUnsupportedPreviewFile } from './UnsupportedViewer';

// 重新导出组件和判断函数
export { CadPreview } from './CadPreview';
export { ImageViewer } from './ImageViewer';
export { VideoViewer } from './VideoViewer';
export { PdfViewer } from './PdfViewer';
export { OfficeViewer } from './OfficeViewer';
export { AudioViewer } from './AudioViewer';
export { UnsupportedViewer } from './UnsupportedViewer';
export { isCadFile, isImageFile, isVideoFile, isPdfFile, isOfficeFile, isAudioFile, isUnsupportedPreviewFile };

// 通用文件类型判断（用于 FileTree 图标等场景）
export function getFileKind(filePath: string): 'cad' | 'image' | 'video' | 'pdf' | 'office' | 'audio' | 'code' {
  if (isCadFile(filePath)) return 'cad';
  if (isImageFile(filePath)) return 'image';
  if (isVideoFile(filePath)) return 'video';
  if (isPdfFile(filePath)) return 'pdf';
  if (isOfficeFile(filePath)) return 'office';
  if (isAudioFile(filePath)) return 'audio';
  return 'code';
}
