# 跨 Provider 压缩与摘要参数

实现基线：2026-09-22。本文描述当前代码，不把已查阅的厂商功能全部当作已接入。

## 默认行为

新建压缩配置使用 `kind: auto`、`providerNative.trustMode: verified_only`、`llmSummary.reasoning.mode: provider_default`。后备顺序为 `segmented_summary → deterministic_summary → continue_uncompressed_if_fits`。这些字段位于既有 `llmCompressionConfigs` record，不新增设置存储根。

`provider_default` 是不发送思考控制字段，不等于关闭思考。摘要不继承聊天请求中的原生 reasoning、采样、工具或输出格式覆盖；显式选择 `inherit_chat` 才继承聊天思考意图，并按摘要目标模型重新验证。附件摘要预处理也不再写死 `low`。

分段摘要指本地分段后调用配置的 LLM，不是离线推理。确定性摘要才是不调用 LLM 的有损保底；启用它表示接受这种损失，使用时会显示后备方法。取消勾选会从后备链删除，空链不会被运行时重新补全。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `shared/modelCapabilities.ts` | 精确模型注册表、能力证据编解码、摘要意图解析、压缩执行计划 |
| `backend/capabilities/modelCapabilityDiscovery.ts` | 显式读取 Anthropic Models API，完整分页；不会在普通请求中联网发现能力 |
| `backend/capabilities/summaryReasoning.ts` | 清除普通聊天请求覆盖，应用冻结的摘要原生参数 |
| `shared/summaryOutputBudget.ts` | 统一冻结与实际编码使用的摘要输出预算 |
| `backend/capabilities/llmProvider.ts` | 文本摘要与 OpenAI/Anthropic 原生压缩执行、显式端点探测 |
| `backend/reliableKernel/contextCompressionCoordinator.ts` | 内核唯一压缩协调器，冻结顺序、后备方法与替换提交 |
| `backend/reliableKernel/compressionSourceReplay.ts` | 文本后备从不可变来源重建原生不透明状态所覆盖的历史 |
| `shared/compressionExecution.ts` | 有界、脱敏的持久化失败与恢复决策合同 |
| `shared/compressionNotices.ts` | 只从已提交事实投影警告和无消息锚点的失败提示 |

## 能力证据，不等于接口名字

能力按渠道 ID、精确模型 ID、端点指纹和 transport 绑定。改变上述身份后，新请求不采用旧探测证据；已冻结请求不跟随当前配置变化。端点指纹不保留 URL 密码、查询参数和片段。

`official_registry` 表示有文档依据；`provider_api` 表示读取了机器能力目录；`verified_probe` 表示执行了独立探测；`explicit_trust` 是用户声明；`unknown` 表示未知。原生状态另行区分 `documented / verified / declared / unsupported / unknown`。默认 `verified_only` 不把 `documented` 当作在线验证，只有 `verified` 或显式 `declared` 可进入原生尝试。

OpenAI Compatible 只代表编码格式。自定义网关、未识别模型和未来模型不自动获得 OpenAI 思考档位或压缩能力。Google 官方兼容入口与 Gemini 原生入口使用不同参数编译路径。DeepSeek 不再是独立渠道类型：它和 Kimi、智谱、百炼等都走 OpenAI Compatible，思考参数写法按接口地址和模型 ID 识别（`shared/openAICompatibleDialect.ts`），也可在高级配置里手动指定；旧配置与历史快照里的 `deepseek` 读作 `openai-compatible`。能力表复用同一份方言规则：DeepSeek 写法或 enable_thinking 写法、且有模型规则时记为 `deepseek_toggle`，摘要推理的预设按模型规则就近换算（例如均衡的 medium 在 DeepSeek 上发成 high）；按接口地址认出服务商时记为官方文档登记，只按模型 ID 认出（中转站）时仍为未确认。规则来源依次为手动写法、“测试这个模型”的结果（`models[].capabilitySnapshot`，`source: verified_probe` 且带 `reasoning.wireFormat`）、自动识别。未确认精确能力的模型使用 Provider 默认或明确标记的高级未验证设置，不猜测所有模型都接受同一组等级。

在设置页点“验证原生端点（会调用一次）”才发送探测。探测只含合成的 `verification_marker=42`，没有当前对话、附件或工具；可能产生少量 Provider 费用。只返回 HTTP 200 而没有原生 compaction 状态，不算验证通过。404/405/501 生成绑定到当前身份的负面能力证据。并发相同探测在宿主内合并。正常渲染、保存配置和回合执行不会偷偷探测。

