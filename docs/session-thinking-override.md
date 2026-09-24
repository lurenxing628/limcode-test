# 会话思维参数覆盖（Draft）

## 范围与权威

- 增加 conversation-scoped `ModelProfileRecord.thinkingOverride`（类型区分预算、OpenAI effort、Gemini level、Claude adaptive effort、DeepSeek 模式）。thinking-only 记录标记 `inheritModel`，不成为模型身份选择器，不往 ModelProfile 塞入完整渠道配置。
- 复用 `ModelProfileScopeSet/Clear`、配置 authority、现有 record/link 路径；补充仅限 ModelProfile 的 `ScopeRead/ScopeSnapshot` 确认通道（不是全 Bridge 版本重构）。外部 set/clear/thinking/reset 必须带已观察 authority/session/revision；非 conversation scope 拒绝思维覆盖，UI 只发送普通数据。
- 底栏从 authority 获取 conversation → workflow → agent → global 的有效模型；thinking/reset 在同一 mutation lock 内校验 `expectedEffectiveModel`。继承改变时拒绝旧选择，不把 global fallback 或旧继承身份偷偷固化到会话。
- 模型专属配置**整体替代**渠道设置；专属配置没有 generationConfig 即未设置，不继承渠道的思维数值。默认选项写作“跟随渠道设置：<值>”，显示渠道或模型高级配置里实际会发送的值；未设置时显示“未设置（由服务决定）”，请求不带思考参数。Gemini 默认省略思考参数，类型或等级不受支持时明确拒绝；Astra 的现有适配器归一化另作标注，不把参数编辑器示例值当成服务端默认值。
- 切渠道/模型走现有 selection 入口并清掉覆盖，不进行数字与等级换算。普通 Fork 沿用已有配置复制，复制成目标独立记录；本改动不修改 Fork 实现。
- 子 Agent 的模型选择规则不变。默认不继承父会话思维；在下拉面板底部勾选「派出的子 Agent 也用这个思考强度」后，按现有初始化路径复制兼容的思维覆盖。请求参数解析只查**子会话自身** record；已有子会话覆盖优先。

## 单次请求生效

1. 新 ModelRequest 边界经 authority 加载 `requestGeneration`，使用现有 `settings_snapshot_object_id` 冻结。与 `requestCompression` 是并列数据，不把聊天参数写入压缩配置。
2. 普通 full-request adapter 把冻结 generationConfig 交给 LLM capability，再经现有 provider mapper 生成线级 body。重试/重放读取原快照；已经冻结的请求不会读到后来编辑。
3. 原始 requestBody 同时冻结，**先选冻结输入再统一 normalize/adapt**，Astra 不支持字段不会被 normalize 后的原始 body 重新加回；无关自定义字段保留。Gemini 按实际 nested 子键检测 deep-merge 冲突，空对象/无关采样子键允许，null/false 覆盖父对象仍拒绝。Claude `output_config` 仅检查已证实冲突的 effort；非法 thinking+采样组合拒绝本次保存并提示，不偷偷改渠道默认、不永久禁止恢复默认后的发送。
4. native recipe 使用同一单请求 authority。普通 effort 变更沿用已有 configuration_update；恢复字段省略时丢弃旧动态更新并通过现有 full-request rebase（`thinking_defaults_restored`），不复用旧 anchored effort。压缩 rebase 的 fresh/base 必须由本次**冻结 requestGeneration**重建，不使用旧 compression high，也不在压缩结束后再读 live scope。reset 未设置时省略、reset 渠道 low、显式 medium、合法 high 保持分开验证；不把默认/low 当 off，不改 reasoningMode/native flags/工具配对或重复工具。
5. 底栏当前选择与最近请求冻结参数摘要分开；服务未返回的实际内部思考预算不伪造。摘要位于已有 stream stats，SQLite worker 仍严格校验允许字段和有界字符串。没有 schema migration、旁路 writer 或真实数据修改。

## 本地能力矩阵

这些是**当前代码的保守编辑能力**，不是远端服务承诺。HTTP/SSE 经既有 mapper；WS 仅项目原有 Responses 支持路径。

