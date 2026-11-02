/**
 * 多平台每日签到 · Cloudflare Worker（单文件）
 *
 * 一套部署、一个控制台、一条定时任务，管理下面 6 个平台的每日签到：
 *
 *   trae              Trae（抖音扫码 / 设备密钥 / refreshToken 续期）
 *   workbuddy         WorkBuddy 国内版（微信扫码 / refreshToken 续期）
 *   workbuddy_intl    WorkBuddy 国际版（Google / GitHub / X 授权，或粘贴 token）
 *   zhipu             智谱清言（chatglm_token，需要 CHATGLM_SIGN_SECRET）
 *   loomy             讯飞 Loomy（token）
 *   astudio           讯飞 AStudio（Cookie，或手机号 + 密码换会话）
 *
 * 代码结构：
 *   0. 公共工具        编码 / 时间 / HTTP / MD5 / 加密保险箱
 *   1. Trae 模块       设备身份、抖音扫码授权、签到与积分查询
 *   2. WorkBuddy 模块  扫码授权、令牌轮换、签到
 *   3. 通用平台工厂    KV / 加密 / 签到编排 / 增删改查 / 路由
 *   4. 国际版模块      WorkBuddy 国际版（协议差异较大，单独实现）
 *   5. 外壳            平台注册表 + 聚合接口 + 定时任务
 *   6. 控制台页面      参考「签到台」的极简工具风（账号列表 / 运行历史 / 教程）
 *
 * 环境绑定：
 *
 *   KV 绑定    KV                     一个命名空间即可，按平台前缀隔离
 *   Secret     MASTER_KEY             32 字节随机值的 base64，所有平台共用
 *   Secret     ADMIN_TOKEN            控制台登录密码
 *   Secret     CRON_SECRET            （可选）/cron 独立口令，缺省回落到 ADMIN_TOKEN
 *   Secret     CHATGLM_SIGN_SECRET    （可选）智谱客户端签名盐；不配则智谱不可用
 *   变量       <平台键>_VERIFIED      （可选）覆盖页面上的「未验证」标记，如 ZHIPU_VERIFIED=true
 *
 * Cron 配置（Cloudflare 的 cron 走 UTC，比北京时间慢 8 小时）：
 *   北京 08:10 = UTC 00:10
 *   crons = ["10 0 * * *"]
 */
'use strict';

/* ================================================================== */
/* 模块零：公共工具                                                     */
/* ================================================================== */

const SH = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64decode(str) {
    const bin = atob(String(str).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function b64urlEncode(buf) {
    return b64encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    return b64decode(s + '='.repeat((4 - (s.length % 4)) % 4));
  }

  function randomId(bytes = 12) {
    return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
  }

  function randomHex(bytes = 16) {
    const b = crypto.getRandomValues(new Uint8Array(bytes));
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  /** 定长比较，避免口令被时序侧信道猜出来 */
  function timingSafeEqual(a, b) {
    const x = enc.encode(String(a ?? ''));
    const y = enc.encode(String(b ?? ''));
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  }

  const bjDay = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
  const bjHour = (ms = Date.now()) => new Date(ms + 8 * 3600e3).getUTCHours();

  function fmtBj(ms) {
    if (!ms) return '';
    return new Date(ms + 8 * 3600e3).toISOString().replace('Z', ' +08:00');
  }

  function fmtBjShort(ms) {
    if (!ms) return '';
    return new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  }

  /** 北京时间下一次 HH:MM 的字符串（用于「下次自动签到」展示） */
  function nextRunBj(hour = 8, minute = 10) {
    const bj = new Date(Date.now() + 8 * 3600e3);
    const target = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), hour, minute, 0));
    if (target.getTime() <= bj.getTime()) target.setUTCDate(target.getUTCDate() + 1);
    return target.toISOString().slice(0, 16).replace('T', ' ');
  }

  async function sha256Hex(data) {
    const buf = typeof data === 'string' ? enc.encode(data) : data;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  /** MD5（Cloudflare Web Crypto 不提供，智谱 X-Sign 需要） */
  function md5(str) {
    const bytes = enc.encode(String(str));
    const len = bytes.length;
    const total = (((len + 8) >>> 6) + 1) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer);
    const bitLen = len * 8;
    view.setUint32(total - 8, bitLen >>> 0, true);
    view.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true);

    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

    let a0 = 0x67452301 | 0;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476 | 0;

    for (let off = 0; off < total; off += 64) {
      const M = new Int32Array(16);
      for (let j = 0; j < 16; j++) M[j] = view.getInt32(off + j * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        const s = S[i];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    ov.setInt32(0, a0, true);
    ov.setInt32(4, b0, true);
    ov.setInt32(8, c0, true);
    ov.setInt32(12, d0, true);
    let hex = '';
    for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
    return hex;
  }

  function stripBearer(tok) {
    let s = String(tok ?? '').trim();
    if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, '').trim();
    return s;
  }

  function jwtClaims(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    try {
      return JSON.parse(dec.decode(b64urlDecode(parts[1]))) || {};
    } catch {
      return {};
    }
  }

  function jwtExp(token) {
    const c = jwtClaims(token);
    let v = Number(c.exp || c.TokenExpireAt || 0) || 0;
    if (v > 1e12) v = Math.floor(v / 1000);
    return v;
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function httpJson(url, { method = 'POST', headers = {}, body = '{}', timeout = 20000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: method === 'GET' ? undefined : body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON 响应留给调用方从 text 里看 */
      }
      return { status: res.status, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** AES-256-GCM 保险箱：每条记录随机 salt/IV，密钥由 MASTER_KEY 经 HKDF 派生 */
  function makeVault(info) {
    async function deriveKey(env, salt) {
      const raw = env.PLATFORM_MASTER_KEY;
      if (!raw) throw new Error('缺少 MASTER_KEY');
      let master;
      try {
        master = b64decode(String(raw).trim());
      } catch {
        throw new Error('MASTER_KEY 不是合法 base64');
      }
      if (master.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节（base64 后 44 字符）');
      const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    return {
      async seal(env, obj) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(env, salt);
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
        return JSON.stringify({ v: 1, s: b64encode(salt), i: b64encode(iv), d: b64encode(ct) });
      },
      async open(env, text) {
        const box = JSON.parse(text);
        if (box.v !== 1) throw new Error('不认识的记录版本');
        const key = await deriveKey(env, b64decode(box.s));
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64decode(box.i) },
          key,
          b64decode(box.d)
        );
        return JSON.parse(dec.decode(pt));
      },
    };
  }

  return {
    enc, dec, b64encode, b64decode, b64urlEncode, b64urlDecode, randomId, randomHex,
    timingSafeEqual, bjDay, bjHour, fmtBj, fmtBjShort, nextRunBj, sha256Hex, md5,
    stripBearer, jwtClaims, jwtExp, num, httpJson, makeVault,
  };
})();

/** 凭证失效（需要重新登录） */
class PlatformAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformAuthError';
    this.auth = true;
  }
}
/* ================================================================== */
/* 模块一：Trae —— 设备身份 / 扫码授权 / 签到 */
/* ================================================================== */

const Trae = (() => {
const API = 'https://api.trae.cn';

const EP = {
  claim: '/trae/api/v2/ug/checkin_credits/claim',
  status: '/trae/api/v2/ug/checkin_credits/status',
  entitle: '/trae/api/v2/pay/user_current_entitlement_list',
  exchange: '/trae/api/v3/oauth/ExchangeToken',
  exchangeLegacy: 'https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken',
};

const CLIENT_ID_IDE = 'ono9krqynydwx5';
const CLIENT_ID_OLD = 'en1oxy7wnw8j9n';
const IDE_VERSION = '1.107.1';
const UA = 'Trae/' + IDE_VERSION;

/* 扫码登录（网页授权）用到的固定参数，随官网版本更新而变 */
const AUTHORIZE_BASE = 'https://www.trae.cn';
const OAUTH_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const OAUTH_APP_VERSION = '3.3.100';
const OAUTH_PLUGIN_VERSION = '2.3.83560';

/* 回调地址：官网只认 http://127.0.0.1:<端口>，换成域名（包括 localhost、https、无端口）
   都会让登录页立刻显示「登录失败 · 网络错误」，与扫码无关。
   所以固定指向本机一个没有服务的端口：登录完成后浏览器会停在一个打不开的页面，
   用户把地址栏里的整段链接粘回控制台即可完成绑定。 */
const CALLBACK_LOCAL = 'http://127.0.0.1:17388/authorize';
/* Trae 产品线的授权参数：client_id 与 platform 必须成对，随官网版本更新而变 */
const TRAE_LINE = { authFrom: 'trae', clientId: 'ono9krqynydwx5', platform: 'IDE_PC', label: 'Trae' };
const LOGIN_TTL = 900; // 登录会话 15 分钟
const LOGIN_LATEST = 'login:latest';

const REQ_BODY = '{"req_source": 1}';
const CODE_OK = 0;
const CODE_ALREADY = 9095;
const CODE_RATE = 9074;
const AUTH_FAIL_CODES = [1001, 1002, 401, 403];
const COOLDOWN_MIN = 55;
const PEAK_COOLDOWN_MIN = 12;

/* ------------------------------------------------------------------ */
/* 编码工具                                                            */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(String(str).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(buf) {
  return b64encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return b64decode(s + '='.repeat((4 - (s.length % 4)) % 4));
}

function randomId(bytes = 12) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function randomHex(bytes = 16) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** 定长比较，避免口令被时序侧信道猜出来 */
function timingSafeEqual(a, b) {
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* 加密：AES-256-GCM + 每条记录随机 salt，密钥由主密钥 HKDF 派生        */
/* ------------------------------------------------------------------ */

async function deriveKey(env, salt) {
  const raw = env.TRAE_MASTER_KEY;
  if (!raw) throw new Error('缺少 MASTER_KEY');

  let master;
  try {
    master = b64decode(raw.trim());
  } catch {
    throw new Error('MASTER_KEY 不是合法 base64');
  }
  if (master.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节（base64 后 44 字符）');

  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('trae-signin/v1/account') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function sealRecord(env, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(env, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, s: b64encode(salt), i: b64encode(iv), d: b64encode(ct) });
}

async function openRecord(env, text) {
  const box = JSON.parse(text);
  if (box.v !== 1) throw new Error('不认识的记录版本');
  const key = await deriveKey(env, b64decode(box.s));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(box.i) }, key, b64decode(box.d));
  return JSON.parse(dec.decode(pt));
}

/* ------------------------------------------------------------------ */
/* ECDSA：P-256 / SHA-256，输出 base64(DER)，低 s 归一化               */
/* ------------------------------------------------------------------ */

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function pemToDer(pem) {
  const body = String(pem)
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  return b64decode(body);
}

function bytesToBig(bytes) {
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h ? BigInt('0x' + h) : 0n;
}

function bigToBytes(x) {
  let h = x.toString(16);
  if (h.length % 2) h = '0' + h;
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return Uint8Array.from(out);
}

/** DER INTEGER：去前导零，最高位为 1 时补 0x00 保证正整数 */
function derInt(bytes) {
  const arr = Array.from(bytes);
  let i = 0;
  while (i < arr.length - 1 && arr[i] === 0) i++;
  let v = arr.slice(i);
  if (v.length === 0 || (v[0] & 0x80)) v = [0, ...v];
  return [0x02, v.length, ...v];
}

/** DER SEQUENCE { INTEGER r, INTEGER s } —— 长度均 < 128，单字节长度即可 */
function derSig(rBytes, sBytes) {
  const body = derInt(rBytes).concat(derInt(sBytes));
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** 简易 DER TLV 读取，只解决本文件需要的结构 */
function derNext(buf, i) {
  const tag = buf[i++];
  let len = buf[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
  }
  return { tag, val: buf.subarray(i, i + len), next: i + len };
}

/** 从 SEC1（BEGIN EC PRIVATE KEY）里取私钥标量 */
function sec1Scalar(pem) {
  const der = pemToDer(pem);
  const outer = derNext(der, 0);
  if (outer.tag !== 0x30) throw new Error('SEC1 私钥结构异常');
  let i = 0;
  let d = null;
  while (i < outer.val.length) {
    const node = derNext(outer.val, i);
    if (node.tag === 0x04 && !d) d = node.val;
    i = node.next;
  }
  if (!d) throw new Error('SEC1 私钥里没找到私钥标量');
  return d;
}

/** 从 SPKI 公钥里取 P-256 的 x / y */
function spkiPoint(pem) {
  const der = pemToDer(pem);
  const outer = derNext(der, 0);
  if (outer.tag !== 0x30) throw new Error('公钥结构异常');
  const alg = derNext(outer.val, 0);
  const bits = derNext(outer.val, alg.next);
  if (bits.tag !== 0x03 || bits.val[0] !== 0 || bits.val[1] !== 0x04) {
    throw new Error('公钥不是未压缩的 P-256 点');
  }
  return { x: bits.val.subarray(2, 34), y: bits.val.subarray(34, 66) };
}

const ecdsaAlg = { name: 'ECDSA', namedCurve: 'P-256' };

/** 导入设备私钥：优先 PKCS#8，失败则按 SEC1 + 公钥补 x/y 走 JWK */
async function importPrivateKey(pem, pubPem) {
  if (!pem) throw new Error('缺少设备私钥');
  try {
    return await crypto.subtle.importKey('pkcs8', pemToDer(pem), ecdsaAlg, false, ['sign']);
  } catch (e) {
    if (!pubPem) throw new Error('私钥不是 PKCS#8，且没有公钥可用于 SEC1 转换');
    const d = sec1Scalar(pem);
    const { x, y } = spkiPoint(pubPem);
    return crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: b64urlEncode(d), x: b64urlEncode(x), y: b64urlEncode(y), ext: true },
      ecdsaAlg,
      false,
      ['sign']
    );
  }
}

/** 签名 canonical 串，返回 base64(DER)。低 s 归一化，与官方客户端的算法对齐。 */
async function ecSign(pem, data, pubPem) {
  const key = await importPrivateKey(pem, pubPem);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data));
  let r = bytesToBig(raw.subarray(0, 32));
  let s = bytesToBig(raw.subarray(32));
  if (s > P256_N >> 1n) s = P256_N - s; // 低 s 归一化
  return b64encode(derSig(bigToBytes(r), bigToBytes(s)));
}

/* ------------------------------------------------------------------ */
/* 与 Trae 服务端交互                                                   */
/* ------------------------------------------------------------------ */

async function traeFetch(path, { method = 'POST', headers = {}, body = '{}', timeout = 20000 } = {}) {
  const url = path.startsWith('http') ? path : API + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应留给调用方从 text 里看 */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 签到/积分接口通用头：缺设备头会被服务端拒成 9074 */
function ugHeaders(token, acct) {
  const h = {
    Authorization: 'Cloud-IDE-JWT ' + token,
    'X-User-Region': 'CN',
    'User-Agent': UA,
    'Content-Type': 'application/json',
  };
  const did = String(acct?.deviceId ?? '').trim();
  if (did) h['x-device-id'] = did;
  h['x-device-type'] = String(acct?.deviceType || 'Windows');
  h['x-os-version'] = String(acct?.osVersion || '10.0.19045');
  h['x-app-version'] = IDE_VERSION;
  const brand = String(acct?.deviceBrand ?? '').trim();
  if (brand) h['x-device-brand'] = brand;
  return h;
}

/** 从 JWT 里取过期时间（秒）。兼容自定义声明 TokenExpireAt（秒/毫秒都可能） */
function jwtExp(token) {
  try {
    const json = JSON.parse(dec.decode(b64urlDecode(String(token).split('.')[1])));
    let v = Number(json.exp || json.TokenExpireAt || 0) || 0;
    if (v > 1e12) v = Math.floor(v / 1000); // 毫秒归一化
    return v;
  } catch {
    return 0;
  }
}

/** 构造设备证明 (DeviceProof, DeviceInfo) */
async function buildProof(acct, path, clientId, platformCode, refreshToken) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomHex(16);
  const canonical = ['POST', path, clientId, refreshToken, String(ts), nonce].join('\n');
  const signature = await ecSign(acct.privateKeyPem, enc.encode(canonical), acct.publicKeyPem);
  return {
    proof: { Timestamp: ts, Nonce: nonce, Signature: signature },
    info: {
      DeviceID: String(acct.deviceId || ''),
      MachineID: String(acct.machineId || ''),
      PlatformCode: platformCode,
      DeviceType: 'PC',
      DeviceName: String(acct.deviceName || 'PC'),
      DeviceModel: String(acct.deviceModel || ''),
      ClientVersion: IDE_VERSION,
      DevicePublicKey: String(acct.publicKeyPem || ''),
      DeviceBrand: String(acct.deviceBrand || ''),
      DeviceCPU: '',
      OSInfo: String(acct.osInfo || 'Windows'),
      OSVersion: String(acct.osVersion || '10.0.19045'),
    },
  };
}

function explainRefreshErr(json, text) {
  const err = (json?.ResponseMetadata?.Error) || {};
  const code = err.Code;
  const msg = (err.Data && err.Data['__Message.error']) || err.Message || String(text).slice(0, 200);
  const hint =
    {
      20101: 'refreshToken 已失效或被别处轮换，请删掉该账号重新扫码登录',
      10101: 'refreshToken 与当前产品线不匹配，请用对应按钮重新扫码登录',
      20405: '服务端要求设备证明，但该账号缺少设备密钥，请删掉后重新扫码登录',
      20403: '设备密钥与令牌不匹配，请删掉该账号重新扫码登录',
    }[code] || '';
  return `code=${code ?? '?'} ${msg}${hint ? '（' + hint + '）' : ''}`;
}

/**
 * 用 refreshToken 换新的双令牌。
 * 主接口要求设备证明，按「钥匙 × 产品线」三组组合依次尝试；
 * 账号没有设备材料时只能走备用端点（大概率失败，但报错更具体）。
 */
async function refreshTokens(acct) {
  const rt = String(acct.refreshToken || '').trim();
  if (!rt) throw new Error('账号没有 refreshToken');

  const hasKeys = !!(acct.privateKeyPem && acct.publicKeyPem);

  if (!hasKeys) {
    const body = JSON.stringify({
      ClientID: CLIENT_ID_OLD,
      RefreshToken: rt,
      ClientSecret: '-',
      UserID: '',
    });
    const r = await traeFetch(EP.exchangeLegacy, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      body,
    });
    const token = r.json?.Result?.Token;
    if (r.status >= 400 || !token) throw new Error('刷新令牌失败: ' + explainRefreshErr(r.json, r.text));
    return {
      accessToken: token,
      refreshToken: r.json.Result.RefreshToken || rt,
    };
  }

  const combos = [
    [acct.clientId || CLIENT_ID_IDE, acct.platformCode || 'IDE_PC'],
    [CLIENT_ID_OLD, 'IDE_PC'],
    [CLIENT_ID_OLD, 'SOLO_PC'],
  ].filter((v, i, arr) => arr.findIndex((x) => x[0] === v[0] && x[1] === v[1]) === i);

  let lastErr = null;
  for (const [clientId, platformCode] of combos) {
    let built;
    try {
      built = await buildProof(acct, EP.exchange, clientId, platformCode, rt);
    } catch (e) {
      throw new Error('设备签名失败（检查设备私钥）: ' + e.message);
    }
    const body = JSON.stringify({
      ClientID: clientId,
      ClientSecret: '',
      RefreshToken: rt,
      DeviceInfo: built.info,
      DeviceProof: built.proof,
      IDEVersion: IDE_VERSION,
    });
    const r = await traeFetch(EP.exchange, {
      headers: { 'x-cloudide-token': '' },
      body,
    });
    const token = r.json?.Result?.Token;
    if (r.status < 400 && token) {
      return { accessToken: token, refreshToken: r.json.Result.RefreshToken || rt };
    }
    lastErr = explainRefreshErr(r.json, r.text);
    // 只有「不匹配」类错误才值得换一组钥匙，其它错误直接抛
    const raw = String(r.text || '');
    if (!raw.includes('10101') && !raw.includes('20403')) break;
  }
  throw new Error('刷新令牌失败: ' + (lastErr || '未知错误'));
}

/** 提交签到：0 成功 / 9095 今日已签 / 9074 限流 */
async function claim(token, acct) {
  const r = await traeFetch(EP.claim, { headers: ugHeaders(token, acct), body: REQ_BODY });
  if (!r.json) return { status: r.status, code: '?', msg: String(r.text).slice(0, 160), points: null };
  const data = r.json.data;
  const points = data && typeof data === 'object' ? data.points ?? null : null;
  return {
    status: r.status,
    code: r.json.code ?? -1,
    msg: r.json.message || String(r.text).slice(0, 160),
    points,
  };
}

/** 查询今日签到状态：checked_in / credits */
async function statusOf(token, acct) {
  const r = await traeFetch(EP.status, { headers: ugHeaders(token, acct), body: REQ_BODY });
  if (!r.json) return { ok: false, code: '?', raw: String(r.text).slice(0, 160) };
  if (r.status >= 400) return { ok: false, code: r.json.code ?? -1, raw: String(r.text).slice(0, 160) };
  return {
    ok: true,
    checked: r.json.checked_in === true,
    credits: typeof r.json.credits === 'number' ? r.json.credits : null,
    enable: r.json.enable ?? null,
    code: r.json.code ?? -1,
  };
}

/** 查积分余额：优先 usage_summary，再按 entitlement 包求和兜底 */
async function creditsOf(token, acct) {
  const r = await traeFetch(EP.entitle, { headers: ugHeaders(token, acct), body: '{"require_usage": true}' });
  const d = r.json;
  if (!d) return null;
  const root = d.data || d;
  const us = root.usage_summary || {};
  const total = Number(us.total_amount || 0);
  const used = Number(us.consumed_amount || 0);
  if (total > 0) return total - used;
  const packs = root.user_entitlement_pack_list || [];
  let sum = 0;
  let found = false;
  for (const p of packs) {
    const limit = Number(p?.entitlement_base_info?.quota?.credits_limit || 0);
    const consumed = Number(p?.usage?.credits_amount || 0);
    if (limit > 0) {
      found = true;
      sum += Math.max(limit - consumed, 0);
    }
  }
  return found ? sum : null;
}

/* ------------------------------------------------------------------ */
/* KV 读写                                                             */
/* ------------------------------------------------------------------ */

const acctKey = (id) => `acct:${id}`;
const INDEX_KEY = 'index:accounts';

async function listAccounts(env) {
  const raw = await env.TRAE_KV.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveIndex(env, list) {
  await env.TRAE_KV.put(INDEX_KEY, JSON.stringify(list));
}

async function getAccount(env, id) {
  const raw = await env.TRAE_KV.get(acctKey(id));
  if (!raw) return null;
  return openRecord(env, raw);
}

async function putAccount(env, acct) {
  await env.TRAE_KV.put(acctKey(acct.id), await sealRecord(env, acct));
}

/* ------------------------------------------------------------------ */
/* 时间与账号状态辅助                                                   */
/* ------------------------------------------------------------------ */

const bjDay = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const bjHour = (ms = Date.now()) => new Date(ms + 8 * 3600e3).getUTCHours();

/** 早窗（北京时间 0 点）冷却更短，好让下一轮还能在窗口里补签 */
function cooldownMinutes() {
  return bjHour() === 0 ? PEAK_COOLDOWN_MIN : COOLDOWN_MIN;
}

/* ------------------------------------------------------------------ */
/* 单个账号的完整签到流程                                               */
/* ------------------------------------------------------------------ */

async function signinOne(env, acct, { force = false } = {}) {
  const now = Date.now();
  const today = bjDay(now);
  const base = { id: acct.id, label: acct.label, platform: 'trae' };

  if (acct.enabled === false) {
    return { ...base, state: 'disabled', msg: '账号已停用' };
  }

  if (!force && Number(acct.cooldownUntil || 0) > now) {
    const left = Math.ceil((acct.cooldownUntil - now) / 60000);
    return { ...base, state: 'cooldown', msg: `限流冷却中，约 ${left} 分钟` };
  }

  if (!force && acct.lastOkDate === today) {
    return { ...base, state: 'skipped', msg: '今日已完成' };
  }

  // 1) 拿一个可用的 accessToken：还没过期就直接用，避免无谓轮换
  let token = String(acct.accessToken || '');
  const exp = jwtExp(token);
  const usable = token && (!exp || exp * 1000 - now > 120000);

  if (!usable) {
    try {
      const t = await refreshTokens(acct);
      token = t.accessToken;
      acct.refreshToken = t.refreshToken;
      acct.accessToken = token;
      acct.accessExp = jwtExp(token);
      acct.tokenRefreshedAt = now;
      await putAccount(env, acct); // 先落盘：令牌链不能断
    } catch (e) {
      acct.lastState = 'token_dead';
      acct.lastMsg = e.message;
      acct.lastRun = now;
      await putAccount(env, acct);
      return { ...base, state: 'token_dead', msg: e.message };
    }
  }

  // 2) 提交签到（鉴权类错误刷新一次再试）
  let res = await claim(token, acct);

  if (AUTH_FAIL_CODES.includes(res.code)) {
    try {
      const t = await refreshTokens(acct);
      token = t.accessToken;
      acct.refreshToken = t.refreshToken;
      acct.accessToken = token;
      acct.accessExp = jwtExp(token);
      await putAccount(env, acct);
      res = await claim(token, acct);
    } catch (e) {
      acct.lastState = 'token_dead';
      acct.lastMsg = e.message;
      acct.lastRun = now;
      await putAccount(env, acct);
      return { ...base, state: 'token_dead', msg: e.message };
    }
  }

  acct.lastRun = now;

  // 3) 限流：换个假设备号也没用，9074 会原样返回，按账号冷却等下轮
  if (res.code === CODE_RATE || res.status === 429 || res.status >= 500) {
    const mins = cooldownMinutes();
    acct.cooldownUntil = now + mins * 60000;
    acct.lastState = 'rate';
    acct.lastMsg = `限流 9074，冷却 ${mins} 分钟`;
    await putAccount(env, acct);
    return { ...base, state: 'rate', msg: acct.lastMsg };
  }

  // 4) 今日已签
  if (res.code === CODE_ALREADY) {
    acct.lastState = 'already';
    acct.lastMsg = '今日已签';
    acct.lastOkDate = today;
    acct.cooldownUntil = 0;
    const st = await statusOf(token, acct).catch(() => null);
    if (st?.ok) {
      acct.checkedIn = true;
      // status 的 credits 是「今日这单给多少分」，不是余额，只能当今日积分用
      if (typeof st.credits === 'number') {
        acct.lastCredit = st.credits;
        acct.lastCreditDate = today;
      }
    }
    const bal = await creditsOf(token, acct).catch(() => null);
    if (bal != null) acct.credits = bal;
    await putAccount(env, acct);
    return { ...base, state: 'already', msg: '今日已签', credits: acct.credits ?? null };
  }

  // 5) 其它失败
  if (res.code !== CODE_OK) {
    acct.lastState = 'error';
    acct.lastMsg = `签到失败 code=${res.code} ${res.msg ?? ''}`.trim();
    await putAccount(env, acct);
    return { ...base, state: 'error', msg: acct.lastMsg };
  }

  // 6) code=0 未必真到账：用同一 deviceId 回查 checked_in 是否翻转
  let confirmed = false;
  let credits = null;
  try {
    const st = await statusOf(token, acct);
    if (st.ok) {
      confirmed = st.checked === true;
      credits = st.credits;
    }
  } catch {
    /* 回查失败按未确认处理，交给下轮 cron */
  }

  if (!confirmed) {
    const bal = await creditsOf(token, acct).catch(() => null);
    acct.lastState = 'pending';
    acct.lastMsg = '已提交，但回查未确认，等下轮再试';
    acct.credits = bal ?? acct.credits ?? null;
    acct.cooldownUntil = now + 12 * 60000;
    await putAccount(env, acct);
    return { ...base, state: 'pending', msg: acct.lastMsg, credits: acct.credits ?? null };
  }

  const bal = await creditsOf(token, acct).catch(() => null);
  const points = Number(res.points) || credits || null;
  acct.lastState = 'checked';
  acct.lastMsg = points ? `+${points} 积分` : '签到成功';
  acct.lastOkDate = today;
  acct.lastCredit = points;
  acct.lastCreditDate = today;
  acct.totalCredit = (acct.totalCredit ?? 0) + (Number(res.points) || 0);
  acct.totalSigned = (acct.totalSigned ?? 0) + 1;
  acct.credits = bal ?? acct.credits ?? null;
  acct.checkedIn = true;
  acct.cooldownUntil = 0;
  await putAccount(env, acct);

  return {
    ...base,
    state: 'checked',
    msg: acct.lastMsg,
    credits: acct.credits ?? null,
    points: points,
  };
}

/* ------------------------------------------------------------------ */
/* 页面与鉴权辅助                                                       */
/* ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function requireAdmin(request, env) {
  const url = new URL(request.url);
  const given =
    request.headers.get('X-Admin-Token') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('token');
  if (!env.ADMIN_TOKEN) return { ok: false, res: json({ error: '未配置 ADMIN_TOKEN' }, 500) };
  if (!timingSafeEqual(given, env.ADMIN_TOKEN)) return { ok: false, res: json({ error: '登录密码不正确' }, 401) };
  return { ok: true };
}

function requireCron(request, env) {
  const secret = env.CRON_SECRET || env.ADMIN_TOKEN;
  const url = new URL(request.url);
  const given = request.headers.get('X-Cron-Secret') || url.searchParams.get('key');
  if (!secret) return { ok: false, res: json({ error: '未配置 CRON_SECRET / ADMIN_TOKEN' }, 500) };
  if (!timingSafeEqual(given, secret)) return { ok: false, res: json({ error: '口令不对' }, 401) };
  return { ok: true };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 对外数据视图 / 增删改查                                              */
/* ------------------------------------------------------------------ */

/** 列表与刷新共用同一套字段，令牌与私钥永不下发 */
function publicView(a, now, today) {
  const creditToday = a.lastCreditDate
    ? a.lastCreditDate === today
    : (a.lastOkDate === today && (a.lastState === 'checked' || a.lastState === 'already'));
  return {
    id: a.id,
    label: a.label,
    enabled: a.enabled !== false,
    lastState: a.lastState,
    lastMsg: a.lastMsg,
    lastRun: a.lastRun ? new Date(a.lastRun + 8 * 3600e3).toISOString().replace('Z', ' +08:00') : null,
    lastOkDate: a.lastOkDate ?? null,
    lastCredit: creditToday ? (a.lastCredit ?? null) : null,
    credits: typeof a.credits === 'number' ? Math.round(a.credits * 100) / 100 : null,
    totalCredit: a.totalCredit ?? 0,
    totalSigned: a.totalSigned ?? 0,
    cooldownUntil: Number(a.cooldownUntil || 0) > now ? a.cooldownUntil : 0,
    hasKeys: !!(a.privateKeyPem && a.publicKeyPem),
    hasDevice: !!String(a.deviceId || '').trim(),
    credExp: a.accessExp ? Number(a.accessExp) * 1000 : null,
    credKind: 'access',
    // 服务端当场判定，避免前端拿历史状态跨天残留
    today,
    signedToday: a.lastOkDate === today,
    ranToday: a.lastRun ? bjDay(a.lastRun) === today : false,
    // 令牌与私钥永不下发
  };
}

async function list(env) {
  const list = await listAccounts(env);
  const out = [];
  const now = Date.now();
  const today = bjDay(now);
  for (const meta of list) {
    const a = await getAccount(env, meta.id);
    if (!a) continue;
    out.push(publicView(a, now, today));
  }
  return { count: out.length, today, accounts: out };
}

async function removeAccount(env, id) {
  await env.TRAE_KV.delete(acctKey(id));
  const list = (await listAccounts(env)).filter((x) => x.id !== id);
  await saveIndex(env, list);
  return { removed: id };
}

/** 改备注：昵称取不到时就靠这个，改成什么由用户定 */
async function renameAccount(env, id, label) {
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  acct.label = label;
  await putAccount(env, acct);

  const list = await listAccounts(env);
  await saveIndex(env, list.map((x) => (x.id === id ? { ...x, label } : x)));
  return { id, label };
}

async function setEnabled(env, id, enabled) {
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  acct.enabled = !!enabled;
  await putAccount(env, acct);
  return { id, enabled: !!enabled };
}

/** 只查状态与余额，不签到。用于控制台「刷新积分」。 */
async function refreshOne(env, id) {
  const now = Date.now();
  const today = bjDay(now);
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  const wasCheckedToday = acct.lastOkDate === today && acct.lastState === 'checked';

  let token = String(acct.accessToken || '');
  const exp = jwtExp(token);
  if (!token || (exp && exp * 1000 - now < 120000)) {
    let t;
    try {
      t = await refreshTokens(acct);
    } catch (e) {
      acct.lastState = 'token_dead';
      acct.lastMsg = e.message;
      acct.lastRun = now;
      await putAccount(env, acct);
      return publicView(acct, now, today);
    }
    token = t.accessToken;
    acct.refreshToken = t.refreshToken;
    acct.accessToken = token;
    acct.accessExp = jwtExp(token);
    acct.tokenRefreshedAt = now;
  }

  const st = await statusOf(token, acct).catch(() => null);
  if (st?.ok) {
    acct.checkedIn = st.checked === true;
    if (st.checked) {
      acct.lastOkDate = today;
      acct.cooldownUntil = 0;
      if (!wasCheckedToday && acct.lastState !== 'token_dead') {
        acct.lastState = 'already';
        acct.lastMsg = '服务端显示今日已签';
      }
      // 今日这单的分数记下来，否则「今日」列会在刷新后变成空
      if (typeof st.credits === 'number' && acct.lastCreditDate !== today) {
        acct.lastCredit = st.credits;
        acct.lastCreditDate = today;
      }
    }
  }
  const bal = await creditsOf(token, acct).catch(() => null);
  if (bal != null) acct.credits = bal;
  await putAccount(env, acct);
  return publicView(acct, now, today);
}

async function run(env, { force = false, id = '' } = {}) {
  const list = await listAccounts(env);
  const results = [];
  for (const meta of list) {
    if (id && meta.id !== id) continue;
    const a = await getAccount(env, meta.id);
    if (!a) continue;
    try {
      results.push(await signinOne(env, a, { force }));
    } catch (e) {
      results.push({ id: a.id, label: a.label, platform: 'trae', state: 'error', msg: e.message });
    }
  }
  return {
    at: new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', ' +08:00'),
    accounts: results.length,
    checked: results.filter((r) => r.state === 'checked').length,
    already: results.filter((r) => ['already', 'skipped'].includes(r.state)).length,
    failed: results.filter((r) => ['error', 'token_dead'].includes(r.state)).length,
    cooling: results.filter((r) => ['rate', 'cooldown', 'pending'].includes(r.state)).length,
    results,
  };
}

async function handleRemove(request, env) {
  const body = await readBody(request);
  const id = String(body.id ?? '').trim();
  if (!id) return json({ error: '缺少 id' }, 400);
  return json({ ok: true, ...(await removeAccount(env, id)) });
}

async function handleRename(request, env) {
  const body = await readBody(request);
  const id = String(body.id ?? '').trim();
  const label = String(body.label ?? '').trim().slice(0, 40);
  if (!id) return json({ error: '缺少 id' }, 400);
  if (!label) return json({ error: '备注不能为空' }, 400);
  try {
    return json({ ok: true, ...(await renameAccount(env, id, label)) });
  } catch (e) {
    return json({ error: e.message }, 404);
  }
}

async function handleList(request, env) {
  return json(await list(env));
}

async function handleRun(request, env, force) {
  const body = await readBody(request);
  return json(await run(env, { force, id: String(body.id ?? '').trim() }));
}

/* ------------------------------------------------------------------ */
/* 扫码登录（网页授权 → 换令牌）                                        */
/*                                                                     */
/* 账号只能通过扫码添加，不涉及任何本地客户端：                         */
/*   1. 现场生成 P-256 设备密钥对 + 随机 deviceId                       */
/*   2. 拼 /authorization 链接，回调地址固定为 127.0.0.1:<端口>          */
/*   3. 用户用抖音扫码；官网只往本机地址回送 AuthCode                    */
/*   4. 把那段回调链接粘回控制台，用 AuthCode + PKCE + 设备公钥换令牌    */
/*                                                                     */
/* 设备身份由 Worker 自己生成，续期时的设备证明也由自己签名。            */
/* ------------------------------------------------------------------ */

const b64std = (buf) => b64encode(buf);

function toPem(der, label) {
  const b = b64std(der);
  const lines = b.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

/** 生成一套全新的设备身份（私钥 PKCS#8、公钥 SPKI） */
async function genDeviceIdentity() {
  const kp = await crypto.subtle.generateKey(ecdsaAlg, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return {
    privateKeyPem: toPem(pkcs8, 'PRIVATE KEY'),
    publicKeyPem: toPem(spki, 'PUBLIC KEY'),
  };
}

/** 15 位数字设备号，首位非 0，与客户端 device_id 形态一致 */
function genDeviceId() {
  const a = crypto.getRandomValues(new Uint8Array(15));
  let s = String(1 + (a[0] % 9));
  for (let i = 1; i < 15; i++) s += String(a[i] % 10);
  return s;
}

/** PKCE：verifier 用 64 位 hex，challenge = base64url(SHA256(verifier)) */
async function pkcePair() {
  const verifier = randomHex(32);
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return { verifier, challenge: b64urlEncode(digest) };
}

/** URL 编码：保留 '/'，空格转成 %20 */
function qsQuote(v) {
  return encodeURIComponent(String(v)).replace(/%2F/g, '/');
}

function buildAuthorizeUrl(o) {
  const params = [
    ['login_version', '1'],
    ['auth_from', o.authFrom],
    ['login_channel', 'native_ide'],
    ['plugin_version', OAUTH_PLUGIN_VERSION],
    ['auth_type', 'local'],
    ['client_id', o.clientId],
    ['redirect', '0'],
    ['login_trace_id', o.trace],
    ['auth_callback_url', o.callback],
    ['machine_id', o.machineId],
    ['device_id', o.deviceId],
    ['x_device_id', o.deviceId],
    ['x_machine_id', o.machineId],
    ['x_device_brand', 'PC'],
    ['x_device_type', 'Windows'],
    ['x_os_version', '10.0.19045'],
    ['x_env', ''],
    ['x_app_version', OAUTH_APP_VERSION],
    ['x_app_type', 'stable'],
    ['code_challenge', o.challenge],
    ['code_challenge_method', 'S256'],
    ['channel_name', 'common'],
  ];
  return AUTHORIZE_BASE + '/authorization?' + params.map(([k, v]) => k + '=' + qsQuote(v)).join('&');
}

function hostBase(h) {
  const s = String(h || '').trim();
  if (!s) return 'https://api.trae.cn';
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  return 'https://' + s.replace(/\/+$/, '');
}

/** 递归找 token 字段：兑换响应外层结构各版本不一致 */
function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    const r = deepFind(v, keys, depth + 1);
    if (r) return r;
  }
  return '';
}

const ACCESS_KEYS = ['AccessToken', 'access_token', 'token', 'Jwt', 'JWT'];
const REFRESH_KEYS = ['RefreshToken', 'refresh_token'];

/* 用户资料的字段名各版本不统一，按可能性从高到低找昵称 */
const NICK_KEYS = [
  'Nickname', 'nickname', 'NickName', 'nick_name',
  'UserName', 'userName', 'user_name', 'username',
  'ScreenName', 'screen_name',
  'DisplayName', 'displayName', 'display_name',
  'Name', 'name',
];

/** 递归找昵称：只认上面这些字段，避免误抓 DeviceName 之类的值 */
function pickNickname(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return '';
  for (const k of NICK_KEYS) {
    const v = obj[k];
    if (typeof v === 'string') {
      const s = v.trim();
      // 跳过设备/平台口径的通用值，它们不是昵称
      if (s && s.length <= 32 && !/^(pc|windows|web|ide|trae|unknown)$/i.test(s)) return s;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = pickNickname(v, depth + 1);
      if (r) return r;
    }
  }
  return '';
}

/** 令牌是 JWT 时，载荷里常常带昵称；只取来当备注，不校验签名 */
function nicknameFromJwt(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length < 3) return '';
  try {
    return pickNickname(JSON.parse(dec.decode(b64urlDecode(parts[1]))));
  } catch {
    return '';
  }
}