Anthropic 模型目录读取 `thinking.types` 和逐级 effort 标志；按需压缩要求 `capabilities.compaction.summarize`。`context_management.compact_20260112` 只证明阈值压缩，不能替代按需压缩证据。

## 厂商接入范围

### OpenAI Responses

当前使用独立 `/responses/compact` 适配器，保留完整原生返回窗口及加密状态。自动阈值仍由 Limcode 内核判断，手动压缩也进入同一维护调度。原生状态只允许同一渠道与模型消费。

继续使用既有动态推理 rebase 防护：工具边界、未完成原生调用和转向不能被悄悄删除。文字后备同样保留正确的 rebase 计划。

没有额外启用服务端 inline 自动压缩，也没有新增 `compaction_trigger` 传输适配器。这样避免服务端和本地同时修改上下文。不能将本实现描述成支持所有 OpenAI 压缩模式。

### Anthropic Messages

新增 signed block 按需压缩：Messages 请求 `compaction.type: summarize`，使用 `compact-2026-09-04` beta。携带冻结的原对话系统要求、工具定义与思考设置，而不是误用摘要参数。只接受符合完成契约的单个签名 compaction block，原样保存并在后续 Claude 请求中回放。费用统计累计 `usage.iterations`。

未启用另一套 `compact_20260112` 服务端自动阈值或 pause-after-compaction 流程。

Claude 旧式 `enabled + budget_tokens`、新式 adaptive、effort 和是否允许关闭分别判断。不能把“有 effort”直接编码成任何 Claude 都接受 adaptive。未知兼容模型不做这种推断。

### Google Gemini / 其他兼容渠道

使用文本摘要路线，不把 context caching 当作压缩。原始 thought signatures 和工具原子边界继续由既有投影保留。

Gemini `generateContent` 的 2.5 模型使用 `thinkingBudget`；已列出的后续精确模型使用其支持的 `thinkingLevel`。Google OpenAI 兼容预算字段使用 `extra_body.google.thinking_config`，不得同时发送重叠的 `reasoning_effort`。

Google 兼容入口的 `includeThoughts` 独立编码为 `extra_body.google.thinking_config.include_thoughts`，保留显式 `true` / `false`，可以与 `reasoning_effort` 并存；数字预算则不再同时发送 effort。未登记的 Gemini 模型显示“能力未确认”，不把未知能力标成已确认不支持，也不开放快捷思考设置。

## 冻结与恢复

配置解析先冻结能力快照、摘要意图的实际原生字段及执行顺序。每个后备方法是独立 `ModelRequest`，共享同一来源根与请求设置快照，使用不同稳定请求身份；底层 Provider 不自行切换方法。

`stream_stats_json` 增加有界的 `compressionPurpose`、`compressionDecision` 和 `failure`。字段在已有 SQLite worker 事务中写入；不是第二个状态机或新的数据库表。失败保留 category、状态码和脱敏消息，重放不会仅凭“ended as provider_failed”丢掉原分类。普通请求在创建时冻结“已压缩”或“本次未压缩继续”的决定。

手动压缩允许有界的多方法请求链，不再把第二个后备请求误判为损坏。所有方法必须共享冻结设置和来源，之前的方法已经终止，选定前缀不得扩大。维护回合没有伪造聊天消息，但失败可以独立显示。

## 失败规则

404/405/501 原生端点失败属于能力或配置错误，不因正文包含 `Upstream request failed` 就被当作临时错误。瞬时连接错误、限流和服务故障仍服从已有冻结 Attempt 重试预算。

认证、权限、额度、取消、宿主交接、SQLite、上下文来源损坏和内部合同错误不由摘要后备掩盖。

只有自动压缩、用户启用 `continue_uncompressed_if_fits`，且完整普通请求的计划估算不超过输入容量时，才允许本次继续未压缩请求。这个条件是有安全余量的计划判断，不是对任意 Provider 分词的数学保证。无法容纳时明确失败；手动压缩不伪装为“继续回答”。

空正文、仅思考没有摘要正文、已知输出截断不会被当作摘要成功。传输错误也不在叶子摘要函数内偷偷返回确定性摘要。

输出预算采用确定的冷启动保护：自动值至少 8192，最多 16000，并结合可见摘要目标及显式思考预算；显式最大输出保持不变，思考预算不小于总输出上限时拒绝。冻结端与编码端共用函数。尚未实现历史 P95 自学习预算，也不会在恢复中突然删除上限或降低思考强度。

## 不透明原生状态的文本后备

