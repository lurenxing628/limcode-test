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

对话的执行只交给服务它的宿主。执行工作是每个活动 Turn 和每条排队的 TurnIntent，二者在创建时就冻结了权限（含默认工作环境），每一项都必须能放在本窗口：冻结的是项目自身以外的工作环境（例如用户在项目文件夹移动后为对话另选的环境）时，只要求该环境在本窗口可用，不要求项目打开；冻结的是项目自身的环境或没有冻结环境时，仍要求主 ProjectContext 文件夹在本窗口打开（冻结了环境的还要求它可用）。这一放宽经维护者确认：在项目窗口里显式选了别的文件夹开始的 Turn，也可以由没有该项目、但有这个文件夹的窗口接管。空闲对话（没有活动 Turn、没有排队输入）若有待处理的运行时投递（后台进程完成、子 Agent 答复、协作消息，投递的唤醒尚未写入或尚未处理完），由能执行其中某条投递所开续跑的宿主服务：继承源 Turn 权限的续跑按源 Turn 冻结的环境放置（与上面活动 Turn 的规则相同），协作消息的续跑按当前设置编译，与新输入用同一个入口判定（下一个 Turn 的预览有错误就不合格，没有预览时看项目文件夹是否打开）；因此项目窗口也可能不服务它（源 Turn 冻结了只有别的窗口才有的目录）。其余空闲对话由项目文件夹在本窗口打开的宿主服务；文件夹不在本窗口时，由下一个 Turn 能在本窗口开始（预览为对话解析出的工作环境在本窗口可用、预览没有错误）的宿主服务。没有项目链接也没有冻结默认环境的对话缺少持久放置事实，任一宿主都合格；资格探针出错视为“未知”，从不当作合格。占用对话分两类。控制类：停止与中断收尾、孤儿 Turn 收尾、删除、重命名、会话配置、记录回答或审批结果、取消工具，任何窗口都能做；不合格窗口做完立即交还归属记录（重叠的控制命令以认领本身记账，最后结束的命令交还），不因还有活动 Turn 而保留，也不驱动 Provider 或工具。执行类：调用模型、执行工具、驱动 Turn 前进（回答后的续跑、准入新 Turn、派发已批准的文件修改、为已批准的计划派生并驱动子 Agent），只有合格宿主能做；已持有归属记录不等于可以执行，执行类认领之后再复核一次资格，Agent 循环还在每一轮开始前复核，不合格就停下并交还租约，由合格宿主接着执行；轮次边界上同步工具都已结束，但已准入的异步 native 调用可能仍在本窗口执行，所以交还前先等本窗口这个 Turn 的在途 native 调用写完回执。在不合格窗口回答或审批，只记录结果，Turn 由合格宿主继续，窗口提示“已记录，将在打开该项目的窗口中继续”；“在新对话中执行”的计划审批也只记录回答，子 Agent 由合格宿主续跑父 Turn 时派生。已打开的合格宿主在别的窗口提交后，限频地接管没有存活宿主持有的活动 Turn，接管走与打开面板相同的按对话恢复（先 Phase D 核对退出窗口留下的已派发效果，再子调度，再对话 Runner）；扫描只对租约已过期的 Turn 做进程启动身份比对，比对结果按 (hostBootId, pid) 缓存（相符的结果 60 秒后重新比对，不符或进程已不在的一直按已死）；租约未过期时只做廉价检查（持有者的存活记录是否还在、该 PID 的进程是否还在，信号 0 探测），已关闭或已退出的窗口因此立即被认出，PID 被别的进程占用的情况等租约到期后比对，扫描在到期时自动再看一次。新消息、重试、编辑后运行、手动压缩与运行时投递的续跑，都按新 Turn 将冻结的工作环境判断，入口、准入、投递唤醒用同一判定：对话已有活动 Turn 或排队输入时，这些工作也必须能放在本窗口；新输入看下一个 Turn 将冻结的工作环境（含用户在本窗口显式选择的，以及单条消息指定的 Agent 的设置）；后台进程完成、子 Agent 答复等运行时投递的续跑继承源 Turn 的冻结权限，看源 Turn 冻结的环境；协作消息按当前设置编译，与新输入相同。不合格时在写入前被拒绝并提示原因，以及可在本窗口选择工作环境后继续；投递不合格时保持待处理，留给能执行它的窗口，唤醒处理因本窗口不能执行续跑而未确认时，本窗口立即交还对话归属（这是“不服务这项工作”的交还，不因本窗口对对话其它工作合格、对话仍有待处理投递而保留），资格未知时不交还。归属的保留同样以能执行为准：待处理工作让本窗口保留归属，前提是本窗口对这些工作合格，且对话的执行租约不在另一个存活（或无法证明已死）的宿主手里——租约在别的存活宿主手里时，工作由那个宿主执行，本窗口的归属只会挡住它，因此在控制命令或恢复扫描结束后立即交还。手动压缩的维护 Turn 继承源 Turn 的模型、提示词与压缩设置，但工作环境换成入口批准的“下一个 Turn 的环境”；入口按源 Turn 的执行 Agent（没有源 Turn 时按对话默认 Agent）预览，与维护 Turn 实际冻结时用的 Agent 相同，所以项目移动后在本窗口选好环境即可压缩；维护 Turn 准入后若本窗口不能驱动它（资格在两者之间变化），压缩命令返回错误，维护 Turn 以失败收尾，不留下活动 Turn（子对话的手动压缩同样如此）。ConversationProjectLink 不因此改挂。停止在任何窗口都生效：存活宿主持有时由它执行；否则合格宿主接管后驱动 Turn 记录中断；不合格宿主短暂认领，只把中断记录为终态（取消持久等待、取消尚未派发的效果、关闭未完成的模型请求，不调用 Provider、不执行工具），然后交还；认领之后若收尾没有完成（包括出错，以及认领已提交但回读出错），在同一次持有内用栅栏把 `ExecutionLease` 交还（下一代租约由无人注册的“已交还”身份持有并立即过期，任何宿主可按现有接管规则取得），不把租约留在存活但不合格的窗口。子 Agent 的 Turn 同样适用：子调度在不合格窗口做对称的控制类收尾，父对话停止时级联到子树。已派发但没有回执的效果，自动路径不碰。本窗口服务该对话时，用户停止先对这些效果走启动恢复同样的路径（Phase D：文件修改核对工作区，其余按各自的恢复规则）；核对不了、或本窗口不服务该对话时，才按下面的规则收尾：只有用户显式停止（面板、侧栏、取消工具，含子 Agent），并且派发这些工作的宿主和持有租约的宿主都已被进程身份核验证明死亡（进程不在或 PID 被复用；存活或身份不明一律不算）时，任何窗口才把这些效果按 `outcome_unknown` 收尾，原因写“执行窗口意外退出，执行结果未知；由用户停止收尾。”，不重放、不重试、不再检查外部世界，然后把 Turn 记为中断；执行宿主仍存活时只记录停止请求，并提示去该窗口查看。子 Agent 派生（subagent_spawn）不记录派发栅栏，派发它的宿主由派生事务交给它的子 Turn 租约（以及别的宿主持有的父 Turn 租约）确定：派发宿主存活或身份不明时，它正在写派生回执并会驱动子 Agent，停止不碰派生，只记录停止请求，并提示正在启动的子 Agent 仍在另一个窗口中执行、启动完成后也可以在那里停止它；派发宿主已被进程身份证明死亡时，派生事务已经建好子执行，用户停止先在子对话的短暂控制类认领下用子调度自己的恢复转换（`recoverSpawnIntent`）把它记为已派生，本窗口不驱动子 Agent，子 Agent 需要继续时立即交还子对话归属，由服务它的窗口的子调度接管；父 Turn 再按普通停止收尾，级联时停止子 Agent。子调度的自动恢复按既有幂等规则记录派生时，同样不因子对话有待处理工作而占住租约在存活宿主手里的子对话；派发宿主写完回执后认领新子对话失败时，由它自己的恢复轮询重试。子 Agent 取消（subagent_cancel）仍在进行时不在此列，由子任务调度收尾。在不合格窗口批准“在新对话中执行”的计划后又在不合格窗口停止，停止要等合格窗口出现才生效：审批已先生效、委派意图是持久的，在这里结算会让工具结果声称子 Agent 已派出而它并不存在；项目再也打不开时，删除这个对话会一直等这个停止，到上限后如实报告没能完成。删除对话先停止、再收尾、再删除（`conversationDeleteCommand.ts`），不因还有任务在跑而拒绝：删除范围是该对话加它的整棵子 Agent 树。每一轮先取消范围内排队的 TurnIntent：普通消息，以及续写、运行时续跑、重试（这些排在维护 Turn 或已有终止记录、最终输出栅栏的 Turn 后面时会排队），取消都走修订号 CAS（`TurnControlPlane.cancelGuidanceForDeletion`），不需要对话归属，准入只取仍在排队的意图，所以正在执行的窗口也不会再准入它；子 Agent 的续跑随谱系中断取消；全部取消落地之前不停任何 Turn，删除命令运行期间本窗口的 Runner 也不准入范围内的排队意图（稍后再看，删除没完成就照常准入）。然后写各活动 Turn（含等待回答或审批的）的持久停止请求，再中断有工作的子 Agent（外层优先、带子树，每次重发用新的来源键，续派开出的新 Turn 也被停下；被删的是父 Turn 已完成的后台子 Agent 时，它的活动 Turn 按它自己面板的停止停下（`interruptFromConversation`），没有终止请求就不发布中断答复，已完成的父对话因此不开续跑，它自己的子 Agent 作为最外层照常带子树中断；只剩排队续跑时再按子树中断取消，这时没有活动 Turn，同样不发布答复），最后执行各 Turn 的停止：父 Turn 的停止请求先于子树中断持久化，子树又在任何父 Turn 真正结束前中断，子 Agent 在这之间正常完成也只会被仍在运行、正在停止的父 Turn 接收，不会给已停的父对话开续跑。运行中的后台进程直接写停止请求文件（`stopOwnedProcess`，有 nonce、启动指纹与 PID 复用防护），不需要对话归属。这些都走上面的用户停止路径，原因写“用户删除对话”（被删的是子对话本身时，父对话的等待结果写“用户删除子任务对话”），存活的 owner 自己执行 Turn 的停止，owner 已死时按死宿主与 `outcome_unknown` 收尾。删除命令运行期间，本窗口的运行时投递调度不在删除范围内开续跑 Turn（`ConversationDeletionControlPlane.markStopping`，内存标记，命令结束即释放；唤醒保持待处理，删除事务把它置 dead_letter，删除没完成时照常投递），被停掉的后台进程或子 Agent 的结束通知因此不会调用模型；只有持有对话的窗口处理它的唤醒，所以持有对话的另一个存活窗口仍可能为此开一次续跑，删除随即停下它。只删子对话、父对话不在范围内时，范围外正在运行的父 Turn 还没接收的答复一律换成删除通知，删除不等父 Turn：答复还是作为 current_turn 投给它的 pending 投递时，删除事务把这条答复换成运行时输入交给父 Turn（投递置 consumed）；父 Turn 已接收（投递 consumed，`RuntimeDeliveryInputLink` 未 handled）但还没吸收进上下文时，删除事务把那条待吸收输入的内容换成通知（断言输入与链接仍是读到的样子）；注入的内容是删除通知“子任务对话已被用户删除，它的答复不会再送达。”与子任务对话的标题，从不包含已删子任务的答复；父 Turn 已过最终输出栅栏时不再注入，答复置 failed(source-gone)。父 Turn 吸收输入时内容正好被删除换掉，就按输入现在的内容再投影一次；答复记录已随子对话删除而输入没被换掉时跳过这条输入（标记已处理、不进上下文），父 Turn 不会因读不到答复卡住。最多等 60 秒，进度通知按原因显示（正在停止、在等另一个窗口（写明进程号）释放对话）；超时说明按最后一轮停止之后重新盘点的结果写，只在最后一次删除尝试被另一个窗口占用时才说占用；对话在这期间被别的窗口删掉按已删除处理；停不下来（例如另一个窗口的工具迟迟不返回，或宿主存活无法判定）就不删，照实说明哪个任务在哪个窗口没停下，逐项写明“已发出停止请求”或“还没能发出停止请求”，只是被另一个窗口占着时写明被哪个进程占用、释放后再删一次。停好后删除事务收尾投递：投给范围内对话的 pending 投递置 failed(target-gone)，唤醒与进程完成派发置 dead_letter；只删子对话、父对话不在范围内时，父对话对它的前台或续跑等待以“用户删除子任务对话”取消（父 Turn 在跑就拿这个结果继续），父对话空闲时它投给父对话、还没接收的答复置 failed(source-gone)，为这条答复排队的父对话运行时续跑同一事务取消，从未路由的答复 Inbox 置 settled，父对话以后不会再收到它，也不会因此再运行。删除等待期间的盘点只读删除范围（逐层读子 Agent 来源关系），不整表读取。子调度的答复扫描遇到随对话删除的子执行就跳过它、继续其它子执行，不让共享这次扫描的恢复失败；Runner 的延迟恢复候选对应的 Turn 已随对话删除时丢弃该候选。删除事务本身仍拒绝活动工作与未取消的父等待（`ConversationDeletionBlockedError`），只作最后防护；不新增 schema、状态或持久关系。本窗口里等待回答或审批的 Turn，其项目文件夹离开本窗口（重扫、外部唤醒或延迟候选复查判定不合格）时，连同归属记录一起交还 `ExecutionLease`，合格窗口在本窗口仍打开时即可接着执行：按本窗口持有的租约行（owner、host、generation）交还，不看是否已过期（等待中的 Turn 不续租，等待超过租约时长时租约仍属于本窗口这个存活宿主，别的宿主不能接管）；交还前先等本窗口这个 Turn 的在途 native 调用写完回执，等待在后台进行、不阻塞重扫，等完后在认领内复核（文件夹已回来、或本窗口已在驱动它，就不交还）；本窗口并不持有租约时不为交还认领对话；交还时对话正被别的窗口占着（busy）就保留“待交还”标记，每次唤醒轮询在本窗口仍持有租约且确定不合格时重试。子调度对称：子对话的文件夹离开本窗口时，子调度的恢复扫描同样交还等待中子 Turn 的租约（在途 native 调用在后台等完，busy 由恢复轮询重试）；服务子对话的窗口里用户停止子 Agent，也先对子对话跑 Phase D，剩下核对不了的才由停止收尾。排队输入的准入被挡下时，另一存活宿主持有（busy）或资格未知就按退避（1 秒起，上限 30 秒）自动重试，确定不合格则清掉退避、等文件夹变化的重扫。不合格或资格未知的 Turn 不会被丢弃：确定不合格时每 30 秒低频复查，资格未知时从 1 秒起指数退避（上限 30 秒）；本窗口文件夹变化或工作区同步从失败转为成功时立即重扫，重扫遇到存活宿主持有的对话交回延迟队列。面板在不合格窗口打开时提示原因（工作环境显示名称与路径，不显示内部 ID），资格无法确定时也显示原因。审批与提问提示只在持有其 Turn `ExecutionLease` 的宿主出现。资格判断是宿主本地筛选，归属权威仍是归属记录、`ExecutionLease` 与栅栏。

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

