# 可靠运行内核架构

> 合同修订：`2026-07-31-r4`
> 当前状态：生产入口已切换到 ReliableKernelApplication、SQLite 与 CAS；下文说明现状和持续有效的边界。
> 支持范围：Windows x64、Linux x64、macOS x64 / arm64 的本地 VS Code Extension Host。
> 文档结构：本页描述现状，`contracts/` 定义机器合同，`phases/` 保留实施阶段依据；阶段编号不表示当前待办状态。

## 1. 当前职责

可靠内核以 SQLite 热控制面和 CAS 内容目录承载 Agent 运行语义。它替代旧文件 Runtime，集中处理原实现中的以下问题：

1. 工具提案、外部执行与模型终态混在一起；
2. 长对话重复复制完整历史，导致近似 O(n²) 的存储、同步和深拷贝；
3. 子代理执行、答案提交、投递、父 Turn 处理与终止控制缺少同一组权威事实；
4. Client changes、后台进程观察和硬切归档没有可执行的容量与恢复边界。

历史背景见[项目背景](./BACKGROUND.md)。机器定义以 [`contracts/`](./contracts/README.md) 为唯一权威，人读文档解释当前入口、数据权威与验证边界。

## 2. 当前结构

```text
一个 limcode.sqlite 热控制面
+ 一个 CAS 冷内容目录
+ Turn 唯一执行身份
+ Durable EffectIntent / EffectReceipt
+ RuntimeInboxItem / RuntimeDelivery / RuntimeDeliveryInputLink
+ Persistent ContextSequence DAG / ConversationContextHeadLink
+ ChildExecution + Parent/Turn/Intent/ActiveTurn Links
+ AnswerBridge / AnswerSubmission
+ bounded snapshot / changes ClientState
+ ConversationRuntimeOwnerManager（对话级宿主归属）
```

含义：

- SQLite 保存小而关键、需要事务约束的运行事实；
- CAS 保存工具原始结果、文件目标内容、上下文段、答案正文、进程输出 chunk 和回执详情；
- Agent、Conversation、Message、Turn、Tool、Process、Answer 与关系继续独立建模；
- 运行生命周期由可靠内核控制面负责；`backend/world` 仍复用部分领域定义与工具声明，但旧 ECS World/System 循环不是生产入口，也不是 Client Feed 的中间写入者；
- Webview 只接收有界快照和有界 changes，历史大内容按需读取；
- Agent、Workflow、Policy、Prompt、ModelProfile、WorkEnvironment、RuntimeContext 与 Settings 继续位于独立配置文件根，不进入 Runtime SQLite。

### 2.1 生产入口与依赖方向

```text
vscode/extension.ts
→ VscodeReliableKernelApplicationFacade.open
→ VscodeReliableKernelCutoverCoordinator.ensureCurrentRoot
→ VscodeReliableKernelProductRuntime.open
→ ReliableKernelApplication
```

| 边界 | 当前代码入口 | 职责 |
| --- | --- | --- |
| 宿主命令 | `backend/application/reliableKernel/VscodeReliableKernelCommandRouter.ts` | 校验 bridge payload、区分全局与对话作用域、调用控制面 |
| 产品装配 | `backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts` | 注入配置 authority、provider、工具宿主与会话执行器 |
| 宿主归属 | `backend/reliableKernel/ConversationRuntimeOwnerManager.ts`、`runtimeHostControl.ts` | 对话独占、视图/后台生命周期、维护与宿主注册互斥；不替代 ExecutionLease |
| Runtime 装配 | `backend/reliableKernel/runtimeApplication.ts` | 共享同一 RootBinding、RuntimeDatabase 与 CAS，组合控制面 |
| Turn 队列控制 | `backend/reliableKernel/turnControlPlane.ts`、`turnGuidanceQueue.ts`、`turnCommandWire.ts` | Turn 主控制面、guidance 修订/暂停/取消/重排、共享命令身份与事务约束 |
| 运行写入 | `backend/reliableKernel/runtimeDatabase.ts`、`databaseWorker.ts` | SQLite 事务、独立领域 mutation、提交后的 typed changes |
| 客户端查询 | `backend/reliableKernel/clientProjection.ts`、`runtimeSqlRows.ts` | 只读记录投影、原子快照与历史页；通过受限接口读取 worker 已核验的 CAS 内容 |
| 前端运行投影 | `backend/reliableKernel/clientFeed.ts`、`webviewFeedBridge.ts` | 有界 snapshot / changes、序列与会话隔离、历史按需读取 |
| 配置权威 | `backend/reliableKernel/vscodeConfigurationAuthority.ts` | 读取独立配置 roots，冻结执行配置，不把配置迁入 Runtime SQLite |
| 外部执行 | `backend/capabilities/`、`VscodeReliableToolHost` | 执行 LLM、MCP、文件、传输与进程能力，不接管领域生命周期 |
| LLM 适配分工 | `backend/capabilities/llmProvider.ts`、`llmStreamEventProjection.ts`、`geminiProviderAdaptation.ts`、`unifiedMessageConversion.ts`、`llmRequestContentPreparation.ts` | capability 生命周期、流事件投影、Gemini 适配、消息转换与多模态内容准备；关键模块均纳入现有构建/调试指纹 |

