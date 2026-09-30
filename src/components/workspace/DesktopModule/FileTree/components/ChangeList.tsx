/**
 * 变更记录面板
 * 
 * 对比 HEAD（最近一次「接受修改」checkpoint）与工作区（git status）：
 * - 有变更 → 显示 +xx -xx 变更统计
 * - 点击条目 → onViewDiff 回调，直接在 CodeEditor 的 DiffViewer 中显示
 * - 接受 = 单文件 checkpoint；回退 = 恢复 HEAD 内容（新文件回退 = 删除）
 * - 底部：checkpoint 时间线（git log），支持回滚到任意版本
 */

import React, { useState, useEffect } from 'react';
import { FileText, Loader2, History, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { FileHistory } from '../types';
import { getHistoryContent, getCurrentFileContent, commitFiles, saveFile, deleteFile, listCheckpointTimeline, restoreToCheckpoint } from '../utils';

/**
 * LCS diff 统计
 */
function computeDiffStats(oldCode: string, newCode: string): { added: number; deleted: number } {
  // 🔥 标准化行尾符：CRLF→LF，去除行尾空白，避免行尾差异导致整文件重写
  const normalizeLine = (line: string) => line.replace(/\r$/, '').trimEnd();
  const oldLines = oldCode.split('\n').map(normalizeLine);
  const newLines = newCode.split('\n').map(normalizeLine);
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let added = 0, deleted = 0;
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added++; j--;
    } else {
      deleted++; i--;
    }
  }
  return { added, deleted };
}

// ─── ChangeList 组件 ───

interface ChangeListProps {
  appId: string;
  /** 相对 HEAD 的变更文件列表（fileName=相对路径） */
  changes: FileHistory[];
  onRefresh: () => void;
  /** 点击条目 → 在 CodeEditor 中显示 diff */
  onViewDiff?: (fileName: string, oldCode: string, newCode: string) => void;
  /** 当前选中的变更条目（文件名），用于高亮 */
  selectedFileName?: string;
  /** 选中状态变化回调 */
  onSelectionChange?: (fileName: string | null) => void;
  /** 文件接受/回退后回调，通知父组件退出 diff 模式 */
  onFileHandled?: (fileName: string, action: 'accept' | 'revert') => void;
}

