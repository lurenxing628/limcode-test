# 不变量与权威

[返回总计划](./README.md)

## 1. 权威分层

```text
配置权威：独立 configuration file roots
运行权威：limcode.sqlite
大内容权威：CAS
外部世界：Workspace / Provider / detached Process wrapper / MCP / Subagent runtime
领域定义：复用 ECS/world 的独立对象与 Link；生产运行投影由 Client Feed 直接读取已提交事实
Webview：有界客户端读模型
```

任何层都不能冒充另一层：

- ECS/world 定义不提供第二套运行 writer；任何进程内投影都不能反向覆盖 SQLite；
- Webview 展示字段不能决定运行终态；
- CAS 内容不能暗中携带领域关系；
- Provider transport 优化不能成为模型上下文权威；
- Settings/Agent/Workflow/Policy 等配置不能迁入 Runtime SQLite；
- wrapper spool/exit receipt 是外部观察证据，必须经 EffectReceipt/reconcile 才成为领域结论。

## 2. 一个数据库文件，独立领域表

所有 Runtime 领域共用一个 `limcode.sqlite`，但共用事务介质不表示领域 ownership。每个对象与 Link 必须具有独立 table、Repository、Codec、mutation mapping、client mapping、index/FK 与 delete/reset policy。

禁止：

- generic family JSON table；
- 业务层 arbitrary SQL batch；
- 把 Tool、Message、Agent、Conversation、Process、Answer 或配置聚合进大记录；
- 用主体表可空字段代替独立 Link；
- 为 AskUser、TaskList 或 MCP 再建平行 authority；
- 在首发禁用状态下仍创建 ProviderContinuation 表。

Runtime domain exact set 只在 [`authority.json#runtimeDomains`](./contracts/authority.json) 定义，并由 plan validator 与 Context/Subagent/Fork 合同交叉核验。

### 2.1 多宿主与对话归属

同一工作区允许多个 Runtime 宿主连接现有 SQLite/CAS；每个宿主有自己的 SQLite worker，写事务仍由 SQLite 串行提交。模型等待、工具执行和打开面板不持有工作区级锁。

三种保护相互独立：

| 保护 | 作用域 | 职责 |
| --- | --- | --- |
| `ConversationRuntimeOwnerManager` | 数据集身份 + Conversation ID | 决定服务对话的宿主，覆盖面板、命令、调度、恢复和后台唤醒 |
| `ExecutionLease` | Conversation / Turn | 保留唯一执行身份与 owner/hostBootId/generation 栅栏，拒绝迟到执行写入 |
| `runtimeHostControl` 维护互斥 | Runtime 数据根 | 串行化宿主注册与创建、升级、归档、重置；维护前拒绝其他存活或身份未知宿主 |

归属记录位于 Runtime 控制目录，包含数据集/根身份、conversationId、hostBootId、ownerToken 和进程启动指纹，不进入 Conversation 配置，不保存第二套 Turn 状态。原子目录发布负责抢占唯一性；释放核对 token；死宿主接管使用旧 token 的确定性隔离目录。只有进程退出或 PID 启动指纹不匹配可证明失效，租约过期、心跳延迟和未知状态均不能抢占活宿主。

同宿主主聊天页按对话共享正在打开的 Promise，重复打开聚焦已有面板。计划和工具详情等附属视图保留同一对话归属。关闭最后一个视图，仅在没有在途命令、执行、队列、回执收尾或待投递工作时释放；仍有后台工作则保留至收尾。外部 EffectReceipt / ProcessReceipt 按既有幂等规则落盘，后续继续执行和通知由目标对话宿主处理。