function describeExchangeErr(json, text, status) {
  const err = json?.ResponseMetadata?.Error || json?.error || {};
  const code = err.Code ?? json?.code;
  const msg =
    (err.Data && err.Data['__Message.error']) ||
    err.Message ||
    json?.message ||
    json?.msg ||
    String(text || '').slice(0, 160);
  return `code=${code ?? '?'} ${msg} (HTTP ${status})`;
}

/**
 * AuthCode → 双令牌。后端有几套不同版本的兑换端点，按下面顺序逐个尝试：
 *   主端点 DeviceInfo → 备用端点 AuthCode → 备用端点 Code
 * 这几步都不需要设备私钥，只要设备公钥已登记。
 */
async function exchangeAuthCode({ authCode, verifier, device, clientId, platform, host }) {
  const dev = {
    DeviceID: String(device.deviceId || ''),
    MachineID: String(device.machineId || ''),
    PlatformCode: platform,
    DeviceType: 'PC',
    DeviceName: 'PC',
    DeviceModel: '',
    ClientVersion: OAUTH_APP_VERSION,
    DevicePublicKey: String(device.publicKeyPem || ''),
    DeviceBrand: '',
    DeviceCPU: '',
    OSInfo: 'Windows',
    OSVersion: '10.0.19045',
  };

  const baseHeaders = {
    Accept: '*/*',
    'User-Agent': 'Trae/' + OAUTH_APP_VERSION,
    'x-device-id': dev.DeviceID,
    'x-app-id': OAUTH_APP_ID,
    'x-platform-code': platform,
  };

  const variants = [
    {
      tag: 'DeviceInfo',
      url: hostBase(host) + EP.exchange,
      headers: { ...baseHeaders, 'x-cloudide-token': '' },
      body: {
        ClientID: clientId,
        AuthCode: authCode,
        CodeVerifier: verifier,
        DeviceInfo: dev,
        IDEVersion: OAUTH_APP_VERSION,
      },
    },
    {
      tag: 'AuthCode',
      url: EP.exchangeLegacy,
      headers: baseHeaders,
      body: {
        ClientID: clientId,
        AuthCode: authCode,
        CodeVerifier: verifier,
        DeviceID: dev.DeviceID,
        PlatformCode: platform,
      },
    },
    {
      tag: 'Code',
      url: EP.exchangeLegacy,
      headers: baseHeaders,
      body: {
        ClientID: clientId,
        Code: authCode,
        CodeVerifier: verifier,
        DeviceID: dev.DeviceID,
        PlatformCode: platform,
      },
    },
  ];

  const errors = [];
  for (const v of variants) {
    const { status, json, text } = await traeFetch(v.url, {
      method: 'POST',
      headers: v.headers,
      body: JSON.stringify(v.body),
    });
    const refreshToken = deepFind(json, REFRESH_KEYS);
    const accessToken = deepFind(json, ACCESS_KEYS);
    if (refreshToken) {
      // 兑换响应偶尔带用户资料，能拿到昵称就直接当备注
      return { tokens: { refreshToken, accessToken }, tag: v.tag, name: pickNickname(json) || nicknameFromJwt(accessToken) };
    }
    if (accessToken) {
      errors.push(`${v.tag}: 响应只有 AccessToken，没有 RefreshToken（无法续期）${describeExchangeErr(json, text, status)}`);
    } else {
      errors.push(`${v.tag}: ${describeExchangeErr(json, text, status)}`);
    }
  }
  throw new Error('登录失败 → ' + errors.join(' | '));
}

const loginKey = (trace) => `login:${trace}`;

async function putLoginSession(env, sess) {
  await env.TRAE_KV.put(loginKey(sess.trace), await sealRecord(env, sess), { expirationTtl: LOGIN_TTL });
  await env.TRAE_KV.put(LOGIN_LATEST, sess.trace, { expirationTtl: LOGIN_TTL });
}

async function getLoginSession(env, trace) {
  const raw = await env.TRAE_KV.get(loginKey(trace));
  if (!raw) return null;
  try {
    return await openRecord(env, raw);
  } catch {
    return null;
  }
}

/** 把扫码换到的令牌落成账号（设备密钥随账号一起加密保存，供续期签名） */
async function saveScannedAccount(env, { label, refreshToken, device, clientId, platform }) {
  const rt = String(refreshToken || '').trim();
  if (!rt) throw new Error('登录响应里没有 refreshToken');

  const id = randomId(9);
  const acct = {
    id,
    label: String(label || '').trim().slice(0, 40) || `Trae-${String(device.deviceId || '').slice(-4)}`,
    refreshToken: rt,
    deviceId: String(device.deviceId || ''),
    machineId: String(device.machineId || ''),
    privateKeyPem: String(device.privateKeyPem || ''),
    publicKeyPem: String(device.publicKeyPem || ''),
    deviceName: 'PC',
    deviceModel: '',
    deviceBrand: '',
    deviceType: 'Windows',
    osInfo: 'Windows',
    osVersion: '10.0.19045',
    clientId: String(clientId || ''),
    platformCode: String(platform || ''),
    source: 'scan',
    enabled: true,
    createdAt: Date.now(),
    lastState: 'new',
    lastMsg: '扫码登录，尚未运行',
    cooldownUntil: 0,
  };
  await putAccount(env, acct);

  const list = await listAccounts(env);
  list.push({ id, label: acct.label, createdAt: acct.createdAt });
  await saveIndex(env, list);
  return acct;
}

/** 回调参数解析：AuthCode 可能在 authCodeInfo JSON 里，也可能直接是 code */
function parseCallbackParams(url) {
  const q = url.searchParams;
  let authCode = '';
  const raw = q.get('authCodeInfo');
  if (raw) {
    try {
      authCode = String(JSON.parse(raw).AuthCode || '').trim();
    } catch {
      /* 不是 JSON 就继续找 code */
    }
  }
  if (!authCode) authCode = String(q.get('code') || q.get('AuthCode') || '').trim();

  let refreshToken = '';
  for (const k of ['refreshToken', 'refresh_token', 'RefreshToken']) {
    const v = String(q.get(k) || '').trim().replace(/^"+|"+$/g, '');
    if (v) {
      refreshToken = v;
      break;
    }
  }

  return {
    authCode,
    refreshToken,
    trace: String(q.get('loginTraceID') || q.get('login_trace_id') || q.get('state') || '').trim(),
    host: String(q.get('host') || '').trim(),
    name: String(q.get('name') || q.get('nickname') || q.get('userName') || '').trim(),
    uid: String(q.get('uid') || '').trim(),
    error: String(q.get('error') || '').trim(),
  };
}

/** 完成一次登录：换取令牌 → 落库 → 回写会话状态 */
async function completeLogin(env, sess, p) {
  if (sess.status === 'ok') return { ok: true, label: sess.label, id: sess.accountId, repeat: true };

  let refreshToken = p.refreshToken;
  let via = 'callback';
  // 昵称来源：回调参数 → 令牌载荷 → 兑换响应，取到第一个算数
  let nick = p.name || nicknameFromJwt(p.refreshToken);
  if (!refreshToken) {
    if (!p.authCode) throw new Error('回调里既没有 AuthCode 也没有 refreshToken');
    const r = await exchangeAuthCode({
      authCode: p.authCode,
      verifier: sess.verifier,
      device: sess,
      clientId: sess.clientId,
      platform: sess.platform,
      host: p.host,
    });
    refreshToken = r.tokens.refreshToken;
    via = r.tag;
    nick = nick || r.name;
  }

  // 都拿不到就回落到设备后缀，用户可在控制台点「备注」自己改
  const label = String(nick || p.uid || '').trim() || `Trae-${String(sess.deviceId || '').slice(-4)}`;
  const acct = await saveScannedAccount(env, {
    label,
    refreshToken,
    device: sess,
    clientId: sess.clientId,
    platform: sess.platform,
  });

  sess.status = 'ok';
  sess.label = acct.label;
  sess.accountId = acct.id;
  sess.via = via;
  sess.error = '';
  await putLoginSession(env, sess);
  return { ok: true, label: acct.label, id: acct.id, via };
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 回调落地页：同源窗口可 postMessage 通知控制台，然后自动关窗 */
function oauthPage(title, detail, ok, label = '') {
  const payload = JSON.stringify({ type: 'trae-login', ok: !!ok, label: String(label || '') }).replace(/</g, '\\u003c');
  const color = ok ? '#0d8a61' : '#bf3529';
  const bg = ok ? 'rgba(13,138,97,.10)' : 'rgba(191,53,41,.10)';
  const icon = ok
    ? '<path d="M4.5 12.6l4.6 4.6L19.5 6.8"/>'
    : '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>';
  const html =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escHtml(title) + '</title>' +
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;' +
    'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
    'background:#eef1f5;color:#0c141d;padding:24px}' +
    '.c{width:min(420px,92vw);background:#fff;border:1px solid rgba(15,23,42,.09);border-radius:18px;' +
    'padding:28px;text-align:center;box-shadow:0 18px 44px -24px rgba(15,23,42,.35)}' +
    '.m{width:52px;height:52px;margin:0 auto 16px;border-radius:16px;display:grid;place-items:center;' +
    'background:' + bg + '}.m svg{width:26px;height:26px;fill:none;stroke:' + color + ';stroke-width:2.6;' +
    'stroke-linecap:round;stroke-linejoin:round}h1{font-size:19px;margin:0 0 8px;letter-spacing:-.01em}' +
    'p{margin:0;color:#5e6a78;font-size:13.5px;word-break:break-word}' +
    '.tip{margin-top:18px;font-size:12px;color:#8b98a7}</style></head><body>' +
    '<div class="c"><div class="m"><svg viewBox="0 0 24 24">' + icon + '</svg></div>' +
    '<h1>' + escHtml(title) + '</h1><p>' + escHtml(detail) + '</p>' +
    '<div class="tip">' + (ok ? '窗口将自动关闭' : '可以关闭此窗口，回到控制台重试') + '</div></div>' +
    '<script>try{if(window.opener)window.opener.postMessage(' + payload + ",'*')}catch(e){}" +
    (ok ? 'setTimeout(function(){try{window.close()}catch(e){}},1400);' : '') +
    '</' + 'script></body></html>';
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** 第一步：生成设备身份 + PKCE + 授权链接 */
async function handleLoginStart(request, env) {
  const callback = CALLBACK_LOCAL;

  const device = await genDeviceIdentity();
  const deviceId = genDeviceId();
  const machineId = randomHex(16);
  const { verifier, challenge } = await pkcePair();
  const trace = randomHex(8);

  const authUrl = buildAuthorizeUrl({
    authFrom: TRAE_LINE.authFrom,
    clientId: TRAE_LINE.clientId,
    trace,
    callback,
    deviceId,
    machineId,
    challenge,
  });

  const sess = {
    trace,
    line: 'trae',
    verifier,
    callback,
    deviceId,
    machineId,
    privateKeyPem: device.privateKeyPem,
    publicKeyPem: device.publicKeyPem,
    clientId: TRAE_LINE.clientId,
    platform: TRAE_LINE.platform,
    status: 'pending',
    createdAt: Date.now(),
  };
  await putLoginSession(env, sess);

  return json({
    ok: true,
    trace,
    authUrl,
    callback,
    deviceId,
    line: 'trae',
    label: TRAE_LINE.label,
  });
}

/** 第二步（自动）：官网把浏览器送到这里，带 AuthCode */
async function handleOauthCallback(request, env) {
  const url = new URL(request.url);
  const p = parseCallbackParams(url);

  // 无凭据也无 trace：多半是官网在探测「客户端是否在线」，直接 200 即可
  if (!p.authCode && !p.refreshToken && !p.error && !p.trace) {
    return new Response('ok', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  }

  if (p.error) return oauthPage('授权未完成', p.error, false);

  let trace = p.trace;
  if (!trace) trace = String((await env.TRAE_KV.get(LOGIN_LATEST)) || '');
  if (!trace) return oauthPage('登录会话丢失', '找不到对应的登录会话，请回到控制台重新发起', false);

  const sess = await getLoginSession(env, trace);
  if (!sess) return oauthPage('登录会话已过期', '二维码有效期 15 分钟，请回到控制台重新获取', false);

  try {
    const r = await completeLogin(env, sess, p);
    return oauthPage(r.repeat ? '这个二维码已经用过了' : '登录成功', `已保存为「${r.label}」`, true, r.label);
  } catch (e) {
    sess.status = 'error';
    sess.error = e.message;
    await putLoginSession(env, sess);
    return oauthPage('换取令牌失败', e.message, false);
  }
}

/** 轮询：控制台查这次扫码有没有完成 */
async function handleLoginPoll(request, env) {
  const url = new URL(request.url);
  const trace = String(url.searchParams.get('trace') || '').trim();
  if (!trace) return json({ error: '缺少 trace' }, 400);
  const sess = await getLoginSession(env, trace);
  if (!sess) return json({ status: 'expired' });
  return json({
    status: sess.status || 'pending',
    label: sess.label || '',
    error: sess.error || '',
    accountId: sess.accountId || '',
    via: sess.via || '',
  });
}

/**
 * 第二步：官网只把 AuthCode 回送到 127.0.0.1，用户把那段地址粘回来，
 * 这里解析出 AuthCode 后换取令牌并绑定账号。
 */
async function handleLoginClaim(request, env) {
  const body = await readBody(request);
  const text = String(body.url || body.text || '').trim();
  if (!text) return json({ error: '请粘贴回调地址' }, 400);

  let u;
  try {
    u = new URL(text);
  } catch {
    try {
      const tail = text.startsWith('?') ? text : text.replace(/^[?/]+/, '');
      u = new URL('https://placeholder.local/' + tail);
    } catch {
      return json({ error: '这不像是回调地址' }, 400);
    }
  }

  const p = parseCallbackParams(u);
  if (!p.authCode && !p.refreshToken) {
    return json({ error: '地址里没找到 authCodeInfo / code，请复制完整地址（含 ? 之后的部分）' }, 400);
  }

  let trace = p.trace || String((await env.TRAE_KV.get(LOGIN_LATEST)) || '');
  if (!trace) return json({ error: '没有待完成的登录会话，请先点「添加账号」' }, 400);

  const sess = await getLoginSession(env, trace);
  if (!sess) return json({ error: '登录会话已过期，请重新发起' }, 400);

  try {
    const r = await completeLogin(env, sess, p);
    return json({ ok: true, label: r.label, id: r.id, via: r.via });
  } catch (e) {
    sess.status = 'error';
    sess.error = e.message;
    await putLoginSession(env, sess);
    return json({ error: e.message }, 502);
  }
}

const PAGE = '<!DOCTYPE html><meta charset="utf-8"><title>控制台</title><p>控制台在根路径 <a href="/">/</a>。</p>';

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

const __mod = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    try {
      if (path === '/' || path === '/index.html') {
        return new Response(PAGE, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      // 定时任务入口：口令走 header/query，不需要登录密码
      if (path === '/cron') {
        const c = requireCron(request, env);
        if (!c.ok) return c.res;
        return handleRun(request, env, false);
      }

      // 扫码登录回调：由浏览器跳转过来，带不了 admin token，只能靠 state 校验
      if (path === '/oauth/callback' && method === 'GET') return handleOauthCallback(request, env);
      if (path === '/oauth/probe' && (method === 'GET' || method === 'HEAD')) {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
      }

      if (!path.startsWith('/api/')) return json({ error: 'not found' }, 404);

      const a = requireAdmin(request, env);
      if (!a.ok) return a.res;

      if (path === '/api/login/start' && method === 'POST') return handleLoginStart(request, env);
      if (path === '/api/login/poll' && method === 'GET') return handleLoginPoll(request, env);
      if (path === '/api/login/claim' && method === 'POST') return handleLoginClaim(request, env);

      if (path === '/api/list' && method === 'GET') return handleList(request, env);
      if (path === '/api/accounts/remove' && method === 'POST') return handleRemove(request, env);
      if (path === '/api/remove' && method === 'POST') return handleRemove(request, env);
      if (path === '/api/rename' && method === 'POST') return handleRename(request, env);
      if (path === '/api/refresh' && method === 'POST') {
        const body = await readBody(request);
        const id = String(body.id ?? '').trim();
        if (!id) return json({ error: '缺少 id' }, 400);
        try {
          return json({ ok: true, account: await refreshOne(env, id) });
        } catch (e) {
          return json({ error: e.message }, 502);
        }
      }
      if (path === '/api/enable' && method === 'POST') {
        const body = await readBody(request);
        const id = String(body.id ?? '').trim();
        if (!id) return json({ error: '缺少 id' }, 400);
        try {
          return json({ ok: true, ...(await setEnabled(env, id, body.enabled !== false)) });
        } catch (e) {
          return json({ error: e.message }, 404);
        }
      }
      if (path === '/api/run' && method === 'POST') {
        const force = url.searchParams.get('force') === '1';
        return handleRun(request, env, force);
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },

  /** Cloudflare Cron Trigger 到点自动跑 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const list = await listAccounts(env);
        for (const meta of list) {
          const acct = await getAccount(env, meta.id);
          if (!acct) continue;
          try {
            await signinOne(env, acct, { force: false });
          } catch {
            /* 单账号失败不影响其他账号 */
          }
        }
      })()
    );
  },
};

/** 内部函数，供自检代码验证签名流程，不参与运行时逻辑 */
const __internal = { ecSign, importPrivateKey, derSig, jwtExp, buildProof, PEM_TEST: true };


