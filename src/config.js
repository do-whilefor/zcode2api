import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.ZCODE2API_DATA_DIR || path.join(ROOT_DIR, 'data');

/**
 * runtime_bin 默认值解析（DEFAULTS 初始化时调用一次；优先级 env > config.json > 平台探测）：
 * 依次探测 LOCALAPPDATA、各盘符 %X%:/Users/<user>/AppData（AppData 迁移到非系统盘的常见场景）、
 * ~/AppData、macOS 应用包、Linux 安装位。探测不到时返回占位路径——启动检查会给出清晰指引而非神秘报错。
 */
function resolveDefaultRuntimeBin() {
  const rel = path.join('resources', 'glm', 'zcode.cjs');
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', rel));
  // Windows 用户目录可能整体迁移到非系统盘（如 D:/Users/<name>/AppData）：扫常见盘符的 Users/<name>
  if (process.platform === 'win32' && (process.env.USERPROFILE || process.env.HOME)) {
    const name = path.basename(process.env.USERPROFILE || process.env.HOME); // 如 Acer
    for (const drive of ['C:', 'D:', 'E:']) {
      candidates.push(path.join(drive, path.sep, 'Users', name, 'AppData', 'Local', 'Programs', 'ZCode', rel));
    }
  }
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, '.local', 'share', 'ZCode', rel));
  if (process.platform === 'darwin') {
    candidates.push(path.join('/Applications/ZCode.app/Contents', rel));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略探测失败 */ }
  }
  return candidates[0] || path.join('resources', 'glm', 'zcode.cjs');
}

const DEFAULTS = {
  web_port: 0,          // 0 = 随机端口
  gateway_port: 0,      // 0 = 随机端口
  host: '127.0.0.1',
  admin_password: '',   // 空则首次启动生成并打印
  poll_interval_sec: 60,
  poll_jitter_sec: 10,
  poll_concurrency: 4,
  web_only_ping_min: 30,
  tool_result_timeout_sec: 600, // 等待客户端执行工具的时限（60–3600 秒）
  claim_auto_min: 240,          // 自动领卡巡检周期（分钟）
  claim_auto_enabled: true,
  runtime_idle_min: 30,         // 运行时空闲回收（过长会频繁冷启动，影响首字延迟）
  max_slots: 8,                 // 运行时槽位上限（每槽位≈一个 Node 子进程；0=不限，超限回收最旧空闲槽位）
  default_reasoning_level: 'low', // 客户端未指定 reasoning_effort/thinking 时的默认档位（low 提速最明显）
  runtime_prewarm: true,        // 启动即预热活跃账号的运行时槽位（消除首个请求的冷启动）
  runtime_bin: resolveDefaultRuntimeBin(), // ZCode 桌面运行时入口（安装路径自动探测，可 env/config 覆盖）
  app_version: '3.16.2',
  retry: {
    max_attempts: 10,
    base_delay_ms: 2000,
    backoff_factor: 2,
    max_delay_ms: 60000,
    jitter: true,
    busy_rotate_account: true,
    busy_cooldown_ms: 1000,
    busy_jitter_ms: 500,
    busy_escalation_ms: [1000, 5000, 15000],
    busy_leak_threshold: 3,
    busy_wait_sec: 60,     // 全账号忙碌时的排队窗口（秒）：0-负数回退 10s 兜底，上限 600
    total_budget_ms: 120000,
    first_token_timeout_ms: 60000,
    min_request_window_sec: 60,
  },
  aliases: {
    'glm-flash': 'GLM-5.3-Flash',
    'glm-5.3-flash': 'GLM-5.3-Flash',
    'glm-5.3': 'GLM-5.3',
  },
  notify_webhook: '',
  bind_public: false,
  proxy_url: '',        // 全局出站代理（http://host:port），留空直连
  trust_proxy: false,   // 反代部署置 true：req.ip 取 X-Forwarded-For（IP 白名单/日志才真实）
  admin_bind_public: false, // 管理面是否随 bind_public 公开（false=管理面始终绑 host/127.0.0.1，仅网关公开）
  session_mode: 'yolo', // 桥会话模式（官方仅记载 yolo；可改 ask 收紧内置工具自动执行，未验证）
  backup_enabled: true, // 每日 SQLite 快照到 data/backups
};

let _cfg = null;

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else out[k] = v;
  }
  return out;
}

export function loadConfig() {
  if (_cfg) return _cfg;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(ROOT_DIR, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try { fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
  }
  const envPort = (name) => {
    const v = process.env[name];
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
  };
  _cfg = deepMerge(DEFAULTS, fileCfg);
  const wp = envPort('ZCODE2API_WEB_PORT'); if (wp !== undefined) _cfg.web_port = wp;
  const gp = envPort('ZCODE2API_GATEWAY_PORT'); if (gp !== undefined) _cfg.gateway_port = gp;
  if (process.env.ZCODE2API_ADMIN_PASSWORD) _cfg.admin_password = process.env.ZCODE2API_ADMIN_PASSWORD;
  if (process.env.ZCODE2API_RUNTIME_BIN) _cfg.runtime_bin = process.env.ZCODE2API_RUNTIME_BIN;
  if (!_cfg.admin_password) {
    // 首次启动生成管理密码，落盘 data/admin-password.txt（仅首次）
    const pwFile = path.join(DATA_DIR, 'admin-password.txt');
    if (fs.existsSync(pwFile)) {
      _cfg.admin_password = fs.readFileSync(pwFile, 'utf8').trim();
    } else {
      _cfg.admin_password = crypto.randomBytes(9).toString('base64url');
      fs.writeFileSync(pwFile, _cfg.admin_password, { mode: 0o600 });
    }
  }
  return _cfg;
}

export function config() { return _cfg || loadConfig(); }

export function runtimeInfoFile() { return path.join(DATA_DIR, 'ports.json'); }

export function saveRuntimeInfo(info) {
  fs.writeFileSync(runtimeInfoFile(), JSON.stringify({ ...info, updated_at: new Date().toISOString() }, null, 2));
}
