/**
 * PdfViewer - PDF 文件预览组件
 *
 * 支持：.pdf
 * - HTTP URL → 直接用 <iframe> 渲染（浏览器内置 PDF 阅读器）
 * - 本地文件 → 通过 electron IPC 以 base64 读取 → Blob URL → <iframe>
 */

import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Download } from 'lucide-react';

/** 判断文件扩展名是否为 PDF 文件 */
export function isPdfFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ext === 'pdf';
}

interface PdfViewerProps {
  filePath: string;
  fileName?: string;
}

export const PdfViewer: React.FC<PdfViewerProps> = ({ filePath, fileName }) => {
  const [src, setSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    // 🔥 本地文件走 teegal-file:// 流式协议：字节不过 IPC、不进内存，
    // 大 PDF 由 Chromium 按需读取，无需大小门禁
    if (filePath.startsWith('http')) {
      setSrc(filePath);
      setLoading(false);
      return;
    }

    const electron = (window as any).electron;
    if (!electron?.userpcFile?.read) {
      setError('无法读取本地文件');
      setLoading(false);
      return;
    }

    // 先探存再给 src：返回结构为 { success, data: { exists } }
    electron.userpcFile.exists(filePath).then((r: any) => {
      if (!r?.data?.exists) {
        setError(`文件不存在: ${filePath}`);
      } else {
        setSrc(`teegal-file://local/${encodeURIComponent(filePath)}`);
      }
      setLoading(false);
    }).catch(() => {
      setError('加载 PDF 失败');
      setLoading(false);
    });
  }, [filePath]);

  const handleDownload = () => {
    if (src) {
      const a = document.createElement('a');
      a.href = src;
      a.download = fileName || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">加载 PDF 中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <AlertTriangle className="h-10 w-10 text-orange-400 mb-2" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-gray-50 dark:bg-gray-800">
        <span className="text-xs text-gray-600 dark:text-gray-300 truncate">
          {fileName || filePath}
        </span>
        <button
          onClick={handleDownload}
          className="text-gray-500 hover:text-blue-600 transition-colors"
          title="下载"
        >
          <Download className="h-4 w-4" />
        </button>
      </div>
      <iframe
        src={src}
        className="flex-1 w-full border-0"
        title="PDF 预览"
      />
    </div>
  );
};

export default PdfViewer;