运行事实提交后直接进入 Client Feed；不要向退役的 `productionWorld`、旧文件 writer 或旧 clientSync 路径追加生产行为。全局配置可以广播，对话设置只能同步到同一对话；前端当前作用域不能由收到的快照重新指定。

同一工作区的多个宿主可以同时查看同一对话的已提交事实；仅活动执行/普通变更由单个宿主持有写入 owner。面板打开与隐藏都不长期占用 owner，提交结束且没有待处理工作时立即释放，另一个窗口无需重载即可接管。聊天或侧栏停止可跨宿主幂等提交经 Turn/lease 栅栏核验的持久 PendingTurnInput；仅原宿主取消本地能力并收敛终态，其他变更仍受 owner 拦截，绝不因超时抢占活宿主。创建、升级、归档和重置仍要求维护互斥，并先核验其他宿主已退出；不能只关闭本窗口后移动共享目录。配置入口继续拒绝运行期间切换数据根，本次不新增迁移或切换命令。

## 3. r4 已冻结的首发决定

### 3.1 子树终止

`interrupt_subtree` 是首发必选能力，不再属于可降级项。树遍历只依据稳定 `ChildExecutionParentLink`；`ChildExecutionActiveTurnLink` 只是当前活动 Turn 指针。终止事务同时覆盖活动 Turn 与尚未 admit 的 `ChildExecutionIntentLink`。

### 3.2 ProviderContinuation

首发决定为 `disabled-full-request`：

- 每个 ModelRequest 都从冻结的 ContextSequenceRoot 与 immutable recipe 构造完整请求；
- 不建 `ProviderContinuation` Runtime 表；
- 不读取旧 continuation，不产生或发送 suffix；
- 连接重建、压缩和 Provider retry 的正确性不依赖 continuation；
- 将来启用必须修改机器合同，不能用运行时 v1/v2 协商或旧格式 fallback。

因此首发保留“断线后正确恢复”的功能语义，但通过完整请求实现，不承诺 WebSocket suffix 优化。

### 3.3 后台进程

后台进程采用小型 packaged `detached wrapper`，不是通用 daemon/broker：

- wrapper 持续 drain stdout/stderr 到durable append-only spool；
- stable nonce、process group 与 start fingerprint 防止 PID 复用误判；
- wrapper 原子写真实 exit receipt；
- Extension Host 重启后读取 spool/receipt 并核验结果；
- 无法证明时写 `outcome_unknown`，不得伪造 `abnormal` 或 `exitCode=1`；
- stop 必须核验 nonce/fingerprint/process group，禁止凭裸 PID 杀进程。

`ProcessOutputChunk` 正文进入 CAS，但每个进程仍受 bytes、chunk count 与 flush 上限约束。达到上限后继续 drain 外部 pipe，只累计 `droppedBytes/truncated`，不再无限写 CAS 或 SQLite metadata。

### 3.4 Conversation fork、MCP 与压缩管理

- Conversation fork 保留关系语义，目标 Runtime 使用独立 `ConversationReuseLink`、`ConversationBranchLink`、`ConversationOriginLink`；Context DAG 共享不可变历史前缀；
- MCP 设置保留在 `settings/mcp-servers`，连接在宿主重启后重建；MCP 工具调用进入 `mcp_tool_call` EffectIntent/EffectReceipt，不自动重试，不可核验时 `outcome_unknown`；
- 原地 `CompressionUpdate` 从目标协议删除；title/summary 修改创建新的 immutable CompressionBlock replacement，旧块只允许 status 更新；
- `ask_user` 复用通用 Tool/Interaction/Outcome 领域，不建专表；
- task list 是 `update_task_list` Tool facts 的客户端派生投影，不建第二套权威；
- skills、rules 原地保留并在重启后重扫；workspace checkpoint Runtime 首发禁用并重置，但 checkpoint 配置保留。

完整 keep/rebuild/delete 表在 [`authority.json#capabilityDispositions`](./contracts/authority.json)。

## 4. 四条核心链路

