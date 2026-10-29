import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { DATA_DIR, config } from '../config.js';
import { logger } from '../log.js';
import { masterSecretString, encrypt } from '../crypto.js';

const log = logger('bridge');

let seqCounter = 0;

/**
 * 计算运行时内置配置的 revision 指纹（宿主注入账号配置时必须精确匹配）：
 * `zcode-builtin:<rev>:<sha256(resolve(activeFilePath))>`
 * 与运行时 NodeZCodeBuiltinProviderConfigSource 的 wQi 实现一致。
 */
export function computeBuiltinRevision(builtinFilePath) {
  const doc = JSON.parse(fs.readFileSync(builtinFilePath, 'utf8'));
  const hash = crypto.createHash('sha256').update(path.resolve(builtinFilePath)).digest('hex');
  return { revision: `zcode-builtin:${doc.revision}:${hash}`, fileRevision: doc.revision };
}

/** 从 runtime_bin 推导运行时自带的内置配置路径（resources/config/provider/zcode-builtin.json） */
export function bundledBuiltinPath(runtimeBin) {
  const resourcesDir = path.dirname(path.dirname(runtimeBin)); // resources/glm/zcode.cjs → resources
  const p = path.join(resourcesDir, 'config', 'provider', 'zcode-builtin.json');
  return fs.existsSync(p) ? p : null;
}

/**
 * RuntimeSlot：一个账号专属的官方运行时子进程（zcode.cjs app-server）。
 * 隔离手段（全部官方机制）：
 *   ZCODE_DATA_BASE_DIR → data/runtimes/<id>/（凭据写在其 .zcode/v2/credentials.json）
 *   ZCODE_STORAGE_DIR   → 同目录 .zcode
 *   ZCODE_CREDENTIAL_SECRET → 主密钥（我们用同一 secret 加密凭据文件）
 *   ZCODE_TELEMETRY_DEVICE_MID → 账号 device_mid
 */
export class RuntimeSlot {
  constructor(account) {
    this.account = account;
    this.accountId = account.id;
    this.family = account.family;
    this.deviceMid = account.device_mid;
    this.tokens = account.tokens; // 已解密明文 { zcode_jwt, business_token?, ... }
    this.baseDir = path.join(DATA_DIR, 'runtimes', account.id);
    this.credFile = path.join(this.baseDir, '.zcode', 'v2', 'credentials.json');
    this.workspaceDir = path.join(this.baseDir, 'workspace');
    this.child = null;
    this.pending = new Map();     // id -> {resolve, reject, timer}
    this.notifyHandlers = new Set();
    this.buffer = '';
    this.started = false;
    this.starting = null;
    this.lastActivity = Date.now();
    this.crashStreak = 0;
    this.builtin = null;          // CDN 内置配置（updateAccountConfig 用）
    this.exited = false;
  }

