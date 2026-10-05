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

已发布 SQLite epoch 3/4/5/6/7/8 只允许按精确来源离线升级到当前 epoch 9。epoch 5 的 107 领域、metadata DDL 与 triggers 固定在独立历史描述中，并核对完整摘要；它已经公开发布，不在原 epoch 内补表或改 manifest。epoch 3 的完整 manifest 分为 v0.0.10–v0.0.12 的 `ModelContextProjection.client=detail` 与 v0.0.13–v0.0.14 的 `summary`；二者物理 DDL 和其余 86 个领域完全相同。v0.0.15–v0.0.21 的正常新建 epoch 4 为完整 91 领域；额外接受的缺 RuntimeDeliveryIntentLink 前驱仍须通过单一精确指纹与 continuation 语义校验，不能由任意缺表推导。升级先核验 table/index/trigger、manifest 与 RootBinding，设置 pending fence/持久 journal，建立并验证 SQLite Backup API 备份，再以单事务补齐当前领域并更新绑定；中断按 journal 向前收敛，旧版 3→4、3/4→5、3/4/5→6、3/4/5/6→7 与 3/4/5/6/7→8 的已知边界先单独认证恢复；旧升级已提交时先完成原来目标的指针与完成记录，再启动独立的 epoch-to-9 journal。Windows 仅在 SQLite 原生 I/O 使用 namespaced path，持久 RootBinding 保留 canonical path。

epoch 7 新增 ConversationContextHandleState 与 ContextRootHandleCatalog 两个独立领域；从 epoch 6 及更早来源升级时，仅为确切当前 head 插入 pending 标记，不重建历史目录。epoch 8 保持 epoch 7 的全部 113 个领域、DDL、索引和 trigger 不变，独立冻结的 epoch-7 描述摘要为 `fd069dee963b1ad5032d1ea3121a583b0bc93cc9cfed43b9e684fb11beb7be46`。紧凑普通 catalog-reference recipe 改变读入语义，必须由整库 epoch 栅栏控制准入；7→8 只更新 schema_manifest、RootBinding 与外部 epoch/指针元数据，保留所有领域行、CAS 字节和 ready/pending 目录状态，不读历史正文、不重建目录、不重置原状态。旧 epoch 7 reader 在打开时拒绝 epoch 8，存活或身份未知的旧 Host 阻止升级。epoch 9 为冻结工具定义 toolsReference 设置同样的全数据集准入栅栏；独立 publishedEpoch8 描述固定 epoch 8 的全部 113 个领域、metadata DDL 与 trigger，8→9 同样只更新准入元数据，不改领域行、CAS 字节或目录状态。旧 epoch 8 reader 拒绝 epoch 9；旧内联工具配方仍按原冻结字节读取，新配方的工具 CAS 引用在复制与合库时随全部登记正文保留。

新建普通与原生压缩请求配方以 toolsReference.contentObjectId 冻结工具定义，指向 application/vnd.limcode.frozen-tool-definitions+json 类型的不可变 CAS。旧内联 tools 配方保留原字节与原读取路径，引用缺失、类型或摘要不符时拒绝，绝不退回当前工具设置。该引用是独立于生产者 Turn/Conversation 的强 CAS 边：分支沿用原配方，删除源对话不删正文，整库复制与合库继续携带全部已登记 ContentObject；未来可达性 GC 必须沿 toolsReference.contentObjectId 保留正文。

备份升级自动触发：当前选中根在 Runtime 打开前完成；当前 Runtime 就绪后串行处理其余旧根；查看旧历史时补做。仅目标根必须无存活或身份未知的 Host，其他已运行数据集继续使用。各库操作分别持有 configuration admission → target maintenance，并在库间释放；结束 activation 后不再开始下一份迁移。旧库发现的局部错误须与可用候选分别返回；已有固定选择损坏时仍拒绝，已有选择从不被改选。没有选择文件时（从按工作区分库的版本升级）不再询问：只在通过只读可升级性预检的候选中选（见下文历史合并段），固定默认根已初始化（有完整 RootBinding，哪怕还没有对话）则选它，否则选 SQLite 最近修改的旧工作区库；全部候选都过不了预检、或固定根/scope 容器本身不可读时要求显式选择并写明每个库的原因；只有异常来源时报错，不创建空库。