对话的执行只交给服务它的宿主：主 ProjectContext 文件夹在本窗口打开，且每个活动 Turn 冻结的默认工作环境在本窗口可用。没有项目链接也没有冻结默认环境的对话缺少持久放置事实，任一宿主都合格；资格探针出错视为“未知”，从不当作合格。占用对话分两类。控制类：停止与中断收尾、孤儿 Turn 收尾、删除、重命名、会话配置、记录回答或审批结果、取消工具，任何窗口都能做；不合格窗口做完立即交还归属记录，不因还有活动 Turn 而保留，也不驱动 Provider 或工具。执行类：调用模型、执行工具、驱动 Turn 前进（回答后的续跑、准入新 Turn、派发已批准的文件修改），只有合格宿主能做；已持有归属记录不等于可以执行，执行类认领之后再复核一次资格，不合格立即交还。在不合格窗口回答或审批，只记录结果，Turn 由合格宿主继续，窗口提示“已记录，将在打开该项目的窗口中继续”。在不合格窗口发新消息、重试、编辑后运行或手动压缩，在写入前被拒绝并提示去哪个窗口：排队的 TurnIntent 需要入队时冻结的执行权威，`PendingTurnInput` 只能挂在活动 Turn 上，现有持久事实无法替另一个窗口保存新输入。停止在任何窗口都生效：存活宿主持有时由它执行；否则合格宿主接管后驱动 Turn 记录中断；不合格宿主短暂认领，只把中断记录为终态（取消持久等待、关闭未完成的模型请求，不调用 Provider、不执行工具），然后交还。已有工具在执行中的 Turn 例外，由合格宿主的效果恢复收尾。停止之后即可删除。不合格或资格未知的 Turn 不会被丢弃：确定不合格时每 30 秒低频复查，资格未知时从 1 秒起指数退避（上限 30 秒）；本窗口文件夹变化或工作区同步从失败转为成功时立即重扫，重扫遇到存活宿主持有的对话交回延迟队列。面板在不合格窗口打开时提示原因，资格无法确定时也显示原因。审批与提问提示只在持有其 Turn `ExecutionLease` 的宿主出现。资格判断是宿主本地筛选，归属权威仍是归属记录、`ExecutionLease` 与栅栏。

打开或恢复面板必须在初始化失败时释放尚未交给面板的归属引用；如果 Feed 已连接但页面初始化失败，同时断开该连接。认领等待期间关闭的面板也不能遗留引用。失败面板没有后台工作时，其他宿主可以立即重新认领该对话。

配置根 admission 覆盖 placement 选择到宿主注册，锁顺序固定为配置根 admission → Runtime scope maintenance。旧文件 physical cutover 会过滤共享的 conversation settings / scope links，因此必须在此 admission 内核验所有 Runtime scopes 离线；不能只枚举当前目录后放任新 scope 注册。普通运行、模型等待和工具执行不持有 admission。

生产入口：`backend/reliableKernel/ConversationRuntimeOwnerManager.ts`、`runtimeHostControl.ts`、`runtimeDatabase.ts`；界面入口和引用生命周期由 `vscode/panels/MainPanel.ts` 与 ApplicationFacade 对接。

## 3. 配置与 physical migration crosswalk

配置对象和 ScopeLink 分别建模，不再用一个抽象 `Policy` 聚合：

- Agent、Workflow；
- PlanReviewPolicy / ToolPolicy / SkillPolicy 及各自 ScopeLink；
- SystemPrompt 与 ScopeLink；
- ModelProfile 与 ScopeLink；
- WorkEnvironment / WorkEnvironmentPolicy / ScopeLink；
- RuntimeContext 与 ScopeLink；
- CheckpointPolicy 与 ScopeLink；
- GlobalSettings、LlmProviderConfig、LlmCompressionConfig、McpServerConfig。

每项在 `authority.json#configurationDomains` 中给出 Repository、Codec 和 `migrationEntryIds`；物理路径与 disposition 只在 `migration.json#physicalManifest` 定义。

Scope 过滤固定为：

```text
global / agent / workflow  → preserve
conversation / run         → archive-reset
agentSystem                → archive-reset（当前没有独立 AgentSystem authority）
```