### 4.1 SQLite 与 CAS

```text
先按摘要发布不可变 CAS 内容
→ 核对内容存在
→ SQLite 事务写入独立领域事实和内容引用
→ 事务直接返回同一 commit 的 typed changes
```

CAS 发布后、SQLite 提交前崩溃，只会留下无人引用内容；首发不做引用计数或在线 GC。

### 4.2 外部作用

```text
领域操作
→ Operation / Attempt / EffectIntent
→ SQLite commit
→ capability dispatcher
→ EffectReceipt
→ reconcile
→ ToolOutcome / ProcessReceipt / RuntimeInboxItem
→ 唯一 ToolModelResult（若属于 ToolCall）
```

模型结果必须唯一；外部副作用不承诺绝对 exactly-once。能够核验就核验，不能确认时写 `outcome_unknown`，不得偷偷重做。

### 4.3 上下文

```text
MessageRevision / Tool exchange
→ source-occurrence ContextSegment
→ persistent parent DAG
→ ContextSequenceRoot
→ ConversationContextHeadLink（当前 root）
→ ModelContextProjection(rootId)
→ 完整 Provider 请求
```

`ContentObject` 只去重正文；相同正文的不同来源不能合并 segment。retry/edit/fork 可从旧 parent 分支。压缩 root 用 `tail_node_id + tail_segment_count` 精确限定未压缩尾部，不重新读入已被摘要替换的原文。

### 4.4 异步交付

```text
AnswerSubmission / ProcessReceipt / 外部完成事实
→ RuntimeInboxItem（只保存来源事实）
→ RuntimeDelivery（目标、phase、attempt、消费状态）
→ RuntimeDeliveryInputLink（具体输入与 handled_at）
```

`consumed` 只表示输入已可靠注入；`handled_at` 才表示父执行器已吸收对应输入。失败人工重投创建 `attempt_seq+1` 新行，旧 failed 行不复活。

## 5. 有界 Client feed

- `hostBootId` 标识一次 Extension Host 启动；
- `commitSeq` 只在同一 host boot 内单调，wire 使用十进制整数字符串；
- snapshot 带 `snapshotCommitSeq`，snapshot read 与 changes 注册通过 writer barrier 或等价原子机制交接；
- 一个数据库 commit 对应一个原子 changes batch，不拆分成半可见状态；
- snapshot、change batch、宿主待发送 batches/bytes 与 Webview 活动窗口都有硬上限；
- 单 commit 或队列超限时丢弃尚未发送的普通 changes，合并为一个 `snapshot-required` 控制状态；
- gap、未知类型、hostBootId 变化或应用失败时整份重取有界 snapshot；
- 本地 `onCommit` 不代表跨进程广播；`externalDataVersion` 检测其他宿主提交后触发有界快照，后台继续执行由持久 `RuntimeDeliveryWake` 按对话归属路由；
- 首发不建设持久 `ClientChangeLog`。

数值与状态机只在 [`client-feed.json`](./contracts/client-feed.json) 定义。

## 6. Recovery owner

通用 scanner 框架由 D 建立，但扫描项使用稳定 ID 分配 owner：

- D：`recovery.effect-intent-hanging`、`recovery.file-change-unresolved`；
- F：`recovery.answer-inbox-invariant`、`recovery.delivery-pending`、`recovery.foreground-answer-wait-expired`、`recovery.interrupted-subtree-incomplete`。

`tool.json#recoveryScan` 是 target/action/owner 唯一权威；identity、阶段文档和 candidate checks 只引用这些 ID。

## 7. SQLite 硬切原则

- 不导入未发布的旧 Runtime 数据；
- 不双写文件数据库与 SQLite；
- SQLite candidate 始终使用隔离数据根；
- `migration.json#physicalManifest` 逐项覆盖全部注册 root/file、global settings sections、conversation settings、mixed-scope links、skills/rules、Workspace 与未知用户文件；
- global/agent/workflow scope links 保留，conversation/run/无 authority 的 agentSystem links 重置；
- 旧 Runtime 归档，配置按 manifest preserve/filter，Workspace 与未知用户文件不触碰；
- 激活后只修复新内核，不自动回退旧 writer。

当前 Runtime 使用 **epoch 5**。已发布 epoch 3、4 在完整 RootBinding、物理结构、manifest 和其他 Host 离线核验后先持久备份 SQLite，再以单事务升级原库并通过日志恢复；旧版中断的 3→4 升级先精确收敛；原会话、消息、附件、CAS、配置和 Workspace 保留。不支持的旧 epoch 或未知漂移保留原根并拒绝自动启动空库。当前 epoch 5 的 table/index/trigger/manifest/RootBinding 必须完整匹配，任何缺表、client mapping 或 digest 漂移均拒绝打开，不做原地修补。Windows 只在 SQLite 原生 I/O 边界使用 namespaced path，持久 RootBinding 仍保存 canonical path。