旧历史数据集在当前选中数据集正常打开、本 Host 就绪并完成后台升级之后，在后台逐来源在线合并进当前数据集（`runtimeDataSetMerge.ts`，`migration.json#historicalMerge`），不重载窗口。自动合并的来源是旧版本留下的全部其它数据集（工作区 scope 与固定根），每份只自动合并一次，以前切换过的除外：0.0.24–0.0.30 已有“切换当前历史库”却不记“用户保留”，本版本第一次选源（`pickSources`）、第一次切换或把新建的默认库记为已初始化之前（`selectVscodeRuntimeDataSet`、`completeVscodeRuntimeDataSetSelection`，这两处会让修订号加一）由 `vscodeRuntimeSwitchedBeforeUpgrade` 在账本 `upgrade/selection.json` 记下当时的选择修订号（没有选择文件记 0，读不出按切换过，估计只读不记），大于 1 时既没有保留标记也没有账本记录的其它库不自动合并、也不收尾，批结果 `undecided` 列出它们（带 SQLite 文件大小），合并状态为 `undecided`；命令层每次启动由一个窗口问一次（`claimRuntimeDataSetUndecidedPrompt`，与大库会话同样的提示记录做法，`prompts/switched-before-upgrade.json`），“全部合并”经与“合并到当前库”相同的确认后记录请求并按明确请求合并，“保持分开”由 `keepRuntimeDataSetsApart` 记为用户保留，关掉不选下次启动再问；本版本起用户切走的库在其控制根记为“用户保留”（标记读不出时按保留处理；写不了标记就不切换；切走一个已无法检查的库时记为保留它的任何实例），与已合并过的来源一样只按明确请求合并；明确请求只作用于用户点击触发的那一次合并调用（批选项 `requested`，须与 `candidateIds` 同传；确认框按 `RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS`、`EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs` 与 `RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS` 写明超限时会等其它窗口、可取消、其它窗口重载一次，以及太大不能合并；还写明中断的任务按“中止”收尾、排队未发送的消息会被取消，在当前库删除过的对话（包括以前合并进来之后删掉的）不会再合并回来，切换当前历史库的说明对已合并进当前库的库也写明这一点；结果总会提示：来源已合并、没有新内容时结果里有一条 `alreadyMerged`，命令层提示“已合并，没有新内容”，引擎什么都没做时也说明原因），记录下来的请求只让该来源在之后的启动里按普通待合并处理，`RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS`（7 天）过期，合并成功、受阻或失败后删除（`mergeRequestDone`：事务已提交但“已合并”记录没写成、仍是 committing 时留着）；过期的请求只在给出一次提示（批结果 `blocked`，代码 `runtime-data-set-merge-request-expired`）时删除，来源本批仍被合并时随结果删除。选源在 configuration admission 内只读账本、请求和文件状态：内容指纹只用 `cachedRuntimeDataSetFingerprint`（按确切文件状态缓存、从不读库）；未命中缓存而判断需要它的已记录来源在 admission 之外、在该库的 maintenance 里逐个计算（`localFingerprint`：本进程里打开着它的操作都持有它，复制它们持有的文件会让本进程丢掉 SQLite 锁）后再判断；同一进程里的合并批次（启动批次、“合并到当前库”、外来库合并、对以前切换走的库的回答）经命令层的一个队列串行执行，不需要它的（用户保留、已合并过且没有请求）在 admission 内直接跳过。首次没有选择文件时，自动选库只在通过只读可升级性预检（已发布 epoch 3/4/5/6/7/8 与当前 epoch 9、表结构与物理指纹精确一致且已发布 3/4/5/6/7/8 另做 quick_check、账本中无同一内容状态的失败记录；预检、摘要与内容摘要都由 worker 读私有副本，主线程不打开数据库）的候选中进行，全部不通过就要求显式选择并写明原因。来源必须离线（Host liveness，以及 v0.0.10–v0.0.20 的 `runtime-owner/owner.json` 进程身份）；来源先走上述精确升级（先备份、再就地升级），再从私有快照核验当前 epoch 指纹与完整性，内容摘要也由审计 worker 在这份副本上计算并写入指纹缓存。快照不持锁：复制前后 `runtimeDataSetFileState` 不变才算数，否则重新复制（最多 3 次，仍在变化就推迟）。快照、核验、冲突与规模判断、正文校验与复制、目标备份都在锁外；只有来源收尾和最后的“复核 + 事务”持有 configuration admission 与来源 maintenance（独占兜底时外层先取 admission 与目标 maintenance），锁内复核来源仍离线、身份与 rootGeneration/pointerRevision 不变、SQLite 文件状态与核验时一致，提交前再重读账本：其它窗口已提交同一内容就直接跳过、不提示，另一窗口留下的 committing 记录则推迟。目标为当前库的 committing 记录，不论来源是否用户保留、有没有请求，选源时都先收敛（`convergeInterruptedCommit`，与外来库一致，请求过期也不误报），本地库收敛为没提交时按放回的记录重新判断；指向另一个库的 committing 记录从不被覆盖：选源时按那个库里的标记收敛（`convergeElsewhere`：在那个库的 maintenance 声明内复制私有快照读标记，在就记为已合并到那个库、只记快照里存在的对话，不在就放回它替换的记录），那个库已不存在时同样放回，正在使用或读不出（或有库读不出、判断不了它是否还在）就推迟（`runtime-data-set-merge-commit-elsewhere`）；锁内重读账本时才看到的只推迟（`settledSource`、`assertNoCommitElsewhere`），`recordRefusal` 也不写在任何 committing 记录上。账本记录文件用不了时（`readRuntimeDataSetMergeRecordDamage`）不当作没有记录：损坏的报告受阻（`runtime-data-set-merge-record-damaged`）并暂停自动合并，明确请求或记下的请求才重新记录；状态不认识的（更新版本写的）推迟（`runtime-data-set-merge-record-newer`），`writeRuntimeDataSetMergeLedgerRecord` 也拒绝改写它。多个窗口因此可同时准备同一来源，但只有一个提交；来源文件在此期间变化时，推迟之前先在锁内重读账本：本批选源（`pickedAt`）之后已被合并进同一目标（例如先到的窗口收尾并合并）就静默跳过（明确请求时报“已由另一个窗口合并”，结果带 `mergedByAnotherWindow`），否则推迟，下次启动再判断（变化来自另一个窗口对这个库的收尾，即收尾记录不是本次所知的那份时，推迟理由如实写明）；其它非预期错误映射为推迟之前也同样重读。会被跳过的对话（删除记录与闭包，连同子 Agent 对话）里的未结束工作不参与拒绝、也不收尾（`keptUnfinishedWork`：与规划同一个跳过集合，探针在快照上经临时视图看不到这些行，大库准备用它的 TEMP 跳过表）；来源的未结束工作只在未收尾快照上的拒绝探针、冲突、规模和正文只读校验全部通过后才收尾；此前内核自己的对话忙碌探针（`createConversationRuntimeWorkProbe`）对全部对话按“收尾之后”的状态判一遍（`runtimeDataSetMergeProbes.ts` 在快照的只读连接上用临时视图投影收尾结果：Turn 终止、租约释放、中断/终止输入消费、待定工具得到结果、排队意图取消），仍判忙就在收尾前整份拒绝。收尾时先备份来源，再只用现有控制面终态转换（active Turn 以 cancelled/interrupted 结束并写原因：旧版本留下的库写 `MERGE_FINALIZATION_REASON`“在旧版本里中断，合并前收尾。”，本版本用户保留的库写 `KEPT_MERGE_FINALIZATION_REASON`“合并前收尾。”；释放 lease，取消未开始的模型请求、无 Operation 的工具调用和排队的用户消息）；收尾数按收尾后来源里的实际状态统计，不累加计划数（账本记下要收尾的 Turn 与 TurnIntent id，`finalizeUnfinishedWork` 结束时回读，上次中途出错或崩溃的在新快照里重数）；没有现成终态转换的状态整份拒绝并写明原因与出路（`runtimeDataSetMergeWork.ts` 的状态表）。写入只经当前 RuntimeDatabase 的正常写事务，每个来源一个事务：逐行 codec 解码后用领域 Repository 插入步骤写入，模型请求相关的已开始或已结束的行以历史复制插入（`HISTORICAL_COPY_DOMAINS`，worker 不变量照常校验：历史复制的 ModelRequest 必须已终态，其 Operation 只收 completed/cancelled/failed、Attempt 只收 transient_failed/completed/cancelled/failed；ModelStreamFence/ModelStreamCheckpoint 只能随父 ModelRequest 在同一事务里以历史复制写入，worker 按事务记录这些父请求，savepoint 回滚时同步撤销；尚未开始的请求及其 pending Operation/Attempt 按 Runtime 自己创建时的形态插入），事务末尾断言每个来源 id 都存在；这个事务经 `RuntimeDatabase.transaction(steps, { durable: true })` 提交：worker 只对这一个事务把写连接的 synchronous 设为 FULL（WAL 在提交时同步，先核对设置已生效），提交或失败后都改回 NORMAL，诊断里的 `durableCommitCount` 计数（提交之后读回仍是 FULL 才计，第二次及以后的 durable 提交也可核对），落盘之后才写“已合并”记录、删提交凭据；不另开或关闭库文件描述符去 fsync，也不用 PASSIVE checkpoint 代替；synchronous 的设置与自检经 `database.pragma()`，不走语句缓存（设置型 PRAGMA 在编译时生效、读形式的答案编译成常量，缓存复用只在 SQLite 恰好每次重新编译时才对）。一般规则：库外记录说库里某事已完成（“已合并”、迁走任务的“已收尾”、迁移的完成记录、整库复制的收据）只在它落盘之后写：有写入的 durable 事务，或落盘屏障 `RuntimeDatabase.durabilityCheckpoint`（worker 请求 `durabilityCheckpoint`：写连接在事务外 `wal_checkpoint(PASSIVE)`，同步 WAL、写回、全部写回后同步库文件；不拿写锁也不等待，不挡其它窗口的写入（FULL 等读者期间会挡住它们，直到它们自己的 busy 超时）；busy 为 0 且 checkpointed 等于 log 才算，约 1 秒内有限次重试仍不行就报错；维护事务打开期间拒绝）；只有断言、没有写入的 durable 事务不产生 WAL 帧，关闭最后一个连接时的 checkpoint 不报告结果、另有连接时不做，都不是屏障；同 id 同内容复用，ContentObject/ProjectContext/Attachment/AttachmentObservationLink 仅允许 `identityDomains` 列出的列不同并保留目标行（事务内用 savepoint 按 id 与全部声明的 UNIQUE 列“仍不存在才插入”，已被其它窗口写入就按同样规则比对），CollaborationMessage.message_seq 不在规划时定：来源行按 message_seq 顺序读出，用 `insertWithNextSequence` 由 worker 在合并事务内逐行分配“当时最大值 + 1”，相对顺序不变（规划到提交之间其它窗口写入的协作消息不会造成 UNIQUE 冲突，超限来源在锁外等待期间也一样），其余差异在写目标之前整份拒绝。有行要写入时，目标先经 SQLite Backup API 在线备份（每批一份，目录名为 UTC 毫秒时间加进程内序号；本批没有任何事务用上——全部推迟、拒绝或确定回滚——就在批末删除；用上时 `merge-backups/` 按创建先后保留最新 3 份，另外总保留本批自己的和本批开始前最新的一份（大库准备做的、`preparing-backups/` 里仍有存活登记的备份不删、不占名额）；失败不留文件；备份前——目标备份与来源收尾前的备份都一样——按库文件与 WAL 的大小加 64 MiB 余量核对备份所在盘的剩余空间，不够就推迟（`runtime-data-set-merge-disk-full`，原因写“磁盘空间不足，需要约 N MB”），不去写盘，提示按原因只出现一次），CAS 先按摘要校验后发布，事务只提交引用；没有要插入的行只记“已合并”，不备份；其它窗口照常运行，只看到一次外部提交。来源行数超过内存单事务上限 `RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS`（60000）时，在任何规划、协调、备份、收尾之前推迟为 `runtime-data-set-merge-awaiting-exclusive`（不写账本，批结果带 `size` 行数与字节数，“历史与存储管理”按待合并显示），由大库会话合并（`runtimeDataSetStreamedMerge.ts`）；以前合并进来的对话在当前库都还在（没有要剔除的行，只读当前库判断）时，审计里有无法收尾的工作的来源不论大小先按受阻入账（`runtime-data-set-merge-unfinished-work`，写明原因和出路），不等待会话；有删掉的，由准备按剔除之后的工作判断，估计也不判受阻。自动批次里超过在线上限、本该单独协调的来源核验之后先放到批末：批里有等待大库会话的来源、且放得下这场会话（`largeMergeSessionFits`：与估计同一口径 `largeMergeSessionSpace`——等待的与随会话的中等来源都算、按各来源的库文件与要复制的正文——再按 `largeMergeDiskNeeds` 逐盘核对当前库所在盘、临时目录与数据库临时文件目录）时同样推迟为 `runtime-data-set-merge-awaiting-exclusive`、随会话一起合并（准备时 `threshold: 'online'` 把它们一并准备），否则照常逐个协调；用户明确请求的那份照常单独协调。在线准备 `prepareLargeMergeSources` 不持久锁、窗口照常可用：同一来源同一时间只有一个窗口准备（账本 `preparing/<id>.json`，10 秒心跳——在配置准入内核对 token 仍是本窗口的才写回，释放或别的窗口接手之后不会写回——进程已不在（`classifyRecordedProcess`，按 pid 与进程启动身份）或 60 秒没刷新可以接手，批末与会话结束时清理；写记录遇到磁盘满按磁盘空间不足推迟这份、后面的来源不开始），按在线合并的顺序做快照与核验、未完成工作探针，以流式试算 `scanMergeRows` 代替规划（每 `RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS`＝250 行解码一次、经当前库 reader 按 id 比对，与规划同一个 `planMergeChunk`，只留计数、最多 20 个冲突样例与耗时，有冲突整份受阻；要插入的每个模型请求在来源私有副本上执行 worker 提交时的同一个 `assertModelRequestAggregate`（`runtimeModelRequestAggregate.ts`，worker 也从这里取），不成立整份受阻 `runtime-data-set-merge-invariant`，读副本本身出错不算），需要时收尾后重新快照、核验、试算，再发布正文并保留校验记录、在线备份目标（会话不用时释放准备会删除它；写第一个字节之前登记在账本 `preparing-backups/<备份名>.json`（进程号、心跳、`used`），随准备记录心跳，并在审计线程（`auditRuntimeSnapshot` 的 `indexBytes`，本线程关掉备份副本之后）用 dbstat 实测目标的索引页；准备整体出错删掉本次的备份并抛 `LargeMergePreparationError`（带已收尾的来源份数，提示只有为 0 时才说“已有数据未被修改”）；窗口在会话之前消失——进程不在（按 pid 与进程启动身份）或 24 小时没心跳——时由清理过期准备（每次批次结束、准备开始与结束）删掉 `used` 为假的备份与登记，`used` 为真的只撤登记、备份照常保留，删不掉的保留登记下次再删，会话什么也没合并、备份又删不掉时登记改回 `used` 为假）；没有新行的来源直接记“已合并”。用户同意之前只做只读估计 `estimateLargeMergeSources`：不收尾、不备份、不传正文、不写账本、不占准备记录、不就地升级已发布 3/4（改为推迟），来源的确切文件状态命中审计缓存就不再复制，否则复制核验一次；外来历史库只经它的声明（`holdForeignHistoricalMergeSource`，声明在当前配置根，配置准入之外取、估计完就释放）定位、复制与核验，不调用本地库的解析与维护声明，不向外来目录写任何东西，正文按全部复制计空间与准备时长；每份来源给出内容指纹（与准备的 `fingerprint` 同义：没变就不变，准备收尾之后变为收尾后的指纹，下一次估计也给这个值，操作键两段一致），准备阶段（复制、核验、试算、收尾、目标备份、正文核验与发布）与独占阶段的时长分开给出，按行数、库大小与正文对象数用保守速率估计；会话把真正合并了的来源实测的独占耗时（含打开与关闭私有实例）与估计模型给的时长记在账本 `rates/`（只作估计，模型不足 1 秒的会话不记，每次会话替换上一次），之后的估计按两者之比换算独占阶段（限 `RUNTIME_DATA_SET_LARGE_MERGE_MEASURED_RATE_BOUNDS`，0.5–4 倍），准备阶段不换算；范围取 `RUNTIME_DATA_SET_LARGE_MERGE_UNMEASURED_RANGE`（0.4–2.5 倍），准备后按实测试算重新估计独占阶段。准备有副作用（收尾、备份、发布正文、入账），只在用户同意之后调用；准备中途取消时 `report.stopped` 为真、不给来源，交还全部准备记录与没用上的目标备份。审计结果按来源确切文件状态与身份缓存在账本 `audits/`（行数、字节数、正文对象数与字节数、未完成工作；外来历史库的按它的 id 记在当前配置根），不是权威：在线批次判断等待的来源、估计、准备判断不进会话的来源都先用它，真正合并前照常复制核验，并由 `assertUnchanged` 与指纹复核；正文核验过的文件身份按配置根记在 `.limcode-runtime-merges/limcode.cas-verified.sqlite`（LimCode 自己的库名，进程内文件工具不会打开；本进程只开一个连接，写入成批，90 天没有再确认的记录丢弃），身份不变就不再哈希，有任何变化就完整哈希；缓存文件损坏（SQLITE_CORRUPT/NOTADB）就删掉重建，仍用不了时内存里最多留 1 万条、多的只计数，一次批量写入失败（例如另一个进程占着写锁超过 50 ms、SQLITE_FULL）时丢掉的条目也计数，准备时这份来源的正文有没记下的就推迟（`runtime-data-set-merge-verification-unrecorded`），不让会话在所有窗口暂停时重新哈希。独占阶段 `runLargeMergeSession` 只在调用方持有 configuration admission 与目标 maintenance 时运行：以 `historical-merge-<uuid>` 打开私有维护实例（`RuntimeDatabase.open(authority, { maintenance: true })` 要求调用方持有该根 maintenance、没有在线 Host，实例没有提交监听者）；逐来源在来源 maintenance 内复核来源不变、重新复制快照（文件状态与核验时一致才沿用结论）、正文只 lstat、重读账本、写 committing（先写空证据），然后一个 worker 维护事务按 `MERGE_DOMAIN_ORDER` 与 rowid 每 250 行比对（经 reader 读已提交状态，与规划读事务前状态同义）并追加该块步骤与存在断言，跳过以前合并后删除的对话的闭包在私有快照连接的 TEMP 表里按同一套规则求不动点（只读一张表的规则按 rowid 分段、每段 64 个读取块；“全部成员都跳过”的规则每一轮先由已跳过的成员行按主键找出候选 owner，再按成员列上的完整索引逐段探测候选、没有这样的索引就按成员表 rowid 分段扫描，去掉仍有未跳过成员的候选，剩下的分段写入，结果与按 owner 分组的整条语句相同；每段、每步之后都让出线程）；最后一块之后写全证据，以 synchronous=FULL 提交，再单独 `wal_checkpoint(TRUNCATE)`，之后才写“已合并”。维护事务（`maintenanceBegin/Append/Commit/Rollback`，`maintenanceCheckpoint` 在事务外）跨请求持有一个写事务：打开期间拒绝其它写与第二个事务，追加失败整笔回滚，每块照常执行插入不变量并清空临时变更表，请求聚合（ModelRequest/Operation/Attempt/Turn 触及的）与历史复制的请求累积在 writer 的 TEMP 表 `runtime_maintenance_scratch` 里、随事务与 savepoint 回滚，提交时统一断言；提交不做 `readTransactionChanges`，返回 `snapshotRequired`，分配记录只给计数；维护实例与来源副本的页缓存封顶，正文传输按正文键去重与核对长度在来源副本连接的 TEMP 表里，内存不随来源行数与正文对象数增长。取消只回滚当前来源（之前合并完的保留）；空间模型 `largeMergeTargetBytes`（`runtimeDataSetLargeMergeSpace.ts`）：全部来源库大小，加最大一份的 `LARGE_MERGE_WAL_PEAK_FACTOR`＝1.5 倍，加目标索引页（id 随机，插入改写每个索引的全部叶子页；准备实测，估计与批次按目标文件的 `LARGE_MERGE_TARGET_INDEX_SHARE`＝0.65 倍），加其余来源的 0.65 倍与 64 MiB；临时目录要最大一份来源的私有副本，数据库临时文件目录（SQLite 的 TEMP 表与排序溢出，`sqliteTemporaryDirectory()`）要最大一份的 `LARGE_MERGE_SQLITE_TEMPORARY_SHARE`＝0.25 倍，不在当前库所在盘上的盘各再加 64 MiB；每块写完 statfs，剩余不到 64 MiB 就提前回滚，需要量取模型与“库 + 按已写行数推算的 WAL + 64 MiB”中的大者；SQLITE_FULL、ENOSPC、EDQUOT 一律 `runtime-data-set-merge-disk-full`：回滚、收回 WAL、推迟并写明所需空间（中文，不带系统原文；错误没说是哪个文件、当前库所在盘还有余量而数据库临时文件目录或临时目录不到余量时，写明那个目录和它要的量），后面的来源 not-run，准备同样停下、后面的来源不开始准备；独占阶段出现新冲突就在那一块停下（不再读这份的其余部分），整份回滚、记为受阻（写明至少几处）；worker 拒绝写入这份的数据（追加或提交时断言失败——不带错误码——或 SQLITE_CONSTRAINT）整份回滚、记为受阻 `runtime-data-set-merge-invariant`（按来源内容记录，来源不变就不再自动准备，明确请求时重查），带其它错误码的（忙、I/O、磁盘满、存在断言）与本线程的错误照旧推迟；关闭私有实例或删私有副本出错只记日志，已有结果与用上的备份不变；回滚或结果不明时按证据实测，确定没提交就放回 committing 替换的原记录。超过流式硬上限 `RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS`（2000 万）的来源才在任何规划、协调、备份、收尾之前拒绝，账本记 `too-large`（行数与判定时的上限，不算失败，上限与来源都不变就不再自动重试，按别的上限记下的——包括以前按 60000 记下的——重新判定，明确请求会重新判断），“历史与存储管理”显示约多少条记录、当前版本不能安全合并，可切换过去查看；合并引擎的数据目录迁移模式本身不受这两个上限；迁移进已有 LimCode 数据时预检用同一常量在任何协调之前拒绝，迁入新建根时按批写入（`runtimeDataSetBulkCopy.ts`），不受此上限。超过在线上限 `RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS`（4000 行或 12 MiB；实测单核满载时最坏约 1.3 秒、另一窗口最长等待约 1.1 秒，远低于 busy_timeout）的来源才走下段的独占维护：只在冲突、正文、目标备份都已就绪之后，在全部锁之外发起，以来源内容指纹作操作键；全部窗口就绪后经 `withLocks` 取 admission 与目标 maintenance，锁内只做来源复核与那一个事务；协调未完成就推迟（此时来源若已收尾，提示如实写明）。由引擎推迟为等待大库会话（`runtime-data-set-merge-awaiting-exclusive`，不入账）的来源进入“大库会话”（`vscode/commands/largeHistoricalMerge.ts`；引擎的估计、准备与合并函数只经 `runtimeLargeMergeEngine.ts` 适配）：有大库会话时，其它超过在线上限的待合并来源不单独协调，随会话一起合并（一次协调、一次重载；用户点击的那一份照常单独协调）；用户同意之前只做只读估计（`threshold:'online'`，中等来源一起估计；在全部锁之外调用，适配层在配置准入内被调用时直接拒绝），准备只在同意之后调用。启动后只有一个窗口提示：提示记录在配置根 `.limcode-runtime-merges/prompts/`，同一 VS Code 会话（`vscode.env.sessionId`）或记录进程仍存活时别的窗口不提示，它只是提示、不是合并记录；估计之前先只读查询协调会不会被冷却挡住（`readExclusiveMaintenanceRefusal`：只有其它窗口在线时才看冷却与退避，不写任何东西），挡住就不估计、不倒计时，写明何时可以再试（同一原因只提示一次）；估计在状态栏进行（只有要复制核验的来源才逐份写明复制、核验；按批次缓存的审计估计时什么都不复制），估计时已有结果的来源按在线批次说明；再按估计给出的空间数字预检（其中含准备要做的目标在线备份与要复制进来的正文；当前库所在盘 `targetBytes`，余量已含在内；临时目录 `temporaryBytes`，临时目录在另一块盘时另加 64 MiB；同一块盘合计），不够就不提示开始，只说明还差多少（同一原因只提示一次）；再用估计给出的各来源指纹（与准备的同义）生成操作键查询一次，会被冷却、按键退避或 blocked 挡住同样不倒计时、写明何时可再试；都没有就以可取消的进度通知倒计时 60 秒（写明份数、约多少条，以及“倒计时结束后先在后台准备约 X（期间照常可用），准备好后所有 LimCode 窗口重载一次，暂停约 Y”：X、Y 是估计给出的准备与独占两段时长，不到 1 分钟时写“不到 1 分钟”；并写明显示进度、完成后自动恢复、未发送的输入会保留），点“取消”只改到下次启动：什么都没准备（不收尾、不备份、不传正文、不占准备记录），不写账本，没有“永不”；倒计时结束才准备（可取消的进度通知，窗口照常可用，逐份写明复制、比较、收尾、复制正文、备份；只准备估计后剩下的来源；中途取消同样改到下次启动），准备时才有结果的来源同样说明；准备好却没有开始合并（取消、准备中途取消、空间不够、协调没有进行）时交还引擎为它保留的东西（来源声明、没用上的目标备份）；准备好后等本窗口和其它窗口的任务结束（沿用最多 10 分钟的锁外等待）再开始，协调的操作键取准备给出的指纹（只有来源收尾之后才与估计时不同）。“历史与存储管理”在有来源等待时列出“合并较大的旧聊天记录（N 份，约 X 条记录，开始前给出预计时长）”，合并列表把这些来源标为“较大，等待合并（约 X 条记录，开始前给出预计时长）”（行数取本进程最近一次批次测得的大小，估计判出已合并、受阻或不需要会话的随即去掉；列出时不估计，不编时长）；手动开始先只读查询冷却（挡住就说明原因、什么都不做），再在可取消的通知里只读估计（取消或出错时什么都没准备），说明估计时已有结果的来源、按估计的空间数字预检（不够就不开始并说明），再用原生模态框确认（写明份数、约多少条，先在后台准备约 X、再等任务结束，然后所有 LimCode 窗口重载一次、暂停约 Y），确认之后才在可取消的通知里准备（中途取消时把已准备好的来源交还引擎，不协调、不合并），明确请求合并这类来源时同样进入这一流程；估计或准备时没有已有结果的来源、仍有来源进入会话时，不对这次点击说“没有合并”（结果在会话之后说明）；这个入口会写库，本窗口冻结期间按写命令拒绝（确认之后才冻结的也拒绝）。两种开始都调用 `runWithExclusiveMaintenance`（`historical-merge`，与中等来源共用冷却；操作键为目标身份加各来源内容指纹的摘要；`whenBusy:'wait'`；自动开始 `final-countdown`、`ignoreBackoff:false`，手动开始其它窗口只提示（`notice`）、`ignoreBackoff:true`；协调中不给取消按钮，go 之后不理会取消；`beforeGo` 照迁移先检查本窗口空闲、再冻结本窗口）；独占阶段在 `withLocks` 内先用 `fs.statfs` 再核一次空间（不够就不关运行时、不重载，说明原因），请面板立即保存未发送的输入，关闭本窗口的运行时，再由引擎逐来源合并：发起窗口的进度通知（“正在合并较大的旧聊天记录 2/4（已处理 12 万 / 38 万条，约还需 3 分钟）”：已处理按引擎比较过的来源行数计，剩余时间用引擎的值 `LargeMergeSessionClock`：开始写入满 1 秒之前用准备的估计减去已用时间，之后只按开始写入以后的行数与时间算速率，每份开头的固定开销——私有副本、逐个 lstat 正文、跳过闭包、提交记录——按已做完的份平均另计）每 0.5 秒最多更新一次，可以取消，取消只回滚正在合并的那一份，已合并的保留；其它窗口的打开外壳由 `reportStage` 更新，只在换来源或进度每增加 5% 时重画，维护标记带预计结束时间（预计区间的上限）；锁放开后本窗口重载，结果先存在本窗口 workspaceState，重载后（10 分钟内重新打开）按在线合并的同一套通知与去重说明每份合并了多少对话（“查看详情”逐份列出，以候选列表读到的项目名标识，没有时写“旧工作区历史”或“默认历史库”，再附位置与规模）、被拒或推迟的原因；引擎在会话开始时的空间预检不够、什么都没合并时，重载后说明没有进行及原因；协调没有进行（忙窗口等不到、有窗口保留、退避等）时本窗口不重载，说明原因（自动开始按原因只提示一次）。合并账本在配置根 `.limcode-runtime-merges/`：提交前记录插入行的证据集（`commits/<id>.json`：全部新增对话 id，加上内容派生领域以外每个领域首末各 50 个供诊断，对话多时其它领域每端收缩，让总数不超过 `RUNTIME_DATA_SET_MERGE_COMMIT_EVIDENCE_ROWS`＝2000，但每端至少首末各 1 个、对话全记，对话很多时总数会超过；另记这次事务新增与复用的行数 `insertedRows`/`reusedRows`），committing 视为未合并。同一事务另插一行这次提交专属的标记（`mergeCommitMarkerStep`：`CommandReceipt`，`source_kind = 'internal'`、`source_key = 'historical-merge-commit:<id>'`，conversation_id/turn_id 为 NULL；大库会话在最后一块之后追加），是否提交只看这一行（`mergeCommitCommitted`）：其它行都可能来自另一份与它重叠的来源（例如以前合并过彼此的库，另一个窗口先提交了同一批行，这次事务正因此整体回滚），内容派生身份还可能被其它窗口独立写入，都不能证明本次提交。标记在就是整份已提交：按证据集记下的新增与复用行数记为已合并（不是证据行数），证据里的新增对话只把当前库里实际存在的记入账本（之后删掉的由删除记录挡住；证据丢了或损坏也照样记为已合并，插入了哪些未知）；标记不在就是整份没提交，撤掉记录重新合并。数据目录迁移的合并模式不写账本也不写标记，它的目标是只有本进程在写的新根，仍按内容派生领域以外的行是否全在判定。每条记录按目标累积各次合并实际插入的对话 id（`mergedInto`，之后同一来源的记录都携带）；再次合并（明确请求、记录下来的请求、崩溃后按实测收敛的自动路径）时，其中现在目标里已不存在（用户删除）的对话连同它在来源里的子 Agent 对话（按 `ConversationDeletionControlPlane` 所用的来源链接）默认跳过：`skippedRows` 从这些对话出发，按外键、归属表 `SKIPPED_WITH`（模型请求的 Operation、投递、命令收据、上下文根与投影、效果与文件变更收据、进程链接与收据）和成员表 `SKIPPED_WITH_MEMBERS`（消息、进程、上下文节点与片段只在全部引用都被跳过时跳过；交互请求、看板频道与帖子有一个引用被跳过就跳过，与删除对话时一致）求闭包，整体不插，插入的行不引用被跳过的行；内容派生行照旧仍不存在才插；跨对话的协作历史与删除对话时一样保留；结果（`skippedConversations`，按删除的对话计）、通知与日志报出跳过的数量。闭包对同一来源身份的全部记录取并集（本地库自己的、外来 id 的，以及同一候选 id 被新化身覆盖、被拒记账时按来源身份保留下来的旧身份闭包 `formerMergedInto`），目标按“当前库及其延续身份”算。删除对话在删除事务提交之前（全部 owner 已固定，`ConversationDeletionControlPlane.delete` 的 `beforeCommit`）把这次删除的整棵子树的对话 id 持久记进配置根 `.limcode-runtime-merges/deleted-conversations/<dataSetId>.<rootInstanceId>/<时间>-<随机8位>.json`（`runtimeMergeTombstones.ts`；每次删除一个文件：临时文件、fsync、rename、目录 fsync；内容 `{ version: 1, conversationIds, deletedAt }`），写不成照常删除并如实警告“没能记下删除记录，以后合并旧拷贝时这些对话可能会回来”，删除命令失败而对话还在（删除没有提交）时撤回它写下的记录；每次合并（在线、独占兜底、大库会话及其准备与试算、外来来源、数据目录迁移的合并模式）都按目标及其延续身份、也按来源自己及其延续身份（本地来源在它的配置根读延续，外来来源按当前配置根记下的）读这些删除记录（来源的较早拷贝里还有本版本在来源里删掉的对话），现在目标里不存在的与闭包同样连同依附的行跳过；删除记录或延续记录读不出、名字或格式不认识（多出字段、别的版本、链接、目录）时合并推迟（`runtime-merge-records-unreadable`），从不当作没有删除，未写完的临时文件与非 `.json` 文件不算记录。身份延续 `aliases/<dataSetId>.<rootInstanceId>.json`（`{ version: 1, continues: [{ dataSetId, rootInstanceId, relocationId, at }] }`，由数据目录迁移写入、写入方展开链）表示这个库延续了列出的旧身份、旧身份的内容已并入它：每个本地库（当前库和其它本地库）延续的身份都算作它的旧身份：这些身份的外来拷贝按那个库的旧拷贝拒绝（原因与列表写明是哪个库迁移数据目录之前的那一份），同身份的本地候选也拒绝（`runtime-data-set-merge-continued-identity`，迁移本身除外），那个库的延续记录读不出时推迟；本地来源的闭包也按它延续的旧身份读；清理备份不认延续身份，这类拷贝走覆盖证明。本版本之前删除的对话没有删除记录，不在闭包里的会随更早版本的拷贝回来，外来库的确认框如实写明。committing 记录带着它替换的记录（`replaced`）：事务失败后读到标记不在（worker 报事务出错时 SQLite 已回滚；事务报错后仍读标记，是因为提交之后的步骤出错也会报错）、或崩溃后下次启动读到标记不在时，原样放回（`restoreRuntimeDataSetMergeLedgerRecord`，连同 `updatedAt` 这一判定时间，选源据此与请求时间比较；上次合并 `lastMerged` 也随之保留），读不了（worker 已退出、应答丢失）才留给下次启动收敛。收尾时要收尾的 id、收尾数与最早的收尾前备份位置记在账本 `finalizations/`（收尾前先写，结束时按实际状态再写一次）。这条记录只随一个结果说明一次：合并成功或发现已合并的结果在 admission 内取走它（`takeFinalized`；其它窗口已报告过就不再带上，读到过它的窗口也一样），被拒的结果写进原因后删除；一次尝试收尾后没有以这些结果结束（之后推迟，或收尾后收到停止——此时按推迟处理而不是静默停止）就留给下次，下次的结果与文案如实带上（“之前一次合并时已把……按“中止”收尾”，冲突文案写“当前库没有改动”）。只有来源自身的确定性问题记为失败（结构、指纹、完整性、行不符合当前格式、正文缺失或摘要不符、未完成恢复、epoch 不支持、升级的非暂时性失败、与当前库是同一数据集），受阻只用于未完成工作、冲突、当前库不接受的数据（`runtime-data-set-merge-invariant`，见上）、目标正文损坏与 `too-large`；目标关闭、窗口关闭、I/O、空间、权限、worker 或内部异常（包括引擎自身的 RangeError）一律推迟、不入账（大库会话里 worker 因数据本身拒绝写入的除外）；事务提交之后，写合并记录、释放锁或结束独占维护出错只记日志，结果仍是已合并（没写成的 committing 记录下次启动按标记收敛）；每个来源开始前、规划前、收尾前与提交前检查 `shouldContinue`，停止时什么都不记。各结果按来源内容记录（全部表全部行的摘要，由 worker 在私有副本上计算，账本 `fingerprints/` 按确切文件状态缓存；WAL 检查点、原样复制或恢复、只打开不写入都不算变化），来源之后变化时显示“合并后有新变化”并可明确重新合并；内容读不出来（例如私有副本所在的临时目录空间不足）时显示“无法读取”（`sourceUnreadable`），不当成有变化，仍可明确合并；“历史与存储管理”读取非当前库（未命中缓存的内容指纹、对话数与最后活动）都经 `withRuntimeDataSetReadClaims` 在该库的 admission 与 maintenance 之内复制，本进程可能打开着的库绝不在锁外复制它的文件；之后的明确合并受阻、失败或中断时记录携带上次成功合并（`lastMerged`），状态与删除警告据此判断，也仍只按明确请求合并；没有任何合并状态的来源（从未入账、只被推迟过、等待自动合并），删除确认写明它还没有合并到当前库；删除合并目标不会让来源再次自动合并。合并进来的对话在任何窗口都不会被恢复、投递或继续执行；不切换选择。启动提示按原因在每个配置根累积（VS Code globalState），只有重新评估过的来源才清除旧原因，用户明确请求的结果总是提示；合并与“已合并，没有新内容”的通知和日志写明收尾的中断任务数、“另有 N 条排队未发送的消息已取消”和在当前库删除过、没有再合并回来的对话数（跳过的是当前库的删除记录与闭包，不只是从这个库合并进来的）。