export function ChangeList({ appId, changes, onRefresh, onViewDiff, selectedFileName, onSelectionChange, onFileHandled }: ChangeListProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [diffStats, setDiffStats] = useState<Record<string, { added: number; deleted: number }>>({});
  const [loading, setLoading] = useState<string | null>(null);
  // 🔥 需要重算 diff 的文件集合（内容实际变更时加入，算完后移除）
  const dirtyRef = React.useRef<Set<string>>(new Set(changes.map(fh => fh.fileName)));
  const diffStatsRef = React.useRef(diffStats);
  diffStatsRef.current = diffStats;
  // 🔥 递增计数器，用于在文件内容变更时强制触发重算
  const [revision, setRevision] = useState(0);

  // 增量计算 diff 统计：新出现的文件 + dirty 文件
  useEffect(() => {
    if (changes.length === 0) {
      setDiffStats({});
      dirtyRef.current.clear();
      return;
    }

    const currentNames = new Set(changes.map(fh => fh.fileName));

    // 🔥 新出现的文件加入 dirty
    for (const name of currentNames) {
      if (!(name in diffStatsRef.current)) {
        dirtyRef.current.add(name);
      }
    }
    // 🔥 已删除的文件从 dirty 移除
    for (const name of [...dirtyRef.current]) {
      if (!currentNames.has(name)) {
        dirtyRef.current.delete(name);
      }
    }

    const toCompute = [...dirtyRef.current];
    if (toCompute.length === 0) return;

    let cancelled = false;
    (async () => {
      const newStats: Record<string, { added: number; deleted: number }> = {};
      for (const fileName of toCompute) {
        if (cancelled) return;
        try {
          const oldCode = await getHistoryContent(appId, fileName);
          const newCode = await getCurrentFileContent(appId, fileName);
          newStats[fileName] = computeDiffStats(oldCode ?? '', newCode ?? '');
        } catch {
          newStats[fileName] = { added: 0, deleted: 0 };
        }
      }
      if (!cancelled) {
        // 🔥 算完的文件从 dirty 中移除
        dirtyRef.current = new Set([...dirtyRef.current].filter(f => !(f in newStats)));
        setDiffStats(prev => {
          const next = { ...prev };
          // 🔥 移除已不存在的文件
          for (const name of Object.keys(next)) {
            if (!currentNames.has(name)) delete next[name];
          }
          return { ...next, ...newStats };
        });
      }
    })();

    return () => { cancelled = true; };
  }, [changes, appId, revision]);

  // 🔥 checkpoint 时间线（git log，新→旧）；changes 变化（含接受/回滚后刷新）时重载
  const [showTimeline, setShowTimeline] = useState(false);
  const [checkpoints, setCheckpoints] = useState<{ oid: string; message: string; timestamp: number }[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    listCheckpointTimeline(appId).then(list => {
      if (!cancelled) setCheckpoints(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [appId, changes]);

  // 回滚整个项目到指定 checkpoint
  // 🔥 两段式确认（点击 → 进入确认态 3 秒 → 再点执行）。
  // ⚠️ 不用 window.confirm：Electron 渲染进程的同步对话框存在挂起不返回的问题，
  // 会把整个页面卡死（真实踩中过）。
  const [confirmOid, setConfirmOid] = useState<string | null>(null);
  const confirmTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRestore = async (oid: string) => {
    if (confirmOid !== oid) {
      setConfirmOid(oid);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmOid(null), 3000);
      return;
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmOid(null);
    setRestoring(oid);
    try {
      const result = await restoreToCheckpoint(appId, oid);
      if (result.success) {
        toast({ title: '已回滚到该版本', duration: 2500 });
        setDiffStats({});
        onSelectionChange?.(null);
        onRefresh();
        // 退出 diff 模式（回滚后文件内容已整体变化）
        onFileHandled?.('', 'revert');
      } else {
        toast({ title: result.error || '回滚失败', variant: 'destructive', duration: 4000 });
      }
    } catch (err) {
      console.error('[ChangeList] 回滚失败:', err);
      toast({ title: '回滚失败', description: String(err), variant: 'destructive', duration: 4000 });
    } finally {
      setRestoring(null);
    }
  };

  // 🔥 监听文件内容变更事件，标记 dirty 并触发重算
  useEffect(() => {
    const handleFileChanged = (event: CustomEvent) => {
      const { fileName } = event.detail || {};
      if (fileName) {
        dirtyRef.current.add(fileName);
        setRevision(r => r + 1);
      }
    };
    window.addEventListener('changeListFileChanged', handleFileChanged as EventListener);
    return () => window.removeEventListener('changeListFileChanged', handleFileChanged as EventListener);
  }, []);

  // 点击条目 → 通知父组件在 CodeEditor 中显示 diff
  const handleClick = async (fh: FileHistory) => {
    onSelectionChange?.(fh.fileName);
    if (!onViewDiff) return;
    const oldCode = await getHistoryContent(appId, fh.fileName);
    const newCode = await getCurrentFileContent(appId, fh.fileName);
    onViewDiff(fh.fileName, oldCode ?? '', newCode ?? '');
  };

  // 回退（新文件回退 = 删除；已有文件回退 = 恢复 HEAD 内容）
  const handleRevert = async (fh: FileHistory, e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(fh.fileName);
    try {
      const oldCode = await getHistoryContent(appId, fh.fileName);
      if (oldCode != null) {
        await saveFile(appId, fh.fileName, oldCode);
      } else {
        // HEAD 中不存在（LLM 新增的文件）→ 回退即删除
        await deleteFile(appId, fh.fileName);
      }
      await commitFiles(appId, fh.fileName);
      setDiffStats(prev => { const next = { ...prev }; delete next[fh.fileName]; return next; });
      onRefresh();
      onFileHandled?.(fh.fileName, 'revert');
    } catch (err) {
      console.error('[ChangeList] 回退失败:', err);
    } finally {
      setLoading(null);
    }
  };

  // 接受
  const handleAccept = async (fh: FileHistory, e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(fh.fileName);
    try {
      await commitFiles(appId, fh.fileName);
      setDiffStats(prev => { const next = { ...prev }; delete next[fh.fileName]; return next; });
      onRefresh();
      onFileHandled?.(fh.fileName, 'accept');
    } catch (err) {
      console.error('[ChangeList] 接受失败:', err);
    } finally {
      setLoading(null);
    }
  };

  // 全部接受
  const handleAcceptAll = async () => {
    setLoading('__all__');
    try {
      await commitFiles(appId);
      setDiffStats({});
      onRefresh();
    } catch (err) {
      console.error('[ChangeList] 全部接受失败:', err);
    } finally {
      setLoading(null);
    }
  };

  const truncate = (name: string, max: number = 18) => {
    return name.length > max ? name.slice(0, max - 2) + '...' : name;
  };

  return (
    <div className="mt-3 pt-3 border-t border-gray-200">
      <div className="flex items-center justify-between mb-2 pl-1">
        <span className="text-xs font-medium text-gray-600">{t('workspace.desktopModule.fileTree.changeHistory')}</span>
        {changes.length > 1 && (
          <button
            className="text-[10px] text-green-600 hover:text-green-700 disabled:opacity-30"
            onClick={handleAcceptAll}
            disabled={loading === '__all__'}
          >{t('workspace.desktopModule.fileTree.acceptAll')}</button>
        )}
      </div>

      {changes.length === 0 ? (
        <div className="text-xs text-gray-400 text-center py-2 pl-1">{t('workspace.desktopModule.fileTree.noChanges')}</div>
      ) : (
        <div className="space-y-0.5">
          {changes.map((fh) => {
            const stats = diffStats[fh.fileName];
            const isLoading = loading === fh.fileName;

            return (
              <div
                key={fh.fileName}
                className={`flex items-center gap-1.5 py-1 px-1.5 rounded cursor-pointer ${
                  selectedFileName === fh.fileName
                    ? 'bg-blue-50 text-blue-700'
                    : 'hover:bg-gray-100'
                }`}
                onClick={() => handleClick(fh)}
                title={fh.fileName}
              >
                <FileText className="w-3 h-3 text-gray-400 flex-shrink-0" />
                <span className="text-xs text-gray-700 truncate max-w-[100px]">{truncate(fh.fileName)}</span>
                <span className="flex-1" />
                {stats && (
                  <span className="text-[10px] flex-shrink-0 leading-none mr-1">
                    <span className="text-green-600">+{stats.added}</span>
                    <span className="mx-0.5" />
                    <span className="text-red-600">-{stats.deleted}</span>
                  </span>
                )}
                {isLoading && <Loader2 className="w-3 h-3 animate-spin text-gray-400 flex-shrink-0" />}
                <button
                  className="w-4 h-4 flex items-center justify-center rounded text-[11px] text-green-600 hover:bg-green-50 flex-shrink-0 disabled:opacity-30"
                  onClick={(e) => handleAccept(fh, e)}
                  disabled={isLoading}
                  title={t('workspace.desktopModule.fileTree.acceptCurrent')}
                >✓</button>
                <button
                  className="w-4 h-4 flex items-center justify-center rounded text-[11px] text-red-500 hover:bg-red-50 flex-shrink-0 disabled:opacity-30"
                  onClick={(e) => handleRevert(fh, e)}
                  disabled={isLoading}
                  title={t('workspace.desktopModule.fileTree.revertToPrevious')}
                >✗</button>
              </div>
            );
          })}
        </div>
      )}

      {/* checkpoint 时间线（git log）：可往上追任意版本，支持整体回滚 */}
      {checkpoints.length > 0 && (
        <div className="mt-2 pl-1">
          <button
            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-700"
            onClick={() => setShowTimeline(s => !s)}
          >
            <History className="w-3 h-3" />
            版本历史（{checkpoints.length}）
          </button>
          {showTimeline && (
            <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
              {checkpoints.map((c, i) => (
                <div key={c.oid} className="flex items-center gap-1.5 py-0.5 px-1.5 rounded hover:bg-gray-50">
                  <span className="text-[11px] text-gray-600 truncate flex-1" title={c.message}>
                    {c.message}
                    {i === 0 && <span className="text-green-600 ml-0.5">（当前）</span>}
                  </span>
                  <span className="text-[10px] text-gray-400 flex-shrink-0">
                    {new Date(c.timestamp).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-[10px] text-gray-300 flex-shrink-0 font-mono">{c.oid.slice(0, 7)}</span>
                  {confirmOid === c.oid ? (
                    <button
                      className="text-[10px] text-red-600 hover:text-red-700 flex-shrink-0 px-1 py-0.5 rounded bg-red-50 disabled:opacity-30"
                      onClick={() => handleRestore(c.oid)}
                      disabled={restoring !== null}
                      title="再次点击确认回滚"
                    >
                      {restoring === c.oid ? '回滚中…' : '确认回滚'}
                    </button>
                  ) : (
                    <button
                      className="w-4 h-4 flex items-center justify-center rounded text-amber-600 hover:bg-amber-50 flex-shrink-0 disabled:opacity-30"
                      onClick={() => handleRestore(c.oid)}
                      disabled={restoring !== null}
                      title={i === 0 ? '丢弃未接受的修改（回滚到当前版本）' : '回滚到该版本（未接受的修改将丢失）'}
                    >
                      {restoring === c.oid ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