过滤必须原子重写 index 与 records，删除悬空 index 和 orphan records。`common.proxy` 是业务设置，hard cut 时从 VS Code globalState 移入 settings root；globalState 只保留 root authority 与 cutover control metadata。

## 4. Turn 是唯一执行身份

- `TurnIntent` 表达未来工作；
- `PendingTurnInput` 表达当前 Turn 的补充；
- `Turn` 表达已经开始的一次执行生命周期；
- `ExecutionLease` 是 Conversation 当前 Turn 的执行栅栏，不替代对话宿主归属；
- `AuthoritySnapshot` 冻结本 Turn 的模型身份、执行权限与基础配置；
- 新请求的压缩设置通过已有 `ModelRequest.settings_snapshot_object_id` 独立固定。保存配置不改写既有 Turn 或 ModelRequest；下一次尚未建立的请求读取对应模型的当前压缩配置，先行压缩与随后普通请求共用同一份设置；
- `TurnTermination` 只表达终止事实；
- `TurnExecutorLink` 保存历史 Agent executor 归属；
- `CommandReceipt(source_kind, source_key)` 对 command/callback/internal/recovery 去重。

一个 Conversation 最多一个 ExecutionLease。终止 Turn 时在同一事务释放 Lease。迟到 callback 只能收口原来源，不能重新打开 Turn 或创建未经意图的新执行。

Run/AgentRun 不再是 Runtime authority。Conversation origin/fork 若需要历史执行来源，使用 `source_turn_id`，不得保留 `source_run_id`。

Turn 重启判定矩阵只在 `identity.json#recoveryJudgment` 定义。

## 5. Message、Attachment 与 Conversation 关系

Message 只保存消息身份；正文与模型可见语义进入 immutable `MessageRevision`。

独立关系至少包括：

- Message 属于哪个 Conversation；
- Message 由哪个 Turn 产生；
- Message 当前 revision；
- MessageRevision 引用哪些 Attachment；
- Agent 与 Conversation 当前角色关系；
- Conversation fork/reuse/origin；
- ChildExecution 的父边、Turn/Intent membership 与 active Turn；
- Runtime item 到目标 Conversation/Turn 的 Delivery；
- Delivery 注入的具体 PendingTurnInput。

消息序号在 Conversation 内单调，含 soft-deleted 消息终身不复用。Attachment 正文进入 CAS，设置中的附件大小配置保留，旧 Runtime Attachment 不导入。

PlanProposal 由 `submit_plan` ToolCall/ToolOutcome 派生；TaskList 由 `update_task_list` Tool facts 派生，二者都不建专用 authority table。

## 6. Conversation fork

首发保留 fork 行为与关系展示：

- `ConversationReuseLink`：稳定 reuse key 到 Conversation/Agent；
- `ConversationBranchLink`：source Conversation/MessageRevision 到 target Conversation 的直接 branch 边；
- `ConversationOriginLink`：Conversation 创建来源，可软引用 Agent、Conversation、MessageRevision、ToolCall、Turn；
- `ConversationContextHeadLink`：目标 Conversation 当前选择的 ContextSequenceRoot。

fork 从选定历史 root/node 创建目标 root/head，允许共享 immutable DAG prefix。三个 Link 独立存储、独立 patch，不嵌入 Conversation。

## 7. CAS 发布

CAS identity 为：

```text
contentType + sha256 + byteLength
```

固定顺序：

1. 生成 canonical bytes；
2. 写 temporary content；
3. 核对 digest/length；
4. 原子 publish by digest；
5. SQLite transaction 写 ContentObject 与领域引用。

SQLite committed reference 不得指向缺失 CAS。无人引用内容首发允许保留到 Runtime dataset reset，不建设在线 refcount/GC。

## 8. EffectIntent、EffectReceipt 与唯一 Tool result

外部作用必须满足：