return {
  fetch: __mod.fetch,
  scheduled: __mod.scheduled,
  list,
  run,
  refresh: refreshOne,
  remove: removeAccount,
  rename: renameAccount,
  setEnabled,
  __internal,
};
})();
const WorkBuddy = (() => {
const API = 'https://copilot.tencent.com';

/* ------------------------------------------------------------------ */
/* 编码工具                                                            */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(buf) {
  return b64encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return b64decode(s + '='.repeat((4 - (s.length % 4)) % 4));
}

function randomId(bytes = 12) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** 定长比较，避免口令被时序侧信道猜出来 */
function timingSafeEqual(a, b) {
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* 加密：AES-256-GCM + 每条记录随机 salt，密钥由主密钥 HKDF 派生        */
/* ------------------------------------------------------------------ */

async function deriveKey(env, salt) {
  const raw = env.WB_MASTER_KEY;
  if (!raw) throw new Error('缺少 MASTER_KEY');

  let master;
  try {
    master = b64decode(raw.trim());
  } catch {
    throw new Error('MASTER_KEY 不是合法 base64');
  }
  if (master.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节（base64 后 44 字符）');

  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('wb-signin/v1/account') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function sealRecord(env, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(env, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(obj))
  );
  return JSON.stringify({ v: 1, s: b64encode(salt), i: b64encode(iv), d: b64encode(ct) });
}

async function openRecord(env, text) {
  const box = JSON.parse(text);
  if (box.v !== 1) throw new Error('不认识的记录版本');
  const key = await deriveKey(env, b64decode(box.s));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(box.i) },
    key,
    b64decode(box.d)
  );
  return JSON.parse(dec.decode(pt));
}

/* ------------------------------------------------------------------ */
/* KV 读写                                                             */
/* ------------------------------------------------------------------ */

const acctKey = (id) => `acct:${id}`;
const INDEX_KEY = 'index:accounts';

async function listAccounts(env) {
  const raw = await env.WB_KV.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveIndex(env, list) {
  await env.WB_KV.put(INDEX_KEY, JSON.stringify(list));
}

async function getAccount(env, id) {
  const raw = await env.WB_KV.get(acctKey(id));
  if (!raw) return null;
  return openRecord(env, raw);
}

async function putAccount(env, acct) {
  await env.WB_KV.put(acctKey(acct.id), await sealRecord(env, acct));
}

/* ------------------------------------------------------------------ */
/* 与 WorkBuddy 服务端交互                                              */
/* ------------------------------------------------------------------ */

async function wbFetch(path, { method = 'POST', headers = {}, body = '{}', timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'workbuddy-signin-worker/1.0',
        ...headers,
      },
      body: method === 'GET' ? undefined : body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`响应不是 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 refresh_token 换新的双令牌。
 * 注意：refreshToken 会轮换，先前签发的随即失效，调用方必须立刻保存新的。
 */
async function refreshTokens(refreshToken) {
  const { status, json } = await wbFetch('/v2/plugin/auth/token/refresh', {
    headers: {
      'X-Refresh-Token': refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': 'copilot.tencent.com',
    },
  });

  if (json?.code !== 0 || !json?.data) {
    const err = new Error(
      `刷新令牌失败 code=${json?.code} ${json?.msg ?? ''} (HTTP ${status})`
    );
    err.code = json?.code;
    err.fatal = true; // 令牌链路断了，需要人工重新抓
    throw err;
  }

  const d = json.data;
  return {
    accessToken: d.accessToken,
    refreshToken: d.refreshToken || refreshToken,
    expiresIn: Number(d.expiresIn) || 0,
    refreshExpiresIn: Number(d.refreshExpiresIn) || 0,
  };
}

/**
 * 扫码登录第一步：向服务端申请一个登录态。
 * 返回的 authUrl 就是官方登录页（微信扫码页），state 用来轮询结果。
 */
async function requestLoginState() {
  const { status, json } = await wbFetch('/v2/plugin/auth/state?platform=workbuddy', {
    headers: {
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
      'X-Domain': 'copilot.tencent.com',
    },
  });
  if (json?.code !== 0 || !json?.data?.state) {
    throw new Error(`申请登录态失败 code=${json?.code} ${json?.msg ?? ''} (HTTP ${status})`);
  }
  return { state: json.data.state, authUrl: json.data.authUrl };
}

/**
 * 扫码登录第二步：轮询这个 state 有没有被授权。
 *   code 11217 → 还在等扫码/确认
 *   code 0     → 已经拿到令牌
 */
async function pollLoginToken(state) {
  const { status, json } = await wbFetch(
    `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    {
      method: 'GET',
      headers: {
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'X-Domain': 'copilot.tencent.com',
      },
    }
  );
  if (json?.code === 11217) return { pending: true };
  if (json?.code === 0 && json?.data?.accessToken) return { tokens: json.data };
  throw new Error(`轮询登录结果失败 code=${json?.code} ${json?.msg ?? ''} (HTTP ${status})`);
}

/** 尽量取一个昵称当备注名，取不到就算了，不影响登录 */
async function fetchNickname(at) {
  try {
    const { json } = await wbFetch('/v2/accounts', {
      method: 'GET',
      headers: { ...authHeader(at), 'X-Domain': 'copilot.tencent.com' },
    });
    const list = json?.data?.accounts ?? json?.data;
    const first = Array.isArray(list) ? list[0] : null;
    return String(first?.nickname ?? first?.nickName ?? '').trim();
  } catch {
    return '';
  }
}

/** 把一条令牌落成账号记录（加密存 KV + 更新索引） */
async function persistAccount(env, { refreshToken, label, accessToken, refreshExpiresIn }) {
  const id = randomId(9);
  let name = String(label ?? '').trim().slice(0, 40);
  if (!name && accessToken) name = await fetchNickname(accessToken);
  if (!name) name = `账号-${id.slice(0, 4)}`;

  const acct = {
    id,
    label: name,
    refreshToken,
    createdAt: Date.now(),
    lastState: 'new',
    lastMsg: '尚未运行',
    verified: true,
    enabled: true,
    tokenRefreshedAt: Date.now(),
    refreshExp: Number(refreshExpiresIn) > 0 ? Date.now() + Number(refreshExpiresIn) * 1000 : 0,
  };
  await putAccount(env, acct);

  const list = await listAccounts(env);
  list.push({ id, label: acct.label, createdAt: acct.createdAt });
  await saveIndex(env, list);
  return acct;
}

const authHeader = (at) => ({ Authorization: `Bearer ${at}` });

async function checkinStatus(at) {
  const { json } = await wbFetch('/v2/billing/meter/checkin-activity-status', {
    headers: authHeader(at),
  });
  if (json?.code !== 0 || !json?.data) {
    return { ok: false, code: json?.code, msg: json?.msg };
  }
  return { ok: true, data: json.data };
}

async function doCheckin(at) {
  const { json } = await wbFetch('/v2/billing/meter/daily-checkin', {
    headers: authHeader(at),
  });
  if (json?.code === 0) {
    return { state: 'checked', credit: json.data?.credit ?? 100, raw: json.data };
  }
  if (json?.code === 10001) {
    return { state: 'already', credit: 0 };
  }
  return { state: 'error', code: json?.code, msg: json?.msg };
}

/* ------------------------------------------------------------------ */
/* 单个账号的完整签到流程                                               */
/* ------------------------------------------------------------------ */

async function signinOne(env, acct, { force = false } = {}) {
  const now = Date.now();
  const today = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10); // 按北京时间算日期

  if (acct.enabled === false) {
    return { id: acct.id, label: acct.label, state: 'disabled', msg: '账号已停用' };
  }

  // 今天已成功过、且没要求强制，直接跳过（省一次请求，也避免无谓刷新）
  if (!force && acct.lastOkDate === today && acct.lastState !== 'error') {
    return { id: acct.id, label: acct.label, state: 'skipped', msg: '今日已完成' };
  }

  let tokens;
  try {
    tokens = await refreshTokens(acct.refreshToken);
  } catch (e) {
    acct.lastState = e.fatal ? 'token_dead' : 'error';
    acct.lastMsg = e.message;
    acct.lastRun = now;
    await putAccount(env, acct);
    return { id: acct.id, label: acct.label, state: acct.lastState, msg: e.message };
  }

  // 先落盘新令牌。哪怕后面签到失败，令牌链也不能断。
  acct.refreshToken = tokens.refreshToken;
  acct.tokenRefreshedAt = now;
  if (tokens.refreshExpiresIn) acct.refreshExp = now + tokens.refreshExpiresIn * 1000;

  let result;
  try {
    result = await doCheckin(tokens.accessToken);
  } catch (e) {
    acct.lastState = 'error';
    acct.lastMsg = `签到请求异常: ${e.message}`;
    acct.lastRun = now;
    await putAccount(env, acct);
    return { id: acct.id, label: acct.label, state: 'error', msg: acct.lastMsg };
  }

  let streak = null;
  let total = null;
  try {
    const st = await checkinStatus(tokens.accessToken);
    if (st.ok) {
      streak = st.data.streak_days ?? null;
      total = st.data.total_credits ?? null;
      // 顺手把最新 accessToken 的服务端视图对上，用于判断是否真的已签
      if (st.data.checked_in_today === true && result.state === 'error') {
        result = { state: 'already', credit: 0 };
      }
    }
  } catch {
    /* 状态查询失败不影响主流程 */
  }

  acct.lastRun = now;
  acct.streak = streak;
  acct.total = total;

  if (result.state === 'error') {
    acct.lastState = 'error';
    acct.lastMsg = `签到失败 code=${result.code} ${result.msg ?? ''}`;
  } else {
    acct.lastState = result.state; // 'checked' | 'already'
    acct.lastMsg = result.state === 'checked' ? `+${result.credit} 积分` : '今日已签';
    acct.lastOkDate = today;
    if (result.state === 'checked') {
      acct.lastCredit = result.credit;
      acct.lastCreditDate = today;
      acct.totalSigned = (acct.totalSigned ?? 0) + 1;
    }
  }

  await putAccount(env, acct);
  return {
    id: acct.id,
    label: acct.label,
    state: acct.lastState,
    msg: acct.lastMsg,
    credit: result.state === 'checked' ? result.credit : null,
    streak,
    total,
  };
}

/* ------------------------------------------------------------------ */
/* 页面与鉴权辅助                                                       */
/* ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function requireAdmin(request, env) {
  const url = new URL(request.url);
  const given =
    request.headers.get('X-Admin-Token') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('token');
  if (!env.ADMIN_TOKEN) return { ok: false, res: json({ error: '未配置 ADMIN_TOKEN' }, 500) };
  if (!timingSafeEqual(given, env.ADMIN_TOKEN)) {
    return { ok: false, res: json({ error: '登录密码不正确' }, 401) };
  }
  return { ok: true };
}

function requireCron(request, env) {
  const secret = env.CRON_SECRET || env.ADMIN_TOKEN;
  const url = new URL(request.url);
  const given = request.headers.get('X-Cron-Secret') || url.searchParams.get('key');
  if (!secret) return { ok: false, res: json({ error: '未配置 CRON_SECRET / ADMIN_TOKEN' }, 500) };
  if (!timingSafeEqual(given, secret)) return { ok: false, res: json({ error: '口令不对' }, 401) };
  return { ok: true };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

/** 扫码登录：申请二维码（其实是一个官方登录页地址） */
async function handleLoginStart(request, env) {
  const { state, authUrl } = await requestLoginState();
  // 记一下 state 是我们发出去的，避免有人拿别人的 state 来轮询
  await env.WB_KV.put(`login:${state}`, String(Date.now()), { expirationTtl: 900 });
  return json({ ok: true, state, authUrl });
}

/** 扫码登录：轮询授权结果，拿到令牌就顺手存成账号 */
async function handleLoginPoll(request, env) {
  const url = new URL(request.url);
  const state = String(url.searchParams.get('state') ?? '').trim();
  if (!state) return json({ error: '缺少 state' }, 400);

  const known = await env.WB_KV.get(`login:${state}`);
  if (!known) return json({ error: '登录会话已过期，请重新获取二维码' }, 400);

  const r = await pollLoginToken(state);
  if (r.pending) return json({ status: 'pending' });

  const rt = String(r.tokens.refreshToken ?? '').trim();
  if (!rt) return json({ error: '登录成功但服务端没返回 refreshToken' }, 502);

  const acct = await persistAccount(env, {
    refreshToken: rt,
    accessToken: r.tokens.accessToken,
    refreshExpiresIn: Number(r.tokens.refreshExpiresIn) || 0,
  });
  await env.WB_KV.delete(`login:${state}`);
  return json({ status: 'ok', id: acct.id, label: acct.label });
}

const bjDayOf = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

/** 列表与刷新共用同一套字段，令牌永不下发 */
function publicView(a, now, today) {
  const creditToday = a.lastCreditDate
    ? a.lastCreditDate === today
    : (a.lastOkDate === today && (a.lastState === 'checked' || a.lastState === 'already'));
  return {
    id: a.id,
    label: a.label,
    enabled: a.enabled !== false,
    lastState: a.lastState,
    lastMsg: a.lastMsg,
    lastRun: a.lastRun ? new Date(a.lastRun + 8 * 3600e3).toISOString().replace('Z', ' +08:00') : null,
    lastOkDate: a.lastOkDate ?? null,
    lastCredit: creditToday ? (a.lastCredit ?? null) : null,
    streak: a.streak ?? null,
    total: a.total ?? null,
    credits: typeof a.total === 'number' ? a.total : null,
    totalSigned: a.totalSigned ?? 0,
    credExp: a.refreshExp || null,
    credKind: 'refresh',
    today,
    signedToday: a.lastOkDate === today,
    ranToday: a.lastRun ? bjDayOf(a.lastRun) === today : false,
    // 永远不返回令牌，连指纹都不给
  };
}

async function list(env) {
  const list = await listAccounts(env);
  const out = [];
  const now = Date.now();
  const today = bjDayOf(now);
  for (const meta of list) {
    const a = await getAccount(env, meta.id);
    if (!a) continue;
    out.push(publicView(a, now, today));
  }
  return { count: out.length, today, accounts: out };
}

async function removeAccount(env, id) {
  await env.WB_KV.delete(acctKey(id));
  const list = (await listAccounts(env)).filter((x) => x.id !== id);
  await saveIndex(env, list);
  return { removed: id };
}

/** 改备注：登录时取不到昵称的账号，允许手动命名 */
async function renameAccount(env, id, label) {
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  acct.label = label;
  await putAccount(env, acct);

  const list = await listAccounts(env);
  await saveIndex(env, list.map((x) => (x.id === id ? { ...x, label } : x)));
  return { id, label };
}

async function setEnabled(env, id, enabled) {
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  acct.enabled = !!enabled;
  await putAccount(env, acct);
  return { id, enabled: !!enabled };
}

/** 只查状态与连签，不签到。用于控制台「刷新积分」。 */
async function refreshOne(env, id) {
  const now = Date.now();
  const today = bjDayOf(now);
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  const wasCheckedToday = acct.lastOkDate === today && acct.lastState === 'checked';

  let tokens;
  try {
    tokens = await refreshTokens(acct.refreshToken);
  } catch (e) {
    acct.lastState = 'token_dead';
    acct.lastMsg = e.message;
    acct.lastRun = now;
    await putAccount(env, acct);
    return publicView(acct, now, today);
  }

  acct.refreshToken = tokens.refreshToken;
  acct.tokenRefreshedAt = now;
  if (tokens.refreshExpiresIn) acct.refreshExp = now + tokens.refreshExpiresIn * 1000;

  const st = await checkinStatus(tokens.accessToken).catch(() => ({ ok: false }));
  if (st.ok) {
    acct.streak = st.data.streak_days ?? acct.streak ?? null;
    acct.total = st.data.total_credits ?? acct.total ?? null;
    if (st.data.checked_in_today === true) {
      acct.lastOkDate = today;
      acct.cooldownUntil = 0;
      if (!wasCheckedToday && acct.lastState !== 'token_dead') {
        acct.lastState = 'already';
        acct.lastMsg = '服务端显示今日已签';
      }
    }
  }
  await putAccount(env, acct);
  return publicView(acct, now, today);
}

async function run(env, { force = false, id = '' } = {}) {
  const list = await listAccounts(env);
  const results = [];
  for (const meta of list) {
    if (id && meta.id !== id) continue;
    const a = await getAccount(env, meta.id);
    if (!a) continue;
    try {
      results.push({ platform: 'workbuddy', ...(await signinOne(env, a, { force })) });
    } catch (e) {
      results.push({ id: a.id, label: a.label, platform: 'workbuddy', state: 'error', msg: e.message });
    }
  }
  return {
    at: new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', ' +08:00'),
    accounts: results.length,
    checked: results.filter((r) => r.state === 'checked').length,
    already: results.filter((r) => r.state === 'already' || r.state === 'skipped').length,
    failed: results.filter((r) => r.state === 'error' || r.state === 'token_dead').length,
    cooling: results.filter((r) => ['rate', 'cooldown', 'pending'].includes(r.state)).length,
    results,
  };
}

async function handleList(request, env) {
  return json(await list(env));
}

async function handleRemove(request, env) {
  const body = await readBody(request);
  const id = String(body.id ?? '').trim();
  if (!id) return json({ error: '缺少 id' }, 400);
  return json({ ok: true, ...(await removeAccount(env, id)) });
}

async function handleRename(request, env) {
  const body = await readBody(request);
  const id = String(body.id ?? '').trim();
  const label = String(body.label ?? '').trim().slice(0, 40);
  if (!id) return json({ error: '缺少 id' }, 400);
  if (!label) return json({ error: '备注不能为空' }, 400);
  try {
    return json({ ok: true, ...(await renameAccount(env, id, label)) });
  } catch (e) {
    return json({ error: e.message }, 404);
  }
}

async function handleRun(request, env, force) {
  const body = await readBody(request);
  return json(await run(env, { force, id: String(body.id ?? '').trim() }));
}

const PAGE = '<!DOCTYPE html><meta charset="utf-8"><title>控制台</title><p>控制台在根路径 <a href="/">/</a>。</p>';

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

const __mod = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    try {
      if (path === '/' || path === '/index.html') {
        return new Response(PAGE, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      // 定时任务入口：口令走 header/query，不需要登录密码
      if (path === '/cron') {
        const c = requireCron(request, env);
        if (!c.ok) return c.res;
        return handleRun(request, env, false);
      }

      if (!path.startsWith('/api/')) return json({ error: 'not found' }, 404);

      const a = requireAdmin(request, env);
      if (!a.ok) return a.res;

      if (path === '/api/list' && method === 'GET') return handleList(request, env);
      if (path === '/api/login/start' && method === 'POST') return handleLoginStart(request, env);
      if (path === '/api/login/poll' && method === 'GET') return handleLoginPoll(request, env);
      if (path === '/api/remove' && method === 'POST') return handleRemove(request, env);
      if (path === '/api/rename' && method === 'POST') return handleRename(request, env);
      if (path === '/api/refresh' && method === 'POST') {
        const body = await readBody(request);
        const id = String(body.id ?? '').trim();
        if (!id) return json({ error: '缺少 id' }, 400);
        try {
          return json({ ok: true, account: await refreshOne(env, id) });
        } catch (e) {
          return json({ error: e.message }, 502);
        }
      }
      if (path === '/api/enable' && method === 'POST') {
        const body = await readBody(request);
        const id = String(body.id ?? '').trim();
        if (!id) return json({ error: '缺少 id' }, 400);
        try {
          return json({ ok: true, ...(await setEnabled(env, id, body.enabled !== false)) });
        } catch (e) {
          return json({ error: e.message }, 404);
        }
      }
      if (path === '/api/run' && method === 'POST') {
        const force = url.searchParams.get('force') === '1';
        return handleRun(request, env, force);
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },

  /** Cloudflare Cron Trigger 到点自动跑 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const list = await listAccounts(env);
        for (const meta of list) {
          const acct = await getAccount(env, meta.id);
          if (!acct) continue;
          try {
            await signinOne(env, acct, { force: false });
          } catch {
            /* 单账号失败不影响其他账号 */
          }
        }
      })()
    );
  },
};


return {
  fetch: __mod.fetch,
  scheduled: __mod.scheduled,
  list,
  run,
  refresh: refreshOne,
  remove: removeAccount,
  rename: renameAccount,
  setEnabled,
};
})();
/* ================================================================== */
/* 模块三：通用平台工厂                                                 */
/*                                                                     */
/* 新增一个「粘贴凭证即可签到」的平台，只需要提供：                      */
/*   meta / urls / headers / normalize / identity / parseStatus /       */
/*   parseClaim 这几样，KV、加密、签到编排、增删改查和路由全部复用。     */
/* ================================================================== */