扫描可以读取共享库，但会话状态修改、外部 dispatch、Turn admission 与 wake 必须先取得会话归属；其他存活宿主的工作只读跳过。`recovery.effect-intent-hanging` 以派发栅栏记录的宿主为准：派发它的宿主（hostBootId）仍被进程身份判定为存活（或无法证明已死）时，不论 Turn 的租约此刻在谁手里（已交还、或等待超过了租约时长），都不写 `outcome_unknown`，由派发宿主写入真实结果；派发宿主已死或没有派发记录时，才按各效果自己的恢复规则收尾。当前宿主新认领一个崩溃对话时按该 conversationId 恢复，不要求重启窗口。

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

已发布 SQLite epoch 3/4/5 只允许按精确来源离线升级到当前 epoch 6。epoch 5（v0.0.24–v0.0.36）的 107 领域、metadata DDL 与 triggers 固定在独立历史描述中，并核对完整摘要；它已经公开发布，不在原 epoch 内补表或改 manifest。开发期 main 上出现过的 epoch 6–10 从未发布，已合并为这一次 5→6 升级，不保留它们的描述、journal 或升级路径。epoch 3 的完整 manifest 分为 v0.0.10–v0.0.12 的 `ModelContextProjection.client=detail` 与 v0.0.13–v0.0.14 的 `summary`；二者物理 DDL 和其余 86 个领域完全相同。v0.0.15–v0.0.21 的正常新建 epoch 4 为完整 91 领域；额外接受的缺 RuntimeDeliveryIntentLink 前驱仍须通过单一精确指纹与 continuation 语义校验，不能由任意缺表推导。升级先核验 table/index/trigger、manifest 与 RootBinding，设置 pending fence/持久 journal，建立并验证 SQLite Backup API 备份，再以单事务补齐当前领域并更新绑定；中断按 journal 向前收敛，旧版 3→4 与 3/4→5 的已知边界先单独认证恢复；旧升级已提交时先完成原来目标的指针与完成记录，再启动独立的 epoch-to-6 journal。Windows 仅在 SQLite 原生 I/O 使用 namespaced path，持久 RootBinding 保留 canonical path。