文本方法遇到原生压缩状态时，经 `ContextSegmentSource → CompressionBlockSource → ContextSegment → verified CAS` 展开它覆盖的原始来源，不对加密字符串或签名占位符做假摘要。重建限制深度、数量和字节；来源缺失或循环直接拒绝。

这不是通用跨模型热切换：现有 native binding 限制保留，未实现让任意新渠道直接消费另一厂商原生状态。需要跨厂商文本重建时使用同一受审计的来源链，不能复制加密块冒充可移植摘要。

## 设置与版本边界

设置仍通过 `llmProviderConfigs`、`llmCompressionConfigs`、`llmCompression` sections 及原有 revision/flush 协议保存。模型能力证据放在已有模型目录条目 `capabilitySnapshot` 中；不另起存储根。高级摘要编辑器只编辑摘要 generationConfig，错误 JSON/不合法预算不会保存。

当前正式策略名称为 `provider_native`，不是旧的 `openai_responses_compact`。本实现没有改写用户磁盘配置、迁移正在运行的旧请求或重置 Runtime 数据库。旧配置在部署前应重建或重新选择当前策略及绑定；旧冻结 authority 缺少新的执行计划时会明确拒绝，不从可变当前设置补造历史事实。不要在仍有旧请求运行时热替换部署，也不要宣称已完成在线迁移兼容。

## 验证入口

```bash
npm run build
npm run typecheck:webview
npm run check:contracts:plan
node scripts/reliable-kernel/run-local-tests.mjs
node --test tests/reliable-kernel/model-capabilities.test.mjs \
  tests/reliable-kernel/compression-provider-contracts.test.mjs \
  tests/reliable-kernel/request-compression-settings.test.mjs
node scripts/playwright/verify-compression-settings.mjs
```

浏览器工具可通过 `LIMCODE_PLAYWRIGHT_MODULE` / `LIMCODE_CHROMIUM_EXECUTABLE_PATH` 指定，截图和 JSON 报告默认写临时目录，不进入产品包。单元、实际 wire 编码和 SQLite/CAS 回归使用合成数据及本地服务器，不会花费真实模型额度。它们不能替代用户实际中继与账户权限的在线验收。

## 官方合同参考

登记日期：2026-09-22。模型目录随时间变化，以精确模型能力和用户明确选择为准。

- OpenAI reasoning：https://platform.openai.com/docs/guides/reasoning
- OpenAI compaction：https://developers.openai.com/api/docs/guides/compaction
- Anthropic effort：https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic thinking troubleshooting：https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
- Anthropic compaction：https://platform.claude.com/docs/en/build-with-claude/compaction
- Anthropic Models API：https://platform.claude.com/docs/en/api/beta/models
- Gemini generateContent：https://ai.google.dev/api/generate-content
- Gemini thinking：https://ai.google.dev/gemini-api/docs/thinking
- Gemini generateContent thinking：https://ai.google.dev/gemini-api/docs/generate-content/thinking
- Google OpenAI compatibility：https://ai.google.dev/gemini-api/docs/openai
- Gemini context caching：https://ai.google.dev/gemini-api/docs/caching

## 先前工作区验证记录（历史，非当前结果）

2026-09-22，macOS / Node 24.15.0，工作区基于 `8a7ba677`，未暂存、未提交、未推送。

| 验证 | 结果 |
| --- | --- |
| `npm run build` | 通过，扩展与 Webview 构建产物已更新 |
| `npm run typecheck:webview` | 通过 |
| `npm run check:contracts:plan` | 通过，11 份计划合同结构检查；不是安装出口验收 |
| WebSocket + 能力 + 实际 wire 编码 + SQLite 压缩回归 | 87 项通过，0 失败，0 跳过 |
| `run-local-tests.mjs` | 649 项：620 通过，29 条件跳过，0 失败 |
| Playwright 1.63.0 | 1440×1000 与 700×1000 均通过，无页面错误、控制台错误、失败请求或横向溢出 |
| 新设置交互 | 非法摘要预算不保存；渲染/保存不自动探测；一次点击对应一次不带实际对话的探测命令 |
| 设置保存恢复 | 丢弃确认后重新读取并完成保存，两种尺寸均通过 |
| `git diff --check` | 通过 |
| 产品依赖 | `package.json`、`package-lock.json` 无修改；Playwright 仅装在 `/tmp/limcode-compression-browser-tools` |

29 项跳过来自原有的平台/可选门禁条件，未算作通过。没有使用真实模型账户执行收费调用，没有迁移用户运行库，也没有进行 VSIX 安装验收。

