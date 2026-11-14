#!/usr/bin/env node
/*
 * WorkBuddy 国内版「真实积分余额 / 今日到账」字段探针（只读，不签到）
 *
 * 用法：
 *   WB_AT='accessToken' node wb-balance-probe.mjs
 *   node wb-balance-probe.mjs ./token.txt        # 从文件读
 *
 * accessToken 怎么拿：官方网页/客户端登录后，F12 → Network → 任意一条
 * copilot.tencent.com/v2/ 请求 → Request Headers → Authorization →
 * 复制 "Bearer " 后面那一串。
 *
 * 千万不要用 refreshToken 跑：它会轮换，新的签发、线上 KV 里那个立刻失效。
 *
 * 已确认（无凭据扫路由，401=路由存在，404 Route Not Found=路由不存在）：
 *   /v2/billing/meter/get-user-resource          ← 大概率是余额
 *   /v2/billing/meter/checkin-status             ← 大概率是今日签到态
 *   /v2/billing/meter/checkin-activity-status    ← 现在用的（total_credits 是本期累计）
 *   /v2/billing/meter/daily-checkin              ← 领取，本脚本不打
 */

const API = 'https://copilot.tencent.com';
const UA = 'workbuddy-signin-worker/1.0';

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith('--'));

async function readToken() {
  const t = process.env.WB_AT || process.env.WB_ACCESS_TOKEN;
  if (t) return t.trim().replace(/^Bearer\s+/i, '');
  if (fileArg) {
    const fs = await import('node:fs/promises');
    return (await fs.readFile(fileArg, 'utf8')).trim().replace(/^Bearer\s+/i, '');
  }
  throw new Error('没有 accessToken：设 WB_AT 环境变量，或把 token 写进文件后当参数传进来');
}

async function call(path, body = '{}') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Authorization: `Bearer ${token}` },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 网关非 JSON 响应 */
    }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: `<异常 ${e.name}: ${e.message}>` };
  } finally {
    clearTimeout(timer);
  }
}

function report(label, r) {
  console.log(`\n### ${label}`);
  if (!r.json) return console.log(`HTTP ${r.status} | ${r.text.slice(0, 300).replace(/\s+/g, ' ')}`);
  console.log(`HTTP ${r.status} code=${r.json.code} msg=${r.json.msg ?? r.json.message ?? ''}`);
  console.log(JSON.stringify(r.json, null, 1).slice(0, 6000));
}

const token = await readToken();

/* 1) 余额候选：路径 × body 变体 */
for (const body of ['{}', '{"require_usage":true}', '{"need_detail":true}']) {
  report(`/v2/billing/meter/get-user-resource  ${body}`, await call('/v2/billing/meter/get-user-resource', body));
}

/* 2) 今日签到态候选 */
for (const body of ['{}', '{"need_detail":true}']) {
  report(`/v2/billing/meter/checkin-status  ${body}`, await call('/v2/billing/meter/checkin-status', body));
}

/* 3) 对照：现在被误当余额用的那条，看它到底还有哪些字段 */
report('/v2/billing/meter/checkin-activity-status', await call('/v2/billing/meter/checkin-activity-status'));

console.log('\n完成。把上面整段输出发回来即可（token 不会出现在输出里）。');
