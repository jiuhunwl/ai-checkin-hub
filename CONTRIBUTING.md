# 签到塔 · 贡献指南

**这个项目故意保持单文件。** 所有逻辑都在 `worker.js` 里，不拆包、不引入依赖、不用构建工具。提 PR 前请接受这个前提：它不是懒，是为了让「粘进 Cloudflare 网页控制台就能跑」这个体验不打折。

## 环境

只需要 Node.js 18+（语法检查与 `wrangler dev`），没有 `npm install`。

```bash
node --check worker.js     # 改完必跑
npx wrangler dev           # 本地跑起来
```

线上验证只能靠真实部署：打开 `*.workers.dev`，用 `ADMIN_TOKEN` 登录，加一个自己的账号跑一轮。

## 加一个新平台

绝大多数「拿 token 就能签到」的平台用工厂即可：

```js
const Foo = createTokenPlatform({
  keyInfo: 'foo-signin/v1/account',   // HKDF info，必须全局唯一
  meta: { /* 名称、强调色、提示、是否已实测 */ },
  primaryFields: ['access_token'],
  normalize(raw) { /* 把用户粘贴的各种形态整理成统一结构 */ },
  hasCredential(acct) { /* 凭证是否可用 */ },
  identity(acct) { /* 返回 { id, label }，用于去重和显示 */ },
  prepare(acct, env) { /* 每次运行前的准备，比如换 token、算签名 */ },
  urls(ctx) { /* 状态查询 / 领取地址 */ },
  headers(ctx) { /* 请求头，含签名、UA、Cookie */ },
  statusMethod: 'GET', claimMethod: 'POST',
  body(ctx) { /* 领取请求体 */ },
  parseStatus(json, ctx) { /* 状态响应转统一结果 */ },
  parseClaim(json, ctx) { /* 领取响应转统一结果，含 already 判定 */ },
  probe: { /* 只读探活配置 */ },
  afterClaim(result, acct) { /* 领取成功后的补充动作，可选 */ },
});
```

需要扫码 / 网页授权的，再加 `loginStart` / `loginPoll` / `passwordLogin`。

写完在 `PLATFORMS` 注册表里挂上；聚合接口、加密存储、控制台、Cron、批量运行会自动带上它。

**必须同时更新：**

1. `meta.verified` —— 没有用真实账号验证过就写 `false`。页面会显示「未实测」，不要为了好看改成已验证。
2. README 的平台表格与「添加账号」小节。
3. 如果引入新密钥/变量，更新 README 部署表与 `wrangler.toml.example`。

## 加一条成长中心能力（参考 WorkBuddy 旅行）

旅行不是通用签到钩子，而是平台模块里的一组独立函数。新增类似能力时：

1. 在对应平台 IIFE 内实现「读状态 → 决策 → 执行 → 回查 → 落盘」的闭环，不要只发写请求。
2. 以服务端状态字段为准；缺字段 / 未知字段判失败，不要默认成「已完成」。
3. 区分「今日已完成」与「可重试失败」：限流、网络、无 Buddy、配置读取失败都不能写完成标记。
4. 状态存进同一条加密账号记录，`publicView` 只暴露展示字段，不暴露任何令牌。
5. 在平台模块导出 `travel(env, { id, action })`，聚合层会自动提供 `POST /api/accounts/travel`。
6. 控制台在账号详情与右侧栏里接入；没有该能力的平台不要显示空面板。

判定文案与状态机参考 `worker.js` 的「成长中心：自动派猫猫旅行」段。

## 改控制台页面

页面 HTML 是一个 JS 模板字符串，硬规则：

- 内容里**不能出现反引号**，也不能出现 `${`。需要插值时用字符串拼接。
- 页面脚本里不要使用 `onclick="..."`。所有交互通过 `data-act` / `data-add` / `data-filter` 事件委托完成。
- 主题通过 `<html data-theme="night|day">` 切换，不要用 `prefers-color-scheme` 写死。
- 只用 CSS 变量：`--ink` / `--paper` / `--panel` / `--line` / `--signal` / `--ok` / `--warn` / `--bad` / `--info` / `--muted` / `--dim`，不要在组件里写死颜色。
- 页面**不加载任何外部资源**：不引 CDN 字体、图标库、统计脚本。图标用文本符号或内联 SVG。
- 所有用户输入插入 DOM 前必须经过 `esc()`。
- 改完至少跑一次 `node --check worker.js`，再用浏览器过一遍：登录、筛选、展开详情、旅行按钮、添加账号、设置、移动端无横向溢出。

## 提交规范

- 一个 PR 只做一件事。修接口和改样式分开。
- commit 标题说清「为什么」，而不只是「改了什么」。
- 涉及存储结构变更时，必须兼容 KV 老记录（读不到新字段要有合理默认），并在 PR 描述里写明迁移方式。
- 不要顺手重构无关代码。

## 安全红线

- 任何响应、日志、错误信息都不能出现令牌、Cookie、私钥，哪怕是片段。
- 新平台的加密 info 必须唯一，不能复用其它平台。
- 密码类字段只在单次请求内存里使用，不入库、不写日志。
- 不要把别人的账号、真实 token、KV id 写进代码、注释、截图或测试数据。文档截图一律用演示数据。

## 不做的事

- 多号批量刷积分、任何形式的绕过风控。
- 兑换、盲盒等重运营玩法（WorkBuddy 旅行为官方正常流程，已实现，不属于此列）。