证据：
- `/tmp/limcode-compression-proof-build.log`
- `/tmp/limcode-compression-proof-targeted.log`
- `/tmp/limcode-compression-proof-all.log`
- `/tmp/limcode-compression-proof-browser.log`
- 浏览器报告及截图：`/var/folders/cz/6c_ysj195sbcytsy44zttdbc0000gn/T/limcode-compression-visual-gO9hIp/visual-verification.json`，同目录包含 desktop/narrow PNG。

已验证代码的 sourceTreeSha256：`22d038509bae90c1f3c93f838577587b8a94f834d590332f35fa957e52d52490`；compiledClosureSha256：`2f286a16f8621146722bb11baee9cf8f83c3edd176a2aea0b65cf85e00c7cc43`。这是未提交工作区的验证记录，不是 clean-worktree 或 installed proof。

## 当前续作验证记录

2026-09-22，macOS arm64 / Node 24.15.0。原工作区 HEAD 为 `9593f3d61b504175a6ed58389e00321c47692adb`，未改当前分支、未暂存、未创建业务提交。

- 开始前用独立 Git index 保存全部 91 个已修改/未跟踪文件，保护引用为 `refs/codex/snapshots/model-compression-20260922T082115Z`，快照为 `9aa477775151258c5ccf87a2877c407b6414449d`。
- 修复会话分叉测试在重建配置 authority 后未同步 Host-local 工作目录的问题；修复思考控件 VM 缺失 `URL` 及“未知能力”显示/断言混淆；修复 Google 兼容摘要编码遗漏显式 `includeThoughts`，新增真实编码回归。设置页说明改为每次请求冻结、带安全余量的输入估算。
- Google 字段核对依据：[Google OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)。原生压缩抽查依据：[OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)、[Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)。这些文档核对不代表已执行在线账户验收。
- 共享工作区复跑期间 `dist/extension` 被清理，且数据集检查代码及测试出现并发修改；该次缺少编译模块的运行不计作有效验证。保留并发修改后冻结 `2f7f7f8616a18bb41cc042c8b79d53be072be429`，在独立 worktree 重新构建、运行以下验证。

| 验证 | 当前结果 |
| --- | --- |
| `npm run check:plan` | 通过：扩展/Webview 构建、Webview 类型检查、11 份计划合同检查 |
| 完整 `run-local-tests.mjs` | 81 个测试文件，920 项：888 通过、32 平台条件跳过、0 失败 |
| 模型能力、provider 实际编码、请求压缩设置、三组 Responses WebSocket 定点测试 | 138 项通过、0 失败、0 跳过；与完整集有重叠，不能相加 |
| compression-settings Playwright 1.61.1 | 1440×1000、700×1000 均通过；零页面错误、控制台错误/警告、失败请求和横向溢出 |
| 设置交互及保存恢复 | 非法预算不保存，渲染/保存不探测，单击仅一个合成探测命令；丢失保存确认后读取并恢复成功 |
| 工作区保护 | 原 HEAD 保持，暂存区为空；验证快照后仅增加此文档说明，代码与隔离快照一致 |
| `git diff --check` | 通过 |

32 项跳过为 6 项 Linux x64 foundation 场景和 26 项 Windows 专属场景；未算作通过。未调用真实收费模型/用户中继，未做 VSIX 安装、真实 Extension Host 出口或 Linux/Windows 实机验证。没有改动产品依赖；浏览器使用已有 npm 缓存，并未新增安装。此结果证明当前混合工作区源码快照的本机验证通过，不证明原工作区干净，也不证明拆分提交后依赖完整。

证据目录：`.git/codex-backups/model-compression-20260922T082115Z/`（原工作区）：

- `check-plan.isolated.log`、`kernel.isolated.log`、`focused.isolated.log`、`playwright.isolated.log`。
- `browser-evidence/visual-verification.json` 及两张 PNG；保存了截图副本，避免只依赖临时目录。
- `isolated-compile-provenance.json`：sourceTreeSha256 为 `749c754d4f434b2dbfb6e861806d0b793df2757c1140cb599b501893770554d8`，compiledClosureSha256 为 `1566f62362d0300411753699c8ecd953b9d06822a3d5f6a017dfc1afcdd804d4`。
- `suggested-commit-scope.md`：50 个压缩相关文件、5 个混合文件的 hunk 选择说明；分叉测试夹具修复随工作环境提交，数据集管理与存储锁另行提交。正式暂存/提交后仍需检查拆分依赖并运行 `check:plan:tracked`。