| 协议 / 模型族 | 控件和原生字段 | 限制 |
|---|---|---|
| OpenAI-compatible，已知 o1/o3/o4（不含 o1-mini/preview） | effort → `reasoning_effort` | low/medium/high；第三方同名转发仍未真实联调 |
| OpenAI-compatible / Responses，GPT-5 / 5.1 / 5.2 / 5.6 已列明型号 | 分模型 effort；Responses → `reasoning.effort` | 5 为 minimal/low/medium/high；5.1（含2025-11-13）为 none/low/medium/high；5.2（含2025-12-11）才开放 xhigh；5.6（gpt-5.6、sol、terra、luna）为 none/low/medium/high/xhigh/max、没有 minimal；未知小版本不按小数点推能力 |
| OpenAI-compatible / Responses，精确 Astra（复用现有识别） | effort + 原有 native continuation | low/medium/high/xhigh/max；none/minimal 不作为新选项；现有渠道配置适配为 low 时明确标注（两种渠道一致） |
| OpenAI-compatible / Responses，精确 GPT-6 Sol / Luna（含日期快照） | effort；Responses 另有 native continuation | none/low/medium/high/xhigh/max，官方默认 medium；minimal 适配为 low 时明确标注；强度不是 none 时去掉采样参数 |
| Gemini 2.5 文本 Pro / Flash | `thinkingBudget` | -1 自动；Pro不允许0；Flash允许0；模型范围与输出上限校验；image/audio/live不开放预算快捷入口 |
| Gemini 3.x | `thinkingLevel` | 复用 shared/geminiThinking 按具体型号等级集合；不发送预算 |
| Claude 3.7 Sonnet / 已识别旧4系 | `thinking.budget_tokens` | 明确 maxOutputTokens；整数≥1024且小于输出上限；temperature仅省略/1，top_k省略，top_p仅省略或0.95–1，不合法拒绝保存 |
| Claude 精确4.6 Opus/Sonnet、Mythos Preview（及日期标识） | adaptive + `output_config.effort` | 与预算互斥；4.6 为 none/low/medium/high/max；Mythos Preview 始终思考、没有 xhigh；渠道配置不放宽已知模型 |
| Claude 4.7 及之后（能力表 `anthropic_adaptive`：Opus 4.7/4.8/5/5.5、Sonnet 5、Fable、Mythos） | adaptive + `output_config.effort`（low–xhigh、max） | 只按能力表精确 id（及日期标识）开放；始终开启的 Fable、Mythos、Opus 5.5 不提供 none（渠道设了 none 时注明实际仍会思考）；非默认的 temperature / top_p / top_k 无论是否思考都报冲突；编码与渠道配置同一路径 |
| OpenAI-compatible，DeepSeek 写法或 enable_thinking 写法的模型（DeepSeek、MiMo、Kimi、GLM-4.5 及以上、混元、Qwen3、ERNIE） | 档位按渠道的有效规则给出（手动写法 → 测试结果 → 接口地址 / 模型 ID），与请求改写、能力表共用（`shared/openAICompatibleDialect.ts`、`resolveProviderOpenAICompatibleDialect`） | DeepSeek none/low/high/max；关不掉思考的模型（Kimi K3、GLM-5.3、Kimi K2.7 Code）不提供 none；只能开关的模型为 none/high；平台差异计入（硅基流动 V4 为 high/max，百炼按模型）；发送时就近换算，“跟随渠道”显示实际发出的值；OpenRouter 按原值发送（没有 max），本机服务不套这些档位 |
| 未知别名 / 自定义渠道模型 | 显示现有渠道或模型配置；已配置 effort 时复用渠道编辑器的参数集合 | 未配置时不猜测能力；Gemini 保留具体型号约束。参数集合来自 `shared/llmThinkingLevels.ts`，不代表远端服务已通过联调 |
| 与思维/输出相关 custom body | 保留已有 body，保存覆盖时报冲突；`chat_template_kwargs` 只在含思考相关子键时算冲突 | 失败草稿保留，可确认重试/放弃草稿/恢复默认；不全局阻塞其他会话 |
| 升级前保存、现在已不适用的覆盖 | 请求冻结、子 Agent 继承与“子 Agent 也用”开关用容错解析：`openai-effort` 与 `deepseek-effort` 的值仍可用时改写 kind 后生效，否则按渠道设置发送 | 保存时仍严格校验；思考下拉单独显示“已保存：X（当前不生效）”，选“跟随渠道”即可清除 |

不声明适用于所有第三方兼容端点。已知名称也可能被中继限制；实际能力报错仍来自原 provider 请求路径。能力白名单需随仓库 adapter 与模型证据更新，不是旧协议 fallback。

## 保存与 UI

