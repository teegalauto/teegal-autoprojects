/**
 * UnsupportedViewer - 不支持在线渲染的文件兜底组件
 *
 * 🔥 目标：任何"看不了"的文件（模型权重/二进制/压缩包等）只允许走到这里——
 * 显示明确提示，绝不把内容读入编辑器/渲染进程，防止页面卡死（页面卡死是最差体验，宁可不渲染）
 */

import { useTranslation } from 'react-i18next';
import { FileX } from 'lucide-react';

/**
 * 🔥 不可在线渲染的类型黑名单（命中即走兜底提示，不进 CodeEditor）
 */
const UNSUPPORTED_EXTS = new Set([
  // AI 模型/权重/张量（best.pt 这类动辄几百 MB，读入即卡死）
  'pt', 'pth', 'ckpt', 'pkl', 'pickle', 'safetensors', 'onnx', 'h5', 'hdf5', 'pb', 'tflite', 'weights', 'npy', 'npz',
  // 二进制数据文件
  'parquet', 'arrow', 'feather', 'bin',
  // 压缩包/包文件
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'whl', 'egg', 'jar', 'war',
  // 可执行/对象文件
  'exe', 'dll', 'so', 'dylib', 'msi', 'apk', 'deb', 'rpm', 'pyd', 'pyc', 'o', 'a', 'obj', 'class', 'wasm',
  // 数据库
  'db', 'sqlite', 'sqlite3',
]);

/** 判断文件是否不支持在线渲染（按扩展名黑名单） */
export function isUnsupportedPreviewFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return !!ext && UNSUPPORTED_EXTS.has(ext);
}

interface UnsupportedViewerProps {
  fileName: string;
}

export const UnsupportedViewer: React.FC<UnsupportedViewerProps> = ({ fileName }) => {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-400 dark:text-gray-500 select-none">
      <FileX className="w-12 h-12" />
      <div className="text-sm font-medium text-gray-600 dark:text-gray-300 max-w-[80%] truncate">{fileName}</div>
      <div className="text-xs">{t('workspace.desktopModule.desktopAppViewer.unsupportedFileType')}</div>
    </div>
  );
};

export default UnsupportedViewer;
