/**
 * ssh_remote —— 实例直连执行/写文件（userpc_shell 的免转义补充）
 *
 * 根因：LLM 经 userpc_shell 写多层引号命令（本地 PowerShell 5.1 → ssh → 远端 bash），
 * PS 5.1 向原生 exe 传参会吞引号（实测 30+ 轮转义搏斗）。
 * 解法：远端脚本整体 base64（echo B64 | base64 -d | sh）——PS 链里只剩字母数字，
 * 唯一需要转义的路径也消失；Windows/macOS/Linux 行为完全一致。
 *
 * 通道（复用 ssh_instance 基础设施）：
 * - 公钥免密主路径（BatchMode 快速失败，绝不挂起）
 * - 密码兜底：Windows=plinkExec（hostkey 两步走）/ macOS/Linux=sshpass -e（凭据注入链）
 */

import { AutoStep, AutoToolResult } from '@/utils/auto/types';
import { runLocalShellDetailed, plinkExec, resolveInstanceConnection } from './sshInstance';
import { resolveProjectId } from '@/utils/apptool/ProjectIdResolver';
import { getAppBasePath } from '@/utils/apptool/AppPathHelper';

/** Unicode 安全 base64（渲染进程无 Buffer，用 TextEncoder 分块转） */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** 远端脚本 → 单个 PS 安全 token（base64 只含 A-Za-z0-9+/=，本地链路零转义风险） */
function wrapRemote(script: string): string {
  return `echo ${b64(script)} | base64 -d | sh`;
}

function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent || '');
}

/** Windows 显式私钥路径（与 sshIdentityArg 同约定：PS 运行时展开，避免 NoProfile 下找不到默认私钥） */
function sshIdentityArg(): string {
  return isWindows() ? '-i "$env:USERPROFILE\\.ssh\\id_ed25519"' : '';
}

/** Windows pscp 完整路径（与 plink 同目录，密码兜底通道用） */
const PSCP_PATH = '"$env:USERPROFILE\\.teegal\\bin\\pscp.exe"';

/** POSIX 单引号转义（仅用于远端重定向目标路径，已在 b64 脚本内，远端 sh 解析） */
function posixQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function fail(error: string, outputs: string[] = []): AutoToolResult {
  return {
    success: false,
    error,
    data: { type: 'terminal', command: 'ssh_remote', outputs, exitCode: -1, executionTime: 0, error },
    metadata: { toolName: 'ssh_remote' },
  };
}

function ok(outputs: string[]): AutoToolResult {
  return {
    success: true,
    data: { type: 'terminal', command: 'ssh_remote', outputs, exitCode: 0, executionTime: 0 },
    metadata: { toolName: 'ssh_remote' },
  };
}

/**
 * ssh_remote 工具执行入口
 * exec:   instanceId + command → 远端命令 b64 包裹直连执行
 * upload: instanceId + remotePath + content → 内容 b64 走管道落盘，零转义
 * push:   instanceId + (localPath | projectId+filePath) + remotePath → scp 直传本地文件/目录
 *         （内容完全不流经 LLM 上下文，零大小限制；项目文件用 projectId+filePath 自动定位磁盘路径）
 */