epoch 6 在 epoch 5 之上新增 RuntimeDeliveryTimelineLink、CollaborationSendTimelineLink、TimelineImportProvenance、RuntimeDeliveryAnswerPresentation 四张 insert-only 时间线关系表，以及 ConversationContextHandleState 与 ContextRootHandleCatalog 两个独立领域，共 113 个领域；RuntimeDelivery 只在原索引后追加两个范围读取索引。升级在同一事务里只按可证明的输入回填时间线关系，并仅为确切当前 head 插入 pending 句柄标记，不重建历史目录。紧凑普通 catalog-reference recipe、冻结工具定义 toolsReference 配方和新写入的至多 8192 字节 packed small-CAS 改变读入语义，一并由 epoch 6 的整库栅栏控制准入：它们只用于新写入，升级保留所有既有领域行、内联配方与 loose CAS 字节，不在启动时打包旧正文；旧 epoch 5 reader 在打开时拒绝 epoch 6，存活或身份未知的旧 Host 阻止升级。旧内联工具配方仍按原冻结字节读取，新配方的工具 CAS 引用在复制与合库时随全部登记正文保留。CAS 小正文存储只在准入 6 后按需建立，缺失是正常的旧库状态，已有未知或损坏的存储不可静默替换。

新建普通与原生压缩请求配方以 toolsReference.contentObjectId 冻结工具定义，指向 application/vnd.limcode.frozen-tool-definitions+json 类型的不可变 CAS。旧内联 tools 配方保留原字节与原读取路径，引用缺失、类型或摘要不符时拒绝，绝不退回当前工具设置。该引用是独立于生产者 Turn/Conversation 的强 CAS 边：分支沿用原配方，删除源对话不删正文，整库复制与合库继续携带全部已登记 ContentObject；未来可达性 GC 必须沿 toolsReference.contentObjectId 保留正文。

