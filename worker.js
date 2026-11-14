/**
 * 签到塔 · SIGN-IN TOWER
 * 多平台每日签到 + WorkBuddy 自动旅行 · Cloudflare Worker（单文件）
 *
 * 一套部署、一个控制台、三条定时班次，管理下面 10 个平台：
 *
 *   trae              Trae（抖音扫码 / 设备密钥 / refreshToken 续期）
 *   workbuddy         WorkBuddy 国内版（微信扫码 / 令牌轮换 / 签到 / 派猫猫旅行）
 *   qoder             Qoder（国内 + 国际版，设备授权或 PAT，双签到通道）
 *   workbuddy_intl    WorkBuddy 国际版（Google / GitHub / X 授权，或粘贴 token）
 *   minimax           MiniMax Code（accessToken / refreshToken + 桌面端签名）
 *   dumate            百度搭子 DuMate（Cookie）
 *   lobster           LobsterAI（accessToken）
 *   zhipu             智谱清言（chatglm_token，需要 CHATGLM_SIGN_SECRET）
 *   loomy             讯飞 Loomy（token，每日额度池重置）
 *   astudio           讯飞 AStudio（Cookie，或手机号 + 密码换会话）
 *
 * 代码结构：
 *   0. 公共工具        编码 / 时间 / HTTP / MD5 / AES-256-GCM 保险箱
 *   1. Trae 模块       设备身份、抖音扫码授权、签到与积分查询
 *   2. WorkBuddy 模块  扫码授权、令牌轮换、签到、成长中心自动旅行
 *   3. Qoder 模块      双区域、设备授权、旧版签到 + 活动平台
 *   4. 通用平台工厂    KV / 加密 / 签到编排 / 增删改查 / 路由
 *   5. 自定义平台      WorkBuddy 国际版、MiniMax、DuMate、Lobster、智谱、Loomy、AStudio
 *   6. 外壳            平台注册表 + 聚合接口 + 通知 + 定时任务
 *   7. 控制台页面      Apple 风格控制台：总览 / 平台 / 账号 / 旅行 / 活动
 *
 * 环境绑定：
 *
 *   KV 绑定    KV                     一个命名空间即可，按平台前缀隔离
 *   Secret     MASTER_KEY             32 字节随机值的 base64，所有平台共用
 *   Secret     ADMIN_TOKEN            控制台登录密码
 *   Secret     CRON_SECRET            （可选）/cron 独立口令，缺省回落到 ADMIN_TOKEN
 *   Secret     CHATGLM_SIGN_SECRET    （可选）智谱客户端签名盐；不配则使用内置默认值
 *   变量       <平台键>_VERIFIED      （可选）覆盖页面上的「未实测」标记，如 ZHIPU_VERIFIED=true
 *
 * Cron 配置（Cloudflare 的 cron 走 UTC，比北京时间慢 8 小时）：
 *   北京 08:10 = UTC 00:10   全量签到 + 派发旅行 + 日报
 *   北京 12:10 = UTC 04:10   重试失败/待确认 + 领取旅行奖励
 *   北京 20:10 = UTC 12:10   晚间兜底 + 旅行收尾
 *   crons = ["10 0 * * *", "10 4 * * *", "10 12 * * *"]
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
        headers: {
          ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
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

/** 平台不回传连续天数时，按本地成功日期累计；同一天重复调用不涨 */
function bumpStreak(acct, day) {
  if (!acct || !day) return;
  const prev = String(acct.streakDate || '');
  if (prev === day) return;
  const expected = new Date(Date.parse(day + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
  acct.streakLocal = prev === expected ? (Number(acct.streakLocal) || 0) + 1 : 1;
  acct.streakDate = day;
}

/** 全局延时（重试/退避用） */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 上游布尔字段可能是 true / 1 / "true" / "1"，统一判断 */
function isTrue(v) {
  if (v === true || v === 1) return true;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
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
    bumpStreak(acct, today);
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
  bumpStreak(acct, today);
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
    streak: a.streak ?? a.streakLocal ?? null,
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
      bumpStreak(acct, today);
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

async function wbFetch(path, { method = 'POST', headers = {}, body = '{}', timeout = 20000, base = API } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(base + path, {
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
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(800);
    try {
      return await refreshTokensOnce(refreshToken);
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
    }
  }
  throw lastErr;
}

async function refreshTokensOnce(refreshToken) {
  const { status, json } = await wbFetch('/v2/plugin/auth/token/refresh', {
    headers: {
      'X-Refresh-Token': refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': 'copilot.tencent.com',
    },
  });

  const text = JSON.stringify(json ?? {});
  if (json?.code !== 0 || !json?.data) {
    const dead = /12153|Offline user session not found|invalid_grant/i.test(text);
    const err = new Error(
      `刷新令牌失败 code=${json?.code} ${json?.msg ?? ''} (HTTP ${status})`
    );
    err.code = json?.code;
    // 只有明确的会话失效才判死刑；网络抖动/5xx 交给上层重试
    err.fatal = dead || status === 401 || status === 403;
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

/** 尽量取昵称和 uid；取不到就算了，不影响登录 */
async function fetchIdentity(at) {
  try {
    const { json } = await wbFetch('/v2/accounts', {
      method: 'GET',
      headers: { ...authHeader(at), 'X-Domain': 'copilot.tencent.com' },
    });
    const list = json?.data?.accounts ?? json?.data;
    const first = Array.isArray(list) ? list[0] : (list && typeof list === 'object' ? list : null);
    return {
      name: String(first?.nickname ?? first?.nickName ?? '').trim(),
      uid: String(first?.uid ?? first?.userId ?? first?.user_id ?? '').trim(),
    };
  } catch {
    return { name: '', uid: '' };
  }
}

/** 从 JWT 里兜底取 uid（WorkBuddy 的 accessToken 带 sub/uid） */
function uidFromToken(token) {
  const c = SH.jwtClaims(token);
  return String(c.uid ?? c.user_id ?? c.userId ?? c.sub ?? '').trim();
}

/** 把一条令牌落成账号记录（加密存 KV + 更新索引） */
async function persistAccount(env, { refreshToken, label, accessToken, refreshExpiresIn }) {
  const id = randomId(9);
  let name = String(label ?? '').trim().slice(0, 40);
  let uid = uidFromToken(accessToken || '');
  if (accessToken && (!name || !uid)) {
    const who = await fetchIdentity(accessToken);
    if (!name) name = who.name;
    if (!uid) uid = who.uid;
  }
  if (!name) name = `账号-${id.slice(0, 4)}`;

  const acct = {
    id,
    label: name,
    uid,
    refreshToken,
    accessToken: String(accessToken || ''),
    accessExp: SH.jwtExp(accessToken || '') * 1000 || 0,
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

/** 所有请求都带上账号身份，服务端按人记账时缺它会出现「返回成功但没记到人」 */
function wbAuthHeaders(acct) {
  const h = authHeader(acct.accessToken || '');
  if (acct.uid) h['X-User-Id'] = String(acct.uid);
  return h;
}

/**
 * 今日签到状态。字段名上游改过几版，这里全部兼容：
 * today_checked_in（现行）/ checked_in_today / checkedIn / alreadyCheckedIn。
 * 只有服务端明确说「今天签过」才算 confirmed，别用客户端自己的乐观判断。
 */
async function checkinStatus(acct) {
  const { json } = await wbFetch('/v2/billing/meter/checkin-activity-status', {
    headers: wbAuthHeaders(acct),
  });
  if (json?.code !== 0 || !json?.data) {
    return { ok: false, code: json?.code, msg: json?.msg };
  }
  const d = json.data;
  const checked =
    isTrue(d.today_checked_in) ||
    isTrue(d.checked_in_today) ||
    isTrue(d.todayCheckedIn) ||
    isTrue(d.checkedIn) ||
    isTrue(d.alreadyCheckedIn);
  return { ok: true, checked, data: d };
}

/**
 * 真实剩余积分：按资源包的「当前周期剩余」汇总。
 * CapacityRemain 是跨周期总量，官方客户端看的是 CycleCapacityRemain（本周期），
 * 两者会差出一截，别混用；只有缺周期字段时才退回总量字段。
 */
async function fetchBalance(acct) {
  const { json } = await wbFetch('/v2/billing/meter/get-user-resource', { headers: wbAuthHeaders(acct) });
  if (json?.code !== 0 || !json?.data) return null;
  const d = json.data.Response?.Data || json.data;
  const rows = Array.isArray(d?.Accounts) ? d.Accounts : [];
  if (!rows.length) return null;
  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  let remain = 0;
  for (const a of rows) {
    const cycle = a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain;
    remain += cycle != null && cycle !== '' ? num(cycle) : num(a.CapacityRemainPrecise ?? a.CapacityRemain);
  }
  return {
    credits: Math.round(remain * 100) / 100,
    dosage: num(d.TotalDosage),
    packages: rows.length,
  };
}

async function doCheckin(acct) {
  const { json } = await wbFetch('/v2/billing/meter/daily-checkin', {
    headers: wbAuthHeaders(acct),
  });
  const msg = String(json?.msg ?? json?.message ?? '');
  if (json?.code === 0) {
    return { state: 'checked', credit: SH.num(json.data?.credit ?? json.data?.credits ?? json.data?.reward), raw: json.data };
  }
  if (json?.code === 10001 || /已签|已领|重复|already/i.test(msg)) {
    return { state: 'already', credit: 0 };
  }
  return { state: 'error', code: json?.code, msg };
}

/* ------------------------------------------------------------------ */
/* 令牌生命周期：复用 → 临期才续 → 401 再续一次                          */
/*                                                                     */
/* WorkBuddy 的 refreshToken 是一次性轮换的：每轮签到都无条件刷新，       */
/* 一旦刷新响应丢失或两次运行撞车，旧 RT 立刻作废 → 断签。               */
/* 所以能复用 accessToken 就复用，续期成功后必须第一时间落盘。           */
/* ------------------------------------------------------------------ */

const TOKEN_MARGIN_MS = 5 * 60 * 1000;

function accessExpOf(acct) {
  const exp = Number(acct.accessExp || 0);
  if (exp > 0) return exp;
  const fromJwt = SH.jwtExp(acct.accessToken || '') * 1000;
  return fromJwt || 0;
}

function accessFresh(acct, margin = TOKEN_MARGIN_MS) {
  if (!acct.accessToken) return false;
  const exp = accessExpOf(acct);
  return !exp || exp - Date.now() > margin;
}

/** 确保有一条可用 accessToken；续期后立即加密落盘，避免轮换丢失 */
async function ensureAccess(env, acct) {
  if (accessFresh(acct)) return acct.accessToken;
  const t = await refreshTokens(acct.refreshToken);
  acct.accessToken = t.accessToken;
  if (t.refreshToken) acct.refreshToken = t.refreshToken;
  acct.accessExp = SH.jwtExp(t.accessToken) * 1000 || 0;
  acct.tokenRefreshedAt = Date.now();
  if (t.refreshExpiresIn) acct.refreshExp = Date.now() + t.refreshExpiresIn * 1000;
  if (!acct.uid) {
    acct.uid = uidFromToken(t.accessToken);
    if (!acct.uid) acct.uid = (await fetchIdentity(t.accessToken)).uid;
  }
  await putAccount(env, acct);
  return acct.accessToken;
}

/** 业务请求遇到 401/403：强制轮换一次令牌再重试 */
async function rotateAccess(env, acct) {
  const t = await refreshTokens(acct.refreshToken);
  acct.accessToken = t.accessToken;
  if (t.refreshToken) acct.refreshToken = t.refreshToken;
  acct.accessExp = SH.jwtExp(t.accessToken) * 1000 || 0;
  acct.tokenRefreshedAt = Date.now();
  if (t.refreshExpiresIn) acct.refreshExp = Date.now() + t.refreshExpiresIn * 1000;
  await putAccount(env, acct);
  return acct.accessToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只读查一次状态；网络异常不抛，交给调用方决定是否继续 */
async function statusOnce(acct) {
  try {
    return await checkinStatus(acct);
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

/** 反复查状态直到服务端确认「今天已签」；状态有延迟，不能只看一次 */
async function confirmChecked(acct, { tries = 3, delay = 1200 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(delay * i);
    last = await statusOnce(acct);
    if (last.ok && last.checked) return { confirmed: true, status: last };
  }
  return { confirmed: false, status: last };
}

/* ------------------------------------------------------------------ */
/* 成长中心：自动派猫猫旅行                                              */
/*                                                                     */
/* 接口挂在 www.codebuddy.cn（和 /v2/plugin 签到网关同账号体系），       */
/* 状态机完全以服务端 data.state 为准：                                 */
/*   idle →(depart)→ traveling →(到点)→ arrived →(claim)→ idle          */
/* idle + daily_limit_reached 对应官网「累了，明天再来吧」，按已完成展示。 */
/* 参考 changexbc/workbuddy-switch 的 travel.rs 复刻判定逻辑：           */
/*   - 429 是限流，不等于「今日已派」，必须看文案里的 daily limit         */
/*   - 缺 state / 未知 state 判失败，绝不默认成 idle 后误标已领           */
/*   - no-buddy / config-error / status-error 都是可重试项，不写完成标记   */
/* ------------------------------------------------------------------ */

const TRAVEL_BASE = 'https://www.codebuddy.cn';
const TRAVEL_FALLBACK_BASE = 'https://copilot.tencent.com';
const TRAVEL_PREFIX = '/activity/growth/buddy/travel';
const TRAVEL_STATES = ['idle', 'traveling', 'arrived'];

function travelHeaders(acct) {
  const h = wbAuthHeaders(acct);
  h.Accept = 'application/json';
  h['X-Client-Platform'] = 'web';
  h.Origin = TRAVEL_BASE;
  h.Referer = TRAVEL_BASE + '/profile/growth-center';
  return h;
}

/** 秒级/毫秒级时间戳统一成毫秒 */
function travelTs(v) {
  const n = Number(v) || 0;
  return n > 0 && n < 1e12 ? n * 1000 : n;
}

function travelMsg(res) {
  const j = res.json || {};
  return String(j.msg ?? j.message ?? `HTTP ${res.status}`);
}

function travelUnauthorized(res) {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  const code = Number((res.json || {}).code);
  if (code === 401 || code === 403) return true;
  return /unauthorized|login required|登录|失效|过期/i.test(travelMsg(res));
}

async function travelRaw(acct, path, { method = 'GET', body = null, base = TRAVEL_BASE } = {}) {
  return wbFetch(TRAVEL_PREFIX + path, {
    base,
    method,
    headers: travelHeaders(acct),
    body: body ? JSON.stringify(body) : '{}',
    timeout: 15000,
  });
}

/** 旅行请求：401 先轮换令牌；主域名不可用/无路由时回落到 copilot 网关 */
async function travelFetch(env, acct, path, opts = {}) {
  let res = null;
  let err = null;
  try {
    res = await travelRaw(acct, path, opts);
  } catch (e) {
    err = e;
  }
  if (res && travelUnauthorized(res) && acct.refreshToken) {
    try {
      await rotateAccess(env, acct);
      res = await travelRaw(acct, path, opts);
    } catch {
      /* 续期失败保留原始响应 */
    }
  }
  if (!res || res.status === 404 || travelUnauthorized(res)) {
    try {
      const alt = await travelRaw(acct, path, { ...opts, base: TRAVEL_FALLBACK_BASE });
      if (alt && alt.status !== 404) return alt;
    } catch {
      /* 回落失败就报告第一次的结论 */
    }
  }
  if (!res) throw err || new Error('旅行接口不可达');
  return res;
}

function travelParse(res) {
  const j = res.json || {};
  const code = Number(j.code);
  if (j.code !== undefined && code !== 0 && code !== 200) {
    return { ok: false, code, msg: travelMsg(res) };
  }
  if (!j.data || typeof j.data !== 'object') {
    return { ok: false, code, msg: travelMsg(res) || '响应缺少 data' };
  }
  return { ok: true, data: j.data };
}

async function fetchTravelStatus(env, acct) {
  let last = { ok: false, msg: '旅行状态查询失败' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(900);
    try {
      const p = travelParse(await travelFetch(env, acct, '/status'));
      if (!p.ok) {
        last = { ok: false, msg: p.msg };
        continue;
      }
      const d = p.data;
      const state = String(d.state ?? '').trim().toLowerCase();
      if (!TRAVEL_STATES.includes(state)) {
        last = { ok: false, msg: state ? `未知旅行状态：${state}` : '响应缺少旅行状态' };
        continue;
      }
      return {
        ok: true,
        state,
        locationId: d.location?.id ?? null,
        locationName: String(d.location?.name ?? '').trim(),
        departAt: travelTs(d.depart_at),
        arriveAt: travelTs(d.arrive_at),
        dailyLimit: d.daily_limit_reached === true,
        buddyId: Number(d.buddy_id) || 0,
        recordId: Number(d.record_id) || 0,
        rewardCredit: SH.num(d.reward_credit),
        serverNow: travelTs(d.server_now),
      };
    } catch (e) {
      last = { ok: false, msg: e.message };
    }
  }
  return last;
}

async function fetchTravelConfig(env, acct) {
  try {
    const p = travelParse(await travelFetch(env, acct, '/config'));
    if (!p.ok) return { ok: false, msg: p.msg };
    const d = p.data;
    const locations = (Array.isArray(d.locations) ? d.locations : [])
      .map((l) => ({ id: l?.id ?? null, name: String(l?.name ?? '').trim() }))
      .filter((l) => l.id !== null && l.id !== undefined);
    return {
      ok: true,
      enabled: d.enabled !== false && locations.length > 0,
      locations,
      msg: locations.length ? '' : '没有可用旅行地点',
    };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

async function departTravel(env, acct) {
  const cfg = await fetchTravelConfig(env, acct);
  if (!cfg.ok) return { ok: false, kind: 'error', msg: cfg.msg || '读取旅行配置失败' };
  if (!cfg.enabled) return { ok: false, kind: 'no-location', msg: cfg.msg || '没有可用旅行地点' };
  let lastUnavailable = false;
  let lastMsg = '';
  for (const loc of cfg.locations) {
    try {
      const p = travelParse(
        await travelFetch(env, acct, '/depart', { method: 'POST', body: { location_id: loc.id } })
      );
      if (p.ok) {
        return {
          ok: true,
          state: String(p.data.state ?? 'traveling').toLowerCase(),
          locationName: loc.name,
          msg: '',
        };
      }
      const msg = String(p.msg || '');
      const low = msg.toLowerCase();
      lastMsg = msg;
      if (/already traveling|already_traveling|已在旅行/.test(low)) {
        return { ok: true, already: true, state: 'traveling', locationName: loc.name, msg: '已在旅行中' };
      }
      if (/daily limit|daily_limit|今日.*(已|上限)/.test(low)) {
        return { ok: true, dailyLimit: true, state: 'idle', locationName: loc.name, msg: '今日已派' };
      }
      if (/no active buddy|no_buddy|无.*buddy|没有.*buddy/.test(low)) {
        return { ok: false, kind: 'no-buddy', msg: '账号还没有 Buddy，请先在 WorkBuddy 创建' };
      }
      if (/location not available|地点不可用/.test(low)) {
        lastUnavailable = true;
        continue;
      }
      return { ok: false, kind: 'error', msg };
    } catch (e) {
      lastMsg = e.message;
    }
  }
  return lastUnavailable
    ? { ok: false, kind: 'no-location', msg: '所选旅行地点暂不可用' }
    : { ok: false, kind: 'error', msg: lastMsg || '派发失败' };
}

async function claimTravel(env, acct, recordId) {
  const body = recordId > 0 ? { record_id: recordId } : {};
  try {
    const p = travelParse(
      await travelFetch(env, acct, '/claim', { method: 'POST', body })
    );
    if (p.ok) return { ok: true, rewardCredit: SH.num(p.data.reward_credit), msg: '' };
    const msg = String(p.msg || '');
    const low = msg.toLowerCase();
    if (/no unclaimed travel|daily_limit|已领/.test(low)) {
      return { ok: true, already: true, msg: '奖励已在网页端领取' };
    }
    if (/not arrived yet|尚未到达/.test(low)) {
      return { ok: false, wait: true, msg: '旅行还没到点，稍后再来' };
    }
    return { ok: false, msg };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

async function saveTravel(env, acct, rec) {
  const next = {
    label: rec.label || 'untraveled',
    state: rec.state || '',
    locationName: rec.locationName || '',
    rewardCredit: typeof rec.rewardCredit === 'number' ? rec.rewardCredit : null,
    departAt: Number(rec.departAt) || 0,
    arriveAt: Number(rec.arriveAt) || 0,
    dailyLimit: rec.dailyLimit === true,
    recordId: Number(rec.recordId) || 0,
    message: rec.message || '',
    checkedAt: Date.now(),
    claimedAt: Number(rec.claimedAt) || 0,
  };
  acct.travel = next;
  await putAccount(env, acct);
  return next;
}

/**
 * 同步单个账号的旅行：到达就领、旅行中就等、今天是 idle 才派。
 * allowDepart = null 时跟随账号的 autoTravel 开关。
 */
async function travelSync(env, acct, { allowDepart = null } = {}) {
  const now = Date.now();
  const base = { id: acct.id, label: acct.label, platform: 'workbuddy' };
  if (acct.enabled === false) {
    return { ...base, ok: false, travelLabel: 'disabled', msg: '账号已停用' };
  }

  try {
    await ensureAccess(env, acct);
  } catch (e) {
    const exp = accessExpOf(acct);
    if (!acct.accessToken || (exp && exp <= now)) {
      await saveTravel(env, acct, { label: 'error', message: e.message });
      return { ...base, ok: false, travelLabel: 'error', msg: e.message, travel: acct.travel };
    }
  }

  const status = await fetchTravelStatus(env, acct);
  if (!status.ok) {
    const rec = { label: 'error', message: status.msg || '状态查询失败' };
    await saveTravel(env, acct, rec);
    return { ...base, ok: false, travelLabel: 'error', msg: rec.message, travel: acct.travel };
  }

  const common = {
    state: status.state,
    locationName: status.locationName,
    departAt: status.departAt,
    arriveAt: status.arriveAt,
    dailyLimit: status.dailyLimit,
    recordId: status.recordId,
    rewardCredit: status.rewardCredit,
  };

  if (status.state === 'traveling') {
    const rec = { ...common, label: 'traveling', message: '猫猫正在路上' };
    await saveTravel(env, acct, rec);
    return { ...base, ok: true, travelLabel: 'traveling', msg: rec.message, travel: acct.travel };
  }

  if (status.state === 'arrived') {
    const claim = await claimTravel(env, acct, status.recordId);
    if (claim.ok) {
      const rec = {
        ...common,
        label: 'finished',
        message: claim.already ? claim.msg : `旅行奖励 +${claim.rewardCredit ?? 0}`,
        rewardCredit: claim.rewardCredit ?? status.rewardCredit,
        claimedAt: Date.now(),
      };
      await saveTravel(env, acct, rec);
      return { ...base, ok: true, travelLabel: 'finished', msg: rec.message, travel: acct.travel };
    }
    const rec = { ...common, label: 'arrived', message: claim.msg || '已到达，等待领取' };
    await saveTravel(env, acct, rec);
    return { ...base, ok: false, travelLabel: 'arrived', msg: rec.message, travel: acct.travel };
  }

  // idle：官网把「今日次数用完」也返回 idle，必须看 daily_limit_reached
  if (status.dailyLimit) {
    const rec = { ...common, label: 'finished', message: '今日旅行已完成（累了，明天再来吧）' };
    await saveTravel(env, acct, rec);
    return { ...base, ok: true, travelLabel: 'finished', msg: rec.message, travel: acct.travel };
  }

  const mayDepart = allowDepart == null ? acct.autoTravel !== false : allowDepart;
  if (!mayDepart) {
    const rec = { label: 'untraveled', state: 'idle', locationName: status.locationName, message: '今日尚未派发' };
    await saveTravel(env, acct, rec);
    return { ...base, ok: true, travelLabel: 'untraveled', msg: rec.message, travel: acct.travel };
  }

  const dep = await departTravel(env, acct);
  if (dep.ok) {
    if (dep.dailyLimit) {
      const rec = { ...common, label: 'finished', state: 'idle', message: '今日已派' };
      await saveTravel(env, acct, rec);
      return { ...base, ok: true, travelLabel: 'finished', msg: rec.message, travel: acct.travel };
    }
    // 派发成功后回查一次，拿到到达时间和积分预览
    const after = await fetchTravelStatus(env, acct).catch(() => null);
    const okAfter = after && after.ok;
    const rec = {
      label: okAfter && after.state === 'arrived' ? 'arrived' : 'traveling',
      state: okAfter ? after.state : 'traveling',
      locationName: (okAfter && after.locationName) || dep.locationName || '',
      departAt: okAfter ? after.departAt : 0,
      arriveAt: okAfter ? after.arriveAt : 0,
      dailyLimit: false,
      recordId: okAfter ? after.recordId : 0,
      rewardCredit: okAfter ? after.rewardCredit : null,
      message: '已派出猫猫去旅行',
    };
    await saveTravel(env, acct, rec);
    return { ...base, ok: true, travelLabel: rec.label, msg: rec.message, travel: acct.travel };
  }

  const rec = {
    ...common,
    label: dep.kind === 'no-buddy' ? 'no-buddy' : dep.kind === 'no-location' ? 'no-location' : 'error',
    message: dep.msg || '派发失败',
  };
  await saveTravel(env, acct, rec);
  return { ...base, ok: false, travelLabel: rec.label, msg: rec.message, travel: acct.travel };
}

async function runTravel(env, { id = '', onlyAuto = true } = {}) {
  const list = await listAccounts(env);
  const results = [];
  for (const meta of list) {
    if (id && meta.id !== id) continue;
    const acct = await getAccount(env, meta.id);
    if (!acct || acct.enabled === false) continue;
    if (!id && onlyAuto && acct.autoTravel === false) continue;
    try {
      results.push(await travelSync(env, acct, { allowDepart: id ? true : null }));
    } catch (e) {
      results.push({ id: acct.id, label: acct.label, platform: 'workbuddy', ok: false, travelLabel: 'error', msg: e.message });
    }
  }
  return {
    accounts: results.length,
    traveling: results.filter((r) => r.travelLabel === 'traveling').length,
    finished: results.filter((r) => r.travelLabel === 'finished').length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

async function setAutoTravel(env, id, on) {
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  acct.autoTravel = !!on;
  await putAccount(env, acct);
  return { id, autoTravel: !!on };
}

/** 旅行总入口：sync / depart / claim / run / auto-on / auto-off */
async function travel(env, { id = '', action = 'sync' } = {}) {
  if (action === 'auto-on' || action === 'auto-off') {
    return { ok: true, ...(await setAutoTravel(env, id, action === 'auto-on')) };
  }
  if (action === 'run') return { ok: true, ...(await runTravel(env, { id, onlyAuto: false })) };
  if (!id) return { ok: false, error: '缺少 id' };

  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');

  let result;
  if (action === 'depart') result = await travelSync(env, acct, { allowDepart: true });
  else if (action === 'claim') result = await travelSync(env, acct, { allowDepart: false });
  else result = await travelSync(env, acct, { allowDepart: null });

  const now = Date.now();
  return {
    ok: result.ok,
    account: publicView(acct, now, bjDayOf(now)),
    result,
  };
}

/** 资源包列表按口径汇总：剩余到底该取哪一列，先让这些数字互相对上 */
function summarizeResource(json) {
  const d = json?.data?.Response?.Data || json?.data || {};
  const rows = Array.isArray(d.Accounts) ? d.Accounts : [];
  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  const sum = (f) => rows.reduce((s, a) => s + num(a?.[f]), 0);
  const grantOf = (a) => ((a.AccountAttributes || []).find((x) => x.Key === 'grantSource') || {}).Value || 'unknown';
  const byGrant = {};
  for (const a of rows) {
    const src = grantOf(a);
    const rec = byGrant[src] || (byGrant[src] = { packages: 0, size: 0, used: 0, remain: 0 });
    rec.packages += 1;
    rec.size += num(a.CapacitySize);
    rec.used += num(a.CapacityUsed);
    rec.remain += num(a.CapacityRemainPrecise ?? a.CapacityRemain);
  }
  const newest = rows.slice(-2).map((a) => ({
    grant: grantOf(a),
    size: num(a.CapacitySize),
    used: num(a.CapacityUsed),
    remain: num(a.CapacityRemain),
    cycleSize: num(a.CycleCapacitySize),
    cycleUsed: num(a.CycleCapacityUsed),
    cycleRemain: num(a.CycleCapacityRemain),
    expired: a.ExpiredTime || '',
    status: a.Status,
  }));
  return {
    totalCount: d.TotalCount ?? null,
    totalDosage: d.TotalDosage ?? null,
    packages: rows.length,
    sumSize: sum('CapacitySize'),
    sumUsed: sum('CapacityUsed'),
    sumRemain: sum('CapacityRemain'),
    sumRemainPrecise: rows.reduce((s, a) => s + num(a.CapacityRemainPrecise), 0),
    sumCycleSize: sum('CycleCapacitySize'),
    sumCycleUsed: sum('CycleCapacityUsed'),
    sumCycleRemain: sum('CycleCapacityRemain'),
    sumCycleRemainPrecise: rows.reduce((s, a) => s + num(a.CycleCapacityRemainPrecise), 0),
    byGrant,
    newest,
  };
}

/**
 * 只读诊断：用账号自己的令牌把候选余额接口的原始返回倒出来。
 * 不返回任何令牌，只给状态码和字段，用来确认真实余额落在哪个字段上。
 */
async function inspectBalance(env, id) {
  const metas = id ? [{ id }] : await listAccounts(env);
  const out = [];
  for (const meta of metas) {
    const acct = await getAccount(env, meta.id);
    if (!acct) continue;

    let at = String(acct.accessToken || '');
    let tokenError = '';
    try {
      at = await ensureAccess(env, acct);
    } catch (e) {
      tokenError = e.message;
    }

    const calls = [];
    if (at) {
      const probes = [
        ['get-user-resource', '/v2/billing/meter/get-user-resource', '{}'],
        ['get-user-resource+usage', '/v2/billing/meter/get-user-resource', '{"require_usage":true}'],
        ['checkin-status', '/v2/billing/meter/checkin-status', '{}'],
      ];
      for (const [name, path, body] of probes) {
        try {
          const r = await wbFetch(path, { headers: authHeader(at), body });
          const call = {
            name,
            status: r.status,
            code: r.json?.code ?? null,
            msg: r.json?.msg ?? r.json?.message ?? '',
            data: JSON.stringify(r.json?.data ?? r.json ?? null).slice(0, 4000),
          };
          if (name.startsWith('get-user-resource') && r.json?.data) call.summary = summarizeResource(r.json);
          calls.push(call);
        } catch (e) {
          calls.push({ name, error: e.message });
        }
      }
    }
    out.push({ id: acct.id, label: acct.label, streak: acct.streak, total: acct.total, tokenError, calls });
  }
  return { ok: true, at: SH.fmtBj(Date.now()), accounts: out };
}

/* ------------------------------------------------------------------ */
/* 单个账号的完整签到流程                                               */
/*                                                                     */
/* 关键原则：                                                            */
/*   1. 只有服务端回查 confirmed 才算成功，接口 code=0 只是「已提交」。   */
/*   2. 失败/待确认不写 lastOkDate，下一轮 Cron 会自动重试。             */
/*   3. 令牌能复用就复用，轮换后立刻落盘，避免一次性 RT 被浪费。         */
/* ------------------------------------------------------------------ */

async function signinOne(env, acct, { force = false } = {}) {
  const now = Date.now();
  const today = SH.bjDay(now);
  const wasVerified = acct.verifiedDate === today;
  const base = { id: acct.id, label: acct.label, platform: 'workbuddy' };

  if (acct.enabled === false) {
    return { ...base, state: 'disabled', msg: '账号已停用' };
  }

  // 只有「服务端确认过」才允许跳过；仅本地乐观标记不算
  if (!force && acct.verifiedDate === today) {
    return { ...base, state: 'skipped', verified: true, msg: '今日已确认签到' };
  }

  // 1) 令牌：复用未过期的 accessToken，避免无谓轮换
  try {
    await ensureAccess(env, acct);
  } catch (e) {
    // 续期失败但手上的 accessToken 还没过期：先用它完成今天，别直接断签
    const exp = accessExpOf(acct);
    const usable = !!acct.accessToken && (!exp || exp > Date.now());
    if (!usable) {
      acct.lastState = e.fatal ? 'token_dead' : 'error';
      acct.lastMsg = e.message;
      acct.lastRun = now;
      await putAccount(env, acct);
      return { ...base, state: acct.lastState, msg: e.message };
    }
  }

  // 2) 先查状态：已经签过就不发写请求
  let before = await statusOnce(acct);
  if (before.ok) {
    acct.streak = before.data.streak_days ?? acct.streak ?? null;
    acct.total = before.data.total_credits ?? acct.total ?? null;
    if (before.checked) {
      acct.verifiedDate = today;
      acct.verifiedAt = now;
      acct.lastOkDate = today;
      acct.lastState = 'already';
      acct.lastMsg = '服务端确认今日已签';
      acct.lastRun = now;
      acct.cooldownUntil = 0;
      bumpStreak(acct, today);
      await putAccount(env, acct);
      return { ...base, state: 'already', verified: true, msg: acct.lastMsg, streak: acct.streak, total: acct.total };
    }
  }

  // 3) 执行签到：网络异常/5xx 重试一次；401 强制轮换一次令牌
  let result = null;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(1500);
    try {
      const { status, json } = await wbFetch('/v2/billing/meter/daily-checkin', {
        headers: wbAuthHeaders(acct),
      });
      if (status === 401 || status === 403) {
        lastErr = `HTTP ${status}`;
        if (attempt === 0) {
          try {
            await rotateAccess(env, acct);
            continue;
          } catch (e) {
            lastErr = e.message;
            break;
          }
        }
        break;
      }
      if (status === 429) {
        acct.cooldownUntil = now + 30 * 60000;
        acct.lastState = 'rate';
        acct.lastMsg = '平台限流（HTTP 429），30 分钟后重试';
        acct.lastRun = now;
        await putAccount(env, acct);
        return { ...base, state: 'rate', msg: acct.lastMsg };
      }
      const msg = String(json?.msg ?? json?.message ?? '');
      if (json?.code === 0) {
        result = { state: 'checked', credit: SH.num(json.data?.credit ?? json.data?.credits ?? json.data?.reward) };
        break;
      }
      if (json?.code === 10001 || /已签|已领|重复|already/i.test(msg)) {
        result = { state: 'already', credit: 0 };
        break;
      }
      lastErr = `code=${json?.code ?? status} ${msg}`.trim();
      // 5xx 或未知业务码：再试一次
    } catch (e) {
      lastErr = e.message;
    }
  }

  // 4) 回查确认：接口说成功不等于真到账，必须让服务端点头
  const confirm = await confirmChecked(acct, { tries: 3, delay: 1200 });
  const statusUnavailable = !confirm.status || confirm.status.ok !== true;
  const st = confirm.status && confirm.status.ok ? confirm.status.data : null;
  if (st) {
    acct.streak = st.streak_days ?? acct.streak ?? null;
    acct.total = st.total_credits ?? acct.total ?? null;
  }

  // 状态接口本身不可用时，「已签到」是服务端给出的明确断言，可以采信；
  // 但「签到成功」仍保持待确认，等状态接口恢复后再复核。
  const alreadyProof = statusUnavailable && result && result.state === 'already';
  acct.lastRun = now;
  if (confirm.confirmed || alreadyProof) {
    acct.verifiedDate = today;
    acct.verifiedAt = now;
    acct.lastOkDate = today;
    acct.lastState = result && result.state === 'already' ? 'already' : 'checked';
    const credit = result && result.state === 'checked' ? result.credit : null;
    acct.lastMsg = result && result.state === 'already'
      ? '服务端确认今日已签'
      : (credit != null ? `签到成功 +${credit} 积分（已复核）` : '签到成功（已复核）');
    acct.cooldownUntil = 0;
    bumpStreak(acct, today);
    if (!acct.lastCreditDate || acct.lastCreditDate !== today) {
      acct.lastCredit = credit;
      acct.lastCreditDate = today;
    }
    if (!wasVerified) acct.totalSigned = (acct.totalSigned ?? 0) + 1;
  } else if (result && result.state !== 'error') {
    // 接口看起来成功，但服务端还没记账：不写成功日期，下一轮继续复查
    acct.lastState = 'unverified';
    acct.lastMsg = result.state === 'already'
      ? '接口提示今日已签，服务端状态尚未确认，稍后自动复查'
      : '接口已受理，服务端状态尚未确认，稍后自动复查';
  } else {
    acct.lastState = 'error';
    acct.lastMsg = `签到失败：${lastErr || '未知错误'}`;
  }

  // 余额不是签到必需项，6 小时内查过就复用，省子请求配额
  if (!acct.balanceAt || now - Number(acct.balanceAt) > 6 * 3600e3) {
    const bal = await fetchBalance(acct).catch(() => null);
    if (bal) {
      acct.credits = bal.credits;
      acct.dosage = bal.dosage;
      acct.balanceAt = now;
    }
  }

  await putAccount(env, acct);
  return {
    ...base,
    state: acct.lastState,
    verified: !!(confirm.confirmed || alreadyProof),
    msg: acct.lastMsg,
    credit: (confirm.confirmed || alreadyProof) && result && result.state === 'checked' ? result.credit : null,
    streak: acct.streak ?? null,
    total: acct.total ?? null,
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
  const verified = a.verifiedDate === today;
  return {
    id: a.id,
    label: a.label,
    uid: a.uid || '',
    enabled: a.enabled !== false,
    lastState: a.lastState,
    lastMsg: a.lastMsg,
    lastRun: a.lastRun ? new Date(a.lastRun + 8 * 3600e3).toISOString().replace('Z', ' +08:00') : null,
    lastOkDate: a.lastOkDate ?? null,
    lastCredit: creditToday ? (a.lastCredit ?? null) : null,
    streak: a.streak ?? a.streakLocal ?? null,
    total: a.total ?? null,
    // credits 只放真实余额，本期累计留在 total，两者口径不同
    credits: typeof a.credits === 'number' ? a.credits : null,
    totalSigned: a.totalSigned ?? 0,
    credExp: a.refreshExp || null,
    credKind: 'refresh',
    today,
    signedToday: verified,
    verified,
    verifiedAt: a.verifiedAt || null,
    ranToday: a.lastRun ? bjDayOf(a.lastRun) === today : false,
    // 成长中心 · 派猫猫旅行（仅国内版，国际版没有这个活动）
    autoTravel: a.autoTravel !== false,
    travel: a.travel
      ? {
          label: a.travel.label || 'untraveled',
          state: a.travel.state || '',
          locationName: a.travel.locationName || '',
          rewardCredit: typeof a.travel.rewardCredit === 'number' ? a.travel.rewardCredit : null,
          departAt: Number(a.travel.departAt) || 0,
          arriveAt: Number(a.travel.arriveAt) || 0,
          dailyLimit: a.travel.dailyLimit === true,
          message: a.travel.message || '',
          checkedAt: Number(a.travel.checkedAt) || 0,
          claimedAt: Number(a.travel.claimedAt) || 0,
        }
      : { label: 'untraveled', state: '', locationName: '', rewardCredit: null, departAt: 0, arriveAt: 0, dailyLimit: false, message: '今日尚未派发', checkedAt: 0, claimedAt: 0 },
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

/** 只查状态与连签，不签到。用于控制台「刷新 / 复查」。 */
async function refreshOne(env, id) {
  const now = Date.now();
  const today = bjDayOf(now);
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');

  try {
    await ensureAccess(env, acct);
  } catch (e) {
    acct.lastState = 'token_dead';
    acct.lastMsg = e.message;
    acct.lastRun = now;
    await putAccount(env, acct);
    return publicView(acct, now, today);
  }

  const st = await statusOnce(acct);
  if (st.ok) {
    acct.streak = st.data.streak_days ?? acct.streak ?? null;
    acct.total = st.data.total_credits ?? acct.total ?? null;
    acct.verified = st.checked;
    if (st.checked) {
      acct.verifiedDate = today;
      acct.verifiedAt = now;
      acct.lastOkDate = today;
      acct.cooldownUntil = 0;
      bumpStreak(acct, today);
      if (acct.lastState !== 'checked') {
        acct.lastState = 'already';
        acct.lastMsg = '服务端确认今日已签';
      }
    } else if (acct.lastState === 'unverified') {
      acct.lastMsg = '服务端仍未确认今日签到，稍后自动重试';
    }
  }
  const bal = await fetchBalance(acct).catch(() => null);
  if (bal) {
    acct.credits = bal.credits;
    acct.dosage = bal.dosage;
  }
  await putAccount(env, acct);
  return publicView(acct, now, today);
}

async function run(env, { force = false, id = '' } = {}) {
  const list = await listAccounts(env);
  const results = [];
  const retryIds = [];
  for (const meta of list) {
    if (id && meta.id !== id) continue;
    const a = await getAccount(env, meta.id);
    if (!a) continue;
    try {
      const r = await signinOne(env, a, { force });
      results.push({ platform: 'workbuddy', ...r });
      if (['error', 'unverified', 'pending'].includes(r.state)) retryIds.push(meta.id);
    } catch (e) {
      results.push({ id: a.id, label: a.label, platform: 'workbuddy', state: 'error', msg: e.message });
      retryIds.push(meta.id);
    }
  }

  // 同一轮里给失败/待确认的账号一次补救机会（网络抖动、状态延迟最常见）
  if (retryIds.length) {
    await sleep(2500);
    for (const rid of retryIds) {
      const a = await getAccount(env, rid).catch(() => null);
      if (!a) continue;
      try {
        const r = await signinOne(env, a, { force: true });
        const idx = results.findIndex((x) => x.id === rid);
        if (idx >= 0) results[idx] = { platform: 'workbuddy', ...r };
      } catch {
        /* 补救失败保留第一次的结论 */
      }
    }
  }

  // 签到收尾后顺带同步成长中心旅行：已到达就领、未派就派。
  // 旅行失败不影响签到结论，单独放在 travels 里返回。
  let travels = { accounts: 0, results: [] };
  try {
    travels = await runTravel(env, { id, onlyAuto: true });
  } catch (e) {
    travels = { accounts: 0, results: [], error: e.message };
  }

  return {
    at: new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', ' +08:00'),
    accounts: results.length,
    checked: results.filter((r) => r.state === 'checked').length,
    already: results.filter((r) => r.state === 'already' || r.state === 'skipped').length,
    failed: results.filter((r) => r.state === 'error' || r.state === 'token_dead').length,
    cooling: results.filter((r) => ['rate', 'cooldown', 'pending', 'unverified'].includes(r.state)).length,
    results,
    travels: travels.results || [],
    travelSummary: {
      accounts: travels.accounts || 0,
      traveling: travels.traveling || 0,
      finished: travels.finished || 0,
      failed: travels.failed || 0,
      error: travels.error || '',
    },
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
      if (path === '/api/inspect' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        try {
          return json(await inspectBalance(env, id));
        } catch (e) {
          return json({ error: e.message }, 502);
        }
      }
      if (path === '/api/travel' && method === 'POST') {
        const body = await readBody(request);
        try {
          return json(await travel(env, {
            id: String(body.id ?? '').trim(),
            action: String(body.action ?? 'sync').trim(),
          }));
        } catch (e) {
          return json({ error: e.message }, 400);
        }
      }
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
  travel,
  setAutoTravel,
};
})();
/* ================================================================== */
/* 平台七：Qoder（国内版 qoder.com.cn + 国际版 qoder.com）              */
/*                                                                     */
/*   GET  /device/selectAccounts?…              官网授权页，用户自己确认 */
/*   GET  /api/v1/deviceToken/poll              PKCE 轮询设备令牌        */
/*   POST /api/v1/deviceToken/refresh           续期（RT 每次轮换）      */
/*   GET  /sash/api/v1/me/campaigns             活动列表                */
/*   POST /sash/api/v1/me/campaigns/{id}/claim  领取                    */
/*                                                                     */
/* 两区路径一样、域名不一样：国内版 openapi.qoder.com.cn，国际版          */
/* openapi.qoder.sh，账号登录态不通用，所以每个账号要记住自己的 region。 */
/* 国内版「每日签到送 100 Credits」档期 2026-07-30 已结束，现在每日档期   */
/* 在国际版：10:00（UTC+8）开一窗，次日 10:00 前关，一窗只能领一次。      */
/* cosy-* 三件套是「设备通行证」：服务端按自报版本 + 设备身份决定下发哪些 */
/* 活动，缺任一件就退化成只发营销卡（VIEW_DETAILS），拿不到每日 credits。 */
/* 服务端还会按设备判重（同设备重复登录记录会直接不给领取），所以设备名   */
/* 跟着 machineId 走，不能让所有账号共用一个 DESKTOP。                   */
/* ================================================================== */

const Qoder = (() => {
const REGIONS = {
  cn: {
    key: 'cn',
    label: '国内版',
    web: 'https://qoder.com.cn',
    api: 'https://openapi.qoder.com.cn',
    clientId: '1c5e33e1-364d-4ce6-b02c-acaa81274a5c',
    redirectUri: 'qoder-work-cn://',
    ua: 'QoderWork/1.1.75',
    nonceDashed: true,
  },
  intl: {
    key: 'intl',
    label: '国际版',
    web: 'https://qoder.com',
    api: 'https://openapi.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    redirectUri: '',
    ua: 'Qoder/1.1.75',
    nonceDashed: false,
  },
};

function normRegion(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'intl' || s === 'international' || s === 'global') return 'intl';
  return 'cn';
}

/** 老账号没有 region 字段，一律按国内版处理，不能猜成国际版 */
function regionOf(acct) {
  return REGIONS[normRegion(acct && acct.region)];
}

const EP = {
  devicePage: '/device/selectAccounts',
  poll: '/api/v1/deviceToken/poll',
  refresh: '/api/v1/deviceToken/refresh',
  campaigns: '/sash/api/v1/me/campaigns',
  /* 旧版「每日签到」：活动平台没下发活动时的主通道，国内版实测可用 */
  checkinStatus: '/sash/api/v1/me/daily-check-in/status',
  checkinClaim: '/sash/api/v1/me/daily-check-in/claim',
};

const UA = 'Qoder';
const PROXY_UA = 'qoder-local-proxy';
const CLIENT_TYPE = '10';
const LANG = 'zh-CN';
/* 自报版本决定服务端下发哪批活动：0.4.8 有每日 credits，0.2.5 只有营销卡 */
const CLIENT_VERSION = '0.4.8';
const MACHINE_OS = 'x86_64_win32';
const LOGIN_TTL = 900;
const COOLDOWN_MIN = 30;
/* 领取是写操作，成功/失败都要回查；活动列表偶发返回空，允许短退避重取 */
const CAMPAIGN_RETRY_DELAYS = [800, 2000];

const CLAIMABLE_RE = /^(CLAIMABLE|UNCLAIMED|UN_CLAIMED|NOT_CLAIMED|CAN_CLAIM|TO_CLAIM|RECEIVABLE|AVAILABLE|PENDING_CLAIM|INIT)$/i;
const CLAIMED_RE = /^(CLAIMED|ALREADY_CLAIMED|RECEIVED|GRANTED|DONE|USED)$/i;
const CLOSED_RE = /^(DISABLED|OFFLINE|INACTIVE|ENDED|FINISHED|EXPIRED|CLOSED|NOT_OPEN|UNSUPPORTED)$/i;
/* 营销卡排最后：它动作名也叫 VIEW_DETAILS，抢在前面就会把每日活动挤掉 */
const ACTION_PRIORITY = ['CLAIM_BENEFIT', 'DAILY_CHECKIN', 'SIGN_IN', 'VIEW_DETAILS'];
const ACTION_CLAIM = /^(CLAIM_BENEFIT|DAILY_CHECKIN|SIGN_IN|CLAIM|CHECK_IN)$/i;

/** 设备名跟着 machineId 走，避免所有账号共用一个 DESKTOP 被判同设备重复登录 */
function hostNameOf(acct) {
  const mid = String(acct && acct.machineId ? acct.machineId : '').replace(/[^a-z0-9]/gi, '');
  return mid ? 'DESKTOP-' + mid.slice(0, 8).toUpperCase() : 'DESKTOP';
}

const vault = SH.makeVault('qoder-signin/v1/account');
const INDEX_KEY = 'index:accounts';
const acctKey = (id) => `acct:${id}`;
const loginKey = (nonce) => `login:${nonce}`;

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
  if (!SH.timingSafeEqual(given, env.ADMIN_TOKEN)) return { ok: false, res: json({ error: '登录密码不正确' }, 401) };
  return { ok: true };
}

async function sha256B64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', SH.enc.encode(text));
  return SH.b64urlEncode(new Uint8Array(digest));
}

/**
 * 业务请求头：只发官方桌面端真正会发的那几项。
 *
 * 重要：不要再自行拼 cosy-machine* 全套。服务端会把「派生出来的六件套」
 * 判定为非官方客户端，直接把 CLAIMABLE 的每日 Credits 活动整条过滤掉，
 * 表现就是「活动列表里什么都没有，但官方客户端明明能领」。
 * 没有真实 machineToken 时，一个机器头都不发是最稳的（CN/INTL 实测）。
 */
function authHeaders(at, acct, extra) {
  const h = {
    accept: 'application/json',
    'user-agent': UA,
    authorization: `Bearer ${at}`,
    'cosy-clienttype': CLIENT_TYPE,
    'cosy-version': CLIENT_VERSION,
    'accept-language': LANG,
  };
  return extra ? Object.assign(h, extra) : h;
}

function qFetch(region, path, { method = 'GET', headers = {}, body } = {}) {
  const reg = typeof region === 'string' ? REGIONS[normRegion(region)] : (region || REGIONS.cn);
  return SH.httpJson(reg.api + path, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
}

/* ------------------------------------------------------------------ */
/* 设备授权                                                            */
/* ------------------------------------------------------------------ */

async function loginStart(region) {
  const reg = REGIONS[normRegion(region)];
  const verifier = SH.randomId(32);
  const challenge = await sha256B64Url(verifier);
  // CN 的 nonce 是带横线的 UUID，intl 是 32 位 hex
  const nonce = reg.nonceDashed
    ? (crypto.randomUUID ? crypto.randomUUID() : SH.randomHex(16))
    : SH.randomHex(16);
  const machineId = crypto.randomUUID();

  const pairs = [['challenge', challenge], ['challenge_method', 'S256'], ['nonce', nonce]];
  if (reg.redirectUri) pairs.push(['redirect_uri', reg.redirectUri]);
  if (reg.clientId) pairs.push(['client_id', reg.clientId]);
  pairs.push(['machine_id', machineId]);

  const authUrl = `${reg.web}${EP.devicePage}?${pairs
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')}`;

  return { verifier, challenge, nonce, machineId, authUrl, region: reg.key };
}

/** 202 / 404 都算「用户还没确认」，不算失败 */
async function loginPoll(region, nonce, verifier) {
  const reg = REGIONS[normRegion(region)];
  const q = `?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`;
  const r = await qFetch(reg.key, EP.poll + q, {
    headers: { Accept: 'application/json', 'User-Agent': reg.ua },
  });
  if (r.status === 202 || r.status === 404) return { pending: true };
  if (r.status >= 400) return { pending: false, error: `授权轮询失败（HTTP ${r.status}）` };
  const d = r.json && typeof r.json.data === 'object' && r.json.data ? r.json.data : (r.json || {});
  const accessToken = String(d.token || d.device_token || d.deviceToken || d.access_token || '').trim();
  if (!accessToken) return { pending: true };
  return {
    pending: false,
    accessToken,
    refreshToken: String(d.refresh_token || d.refreshToken || '').trim(),
    uid: String(d.user_id || d.userId || '').trim(),
    email: String(d.email || d.user_email || '').trim(),
  };
}

/** refreshToken 会轮换，换到的必须立刻回写。drt-=设备令牌，jrt-=jobToken */
async function refreshTokens(acct) {
  const rt = String(acct.refreshToken || '').trim();
  const reg = regionOf(acct);
  if (!rt) {
    if (acct.personalToken) {
      const got = await exchangePersonalToken(reg, acct.personalToken);
      acct.accessToken = got.accessToken;
      if (got.refreshToken) acct.refreshToken = got.refreshToken;
      acct.credExp = SH.jwtExp(got.accessToken) ? SH.jwtExp(got.accessToken) * 1000 : 0;
      return got.accessToken;
    }
    const e = new Error('账号缺少 refreshToken，无法续期，请删掉重新添加');
    e.fatal = true;
    throw e;
  }

  const path = rt.startsWith('jrt-') ? '/api/v1/jobToken/refresh' : EP.refresh;
  const r = await qFetch(reg, path, {
    method: 'POST',
    headers: { 'user-agent': PROXY_UA, 'content-type': 'application/json', accept: 'application/json' },
    body: { refresh_token: rt },
  });
  if (r.status === 401 || r.status === 403) {
    if (acct.personalToken) {
      const got = await exchangePersonalToken(reg, acct.personalToken);
      acct.accessToken = got.accessToken;
      if (got.refreshToken) acct.refreshToken = got.refreshToken;
      acct.credExp = SH.jwtExp(got.accessToken) ? SH.jwtExp(got.accessToken) * 1000 : 0;
      return got.accessToken;
    }
    const e = new Error('refreshToken 已失效，请删掉重新添加');
    e.fatal = true;
    throw e;
  }
  if (r.status >= 400) throw new Error(`令牌续期失败（HTTP ${r.status}）`);
  const d = r.json && typeof r.json.data === 'object' && r.json.data ? r.json.data : (r.json || {});
  const token = String(d.device_token || d.job_token || d.jobToken || d.deviceToken || d.token || d.access_token || '').trim();
  if (!token) throw new Error('续期响应里没有新的 access token');
  acct.accessToken = token;
  const nr = String(d.refresh_token || d.refreshToken || '').trim();
  if (nr) acct.refreshToken = nr;
  acct.tokenRefreshedAt = Date.now();
  acct.credExp = SH.jwtExp(token) ? SH.jwtExp(token) * 1000 : 0;
  return token;
}

async function ensureToken(acct) {
  const exp = Number(acct.credExp || 0);
  if (acct.accessToken && (!exp || exp - Date.now() > 5 * 60 * 1000)) return acct.accessToken;
  if (acct.accessToken && !exp) return acct.accessToken;
  return refreshTokens(acct);
}

/** 401/403 时强制换一次令牌；轮换结果由调用方落盘 */
async function rotateToken(acct) {
  const token = await refreshTokens(acct);
  acct.accessToken = token;
  acct.tokenRefreshedAt = Date.now();
  acct.credExp = SH.jwtExp(token) ? SH.jwtExp(token) * 1000 : 0;
  return token;
}

/* ------------------------------------------------------------------ */
/* 活动列表与领取                                                      */
/* ------------------------------------------------------------------ */

function campaignRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.campaigns,
    payload.data?.campaigns,
    payload.data?.list,
    payload.data?.items,
    payload.data?.records,
    payload.list,
    payload.items,
    Array.isArray(payload.data) ? payload.data : null,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

const statusOf = (row) =>
  String(row.status ?? row.state ?? row.claimStatus ?? row.claim_status ?? row.campaignStatus ?? row.campaign_status ?? '');
const actionOf = (row) =>
  String(row.action ?? row.actionType ?? row.action_type ?? row.campaignType ?? row.campaign_type ?? row.type ?? '');

function idOf(row) {
  for (const k of ['campaignId', 'campaign_id', 'campaignKey', 'campaign_key', 'key', 'id']) {
    const v = row && row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** 活动档期时间戳：上游给的是秒，容错成毫秒 */
function windowOf(row) {
  const toMs = (v) => {
    const n = SH.num(v);
    if (n == null) return null;
    return n < 1e11 ? n * 1000 : n;
  };
  return {
    start: toMs(row.startAt ?? row.start_at ?? row.startTime),
    end: toMs(row.endAt ?? row.end_at ?? row.endTime),
  };
}

/** now 相对档期：future=还没开，past=已经收，now=在窗内 */
function windowPhase(row, now) {
  const w = windowOf(row);
  if (w.start != null && now < w.start) return 'future';
  if (w.end != null && now > w.end) return 'past';
  return 'now';
}

const isClaimableRow = (row) =>
  CLAIMABLE_RE.test(statusOf(row)) || row.claimable === true || row.canClaim === true || row.can_claim === true;

function amountOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const direct = SH.num(obj.credits ?? obj.creditAmount ?? obj.credit_amount);
  if (direct != null) return direct;
  for (const k of ['benefit', 'reward']) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const n = SH.num(v.amount ?? v.credits);
      if (n != null) return n;
    } else {
      const n = SH.num(v);
      if (n != null) return n;
    }
  }
  return SH.num(obj.amount);
}

/** 活动列表的外层：顶层 showCampaign / claimable / campaignUrl 才是官方给的总开关 */
function campaignEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return { rows: [] };
  const inner = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
  return {
    rows: campaignRows(payload),
    show: inner.showCampaign ?? inner.show_campaign ?? payload.showCampaign,
    claimable: inner.claimable ?? inner.canClaim ?? payload.claimable,
    url: String(inner.campaignUrl ?? inner.campaign_url ?? payload.campaignUrl ?? ''),
  };
}

function rowLabel(row) {
  const key = row.campaignKey || row.campaign_key || idOf(row);
  const status = statusOf(row) || '?';
  return key ? `${key}(${status})` : status;
}

/** 活动奖励：Credits 类才是「每日签到」；券/兑换码另算 */
function benefitOf(row) {
  const b = row && row.benefit;
  if (b && typeof b === 'object') {
    return { kind: String(b.kind || b.type || '').toUpperCase(), amount: SH.num(b.amount ?? b.credits) };
  }
  return { kind: '', amount: amountOf(row) };
}

function isDailyCredits(row) {
  const b = benefitOf(row);
  if (b.kind) return b.kind === 'CREDITS';
  return (b.amount || 0) > 0 || ACTION_CLAIM.test(actionOf(row));
}

/** 领取动作只认这几种；纯 VIEW_DETAILS 的营销卡不能点 */
function isClaimAction(row) {
  const a = actionOf(row).toUpperCase();
  return a === '' || ACTION_CLAIM.test(a);
}

/**
 * 这一轮到底该干什么：可领 / 本档期已领 / 档期已结束或未开放 / 窗口还没开 / 空。
 * 枚举服务端会改，所以顶层说「能领」但行里筛不到时，兜底挑一行真去试一次，
 * claim 是幂等的，试错不会重复加分；但绝不能因为不认识枚举就报「无活动」。
 *
 * 另一个坑：领取成功后官方会把 actionType 降级成 VIEW_DETAILS（国际版实测），
 * 所以「已领」必须先按 benefit.amount / CLAIMED 归类，再看 actionType。
 */
function classifyCampaigns(payload, now) {
  const env = campaignEnvelope(payload);
  const rows = env.rows;
  const seen = rows.map(rowLabel).join('、');

  if (!rows.length) {
    if (env.show === false) {
      return { kind: 'closed', total: 0, seen, reason: '官方在该区不再展示签到活动（showCampaign=false）' };
    }
    return { kind: 'empty', total: 0, seen, reason: '接口没返回任何活动' };
  }

  const inOpen = rows.filter((r) => windowPhase(r, now) === 'now');

  const claimable = inOpen
    .filter((r) => isClaimableRow(r) && idOf(r) && isClaimAction(r))
    .sort((a, b) => {
      // 每日 Credits 优先，其次按动作优先级；奖励大的排前面
      const da = isDailyCredits(a) ? 0 : 1;
      const db = isDailyCredits(b) ? 0 : 1;
      if (da !== db) return da - db;
      const ia = ACTION_PRIORITY.indexOf(actionOf(a).toUpperCase());
      const ib = ACTION_PRIORITY.indexOf(actionOf(b).toUpperCase());
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return (benefitOf(b).amount || 0) - (benefitOf(a).amount || 0);
    });
  if (claimable.length) {
    return { kind: 'claim', target: claimable[0], candidates: claimable, total: rows.length, seen };
  }

  if (env.claimable === true) {
    const guess = inOpen.find(
      (r) => idOf(r) && isClaimAction(r) && !CLAIMED_RE.test(statusOf(r)) && !CLOSED_RE.test(statusOf(r))
    );
    if (guess) return { kind: 'claim', target: guess, fallback: true, total: rows.length, seen };
  }

  const claimedNow = inOpen.find((r) => {
    if (!CLAIMED_RE.test(statusOf(r))) return false;
    const b = benefitOf(r);
    return (b.amount || 0) > 0 || isClaimAction(r);
  });
  if (claimedNow) {
    return {
      kind: 'already',
      target: claimedNow,
      daily: isDailyCredits(claimedNow),
      total: rows.length,
      seen,
      reason: `本档期已领取（${rowLabel(claimedNow)}）`,
    };
  }

  const future = rows
    .filter((r) => windowPhase(r, now) === 'future')
    .sort((a, b) => (windowOf(a).start || 0) - (windowOf(b).start || 0));
  if (future.length) {
    const start = windowOf(future[0]).start;
    return { kind: 'future', retryAt: start, total: rows.length, seen, reason: `领取窗口 ${SH.fmtBjShort(start)} 开启` };
  }

  const disabled = rows.find((r) => CLOSED_RE.test(statusOf(r)));
  if (disabled) {
    return { kind: 'closed', total: rows.length, seen, reason: `活动未开放或被下线（${rowLabel(disabled)}）` };
  }
  const past = rows
    .filter((r) => windowPhase(r, now) === 'past')
    .sort((a, b) => (windowOf(b).end || 0) - (windowOf(a).end || 0))[0];
  const endText = past && windowOf(past).end ? `，${SH.fmtBjShort(windowOf(past).end)} 结束` : '';
  const marketing = rows.every((r) => actionOf(r).toUpperCase() === 'VIEW_DETAILS') ? '，只有营销活动' : '';
  return { kind: 'closed', total: rows.length, seen, reason: `档期已结束${endText}${marketing}` };
}

async function fetchCampaigns(acct, { force = true } = {}) {
  const at = await ensureToken(acct);
  return qFetch(regionOf(acct), EP.campaigns + (force ? '?forceRefresh=true' : ''), { headers: authHeaders(at, acct) });
}

/**
 * 取活动列表并给「空结果/无可领项」一次短退避重试。
 * 上游偶发返回空（实测 10 次里 2 次），一次空结果就放弃会让当天直接漏签。
 */
async function fetchCampaignsWithRetry(acct, now = Date.now()) {
  let res = await fetchCampaigns(acct, { force: true });
  let plan = res.status < 400 ? classifyCampaigns(res.json, now) : null;
  for (const wait of CAMPAIGN_RETRY_DELAYS) {
    const needsRetry = !plan || plan.kind === 'empty' || (plan.kind === 'closed' && plan.total === 0);
    if (!needsRetry) break;
    await sleep(wait);
    const again = await fetchCampaigns(acct, { force: true });
    if (again.status < 400) {
      res = again;
      plan = classifyCampaigns(again.json, now);
    }
  }
  return { res, plan: plan || classifyCampaigns(res.json, now) };
}

async function claimCampaign(acct, campaignId) {
  const at = await ensureToken(acct);
  const reg = regionOf(acct);
  return qFetch(reg.key, `${EP.campaigns}/${encodeURIComponent(campaignId)}/claim`, {
    method: 'POST',
    headers: authHeaders(at, acct, { 'content-type': 'application/json', accept: 'application/json' }),
    body: {},
  });
}

/* ---------------- 旧版每日签到（活动平台之外的第二条通道） ---------------- */

function todayBj() {
  return SH.bjDay(Date.now());
}

function parseDailyStatus(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const status = String(d.status || d.claimStatus || '').toUpperCase();
  const last = d.lastClaimedAt ?? d.last_claimed_at ?? d.lastCheckinAt ?? 0;
  let lastDay = '';
  if (last) {
    const n = SH.num(last);
    if (n != null) lastDay = SH.bjDay(n < 1e11 ? n * 1000 : n);
    else lastDay = String(last).slice(0, 10);
  }
  const today = todayBj();
  return {
    ok: true,
    status,
    // 有些账号的响应不带 lastClaimedAt，只有 CLAIMED；此时按已签处理，
    // 否则会陷入「接口说已签、状态却永远无法确认」的循环。
    checked: status === 'CLAIMED' && (!lastDay || lastDay === today),
    active: status === 'CLAIMABLE' || status === 'CLAIMED',
    streak: SH.num(d.currentStreakDays ?? d.streak_days ?? d.currentStreak),
    totalDays: SH.num(d.totalClaimDays ?? d.total_claim_days),
    reward: SH.num(d.rewardCredits ?? d.reward_credits),
    lastDay,
    raw,
  };
}

async function dailyCheckinStatus(acct) {
  const at = await ensureToken(acct);
  const r = await qFetch(regionOf(acct), EP.checkinStatus, { headers: authHeaders(at, acct) });
  if (r.status === 404 || r.status === 405 || r.status === 410) {
    return { ok: false, unavailable: true, http: r.status };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, authFailed: true, http: r.status };
  if (r.status >= 400) return { ok: false, http: r.status, msg: r.json?.msg || r.text.slice(0, 120) };
  return parseDailyStatus(r.json);
}

async function claimDailyCheckin(acct) {
  const at = await ensureToken(acct);
  const reg = regionOf(acct);
  const r = await qFetch(reg.key, EP.checkinClaim, {
    method: 'POST',
    headers: authHeaders(at, acct, { 'content-type': 'application/json' }),
    body: {},
  });
  const body = r.json && typeof r.json === 'object' ? r.json : {};
  const text = JSON.stringify(body);
  const result = String(body.result || body.data?.result || '').toUpperCase();
  if (r.status === 409 || result === 'ALREADY_CLAIMED' || /ALREADY_CLAIMED|已签到|重复领取/.test(text)) {
    return { ok: true, already: true, message: '今日已签到' };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, authFailed: true, message: '凭证失效' };
  if (r.status >= 400 || body.success === false) {
    return { ok: false, message: String(body.error || body.msg || body.message || `HTTP ${r.status}`).slice(0, 160) };
  }
  const reward = SH.num(body.rewardCredits ?? body.data?.rewardCredits);
  return { ok: true, already: false, reward, message: reward != null ? `签到成功 +${reward} Credits` : '签到成功' };
}

/** 只读诊断：把活动列表原始返回倒出来，确认「无活动」是真的没有还是没解析到 */
async function inspectCampaigns(env, id) {
  const metas = id ? [{ id }] : await listRaw(env);
  const out = [];
  for (const meta of metas) {
    const acct = await getAccount(env, meta.id);
    if (!acct) continue;

    let at = String(acct.accessToken || '');
    let tokenError = '';
    try {
      const exp = SH.jwtExp(at);
      if (!(at && exp && exp * 1000 - Date.now() > 120000)) {
        at = await refreshTokens(acct);
        await putAccount(env, acct);
      }
    } catch (e) {
      tokenError = e.message;
    }

    const calls = [];
    if (at) {
      for (const [name, qs] of [['campaigns+force', '?forceRefresh=true'], ['campaigns', '']]) {
        try {
          const r = await qFetch(regionOf(acct), EP.campaigns + qs, { headers: authHeaders(at, acct) });
          const rows = campaignRows(r.json);
          const plan = classifyCampaigns(r.json, Date.now());
          calls.push({
            name,
            status: r.status,
            code: r.json?.code ?? null,
            msg: r.json?.msg ?? r.json?.message ?? '',
            rows: rows.length,
            plan: {
              kind: plan.kind,
              target: plan.target ? { id: idOf(plan.target), status: statusOf(plan.target), action: actionOf(plan.target) } : null,
              reason: plan.reason || '',
              retryAt: plan.retryAt || null,
              total: plan.total,
              seen: plan.seen || '',
            },
            sample: rows.slice(0, 6).map((x) => ({
              id: idOf(x),
              status: statusOf(x),
              action: actionOf(x),
              title: x.title ?? x.name ?? x.campaignName ?? '',
              keys: Object.keys(x).slice(0, 16),
            })),
            raw: JSON.stringify(r.json ?? null).slice(0, 5000),
          });
        } catch (e) {
          calls.push({ name, error: e.message });
        }
      }
    }
    out.push({ id: acct.id, label: acct.label, uid: acct.uid || '', tokenError, calls });
  }
  return { ok: true, at: SH.fmtBj(Date.now()), accounts: out };
}

/* ------------------------------------------------------------------ */
/* 签到编排                                                            */
/*                                                                     */
/* 双通道 + 强制复核：                                                   */
/*   A. /sash/api/v1/me/daily-check-in/*  旧版每日签到（国内版主通道）    */
/*   B. /sash/api/v1/me/campaigns/*      活动平台（每日 Credits / 福利） */
/*                                                                     */
/* 只有「回查看到 CLAIMED / 今日已签」才算成功；接口 200 只算已提交。    */
/* ------------------------------------------------------------------ */

function findCampaignRow(payload, id) {
  const want = String(id || '');
  return campaignRows(payload).find((r) => idOf(r) === want) || null;
}

async function campaignsConfirmed(acct, campaignId) {
  const r = await fetchCampaigns(acct, { force: true });
  if (r.status >= 400) return { ok: false, http: r.status };
  const row = findCampaignRow(r.json, campaignId);
  if (row && CLAIMED_RE.test(statusOf(row))) return { ok: true, row };
  const plan = classifyCampaigns(r.json, Date.now());
  if (plan.kind === 'already' && plan.daily) return { ok: true, row: plan.target || null };
  return { ok: false, row };
}

async function dailyConfirmed(acct, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(900 * i);
    const st = await dailyCheckinStatus(acct).catch(() => null);
    if (st && st.ok && st.checked) return st;
  }
  return null;
}

async function claimCampaignVerified(env, acct, target) {
  const cid = idOf(target);
  const points = benefitOf(target).amount ?? amountOf(target);
  let lastErr = '';
  let already = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(1500);
    let res;
    try {
      res = await claimCampaign(acct, cid);
    } catch (e) {
      lastErr = e.message;
      continue;
    }
    if (res.status === 429) return { state: 'rate', msg: '领取过于频繁（HTTP 429）' };

    const body = res.json || {};
    const text = JSON.stringify(body);
    const failure = String(body.failureCode || body.failure_code || body.code || '').toUpperCase();
    // 同人去重可能以 403 返回，必须先在响应体里识别，不能当凭证失效
    if (/SAME_PERSON_ALREADY_CLAIMED/.test(text) || /SAME_PERSON_ALREADY_CLAIMED/.test(failure)) {
      return {
        state: 'blocked',
        msg: '同一设备/身份下的其他账号本轮已领取（服务端按人去重）',
        cooldownMs: 6 * 3600e3,
      };
    }
    if (res.status === 401 || res.status === 403) {
      await rotateToken(acct);
      await putAccount(env, acct);
      lastErr = `HTTP ${res.status}`;
      continue;
    }
    if (res.status === 409 || String(body.result || '').toUpperCase() === 'ALREADY_CLAIMED' || body.replayed === true) {
      already = true;
    } else if (res.status >= 400) {
      lastErr = `领取失败（HTTP ${res.status}）${failure ? ' ' + failure : ''}`;
      continue;
    } else if (body.success === false && !CLAIMED_RE.test(String(body.status || ''))) {
      lastErr = String(body.error || body.msg || '领取返回失败');
      continue;
    }

    // 写操作后必须回查，不能拿 200 当成功
    const verify = await campaignsConfirmed(acct, cid);
    if (verify.ok) {
      return {
        state: already ? 'already' : 'checked',
        credit: already ? null : points,
        msg: already ? '今日已领取（复核确认）' : `领取成功${points != null ? ' +' + points + ' Credits' : ''}（已复核）`,
      };
    }
    lastErr = '领取接口已返回，但服务端活动状态尚未变成 CLAIMED';
  }

  // 活动平台没确认时，再看一眼旧版每日签到（部分账号两条通道共用同一份额度）
  const daily = await dailyConfirmed(acct, { tries: 2 });
  if (daily) {
    return { state: 'checked', credit: points, msg: `已复核确认（连续 ${daily.streak ?? 0} 天）` };
  }
  return { state: 'unverified', msg: lastErr || '领取已提交，服务端状态尚未确认，稍后自动复查' };
}

async function claimDailyVerified(env, acct) {
  let res = await claimDailyCheckin(acct).catch((e) => ({ ok: false, message: e.message }));
  if (res.authFailed) {
    await rotateToken(acct);
    await putAccount(env, acct);
    res = await claimDailyCheckin(acct).catch((e) => ({ ok: false, message: e.message }));
  }
  const confirmed = await dailyConfirmed(acct, { tries: 3 });
  if (confirmed) {
    return {
      state: res.already ? 'already' : 'checked',
      credit: res.already ? null : (res.reward ?? confirmed.reward ?? null),
      streak: confirmed.streak ?? null,
      msg: res.already ? '今日已签到（复核确认）' : `签到成功${confirmed.reward != null ? ' +' + confirmed.reward + ' Credits' : ''}（已复核）`,
    };
  }
  if (res.ok) {
    return { state: 'unverified', msg: '签到接口已受理，服务端状态尚未确认，稍后自动复查' };
  }
  return { state: 'error', msg: res.message || '签到失败' };
}

async function signinOne(env, acct, { force = false } = {}) {
  const now = Date.now();
  const today = SH.bjDay(now);
  const wasVerified = acct.verifiedDate === today;
  const base = { id: acct.id, label: acct.label, platform: 'qoder' };
  acct.lastRun = now;

  if (acct.enabled === false) {
    return { ...base, state: 'disabled', msg: '账号已停用' };
  }
  if (!force && Number(acct.cooldownUntil || 0) > now) {
    return { ...base, state: 'cooldown', msg: `冷却中，还有 ${Math.ceil((acct.cooldownUntil - now) / 60000)} 分钟` };
  }
  if (!force && acct.verifiedDate === today) {
    return { ...base, state: 'skipped', verified: true, msg: '今日已确认领取' };
  }

  // 1) 令牌：复用未过期 accessToken；即将过期才轮换
  try {
    await ensureToken(acct);
    await putAccount(env, acct);
  } catch (e) {
    acct.lastState = e.fatal ? 'token_dead' : 'error';
    acct.lastMsg = e.message;
    await putAccount(env, acct);
    return { ...base, state: acct.lastState, msg: acct.lastMsg };
  }

  // 2) 通道 A：旧版每日签到（国内版）
  let daily = await dailyCheckinStatus(acct).catch((e) => ({ ok: false, msg: e.message }));
  if (daily.authFailed) {
    try {
      await rotateToken(acct);
      await putAccount(env, acct);
      daily = await dailyCheckinStatus(acct).catch(() => ({ ok: false }));
    } catch (e) {
      acct.lastState = 'token_dead';
      acct.lastMsg = e.message;
      await putAccount(env, acct);
      return { ...base, state: 'token_dead', msg: acct.lastMsg };
    }
  }
  if (daily.ok && daily.checked) {
    acct.verifiedDate = today;
    acct.verifiedAt = now;
    acct.lastOkDate = today;
    acct.lastState = 'already';
    acct.lastMsg = '服务端确认今日已签到';
    acct.streak = daily.streak ?? acct.streak ?? null;
    acct.cooldownUntil = 0;
    bumpStreak(acct, today);
    await putAccount(env, acct);
    return { ...base, state: 'already', verified: true, msg: acct.lastMsg, streak: acct.streak };
  }

  // 3) 通道 B：活动平台（空结果自动短退避重取）
  let plan = null;
  let listRes = null;
  try {
    const got = await fetchCampaignsWithRetry(acct, now);
    listRes = got.res;
    plan = got.plan;
  } catch (e) {
    acct.lastState = 'error';
    acct.lastMsg = `活动列表请求异常: ${e.message}`;
    await putAccount(env, acct);
    return { ...base, state: 'error', msg: acct.lastMsg };
  }

  if (listRes.status === 429) {
    acct.lastState = 'rate';
    acct.lastMsg = '请求过于频繁（HTTP 429）';
    acct.cooldownUntil = now + COOLDOWN_MIN * 60000;
    await putAccount(env, acct);
    return { ...base, state: 'rate', msg: acct.lastMsg };
  }
  if (listRes.status === 401 || listRes.status === 403) {
    acct.lastState = 'token_dead';
    acct.lastMsg = `活动列表拒绝访问（HTTP ${listRes.status}），请删除后重新授权`;
    await putAccount(env, acct);
    return { ...base, state: 'token_dead', msg: acct.lastMsg };
  }
  if (listRes.status >= 400) {
    acct.lastState = 'error';
    acct.lastMsg = `活动列表失败（HTTP ${listRes.status}）`;
    await putAccount(env, acct);
    return { ...base, state: 'error', msg: acct.lastMsg };
  }

  // 4) 按活动状态决定动作
  let outcome = null;
  if (plan.kind === 'claim') {
    outcome = await claimCampaignVerified(env, acct, plan.target);
  } else if (plan.kind === 'already' && (plan.daily || (daily.ok && daily.checked))) {
    outcome = { state: 'already', msg: '服务端活动状态为 CLAIMED（今日已领）' };
  } else if (daily.ok && daily.active && !daily.checked) {
    outcome = await claimDailyVerified(env, acct);
  } else {
    const reason = plan.reason || (daily.ok ? `签到活动未开放（status=${daily.status || '?'}）` : '暂无可领活动');
    outcome = { state: 'no_activity', msg: reason };
  }

  if (outcome.state === 'rate') {
    acct.lastState = 'rate';
    acct.lastMsg = outcome.msg;
    acct.cooldownUntil = now + COOLDOWN_MIN * 60000;
    await putAccount(env, acct);
    return { ...base, state: 'rate', msg: acct.lastMsg };
  }
  if (outcome.state === 'blocked') {
    acct.lastState = 'blocked';
    acct.lastMsg = outcome.msg;
    acct.cooldownUntil = now + Number(outcome.cooldownMs || 6 * 3600e3);
    await putAccount(env, acct);
    return { ...base, state: 'blocked', msg: acct.lastMsg };
  }
  if (outcome.state === 'unverified') {
    acct.lastState = 'unverified';
    acct.lastMsg = outcome.msg;
    await putAccount(env, acct);
    return { ...base, state: 'unverified', verified: false, msg: acct.lastMsg };
  }
  if (outcome.state === 'error') {
    acct.lastState = 'error';
    acct.lastMsg = outcome.msg;
    await putAccount(env, acct);
    return { ...base, state: 'error', msg: acct.lastMsg };
  }
  if (outcome.state === 'no_activity') {
    acct.lastState = 'no_activity';
    acct.lastMsg = outcome.msg;
    acct.lastRun = now;
    await putAccount(env, acct);
    return { ...base, state: 'no_activity', msg: acct.lastMsg };
  }

  // 5) 已复核的成功
  const already = outcome.state === 'already';
  acct.verifiedDate = today;
  acct.verifiedAt = now;
  acct.lastOkDate = today;
  acct.lastState = already ? 'already' : 'checked';
  acct.lastMsg = outcome.msg;
  acct.cooldownUntil = 0;
  acct.streak = outcome.streak ?? daily.streak ?? acct.streak ?? null;
  if (!already) {
    acct.lastCredit = outcome.credit ?? null;
    acct.lastCreditDate = today;
    acct.totalCredit = (acct.totalCredit || 0) + Number(outcome.credit || 0);
    if (!wasVerified) acct.totalSigned = (acct.totalSigned || 0) + 1;
  }
  bumpStreak(acct, today);

  if (!acct.balanceAt || now - Number(acct.balanceAt) > 6 * 3600e3) {
    const bal = await fetchCredits(acct).catch(() => null);
    if (bal != null) {
      acct.credits = bal;
      acct.balanceAt = now;
    }
  }

  await putAccount(env, acct);
  return {
    ...base,
    state: acct.lastState,
    verified: true,
    msg: acct.lastMsg,
    credit: already ? null : (outcome.credit ?? null),
    credits: acct.credits ?? null,
    streak: acct.streak ?? null,
    totalCredit: acct.totalCredit,
  };
}

/** 只读刷新：重查两条通道，把「今日是否已领」对上，不领取 */
async function refreshOne(env, id) {
  const now = Date.now();
  const today = SH.bjDay(now);
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  try {
    await ensureToken(acct);
    const daily = await dailyCheckinStatus(acct).catch(() => null);
    if (daily && daily.ok) {
      acct.streak = daily.streak ?? acct.streak ?? null;
      if (daily.checked) {
        acct.verifiedDate = today;
        acct.verifiedAt = now;
        acct.lastOkDate = today;
        acct.lastState = 'already';
        acct.lastMsg = '服务端确认今日已签到';
        bumpStreak(acct, today);
      }
    }
    const r = await fetchCampaigns(acct, { force: true });
    if (r.status < 400) {
      const plan = classifyCampaigns(r.json, now);
      if (plan.kind === 'already' || (daily && daily.checked)) {
        acct.verifiedDate = today;
        acct.verifiedAt = acct.verifiedAt || now;
        acct.lastOkDate = today;
        if (acct.lastState !== 'checked') {
          acct.lastState = 'already';
          acct.lastMsg = acct.lastMsg && /确认/.test(acct.lastMsg) ? acct.lastMsg : '服务端显示今日已领取';
        }
        bumpStreak(acct, today);
      }
    } else if (r.status === 401 || r.status === 403) {
      acct.lastState = 'token_dead';
      acct.lastMsg = '凭证失效，请删除后重新授权';
    }
    const bal = await fetchCredits(acct).catch(() => null);
    if (bal != null) acct.credits = bal;
  } catch (e) {
    if (e.fatal) {
      acct.lastState = 'token_dead';
      acct.lastMsg = e.message;
    }
  }
  await putAccount(env, acct);
  return publicView(acct, now, today);
}

/** 积分余额：官方 0.4.8 的 quota/usage，读失败不影响签到 */
async function fetchCredits(acct) {
  const at = await ensureToken(acct);
  const r = await qFetch(regionOf(acct), '/api/v2/quota/usage', { headers: authHeaders(at, acct) });
  if (r.status >= 400 || !r.json) return null;
  const d = r.json.data && typeof r.json.data === 'object' ? r.json.data : r.json;
  for (const k of ['remainingCredits', 'remainCredits', 'availableCredits', 'creditsRemaining', 'balance']) {
    const v = SH.num(d[k]);
    if (v != null) return Math.round(v * 100) / 100;
  }
  return null;
}

function publicView(a, now, today) {
  const creditToday = a.lastCreditDate ? a.lastCreditDate === today : false;
  const verified = a.verifiedDate === today;
  return {
    id: a.id,
    label: a.label,
    enabled: a.enabled !== false,
    lastState: a.lastState,
    lastMsg: a.lastMsg,
    lastRun: a.lastRun ? SH.fmtBj(a.lastRun) : null,
    lastOkDate: a.lastOkDate ?? null,
    lastCredit: creditToday ? (a.lastCredit ?? null) : null,
    credits: typeof a.credits === 'number' ? a.credits : null,
    total: null,
    streak: a.streak ?? null,
    totalSigned: a.totalSigned ?? 0,
    totalCredit: a.totalCredit ?? 0,
    credExp: a.credExp || null,
    credKind: 'access',
    cooldownUntil: Number(a.cooldownUntil || 0) > now ? a.cooldownUntil : 0,
    signedToday: verified,
    verified,
    verifiedAt: a.verifiedAt || null,
    ranToday: a.lastRun ? SH.bjDay(a.lastRun) === today : false,
    platform: 'qoder',
    region: normRegion(a.region),
    regionLabel: REGIONS[normRegion(a.region)].label,
  };
}

async function list(env) {
  const entries = await listRaw(env);
  const now = Date.now();
  const today = SH.bjDay(now);
  const out = [];
  for (const meta of entries) {
    const a = await getAccount(env, meta.id).catch(() => null);
    if (!a) continue;
    out.push(publicView(a, now, today));
  }
  return { count: out.length, today, accounts: out };
}

async function run(env, { force = false, id = '' } = {}) {
  const entries = await listRaw(env);
  const results = [];
  const retryIds = [];
  for (const meta of entries) {
    if (id && meta.id !== id) continue;
    const acct = await getAccount(env, meta.id);
    if (!acct) continue;
    try {
      const r = await signinOne(env, acct, { force });
      results.push(r);
      if (['error', 'unverified'].includes(r.state)) retryIds.push(meta.id);
    } catch (e) {
      results.push({ id: acct.id, label: acct.label, platform: 'qoder', state: 'error', msg: e.message });
      retryIds.push(meta.id);
    }
  }

  // 上游偶发空列表/状态延迟：同一轮内补一次
  if (retryIds.length) {
    await sleep(2500);
    for (const rid of retryIds) {
      const acct = await getAccount(env, rid).catch(() => null);
      if (!acct) continue;
      try {
        const r = await signinOne(env, acct, { force: true });
        const idx = results.findIndex((x) => x.id === rid);
        if (idx >= 0) results[idx] = r;
      } catch {
        /* 保留第一次的结论 */
      }
    }
  }

  return {
    at: SH.fmtBj(Date.now()),
    accounts: results.length,
    checked: results.filter((r) => r.state === 'checked').length,
    already: results.filter((r) => r.state === 'already' || r.state === 'skipped').length,
    failed: results.filter((r) => r.state === 'error' || r.state === 'token_dead').length,
    cooling: results.filter((r) => ['rate', 'cooldown', 'unverified', 'blocked'].includes(r.state)).length,
    results,
  };
}

/** Qoder PAT（pt-）→ jobToken；PAT 最长可用一年，是设备授权失败时的备用入口 */
async function exchangePersonalToken(region, personalToken) {
  const r = await qFetch(region, '/api/v1/jobToken/exchange', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
    body: { personal_token: personalToken },
  });
  if (r.status >= 400) {
    throw new Error(`PAT 交换失败（HTTP ${r.status}）：${r.json?.message || r.json?.msg || ''}`.trim());
  }
  const d = r.json?.data && typeof r.json.data === 'object' ? r.json.data : (r.json || {});
  const token = String(d.token || d.jobToken || d.access_token || '').trim();
  if (!token) throw new Error('PAT 交换响应里没有 jobToken');
  return {
    accessToken: token,
    refreshToken: String(d.refresh_token || d.refreshToken || '').trim(),
    uid: String(d.uid || d.user_id || '').trim(),
    expireAt: SH.num(d.expire_time || d.expires_at || d.expiresAt),
  };
}

async function add(env, { creds = {}, label = '' } = {}) {
  let accessToken = SH.stripBearer(creds.access_token || creds.token || '');
  let refreshToken = String(creds.refresh_token || '').trim();
  const personalToken = String(creds.personal_token || '').trim();
  let uid = String(creds.uid || '').trim();
  const region = normRegion(creds.region);
  if (!accessToken && personalToken) {
    const got = await exchangePersonalToken(REGIONS[region], personalToken);
    accessToken = got.accessToken;
    refreshToken = got.refreshToken || refreshToken;
    uid = uid || got.uid;
  }
  if (!accessToken && !refreshToken) throw new Error('缺少 access_token / refresh_token / personal_token');
  const id = SH.randomId(9);
  const acct = {
    id,
    label: String(label).trim().slice(0, 40) || `Qoder-${id.slice(0, 4)}`,
    accessToken,
    refreshToken,
    personalToken,
    machineId: String(creds.machine_id || '').trim(),
    uid,
    region,
    createdAt: Date.now(),
    lastState: 'new',
    lastMsg: '尚未运行',
    verified: true,
    enabled: true,
    credExp: SH.jwtExp(accessToken) ? SH.jwtExp(accessToken) * 1000 : 0,
  };
  await putAccount(env, acct);
  const list = await listRaw(env);
  list.push({ id, label: acct.label, createdAt: acct.createdAt });
  await saveIndex(env, list);
  return { id: acct.id, label: acct.label, accounts: list.length };
}

async function removeAccount(env, id) {
  await env.PLATFORM_KV.delete(acctKey(id));
  const rest = (await listRaw(env)).filter((x) => x.id !== id);
  await saveIndex(env, rest);
  return { removed: id };
}

async function renameAccount(env, id, label) {
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  acct.label = label;
  await putAccount(env, acct);
  await saveIndex(env, (await listRaw(env)).map((x) => (x.id === id ? { ...x, label } : x)));
  return { id, label };
}

async function setEnabled(env, id, enabled) {
  const acct = await getAccount(env, id);
  if (!acct) throw new Error('账号不存在');
  acct.enabled = !!enabled;
  await putAccount(env, acct);
  return { id, enabled: !!enabled };
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
      if (path === '/api/inspect' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        try {
          return json(await inspectCampaigns(env, id));
        } catch (e) {
          return json({ error: e.message }, 502);
        }
      }
      if (path === '/api/login/start' && method === 'POST') {
        const body = await readBody(request);
        const s = await loginStart(body.region);
        await env.PLATFORM_KV.put(
          loginKey(s.nonce),
          await vault.seal(env, { verifier: s.verifier, machineId: s.machineId, region: s.region, at: Date.now() }),
          { expirationTtl: LOGIN_TTL }
        );
        return json({ ok: true, nonce: s.nonce, authUrl: s.authUrl, region: s.region, expiresIn: LOGIN_TTL });
      }
      if (path === '/api/login/poll' && method === 'GET') {
        const nonce = String(url.searchParams.get('nonce') || '').trim();
        if (!nonce) return json({ error: '缺少 nonce' }, 400);
        const raw = await env.PLATFORM_KV.get(loginKey(nonce));
        if (!raw) return json({ error: '授权会话已过期，请重新点「添加账号」' }, 400);
        const sess = await vault.open(env, raw);
        const got = await loginPoll(sess.region, nonce, sess.verifier);
        if (got.pending) return json({ pending: true });
        if (got.error) return json({ error: got.error }, 502);
        const acct = {
          id: SH.randomId(9),
          label: (got.email || `Qoder-${got.uid.slice(-4) || sess.machineId.slice(0, 4)}`).slice(0, 40),
          accessToken: got.accessToken,
          refreshToken: got.refreshToken,
          machineId: sess.machineId,
          uid: got.uid,
          region: normRegion(sess.region),
          createdAt: Date.now(),
          lastState: 'new',
          lastMsg: '尚未运行',
          verified: true,
          enabled: true,
          tokenRefreshedAt: Date.now(),
          credExp: SH.jwtExp(got.accessToken) ? SH.jwtExp(got.accessToken) * 1000 : 0,
        };
        await putAccount(env, acct);
        const list = await listRaw(env);
        list.push({ id: acct.id, label: acct.label, createdAt: acct.createdAt });
        await saveIndex(env, list);
        await env.PLATFORM_KV.delete(loginKey(nonce));
        return json({ ok: true, pending: false, account: publicView(acct, Date.now(), SH.bjDay()), accounts: list.length });
      }
      if (path === '/api/add' && method === 'POST') {
        const body = await readBody(request);
        try {
          return json({ ok: true, ...(await add(env, body)) });
        } catch (e) {
          return json({ error: e.message }, 400);
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
      streak: a.streak ?? a.streakLocal ?? null,
      total: a.total ?? null,
      totalSigned: a.totalSigned ?? 0,
      totalCredit: a.totalCredit ?? 0,
      credExp: a.credExp || null,
      credKind: META.credKind || 'static',
      cooldownUntil: Number(a.cooldownUntil || 0) > now ? a.cooldownUntil : 0,
      signedToday: a.verifiedDate === today || a.lastOkDate === today,
      verified: a.verifiedDate === today,
      verifiedAt: a.verifiedAt || null,
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
    const wasVerified = acct.verifiedDate === today;
    const base = { id: acct.id, label: acct.label, platform: META.key };

    if (acct.enabled === false) return { ...base, state: 'disabled', msg: '账号已停用' };

    if (!force && Number(acct.cooldownUntil || 0) > now) {
      const left = Math.ceil((Number(acct.cooldownUntil) - now) / 60000);
      return { ...base, state: 'cooldown', msg: `限流冷却中，约 ${left} 分钟` };
    }

    if (!force && acct.verifiedDate === today) {
      return { ...base, state: 'skipped', verified: true, msg: '今日已确认' };
    }
    if (
      !force &&
      acct.lastOkDate === today &&
      (acct.lastState === 'checked' || acct.lastState === 'already')
    ) {
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

    // 0) 平台自带完整流程（多步接口 / 签名 / 回查）：交给 cfg.checkin
    if (cfg.checkin) {
      let r;
      try {
        r = await cfg.checkin(env, prepared, acct);
      } catch (e) {
        acct.lastState = e.auth ? 'token_dead' : 'error';
        acct.lastMsg = e.message;
        acct.lastRun = now;
        await putAccount(env, acct);
        return { ...base, state: acct.lastState, msg: acct.lastMsg };
      }
      if (r.creds) acct.creds = r.creds;
      if (r.credits != null) acct.credits = r.credits;
      if (r.streak != null) acct.streak = r.streak;
      if (r.credExp) acct.credExp = r.credExp;
      if (r.uid) acct.uid = r.uid;
      acct.lastRun = now;
      if (r.state === 'checked' || r.state === 'already') {
        const verified = r.verified !== false;
        if (verified) {
          acct.verifiedDate = today;
          acct.verifiedAt = now;
          acct.lastOkDate = today;
          acct.noActivityDate = 0;
          acct.cooldownUntil = 0;
          bumpStreak(acct, today);
          if (r.state === 'checked') {
            acct.lastCredit = r.credit ?? null;
            acct.lastCreditDate = today;
            if (r.credit != null) acct.totalCredit = (acct.totalCredit || 0) + Number(r.credit || 0);
            if (!wasVerified) acct.totalSigned = (acct.totalSigned || 0) + 1;
          }
        }
        acct.lastState = verified ? r.state : 'unverified';
        acct.lastMsg = r.msg || (verified ? '签到成功' : '接口已受理，服务端尚未确认');
        await putAccount(env, acct);
        return {
          ...base,
          state: acct.lastState,
          verified,
          msg: acct.lastMsg,
          credit: verified && r.state === 'checked' ? (r.credit ?? null) : null,
          credits: acct.credits ?? null,
          streak: acct.streak ?? null,
        };
      }
      if (r.state === 'no_activity') {
        acct.lastState = 'no_activity';
        acct.lastMsg = r.msg || '当前没有可签到的活动';
        acct.noActivityDate = today;
        await putAccount(env, acct);
        return { ...base, state: 'no_activity', msg: acct.lastMsg, credits: acct.credits ?? null };
      }
      if (r.state === 'rate' || r.state === 'blocked') {
        acct.lastState = r.state;
        acct.lastMsg = r.msg || '限流';
        acct.cooldownUntil = now + Number(r.cooldownMs || 30 * 60000);
        await putAccount(env, acct);
        return { ...base, state: r.state, msg: acct.lastMsg };
      }
      acct.lastState = r.auth ? 'token_dead' : (r.state || 'error');
      acct.lastMsg = r.msg || '签到失败';
      await putAccount(env, acct);
      return { ...base, state: acct.lastState, msg: acct.lastMsg };
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
        bumpStreak(acct, today);
        acct.noActivityDate = 0;
        acct.lastState = 'already';
        acct.lastMsg = '今日已签';
        acct.lastRun = now;
        acct.cooldownUntil = 0;
        await putAccount(env, acct);
        return { ...base, state: 'already', msg: acct.lastMsg, credits: acct.credits ?? null };
      }
    }

    // 2) 领取（各平台都是幂等的）；网络抖动/5xx 再试一次
    let cl = null;
    let claimErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(1500);
      try {
        cl = await readClaim(env, prepared);
        break;
      } catch (e) {
        claimErr = e.message;
        cl = null;
      }
    }
    if (!cl) {
      acct.lastState = 'error';
      acct.lastMsg = `签到请求异常: ${claimErr}`;
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

    // 3) 成功 / 今日已领 —— 再回查一次，只有服务端确认才落成功日期
    let verified = true;
    let verifyMsg = '';
    if (typeof cfg.verify === 'function') {
      try {
        const v = await cfg.verify(env, prepared, cl);
        verified = v !== false;
        if (v && v.message) verifyMsg = v.message;
      } catch {
        verified = true; // 复核本身失败不推翻已经成功的领取结果
      }
    } else if (cfg.urls && cl.already !== true) {
      try {
        const st2 = await readStatus(env, prepared);
        if (st2 && st2.ok && st2.trustworthy !== false && st2.checked === false) {
          verified = false;
          verifyMsg = '接口已受理，服务端状态尚未确认';
        }
      } catch {
        /* 状态查询失败不阻塞 */
      }
    }

    if (!verified) {
      acct.lastState = 'unverified';
      acct.lastMsg = verifyMsg || '接口已受理，服务端状态尚未确认，稍后自动复查';
      await putAccount(env, acct);
      return { ...base, state: 'unverified', verified: false, msg: acct.lastMsg };
    }

    acct.verifiedDate = today;
    acct.verifiedAt = now;
    acct.lastOkDate = today;
    bumpStreak(acct, today);
    acct.noActivityDate = 0;
    acct.lastState = cl.already ? 'already' : 'checked';
    acct.lastMsg = (cl.message || (cl.already ? '今日已签' : '签到成功')) + (verifyMsg ? '；' + verifyMsg : '');
    acct.cooldownUntil = 0;
    if (!cl.already) {
      acct.lastCredit = cl.credit ?? null;
      acct.lastCreditDate = today;
      if (cl.credit != null) acct.totalCredit = (acct.totalCredit || 0) + Number(cl.credit || 0);
      if (!wasVerified) acct.totalSigned = (acct.totalSigned || 0) + 1;
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
      verified: true,
      msg: acct.lastMsg,
      credit: cl.already ? null : cl.credit ?? null,
      credits: acct.credits ?? null,
      streak: acct.streak ?? acct.streakLocal ?? null,
    };
  }

  async function run(env, { force = false, id = '' } = {}) {
    const entries = await listRaw(env);
    const results = [];
    const retryIds = [];
    for (const meta of entries) {
      if (id && meta.id !== id) continue;
      const a = await getAccount(env, meta.id).catch(() => null);
      if (!a) continue;
      try {
        const r = await runOne(env, a, { force });
        results.push(r);
        if (['error', 'unverified'].includes(r.state)) retryIds.push(meta.id);
      } catch (e) {
        results.push({ id: a.id, label: a.label, platform: META.key, state: 'error', msg: e.message });
        retryIds.push(meta.id);
      }
    }

    // 同一轮内给失败/待确认的账号一次补救机会
    if (retryIds.length) {
      await sleep(2500);
      for (const rid of retryIds) {
        const a = await getAccount(env, rid).catch(() => null);
        if (!a) continue;
        try {
          const r = await runOne(env, a, { force: true });
          const idx = results.findIndex((x) => x.id === rid);
          if (idx >= 0) results[idx] = r;
        } catch {
          /* 保留第一次结论 */
        }
      }
    }

    return {
      at: SH.fmtBj(Date.now()),
      accounts: results.length,
      checked: results.filter((r) => r.state === 'checked').length,
      already: results.filter((r) => ['already', 'skipped'].includes(r.state)).length,
      failed: results.filter((r) => ['error', 'token_dead'].includes(r.state)).length,
      cooling: results.filter((r) => ['rate', 'cooldown', 'pending', 'unverified', 'blocked'].includes(r.state)).length,
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
        acct.verifiedDate = today;
        acct.verifiedAt = now;
        acct.lastOkDate = today;
        bumpStreak(acct, today);
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
/* 平台七～九：MiniMax Code / 百度搭子 DuMate / LobsterAI              */
/*                                                                     */
/* 这三个平台都是「粘贴凭证 + 多步接口」，用 cfg.checkin 完整接管：       */
/*   - 先查状态，已签就跳过                                             */
/*   - 领取后再查一次状态，确认到账才算成功                              */
/*   - 令牌可续期，续期结果立刻写回账号记录                              */
/* ================================================================== */

/* ---------------- MiniMax Code ---------------- */

const MINIMAX_HOSTS = ['https://agent.minimax.cn', 'https://agent.minimaxi.com'];
const MINIMAX_OAUTH = 'https://account.minimax.cn/oauth2/token';
const MINIMAX_DEVICE_ORDER = [
  'device_platform', 'biz_id', 'app_id', 'version_code', 'unix',
  'timezone_offset', 'is_desktop', 'desktop_version', 'sys_language',
  'lang', 'uuid', 'device_id', 'os_name', 'browser_name', 'device_memory',
  'cpu_core_num', 'browser_language', 'browser_platform', 'user_id',
  'op_ticket', 'screen_width', 'screen_height',
];

function minimaxEnc(v) {
  return encodeURIComponent(String(v));
}

function minimaxSign(pathWithQuery, bodyStr, nowMs) {
  const sec = Math.floor(nowMs / 1000);
  const inner = SH.md5(String(nowMs));
  return {
    signature: SH.md5(`${sec}I*7Cf%WZ#S&%1RlZJ&C2${bodyStr}`),
    yy: SH.md5(`${minimaxEnc(pathWithQuery)}_${'{}'}${inner}ooui`),
    sec,
  };
}

function minimaxEnvelopeOk(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const br = payload.base_resp;
  if (br && typeof br === 'object' && Number(br.status_code) === 0) return true;
  const code = Number(payload.code);
  if (Number.isFinite(code) && (code === 0 || code === 200)) return true;
  return payload.success === true || String(payload.status || '').toLowerCase() === 'success';
}

async function minimaxOauthRefresh(creds) {
  if (!creds.refresh_token) return null;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    client_id: 'mcode-public',
    scope: 'agent.default',
    audience: 'agent-backend',
  }).toString();
  const r = await SH.httpJson(MINIMAX_OAUTH, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const d = r.json || {};
  const at = String(d.access_token || '');
  if (!at) return null;
  return {
    access_token: at,
    refresh_token: String(d.refresh_token || creds.refresh_token || ''),
    expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  };
}

function minimaxParams(prepared, nowMs) {
  const claims = SH.jwtClaims(prepared.access_token);
  const seed = String(prepared.device_id || prepared.uuid || claims.device_id || prepared.access_token || '');
  const hash = SH.md5('minimax:' + seed);
  return {
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: String(prepared.version_code || '22201'),
    unix: String(nowMs),
    timezone_offset: '28800',
    is_desktop: '1',
    desktop_version: String(prepared.desktop_version || '3.1.4'),
    sys_language: 'zh',
    lang: 'zh',
    uuid: String(prepared.uuid || (hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-4' + hash.slice(13, 16) + '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32))),
    device_id: String(prepared.device_id || hash.slice(0, 16)),
    os_name: 'Windows',
    browser_name: 'Chrome',
    device_memory: '16',
    cpu_core_num: '4',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    user_id: String(prepared.user_id || claims.user_id || claims.uid || claims.sub || ''),
    op_ticket: 'undefined',
    screen_width: '1366',
    screen_height: '768',
  };
}

async function minimaxCall(prepared, path, method, body = {}) {
  const nowMs = Date.now();
  const params = minimaxParams(prepared, nowMs);
  params.client = 'desktop';
  const qs = MINIMAX_DEVICE_ORDER.concat(['client'])
    .map((k) => `${k}=${encodeURIComponent(params[k] ?? '')}`)
    .join('&');
  const bodyStr = method === 'GET' ? '' : JSON.stringify(body);
  const full = `${path}?${qs}`;
  const { signature, yy, sec } = minimaxSign(full, bodyStr, nowMs);
  const headers = {
    yy,
    'x-timestamp': String(sec),
    'x-signature': signature,
    origin: 'https://agent.minimax.cn',
    referer: 'https://agent.minimax.cn/',
    accept: 'application/json, text/plain, */*',
    'user-agent': 'MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.280 Safari/537.36 MiniMax/3.1.4',
  };
  if (prepared.access_token.startsWith('mmoat_') || prepared.refresh_token || prepared.expires_at) headers.Authorization = 'Bearer ' + prepared.access_token;
  else headers.token = prepared.access_token;
  if (method !== 'GET') headers['content-type'] = 'application/json';

  let last = null;
  for (const host of MINIMAX_HOSTS) {
    try {
      last = await SH.httpJson(host + full, { method, headers, body: bodyStr || undefined, timeout: 20000 });
      if (last.status !== 404) return last;
    } catch {
      /* 换下一个 host */
    }
  }
  return last || { status: 0, json: null, text: '' };
}

async function minimaxBalance(prepared) {
  const r = await minimaxCall(prepared, '/matrix/api/v1/commerce/get_membership_info', 'POST', {});
  if (!minimaxEnvelopeOk(r.json)) return null;
  const raw = r.json?.op_credit_summary?.total_remaining_amount;
  return SH.num(raw);
}

const MiniMax = createTokenPlatform({
  keyInfo: 'minimax-signin/v1/account',
  meta: {
    key: 'minimax',
    label: 'MiniMax Code',
    accent: 'amber',
    verified: false,
    verifiedNote: '接口与签名按桌面端 3.1.4 复刻；如换版本可用字段覆盖 version_code / desktop_version',
    addMode: 'token',
    defaultHost: 'agent.minimax.cn',
    supportsRefresh: true,
    credKind: 'access',
    fields: [
      { name: 'access_token', label: 'access_token', required: true, secret: true, placeholder: 'mmoat_… 或 local-runtime 里的 JWT' },
      { name: 'refresh_token', label: 'refresh_token', optional: true, secret: true, placeholder: 'mmort_…（OAuth 令牌建议填，1 小时自动续期）' },
      { name: 'device_id', label: 'device_id', optional: true, placeholder: '可留空；从客户端日志里取更稳' },
      { name: 'uuid', label: 'uuid', optional: true, placeholder: '可留空' },
      { name: 'user_id', label: 'user_id', optional: true, placeholder: '可留空；JWT 里有就用 JWT 的' },
    ],
    hint: '从 ~/.minimax/auth/prod/cn/mcode-public/auth.json 取 accessToken / refreshToken；device_id 可留空自动派生。',
    note: '签到是每日 OP 积分（默认 400/天，第 4/7 天有额外奖励）。',
  },
  primaryFields: ['access_token'],
  normalize: (c) => ({
    access_token: SH.stripBearer(c.access_token),
    refresh_token: String(c.refresh_token || '').trim(),
    device_id: String(c.device_id || '').trim(),
    uuid: String(c.uuid || '').trim(),
    user_id: String(c.user_id || '').trim(),
    version_code: String(c.version_code || '').trim(),
    desktop_version: String(c.desktop_version || '').trim(),
  }),
  identity: (c) => {
    const claims = SH.jwtClaims(c.access_token);
    if (!claims || !Object.keys(claims).length) return {};
    return {
      uid: String(claims.uid || claims.user_id || claims.sub || ''),
      label: String(claims.nickname || claims.name || claims.email || '').trim(),
      credExp: SH.num(claims.exp) ? SH.num(claims.exp) * 1000 : null,
    };
  },
  hasCredential: (c) => !!c.access_token || !!c.refresh_token,
  probe: async (env, c) => {
    const r = await minimaxCall(c, '/minimax-cloud/api/v1/signin/status', 'GET');
    if (r.status === 401 || r.status === 403) return { ok: false, authFailed: true, message: 'access_token 已失效' };
    if (!minimaxEnvelopeOk(r.json)) {
      return { ok: false, message: `状态查询失败（HTTP ${r.status}）${r.json?.base_resp?.status_msg || ''}` };
    }
    const t = (r.json?.data?.days || []).find((d) => d && d.is_today);
    return {
      ok: true,
      checked: !!t && Number(t.status) === 3,
      trustworthy: true,
      streak: t?.day_no ?? null,
      credits: await minimaxBalance(c).catch(() => null),
      message: t && Number(t.status) === 3 ? '服务端显示今日已签' : '',
    };
  },
  prepare: async (env, c, acct) => {
    if (!c.access_token && !c.refresh_token) throw new PlatformAuthError('未配置 access_token / refresh_token');
    const exp = Number(c.expires_at || 0) || SH.jwtExp(c.access_token) * 1000;
    if (c.refresh_token && (!c.access_token || (exp && exp - Date.now() < 5 * 60000))) {
      const got = await minimaxOauthRefresh(c).catch(() => null);
      if (got) {
        Object.assign(c, got);
        if (acct) acct.creds = { ...c };
      }
    }
    if (!c.access_token) throw new PlatformAuthError('MiniMax access_token 为空，且续期失败，请重新粘贴');
    return { ...c };
  },
  checkin: async (env, c) => {
    const statusRes = await minimaxCall(c, '/minimax-cloud/api/v1/signin/status', 'GET');
    if (statusRes.status === 401 || statusRes.status === 403) {
      const got = await minimaxOauthRefresh(c).catch(() => null);
      if (!got) return { auth: true, msg: 'access_token 已失效，请重新粘贴（建议同时填 refresh_token）' };
      Object.assign(c, got);
      return { state: 'unverified', creds: { ...c }, msg: '令牌已续期，本轮未完成，下一轮自动继续' };
    }
    if (!minimaxEnvelopeOk(statusRes.json)) {
      return { state: 'error', msg: `状态查询失败（HTTP ${statusRes.status}）${statusRes.json?.base_resp?.status_msg || ''}` };
    }
    const days = statusRes.json?.data?.days || [];
    const today = days.find((d) => d && d.is_today) || null;
    const dayNo = today?.day_no ?? null;
    if (today && Number(today.status) === 3) {
      return { state: 'already', msg: `今日已签到${dayNo ? `（第 ${dayNo} 天）` : ''}`, credits: await minimaxBalance(c).catch(() => null) };
    }

    const claimRes = await minimaxCall(c, '/minimax-cloud/api/v1/signin/claim', 'POST', {});
    if (claimRes.status === 401 || claimRes.status === 403) {
      return { auth: true, msg: '领取时被拒绝：access_token 失效' };
    }
    if (!minimaxEnvelopeOk(claimRes.json)) {
      return { state: 'error', msg: `领取失败（HTTP ${claimRes.status}）${claimRes.json?.base_resp?.status_msg || ''}` };
    }
    const cdata = claimRes.json?.data || {};
    if (Number(cdata.claim_result) === 2) {
      return { state: 'already', msg: '今日已签到（服务端返回已领取）', credits: await minimaxBalance(c).catch(() => null) };
    }

    // 回查确认
    let confirmed = null;
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(1000 * i);
      const again = await minimaxCall(c, '/minimax-cloud/api/v1/signin/status', 'GET').catch(() => null);
      const d = again?.json?.data?.days || [];
      const t = d.find((x) => x && x.is_today);
      if (t && Number(t.status) === 3) { confirmed = t; break; }
    }
    const points = SH.num(cdata.points);
    const credits = await minimaxBalance(c).catch(() => null);
    if (!confirmed) {
      return { state: 'unverified', msg: '领取接口已返回，服务端签到状态尚未确认，稍后自动复查', credits };
    }
    return {
      state: 'checked',
      credit: points,
      streak: dayNo,
      credits,
      msg: `签到成功${points != null ? ` +${points} 积分` : ''}${dayNo ? `（第 ${dayNo} 天）` : ''}（已复核）`,
    };
  },
});

/* ---------------- 百度搭子 DuMate ---------------- */

const DUMATE_API = 'https://console.bce.baidu.com';

function dumateHeaders(c) {
  const cookie = String(c.cookie || '').trim();
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: DUMATE_API,
    Referer: DUMATE_API + '/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Cookie: cookie,
  };
  let csrf = String(c.csrftoken || '').trim();
  if (!csrf) {
    const m = /(?:^|;\s*)bce-user-info=([^;]+)/.exec(cookie);
    if (m) csrf = decodeURIComponent(m[1].replace(/^"|"$/g, ''));
  }
  if (csrf) h.csrftoken = csrf;
  return h;
}

function dumateUnwrap(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Number(payload.code) === 0 || payload.success === true) {
    return payload.result && typeof payload.result === 'object' ? payload.result : (payload.data && typeof payload.data === 'object' ? payload.data : {});
  }
  return null;
}

function dumateChecked(payload) {
  const d = dumateUnwrap(payload);
  if (!d) return null;
  const days = d.signInDays || d.sign_in_days || [];
  const today = SH.bjDay(Date.now());
  return days.some((x) => String(x).startsWith(today));
}

const DuMate = createTokenPlatform({
  keyInfo: 'dumate-signin/v1/account',
  meta: {
    key: 'dumate',
    label: '百度搭子 DuMate',
    accent: 'blue',
    verified: false,
    verifiedNote: '接口按桌面端整理；Cookie 过期后需重新粘贴',
    addMode: 'token',
    defaultHost: 'console.bce.baidu.com',
    supportsRefresh: false,
    credKind: 'static',
    fields: [
      { name: 'cookie', label: 'Cookie', required: true, secret: true, placeholder: '登录 console.bce.baidu.com 后复制完整 Cookie', multiline: true },
      { name: 'csrftoken', label: 'csrftoken', optional: true, secret: true, placeholder: '可留空，自动从 bce-user-info 取' },
    ],
    hint: '浏览器登录 console.bce.baidu.com → F12 → Network → 任意请求的 Cookie 整段复制。',
    note: '每日登录奖励 500 积分；BDUSS / bce-user-info 过期后需要重新粘贴。',
  },
  primaryFields: ['cookie'],
  normalize: (c) => ({
    cookie: String(c.cookie || '').trim().replace(/^cookie:\s*/i, ''),
    csrftoken: String(c.csrftoken || '').trim(),
  }),
  hasCredential: (c) => !!c.cookie,
  probe: async (env, c) => {
    const r = await SH.httpJson(DUMATE_API + '/api/dumate/points/loginBonusInfo', {
      method: 'GET',
      headers: dumateHeaders(c),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, authFailed: true, message: 'Cookie 已失效' };
    const d = dumateUnwrap(r.json);
    if (!d) return { ok: false, message: `登录奖励信息读取失败（HTTP ${r.status}）` };
    return {
      ok: true,
      checked: dumateChecked(r.json) === true,
      trustworthy: true,
      credits: await dumateBalance(c).catch(() => null),
      message: dumateChecked(r.json) ? '服务端显示今日已签' : '',
    };
  },
  prepare: async (env, c) => {
    if (!c.cookie) throw new PlatformAuthError('未配置 Cookie');
    if (!/(?:^|;\s*)(BDUSS|bce-user-info)=/.test(c.cookie)) {
      throw new PlatformAuthError('Cookie 里没有 BDUSS / bce-user-info，请复制完整 Cookie');
    }
    return { ...c };
  },
  checkin: async (env, c) => {
    const info = await SH.httpJson(DUMATE_API + '/api/dumate/points/loginBonusInfo', {
      method: 'GET',
      headers: dumateHeaders(c),
    });
    if (info.status === 401 || info.status === 403) return { auth: true, msg: 'Cookie 已失效，请重新粘贴' };
    const infoData = dumateUnwrap(info.json);
    if (!infoData) return { state: 'error', msg: `登录奖励信息读取失败（HTTP ${info.status}）` };
    if (dumateChecked(info.json)) {
      return { state: 'already', msg: '今日已签到', credits: await dumateBalance(c).catch(() => null) };
    }

    const claim = await SH.httpJson(DUMATE_API + '/api/dumate/points/loginBonus', {
      method: 'POST',
      headers: dumateHeaders(c),
      body: '{}',
    });
    if (claim.status === 401 || claim.status === 403) return { auth: true, msg: 'Cookie 已失效，请重新粘贴' };
    const claimData = dumateOr(claim.json);
    const claimed = dumateChecked(claim.json) || claimData?.success === true || Number(claim.json?.code) === 0;

    // 回查确认
    let confirmed = false;
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(1000 * i);
      const again = await SH.httpJson(DUMATE_API + '/api/dumate/points/loginBonusInfo', {
        method: 'GET',
        headers: dumateHeaders(c),
      }).catch(() => null);
      if (again && dumateChecked(again.json)) { confirmed = true; break; }
    }
    const credits = await dumateBalance(c).catch(() => null);
    if (confirmed) return { state: 'checked', credit: 500, credits, msg: '签到成功 +500 积分（已复核）' };
    if (claimed) return { state: 'unverified', msg: '领取接口已返回，服务端签到状态尚未确认，稍后自动复查', credits };
    return { state: 'error', msg: claim.json?.message || claim.json?.msg || '领取失败' };
  },
});

function dumateOr(payload) {
  const d = dumateUnwrap(payload);
  return d || (payload && typeof payload === 'object' ? payload : {});
}

async function dumateBalance(c) {
  const r = await SH.httpJson(
    DUMATE_API + '/api/dumate/points/quota_overview?timezone=Asia/Shanghai&clientType=desktop&ignoreLoginBonus=true',
    { method: 'GET', headers: dumateHeaders(c) }
  );
  const d = dumateUnwrap(r.json);
  if (!d) return null;
  const total = SH.num(d.totalPoints);
  const used = SH.num(d.usedPoints) || 0;
  return total == null ? null : Math.round((total - used) * 100) / 100;
}

/* ---------------- LobsterAI（网易有道） ---------------- */

const LOBSTER_API = 'https://lobsterai-server.youdao.com';
const LOBSTER_VERSION = '2026.9.4';

function lobsterHeaders(c) {
  return {
    Authorization: 'Bearer ' + c.access_token,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `Mozilla/5.0 LobsterAI/${String(c.client_version || LOBSTER_VERSION)}`,
  };
}

async function lobsterProfile(c) {
  const r = await SH.httpJson(LOBSTER_API + '/api/user/profile-summary?firstKeyfrom=official', {
    method: 'GET',
    headers: lobsterHeaders(c),
  });
  if (Number(r.json?.code) !== 0) return null;
  const d = r.json.data || {};
  return { credits: SH.num(d.totalCreditsRemaining), total: SH.num(d.totalCreditsRemaining) };
}

async function lobsterSlot(c) {
  const ver = String(c.client_version || LOBSTER_VERSION);
  const qs = `?placement=desktop_sidebar&clientVersion=${encodeURIComponent(ver)}&containerApiVersion=2&platform=win32`;
  return SH.httpJson(LOBSTER_API + '/api/client-activities/slot' + qs, {
    method: 'GET',
    headers: lobsterHeaders(c),
  });
}

async function lobsterContext(c, code, revision) {
  const qs = `?configRevision=${encodeURIComponent(revision ?? '')}`;
  return SH.httpJson(LOBSTER_API + `/api/client-activities/${encodeURIComponent(code)}/context${qs}`, {
    method: 'GET',
    headers: lobsterHeaders(c),
  });
}

const Lobster = createTokenPlatform({
  keyInfo: 'lobster-signin/v1/account',
  meta: {
    key: 'lobster',
    label: 'LobsterAI',
    accent: 'rose',
    verified: false,
    verifiedNote: '接口按桌面端 2026.9.4 整理；版本升级可用字段覆盖 client_version',
    addMode: 'token',
    defaultHost: 'lobsterai-server.youdao.com',
    supportsRefresh: false,
    credKind: 'static',
    fields: [
      { name: 'access_token', label: 'accessToken', required: true, secret: true, placeholder: 'LobsterAI 数据库 kv.auth_tokens 里的 accessToken' },
      { name: 'client_version', label: '客户端版本', optional: true, placeholder: '默认 2026.9.4' },
    ],
    hint: '从 %APPDATA%\\LobsterAI\\lobsterai.sqlite 的 kv 表里取 auth_tokens.accessToken。',
    note: '每日积分礼 100 积分；错误码 51104 = 今日已领。',
  },
  primaryFields: ['access_token'],
  normalize: (c) => ({
    access_token: SH.stripBearer(c.access_token),
    client_version: String(c.client_version || '').trim(),
  }),
  identity: (c) => {
    const claims = SH.jwtClaims(c.access_token);
    if (!claims || !Object.keys(claims).length) return {};
    return {
      uid: String(claims.uid || claims.user_id || claims.sub || ''),
      label: String(claims.nickname || claims.name || '').trim(),
      credExp: SH.num(claims.exp) ? SH.num(claims.exp) * 1000 : null,
    };
  },
  hasCredential: (c) => !!c.access_token,
  probe: async (env, c) => {
    const slot = await lobsterSlot(c);
    if (slot.status === 401 || slot.status === 403) return { ok: false, authFailed: true, message: 'accessToken 已失效' };
    if (Number(slot.json?.code) !== 0) {
      return { ok: false, message: `活动信息读取失败：${slot.json?.message || 'code=' + slot.json?.code}` };
    }
    const sd = slot.json.data || {};
    const activity = sd.activity || {};
    const balance = (await lobsterProfile(c).catch(() => null))?.credits ?? null;
    if (!activity.activityCode || sd.slotState !== 'available') {
      return { ok: true, checked: false, trustworthy: true, credits: balance, message: '当前没有每日积分礼活动' };
    }
    const ctx = await lobsterContext(c, activity.activityCode, activity.configRevision);
    const checked = isTrue(ctx.json?.data?.state?.claimedToday);
    return { ok: true, checked, trustworthy: true, credits: balance, message: checked ? '服务端显示今日已签' : '' };
  },
  prepare: async (env, c) => {
    if (!c.access_token) throw new PlatformAuthError('未配置 accessToken');
    return { ...c };
  },
  checkin: async (env, c) => {
    const slot = await lobsterSlot(c);
    if (slot.status === 401 || slot.status === 403) return { auth: true, msg: 'accessToken 已失效' };
    if (Number(slot.json?.code) !== 0) {
      return { state: 'error', msg: `活动信息读取失败：${slot.json?.message || slot.json?.error || 'code=' + slot.json?.code}` };
    }
    const sd = slot.json.data || {};
    const activity = sd.activity || {};
    const code = activity.activityCode;
    const revision = activity.configRevision;
    if (!code || sd.slotState !== 'available') {
      return { state: 'no_activity', msg: '当前没有每日积分礼活动', credits: (await lobsterProfile(c).catch(() => null))?.credits };
    }

    const ctx = await lobsterContext(c, code, revision);
    const state = ctx.json?.data?.state || {};
    const balance = (await lobsterProfile(c).catch(() => null))?.credits ?? null;
    if (isTrue(state.claimedToday)) return { state: 'already', msg: '今日已签到', credits: balance };

    const act = await SH.httpJson(LOBSTER_API + `/api/client-activities/${encodeURIComponent(code)}/actions/check_in`, {
      method: 'POST',
      headers: lobsterHeaders(c),
      body: JSON.stringify({
        configRevision: revision,
        idempotencyKey: `daily-check-in-${crypto.randomUUID()}`,
        payload: {},
      }),
    });
    const errCode = Number(act.json?.code);
    if (errCode === 51104) return { state: 'already', msg: '今日已签到', credits: balance };
    if (errCode === 51102) return { auth: true, msg: 'accessToken 已失效' };
    if (errCode === 51100 || errCode === 51101) return { state: 'no_activity', msg: `活动不可用（code=${errCode}）` };
    if (errCode !== 0) {
      return { state: 'error', msg: act.json?.message || act.json?.error || `签到失败（HTTP ${act.status}）` };
    }

    // 回查确认
    let confirmed = false;
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(1000 * i);
      const again = await lobsterContext(c, code, revision).catch(() => null);
      if (isTrue(again?.json?.data?.state?.claimedToday)) { confirmed = true; break; }
    }
    const reward = SH.num(state.rewardCredits) ?? 100;
    if (confirmed) return { state: 'checked', credit: reward, credits: balance, msg: `签到成功 +${reward} 积分（已复核）` };
    return { state: 'unverified', msg: '签到接口已返回，服务端状态尚未确认，稍后自动复查', credits: balance };
  },
});



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
  creditHint: '当前剩余积分（按资源包当前周期合计）',
  totalHint: '本期签到累计获得，不是余额',
};

const QODER_META = {
  key: 'qoder',
  label: 'Qoder',
  accent: 'lime',
  verified: false,
  verifiedNote: '按上游已实测版本移植；本部署未用真实账号复核，实机跑通后可设 QODER_VERIFIED=true 去掉标记',
  addMode: 'device',
  defaultHost: 'openapi.qoder.com.cn',
  supportsRefresh: true,
  fields: [],
  hint: '点「添加账号」打开官方授权页，登录并确认后自动入库；也可以粘贴 Personal Access Token。',
  note: '同时走「旧版每日签到」和「活动平台」两条通道，领取后会回查确认。',
};

const PLATFORMS = [
  { key: 'trae', meta: TRAE_META, mod: Trae, env: traeEnv, prefix: 'trae:' },
  { key: 'workbuddy', meta: WB_META, mod: WorkBuddy, env: wbEnv, prefix: 'wb:' },
  { key: 'qoder', meta: QODER_META, mod: Qoder, env: (env) => platformEnv(env, 'qoder:'), prefix: 'qoder:' },
  { key: 'workbuddy_intl', meta: WorkBuddyIntl.meta, mod: WorkBuddyIntl, env: (env) => platformEnv(env, 'wbi:'), prefix: 'wbi:' },
  { key: 'minimax', meta: MiniMax.meta, mod: MiniMax, env: (env) => platformEnv(env, 'minimax:'), prefix: 'minimax:' },
  { key: 'dumate', meta: DuMate.meta, mod: DuMate, env: (env) => platformEnv(env, 'dumate:'), prefix: 'dumate:' },
  { key: 'lobster', meta: Lobster.meta, mod: Lobster, env: (env) => platformEnv(env, 'lobster:'), prefix: 'lobster:' },
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
  qoder: PLATFORM_MAP.qoder,
  wbi: PLATFORM_MAP.workbuddy_intl,
  workbuddy_intl: PLATFORM_MAP.workbuddy_intl,
  minimax: PLATFORM_MAP.minimax,
  dumate: PLATFORM_MAP.dumate,
  lobster: PLATFORM_MAP.lobster,
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
    creditHint: m.creditHint || '',
    totalHint: m.totalHint || '',
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
      configured: true,
    };
  }
  const raw = String(env.CHECKIN_CRON || '').trim();
  const text = raw || '08:10';
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  const hour = m ? Math.min(23, Math.max(0, Number(m[1]))) : 8;
  const minute = m ? Math.min(59, Math.max(0, Number(m[2]))) : 10;
  return {
    text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    next: SH.nextRunBj(hour, minute),
    source: 'env',
    crons: [],
    configured: raw !== '',
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
      verified: r.verified === true,
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
  const states = {};
  for (const entry of PLATFORMS) counts[entry.key] = accounts.filter((a) => a.platform === entry.key).length;
  for (const a of enabled) states[a.lastState || 'new'] = (states[a.lastState || 'new'] || 0) + 1;

  const crons = await readCrons(env);
  const cron = cronInfo(env, crons);
  return {
    at: SH.fmtBj(Date.now()),
    today: SH.bjDay(),
    cron: cron.text,
    nextRun: cron.next,
    cronSource: cron.source,
    cronConfigured: cron.configured,
    crons: cron.crons,
    stats: {
      total: accounts.length,
      enabled: enabled.length,
      signed: signed.length,
      verified: enabled.filter((a) => a.verified === true).length,
      unverified: enabled.filter((a) => a.lastState === 'unverified').length,
      failed: enabled.filter((a) => ['error', 'token_dead'].includes(a.lastState)).length,
      blocked: enabled.filter((a) => a.lastState === 'blocked').length,
      noActivity: enabled.filter((a) => a.lastState === 'no_activity').length,
      pending: enabled.filter((a) => !a.signedToday && !['unverified', 'error', 'token_dead', 'no_activity', 'blocked', 'rate', 'cooldown'].includes(a.lastState)).length,
      todayCredit: Math.round(todayCredit * 100) / 100,
      totalSigned,
    },
    stateCounts: states,
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

async function runAll(env, { force = false, action = 'cron', notify = null } = {}) {
  const out = { at: SH.fmtBj(Date.now()) };
  for (const entry of PLATFORMS) {
    out[entry.key] = await runPlatform(entry, env, { force, action });
    // 兼容旧版 /cron 响应里的 wb 键
    if (entry.key === 'workbuddy') out.wb = out[entry.key];
  }

  // 多次 Cron 重试时默认不重复推送：只在「本轮确有新结果」时通知
  const counts = Object.values(out).filter((x) => x && Array.isArray(x.results));
  const hasWork = counts.some(
    (s) => s.checked > 0 || s.failed > 0 || (s.results || []).some((r) => ['checked', 'error', 'token_dead', 'blocked'].includes(r.state))
  );
  const shouldNotify = notify === true || (notify !== false && hasWork);
  if (shouldNotify) {
    try {
      out.notify = await notifyRun(env, out);
    } catch (e) {
      out.notify = { error: e.message };
    }
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
/* 签到结果通知（Telegram Bot / QQ 官方机器人）                          */
/*                                                                     */
/* 配置存在 KV 的 notify:config，和其它凭证一样用 MASTER_KEY 加密。      */
/* 每轮全量签到跑完推一条汇总；通道失败只记在返回里，不影响签到结论。    */
/* ================================================================== */

const NOTIFY_KEY = 'notify:config';
const notifyVault = SH.makeVault('notify/v1/config');
const notifyVaultEnv = (env) => ({ PLATFORM_MASTER_KEY: env.MASTER_KEY });

async function readNotify(env) {
  try {
    const raw = await env.KV.get(NOTIFY_KEY);
    if (!raw) return {};
    return await notifyVault.open(notifyVaultEnv(env), raw);
  } catch {
    return {};
  }
}

async function writeNotify(env, cfg) {
  await env.KV.put(NOTIFY_KEY, await notifyVault.seal(notifyVaultEnv(env), cfg));
}

function notifyView(cfg) {
  const tg = cfg.telegram || {};
  const qq = cfg.qq || {};
  return {
    telegram: {
      token: tg.token || '',
      chatId: tg.chatId || '',
      ready: !!(tg.token && tg.chatId),
    },
    qq: {
      appId: qq.appId || '',
      appSecret: qq.appSecret || '',
      openid: qq.openid || '',
      sandbox: !!qq.sandbox,
      ready: !!(qq.appId && qq.appSecret && qq.openid),
    },
  };
}

async function sendTelegram(tg, text) {
  const r = await SH.httpJson(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
    method: 'POST',
    body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
  });
  if (r.status >= 400 || (r.json && r.json.ok === false)) {
    throw new Error(`Telegram 发送失败（HTTP ${r.status}）`);
  }
}

let qqTokenCache = { key: '', token: '', exp: 0 };

async function qqAccessToken(qq) {
  const now = Date.now();
  const key = `${qq.appId}:${qq.appSecret}`;
  if (qqTokenCache.key === key && qqTokenCache.token && qqTokenCache.exp > now) return qqTokenCache.token;
  const r = await SH.httpJson('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    body: JSON.stringify({ appId: qq.appId, clientSecret: qq.appSecret }),
  });
  const token = r.json?.access_token || r.json?.accessToken;
  if (!token) throw new Error(`QQ 机器人取 token 失败（HTTP ${r.status}）`);
  const ttl = Number(r.json?.expires_in || r.json?.expiresIn || 7200);
  qqTokenCache = { key, token, exp: now + Math.max(60, ttl - 120) * 1000 };
  return token;
}

async function sendQQ(qq, text) {
  const at = await qqAccessToken(qq);
  const base = qq.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
  const r = await SH.httpJson(`${base}/v2/users/${encodeURIComponent(qq.openid)}/messages`, {
    method: 'POST',
    headers: { authorization: `QQBot ${at}` },
    body: JSON.stringify({ content: text, msg_type: 0 }),
  });
  if (r.status >= 400) throw new Error(`QQ 发送失败（HTTP ${r.status}）`);
}

/** 汇总文案：一行一个平台，账号明细最多列 6 条 */
function formatReport(summary) {
  const d = new Date(Date.now() + 8 * 3600e3);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const lines = [`📋 签到完成 · ${mm}-${dd} ${hh}:${mi}`];

  for (const entry of PLATFORMS) {
    const p = summary[entry.key];
    if (!p) continue;
    const results = p.results || [];
    if (!results.length && !p.error) continue;
    const total = p.accounts ?? results.length;
    const done = (p.checked || 0) + (p.already || 0);
    const bad = (p.failed || 0) + (p.cooling || 0);
    const mark = bad === 0 ? '✅' : done === 0 ? '❌' : '⚠️';
    const bits = [`${mark} ${entry.meta.label}`, `${done}/${total}`];
    if (p.checked) bits.push(`新签 ${p.checked}`);
    if (p.already) bits.push(`已签 ${p.already}`);
    if (bad) bits.push(`失败 ${bad}`);
    if (p.error) bits.push(p.error);
    lines.push(bits.join(' · '));

    const shown = results.filter((r) => r.state !== 'checked' || r.msg).slice(0, 6);
    for (const r of shown) {
      if (!r.msg) continue;
      lines.push(`   · ${r.label || r.id || ''} ${r.msg}`);
    }
    if (results.length > shown.length) lines.push(`   …还有 ${results.length - shown.length} 个`);
  }
  return lines.join('\n');
}

function demoSummary() {
  const results = [
    { id: 'demo1', label: '示例账号', state: 'checked', msg: '+100 credits' },
    { id: 'demo2', label: '备用号', state: 'error', msg: '令牌已失效，请重新添加' },
  ];
  return {
    at: SH.fmtBj(Date.now()),
    trae: { accounts: 1, checked: 1, already: 0, failed: 0, cooling: 0 },
    workbuddy: { accounts: 1, checked: 0, already: 1, failed: 0, cooling: 0 },
    qoder: { accounts: 2, checked: 1, already: 0, failed: 1, cooling: 0, results },
  };
}

/** 配了哪个就发哪个；都没配就静默跳过 */
async function notifyRun(env, summary) {
  const cfg = await readNotify(env);
  const jobs = [];
  const out = {};

  if (cfg.telegram?.token && cfg.telegram?.chatId) {
    jobs.push(
      sendTelegram(cfg.telegram, formatReport(summary))
        .then(() => {
          out.telegram = 'ok';
        })
        .catch((e) => {
          out.telegram = e.message;
        })
    );
  }
  if (cfg.qq?.appId && cfg.qq?.appSecret && cfg.qq?.openid) {
    jobs.push(
      sendQQ(cfg.qq, formatReport(summary))
        .then(() => {
          out.qq = 'ok';
        })
        .catch((e) => {
          out.qq = e.message;
        })
    );
  }
  if (!jobs.length) return { skipped: true };
  await Promise.all(jobs);
  return out;
}

/* 取 QQ 机器人 openid 的本机脚本：连网关 → 你私聊一次机器人 → 打印 openid */
const QQ_OPENID_HELPER = `#!/usr/bin/env node
/* 用法：node openid-helper.mjs <AppID> <AppSecret>   （需要 Node 22+） */
const [appId, secret] = process.argv.slice(2);
if (!appId || !secret) { console.error('参数：node openid-helper.mjs <AppID> <AppSecret>'); process.exit(1); }

const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

const tok = await post('https://bots.qq.com/app/getAppAccessToken', { appId, clientSecret: secret });
const at = tok.access_token || tok.accessToken;
if (!at) { console.error('取 token 失败：', tok); process.exit(1); }

const gw = await (await fetch('https://api.sgroup.qq.com/gateway', { headers: { Authorization: 'QQBot ' + at } })).json();
if (!gw.url) { console.error('取网关失败：', gw); process.exit(1); }

const ws = new WebSocket(gw.url);
let beat = null;
ws.onopen = () => console.log('已连上网关，请在 60 秒内用手机 QQ 给机器人发一条私聊…');
ws.onmessage = (ev) => {
  const p = JSON.parse(ev.data);
  if (p.op === 10) {
    ws.send(JSON.stringify({ op: 2, d: { token: 'QQBot ' + at, intents: 1 << 25, shard: [0, 1] } }));
    beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), p.d.heartbeat_interval || 40000);
  }
  if (p.op === 0 && p.t === 'C2C_MESSAGE_CREATE') {
    const openid = p.d && p.d.author && p.d.author.user_openid;
    if (openid) {
      console.log('\\n你的 user_openid：\\n' + openid + '\\n');
      clearInterval(beat);
      ws.close();
      process.exit(0);
    }
  }
};
ws.onerror = (e) => { console.error('网关连接失败：', e.message || e); process.exit(1); };
setTimeout(() => { console.error('等超时了，重新跑一次脚本再试'); process.exit(1); }, 65000);
`;

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

      if (path === '/qq/openid-helper.mjs' && method === 'GET') {
        return new Response(QQ_OPENID_HELPER, {
          headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      // 平台命名空间：/trae/api/*、/wb/api/*、/wbi/api/* …
      const ns = path.split('/')[1];
      if (NS_MAP[ns] && path.startsWith('/' + ns + '/')) {
        const entry = NS_MAP[ns];
        return await entry.mod.fetch(repath(request, path.slice(ns.length + 1) || '/'), entry.env(env), ctx);
      }
      if (path === '/trae' || path === '/wb' || path === '/wbi' || path === '/qoder' || path === '/minimax' || path === '/dumate' || path === '/lobster' || path === '/zhipu' || path === '/loomy' || path === '/astudio') {
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
          cronConfigured: cron.configured,
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
      if (path === '/api/accounts/travel' && method === 'POST') {
        const body = await readBody(request);
        const entry = platformOf(body);
        if (!entry) return jsonResponse({ error: '未知平台' }, 400);
        if (typeof entry.mod.travel !== 'function') {
          return jsonResponse({ error: `${entry.meta.label} 没有成长中心旅行` }, 400);
        }
        try {
          const result = await entry.mod.travel(entry.env(env), {
            id: String(body.id || '').trim(),
            action: String(body.action || 'sync').trim(),
          });
          return jsonResponse({ platform: entry.key, ...result });
        } catch (e) {
          return jsonResponse({ error: e.message }, 400);
        }
      }
      if (path === '/api/refresh-all' && method === 'POST') return jsonResponse(await refreshAll(env));

      if (path === '/api/notify' && method === 'GET') {
        return jsonResponse({ ok: true, config: notifyView(await readNotify(env)) });
      }

      if (path === '/api/notify' && method === 'POST') {
        const body = await readBody(request);
        const prev = await readNotify(env);
        // 空值视为「不改」，方便只换其中一个字段
        const keep = (v, old) => (typeof v === 'string' && v.trim() ? v.trim() : old || '');
        const tg = body.telegram || {};
        const qq = body.qq || {};
        const next = {
          telegram: {
            token: keep(tg.token, prev.telegram?.token),
            chatId: keep(tg.chatId, prev.telegram?.chatId),
          },
          qq: {
            appId: keep(qq.appId, prev.qq?.appId),
            appSecret: keep(qq.appSecret, prev.qq?.appSecret),
            openid: keep(qq.openid, prev.qq?.openid),
            sandbox: qq.sandbox != null ? !!qq.sandbox : !!prev.qq?.sandbox,
          },
        };
        await writeNotify(env, next);
        return jsonResponse({ ok: true, config: notifyView(next) });
      }

      if (path === '/api/notify/test' && method === 'POST') {
        const cfg = await readNotify(env);
        const summary = demoSummary();
        const result = {};
        if (cfg.telegram?.token && cfg.telegram?.chatId) {
          try {
            await sendTelegram(cfg.telegram, formatReport(summary));
            result.telegram = 'ok';
          } catch (e) {
            result.telegram = e.message;
          }
        } else result.telegram = '未配置';
        if (cfg.qq?.appId && cfg.qq?.appSecret && cfg.qq?.openid) {
          try {
            await sendQQ(cfg.qq, formatReport(summary));
            result.qq = 'ok';
          } catch (e) {
            result.qq = e.message;
          }
        } else result.qq = '未配置';
        return jsonResponse({ ok: true, result });
      }

      return jsonResponse({ error: 'not found' }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message || String(e) }, 500);
    }
  },

  /** Cloudflare Cron Trigger：所有平台依次签到，互不影响
   *  推荐配置多条 Cron（如 08:10 / 12:10 / 20:10）：已验证的账号会自动跳过，
   *  失败/待确认的账号在后续触发里继续重试，避免一次抖动就断签。 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await rememberCron(env, event && event.cron);
        } catch {
          /* cron 记录失败不影响签到 */
        }
        const hour = SH.bjHour();
        // 早班固定推一条日报；其余触发只在确有新结果/失败时才推
        await runAll(env, { force: false, action: 'cron', notify: hour === 8 ? true : null });
      })().catch(() => {})
    );
  },
};
/* ================================================================== */
/* 模块六：控制台页面                                                   */
/*                                                                     */
/* 视觉：Apple 设计语言——浅色优先、系统蓝强调色、白色卡片与柔和     */
/* 阴影，1px 发丝线建立层次；深色模式使用纯黑底与 #1c1c1e 卡片。      */
/* 平台用系统色渐变的圆角图标区分，账号用首字头像区分。                */
/* ================================================================== */

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="day">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>签到塔 · SIGN-IN TOWER</title>
<meta name="description" content="十个 AI 工具的每日签到与 WorkBuddy 自动旅行，一个安静、清晰的控制台。">
<script>try{if(localStorage.getItem('tower.theme')==='night')document.documentElement.setAttribute('data-theme','night');}catch(e){}</script>
<style>
:root{
  color-scheme:light;
  --bg:#f5f5f7; --bg-soft:#fbfbfd;
  --surface:#ffffff; --surface-2:#f2f2f7; --surface-3:#e8e8ed;
  --line:rgba(60,60,67,.10); --line-2:rgba(60,60,67,.18);
  --text:#1d1d1f; --text-2:#3c3c43; --muted:#6e6e73; --dim:#8e8e93;
  --accent:#007aff; --accent-2:#0a84ff; --accent-soft:rgba(0,122,255,.10); --accent-line:rgba(0,122,255,.26);
  --ok:#34c759; --warn:#ff9f0a; --bad:#ff3b30;
  --ok-soft:rgba(52,199,89,.12); --warn-soft:rgba(255,159,10,.13); --bad-soft:rgba(255,59,48,.11);
  --on-accent:#ffffff;
  --radius:24px;
  --shadow-xs:0 1px 2px rgba(0,0,0,.04);
  --shadow-sm:0 1px 2px rgba(0,0,0,.04),0 2px 8px -2px rgba(0,0,0,.06);
  --shadow-md:0 2px 6px rgba(0,0,0,.04),0 12px 28px -12px rgba(0,0,0,.12);
  --shadow-lg:0 18px 48px -16px rgba(0,0,0,.22),0 4px 12px -4px rgba(0,0,0,.08);
  --ring-track:rgba(0,0,0,.07);
  --topbar:rgba(251,251,253,.78);
  --toast-bg:#1d1d1f;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,"JetBrains Mono",Consolas,monospace;
  --display:var(--sans);
}
[data-theme="night"]{
  color-scheme:dark;
  --bg:#000000; --bg-soft:#0a0a0a;
  --surface:#1c1c1e; --surface-2:#2c2c2e; --surface-3:#3a3a3c;
  --line:rgba(255,255,255,.09); --line-2:rgba(255,255,255,.18);
  --text:#f5f5f7; --text-2:#e5e5ea; --muted:#a1a1a6; --dim:#8e8e93;
  --accent:#0a84ff; --accent-2:#409cff; --accent-soft:rgba(10,132,255,.16); --accent-line:rgba(10,132,255,.4);
  --ok:#30d158; --warn:#ffd60a; --bad:#ff453a;
  --ok-soft:rgba(48,209,88,.15); --warn-soft:rgba(255,214,10,.14); --bad-soft:rgba(255,69,58,.15);
  --shadow-xs:0 1px 2px rgba(0,0,0,.4);
  --shadow-sm:0 1px 2px rgba(0,0,0,.5),0 2px 8px -2px rgba(0,0,0,.4);
  --shadow-md:0 2px 8px rgba(0,0,0,.45),0 14px 30px -14px rgba(0,0,0,.6);
  --shadow-lg:0 24px 60px -18px rgba(0,0,0,.75),0 6px 18px -8px rgba(0,0,0,.5);
  --ring-track:rgba(255,255,255,.09);
  --topbar:rgba(10,10,10,.72);
  --toast-bg:#2c2c2e;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100vh;background:var(--bg);color:var(--text);
  font:400 14px/1.6 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;overflow-x:hidden;
}
body::before{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(1100px 560px at 50% -12%,rgba(0,122,255,.07),transparent 70%);
}
[data-theme="night"] body::before{background:radial-gradient(1100px 560px at 50% -12%,rgba(10,132,255,.13),transparent 70%)}
a{color:inherit;text-decoration:none}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;background:none;border:0;padding:0}
button[disabled]{cursor:not-allowed;opacity:.45}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
::selection{background:var(--accent-soft);color:var(--text)}
.skip{position:absolute;left:-9999px;top:0}
.skip:focus{left:16px;top:14px;z-index:120;background:var(--surface);border:1px solid var(--accent);padding:10px 14px;border-radius:12px;box-shadow:var(--shadow-md)}
.shell{width:min(1240px,calc(100% - 48px));margin:0 auto;position:relative;z-index:1}

/* ---------- top bar ---------- */
.topbar{position:sticky;top:0;z-index:40;border-bottom:1px solid var(--line);background:var(--topbar);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px)}
.topbarIn{display:flex;align-items:center;gap:22px;height:64px}
.brand{display:flex;align-items:center;gap:10px;flex:none}
.brandOrb{
  width:30px;height:30px;border-radius:9px;display:grid;place-items:center;
  background:linear-gradient(160deg,#2e9bff,#0064d6);
  box-shadow:0 4px 12px -4px rgba(0,122,255,.55),inset 0 1px 0 rgba(255,255,255,.35);
}
.brandOrb svg{width:16px;height:16px;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.brandText b{display:block;font-size:14.5px;font-weight:650;letter-spacing:-.01em;line-height:1.2;white-space:nowrap}
.brandText em{display:block;font:500 9px/1.5 var(--mono);font-style:normal;letter-spacing:.16em;color:var(--muted)}
.topTabs{display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--surface-2)}
.topTabs button{padding:7px 14px;border-radius:999px;font-size:12px;font-weight:500;color:var(--muted);transition:color .18s,background .18s,box-shadow .18s}
.topTabs button:hover{color:var(--text)}
.topTabs button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-xs),0 0 0 .5px var(--line)}
.topRight{margin-left:auto;display:flex;align-items:center;gap:6px;flex:none}
.livePill{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;font:11px var(--mono);color:var(--muted);white-space:nowrap}
.livePill i{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3.5px var(--ok-soft);animation:pulse 2.4s infinite}
.iconBtn{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:var(--muted);transition:color .18s,background .18s}
.iconBtn:hover{color:var(--text);background:var(--surface-2)}
.iconBtn svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.iMoon{display:none}
[data-theme="night"] .iSun{display:none}
[data-theme="night"] .iMoon{display:block}
.primaryBtn{
  display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 16px;border-radius:999px;
  background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;
  box-shadow:0 1px 2px rgba(0,122,255,.28),0 6px 16px -8px rgba(0,122,255,.5);
  transition:transform .18s,filter .18s,box-shadow .18s;white-space:nowrap;
}
.primaryBtn:hover{filter:brightness(1.06);box-shadow:0 1px 2px rgba(0,122,255,.3),0 10px 22px -10px rgba(0,122,255,.55)}
.primaryBtn:active{transform:scale(.98)}
.primaryBtn .spark{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 2s infinite}
.primaryBtn .spark.spin{animation:spin 1s linear infinite}

/* ---------- hero ---------- */
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.08fr);gap:56px;padding:66px 0 12px;align-items:center}
.heroLead{display:flex;flex-direction:column;justify-content:center;min-width:0}
.eyebrow{display:inline-flex;align-items:center;gap:9px;font:11.5px var(--mono);letter-spacing:.03em;color:var(--muted);margin:0}
.eyebrow i{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px var(--ok-soft);animation:pulse 2.4s infinite}
.hero h1{font:650 clamp(40px,4.9vw,62px)/1.06 var(--display);letter-spacing:-.035em;margin:18px 0 0;color:var(--text)}
.hero h1 .grad{background:linear-gradient(96deg,#0071e3 8%,#32ade6 92%);-webkit-background-clip:text;background-clip:text;color:transparent}
.heroSub{margin:20px 0 0;max-width:46ch;color:var(--muted);font-size:15px;line-height:1.75}
.heroActions{display:flex;gap:10px;margin-top:30px;flex-wrap:wrap}
.ghostBtn{
  display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:999px;
  background:var(--surface);border:1px solid var(--line);color:var(--text-2);font-size:12.5px;font-weight:500;
  box-shadow:var(--shadow-xs);transition:background .18s,border-color .18s,transform .18s;
}
.ghostBtn:hover{background:var(--surface-2);border-color:var(--line-2)}
.ghostBtn:active{transform:scale(.98)}
.heroGrid{display:grid;grid-template-columns:1.2fr .92fr;grid-template-rows:auto auto;gap:16px;min-width:0}
.glass{position:relative;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow-sm);overflow:hidden}
.statusCard{grid-row:1/3;padding:24px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:20px;min-width:0}
.statusHead{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%}
.statusBadge{display:inline-flex;align-items:center;gap:5px;font:10.5px var(--mono);color:var(--ok);background:var(--ok-soft);padding:3px 8px;border-radius:999px}
.statusBadge::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
.ringWrap{position:relative;width:178px;height:178px;flex:none}
.ringWrap svg{width:100%;height:100%;transform:rotate(-90deg)}
.ringTrack{stroke:var(--ring-track)}
.ringFg{transition:stroke-dashoffset .9s cubic-bezier(.2,.7,.2,1)}
.ringCenter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.ringCenter b{font:650 46px/1 var(--display);letter-spacing:-.05em;font-variant-numeric:tabular-nums}
.ringCenter small{font:12px var(--mono);color:var(--muted);margin-top:3px}
.ringCenter em{font:500 9.5px var(--sans);font-style:normal;letter-spacing:.14em;color:var(--dim);margin-top:8px}
.statusMeta{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%}
.statusMeta div{padding:11px 13px;border-radius:14px;background:var(--surface-2);min-width:0}
.statusMeta b{display:block;font-size:20px;font-weight:600;line-height:1.2;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.statusMeta span{display:block;font-size:10.5px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nextCard{padding:22px 24px;display:flex;flex-direction:column;justify-content:center;min-width:0}
.cardKicker{margin:0 0 9px;font:500 10px var(--mono);letter-spacing:.1em;color:var(--dim)}
.nextTime{font:600 36px/1 var(--display);letter-spacing:-.035em;font-variant-numeric:tabular-nums}
.nextDate{font:11px var(--mono);color:var(--muted);margin-top:6px}
.nextNote{font-size:11.5px;color:var(--muted);margin:8px 0 13px;line-height:1.55}
.cronPills{display:flex;gap:5px;flex-wrap:wrap}
.cronPills span{font:10.5px var(--mono);padding:3px 8px;border-radius:7px;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.travelCard{padding:22px 24px;display:flex;flex-direction:column;justify-content:space-between;min-width:0}
.travelTop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.travelState{font:500 10px var(--sans);letter-spacing:.01em;padding:4px 8px;border-radius:999px;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.travelState.s-traveling{color:var(--accent);background:var(--accent-soft)}
.travelState.s-arrived,.travelState.s-finished{color:var(--ok);background:var(--ok-soft)}
.travelState.s-error{color:var(--bad);background:var(--bad-soft)}
.travelWho{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:8px}
.travelMeta{font:11px/1.65 var(--mono);color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.travelRoute{position:relative;height:24px;margin:8px 0 6px}
.travelRoute .track{position:absolute;left:4px;right:4px;top:50%;height:2px;border-radius:2px;background:linear-gradient(90deg,var(--accent-line),var(--accent))}
.travelRoute .dot{position:absolute;top:50%;left:6%;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft);transform:translate(-50%,-50%);animation:route 5.5s ease-in-out infinite}
.travelRoute .dot.still{animation:none;left:92%;background:var(--ok);box-shadow:0 0 0 4px var(--ok-soft)}
.travelFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.travelFoot .reward{font:600 15px/1 var(--display);color:var(--accent);font-variant-numeric:tabular-nums}
.travelFoot button{margin-left:auto;font-size:11.5px;font-weight:500;padding:5px 2px;color:var(--accent)}
.travelFoot button:hover{opacity:.7}
.travelEmpty{font-size:12px;line-height:1.7;color:var(--muted);padding:6px 0}

/* ---------- sections ---------- */
.section{padding:60px 0 0}
section[id],#activity{scroll-margin-top:84px}
.sectionHead{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;margin-bottom:22px;flex-wrap:wrap}
.sectionHead h2{font-size:clamp(24px,2.4vw,30px);font-weight:650;line-height:1.15;letter-spacing:-.025em;margin:0}
.sectionHead p{margin:6px 0 0;font-size:13px;color:var(--muted)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:6px;height:6px;border-radius:50%;background:currentColor}
.legend .ok{color:var(--ok)} .legend .warn{color:var(--warn)} .legend .bad{color:var(--bad)} .legend .idle{color:var(--dim)}

/* ---------- platform matrix ---------- */
.platformGrid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;min-width:0}
.platformGrid>*{min-width:0}
.pTile{
  position:relative;padding:16px;border-radius:20px;border:1px solid var(--line);
  background:var(--surface);cursor:pointer;text-align:left;overflow:hidden;box-shadow:var(--shadow-xs);min-width:0;
  transition:transform .2s,border-color .2s,box-shadow .2s;
}
.pTile:hover{transform:translateY(-2px);border-color:var(--line-2);box-shadow:var(--shadow-md)}
.pTile.on{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft),var(--shadow-sm)}
.pOrb{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:13px;font-weight:650;color:#fff;background:linear-gradient(160deg,var(--c1),var(--c2));margin-bottom:12px;box-shadow:0 4px 10px -4px rgba(0,0,0,.3);text-shadow:0 1px 2px rgba(0,0,0,.18)}
.pTile b{display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pTile small{display:block;font-size:11px;color:var(--muted);margin-top:3px}
.pBar{display:block;height:4px;border-radius:999px;background:var(--surface-2);margin-top:14px;overflow:hidden}
.pBar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--c1),var(--c2));transition:width .6s}
.pDots{display:flex;gap:3px;margin-top:8px;height:6px}
.pDots i{width:6px;height:6px;border-radius:50%;background:var(--surface-3)}
.pDots i.ok{background:var(--ok)}
.pDots i.bad{background:var(--bad)}
.pDots i.warn{background:var(--warn)}
.pDots i.off{background:transparent;border:1px solid var(--line-2)}

/* ---------- account matrix ---------- */
.accountTools{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.filterRow{display:flex;gap:4px;flex-wrap:wrap;padding:3px;border-radius:999px;background:var(--surface-2)}
.pill{padding:6px 13px;border-radius:999px;font-size:11.5px;font-weight:500;color:var(--muted);transition:color .18s,background .18s,box-shadow .18s}
.pill:hover{color:var(--text)}
.pill.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-xs),0 0 0 .5px var(--line)}
.searchBox{display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:999px;background:var(--surface-2);border:1px solid transparent;transition:background .18s,border-color .18s,box-shadow .18s}
.searchBox:focus-within{background:var(--surface);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.searchBox svg{width:14px;height:14px;fill:none;stroke:var(--dim);stroke-width:1.8;stroke-linecap:round}
.searchBox input{width:132px;border:0;background:transparent;outline:0;font-size:12px;color:var(--text)}
.searchBox input::placeholder{color:var(--dim)}
.acctGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(326px,1fr));gap:14px;min-width:0}
.acctGrid>*{min-width:0}
.aCard{
  position:relative;padding:20px;border-radius:22px;border:1px solid var(--line);
  background:var(--surface);cursor:pointer;overflow:hidden;box-shadow:var(--shadow-xs);
  transition:transform .22s,border-color .22s,box-shadow .22s;
  animation:rise .5s both;animation-delay:calc(var(--i,0)*20ms);
}
.aCard:hover{transform:translateY(-2px);border-color:var(--line-2);box-shadow:var(--shadow-md)}
.aCard.off{opacity:.56}
.aTop{display:flex;align-items:center;gap:10px;min-width:0}
.aOrb{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;font-size:12px;font-weight:650;color:#fff;background:linear-gradient(160deg,var(--c1),var(--c2));flex:none;text-shadow:0 1px 2px rgba(0,0,0,.18)}
.aNames{min-width:0}
.aNames b{display:block;font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aNames small{display:block;font:10.5px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.aStatus{margin-left:auto;display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border-radius:999px;background:var(--surface-2);font-size:10.5px;font-weight:500;color:var(--muted);white-space:nowrap;flex:none}
.aStatus i{width:5px;height:5px;border-radius:50%;background:currentColor}
.aStatus.ok{color:var(--ok);background:var(--ok-soft)}
.aStatus.warn{color:var(--warn);background:var(--warn-soft)}
.aStatus.bad{color:var(--bad);background:var(--bad-soft)}
.aStatus.off,.aStatus.idle{color:var(--muted);background:var(--surface-2)}
.aMsg{margin:14px 0 0;font-size:12px;line-height:1.62;color:var(--muted);min-height:39px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.aStats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:16px;padding-top:15px;border-top:1px solid var(--line)}
.aStats b{display:block;font-size:20px;font-weight:600;line-height:1.2;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aStats span{display:block;font-size:10.5px;color:var(--muted);margin-top:3px}
.aTravel{margin-top:13px;padding:9px 11px;border-radius:12px;background:var(--surface-2);display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);min-width:0}
.aTravel .tState{font-size:9.5px;font-weight:500;padding:3px 7px;border-radius:999px;background:var(--surface);color:var(--muted);white-space:nowrap;flex:none}
.aTravel .tState.s-traveling{color:var(--accent);background:var(--accent-soft)}
.aTravel .tState.s-arrived,.aTravel .tState.s-finished{color:var(--ok);background:var(--ok-soft)}
.aTravel .tState.s-error{color:var(--bad);background:var(--bad-soft)}
.aTravel .tText{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aActions{display:flex;gap:7px;margin-top:14px}
.aActions button{flex:1;padding:9px;border-radius:10px;background:var(--surface-2);font-size:11.5px;font-weight:500;color:var(--text-2);transition:background .18s,color .18s,filter .18s}
.aActions button:hover{background:var(--surface-3);color:var(--text)}
.aActions button.primary{background:var(--accent);color:var(--on-accent)}
.aActions button.primary:hover{filter:brightness(1.06)}
.footNote{margin:16px 0 0;font:10.5px var(--mono);color:var(--dim)}

/* ---------- travel missions ---------- */
.missionGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;min-width:0}
.missionGrid>*{min-width:0}
.mission{padding:20px 22px;border-radius:22px;border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow-xs);position:relative;overflow:hidden;min-width:0}
.missionTop{display:flex;align-items:center;gap:8px;min-width:0}
.missionTop b{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.missionTop .travelState{margin-left:auto;flex:none}
.missionRoute{position:relative;height:46px;margin:12px 0 4px}
.missionRoute .track{position:absolute;left:6%;right:6%;top:50%;height:2px;border-radius:2px;background:linear-gradient(90deg,var(--accent-line),var(--accent))}
.missionRoute .node{position:absolute;top:50%;width:7px;height:7px;border-radius:50%;border:1px solid var(--line-2);background:var(--surface);transform:translate(-50%,-50%)}
.missionRoute .node.start{left:6%}
.missionRoute .node.end{left:94%}
.missionRoute .dot{position:absolute;top:50%;width:11px;height:11px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft);transform:translate(-50%,-50%);animation:route 5.8s ease-in-out infinite}
.missionRoute .dot.arrived{animation:none;left:92%;background:var(--ok);box-shadow:0 0 0 4px var(--ok-soft)}
.missionRoute .dot.idle{animation:none;left:6%;background:var(--dim);box-shadow:0 0 0 4px var(--surface-2)}
.missionMeta{font:11px/1.7 var(--mono);color:var(--muted);min-height:36px}
.missionActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:13px}
.missionActions button{font-size:11.5px;font-weight:500;padding:5px 2px;color:var(--accent)}
.missionActions button:hover{opacity:.7}
.missionActions button.primary{background:var(--accent-soft);color:var(--accent);padding:5px 11px;border-radius:999px}
.missionActions .switch{margin-left:auto}

/* ---------- switch ---------- */
.switch{display:inline-flex;align-items:center;gap:7px;font-size:10.5px;color:var(--muted);cursor:pointer;white-space:nowrap}
.switch i{font-style:normal}
.switch input{position:absolute;opacity:0;width:1px;height:1px}
.switch .track{width:38px;height:23px;border-radius:999px;background:var(--surface-3);position:relative;display:inline-block;transition:background .2s}
.switch .track::after{content:"";position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.switch input:checked+.track{background:var(--ok)}
.switch input:checked+.track::after{transform:translateX(15px)}
.switch input:focus-visible+.track{outline:2px solid var(--accent);outline-offset:2px}

/* ---------- bottom ---------- */
.bottomGrid{display:grid;grid-template-columns:1.3fr .9fr;gap:16px;padding-top:60px}
.activityCard,.systemCard{padding:24px 26px}
.systemCard{display:flex;flex-direction:column}
.systemCard .sysActions{margin-top:auto}
.bottomHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.bottomHead h2{font-size:20px;font-weight:650;letter-spacing:-.02em;margin:0}
.linkBtn{font-size:12px;font-weight:500;color:var(--accent);padding:5px 0;background:none;border:0}
.linkBtn:hover{opacity:.7}
.activityList{display:flex;flex-direction:column}
.actRow{display:grid;grid-template-columns:44px 7px minmax(0,1fr);gap:10px;align-items:start;padding:11px 0;border-bottom:1px solid var(--line)}
.actRow:last-child{border-bottom:0}
.actRow time{font:10.5px/1.7 var(--mono);color:var(--dim)}
.actRow .dot{width:6px;height:6px;border-radius:50%;background:var(--dim);margin-top:6px}
.actRow .dot.ok{background:var(--ok)}
.actRow .dot.bad{background:var(--bad)}
.actRow .dot.warn{background:var(--warn)}
.actRow p{margin:0;font-size:12px;line-height:1.58;color:var(--muted)}
.actRow b{font-weight:600;color:var(--text)}
.sysGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0 0}
dl.sysGrid{margin:10px 0 0}
.sysItem{padding:11px 13px;border-radius:14px;background:var(--surface-2);min-width:0}
.sysItem small{display:block;font-size:10.5px;color:var(--muted);margin-bottom:3px}
.sysItem b{display:block;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sysActions{display:flex;gap:4px;flex-wrap:wrap;margin-top:13px}
.sysActions button{font-size:11.5px;font-weight:500;padding:6px 10px;border-radius:8px;color:var(--accent);background:transparent}
.sysActions button:hover{background:var(--accent-soft)}

.footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:32px 0 36px;margin-top:48px;border-top:1px solid var(--line);font-size:11px;color:var(--dim)}

/* ---------- dialogs ---------- */
.veil{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.32);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:fade .2s ease both}
.veil[hidden]{display:none}
.sheet{
  width:min(700px,100%);max-height:90vh;overflow:auto;position:relative;
  border:1px solid var(--line);border-radius:28px;background:var(--surface);
  box-shadow:var(--shadow-lg);animation:pop .26s cubic-bezier(.2,.7,.2,1) both;
}
.sheet.narrow{width:min(430px,100%)}
.sheet.wide{width:min(800px,100%)}
.sheetHead{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:24px 26px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2;background:var(--surface)}
.sheetHead h2{font-size:24px;font-weight:650;line-height:1.15;letter-spacing:-.025em;margin:0}
.sheetHead p{margin:6px 0 0;font-size:12.5px;line-height:1.6;color:var(--muted);max-width:54ch}
.kicker{margin:0 0 6px;font:500 10px var(--mono);letter-spacing:.1em;color:var(--dim)}
.closeX{width:30px;height:30px;border-radius:999px;background:var(--surface-2);display:grid;place-items:center;font-size:17px;line-height:1;color:var(--muted);flex:none;transition:background .18s,color .18s}
.closeX:hover{background:var(--surface-3);color:var(--text)}
.sheetBody{padding:20px 26px 26px}
.sheetFoot{display:flex;justify-content:flex-end;gap:9px;padding:15px 26px;border-top:1px solid var(--line);position:sticky;bottom:0;background:var(--surface);z-index:2}
.secTitle{font-size:16px;font-weight:650;letter-spacing:-.01em;margin:26px 0 10px;padding-top:20px;border-top:1px solid var(--line)}
.secTitle:first-child{margin-top:0;padding-top:0;border-top:0}
.hint{margin:0 0 14px;font-size:12.5px;line-height:1.65;color:var(--muted)}
.err{min-height:16px;margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--bad)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.field{display:block;margin-bottom:15px;min-width:0}
.field label{display:block;margin-bottom:6px;font-size:11.5px;font-weight:500;color:var(--muted)}
.field input,.field textarea,.field select{
  width:100%;min-height:42px;padding:10px 12px;border-radius:12px;border:1px solid transparent;
  background:var(--surface-2);font:12.5px/1.5 var(--sans);color:var(--text);
  transition:background .18s,border-color .18s,box-shadow .18s;
}
.field input:focus,.field textarea:focus,.field select:focus{background:var(--surface);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);outline:none}
.field textarea{resize:vertical;min-height:64px;font-family:var(--mono);font-size:11.5px}
.field select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 16px) 18px,calc(100% - 11px) 18px;background-size:5px 5px;background-repeat:no-repeat}
.field .opt{color:var(--dim);margin-left:5px;font-weight:400}
.check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);min-height:42px}
.field .check{margin-top:22px}
.check input{width:16px;height:16px;min-height:0;accent-color:var(--accent)}
.rowBtns{display:flex;flex-wrap:wrap;gap:8px}
.btn{min-height:40px;padding:0 15px;border-radius:12px;background:var(--surface-2);font-size:12.5px;font-weight:500;color:var(--text-2);transition:background .18s,color .18s,filter .18s}
.btn:hover{background:var(--surface-3);color:var(--text)}
.btn.primary{background:var(--accent);color:var(--on-accent)}
.btn.primary:hover{filter:brightness(1.06);color:var(--on-accent)}
.btn.sm{min-height:34px;padding:0 12px;font-size:11.5px}
.btn.wide{width:100%}
.btn.danger{color:var(--bad);background:var(--bad-soft)}
.platChips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:20px}
.platChips button{padding:7px 11px;border-radius:999px;background:var(--surface-2);font-size:11.5px;font-weight:500;color:var(--muted);transition:background .18s,color .18s}
.platChips button:hover{color:var(--text);background:var(--surface-3)}
.platChips button.on{background:var(--accent);color:var(--on-accent)}
.authBox{border-top:1px solid var(--line);padding-top:16px;margin-bottom:10px}
.authBox h3{font-size:15px;font-weight:650;margin:0 0 5px}
.authBox p{font-size:12px;line-height:1.65;color:var(--muted);margin:0 0 12px}
.authMsg{min-height:16px;margin:10px 0 0;font-size:11.5px;line-height:1.55;color:var(--muted);word-break:break-all}
.authMsg a{color:var(--accent);text-decoration:underline}
.authMsg.ok{color:var(--ok)} .authMsg.err{color:var(--bad)}
.divider{display:flex;align-items:center;gap:10px;margin:18px 0;font-size:10.5px;color:var(--dim)}
.divider::before,.divider::after{content:"";height:1px;background:var(--line);flex:1}
.modeTabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--line)}
.modeTabs button{padding:9px 10px;font-size:12px;font-weight:500;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.modeTabs button.on{color:var(--text);border-color:var(--accent)}
.code{margin:0;padding:12px 13px;border-radius:12px;background:var(--surface-2);font:11px/1.7 var(--mono);color:var(--muted);overflow:auto;white-space:pre-wrap;word-break:break-all}

/* ---------- account modal ---------- */
.acctModalTop{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.acctModalOrb{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:17px;font-weight:650;color:#fff;background:linear-gradient(160deg,var(--c1),var(--c2));flex:none;text-shadow:0 1px 2px rgba(0,0,0,.18)}
.acctModalMeta{min-width:0}
.acctModalMeta b{display:block;font-size:13.5px;font-weight:600;line-height:1.35}
.acctModalMeta small{display:block;font:10.5px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modalStatus{margin-left:auto}
.modalMsg{margin:18px 0 0;font-size:13px;line-height:1.7;color:var(--text-2)}
.modalGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px 0}
.modalGrid div{padding:11px 13px;border-radius:14px;background:var(--surface-2);min-width:0}
.modalGrid small{display:block;font-size:10.5px;color:var(--muted);margin-bottom:3px}
.modalGrid b{display:block;font:600 12px/1.4 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modalBlock{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.modalBlockHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
.modalBlockHead b{font-size:13px;font-weight:600}
.modalNote{font-size:12px;line-height:1.65;color:var(--muted);margin:0}
.modalActions{display:flex;flex-wrap:wrap;gap:7px;margin-top:18px}
.modalActions button{min-height:36px;padding:0 12px;border-radius:10px;background:var(--surface-2);font-size:11.5px;font-weight:500;color:var(--text-2)}
.modalActions button:hover{background:var(--surface-3);color:var(--text)}
.modalActions button.primary{background:var(--accent);color:var(--on-accent)}
.modalActions button.danger{background:var(--bad-soft);color:var(--bad)}
.modalTravel{margin-top:18px;padding:15px;border-radius:16px;background:var(--surface-2)}
.modalTravel .missionRoute{margin:10px 0 8px;height:38px}
.modalTravel .modalNote{color:var(--muted)}

/* ---------- toasts ---------- */
.toasts{position:fixed;right:22px;bottom:22px;z-index:100;display:flex;flex-direction:column;gap:7px;max-width:min(380px,calc(100vw - 44px));pointer-events:none}
.toast{border-radius:13px;background:var(--toast-bg);padding:11px 14px;font-size:12px;line-height:1.55;color:#f5f5f7;box-shadow:0 16px 40px -12px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.12);animation:toast .24s ease both;border-left:3px solid var(--dim)}
.toast.ok{border-left-color:var(--ok)}
.toast.err{border-left-color:var(--bad)}
.toast.warn{border-left-color:var(--warn)}

/* ---------- motion ---------- */
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes pop{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
@keyframes toast{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes route{0%{left:6%}50%{left:92%}100%{left:6%}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}html{scroll-behavior:auto}}

/* ---------- responsive ---------- */
@media (max-width:1120px){
  .platformGrid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .hero{grid-template-columns:1fr;gap:30px}
  .heroGrid{grid-template-columns:1.1fr .9fr}
  .hero h1{font-size:clamp(40px,6.4vw,58px)}
}
@media (max-width:860px){
  .topbarIn{height:auto;padding:10px 0;flex-wrap:wrap;gap:9px}
  .topTabs{order:3;width:100%;justify-content:space-between;overflow:auto}
  .topRight{margin-left:auto}
  .livePill{display:none}
  .bottomGrid{grid-template-columns:1fr}
}
@media (max-width:720px){
  .shell{width:calc(100% - 32px)}
  .hero{padding-top:38px}
  .heroGrid{grid-template-columns:1fr;grid-template-rows:auto}
  .statusCard{grid-row:auto;flex-direction:row;flex-wrap:wrap;justify-content:center;gap:16px;padding:20px}
  .ringWrap{width:150px;height:150px}
  .ringCenter b{font-size:38px}
  .statusHead{width:100%}
  .statusMeta{width:100%}
  .section{padding-top:46px}
  section[id],#activity{scroll-margin-top:112px}
  .sectionHead{align-items:flex-start}
  .sectionHead h2{font-size:24px}
  .accountTools{width:100%}
  .searchBox{flex:1}
  .searchBox input{width:100%}
  .platformGrid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .topTabs button{flex:1;text-align:center;padding:7px 4px}
  .acctGrid{grid-template-columns:1fr}
  .missionGrid{grid-template-columns:1fr}
  .two{grid-template-columns:1fr}
  .modalGrid{grid-template-columns:1fr}
  .veil{padding:10px}
  .sheet{max-height:94vh;border-radius:24px}
  .sheetHead,.sheetBody{padding-left:18px;padding-right:18px}
  .sheetFoot{padding:13px 18px}
  .toasts{right:12px;left:12px;bottom:12px;max-width:none}
  .footer{padding:24px 0}
}
</style>
</head>
<body>
<a class="skip" href="#accounts">跳到账号</a>

<header class="topbar">
  <div class="shell topbarIn">
    <a class="brand" href="#overview" aria-label="签到塔首页">
      <span class="brandOrb" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4.5 12.5 5 5 10-11"/></svg></span>
      <span class="brandText"><b>签到塔</b><em>SIGN-IN TOWER</em></span>
    </a>
    <nav class="topTabs" aria-label="页面导航">
      <button type="button" data-jump="overview" class="on">总览</button>
      <button type="button" data-jump="platforms">平台</button>
      <button type="button" data-jump="accounts">账号</button>
      <button type="button" data-jump="travel">旅行</button>
    </nav>
    <div class="topRight">
      <span class="livePill"><i aria-hidden="true"></i><span id="barClock">--:--:--</span> 北京</span>
      <button class="iconBtn" id="themeBtn" type="button" aria-label="切换日间/夜间模式">
        <svg class="iSun" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>
        <svg class="iMoon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <button class="iconBtn" id="settingsBtn" type="button" aria-label="设置">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v4H21a1.7 1.7 0 0 0-1.6 1z"/></svg>
      </button>
      <button class="primaryBtn" id="runAllBtn" type="button"><span class="spark" aria-hidden="true"></span>运行全部</button>
    </div>
  </div>
</header>

<main class="shell">
  <section class="hero" id="overview">
    <div class="heroLead">
      <p class="eyebrow"><i aria-hidden="true"></i> 实时状态 · 北京时间 <span id="todayStr">—</span></p>
      <h1>今日签到<br><span class="grad">一目了然。</span></h1>
      <p class="heroSub" id="mastSub">正在读取今日状态…</p>
      <div class="heroActions">
        <button class="primaryBtn" type="button" data-act="add">＋ 添加账号</button>
        <button class="ghostBtn" type="button" id="refreshBtn">刷新状态</button>
      </div>
    </div>
    <div class="heroGrid">
      <article class="glass statusCard" aria-label="今日完成度">
        <div class="statusHead">
          <p class="cardKicker" style="margin:0">TODAY · 今日完成</p>
          <span class="statusBadge">实时</span>
        </div>
        <div class="ringWrap">
          <svg width="178" height="178" viewBox="0 0 186 186" aria-hidden="true">
            <defs>
              <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#007aff"/>
                <stop offset="60%" stop-color="#32ade6"/>
                <stop offset="100%" stop-color="#64d2ff"/>
              </linearGradient>
            </defs>
            <circle class="ringTrack" cx="93" cy="93" r="78" fill="none" stroke-width="10"/>
            <circle class="ringFg" id="ringFg" cx="93" cy="93" r="78" fill="none" stroke="url(#ringGrad)" stroke-width="10" stroke-linecap="round" stroke-dasharray="490" stroke-dashoffset="490"/>
          </svg>
          <div class="ringCenter">
            <b id="heroVerified">—</b>
            <small id="heroEnabled">/ —</small>
            <em>已确认</em>
          </div>
        </div>
        <div class="statusMeta">
          <div><b id="heroPending">—</b><span>待确认</span></div>
          <div><b id="heroFailed">—</b><span>失败 / 受限</span></div>
          <div><b id="heroCredit">—</b><span>今日积分</span></div>
          <div><b id="heroTravel">—</b><span>旅行在途</span></div>
        </div>
      </article>

      <article class="glass nextCard" aria-label="下次自动签到">
        <p class="cardKicker">NEXT RUN · 下次自动签到</p>
        <b class="nextTime" id="nextRun">—</b>
        <p class="nextDate" id="nextDate">—</p>
        <p class="nextNote">Cloudflare Cron · 自动签到、复核与旅行</p>
        <div class="cronPills" id="cronPills"></div>
      </article>

      <article class="glass travelCard" id="travelHero" aria-label="旅行任务">
        <p class="cardKicker">TRAVEL · 自动旅行</p>
        <div class="travelEmpty">正在读取旅行状态…</div>
      </article>
    </div>
  </section>

  <section class="section" id="platforms">
    <div class="sectionHead">
      <div>
        <h2>平台</h2>
        <p>点选一个平台，只看它的账号；再点一次取消。</p>
      </div>
      <div class="legend" aria-label="状态图例">
        <span class="ok"><i aria-hidden="true"></i>已确认</span>
        <span class="warn"><i aria-hidden="true"></i>待确认</span>
        <span class="bad"><i aria-hidden="true"></i>失败</span>
        <span class="idle"><i aria-hidden="true"></i>未完成</span>
      </div>
    </div>
    <div class="platformGrid" id="platformGrid"></div>
  </section>

  <section class="section" id="accounts">
    <div class="sectionHead">
      <div>
        <h2>账号</h2>
        <p id="accountSub">正在读取账号…</p>
      </div>
      <div class="accountTools">
        <div class="filterRow" id="filters" role="group" aria-label="筛选账号">
          <button type="button" class="pill on" data-filter="all">全部</button>
          <button type="button" class="pill" data-filter="attention">需关注</button>
          <button type="button" class="pill" data-filter="done">已确认</button>
          <button type="button" class="pill" data-filter="verify">待确认</button>
          <button type="button" class="pill" data-filter="off">已停用</button>
        </div>
        <label class="searchBox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="search" type="search" placeholder="搜索账号 / 平台" aria-label="搜索账号或平台">
        </label>
      </div>
    </div>
    <div class="acctGrid" id="acctGrid">
      <div class="aCard"><p class="modalNote">正在读取账号矩阵…</p></div>
    </div>
    <p class="footNote" id="accountFoot"></p>
  </section>

  <section class="section" id="travel">
    <div class="sectionHead">
      <div>
        <h2>自动旅行</h2>
        <p>WorkBuddy 成长中心 · 自动派发、到点领取，每日次数用尽后停止。</p>
      </div>
      <button class="linkBtn" type="button" data-act="travel-run">同步全部 →</button>
    </div>
    <div class="missionGrid" id="missionGrid"></div>
  </section>

  <section class="bottomGrid" id="activity">
    <article class="glass activityCard">
      <div class="bottomHead">
        <h2>最近活动</h2>
        <button class="linkBtn" type="button" data-act="history">全部记录 →</button>
      </div>
      <div class="activityList" id="activityList"></div>
    </article>

    <article class="glass systemCard">
      <div class="bottomHead">
        <h2>状态</h2>
        <span class="cardKicker" style="margin:0">SYSTEM</span>
      </div>
      <div class="sysGrid">
        <div class="sysItem"><small>当前 Cron</small><b id="sysCron">—</b></div>
        <div class="sysItem"><small>下次运行</small><b id="sysNext">—</b></div>
        <div class="sysItem"><small>账号</small><b id="sysAccounts">—</b></div>
        <div class="sysItem"><small>平台</small><b id="sysPlatforms">—</b></div>
      </div>
      <div class="sysActions">
        <button type="button" data-act="settings">通知设置</button>
        <button type="button" data-act="refresh-all">刷新全部</button>
        <button type="button" data-act="history">全部记录</button>
      </div>
    </article>
  </section>

  <footer class="footer">
    <span>签到塔 · SIGN-IN TOWER</span>
    <span>Cloudflare Workers · 单文件 · 零依赖</span>
  </footer>
</main>

<!-- 登录 -->
<div class="veil" id="loginVeil" hidden>
  <div class="sheet narrow" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
    <div class="sheetHead">
      <div>
        <p class="kicker">ACCESS</p>
        <h2 id="loginTitle">值班口令</h2>
        <p>输入部署时设置的 ADMIN_TOKEN 进入控制台。</p>
      </div>
    </div>
    <div class="sheetBody">
      <div class="field">
        <label for="loginToken">ADMIN_TOKEN</label>
        <input id="loginToken" type="password" autocomplete="current-password" placeholder="部署时设置的口令">
      </div>
      <p class="err" id="loginErr"></p>
      <button class="btn primary wide" id="loginBtn" type="button">进入控制台</button>
    </div>
  </div>
</div>

<!-- 账号详情 -->
<div class="veil" id="acctVeil" hidden>
  <div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="acctTitle">
    <div class="sheetHead">
      <div>
        <p class="kicker" id="acctKicker">ACCOUNT</p>
        <h2 id="acctTitle">账号</h2>
        <p id="acctSub"></p>
      </div>
      <button class="closeX" type="button" data-close="acctVeil" aria-label="关闭">×</button>
    </div>
    <div class="sheetBody" id="acctBody"></div>
  </div>
</div>

<!-- 添加账号 -->
<div class="veil" id="addVeil" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="addTitle">
    <div class="sheetHead">
      <div>
        <p class="kicker">NEW ACCOUNT</p>
        <h2 id="addTitle">添加账号</h2>
        <p id="addHint"></p>
      </div>
      <button class="closeX" type="button" data-close="addVeil" aria-label="关闭">×</button>
    </div>
    <div class="sheetBody">
      <div class="platChips" id="platChips"></div>
      <div id="addBody"></div>
      <p class="err" id="addErr"></p>
    </div>
    <div class="sheetFoot">
      <button class="btn" type="button" data-close="addVeil">取消</button>
      <button class="btn primary" id="addConfirm" type="button">确认添加</button>
    </div>
  </div>
</div>

<!-- 设置 -->
<div class="veil" id="setVeil" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="setTitle">
    <div class="sheetHead">
      <div>
        <p class="kicker">CONFIG</p>
        <h2 id="setTitle">设置</h2>
        <p>通知通道、定时信息与数据维护。</p>
      </div>
      <button class="closeX" type="button" data-close="setVeil" aria-label="关闭">×</button>
    </div>
    <div class="sheetBody">
      <h3 class="secTitle">通知通道</h3>
      <p class="hint">每轮 Cron 有实际结果时推送一条汇总；通道失败不影响签到。</p>
      <div class="two">
        <div class="field"><label for="tgToken">Telegram Bot Token</label><input id="tgToken" type="password" autocomplete="off" placeholder="123456:ABC..."></div>
        <div class="field"><label for="tgChat">Telegram Chat ID</label><input id="tgChat" autocomplete="off" placeholder="123456789"></div>
        <div class="field"><label for="qqAppId">QQ AppID</label><input id="qqAppId" autocomplete="off" placeholder="102xxxxxx"></div>
        <div class="field"><label for="qqSecret">QQ AppSecret</label><input id="qqSecret" type="password" autocomplete="off" placeholder="AppSecret"></div>
        <div class="field"><label for="qqOpenid">QQ 用户 OpenID</label><input id="qqOpenid" autocomplete="off" placeholder="私聊机器人后打印的 openid"></div>
        <div class="field"><label class="check"><input id="qqSandbox" type="checkbox"> 使用 QQ 沙箱环境</label></div>
      </div>
      <p class="err" id="setErr"></p>
      <div class="rowBtns">
        <button class="btn sm" id="notifyTest" type="button">发送测试</button>
        <button class="btn primary sm" id="notifySave" type="button">保存通知</button>
      </div>

      <h3 class="secTitle">定时与维护</h3>
      <dl class="sysGrid" id="setSys"></dl>
      <p class="hint" id="cronTip"></p>
      <div class="rowBtns">
        <button class="btn sm" id="refreshAllBtn" type="button">刷新全部账号</button>
        <button class="btn sm" id="clearHistBtn" type="button">清空运行记录</button>
        <button class="btn sm" id="forgetBtn" type="button">更换口令</button>
      </div>

      <h3 class="secTitle">QQ OpenID 助手</h3>
      <p class="hint">在电脑上执行下面的命令，然后私聊机器人一次，终端会打印 openid。</p>
      <pre class="code" id="oidCmd"></pre>
    </div>
  </div>
</div>

<!-- 运行记录 -->
<div class="veil" id="histVeil" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="histTitle">
    <div class="sheetHead">
      <div>
        <p class="kicker">RUN LOG</p>
        <h2 id="histTitle">运行记录</h2>
        <p>最近 300 条签到结果，新的在上面。</p>
      </div>
      <button class="closeX" type="button" data-close="histVeil" aria-label="关闭">×</button>
    </div>
    <div class="sheetBody" id="histBody"></div>
  </div>
</div>

<!-- 通用确认 / 输入 -->
<div class="veil" id="askVeil" hidden>
  <div class="sheet narrow" role="dialog" aria-modal="true" aria-labelledby="askTitle">
    <div class="sheetHead">
      <div>
        <p class="kicker" id="askKicker">CONFIRM</p>
        <h2 id="askTitle">确认</h2>
        <p id="askDesc"></p>
      </div>
    </div>
    <div class="sheetBody">
      <div class="field" id="askField">
        <label for="askInput" id="askLabel">值</label>
        <input id="askInput" autocomplete="off">
      </div>
      <p class="err" id="askErr"></p>
    </div>
    <div class="sheetFoot">
      <button class="btn" id="askCancel" type="button">取消</button>
      <button class="btn primary" id="askOk" type="button">确认</button>
    </div>
  </div>
</div>

<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>

<script>
(function(){
  'use strict';

  var TOKEN_KEY = 'tower.token';
  var THEME_KEY = 'tower.theme';
  var token = '';
  var S = { meta:null, data:null, history:[], filter:'all', platform:'', search:'', acct:null };
  var ADD = { pf:'', timer:null };
  var askResolve = null;

  function el(id){ return document.getElementById(id); }
  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){
      if(c === '&') return '&amp;';
      if(c === '<') return '&lt;';
      if(c === '>') return '&gt;';
      if(c === '"') return '&quot;';
      return '&#39;';
    });
  }
  function pad(n){ return n < 10 ? '0' + n : String(n); }
  function bj(){ return new Date(Date.now() + 28800000); }
  function fmtClock(sec){
    var d = bj();
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + (sec ? ':' + pad(d.getUTCSeconds()) : '');
  }
  function weekdayName(d){
    return ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][d.getUTCDay()];
  }
  function fmtDateLong(){
    var d = bj();
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' · ' + weekdayName(d);
  }
  function fmtDateTime(ms){
    if(!ms) return '—';
    var d = new Date(Number(ms) + 28800000);
    return (d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function show(v){ return v == null || v === '' ? '—' : String(v); }
  function compact(v){
    var n = Number(v);
    if(!isFinite(n)) return v == null ? '—' : String(v);
    if(Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n * 10) / 10);
  }

  var ACCENTS = {
    purple:['#bf5af2','#8944ab'], blue:['#0a84ff','#0060df'], lime:['#a3e635','#4d7c0f'],
    orange:['#ff9f0a','#c93400'], green:['#34c759','#1f7a33'], pink:['#ff375f','#c9184a'],
    cyan:['#64d2ff','#0071a4'], red:['#ff453a','#c41e1a'], yellow:['#ffd60a','#b25000'],
    gray:['#aeaeb2','#636366']
  };
  function grad(name){ return ACCENTS[name] || ACCENTS.gray; }
  function orbStyle(name){
    var g = grad(name);
    return '--c1:' + g[0] + ';--c2:' + g[1];
  }
  function initial(label){
    var s = String(label || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  function toast(msg, type){
    var box = el('toasts');
    if(!box) return;
    var div = document.createElement('div');
    div.className = 'toast ' + (type || '');
    div.textContent = msg;
    box.appendChild(div);
    setTimeout(function(){
      if(div.parentNode) div.parentNode.removeChild(div);
    }, 4200);
  }

  /* ---------- api ---------- */
  function api(path, opt){
    opt = opt || {};
    var headers = { 'X-Admin-Token': token };
    if(opt.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opt.method || 'GET',
      headers: headers,
      body: opt.body,
      credentials: 'same-origin'
    }).then(function(res){
      return res.text().then(function(txt){
        var data = null;
        try { data = JSON.parse(txt); } catch(e) { data = { error: txt || ('HTTP ' + res.status) }; }
        if(res.status === 401){
          showLogin('口令不正确或已失效');
          throw new Error((data && data.error) || '未授权');
        }
        if(!res.ok || (data && data.error)) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data || {};
      });
    });
  }

  /* ---------- login ---------- */
  function showLogin(msg){
    el('loginVeil').hidden = false;
    el('loginErr').textContent = msg || '';
    var input = el('loginToken');
    if(input){ input.value = token; input.focus(); input.select(); }
  }
  function tryLogin(){
    var v = el('loginToken').value.trim();
    if(!v){ el('loginErr').textContent = '请输入口令'; return; }
    var btn = el('loginBtn');
    btn.disabled = true; btn.textContent = '验证中…';
    fetch('/api/ping', { headers: { 'X-Admin-Token': v } })
      .then(function(res){
        return res.text().then(function(txt){
          var data = null;
          try { data = JSON.parse(txt); } catch(e) { data = {}; }
          return { ok: res.ok, data: data || {} };
        });
      })
      .then(function(r){
        if(!r.ok) throw new Error(r.data.error || '口令不正确');
        token = v;
        try { localStorage.setItem(TOKEN_KEY, v); } catch(e) {}
        el('loginVeil').hidden = true;
        el('loginErr').textContent = '';
        loadAll();
      })
      .catch(function(e){ el('loginErr').textContent = e.message; })
      .then(function(){ btn.disabled = false; btn.textContent = '进入控制台'; });
  }

  /* ---------- helpers ---------- */
  function metaOf(key){
    if(!S.meta || !S.meta.platforms) return null;
    for(var i = 0; i < S.meta.platforms.length; i++){
      if(S.meta.platforms[i].key === key) return S.meta.platforms[i];
    }
    return null;
  }
  function platformLabel(key){
    var m = metaOf(key);
    return m ? m.label : (key || '');
  }
  function findAccount(pf, id){
    var list = (S.data && S.data.accounts) || [];
    for(var i = 0; i < list.length; i++){
      if(list[i].platform === pf && list[i].id === id) return list[i];
    }
    return null;
  }
  function travelAccounts(){
    var list = (S.data && S.data.accounts) || [];
    var out = [];
    for(var i = 0; i < list.length; i++){
      if(list[i].platform === 'workbuddy') out.push(list[i]);
    }
    return out;
  }

  function statusOf(a){
    if(a.enabled === false) return { t:'已停用', c:'off' };
    if(a.signedToday) return { t:'已确认', c:'ok' };
    if(a.lastState === 'error' || a.lastState === 'token_dead') return { t:'失败', c:'bad' };
    if(a.lastState === 'unverified') return { t:'待确认', c:'warn' };
    if(a.lastState === 'blocked') return { t:'受限', c:'warn' };
    if(a.lastState === 'rate' || a.lastState === 'cooldown') return { t:'限流', c:'warn' };
    if(a.lastState === 'no_activity') return { t:'无活动', c:'idle' };
    return { t:'未完成', c:'idle' };
  }
  function travelText(label){
    var map = {
      traveling:'旅行中', arrived:'已到达', finished:'今日完成', untraveled:'未派发',
      'no-buddy':'无 Buddy', 'no-location':'地点不可用', error:'同步失败', disabled:'已停用'
    };
    return map[label] || '未派发';
  }
  function travelClass(label){
    if(label === 'traveling') return 's-traveling';
    if(label === 'arrived' || label === 'finished') return 's-arrived';
    if(label === 'error') return 's-error';
    return 's-untraveled';
  }
  function stateText(state){
    var map = {
      checked:'已签到', already:'今日已签', skipped:'已跳过', unverified:'待确认',
      error:'失败', token_dead:'凭证失效', blocked:'平台拦截', rate:'限流',
      cooldown:'冷却中', pending:'等待中', no_activity:'无活动', disabled:'已停用'
    };
    return map[state] || state || '未知';
  }

  /* ---------- load ---------- */
  function loadAll(){
    el('acctGrid').innerHTML = '<div class="aCard"><p class="modalNote">正在读取账号矩阵…</p></div>';
    el('missionGrid').innerHTML = '<div class="mission"><p class="modalNote">正在读取旅行任务…</p></div>';
    return Promise.all([
      api('/api/meta'),
      api('/api/overview'),
      api('/api/history?limit=60')
    ]).then(function(r){
      S.meta = r[0];
      S.data = r[1];
      S.history = (r[2] && r[2].entries) || [];
      renderAll();
    }).catch(function(e){
      el('acctGrid').innerHTML = '<div class="aCard"><p class="modalNote">读取失败：' + esc(e.message) + '</p></div>';
      if(token) toast(e.message, 'err');
    });
  }
  function loadQuiet(){
    Promise.all([
      api('/api/overview'),
      api('/api/history?limit=60')
    ]).then(function(r){
      S.data = r[0];
      S.history = (r[1] && r[1].entries) || [];
      renderAll();
    }).catch(function(){});
  }

  function renderAll(){
    if(!S.data || !S.meta) return;
    renderHero();
    renderPlatforms();
    renderAccounts();
    renderMissions();
    renderActivity();
    renderSystem();
    renderAccountModal();
  }

  /* ---------- hero ---------- */
  function renderHero(){
    var st = S.data.stats || {};
    var enabled = st.enabled || 0;
    var verified = st.verified || 0;
    var wb = travelAccounts();
    var traveling = 0;
    for(var i = 0; i < wb.length; i++){
      if(wb[i].travel && wb[i].travel.label === 'traveling') traveling++;
    }
    el('todayStr').textContent = S.data.today || '—';
    el('heroVerified').textContent = verified;
    el('heroEnabled').textContent = '/ ' + enabled;
    el('heroPending').textContent = st.unverified || 0;
    el('heroFailed').textContent = (st.failed || 0) + (st.blocked || 0);
    el('heroCredit').textContent = compact(st.todayCredit == null ? 0 : st.todayCredit);
    el('heroTravel').textContent = traveling + ' / ' + wb.length;
    el('mastSub').textContent = verified + ' / ' + enabled + ' 个账号已确认' +
      ((st.unverified || 0) + (st.failed || 0) > 0 ? '，' + ((st.unverified || 0) + (st.failed || 0)) + ' 个需要处理' : '，全部就绪') +
      '。自动旅行' + (traveling ? '有 ' + traveling + ' 只在途。' : '待命。');

    var ring = el('ringFg');
    if(ring){
      var circumference = 2 * Math.PI * 78;
      var pct = enabled > 0 ? Math.min(1, verified / enabled) : 0;
      ring.setAttribute('stroke-dasharray', String(circumference));
      ring.setAttribute('stroke-dashoffset', String(circumference * (1 - pct)));
    }

    var next = String(S.data.nextRun || '—');
    var bits = next.split(' ');
    el('nextRun').textContent = bits.length > 1 ? bits[bits.length - 1] : next;
    el('nextDate').textContent = bits.length > 1 ? bits.slice(0, -1).join(' ') : '北京时间';

    var crons = (S.data.crons && S.data.crons.length)
      ? S.data.crons
      : String(S.data.cron || '').split(' / ').filter(Boolean);
    el('cronPills').innerHTML = crons.map(function(c){
      return '<span>' + esc(c) + '</span>';
    }).join('') || '<span>cron 未配置</span>';

    renderTravelHero();
  }

  function renderTravelHero(){
    var box = el('travelHero');
    if(!box) return;
    var wb = travelAccounts();
    if(!wb.length){
      box.innerHTML = '<p class="cardKicker">TRAVEL · 自动旅行</p>' +
        '<div class="travelEmpty">还没有 WorkBuddy 账号。添加后，这里会自动派猫猫去旅行，并在到点后领取奖励。</div>' +
        '<div class="travelFoot"><button type="button" data-act="add">＋ 添加 WorkBuddy</button></div>';
      return;
    }
    var a = wb[0];
    for(var i = 0; i < wb.length; i++){
      if(wb[i].travel && (wb[i].travel.label === 'arrived' || wb[i].travel.label === 'traveling')) { a = wb[i]; break; }
    }
    var t = a.travel || { label:'untraveled', message:'今日尚未派发' };
    box.innerHTML = '<p class="cardKicker">TRAVEL · 自动旅行</p>' +
      '<div class="travelTop"><span class="travelWho">' + esc(a.label || a.id) + '</span>' +
      '<span class="travelState ' + travelClass(t.label) + '">' + travelText(t.label) + '</span></div>' +
      '<div class="travelRoute" aria-hidden="true"><span class="track"></span><span class="dot ' + (t.label === 'arrived' || t.label === 'finished' ? 'still' : '') + '"></span></div>' +
      '<div class="travelMeta">' + esc(t.message || travelText(t.label)) +
      (t.locationName ? ' · ' + esc(t.locationName) : '') + '</div>' +
      '<div class="travelFoot">' +
      (t.rewardCredit != null ? '<span class="reward">+' + esc(t.rewardCredit) + '</span>' : '<span class="travelMeta">' + (t.arriveAt ? '<span class="countdown" data-arrive="' + Number(t.arriveAt) + '"></span>' : '') + '</span>') +
      (t.label === 'arrived' ? '<button type="button" data-act="travel-claim" data-id="' + esc(a.id) + '">领取奖励</button>' :
        (t.label === 'untraveled' || t.label === 'error' || t.label === 'no-buddy' ? '<button type="button" data-act="travel-depart" data-id="' + esc(a.id) + '">派发</button>' :
        '<button type="button" data-act="travel-sync" data-id="' + esc(a.id) + '">同步</button>')) +
      '</div>';
    tickCountdowns();
  }

  /* ---------- platforms ---------- */
  function renderPlatforms(){
    var accounts = (S.data && S.data.accounts) || [];
    var meta = (S.meta && S.meta.platforms) || [];
    el('platformGrid').innerHTML = meta.map(function(p){
      var rows = accounts.filter(function(a){ return a.platform === p.key; });
      var done = rows.filter(function(a){ return a.signedToday; }).length;
      var pct = rows.length ? Math.round(done / rows.length * 100) : 0;
      var dots = rows.slice(0, 6).map(function(a){
        var st = statusOf(a);
        return '<i class="' + (st.c === 'off' ? 'off' : st.c) + '" title="' + esc(a.label) + ' · ' + st.t + '"></i>';
      }).join('');
      return '<button type="button" class="pTile ' + (S.platform === p.key ? 'on' : '') + '" data-plat="' + esc(p.key) + '" style="' + orbStyle(p.accent) + '" aria-pressed="' + (S.platform === p.key ? 'true' : 'false') + '">' +
        '<span class="pOrb" aria-hidden="true">' + esc(initial(p.label)) + '</span>' +
        '<b>' + esc(p.label) + '</b>' +
        '<small>' + rows.length + ' 个账号 · ' + done + ' 已确认</small>' +
        '<span class="pBar" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' +
        '<span class="pDots" aria-hidden="true">' + (dots || '<i class="off"></i>') + '</span>' +
        '</button>';
    }).join('');
  }

  /* ---------- accounts ---------- */
  function visibleAccounts(){
    var list = (S.data && S.data.accounts) || [];
    var q = S.search.trim().toLowerCase();
    var out = [];
    for(var i = 0; i < list.length; i++){
      var a = list[i];
      if(S.platform && a.platform !== S.platform) continue;
      if(S.filter === 'attention' && (a.enabled === false || a.signedToday)) continue;
      if(S.filter === 'done' && !a.signedToday) continue;
      if(S.filter === 'off' && a.enabled !== false) continue;
      if(S.filter === 'verify' && a.lastState !== 'unverified') continue;
      if(q){
        var hay = ((a.label || '') + ' ' + (a.platformLabel || '') + ' ' + (a.id || '') + ' ' + (a.lastMsg || '')).toLowerCase();
        if(hay.indexOf(q) < 0) continue;
      }
      out.push(a);
    }
    return out;
  }

  function renderAccounts(){
    var rows = visibleAccounts();
    var all = (S.data && S.data.accounts) || [];
    var grid = el('acctGrid');
    if(!rows.length){
      grid.innerHTML = all.length
        ? '<div class="aCard"><p class="modalNote">没有符合条件的账号。换一个筛选或清空搜索。</p></div>'
        : '<div class="aCard"><p class="modalNote">还没有账号。先把第一个平台接进来：扫码或粘贴一次凭证，之后由 Cron 自动签到。</p><div class="aActions"><button type="button" class="primary" data-act="add">＋ 添加第一个账号</button></div></div>';
      el('accountFoot').textContent = '显示 0 个账号';
      el('accountSub').textContent = '把每天要点的签到收进一块面板。';
      return;
    }
    var accountGroups = rows.length + ' 个账号';
    if(S.platform) accountGroups += ' · ' + platformLabel(S.platform);
    el('accountSub').textContent = accountGroups + ' · 点卡片查看完整凭证状态与旅行控制。';
    grid.innerHTML = rows.map(function(a, i){
      var m = metaOf(a.platform) || { label:a.platformLabel || a.platform, accent:'gray' };
      var st = statusOf(a);
      var t = a.travel;
      var travelRow = '';
      if(a.platform === 'workbuddy' && t){
        travelRow = '<div class="aTravel"><span class="tState ' + travelClass(t.label) + '">' + travelText(t.label) + '</span>' +
          '<span class="tText">' + esc(t.message || travelText(t.label)) + (t.arriveAt ? ' · <span class="countdown" data-arrive="' + Number(t.arriveAt) + '"></span>' : '') + '</span></div>';
      }
      return '<article class="aCard ' + (a.enabled === false ? 'off' : '') + '" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '" style="' + orbStyle(m.accent) + ';--i:' + i + '" tabindex="0" role="button" aria-label="查看 ' + esc(a.label || a.id) + ' 详情">' +
        '<div class="aTop">' +
        '<span class="aOrb" aria-hidden="true">' + esc(initial(m.label)) + '</span>' +
        '<span class="aNames"><b>' + esc(a.label || a.id) + '</b><small>' + esc(m.label) + (a.uid ? ' · UID ' + esc(a.uid) : '') + '</small></span>' +
        '<span class="aStatus ' + st.c + '"><i aria-hidden="true"></i>' + st.t + '</span>' +
        '</div>' +
        '<p class="aMsg">' + esc(a.lastMsg || '暂无运行记录') + '</p>' +
        '<div class="aStats">' +
        '<div><b>' + esc(show(a.streak)) + '</b><span>连签</span></div>' +
        '<div><b>' + esc(compact(a.credits != null ? a.credits : a.total)) + '</b><span>' + (a.credits != null ? '余额' : '累计') + '</span></div>' +
        '<div><b>' + esc(a.lastRun ? a.lastRun.slice(11, 16) : '—') + '</b><span>最近运行</span></div>' +
        '</div>' + travelRow +
        '<div class="aActions">' +
        '<button type="button" class="primary" data-act="sign" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '">立即签到</button>' +
        '<button type="button" data-act="detail" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '">查看详情</button>' +
        '</div></article>';
    }).join('');
    el('accountFoot').textContent = '显示 ' + rows.length + ' 个账号 · 数据更新于 ' + (S.data.at || '—');
    tickCountdowns();
  }

  function openAccount(pf, id){
    S.acct = { pf: pf, id: id };
    el('acctVeil').hidden = false;
    renderAccountModal();
  }
  function closeAccount(){
    S.acct = null;
    el('acctVeil').hidden = true;
  }
  function renderAccountModal(){
    if(!S.acct) return;
    var a = findAccount(S.acct.pf, S.acct.id);
    if(!a){ closeAccount(); return; }
    var m = metaOf(a.platform) || { label: a.platformLabel || a.platform, accent:'gray', note:'', hint:'', verified:false };
    var st = statusOf(a);
    var t = a.travel;
    el('acctKicker').textContent = 'ACCOUNT · ' + a.platform.toUpperCase();
    el('acctTitle').textContent = a.label || a.id;
    el('acctSub').textContent = m.label + ' · ' + (a.uid ? 'UID ' + a.uid : a.id);
    var travelBlock = '';
    if(a.platform === 'workbuddy'){
      var tt = t || { label:'untraveled', message:'今日尚未派发' };
      travelBlock = '<div class="modalTravel">' +
        '<div class="modalBlockHead"><b>成长中心 · 派猫猫旅行</b>' +
        '<span class="travelState ' + travelClass(tt.label) + '">' + travelText(tt.label) + '</span></div>' +
        '<div class="missionRoute" aria-hidden="true"><span class="track"></span><span class="node start"></span><span class="node end"></span>' +
        '<span class="dot ' + (tt.label === 'arrived' || tt.label === 'finished' ? 'arrived' : (tt.label === 'untraveled' ? 'idle' : '')) + '"></span></div>' +
        '<p class="modalNote">' + esc(tt.message || travelText(tt.label)) +
        (tt.locationName ? ' · ' + esc(tt.locationName) : '') +
        (tt.arriveAt ? ' · <span class="countdown" data-arrive="' + Number(tt.arriveAt) + '"></span>' : '') +
        (tt.rewardCredit != null ? ' · 奖励 +' + esc(tt.rewardCredit) : '') + '</p>' +
        '<div class="missionActions">' +
        '<button type="button" data-act="travel-sync" data-id="' + esc(a.id) + '">同步</button>' +
        (tt.label === 'arrived' ? '<button type="button" class="primary" data-act="travel-claim" data-id="' + esc(a.id) + '">领取奖励</button>' : '') +
        (tt.label === 'untraveled' || tt.label === 'error' || tt.label === 'no-buddy' ? '<button type="button" data-act="travel-depart" data-id="' + esc(a.id) + '">派发</button>' : '') +
        '<label class="switch"><input type="checkbox" data-act="travel-auto" data-id="' + esc(a.id) + '"' + (a.autoTravel !== false ? ' checked' : '') + '><span class="track" aria-hidden="true"></span><i>自动旅行</i></label>' +
        '</div></div>';
    }
    el('acctBody').innerHTML =
      '<div class="acctModalTop" style="' + orbStyle(m.accent) + '">' +
      '<span class="acctModalOrb" aria-hidden="true">' + esc(initial(m.label)) + '</span>' +
      '<span class="acctModalMeta"><b>' + esc(a.lastMsg || '暂无运行记录') + '</b><small>' + esc(m.label) + ' · ' + (a.verifiedDate || a.lastOkDate || '尚未确认') + '</small></span>' +
      '<span class="aStatus modalStatus ' + st.c + '"><i aria-hidden="true"></i>' + st.t + '</span>' +
      '</div>' +
      '<p class="modalMsg">' + esc(a.lastMsg || '暂无运行记录') + '</p>' +
      '<div class="modalGrid">' +
      '<div><small>最近运行</small><b>' + esc(a.lastRun || '—') + '</b></div>' +
      '<div><small>最近确认</small><b>' + esc(a.lastOkDate || '—') + '</b></div>' +
      '<div><small>连续签到</small><b>' + esc(show(a.streak)) + ' 天</b></div>' +
      '<div><small>累计签到</small><b>' + esc(show(a.totalSigned)) + ' 次</b></div>' +
      '<div><small>本期累计</small><b>' + esc(show(a.total)) + '</b></div>' +
      '<div><small>真实余额</small><b>' + esc(show(a.credits)) + '</b></div>' +
      '<div><small>今日获得</small><b>' + esc(a.lastCredit == null ? '—' : '+' + a.lastCredit) + '</b></div>' +
      '<div><small>凭证类型</small><b>' + esc(a.credKind === 'refresh' ? 'refresh token' : 'access token') + '</b></div>' +
      '</div>' + travelBlock +
      '<div class="modalBlock"><div class="modalBlockHead"><b>平台说明</b></div>' +
      '<p class="modalNote">' + esc(m.note || m.hint || '暂无说明') + '</p>' +
      '<p class="modalNote" style="margin-top:6px;color:' + (m.verified ? 'var(--ok)' : 'var(--warn)') + '">' + (m.verified ? '该平台已在部署中跑通' : (m.verifiedNote || '尚未用真实账号复核')) + '</p></div>' +
      '<div class="modalActions">' +
      '<button type="button" class="primary" data-act="sign" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '">立即签到</button>' +
      '<button type="button" data-act="refresh" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '">刷新状态</button>' +
      '<button type="button" data-act="rename" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '">改名</button>' +
      '<button type="button" data-act="toggle" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '">' + (a.enabled === false ? '启用' : '停用') + '</button>' +
      '<button type="button" class="danger" data-act="del" data-pf="' + esc(a.platform) + '" data-id="' + esc(a.id) + '">删除</button>' +
      '</div>';
    tickCountdowns();
  }

  /* ---------- travel missions ---------- */
  function renderMissions(){
    var wb = travelAccounts();
    var box = el('missionGrid');
    if(!wb.length){
      box.innerHTML = '<div class="mission"><p class="modalNote">还没有 WorkBuddy 账号。添加后这里会出现旅行任务卡。</p><div class="missionActions"><button type="button" data-act="add">＋ 添加账号</button></div></div>';
      return;
    }
    box.innerHTML = wb.map(function(a){
      var t = a.travel || { label:'untraveled', message:'今日尚未派发' };
      var dotCls = t.label === 'traveling' ? '' : (t.label === 'arrived' || t.label === 'finished' ? 'arrived' : 'idle');
      var actions = '<button type="button" data-act="travel-sync" data-id="' + esc(a.id) + '">同步</button>';
      if(t.label === 'arrived') actions += '<button type="button" class="primary" data-act="travel-claim" data-id="' + esc(a.id) + '">领取</button>';
      if(t.label === 'untraveled' || t.label === 'error' || t.label === 'no-buddy') actions += '<button type="button" data-act="travel-depart" data-id="' + esc(a.id) + '">派发</button>';
      return '<article class="mission">' +
        '<div class="missionTop"><b>' + esc(a.label || a.id) + '</b>' +
        '<span class="travelState ' + travelClass(t.label) + '">' + travelText(t.label) + '</span></div>' +
        '<div class="missionRoute" aria-hidden="true"><span class="track"></span><span class="node start"></span><span class="node end"></span><span class="dot ' + dotCls + '"></span></div>' +
        '<div class="missionMeta">' + esc(t.message || travelText(t.label)) +
        (t.locationName ? '<br>' + esc(t.locationName) : '') +
        (t.arriveAt ? '<br><span class="countdown" data-arrive="' + Number(t.arriveAt) + '"></span>' : '') +
        (t.rewardCredit != null ? '<br>奖励 +' + esc(t.rewardCredit) : '') + '</div>' +
        '<div class="missionActions">' + actions +
        '<label class="switch"><input type="checkbox" data-act="travel-auto" data-id="' + esc(a.id) + '"' + (a.autoTravel !== false ? ' checked' : '') + '><span class="track" aria-hidden="true"></span><i>自动</i></label>' +
        '</div></article>';
    }).join('');
    tickCountdowns();
  }

  /* ---------- activity / system ---------- */
  function logRow(h){
    var state = h.state || '';
    var cls = (state === 'checked' || state === 'already') ? 'ok' :
      ((state === 'error' || state === 'token_dead') ? 'bad' :
      (state === 'unverified' ? 'warn' : 'idle'));
    var time = (h.at || '').slice(11, 16) || '--:--';
    return '<div class="actRow"><time>' + esc(time) + '</time>' +
      '<span class="dot ' + cls + '" aria-hidden="true"></span>' +
      '<p><b>' + esc(h.label || h.id || '') + '</b> · ' + esc(platformLabel(h.platform)) +
      '<br>' + esc(h.msg || stateText(state)) + '</p></div>';
  }
  function renderActivity(){
    var items = (S.history || []).slice(0, 8);
    el('activityList').innerHTML = items.length
      ? items.map(logRow).join('')
      : '<p class="modalNote">还没有运行记录。点「运行全部」或等下一班 Cron。</p>';
  }
  function renderSystem(){
    var st = S.data.stats || {};
    el('sysCron').textContent = S.data.cron || '—';
    el('sysNext').textContent = S.data.nextRun || '—';
    el('sysAccounts').textContent = (st.total || 0) + ' 个';
    el('sysPlatforms').textContent = ((S.data.platforms || []).length || 0) + ' 个';
  }

  /* ---------- clock ---------- */
  function tickCountdowns(){
    var nodes = document.querySelectorAll('[data-arrive]');
    for(var i = 0; i < nodes.length; i++){
      var node = nodes[i];
      var at = Number(node.getAttribute('data-arrive')) || 0;
      if(!at){ node.textContent = ''; continue; }
      var left = at - Date.now();
      if(left <= 0){ node.textContent = '已到点，等待同步'; continue; }
      var m = Math.floor(left / 60000);
      var s = Math.floor((left % 60000) / 1000);
      node.textContent = m + ' 分 ' + pad(s) + ' 秒后到达';
    }
  }
  function tickClock(){
    el('barClock').textContent = fmtClock(true);
    tickCountdowns();
  }

  /* ---------- theme ---------- */
  function setTheme(t){
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch(e) {}
    el('themeBtn').setAttribute('aria-label', t === 'day' ? '切换到夜间模式' : '切换到日间模式');
  }

  /* ---------- veil / ask ---------- */
  function closeVeil(id){
    var v = el(id);
    if(v) v.hidden = true;
    if(id === 'addVeil') stopAddTimer();
    if(id === 'acctVeil') S.acct = null;
  }
  function anyVeilOpen(){
    var ids = ['acctVeil','addVeil','setVeil','histVeil','askVeil'];
    for(var i = 0; i < ids.length; i++){
      var v = el(ids[i]);
      if(v && !v.hidden) return true;
    }
    return false;
  }
  function openVeil(id){
    var v = el(id);
    if(v) v.hidden = false;
  }
  function askValue(title, desc, label, value){
    return new Promise(function(resolve){
      askResolve = resolve;
      el('askKicker').textContent = 'INPUT';
      el('askTitle').textContent = title;
      el('askDesc').textContent = desc || '';
      el('askField').hidden = false;
      el('askLabel').textContent = label || '值';
      el('askInput').value = value || '';
      el('askErr').textContent = '';
      openVeil('askVeil');
      setTimeout(function(){ el('askInput').focus(); el('askInput').select(); }, 30);
    });
  }
  function askConfirm(title, desc){
    return new Promise(function(resolve){
      askResolve = resolve;
      el('askKicker').textContent = 'CONFIRM';
      el('askTitle').textContent = title;
      el('askDesc').textContent = desc || '';
      el('askField').hidden = true;
      el('askErr').textContent = '';
      openVeil('askVeil');
      setTimeout(function(){ el('askOk').focus(); }, 30);
    });
  }
  function resolveAsk(v){
    var r = askResolve;
    askResolve = null;
    closeVeil('askVeil');
    if(r) r(v);
  }

  /* ---------- actions ---------- */
  function setBusy(btn, text){
    if(!btn) return function(){};
    var old = btn.innerHTML;
    btn.disabled = true;
    if(text) btn.innerHTML = text;
    return function(){ btn.disabled = false; btn.innerHTML = old; };
  }
  function summaryLine(res){
    var checked = 0, already = 0, failed = 0, travel = 0;
    if(res){
      Object.keys(res).forEach(function(k){
        var v = res[k];
        if(!v || !v.results) return;
        checked += v.checked || 0;
        already += v.already || 0;
        failed += v.failed || 0;
        if(v.travelSummary) travel += v.travelSummary.finished || 0;
      });
    }
    var parts = ['新签 ' + checked, '已签 ' + already, '失败 ' + failed];
    if(travel) parts.push('旅行 ' + travel);
    return parts.join(' · ');
  }
  function runAll(){
    var btn = el('runAllBtn');
    var done = setBusy(btn, '<span class="spark spin"></span>运行中');
    api('/api/run-all?force=1', { method:'POST', body:'{}' })
      .then(function(res){ return loadAll().then(function(){ toast('本轮完成：' + summaryLine(res), 'ok'); }); })
      .catch(function(e){ toast(e.message, 'err'); })
      .then(done);
  }
  function runPlatform(pf){
    var btn = document.querySelector('button[data-act="runpf"][data-pf="' + pf + '"]');
    var done = setBusy(btn, '运行中…');
    api('/api/platforms/run', { method:'POST', body: JSON.stringify({ platform: pf }) })
      .then(function(res){ return loadAll().then(function(){ toast(platformLabel(pf) + '：' + summaryLine(res), 'ok'); }); })
      .catch(function(e){ toast(e.message, 'err'); })
      .then(done);
  }
  function signOne(pf, id){
    toast('正在签到…', 'warn');
    api('/api/accounts/sign', { method:'POST', body: JSON.stringify({ platform: pf, id: id, force: true }) })
      .then(function(res){
        var hit = null;
        (res.results || []).forEach(function(r){ if(r.id === id) hit = r; });
        return loadAll().then(function(){
          toast(hit ? (hit.msg || stateText(hit.state)) : '已运行', hit && (hit.verified || hit.state === 'already') ? 'ok' : 'warn');
        });
      })
      .catch(function(e){ toast(e.message, 'err'); });
  }
  function refreshOne(pf, id){
    api('/api/accounts/refresh', { method:'POST', body: JSON.stringify({ platform: pf, id: id }) })
      .then(function(){ return loadAll().then(function(){ toast('状态已刷新', 'ok'); }); })
      .catch(function(e){ toast(e.message, 'err'); });
  }
  function toggleAccount(pf, id){
    var a = findAccount(pf, id);
    if(!a) return;
    api('/api/accounts/enable', { method:'POST', body: JSON.stringify({ platform: pf, id: id, enabled: a.enabled === false }) })
      .then(function(){ return loadAll().then(function(){ toast(a.enabled === false ? '账号已启用' : '账号已停用', 'ok'); }); })
      .catch(function(e){ toast(e.message, 'err'); });
  }
  function renameAccount(pf, id){
    var a = findAccount(pf, id);
    if(!a) return;
    askValue('改名', '备注只影响控制台显示，不影响凭证。', '新的备注名', a.label || '').then(function(v){
      if(v == null) return;
      var name = String(v).trim();
      if(!name){ toast('备注不能为空', 'err'); return; }
      api('/api/accounts/rename', { method:'POST', body: JSON.stringify({ platform: pf, id: id, label: name }) })
        .then(function(){ return loadAll().then(function(){ toast('已改名：' + name, 'ok'); }); })
        .catch(function(e){ toast(e.message, 'err'); });
    });
  }
  function removeAccount(pf, id){
    var a = findAccount(pf, id);
    if(!a) return;
    askConfirm('删除账号', '「' + (a.label || a.id) + '」的加密凭证会一并删除，无法恢复。').then(function(v){
      if(!v) return;
      api('/api/accounts/remove', { method:'POST', body: JSON.stringify({ platform: pf, id: id }) })
        .then(function(){ return loadAll().then(function(){ toast('账号已删除', 'ok'); }); })
        .catch(function(e){ toast(e.message, 'err'); });
    });
  }
  function travelAction(id, action, btn){
    var done = setBusy(btn, '…');
    api('/api/accounts/travel', { method:'POST', body: JSON.stringify({ platform:'workbuddy', id: id || '', action: action }) })
      .then(function(res){
        if(action === 'auto-on') toast('已开启自动旅行', 'ok');
        else if(action === 'auto-off') toast('已关闭自动旅行', 'ok');
        else if(res.result && res.result.msg) toast(res.result.msg, res.ok ? 'ok' : 'warn');
        else if(res.msg) toast(res.msg, res.ok ? 'ok' : 'warn');
        else if(action === 'run') toast('旅行同步完成：在途 ' + (res.traveling || 0) + ' · 完成 ' + (res.finished || 0), 'ok');
        else toast('旅行状态已同步', 'ok');
        return loadAll();
      })
      .catch(function(e){ toast(e.message, 'err'); })
      .then(done);
  }
  function refreshAll(){
    toast('正在刷新全部账号…', 'warn');
    api('/api/refresh-all', { method:'POST', body:'{}' })
      .then(function(res){
        var n = (res.results || []).filter(function(x){ return x.ok; }).length;
        return loadAll().then(function(){ toast('已刷新 ' + n + ' 个账号', 'ok'); });
      })
      .catch(function(e){ toast(e.message, 'err'); });
  }
  function openHistory(){
    openVeil('histVeil');
    el('histBody').innerHTML = (S.history || []).length
      ? (S.history || []).map(logRow).join('')
      : '<p class="modalNote">还没有运行记录。</p>';
  }

  /* ---------- settings ---------- */
  function openSettings(){
    openVeil('setVeil');
    el('setErr').textContent = '';
    renderSetSys();
    el('oidCmd').textContent = 'curl -O ' + location.origin + '/qq/openid-helper.mjs' +
      String.fromCharCode(10) + 'node openid-helper.mjs <AppID> <AppSecret>';
    api('/api/notify').then(function(d){
      var c = d.config || {};
      var tg = c.telegram || {};
      var qq = c.qq || {};
      el('tgToken').value = tg.token || '';
      el('tgChat').value = tg.chatId || '';
      el('qqAppId').value = qq.appId || '';
      el('qqSecret').value = qq.appSecret || '';
      el('qqOpenid').value = qq.openid || '';
      el('qqSandbox').checked = !!qq.sandbox;
    }).catch(function(e){ el('setErr').textContent = e.message; });
  }
  function renderSetSys(){
    var d = S.data || {};
    var st = d.stats || {};
    el('setSys').innerHTML =
      '<div class="sysItem"><small>当前触发</small><b>' + esc(d.cron || '—') + '</b></div>' +
      '<div class="sysItem"><small>下次运行</small><b>' + esc(d.nextRun || '—') + '</b></div>' +
      '<div class="sysItem"><small>账号 / 平台</small><b>' + esc((st.total || 0) + ' / ' + ((d.platforms || []).length || 0)) + '</b></div>' +
      '<div class="sysItem"><small>今日积分</small><b>' + esc(st.todayCredit == null ? 0 : st.todayCredit) + '</b></div>';
    el('cronTip').textContent = '建议配置 3 条 Cron：08:10 / 12:10 / 20:10（UTC 00:10 / 04:10 / 12:10）。已验证账号自动跳过，失败与待确认账号会在后续班次继续重试；旅行在 12:10 那班通常正好到点可领。';
  }
  function notifyPayload(){
    return {
      telegram: { token: el('tgToken').value.trim(), chatId: el('tgChat').value.trim() },
      qq: {
        appId: el('qqAppId').value.trim(),
        appSecret: el('qqSecret').value.trim(),
        openid: el('qqOpenid').value.trim(),
        sandbox: el('qqSandbox').checked
      }
    };
  }
  function saveNotify(){
    var btn = el('notifySave');
    btn.disabled = true;
    el('setErr').textContent = '';
    api('/api/notify', { method:'POST', body: JSON.stringify(notifyPayload()) })
      .then(function(){ toast('通知配置已保存', 'ok'); })
      .catch(function(e){ el('setErr').textContent = e.message; })
      .then(function(){ btn.disabled = false; });
  }
  function testNotify(){
    var btn = el('notifyTest');
    btn.disabled = true;
    el('setErr').textContent = '';
    api('/api/notify/test', { method:'POST', body:'{}' })
      .then(function(d){
        var r = d.result || {};
        var parts = [];
        if(r.telegram) parts.push('Telegram: ' + r.telegram);
        if(r.qq) parts.push('QQ: ' + r.qq);
        toast(parts.join(' · ') || '没有可用的通知通道', 'warn');
      })
      .catch(function(e){ el('setErr').textContent = e.message; })
      .then(function(){ btn.disabled = false; });
  }

  /* ---------- add account ---------- */
  function stopAddTimer(){
    if(ADD.timer){ clearInterval(ADD.timer); ADD.timer = null; }
  }
  function closeWin(win){
    if(win && !win.closed){ try { win.close(); } catch(e) {} }
  }
  function addMsg(msg, type){
    var m = el('addAuthMsg');
    if(m){
      m.textContent = msg || '';
      m.className = 'authMsg' + (type ? ' ' + type : '');
    } else {
      el('addErr').textContent = msg || '';
    }
  }
  function addLink(url){
    var m = el('addAuthMsg');
    var html = '新窗口被拦截，请手动打开：<a href="' + esc(url) + '" target="_blank" rel="noopener">打开登录页</a>';
    if(m){ m.className = 'authMsg'; m.innerHTML = html; }
    else { el('addErr').textContent = '新窗口被拦截，请手动打开：' + url; }
  }
  function firstAvailable(){
    var list = (S.meta && S.meta.platforms) || [];
    for(var i = 0; i < list.length; i++){
      if(list[i].available !== false) return list[i].key;
    }
    return list.length ? list[0].key : '';
  }
  function openAdd(pf){
    if(!S.meta || !S.meta.platforms){ toast('平台信息还没加载完', 'warn'); return; }
    stopAddTimer();
    ADD.pf = pf || firstAvailable();
    openVeil('addVeil');
    el('addErr').textContent = '';
    renderPlatChips();
    renderAddBody();
  }
  function renderPlatChips(){
    el('platChips').innerHTML = (S.meta.platforms || []).map(function(p){
      return '<button type="button" data-plat="' + esc(p.key) + '" class="' + (p.key === ADD.pf ? 'on' : '') + '"' +
        (p.available === false ? ' disabled' : '') + '>' + esc(p.label) + '</button>';
    }).join('');
  }
  function renderAddBody(){
    var m = metaOf(ADD.pf);
    if(!m) return;
    el('addTitle').textContent = '添加 · ' + m.label;
    el('addHint').textContent = m.hint || '';
    el('addErr').textContent = '';
    var body = el('addBody');
    var confirm = el('addConfirm');
    confirm.hidden = false;
    confirm.disabled = false;
    confirm.textContent = '确认添加';

    if(m.available === false){
      body.innerHTML = '<p class="modalNote">该平台当前不可用：' + esc(m.unavailableReason || '缺少配置') + '</p>';
      confirm.hidden = true;
      return;
    }
    if(m.key === 'trae'){
      body.innerHTML = '<div class="authBox"><h3>抖音扫码</h3>' +
        '<p>打开官方授权页扫码。完成后浏览器会停在一个打不开的 127.0.0.1 页面，把地址栏整段复制回来。</p>' +
        '<button class="btn sm primary" type="button" data-add="trae-start">打开授权页</button>' +
        '<div class="field" style="margin-top:14px"><label for="traeUrl">回调地址</label>' +
        '<input id="traeUrl" autocomplete="off" placeholder="http://127.0.0.1:17388/authorize?authCodeInfo=..."></div>' +
        '<button class="btn sm" type="button" data-add="trae-claim">绑定账号</button>' +
        '<p class="authMsg" id="addAuthMsg"></p></div>';
      confirm.hidden = true;
      return;
    }
    if(m.key === 'workbuddy'){
      body.innerHTML = '<div class="authBox"><h3>微信扫码</h3>' +
        '<p>打开官方登录页扫码并确认。Worker 轮询到结果后自动保存账号，登录窗口会自动关闭。</p>' +
        '<button class="btn sm primary" type="button" data-add="wb-start">打开登录页</button>' +
        '<p class="authMsg" id="addAuthMsg"></p></div>';
      confirm.hidden = true;
      return;
    }
    if(m.key === 'qoder'){
      body.innerHTML = '<div class="authBox"><h3>官网设备授权</h3>' +
        '<p>优先用设备授权：登录并确认后，Worker 轮询到结果自动入库。</p>' +
        '<div class="rowBtns"><button class="btn sm primary" type="button" data-add="qoder-start" data-region="cn">国内版授权</button>' +
        '<button class="btn sm" type="button" data-add="qoder-start" data-region="intl">国际版授权</button></div>' +
        '<p class="authMsg" id="addAuthMsg"></p></div>' +
        '<div class="divider">或粘贴 PAT</div>' +
        '<div class="two"><div class="field"><label for="qoderPat">Personal Access Token</label>' +
        '<textarea id="qoderPat" rows="2" placeholder="pt-..."></textarea></div>' +
        '<div class="field"><label for="qoderRegion">区域</label><select id="qoderRegion">' +
        '<option value="cn">国内版</option><option value="intl">国际版</option></select></div></div>' +
        '<div class="field"><label for="f_label">备注<span class="opt">可选</span></label>' +
        '<input id="f_label" maxlength="40" placeholder="留空自动命名"></div>';
      confirm.hidden = false;
      return;
    }
    if(m.key === 'workbuddy_intl'){
      body.innerHTML = '<div class="authBox"><h3>网页授权</h3>' +
        '<p>打开官方授权页，用 Google / GitHub / X 登录，完成后自动入库。</p>' +
        '<button class="btn sm primary" type="button" data-add="intl-start">打开授权页</button>' +
        '<p class="authMsg" id="addAuthMsg"></p></div>' +
        '<div class="divider">或粘贴令牌</div>' + fieldsHtml(m);
      confirm.hidden = false;
      return;
    }
    if(m.key === 'astudio'){
      body.innerHTML = '<div class="modeTabs"><button type="button" class="on" data-add="ast-pw">手机号密码</button>' +
        '<button type="button" data-add="ast-cookie">粘贴 Cookie</button></div>' +
        '<div id="astPw"><p class="hint">密码只在本次请求的内存里用一次，不保存。</p>' +
        '<div class="two"><div class="field"><label for="astPhone">手机号</label>' +
        '<input id="astPhone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号"></div>' +
        '<div class="field"><label for="astPass">密码</label><input id="astPass" type="password" placeholder="讯飞账号密码"></div></div>' +
        '<button class="btn primary sm" type="button" data-add="ast-login">登录并添加</button></div>' +
        '<div id="astCk" hidden>' + fieldsHtml(m) + '</div>';
      confirm.hidden = true;
      return;
    }
    body.innerHTML = fieldsHtml(m);
    confirm.hidden = false;
  }
  function fieldsHtml(m){
    var html = '<div class="two">';
    (m.fields || []).forEach(function(f){
      var id = 'f_' + f.name;
      var input;
      if(f.multiline || f.secret || f.name === 'session' || f.name === 'access_token' || f.name === 'refresh_token' || f.name === 'cookie'){
        input = '<textarea id="' + id + '" rows="' + (f.name === 'cookie' ? 3 : 2) + '" placeholder="' + esc(f.placeholder || '') + '" spellcheck="false"></textarea>';
      } else {
        input = '<input id="' + id + '" type="text" placeholder="' + esc(f.placeholder || '') + '" autocomplete="off" spellcheck="false">';
      }
      html += '<div class="field"><label for="' + id + '">' + esc(f.label || f.name) +
        (f.required ? '' : '<span class="opt">可选</span>') + '</label>' + input + '</div>';
    });
    html += '<div class="field"><label for="f_label">备注<span class="opt">可选</span></label>' +
      '<input id="f_label" maxlength="40" placeholder="留空则自动识别昵称"></div></div>';
    return html;
  }
  function collectCreds(m){
    var creds = {};
    (m.fields || []).forEach(function(f){
      var node = el('f_' + f.name);
      if(node) creds[f.name] = node.value.trim();
    });
    return creds;
  }
  function submitAdd(){
    var m = metaOf(ADD.pf);
    if(!m) return;
    var creds = collectCreds(m);
    if(m.key === 'qoder'){
      var pat = el('qoderPat');
      var region = el('qoderRegion');
      if(pat && pat.value.trim()) creds.personal_token = pat.value.trim();
      if(region) creds.region = region.value;
    }
    var has = Object.keys(creds).some(function(k){ return String(creds[k] || '').trim(); });
    if(!has){ el('addErr').textContent = '请至少填写一项凭证'; return; }
    var labelEl = el('f_label');
    var label = labelEl ? labelEl.value.trim() : '';
    var btn = el('addConfirm');
    btn.disabled = true;
    btn.textContent = '添加中…';
    el('addErr').textContent = '';
    api('/api/accounts/add', { method:'POST', body: JSON.stringify({ platform: m.key, label: label, creds: creds }) })
      .then(function(d){
        toast((d.updated ? '凭证已更新：' : '账号已添加：') + ((d.account && d.account.label) || ''), 'ok');
        closeVeil('addVeil');
        return loadAll();
      })
      .catch(function(e){ el('addErr').textContent = e.message; })
      .then(function(){ btn.disabled = false; btn.textContent = '确认添加'; });
  }
  function startTraeFlow(){
    var btn = document.querySelector('button[data-add="trae-start"]');
    var done = setBusy(btn, '打开中…');
    api('/trae/api/login/start', { method:'POST', body:'{}' })
      .then(function(d){
        var win = window.open(d.authUrl, 'trae-login', 'width=520,height=820');
        if(!win) addLink(d.authUrl);
        else addMsg('已打开授权页。扫码确认后，把打不开的 127.0.0.1 地址复制到下面。');
        var input = el('traeUrl');
        if(input) input.focus();
      })
      .catch(function(e){ addMsg(e.message, 'err'); })
      .then(done);
  }
  function claimTrae(){
    var input = el('traeUrl');
    if(!input) return;
    var url = input.value.trim();
    if(!url){ addMsg('请先粘贴回调地址', 'err'); return; }
    addMsg('正在用授权码换取令牌…');
    api('/trae/api/login/claim', { method:'POST', body: JSON.stringify({ url: url }) })
      .then(function(d){
        toast('登录成功：' + (d.label || ''), 'ok');
        closeVeil('addVeil');
        return loadAll();
      })
      .catch(function(e){ addMsg(e.message, 'err'); });
  }
  function startWbFlow(){
    stopAddTimer();
    var btn = document.querySelector('button[data-add="wb-start"]');
    var win = window.open('about:blank', 'wb-login', 'width=640,height=880');
    if(btn) btn.disabled = true;
    api('/wb/api/login/start', { method:'POST', body:'{}' })
      .then(function(d){
        var opened = false;
        if(win && !win.closed){ try { win.location.href = d.authUrl; opened = true; } catch(e) {} }
        if(!opened) addLink(d.authUrl);
        else addMsg('已打开登录页，用微信扫码并确认。');
        var n = 0;
        ADD.timer = setInterval(function(){
          if(n++ > 150){ stopAddTimer(); addMsg('登录会话已过期，请重试', 'err'); return; }
          api('/wb/api/login/poll?state=' + encodeURIComponent(d.state)).then(function(r){
            if(r.status === 'ok'){
              stopAddTimer();
              closeWin(win);
              toast('登录成功：' + (r.label || ''), 'ok');
              closeVeil('addVeil');
              loadAll();
            } else if(r.status === 'expired' || r.status === 'error'){
              stopAddTimer();
              addMsg(r.error || '登录会话已过期', 'err');
            }
          }).catch(function(e){ stopAddTimer(); addMsg(e.message, 'err'); });
        }, 2500);
      })
      .catch(function(e){ closeWin(win); addMsg(e.message, 'err'); })
      .then(function(){ if(btn) btn.disabled = false; });
  }
  function startQoderFlow(region){
    stopAddTimer();
    var btn = document.querySelector('button[data-add="qoder-start"]');
    var win = window.open('about:blank', 'qoder-login', 'width=680,height=900');
    if(btn) btn.disabled = true;
    api('/qoder/api/login/start', { method:'POST', body: JSON.stringify({ region: region || 'cn' }) })
      .then(function(d){
        var opened = false;
        if(win && !win.closed){ try { win.location.href = d.authUrl; opened = true; } catch(e) {} }
        if(!opened) addLink(d.authUrl);
        else addMsg('已打开授权页，登录并确认后自动入库。');
        var n = 0;
        ADD.timer = setInterval(function(){
          if(n++ > 150){ stopAddTimer(); addMsg('授权超时，请重试', 'err'); return; }
          api('/qoder/api/login/poll?nonce=' + encodeURIComponent(d.nonce)).then(function(r){
            if(r.ok){
              stopAddTimer();
              closeWin(win);
              toast('登录成功：' + ((r.account && r.account.label) || ''), 'ok');
              closeVeil('addVeil');
              loadAll();
            } else if(!r.pending){
              stopAddTimer();
              addMsg(r.error || '授权会话已过期', 'err');
            }
          }).catch(function(e){ stopAddTimer(); addMsg(e.message, 'err'); });
        }, 2500);
      })
      .catch(function(e){ closeWin(win); addMsg(e.message, 'err'); })
      .then(function(){ if(btn) btn.disabled = false; });
  }
  function startIntlFlow(){
    stopAddTimer();
    var btn = document.querySelector('button[data-add="intl-start"]');
    var win = window.open('about:blank', 'wbi-login', 'width=680,height=880');
    if(btn) btn.disabled = true;
    api('/wbi/api/login/start', { method:'POST', body:'{}' })
      .then(function(d){
        var opened = false;
        if(win && !win.closed){ try { win.location.href = d.authUrl; opened = true; } catch(e) {} }
        if(!opened) addLink(d.authUrl);
        else addMsg('已打开授权页，用 Google / GitHub / X 登录。');
        var n = 0;
        ADD.timer = setInterval(function(){
          if(n++ > 150){ stopAddTimer(); addMsg('授权超时，请重试', 'err'); return; }
          api('/wbi/api/login/poll?state=' + encodeURIComponent(d.state)).then(function(r){
            if(r.status === 'ok'){
              stopAddTimer();
              closeWin(win);
              toast('登录成功：' + (r.label || ''), 'ok');
              closeVeil('addVeil');
              loadAll();
            } else if(r.status === 'expired' || r.status === 'error'){
              stopAddTimer();
              addMsg(r.error || '授权会话已过期', 'err');
            }
          }).catch(function(e){ stopAddTimer(); addMsg(e.message, 'err'); });
        }, 2500);
      })
      .catch(function(e){ closeWin(win); addMsg(e.message, 'err'); })
      .then(function(){ if(btn) btn.disabled = false; });
  }
  function astMode(pw, btn){
    var pwBox = el('astPw');
    var ckBox = el('astCk');
    if(!pwBox || !ckBox) return;
    pwBox.hidden = !pw;
    ckBox.hidden = pw;
    var tabs = document.querySelectorAll('.modeTabs button');
    for(var i = 0; i < tabs.length; i++) tabs[i].classList.remove('on');
    if(btn) btn.classList.add('on');
    el('addConfirm').hidden = pw;
  }
  function astLogin(){
    var phone = el('astPhone') ? el('astPhone').value.trim() : '';
    var pass = el('astPass') ? el('astPass').value : '';
    if(!phone || !pass){ el('addErr').textContent = '请填写手机号和密码'; return; }
    var btn = document.querySelector('button[data-add="ast-login"]');
    var done = setBusy(btn, '登录中…');
    el('addErr').textContent = '';
    api('/astudio/api/login/password', { method:'POST', body: JSON.stringify({ phone: phone, password: pass }) })
      .then(function(d){
        toast('登录成功：' + ((d.account && d.account.label) || ''), 'ok');
        closeVeil('addVeil');
        return loadAll();
      })
      .catch(function(e){ el('addErr').textContent = e.message; })
      .then(done);
  }

  /* ---------- global wiring ---------- */
  function handleAct(btn){
    var act = btn.getAttribute('data-act');
    var pf = btn.getAttribute('data-pf') || '';
    var id = btn.getAttribute('data-id') || '';
    if(act === 'add') openAdd('');
    else if(act === 'detail') openAccount(pf, id);
    else if(act === 'sign') signOne(pf, id);
    else if(act === 'refresh') refreshOne(pf, id);
    else if(act === 'rename') renameAccount(pf, id);
    else if(act === 'toggle') toggleAccount(pf, id);
    else if(act === 'del') removeAccount(pf, id);
    else if(act === 'travel-sync') travelAction(id, 'sync', btn);
    else if(act === 'travel-depart') travelAction(id, 'depart', btn);
    else if(act === 'travel-claim') travelAction(id, 'claim', btn);
    else if(act === 'travel-run') travelAction('', 'run', btn);
    else if(act === 'settings') openSettings();
    else if(act === 'history') openHistory();
    else if(act === 'refresh-all') refreshAll();
  }

  function bind(){
    el('loginBtn').addEventListener('click', tryLogin);
    el('loginToken').addEventListener('keydown', function(e){ if(e.key === 'Enter') tryLogin(); });
    el('themeBtn').addEventListener('click', function(){
      setTheme(document.documentElement.getAttribute('data-theme') === 'day' ? 'night' : 'day');
    });
    el('settingsBtn').addEventListener('click', openSettings);
    el('runAllBtn').addEventListener('click', runAll);
    el('refreshBtn').addEventListener('click', function(){ loadAll(); });

    document.querySelectorAll('[data-jump]').forEach(function(b){
      b.addEventListener('click', function(){
        var id = b.getAttribute('data-jump');
        var target = el(id);
        if(target) target.scrollIntoView({ behavior:'smooth', block:'start' });
        document.querySelectorAll('[data-jump]').forEach(function(x){ x.classList.toggle('on', x === b); });
      });
    });

    el('filters').addEventListener('click', function(e){
      var b = e.target.closest('button[data-filter]');
      if(!b) return;
      S.filter = b.getAttribute('data-filter');
      var all = el('filters').querySelectorAll('button');
      for(var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      renderAccounts();
    });
    el('search').addEventListener('input', function(e){
      S.search = e.target.value || '';
      renderAccounts();
    });

    document.addEventListener('click', function(e){
      var close = e.target.closest('[data-close]');
      if(close){ closeVeil(close.getAttribute('data-close')); return; }
      var jump = e.target.closest('[data-jump]');
      if(jump) return;
      var btn = e.target.closest('button[data-act]');
      if(btn){ e.preventDefault(); handleAct(btn); return; }
      var tile = e.target.closest('#platformGrid .pTile');
      if(tile){
        var key = tile.getAttribute('data-plat');
        S.platform = S.platform === key ? '' : key;
        renderPlatforms();
        renderAccounts();
        var target = el('accounts');
        if(target) target.scrollIntoView({ behavior:'smooth', block:'start' });
        return;
      }
      var card = e.target.closest('#acctGrid .aCard');
      if(card){
        var pf = card.getAttribute('data-pf');
        var id = card.getAttribute('data-id');
        if(pf && id) openAccount(pf, id);
      }
    });

    document.addEventListener('change', function(e){
      var input = e.target;
      if(input && input.getAttribute && input.getAttribute('data-act') === 'travel-auto'){
        travelAction(input.getAttribute('data-id'), input.checked ? 'auto-on' : 'auto-off', input);
      }
    });

    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){
        if(!el('askVeil').hidden) resolveAsk(null);
        else if(!el('acctVeil').hidden) closeAccount();
        else if(!el('addVeil').hidden) closeVeil('addVeil');
        else if(!el('setVeil').hidden) closeVeil('setVeil');
        else if(!el('histVeil').hidden) closeVeil('histVeil');
      }
      if(e.key === 'Enter' || e.key === ' '){
        var card = e.target.closest ? e.target.closest('#acctGrid .aCard') : null;
        if(card && !e.target.closest('button') && !e.target.closest('input')){
          e.preventDefault();
          openAccount(card.getAttribute('data-pf'), card.getAttribute('data-id'));
        }
      }
    });

    el('platChips').addEventListener('click', function(e){
      var b = e.target.closest('button[data-plat]');
      if(!b) return;
      stopAddTimer();
      ADD.pf = b.getAttribute('data-plat');
      renderPlatChips();
      renderAddBody();
    });
    el('addBody').addEventListener('click', function(e){
      var b = e.target.closest('button[data-add]');
      if(!b) return;
      var act = b.getAttribute('data-add');
      if(act === 'trae-start') startTraeFlow();
      else if(act === 'trae-claim') claimTrae();
      else if(act === 'wb-start') startWbFlow();
      else if(act === 'qoder-start') startQoderFlow(b.getAttribute('data-region') || 'cn');
      else if(act === 'intl-start') startIntlFlow();
      else if(act === 'ast-pw') astMode(true, b);
      else if(act === 'ast-cookie') astMode(false, b);
      else if(act === 'ast-login') astLogin();
    });
    el('addBody').addEventListener('paste', function(e){
      if(e.target && e.target.id === 'traeUrl') setTimeout(claimTrae, 0);
    });
    el('addConfirm').addEventListener('click', submitAdd);

    el('notifySave').addEventListener('click', saveNotify);
    el('notifyTest').addEventListener('click', testNotify);
    el('refreshAllBtn').addEventListener('click', refreshAll);
    el('clearHistBtn').addEventListener('click', function(){
      askConfirm('清空运行记录', '只删除日志，不影响账号和凭证。').then(function(v){
        if(!v) return;
        api('/api/history/clear', { method:'POST', body:'{}' })
          .then(function(){ S.history = []; renderActivity(); return loadAll(); })
          .then(function(){ toast('运行记录已清空', 'ok'); })
          .catch(function(e){ toast(e.message, 'err'); });
      });
    });
    el('forgetBtn').addEventListener('click', function(){
      askConfirm('更换口令', '会退出当前控制台，下次需要重新输入 ADMIN_TOKEN。').then(function(v){
        if(!v) return;
        try { localStorage.removeItem(TOKEN_KEY); } catch(e) {}
        token = '';
        location.reload();
      });
    });

    el('askOk').addEventListener('click', function(){
      if(!el('askField').hidden){
        var v = el('askInput').value.trim();
        if(!v){ el('askErr').textContent = '不能为空'; return; }
        resolveAsk(v);
      } else {
        resolveAsk(true);
      }
    });
    el('askCancel').addEventListener('click', function(){ resolveAsk(null); });
    el('askInput').addEventListener('keydown', function(e){ if(e.key === 'Enter') el('askOk').click(); });

    setInterval(tickClock, 1000);
    setInterval(function(){
      if(!token) return;
      if(document.visibilityState !== 'visible') return;
      if(anyVeilOpen()) return;
      loadQuiet();
    }, 120000);

    tickClock();
  }

  /* ---------- boot ---------- */
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch(e) { token = ''; }
  try {
    var theme = localStorage.getItem(THEME_KEY) || '';
    setTheme(theme === 'night' ? 'night' : 'day');
  } catch(e) { setTheme('day'); }

  bind();

  if(token){
    api('/api/ping').then(function(){ loadAll(); }).catch(function(){ showLogin(''); });
  } else {
    showLogin('');
  }
})();
</script>
</body>
</html>
`;
/* ================================================================== */
/* 导出                                                                */
/* ================================================================== */

export default {
  fetch: __worker.fetch,
  scheduled: __worker.scheduled,
};