- UI 区分未提交草稿、保存中、结果未确定、已读取已保存值。10秒未确认仅表示 uncertain；可能已提交，绝不把超时/异常解释为未写或取消。
- Router 收到 ModelProfile 写消息、进入任何 preflight/owner/queue await **之前**注册 completion Promise。afterRequestId 读等待对应操作 settled，再进入同一 `.configuration-authority` 跨进程锁观察实际 pair/absence。未知请求/超时/换 host 只报告结果未确定，不重发、不用旧值冒充成功。
- CAS 比较 scope + profile/link完整内容（包括安全 absence），不只看 profile id；确认带 authority、session、sequence 与相关 request id。旧 full ConfigurationSnapshot 仅触发 scoped reread，不覆盖已确认 scope；晚到的旧 after-read 不能移除后续 queued write 的关联。
- 快速 high→medium→reset 串行提交并使用前次实际 revision；发送只等**当前 conversation**的保存。Composer 的等待/错误也按 conversation 分离，切会话不会阻塞新会话或把旧 await 发送到新会话。底栏思维控件直接展示失败原因与重试入口；配置编辑页复用 ModelProfileSaveStatus。
- 读取有效模型失败时仍返回已保存的 profile/link、revision 与 `effectiveModelError`，允许重新选择模型修复。配置读取只载入相关 scope 引用的模型记录，避免扫描所有会话模型文件。
- 写入结果未知时，第一次重试仍先读取原操作结果。若该读取也失败，下一次显式重试重建编辑会话、保留旧草稿并解除发送等待；不自动重放未知写入。更换 Host 时同样重新读取，迟到回执不能恢复旧状态。
- `inheritModel` 记录只承载思维设置；发送、编辑和重试均不把其中保存的旧模型身份变成显式模型选择。重置思维保留独立的子 Agent 继承开关，关闭该开关明确保存 false。
- **没有“撤销已提交写入”**：放弃未提交草稿只丢本地草稿；有 requestId 时必须 after-read 确认实际状态后放弃。恢复默认是新的 thinking-only CAS reset，不是补偿回写。显式重连保留旧草稿为 detached，不自动跨代提交。

### 渠道无关的操作确认契约

`modelProfileObservation`是read及全部成功mutation的共同构造点。成功mutation统一包含宿主确认的`operation`（实际语义为select/thinking/reset/clear）、实际使用的`expectedRevision`、结果`revision`、scope、authority、sequence及原通道关联的session/correlationId。clear不再依靠缺少profile来猜测操作完成。前端使用发送时保存的submitted操作/基线匹配，而不是当前可能已queued的新选择；同时验证profile/link成对、scope和记录id一致。

`profileState`明确区分：`absent`=没有本scope的profile/link，`default`=有模型记录但无思维覆盖，`overridden`=有显式思维覆盖（包括none/0等显式值），`unknown`=结果未确定。异常路由只能返回unknown，不能表示absence；读到或收到不完整/不一致结构也不能当作保存成功。reset仍区分显式模型（保留模型，仅去覆盖）与inherit-only记录（若未启用子 Agent 继承，则去掉本地记录），不是clear的别名。

本确认格式与OpenAI/Claude/Gemini/DeepSeek无关，没有改变已有provider能力/格式代码。真实组件script-setup/Pinia→router→authority的交叉测试从OpenAI high切换到：OpenAI另一渠道effort、Gemini budget、Claude budget、Claude adaptive none、DeepSeek none、无thinking能力gpt-4o。每条路径验证select/reset/clear回执、实际落盘与UI观察一致；clear后由当前Agent继承链解析有效模型，再set覆盖（无能力模型执行reset），并生成真实临时Turn/dry-run请求。旧模型expectedEffectiveModel和旧revision均由真实router拒绝，实际absence不改变。

可达性边界：同一健康client/root/scope编辑会话中，clear在途时新selection只queued，直到原clear确认才提交；“新选择已先提交而第一次clear确认才来”不按合法生产路径构造。实际测试暂停真实clear回执，验证queued新渠道被原clear正确释放且旧重复correlationId不能确认新写；显式session/root重连后的迟到clear也不影响新渠道。错误operation/基线、unknown冒充absence或dangling link是结构防御注入，**不宣称**健康宿主会生成这些非法包。gpt-4o不能创建思维覆盖，因此不硬造非法set，而经独立公共恢复入口验证reset/clear无悬挂。