  prepareDirs() {
    fs.mkdirSync(path.dirname(this.credFile), { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    // 隔离凭据库：只用官方识别的槽位
    const creds = {
      zcodejwttoken: encrypt(this.tokens.zcode_jwt),
      'oauth:active_provider': encrypt(this.family),
    };
    const providerId = `account:${this.family}-start-plan`;
    if (this.tokens.zcode_jwt) {
      creds[`account-provider:${providerId}:identity`] = encrypt(String(this.account.customer_id || ''));
      creds[`account-provider:${providerId}:auth-source`] = encrypt('oauth');
    }
    fs.writeFileSync(this.credFile, JSON.stringify(creds, null, 1), { mode: 0o600 });
    const telFile = path.join(this.baseDir, '.zcode', 'v2', 'telemetry-state.json');
    fs.writeFileSync(telFile, JSON.stringify({ deviceMid: this.deviceMid, lastDailyActiveDate: new Date().toISOString().slice(0, 10) }));
    // 个性化 provider 配置：空（账号 provider 由宿主注入，避免读真实机器配置）
    const personalFile = path.join(this.baseDir, '.zcode', 'v2', 'provider_config.json');
    if (!fs.existsSync(personalFile)) {
      fs.writeFileSync(personalFile, JSON.stringify({
        schemaVersion: 1,
        config: { providerOrder: [], providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [] } },
      }));
    }
  }

  async start() {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = this._doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _doStart() {
    if (!this.tokens.zcode_jwt) throw new Error(`账号 ${this.accountId} 无 zcode_jwt，无法启动运行时`);
    this.prepareDirs();
    const cfg = config();
    // 内置配置与 revision 指纹：优先运行时自带文件（与桌面宿主同源），否则 CDN 拉取后落盘
    const bundledPath = bundledBuiltinPath(cfg.runtime_bin);
    if (bundledPath) {
      this.builtinFile = bundledPath;
      try {
        const { revision } = computeBuiltinRevision(bundledPath);
        this.builtinRevision = revision;
      } catch (e) {
        throw new Error(`运行时内置配置读取失败: ${e.message}`);
      }
    } else {
      // 无自带文件的部署：用 CDN 配置写入隔离目录再计算指纹
      const { getBuiltinProviderConfig } = await import('../zcodeApi.js');
      const remote = await getBuiltinProviderConfig();
      const localFile = path.join(this.baseDir, '.zcode', 'v2', 'zcode-builtin.json');
      fs.writeFileSync(localFile, JSON.stringify(remote));
      this.builtinFile = localFile;
      this.builtinRevision = computeBuiltinRevision(localFile).revision;
    }
    // 按账号出站代理：运行时内嵌 proxy-from-env 栈认 ZCODE_HTTP_PROXY（官方键）与标准变量；
    // 无代理时显式清空，防继承宿主全局代理破坏账号间出口隔离
    const proxyUrl = String(this.account.proxy_url || '').trim();
    const proxyEnv = proxyUrl
      ? { ZCODE_HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl }
      : { ZCODE_HTTP_PROXY: '', HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', all_proxy: '' };
    const args = [cfg.runtime_bin, 'app-server', '--surface', 'terminal'];
    this.child = spawn(process.execPath, args, {
      cwd: this.workspaceDir,
      env: {
        ...process.env,
        ...proxyEnv,
        NO_PROXY: proxyUrl ? (process.env.NO_PROXY || '') : '*',
        no_proxy: proxyUrl ? (process.env.no_proxy || '') : '*',
        ZCODE_DATA_BASE_DIR: this.baseDir,
        ZCODE_STORAGE_DIR: path.join(this.baseDir, '.zcode'),
        ZCODE_CREDENTIAL_SECRET: masterSecretString(),
        ZCODE_TELEMETRY_DEVICE_MID: this.deviceMid,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: this.builtinFile,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(this.baseDir, '.zcode', 'v2', 'provider_config.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exited = false;

    this.child.stdout.setEncoding('utf8');
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this._onLine(line));

    let stderrBuf = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      stderrBuf = (stderrBuf + d).slice(-8000);
      if (process.env.ZCODE2API_DEBUG) log.debug(`[slot ${this.accountId} stderr]`, d.trim().slice(0, 300));
    });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.started = false;
      log.warn(`运行时退出 slot=${this.accountId} code=${code} signal=${signal}`);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('运行时进程已退出')); }
      this.pending.clear();
      this.lastStderr = stderrBuf;
      if (this.exitHandlers) for (const h of this.exitHandlers) h(code, signal, stderrBuf);
    });

    // 握手：注入账号 provider（官方宿主的正式通道；basedOn 必须是运行时内置配置的精确指纹）
    const providerId = `account:${this.family}-start-plan`;
    const params = {
      revision: String(Date.now()),
      basedOnZCodeBuiltinRevision: this.builtinRevision,
      providers: { [providerId]: { builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'], access: { type: 'zhipu-account', entitled: true } } },
      states: { [providerId]: { availability: 'available', entitled: true, current: true } },
    };
    try {
      const r = await this.request('provider/updateAccountConfig', params, { timeoutMs: 20000 });
      if (r?.status !== 'received') {
        throw new Error(`updateAccountConfig 状态异常: ${JSON.stringify(r)}`);
      }
    } catch (e) {
      await this.stop();
      throw new Error(`updateAccountConfig 失败: ${e.message}`);
    }
    this.started = true;
    this.lastActivity = Date.now();
    log.info(`运行时已就绪 slot=${this.accountId} provider=${providerId} basedOn=${this.builtinRevision.slice(0, 30)}…`);
  }

  _onLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { log.warn(`[${this.accountId}] 非 JSON 行`, t.slice(0, 120)); return; }
    this.lastActivity = Date.now();
    if (process.env.ZCODE2API_DEBUG) {
      const kind = msg.method ? `NOTIF ${msg.method}` : `RESP ${msg.id}`;
      log.debug(`[${this.accountId}] << ${kind}`, t.slice(0, 200));
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || '运行时错误'), { code: msg.error.code, data: msg.error.data }));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      // 宿主职责：应答运行时向宿主发起的请求
      this._handleHostRequest(msg).catch((e) => log.warn(`[${this.accountId}] 宿主应答失败`, msg.method, e.message));
      for (const h of this.notifyHandlers) {
        try { h(msg); } catch (e) { log.error('通知处理器异常', e); }
      }
    }
  }

  /** HostEmulator：requestRuntimePreferences 15s 内必答；runtime headers 携账号 JWT；其余最小应答 */
  async _handleHostRequest(msg) {
    const method = msg.method;
    let result = {};
    switch (method) {
      case 'session/requestRuntimePreferences':
        result = {
          nativeSearchEnhancementsEnabled: false,
          toolSearchMode: 'off',
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
          modelContextBudgetStrategy: 'preflight-v1',
        };
        break;
      case 'interaction/requestProviderRuntimeHeaders':
        // zhipu-account 模型请求前宿主必须提供鉴权头（免费链路 = ZCode JWT Bearer）
        if (!this.tokens.zcode_jwt) {
          result = { headersApplied: false, errorMessage: '账号无 zcode_jwt' };
        } else {
          result = {
            headersApplied: true,
            requestAuth: {
              apiKey: this.tokens.zcode_jwt,
              headers: { authorization: `Bearer ${this.tokens.zcode_jwt}` },
            },
          };
        }
        break;
      case 'interaction/requestOfficialMcpAuthHeaders':
        // 官方 MCP（图片搜索等）不需要鉴权头：空 headers 合法应答
        result = { ok: true, headers: {} };
        break;
      case 'provider/refreshRegistry':
      case 'workspace/updateInteractionPreferences':
      case 'workspace/updateModelIoPreferences':
      case 'workspace/updateOffPeakToolPolicy':
      case 'workspace/updateDynamicWorkflowPolicy':
      case 'workspace/hooks/trustGrant':
        result = { success: true };
        break;
      default:
        // 读类请求给空对象；写类请求成功标记——最小应答足够桥会话运行
        result = {};
    }
    if (msg.id !== undefined) this._write({ id: msg.id, result });
  }

  _write(obj) {
    if (!this.child || this.exited) throw new Error('运行时未在运行');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, { timeoutMs = 30000 } = {}) {
    if (!this.child || this.exited) return Promise.reject(new Error('运行时未在运行'));
    const id = ++seqCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`运行时请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ id, method, params }); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onNotification(handler) {
    this.notifyHandlers.add(handler);
    return () => this.notifyHandlers.delete(handler);
  }

  onExit(handler) {
    if (!this.exitHandlers) this.exitHandlers = new Set();
    this.exitHandlers.add(handler);
  }

  async stop() {
    this.started = false;
    if (this.rl) { try { this.rl.close(); } catch { /* 忽略 */ } }
    if (this.child && !this.exited) {
      try { this._write({ id: ++seqCounter, method: 'session/close', params: {} }); } catch { /* 忽略 */ }
      try { this.child.kill(); } catch { /* 忽略 */ }
      const child = this.child;
      setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch { /* 忽略 */ } }, 3000);
    }
    this.child = null;
  }

  isIdle(idleMs) {
    return this.started && Date.now() - this.lastActivity > idleMs && this.pending.size === 0;
  }
}
