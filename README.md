# dsh-image · 模型与识图

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 web profile 用的识图开关：**先证明某个模型路由真的能读图，再让配置承认这件事。**

> Declaring `input: [text, image]` is a claim, not a check. This plugin draws an
> image, asks the endpoint directly on its own protocol, scores the answer against
> two independent facts, and only then writes the declaration and the default
> model — with every write reversible.

---

## 为什么需要它

DSH 里，一条路由能不能识图，写在 profile 的 `llm-pi-ai` 配置里：

```yaml
models:
  - id: some-model
    name: some-model
    input: [text, image]   # 只是一句声明
```

这句声明**没有任何环节去校验**。它写错了，失败发生在对话中途：你把图贴进去，模型回一句"我看到一张图"或者干脆答非所问，报错指向的却常常是别的地方。反过来，一个真能读图的模型，也会因为没有这句声明而收不到图片。

这个插件把"能不能识图"变成一次可以复现的测量，再把测量结论写成配置。测量与写入是同一条代码路径，所以界面上看到什么、工具里调用什么、`curl` 打到什么，结论一致。

## 它做三件事

| 动作 | 做什么 | 副作用 |
| --- | --- | --- |
| **探测** | 现画一张图，直连端点请它读，核对回答 | 无（只消耗一次请求的 token） |
| **应用** | 把 `input: [text, image]` 写进该模型，并设为默认模型 | 改 profile 配置 |
| **撤回** | 抹除识图声明（删掉 `input` 键，不是改回 `[text]`）、恢复默认模型、按历史逐条回退 | 改 profile 配置 |

## 探测是怎么设计的

### 1. 现画一张图

`buildProbeImage()` 自己写 PNG：只用 `node:zlib` 的 `crc32` 和 `deflateSync`，不依赖任何图形库。460×200 白底，画两个**互相独立**的事实：

- **4 位随机数字**，用 7 段数码管画在左半边（x=42..300）——考"文字读取"；
- **60×60 的随机颜色方块**（红 / 绿 / 蓝），画在右半边（x=350..409）——考"像素真的被看了"。

两个事实是分开的，所以结论能区分三种情况，而不是只有"能/不能"：数字对了是确认，只对颜色是"看到了但读不准"，两个都不对是"图像被忽略"。

### 2. 直连端点，不经过模型抽象

探测按这条路由**自己的**协议发请求，`baseURL` 接受三种写法（主机根、`/v1`、完整端点），已经写死某个叶子的会被**替换**而不是继续拼接：

| 协议 | 端点叶子 | 图像字段的两种序列化（都会试） |
| --- | --- | --- |
| `openai-completions` | `chat/completions` | `image_url: { url: <dataURL> }` → `image_url: <dataURL>` |
| `openai-responses` | `responses` | `image_url: <dataURL>` → `image_url: { url: <dataURL> }` |

同族协议的网关对同一个字段的形状并不统一。所以**只因为形状被拒**（`refused-image`）时会换另一种形态再试一次，两种都被拒才算"这个端点不收图"。

### 3. 判两个事实，而不是判"看起来像"

- `digitsHit`：答案里必须出现与真值**完全相同**的数字串；或整个答案去掉非数字字符后正好等于真值。所以 `17341` 不会因为"包含 7341"而通过。
- `colorHit`：答案必须点名被画的颜色，**且不能同时点名另外两种颜色**。说"红和蓝"不算读对。

### 4. 失败必须说清是什么失败

一次"不能识图"有很多原因，把原因混在一起就等于没测。每个非 2xx 都分类：

| 状态 | verdict | 含义 |
| --- | --- | --- |
| 401 / 403 | `bad-credential` | 密钥无效或没有该模型权限 |
| 402 | `insufficient-credit` | 余额或配额不足 |
| 404 | `not-found` | baseURL / 协议不匹配，或模型不在这个路由上 |
| 410 | `endpoint-gone` | 端点已下线 |
| 429 | `rate-limited`（可重试） | 被限流 |
| 5xx | `server-error`（可重试） | 上游故障 |
| 400 / 413 / 415 / 422 + 图像关键词 | `refused-image` | 端点以图像相关理由拒绝 |
| 400 / 413 / 415 / 422 无图像关键词 | `refused` | 模型名 / 参数 / 协议不匹配 |
| 超时 | `timeout` | 在 `timeoutMs` 内没响应 |
| 连不上 | `unreachable` | 附带 `error.cause.code`（DNS / TLS / 拒绝连接） |
| 2xx 但非 JSON | `bad-response` | 网关错误页或 SSE 流 |
| 2xx 但无文本 | `empty-answer` | 空 choices / 只返回 reasoning |

`unsupported`、`bad-credential`、`not-found`、`refused`、`refused-image` 属于**硬停止**——再问一次也不会变好，直接结束。传输层失败连续两次即停，避免每条采样都白等一个超时。

### 5. 多采样，区分"读得准"和"猜中一次"