function createTokenPlatform(cfg) {
  const vault = SH.makeVault(cfg.keyInfo);
  const INDEX_KEY = 'index:accounts';
  const acctKey = (id) => `acct:${id}`;
  const META = cfg.meta;

  async function listRaw(env) {
    const raw = await env.PLATFORM_KV.get(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  }

  async function saveIndex(env, list) {
    await env.PLATFORM_KV.put(INDEX_KEY, JSON.stringify(list));
  }

  async function getAccount(env, id) {
    const raw = await env.PLATFORM_KV.get(acctKey(id));
    if (!raw) return null;
    return vault.open(env, raw);
  }

  async function putAccount(env, acct) {
    await env.PLATFORM_KV.put(acctKey(acct.id), await vault.seal(env, acct));
  }

  function primaryOf(creds) {
    for (const k of cfg.primaryFields || Object.keys(creds)) {
      const v = String(creds[k] || '').trim();
      if (v) return k + '=' + v;
    }
    return '';
  }

  async function credHashOf(creds) {
    return (await SH.sha256Hex(primaryOf(creds))).slice(0, 24);
  }

  function publicView(a, now, today) {
    const creditToday = a.lastCreditDate
      ? a.lastCreditDate === today
      : (a.lastOkDate === today && (a.lastState === 'checked' || a.lastState === 'already'));
    return {
      id: a.id,
      label: a.label,
      enabled: a.enabled !== false,
      lastState: a.lastState,
      lastMsg: a.lastMsg,
      lastRun: a.lastRun ? SH.fmtBj(a.lastRun) : null,
      lastOkDate: a.lastOkDate ?? null,
      lastCredit: creditToday ? (a.lastCredit ?? null) : null,
      credits: typeof a.credits === 'number' ? Math.round(a.credits * 100) / 100 : null,
      streak: a.streak ?? null,
      total: a.total ?? null,
      totalSigned: a.totalSigned ?? 0,
      totalCredit: a.totalCredit ?? 0,
      credExp: a.credExp || null,
      credKind: META.credKind || 'static',
      cooldownUntil: Number(a.cooldownUntil || 0) > now ? a.cooldownUntil : 0,
      signedToday: a.lastOkDate === today,
      ranToday: a.lastRun ? SH.bjDay(a.lastRun) === today : false,
      platform: META.key,
    };
  }

  async function list(env) {
    const entries = await listRaw(env);
    const out = [];
    const now = Date.now();
    const today = SH.bjDay(now);
    for (const meta of entries) {
      const a = await getAccount(env, meta.id).catch(() => null);
      if (!a) continue;
      out.push(publicView(a, now, today));
    }
    return { count: out.length, today, accounts: out };
  }

  async function callJson(env, prepared, url, method) {
    const headers = await cfg.headers(env, prepared);
    const res = await SH.httpJson(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : (cfg.body || '{}'),
      timeout: META.timeout || 20000,
    });
    if (res.status === 401 || res.status === 403) {
      throw new PlatformAuthError(`HTTP ${res.status}：凭证无效或已过期`);
    }
    return res;
  }

  async function readStatus(env, prepared) {
    try {
      const [url] = cfg.urls(prepared);
      const res = await callJson(env, prepared, url, cfg.statusMethod || 'POST');
      return cfg.parseStatus(res.json, res.status, res.text) || { ok: false, message: '空响应' };
    } catch (e) {
      if (e instanceof PlatformAuthError) return { ok: false, authFailed: true, message: e.message };
      throw e;
    }
  }

  async function readClaim(env, prepared) {
    try {
      const [, url] = cfg.urls(prepared);
      const res = await callJson(env, prepared, url, cfg.claimMethod || 'POST');
      return cfg.parseClaim(res.json, res.status, res.text) || { ok: false, message: '空响应' };
    } catch (e) {
      if (e instanceof PlatformAuthError) return { ok: false, authFailed: true, message: e.message };
      throw e;
    }
  }

  function isNoActivity(message) {
    const s = String(message || '');
    return /没有进行中|无进行中|活动未开启|活动未开始|活动已结束|已结束|暂无活动/.test(s);
  }

  async function runOne(env, acct, { force = false } = {}) {
    const now = Date.now();
    const today = SH.bjDay(now);
    const base = { id: acct.id, label: acct.label, platform: META.key };

    if (acct.enabled === false) return { ...base, state: 'disabled', msg: '账号已停用' };

    if (!force && Number(acct.cooldownUntil || 0) > now) {
      const left = Math.ceil((Number(acct.cooldownUntil) - now) / 60000);
      return { ...base, state: 'cooldown', msg: `限流冷却中，约 ${left} 分钟` };
    }

    if (!force && acct.lastOkDate === today && acct.lastState !== 'error' && acct.lastState !== 'token_dead') {
      return { ...base, state: 'skipped', msg: '今日已完成' };
    }
    if (!force && acct.noActivityDate === today) {
      return { ...base, state: 'no_activity', msg: '今日无活动' };
    }

    let prepared;
    try {
      prepared = cfg.prepare ? await cfg.prepare(env, { ...(acct.creds || {}) }, acct) : { ...(acct.creds || {}) };
    } catch (e) {
      acct.lastState = e.auth ? 'token_dead' : 'error';
      acct.lastMsg = e.message;
      acct.lastRun = now;
      await putAccount(env, acct);
      return { ...base, state: acct.lastState, msg: e.message };
    }

    // 1) 先查状态；状态查询失败不致命，继续尝试领取
    let st = null;
    if (cfg.urls) {
      try {
        st = await readStatus(env, prepared);
      } catch (e) {
        st = { ok: false, message: e.message };
      }
    }

    if (st?.authFailed) {
      acct.lastState = 'token_dead';
      acct.lastMsg = st.message || '凭证失效';
      acct.lastRun = now;
      await putAccount(env, acct);
      return { ...base, state: 'token_dead', msg: acct.lastMsg };
    }

    if (st) {
      if (st.credits != null) acct.credits = st.credits;
      if (st.streak != null) acct.streak = st.streak;
      if (st.credExp) acct.credExp = st.credExp;
      if (st.uid) acct.uid = st.uid;
      if (st.checked && st.trustworthy !== false) {
        acct.lastOkDate = today;
        acct.noActivityDate = 0;
        acct.lastState = 'already';
        acct.lastMsg = '今日已签';
        acct.lastRun = now;
        acct.cooldownUntil = 0;
        await putAccount(env, acct);
        return { ...base, state: 'already', msg: acct.lastMsg, credits: acct.credits ?? null };
      }
    }

    // 2) 领取（各平台都是幂等的）
    let cl;
    try {
      cl = await readClaim(env, prepared);
    } catch (e) {
      acct.lastState = 'error';
      acct.lastMsg = `签到请求异常: ${e.message}`;
      acct.lastRun = now;
      await putAccount(env, acct);
      return { ...base, state: 'error', msg: acct.lastMsg };
    }

    acct.lastRun = now;

    if (cl.authFailed) {
      acct.lastState = 'token_dead';
      acct.lastMsg = cl.message || '凭证失效';
      await putAccount(env, acct);
      return { ...base, state: 'token_dead', msg: acct.lastMsg };
    }

    if (cl.noActivity || (!cl.ok && isNoActivity(cl.message))) {
      acct.lastState = 'no_activity';
      acct.lastMsg = cl.message || '当前没有进行中的签到活动';
      acct.noActivityDate = today;
      acct.cooldownUntil = 0;
      if (cl.credits != null) acct.credits = cl.credits;
      await putAccount(env, acct);
      return { ...base, state: 'no_activity', msg: acct.lastMsg, credits: acct.credits ?? null };
    }

    if (cl.retryable) {
      const mins = 30;
      acct.cooldownUntil = now + mins * 60000;
      acct.lastState = 'rate';
      acct.lastMsg = cl.message || `限流，冷却 ${mins} 分钟`;
      await putAccount(env, acct);
      return { ...base, state: 'rate', msg: acct.lastMsg };
    }

    if (!cl.ok) {
      acct.lastState = 'error';
      acct.lastMsg = cl.message || '签到失败';
      await putAccount(env, acct);
      return { ...base, state: 'error', msg: acct.lastMsg };
    }

    // 3) 成功 / 今日已领
    acct.lastOkDate = today;
    acct.noActivityDate = 0;
    acct.lastState = cl.already ? 'already' : 'checked';
    acct.lastMsg = cl.message || (cl.already ? '今日已签' : '签到成功');
    acct.cooldownUntil = 0;
    if (!cl.already) {
      acct.lastCredit = cl.credit ?? null;
      acct.lastCreditDate = today;
      if (cl.credit != null) acct.totalCredit = (acct.totalCredit || 0) + Number(cl.credit || 0);
      acct.totalSigned = (acct.totalSigned || 0) + 1;
    }
    if (cl.credits != null) acct.credits = cl.credits;
    if (cl.streak != null) acct.streak = cl.streak;
    if (cl.credExp) acct.credExp = cl.credExp;

    if (cfg.afterClaim) {
      try {
        const info = await cfg.afterClaim(env, prepared);
        if (info && info.detail) acct.lastMsg += '；' + info.detail;
        if (info && info.credits != null) acct.credits = info.credits;
        if (info && info.streak != null) acct.streak = info.streak;
      } catch {
        /* 后续动作失败不影响签到结论 */
      }
    }

    await putAccount(env, acct);
    return {
      ...base,
      state: acct.lastState,
      msg: acct.lastMsg,
      credit: cl.already ? null : cl.credit ?? null,
      credits: acct.credits ?? null,
      streak: acct.streak ?? null,
    };
  }

  async function run(env, { force = false, id = '' } = {}) {
    const entries = await listRaw(env);
    const results = [];
    for (const meta of entries) {
      if (id && meta.id !== id) continue;
      const a = await getAccount(env, meta.id).catch(() => null);
      if (!a) continue;
      try {
        results.push(await runOne(env, a, { force }));
      } catch (e) {
        results.push({ id: a.id, label: a.label, platform: META.key, state: 'error', msg: e.message });
      }
    }
    return {
      at: SH.fmtBj(Date.now()),
      accounts: results.length,
      checked: results.filter((r) => r.state === 'checked').length,
      already: results.filter((r) => ['already', 'skipped'].includes(r.state)).length,
      failed: results.filter((r) => ['error', 'token_dead'].includes(r.state)).length,
      cooling: results.filter((r) => ['rate', 'cooldown', 'pending'].includes(r.state)).length,
      noActivity: results.filter((r) => r.state === 'no_activity').length,
      results,
    };
  }

  async function refreshOne(env, id) {
    const now = Date.now();
    const today = SH.bjDay(now);
    const acct = await getAccount(env, id);
    if (!acct) throw new Error('账号不存在');
    const wasCheckedToday = acct.lastOkDate === today && acct.lastState === 'checked';

    let prepared;
    try {
      prepared = cfg.prepare ? await cfg.prepare(env, { ...(acct.creds || {}) }, acct) : { ...(acct.creds || {}) };
    } catch (e) {
      if (e.auth) {
        acct.lastState = 'token_dead';
        acct.lastMsg = e.message;
        acct.lastRun = now;
        await putAccount(env, acct);
        return publicView(acct, now, today);
      }
      throw e;
    }

    let st;
    try {
      st = cfg.probe ? await cfg.probe(env, prepared) : await readStatus(env, prepared);
    } catch (e) {
      throw new Error(`刷新失败：${e.message}`);
    }

    if (st?.authFailed) {
      acct.lastState = 'token_dead';
      acct.lastMsg = st.message || '凭证失效';
      acct.lastRun = now;
      await putAccount(env, acct);
      return publicView(acct, now, today);
    }
    if (st && st.ok === false) throw new Error(st.message || '刷新失败');

    if (st) {
      if (st.credits != null) acct.credits = st.credits;
      if (st.streak != null) acct.streak = st.streak;
      if (st.credExp) acct.credExp = st.credExp;
      if (st.uid) acct.uid = st.uid;
      if (st.checked && st.trustworthy !== false) {
        acct.lastOkDate = today;
        acct.cooldownUntil = 0;
        if (!wasCheckedToday && acct.lastState !== 'token_dead') {
          acct.lastState = 'already';
          acct.lastMsg = '服务端显示今日已签';
        }
      }
    }
    acct.lastRun = now;
    await putAccount(env, acct);
    return publicView(acct, now, today);
  }

  async function probeCreds(env, creds) {
    const prepared = cfg.prepare ? await cfg.prepare(env, { ...creds }, null) : { ...creds };
    if (cfg.probe) return cfg.probe(env, prepared);
    const st = await readStatus(env, prepared);
    return { ...st, creds: prepared };
  }

  async function add(env, payload, opts = {}) {
    const raw = (payload && payload.creds) || {};
    const creds = cfg.normalize ? cfg.normalize(raw) : raw;
    if (!cfg.hasCredential(creds)) throw new Error('缺少必填凭证字段');

    const idn = (cfg.identity && cfg.identity(creds)) || {};
    let probe = null;
    if (!opts.skipProbe) {
      try {
        probe = await probeCreds(env, creds);
      } catch (e) {
        throw new Error(`验证凭证失败：${e.message}`);
      }
      if (probe?.authFailed) throw new Error(`凭证无效：${probe.message || '上游返回未认证'}`);
      if (probe && probe.ok === false) throw new Error(`凭证验证失败：${probe.message || '上游没有返回可用数据'}`);
    }

    const now = Date.now();
    const today = SH.bjDay(now);
    const uid = String((payload && payload.uid) || probe?.uid || idn.uid || '').trim();
    const credHash = await credHashOf(creds);
    const label =
      String((payload && payload.label) || '').trim().slice(0, 40) ||
      probe?.label ||
      idn.label ||
      `${META.label}-${SH.randomId(3)}`;

    const entries = await listRaw(env);
    let existing = null;
    for (const meta of entries) {
      const a = await getAccount(env, meta.id).catch(() => null);
      if (!a) continue;
      if (uid && a.uid && a.uid === uid) { existing = a; break; }
      if (a.credHash && a.credHash === credHash) { existing = a; break; }
    }

    if (existing) {
      existing.creds = creds;
      existing.uid = uid || existing.uid || '';
      existing.credHash = credHash;
      if (probe?.credits != null) existing.credits = probe.credits;
      if (probe?.streak != null) existing.streak = probe.streak;
      if (probe?.credExp) existing.credExp = probe.credExp;
      if (payload && payload.label) {
        existing.label = label;
        await saveIndex(env, entries.map((x) => (x.id === existing.id ? { ...x, label } : x)));
      }
      existing.lastMsg = '凭证已更新';
      await putAccount(env, existing);
      return { account: publicView(existing, now, today), updated: true };
    }

    const acct = {
      id: SH.randomId(9),
      label,
      creds,
      uid,
      credHash,
      credExp: probe?.credExp || idn.credExp || null,
      credits: probe?.credits ?? null,
      streak: probe?.streak ?? null,
      enabled: true,
      createdAt: now,
      lastState: 'new',
      lastMsg: '尚未运行',
      totalSigned: 0,
      totalCredit: 0,
      platform: META.key,
    };
    await putAccount(env, acct);
    entries.push({ id: acct.id, label: acct.label, createdAt: acct.createdAt });
    await saveIndex(env, entries);
    return { account: publicView(acct, now, today), updated: false };
  }

  async function removeAccount(env, id) {
    await env.PLATFORM_KV.delete(acctKey(id));
    const list = (await listRaw(env)).filter((x) => x.id !== id);
    await saveIndex(env, list);
    return { removed: id };
  }

  async function renameAccount(env, id, label) {
    const acct = await getAccount(env, id);
    if (!acct) throw new Error('账号不存在');
    acct.label = label;
    await putAccount(env, acct);
    const list = await listRaw(env);
    await saveIndex(env, list.map((x) => (x.id === id ? { ...x, label } : x)));
    return { id, label };
  }

  async function setEnabled(env, id, enabled) {
    const acct = await getAccount(env, id);
    if (!acct) throw new Error('账号不存在');
    acct.enabled = !!enabled;
    await putAccount(env, acct);
    return { id, enabled: !!enabled };
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  async function readBody(request) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  function requireAdmin(request, env) {
    const url = new URL(request.url);
    const given =
      request.headers.get('X-Admin-Token') ||
      (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token');
    if (!env.ADMIN_TOKEN) return { ok: false, res: json({ error: '未配置 ADMIN_TOKEN' }, 500) };
    if (!SH.timingSafeEqual(given, env.ADMIN_TOKEN)) {
      return { ok: false, res: json({ error: '登录密码不正确' }, 401) };
    }
    return { ok: true };
  }

  const __mod = {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method.toUpperCase();
      try {
        if (!path.startsWith('/api/')) return json({ error: 'not found' }, 404);
        const a = requireAdmin(request, env);
        if (!a.ok) return a.res;

        if (path === '/api/list' && method === 'GET') return json(await list(env));
        if (path === '/api/run' && method === 'POST') {
          const body = await readBody(request);
          const force = url.searchParams.get('force') === '1' || body.force === true;
          return json(await run(env, { force, id: String(body.id || '').trim() }));
        }
        if (path === '/api/add' && method === 'POST') {
          const body = await readBody(request);
          try {
            return json({ ok: true, ...(await add(env, body)) });
          } catch (e) {
            return json({ error: e.message }, 400);
          }
        }
        if (path === '/api/remove' && method === 'POST') {
          const body = await readBody(request);
          const id = String(body.id || '').trim();
          if (!id) return json({ error: '缺少 id' }, 400);
          return json({ ok: true, ...(await removeAccount(env, id)) });
        }
        if (path === '/api/rename' && method === 'POST') {
          const body = await readBody(request);
          const id = String(body.id || '').trim();
          const label = String(body.label || '').trim().slice(0, 40);
          if (!id) return json({ error: '缺少 id' }, 400);
          if (!label) return json({ error: '备注不能为空' }, 400);
          try {
            return json({ ok: true, ...(await renameAccount(env, id, label)) });
          } catch (e) {
            return json({ error: e.message }, 404);
          }
        }
        if (path === '/api/enable' && method === 'POST') {
          const body = await readBody(request);
          const id = String(body.id || '').trim();
          if (!id) return json({ error: '缺少 id' }, 400);
          try {
            return json({ ok: true, ...(await setEnabled(env, id, body.enabled !== false)) });
          } catch (e) {
            return json({ error: e.message }, 404);
          }
        }
        if (path === '/api/refresh' && method === 'POST') {
          const body = await readBody(request);
          const id = String(body.id || '').trim();
          if (!id) return json({ error: '缺少 id' }, 400);
          try {
            return json({ ok: true, account: await refreshOne(env, id) });
          } catch (e) {
            return json({ error: e.message }, 502);
          }
        }
        if (path === '/api/login/start' && method === 'POST' && cfg.loginStart) {
          try {
            return json({ ok: true, ...(await cfg.loginStart(env)) });
          } catch (e) {
            return json({ error: e.message }, 502);
          }
        }
        if (path === '/api/login/poll' && method === 'GET' && cfg.loginPoll) {
          const state = String(url.searchParams.get('state') || '').trim();
          if (!state) return json({ error: '缺少 state' }, 400);
          try {
            return json(await cfg.loginPoll(env, state, { add }));
          } catch (e) {
            return json({ error: e.message }, 502);
          }
        }
        if (path === '/api/login/password' && method === 'POST' && cfg.passwordLogin) {
          const body = await readBody(request);
          try {
            const info = await cfg.passwordLogin(env, body);
            const phone = String(body.phone || '').trim();
            const res = await add(env, {
              creds: info.creds,
              label: info.label || `${META.label} ${phone.slice(-4)}`,
              uid: info.uid || '',
            });
            return json({ ok: true, ...res, balance: info.balance || '' });
          } catch (e) {
            return json({ error: e.message }, 400);
          }
        }
        return json({ error: 'not found' }, 404);
      } catch (e) {
        return json({ error: e.message || String(e) }, 500);
      }
    },

    async scheduled(event, env, ctx) {
      ctx.waitUntil(run(env, { force: false }).catch(() => {}));
    },
  };

  return {
    meta: META,
    fetch: __mod.fetch,
    scheduled: __mod.scheduled,
    list,
    run,
    refresh: refreshOne,
    add,
    remove: removeAccount,
    rename: renameAccount,
    setEnabled,
  };
}

/* ================================================================== */
/* 平台三：智谱清言（chatglm.cn）                                       */
/*                                                                     */
/* 接口按官方网页客户端整理：                                           */
/*   GET  /chatglm/member-api/member/member_info                        */
/*   POST /chatglm/member-api/member/daily_login_score                  */
/*                                                                     */
/* 请求头签名：                                                         */
/*   X-Timestamp  毫秒时间戳，倒数第二位被校验位替换                    */
/*   X-Nonce      随机 UUID v4（去掉连字符）                            */
/*   X-Sign       md5(`${ts}-${nonce}-${signSecret}`)                   */
/*                                                                     */
/* 签名盐是官方网页客户端里的固定常量，已内置为默认值；                 */
/* 客户端更新后若签名失效，可用 Secret CHATGLM_SIGN_SECRET 覆盖。       */
/* ================================================================== */

const DEFAULT_CHATGLM_SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

const Zhipu = createTokenPlatform({
  keyInfo: 'zhipu-signin/v1/account',
  meta: {
    key: 'zhipu',
    label: '智谱清言',
    accent: 'amber',
    verified: false,
    verifiedNote: '接口与签名逻辑按官方网页客户端整理，尚未在 Worker 环境用真实账号验证',
    addMode: 'token',
    defaultHost: 'chatglm.cn',
    supportsRefresh: true,
    fields: [
      { name: 'access_token', label: 'chatglm_token', required: true, secret: true, placeholder: '浏览器 Cookie 里的 chatglm_token' },
      { name: 'refresh_token', label: 'chatglm_refresh_token', optional: true, secret: true, placeholder: '可选，令牌过期时用来自动续期' },
      { name: 'device_id', label: '设备 ID', optional: true, placeholder: '可留空，自动派生固定值' },
    ],
    hint: '浏览器登录 chatglm.cn 后，从 Cookie 里取 chatglm_token；device_id 可留空。',
    note: '签名盐已内置，开箱即用；如客户端更新导致签名失败，可用 Secret CHATGLM_SIGN_SECRET 覆盖。',
  },
  primaryFields: ['access_token'],
  statusMethod: 'GET',
  claimMethod: 'POST',
  urls: () => [
    'https://chatglm.cn/chatglm/member-api/member/member_info',
    'https://chatglm.cn/chatglm/member-api/member/daily_login_score',
  ],
  normalize: (c) => ({
    access_token: SH.stripBearer(c.access_token),
    refresh_token: String(c.refresh_token || '').trim(),
    device_id: String(c.device_id || '').trim(),
  }),
  hasCredential: (c) => !!c.access_token,
  prepare: async (env, c) => {
    if (!c.access_token) throw new PlatformAuthError('未配置 access_token（chatglm_token）');
    const secret = String(env.CHATGLM_SIGN_SECRET || env.ZHIPU_SIGN_SECRET || DEFAULT_CHATGLM_SIGN_SECRET).trim();
    if (!secret) {
      throw new Error('缺少智谱签名盐：默认值失效，请用 Secret CHATGLM_SIGN_SECRET 覆盖');
    }
    let device = c.device_id;
    if (!device) {
      const h = await SH.sha256Hex('chatglm:' + c.access_token);
      device = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    return { ...c, _secret: secret, _device: device };
  },
  headers: (env, c) => {
    const ts = (() => {
      const text = String(Date.now());
      const digits = Array.from(text).map(Number);
      const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10;
      return text.slice(0, -2) + checksum + text.slice(-1);
    })();
    const nonce = (() => {
      try {
        return crypto.randomUUID().replace(/-/g, '');
      } catch {
        return SH.randomHex(16);
      }
    })();
    const sign = SH.md5(`${ts}-${nonce}-${c._secret || ''}`);
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=utf-8',
      'App-Name': 'chatglm',
      'X-Device-Id': c._device || '',
      'X-App-Platform': 'pc',
      'X-App-Version': '2.0.7',
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Sign': sign,
      Origin: 'https://chatglm.cn',
      Referer: 'https://chatglm.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      Authorization: 'Bearer ' + c.access_token,
    };
  },
  identity: () => ({}),
  parseStatus: (payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const status = Number(raw.status);
    if (status === 401 || status === 403) {
      return { ok: false, authFailed: true, message: '登录状态失效，请重新获取 chatglm_token', raw };
    }
    let data = null;
    if (raw.status == null) {
      data = raw.result && typeof raw.result === 'object' ? raw.result : raw;
    } else if (status === 0 || status === 200) {
      data = raw.result && typeof raw.result === 'object' ? raw.result : {};
    }
    if (!data) {
      return { ok: false, message: raw.message || raw.msg || `status=${raw.status}`, raw };
    }
    const total = SH.num(data.score ?? data.totalScore ?? data.balance ?? data.total);
    const plan = data.memberType || data.planName || data.vipType || '';
    return {
      ok: true,
      checked: false,
      trustworthy: false,
      credits: total,
      message: plan ? `会员等级=${plan}` : '',
      raw,
    };
  },
  parseClaim: (payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const msg = String(raw.message || raw.msg || '');
    if (/已领取|已经领取|已签到|重复|今日已/.test(msg)) {
      return { ok: true, already: true, message: '今日已领取过登录积分', raw };
    }
    const status = Number(raw.status);
    if (status === 401 || status === 403) {
      return { ok: false, authFailed: true, message: '登录状态失效，请重新获取 chatglm_token', raw };
    }
    let data = null;
    if (raw.status == null) {
      data = raw.result && typeof raw.result === 'object' ? raw.result : raw;
    } else if (status === 0 || status === 200) {
      data = raw.result && typeof raw.result === 'object' ? raw.result : {};
    }
    if (!data) {
      return { ok: false, message: msg || `status=${raw.status}`, raw };
    }
    let credit = null;
    for (const k of ['score', 'credit', 'points', 'reward', 'rewardScore', 'addScore']) {
      const v = SH.num(data[k]);
      if (v != null) { credit = v; break; }
    }
    if (credit == null) {
      for (const k of ['score', 'credit', 'points', 'reward']) {
        const v = SH.num(raw[k]);
        if (v != null) { credit = v; break; }
      }
    }
    return {
      ok: true,
      credit,
      message: credit != null ? `领取成功，+${credit} 积分` : '领取成功',
      raw,
    };
  },
});

/* ================================================================== */
/* 平台四：讯飞 Loomy（loomyad.xunfei.cn）                              */
/*                                                                     */
/* 签到语义：触发每日额度池重置，不是「+5000 积分」。                    */
/*   GET  /api/v1/points/records  只读余额                              */
/*   POST /api/v1/points/first-login  幂等重置                          */
/* ================================================================== */

const Loomy = createTokenPlatform({
  keyInfo: 'loomy-signin/v1/account',
  meta: {
    key: 'loomy',
    label: '讯飞 Loomy',
    accent: 'cyan',
    verified: false,
    verifiedNote: '按公开接口实测整理，尚未在 Worker 环境用真实账号验证',
    addMode: 'token',
    defaultHost: 'loomyad.xunfei.cn',
    supportsRefresh: true,
    fields: [
      { name: 'access_token', label: 'Loomy token', required: true, secret: true, placeholder: '登录后从请求头 / Cookie 里取 token' },
    ],
    hint: '登录 Loomy 客户端或网页后，从请求头或 Cookie 里取 token。',
    note: '签到是「每日额度池重置」，不是直接加积分。',
  },
  primaryFields: ['access_token'],
  statusMethod: 'GET',
  claimMethod: 'POST',
  urls: () => [
    'https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all',
    'https://loomyad.xunfei.cn/api/v1/points/first-login',
  ],
  normalize: (c) => ({ access_token: SH.stripBearer(c.access_token) }),
  hasCredential: (c) => !!c.access_token,
  prepare: async (env, c) => {
    if (!c.access_token) throw new PlatformAuthError('未配置 access_token（Loomy token）');
    return { ...c };
  },
  headers: (env, c) => ({
    Accept: 'application/json',
    token: c.access_token,
    'User-Agent': 'Loomy-Client/1.0',
  }),
  identity: (c) => {
    const claims = SH.jwtClaims(c.access_token);
    if (!claims || !Object.keys(claims).length) return {};
    const uid = String(claims.sub || claims.user_id || claims.uid || '');
    const label = String(claims.nickname || claims.name || claims.preferred_username || '').trim();
    const exp = SH.num(claims.exp);
    return { label, uid, credExp: exp ? exp * 1000 : null };
  },
  parseStatus: (payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const code = raw.code == null ? null : Number(raw.code);
    if (code === 401 || code === 403) {
      return { ok: false, authFailed: true, message: raw.msg || raw.message || 'token 无效或已过期', raw };
    }
    if (code != null && code !== 0 && code !== 200) {
      return { ok: false, message: raw.msg || raw.message || `code=${code}`, raw };
    }
    const d = raw.data && typeof raw.data === 'object' ? raw.data : null;
    if (!d) return { ok: false, message: raw.msg || raw.message || `code=${raw.code}`, raw };
    const left = SH.num(d.dailyBalance);
    const quota = SH.num(d.dailyQuota);
    const used = SH.num(d.dailyConsumed);
    const permanent = SH.num(d.balance);
    const available = SH.num(d.availableBalance);
    const total = available != null ? available : (permanent || 0) + (left || 0);
    return {
      ok: true,
      checked: false,
      trustworthy: false,
      credits: total,
      message: left != null && quota ? `每日池 ${left}/${quota}` : '',
      raw,
    };
  },
  parseClaim: (payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const code = raw.code == null ? null : Number(raw.code);
    if (code === 401 || code === 403) {
      return { ok: false, authFailed: true, message: raw.msg || raw.message || 'token 无效或已过期', raw };
    }
    if (code != null && code !== 0 && code !== 200) {
      return { ok: false, message: raw.msg || raw.message || `code=${code}`, raw };
    }
    const d = raw.data && typeof raw.data === 'object' ? raw.data : null;
    if (!d) {
      return { ok: false, message: raw.msg || raw.message || '上游返回失败', raw };
    }
    const already = !!d.alreadyProcessed;
    const quota = SH.num(d.dailyQuota);
    const left = SH.num(d.dailyBalance);
    const used = SH.num(d.dailyConsumed);
    let msg = already ? '今日额度已就绪（重复调用）' : '每日额度已重置';
    if (quota != null) msg += `，每日池 ${quota}`;
    if (left != null) msg += `，当前剩余 ${left}`;
    if (used != null) msg += `，已用 ${used}`;
    return {
      ok: true,
      already,
      credit: null,
      credits: left != null ? left + (SH.num(d.permanentBalance) || 0) : null,
      message: msg,
      raw,
    };
  },
});

/* ================================================================== */
/* 平台五：讯飞 AStudio（星辰 / Astron Studio）                         */
/*                                                                     */
/*   GET  /points/balance               余额（Cookie 鉴权）             */
/*   POST /tenant-app/v2/init-app       当日首次调用发登录积分           */
/*                                                                     */
/* 凭证：完整 Cookie 串（session），或只填 token 值（access_token）。    */
/* 也支持手机号 + 密码走讯飞 SSO 换 Cookie（密码只用一次，不落盘）。     */
/* ================================================================== */

const ASTUDIO_SSO = 'https://sso.xfyun.cn/SSOService';
const ASTUDIO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const AStudio = createTokenPlatform({
  keyInfo: 'astudio-signin/v1/account',
  meta: {
    key: 'astudio',
    label: '讯飞 AStudio',
    accent: 'rose',
    verified: false,
    verifiedNote: '按公开接口实测整理，尚未在 Worker 环境用真实账号验证',
    addMode: 'password',
    defaultHost: 'agent.xfyun.cn',
    supportsRefresh: true,
    fields: [
      { name: 'session', label: '完整 Cookie（与 token 二选一）', required: false, secret: true, placeholder: 'ssoSessionId=…; sso_sessionid=…; account_id=…; token=…' },
      { name: 'access_token', label: 'token 值', optional: true, secret: true, placeholder: '只填 token 时会自动拼成 Cookie: token=…' },
    ],
    hint: '登录 AStudio 后 F12 复制完整 Cookie；或只取 astron-session.json 里的 token 值。',
    note: '支持手机号 + 密码走讯飞 SSO 换会话。',
  },
  primaryFields: ['session', 'access_token'],
  statusMethod: 'GET',
  claimMethod: 'POST',
  urls: () => [
    'https://agent.xfyun.cn/xingchen-studio/points/balance',
    'https://agent.xfyun.cn/xingchen-studio/tenant-app/v2/init-app',
  ],
  normalize: (c) => ({
    session: String(c.session || '').trim(),
    access_token: String(c.access_token || '').trim(),
  }),
  hasCredential: (c) => !!(c.session || c.access_token),
  prepare: async (env, c) => {
    if (!c.session && !c.access_token) {
      throw new PlatformAuthError('未配置 session（完整 Cookie）或 access_token（token 值）');
    }
    return { ...c };
  },
  headers: (env, c) => {
    const cookie = c.session
      ? (c.session.includes('=') ? c.session : `token=${c.session}`)
      : `token=${c.access_token}`;
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Cookie: cookie,
      clientType: '21',
      studioVersion: '3.4.4',
      'User-Agent': 'AStudio/3.4.4',
      Origin: 'https://agent.xfyun.cn',
    };
  },
  identity: () => ({}),
  parseStatus: (payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const code = raw.code == null ? null : Number(raw.code);
    if (code === 80000 || code === 401 || code === 403) {
      return { ok: false, authFailed: true, message: raw.msg || raw.message || '会话无效', raw };
    }
    if (code != null && code !== 0 && code !== 200) {
      return { ok: false, message: raw.msg || raw.message || `code=${code}`, raw };
    }
    const total = SH.num(raw.totalBalance);
    const spark = SH.num(raw.sparkTotalBalance);
    const expire = String(raw.activityNextExpireTime || '');
    const parts = [];
    if (total != null) parts.push(`通用 ${total}`);
    if (spark != null) parts.push(`星火 ${spark}`);
    if (expire) parts.push(`体验积分到期 ${expire.slice(0, 10)}`);
    return {
      ok: true,
      checked: false,
      trustworthy: false,
      credits: total != null ? total + (spark || 0) : (spark != null ? spark : null),
      message: parts.join('，'),
      raw,
    };
  },
  parseClaim: (payload) => {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const code = raw.code == null ? null : Number(raw.code);
    const msg = String(raw.msg || raw.message || '');
    if (code != null && code !== 0 && code !== 200) {
      if (code === 80000 || code === 401 || code === 403) {
        return { ok: false, authFailed: true, message: msg || '会话无效', raw };
      }
      return { ok: false, message: msg || `code=${code}`, raw };
    }
    if (/已领取|已发放|重复|今日已/.test(msg)) {
      return { ok: true, already: true, message: msg || '今日登录积分已到账', raw };
    }
    const d = raw.data && typeof raw.data === 'object' ? raw.data : {};
    let credit = null;
    for (const src of [d, raw]) {
      for (const k of ['score', 'credit', 'points', 'reward', 'totalBalance', 'dailyReward']) {
        const v = SH.num(src[k]);
        if (v != null) { credit = v; break; }
      }
      if (credit != null) break;
    }
    return {
      ok: true,
      credit,
      message: credit == null ? '已发放今日登录积分' : `已发放今日登录积分，+${credit}`,
      raw,
    };
  },
  passwordLogin: async (env, body) => {
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '');
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('请填写 11 位手机号');
    if (!password) throw new Error('请填写讯飞账号密码');

    const ssoHeaders = {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://passport.xfyun.cn/login',
      Origin: 'https://passport.xfyun.cn',
      'User-Agent': ASTUDIO_UA,
    };
    const cap = await SH.httpJson(
      `${ASTUDIO_SSO}/login/if-captcha?accountName=${encodeURIComponent(phone)}`,
      { method: 'GET', headers: ssoHeaders }
    );
    if (cap.json?.data !== false) {
      throw new Error('该账号本次登录要求滑块验证，请改用「粘贴 Cookie」');
    }

    const qs = new URLSearchParams({ accountName: phone, accountPwd: password, isAct: 'false' }).toString();
    const r = await SH.httpJson(`${ASTUDIO_SSO}/login/check-account?${qs}`, {
      method: 'GET',
      headers: ssoHeaders,
    });
    if (!r.json?.flag) throw new Error(String(r.json?.desc || '账号或密码错误'));

    const d = r.json.data && typeof r.json.data === 'object' ? r.json.data : {};
    const sid = String(d.ssoSessionId || d.token || '');
    const aid = String(d.account_id || d.accountId || '');
    if (!sid) throw new Error('登录响应里没有 ssoSessionId');
    const cookie = [
      `ssoSessionId=${sid}`,
      `sso_sessionid=${sid}`,
      aid ? `account_id=${aid}` : '',
      `token=${sid}`,
    ].filter(Boolean).join('; ');
    return {
      creds: { session: cookie, access_token: sid },
      uid: aid,
      label: '讯飞 AStudio ' + phone.slice(-4),
    };
  },
});
/* ================================================================== */
/* 平台六：WorkBuddy 国际版（www.workbuddy.ai）                         */
/*                                                                     */
/* 与国内版登录态不通用，账号是 Google / GitHub / X 授权的：            */
/*   POST /v2/plugin/auth/state?platform=workbuddy-ai   申请网页授权    */
/*   GET  /v2/plugin/auth/token?state=                   轮询换令牌    */
/*   POST /billing/meter/checkin-activity-status         查活动/签到态 */
/*   POST /v2/billing/meter/daily-checkin                领取           */
/*   POST /v2/chat/completions                           保活对话       */
/*                                                                     */
/* 注意：三个 billing 接口只接受 POST，GET 会被网关回 404。             */
/* 活动没档期时 claim 返回 10001，这是「无活动」而不是凭证失效。        */
/* ================================================================== */

const INTL_API = 'https://www.workbuddy.ai';
const INTL_UA = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/2.137.1';
const INTL_ANON = {
  'User-Agent': INTL_UA,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Domain': 'www.workbuddy.ai',
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
};

function intlHeaders(p) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + p.token,
    'User-Agent': INTL_UA,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy AI',
    'X-IDE-Version': '5.5.2',
    'X-Product': 'WorkBuddy AI',
  };
  if (p.uid) h['X-User-Id'] = p.uid;
  return h;
}

function parseIntlStatus(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const code = Number(raw.code);
  if (code === 401 || code === 40100) {
    return { ok: false, authFailed: true, message: '登录状态失效，请重新登录', raw };
  }
  const d = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const active = d.active !== false;
  const checked = !!(d.today_checked_in ?? d.todayCheckedIn);
  return {
    ok: code === 0,
    checked,
    trustworthy: active,
    credits: null,
    streak: SH.num(d.streak_days),
    message: raw.msg || raw.message || (checked ? '今日已领取' : ''),
    raw,
    active,
  };
}

function parseIntlClaim(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const code = Number(raw.code);
  const d = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const msg = String(raw.msg || raw.message || '');

  if (code === 401 || code === 40100) {
    return { ok: false, authFailed: true, message: '登录状态失效，请重新登录', raw };
  }
  if (code === 0) {
    const credit = SH.num(d.credits ?? d.reward ?? d.amount ?? d.credit);
    return {
      ok: true,
      credit,
      streak: SH.num(d.streak_days),
      credits: SH.num(d.total_credits ?? d.credits),
      message: credit != null ? `领取成功 +${credit}` : '领取成功',
      raw,
    };
  }
  if (code === 10001 || code === 41000 || /没有进行中|活动未开启|活动未开始|已结束/.test(msg)) {
    return { ok: false, noActivity: true, message: msg || '当前没有进行中的签到活动', raw };
  }
  if (code === 40901) {
    return { ok: false, retryable: true, message: msg || '任务暂不可领取', raw };
  }
  if (/已签|已领|already/i.test(msg)) {
    return { ok: true, already: true, message: '今日已领取', raw };
  }
  return { ok: false, message: msg || `code=${code}`, raw };
}

const WorkBuddyIntl = createTokenPlatform({
  keyInfo: 'wbintl-signin/v1/account',
  meta: {
    key: 'workbuddy_intl',
    label: 'WorkBuddy 国际版',
    accent: 'green',
    verified: false,
    verifiedNote: '接口按官方网页客户端整理，尚未在 Worker 环境用真实账号验证',
    addMode: 'oauth',
    defaultHost: 'www.workbuddy.ai',
    supportsRefresh: true,
    credKind: 'access',
    fields: [
      { name: 'access_token', label: 'access_token', required: true, secret: true, placeholder: 'www.workbuddy.ai 的访问令牌' },
      { name: 'refresh_token', label: 'refresh_token', optional: true, secret: true, placeholder: '可选，用于自动续期' },
    ],
    hint: '点「用 Google / GitHub / X 登录」一键授权；也可以粘贴 access_token。',
    note: '国际版与国内版登录态不通用，国内版 token 在这里会 401。',
  },
  primaryFields: ['access_token'],
  statusMethod: 'POST',
  claimMethod: 'POST',
  urls: () => [
    'https://www.workbuddy.ai/billing/meter/checkin-activity-status',
    'https://www.workbuddy.ai/v2/billing/meter/daily-checkin',
  ],
  normalize: (c) => ({
    access_token: SH.stripBearer(c.access_token),
    refresh_token: String(c.refresh_token || '').trim(),
  }),
  hasCredential: (c) => !!c.access_token,
  prepare: async (env, c, acct) => {
    let token = SH.stripBearer(c.access_token);
    if (!token) throw new PlatformAuthError('未配置 access_token。国际版请粘贴 www.workbuddy.ai 的登录令牌。');

    let exp = SH.jwtExp(token);
    if (exp && exp * 1000 < Date.now() + 60000 && c.refresh_token) {
      try {
        const r = await SH.httpJson('https://www.workbuddy.ai/v2/plugin/auth/token/refresh', {
          headers: {
            'X-Refresh-Token': c.refresh_token,
            'X-Auth-Refresh-Source': 'plugin',
            'X-Domain': 'www.workbuddy.ai',
          },
        });
        if (r.json?.code === 0 && r.json?.data?.accessToken) {
          token = r.json.data.accessToken;
          c.access_token = token;
          c.refresh_token = r.json.data.refreshToken || c.refresh_token;
          if (acct) acct.creds = c;
          exp = SH.jwtExp(token);
        }
      } catch {
        /* 续期失败就继续用旧令牌，让上游给出明确 401 */
      }
    }

    const claims = SH.jwtClaims(token);
    const uid = String(claims.sub || claims.user_id || (acct && acct.uid) || '');
    return { ...c, token, uid, credExp: exp ? exp * 1000 : null };
  },
  headers: (env, p) => intlHeaders(p),
  identity: (c) => {
    const claims = SH.jwtClaims(c.access_token);
    if (!claims || !Object.keys(claims).length) return {};
    const uid = String(claims.sub || claims.user_id || '');
    let label = String(claims.name || claims.given_name || '').trim();
    if (!label && claims.email) label = String(claims.email).split('@')[0];
    const exp = SH.num(claims.exp);
    return { label, uid, credExp: exp ? exp * 1000 : null };
  },
  parseStatus: parseIntlStatus,
  parseClaim: parseIntlClaim,
  probe: async (env, p) => {
    const r = await SH.httpJson(INTL_API + '/billing/meter/checkin-activity-status', {
      headers: intlHeaders(p),
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, authFailed: true, message: `HTTP ${r.status}：凭证无效或已过期` };
    }
    const st = parseIntlStatus(r.json);
    const bal = await fetchIntlBalance(p).catch(() => null);
    return {
      ...st,
      credits: bal?.credits ?? st.credits ?? null,
      credExp: p.credExp || null,
      uid: p.uid || '',
      balance: bal,
    };
  },
  afterClaim: async (env, p) => {
    const ok = await intlKeepalive(p).catch(() => false);
    const bal = await fetchIntlBalance(p).catch(() => null);
    return {
      step: '保活对话',
      ok: !!ok,
      detail: ok ? '已完成一次模型调用' : '保活未成功，不影响今天已领到的积分',
      credits: bal?.credits ?? null,
    };
  },
  loginStart: async (env) => {
    const r = await SH.httpJson(INTL_API + '/v2/plugin/auth/state?platform=workbuddy-ai', {
      headers: INTL_ANON,
    });
    if (r.json?.code !== 0 || !r.json?.data?.state || !r.json?.data?.authUrl) {
      throw new Error(`申请授权失败 code=${r.json?.code} ${r.json?.msg || ''} (HTTP ${r.status})`);
    }
    const state = String(r.json.data.state);
    await env.PLATFORM_KV.put('login:' + state, String(Date.now()), { expirationTtl: 900 });
    return { state, authUrl: r.json.data.authUrl };
  },
  loginPoll: async (env, state, ctx) => {
    const known = await env.PLATFORM_KV.get('login:' + state);
    if (!known) return { status: 'expired' };

    const r = await SH.httpJson(
      `https://www.workbuddy.ai/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
      { method: 'GET', headers: INTL_ANON }
    );
    const data = r.json?.data && typeof r.json.data === 'object' ? r.json.data : {};
    const at = String(data.accessToken || '');
    if (!at) {
      if (r.json?.code === 11217 || r.json?.code === 0 || r.json?.code == null) return { status: 'pending' };
      return { ok: false, status: 'error', error: r.json?.msg || '授权失败' };
    }

    const rt = String(data.refreshToken || '');
    let nickname = '';
    let uid = '';
    try {
      const ar = await SH.httpJson(
        `https://www.workbuddy.ai/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
        { method: 'GET', headers: { ...INTL_ANON, Authorization: 'Bearer ' + at } }
      );
      const acc = ar.json?.data && typeof ar.json.data === 'object' ? ar.json.data : {};
      uid = String(acc.uid || '');
      nickname = String(acc.nickname || acc.name || '');
    } catch {
      /* 昵称取不到不影响入库 */
    }

    const res = await ctx.add(
      env,
      { creds: { access_token: at, refresh_token: rt }, label: nickname, uid },
      { skipProbe: true }
    );
    await env.PLATFORM_KV.delete('login:' + state);
    return { status: 'ok', id: res.account.id, label: res.account.label, updated: res.updated };
  },
});

/** 国际版积分余额：汇总 + 套餐明细（都只接受 POST） */
async function fetchIntlBalance(p) {
  const baseHeaders = intlHeaders(p);

  let credits = null;
  let subscription = '';
  let packs = [];

  try {
    const r = await SH.httpJson('https://www.workbuddy.ai/billing/meter/get-user-resource-summary', {
      headers: baseHeaders,
    });
    const d = r.json?.data && typeof r.json.data === 'object' ? r.json.data : {};
    credits = SH.num(d.TotalCredits);
    subscription = String(d.SubscriptionPackageName || '');
  } catch {
    /* 汇总失败时用明细兜底 */
  }

  try {
    const r = await SH.httpJson('https://www.workbuddy.ai/billing/meter/get-user-resource', {
      headers: baseHeaders,
    });
    const accounts = r.json?.data?.Response?.Data?.Accounts || [];
    for (const a of accounts) {
      const remain = SH.num(a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain) || 0;
      if (remain <= 0) continue;
      packs.push({
        name: String(a.PackageName || '积分包').trim(),
        remain,
        end: String(a.CycleEndTime || '').trim(),
      });
    }
    packs.sort((x, y) => String(x.end).localeCompare(String(y.end)));
    if (credits == null) credits = packs.reduce((s, x) => s + x.remain, 0);
  } catch {
    /* 明细失败不影响汇总 */
  }

  return { credits, subscription, packs, nextExpire: packs[0]?.end || '' };
}