备份清理（`runtimeBackupCleanup.ts`，`migration.json#backupCleanup`）只删能证明完整存在于本地库的副本：处理升级前备份（`epoch-migration-backups/`）、合并前备份（`merge-backups/`）、合并来源的收尾前备份（`merge-source-backups/`）与核验通过的外来历史库（见本段后半），证明它的本地库（备份是它所在控制根的库）要有它的全部 Conversation 与 MessageRevision id、`RUNTIME_HISTORY_RECORD_DOMAINS` 里其它历史记录的 id（轮次与结束记录、工具调用与结果、交给模型的工具结果、工具产物、文件修改及明细与确认、交互请求与回答、进程与输出、附件与关联、上下文压缩、子任务、协作消息；模块加载时核对每一个都没有 delete 变更，所以只随 Conversation 删除或从不删除，合并按原 id 带过去）和它引用的每个正文（那个库有这个 ContentObject，且其 CAS 在 storage key 处有同样大小的普通文件，只 lstat；ContentObject 只在重置时删除），并且显示一致：副本里显示的每条消息（`deleted_at IS NULL` 的当前版本）在那个库里也显示同一个当前版本。对话是硬删除、无法证明是用户删的，缺对话、版本、记录或正文的一律保留；只是显示不一致的（那个库里的消息被删除、编辑或重试替换——软删行与旧版本仍在，能证明是用户操作）可删但单列“含你后来删除或替换的内容”、写明条数、默认不勾选，只在用户明确勾选后删除；全部一致的才说“内容已完整在…里”。库名与历史管理一致（当前库、项目名、旧工作区历史、默认历史库），不写 id。副本在 facts worker 里读私有拷贝（id 与显示集合直接从表读、每张表不经索引各自读出再连接，索引缺项的副本不会显得历史更少；按确切文件状态缓存在配置根 `.limcode-runtime-merges/coverage/`，gzip 压缩，不是权威；副本只记正文 id，正文按证明它的库自己的记录核对，本地库另记正文位置；列出之后只留删除时要重查的对话与显示集合）；当前库只经它自己的 worker reader 按 250 个 id 一批查询（显示集合每条消息查 Message 与 MessageCurrentRevisionLink），遵守 POSIX 锁规则，本进程从不另开或关闭它的 SQLite、-wal、-shm，也不开关与它是同一个 inode 的文件：复制副本或其它本地库之前先按 dev:ino（只 stat，不开文件）与当前库和每个本地库的库文件、-wal、-shm 比较，是硬链接的一律不读、按历史保留；其它本地库在其控制根 maintenance 内复制，由 facts worker 读。升级前备份另须有精确 3/4→5、3/4/5→6、3/4/5/6→7 、3/4/5/6/7→8 或 3/4/5/6/7/8→9 的完成记录（已发布 0.0.15–0.0.21 在同一目录留下的 3→4 备份，完成记录 kind 相同、toEpoch 为 4，一律保留）、`nextBinding` 与现存库同一身份且现存库代数不低于它、升级完成满 7 天（取完成记录时间、目录名时间与完成记录文件 mtime/ctime 中最晚的；最晚的晚于现在按时间不可信保留）；合并前与收尾前备份的 `root-binding.json` 与现存库同一身份且代数不低于它，备份库内的 root_binding 行必须与保存的绑定一致。控制根有进行中的日志（pending 指针、升级、旧版 3→4 升级、cutover）或正在提交的合并、每个控制根最新一份满 1 小时的完整合并前备份和比它新的（合并前备份不持锁写入，本批没有事务用上的在批末不持锁删掉，不满 1 小时的因此不能顶替它；大库合并准备登记在 `preparing-backups/` 的目标备份，登记仍然有效或还没被会话用上时同样不能顶替它，合并会不论新旧删掉没用上的）、大库合并准备登记仍然有效或还没被用上的目标备份（登记读不了时合并前备份一律保留）、创建不满 1 小时（名字时间与目录修改时间取较晚的）的合并前备份、被尚未报告的 `finalizations/` 引用的来源备份、目录里有它的种类不会写的内容的（按种类逐项核对普通文件：库文件及其伴随文件、保存的绑定或升级记录、本清理的已核对标记；`.tmp` 普通文件算没写完，其它一律整份保留）一律保留；覆盖不了的按历史保留并写明缺什么；原因只写中文，技术原因只进日志（整个检查或删除失败时命令层也只写中文原因；时间按本地时间写到分钟）；读不了的目录（工作区 scope 目录、控制根或其中的备份目录）记进检查结果的问题、其中的备份按历史保留，检查照常完成。拷来目录整体（其中的设置、规则、技能）、归档目录里不是归档的条目、控制根旧格式 `backups/` 与 `.limcode-data-backups` 只列出。检查与删除都按写命令经写入闸门。删除只在两步确认（设置页 ConfirmPanel，第二步 danger）之后，在 configuration admission 与该控制根 maintenance 内（两处都发布“清理备份”的维护进行中标记）用同一口径重新核对文件状态、硬链接、现存库身份与代数、日志、最新一份与覆盖，改名前最后一步再比较一次目录（同一个目录而不是换上的链接，条目与文件状态不变），然后改名为 `<名>.deleting-<id>` 并再核一次覆盖与目录（合并、升级、重置都要 admission，与删除串行；删除对话、删改消息都不取锁，所以当前库经 reader 再查对话与显示一致，被替换的不能超出列出时的——其它记录只随对话删除、正文从不删除；其它库按文件状态），不通过或核对不了就改回原名并保留；通过才在目录里写入“已核对”标记并落盘（写明新名字、本配置根的路径与它的清理身份，即 `.limcode-runtime-merges/backup-cleanup-identity.json` 里第一次写标记时建的随机 token），再递归删除（只删真的目录、不经链接，标记最后删，删到一半也还是已核对的残留）；标记之后的失败报“没有删完”，从不报保留。崩溃留下的 `.deleting-*` 由下次清理在同样的锁内收尾：只有本安装写的标记删完，删到一半的绝不改回原名——本配置根写的（路径与身份都对），或迁移数据目录之后本安装离开过的数据目录（globalStatus `previousDataRoots`）写的（那里的清理身份仍与标记相同，或已随它最后一个库删除）；没有标记、旧版本写的或别处写的（拷来的目录、另一个安装）改回原名重新核对；标记或身份暂时读不了的这次不动它。仍有的窗口：最后一次核对到删除之间的毫秒里在别的窗口删掉的对话，按删除之后才删处理；合并前备份没有持久的“已被事务用过”标记，运行超过 1 小时、最后没用上自己备份的合并批次会在批末删掉那份已成为最新一份的备份。全程不跟随符号链接，路径按平台规则比较。外来历史库（`runtimeForeignHistory.ts` 发现与核验的当前与离开过的数据目录各 scope 的归档、这些目录旁拷来目录里的默认根、各 scope 与它们的归档）只处理核验通过的；可删须满足其一：与一个非当前本地库 dataSetId、rootInstanceId 相同且内容摘要（`runtimeDataSetContentDigest`，经合并账本的指纹缓存，在该库 maintenance 内读私有拷贝）相同，那个库的 id 与摘要读自同一份文件、正文都在它的 CAS 里——当前库没有安全的摘要途径（`RuntimeDatabase` 没有摘要接口，复制其文件会释放本进程的 POSIX 锁），与它同身份的拷贝只按覆盖核对——或它与它控制根里保留的每份备份按上面的口径被同一配置根下的某一个本地库覆盖（显示不一致的同样单列、默认不勾选）。删除单位是它的 located 控制根（归档整份；拷来目录只删其中被证明的库，拷来目录本身和其余内容永不删，删到没有库时结果写明其余内容保留）；控制根与数据根的条目按名字与类型逐项核对：有旧格式 `backups/`、非空的调试取证或进程输出暂存、诊断日志（不含对话内容，自己 7 天后删除）以外的诊断内容、不认识或类型不对的条目（`.tmp` 只认普通文件，声明目录只认确切的名字格式且只装声明记录与活动标记）、符号链接或特殊文件时整份保留，按覆盖证明时有未结束任务的也保留，它保留的备份按原规则逐份核对（目录内容按种类核对）。外来库的数据库与它保留的备份只经外来库模块的复制函数（复制前按 dev:ino 排除本进程可能持锁的库文件，前后文件状态一致）读私有拷贝，小记录按普通小文件读。它的外来声明（`.limcode-runtime-merges/foreign-claims/<id>`）在检查、删除与收尾时都不等待地取（`refuseWhenHeld`，持有者活着就立即放弃），被核验、合并或另一次清理持有时不删；打开着的只读查看在它的整个打开期间登记在当前配置根 `.limcode-runtime-merges/foreign-views/<id>/`（在外来声明内写入、关闭时撤销，记进程与起始身份），声明内看到存活的登记（已证明结束的清掉，读不懂的按在用）同样不删；本地库的摘要与 id 从不在外来声明里读（不在外来声明里取别的锁）。删除在 admission 与外来声明内确认没有查看、重新严格定位与核验、比较目录（每个目录按 dev:ino 与名字集合，正文库以外的文件按完整状态；正文对象只经 link() 发布一次、从不原地改写，证明也不依赖这份拷贝的正文，所以只比名字，不再遍历每个正文文件）、确认证明它的本地库身份与代数不变并复核覆盖，改名前最后一步再比较一次目录，改名、对新目录再核覆盖与目录、写带外来 id 的已核对标记并落盘，之后放开 admission，只在外来声明内递归删除；外来目录里只有被删那一份本身的改名、标记与删除；崩溃留下的在原处按发现规则找到，在 admission 与同一个外来声明内收尾（删除同样在放开 admission 之后）。两个安装共用同一个以前的数据目录时互不排斥（声明在各自的配置根），是已知限制。

