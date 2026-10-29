import { db, audit } from '../db.js';
import { sha256Hex } from '../crypto.js';

/** 创建网关密钥，返回明文（仅此一次） */
export function createKey({ name, quotaLimit = null, expiresAt = null, ipWhitelist = [], modelWhitelist = [], groupOrder = null, stickyMinutes = 0, defaultLevel = null }) {
  const id = 'key_' + sha256Hex(name + Date.now() + Math.random()).slice(0, 8);
  const secret = 'zk2-' + sha256Hex(id + ':' + Math.random().toString(36).slice(2)).slice(0, 40);
  const level = ['low', 'high', 'max'].includes(defaultLevel) ? defaultLevel : null;
  db().prepare(`INSERT INTO keys(id,name,key_hash,key_tail,quota_limit,expires_at,ip_whitelist,model_whitelist,group_order,sticky_minutes,default_level,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name || 'default', sha256Hex(secret), secret.slice(-6), quotaLimit, expiresAt,
      JSON.stringify(ipWhitelist || []), JSON.stringify(modelWhitelist || []), groupOrder ? JSON.stringify(groupOrder) : null, stickyMinutes || 0, level, Date.now());
  return { id, secret };
}

export function listKeys() {
  return db().prepare('SELECT * FROM keys ORDER BY created_at').all().map((k) => ({
    ...k, ip_whitelist: JSON.parse(k.ip_whitelist || '[]'), model_whitelist: JSON.parse(k.model_whitelist || '[]'),
    group_order: k.group_order ? JSON.parse(k.group_order) : null,
  }));
}

export function deleteKey(id) {
  db().prepare('DELETE FROM keys WHERE id=?').run(id);
}

export function updateKey(id, fields) {
  const allowed = ['name', 'quota_limit', 'expires_at', 'ip_whitelist', 'model_whitelist', 'group_order', 'sticky_minutes', 'default_level', 'enabled'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    // default_level 只接受合法档位；''/null 清空为跟随全局
    if (k === 'default_level') {
      const lv = ['low', 'high', 'max'].includes(v) ? v : null;
      sets.push('default_level=?'); vals.push(lv);
      continue;
    }
    sets.push(`${k}=?`);
    vals.push(['ip_whitelist', 'model_whitelist', 'group_order'].includes(k) ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  vals.push(id);
  db().prepare(`UPDATE keys SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

/**
 * IP 白名单匹配。支持：
 *  - IPv4 CIDR：10.0.0.0/8、192.168.1.0/24
 *  - 前缀通配（旧语法）：1.2.3.*
 *  - 精确 IP：1.2.3.4
 */
export function ipAllowed(ip, patterns) {
  const ipNorm = String(ip || '').trim();
  if (!ipNorm) return false;
  for (const p of patterns || []) {
    const pat = String(p || '').trim();
    if (!pat) continue;
    if (pat === ipNorm) return true;
    if (pat.endsWith('.*')) { // 旧前缀通配
      if (ipNorm.startsWith(pat.slice(0, -1))) return true;
      continue;
    }
    const slash = pat.indexOf('/');
    if (slash > 0) {
      const ok = cidrMatch(ipNorm, pat.slice(0, slash), Number(pat.slice(slash + 1)));
      if (ok !== null && ok) return true;
    }
  }
  return false;
}

/** IPv4 CIDR 匹配；ip/base 非 IPv4 返回 null（交由其他模式处理） */
function cidrMatch(ip, base, prefix) {
  const toInt = (s) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    const [a, b, c, d] = m.slice(1).map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  };
  const ipN = toInt(ip), baseN = toInt(base);
  if (ipN === null || baseN === null) return null;
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((ipN & mask) >>> 0) === ((baseN & mask) >>> 0);
}

/**
 * 网关密钥校验。鉴权头：Authorization: Bearer <secret> 或 x-api-key。
 * 返回 { ok, key, error }；key 为行记录。
 */
export function authenticateGateway(req) {
  const auth = req.headers['authorization'] || '';
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-api-key'] || '').trim();
  if (!secret) return { ok: false, status: 401, error: '缺少 API 密钥（Authorization: Bearer 或 x-api-key）' };
  const row = db().prepare('SELECT * FROM keys WHERE key_hash=?').get(sha256Hex(secret));
  if (!row) return { ok: false, status: 401, error: '无效密钥' };
  if (!row.enabled) return { ok: false, status: 403, error: '密钥已禁用' };
  if (row.expires_at && Date.now() > row.expires_at) return { ok: false, status: 403, error: '密钥已过期' };
  if (row.quota_limit !== null && row.used_units >= row.quota_limit) {
    return { ok: false, status: 429, error: `密钥配额已用尽（${row.used_units}/${row.quota_limit}）` };
  }
  const ips = JSON.parse(row.ip_whitelist || '[]');
  if (ips.length && !ipAllowed(req.ip, ips)) {
    return { ok: false, status: 403, error: `IP ${req.ip} 不在白名单` };
  }
  db().prepare('UPDATE keys SET last_used_at=? WHERE id=?').run(Date.now(), row.id);
  return { ok: true, key: row };
}

export function keyModelAllowed(keyRow, model) {
  const list = JSON.parse(keyRow.model_whitelist || '[]');
  if (!list.length) return true;
  return list.includes(model);
}

export function keyChain(keyRow) {
  if (keyRow.group_order && Array.isArray(JSON.parse(keyRow.group_order))) return JSON.parse(keyRow.group_order);
  // 默认链 = [默认主组, 备用池]
  const groups = db().prepare('SELECT * FROM groups WHERE enabled=1 ORDER BY created_at').all();
  const primary = groups.find((g) => g.role === 'primary');
  const backup = groups.find((g) => g.role === 'backup');
  return [primary?.id, backup?.id].filter(Boolean);
}

export function addKeyUsage(keyId, units) {
  if (!units) return;
  db().prepare('UPDATE keys SET used_units = used_units + ? WHERE id=?').run(units, keyId);
}