默认 2 次采样，可设 1–3 次；**每次都是新画的图**（新数字、新颜色）。判定：

| verdict | 条件 | confidence |
| --- | --- | --- |
| `vision-confirmed` | 至少一次准确读出数字 | 每次都读对 → `high`；部分读对 → `medium` |
| `vision-partial` | 颜色对、数字没读对 | `low` |
| `no-vision` | 有回答，但既没读数字也没认颜色 | `medium` |

只有 `vision-confirmed` 才建议 `apply`。

## 写入什么，写在哪里

| 设置 | 写入方式 |
| --- | --- |
| 识图声明 | `configEditor.edit()` 改 profile patch 里 `@deepseek-ai/dsh-llm-pi-ai` 那一行的 `providers[<provider>].models[<id>].input = ['text', 'image']`（写在 override 层） |
| 默认模型 | `agentDefaultModel.saveSelection({ provider, model })` |
| 抹除 | `delete input`。不是改回 `['text']`——从没声明过的行不该因为被抹除而多出一个键 |
| 历史 | 每次写之前快照旧值，追加到插件目录下 `.history.json`（最多 200 条；先写 `.tmp` 再 `rename` 原子替换） |
| 回退 | 按快照写回旧值，把该条标记 `undone`（记录保留，不删） |

`apply` 之前如果最近一次探测结论是失败，仍然允许写入，但会在返回结果里带一条 warning——矛盾必须可见，不能悄悄成立。

## 三种入口

**① 设置页**：设置 → **模型与识图**（`settings.section`，`order: 50`，排在插件市场那一项之后）。中英双语，含供应商 / 模型下拉、采样次数、探测、应用、抹除、改动历史。

**② Agent 工具** `model_vision_picker`：

| `action` | 必填 | 说明 |
| --- | --- | --- |
| `list` | — | 供应商与模型、识图声明、最近探测结论、改动历史 |
| `probe` | `provider`, `model` | 真实探测；可选 `attempts`(1–3)、`timeoutMs`(2000–120000) |
| `apply` | `provider`, `model` | 可选 `declareImage`、`setDefault`（都默认 true） |
| `erase` | `provider`, `model` | 可选 `eraseImage`、`restoreDefault` + `defaultTo` |
| `revert` | — | 可选 `id`；省略则回退最近一条**未回退**的记录 |

**③ HTTP（仅本机页面用）**：

| 方法 | 路径 | 请求体 |
| --- | --- | --- |
| GET | `/plugins/model-vision-picker/state` | — |
| POST | `/plugins/model-vision-picker/probe` | `{ provider, model, attempts?, timeoutMs? }` |
| POST | `/plugins/model-vision-picker/apply` | `{ provider, model, declareImage?, setDefault? }` |
| POST | `/plugins/model-vision-picker/erase` | `{ provider, model, eraseImage?, restoreDefault?, defaultTo? }` |
| POST | `/plugins/model-vision-picker/revert` | `{ id? }` |

`Origin` 不是 `localhost` / `127.0.0.1` / `[::1]` 一律 403；请求体上限 64 KB；只注册 exact 路由，不做前缀匹配。

## 安装

前置：DSH 的 web profile（本仓库在 **0.2.1-rc.2** 上跑通），以及这些 Host 服务：`llm`、`configEditor`、`agentDefaultModel`、`credentials`、`webServer`、`tools`；Client 侧需要 `slots`、`locale`。

安装方式与当前正在运行的那一份完全一致——profile 里 `link` 到本仓库目录：

**1. 把仓库放到任意路径**（下文用 `C:/path/to/dsh-image` 占位）：

```
git clone https://github.com/hyzdgd/dsh-image.git C:/path/to/dsh-image
```

**2. 编辑 profile 的 `package.json`**（Windows 默认在 `%USERPROFILE%\.dsh\profiles\web\package.json`）：

```jsonc
{
  "dependencies": {
    // …原有依赖…
    "@local/model-vision-picker": "link:C:/path/to/dsh-image"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …原有 bundle…
        "@local/model-vision-picker"
      ]
    }
  }
}
```

> 依赖名必须与仓库 `package.json` 的 `name` 一致（本仓库是 `@local/model-vision-picker`），因为 `link:` 依赖按包名登记。想把名字换成 `@local/dsh-image` 也可以，但要同时改三处：`package.json` 的 `name`、`client.js` 顶部 `window.__ModuleLoader__.load({ id: ... })` 的 id、以及 profile 里的依赖名与 bundle 名。`private: true` 表示不作为 npm 包发布。

**3. 在 profile 目录安装并重启**：

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install
```

重启 `dsh web`。设置页会出现「模型与识图」；`model_vision_picker` 工具同时可用。

`cordis.patch.yml` 里已经写好 insert 行，随 bundle 自动生效，不需要手改 `cordis.yml`：

```yaml
- insert:
    - id: model-vision-picker
      name: '@local/model-vision-picker'