多窗口独占维护（`runtimeExclusiveMaintenance.ts`，`migration.json#exclusiveMaintenance`）只用于用户发起的数据目录迁移、超大来源的兜底合并、大库会话（见上段）与离线 GC，不用于 epoch 升级。每个请求方写自己的请求文件（带操作键、给其它窗口看的原因与操作说明；每 2 秒刷新心跳，执行操作期间也刷新，超过 15 秒未刷新即被忽略，撤回时先标记为撤回再删除），按三阶段推进：prepare 时每个已登记窗口只回答就绪、忙或拒绝；全部就绪才进入 confirm，各窗口显示 5 秒倒计时后回答确认（普通操作可取消；用户已确认的操作用不可取消的倒计时或只提示；倒计时期间每 0.25 秒核对请求仍在等这个回答，请求撤回——其它窗口拒绝、答忙或超时——就立即关闭倒计时并提示“其它窗口的……这次没有进行，本窗口不重载。”；请求进入新一轮——发起方回到锁外后重新协调——时只悄悄关闭倒计时，新一轮会再问；只提示与等待模式的提前提示——“本窗口的任务结束后会自动重载”——每个请求只说一次、后续轮次不重复，请求没有进行就撤回、本窗口没有为它重载时同样补一句“……这次没有进行，本窗口不重载。”，倒计时已经说过的不再重复）；全部确认才进入 go 统一重载（每个窗口在 go 时查过自己空闲之后、重载之前再核对一次请求仍在，调用已经结束就不重载）。go 之前任何窗口都不让出。忙分两种原因、分别提示：有任务（本 Host 持有 ExecutionLease、有命令在执行——包括经写入门准入、仍在进行的写命令，例如清理备份的检查与删除，冻结与否都算——、所拥有对话的待办工作探测为真，或本窗口自己的独占维护请求正在进行——从用户同意那项操作起算：迁移数据目录与大库会话在可能要几分钟的准备阶段就登记（`holdExclusiveMaintenanceWork`），还没有请求文件时同样答忙、不让出）与正在使用（窗口有焦点）；用户已确认的操作（不可取消的倒计时或只提示）过了 prepare 只看任务不看焦点，用户点进倒计时的窗口不会让这一轮作废。请求方可传入自身忙碌检查，发起窗口自己的任务同样要等，准备、确认、让出期间与执行前都会检查；`beforeGo` 钩子在全部确认之后、发布 go 之前调用，调用方在其中先检查本窗口是否空闲，再冻结本窗口（冻结之后只做不会失败的事；数据目录命令的冻结从这里持续到操作结束：本窗口在入口——Facade 与命令路由——拒绝一切写入类命令，包括新消息、重试、编辑后运行、压缩、计划审批执行、改名、删除与设置，以及经 Facade 写入门的扩展命令（清理备份；历史与存储管理的合并到当前库、查看前就地升级旧历史库与删除其他历史库在入口与确认之后各查一次，对以前切换走的库的“全部合并”“保持分开”在回答与确认之后各查一次（拒绝时什么都不记，下次启动再问）；设置页的数据目录按钮在面板入口就拒绝），提示“正在<操作说明>，完成后再操作。”，查看与读取（包括查看存储占用、开发诊断）不受影响、输入框内容保留，不再认领新的对话执行（只执行冻结时已拥有的对话：其间打开面板接管的对话只做控制类收尾，不续跑、不准入排队输入）；冻结期间本窗口的忙只看冻结前已有的工作：冻结时仍在进行的写命令算忙，对话只看冻结时已持有的）；不空闲或钩子抛错（按本窗口忙处理）就在任何窗口重载之前退回锁外（等待模式）或放弃，冻结在锁内轮次结束时解除。两个请求方从不互等：窗口自己的请求进行期间对其它请求回答忙（“本窗口正在等待执行……”），从不让出；较新的请求（按 createdAt、再按 requestId）遇到较早的、等待中或已过 prepare 的请求时立即放弃并写明“另一个窗口先发起了……”（较早的请求是本窗口自己的，例如仍在等待的超大合并，则写“本窗口正在等待执行……，完成后再试”；两个请求是同一项工作——同一操作与操作键——时，较新的一方直接让先（只有较早的一方遇忙即放弃、仍在 prepare，而较新的一方会等待时例外：较新的一方不让先，较早的一方把它的窗口当忙、自己放弃，免得两边都没做），结果为 superseded“另一个窗口正在进行同一项维护（……），这次由它完成。”，不记退避，自动合并也不因此提示；窗口因自己的请求答忙时回应带上那项工作，较早的请求把为同一项工作答忙的窗口当作即将让出、按未回答等待，为其它维护答忙的原因单独写“N 个其它窗口正在进行自己的维护（……）”），让先的窗口在自己的请求结束前对那个请求的确认与让出先不回答；用户明确调用的请求这样让先之后，窗口若正是为它让先的那个请求重载，参与层把没有进行的原因带过重载（参与方选项 `windowState`，扩展传 workspaceState；窗口在保存之后 10 分钟内重新打开才有效，按扩展开始激活的时间判断，重新打开后等那项维护结束的时间不算），重新打开后提示一次；自动调用、其它结果与为别的请求重载都不带。有忙、拒绝、未登记的存活窗口（刚启动的窗口有与准备阶段超时相同的登记宽限；本版本窗口的运行时一打开就先登记为“正在打开”，参与方开始回答之前按忙——“N 个其它窗口正在打开”——对待，停在打开中超过 2 分钟才算未参与协作；启动身份只在登记与 Host liveness 两边都有时才比较，一次探测失败不会让本版本窗口被当成旧版本）或状态未知的窗口、超时或取消时放弃（取消只在 go 发布之前有效：之后其它窗口已在重载，任何取消都不再理会；调用方可以不给取消按钮，`cancellable: false`，数据目录命令进入协调后就是这样）；正在关闭或重载的窗口不是未登记的窗口：参与方 dispose 时把登记改写为“离开中”（带时间戳），扩展在运行时连同 Host liveness 关闭之后才删除登记（关闭失败就保持离开中），本次调用中回答过的窗口登记消失（较早的版本先注销）同样算离开中；请求方把离开中的窗口按缺席处理，不要求它回答或确认，锁外等它的 liveness 消失、锁内在执行前等它下线（从首次看到起最多 30 秒，超过则以 timed-out 放弃并如实说明），只剩离开中的窗口时不发布 go；结果区分 busy、declined、legacy-host、timed-out、cancelled、backoff、blocked 并附原因；锁内轮次用完时原因按最后一次实际的忙（发起窗口自身任务、其它窗口任务、正在使用）生成，只有发起窗口自身时写“准备期间本窗口一再变忙（最后一次：……）”，不提其它窗口。等待忙窗口只在锁外进行（`runExclusiveRuntimeMaintenance` 的 `whenBusy: 'wait'`，只用于用户发起的操作，有上限并提前按原因提示一次），期间其它窗口照常打开并加入；全部就绪后才通过调用方的 `withLocks` 取得 admission 与 maintenance，做一轮有时限的准备、确认、让出（8 秒 + 20 秒 + 30 秒）再执行操作；go 之前发现有窗口又变忙时放开锁回到锁外，最多 3 轮；go 之后任何窗口（或发起窗口自身）变忙都结束这次调用，不在同一调用里再来一轮（“已协调”只按 go 是否已发布判断，没有发布 go 就回锁外等待并如实写原因），因此一次操作里每个其它窗口最多重载一次。在线合并的兜底同样在锁外调用 `runExclusiveRuntimeMaintenance`，`withLocks` 取 admission 与目标 maintenance，锁内的操作只是来源复核与那一个事务：自动合并遇忙立即放弃（按操作键退避），用户明确请求的合并传 `whenBusy: 'wait'`、`ignoreBackoff: true`，其它窗口只收到提示；让出之后操作失败时，只有引擎判为受阻或失败的结果算确定性失败（`isDeterministicFailure`），把该键转为 blocked，锁内复核发现来源变化、写入出错等推迟结果只按键退避。`requestExclusiveRuntimeMaintenance` 只留给已经持锁的调用方，遇忙立即放弃。go 阶段遇忙放弃的代价：已经重载的窗口白白重载了一次，它们在 admission 上等请求方放手后重新打开，未发送的输入保留；之后的自动调用受冷却约束。每次放弃以及让出后操作失败都按操作键指数退避（5 分钟起，最长 6 小时，成功后清零）；调用方判定为确定性失败的把该键转为 blocked，只拦自动调用，用户明确的调用照常执行、成功后清除该键的 blocked 与退避，`clearExclusiveMaintenanceKey` 也可显式清除；操作键应包含“修好之后会改变”的身份（来源内容状态、目标目录身份），修好的问题因此自然成为新键。进入 go 时按操作记 10 分钟冷却，连同发起方 token：冷却不论操作键（数据目录命令的键带每次尝试的 id，换键、换目标都绕不开），自动调用和不带这个 token 的明确调用都被挡住；只有发起窗口里同一操作的再试越过它——参与层按操作名把 token 存进发起窗口的 workspaceState（数据目录命令显式传入 `windowState`），直到该操作完成，失败后重载也带着，自动作为 `requesterToken` 传入，再试时换目标也可以；被重载过的其它窗口不能马上反过来要求别人让出。冷却只在还有其它窗口要让出时检查；调用方可以先只读查询这次调用会不会被冷却、按键退避、blocked 或未参与协作的窗口（旧版本、状态不明，登记宽限与调用的准备超时相同，结果 legacy-host）挡住（`readExclusiveMaintenanceRefusal`，同一套规则，什么都不写），大库会话据此在倒计时、确认与任何准备之前就说明何时可以再试或要先重载、关闭哪个窗口；被挡住时原因写明大约多少分钟后（几点以后）可以再试，结果带 `retryAfter`。`ignoreBackoff` 必须每次调用显式传入，只用于用户那一次操作；原语从不根据持久状态推断它。请求方自己的窗口按 `requesterHostBootId`（否则按进程）跳过请求，需要离线时在操作内关闭自己的 Runtime。持有锁的请求方在锁内轮次与操作期间用 `withRuntimeMaintenanceActivity` 在所持每个锁目录内发布“维护进行中”标记（操作名、给用户看的说明、开始时间、阶段，操作可经 `reportStage` 更新；操作还可经 `reportExpectedEnd` 写入预计结束时间，写坏的值只丢掉这一项；旧版本数据集升级、合并来源收尾与清理备份的持锁作用域同样发布），每 2 秒刷新、随锁一起消失，只认当前持有者的 claim token；标记超过 15 秒未刷新只报告为没有进展，从不据此接管锁。重载后的窗口在 admission 上等待维护结束（轮询按当前持有者计：持有者的 claim token 一变就回到 50 毫秒，2 秒后 250 毫秒，10 秒后 1 秒，排队的多个窗口因此不会逐个晚 1 秒），等待超过约 1 秒时 VS Code 通知显示“另一个窗口正在……（已进行 N 秒），完成后自动打开；未发送的输入已保留”，打开外壳只显示不带秒数的原因、只在阶段变化时重画；拿到锁时（`onAcquired`，在打开运行时之前）通知立即收起、外壳不再显示等待原因，不与随后的选库框并存，之后再等别的锁时重新提示；持有方没有标记时中性地写“正在等待其它 LimCode 窗口释放数据目录”；标记带预计结束时间时，外壳与通知写“预计 HH:MM 前完成”，过了这个时间改写“比预计的慢，仍在进行”；当前持有者占用很久（没有标记 1 分钟、维护 10 分钟，从它的 claim token 首次出现起算；带预计结束时间且心跳正常的维护推迟到它已进行预计时长的 1.5 倍，不早于 10 分钟）或持有方心跳停止（立即，不推迟）时给出警告，只提供“继续等待 / 关闭窗口”，本窗口打开之后才点的按钮只说明已经打开、不关窗口，绝不越过锁打开。拿到 admission 后重读数据根，根已迁移就放开旧根改在新根上打开；未发送的输入、附件与打开的编辑（连同编辑起点的修订号）保存在 Webview 状态中（平时在最后一次改动约 0.25 秒后写入），清空或放弃恢复编辑时立即写入；参与方开始倒计时或提示时、以及重载之前经 Facade 的纯数据边界请每个面板立即写入（`composer.draft.save`，重载前留出 0.25 秒让写入落地），页面隐藏（pagehide）时也立即写入，重载后恢复（消息已被改过的编辑不恢复并只提示一次，仍在发送中的输入不再作为草稿恢复）。轮询中每个 (pid, 启动身份) 只做一次平台身份探测，之后只用 `kill(pid, 0)` 复查（探测失败得到的“无法确认”只记 5 秒，之后重新探测，一次失败不会让窗口一直不理某个请求方），登记参与方时只用 `kill(pid, 0)` 清理；执行前的最终判定仍不使用缓存，独占只以 Host liveness 证明，请求文件与维护进行中标记只是提示。崩溃请求方留下的请求与回应由下一次请求清理：回应目录只在清理前后两次列出请求时都没有对应请求、且 15 秒内没有写入时删除；清理失败只记日志，不覆盖结果。