已发布 epoch 3/4/5 的备份升级自动触发：当前根在 Runtime 打开前处理，其余旧根后台串行或查看时处理。每个目标必须独立满足离线、身份、结构与物理指纹边界；失败不影响正常当前库。首次选择、残留归档与已有选择的失效处理遵守下述单库合同，不恢复选库界面。

单一历史库：一个配置根只有一个固定当前库，工作区只作为执行上下文。不提供选库、切换、保留分库或删除其它库入口。没有选择文件时优先使用健康的固定根，否则选可安全升级的最近旧根；所有可检查候选都不合格时，先在离线边界内原样归档不可用固定根，再建立默认根，并把旧来源登记为 pending 或 residual。不可读路径、符号链接、活跃或身份不明 Host 不可绕过；已有选择损坏或已初始化根丢失仍拒绝打开，不隐式改选。旧安装的选择修订号和保留标记只读容忍，保留标记不阻止收敛。

收敛只使用无期限 pending 和 residual 登记，不再读写 requests、prompts、过期时间或保留策略。后台逐来源合并，超出在线上限的等待“立即合并全部”，不后台发起独占协调。明确合并直接调用准备与流式后端，复用独占协调、冻结新工作、保存输入、关闭 Runtime、取消与重载，不保留会话适配、估时、速率或结果缓存。来源和目标相同且内容未变的成功结果可跳过，明确操作仍报告“没有新内容”。