```

### 用之前先确认

- **路由必须在 `llm-pi-ai` 的 profile 配置里出现过**。由别的插件在运行时注册的路由可以列表、可以探测，但写不了声明——界面会标「(只读)」，工具会明确说明原因。
- **协议只支持 `openai-completions` 与 `openai-responses`**。`anthropic-messages` 之类会直接返回 `unsupported`（并说明探测支持哪些协议），不会假装测过。
- **密钥解析顺序**：先 `process.env[apiKeyEnv]`，再 `credentials` 服务。都解析不到仍会发一次无鉴权请求，并在 `warnings` 里说明。

## 自检（不需要 DSH、不需要网络）

```powershell
node verify.mjs
```

期望输出 `全部通过：95/95 项检查`，退出码 0。覆盖：

- PNG 编码正确性——签名、尺寸、每行 filter、IDAT 解压长度，以及**解出来的像素**：方块 3600 个像素逐个与声明颜色比对、数字笔画确实被画出、画布仍是白底；
- 判定函数——数字（完整串命中、更长数字不命中、多段数字命中）、颜色（中英别名、点名别的颜色不算、同时点名两色不算）；
- `baseURL` 归一化——根地址、`/v1`、完整端点、叶子替换、空值抛错；
- 探测引擎（注入假 `fetch`）——`vision-confirmed` / `vision-partial` / `no-vision`、8 类 HTTP 失败、超时、不可达（含 `error.cause.code`）、非 JSON、空回答、协议不支持、无凭据警告、`attempts` 上限夹取、图像字段形态回退；
- 请求体形状——`image_url` 对象 / 字符串、`input_image`、`data:image/png;base64,` 前缀、`max_tokens: 400`。

## 目录结构

```
dsh-image/
├── index.js            # Host 一半：探测引擎 + 配置读写 + 历史 + 工具 + HTTP 路由
├── client.js           # Web 一半：设置页卡片 + 中英双语字典 + 样式
├── cordis.patch.yml    # bundle patch：insert 行 id model-vision-picker
├── package.json        # dsh.bundle.patch / dsh.client 声明
├── icon.svg
├── locale/
│   ├── zh.json         # 设置页标题与说明
│   └── en.json
├── verify.mjs          # 离线自检（不依赖 DSH）
└── README.md
```

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 设置页没有「模型与识图」 | bundle 没加进 `bundles` / 没 `pnpm install` / 没重启 | 回到「安装」 |
| 供应商下拉项带「(只读)」 | 该路由不在 `llm-pi-ai` 配置里 | 换成 `llm-pi-ai` 配置的路由；否则只能探测 |
| 探测 `bad-credential` | `apiKeyEnv` 对应的密钥没解析到 | 配环境变量，或在供应商卡片里填 key |
| 探测 `not-found` | baseURL / 协议不匹配，或模型名不在该路由 | 核对 baseURL 与 `api` 字段 |
| 探测 `refused-image` | 端点以图像理由拒绝 | 不要声明识图；换模型或换路由 |
| 探测 `no-vision` | 有回答但没用图像内容 | 换 `openai-responses` 路由，或确认该模型是否真支持图像输入 |
| 探测 `vision-partial` | 看到图但读数不稳 | 再探一次或换更强的模型，别急着 `apply` |
| `apply` 有 warning「识图声明可能不成立」 | 最近一次探测是失败的 | 先探测通过再应用 |
| 「抹除」显示无可恢复的默认模型 | 历史里没有记录过默认模型旧值 | 手动在设置里改默认模型，或先 `apply` 一次 |

## 已知限制

- **`lastProbe` 只在内存里**：`dsh` 重启后「上次探测」标记消失，改动历史仍在 `.history.json` 里。
- **`.history.json` 在插件目录**：已写进 `.gitignore`；多份安装共享同一个目录才会共享历史。
- **数字是 4 位**：弱模型可能"颜色看对、数字读错"，结论是 `vision-partial`。想更严就看采样明细里的原始回答，别只看 verdict。
- **界面语言**：中 / 英之外的 locale 回落到英文；`locale/*.json` 里只有设置页的标题与说明，卡片内的文案在 `client.js` 的 `zh` / `en` 字典里。
- **改配置靠写 profile**：需要 `configEditor` 与 `llm-pi-ai` 行都存在，缺一个就退化为只读（界面会说明原因）。

## 安全

- 密钥不落盘、不进历史：探测时从 `process.env` 或 `credentials` 服务取，只放进请求头。
- 历史只记录**被改过的配置值**（`input` 数组、默认模型选择）。
- HTTP 路由只服务本机页面：非 loopback `Origin` 直接 403，请求体 64 KB 上限，只注册 exact 路由。
- 探测会真的调用端点、消耗 token（单次响应上限 400 tokens），`attempts` 决定请求次数（1–3）。

## 许可

尚未声明许可证。如需开源请添加 `LICENSE`（MIT / Apache-2.0 等），并在本节写明。当前 `package.json` 为 `private: true`，不作为 npm 包发布。