历史升级入口只复用精确 epoch migrator，不调用含归档重置/空库初始化的通用 cutover coordinator，不改当前 selection，不注册历史 Host 或启动旧任务。既有对话、消息、附件及原 CAS 内容保留；需要转换的旧 Child Runtime continuation 仅在稳定 ID、回执、投递和旧 CAS 全部吻合时发布新内容并补 Link。备份路径和逐库失败原因可追踪。未知 schema、缺失备份或绑定冲突均拒绝；目录移动与跨平台备份恢复需要独立的来源认证与重新绑定流程，不能放宽原位升级检查。归档与拷来的目录走独立的只读认证流程（外来历史库，`runtimeForeignHistory.ts`，`authority.json#rootPolicy.foreignHistory`）：位置只由配置根加固定目录名和严格匹配的名字推导（located），身份只由指针、epoch 清单与 `root_binding` 行完全一致推导（recorded）；核验与本地候选同样严格，只把路径相等换成 recorded 路径自洽（`createRuntimeRootPaths(recorded.dataRootPath)` 且末两级为 `.limcode-runtime/active`），epoch 必须为当前 epoch（已发布 3/4/5/6/7/8 只在原位升级）；所有读取只经 located 路径和私有拷贝，recorded 路径只作身份栅栏与显示，从不访问；不建立 RootAuthority、不打开 RuntimeDatabase、不登记 Host、不收尾、不升级，外来目录中不写入任何文件（唯一的例外是清理备份删除经证明的外来库时对被删那一份本身的改名、已核对标记与删除），结果缓存与互斥声明在当前配置根 `.limcode-runtime-merges/foreign/`、`foreign-claims/`，打开着的只读查看在 `foreign-views/` 登记到关闭为止。外来库不重新绑定、不可切换为当前库；只在用户明确请求时合并进当前库（`runtimeForeignHistoryMerge.ts`，`migration.json#historicalMerge.foreignSourcePolicy`）：从准备到提交持有它在当前配置根的声明，提交前在声明内重新严格定位并复核指针、`root_binding`、epoch 清单、host-liveness 与各文件自核验以来的确切状态；快照与审计只在私有拷贝上，正文只复制、不硬链接，账本记录与指纹只在当前配置根；有未结束任务或与本地库、当前库延续的旧身份相同（旧拷贝，按可读的库名写明）时拒绝并写明原因，本地有库读不出时推迟，从不收尾、升级或做来源备份；提交后中断的合并只按账本与当前库收敛，不取声明、不定位它、不需要请求，清理备份在此之前保留它。数据目录迁移的合并模式同样按删除记录跳过，跳过了对话的旧库在删除旧目录时保留。迁移在合并之后把旧配置根的删除记录与合并账本带到新配置根（同名删除记录内容必须一致；目标已有同一候选 id 的账本记录时保留它，旧那条的闭包按来源身份并入），给每个身份变了的库写展开成一层的身份延续（目标原有的也保留），迁走的库的合并请求（保留期限）与收尾说明按新身份改写带走（外来历史库的请求改写成新目录找到它的位置，目标已有同一来源更新的请求时保留目标的），逐步记日志、写完核对，撤销与续撤照日志还原；读不出或矛盾时预检拒绝；合并进要迁走的库、旧目录还能收尾的未收尾提交也预检拒绝（先在旧目录打开窗口收尾）。“回到旧目录”切换之前把当前目录里记在延续身份下的删除一并记到旧目录的旧身份下（只影响以后的合并，旧目录原有的对话不删；记不下就不切换）。