旧数据备份升级无需单独确认：选中根在启动前处理，其他旧根在当前 Runtime 就绪后自动逐库处理，查看旧历史时补做。目标库必须离线；其他正常数据集可继续运行。某个旧目录不完整会单独显示原因，不再阻断正常历史库的发现；仍禁止异常根隐式换成空库或自动切换当前选择。自动升级不会合并历史库，也不会启动非当前库的旧任务。详细来源审计与当前交付记录见 [epoch 3/4 恢复审计](../../../limcode-storage-topology-research/epoch3-4-recovery-audit.md)。

真实 cutover actor 是最终 VSIX 的 `cutover-only coordinator`：旧宿主先关闭 admission、drain 并持久化 request，然后退出；最终 VSIX 安装并重启后先完成 journaled archive、配置过滤和校验，再创建 SQLite/CAS/epoch 并原子激活 RootBinding。归档失败时 active pointer 不变且可按 journal 恢复。

## 8. 实施阶段与验证出口

以下是实施阶段和 gate 的分类，不是当前实现进度清单：

```text
A 合同、边界与物理清单
→ B SQLite/CAS/RootBinding foundation
→ C Turn 控制面
→ D Effect/Tool/File/Process/MCP
→ E Context/Compression/完整请求 Provider
→ F ChildExecution/Delivery/Client feed
→ G hard cut/源码删除/真实安装
```

- `foundation`：只证明 B 的 SQLite、CAS、RootBinding 与空根可用，不替换日常插件；
- `candidate`：在隔离根证明 C～F 能力与原子 recovery checks；旧源码可以仍存在，但候选导入图/路由不可达旧 writer；
- `installed`：G 物理删除旧入口、执行迁移、安装同一个当前 VSIX，并逐个运行 targets smoke。

Gate 的机器身份是稳定 `check.id`，handler 使用 `Map<checkId, handler>`，绝不正则匹配 description。未实现 handler 必须诚实输出 `PENDING`。

## 9. 明确不做

- 旧文件 Runtime 导入、双写、兼容 adapter、fallback 或长期 migration chain；只接受已发布 epoch 3、4 的精确离线升级；
- 运行时 schema v1/v2 协商；
- 在线 Context root/node GC 或 CAS 引用计数；
- 持久 ClientChangeLog 或跨宿主持久 feed；
- 通用进程 daemon/broker、全局多租户进程配额平台；
- 通用死信系统、closure table、图数据库或 gate 结果数据库；
- AskUser/TaskList 专用权威表；
- 把配置 authority 迁入 Runtime SQLite；
- 把本地测试、fixture、benchmark、数据库或密钥打入 VSIX。

## 10. 当前开发与验证边界

SQLite/CAS、Turn/Effect/Tool/Process、Context、子代理与 Client Feed 已接入生产组合根。`check:contracts:plan` 只检查合同结构自洽，不执行这些能力，也不证明当前 VSIX 已在目标宿主通过验收。

后续修改和发布仍需分别验证以下不变量，不得把“已有源码”或“类型检查通过”当作运行证据：

1. Turn 是唯一执行身份；
2. 每个终态 ToolCall 只有一个 ToolModelResult；
3. Context DAG 不复制历史前缀；
4. detached wrapper 身份核验、进程输出容量与分批读取通过故障测试；
5. 六类 recovery scan 各有证据；
6. interrupt_subtree、fork Links、MCP Effect 与 immutable compression replacement 通过 candidate；
7. snapshot/changes/queue/barrier 全部有界；
8. 生产导入图不包含旧 writer，修改不能恢复旧运行入口或增加 fallback；
9. physical migration manifest 与 cutover journal 真正执行；
10. 目标平台真实安装 smoke 通过，包括文件 mutation 与普通 Turn interrupt。

## 11. 常用检查

```text
npm run check:contracts:plan
npm run check:plan
npm run check:plan:tracked
npm run check:local
npm run check:gate -- --stage=foundation
npm run check:gate -- --stage=candidate
npm run check:gate -- --stage=installed --artifact=/本机路径/limcode.vsix
```

`check:contracts:plan` 只证明工作区计划结构自洽，不要求干净工作区。`check:plan:tracked` 和正式 gate 需要计划/脚本已被 Git 跟踪且工作区干净；foundation/candidate/package 中尚未实现的检查保持 `PENDING`，不得为了绿灯伪造完成。