合并后端的安全边界保持：当前库只经自身 Runtime writer/reader；其它库的快照在各自维护声明内生成，外来库在外来声明内经 located 路径读取，声明在配置准入之外取得。选源锁内只读账本、登记和确切文件状态缓存；缓存未命中需要内容时在锁外准备私有快照，不能在窗口线程反复读整库。同一进程的合并批次串行，目标提交前复核被复用行和身份栅栏。正文传输、空间检查与备份先于提交；事务同步落盘后才记成功账本，没有新增行也完成持久屏障。committing 按数据库提交凭据恢复，指向其它目标的记录不得覆盖；读不出的记录暂停自动合并，未知新状态不改写。删除闭包、身份延续和已合并对话集合随迁移保留，删掉的对话不得因旧拷贝或再次合并复活。冲突、缺正文及未完成工作的剔除按对话归属和依赖闭包进行；只插入安全部分，partial 与 merged 独立，残留保留且可只读查看。源任务的中止收尾必须有明确同意并先备份，外来来源不收尾、不升级原件；预检、提交与恢复具体合同以 migration.json、领域合同和相应故障测试为准。

备份清理：普通升级／合并／来源收尾备份仅由当前库的读取线程证明历史记录、正文和可见消息覆盖，不再扫描其它本地库作覆盖证明。保留原有升级宽限、最新合并备份、未完成日志、收尾引用、链接与未知内容保护；显示已被替换的消息单列且默认不勾选。已合并来源单独一类：最新账本必须是 merged、目标为当前选择、来源确切文件状态的已缓存指纹仍匹配；缓存失效先重新合并，不为清理重新扫描历史正文。pending、residual、partial、committing、独立嵌套备份、调试取证、进程输出、未知内容、符号链接和特殊文件均保留。本地来源在配置准入、自己的 maintenance 与 Host 离线检查下删除；外来来源使用不等待的外来声明且无只读查看占用。改名前后复核登记、账本、选择与目录状态，持久写已核对标记后才能删除；未核对残留恢复原名，已核对的中断删除按原声明继续，标记最后删除。不可因释放声明失败把实际已删除报告成保留。残留列表不提供删除操作。

多窗口独占维护仅用于用户明确发起的迁移、当前库修复、清理与立即合并全部。发起方在锁外等待本窗口及其它窗口空闲，冻结新写入前后复核忙状态；参与窗口保存未发送输入并按请求的 notice 或 countdown 策略让出，旧版本或身份未知 Host 不可跳过。准备与协调不持有配置准入等待其它窗口。只有一致身份、可用性和空闲证据成立后才在原有锁序内开始维护；结束或失败按实际 Runtime 生命周期重载，已提交的数据不能因后续协调或释放声明失败误报为未提交。启动后台不发起历史合并独占协调。原有取消、退避、轮次与进程身份隔离规则保持，详见 exclusiveMaintenance 合同。

