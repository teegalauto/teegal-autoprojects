import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles, Loader2, OctagonX } from 'lucide-react';
import { getBackendUrl } from '@/config/env';

interface GPUOption {
  provider: string;
  providerDisplayName: string;
  gpuType: string;
  gpuCount: number;
  vcpuCount: number;
  memoryGB: number;
  instanceType: string;
  pricePerHour: number;
  available: boolean;
}

/** 训练中的任务（跑在云端机子上，可在此停止） */
export interface RunningTrainTask {
  id: string;
  status: string;
  instance_type: string;
  duration: number;
  cost: number;
  created_at: number;
}

interface GPUSelectorDialogProps {
  isOpen: boolean;
  userBalance: number;
  onSelect: (gpuOption: GPUOption) => void;
  onCancel: () => void;
  onRecharge?: () => void;
  /** 🔥 训练中的任务列表（上半区展示，可停止） */
  runningTasks?: RunningTrainTask[];
  /** 🔥 停止指定训练任务（弹确认填原因） */
  onStopTask?: (taskId: string) => void;
  /** 🔥 正在停止中的任务 ID（按钮转圈） */
  stoppingTaskId?: string | null;
}

const GPUSelectorDialog: React.FC<GPUSelectorDialogProps> = ({
  isOpen,
  userBalance,
  onSelect,
  onCancel,
  onRecharge,
  runningTasks = [],
  onStopTask,
  stoppingTaskId
}) => {
  const [selectedGpu, setSelectedGpu] = useState<GPUOption | null>(null);
  const [gpuOptions, setGpuOptions] = useState<GPUOption[]>([]);
  const [loading, setLoading] = useState(false);
  // 🔥 加载失败显性化：此前所有失败被静默吞掉（catch→console.warn），用户只看到空页面，
  //    远程无从诊断（真实案例：部分 Mac 用户 local-backend 未起来，弹窗空白）
  const [loadError, setLoadError] = useState<string | null>(null);

  // 🔥 从 API 获取 GPU 规格列表和可用性
  const fetchGpuData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 并行获取规格列表和可用性
      const [specsResp, availabilityResp] = await Promise.all([
        fetch(`${getBackendUrl()}/api/code-execution/gpu-specs`),
        fetch(`${getBackendUrl()}/api/code-execution/gpu-availability`)
      ]);

      let specs: GPUOption[] = [];
      let availabilityMap: Record<string, Set<string>> = {};

      // 解析规格列表
      if (specsResp.ok) {
        const specsData = await specsResp.json();
        if (specsData.success && specsData.specs) {
          specs = specsData.specs.map((spec: any) => ({
            provider: spec.provider,
            providerDisplayName: spec.providerDisplayName,
            gpuType: spec.gpuType,
            gpuCount: spec.gpuCount,
            vcpuCount: spec.vcpuCount,
            memoryGB: spec.memoryGB,
            instanceType: spec.instanceType,
            pricePerHour: spec.pricePerHour,
            available: true // 默认可用，后面根据可用性更新
          }));
        }
      }

      // 解析可用性
      // 🔥 使用 Map 记录 provider 是否有 API 数据（而不是只记录可用实例）
      const providerHasApiData = new Map<string, boolean>();
      
      if (availabilityResp.ok) {
        const availabilityData = await availabilityResp.json();
        if (availabilityData.success && availabilityData.availability) {
          for (const providerData of availabilityData.availability) {
            const provider = providerData.provider;
            availabilityMap[provider] = new Set();
            providerHasApiData.set(provider, true);  // 🔥 标记该 provider 有 API 数据
            
            for (const item of providerData.items || []) {
              if (item.available) {
                availabilityMap[provider].add(item.instanceType);
              }
            }
          }
        }
      }

      // 🔥 更新可用性状态
      specs = specs.map(spec => {
        const providerAvail = availabilityMap[spec.provider];
        const hasApiData = providerHasApiData.get(spec.provider);
        
        if (hasApiData) {
          return { ...spec, available: providerAvail?.has(spec.instanceType) || false };
        }
        return spec;
      });

      // 🔥 混合排序：可用的在前，售罄的在后；同组内按价格从低到高
      specs.sort((a, b) => {
        // 先按可用性排序（可用的在前）
        if (a.available !== b.available) {
          return a.available ? -1 : 1;
        }
        // 同组内按价格排序（价格低的在前）
        return a.pricePerHour - b.pricePerHour;
      });

      setGpuOptions(specs);
      if (specs.length === 0) {
        const st = (r: Response) => `HTTP ${r.status}`;
        setLoadError(`规格接口异常（specs: ${st(specsResp)} / availability: ${st(availabilityResp)}）——本机服务可能未启动或云端不可达`);
      }
    } catch (error: any) {
      setLoadError(`连接本机服务失败：${error?.message || String(error)}（local-backend 未运行？）`);
      console.warn('[GPU-SELECTOR] 获取数据失败:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setSelectedGpu(null);
      fetchGpuData();
    }
  }, [isOpen, fetchGpuData]);

  if (!isOpen) return null;

  const hasEnoughBalance = userBalance > 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4 backdrop-blur-sm">
      <div className="bg-white rounded-xl w-full max-w-2xl shadow-2xl border border-gray-100 animate-in fade-in zoom-in duration-200 overflow-hidden">
        
        <div className="p-6 border-b border-gray-100 flex justify-between items-center">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            🚀 选择计算实例规格
            {loading && (
              <span className="ml-2 px-2 py-0.5 text-xs font-normal text-blue-600 bg-blue-50 rounded-full inline-flex items-center gap-1 animate-pulse">
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                正在扫描可用类型...
              </span>
            )}
          </h3>
          <button
            onClick={onCancel}
            className="p-1.5 -mr-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="p-6 max-h-[400px] overflow-y-auto">
          {/* 🔥 训练中的任务（可多台并存，点击停止——与常驻面板同款体验） */}
          {runningTasks.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-500 mb-2">训练中的任务（按实际时长计费中）</div>
              <div className="grid gap-2">
                {runningTasks.map((task) => (
                  <div key={task.id} className="p-3 rounded-lg border border-blue-200 bg-blue-50/50 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      {task.status === 'running' ? (
                        <span className="h-2 w-2 rounded-full bg-green-500" />
                      ) : (
                        <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                      )}
                      <div>
                        <div className="text-sm font-medium">
                          {task.instance_type || 'GPU 任务'}
                          <span className="ml-2 text-xs text-gray-500">#{task.id.slice(0, 8)}</span>
                        </div>
                        <div className="text-xs text-gray-500 inline-flex items-center gap-0.5">
                          <Sparkles className="h-3 w-3" />已计费 {Number(task.cost || 0).toFixed(2)}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => onStopTask?.(task.id)}
                      disabled={stoppingTaskId === task.id}
                      className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded-md inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                    >
                      {stoppingTaskId === task.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <OctagonX className="w-3 h-3" />}
                      停止
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {gpuOptions.length === 0 && !loading && (
            loadError ? (
              <div className="text-center py-8">
                <div className="text-red-600 text-sm mb-3">{loadError}</div>
                <button onClick={fetchGpuData} className="px-4 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                  重试
                </button>
              </div>
            ) : (
              <div className="text-center text-gray-500 py-8">
                暂无可用的计算实例规格
              </div>
            )
          )}
          
          {/* 🔥 不再按云厂商分组，混合显示所有 GPU 规格 */}
          <div className="grid gap-2">
            {gpuOptions.map((option) => (
              <button
                key={`${option.provider}-${option.instanceType}`}
                onClick={() => setSelectedGpu(option)}
                disabled={!option.available}
                className={`p-3 rounded-lg border transition-all ${
                  selectedGpu?.instanceType === option.instanceType && selectedGpu?.provider === option.provider
                    ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                    : option.available
                      ? 'border-green-200 bg-white hover:border-green-300 hover:bg-green-50'
                      : 'border-gray-200 bg-gray-100 opacity-60 cursor-not-allowed'
                }`}
              >
                <div className="flex justify-between items-center">
                  <div className={`flex items-center gap-3 ${!option.available ? 'text-gray-400' : ''}`}>
                    <div className="text-sm font-medium">
                      {option.gpuType === 'CPU' ? 'CPU（通用计算）' : `${option.gpuType} × ${option.gpuCount}`}
                    </div>
                    <div className="text-xs text-gray-500">
                      {option.vcpuCount}核 / {option.memoryGB}GB内存
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-sm font-bold inline-flex items-center gap-0.5 ${option.available ? 'text-green-600' : 'text-gray-400'}`}>
                      <Sparkles className="h-3 w-3" />{option.pricePerHour.toFixed(2)}/小时
                    </div>
                    {!option.available && (
                      <div className="text-xs text-gray-500">已售罄</div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {selectedGpu && (
          <div className="p-4 bg-gray-50 border-t border-gray-100">
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600 inline-flex items-center gap-1">
                  当前余额：<span className={`font-bold inline-flex items-center gap-0.5 ${userBalance <= 0 ? 'text-red-600' : 'text-green-600'}`}><Sparkles className="h-3.5 w-3.5 text-violet-500" />{userBalance.toFixed(2)}</span>
                </span>
              <div className="text-sm text-gray-500">
                ⏱️ 按实际使用时间扣费
              </div>
            </div>
            
            {!hasEnoughBalance && (
              <div className="mt-2 p-2 bg-red-50 border-l-4 border-red-500 rounded-r text-sm text-red-700">
                ⚠️ 余额不足，请先充值
                {onRecharge && (
                  <button onClick={onRecharge} className="ml-2 text-blue-600 underline">
                    去充值
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="p-4 border-t border-gray-100 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-all font-medium"
          >
            取消
          </button>
          <button
            onClick={() => selectedGpu && onSelect(selectedGpu)}
            disabled={!selectedGpu || !hasEnoughBalance}
            className={`flex-1 py-2.5 px-4 rounded-lg transition-all font-bold ${
              selectedGpu && hasEnoughBalance
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {!selectedGpu ? '请选择实例规格' : !hasEnoughBalance ? '余额不足' : '确认启动'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GPUSelectorDialog;