数据目录迁移把未完成的工作原样带进新目录，旧目录的数据不变（`migration.json#dataRootRelocation`）；旧目录里这些工作不能被恢复第二次。迁移完成时，对每个真正迁走、带着未完成工作的库，在记来源指纹的同一份私有快照上用 `inventoryRelocatedWork` 列出会被自动恢复或执行的工作，写进旧目录“已迁走”标记的 `carriedWork`。这份标记是旧目录唯一的闸门：在同一准入内、切换指针之前写并 fsync，写不成就按切换前失败撤销整个迁移；撤销（包括续撤）去掉它（只动同一迁移 id 的，原有别的迁移的标记放回）；标记存在但读不懂时一律拒绝打开（`moved-notice-invalid`），从不当作没有标记；它所指的迁移在目标里还在进行、发起进程也没证明已结束时按 `relocating` 拒绝，目标记录读不出（不是不存在）时按读不出拒绝。本安装进行中记录所指、指针从没切换过去的迁移写下的标记，本安装不当作已迁走（它替换的标记这时已没有未收尾的库）；放弃那条记录时先按迁移 id 去掉标记、放回它替换的那份（`earlierNotice`）。迁入一个带“已迁走”标记的目录时，标记里还有没收尾的库就保留它（规划写明），都收尾了才去掉；合并模式因目标删过而跳过的对话没有迁走，不记进 `carriedWork`。切换指针之前目标记录持久写下 `switchingAt`：之后中断的迁移可能已经切换，其它安装不提供撤销。打开这样的库之前：用户没有同意就拒绝打开，运行时不打开（`moved-work`，三选一：在这里继续并把已迁走的任务按中止收尾、只切指针改用新目录、暂不打开）；发起安装“回到旧目录”的确认即同意。同意之后运行时打开时从构造起扣住运行时收敛（已批准的文件修改不派发），启动恢复、投递唤醒、进程扫描与对话接管都等收尾：在任何执行之前收尾（`settleRelocatedWork`，打开、收尾、放行在 `openSettlingRelocatedWork` 里），全部收尾、且经落盘屏障（`durabilityCheckpoint`）写回磁盘之后才记已收尾（只记关掉的数目，只认同一次迁移、只记一次）并放行，离线收尾同样；屏障失败按“收尾过程出错”留下；剩下任何一项都不放行：不记已收尾、保持同意，把这次留下的逐条记进标记（`left`），关掉运行时、本次打开失败（`moved-work-unsettled`），下次打开整库再收尾；收尾中途崩溃时同意保留，下次打开先续完，其间不执行任何工作。收尾只用现有控制面转换：Turn、排队消息、子 Agent 与待回答的交互走用户停止的转换；父 Turn 已完成的后台子 Agent 先按它自己面板的停止停下活动 Turn，排着续跑时再按子树中断取消（这时没有活动 Turn，不写终止请求，也就不发布答复）；迁走的结果用放弃转换，按原因码 `data-root-relocated` 落到各自已有的终态（`deliverySettlementSteps`，与删除对话共用，不新增状态，不重试，不开 Turn）：会开启回合的 pending Delivery 置 failed、它的 Wake 置 dead_letter、为它排队的 runtime_continuation 在同一事务里取消（`RuntimeDeliveryControlPlane.abandonPending`）；从未路由的子 Agent 答复在同一事务里路由到一条 attempt=1、已 failed、没有 Wake 的 Delivery（`createAbandoned`），恢复找到它就不再路由；已结束进程的完成派发置 dead_letter（`ProcessCompletionDeliveryControlPlane.abandonDispatch`）；排队的非普通消息（续写、运行时续跑、重试）取消（`TurnControlPlane.cancelQueuedIntent`）。两个放弃转换都在目标对话的控制类认领下进行：目标对话被另一个存活（或无法证明已死）的 Host 持有、存活 Host 认领且未过期的 Wake 或派发、仍在活动的目标 Turn 都属于存活宿主，原样留下并记为 live（这次不放行），与投递扫描不碰别的窗口持有的对话一致；持有或认领它的 Host 已死时照常放弃。收尾会带出新工作（请求的投递全部失败后，请求方收到“没人会回答”的回复，这条回复会开启回合），所以按轮进行：每轮之后先让协作收敛（`CollaborationControlPlane.reconcile`），再在运行时里重新盘点整个库（`RuntimeDatabase.relocatedWorkInventory`），新出现的工作按同样的顺序收尾（轮间的收敛与盘点有界重试 3 次，仍失败记为这一轮 `failed`），最多 5 轮，之后仍出现的记为 `rounds_exhausted`；这些与 `needs_human`、`live` 一样都不放行。没有“只报告再放行”的类别：打开前的提示只说明全部收尾之前不执行、收尾不了就不打开，剩下什么在收尾之后才知道，由拒绝打开的提示逐条列出；收尾本身意外出错（不是某一项失败）同样不放行，记一条“收尾过程出错”的剩余项。从还留着这种标记、其中有没收尾的库的目录再迁移时，那些库不能再被迁走（它们迁走的工作会在两个新目录里各执行一次，新标记也会顶掉旧目录里拦着它们的那份）：规划逐库列出（项目名、对话），标记读不出或读不懂、库读不出来时拒绝迁移；确认框只给“先把这些任务按中止收尾，再迁移”，选了即同意（只限确认框列出的，之后才出现的按“发生了变化”拒绝），由迁移在独占阶段、写目标之前按这些库各自打开时的收尾离线收尾（`settleEarlierMovedWorkOffline`：扣住收敛、从不恢复，模型、工具、MCP、编译回合一律拒绝），收尾不了就按切换前失败撤销并逐条说明；没选就不迁移。

