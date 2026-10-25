import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles, Cloud, Loader2, OctagonX, Copy, Check, Unlink, Plus, CalendarSync } from 'lucide-react';
import { getBackendUrl } from '@/config/env';
import { sshListActive, sshCloseInstance, sshAddSelfInstance, sshGetInstanceDetail, sshRenewInstance } from '@/utils/systemtools/sshInstance';

/**
 * 云端常驻实例选择弹窗（长期租赁语义，与 GPUSelectorDialog 的短任务区分）
 * - 上半区：当前活跃实例（可关机，防止重复开机计费）
 * - 下半区：CPU/GPU 规格 + 单价，选中后开机（常驻直到手动关机）
 * 架构原则：本组件只做 React 触点，开机/关机/列表逻辑统一走 sshInstance 核心层
 * （与 LLM ssh_instance 工具同一条链路）。
 * 注：SSH 是底层通道名词，只出现在给 LLM 的工具/凭据描述里，UI 不露出
 */

export interface SshSpecOption {
  gpuType: string;
  gpuCount: number;
  instanceType: string;
  vcpuCount: number;
  memoryGB: number;
  pricePerHour: number;
  pricePerDay: number;
}

// ===== 长租月租（与云端 RentalService 折扣口径一致：>6月 5/6，1-6月 11/12；月=720 时）=====
export const PREPAID_MAX_MONTHS = 12;
const PREPAID_MONTH_HOURS = 720;
/** 低毛利机型不参与长租折扣（与云端 RentalService.PREPAID_NO_DISCOUNT_TYPES 同口径，预付一律原价）——当前无豁免机型（SA5.LARGE16 已下架） */
const PREPAID_NO_DISCOUNT_TYPES = new Set<string>();

export function prepaidUnitPrice(basePerHour: number, months: number, instanceType?: string): number {
  if (instanceType && PREPAID_NO_DISCOUNT_TYPES.has(instanceType)) return basePerHour;
  return Math.round(basePerHour * (months > 6 ? 5 / 6 : 11 / 12) * 100) / 100;
}

export function prepaidTotalPrice(basePerHour: number, months: number, instanceType?: string): number {
  return Math.round(prepaidUnitPrice(basePerHour, months, instanceType) * PREPAID_MONTH_HOURS * months * 100) / 100;
}

/** 活跃实例（本地资源表字段，sync 自愈校正后） */
interface ActiveInstance {
  id: string;                 // cloud_rental_id
  instance_id: string;
  instance_type: string;
  status: string;
  host: string;               // 公网 IP
  username: string;           // 登录用户（镜像决定，ubuntu 为主）
  app_id: string;             // 项目归属（开机登记；空 = 未关联项目）
  price_per_hour: number;
  credential_name: string;    // 对应凭据编号（ssh_ins-xxx）
  source: string;             // cloud=云端租赁（计费）/ workstation=用户自有机器（不计费）
  port: number;               // SSH 端口（自有机器可能非 22）
}

interface SSHSelectorDialogProps {
  isOpen: boolean;
  userBalance: number;
  /** 当前项目 appId（归属标签用：本项目 / 其他项目 / 未关联） */
  currentAppId?: string | null;
  onSelect: (spec: SshSpecOption, months?: number) => void;
  onCancel: () => void;
  onRecharge?: () => void;
  userId?: string;
  /** 续费成功后刷新余额显示 */
  onBalanceChanged?: () => void;
}