历史升级入口只复用精确 epoch migrator，不调用含归档重置/空库初始化的通用 cutover coordinator，不改当前 selection，不注册历史 Host 或启动旧任务。既有对话、消息、附件及原 CAS 内容保留；需要转换的旧 Child Runtime continuation 仅在稳定 ID、回执、投递和旧 CAS 全部吻合时发布新内容并补 Link。备份路径和逐库失败原因可追踪。未知 schema、缺失备份或绑定冲突均拒绝；目录移动与跨平台备份恢复需要独立的来源认证与重新绑定流程，不能放宽原位升级检查。归档与拷来的目录走独立的只读认证流程（外来历史库，`runtimeForeignHistory.ts`，`authority.json#rootPolicy.foreignHistory`）：位置只由配置根加固定目录名和严格匹配的名字推导（located），身份只由指针、epoch 清单与 `root_binding` 行完全一致推导（recorded）；核验与本地候选同样严格，只把路径相等换成 recorded 路径自洽（`createRuntimeRootPaths(recorded.dataRootPath)` 且末两级为 `.limcode-runtime/active`），epoch 为当前 epoch 或已发布的 3/4/5；已发布旧格式从不在原位置升级，只在每份私有拷贝上由短期 worker 执行同一套精确 3/4/5→6 数据库升级（不写 journal、不做备份，拷贝绑定按 `migratedBinding` 推导、身份不变），旧正文由主线程经不跟随链接的描述符读取后交给 worker，转换出的新正文只进当前配置根 `.limcode-runtime-merges/foreign-upgrade-cas/`，之后先读它、再读外来目录；升级核验不通过的列为未通过，审计缓存与内容指纹的键区分已升级的拷贝；所有读取只经 located 路径和私有拷贝，recorded 路径只作身份栅栏与显示，从不访问；不建立 RootAuthority、不打开 RuntimeDatabase、不登记 Host、不收尾、不在原位置升级，外来目录中不写入任何文件（唯一的例外是清理备份删除经证明的外来库时对被删那一份本身的改名、已核对标记与删除），结果缓存、互斥声明与升级转换出的正文在当前配置根 `.limcode-runtime-merges/foreign/`、`foreign-claims/`、`foreign-upgrade-cas/`，打开着的只读查看在 `foreign-views/` 登记到关闭为止。外来库不重新绑定、不可切换为当前库；按待合并登记或用户明确请求合并进当前库（`runtimeForeignHistoryMerge.ts`，`migration.json#historicalMerge.foreignSourcePolicy`）：从准备到提交持有它在当前配置根的声明，提交前在声明内重新严格定位并复核指针、`root_binding`、epoch 清单、host-liveness 与各文件自核验以来的确切状态；快照与审计只在私有拷贝上，正文只复制、不硬链接，账本记录与指纹只在当前配置根；有未结束任务或与本地库、当前库延续的旧身份相同（旧拷贝，按可读的库名写明）时拒绝并写明原因，本地有库读不出时推迟，从不收尾、在原位置升级或做来源备份；提交后中断的合并只按账本与当前库收敛，不取声明、不定位它、不需要请求，清理备份在此之前保留它。数据目录迁移的合并模式同样按删除记录跳过，跳过了对话的旧库在删除旧目录时保留。迁移在合并之后把旧配置根的删除记录与合并账本带到新配置根（同名删除记录内容必须一致；目标已有同一候选 id 的账本记录时保留它，旧那条的闭包按来源身份并入），给每个身份变了的库写展开成一层的身份延续（目标原有的也保留），迁走的库的合并请求（保留期限）与收尾说明按新身份改写带走（外来历史库的请求改写成新目录找到它的位置，目标已有同一来源更新的请求时保留目标的），逐步记日志、写完核对，撤销与续撤照日志还原；读不出或矛盾时预检拒绝；合并进要迁走的库、旧目录还能收尾的未收尾提交也预检拒绝（先在旧目录打开窗口收尾）。“回到旧目录”切换之前把当前目录里记在延续身份下的删除一并记到旧目录的旧身份下（只影响以后的合并，旧目录原有的对话不删；记不下就不切换）。

数据目录迁移只把当前库未完成工作及其持久执行资格带入新目录，旧目录不得恢复已迁走的同一工作。非当前来源不迁移、不标记 carriedWork，原位保留并登记待合并。返回旧目录、再次迁移及打开历史版本留下的搬迁标记时，仍按精确迁移身份和已提交证据判定是否需要一次明确同意后离线收尾；不伪造终态或在两个目录重复执行。

## 18. 失败原则

- SQLite 不可用：关闭 Runtime capability 并显示真实错误；
- CAS 缺失：报告 integrity error，不返回空正文；
- Effect 已 dispatch 但无法确认：`outcome_unknown`；
- wrapper 不可达且无 valid receipt：`outcome_unknown`；
- Provider 临时错误：仅按有限、可见、可取消策略 retry；
- Client patch 不适用：snapshot-required/重取 snapshot；
- Delivery target 已删除：InboxItem 保留，Delivery failed(reason=target-gone)；产生答复的子对话被用户删除而父对话保留时，父对话还没接收的答复 Delivery failed(reason=source-gone)，但答复已投给正在运行的父 Turn（未过最终输出栅栏）时，改为把删除通知作为这条投递的运行时输入注入（Delivery consumed，内容为 `application/vnd.limcode.child-answer-source-deleted+json`，模型看到的是 child_failure 与通知文字，不含答复），父 Turn 已接收但还没吸收的那条运行时输入改用同样的通知内容，为 failed(source-gone) 的答复排队的父对话续跑同一事务取消；数据目录迁移后旧目录收尾迁走的结果：Delivery failed(reason=data-root-relocated)，Wake 与进程完成派发 dead_letter（last_error=data-root-relocated），界面显示“数据目录已迁移，未送达”；
- 不吞错、不伪造成功/失败、不改走旧文件 writer。


新的“归档并重置”将原库放到 `<scope>/.limcode-runtime-reset-backups/<时间>-<id8>`，在同一准入内登记 residual 并持久化后才报告完成。这个目录不属于外来自动发现；启动只枚举该目录补登崩溃窗口，不扫描历史正文。旧 `.limcode-runtime-backups` 归档继续作为收敛来源。重置备份只能只读查看、打开文件夹或明确重新核验并合并，LimCode 不自动删除。