1. 来源 Operation/Attempt 与 EffectIntent 同事务建立；
2. commit 后才 dispatch；
3. EffectReceipt 独立于原 Turn 是否仍活动；
4. receipt 只陈述能证明的外部结果；
5. reconcile 再产生 FileMutationReceipt、ProcessReceipt、ToolOutcome、AnswerSubmission 或 RuntimeInboxItem；
6. 每个终态 ToolCall 只有一个 ToolModelResult。

拒绝或过期且尚未 dispatch 的审批可直接生成 ToolOutcome/ToolModelResult，不伪造 EffectIntent。文件、命令、MCP 和 subagent spawn 在 Extension Host 重启后不自动重复 dispatch。

Effect kind 首发包括 `mcp_tool_call`。MCP connection rebuild 不是 call recovery；无法查询同一 call 结果时写 `outcome_unknown`。

## 9. Recovery scans

六个 scan 的 target/action/owner 只在 `tool.json#recoveryScan` 定义：

| ID | Owner | 边界 |
|---|---|---|
| `recovery.effect-intent-hanging` | D | dispatched、无 receipt 的 EffectIntent |
| `recovery.file-change-unresolved` | D | 未决 FileChangeSet 收口 |
| `recovery.answer-inbox-invariant` | F | AnswerSubmission 已提交但缺 InboxItem |
| `recovery.delivery-pending` | F | pending RuntimeDelivery 重评估 |
| `recovery.foreground-answer-wait-expired` | F | 前台 answer wait 到期转后台 |
| `recovery.interrupted-subtree-incomplete` | F | interrupt_subtree 后仍有 active Turn/pending Intent |

D 建 scanner framework，但不得实现 F 的领域规则。candidate gate 为每个 ID 提供独立 check，不能再用“恢复三类”复合 prose。

扫描可以读取共享库，但会话状态修改、外部 dispatch、Turn admission 与 wake 必须先取得会话归属；其他存活宿主的工作只读跳过。当前宿主新认领一个崩溃对话时按该 conversationId 恢复，不要求重启窗口。

## 10. 文件事实

- FileChangeSet 是 proposal，不是模型最终结果；
- 用户批准前不得修改 Workspace；
- apply 前重新核对路径、类型、base digest；
- actual digest 与 member outcome 逐项记录；
- partial execution 只记录真实完成项；
- 不自动 rollback 或 retry 外部文件变更；
- approval 使用 InteractionRequest/Response；
- terminal 后通过 ToolOutcome 生成唯一 ToolModelResult。

Installed smoke 必须包含 proposal → approve → actual Workspace mutation → digest/receipt 的完整链路。

## 11. Process authority 与输出上限

一次后台进程由 Process/ProcessOriginLink/ProcessOutputChunk/ProcessReceipt 独立表达。宿主通过 packaged detached wrapper 启动和观察真实命令：

```text
stable nonce
+ wrapper/child pid
+ process group
+ start fingerprint
+ command digest
+ durable append-only spool path
+ atomic exit receipt
```

Extension Host 不把 Node child pipe 或裸 PID 当作可跨重启 authority。重启后：

- wrapper/fingerprint 可证明存活 → running；
- valid exit receipt → 真实 exit code/signal；
- 无法证明 → `outcome_unknown`；
- stop 只有在 nonce/fingerprint/process group 全匹配后才能发送。

ProcessOutputChunk 只保存 metadata，正文进入 CAS。精确数值以 `tool.json#processOutput` 为准；达到 per-process retained bytes/chunks 任一上限后仍持续 drain，但不再写正文或 metadata，只更新 dropped/truncated counters。CAS 不替代 quota。

## 12. RuntimeInbox 与 RuntimeDelivery

RuntimeInboxItem 只保存来源事实和来源引用，不保存目标 Conversation/Turn。目标、phase、attempt 与消费状态都属于 RuntimeDelivery。

Delivery phases：

```text
current_turn
next_turn
notify_only
```

