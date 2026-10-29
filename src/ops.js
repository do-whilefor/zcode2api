import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { db } from './db.js';
import { logger } from './log.js';
import { encrypt, decrypt } from './crypto.js';

const log = logger('ops');

let backupTimer = null;
export function startBackupScheduler() {
  const cfg = config();
  if (!cfg.backup_enabled) return;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const run = () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const target = path.join(dir, `zcode2api-${today}.db`);
      if (!fs.existsSync(target)) {
        db().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        log.info('每日备份完成', target);
        pruneOldBackups(dir);
      }
    } catch (e) { log.warn('备份失败', e.message); }
  };
  run(); // 启动即做当天快照（存在则跳过）
  backupTimer = setInterval(run, 6 * 3600 * 1000); // 每 6h 检查一次，当日文件只落一次
}

function pruneOldBackups(dir) {
  const keep = 14;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('zcode2api-') && f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.rmSync(path.join(dir, f)); } catch { /* 忽略 */ }
  }
}

export function exportConfig() {
  const d = db();
  const rows = (sql) => d.prepare(sql).all();
  const data = {
    version: 1,
    exported_at: Date.now(),
    accounts: rows('SELECT * FROM accounts').map((a) => ({ ...a, enc_tokens: JSON.parse(a.enc_tokens) })),
    groups: rows('SELECT * FROM groups'),
    keys: rows('SELECT * FROM keys').map((k) => ({ ...k, key_hash: encrypt(k.key_hash) })), // 密钥哈希再包一层
    settings: rows('SELECT * FROM settings'),
  };
  return encrypt(JSON.stringify(data));
}

export function importConfig(encBlob, { merge = true } = {}) {
  let data;
  try { data = JSON.parse(decrypt(encBlob)); } catch { throw new Error('导入内容解密失败（密钥不一致或文件损坏）'); }
  if (!data || data.version !== 1) throw new Error('不支持的备份格式');
  const d = db();
  let counts = { accounts: 0, groups: 0, keys: 0 };
  const tx = d;
  for (const g of data.groups || []) {
    try {
      tx.prepare('INSERT INTO groups(id,name,role,family_filter,policy,urgent_window_min,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(g.id, g.name, g.role, g.family_filter, g.policy, g.urgent_window_min, g.enabled, g.created_at);
      counts.groups++;
    } catch { if (!merge) throw new Error(`分组 ${g.id} 冲突`); }
  }
  for (const a of data.accounts || []) {
    try {
      tx.prepare(`INSERT INTO accounts(id,label,family,customer_id,group_id,status,enc_tokens,device_mid,app_version,card_started_at,card_expires_at,web_cookie_expires_at,business_token_expires_at,zcode_jwt_last_ok_at,fail_streak,cooldown_until,capabilities,last_balance,last_error,source,created_at,last_ok_at,last_used_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(a.id, a.label, a.family, a.customer_id, a.group_id, a.status, JSON.stringify(a.enc_tokens), a.device_mid, a.app_version,
          a.card_started_at, a.card_expires_at, a.web_cookie_expires_at, a.business_token_expires_at, a.zcode_jwt_last_ok_at,
          a.fail_streak, a.cooldown_until, a.capabilities, a.last_balance, a.last_error, a.source, a.created_at, a.last_ok_at, a.last_used_at);
      counts.accounts++;
    } catch { if (!merge) throw new Error(`账号 ${a.id} 冲突`); }
  }
  for (const k of data.keys || []) {
    let hash;
    try { hash = decrypt(k.key_hash); } catch { continue; }
    try {
      tx.prepare(`INSERT INTO keys(id,name,key_hash,key_tail,quota_limit,used_units,expires_at,ip_whitelist,model_whitelist,group_order,sticky_minutes,enabled,created_at,last_used_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(k.id, k.name, hash, k.key_tail, k.quota_limit, k.used_units, k.expires_at, k.ip_whitelist, k.model_whitelist, k.group_order, k.sticky_minutes, k.enabled, k.created_at, k.last_used_at);
      counts.keys++;
    } catch { if (!merge) throw new Error(`密钥 ${k.id} 冲突`); }
  }
  return { ok: true, counts };
}