export async function executeSshRemoteTool(
  step: AutoStep,
  _planId: string,
  _onProgress?: (progress: any) => void,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || {};
  const instanceId = String(params.instanceId || '').trim();
  const command = String(params.command || '').trim();
  const remotePath = String(params.remotePath || '').trim();
  const content = params.content !== undefined ? String(params.content) : undefined;
  const localPathRaw = String(params.localPath || '').trim();
  const projectId = String(params.projectId || params.appId || '').trim();
  const filePathParam = String(params.filePath || params.file_path || '').trim();
  // push 模式传大文件耗时不可控，默认放宽到 600s
  const timeoutSec = Number(params.timeout || 0) || (localPathRaw || (projectId && filePathParam) ? 600 : 120);

  if (!instanceId) return fail('缺少 instanceId（ssh_instance action=list 可查）');

  // 🔥 批量推送：projectId + filePaths[] + remotePath(目标目录) 一次调用推多个项目文件并保持远端目录结构
  // （部署场景 LLM 逐文件 push 要 12+ 轮，批量压成 1 轮；递归单文件时剥掉批量参数防自我递归）
  const filePathsRaw = params.filePaths || params.files;
  if (Array.isArray(filePathsRaw) && projectId && remotePath) {
    const files = filePathsRaw.filter((f: any) => typeof f === 'string' && f.trim()).slice(0, 20);
    if (files.length === 0) return fail('filePaths 数组为空。用法: ssh_remote(instanceId, mode含义省略, projectId, filePaths=["src/api.ts","src/App.tsx"], remotePath="/tmp/app")');
    const started = Date.now();
    const okLines: string[] = [];
    const errLines: string[] = [];
    const { filePaths: _fpA, files: _fsA, filePath: _fA, localPath: _lpA, ...restParams } = params;
    const baseDir = remotePath.replace(/\/+$/, '');
    for (const f of files) {
      const rel = f.trim().replace(/\\/g, '/');
      const single = await executeSshRemoteTool(
        { ...step, toolParams: { ...restParams, projectId, filePath: rel, remotePath: `${baseDir}/${rel}` } } as AutoStep,
        _planId, _onProgress, context
      );
      if (single.success) okLines.push(String(single.data?.outputs?.[0] || `✅ ${rel}`));
      else errLines.push(`- ${rel}: ${single.error}`);
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (okLines.length === 0) {
      return fail(`批量推送全部失败（${secs}s）。远端父目录可能不存在，先 exec: mkdir -p ${baseDir} 再重推\n${errLines.join('\n')}`);
    }
    return ok([
      `📂 批量推送 ${okLines.length}/${files.length} 个文件（${secs}s）${errLines.length ? `，失败 ${errLines.length} 个:\n${errLines.join('\n')}` : ''}`,
      ...okLines,
    ]);
  }

  let mode: 'exec' | 'upload' | 'push';
  let script = '';
  let localPath = '';
  if (localPathRaw || (projectId && filePathParam)) {
    // push 模式：本地路径二选一——localPath 直传绝对路径；projectId+filePath 定位项目文件磁盘路径
    mode = 'push';
    if (!remotePath) return fail('推送模式缺少 remotePath（远端目标路径，如 /tmp/chat-src）');
    if (localPathRaw) {
      localPath = localPathRaw;
    } else {
      const resolved = { id: '' };
      const resolveErr = await resolveProjectId(projectId, resolved, context?.userId);
      if (resolveErr) return fail(`projectId 解析失败: ${resolveErr}`);
      localPath = `${await getAppBasePath(resolved.id)}/${filePathParam}`;
    }
  } else if (remotePath && content !== undefined) {
    mode = 'upload';
    script = `echo ${b64(content)} | base64 -d > ${posixQuote(remotePath)} && echo WRITE_OK`;
  } else if (command) {
    mode = 'exec';
    script = command;
  } else {
    return fail('缺少 command 或 remotePath+content 或 localPath/projectId+filePath+remotePath（三选一）');
  }

  // Windows CreateProcess 命令行上限 32K：b64 膨胀 4/3，原始脚本超 2 万字符必炸，提前拦（push 走 scp 不受限）
  if (mode !== 'push' && script.length > 20000) {
    return fail('内容过大（>20000 字符）：请分块写入，或改用 push 模式（localPath/projectId+filePath scp 直传，零大小限制）');
  }

  const conn = await resolveInstanceConnection(instanceId, context?.userId);
  if (!conn) return fail(`实例 ${instanceId} 不在本地资源表或未就绪（用 ssh_instance activate/list 先确认）`);

  // push 模式：scp 直传（公钥主路径 BatchMode；密码兜底 Windows=pscp 两步走 / macOS/Linux=sshpass -e）
  if (mode === 'push') {
    const started = Date.now();
    // 🔥 scp 远端路径禁止加 shell 引号：OpenSSH 9.0+ scp 默认走 SFTP 协议（不经远端 shell），
    // 引号会被当成文件名字面量（posixQuote 只用于 exec/upload 的 b64 脚本重定向，语义不同）
    const target = `${conn.user}@${conn.host}:${remotePath}`;
    const scpIdentity = isWindows() ? sshIdentityArg() : '';

    // 🔥 push 前自动建远端父目录：scp(SFTP) 不自动创建缺失目录，父目录不存在时 scp 直接失败。
    // 曾因此连环踩坑：scp 失败 → 执行链不校验退出码回执仍 ✓ → LLM 被假回执骗 5 轮 find 定位
    const mkDir = remotePath.endsWith('/')
      ? remotePath.replace(/\/+$/, '')
      : (remotePath.replace(/\/[^/]*$/, '') || '/');
    const mkCmd = `ssh ${sshIdentityArg()} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${conn.port} ${conn.user}@${conn.host} "mkdir -p '${mkDir}'" 2>&1`.replace(/\s+/g, ' ');
    await runLocalShellDetailed(mkCmd, context?.userId, undefined, 30);

    const scpCmd = `scp ${scpIdentity} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -P ${conn.port} -r "${localPath}" ${target}`.replace(/\s+/g, ' ');
    let r = await runLocalShellDetailed(scpCmd, context?.userId, undefined, timeoutSec);

    // 🔥 scp 失败特征检测：执行链标 ✓ 不代表 scp 真成功（stderr 错误也进 out、退出码被忽略），
    // 必须按输出特征二次判定——这是"推送报成功但未落盘"假回执的根治点
    const combined = `${r.out}\n${r.err}`;
    const authFail = /Permission denied/i.test(combined);
    const scpFailSig = /No such file or directory|not a directory|is a directory|Connection refused|Connection timed out|Host key verification failed/i;
    const scpFailed = !r.ok || scpFailSig.test(combined);

    // 公钥认证失败 → 密码兜底（连接超时/拒绝不兜底，密码也救不了）
    if (authFail && conn.credentialName) {
      if (isWindows()) {
        // pscp 两步走：-batch 首连拿 hostkey 指纹 → 带 -hostkey 重连（同 plinkExec 约定）
        const pushArgs = `-P ${conn.port} -batch -pw $env:SSHPASS -r "${localPath}" ${target}`;
        const r1 = await runLocalShellDetailed(`${PSCP_PATH} ${pushArgs} 2>&1`.replace(/\s+/g, ' '), context?.userId, conn.credentialName, timeoutSec);
        const fp = r1.out.match(/SHA256:[A-Za-z0-9+/=]+/);
        if (fp && /host key is not cached/i.test(r1.out)) {
          r = await runLocalShellDetailed(`${PSCP_PATH} -hostkey "${fp[0]}" ${pushArgs} 2>&1`.replace(/\s+/g, ' '), context?.userId, conn.credentialName, timeoutSec);
        } else {
          r = r1;
        }
      } else {
        const pwCmd = `sshpass -e scp -o StrictHostKeyChecking=no -P ${conn.port} -r "${localPath}" ${target}`;
        r = await runLocalShellDetailed(pwCmd, context?.userId, conn.credentialName, timeoutSec);
      }
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (scpFailed) {
      const reason = (r.err || r.out || '').trim().split('\n').filter(Boolean).slice(-2).join('; ') || 'scp 无输出（可能超时）';
      return fail(`推送失败（${secs}s）: ${reason}`, r.out ? r.out.replace(/\n+$/, '').split('\n') : []);
    }
    return ok([`✅ 已推送 ${localPath} → ${conn.user}@${conn.host}:${remotePath}（${secs}s）`]);
  }

  const started = Date.now();
  const remote = wrapRemote(script);
  // 公钥主路径：BatchMode 认证失败立即退出（绝不挂起等密码）
  const keyCmd = `ssh ${sshIdentityArg()} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${conn.port} ${conn.user}@${conn.host} "${remote}" 2>&1`;
  let r = await runLocalShellDetailed(keyCmd, context?.userId, undefined, timeoutSec);

  // 认证失败特征：Permission denied（BatchMode 无密钥即此报错）→ 密码兜底；
  // 连接超时/拒绝不兜底（密码也救不了，避免白拖）
  if (r.ok && /Permission denied/i.test(r.out) && conn.credentialName) {
    if (isWindows()) {
      const pr = await plinkExec(conn.host, conn.user, conn.credentialName, remote, context?.userId, conn.port);
      r = { ok: !pr.err, out: pr.out, err: pr.err };
    } else {
      const pwCmd = `sshpass -e ssh -o StrictHostKeyChecking=no -p ${conn.port} ${conn.user}@${conn.host} "${remote}" 2>&1`;
      r = await runLocalShellDetailed(pwCmd, context?.userId, conn.credentialName, timeoutSec);
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const outputs = r.out ? r.out.replace(/\n+$/, '').split('\n') : [];
  if (!r.ok) {
    const hint = /超时|timeout/i.test(r.err || '')
      ? '（刚开机的实例系统启动期 sshd/磁盘较慢，属环境问题非命令问题：稍候重试或拆小命令）'
      : '';
    return fail((r.err || `远端执行失败（${secs}s）`) + hint, outputs);
  }
  if (mode === 'upload') {
    if (!r.out.includes('WRITE_OK')) {
      return fail(`写入 ${remotePath} 失败`, outputs);
    }
    return ok([`✅ 已写入 ${conn.user}@${conn.host}:${remotePath}（${content!.length} 字符，${secs}s）`]);
  }
  if (outputs.length === 0) outputs.push(`(无输出, ${secs}s)`);
  return ok(outputs);
}