状态仅有 `pending/consumed/failed`，不建 dead-letter queue。`target_turn_id` 为 NULL 与非 NULL 时分别使用两组 SQLite partial UNIQUE index，避免 NULL 语义产生重复行。

人工 redeliver：

- 创建 `attempt_seq + 1` 新 RuntimeDelivery；
- 写 `retry_of_delivery_id`；
- 旧 failed row 不复活；
- 旧 attempt 只允许 pending→consumed 或 pending→failed。

注入时创建 `RuntimeDeliveryInputLink(delivery_id UNIQUE, pending_turn_input_id UNIQUE)`；执行器真正吸收对应 input 时写 `handled_at`。`parent_handling_state` 只由该 Link 推导，不读取目标 Turn 下任意无关 PendingTurnInput。

## 13. ContextSequence 与 compression

- ContentObject 只按摘要去重正文；ContextSegment 表达 source occurrence；
- ContextSegmentSource 使用 `(source_kind, source_id, source_revision) UNIQUE`；
- ContextSequenceNode 组成可分支 parent DAG，`(parent_node_id, segment_id) UNIQUE` 只做同一次 append 幂等；
- `parent_node_id` 本身不 UNIQUE；`root_node_id` 本身不 UNIQUE；
- ConversationContextHeadLink 显式选择 current root；
- root/node 首发保留到 dataset reset，不做在线 GC；
- historical replay 使用原 root、AuthoritySnapshot 与 immutable recipe，不读 Message 当前 soft-delete；
- compression root 用 `tail_node_id + tail_segment_count` 精确截断；
- ToolCall/ToolModelResult pair 不可拆开。

CompressionBlock 正文、来源和摘要 immutable。enable/disable/soft delete 只更新 status；regenerate 或用户修改 title/summary 都创建 new replacement block/root，禁止原地 CompressionUpdate。

## 14. Provider 首发模式

ProviderContinuation 首发为 `disabled-full-request`：

- Runtime domain exact set 中没有 ProviderContinuation；
- 每次请求都由 ContextSequenceRoot + frozen recipe 完整物化；Message role 来自 source 指向的 immutable MessageRevision，正文必须可精确解码为 UTF-8；
- 不读写 suffix；
- retry/compression/reconnect 均走完整请求；
- ModelStreamCheckpoint 与 ModelStreamFence 仍负责 stream identity、迟到隔离与 terminal fence；相同 stream identity 的 kind/content 不同必须冲突；
- request-level cancel-current 在 writer 中终止当时最新 attempt/socket；adapter 迟到结果按 durable first-wins 分类，不能覆盖 Completed 或新 generation。

未来 enabled contract 可规定同物理 connection、strict prefix、Completed fence 与 socketGeneration，但首发实现和 gate 不得假装已启用。

## 15. ChildExecution 与 interrupt_subtree

- ChildExecution 是稳定 lineage；
- ParentLink 是稳定树边；
- TurnLink 保存首次/续接 Turn membership；
- IntentLink 保存尚未 admit 的续接意图；
- ActiveTurnLink 只表达当前 active Turn；
- AnswerBridge 归属 ChildExecution，续接 Turn 复用同一 bridge；
- queue 与 interrupt 是不同输入语义；
- wait/list 为单次短 SQLite snapshot read，不改变 delivery；
- interrupt_subtree 首发必选，沿 ParentLink 递归，并在同一事务覆盖 active Turn 与 pending Intent；
- 显式 interrupt_subtree 的 partial interrupted answer 可保存但不得重开或自动续接父 Turn；非 cascade 父 Turn 中断后仍正常运行的 ChildExecution 提交答案时，可创建新的父侧 continuation Turn，但绝不复活旧 Turn。

UI 直接显示 childExecution、activeChildTurn、answerSubmission、runtimeDelivery、parentHandling 与 termination facts，不通过旧 activityStage、notificationRun 或 display text 猜测。