f0751b3的健康clear能凭本地submitted操作和缺少profile完成；本次没有声称必然出现悬挂。真红证明的是宿主回执缺少明确操作/基线/absence语义，以及旧前端无法拒绝这些未证实的确认。旧store快速reset测试曾将显式模型reset简写成absence，本轮改为实际生产的“保留模型、无override”并增加断言，不改变或放松生产reset规则。

### ModelProfile 局部 session fence：两处复核边界

此 token 仅作用本 `clientId + authorityId(root/lifecycle) + scope`。authority 实例更换/根路径变化会产生新代际；捕获旧根的排队操作逐写点检查 fence，产品 dispose 会 retire authority。使用原有 mutation lock 等待，不强释活锁，不重构其他 Bridge/配置或 Runtime SQLite。

1. **record/link 非原子多文件的部分提交**（`vscodeConfigurationMutations.setScoped/clearScoped`）：set先完整保存record/index，再guard，再发布link；clear先保存删除link的index，再guard，再删record。新建 absent-set 在中间失效留下不可达record+安全absence；更新已有pair在中间失效，原link仍指向已经更新的record；clear中间失效留下无link的不可达record。不能把后两者的失败说成“未写”。不补偿回写、不删除残留；随后同锁读返回实际pair/revision或absence，无悬空link。测试在真实第二写点guard注入session变化，并启动排在锁后的重读；三个场景均检验catalog引用完整性及用户基于新revision显式操作可恢复。底层无关I/O损坏仍按原store错误报告，不引入自动修复。
2. **有界session/completion**（`CommandRouter.handleModelProfileScope`、`ModelProfileMutationCompletions`）：session最多256个，读/写从接收至settled均pin；只淘汰idle，绝不为新scope取消另一窗口/范围的在途操作；全满且均在途则新请求uncertain。idle旧token被淘汰后拒绝，显式重连生成新UUID并锁内读取实际值。普通组件mount或无关快照读复用session，只有显式renew重建。completion最多512个，未完成条目永不按TTL清除，不复用同一在途key；满时拒绝新注册，after返回unknown而非settled。已settled条目10分钟后过期，unknown不能证明取消；显式重连+锁内读恢复实际观察。容量测试使用固定小completion限额/合成registry占位，不进行无界压力或真实用户数据操作。

真实 VS Code 布局、键盘/鼠标交互未运行。组件验证执行实际 Vue script-setup、Pinia actions、真实router和authority；Composer发送用实际函数及其guard声明的headless夹具，不等同于渲染UI验收。

## 验证方式与边界

- 所有 runtime 数据均在自动创建的系统临时测试目录；provider 编码测试使用 example.invalid dry-run；native 集成只启动 loopback 模拟服务。
- `session-thinking.test.mjs`：普通 full-request adapter → LLM capability → 固定 provider 包实际编码器的 body 矩阵、格式负例、0/none/-1、custom body、空快照及显示归一化。
- `session-thinking-runtime.test.mjs`：首次请求、工具后新请求、队列、同请求瞬时失败重试、重放；真实 child coordinator 从父工具生成子/嵌套任务并检查编码后的 wire body；子自身覆盖继续、跨协议子渠道。
- `session-thinking-store.test.cjs`：真实 Pinia/Vue reactive、bootstrap/full payload 延迟调度、mock bridge structuredClone，无Proxy；scope序号、草稿、未知/超时、session/root换代、旧after-read与实际Composer submit。不是浏览器布局测试。
- `session-thinking-ui-fixture.cjs`：真实SessionThinkingControl script-setup；runtime中通过真实router保存Agent/Workflow继承模型、生成Turn并校验最终dry-run body。
- `configuration-authority.test.mjs`：保存重开、两会话隔离、模型专属整体替代、Fork独立及禁止Agent scope覆盖。
- `native-astra-integration.test.mjs`：真实 loopback HTTP/WS 的 native续接、high→恢复省略、恢复默认后重新选medium；不得携带旧 effort/updates/previous_response_id。

### 修复过程（保留失败，不隐去）