迁移复制的其它库不再写用户保留标记，而在新配置根登记 pending；留在旧目录的来源同样登记其可读位置。迁移日志携带 pending、residual、settlement-consent 与 convergence 记录。旧目录还含本地库或新重置备份时保留，不能因其它内容已迁走就整目录删除。

`runtimeHistoryRegistry.ts` 在配置根维护无期限 pending 与 residual，收敛登记去重记录在 convergence.json。`partial` 不是 `merged`：必须保留每个剔除对话的 conversationId、title、code、count，committing 与 lastMerged 同样携带；mergedInto 只登记实际插入的对话。`partial`、pending 与 residual 的外来来源受备份清理保护；删除非当前本地库须有合并到当前目标的 merged 记录、确切缓存文件状态与身份均未变化、且不存在 residual，否则须明确选择覆盖核验路径。覆盖核验复用备份清理的当前库覆盖证明，连同来源嵌套备份一起核对；有未完成工作、缺对话/版本/正文、可见消息被编辑删除或替换均拒绝，partial/residual 始终拒绝删除。残留列表只读展示（部分合并仅展示剔除对话），重新核验将来源重新登记待合并。

### 历史残留的删除、检查与修复

进程等待、停止收敛、spool 清理和完成通知共用完整的持久终态证据校验：成功必须退出码为 0，失败必须非零退出码或非空退出信号，退出码和信号只能存在一个；未知结果二者均为空。Process 的状态、非空 completed_at、nonce 和启动身份必须与回执匹配。等待和通知从同一读快照取 Process 与回执；通知正文使用已核实的 Process.completed_at，创建通知的写事务再次断言已核验字段，不用收到回执的时间替代完成时间。

大库读取每扫描 250 条原始记录即让出并检查取消，包括全部被删除闭包跳过的区段；保留协作消息的来源序号顺序。按跳过闭包复查未完成工作时不把全部跳过 id 装进窗口线程的 Map：小步导出磁盘跳过索引，关闭私有快照 reader，再由审计 worker 用固定 TEMP 视图检查；worker 连接关闭且线程退出之后才重开 reader。此生命周期只属于独立、只读、没有事务或活跃 iterator 的私有快照，不得用于在线来源、目标或维护 writer。

`Operation.owner_kind/owner_id` 是软引用，`deletePolicy: cascade-with-owner` 不是数据库外键。writer 的 Conversation 删除（包括按唯一键删除）在同一事务里先按该对话的 Turn/ModelRequest 精确找出模型请求所属的 Operation，要求请求已终态且聚合完整，再删除 Operation（Attempt 随真实外键级联），最后由 Conversation 级联删除 Turn/ModelRequest。不能依赖声明文字自动级联，也不能泛化为清理所有失去软引用的领域：Process、EffectReceipt 等保留历史仍按原合同保留。任何后续断言失败整笔回滚。

历史合并的进程准入根据持久证据与后续工作，而非仅按状态枚举排除：`outcome_unknown` 是已经结束观测但结果未知，不是“运行中”，更不代表子进程已被证明退出。匹配的 ProcessReceipt（nonce、启动身份、结果和退出元组）、completed_at、没有待完成操作/通知以及输出完整登记时可按原状态导入；缺回执、身份不匹配、状态矛盾或待处理工作仍拒绝。合并从不把它改成 exited，不发送旧结束通知或重新启动进程。数据目录迁移保留原来的较严策略，不因历史展示可合并而允许未知进程迁走。

普通合并、大库准备与整库分批复制使用共享 `MergeAggregatePreflight`，检查本次实际触及的模型聚合：新请求、模型所属 Operation、Attempt 与模型流记录双向确定请求 id，按删除跳过闭包过滤来源，与当前库自己 worker 在一致读快照中的关联行组成有效聚合。请求 id 存在独立连接的磁盘 TEMP 表、页缓存受限，每次只取 64 个目标聚合、每个只保留能证明超限的有界行数，不能向正在 iterate 的来源连接写 TEMP 表。仍在最终 writer 提交时复核。只有带 `RUNTIME_DATA_INVARIANT` 的数据断言或 SQLite 约束归为确定性受阻；域与记录 id 可跨 worker 边界传回，其它执行器、I/O 或目标状态失败继续按推迟。普通在线合并记录规划时目标 writer 的本地提交序号与 external data_version，提交拒绝后目标有过任何本地或外部提交时先按并发变化推迟、不记永久受阻，防止另一窗口抢先合并同一行产生的唯一键冲突被误判为来源损坏。`runtimeMergeValidation.ts` 的日期化规则标识只使受影响的派生拒绝与审计缓存失效（包括外来历史库的审计缓存），不改变内容指纹，不删除提交记录、删除记录、mergedInto 闭包或恢复凭据。