## 18. 失败原则

- SQLite 不可用：关闭 Runtime capability 并显示真实错误；
- CAS 缺失：报告 integrity error，不返回空正文；
- Effect 已 dispatch 但无法确认：`outcome_unknown`；
- wrapper 不可达且无 valid receipt：`outcome_unknown`；
- Provider 临时错误：仅按有限、可见、可取消策略 retry；
- Client patch 不适用：snapshot-required/重取 snapshot；
- Delivery target 已删除：InboxItem 保留，Delivery failed(reason=target-gone)；产生答复的子对话被用户删除而父对话保留时，父对话还没接收的答复 Delivery failed(reason=source-gone)，但答复已投给正在运行的父 Turn（未过最终输出栅栏）时，改为把删除通知作为这条投递的运行时输入注入（Delivery consumed，内容为 `application/vnd.limcode.child-answer-source-deleted+json`，模型看到的是 child_failure 与通知文字，不含答复），父 Turn 已接收但还没吸收的那条运行时输入改用同样的通知内容，为 failed(source-gone) 的答复排队的父对话续跑同一事务取消；数据目录迁移后旧目录收尾迁走的结果：Delivery failed(reason=data-root-relocated)，Wake 与进程完成派发 dead_letter（last_error=data-root-relocated），界面显示“数据目录已迁移，未送达”；
- 不吞错、不伪造成功/失败、不改走旧文件 writer。