## 16. bounded Client feed

- snapshot 与 changes 都带 sessionId/hostBootId；
- commitSeq 在同一 host boot 内单调，宿主重启后不延续；
- snapshot 带 snapshotCommitSeq；snapshot read 与 listener registration 形成 atomic barrier；
- 一个 commit 对应一个 atomic batch；
- snapshot、batch、queue batches、queue bytes、page 与 detail response 各有 hard limit；
- 单 commit/queue 超限时丢弃未发送普通 changes，并合并为一个 snapshot-required；
- gap、hostBootId 变化、unknown type 或 apply failure 时整份重取 snapshot；
- 不持久化 ClientChangeLog；
- bridge payload 只允许 structured-clone plain data。

## 17. RootBinding 与 cutover

SQLite long-lived connection 只能缓存由 RootAuthority 建立的 immutable fenced RootBinding；每个 request/transaction 开始时重验 generation。root switch 只在 restart 后、数据库打开前完成。

最终 VSIX 的 cutover-only coordinator 是 archive actor。它按 physical manifest journaled archive Runtime、filter settings/scope links、验证配置与外部 untouched 项，再创建 SQLite/CAS/epoch 并原子切 pointer。激活前失败按 journal 恢复；激活后不自动回退旧 writer。

已发布 SQLite epoch 3/4 只允许按精确来源离线升级到当前 epoch 5。epoch 3 的完整 manifest 分为 v0.0.10–v0.0.12 的 `ModelContextProjection.client=detail` 与 v0.0.13–v0.0.14 的 `summary`；二者物理 DDL 和其余 86 个领域完全相同。v0.0.15–v0.0.21 的正常新建 epoch 4 为完整 91 领域；额外接受的缺 RuntimeDeliveryIntentLink 前驱仍须通过单一精确指纹与 continuation 语义校验，不能由任意缺表推导。升级先核验 table/index/trigger、manifest 与 RootBinding，设置 pending fence/持久 journal，建立并验证 SQLite Backup API 备份，再以单事务补齐当前领域并更新绑定；中断按 journal 向前收敛，旧版 3→4 的已知边界先单独认证恢复。Windows 仅在 SQLite 原生 I/O 使用 namespaced path，持久 RootBinding 保留 canonical path。

备份升级自动触发：当前选中根在 Runtime 打开前完成；当前 Runtime 就绪后串行处理其余旧根；查看旧历史时补做。仅目标根必须无存活或身份未知的 Host，其他已运行数据集继续使用。各库操作分别持有 configuration admission → target maintenance，并在库间释放；结束 activation 后不再开始下一份迁移。旧库发现的局部错误须与可用候选分别返回；已有固定选择损坏时仍拒绝，已有选择从不被改选。没有选择文件时（从按工作区分库的版本升级）不再询问：固定默认根有数据则选它，否则选 SQLite 最近修改的旧工作区库；只有固定根或 scope 容器本身不可读时仍要求显式选择；只有异常来源时报错，不创建空库。

旧版本按工作区拆出的历史 scope 在当前选中数据集打开、本 Host 注册之前自动合并进当前数据集（`runtimeDataSetMerge.ts`），其它数据集只在用户明确请求后于下次启动合并。整批持有 configuration admission 与目标 maintenance；目标仍有其它 Host 时走通用独占维护（见下段）；协调被放弃时整批推迟。来源被旧窗口占用时单独推迟。来源先走上述精确升级，再从离线快照核验当前 epoch 指纹与完整性；含 active/queued Turn、lease、未完成工具/effect/模型请求、待投递或运行中进程时整份拒绝。目标先经 SQLite Backup API 备份（每次启动一份），来源 CAS 以硬链接或校验摘要的复制先行发布，随后单事务合并全部领域：同 id 同内容复用，ContentObject/ProjectContext/Attachment 仅允许 `migration.json#historicalMerge.identityDomains` 列出的列不同并保留目标行，其余差异或唯一约束冲突整份回滚；提交前核对外键、quick_check 与逐领域行数。来源保持不变，不切换选择，不注册来源 Host，不恢复来源任务。逐来源记录位于目标控制根 `merged-sources/`：提交前写 committing，提交后写 merged；受阻来源按其文件指纹记录，未变化时不重复尝试。同一配置根内每份来源只自动合并一次：切换当前库或归档重置后，已合并过的来源和接收过合并的库都不再自动合并，只能在“历史与存储管理”中明确请求。启动提示每个配置根按原因只显示一次（VS Code globalState），原因消失后再次出现才重新提示。