/** 发一次最小对话，把今天记成「活跃」；免费模型不消耗积分 */
async function intlKeepalive(p) {
  const models = ['deepseek-v4.1-flash', 'hy3', 'hy4-preview', 'hy4-preview-f'];
  for (const model of models) {
    const rid = crypto.randomUUID();
    const body = JSON.stringify({
      model,
      stream: true,
      max_tokens: 16,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    });
    try {
      const r = await SH.httpJson('https://www.workbuddy.ai/v2/chat/completions', {
        headers: {
          ...intlHeaders(p),
          Accept: 'text/event-stream',
          'X-Request-ID': rid,
          'X-Conversation-Request-ID': rid,
          'X-Conversation-ID': rid,
          'X-Session-ID': rid,
          'X-Agent-Purpose': 'conversation',
          'X-Conversation-Message-ID': rid,
          'X-Root-Request-ID': rid,
          Origin: 'https://www.workbuddy.ai',
          Referer: 'https://www.workbuddy.ai/',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        timeout: 15000,
      });
      if (r.status === 200) return true;
    } catch {
      /* 换下一个模型 */
    }
  }
  return false;
}
/* ================================================================== */
/* 模块五：外壳 —— 平台注册表 / 聚合接口 / 定时任务                     */
/* ================================================================== */

/* ---------------- 绑定适配 ---------------- */

/** 把共享 KV 包装成带前缀的视图，各平台互不越界 */
function kvScope(kv, prefix) {
  const strip = (keys) => (keys || []).map((x) => ({ ...x, name: String(x.name).slice(prefix.length) }));
  return {
    async get(k, o) {
      return kv.get(prefix + k, o);
    },
    async put(k, v, o) {
      return kv.put(prefix + k, v, o);
    },
    async delete(k) {
      return kv.delete(prefix + k);
    },
    async list(o = {}) {
      const r = await kv.list({ ...o, prefix: prefix + (o.prefix || '') });
      return { ...r, keys: strip(r.keys) };
    },
  };
}

/** 没绑 KV 时给出一个会说话的桩，而不是 undefined 引发的 TypeError */
function missingKV(hint) {
  const boom = () => {
    throw new Error(hint);
  };
  return { get: boom, put: boom, delete: boom, list: boom };
}

function kvFor(env, prefix) {
  if (env.KV) return kvScope(env.KV, prefix);
  return missingKV('未绑定 KV：请给 Worker 添加一个 KV 命名空间，变量名填 KV');
}

function traeEnv(env) {
  return {
    TRAE_KV: kvFor(env, 'trae:'),
    TRAE_MASTER_KEY: env.MASTER_KEY,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    CRON_SECRET: env.CRON_SECRET,
  };
}

function wbEnv(env) {
  return {
    WB_KV: kvFor(env, 'wb:'),
    WB_MASTER_KEY: env.MASTER_KEY,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    CRON_SECRET: env.CRON_SECRET,
  };
}

function platformEnv(env, prefix) {
  return {
    PLATFORM_KV: kvFor(env, prefix),
    PLATFORM_MASTER_KEY: env.MASTER_KEY,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    CRON_SECRET: env.CRON_SECRET,
    CHATGLM_SIGN_SECRET: env.CHATGLM_SIGN_SECRET,
    ZHIPU_SIGN_SECRET: env.ZHIPU_SIGN_SECRET,
  };
}

/* ---------------- 平台注册表 ---------------- */

const TRAE_META = {
  key: 'trae',
  label: 'Trae',
  accent: 'purple',
  verified: true,
  verifiedNote: '扫码授权与签到接口已实测',
  addMode: 'qr',
  defaultHost: 'api.trae.cn',
  supportsRefresh: true,
  fields: [],
  hint: '点「添加账号」打开官方授权页，用抖音扫码。',
  note: 'Trae 只认 127.0.0.1 回调，扫码完成后需要把打不开的本地地址粘回控制台。',
};

const WB_META = {
  key: 'workbuddy',
  label: 'WorkBuddy',
  accent: 'blue',
  verified: true,
  verifiedNote: '扫码授权与签到接口已实测',
  addMode: 'qr',
  defaultHost: 'copilot.tencent.com',
  supportsRefresh: true,
  fields: [],
  hint: '点「添加账号」打开官方登录页，用微信扫码。',
  note: '二维码由官方页面渲染，本服务不接触你的微信信息。',
};

const PLATFORMS = [
  { key: 'trae', meta: TRAE_META, mod: Trae, env: traeEnv, prefix: 'trae:' },
  { key: 'workbuddy', meta: WB_META, mod: WorkBuddy, env: wbEnv, prefix: 'wb:' },
  { key: 'workbuddy_intl', meta: WorkBuddyIntl.meta, mod: WorkBuddyIntl, env: (env) => platformEnv(env, 'wbi:'), prefix: 'wbi:' },
  { key: 'zhipu', meta: Zhipu.meta, mod: Zhipu, env: (env) => platformEnv(env, 'zhipu:'), prefix: 'zhipu:' },
  { key: 'loomy', meta: Loomy.meta, mod: Loomy, env: (env) => platformEnv(env, 'loomy:'), prefix: 'loomy:' },
  { key: 'astudio', meta: AStudio.meta, mod: AStudio, env: (env) => platformEnv(env, 'astudio:'), prefix: 'astudio:' },
];

const PLATFORM_MAP = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));
/* 路径别名：/wb 是旧版 WorkBuddy 路径，/wbi 是国际版短前缀 */
const NS_MAP = {
  trae: PLATFORM_MAP.trae,
  wb: PLATFORM_MAP.workbuddy,
  workbuddy: PLATFORM_MAP.workbuddy,
  wbi: PLATFORM_MAP.workbuddy_intl,
  workbuddy_intl: PLATFORM_MAP.workbuddy_intl,
  zhipu: PLATFORM_MAP.zhipu,
  loomy: PLATFORM_MAP.loomy,
  astudio: PLATFORM_MAP.astudio,
};

const ENV_FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * meta.verified 是写死的静态标记，部署方实机跑通用后可以覆盖：
 * 环境变量 <平台键大写>_VERIFIED，填 true / 1 / yes 视为已验证，填 false / 0 / no / off 视为未验证。
 * 例如 ZHIPU_VERIFIED=true。未设置时沿用代码里的静态值。
 */
function verifiedFlag(entry, env) {
  const raw = String(env[`${entry.key.toUpperCase()}_VERIFIED`] || '').trim().toLowerCase();
  if (!raw) return !!entry.meta.verified;
  return !ENV_FALSY.has(raw);
}

function metaOf(entry, env) {
  const m = entry.meta;
  const verified = verifiedFlag(entry, env);
  return {
    key: m.key,
    label: m.label,
    accent: m.accent,
    verified,
    verifiedNote: verified ? '' : (m.verifiedNote || ''),
    addMode: m.addMode || 'token',
    defaultHost: m.defaultHost || '',
    supportsRefresh: m.supportsRefresh !== false,
    fields: m.fields || [],
    hint: m.hint || '',
    note: m.note || '',
    available: true,
    unavailableReason: '',
  };
}

const CRON_KEY = 'meta:crons';

function parseCronField(text, min, max, isDow) {
  const set = new Set();
  const raw = String(text || '').trim();
  if (!raw) return null;
  for (const part of raw.split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw == null || stepRaw === '' ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let start;
    let end;
    if (rangeRaw === '*' || rangeRaw === '?') {
      start = min;
      end = max;
    } else if (rangeRaw.includes('-')) {
      const bits = rangeRaw.split('-');
      if (bits.length !== 2) return null;
      start = Number(bits[0]);
      end = Number(bits[1]);
    } else {
      const v = Number(rangeRaw);
      if (!Number.isInteger(v)) return null;
      start = v;
      end = v;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) set.add(v);
  }
  if (isDow && set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  return set.size ? set : null;
}

/** 计算 5 段 cron 的下一次触发时间（UTC），支持数字/范围/列表/步长 */
function nextCronTime(cron, nowMs) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const mins = parseCronField(parts[0], 0, 59, false);
  const hours = parseCronField(parts[1], 0, 23, false);
  const doms = parseCronField(parts[2], 1, 31, false);
  const months = parseCronField(parts[3], 1, 12, false);
  const dows = parseCronField(parts[4], 0, 7, true);
  if (!mins || !hours || !doms || !months || !dows) return null;

  const domRestricted = parts[2] !== '*' && parts[2] !== '?';
  const dowRestricted = parts[4] !== '*' && parts[4] !== '?';
  const start = Math.floor(nowMs / 60000) * 60000 + 60000;
  const startDate = new Date(start);
  const startDay = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const minutes = Array.from(mins).sort((a, b) => a - b);
  const hoursSorted = Array.from(hours).sort((a, b) => a - b);

  for (let d = 0; d <= 370; d++) {
    const day = new Date(startDay + d * 86400000);
    if (!months.has(day.getUTCMonth() + 1)) continue;
    const dom = day.getUTCDate();
    const dow = day.getUTCDay();
    const dayMatch = domRestricted && dowRestricted
      ? (doms.has(dom) || dows.has(dow))
      : (doms.has(dom) && dows.has(dow));
    if (!dayMatch) continue;
    for (const h of hoursSorted) {
      for (const m of minutes) {
        const t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), dom, h, m, 0);
        if (t >= start) return t;
      }
    }
  }
  return null;
}