### 历史残留的删除、检查与修复

进程等待、停止收敛、spool 清理和完成通知共用完整的持久终态证据校验：成功必须退出码为 0，失败必须非零退出码或非空退出信号，退出码和信号只能存在一个；未知结果二者均为空。Process 的状态、非空 completed_at、nonce 和启动身份必须与回执匹配。等待和通知从同一读快照取 Process 与回执；通知正文使用已核实的 Process.completed_at，创建通知的写事务再次断言已核验字段，不用收到回执的时间替代完成时间。

大库读取每扫描 250 条原始记录即让出并检查取消，包括全部被删除闭包跳过的区段；保留协作消息的来源序号顺序。按跳过闭包复查未完成工作时不把全部跳过 id 装进窗口线程的 Map：小步导出磁盘跳过索引，关闭私有快照 reader，再由审计 worker 用固定 TEMP 视图检查；worker 连接关闭且线程退出之后才重开 reader。此生命周期只属于独立、只读、没有事务或活跃 iterator 的私有快照，不得用于在线来源、目标或维护 writer。

`Operation.owner_kind/owner_id` 是软引用，`deletePolicy: cascade-with-owner` 不是数据库外键。writer 的 Conversation 删除（包括按唯一键删除）在同一事务里先按该对话的 Turn/ModelRequest 精确找出模型请求所属的 Operation，要求请求已终态且聚合完整，再删除 Operation（Attempt 随真实外键级联），最后由 Conversation 级联删除 Turn/ModelRequest。不能依赖声明文字自动级联，也不能泛化为清理所有失去软引用的领域：Process、EffectReceipt 等保留历史仍按原合同保留。任何后续断言失败整笔回滚。

历史合并的进程准入根据持久证据与后续工作，而非仅按状态枚举排除：`outcome_unknown` 是已经结束观测但结果未知，不是“运行中”，更不代表子进程已被证明退出。匹配的 ProcessReceipt（nonce、启动身份、结果和退出元组）、completed_at、没有待完成操作/通知以及输出完整登记时可按原状态导入；缺回执、身份不匹配、状态矛盾或待处理工作仍拒绝。合并从不把它改成 exited，不发送旧结束通知或重新启动进程。数据目录迁移保留原来的较严策略，不因历史展示可合并而允许未知进程迁走。

普通合并、大库准备与整库分批复制使用共享 `MergeAggregatePreflight`，检查本次实际触及的模型聚合：新请求、模型所属 Operation、Attempt 与模型流记录双向确定请求 id，按删除跳过闭包过滤来源，与当前库自己 worker 在一致读快照中的关联行组成有效聚合。请求 id 存在独立连接的磁盘 TEMP 表、页缓存受限，每次只取 64 个目标聚合、每个只保留能证明超限的有界行数，不能向正在 iterate 的来源连接写 TEMP 表。仍在最终 writer 提交时复核。只有带 `RUNTIME_DATA_INVARIANT` 的数据断言或 SQLite 约束归为确定性受阻；域与记录 id 可跨 worker 边界传回，其它执行器、I/O 或目标状态失败继续按推迟。普通在线合并记录规划时目标 writer 的本地提交序号与 external data_version，提交拒绝后目标有过任何本地或外部提交时先按并发变化推迟、不记永久受阻，防止另一窗口抢先合并同一行产生的唯一键冲突被误判为来源损坏。`runtimeMergeValidation.ts` 的日期化规则标识只使受影响的派生拒绝与审计缓存失效（包括外来历史库的审计缓存），不改变内容指纹，不删除提交记录、删除记录、mergedInto 闭包或恢复凭据。

“历史与存储管理 → 检查并修复历史残留”（`runtimeHistoryRepair.ts`）是独立的用户操作，不是合库的静默兜底。只接受本地非当前、Host 和旧版 owner 均离线、无未完成恢复且精确核验为当前 epoch 的库；拒绝共享 inode/硬链接、符号链接、不完整结构与涉及该库的 committing 合并。只读检查通过私有快照审计 worker 完成，不备份、不启动 Runtime、不改源库；现存请求聚合异常、非终态孤立操作、保留效果或结果暂停依赖、不能匹配的进程结束证据均报告而不猜测修复。明确确认后才经写入闸门和维护生命周期：按完整内容摘要复核计划，先查备份与修复 WAL 空间（数据库与 WAL 大小之和的两倍加 64 MiB），通过 SQLite Backup API 备份、核对摘要并 fsync 数据库/目录，在控制根 `history-repair-backups/<时间>-<修复UUID>/` 保存 RootBinding 与 prepared 日志；再由私有维护实例的固定 worker 操作，以 synchronous=FULL 的单事务清理父请求缺失且没有保留依赖的完整终态 Operation/Attempt，并仅凭匹配的既有未知结果回执，将误改成 exited 的 Process 恢复为 outcome_unknown。实际修改前再次核对内容摘要；事务内逐表保护投影摘要证明除精确清理的元数据与纠正的单列状态外全部原记录不变，包含消息修订、当前版本、成员关系、正文与附件元数据；CAS 文件不改动，完整性核验不通过整笔回滚。没有需要修复的记录不备份；任一不安全记录使整份拒绝。

修复事务同笔写专属 CommandReceipt（`historical-repair:<UUID>:<计划摘要>`）；库内标记是是否提交的唯一证明，库外 completed 日志不作提交依据。备份后取消或崩溃未改源数据；提交后写完成记录失败仍报告已提交，下次只读检查按标记显示实际结果，同一计划重入不重复删除、也不重复备份。修复备份不纳入自动备份清理。修复不改当前选择、不重建缺失父记录、不伪造退出码、不调用模型/工具、不清合库账本；修复与之后合库分别报告，修复过来源之后不得宣称两边从未改动。修复当前库中的历史残留须先切换到另一库并让本库离线；外来只读历史不原地修复。