“历史与存储管理 → 检查并修复历史残留”（`runtimeHistoryRepair.ts`）是独立的用户操作，不是合库的静默兜底。只接受本地、Host 和旧版 owner 均离线、无未完成恢复且精确核验为当前 epoch 的库；拒绝共享 inode/硬链接、符号链接、不完整结构与涉及该库的 committing 合并。只读检查通过私有快照审计 worker 完成，不备份、不启动 Runtime、不改源库；现存请求聚合异常、非终态孤立操作、保留效果或结果暂停依赖、不能匹配的进程结束证据均报告而不猜测修复。明确确认后才经写入闸门和维护生命周期：按完整内容摘要复核计划，先查备份与修复 WAL 空间（数据库与 WAL 大小之和的两倍加 64 MiB），通过 SQLite Backup API 备份、核对摘要并 fsync 数据库/目录，在控制根 `history-repair-backups/<时间>-<修复UUID>/` 保存 RootBinding 与 prepared 日志；再由私有维护实例的固定 worker 操作，以 synchronous=FULL 的单事务清理父请求缺失且没有保留依赖的完整终态 Operation/Attempt，并仅凭匹配的既有未知结果回执，将误改成 exited 的 Process 恢复为 outcome_unknown。实际修改前再次核对内容摘要；事务内逐表保护投影摘要证明除精确清理的元数据与纠正的单列状态外全部原记录不变，包含消息修订、当前版本、成员关系、正文与附件元数据；CAS 文件不改动，完整性核验不通过整笔回滚。没有需要修复的记录不备份；任一不安全记录使整份拒绝。

修复事务同笔写专属 CommandReceipt（`historical-repair:<UUID>:<计划摘要>`）；库内标记是是否提交的唯一证明，库外 completed 日志不作提交依据。备份后取消或崩溃未改源数据；提交后写完成记录失败仍报告已提交，下次只读检查按标记显示实际结果，同一计划重入不重复删除、也不重复备份。修复备份不纳入自动备份清理。修复不改当前选择、不重建缺失父记录、不伪造退出码、不调用模型/工具、不清合库账本；修复与之后合库分别报告，修复过来源之后不得宣称两边从未改动。修复当前库先经独占协调等待窗口空闲、冻结新工作并关闭发起窗口的 Runtime；随后只读检查并另行确认备份修复，结束后重载，选择文件不变。外来只读历史不原地修复。

历史合并的对话归属由 `runtimeMergeConversationOwnership.ts` 对全部领域显式分类与声明路径，机器合同一一覆盖。实际剔除规划复用一次行扫描建立的关系边，不能为每一行重复遍历历史；内容派生身份不强行归入某一个对话。

历史合并的离线收尾基础复用迁移已有的停止和放弃转换，原因参数为 `historical-merge-settled`，最多三轮，返回按对话归属的未完成项；迁移原有原因与五轮行为保留。合并调用方负责在来源维护声明内、已有备份及持久同意之后调用，落盘后再记收尾结果；外来来源不原地收尾。

后台批次逐来源开始前检查发起 Runtime 是否空闲。自动外来来源从申请声明前起有 120 秒取消预算，声明已占用时直接推迟；取消传到私有复制、审计和正文读取，最终释放声明并清理计时器。明确请求不受后台预算限制，超时只推迟、不记为坏库。

收尾同意按来源身份持久保存轮次数、排队意图数、待投递数（含进程完成派发与未送达答案）、子 Agent 数、未收到回执的操作数；界面同时说明未知效果可能记为结果未知。只有同一来源身份、各项数量均未超过已同意数量才复用同意；新来源或数量增加重新确认。在线与流式准备复用已有私有快照，在不持维护声明的同意边界暂停；一次确认列出已准备来源的可读名称与数量，同一准入内持久整批同意之后才逐来源继续。取消时拒绝尚未继续的来源并等待各自快照清理，已提交来源不回滚。先持久同意，再在来源维护声明内备份，以 SETTLING_ONLY 打开来源、运行既有三轮停止与放弃转换，durabilityCheckpoint 后关闭，剩余按对话剔除，无法归属的整轮失败推迟。finalizations 同时保留控制面返回的 15 项完整分类计数，轮次与排队意图另按来源实际状态回读统计。


### 单一历史界面（第3期）

历史与存储管理只提供当前历史修复、存储占用、未能合并的旧数据、立即合并全部、迁移、清理备份和归档重置。不再提供选择、切换、保持分开、删除其他库、外来库列表或大库会话界面。没有选择且所有可检查候选均不合格时，在维护离线边界内保留不可用固定根为残留备份，建立固定当前根，旧来源登记待合并或残留；不绕过不可读物理边界。已有选择保持不变。立即合并全部直接调用准备与流式合并后端，复用独占协调、保存输入、取消和重载，不估时、不倒计时、不暂存会话结果。残留和部分合并来源不删除。

旧大库会话适配层与只读估时、倒计时、剩余时间、实测速率账本已删除。流式后端只报告阶段和已处理行数；准备声明、备份、空间检查、单来源事务和取消回滚保持原语义。旧rates文件留在磁盘上不读不写，不新增清理扫描。