| 候选 | 结果与根因 |
|---|---|
| d6a4575 | 首次 build 类型检查失败：局部 thinkingOverride 隐式 any；后续显式标注类型 |
| e7cd3f0 | build、webview typecheck通过；相关93项89通过4失败。新摘要字段遗漏 worker严格白名单，创建ModelRequest报invalid shape。WS/native+run_agent既有64项通过 |
| 42b72bd | 增加单个有界字符串字段校验，不绕过校验；受影响7项6通过，剩余child续聊夹具未合法claim已释放ownership |
| 6421e40 | build、webview typecheck通过；164项162通过、1失败、1取消。新增排队用例误注册在child测试内，父测试结束取消该子测试；没有产品失败断言。后续只将排队用例移到顶层，保留全部断言 |
| ede6170 | 续聊夹具按宿主路径claim；普通runtime+native集成12/12通过，含实际子/嵌套wire隔离与HTTP/WS恢复默认 |
| 2945bba | 原164组全绿，但独立review发现3P1+5P2，不能用原绿结果证明修复完整；未发布PR |
| fe988a9 | P1-1/P2-3/P2-4/P2-5四个定向真红；冻结raw重加字段、GPT5.1 xhigh、Claude采样与Gemini粗粒度冲突 |
| d4fa8aa | 修复候选编译失败：当前TS目标不支持Object.hasOwn；8e096ce改为hasOwnProperty.call |
| 74530e6 / 807bee1 | native组合夹具未触达自动压缩，前置断言失败；保留为无效前置历史，不算产品红/绿 |
| 6160855 | 新Turn运输组合可绿，但不是review同Turn分支证明，不能替代该红证据 |
| e6c5ff1 | 真实authority+内核多请求冻结，在同Turn自动压缩后旧high configuration_update实际重发，HTTP/WS dry-run两例真红 |
| ebcef80 | 最小生产修复让compression rebase遵从当前冻结值，11项定向绿；后续增加low/保持high及recipe前置 |
| 6727ba4 | scope候选编译失败：role被推断为string；b1897d3修为active as const；原错误日志保留 |
| 59b553e | scope/router/session初始10项定向绿，非最终统一验证 |
| 93b703d | 新增部分写故障注入、容量、组件到Turn、Composer scope等待、同Turn native四种选择，共18项定向绿，非最终统一验证 |
| f0751b3 | 同SHA build/typecheck、scope18、protocol15、完整相关194均绿；两位review原问题CLOSED，但scope新增clear回执P2，不能当最终可发布候选 |
| 74e059b | 仅新增测试，生产源码/编译closure仍与f0751b3相同；14项2绿12红：六目标渠道+真实延迟clear回执operation缺失、5项结构防御无法拒绝；旧session/authority迟到fence原已通过 |
| 8d090cb | 共同构造点统一operation/expectedRevision/profileState，前端严格核对；compile/typecheck及clear定向15/15通过；后续最终统一验收另记完整SHA |

最终候选的构建SHA、完整命令与通过/失败计数见交付记录。每轮先固定干净提交再构建，`dist/build-provenance.json` 与 `dist/extension/reliable-kernel-compile-provenance.json` 必须匹配；不同SHA的结果不得混成一次通过。

最终复验约定（PowerShell，cwd为本feature独立副本；Node v23.11.0 / npm 10.9.2 / win32；锁文件依赖，不使用其他副本dist）：

```powershell
npm run build
npm run typecheck:webview
node --test --test-name-pattern 'review scope|review completion|bootstrap|scope序号|timeout|快速|无thinking|重建|新root' tests/reliable-kernel/configuration-authority.test.mjs tests/reliable-kernel/session-thinking-runtime.test.mjs tests/reliable-kernel/session-thinking-store.test.cjs
node --test --test-name-pattern 'review P' tests/reliable-kernel/session-thinking.test.mjs tests/reliable-kernel/session-thinking-runtime.test.mjs tests/reliable-kernel/native-astra-integration.test.mjs
node --test tests/reliable-kernel/session-thinking.test.mjs tests/reliable-kernel/session-thinking-store.test.cjs tests/reliable-kernel/session-thinking-runtime.test.mjs tests/reliable-kernel/configuration-authority.test.mjs tests/reliable-kernel/request-compression-settings.test.mjs tests/reliable-kernel/llm-capability-provider-adapter.test.mjs tests/openAIResponsesWebSocketSession.test.cjs tests/openAIResponsesWebSocketNative.test.cjs tests/reliable-kernel/native-astra-integration.test.mjs tests/runAgentToolSchema.test.cjs
```

这三组计数彼此重叠，分别报告，不能相加充当独立测试总量。完整组仍是**相关回归**而非全仓所有测试。日志保留在父工作区tmp，逐组记录exit code；以上命令列出并不代表已经执行成功。

**未运行**：真实 VS Code UI、真实模型API/usage、任意第三方服务兼容性。没有自动安装、合并、修改已安装扩展/globalStorage或用户数据库。依赖安装提示的上游漏洞不在本功能内自动升级修复。