async function readCrons(env) {
  if (!env.KV) return [];
  try {
    const raw = await env.KV.get(CRON_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((x) => typeof x === 'string' && x.trim()).slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

async function rememberCron(env, cron) {
  if (!env.KV) return;
  const text = String(cron || '').trim();
  if (!text) return;
  const list = await readCrons(env);
  if (!list.includes(text)) {
    list.push(text);
    await env.KV.put(CRON_KEY, JSON.stringify(list.slice(-10)));
  }
}

function cronInfo(env, crons) {
  const list = Array.isArray(crons) ? crons : [];
  if (list.length) {
    const now = Date.now();
    let best = null;
    for (const c of list) {
      const t = nextCronTime(c, now);
      if (t && (!best || t < best.t)) best = { t, c };
    }
    return {
      text: list.join(' / '),
      next: best ? SH.fmtBjShort(best.t) : '—',
      source: 'auto',
      crons: list,
    };
  }
  const text = String(env.CHECKIN_CRON || '08:10').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  const hour = m ? Math.min(23, Math.max(0, Number(m[1]))) : 8;
  const minute = m ? Math.min(59, Math.max(0, Number(m[2]))) : 10;
  return {
    text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    next: SH.nextRunBj(hour, minute),
    source: 'env',
    crons: [],
  };
}

/* ---------------- 通用响应与鉴权 ---------------- */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function requireAdmin(request, env) {
  const url = new URL(request.url);
  const given =
    request.headers.get('X-Admin-Token') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('token');
  if (!env.ADMIN_TOKEN) return { ok: false, res: jsonResponse({ error: '未配置 ADMIN_TOKEN' }, 500) };
  if (!SH.timingSafeEqual(given, env.ADMIN_TOKEN)) {
    return { ok: false, res: jsonResponse({ error: '登录密码不正确' }, 401) };
  }
  return { ok: true };
}

function requireCron(request, env) {
  const secret = env.CRON_SECRET || env.ADMIN_TOKEN;
  const url = new URL(request.url);
  const given = request.headers.get('X-Cron-Secret') || url.searchParams.get('key');
  if (!secret) return { ok: false, res: jsonResponse({ error: '未配置 CRON_SECRET / ADMIN_TOKEN' }, 500) };
  if (!SH.timingSafeEqual(given, secret)) return { ok: false, res: jsonResponse({ error: '口令不对' }, 401) };
  return { ok: true };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/* ---------------- 运行历史 ---------------- */

const HISTORY_KEY = 'history:runs';
const HISTORY_MAX = 300;

async function readHistory(env, limit = 200) {
  if (!env.KV) return [];
  try {
    const raw = await env.KV.get(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, limit) : [];
  } catch {
    return [];
  }
}

async function recordHistory(env, platform, results, action) {
  if (!env.KV || !Array.isArray(results) || !results.length) return;
  const at = SH.fmtBj(Date.now());
  const entries = results
    .filter((r) => r && r.state !== 'disabled')
    .map((r) => ({
      at,
      platform,
      id: r.id || '',
      label: r.label || '',
      state: r.state || 'error',
      msg: r.msg || '',
      credit: typeof r.credit === 'number' ? r.credit : (typeof r.points === 'number' ? r.points : null),
      action,
    }));
  if (!entries.length) return;
  const old = await readHistory(env, HISTORY_MAX);
  const next = entries.concat(old).slice(0, HISTORY_MAX);
  await env.KV.put(HISTORY_KEY, JSON.stringify(next));
}

/* ---------------- 平台聚合 ---------------- */

async function listPlatform(entry, env) {
  const data = await entry.mod.list(entry.env(env));
  const verified = verifiedFlag(entry, env);
  return (data.accounts || []).map((a) => ({
    ...a,
    platform: entry.key,
    platformLabel: entry.meta.label,
    accent: entry.meta.accent,
    verified,
    addMode: entry.meta.addMode || 'token',
    supportsRefresh: entry.meta.supportsRefresh !== false,
    metaNote: entry.meta.note || (verified ? '' : entry.meta.verifiedNote) || '',
  }));
}

async function overview(env) {
  const errors = [];
  const groups = await Promise.all(
    PLATFORMS.map(async (entry) => {
      try {
        return await listPlatform(entry, env);
      } catch (e) {
        errors.push({ platform: entry.key, error: e.message });
        return [];
      }
    })
  );
  const accounts = groups.flat();
  const enabled = accounts.filter((a) => a.enabled !== false);
  const signed = enabled.filter((a) => a.signedToday);
  const todayCredit = signed.reduce((sum, a) => sum + (typeof a.lastCredit === 'number' ? a.lastCredit : 0), 0);
  const totalSigned = accounts.reduce((sum, a) => sum + (Number(a.totalSigned) || 0), 0);
  const counts = {};
  for (const entry of PLATFORMS) counts[entry.key] = accounts.filter((a) => a.platform === entry.key).length;

  const crons = await readCrons(env);
  const cron = cronInfo(env, crons);
  return {
    at: SH.fmtBj(Date.now()),
    today: SH.bjDay(),
    cron: cron.text,
    nextRun: cron.next,
    cronSource: cron.source,
    crons: cron.crons,
    stats: {
      total: accounts.length,
      enabled: enabled.length,
      signed: signed.length,
      todayCredit: Math.round(todayCredit * 100) / 100,
      totalSigned,
      noActivity: accounts.filter((a) => a.lastState === 'no_activity').length,
    },
    platformCounts: counts,
    platforms: PLATFORMS.map((p) => metaOf(p, env)),
    accounts,
    errors,
  };
}

async function runPlatform(entry, env, { force = false, id = '', action = 'run' } = {}) {
  try {
    const summary = await entry.mod.run(entry.env(env), { force, id });
    try {
      await recordHistory(env, entry.key, summary.results || [], action);
    } catch {
      /* 历史写入失败不影响签到结论 */
    }
    return { platform: entry.key, ...summary };
  } catch (e) {
    return { platform: entry.key, error: e.message, results: [] };
  }
}

async function runAll(env, { force = false, action = 'cron' } = {}) {
  const out = { at: SH.fmtBj(Date.now()) };
  for (const entry of PLATFORMS) {
    out[entry.key] = await runPlatform(entry, env, { force, action });
    // 兼容旧版 /cron 响应里的 wb 键
    if (entry.key === 'workbuddy') out.wb = out[entry.key];
  }
  return out;
}

async function refreshPlatform(entry, env, id) {
  const account = await entry.mod.refresh(entry.env(env), id);
  return { platform: entry.key, account };
}

async function refreshAll(env) {
  const results = [];
  for (const entry of PLATFORMS) {
    let accounts = [];
    try {
      accounts = (await entry.mod.list(entry.env(env))).accounts || [];
    } catch (e) {
      results.push({ platform: entry.key, ok: false, error: e.message });
      continue;
    }
    for (const a of accounts) {
      if (a.enabled === false) continue;
      try {
        const account = await entry.mod.refresh(entry.env(env), a.id);
        results.push({ platform: entry.key, id: a.id, label: a.label, ok: true, account });
      } catch (e) {
        results.push({ platform: entry.key, id: a.id, label: a.label, ok: false, error: e.message });
      }
    }
  }
  return { at: SH.fmtBj(Date.now()), results };
}

/* ---------------- 管理接口分发 ---------------- */

function platformOf(body) {
  const key = String((body && body.platform) || '').trim();
  return PLATFORM_MAP[key] || null;
}

async function handleAddAccount(request, env) {
  const body = await readBody(request);
  const entry = platformOf(body);
  if (!entry) return jsonResponse({ error: '未知平台' }, 400);
  if (entry.key === 'trae' || entry.key === 'workbuddy') {
    return jsonResponse({ error: `${entry.meta.label} 请用扫码方式添加` }, 400);
  }
  if (!entry.mod.add) return jsonResponse({ error: '该平台不支持粘贴凭证添加' }, 400);
  try {
    const res = await entry.mod.add(entry.env(env), body);
    return jsonResponse({ ok: true, platform: entry.key, ...res });
  } catch (e) {
    return jsonResponse({ error: e.message || String(e) }, 400);
  }
}

async function handleRemoveAccount(request, env) {
  const body = await readBody(request);
  const entry = platformOf(body);
  const id = String(body.id || '').trim();
  if (!entry) return jsonResponse({ error: '未知平台' }, 400);
  if (!id) return jsonResponse({ error: '缺少 id' }, 400);
  try {
    return jsonResponse({ ok: true, ...(await entry.mod.remove(entry.env(env), id)) });
  } catch (e) {
    return jsonResponse({ error: e.message }, 404);
  }
}

async function handleRenameAccount(request, env) {
  const body = await readBody(request);
  const entry = platformOf(body);
  const id = String(body.id || '').trim();
  const label = String(body.label || '').trim().slice(0, 40);
  if (!entry) return jsonResponse({ error: '未知平台' }, 400);
  if (!id) return jsonResponse({ error: '缺少 id' }, 400);
  if (!label) return jsonResponse({ error: '备注不能为空' }, 400);
  try {
    return jsonResponse({ ok: true, ...(await entry.mod.rename(entry.env(env), id, label)) });
  } catch (e) {
    return jsonResponse({ error: e.message }, 404);
  }
}

async function handleEnableAccount(request, env) {
  const body = await readBody(request);
  const entry = platformOf(body);
  const id = String(body.id || '').trim();
  if (!entry) return jsonResponse({ error: '未知平台' }, 400);
  if (!id) return jsonResponse({ error: '缺少 id' }, 400);
  try {
    return jsonResponse({ ok: true, ...(await entry.mod.setEnabled(entry.env(env), id, body.enabled !== false)) });
  } catch (e) {
    return jsonResponse({ error: e.message }, 404);
  }
}

async function handleRefreshAccount(request, env) {
  const body = await readBody(request);
  const entry = platformOf(body);
  const id = String(body.id || '').trim();
  if (!entry) return jsonResponse({ error: '未知平台' }, 400);
  if (!id) return jsonResponse({ error: '缺少 id' }, 400);
  try {
    return jsonResponse({ ok: true, ...(await refreshPlatform(entry, env, id)) });
  } catch (e) {
    return jsonResponse({ error: e.message }, 502);
  }
}

/** 子模块只认 request.url 上的 path，这里按前缀改写后转发 */
function repath(request, path) {
  const u = new URL(request.url);
  u.pathname = path || '/';
  return new Request(u.toString(), request);
}

/* ================================================================== */
/* 入口                                                                */
/* ================================================================== */

const __worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    try {
      if (path === '/' || path === '/index.html') return htmlResponse(PAGE);

      if (path === '/cron') {
        const c = requireCron(request, env);
        if (!c.ok) return c.res;
        return jsonResponse(await runAll(env, { force: false, action: 'cron' }));
      }

      // Trae 的授权链接里回调地址写死为 <origin>/oauth/callback，必须留在根路径
      if (path === '/oauth/callback' && method === 'GET') return await Trae.fetch(request, traeEnv(env), ctx);
      if (path === '/oauth/probe' && (method === 'GET' || method === 'HEAD')) {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
      }

      // 平台命名空间：/trae/api/*、/wb/api/*、/wbi/api/* …
      const ns = path.split('/')[1];
      if (NS_MAP[ns] && path.startsWith('/' + ns + '/')) {
        const entry = NS_MAP[ns];
        return await entry.mod.fetch(repath(request, path.slice(ns.length + 1) || '/'), entry.env(env), ctx);
      }
      if (path === '/trae' || path === '/wb' || path === '/wbi' || path === '/zhipu' || path === '/loomy' || path === '/astudio') {
        return Response.redirect(url.origin + '/', 302);
      }

      if (!path.startsWith('/api/')) return jsonResponse({ error: 'not found' }, 404);

      const a = requireAdmin(request, env);
      if (!a.ok) return a.res;

      if (path === '/api/ping' && method === 'GET') return jsonResponse({ ok: true });

      if (path === '/api/meta' && method === 'GET') {
        const crons = await readCrons(env);
        const cron = cronInfo(env, crons);
        return jsonResponse({
          platforms: PLATFORMS.map((p) => metaOf(p, env)),
          cron: cron.text,
          nextRun: cron.next,
          cronSource: cron.source,
          crons: cron.crons,
        });
      }

      if (path === '/api/overview' && method === 'GET') return jsonResponse(await overview(env));

      if (path === '/api/history' && method === 'GET') {
        const limit = Math.max(1, Math.min(300, Number(url.searchParams.get('limit')) || 200));
        const entries = await readHistory(env, limit);
        return jsonResponse({ count: entries.length, entries });
      }

      if (path === '/api/history/clear' && method === 'POST') {
        if (env.KV) await env.KV.put(HISTORY_KEY, '[]');
        return jsonResponse({ ok: true });
      }

      if (path === '/api/run-all' && method === 'POST') {
        const body = await readBody(request);
        const force = url.searchParams.get('force') === '1' || body.force === true;
        return jsonResponse(await runAll(env, { force, action: 'run' }));
      }

      if (path === '/api/platforms/run' && method === 'POST') {
        const body = await readBody(request);
        const entry = platformOf(body);
        if (!entry) return jsonResponse({ error: '未知平台' }, 400);
        const force = url.searchParams.get('force') === '1' || body.force === true;
        return jsonResponse(await runPlatform(entry, env, { force, id: String(body.id || '').trim(), action: 'run' }));
      }

      if (path === '/api/accounts/sign' && method === 'POST') {
        const body = await readBody(request);
        const entry = platformOf(body);
        if (!entry) return jsonResponse({ error: '未知平台' }, 400);
        const force = url.searchParams.get('force') === '1' || body.force === true;
        return jsonResponse(await runPlatform(entry, env, { force, id: String(body.id || '').trim(), action: 'sign' }));
      }

      if (path === '/api/accounts/add' && method === 'POST') return handleAddAccount(request, env);
      if (path === '/api/accounts/remove' && method === 'POST') return handleRemoveAccount(request, env);
      if (path === '/api/accounts/rename' && method === 'POST') return handleRenameAccount(request, env);
      if (path === '/api/accounts/enable' && method === 'POST') return handleEnableAccount(request, env);
      if (path === '/api/accounts/refresh' && method === 'POST') return handleRefreshAccount(request, env);
      if (path === '/api/refresh-all' && method === 'POST') return jsonResponse(await refreshAll(env));

      return jsonResponse({ error: 'not found' }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message || String(e) }, 500);
    }
  },

  /** Cloudflare Cron Trigger：所有平台依次签到，互不影响 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await rememberCron(env, event && event.cron);
        } catch {
          /* cron 记录失败不影响签到 */
        }
        await runAll(env, { force: false, action: 'cron' });
      })().catch(() => {})
    );
  },
};
/* ================================================================== */
/* 模块六：控制台页面                                                   */
/*                                                                     */
/* 视觉参考「签到台」：黑白灰 + 单一强调色，用排版和 1px 分割线建立     */
/* 层次；平台用色条/标签区分，账号用首字头像区分。                      */
/* ================================================================== */

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f6f7f5" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#0c0e0f" media="(prefers-color-scheme:dark)">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='5' fill='%2314171a'/%3E%3Cpath d='M17 33.2 L27.4 43.4 L46.5 21.6' fill='none' stroke='%23f6f7f5' stroke-width='6.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<title>签到台 · 每日签到登记簿</title>
<style>
/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */
@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-translate-x:0;--tw-translate-y:0;--tw-translate-z:0;--tw-space-y-reverse:0;--tw-border-style:solid;--tw-leading:initial;--tw-font-weight:initial;--tw-blur:initial;--tw-brightness:initial;--tw-contrast:initial;--tw-grayscale:initial;--tw-hue-rotate:initial;--tw-invert:initial;--tw-opacity:initial;--tw-saturate:initial;--tw-sepia:initial;--tw-drop-shadow:initial;--tw-drop-shadow-color:initial;--tw-drop-shadow-alpha:100%;--tw-drop-shadow-size:initial;--tw-duration:initial;--tw-tracking:initial}}}@layer theme{:root,:host{--font-sans:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--font-mono:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--spacing:.25rem;--font-weight-normal:400;--font-weight-medium:500;--font-weight-semibold:600;--font-weight-bold:700;--tracking-tight:-.025em;--leading-relaxed:1.625;--default-transition-duration:.15s;--default-transition-timing-function:cubic-bezier(.4, 0, .2, 1);--default-font-family:var(--font-sans);--default-mono-font-family:var(--font-mono);--font-display:ui-serif, Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif;--font-body:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;--font-num:ui-monospace, "Cascadia Mono", "SF Mono", Consolas, "Liberation Mono", monospace;--radius-card:3px;--radius-pill:999px}}@layer base{*,:after,:before,::backdrop{box-sizing:border-box;border:0 solid;margin:0;padding:0}::file-selector-button{box-sizing:border-box;border:0 solid;margin:0;padding:0}html,:host{-webkit-text-size-adjust:100%;tab-size:4;line-height:1.5;font-family:var(--default-font-family,-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");font-feature-settings:var(--default-font-feature-settings,normal);font-variation-settings:var(--default-font-variation-settings,normal);-webkit-tap-highlight-color:transparent}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,samp,pre{font-family:var(--default-mono-font-family,ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);font-feature-settings:var(--default-mono-font-feature-settings,normal);font-variation-settings:var(--default-mono-font-variation-settings,normal);font-size:1em}small{font-size:80%}sub,sup{vertical-align:baseline;font-size:75%;line-height:0;position:relative}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}:-moz-focusring:where(:not(iframe)){outline:auto}progress{vertical-align:baseline}summary{display:list-item}ol,ul,menu{list-style:none}img,svg,video,canvas,audio,iframe,embed,object{vertical-align:middle;display:block}img,video{max-width:100%;height:auto}button,input,select,optgroup,textarea{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}::file-selector-button{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}:where(select:is([multiple],[size])) optgroup{font-weight:bolder}:where(select:is([multiple],[size])) optgroup option{padding-inline-start:20px}::file-selector-button{margin-inline-end:4px}::placeholder{opacity:1}@supports (not ((-webkit-appearance:-apple-pay-button))) or (contain-intrinsic-size:1px){::placeholder{color:currentColor}@supports (color:color-mix(in lab, red, red)){::placeholder{color:color-mix(in oklab, currentcolor 50%, transparent)}}}textarea{resize:vertical}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-date-and-time-value{min-height:1lh;text-align:inherit}::-webkit-datetime-edit{display:inline-flex}::-webkit-datetime-edit-fields-wrapper{padding:0}::-webkit-datetime-edit{padding-block:0}::-webkit-datetime-edit-year-field{padding-block:0}::-webkit-datetime-edit-month-field{padding-block:0}::-webkit-datetime-edit-day-field{padding-block:0}::-webkit-datetime-edit-hour-field{padding-block:0}::-webkit-datetime-edit-minute-field{padding-block:0}::-webkit-datetime-edit-second-field{padding-block:0}::-webkit-datetime-edit-millisecond-field{padding-block:0}::-webkit-datetime-edit-meridiem-field{padding-block:0}::-webkit-calendar-picker-indicator{line-height:1}:-moz-ui-invalid{box-shadow:none}button,input:where([type=button],[type=reset],[type=submit]){appearance:button}::file-selector-button{appearance:button}::-webkit-inner-spin-button{height:auto}::-webkit-outer-spin-button{height:auto}[hidden]:where(:not([hidden=until-found])){display:none!important}html{background:var(--c-paper)}body{background-color:var(--c-paper);color:var(--c-ink);font-family:var(--font-body);-webkit-font-smoothing:antialiased;font-size:14px}::selection{background:var(--c-ink);color:var(--c-paper)}:focus-visible{outline:2px solid var(--c-focus);outline-offset:2px}input,button,select,textarea{font:inherit;color:inherit}code{white-space:nowrap;color:var(--c-ink);font-family:var(--font-num);background:var(--c-panel2);border:1px solid var(--c-rule);border-radius:2px;padding:0 3px;font-size:.92em}@media (prefers-reduced-motion:reduce){*{transition-duration:.001ms!important;animation-duration:.001ms!important}}}@layer components{.panel{display:none}.panel.active{display:block}.guide-panel{display:none}.guide-panel.active{display:block}.btn-ghost{height:calc(var(--spacing) * 8);align-items:center;gap:calc(var(--spacing) * 1.5);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule2);background-color:var(--c-panel);padding-inline:calc(var(--spacing) * 3);color:var(--c-ink2);border-radius:var(--radius-card);font-size:12.5px;transition:background-color .12s,border-color .12s,color .12s;display:inline-flex}.btn-ghost:hover:not(:disabled){border-color:var(--c-ink);color:var(--c-ink)}.btn-ghost:disabled{cursor:not-allowed;color:var(--c-ink4)}.btn-primary{height:calc(var(--spacing) * 8);align-items:center;gap:calc(var(--spacing) * 1.5);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-ink);background-color:var(--c-ink);padding-inline:calc(var(--spacing) * 3.5);color:var(--c-paper);border-radius:var(--radius-card);font-size:12.5px;font-weight:600;transition:opacity .12s,transform 60ms;display:inline-flex}.btn-primary:hover:not(:disabled){opacity:.85}.btn-primary:active:not(:disabled){transform:translateY(1px)}.btn-primary:disabled{border-color:var(--c-rule);background-color:var(--c-panel2);color:var(--c-ink4);font-weight:400}.btn-sm{height:calc(var(--spacing) * 7);padding-inline:calc(var(--spacing) * 2.5);font-size:12px}.btn-danger{border-color:var(--c-failed);color:var(--c-failed);background-color:#0000}.btn-danger:hover:not(:disabled){border-color:var(--c-failed);background-color:var(--c-failed);color:var(--c-paper)}.field{height:calc(var(--spacing) * 9);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule2);background-color:var(--c-panel);width:100%;padding-inline:calc(var(--spacing) * 2.5);color:var(--c-ink)}.field::placeholder{color:var(--c-ink4)}.field{border-radius:var(--radius-card);font-size:13px}.field:focus{border-color:var(--c-ink);--tw-outline-style:none;outline-style:none}textarea.field{height:auto;padding-block:calc(var(--spacing) * 2);--tw-leading:var(--leading-relaxed);line-height:var(--leading-relaxed);font-family:var(--font-num);font-size:12px}.lb{margin-bottom:var(--spacing);--tw-font-weight:var(--font-weight-medium);font-size:12px;font-weight:var(--font-weight-medium);color:var(--c-ink2);display:block}.lb .hint{margin-left:calc(var(--spacing) * 1.5);--tw-font-weight:var(--font-weight-normal);font-weight:var(--font-weight-normal);color:var(--c-ink4)}.fields{gap:calc(var(--spacing) * 2.5);display:grid}.field-row{gap:var(--spacing);display:grid}.hint{--tw-leading:var(--leading-relaxed);font-size:12px;line-height:var(--leading-relaxed);color:var(--c-ink3)}.tip{--tw-leading:var(--leading-relaxed);font-size:12px;line-height:var(--leading-relaxed);color:var(--c-ink2);background:var(--c-panel2);border-left:2px solid var(--c-rule2);border-radius:0 var(--radius-card) var(--radius-card) 0;padding:8px 10px}.tip b{--tw-font-weight:var(--font-weight-semibold);font-weight:var(--font-weight-semibold);color:var(--c-ink)}.err{color:var(--c-failed);min-height:0;font-size:12px}.err:empty{display:none}.num{font-family:var(--font-num);font-variant-numeric:tabular-nums}.badge{align-items:center;gap:var(--spacing);height:19px;padding-inline:calc(var(--spacing) * 1.5);--tw-leading:1;white-space:nowrap;border:1px solid;border-radius:2px;font-size:11px;line-height:1;display:inline-flex}.badge:before{content:"";background:currentColor;border-radius:1px;width:4px;height:4px}.badge.nodot:before{display:none}.badge.ok{color:var(--c-signed);background:var(--c-signed-weak)}.badge.idle{color:var(--c-ink3);background:0 0}.badge.warn{color:var(--c-pending);background:var(--c-pending-weak)}.badge.err{color:var(--c-failed);background:var(--c-failed-weak)}.badge.off{color:var(--c-off);background:var(--c-off-weak)}.badge.none{color:var(--c-ink4);background:0 0;border-style:dashed}.stamp{height:20px;padding-inline:calc(var(--spacing) * 2);--tw-leading:1;--tw-font-weight:var(--font-weight-bold);font-size:12px;line-height:1;font-weight:var(--font-weight-bold);white-space:nowrap;font-family:var(--font-display);color:var(--c-signed);background:var(--c-signed);border:1.4px solid;border-radius:2px;align-items:center;display:inline-flex;position:relative}@supports (color:color-mix(in lab, red, red)){.stamp{background:color-mix(in oklab,var(--c-signed) 8%,var(--c-panel))}}.stamp{letter-spacing:.12em;transform:rotate(-2.5deg)}.stamp:after{content:"";border:1px solid var(--c-signed);border-radius:4px;position:absolute;inset:-3px}@supports (color:color-mix(in lab, red, red)){.stamp:after{border:1px solid color-mix(in oklab,var(--c-signed) 42%,transparent)}}.card{border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule);background-color:var(--c-panel);border-radius:var(--radius-card)}.sec-head{margin-bottom:calc(var(--spacing) * 2.5);justify-content:space-between;align-items:flex-end;gap:calc(var(--spacing) * 3);flex-wrap:wrap;display:flex}.sec-title{--tw-leading:1;color:var(--c-ink);font-family:ui-serif,Georgia,Songti SC,Noto Serif CJK SC,SimSun,serif;font-size:17px;line-height:1}.sec-title .auto-tip{margin-left:calc(var(--spacing) * 2);vertical-align:middle;--tw-font-weight:var(--font-weight-normal);font-family:system-ui,-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;font-size:11px;font-weight:var(--font-weight-normal);color:var(--c-ink4)}.sec-acts{align-items:center;gap:calc(var(--spacing) * 1.5);flex-wrap:wrap;display:flex}.act-div{margin-inline:calc(var(--spacing) * .5);height:calc(var(--spacing) * 4);background-color:var(--c-rule);width:1px}.empty{padding-block:calc(var(--spacing) * 10);text-align:center;color:var(--c-ink3);font-size:13px}.at-wrap{border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule);background-color:var(--c-panel);border-radius:var(--radius-card);overflow:hidden}.at{border-collapse:collapse;width:100%;font-size:13px}.at thead th{text-align:left;--tw-font-weight:var(--font-weight-medium);font-size:11px;font-weight:var(--font-weight-medium);white-space:nowrap;color:var(--c-ink3);border-bottom:1px solid var(--c-rule2);padding:0 10px 6px}.at thead th.num,.at thead th.act{text-align:right}.at tbody tr.ar{cursor:pointer;vertical-align:middle;border-bottom:1px solid var(--c-rule);border-left:2px solid var(--pc,transparent);transition:background-color .12s}.at tbody tr.ar:last-of-type{border-bottom:0}.at tbody tr.ar:hover{background:var(--c-panel2)}.at tbody tr.ar.open{background:var(--c-panel2);box-shadow:inset 3px 0 0 var(--c-ink)}.at tbody td{white-space:nowrap;text-overflow:ellipsis;padding:9px 10px;overflow:hidden}.at td.num,.at th.num{text-align:right}.at td.empty{text-align:center;white-space:normal}.at tbody tr.ar.st-off{border-left-color:var(--c-rule2);color:var(--c-ink4)}.at tbody tr.ar.st-off .avatar{opacity:.4}.at tbody tr.ar.st-off .plat-tag{color:var(--c-ink4)}.at tr.ar-detail{display:none}.at tr.ar-detail>td{background:var(--c-panel2);border-left:2px solid var(--pc,transparent);white-space:normal;padding:0 10px;overflow:visible}.at tr.ar-detail.show{display:table-row}.at tr.ar-detail.show>td{padding:10px 12px 14px 14px}.at .cell-acct{align-items:center;gap:calc(var(--spacing) * 2.5);white-space:nowrap;min-width:0;display:flex}.at .nm2{text-overflow:ellipsis;white-space:nowrap;--tw-font-weight:var(--font-weight-medium);min-width:0;font-weight:var(--font-weight-medium);color:var(--c-ink);flex:1;overflow:hidden}.at .col-act{justify-content:flex-end;align-items:center;gap:calc(var(--spacing) * 1.5);display:flex}.at .chev2{width:calc(var(--spacing) * 3);--tw-leading:1;color:var(--c-ink4);-webkit-user-select:none;user-select:none;font-size:15px;line-height:1}.at tr.ar.open .chev2{transform:rotate(90deg)}.at th:first-child{width:30%}.at th:nth-child(2){width:12%}.at th:nth-child(3){width:10%}.at th:nth-child(4){width:9%}.at th:nth-child(5),.at th:nth-child(6),.at th:nth-child(7){width:13%}.at .v-cred{--tw-font-weight:var(--font-weight-semibold);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-size:13px;font-weight:var(--font-weight-semibold);color:var(--c-ink)}.at .v-up{--tw-font-weight:var(--font-weight-semibold);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-weight:var(--font-weight-semibold);color:var(--c-signed)}.at .v-day{color:var(--c-ink3);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace}.at .v-date{color:var(--c-ink3);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-size:12.5px}.at .v-none{color:var(--c-ink4)}.at .v-warn{color:var(--c-pending);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-size:12.5px}.at .v-bad{color:var(--c-failed);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-size:12.5px}.at .btn-sign{height:calc(var(--spacing) * 7);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule2);padding-inline:calc(var(--spacing) * 2.5);color:var(--c-ink2);border-radius:var(--radius-card);background-color:#0000;align-items:center;font-size:12px;transition:background-color .12s,color .12s,border-color .12s;display:inline-flex}.at .btn-sign:hover:not(:disabled){border-color:var(--c-ink);background-color:var(--c-ink);color:var(--c-paper)}.at .btn-sign:disabled{cursor:not-allowed;border-color:var(--c-rule);color:var(--c-ink4)}.p-purple{--pc:var(--a-purple);--pbg:var(--a-purple)}@supports (color:color-mix(in lab, red, red)){.p-purple{--pbg:color-mix(in srgb, var(--a-purple) 11%, transparent)}}.p-purple{--pbd:var(--a-purple)}@supports (color:color-mix(in lab, red, red)){.p-purple{--pbd:color-mix(in srgb, var(--a-purple) 34%, transparent)}}.p-blue{--pc:var(--a-blue);--pbg:var(--a-blue)}@supports (color:color-mix(in lab, red, red)){.p-blue{--pbg:color-mix(in srgb, var(--a-blue) 11%, transparent)}}.p-blue{--pbd:var(--a-blue)}@supports (color:color-mix(in lab, red, red)){.p-blue{--pbd:color-mix(in srgb, var(--a-blue) 34%, transparent)}}.p-green{--pc:var(--a-green);--pbg:var(--a-green)}@supports (color:color-mix(in lab, red, red)){.p-green{--pbg:color-mix(in srgb, var(--a-green) 11%, transparent)}}.p-green{--pbd:var(--a-green)}@supports (color:color-mix(in lab, red, red)){.p-green{--pbd:color-mix(in srgb, var(--a-green) 34%, transparent)}}.p-amber{--pc:var(--a-amber);--pbg:var(--a-amber)}@supports (color:color-mix(in lab, red, red)){.p-amber{--pbg:color-mix(in srgb, var(--a-amber) 11%, transparent)}}.p-amber{--pbd:var(--a-amber)}@supports (color:color-mix(in lab, red, red)){.p-amber{--pbd:color-mix(in srgb, var(--a-amber) 34%, transparent)}}.p-cyan{--pc:var(--a-cyan);--pbg:var(--a-cyan)}@supports (color:color-mix(in lab, red, red)){.p-cyan{--pbg:color-mix(in srgb, var(--a-cyan) 11%, transparent)}}.p-cyan{--pbd:var(--a-cyan)}@supports (color:color-mix(in lab, red, red)){.p-cyan{--pbd:color-mix(in srgb, var(--a-cyan) 34%, transparent)}}.p-rose{--pc:var(--a-rose);--pbg:var(--a-rose)}@supports (color:color-mix(in lab, red, red)){.p-rose{--pbg:color-mix(in srgb, var(--a-rose) 11%, transparent)}}.p-rose{--pbd:var(--a-rose)}@supports (color:color-mix(in lab, red, red)){.p-rose{--pbd:color-mix(in srgb, var(--a-rose) 34%, transparent)}}.p-gray{--pc:var(--a-gray);--pbg:var(--a-gray)}@supports (color:color-mix(in lab, red, red)){.p-gray{--pbg:color-mix(in srgb, var(--a-gray) 11%, transparent)}}.p-gray{--pbd:var(--a-gray)}@supports (color:color-mix(in lab, red, red)){.p-gray{--pbd:color-mix(in srgb, var(--a-gray) 34%, transparent)}}.st-off{--pc:var(--c-rule2)}.plat-tag{height:18px;padding-inline:calc(var(--spacing) * 1.5);white-space:nowrap;color:var(--pc,var(--c-ink2));border:1px solid var(--pbd,var(--c-rule));background:var(--pbg,transparent);border-radius:2px;align-items:center;font-size:11px;display:inline-flex}.avatar{-webkit-user-select:none;user-select:none;border:1px solid var(--pbd,var(--c-rule2));background:var(--pbg,var(--c-panel2));width:27px;height:27px;color:var(--pc,var(--c-ink2));font-family:var(--font-display);border-radius:2px;flex-shrink:0;place-items:center;font-size:13px;line-height:1;display:inline-grid;position:relative}.avatar .dot{background:var(--pc,var(--c-rule2));width:7px;height:7px;box-shadow:0 0 0 2px var(--c-panel);border-radius:3.40282e38px;position:absolute;bottom:-3px;right:-3px}.switch{cursor:pointer;flex-shrink:0;align-items:center;display:inline-flex}.switch input{clip-path:inset(50%);white-space:nowrap;border-width:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.switch .track{width:30px;height:16px;transition-property:color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--default-transition-duration));background:var(--c-rule2);border-radius:var(--radius-pill);transition-duration:.15s;display:inline-block;position:relative}.switch .track:after{content:"";background:var(--c-panel);border-radius:50%;width:12px;height:12px;transition:transform .15s;position:absolute;top:2px;left:2px;box-shadow:0 1px 2px #00000040}.switch input:checked+.track{background:var(--c-ink)}.switch input:checked+.track:after{transform:translate(14px)}.switch input:disabled+.track{opacity:.4}.sec-mini{margin-bottom:calc(var(--spacing) * 1.5);color:var(--c-ink3);font-size:11px}.acct-sec{margin-top:calc(var(--spacing) * 2.5);padding-top:calc(var(--spacing) * 2.5);border-top:1px dashed var(--c-rule2)}.qa{margin-bottom:calc(var(--spacing) * 2);align-items:center;gap:calc(var(--spacing) * 1.5);flex-wrap:wrap;display:flex}.qbtn{height:calc(var(--spacing) * 7);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule2);background-color:var(--c-panel);padding-inline:calc(var(--spacing) * 2.5);color:var(--c-ink2);border-radius:var(--radius-card);align-items:center;font-size:12px;transition:border-color .12s,color .12s,background-color .12s;display:inline-flex}.qbtn:hover:not(:disabled){border-color:var(--c-ink);color:var(--c-ink)}.qbtn:disabled{cursor:not-allowed;color:var(--c-ink4)}.qbtn.danger{color:var(--c-failed);border-color:var(--c-failed)}@supports (color:color-mix(in lab, red, red)){.qbtn.danger{border-color:color-mix(in srgb, var(--c-failed) 40%, transparent)}}.qbtn.danger:hover:not(:disabled){background-color:var(--c-failed);color:var(--c-paper)}.qa-tip{text-align:right;color:var(--c-ink4);margin-left:auto;font-size:11px}.acct-hint{margin-bottom:calc(var(--spacing) * 2);--tw-leading:var(--leading-relaxed);font-size:12.5px;line-height:var(--leading-relaxed);color:var(--c-ink2)}.task-list{max-height:210px}:where(.task-list>:not(:last-child)){--tw-space-y-reverse:0;margin-block-start:calc(var(--spacing) * var(--tw-space-y-reverse));margin-block-end:calc(var(--spacing) * calc(1 - var(--tw-space-y-reverse)))}.task-list{overflow:auto}.task{align-items:baseline;gap:calc(var(--spacing) * 2);color:var(--c-ink2);font-size:12px;font-family:var(--font-num);display:flex}.task .t-state{width:calc(var(--spacing) * 3);text-align:center;--tw-font-weight:var(--font-weight-semibold);font-weight:var(--font-weight-semibold);flex-shrink:0;display:inline-block}.task.ok .t-state{color:var(--c-signed)}.task.bad .t-state{color:var(--c-failed)}.task.warn .t-state{color:var(--c-pending)}.task.mut .t-state{color:var(--c-ink4)}.task b{--tw-font-weight:var(--font-weight-medium);font-weight:var(--font-weight-medium);color:var(--c-ink);flex-shrink:0}.task span{text-overflow:ellipsis;white-space:nowrap;color:var(--c-ink3);overflow:hidden}.run-empty{color:var(--c-ink4);font-size:12px}.inline-edit{height:calc(var(--spacing) * 7);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-ink);background-color:var(--c-panel);padding-inline:calc(var(--spacing) * 1.5);color:var(--c-ink);border-radius:2px;width:min(220px,60%);font-size:13px}.at.no-click tbody tr.ar{cursor:default}.at .t-ts{color:var(--c-ink3);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-size:12px}.at .t-name{text-overflow:ellipsis;white-space:nowrap;--tw-font-weight:var(--font-weight-medium);max-width:150px;font-weight:var(--font-weight-medium);color:var(--c-ink);overflow:hidden}.at .t-msg{text-overflow:ellipsis;white-space:nowrap;max-width:300px;color:var(--c-ink3);font-size:12px;overflow:hidden}.at .credit-cell{--tw-font-weight:var(--font-weight-semibold);font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-weight:var(--font-weight-semibold);color:var(--c-signed)}.at .credit-cell.none{--tw-font-weight:var(--font-weight-normal);font-weight:var(--font-weight-normal);color:var(--c-ink4)}.modal-mask{z-index:100;padding:calc(var(--spacing) * 4);justify-content:center;align-items:flex-start;display:none;position:fixed;inset:0}@media (min-width:40rem){.modal-mask{padding:calc(var(--spacing) * 8)}}.modal-mask{background:var(--c-ink)}@supports (color:color-mix(in lab, red, red)){.modal-mask{background:color-mix(in srgb, var(--c-ink) 42%, transparent)}}.modal-mask{overflow:auto}.modal-mask.show{display:flex}.modal{border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule2);background-color:var(--c-panel);border-radius:var(--radius-card);width:100%;max-width:560px;box-shadow:var(--shadow-pop);margin-block:auto}.modal.xl{max-width:760px}.modal-head{padding-inline:calc(var(--spacing) * 4);padding-block:calc(var(--spacing) * 3);border-bottom:1px solid var(--c-rule);justify-content:space-between;align-items:center;display:flex}.modal-head h3{font-family:ui-serif,Georgia,Songti SC,Noto Serif CJK SC,SimSun,serif;font-size:16px}.modal-x{height:calc(var(--spacing) * 7);width:calc(var(--spacing) * 7);color:var(--c-ink3);place-items:center;display:grid}@media (hover:hover){.modal-x:hover{color:var(--c-ink)}}.modal-x{cursor:pointer;background:0 0;border:0}.modal-body{max-height:70vh;padding-inline:calc(var(--spacing) * 4);padding-block:calc(var(--spacing) * 3.5);overflow:auto}.modal-foot{justify-content:flex-end;align-items:center;gap:calc(var(--spacing) * 2);padding-inline:calc(var(--spacing) * 4);padding-block:calc(var(--spacing) * 3);border-top:1px solid var(--c-rule);display:flex}.step{margin-bottom:calc(var(--spacing) * 4);gap:calc(var(--spacing) * 3);display:flex}.step:last-child{margin-bottom:0}.step-n{width:22px;height:22px;font-size:11px;font-family:var(--font-num);color:var(--c-ink2);border:1px solid var(--c-rule2);border-radius:50%;flex-shrink:0;place-items:center;display:grid}.step-b{flex:1;min-width:0}.step-t{margin-bottom:var(--spacing);--tw-font-weight:var(--font-weight-semibold);font-size:13.5px;font-weight:var(--font-weight-semibold);color:var(--c-ink)}.step-b p{margin-bottom:calc(var(--spacing) * 1.5);--tw-leading:var(--leading-relaxed);font-size:12.5px;line-height:var(--leading-relaxed);color:var(--c-ink2)}.step-b p:last-child{margin-bottom:0}.plat-card{cursor:pointer;align-items:center;gap:calc(var(--spacing) * 2.5);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule2);background-color:var(--c-panel);min-width:0;padding-inline:calc(var(--spacing) * 3);padding-block:calc(var(--spacing) * 2.5);border-radius:var(--radius-card);transition:border-color .12s,background-color .12s;display:flex}.plat-card:hover{border-color:var(--c-ink4)}.plat-card.on{border-color:var(--c-ink);background:var(--c-panel2);box-shadow:inset 2px 0 0 var(--pc,var(--c-ink))}.plat-card.off{cursor:not-allowed;opacity:.5}.plat-card .ic{width:26px;height:26px;color:var(--pc,var(--c-ink2));background:var(--pbg,transparent);border:1px solid var(--pbd,var(--c-rule));font-family:var(--font-display);border-radius:2px;flex-shrink:0;place-items:center;font-size:13px;line-height:1;display:grid}.plat-card .tt{text-overflow:ellipsis;white-space:nowrap;--tw-font-weight:var(--font-weight-semibold);font-size:13px;font-weight:var(--font-weight-semibold);color:var(--c-ink);overflow:hidden}.plat-card .dd{text-overflow:ellipsis;white-space:nowrap;color:var(--c-ink3);font-size:11px;overflow:hidden}.rs-card{border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule);background-color:var(--c-panel2);padding-inline:calc(var(--spacing) * 3);padding-block:calc(var(--spacing) * 3);border-radius:var(--radius-card)}.rs-h{margin-bottom:var(--spacing);--tw-font-weight:var(--font-weight-semibold);font-size:13px;font-weight:var(--font-weight-semibold);color:var(--c-ink)}.auth-status{margin-top:calc(var(--spacing) * 2);--tw-leading:var(--leading-relaxed);font-size:12px;line-height:var(--leading-relaxed);color:var(--c-ink2)}.auth-status a{color:var(--c-ink);text-decoration-line:underline}.divider{margin-block:calc(var(--spacing) * 3.5);align-items:center;gap:calc(var(--spacing) * 2.5);color:var(--c-ink4);font-size:11.5px;display:flex}.divider:before,.divider:after{content:"";background-color:var(--c-rule);flex:1;height:1px}.tabs{border-bottom:1px solid var(--c-rule);align-items:center;gap:0;display:flex}.tab{height:calc(var(--spacing) * 9);cursor:pointer;border-style:var(--tw-border-style);padding-inline:calc(var(--spacing) * 3);white-space:nowrap;color:var(--c-ink3);background-color:#0000;border-width:0;font-size:13px;transition:color .12s;position:relative}.tab:hover{color:var(--c-ink)}.tab.on{--tw-font-weight:var(--font-weight-semibold);font-weight:var(--font-weight-semibold);color:var(--c-ink)}.tab.on:after{content:"";background:var(--c-ink);height:2px;position:absolute;bottom:-1px;left:8px;right:8px}.tab .cnt{margin-left:var(--spacing);padding-inline:var(--spacing);vertical-align:middle;font-size:11px;font-family:var(--font-num);background:var(--c-panel2);color:var(--c-ink3);border-radius:2px;display:inline-block}.tab.on .cnt{background:var(--c-ink);color:var(--c-paper)}.toast-item{pointer-events:auto;background-color:var(--c-ink);padding-inline:calc(var(--spacing) * 3.5);padding-block:calc(var(--spacing) * 2);color:var(--c-paper);border-radius:var(--radius-card);box-shadow:var(--shadow-pop);opacity:0;font-size:12.5px;transition:opacity .16s,transform .16s;transform:translateY(6px)}.toast-item.show{opacity:1;transform:none}.toast-item.err{background:var(--c-failed);color:#fff}.toast-item.ok{background:var(--c-signed);color:#fff}.toast-item.warn{background:var(--c-pending);color:#fff}}@layer utilities{.pointer-events-none{pointer-events:none}.fixed{position:fixed}.bottom-6{bottom:calc(var(--spacing) * 6)}.left-1{left:var(--spacing)}.left-1\\/2{left:50%}.z-\\[200\\]{z-index:200}.mx-auto{margin-inline:auto}.mt-1{margin-top:var(--spacing)}.mt-1\\.5{margin-top:calc(var(--spacing) * 1.5)}.mt-2{margin-top:calc(var(--spacing) * 2)}.mt-2\\.5{margin-top:calc(var(--spacing) * 2.5)}.mt-3{margin-top:calc(var(--spacing) * 3)}.mt-4{margin-top:calc(var(--spacing) * 4)}.mt-5{margin-top:calc(var(--spacing) * 5)}.mb-1{margin-bottom:var(--spacing)}.mb-2{margin-bottom:calc(var(--spacing) * 2)}.mb-2\\.5{margin-bottom:calc(var(--spacing) * 2.5)}.mb-3{margin-bottom:calc(var(--spacing) * 3)}.mb-4{margin-bottom:calc(var(--spacing) * 4)}.mb-6{margin-bottom:calc(var(--spacing) * 6)}.block{display:block}.flex{display:flex}.grid{display:grid}.hidden{display:none}.h-9{height:calc(var(--spacing) * 9)}.h-\\[2px\\]{height:2px}.h-full{height:100%}.min-h-dvh{min-height:100dvh}.w-9{width:calc(var(--spacing) * 9)}.w-full{width:100%}.w-max{width:max-content}.max-w-\\[80vw\\]{max-width:80vw}.max-w-\\[380px\\]{max-width:380px}.max-w-\\[1060px\\]{max-width:1060px}.shrink-0{flex-shrink:0}.-translate-x-1\\/2{--tw-translate-x:calc(calc(1 / 2 * 100%) * -1);translate:var(--tw-translate-x) var(--tw-translate-y)}.list-disc{list-style-type:disc}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.place-items-center{place-items:center}.items-baseline{align-items:baseline}.items-center{align-items:center}.items-end{align-items:flex-end}.items-start{align-items:flex-start}.justify-between{justify-content:space-between}.gap-1\\.5{gap:calc(var(--spacing) * 1.5)}.gap-2{gap:calc(var(--spacing) * 2)}.gap-3{gap:calc(var(--spacing) * 3)}.gap-4{gap:calc(var(--spacing) * 4)}.gap-5{gap:calc(var(--spacing) * 5)}.gap-6{gap:calc(var(--spacing) * 6)}.gap-8{gap:calc(var(--spacing) * 8)}:where(.space-y-1>:not(:last-child)){--tw-space-y-reverse:0;margin-block-start:calc(var(--spacing) * var(--tw-space-y-reverse));margin-block-end:calc(var(--spacing) * calc(1 - var(--tw-space-y-reverse)))}:where(.space-y-1\\.5>:not(:last-child)){--tw-space-y-reverse:0;margin-block-start:calc(calc(var(--spacing) * 1.5) * var(--tw-space-y-reverse));margin-block-end:calc(calc(var(--spacing) * 1.5) * calc(1 - var(--tw-space-y-reverse)))}:where(.space-y-3>:not(:last-child)){--tw-space-y-reverse:0;margin-block-start:calc(calc(var(--spacing) * 3) * var(--tw-space-y-reverse));margin-block-end:calc(calc(var(--spacing) * 3) * calc(1 - var(--tw-space-y-reverse)))}.overflow-x-auto{overflow-x:auto}.border-b{border-bottom-style:var(--tw-border-style);border-bottom-width:1px}.border-rule{border-color:var(--c-rule)}.bg-rule{background-color:var(--c-rule)}.bg-signed{background-color:var(--c-signed)}.p-4{padding:calc(var(--spacing) * 4)}.px-4{padding-inline:calc(var(--spacing) * 4)}.px-5{padding-inline:calc(var(--spacing) * 5)}.py-3{padding-block:calc(var(--spacing) * 3)}.py-10{padding-block:calc(var(--spacing) * 10)}.pt-6{padding-top:calc(var(--spacing) * 6)}.pb-1{padding-bottom:var(--spacing)}.pb-3\\.5{padding-bottom:calc(var(--spacing) * 3.5)}.pb-16{padding-bottom:calc(var(--spacing) * 16)}.pl-4{padding-left:calc(var(--spacing) * 4)}.font-display{font-family:ui-serif,Georgia,Songti SC,Noto Serif CJK SC,SimSun,serif}.text-\\[11px\\]{font-size:11px}.text-\\[12\\.5px\\]{font-size:12.5px}.text-\\[13px\\]{font-size:13px}.text-\\[15px\\]{font-size:15px}.text-\\[22px\\]{font-size:22px}.text-\\[24px\\]{font-size:24px}.leading-none{--tw-leading:1;line-height:1}.leading-relaxed{--tw-leading:var(--leading-relaxed);line-height:var(--leading-relaxed)}.font-semibold{--tw-font-weight:var(--font-weight-semibold);font-weight:var(--font-weight-semibold)}.whitespace-nowrap{white-space:nowrap}.text-ink{color:var(--c-ink)}.text-ink2{color:var(--c-ink2)}.text-ink3{color:var(--c-ink3)}.text-ink4{color:var(--c-ink4)}.blur{--tw-blur:blur(8px);filter:var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)}.transition-\\[width\\]{transition-property:width;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--default-transition-duration))}.duration-300{--tw-duration:.3s;transition-duration:.3s}.select-none{-webkit-user-select:none;user-select:none}@media (min-width:40rem){.sm\\:col-span-2{grid-column:span 2/span 2}.sm\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.sm\\:gap-8{gap:calc(var(--spacing) * 8)}.sm\\:px-7{padding-inline:calc(var(--spacing) * 7)}}}:root{--c-paper:#f6f7f5;--c-panel:#fff;--c-panel2:#eff1ee;--c-rule:#dfe3de;--c-rule2:#c8cec7;--c-ink:#14171a;--c-ink2:#4b5155;--c-ink3:#848b8f;--c-ink4:#a9aeb1;--c-signed:#1f7a4d;--c-signed-weak:#e8f2ec;--c-pending:#8a6116;--c-pending-weak:#f6efdf;--c-failed:#a6332b;--c-failed-weak:#f7e9e7;--c-off:#6e7570;--c-off-weak:#eceeea;--c-focus:#2f6f57;--a-purple:#5d5a8f;--a-blue:#31618c;--a-green:#2f7a58;--a-amber:#96703a;--a-cyan:#3f8088;--a-rose:#93505c;--a-gray:#6b7169;--shadow-pop:0 18px 44px -18px #14171a4d;color-scheme:light}@media (prefers-color-scheme:dark){:root{--c-paper:#0c0e0f;--c-panel:#141718;--c-panel2:#191d1e;--c-rule:#272c2d;--c-rule2:#3a4042;--c-ink:#eef0ee;--c-ink2:#b9bfbd;--c-ink3:#828a88;--c-ink4:#656d6b;--c-signed:#4ec98a;--c-signed-weak:#12241b;--c-pending:#e0b25f;--c-pending-weak:#241d10;--c-failed:#f08b80;--c-failed-weak:#2a1513;--c-off:#8d9490;--c-off-weak:#1b1f1e;--c-focus:#7fc7a8;--a-purple:#a3a0dc;--a-blue:#8ab6df;--a-green:#6fd0a4;--a-amber:#e0b26a;--a-cyan:#86cdd6;--a-rose:#e79aa8;--a-gray:#a8afaa;--shadow-pop:0 18px 44px -18px #000000bf;color-scheme:dark}}.today-rule{border-bottom:2px solid var(--c-ink)}.today-date{--tw-leading:.92;--tw-tracking:var(--tracking-tight);letter-spacing:var(--tracking-tight);font-family:ui-serif,Georgia,Songti SC,Noto Serif CJK SC,SimSun,serif;font-size:clamp(30px,6vw,46px);line-height:.92}.today-frac{font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-size:clamp(26px,4.6vw,38px);line-height:1}.kpi-label{margin-bottom:var(--spacing);color:var(--c-ink3);font-size:11px}.kpi-value{--tw-leading:1;font-family:ui-monospace,Cascadia Mono,SF Mono,Consolas,Liberation Mono,monospace;font-size:19px;line-height:1}.punch{flex-wrap:wrap;align-items:center;gap:5px;display:flex}.punch i{background:var(--x,var(--c-panel2));border-radius:3.40282e38px;width:13px;height:13px;display:inline-block}@supports (color:color-mix(in lab, red, red)){.punch i{background:color-mix(in oklab,var(--x,var(--c-panel2)) 45%,var(--c-panel))}}.punch i{border:1px solid var(--x,var(--c-rule2))}.punch i.done{--x:var(--c-signed)}.punch i.part{--x:var(--c-pending)}.punch i.bad{--x:var(--c-failed)}.punch i.offd{--x:var(--c-rule2);opacity:.55}@media (max-width:860px){.at-wrap{background:0 0;border:0}.at,.at tbody{min-width:0;display:block}.at colgroup,.at thead{display:none}.at tbody tr.ar{margin-bottom:calc(var(--spacing) * 2);column-gap:calc(var(--spacing) * 2.5);row-gap:calc(var(--spacing) * 1.5);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule);background-color:var(--c-panel);padding-inline:calc(var(--spacing) * 3);padding-block:calc(var(--spacing) * 3);border-left:2px solid var(--pc,var(--c-rule));border-radius:var(--radius-card);grid-template-columns:minmax(0,1fr) auto auto;display:grid}.at tbody tr.ar.open{box-shadow:inset 3px 0 0 var(--c-ink)}.at tbody td{align-items:center;gap:calc(var(--spacing) * 1.5);border-style:var(--tw-border-style);white-space:nowrap;min-width:0;color:var(--c-ink3);border-width:0;padding:0;font-size:12.5px;display:flex;overflow:visible}.at td:first-child{flex-wrap:wrap;grid-area:1/1/2/3;row-gap:4px;font-size:13.5px}.at td:first-child .nm2{flex:1 0 auto;min-width:0;max-width:100%}.at td:nth-child(7){grid-area:1/3/2/4;justify-self:end}.at td:nth-child(6){grid-area:2/1/3/4}.at td:nth-child(2){grid-area:3/1/4/2}.at td:nth-child(3){grid-area:3/2/4/3}.at td:nth-child(4){grid-area:3/3/4/4;justify-self:end}.at td:nth-child(5){grid-area:4/1/5/4}.at td.num{justify-self:flex-start}.at td:nth-child(2):before{content:"积分";color:var(--c-ink4);font-size:11px}.at td:nth-child(3):before{content:"今日";color:var(--c-ink4);font-size:11px}.at td:nth-child(4):before{content:"连续";color:var(--c-ink4);font-size:11px}.at td:nth-child(5):before{content:"凭证";color:var(--c-ink4);font-size:11px}.at tr.ar-detail{display:none}.at tr.ar-detail.show{margin-top:-8px;margin-bottom:calc(var(--spacing) * 3);border-style:var(--tw-border-style);border-width:1px;border-color:var(--c-rule);background-color:var(--c-panel);border-top:1px dashed var(--c-rule2);border-radius:0 0 var(--radius-card) var(--radius-card);display:block}.at tr.ar-detail>td{width:auto;padding:calc(var(--spacing) * 3);white-space:normal;border-left:0;display:block}.qa .qa-tip{text-align:left;width:100%;margin-left:0}.at .t-msg{max-width:44vw}}@property --tw-translate-x{syntax:"*";inherits:false;initial-value:0}@property --tw-translate-y{syntax:"*";inherits:false;initial-value:0}@property --tw-translate-z{syntax:"*";inherits:false;initial-value:0}@property --tw-space-y-reverse{syntax:"*";inherits:false;initial-value:0}@property --tw-border-style{syntax:"*";inherits:false;initial-value:solid}@property --tw-leading{syntax:"*";inherits:false}@property --tw-font-weight{syntax:"*";inherits:false}@property --tw-blur{syntax:"*";inherits:false}@property --tw-brightness{syntax:"*";inherits:false}@property --tw-contrast{syntax:"*";inherits:false}@property --tw-grayscale{syntax:"*";inherits:false}@property --tw-hue-rotate{syntax:"*";inherits:false}@property --tw-invert{syntax:"*";inherits:false}@property --tw-opacity{syntax:"*";inherits:false}@property --tw-saturate{syntax:"*";inherits:false}@property --tw-sepia{syntax:"*";inherits:false}@property --tw-drop-shadow{syntax:"*";inherits:false}@property --tw-drop-shadow-color{syntax:"*";inherits:false}@property --tw-drop-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-drop-shadow-size{syntax:"*";inherits:false}@property --tw-duration{syntax:"*";inherits:false}@property --tw-tracking{syntax:"*";inherits:false}
</style>
</head>
<body class="min-h-dvh">

<!-- 登录 -->
<div id="loginView" class="min-h-dvh grid place-items-center px-5 py-10">
  <div class="w-full max-w-[380px]">
    <div class="flex items-center gap-3 mb-6">
      <svg class="w-9 h-9 shrink-0" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="4" fill="#14171a"/><path d="M17 33.2 L27.4 43.4 L46.5 21.6" fill="none" stroke="#f6f7f5" stroke-width="6.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div>
        <h1 class="font-display text-[24px] leading-none">签到台</h1>
        <div class="hint mt-1.5">每日考勤登记 · Cloudflare Worker</div>
      </div>
    </div>
    <div class="card p-4">
      <label class="lb" for="pwd">登录密码</label>
      <div class="flex gap-2">
        <input id="pwd" class="field" type="password" placeholder="输入 ADMIN_TOKEN" autocomplete="current-password">
        <button id="loginBtn" class="btn-primary shrink-0">登录</button>
      </div>
      <div class="hint mt-3">密码即后台的 <code>ADMIN_TOKEN</code>。登录状态只存在本机浏览器，公共电脑用完请退出。</div>
      <div class="err mt-2" id="loginErr"></div>
    </div>
  </div>
</div>

<div id="appView" hidden>
<div class="mx-auto w-full max-w-[1060px] px-4 sm:px-7 pb-16">

  <!-- 今日卡 -->
  <header class="pt-6 pb-3.5 today-rule">
    <div class="flex items-start justify-between gap-4">
      <div class="hint select-none">签到台 <span class="text-ink4">/</span> <span id="headScope">6 平台</span></div>
      <div class="flex items-center gap-1.5">
        <span class="badge idle" id="schedBadge">定时 —</span>
        <button class="btn-ghost btn-sm" onclick="openGuide()">使用教程</button>
        <button class="btn-ghost btn-sm" onclick="logout('')">退出</button>
      </div>
    </div>
    <div class="flex items-end justify-between gap-8 flex-wrap mt-4">
      <div class="flex items-end gap-5">
        <div class="today-date" id="stampDate">--</div>
        <div class="pb-1">
          <div class="hint" id="stampWeek">—</div>
          <div class="punch mt-2" id="punchStrip" aria-hidden="true"></div>
        </div>
      </div>
      <div class="flex items-end gap-6 sm:gap-8 flex-wrap">
        <div>
          <div class="kpi-label">今日已签</div>
          <div class="today-frac"><span id="kpiToday">0</span><span class="text-ink4 text-[22px]" id="kpiTotal">/0</span></div>
          <div class="hint mt-1" id="kpiEnabled">—</div>
        </div>
        <div>
          <div class="kpi-label">今日积分</div>
          <div class="kpi-value" id="kpiCredit">—</div>
          <div class="hint mt-1">各平台合计</div>
        </div>
        <div>
          <div class="kpi-label">累计签到</div>
          <div class="kpi-value" id="kpiSigned">—</div>
          <div class="hint mt-1">次</div>
        </div>
        <div>
          <div class="kpi-label">下次自动签到</div>
          <div class="kpi-value text-[15px]" id="kpiNext">—</div>
          <div class="hint mt-1 num" id="kpiCron">—</div>
        </div>
      </div>
    </div>
    <div class="mt-3 h-[2px] bg-rule" aria-hidden="true"><i id="kpiBar" class="block h-full bg-signed transition-[width] duration-300" style="width:0"></i></div>
  </header>

  <nav class="tabs mt-5">
    <button class="tab on" data-tab="accounts" onclick="switchTab('accounts',this)">账号 <span class="cnt" id="tabCnt">0</span></button>
    <button class="tab" data-tab="history" onclick="switchTab('history',this)">运行历史 <span class="cnt" id="tabHist">0</span></button>
    <button class="tab" data-tab="about" onclick="switchTab('about',this)">关于</button>
  </nav>

  <section class="panel active" id="panel-accounts">
    <div class="sec-head mt-5">
      <div class="sec-title">考勤登记簿<i class="auto-tip">每分钟自动刷新</i></div>
      <div class="sec-acts">
        <button class="btn-ghost btn-sm" onclick="openAdd()">添加账号</button>
        <span class="act-div"></span>
        <button class="btn-ghost btn-sm" id="refreshAllBtn" onclick="refreshAll(this)">刷新</button>
        <button class="btn-primary btn-sm" id="runAllBtn" onclick="runAll(this)">全部签到</button>
      </div>
    </div>
    <div class="err mb-2" id="runMsg"></div>
    <div id="acctList"><div class="empty">加载中…</div></div>
    <div class="hint mt-3">点账号行展开详情：刷新积分、重命名、删除、最近执行记录都在里面。凭证只支持重新登录或重新粘贴，不支持直接查看。</div>
  </section>

  <section class="panel" id="panel-history">
    <div class="sec-head mt-5">
      <div class="sec-title">运行历史</div>
      <div class="sec-acts">
        <span class="hint" id="histHint">—</span>
        <button class="btn-ghost btn-sm" onclick="clearHistory()">清空</button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="at no-click">
        <thead><tr><th>时间</th><th>账号</th><th>平台</th><th>触发</th><th>结果</th><th class="num">积分</th><th>说明</th></tr></thead>
        <tbody id="histBody"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
      </table>
    </div>
    <div class="flex items-center justify-between gap-3 mt-3 flex-wrap">
      <span class="hint num" id="histRange">—</span>
      <div class="flex items-center gap-1.5">
        <button class="btn-ghost btn-sm" id="histPrev" onclick="histPage(-1)">上一页</button>
        <button class="btn-ghost btn-sm" id="histNext" onclick="histPage(1)">下一页</button>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-about">
    <div class="grid gap-4 sm:grid-cols-2 mt-5">
      <div class="card sm:col-span-2">
        <div class="px-4 py-3 flex items-baseline justify-between gap-3 border-b border-rule">
          <h3 class="font-display text-[15px]">支持平台</h3><span class="hint">接口按官方客户端/网页整理</span>
        </div>
        <div class="px-4 py-3 overflow-x-auto">
          <table class="at no-click">
            <thead><tr><th>平台</th><th>签到</th><th>积分口径</th><th>添加方式</th><th>状态</th></tr></thead>
            <tbody>
              <tr class="ar"><td>Trae</td><td>每日积分</td><td class="num">余额 / 本次</td><td>抖音扫码 + 粘贴回调</td><td><span class="badge ok">已实测</span></td></tr>
              <tr class="ar"><td>WorkBuddy</td><td>每日签到</td><td class="num">连签 / 本期</td><td>微信扫码</td><td><span class="badge ok">已实测</span></td></tr>
              <tr class="ar"><td>WorkBuddy 国际版</td><td>活动档期内</td><td class="num">余额 / 套餐</td><td>网页授权或粘贴 token</td><td><span class="badge warn">未验证</span></td></tr>
              <tr class="ar"><td>智谱清言</td><td>每日登录积分</td><td class="num">积分余额</td><td>粘贴 chatglm_token</td><td><span class="badge warn">未验证</span></td></tr>
              <tr class="ar"><td>讯飞 Loomy</td><td>每日额度池</td><td class="num">可用额度</td><td>粘贴 token</td><td><span class="badge warn">未验证</span></td></tr>
              <tr class="ar"><td>讯飞 AStudio</td><td>登录积分</td><td class="num">通用 / 星火</td><td>Cookie 或手机号密码</td><td><span class="badge warn">未验证</span></td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="px-4 py-3 flex items-baseline justify-between gap-3 border-b border-rule">
          <h3 class="font-display text-[15px]">部署绑定</h3><span class="hint">Cloudflare Worker</span>
        </div>
        <div class="px-4 py-3">
          <table class="at no-click">
            <tbody>
              <tr class="ar"><td class="num whitespace-nowrap">KV</td><td>KV 命名空间，所有平台按前缀隔离</td></tr>
              <tr class="ar"><td class="num whitespace-nowrap">MASTER_KEY</td><td>32 字节随机值的 base64，所有平台共用</td></tr>
              <tr class="ar"><td class="num whitespace-nowrap">ADMIN_TOKEN</td><td>控制台登录密码</td></tr>
              <tr class="ar"><td class="num whitespace-nowrap">CRON_SECRET</td><td>可选，/cron 独立口令</td></tr>
              <tr class="ar"><td class="num whitespace-nowrap">CHATGLM_SIGN_SECRET</td><td>可选，覆盖内置的智谱签名盐</td></tr>
              <tr class="ar"><td class="num whitespace-nowrap">CHECKIN_CRON</td><td>可选，首次 Cron 触发前的展示占位</td></tr>
            </tbody>
          </table>
          <div class="hint mt-3">Cron 在 Cloudflare 控制台 <b class="text-ink">Settings → Triggers → Cron Triggers</b> 配置，推荐 <code>10 0 * * *</code>（UTC）= 北京 08:10。页面会自动记录最近一次 Cron 触发的表达式并按北京时间算下次时间。</div>
        </div>
      </div>
      <div class="card">
        <div class="px-4 py-3 border-b border-rule"><h3 class="font-display text-[15px]">安全设计</h3></div>
        <div class="px-4 py-3">
          <ul class="text-[12.5px] leading-relaxed text-ink2 space-y-1.5 list-disc pl-4">
            <li>KV 里存的是 AES-256-GCM 密文，每条记录随机 salt 与 IV，密钥由 MASTER_KEY 经 HKDF-SHA256 派生。</li>
            <li>接口响应永远不返回令牌、Cookie、私钥，连前缀都不给。</li>
            <li>登录密码与账号凭证分离；口令比较走定长比较。</li>
            <li>登录密码只存在浏览器 localStorage；Worker 侧不落盘、不下发 Cookie。</li>
            <li>页面零外部资源引用，样式在部署时已编译进 Worker，不加载任何第三方脚本或字体。</li>
          </ul>
          <div class="tip mt-3"><b>边界：</b>令牌在 Worker 内存里必然有一刻是明文。云端能看到什么取决于你是否信任它——介意就部署到自己的账号下。</div>
        </div>
      </div>
      <div class="card sm:col-span-2">
        <div class="px-4 py-3 border-b border-rule"><h3 class="font-display text-[15px]">已知限制</h3></div>
        <div class="px-4 py-3">
          <ul class="text-[12.5px] leading-relaxed text-ink2 space-y-1.5 list-disc pl-4">
            <li>除 Trae / WorkBuddy 外，新平台协议按官方客户端/网页调用整理，接口可能随客户端升级变化。</li>
            <li>智谱签名盐默认已内置；如官方客户端更新导致签名失败，可用 <code>CHATGLM_SIGN_SECRET</code> 覆盖。</li>
            <li>WorkBuddy 国际版活动按档期开放，没档期时显示「无活动」，不是凭证失效。</li>
            <li>Trae 授权回调只认 127.0.0.1，添加账号的最后一步需要手动粘贴一次回调链接。</li>
            <li>签到接口本身幂等；重复点「签到」或「全部签到」不会重复加分。</li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</div>
</div>

<!-- 添加账号 -->
<div class="modal-mask" id="addModal">
  <div class="modal xl">
    <div class="modal-head">
      <h3>添加账号</h3>
      <button class="modal-x" onclick="closeAdd()" title="关闭">✕</button>
    </div>
    <div class="modal-body">
      <div class="step">
        <div class="step-n">1</div>
        <div class="step-b">
          <div class="step-t">选择平台</div>
          <div class="grid gap-2 sm:grid-cols-2" id="platPick"></div>
        </div>
      </div>
      <div class="step">
        <div class="step-n">2</div>
        <div class="step-b">
          <div class="step-t" id="addTitle">添加账号</div>
          <div class="hint mb-2.5" id="addHint"></div>
          <div id="addBody"></div>
          <div class="err mt-2.5" id="addErr"></div>
        </div>
      </div>
      <div class="tip mt-3"><b>昵称、域名会自动识别</b>，无需手动填写。只解析展示用信息，不读取手机号等隐私字段。</div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" id="addCancel" onclick="closeAdd()">取消</button>
      <button class="btn-primary" id="addConfirm" onclick="submitAdd()">确认添加</button>
    </div>
  </div>
</div>

<!-- 使用教程 -->
<div class="modal-mask" id="guideModal">
  <div class="modal xl">
    <div class="modal-head">
      <h3>使用说明</h3>
      <button class="modal-x" onclick="closeGuide()" title="关闭">✕</button>
    </div>
    <div class="modal-body">
      <div class="tabs mb-4" id="guideTabs">
        <button class="tab on" onclick="switchGuide('start',this)">快速开始</button>
        <button class="tab" onclick="switchGuide('trae',this)">Trae / WorkBuddy</button>
        <button class="tab" onclick="switchGuide('more',this)">国际版 / 智谱 / 讯飞</button>
        <button class="tab" onclick="switchGuide('safe',this)">隐私与安全</button>
      </div>

      <div id="guide-start" class="guide-panel active">
        <div class="step"><div class="step-n">1</div><div class="step-b"><div class="step-t">添加账号</div><p>点今日卡下方的「添加账号」，选择平台后按提示扫码或粘贴凭证。昵称和域名会自动识别。</p></div></div>
        <div class="step"><div class="step-n">2</div><div class="step-b"><div class="step-t">设置定时</div><p>在 Cloudflare 控制台给 Worker 加 Cron Trigger：<code>10 0 * * *</code>（UTC）= 北京时间每天 08:10。所有平台会在一次触发里依次跑完。</p></div></div>
        <div class="step"><div class="step-n">3</div><div class="step-b"><div class="step-t">看结果</div><p>今日卡上的日期戳、打孔条和账号状态都是按北京时间当天现算的。点账号行可以展开最近执行记录。</p></div></div>
        <div class="tip mt-3"><b>不用一直开页面</b>　定时任务跑在 Cloudflare，关掉浏览器照样执行；页面只用来查看和管理。</div>
      </div>

      <div id="guide-trae" class="guide-panel">
        <div class="step"><div class="step-n">1</div><div class="step-b"><div class="step-t">Trae：抖音扫码</div><p>点「添加账号」→ 选 Trae → 打开官方授权页，用抖音扫码并确认。浏览器会跳到一个打不开的 <code>127.0.0.1</code> 地址，这是正常的。</p><p>把那个页面的地址栏整段复制，粘回控制台，立即自动绑定。授权码 15 分钟内有效，只能用一次。</p></div></div>
        <div class="step"><div class="step-n">2</div><div class="step-b"><div class="step-t">WorkBuddy：微信扫码</div><p>点「添加账号」→ 选 WorkBuddy → 新窗口打开官方登录页，用微信扫码确认。账号会自动保存，登录窗口自动关闭。</p></div></div>
        <div class="tip mt-3"><b>为什么 Trae 要手动粘一次？</b>　Trae 只把授权码回送到你电脑的 <code>127.0.0.1</code>，云端 Worker 访问不到你电脑的端口，也读不到弹窗地址栏，所以最后一步只能由浏览器里的人完成。</div>
        <div class="tip mt-2"><b>设备密钥是 Worker 现场生成的</b>　Trae 账号由 Worker 生成 P-256 设备密钥并加密保存，续期时的设备证明也由自己签名，不需要安装 Trae 客户端。</div>
      </div>

      <div id="guide-more" class="guide-panel">
        <div class="text-[12.5px] leading-relaxed text-ink2 space-y-3">
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">WorkBuddy 国际版</h4><p>与国内版登录态不通用，账号是 Google / GitHub / X 授权的。点「用 Google / GitHub / X 登录」打开官方授权页，登录完自动入库；也可以粘贴 <code>access_token</code>。</p><p class="text-ink3">活动按档期开放。没有档期时领取接口返回 10001，页面显示「无活动」，不是凭证失效。</p></div>
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">智谱清言</h4><p>浏览器登录 <code>chatglm.cn</code> 后，从 Cookie 里取 <code>chatglm_token</code> 粘贴。签名盐已内置，开箱即用。</p></div>
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">讯飞 Loomy</h4><p>登录 Loomy 客户端或网页后，从请求头 / Cookie 里取 <code>token</code> 粘贴。签到是「每日额度池重置」，不是直接加积分。</p></div>
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">讯飞 AStudio</h4><p>两种方式：① 手机号 + 密码走讯飞 SSO 换会话（密码只用一次，不保存；若被要求滑块请改用 Cookie）；② 登录后 F12 复制完整 Cookie 粘贴。</p></div>
        </div>
        <div class="tip mt-3"><b>未验证标记</b>　智谱、Loomy、AStudio 按官方客户端/网页调用整理，尚未在 Worker 环境用真实账号跑通，页面上会标「未验证」。接口变动时可能需要跟进适配。</div>
      </div>

      <div id="guide-safe" class="guide-panel">
        <div class="text-[12.5px] leading-relaxed text-ink2 space-y-3">
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">处理哪些信息</h4><p>仅处理完成签到所需的平台登录凭证、账号昵称 / ID，以及每次执行的时间、结果与获得积分。</p></div>
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">怎么保存</h4><p>全部保存在你自己的 Cloudflare KV 中，凭证用 AES-256-GCM 加密；不经过开发者或任何第三方服务器，也不提供对外数据输出通道。</p></div>
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">不会做什么</h4><ul class="list-disc pl-4 space-y-1"><li>不收集账号密码（AStudio 密码只在单次请求内存里换会话，不落盘）。</li><li>不读取聊天内容、通讯录、文件或平台上的其它业务数据。</li><li>不出售、共享、转让凭证或数据。</li></ul></div>
          <div><h4 class="text-[13px] font-semibold text-ink mb-1">使用边界</h4><p>仅限本人账号，用于自动化完成本应手动完成的签到。请勿用于代签、账号共享、批量注册或违反平台服务条款的用途。</p></div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" onclick="closeGuide()">关闭</button>
      <button class="btn-primary" onclick="closeGuide();openAdd()">去添加账号</button>
    </div>
  </div>
</div>

<div id="toast" class="fixed left-1/2 bottom-6 -translate-x-1/2 z-[200] flex flex-col items-center gap-2 pointer-events-none w-max max-w-[80vw]"></div>
<script>
(function(){
  'use strict';
  var $ = function(sel){ return document.querySelector(sel); };
  var TOKEN_KEY = 'checkin-admin-token';
  var TOKEN = '';
  var META = { platforms: [], cron: '08:10', nextRun: '' };
  var DATA = { accounts: [], stats: {}, platforms: [], errors: [] };
  var HISTORY = [];
  var HIST_PAGE = 1;
  var HIST_PER = 20;
  var ADD_PLATFORM = '';
  var TIMER = null;
  var WB_TIMER = null;
  var INTL_TIMER = null;

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function firstChar(s){
    var t = String(s == null ? '' : s).trim();
    if (!t) return '?';
    var chars = Array.from ? Array.from(t) : t.split('');
    return chars[0] || '?';
  }
  function fmtNum(n){
    if (n == null || n === '') return '—';
    var v = Number(n);
    if (!isFinite(v)) return '—';
    if (Math.abs(v - Math.round(v)) < 0.0001) return String(Math.round(v));
    return String(Math.round(v * 100) / 100);
  }
  function shortTime(s){
    if (!s) return '';
    return String(s).slice(0, 16).replace('T', ' ');
  }
  function dateText(ms){
    if (!ms) return '';
    var d = new Date(Number(ms) + 8 * 3600e3);
    return d.toISOString().slice(0, 10);
  }
  function beijingNow(){ return new Date(Date.now() + 8 * 3600e3); }
  function pad2(n){ return n < 10 ? '0' + n : String(n); }
  var WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function accentClass(a){
    return 'p-' + ((a && a.accent) || 'gray');
  }
  function platformLabel(key){
    var aliases = { wb: 'workbuddy', wbi: 'workbuddy_intl' };
    var k = aliases[key] || key;
    for (var i = 0; i < META.platforms.length; i++){
      if (META.platforms[i].key === k) return META.platforms[i].label;
    }
    for (var j = 0; j < DATA.platforms.length; j++){
      if (DATA.platforms[j].key === k) return DATA.platforms[j].label;
    }
    return k || '';
  }

  function api(path, opts){
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
      body: opts.body
    }).then(function(res){
      return res.text().then(function(text){
        var data = {};
        try { data = text ? JSON.parse(text) : {}; }
        catch (e) { data = { error: text ? text.slice(0, 200) : ('HTTP ' + res.status) }; }
        if (res.status === 401){
          logout(data.error || '登录已失效，请重新登录');
          throw new Error(data.error || '登录已失效');
        }
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function toast(msg, type){
    var box = $('#toast');
    var el = document.createElement('div');
    el.className = 'toast-item ' + (type || '');
    el.textContent = String(msg == null ? '' : msg);
    box.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add('show'); });
    setTimeout(function(){
      el.classList.remove('show');
      setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 3200);
  }
  function setLoginErr(msg){ $('#loginErr').textContent = msg ? String(msg) : ''; }
  function showRunMsg(msg){
    $('#runMsg').textContent = msg ? String(msg) : '';
  }

  /* ---------------- 登录 / 登出 ---------------- */
  function login(password, silent){
    var v = String(password == null ? '' : password).trim();
    if (!v){ setLoginErr('请输入登录密码'); return; }
    var btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = '登录中…';
    fetch('/api/ping', { headers: { 'X-Admin-Token': v } })
      .then(function(res){
        return res.json().catch(function(){ return { error: '响应无法解析' }; }).then(function(d){
          if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
          TOKEN = v;
          localStorage.setItem(TOKEN_KEY, v);
          setLoginErr('');
          $('#loginView').hidden = true;
          $('#appView').hidden = false;
          loadAll();
          startTimer();
        });
      })
      .catch(function(e){
        localStorage.removeItem(TOKEN_KEY);
        TOKEN = '';
        if (!silent) setLoginErr(e.message || e);
        else { $('#loginView').hidden = false; $('#appView').hidden = true; }
      })
      .then(function(){ btn.disabled = false; btn.textContent = '登录'; });
  }
  function logout(msg){
    TOKEN = '';
    localStorage.removeItem(TOKEN_KEY);
    stopTimer();
    $('#appView').hidden = true;
    $('#loginView').hidden = false;
    $('#pwd').value = '';
    setLoginErr(msg || '');
  }
  function startTimer(){
    stopTimer();
    TIMER = setInterval(function(){
      if (TOKEN) loadOverview().catch(function(){});
    }, 60000);
  }
  function stopTimer(){
    if (TIMER){ clearInterval(TIMER); TIMER = null; }
  }

  /* ---------------- 数据加载 ---------------- */
  function loadAll(){
    return Promise.all([loadMeta(), loadOverview(), loadHistory()])
      .catch(function(e){ toast(e.message || e, 'err'); });
  }
  function loadMeta(){
    return api('/api/meta').then(function(d){
      META = d || { platforms: [] };
      renderStats();
    });
  }
  function loadOverview(){
    return api('/api/overview').then(function(d){
      DATA = d || { accounts: [], stats: {} };
      if (DATA.platforms && DATA.platforms.length) META.platforms = DATA.platforms;
      if (DATA.errors && DATA.errors.length){
        showRunMsg(DATA.errors.map(function(e){ return platformLabel(e.platform) + ': ' + e.error; }).join('；'));
      }
      renderStats();
      if (!document.querySelector('.inline-edit')) renderAccounts();
    });
  }
  function loadHistory(){
    return api('/api/history?limit=200').then(function(d){
      HISTORY = (d && d.entries) || [];
      HIST_PAGE = 1;
      renderHistory();
      renderStats();
    });
  }

  /* ---------------- 今日卡 ---------------- */
  function renderStamp(){
    var d = beijingNow();
    $('#stampDate').textContent = pad2(d.getUTCMonth() + 1) + ' 月 ' + pad2(d.getUTCDate()) + ' 日';
    $('#stampWeek').textContent = WEEK_CN[d.getUTCDay()] + ' · 北京时间 UTC+8';
  }
  function renderPunch(list, now){
    var box = $('#punchStrip');
    if (!list.length){ box.innerHTML = '<i class="offd"></i>'; return; }
    var html = '';
    var shown = Math.min(list.length, 60);
    for (var i = 0; i < shown; i++){
      var st = statusOf(list[i], now);
      var cls = st.cls === 'ok' ? 'done'
        : (st.cls === 'err' ? 'bad'
        : (st.cls === 'warn' ? 'part'
        : (st.cls === 'off' ? 'offd' : '')));
      html += '<i' + (cls ? ' class="' + cls + '"' : '') + ' title="' + esc((list[i].label || list[i].id) + ' · ' + st.text) + '"></i>';
    }
    if (list.length > shown) html += '<span class="text-ink4 text-[11px] num">+' + (list.length - shown) + '</span>';
    box.innerHTML = html;
  }
  function renderStats(){
    var s = DATA.stats || {};
    var list = DATA.accounts || [];
    var now = Date.now();
    $('#kpiToday').textContent = String(s.signed || 0);
    $('#kpiTotal').textContent = '/' + String(s.enabled || 0);
    $('#kpiEnabled').textContent = (s.total || 0) === (s.enabled || 0)
      ? (s.total || 0) + ' 个账号全部启用'
      : ((s.total || 0) + ' 个账号 · 启用 ' + (s.enabled || 0) + ' 个');
    var pct = s.enabled ? Math.round((s.signed || 0) * 100 / s.enabled) : 0;
    $('#kpiBar').style.width = pct + '%';
    $('#kpiCredit').textContent = fmtNum(s.todayCredit || 0);
    $('#kpiSigned').textContent = fmtNum(s.totalSigned || 0);
    var crons = DATA.crons || META.crons || [];
    var cronText = DATA.cron || META.cron || '08:10';
    $('#kpiNext').textContent = DATA.nextRun || META.nextRun || '—';
    $('#kpiCron').textContent = crons.length ? ('UTC ' + crons.join(' / ')) : ('每天 ' + cronText);
    var badge = $('#schedBadge');
    badge.className = 'badge ' + (crons.length ? 'ok' : 'warn');
    badge.textContent = crons.length
      ? ('定时 ' + (crons.length > 1 ? crons.length + ' 条' : '已同步'))
      : ('定时未配置 ' + cronText);
    badge.title = crons.length ? ('已自动识别的 Cloudflare Cron（UTC）：' + crons.join(' / ')) : '在 Cloudflare 控制台配置 Cron Triggers';
    var plats = {};
    list.forEach(function(a){ plats[a.platform] = 1; });
    var pn = Object.keys(plats).length;
    $('#headScope').textContent = pn
      ? (pn + ' 平台 · ' + list.length + ' 个账号')
      : ((META.platforms || []).length + ' 平台 · 尚未添加账号');
    $('#tabCnt').textContent = list.length;
    $('#tabHist').textContent = HISTORY.length;
    renderStamp();
    renderPunch(list, now);
  }

  /* ---------------- 账号登记簿 ---------------- */
  function statusOf(a, now){
    if (a.enabled === false) return { cls: 'off', text: '已停用', stamp: false };
    if (a.signedToday) return { cls: 'ok', text: '已签', stamp: true };
    if (a.cooldownUntil && a.cooldownUntil > now){
      return { cls: 'warn', text: '限流 ' + Math.ceil((a.cooldownUntil - now) / 60000) + ' 分钟', stamp: false };
    }
    if (a.lastState === 'token_dead') return { cls: 'err', text: '令牌失效', stamp: false };
    if (a.lastState === 'no_activity' && a.ranToday) return { cls: 'idle', text: '无活动', stamp: false };
    if (a.lastState === 'pending' && a.ranToday) return { cls: 'warn', text: '待确认', stamp: false };
    if (a.lastState === 'error' && a.ranToday) return { cls: 'err', text: '失败', stamp: false };
    if (a.lastState === 'rate') return { cls: 'warn', text: '限流', stamp: false };
    return { cls: 'idle', text: '待签', stamp: false };
  }
  function todayGain(a){
    if (a.signedToday && typeof a.lastCredit === 'number') return '+' + fmtNum(a.lastCredit);
    if (a.lastState === 'no_activity' && a.ranToday) return '无';
    return '—';
  }
  function streakText(a){
    if (a.streak == null) return '—';
    return fmtNum(a.streak) + ' 天';
  }
  function credHtml(ms, now, kind){
    if (!ms) return '<span class="v-none">—</span>';
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) return '<span class="v-none">—</span>';
    if (t < now) return kind === 'access' ? '<span class="v-warn">可续期</span>' : '<span class="v-bad">已过期</span>';
    if (t - now < 7 * 86400e3){
      return '<span class="v-warn">' + Math.max(1, Math.ceil((t - now) / 86400e3)) + ' 天后</span>';
    }
    return esc(dateText(t));
  }

  function detailHtml(a, st){
    var recent = [];
    for (var i = 0; i < HISTORY.length && recent.length < 6; i++){
      var h = HISTORY[i];
      if (h.platform === a.platform && h.id === a.id) recent.push(h);
    }
    var runs = recent.length
      ? recent.map(function(h){
          var cls = h.state === 'checked' ? 'ok'
            : ((h.state === 'error' || h.state === 'token_dead') ? 'bad'
            : ((h.state === 'rate' || h.state === 'cooldown' || h.state === 'pending') ? 'warn' : 'mut'));
          var icon = cls === 'ok' ? '✓' : (cls === 'bad' ? '✕' : (cls === 'warn' ? '!' : '·'));
          var msg = h.msg || histState(h.state)[1];
          var gain = (typeof h.credit === 'number' && h.credit > 0) ? ' +' + fmtNum(h.credit) : '';
          if (gain && msg.indexOf(String(h.credit)) === -1) msg += gain;
          return '<div class="task ' + cls + '"><span class="t-state">' + icon + '</span><b>' + esc(shortTime(h.at)) + '</b><span>' + esc(msg) + '</span></div>';
        }).join('')
      : '<div class="run-empty">还没有执行记录，签到后这里会留下痕迹。</div>';

    return '<div class="qa">'
      + '<button class="qbtn" onclick="signOne(\\'' + esc(a.platform) + '\\',\\'' + esc(a.id) + '\\',this)">立即签到</button>'
      + '<button class="qbtn" onclick="refreshOne(\\'' + esc(a.platform) + '\\',\\'' + esc(a.id) + '\\',this)">刷新积分</button>'
      + '<button class="qbtn" data-label="' + esc(a.label) + '" onclick="startRename(this,\\'' + esc(a.platform) + '\\',\\'' + esc(a.id) + '\\')">重命名</button>'
      + '<button class="qbtn danger" onclick="removeOne(\\'' + esc(a.platform) + '\\',\\'' + esc(a.id) + '\\')">删除</button>'
      + '<span class="qa-tip">最近运行 ' + (a.lastRun ? esc(shortTime(a.lastRun)) : '—') + '</span>'
      + '</div>'
      + (a.lastMsg ? '<div class="acct-hint">' + esc(a.lastMsg) + '</div>' : '')
      + (a.metaNote ? '<div class="hint mb-2">' + esc(a.metaNote) + '</div>' : '')
      + '<div class="acct-sec"><div class="sec-mini">最近执行</div><div class="task-list">' + runs + '</div></div>';
  }

  function renderAccounts(){
    var box = $('#acctList');
    var list = DATA.accounts || [];
    var openKeys = {};
    document.querySelectorAll('tr.ar.open').forEach(function(r){
      openKeys[r.getAttribute('data-platform') + '|' + r.getAttribute('data-id')] = true;
    });
    if (!list.length){
      box.innerHTML = '<div class="at-wrap"><div class="empty">登记簿还是空的。点上方「添加账号」，扫码或粘一次凭证就能托管。</div></div>';
      return;
    }
    var now = Date.now();
    var html = '<div class="at-wrap"><table class="at"><colgroup><col><col><col><col><col><col><col></colgroup>'
      + '<thead><tr><th>账号</th><th class="num">积分</th><th class="num">今日</th><th class="num">连续</th><th>凭证</th><th>状态</th><th class="act"></th></tr></thead><tbody>';
    for (var i = 0; i < list.length; i++){
      var a = list[i];
      var st = statusOf(a, now);
      var cls = accentClass(a);
      var off = a.enabled === false;
      var mark = st.stamp
        ? '<span class="stamp">' + esc(st.text) + '</span>'
        : '<span class="badge ' + st.cls + '">' + esc(st.text) + '</span>';
      var gain = todayGain(a);
      html += '<tr class="ar ' + cls + (off ? ' st-off' : '') + '" data-platform="' + esc(a.platform) + '" data-id="' + esc(a.id) + '" onclick="toggleDetail(this,event)">'
        + '<td class="cell-acct">'
        +   '<div class="avatar"><span>' + esc(firstChar(a.label)) + '</span><i class="dot"></i></div>'
        +   '<div class="nm2">' + esc(a.label || '未命名') + '</div>'
        +   '<span class="plat-tag">' + esc(a.platformLabel || platformLabel(a.platform)) + '</span>'
        +   (a.verified ? '' : '<span class="badge none nodot">未验证</span>')
        + '</td>'
        + '<td class="num v-cred">' + fmtNum(a.credits) + '</td>'
        + '<td class="num ' + (gain.charAt(0) === '+' ? 'v-up' : 'v-none') + '">' + gain + '</td>'
        + '<td class="num v-day">' + streakText(a) + '</td>'
        + '<td class="v-date">' + credHtml(a.credExp, now, a.credKind) + '</td>'
        + '<td>' + mark + '</td>'
        + '<td class="act"><div class="col-act">'
        +   '<label class="switch" onclick="event.stopPropagation()" title="启用 / 停用"><input type="checkbox" ' + (off ? '' : 'checked') + ' onchange="toggleEnable(this,\\'' + esc(a.platform) + '\\',\\'' + esc(a.id) + '\\')"><span class="track"></span></label>'
        +   '<button class="btn-sign" ' + (off ? 'disabled title="账号已停用"' : '') + ' onclick="event.stopPropagation();signOne(\\'' + esc(a.platform) + '\\',\\'' + esc(a.id) + '\\',this)">签到</button>'
        +   '<span class="chev2">›</span>'
        + '</div></td>'
        + '</tr>'
        + '<tr class="ar-detail ' + cls + '" data-detail="' + esc(a.platform) + '|' + esc(a.id) + '"><td colspan="7">' + detailHtml(a, st) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    box.innerHTML = html;
    if (Object.keys(openKeys).length){
      document.querySelectorAll('tr.ar').forEach(function(r){
        var key = r.getAttribute('data-platform') + '|' + r.getAttribute('data-id');
        if (!openKeys[key]) return;
        r.classList.add('open');
        var n = r.nextElementSibling;
        if (n) n.classList.add('show');
      });
    }
  }

  function toggleDetail(tr, ev){
    if (ev && ev.target && ev.target.closest && ev.target.closest('button,label,input,a')) return;
    var next = tr.nextElementSibling;
    if (next && next.classList.contains('ar-detail')){
      next.classList.toggle('show');
      tr.classList.toggle('open');
    }
  }

  /* ---------------- 账号操作 ---------------- */
  function toggleEnable(el, platform, id){
    var enabled = !!el.checked;
    api('/api/accounts/enable', { method: 'POST', body: JSON.stringify({ platform: platform, id: id, enabled: enabled }) })
      .then(function(){
        toast(enabled ? '账号已启用' : '账号已停用', 'ok');
        return loadOverview();
      })
      .catch(function(e){
        el.checked = !enabled;
        toast(e.message || e, 'err');
      });
  }

  function summarize(summary){
    var checked = 0, failed = 0, skipped = 0, noact = 0, cooling = 0;
    var errors = [];
    var results = (summary && summary.results) || [];
    results.forEach(function(r){
      if (r.state === 'checked') checked++;
      else if (r.state === 'already' || r.state === 'skipped') skipped++;
      else if (r.state === 'no_activity') noact++;
      else if (r.state === 'rate' || r.state === 'cooldown' || r.state === 'pending') cooling++;
      else if (r.state === 'error' || r.state === 'token_dead'){
        failed++;
        errors.push((r.label || '') + ': ' + (r.msg || r.state));
      }
    });
    var parts = [];
    if (checked) parts.push('新签 ' + checked);
    if (skipped) parts.push('已完成 ' + skipped);
    if (noact) parts.push('无活动 ' + noact);
    if (cooling) parts.push('冷却 ' + cooling);
    if (failed) parts.push('失败 ' + failed);
    var text = parts.join(' · ');
    if (!text && results.length === 1) text = results[0].msg || results[0].state || '没有可执行的账号';
    return { text: text || '没有可执行的账号', errors: errors, failed: failed, cooling: cooling };
  }

  function signOne(platform, id, btn){
    if (btn){ btn.disabled = true; btn.textContent = '签到中…'; }
    api('/api/accounts/sign', { method: 'POST', body: JSON.stringify({ platform: platform, id: id, force: true }) })
      .then(function(d){
        if (d.error) throw new Error(d.error);
        var s = summarize(d);
        toast(s.text, (s.failed || s.cooling) ? 'warn' : 'ok');
        if (s.errors.length) showRunMsg(s.errors.join('；'));
        else showRunMsg('');
        return loadAll();
      })
      .catch(function(e){ toast(e.message || e, 'err'); })
      .then(function(){
        if (btn){ btn.disabled = false; btn.textContent = '签到'; }
      });
  }

  function refreshOne(platform, id, btn){
    if (btn){ btn.disabled = true; btn.textContent = '刷新中…'; }
    api('/api/accounts/refresh', { method: 'POST', body: JSON.stringify({ platform: platform, id: id }) })
      .then(function(d){
        var acc = d.account || {};
        toast('已刷新 ' + (acc.label || '') + (acc.credits != null ? '：积分 ' + fmtNum(acc.credits) : ''), 'ok');
        return loadAll();
      })
      .catch(function(e){ toast(e.message || e, 'err'); })
      .then(function(){
        if (btn){ btn.disabled = false; btn.textContent = '刷新积分'; }
      });
  }

  function startRename(btn, platform, id){
    var row = btn.closest('tr') ? btn.closest('tr').previousElementSibling : null;
    if (!row) return;
    var nm = row.querySelector('.nm2');
    if (!nm) return;
    var current = btn.getAttribute('data-label') || nm.textContent || '';
    nm.innerHTML = '<input class="inline-edit" maxlength="40" value="' + esc(current) + '">';
    var input = nm.querySelector('input');
    input.focus();
    input.select();
    var done = false;
    function finish(save){
      if (done) return;
      done = true;
      var v = input.value.trim();
      if (!save || !v || v === current){ loadOverview(); return; }
      api('/api/accounts/rename', { method: 'POST', body: JSON.stringify({ platform: platform, id: id, label: v }) })
        .then(function(){ toast('备注已更新', 'ok'); return loadAll(); })
        .catch(function(e){ toast(e.message || e, 'err'); loadOverview(); });
    }
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape'){ ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function(){ finish(true); });
  }

  function removeOne(platform, id){
    if (!confirm('删除这个账号？删除后需要重新登录/重新粘贴凭证才能恢复。')) return;
    api('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ platform: platform, id: id }) })
      .then(function(){ toast('账号已删除', 'ok'); return loadAll(); })
      .catch(function(e){ toast(e.message || e, 'err'); });
  }

  function runAll(btn){
    if (btn){ btn.disabled = true; btn.textContent = '签到中…'; }
    showRunMsg('');
    api('/api/run-all?force=1', { method: 'POST', body: '{}' })
      .then(function(d){
        var lines = [];
        var checked = 0, failed = 0, already = 0, noact = 0, cooling = 0;
        Object.keys(d).forEach(function(k){
          if (k === 'at' || k === 'platform' || k === 'wb') return;
          var r = d[k] || {};
          if (r.error) { lines.push(platformLabel(k) + ': ' + r.error); failed++; return; }
          checked += r.checked || 0;
          failed += r.failed || 0;
          already += r.already || 0;
          noact += r.noActivity || 0;
          cooling += r.cooling || 0;
          (r.results || []).forEach(function(x){
            if (x.state === 'error' || x.state === 'token_dead') lines.push((x.label || platformLabel(k)) + ': ' + (x.msg || x.state));
          });
        });
        var parts = [];
        if (checked) parts.push('新签 ' + checked);
        if (already) parts.push('已完成 ' + already);
        if (noact) parts.push('无活动 ' + noact);
        if (cooling) parts.push('冷却 ' + cooling);
        if (failed) parts.push('失败 ' + failed);
        toast(parts.join(' · ') || '没有可执行的账号', (failed || cooling) ? 'warn' : 'ok');
        showRunMsg(lines.join('；'));
        return loadAll();
      })
      .catch(function(e){ toast(e.message || e, 'err'); })
      .then(function(){ if (btn){ btn.disabled = false; btn.textContent = '全部签到'; } });
  }

  function refreshAll(btn){
    if (btn){ btn.disabled = true; btn.textContent = '刷新中…'; }
    showRunMsg('');
    api('/api/refresh-all', { method: 'POST', body: '{}' })
      .then(function(d){
        var ok = 0, bad = [];
        (d.results || []).forEach(function(r){
          if (r.ok) ok++;
          else bad.push((r.label || platformLabel(r.platform)) + ': ' + (r.error || '刷新失败'));
        });
        toast('已刷新 ' + ok + ' 个账号' + (bad.length ? '，' + bad.length + ' 个失败' : ''), bad.length ? 'warn' : 'ok');
        showRunMsg(bad.join('；'));
        return loadAll();
      })
      .catch(function(e){ toast(e.message || e, 'err'); })
      .then(function(){ if (btn){ btn.disabled = false; btn.textContent = '刷新'; } });
  }

  /* ---------------- 运行历史 ---------------- */
  function histState(state){
    var map = {
      checked: ['ok', '已签'],
      already: ['idle', '今日已完成'],
      skipped: ['idle', '今日已完成'],
      no_activity: ['idle', '无活动'],
      rate: ['warn', '限流'],
      cooldown: ['warn', '冷却中'],
      pending: ['warn', '待确认'],
      error: ['err', '失败'],
      token_dead: ['err', '令牌失效']
    };
    return map[state] || ['idle', state || '—'];
  }
  function renderHistory(){
    var body = $('#histBody');
    var total = HISTORY.length;
    var pages = Math.max(1, Math.ceil(total / HIST_PER));
    if (HIST_PAGE > pages) HIST_PAGE = pages;
    var start = (HIST_PAGE - 1) * HIST_PER;
    var rows = HISTORY.slice(start, start + HIST_PER);
    if (!rows.length){
      body.innerHTML = '<tr><td colspan="7" class="empty">还没有执行记录，每次签到或定时任务完成后会出现在这里。</td></tr>';
    } else {
      body.innerHTML = rows.map(function(h){
        var st = histState(h.state);
        var pm = metaOf(h.platform);
        var credit = typeof h.credit === 'number' && h.credit > 0 ? '+' + fmtNum(h.credit) : '—';
        return '<tr class="ar ' + accentClass(pm) + '">'
          + '<td class="t-ts">' + esc(shortTime(h.at)) + '</td>'
          + '<td class="t-name">' + esc(h.label || '—') + '</td>'
          + '<td>' + esc(platformLabel(h.platform)) + '</td>'
          + '<td class="hint">' + esc(h.action === 'cron' ? '定时' : (h.action === 'sign' ? '单个' : '手动')) + '</td>'
          + '<td><span class="badge ' + st[0] + '">' + esc(st[1]) + '</span></td>'
          + '<td class="num credit-cell' + (credit === '—' ? ' none' : '') + '">' + credit + '</td>'
          + '<td class="t-msg" title="' + esc(h.msg || '') + '">' + esc(h.msg || '—') + '</td>'
          + '</tr>';
      }).join('');
    }
    $('#histRange').textContent = total ? ('第 ' + (start + 1) + '–' + Math.min(start + HIST_PER, total) + ' 个 · 共 ' + total + ' 个') : '共 0 个';
    $('#histHint').textContent = '共 ' + total + ' 条';
    $('#histPrev').disabled = HIST_PAGE <= 1;
    $('#histNext').disabled = HIST_PAGE >= pages;
  }
  function histPage(delta){
    var pages = Math.max(1, Math.ceil(HISTORY.length / HIST_PER));
    HIST_PAGE = Math.min(pages, Math.max(1, HIST_PAGE + delta));
    renderHistory();
  }
  function clearHistory(){
    if (!confirm('清空全部运行历史？账号和凭证不受影响。')) return;
    api('/api/history/clear', { method: 'POST', body: '{}' })
      .then(function(){ toast('运行历史已清空', 'ok'); HISTORY = []; HIST_PAGE = 1; renderHistory(); renderStats(); })
      .catch(function(e){ toast(e.message || e, 'err'); });
  }

  /* ---------------- 页签 ---------------- */
  function switchTab(name, btn){
    var tabs = document.querySelectorAll('.tab[data-tab]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i] === btn);
    var panels = ['accounts', 'history', 'about'];
    panels.forEach(function(k){
      var el = $('#panel-' + k);
      if (el) el.classList.toggle('active', k === name);
    });
  }

  /* ---------------- 添加账号 ---------------- */
  function metaOf(key){
    for (var i = 0; i < META.platforms.length; i++){
      if (META.platforms[i].key === key) return META.platforms[i];
    }
    return null;
  }
  function openAdd(){
    if (!META.platforms.length){
      toast('平台信息还没加载完，请稍后再试', 'warn');
      return;
    }
    stopWbTimer();
    stopIntlTimer();
    if (!ADD_PLATFORM){
      for (var i = 0; i < META.platforms.length; i++){
        if (META.platforms[i].available !== false){ ADD_PLATFORM = META.platforms[i].key; break; }
      }
      if (!ADD_PLATFORM) ADD_PLATFORM = META.platforms[0].key;
    }
    $('#addErr').textContent = '';
    $('#addModal').classList.add('show');
    renderPlatPick();
    renderAddBody();
  }
  function closeAdd(){
    $('#addModal').classList.remove('show');
    stopWbTimer();
    stopIntlTimer();
    $('#addErr').textContent = '';
  }
  function pickPlatform(key){
    stopWbTimer();
    stopIntlTimer();
    ADD_PLATFORM = key;
    $('#addErr').textContent = '';
    renderPlatPick();
    renderAddBody();
  }
  function renderPlatPick(){
    var html = META.platforms.map(function(p){
      var cls = accentClass(p);
      var off = p.available === false;
      return '<div class="plat-card ' + cls + (p.key === ADD_PLATFORM ? ' on' : '') + (off ? ' off' : '') + '" onclick="pickPlatform(\\'' + esc(p.key) + '\\')">'
        + '<div class="ic">' + esc(firstChar(p.label)) + '</div>'
        + '<div style="min-width:0"><div class="tt">' + esc(p.label) + '</div><div class="dd">'
        + (off ? esc(p.unavailableReason || '未配置') : (p.verified ? '已实测' : '未验证')) + '</div></div></div>';
    }).join('');
    $('#platPick').innerHTML = html;
  }
  function fieldInput(f){
    var id = 'f_' + f.name;
    var ph = esc(f.placeholder || '');
    var isText = f.secret || f.name === 'session' || f.name === 'access_token' || f.name === 'refresh_token';
    if (isText){
      return '<textarea id="' + id + '" class="field" rows="' + (f.name === 'session' ? 3 : 2) + '" placeholder="' + ph + '" spellcheck="false"></textarea>';
    }
    return '<input id="' + id + '" class="field" type="text" placeholder="' + ph + '">';
  }
  function fieldsHtml(meta){
    var list = meta.fields || [];
    var html = '<div class="fields">';
    list.forEach(function(f){
      html += '<div class="field-row"><label class="lb">' + esc(f.label) + (f.required ? '' : '<span class="hint">可选</span>') + '</label>' + fieldInput(f) + '</div>';
    });
    html += '<div class="field-row"><label class="lb">备注<span class="hint">可选</span></label><input id="f_label" class="field" type="text" maxlength="40" placeholder="留空则自动识别昵称"></div>';
    html += '</div>';
    return html;
  }
  function authBlock(title, desc, btnText, onclick){
    return '<div class="rs-card"><div class="rs-h">' + esc(title) + '</div>'
      + '<div class="hint mb-2.5">' + desc + '</div>'
      + '<button class="btn-primary btn-sm" onclick="' + onclick + '">' + esc(btnText) + '</button>'
      + '<div class="auth-status" id="addMsg"></div></div>';
  }
  function renderAddBody(){
    var meta = metaOf(ADD_PLATFORM);
    if (!meta) return;
    var body = $('#addBody');
    var confirm = $('#addConfirm');
    var cancel = $('#addCancel');
    $('#addTitle').textContent = '添加 · ' + meta.label;
    $('#addHint').textContent = meta.hint || '';
    $('#addErr').textContent = '';
    confirm.style.display = '';
    confirm.disabled = false;
    cancel.textContent = '取消';
    confirm.textContent = '确认添加';

    if (meta.available === false){
      body.innerHTML = '<div class="tip"><b>该平台当前不可用：</b>' + esc(meta.unavailableReason || '缺少配置') + '</div>';
      confirm.style.display = 'none';
      return;
    }

    if (meta.addMode === 'qr' && meta.key === 'trae'){
      body.innerHTML = authBlock('Trae 抖音扫码', '点下面按钮打开官方授权页，用抖音扫码。登录完成后浏览器会停在一个打不开的 127.0.0.1 页面，把地址栏整段复制粘到下面。', '打开官方授权页', 'startTrae(this)')
        + '<div id="traeClaim" hidden class="mt-2.5">'
        + '<label class="lb">粘贴回调地址</label>'
        + '<input id="traeUrl" class="field" placeholder="http://127.0.0.1:17388/authorize?authCodeInfo=...">'
        + '<button class="btn-ghost btn-sm mt-2" onclick="claimTrae()">绑定账号</button>'
        + '</div>';
      confirm.style.display = 'none';
      cancel.textContent = '关闭';
      var urlInput = $('#traeUrl');
      if (urlInput){
        urlInput.addEventListener('paste', function(){ setTimeout(claimTrae, 0); });
      }
      return;
    }

    if (meta.addMode === 'qr' && meta.key === 'workbuddy'){
      body.innerHTML = authBlock('WorkBuddy 微信扫码', '点下面按钮打开官方登录页，用微信扫码并确认。账号会自动保存，登录窗口自动关闭。', '打开登录页', 'startWb(this)');
      confirm.style.display = 'none';
      cancel.textContent = '关闭';
      return;
    }

    if (meta.addMode === 'oauth'){
      body.innerHTML = authBlock('一键网页授权', '打开官方授权页，用 Google / GitHub / X 登录。登录完成后这里会自动识别并入库。', '用 Google / GitHub 登录', 'startIntl(this)')
        + '<div class="divider">或粘贴令牌</div>'
        + fieldsHtml(meta);
      confirm.onclick = submitAdd;
      return;
    }

    if (meta.addMode === 'password'){
      body.innerHTML = '<div class="tabs mb-3">'
        + '<button class="tab on" id="astPwTab" onclick="astudioMode(\\'pw\\')">手机号密码</button>'
        + '<button class="tab" id="astCkTab" onclick="astudioMode(\\'cookie\\')">粘贴 Cookie</button>'
        + '</div>'
        + '<div id="astPwBox">'
        + '<div class="tip mb-2.5">用讯飞账号（passport.xfyun.cn）的手机号 + 密码换会话。密码只在本次请求内存里用一次，不保存。若提示需要滑块，请改用「粘贴 Cookie」。</div>'
        + '<div class="fields">'
        + '<div class="field-row"><label class="lb">手机号</label><input id="astPhone" class="field" type="tel" maxlength="11" placeholder="11 位手机号"></div>'
        + '<div class="field-row"><label class="lb">密码</label><input id="astPass" class="field" type="password" placeholder="讯飞账号密码"></div>'
        + '</div>'
        + '<button class="btn-primary btn-sm mt-2.5" id="astLoginBtn" onclick="astudioPassword(this)">登录并添加</button>'
        + '</div>'
        + '<div id="astCkBox" hidden>' + fieldsHtml(meta) + '</div>';
      confirm.style.display = 'none';
      confirm.onclick = submitAdd;
      return;
    }

    body.innerHTML = fieldsHtml(meta);
    confirm.onclick = submitAdd;
  }

  function collectCreds(meta){
    var creds = {};
    (meta.fields || []).forEach(function(f){
      var el = $('#f_' + f.name);
      if (el) creds[f.name] = el.value.trim();
    });
    return creds;
  }
  function submitAdd(){
    var meta = metaOf(ADD_PLATFORM);
    if (!meta) return;
    var creds = collectCreds(meta);
    var has = Object.keys(creds).some(function(k){ return String(creds[k] || '').trim(); });
    if (!has){ $('#addErr').textContent = '请至少填写一项凭证'; return; }
    var labelEl = $('#f_label');
    var label = labelEl ? labelEl.value.trim() : '';
    var btn = $('#addConfirm');
    btn.disabled = true; btn.textContent = '添加中…';
    $('#addErr').textContent = '';
    api('/api/accounts/add', { method: 'POST', body: JSON.stringify({ platform: meta.key, label: label, creds: creds }) })
      .then(function(d){
        toast((d.updated ? '账号凭证已更新：' : '账号已添加：') + ((d.account && d.account.label) || ''), 'ok');
        closeAdd();
        return loadAll();
      })
      .catch(function(e){ $('#addErr').textContent = e.message || String(e); })
      .then(function(){ btn.disabled = false; btn.textContent = '确认添加'; });
  }

  function showAddMsg(msg, type){
    var el = $('#addMsg');
    if (!el){
      var err = $('#addErr');
      if (err) err.textContent = msg || '';
      return;
    }
    el.innerHTML = msg ? '<span style="color:' + (type === 'err' ? 'var(--c-failed)' : 'var(--c-signed)') + '">' + esc(msg) + '</span>' : '';
  }
  function showAddLink(url){
    var el = $('#addMsg');
    var html = '新窗口被拦截，请手动打开：<a href="' + esc(url) + '" target="_blank" rel="noopener">打开登录页</a>';
    if (el) el.innerHTML = html;
    else {
      var err = $('#addErr');
      if (err) err.textContent = '新窗口被拦截，请手动打开：' + url;
    }
  }

  function startTrae(btn){
    if (btn){ btn.disabled = true; }
    api('/trae/api/login/start', { method: 'POST', body: '{}' })
      .then(function(d){
        var win = window.open(d.authUrl, 'trae-login', 'width=520,height=820');
        var wrap = $('#traeClaim');
        if (wrap) wrap.hidden = false;
        var urlInput = $('#traeUrl');
        if (urlInput){ urlInput.focus(); }
        if (!win){
          showAddLink(d.authUrl);
        } else {
          showAddMsg('已打开授权页。扫码并确认后，把打不开的 127.0.0.1 地址复制粘到下面。');
        }
      })
      .catch(function(e){ showAddMsg(e.message || e, 'err'); })
      .then(function(){ if (btn) btn.disabled = false; });
  }

  function claimTrae(){
    var input = $('#traeUrl');
    if (!input) return;
    var url = input.value.trim();
    if (!url){ showAddMsg('请先粘贴回调地址', 'err'); return; }
    showAddMsg('正在用授权码换取令牌…');
    api('/trae/api/login/claim', { method: 'POST', body: JSON.stringify({ url: url }) })
      .then(function(d){
        toast('登录成功：' + (d.label || ''), 'ok');
        closeAdd();
        return loadAll();
      })
      .catch(function(e){ showAddMsg(e.message || e, 'err'); });
  }

  function stopWbTimer(){ if (WB_TIMER){ clearInterval(WB_TIMER); WB_TIMER = null; } }
  function startWb(btn){
    stopWbTimer();
    if (btn){ btn.disabled = true; }
    var win = window.open('about:blank', 'wb-login', 'width=640,height=880');
    api('/wb/api/login/start', { method: 'POST', body: '{}' })
      .then(function(d){
        var opened = false;
        if (win && !win.closed){
          try { win.location.href = d.authUrl; opened = true; } catch (e) { opened = false; }
        }
        if (!opened){
          showAddLink(d.authUrl);
        } else {
          showAddMsg('已打开登录页，用微信扫码并确认，本页会自动保存账号。');
        }
        var n = 0;
        WB_TIMER = setInterval(function(){
          if (n++ > 150){
            stopWbTimer();
            showAddMsg('二维码已过期，请关闭弹窗后重试', 'err');
            return;
          }
          api('/wb/api/login/poll?state=' + encodeURIComponent(d.state))
            .then(function(r){
              if (r.status === 'ok'){
                stopWbTimer();
                if (win && !win.closed){ try { win.close(); } catch (e) {} }
                toast('登录成功：' + (r.label || ''), 'ok');
                closeAdd();
                loadAll();
              } else if (r.status === 'expired' || r.status === 'error'){
                stopWbTimer();
                showAddMsg(r.error || '登录会话已过期，请重试', 'err');
              }
            })
            .catch(function(e){
              stopWbTimer();
              showAddMsg(e.message || e, 'err');
            });
        }, 2500);
      })
      .catch(function(e){
        if (win && !win.closed){ try { win.close(); } catch (err) {} }
        showAddMsg(e.message || e, 'err');
      })
      .then(function(){ if (btn) btn.disabled = false; });
  }

  function stopIntlTimer(){ if (INTL_TIMER){ clearInterval(INTL_TIMER); INTL_TIMER = null; } }
  function startIntl(btn){
    stopIntlTimer();
    if (btn){ btn.disabled = true; }
    var win = window.open('about:blank', 'wbi-login', 'width=680,height=880');
    api('/wbi/api/login/start', { method: 'POST', body: '{}' })
      .then(function(d){
        var opened = false;
        if (win && !win.closed){
          try { win.location.href = d.authUrl; opened = true; } catch (e) { opened = false; }
        }
        if (!opened){
          showAddLink(d.authUrl);
        } else {
          showAddMsg('已打开授权页，用 Google / GitHub / X 登录，本页会自动保存账号。');
        }
        var n = 0;
        INTL_TIMER = setInterval(function(){
          if (n++ > 150){
            stopIntlTimer();
            showAddMsg('授权超时，请关闭弹窗后重试', 'err');
            return;
          }
          api('/wbi/api/login/poll?state=' + encodeURIComponent(d.state))
            .then(function(r){
              if (r.status === 'ok'){
                stopIntlTimer();
                if (win && !win.closed){ try { win.close(); } catch (e) {} }
                toast('登录成功：' + (r.label || ''), 'ok');
                closeAdd();
                loadAll();
              } else if (r.status === 'expired' || r.status === 'error'){
                stopIntlTimer();
                showAddMsg(r.error || '授权会话已过期，请重试', 'err');
              }
            })
            .catch(function(e){
              stopIntlTimer();
              showAddMsg(e.message || e, 'err');
            });
        }, 2500);
      })
      .catch(function(e){
        if (win && !win.closed){ try { win.close(); } catch (err) {} }
        showAddMsg(e.message || e, 'err');
      })
      .then(function(){ if (btn) btn.disabled = false; });
  }

  function astudioMode(mode){
    var pw = $('#astPwBox'), ck = $('#astCkBox');
    var pt = $('#astPwTab'), ct = $('#astCkTab');
    if (!pw || !ck) return;
    pw.hidden = mode !== 'pw';
    ck.hidden = mode !== 'cookie';
    if (pt) pt.classList.toggle('on', mode === 'pw');
    if (ct) ct.classList.toggle('on', mode === 'cookie');
    var confirm = $('#addConfirm');
    if (confirm) confirm.style.display = mode === 'cookie' ? '' : 'none';
  }
  function astudioPassword(btn){
    var phone = ($('#astPhone') && $('#astPhone').value.trim()) || '';
    var password = ($('#astPass') && $('#astPass').value) || '';
    if (!phone || !password){ $('#addErr').textContent = '请填写手机号和密码'; return; }
    btn.disabled = true; btn.textContent = '登录中…';
    $('#addErr').textContent = '';
    api('/astudio/api/login/password', { method: 'POST', body: JSON.stringify({ phone: phone, password: password }) })
      .then(function(d){
        toast('登录成功：' + ((d.account && d.account.label) || ''), 'ok');
        closeAdd();
        return loadAll();
      })
      .catch(function(e){ $('#addErr').textContent = e.message || String(e); })
      .then(function(){ btn.disabled = false; btn.textContent = '登录并添加'; });
  }

  /* ---------------- 教程 ---------------- */
  function openGuide(){
    $('#guideModal').classList.add('show');
    switchGuide('start', document.querySelector('#guideTabs .tab'));
  }
  function closeGuide(){ $('#guideModal').classList.remove('show'); }
  function switchGuide(key, btn){
    var tabs = document.querySelectorAll('#guideTabs .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i] === btn);
    var panels = ['start', 'trae', 'more', 'safe'];
    panels.forEach(function(k){
      var el = $('#guide-' + k);
      if (el) el.classList.toggle('active', k === key);
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  $('#loginBtn').onclick = function(){ login($('#pwd').value, false); };
  $('#pwd').onkeydown = function(e){ if (e.key === 'Enter') login($('#pwd').value, false); };
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    if ($('#addModal').classList.contains('show')) closeAdd();
    else if ($('#guideModal').classList.contains('show')) closeGuide();
  });
  document.querySelectorAll('.modal-mask').forEach(function(mask){
    mask.addEventListener('click', function(e){
      if (e.target !== mask) return;
      if (mask.id === 'addModal') closeAdd();
      if (mask.id === 'guideModal') closeGuide();
    });
  });

  /* 页面里大量使用内联 onclick，必须把入口函数挂到 window 上 */
  window.openGuide = openGuide;
  window.closeGuide = closeGuide;
  window.switchGuide = switchGuide;
  window.switchTab = switchTab;
  window.openAdd = openAdd;
  window.closeAdd = closeAdd;
  window.pickPlatform = pickPlatform;
  window.startTrae = startTrae;
  window.claimTrae = claimTrae;
  window.startWb = startWb;
  window.startIntl = startIntl;
  window.astudioMode = astudioMode;
  window.astudioPassword = astudioPassword;
  window.submitAdd = submitAdd;
  window.toggleDetail = toggleDetail;
  window.toggleEnable = toggleEnable;
  window.signOne = signOne;
  window.refreshOne = refreshOne;
  window.startRename = startRename;
  window.removeOne = removeOne;
  window.logout = logout;
  window.refreshAll = refreshAll;
  window.runAll = runAll;
  window.histPage = histPage;
  window.clearHistory = clearHistory;

  var saved = localStorage.getItem(TOKEN_KEY);
  if (saved) login(saved, true);
})();
</script>
</body>
</html>`;
/* ================================================================== */
/* 导出                                                                */
/* ================================================================== */

export default {
  fetch: __worker.fetch,
  scheduled: __worker.scheduled,
};