多窗口独占维护（`runtimeExclusiveMaintenance.ts`，`migration.json#exclusiveMaintenance`）只用于用户发起的数据目录迁移、超大来源的兜底合并与离线 GC，不用于 epoch 升级。请求方持有目标 maintenance（给定时还有 configuration admission）后发布请求，按三阶段推进：prepare 时每个已登记窗口只回答就绪、忙或拒绝；全部就绪才进入 confirm，各窗口显示 5 秒可取消倒计时（用户已确认的操作只提示）后回答确认；全部确认才进入 go 统一重载。go 之前任何窗口都不让出，因此有忙（本 Host 持有 ExecutionLease、有命令在执行，或所拥有对话的待办工作探测为真；窗口聚焦也算忙）、拒绝、未登记的存活窗口（刚启动的窗口有 15 秒登记宽限）或状态未知的窗口、超时或取消时立即放弃，结果区分 busy、declined、legacy-host、timed-out、cancelled、backoff 并附原因。只有用户发起的操作可选 wait：忙窗口会提前收到一次提示，等它空闲后重新进入 prepare，等待有上限；确认后又开始工作的窗口不会被打断，而是开始新一轮。每次放弃按操作键指数退避（5 分钟起，最长 6 小时），进入 go 时按操作记 10 分钟冷却，刚让出的窗口不能马上反过来为同一操作要求别人让出；用户明确发起时忽略退避。请求方自己的窗口按 `requesterHostBootId`（否则按进程）跳过请求，需要离线时在操作内关闭自己的 Runtime。重载后的窗口在 admission 上等待维护结束，拿到 admission 后重读数据根，根已迁移就放开旧根改在新根上打开；未发送的输入、附件与打开的编辑保存在 Webview 状态中，重载后恢复。轮询中每个 (pid, 启动身份) 只做一次平台身份探测，之后只用 `kill(pid, 0)` 复查；执行前的最终判定仍不使用缓存，独占只以 Host liveness 证明，请求文件只是提示。清理失败只记日志，不覆盖结果。

历史升级入口只复用精确 epoch migrator，不调用含归档重置/空库初始化的通用 cutover coordinator，不改当前 selection，不注册历史 Host 或启动旧任务。既有对话、消息、附件及原 CAS 内容保留；需要转换的旧 Child Runtime continuation 仅在稳定 ID、回执、投递和旧 CAS 全部吻合时发布新内容并补 Link。备份路径和逐库失败原因可追踪。未知 schema、缺失备份或绑定冲突均拒绝；目录移动与跨平台备份恢复需要独立的来源认证与重新绑定流程，不能放宽原位升级检查。

## 18. 失败原则

- SQLite 不可用：关闭 Runtime capability 并显示真实错误；
- CAS 缺失：报告 integrity error，不返回空正文；
- Effect 已 dispatch 但无法确认：`outcome_unknown`；
- wrapper 不可达且无 valid receipt：`outcome_unknown`；
- Provider 临时错误：仅按有限、可见、可取消策略 retry；
- Client patch 不适用：snapshot-required/重取 snapshot；
- Delivery target 已删除：InboxItem 保留，Delivery failed(reason=target-gone)；
- 不吞错、不伪造成功/失败、不改走旧文件 writer。
