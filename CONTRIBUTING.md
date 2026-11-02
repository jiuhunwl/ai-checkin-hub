# 贡献指南

先说结论：**这个项目故意保持单文件**。所有逻辑都在 `worker.js` 里，不拆包、不引入依赖、不用构建工具。提 PR 前请接受这个前提——它不是懒，是为了让「粘进 Cloudflare 网页控制台就能跑」这个体验不打折。

## 环境

只需要 Node.js 18+（本地跑语法检查和 `wrangler dev`），没有 `npm install` 这一步。

```bash
node --check worker.js     # 语法检查，改完必跑
npx wrangler dev           # 本地跑起来（需要 wrangler，它自己会装）
```

线上验证只能靠真实部署：`*.workers.dev` 打开页面，用 `ADMIN_TOKEN` 登录，加一个自己的账号跑一轮。

## 加一个新平台

绝大多数「拿 token 就能签到」的平台不需要写完整模块，用工厂就行：

```js
const Foo = createTokenPlatform({
  keyInfo: 'foo-signin/v1/account',   // HKDF 派生密钥用的 info，必须全局唯一
  meta: { /* 名称、图标色、提示、是否已验证 */ },
  primaryFields: ['access_token'],    // 判定「有没有凭证」的字段
  normalize(raw) { /* 把用户粘贴的各种形态整理成统一结构 */ },
  hasCredential(acct) { /* 凭证是否可用 */ },
  identity(acct) { /* 返回 { id, label }，用于去重和显示 */ },
  prepare(acct, env) { /* 每次运行前的准备，比如换 token、算签名 */ },
  urls(ctx) { /* 状态查询 / 领取 的接口地址 */ },
  headers(ctx) { /* 请求头，含签名、UA、Cookie */ },
  statusMethod: 'GET', claimMethod: 'POST',
  body(ctx) { /* 领取请求体 */ },
  parseStatus(json, ctx) { /* 把状态响应转成统一结果 */ },
  parseClaim(json, ctx) { /* 把领取响应转成统一结果（含 already 判定） */ },
  probe: { /* 只读探活配置，用于「刷新积分」 */ },
  afterClaim(result, acct) { /* 领取成功后的补充动作，可选 */ },
});
```

需要扫码/网页授权的，再加 `loginStart` / `loginPoll` / `passwordLogin`。

写完在 `PLATFORMS` 注册表里挂上，聚合接口、加密存储、控制台、定时任务、批量运行会自动带上它。

**必须同时更新的三件事**：

1. `meta.verified` —— 没有用真实账号验证过就写 `false`，页面会显示「未验证」。不要为了好看标成已验证。
2. README 的平台表格与「添加账号」小节。
3. 如果引入了新的密钥/变量，更新 README 的部署表和 `wrangler.toml.example`。

## 改控制台页面

页面 HTML 是一个 JS 模板字符串，有两条硬规则，违反会得到难以定位的报错：

- 内容里**不能出现反引号**，也不能出现 `${`——需要插值时用字符串拼接，或写成 `\${`。
- 内联事件（`onclick="..."`）里的单引号要写成 `\\'`；因为整个脚本被包在模板字符串里，少一层转义就会打断 HTML 属性。
- 内联事件只能调用挂到 `window` 上的函数。新增交互函数时记得 `window.xxx = xxx`，否则点了没反应（脚本跑在 IIFE 里）。

样式约定：只用 CSS 变量（`--bg` / `--panel` / `--ink-*` / `--line` / `--ok` / `--warn` / `--err` / `--accent`），深色模式靠 `@media(prefers-color-scheme:dark)` 覆盖变量，不要写死颜色。页面**不加载任何外部资源**——不要引 CDN 字体、图标库或统计脚本。

## 提交规范

- 一个 PR 只做一件事。修接口和改样式分开。
- commit 标题用中文或英文都行，说清「为什么」而不是「改了什么」。
- 涉及存储结构变更时，必须兼容 KV 里的老记录（读不到新字段要有合理默认），并在 PR 描述里写明迁移方式。
- 不要顺手重构无关代码。

## 安全红线

- 任何响应、日志、错误信息都不能出现令牌、Cookie、私钥，哪怕是片段。
- 新平台的加密 `info` 必须唯一，不能复用其它平台的。
- 用户输入的密码类字段（参考 AStudio）只在单次请求内存里使用，不入库、不写日志。
- 不要把别人的账号、真实的 token、你自己的 KV id 写进代码、注释、截图或测试数据。文档截图一律用演示数据。

## 不属于本项目的功能

成长中心那一套（连登奖励、兑换、盲盒、玩法）、多号批量刷积分、任何形式的绕过风控。这些不是技术做不到，是不做。