const SSHSelectorDialog: React.FC<SSHSelectorDialogProps> = ({
  isOpen,
  userBalance,
  currentAppId,
  onSelect,
  onCancel,
  onRecharge,
  userId,
  onBalanceChanged
}) => {
  const [selectedSpec, setSelectedSpec] = useState<SshSpecOption | null>(null);
  const [rentMonths, setRentMonths] = useState<number | null>(null);
  const [specs, setSpecs] = useState<SshSpecOption[]>([]);
  const [activeInstances, setActiveInstances] = useState<ActiveInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 续费（预付长租）：展开行内月数选择 + 确认；按量实例点开提示无需续费
  const [renewId, setRenewId] = useState<string | null>(null);
  const [renewMonths, setRenewMonths] = useState(1);
  const [renewExpireAt, setRenewExpireAt] = useState<number | null>(null);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);
  // 自有机器绑定表单
  const [showSelfForm, setShowSelfForm] = useState(false);
  const [selfHost, setSelfHost] = useState('');
  const [selfPort, setSelfPort] = useState('22');
  const [selfUsername, setSelfUsername] = useState('root');
  const [selfPassword, setSelfPassword] = useState('');
  const [selfAdding, setSelfAdding] = useState(false);
  const [selfProgress, setSelfProgress] = useState('');
  const [selfError, setSelfError] = useState<string | null>(null);
  // 🔥 加载失败显性化：此前 catch→console.warn 全静默，local-backend 未启动时用户只看到空页
  const [loadError, setLoadError] = useState<string | null>(null);

  // 复制 ssh 地址（user@IP，可直接拼连接命令），成功显示对勾 1.5s
  const handleCopyAddress = async (inst: ActiveInstance) => {
    try {
      const addr = `${inst.username || 'ubuntu'}@${inst.host}`;
      await navigator.clipboard.writeText(addr);
      setCopiedId(inst.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (error) {
      console.warn('[SSH-SELECTOR] 复制地址失败:', error);
    }
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 规格清单（展示型，直连本地转发）；活跃实例走核心层（带云端自愈校正）
      const [typesResp, active] = await Promise.all([
        fetch(`${getBackendUrl()}/api/rental/types`),
        sshListActive(userId)
      ]);

      if (!typesResp.ok) {
        setLoadError(`规格接口异常（HTTP ${typesResp.status}）——本机服务可能未启动或云端不可达`);
      } else if (!active.ok) {
        setLoadError(`实例列表查询失败：${active.error || '未知错误'}`);
      }

      if (typesResp.ok) {
        const data = await typesResp.json();
        if (data.success && data.types) {
          setSpecs(data.types.map((t: any) => ({
            gpuType: t.gpuType,
            gpuCount: t.gpuCount,
            instanceType: t.instanceType,
            vcpuCount: t.vcpuCount,
            memoryGB: t.memoryGB,
            pricePerHour: t.pricePerHour,
            pricePerDay: t.pricePerDay
          })).sort((a: SshSpecOption, b: SshSpecOption) => a.pricePerHour - b.pricePerHour));
        }
      }

      if (active.ok) {
        setActiveInstances(active.instances.map((r: any) => ({
          // 自有机器（workstation）无云端键，必须用本地 id，否则解绑传错 id
          id: r.source === 'workstation' ? r.id : (r.cloud_rental_id || r.cloud_instance_id),
          instance_id: r.source === 'workstation' ? 'self' : (r.cloud_instance_id || ''),
          instance_type: r.instance_type,
          status: r.status,
          host: r.host || '',
          username: r.username || '',
          app_id: r.app_id || '',
          price_per_hour: r.price_per_hour || 0,
          credential_name: r.credential_name || '',
          source: r.source || 'cloud',
          port: r.port || 22,
        })));
      }
    } catch (error: any) {
      setLoadError(`连接本机服务失败：${error?.message || String(error)}（local-backend 未运行？）`);
      console.warn('[SSH-SELECTOR] 获取数据失败:', error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (isOpen) {
      setSelectedSpec(null);
      setRentMonths(null);
      setRenewId(null);
      fetchData();
    }
  }, [isOpen, fetchData]);

  // 续费：先查详情判断长租（按量实例提示无需续费），展开行内月数选择
  const handleRenewClick = async (inst: ActiveInstance) => {
    if (renewId === inst.id) {
      setRenewId(null);
      return;
    }
    setRenewId(inst.id);
    setRenewMonths(1);
    setRenewExpireAt(null);
    setRenewError(null);
    const d = await sshGetInstanceDetail(inst.id, userId);
    if (d.ok && d.instance?.prepaid) {
      setRenewExpireAt(d.instance.prepaid.expire_at);
    } else if (d.ok) {
      setRenewError('按量计费实例无需续费（关机即停止计费）');
    } else {
      setRenewError(d.error || '查询预付信息失败');
    }
  };

  const handleRenewConfirm = async () => {
    if (!renewId || renewExpireAt === null) return;
    setRenewBusy(true);
    setRenewError(null);
    try {
      const r = await sshRenewInstance(renewId, renewMonths, userId);
      if (!r.ok) {
        setRenewError(r.error || '续费失败');
        return;
      }
      setRenewId(null);
      await fetchData();
      onBalanceChanged?.();
    } catch (error: any) {
      setRenewError(error?.message || String(error));
    } finally {
      setRenewBusy(false);
    }
  };

  // 关机/解绑（核心层统一处理：云端实例走云端结算；自有机器仅解绑 + 凭据同步删除）
  const handleCloseInstance = async (inst: ActiveInstance) => {
    setClosingId(inst.id);
    try {
      const r = await sshCloseInstance(inst.id, userId);
      if (!r.ok) {
        console.warn('[SSH-SELECTOR] 关机失败:', r.error);
        return;
      }
      await fetchData();
    } catch (error) {
      console.warn('[SSH-SELECTOR] 关机失败:', error);
    } finally {
      setClosingId(null);
    }
  };

  // 绑定自有机器（核心层负责连通测试/公钥注入/凭据入库/建档，失败自动回滚）
  const handleSubmitSelf = async () => {
    if (!selfHost.trim() || !selfUsername.trim() || !selfPassword) {
      setSelfError('请填写服务器地址、用户名和密码');
      return;
    }
    setSelfAdding(true);
    setSelfError(null);
    try {
      const r = await sshAddSelfInstance({
        host: selfHost.trim(),
        port: Number(selfPort) || 22,
        username: selfUsername.trim(),
        password: selfPassword,
        projectId: currentAppId || undefined,
        userId,
        onProgress: (msg) => setSelfProgress(msg),
      });
      if (!r.ok) {
        setSelfError(r.error || '绑定失败');
        return;
      }
      setShowSelfForm(false);
      setSelfHost(''); setSelfPort('22'); setSelfUsername('root'); setSelfPassword('');
      await fetchData();
    } catch (error: any) {
      setSelfError(error?.message || String(error));
    } finally {
      setSelfAdding(false);
      setSelfProgress('');
    }
  };

  if (!isOpen) return null;

  const prepaidNeed = selectedSpec && rentMonths ? prepaidTotalPrice(selectedSpec.pricePerHour, rentMonths, selectedSpec.instanceType) : 0;
  // 按量只要余额 > 0（开机预检 1 小时费）；长租需一次付清总额
  const hasEnoughBalance = rentMonths ? userBalance >= prepaidNeed : userBalance > 0;
  const pillCls = (active: boolean) =>
    `px-2 py-1 text-xs rounded-md border transition-colors ${
      active ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium' : 'border-gray-200 bg-white text-gray-600 hover:border-blue-300'
    }`;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-full shadow-2xl border border-gray-100 animate-in fade-in zoom-in duration-200 flex flex-col">

        <div className="p-6 border-b border-gray-100 flex justify-between items-center shrink-0">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Cloud className="h-5 w-5" /> 常驻实例
            {loading && <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />}
          </h3>
          <button
            onClick={onCancel}
            className="p-1.5 -mr-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="p-6 flex-1 min-h-0 overflow-y-auto">
          {/* 🔥 加载失败显性化：错误 + 重试，替代空白页 */}
          {loadError && (
            <div className="mb-4 text-center py-4">
              <div className="text-red-600 text-sm mb-3">{loadError}</div>
              <button onClick={fetchData} className="px-4 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                重试
              </button>
            </div>
          )}

          {/* 活跃实例：常驻中，可关机（云端）/ 解绑（自有机器，不影响机器本身） */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-gray-500">运行中的实例</div>
              <button
                onClick={() => { setShowSelfForm(!showSelfForm); setSelfError(null); }}
                className="text-xs text-violet-600 hover:text-violet-700 inline-flex items-center gap-0.5 font-medium transition-colors"
              >
                <Plus className="w-3 h-3" /> 自有机器
              </button>
            </div>

            {/* 自有机器绑定表单（不计费、不过云端账本） */}
            {showSelfForm && (
              <div className="mb-2 p-3 rounded-lg border border-violet-200 bg-violet-50/50">
                <div className="grid grid-cols-[1fr_70px_1fr] gap-2 mb-2">
                  <input value={selfHost} onChange={(e) => setSelfHost(e.target.value)} disabled={selfAdding} placeholder="服务器地址（IP / 域名）" className="px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:opacity-50" />
                  <input value={selfPort} onChange={(e) => setSelfPort(e.target.value)} disabled={selfAdding} placeholder="端口" className="px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:opacity-50" />
                  <input value={selfUsername} onChange={(e) => setSelfUsername(e.target.value)} disabled={selfAdding} placeholder="用户名（root / ubuntu）" className="px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:opacity-50" />
                </div>
                <div className="flex gap-2">
                  <input type="password" value={selfPassword} onChange={(e) => setSelfPassword(e.target.value)} disabled={selfAdding} placeholder="密码" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:opacity-50" />
                  <button onClick={handleSubmitSelf} disabled={selfAdding} className="px-3 py-1.5 text-xs font-medium bg-violet-600 text-white rounded-md hover:bg-violet-700 inline-flex items-center gap-1 whitespace-nowrap disabled:opacity-50 transition-colors">
                    {selfAdding && <Loader2 className="w-3 h-3 animate-spin" />}
                    {selfAdding ? (selfProgress || '处理中...') : '绑定'}
                  </button>
                </div>
                {selfError && <div className="mt-2 text-xs text-red-600">{selfError}</div>}
              </div>
            )}

            {activeInstances.length > 0 && (
              <div className="grid gap-2">
                {activeInstances.map((inst) => (
                  <div key={inst.id} className={`rounded-lg border ${inst.source === 'workstation' ? 'border-violet-200 bg-violet-50/50' : 'border-blue-200 bg-blue-50/50'}`}>
                    <div className="p-3 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      {inst.status === 'running' ? (
                        <span className="h-2 w-2 rounded-full bg-green-500" />
                      ) : (
                        <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                      )}
                      <div>
                        <div className="text-sm font-medium flex items-center gap-1">
                          {inst.host || '开机中...'}
                          {inst.host && (
                            <button
                              onClick={() => handleCopyAddress(inst)}
                              title={`复制 ${inst.username || 'ubuntu'}@${inst.host}`}
                              className="p-0.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                            >
                              {copiedId === inst.id
                                ? <Check className="w-3 h-3 text-green-600" />
                                : <Copy className="w-3 h-3" />}
                            </button>
                          )}
                          <span className="ml-1 text-xs text-gray-500">{inst.instance_type}</span>
                          {inst.source === 'workstation' && (
                            <span className="text-[10px] px-1.5 py-px rounded-full bg-violet-100 text-violet-700">自有</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 inline-flex items-center gap-0.5">
                          {inst.source === 'workstation' ? (
                            <span className="text-violet-600 font-medium">自有 · 不计费</span>
                          ) : (
                            <><Sparkles className="h-3 w-3" />{Number(inst.price_per_hour).toFixed(2)}/小时</>
                          )}
                          {/* 归属标签：项目视角下的机器归属（全局列表也能看出关联） */}
                          <span className={`ml-2 text-[10px] px-1.5 py-px rounded-full ${
                            inst.app_id === currentAppId
                              ? 'bg-blue-100 text-blue-700'
                              : inst.app_id
                                ? 'bg-gray-100 text-gray-500'
                                : 'bg-gray-50 text-gray-400 border border-gray-200'
                          }`}>
                            {inst.app_id === currentAppId ? '本项目' : inst.app_id ? '其他项目' : '未关联'}
                          </span>
                          {inst.credential_name && (
                            <span className="ml-2 text-gray-400">凭据: {inst.credential_name}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {inst.source !== 'workstation' && (
                        <button
                          onClick={() => handleRenewClick(inst)}
                          className="px-2 py-1 text-xs rounded-md text-blue-600 hover:bg-blue-50 inline-flex items-center gap-1 transition-colors"
                        >
                          <CalendarSync className="w-3 h-3" /> 续费
                        </button>
                      )}
                      <button
                        onClick={() => handleCloseInstance(inst)}
                        disabled={closingId === inst.id}
                        className={`px-2 py-1 text-xs rounded-md inline-flex items-center gap-1 transition-colors disabled:opacity-50 ${
                          inst.source === 'workstation' ? 'text-gray-500 hover:bg-gray-100' : 'text-red-600 hover:bg-red-50'
                        }`}
                      >
                        {closingId === inst.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : inst.source === 'workstation' ? (
                          <Unlink className="w-3 h-3" />
                        ) : (
                          <OctagonX className="w-3 h-3" />
                        )}
                        {inst.source === 'workstation' ? '解绑' : '关机'}
                      </button>
                    </div>
                    </div>
                    {renewId === inst.id && (
                      <div className="px-3 pb-3">
                        <div className="p-2 rounded-md bg-white border border-blue-100 text-xs flex items-center gap-2 flex-wrap">
                          <select
                            value={renewMonths}
                            onChange={(e) => setRenewMonths(Number(e.target.value))}
                            disabled={renewBusy}
                            className="px-1.5 py-1 rounded-md border border-gray-200 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-300"
                          >
                            {Array.from({ length: PREPAID_MAX_MONTHS }, (_, i) => i + 1).map(m => (
                              <option key={m} value={m}>{m} 个月</option>
                            ))}
                          </select>
                          <span className="text-gray-600">
                            预付 <span className="font-bold text-blue-600">{(prepaidUnitPrice(inst.price_per_hour, renewMonths, inst.instance_type) * 720 * renewMonths).toFixed(2)}</span> 积分（{prepaidUnitPrice(inst.price_per_hour, renewMonths, inst.instance_type).toFixed(2)}/时）
                          </span>
                          {renewExpireAt !== null && (
                            <span className="text-gray-500">
                              {new Date(renewExpireAt).toLocaleDateString()} → {new Date(renewExpireAt + renewMonths * 30 * 86400000).toLocaleDateString()}
                            </span>
                          )}
                          <button
                            onClick={handleRenewConfirm}
                            disabled={renewBusy || renewExpireAt === null || userBalance < prepaidUnitPrice(inst.price_per_hour, renewMonths, inst.instance_type) * 720 * renewMonths}
                            className="ml-auto px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                          >
                            {renewBusy ? '续费中...' : '确认续费'}
                          </button>
                        </div>
                        {renewError && <div className="mt-1.5 text-xs text-red-600">{renewError}</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 规格列表 */}
          <div className="text-xs font-medium text-gray-500 mb-2">开机新实例（CPU / GPU 均可长租）</div>
          <div className="grid gap-2">
            {specs.map((spec) => (
              <button
                key={spec.instanceType}
                onClick={() => setSelectedSpec(spec)}
                className={`p-3 rounded-lg border transition-all ${
                  selectedSpec?.instanceType === spec.instanceType
                    ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                    : 'border-green-200 bg-white hover:border-green-300 hover:bg-green-50'
                }`}
              >
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="text-sm font-medium">
                      {spec.gpuType === 'CPU' ? 'CPU（通用计算）' : `${spec.gpuType} × ${spec.gpuCount}`}
                    </div>
                    <div className="text-xs text-gray-500">
                      {spec.vcpuCount}核 / {spec.memoryGB}GB内存
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-green-600 inline-flex items-center gap-0.5">
                      <Sparkles className="h-3 w-3" />{spec.pricePerHour.toFixed(2)}/时
                    </div>
                    <div className="text-xs text-gray-500">≈ {spec.pricePerDay.toFixed(0)}/天</div>
                  </div>
                </div>
              </button>
            ))}
            {specs.length === 0 && !loading && (
              <div className="text-center text-gray-500 py-6">暂无可租赁规格（云端未发布或加载失败）</div>
            )}
          </div>
        </div>

        {selectedSpec && (
          <div className="p-4 bg-gray-50 border-t border-gray-100 shrink-0">
            {/* 计费方式：按量 / 长租两档（1-6月 0.55，6月以上 0.5），选中档后选具体月数 */}
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              <span className="text-xs text-gray-500 mr-0.5">计费：</span>
              <button onClick={() => setRentMonths(null)} className={pillCls(rentMonths === null)}>
                按量 {selectedSpec.pricePerHour.toFixed(2)}/时
              </button>
              <button
                onClick={() => setRentMonths(rentMonths && rentMonths <= 6 ? rentMonths : 1)}
                className={pillCls(rentMonths !== null && rentMonths <= 6)}
              >
                1-6个月 {prepaidUnitPrice(selectedSpec.pricePerHour, 1, selectedSpec.instanceType).toFixed(2)}/时
              </button>
              <button
                onClick={() => setRentMonths(rentMonths && rentMonths > 6 ? rentMonths : 7)}
                className={pillCls(rentMonths !== null && rentMonths > 6)}
              >
                6个月以上 {prepaidUnitPrice(selectedSpec.pricePerHour, 7, selectedSpec.instanceType).toFixed(2)}/时
              </button>
              {rentMonths !== null && (
                <select
                  value={rentMonths}
                  onChange={(e) => setRentMonths(Number(e.target.value))}
                  className="px-1.5 py-1 text-xs rounded-md border border-gray-200 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-300"
                >
                  {/* 全量 1-12：下拉直接选任意月数，档位 pill 联动高亮（>6 自动切 0.50 档） */}
                  {Array.from({ length: PREPAID_MAX_MONTHS }, (_, i) => i + 1).map(m => (
                    <option key={m} value={m}>{m} 个月</option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600 inline-flex items-center gap-1">
                当前余额：<span className={`font-bold inline-flex items-center gap-0.5 ${userBalance <= 0 ? 'text-red-600' : 'text-green-600'}`}><Sparkles className="h-3.5 w-3.5 text-violet-500" />{userBalance.toFixed(2)}</span>
              </span>
              <div className="text-sm text-gray-500">
                {rentMonths ? (
                  <>预付总额：<span className="font-bold text-blue-600">{prepaidNeed.toFixed(2)} 积分</span>（到期自动关机，提前关机按原价折算退差额）</>
                ) : (
                  '⏱️ 开机即计费，关机停止'
                )}
              </div>
            </div>
            {!hasEnoughBalance && (
              <div className="mt-2 p-2 bg-red-50 border-l-4 border-red-500 rounded-r text-sm text-red-700">
                ⚠️ {rentMonths ? `余额不足付长租总额 ${prepaidNeed.toFixed(2)}，` : ''}请先充值
                {onRecharge && (
                  <button onClick={onRecharge} className="ml-2 text-blue-600 underline">
                    去充值
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="p-4 border-t border-gray-100 flex gap-3 shrink-0">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-all font-medium"
          >
            取消
          </button>
          <button
            onClick={() => selectedSpec && onSelect(selectedSpec, rentMonths || undefined)}
            disabled={!selectedSpec || !hasEnoughBalance}
            className={`flex-1 py-2.5 px-4 rounded-lg transition-all font-bold ${
              selectedSpec && hasEnoughBalance
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {!selectedSpec
              ? '请选择实例规格'
              : !hasEnoughBalance
                ? '余额不足'
                : rentMonths
                  ? `预付开机（${prepaidNeed.toFixed(2)}）`
                  : '开机'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SSHSelectorDialog;
