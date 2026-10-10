# AGENTS.md

本文件是 Limcode Test 项目后续开发时 AI Agent / 开发者需要遵守的架构准则。项目由 [lurenxing628](https://github.com/lurenxing628) 独立维护，仓库地址为 <https://github.com/lurenxing628/limcode-test>。重点是：**ECS 数据、协议、effect、存储都要保持领域对象解耦**。当前准则来自 Agent 与 Conversation 解耦改造经验。

当前生产入口是 `vscode/extension.ts → VscodeReliableKernelApplicationFacade → VscodeReliableKernelProductRuntime → ReliableKernelApplication`。Runtime 生命周期与提交权威由可靠内核和 SQLite worker 持有，Client Feed 直接投影已提交事实；`backend/world` 中仍复用部分领域类型、工具声明与 prompt helper，但旧 ECS World/System 循环不是生产执行器。下文 ECS 示例表达领域解耦准则，不得据此恢复旧运行 writer。

提交消息只写简明中文标题，不添加 `feat:`、`fix:` 等类型前缀，不使用晦涩说法，也不写正文。每个提交只表达一个完整改动。

## 1. 总原则

本项目由个人维护，默认采用最小必要实现。严禁没有实际问题依据的冗余防护、层层兜底和重复校验，尤其不要为诊断或重复读取反复计算 SHA256、扫描历史正文。优先复用已有身份、事务边界和已验证事实，不重复实现同一道检查。

### 1.0 兼容原则

当前项目仍然处于开发模式，因此不要对旧格式有任何兜底，也不需要保留旧功能代码的兼容和体验，也不需要写什么协议v1，v2等之类的运行时内部版本号，全面使用新格式新功能更优秀的代码。

允许机器合同使用日期化`planRevision/contractRevision`、密码学domain separator或单一Runtime schema epoch来标识当前定义；这些标识不得用于运行时版本协商、旧格式fallback或维护未发布格式的通用 migration 链。当前 Runtime epoch 为 6。已发布 epoch 5（v0.0.24–v0.0.36）的 107 个领域、metadata DDL 和 trigger 由独立历史描述与摘要固定，不能在原 epoch 内改定义；开发期 main 上依次出现过的 epoch 6–10 从未发布，已合并为一次 5→6 升级，不保留它们的描述、journal 或升级路径。epoch 6 在 epoch 5 之上新增 RuntimeDeliveryTimelineLink、CollaborationSendTimelineLink、TimelineImportProvenance、RuntimeDeliveryAnswerPresentation 四张时间线关系表，以及 ConversationContextHandleState 当前指针与 ContextRootHandleCatalog 不可变根目录两个独立领域，共 113 个领域；句柄作用域为 Conversation、Context root 与显式 provenance_revision，绝不合并已丢弃重试分支。离线升级只为已有 Conversation 的确切当前 head 插入 pending、revision=0、provenance_revision=0、content_object_id=NULL、requires_native_reset=1 的标记，这一步不读历史正文、不重建目录；随后只沿选中根的实际 occurrence/压缩来源以有界、可恢复的 CAS 检查点重建。普通读只读当前目录；重试、编辑、删除与切回旧根原子恢复同代前缀快照，缺失的旧作用域显式重建一次。请求/pre-wire 私有分配仅随实际 Context admission 发布；未使用的编号只保留 high-water，不成为跨分支映射。为保留已发布用户的对话，精确支持版本 0.0.10–0.0.14 的 epoch 3、0.0.15–0.0.21 的 epoch 4 和 0.0.24–0.0.36 的 epoch 5 离线升级到 epoch 6：数据库打开前核对完整 table/index/trigger/manifest/RootBinding 指纹，要求其它 Host 离线，使用 SQLite Backup API 持久备份，通过 pending pointer、单事务和 durable journal 向前恢复；旧版中断的 3→4 与 3/4→5 pending/journal 经精确核验后先收敛；新的升级只写 epoch-to-6 journal，旧 journal 的目标仍为原来的 epoch；原 Conversation、Message、附件与 CAS 保留。epoch 3 的旧 Child Runtime continuation、epoch 4 精确缺少 RuntimeDeliveryIntentLink 的前驱，仅在身份与内容全部严格匹配时转换。不允许由其它缺表、字段或 digest 推导前驱。未知结构漂移和不受支持的旧 epoch 保持原根不变并 fail closed，绝不自动换成空库；用户显式归档重置另走独立入口。epoch 6 同时是紧凑普通 catalog-reference recipe、冻结工具定义 toolsReference 配方与新写入的至多 8192 字节 packed small-CAS 的全数据集准入栅栏：这些写法只用于新写入，升级保留每一条既有领域行、内联配方与 loose CAS 的原字节，不在启动时打包旧正文；旧 epoch 5 reader 在打开时拒绝 epoch 6，仍存活或身份未知的旧 Host 阻止离线升级。旧内联工具配方仍按原冻结字节读取，新配方的工具 CAS 引用在复制与合库时随全部登记正文保留。CAS 小正文存储只在准入 6 后按需建立，缺失是正常的旧库状态，已有未知或损坏的存储不可静默替换。当前 epoch 内任何 table/index/trigger/manifest/RootBinding 漂移也 fail closed，不补表、不修 metadata。

已发布 epoch 3/4/5 的备份升级自动执行，不要求用户点击单独升级命令或确认：当前根仍在 Runtime 打开前升级，其余旧根在当前 Runtime 就绪后逐库处理，查看旧历史时补做。每份目标必须离线并独立核验；其他正常数据集可继续使用。失败逐库报告，禁止隐式切换选择、启动非当前旧任务或把异常来源替换为空库；数据集合并只能按下一段的历史合并合同执行。候选发现可分别返回可用项和错误，任何来源的实际打开/升级仍必须严格通过原有身份与指纹合同。

单一历史库：一个配置根只有一个固定当前库，工作区只作为执行上下文。不提供选库、切换、保留分库或删除其它库入口。没有选择文件时优先使用健康的固定根，否则选可安全升级的最近旧根；所有可检查候选都不合格时，先在离线边界内原样归档不可用固定根，再建立默认根，并把旧来源登记为 pending 或 residual。不可读路径、符号链接、活跃或身份不明 Host 不可绕过；已有选择损坏或已初始化根丢失仍拒绝打开，不隐式改选。旧安装的选择修订号和保留标记只读容忍，保留标记不阻止收敛。

收敛只使用无期限 pending 和 residual 登记，不再读写 requests、prompts、过期时间或保留策略。后台逐来源合并，超出在线上限的等待“立即合并全部”，不后台发起独占协调。明确合并先经正常 Runtime 入口在线处理小来源，仅超出在线上限的来源进入准备与流式后端，复用独占协调、冻结新工作、保存输入、关闭 Runtime、取消与重载，不保留会话适配、估时、速率或结果缓存。来源和目标相同且内容未变的完整合并结果可跳过，明确操作仍报告“没有新内容”；partial 仅在后台复用，明确重新核验会重查行数据与正文。

合并后端的安全边界保持：当前库只经自身 Runtime writer/reader；其它库的快照在各自维护声明内生成，外来库在外来声明内经 located 路径读取，声明在配置准入之外取得。选源锁内只读账本、登记和确切文件状态缓存；缓存未命中需要内容时在锁外准备私有快照，不能在窗口线程反复读整库。同一进程的合并批次串行，目标提交前复核被复用行和身份栅栏。正文传输、空间检查与备份先于提交；事务同步落盘后才记成功账本，没有新增行也完成持久屏障。committing 按数据库提交凭据恢复，指向其它目标的记录不得覆盖；读不出的记录暂停自动合并，未知新状态不改写。删除闭包、身份延续和已合并对话集合随迁移保留，删掉的对话不得因旧拷贝或再次合并复活。冲突、缺正文及未完成工作的剔除按对话归属和依赖闭包进行；只插入安全部分，partial 与 merged 独立，残留保留且可只读查看。源任务的中止收尾必须有明确同意并先备份，外来来源不收尾、不升级原件；预检、提交与恢复具体合同以 migration.json、领域合同和相应故障测试为准。

备份清理：普通升级／合并／来源收尾备份仅由当前库的读取线程证明历史记录、正文和可见消息覆盖，不再扫描其它本地库作覆盖证明。保留原有升级宽限、最新合并备份、未完成日志、收尾引用、链接与未知内容保护；显示已被替换的消息单列且默认不勾选。已合并来源单独一类：最新账本必须是 merged、目标为当前选择、来源确切文件状态的已缓存指纹仍匹配；缓存失效先重新合并，不为清理重新扫描历史正文。pending、residual、partial、committing、含有因删除记录而跳过的对话、独立嵌套备份、调试取证、进程输出、未知内容、符号链接和特殊文件均保留。本地来源在配置准入、自己的 maintenance 与 Host 离线检查下删除；本地与外来来源均保留正在打开的只读查看；外来来源使用不等待的外来声明。改名前后复核登记、账本、选择与目录状态，持久写已核对标记后才能删除；未核对残留恢复原名，已核对的中断删除按原声明继续，标记最后删除。不可因释放声明失败把实际已删除报告成保留。残留列表不提供删除操作。

外来历史后端永久保留以支持直接从已发布版本升级。发现、身份核验、原位置定位、私有快照升级、只读查看登记与合并声明仍有效；入口收敛到待合并与残留列表，不恢复单独外来库管理界面。recorded RootBinding 描述原身份，所有物理 IO 只用经核验的 located 路径，不访问原机器路径、不跟随链接、不原地修改来源。数据库私有复制避免接触当前 Runtime 的同 inode 文件，已发布 epoch 3/4/5 只在私有副本中升级；旧来源不会恢复执行任务。与本地库同身份的旧拷贝按身份延续和删除闭包判定，不能伪装成新来源。声明、缓存和查看登记写在当前配置根；外来原件只有明确清理已合并来源时才可按删除协议改名、标记与移除。

数据目录迁移只迁当前库与登记的设置、全局规则和技能，不整体复制配置目录，也不为其它来源新建运行库。非当前来源原位保留，以 located pending/residual 登记带到新目录；完成记录的 migrated 和 carriedWork 只包含真正迁入的当前库，携带引用不构成删除旧来源的依据。连续迁移保持来源指向其真实旧位置。目标为拷来的目录或用户文件时保留原位、提示选择子目录，不自动改名挪开；已有旧迁移中断的恢复仍能找回先前归档。

当前库迁移保留在线 CAS 预复制、独占阶段冻结与关闭、接收库事务合并／新根复制、空间估算、持久撤销日志、配置逐项核对及最后切换指针；失败先按日志撤销，不能覆盖目标后续写入。删除记录、身份延续、合并闭包、pending、residual、收尾与同意记录随同一日志携带并核对。以前迁走但未收尾的工作按既有明确同意流程处理，不能在新旧目录重复执行。旧目录默认保留，删除只基于完成记录证明实际迁入且未变的内容；未迁入来源和独立归档保留。回到旧目录前带回适用的删除记录并使原完成记录失效。

多窗口执行资格（`docs/architecture/reliable-kernel/01-invariants-and-authority.md` §2.1）：对话的执行（调用模型、执行工具、推进 Turn、准入排队输入、投递续跑）只交给服务它的窗口；控制类操作（停止、删除、改名、记录回答或审批）任何窗口都能做，不合格窗口做完立即交还归属与租约。每个活动 Turn 和排队 TurnIntent 按自己冻结的工作环境定位：冻结的不是项目自身的环境时，只要求该环境在本窗口可用，不要求项目打开；冻结的是项目自身环境时仍要求项目匹配。新输入、压缩与投递续跑按新 Turn 将冻结的环境判断，入口、准入与投递唤醒必须用同一判定，维护 Turn 实际冻结的内容必须与入口批准的一致。不合格窗口交还执行租约按它持有的租约行进行，不看是否过期，交还前先等本窗口这个 Turn 的在途 native 调用写完回执；Phase D 从不把派发宿主仍存活的效果记为结果未知。认领与保留归属都以本窗口能执行它要做或保留的那项工作为准：空闲对话的待处理投递按续跑所继承的源 Turn 冻结环境放置，唤醒因本窗口不能执行而未确认时交还归属，执行租约在另一存活宿主手里的工作不让本窗口保留归属。只有用户明确停止，并且执行宿主已被进程身份证明死亡时，才把核对不了的已派发效果标为 `outcome_unknown`、把已派发的子 Agent 派生记为已派生；自动路径（恢复扫描、子 Agent 调度）从不这样标记。资格只是宿主本地筛选，归属记录、`ExecutionLease` 与栅栏仍是唯一权威。

删除对话（`conversationDeleteCommand.ts`，删除范围是该对话加它的整棵子 Agent 树）先停止、再收尾、再删除，不因还有任务在跑而拒绝。每一轮先取消范围内排队的 TurnIntent（`cancelGuidanceForDeletion`，普通消息与续写、运行时续跑、重试都取消，子 Agent 续跑随谱系中断取消；按修订号 CAS，不需要对话归属），全部取消落地之前不停任何 Turn，结束的 Turn 因此没有排队消息可准入，本窗口的 Runner 在删除期间也不准入范围内的排队意图；再写各活动 Turn 的持久停止请求，然后中断有工作的子 Agent（外层优先、带子树，每次重发用新的来源键；被删的是父 Turn 已完成的后台子 Agent 时，它的活动 Turn 按它自己面板的停止停下，不发布中断答复，父对话因此不开续跑），再执行各 Turn 的停止，父 Turn 的停止请求与子树中断在同一轮写入；运行中的后台进程直接写进程的停止请求文件（有 nonce、指纹与 PID 复用防护，不需要对话归属，另一个存活窗口持有对话也能停）。这些都走现有的用户停止路径，原因写“用户删除对话”（被删的是子对话本身时，父对话看到“用户删除子任务对话”）；存活的 owner 自己执行 Turn 的停止，owner 已死时走死宿主与 `outcome_unknown` 路径，不另造路径。删除进行期间，本窗口不在删除范围内开续跑 Turn（内存标记，删除结束即释放），被停掉的后台进程的结束通知因此不会调用模型；持有对话的另一个存活窗口仍可能为它开一次续跑，删除随即停下它。只删子对话、它的答复范围外正在运行的父 Turn 还没接收时，删除不等父 Turn：答复还是投给父 Turn 的 pending 投递，删除事务把它换成运行时输入“子任务对话已被用户删除，它的答复不会再送达。”交给父 Turn（投递置 consumed，内容只有通知与子任务标题，不含已删子任务的答复）；父 Turn 已接收（投递 consumed）但还没吸收进上下文的，删除事务把那条待吸收输入的内容换成同样的通知；父 Turn 吸收时发现答复记录已随子对话删除（例如删除没替换输入），就跳过这条输入，不卡住父 Turn。停止最多等 60 秒，进度通知按原因显示：正在停止、在等另一个窗口（写明进程号）释放对话；停不下来就不删，照实说明哪个任务在哪个窗口没停下，并区分“已发出停止请求”“没能发出停止请求”和“对话被另一个窗口占用”，停下或释放后再删一次；侧栏以警告样式显示没删完。删除事务再收尾投递：投给范围内对话的 pending 投递置 failed(target-gone)；只删子对话时，父对话对它的等待以“用户删除子任务对话”取消（父 Turn 在跑就拿这个结果继续），父对话空闲时它还没接收的答复置 failed(source-gone)，为它排队的父对话续跑同一事务取消；相关唤醒和进程完成派发置 dead_letter（这些步骤在 `deliverySettlementSteps`，数据目录迁移后旧目录的收尾复用它们，原因码是 `data-root-relocated`）。删除等待期间的盘点只读删除范围；子调度的答复扫描遇到随对话删除的子 Agent 就跳过它，Runner 丢弃 Turn 已被删除的延迟恢复候选。删除事务本身仍拒绝活动工作（`ConversationDeletionBlockedError`），只作最后防护。删除事务提交之前（`beforeCommit`，事务要删的正是这些）把这次删除的全部对话 id 持久记进当前配置根的删除记录（见合并一段），多轮重试只补记没记过的；写不成照常删除，结果带 `deletionRecordError`，窗口警告“对话已删除，但没能记下删除记录，以后合并旧拷贝时这些对话可能会回来。”。


新的“归档并重置”将原库放到 `<scope>/.limcode-runtime-reset-backups/<时间>-<id8>`，在同一准入内登记 residual 并持久化后才报告完成。这个目录不属于外来自动发现；启动只枚举该目录补登缺失登记；已有 pending/residual 或完整合并到当前目标的记录不重复补登，不扫描历史正文。旧 `.limcode-runtime-backups` 归档继续作为收敛来源。重置备份只能只读查看、打开文件夹或明确重新核验并合并，LimCode 不自动删除。

非当前本地库原位保留，在新配置根登记原位置的 pending 或 residual，连续迁移仍指向最初位置。迁移日志携带 pending、residual、settlement-consent 与 convergence 记录。旧目录还含本地库或新重置备份时保留，不能因其它内容已迁走就整目录删除。

迁移前先收敛将迁走的目标里的未完成提交，包括 foreign、reset 和 migration 登记来源。撤销沿用同一日志记录配置及登记文件的写后状态，所有延迟撤销入口先复核将撤销的文件与目录；发现后来修改或新增的内容就保留现场并进入 held。Runtime 数据库与 CAS 沿用现有检查，配置深层修改同样受保护，不新增正文哈希或复制一套配置副本。

`runtimeHistoryRegistry.ts` 在配置根维护无期限 pending 与 residual，收敛登记去重记录在 convergence.json。`partial` 不是 `merged`：保留每个剔除对话的 conversationId、title、code、count，committing 与 lastMerged 同样携带；mergedInto 只登记实际插入的对话。在线、流式与提交恢复共用完成路径，重入在准入内依据最新账本投影残留与待合并，旧 partial 不能覆盖后来完成的 merged。完成登记未写成时保留原恢复依据。已有残留只由明确重新核验回到 pending；单份重试保留所选来源，身份恢复后用当前定位 ID 登记并清除旧 pending/residual，原合并账本与删除闭包保留。读取列表时，枚举后已被另一窗口正常删除的登记略过，其它读取错误照常报告。未合并、部分合并与残留来源原位保留；已合并来源只经“清理备份”处理，不提供删除其它库或另一套覆盖删除入口。残留列表只读展示，部分合并只展示被剔除对话。

### 历史残留的删除、检查与修复

`Operation.owner_kind/owner_id` 是软引用，`deletePolicy: cascade-with-owner` 不是数据库外键。writer 的 Conversation 删除（包括按唯一键删除）在同一事务里先按该对话的 Turn/ModelRequest 精确找出模型请求所属的 Operation，要求请求已终态且聚合完整，再删除 Operation（Attempt 随真实外键级联），最后由 Conversation 级联删除 Turn/ModelRequest。不能依赖声明文字自动级联，也不能泛化为清理所有失去软引用的领域：Process、EffectReceipt 等保留历史仍按原合同保留。任何后续断言失败整笔回滚。

历史合并的进程准入根据持久证据与后续工作，而非仅按状态枚举排除：`outcome_unknown` 是已经结束观测但结果未知，不是“运行中”，更不代表子进程已被证明退出。匹配的 ProcessReceipt（nonce、启动身份、结果和退出元组）、completed_at、没有待完成操作/通知以及输出完整登记时可按原状态导入；缺回执、身份不匹配、状态矛盾或待处理工作仍拒绝。合并从不把它改成 exited，不发送旧结束通知或重新启动进程。数据目录迁移保留原来的较严策略，不因历史展示可合并而允许未知进程迁走。

普通合并、大库准备与整库分批复制使用共享 `MergeAggregatePreflight`，检查本次实际触及的模型聚合：新请求、模型所属 Operation、Attempt 与模型流记录双向确定请求 id，按删除跳过闭包过滤来源，与当前库自己 worker 在一致读快照中的关联行组成有效聚合。请求 id 存在独立连接的磁盘 TEMP 表、页缓存受限，每次只取 64 个目标聚合、每个只保留能证明超限的有界行数，不能向正在 iterate 的来源连接写 TEMP 表。仍在最终 writer 提交时复核。只有带 `RUNTIME_DATA_INVARIANT` 的数据断言或 SQLite 约束归为确定性受阻；域与记录 id 可跨 worker 边界传回，其它执行器、I/O 或目标状态失败继续按推迟。普通在线合并记录规划时目标 writer 的本地提交序号与 external data_version，提交拒绝后目标有过任何本地或外部提交时先按并发变化推迟、不记永久受阻，防止另一窗口抢先合并同一行产生的唯一键冲突被误判为来源损坏。`runtimeMergeValidation.ts` 的日期化规则标识只使受影响的派生拒绝与审计缓存失效（包括外来历史库的审计缓存），不改变内容指纹，不删除提交记录、删除记录、mergedInto 闭包或恢复凭据。

“历史与存储管理 → 检查并修复历史残留”（`runtimeHistoryRepair.ts`）是独立的用户操作，不是合库的静默兜底。只接受本地、Host 和旧版 owner 均离线、无未完成恢复且精确核验为当前 epoch 的库；拒绝共享 inode/硬链接、符号链接、不完整结构与涉及该库的 committing 合并。只读检查通过私有快照审计 worker 完成，不备份、不启动 Runtime、不改源库；现存请求聚合异常、非终态孤立操作、保留效果或结果暂停依赖、不能匹配的进程结束证据均报告而不猜测修复。明确确认后才经写入闸门和维护生命周期：按完整内容摘要复核计划，先查备份与修复 WAL 空间（数据库与 WAL 大小之和的两倍加 64 MiB），通过 SQLite Backup API 备份、核对摘要并 fsync 数据库/目录，在控制根 `history-repair-backups/<时间>-<修复UUID>/` 保存 RootBinding 与 prepared 日志；再由私有维护实例的固定 worker 操作，以 synchronous=FULL 的单事务清理父请求缺失且没有保留依赖的完整终态 Operation/Attempt，并仅凭匹配的既有未知结果回执，将误改成 exited 的 Process 恢复为 outcome_unknown。实际修改前再次核对内容摘要；事务内逐表保护投影摘要证明除精确清理的元数据与纠正的单列状态外全部原记录不变，包含消息修订、当前版本、成员关系、正文与附件元数据；CAS 文件不改动，完整性核验不通过整笔回滚。没有需要修复的记录不备份；任一不安全记录使整份拒绝。

修复事务同笔写专属 CommandReceipt（`historical-repair:<UUID>:<计划摘要>`）；库内标记是是否提交的唯一证明，库外 completed 日志不作提交依据。备份后取消或崩溃未改源数据；提交后写完成记录失败仍报告已提交，下次只读检查按标记显示实际结果，同一计划重入不重复删除、也不重复备份。修复备份不纳入自动备份清理。修复不改当前选择、不重建缺失父记录、不伪造退出码、不调用模型/工具、不清合库账本；修复与之后合库分别报告，修复过来源之后不得宣称两边从未改动。修复当前库先经独占协调等待窗口空闲、冻结新工作并关闭发起窗口的 Runtime；随后只读检查并另行确认备份修复，结束后重载，选择文件不变。外来只读历史不原地修复。

进程等待、停止收敛、spool 清理和完成通知共用完整的持久终态证据校验：成功必须退出码为 0，失败必须非零退出码或非空退出信号，退出码和信号只能存在一个；未知结果二者均为空。Process 的状态、非空 completed_at、nonce 和启动身份必须与回执匹配。等待和通知从同一读快照取 Process 与回执；通知正文使用已核实的 Process.completed_at，创建通知的写事务再次断言已核验字段，不用收到回执的时间替代完成时间。

大库读取每扫描 250 条原始记录即让出并检查取消，包括全部被删除闭包跳过的区段；保留协作消息的来源序号顺序。按跳过闭包复查未完成工作时不把全部跳过 id 装进窗口线程的 Map：小步导出磁盘跳过索引，关闭私有快照 reader，再由审计 worker 用固定 TEMP 视图检查；worker 连接关闭且线程退出之后才重开 reader。此生命周期只属于独立、只读、没有事务或活跃 iterator 的私有快照，不得用于在线来源、目标或维护 writer。

合库收尾对预检接受的非子任务排队意图统一使用已有 `cancelQueuedIntent`（普通输入、继续执行、重试；运行时续跑仍须先满足待投递工作拒绝规则），保留修订栅栏并先取消队列再结束回合。普通合并对规划时复用的记录在提交事务内复核全部合同要求一致的字段，仅排除既有内容身份差异白名单和重新分配的序号字段；并发变化按推迟处理。没有新增行的合并也须事务内复核复用记录，并在库外成功账本之前完成 `durabilityCheckpoint`，仅有断言的事务不能代替落盘屏障。历史残留修复复用已准备的备份时，重新完成备份目录及父级目录的持久同步；同步失败不得进入修复事务。

### 数据库投影与界面响应边界

侧栏首条用户消息、末条可见消息，以及工具事件/子任务回合的尾部记录，优先按既有索引逐主体读取有界后缀；不得先对全部历史排名再截取少量记录。侧栏 Turn 只携带活动回合和实际子任务/投递引用的回合，不能省略这些引用后改变状态判断。历史分页先选游标范围内的有界候选，再计算所需的可见前缀计数与页内序号；绝对可见序号仍需准确，不能把物理序号或客户端猜测当作显示序号，前缀计数仍可能随历史规模增长。

界面仅在需要校验已加载历史的完整快照上扫描历史边界，普通增量确认不重复遍历历史。侧栏和应用 Facade 的刷新保留首次调度截止时间，以 single-flight 与 dirty/pending 合并在途请求；持续事件不能无限推迟刷新，关闭后的异步结果不能恢复已关闭视图。已完成详情的 JSON 解析跟随详情对象生命周期缓存，内容或角色变化时失效，不独立保留旧会话。代码块按可见行窗口渲染，保留完整复制、逻辑滚动锚点和宽度；尺寸观察不得通过反复重新 observe 造成静止状态持续测量。

CAS 分页的验证记录与整文件字节缓存分离：首次流式校验，之后按范围读，校验记录有界；文件身份或 logical→canonical 目标变化时不能复用旧校验。每次读前后保留 root fence，核对 regular file、长度和文件身份，错误路径关闭句柄。保留本地 CAS 既有符号链接语义，固定并复核规范化目标；外来历史库原有拒绝符号链接规则不变。

大差异预览不得用展开数组传递无界函数参数。昂贵的展示 diff 由有界 worker 执行，保留同步算法的编辑语义、统计和 Unicode 安全截断；并发及输入字节容量有上限，永久过大与暂时繁忙明确区分，预览限制不修改文件内容。分页复用有界的已物化 diff，但每次仍核对成员存在及输入身份；失败结果不缓存。新增性能回归应优先验证查询范围、解析次数、渲染节点数、验证次数和事件调度进展，不以机器相关的毫秒阈值代替正确性。

### 1.1 独立领域对象必须独立建模

如果两个概念可以独立存在、独立复用、独立存储，就不要把一个塞进另一个对象里。

当前项目中的典型例子：

```text
Agent 是独立对象
Conversation / Session 是独立对象
Message 是独立对象
AgentConversationLink 是独立关系对象
```

不要设计成：

```text
Agent owns Conversation
Conversation embeds Agent
SessionRecord.agentId 强制绑定 Agent
```

应该设计成：

```text
Agent Entity
  - Agent
  - AgentKind
  - ModelProfile
  - ToolPolicy
  - SystemPrompt
  - AgentStatus

Conversation / Session Entity
  - Session

Message Entity
  - Message
  - PartOf -> Conversation

Link Entity
  - AgentConversationLink { agent, conversation, role }
```

### 1.2 关系也必须是数据

两个领域对象之间的关系不能藏在对象内部，也不能写死在 system 逻辑里。关系本身应作为独立 ECS 数据存在。

例如：

```ts
AgentConversationLink {
  agent: Entity;
  conversation: Entity;
  role: 'active' | 'participant' | 'reviewer';
}
```

这样切换 agent、切换 conversation、多 agent 协作，本质上都是修改 link 数据。

## 2. ECS 开发准则

### 2.1 Component 表达单一事实

每个 component 应只表达一个清晰事实。推荐：

```text
Agent
ModelProfile
ToolPolicy
SystemPrompt
Session
Message
PartOf
AgentConversationLink
```

避免创建包含多个领域概念的大组件。

### 2.2 Link 优先于嵌套字段

当 A 与 B 的关系未来可能变化，或可能变成一对多 / 多对多时，必须优先使用 Link component/entity。

推荐：

```ts
AgentConversationLink { agent, conversation, role }
```

避免：

```ts
Session { id, agentId }
Agent { id, currentSessionId }
```

### 2.3 System 解释数据，不制造耦合

System 可以读取 link 并执行行为，但不能假设某个领域对象天然拥有另一个领域对象。

推荐流程：

```text
LlmDispatchSystem
  1. 找到 NeedsResponse 的 conversation
  2. 通过 AgentConversationLink 找 active agent
  3. 读取 agent 的 ModelProfile / SystemPrompt / ToolPolicy
  4. 读取 conversation 的 messages
  5. 发出 llm.start effect
```

避免：

```text
LlmDispatchSystem 假设 Session 一定 OwnedByAgent
```

## 3. Protocol / ClientState 准则

前端协议不能把后端已经拆开的对象重新耦合起来。

推荐：

```ts
interface ClientState {
  agents: AgentRecord[];
  sessions: SessionRecord[];
  agentConversationLinks: AgentConversationLinkRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}
```

避免：

```ts
interface SessionRecord {
  id: string;
  agentId: string;
}
```

如果新增独立对象，也应新增独立 patch：

```ts
{ kind: 'agentConversationLink.upsert'; link }
{ kind: 'agentConversationLink.remove'; id }
```

不要为了更新 link 而重发 agent 或 session。

### 3.1 Bridge / postMessage payload 必须是可结构化克隆的纯数据

Webview 与 Extension Host 之间通过 `postMessage` 传递数据，payload 必须满足浏览器 structured clone 规则。**不要把 Vue / Pinia 的响应式对象、Proxy、ref、computed、DOM Event、函数、class 实例、Map / Set 等直接放进 bridge payload**，否则容易触发：

```text
DataCloneError: Failed to execute 'postMessage' on 'MessagePort': [object Object] could not be cloned.
```

强制要求：

```text
1. 调用 bridge.request / bridge.post / vscode.postMessage 前，必须把 payload 转成普通 Object / Array / string / number / boolean / null。
2. 不要直接传 Pinia state，例如 settings: this.llm、payload: store.xxx、items: reactiveArray。
3. 对嵌套对象也要递归转成纯对象；数组用 map 重新生成，record 用 Object.fromEntries / 显式 for 循环重新生成。
4. 优先使用已有 normalize / sanitize / toPlainXxx 函数；没有就新增一个专用转换函数，不要偷懒直接传响应式对象。
5. 发送前的协议对象应只包含 shared/protocol.ts 里定义的字段，不要把 UI 临时字段、组件对象、事件对象混进去。
```

推荐：

```ts
const settings = normalizeLlmSettings(this.llm);
bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
  section: 'llm',
  settings
});
```

避免：

```ts
bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
  section: 'llm',
  settings: this.llm // Pinia state / Proxy，禁止直接发送
});
```

如果 payload 来自 store，最低限度也要显式构造：

```ts
const payload = {
  conversationId: this.llm.conversationId,
  activeProviderConfigId: this.llm.activeProviderConfigId,
  ...(plainModelOverrides ? { modelOverrides: plainModelOverrides } : {})
};
```

排查准则：只要遇到 `DataCloneError`，第一时间检查最近一次 `bridge.request(...)` 是否传入了 Pinia/Vue Proxy 或不可 clone 对象。

## 4. Effect 层准则

### 4.1 Effect payload 不应长期携带领域耦合结构

Effect 是 system 到 runtime capability 的边界。这个边界也必须保持解耦。

推荐：

```text
llm.start effect 接收：
  - model settings
  - prompt messages
  - tools
```

这些数据可以由 system 根据 ECS link 临时组装，但 effect 不应该保存类似 `agentWithConversation` 的耦合结构。

### 4.2 Effect handler 只执行外部能力

Effect handler 不应承载领域关系规则。领域关系应在 ECS world 中由 component/link 表达，由 system 解释。

例如：

```text
LlmDispatchSystem 决定哪个 agent 使用哪个 conversation
LLM capability 只负责调用模型
Storage capability 只负责读写当前投影数据
```

## 5. Storage 层准则

### 5.1 文件层也必须解耦

如果 ECS 和协议层已经拆成独立对象，存储层不能再把它们塞回一个大JSON记录或一个表达领域ownership的强绑定目录。

可靠运行内核可以让多个Runtime领域表物理共用一个SQLite文件，但这只是共同事务介质，不表示领域ownership。强制要求：每个领域对象/Link具有独立table、schema owner、Repository、codec、mutation mapping、Client mapping、delete/reset/index policy；禁止generic family JSON表、任意SQL batch和跨领域聚合记录。Agent/Workflow/Policy/Settings等配置authority仍使用独立settings roots，不迁入Runtime SQLite。该例外必须由`docs/architecture/reliable-kernel/contracts/authority.json`逐项machine crosswalk约束。

推荐结构：

```text
<dataRoot>/
  agents/
    index.json
    records/{timeSlugHash}.json

  conversations/
    index.json
    {timeSlugHash}/
      conversation.json
      messages/
        index.json
        chunks/000000.json

  agent-conversation-links/
    index.json
    records/{timeSlugHash}.json
```

含义：

```text
agents/ 只保存 agent 数据
conversations/ 只保存 conversation 与 message 数据
agent-conversation-links/ 只保存 agent 与 conversation 的关系
```

避免：

```text
chat/manifest.json 同时保存 agents、sessions、links
conversation 文件夹里保存 agent 配置
agent 文件夹里保存 conversation 历史
```

### 5.2 Index 只描述本类对象

每类数据的 index 只索引本类对象：

```text
agents/index.json 只列 agent records
conversations/index.json 只列 conversation records
agent-conversation-links/index.json 只列 link records
```

不要跨领域混存。

### 5.3 文件名必须可读、可排序、稳定

新记录文件名使用：

```text
{yyyyMMdd-HHmmss-SSS}-{可读slug}-{短hash}
```

例如：

```text
20260530-142233-123-main-0ab12cd.json
20260530-142240-456-default-1x9k2p3/
```

规则：

```text
1. 新记录生成 time + slug + hash 名称
2. 已存在记录复用 index 中的 file/folder
3. 未发布阶段不写旧格式兼容或迁移代码
```

### 5.4 数据文件路径必须通过 getPaths 获取

当需要读写/创建任何业务数据文件或目录时，必须先通过当前 storage capability 内部的 `getPaths()` 获取路径：

```ts
function getPaths(): StoragePaths {
  currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
  return currentPaths;
}
```

要求：

```text
1. 业务数据文件必须写到 getPaths() 返回的对应 root/index 路径下，例如 agentsRootUri、conversationsRootUri、linksRootUri、settingsRootUri 等。
2. 普通文件配置/业务store每次load/save/ensure storage roots前都应重新调用getPaths()，不要长期缓存旧路径。
3. SQLite长连接只允许缓存由RootAuthority通过getPaths建立的immutable、fenced `RootBinding { paths, dataSetId, rootInstanceId, rootGeneration, pointerRevision, runtimeKernelEpoch }`；禁止缓存裸路径。每个request/transaction必须重验binding generation，root switch通过新binding reopen。
4. CAS和配置operation每次从RootAuthority获取current binding/operation registration；不能由各模块自行读取Memento重新选root。
   外来历史根（归档、拷来的目录）不建立RootAuthority、不打开RuntimeDatabase、不登记Host：`LocatedRuntimeRoot.located`只由getPaths加固定目录名和严格匹配的名字推导，所有fs与SQLite读取只用它；`recorded`只作身份栅栏与显示文字，recorded路径永远不交给任何I/O；外来目录里从不新建文件或目录，声明与缓存放在当前配置根`.limcode-runtime-merges/`下。
5. 不要直接使用VS Code extension context的globalStorageUri/globalStoragePath/globalState拼接业务数据路径。
6. globalStatus只用于保存数据根目录配置、当前激活数据目录与迁移控制元数据，不用于承载业务数据文件或proxy等业务设置；业务设置进入`GLOBAL_SETTINGS_SECTIONS`对应settings root。
```

原因：

```text
通过 resolveDataRootUri(context) + createVscodeStoragePaths(...) 统一生成路径，才能集中控制数据目录，支持后续数据文件迁移、切换和管理。
```

## 5.5. UI设计原则

避免蓝紫色+大圆角。按钮 hover / focus / active / 选中态也尽量不要使用 VS Code 默认的蓝色实心背景；如需高亮，优先使用中性灰色背景或轻量边框，避免蓝色块破坏整体风格。

如果前端需要使用滚动条，优先使用自定义滚动条组件，不要直接依赖浏览器默认滚动条：

```text
webview/src/components/navigation/AdvancedScrollbar.vue
```

要求：

```text
1. 普通内容区域需要滚动条时，使用 AdvancedScrollbar。
2. 下拉面板、浮层、小区域滚动条优先使用 AdvancedScrollbar 的基础样式 variant="minimal"：无可见导轨，仅悬浮显示滑块，不占用布局空间。
3. 如确实不能使用 AdvancedScrollbar，需说明原因，并保持视觉风格与现有自定义滚动条一致。
```

如果前端需要做信息展示类悬浮面板（例如 token / usage / 指标明细、图表柱子明细、状态解释等 hover/focus 提示），必须优先复用：

```text
webview/src/components/ui/HoverTooltipPanel.vue
```

要求：不要直接依赖浏览器默认 `title` 提示，也不要临时写新的 tooltip / hover 面板；复用 `HoverTooltipPanel` 的展示样式、进入 / 离开动画、延迟和关闭等待时间。只有在交互形态明显不是信息展示 tooltip 时，才允许使用下拉面板或其他浮层组件，并说明原因。


### 5.6 设置页组件使用标准

设置页内的通用交互组件必须保持一致：

```text
1. 下拉选择不要直接使用浏览器原生 select；优先复用 webview/src/components/settings/global/SettingsDropdown.vue。该组件基于 project-dropdown + lc-dropdown-panel + IconCaretUp。
2. 下拉按钮右侧使用 IconCaretUp，并用旋转动画表达展开 / 收起。
3. 下拉面板内容可能超过高度时，必须复用 webview/src/components/navigation/AdvancedScrollbar.vue；最基础样式使用 variant="minimal"，无可见导轨，仅显示滑块。SettingsDropdown 已内置该规则，并支持 maxHeight / height 以适配最大高度或固定高度场景。
4. 需要删除、危险操作或二次确认时，必须复用 webview/src/components/ui/ConfirmPanel.vue，不要临时写新的确认弹窗。
5. 需要输入名称、重命名等简单文本输入弹窗时，优先复用 webview/src/components/ui/InputPanel.vue。
6. 需要勾选框 / 复选框 / 列表选中标记时，必须复用 webview/src/components/ui/LcCheckbox.vue；不要临时使用原生 checkbox 默认样式，也不要用 span + “✓” 拼接勾选图形。纯展示选中标记使用 presentation 模式，交互式复选框使用 v-model / update:model-value。
7. 设置页签内容较多时按页签拆分 Vue 组件，主面板只负责布局与页签切换。
8. 需要 token 数阈值 / 上下文窗口阈值滑条时，优先复用 webview/src/components/ui/TokenThresholdSlider.vue；不要在业务组件中临时编写 range 滑条样式。该组件已内置 1k 对齐、顶部 token 标签、底部百分比标签、推荐阈值标签与中性灰视觉风格。
```

`TokenThresholdSlider` 基础用法：

```vue
<TokenThresholdSlider
  :model-value="thresholdTokens"
  :max-tokens="contextWindowTokens"
  :step-tokens="1000"
  :recommended-tokens="contextWindowTokens - 20000"
  label-variant="tag"
  :show-top-label="true"
  :show-bottom-label="true"
  aria-label="拖拽调整自动压缩触发阈值"
  @update:model-value="updateThresholdTokens"
/>
```

要求：业务组件只负责计算 `model-value`、`max-tokens`、`recommended-tokens` 并在 `update:model-value` 中写回配置；滑条的 token / 百分比展示、推荐标签、hover / focus 样式由组件统一维护。如需标签样式，使用 `label-variant="tag"`；如需隐藏上下数字，使用 `:show-top-label="false"` / `:show-bottom-label="false"`；如需隐藏推荐标签，使用 `:show-recommended-tag="false"`。

### 5.7 配置项数据对接标准

新增任何设置项 / 配置页 / 可复用配置记录前，必须先阅读（该文为 settings 子系统长期规范，可靠内核切换后继续有效）：

```text
docs/global-settings-data-integration.md
```

开发时必须先区分两个 scope：

```text
1. 配置管理 scope：这个配置入口属于 global / conversation / agent 哪一级设置。
2. 配置数据 scope：这个配置是简单 section，还是该 settings scope 下的可复用 record 集合，还是独立 ECS 领域对象。
```

要求：

```text
1. 如果入口属于全局设置，优先新增 GLOBAL_SETTINGS_SECTIONS section，并复用 settings.global.get/update/snapshot。
2. 不要为了全局设置页里的 CRUD 新建独立 BridgeMessageType / Bridge / 顶层 storage root。
3. 如果全局设置下有多个可复用配置页，每个配置仍可作为独立 record 存在，但应放在 settingsRootUri 对应 section 下，通过 index + records 管理。
4. 当前激活 id / 默认选择这类状态应单独作为 settings section 保存，不要塞进每个配置 record。
5. 如果某配置未来要被 Agent / Workflow / Conversation 复用，应通过 Link/关系数据引用配置 id，不要把配置对象嵌入主体对象。
```

## 6. 默认初始化准则

默认初始化可以为了跑通基础体验创建默认对象，但也必须遵循解耦模型。

推荐：

```text
创建 default Agent
创建 default Conversation
创建 AgentConversationLink(default Agent, default Conversation, active)
```

避免：

```text
创建 Agent 时把 Conversation 内嵌进去
创建 Session 时必须写 agentId
```

## 7. 新功能设计检查清单

新增模块、组件、effect、协议或存储格式前，必须检查：

```text
1. 这个字段是不是其实在表达另一个领域对象？
2. 这个关系未来是否可能一对多或多对多？
3. 切换关系是否能只改 link，而不用改主体对象？
4. ClientState 是否把独立对象重新塞进另一个对象？
5. Effect payload 是否携带了长期领域关系？
6. 是否把多个领域对象塞进同一大 JSON / 聚合记录，或在共用 SQLite 时遗漏独立 table、Repository、Link/FK 与 mutation mapping？
7. 是否为了未发布的旧格式写了兼容/迁移代码？如果没有发布，应该删除。
8. 数据文件路径是否通过 getPaths() 获取，或由 RootAuthority 建立并逐事务校验 fenced RootBinding，而不是直接使用 extension globalStorage/globalState/globalStatus？
9. 新增配置项前是否已阅读 docs/global-settings-data-integration.md（settings 子系统长期规范），并区分配置管理 scope 与配置数据 scope？
```

如果发现耦合，优先拆成：

```text
主体对象 A
主体对象 B
Link / Relation 对象
System 解释 Link
Effect 执行外部能力
Storage 按领域分目录，或在共用 SQLite 中按领域独立表与 Repository 持久化
```

## 8. 当前 Agent / Conversation 案例

当前生产结构：

```text
Configuration:
  Agent / ModelProfile / Policy 位于独立配置 roots

Runtime domains:
  Conversation 独立
  Message / MessageRevision 与 Conversation 的关系独立
  AgentConversationLink 独立表达 Agent 与 Conversation 的关系
  Turn / EffectIntent / EffectReceipt 独立表达执行与外部结果

Protocol:
  ConfigurationSnapshot 投影配置
  有界 Runtime snapshot / changes 投影已提交运行事实
  对话设置按 conversationId 分发，不能覆盖其他面板的作用域

Storage:
  独立配置 roots 保存 Agent、Workflow、Policy、Settings
  Runtime SQLite 按领域保存 Conversation、Message、Turn 与各类 Link
  CAS 保存正文和大结果

Execution:
  CommandRouter / Facade 接收命令
  可靠内核 control planes 解释独立领域与 Link 并提交事实
  capability adapters 执行外部能力
  Client Feed 直接投影已提交事实到 Webview
```

这套方式后续应用于所有类似模块：只要两个概念可以被不同功能复用，就不要做所有权绑定，而是通过独立 link 和 system 组合。

## 9. 发送路径与设置一致性

发送前的全局设置屏障仅允许跳过同一有序消息通道中、已确认初始化且干净的请求客户端；其它可编辑客户端仍须逐次握手，不能把未到达 Host 的脏通知视为不存在。活动通知仅含状态、修订与 Ready 绑定的文档会话身份，不携带设置内容；旧会话与旧修订不得覆盖新状态。屏障返回原子代数，配置写入队列排空后复核代数和队列身份，变化则重新等待；加载、错误和冲突不能作为已保存确认。

工作环境资格预览只读取实际依赖的配置集合与策略记录，保留作用域优先级、继承限制及最新文件读取；执行前完整权威编译与租约检查不省略，不引入未验证的跨请求缓存。乐观提交、已保存待显示与真实排队分别呈现，只有持久队列或明确未准入确认才计入等待队列。发送计时仅在既有调试捕获开启时记录阶段、标识与耗时，不记录消息正文或附件。

## 10. 恢复、结果投递与编辑边界

恢复扫描不得替换仍合格、同一 Host/owner 持有且未过期的执行代数。启动时仅有排队输入的会话遇到暂时 busy/unknown，必须保留有界准入重试；等待中的事实变化不得因一次抢占失败而丢失唤醒。只能在下一次模型请求边界吸收的运行时投递，不得让尚未解决工具/用户等待的回合持续空转。

ChildExecutionParentLink 保留不可变的创建祖先关系；某次回答的自动投递来源必须解析到该任务代数的实际请求者（创建父回合，或该代数 send Operation 对应 ToolCall 的父回合），进程/子任务回答产生的续跑递归继承这份来源。实时投递、恢复、唤醒准入、最终回答归类与已停止父回合的资格判断使用同一解析规则；过期请求者的回调仍不能唤醒新代数。

文件提案在既有 CAS 正文中绑定规划时的规范化根身份，批准和执行核对成员对应关系，不把缺失证据替换成当前路径。规划读取之前验证实际路径边界；允许工作区根本身是受支持的链接，但不能经中间链接读取根外正文。协作式文件修改使用共享锁与执行前目标校验；加载目标 CAS 后再次核对基线。不能宣称便携式 Node 文件操作能对不遵守锁的外部编辑器提供原子比较交换。附件存储失败与已经观测到的 MCP 外部操作结果分开表达，不把后处理错误伪装成外部动作未完成。

压缩、分支、重建和原生续接必须保留已展示短引用的身份，不能重新编号后赋予旧引用新含义。未采用当前身份合同、单份配方合法的历史 Context 短引用（P/O/W 与协作引用）存在重复映射时，读取全部冻结请求与原生投影证据，将涉及歧义的旧编号永久退役；新编号高于全部已见编号，不按时间戳覆盖，不猜摘要中旧编号的含义。有效映射、退役编号与单一日期化身份合同随新配方及原生投影冻结，分支与历史合并后按实际证据重新核对；当前合同内的冲突、单份请求内的原生引用冲突、非法配方或缺失 CAS 仍拒绝。旧请求和已解析工具参数照原冻结事实重放，修复只在新请求安全边界采用，首次采用修复状态的原生请求全量重建。新压缩配方先按确切的不可变来源选择器展开，再冻结实际投影会展示的全部引用；历史压缩曾展示却未冻结的地址只从原冻结来源的分配过程重演后退役，不猜摘要中短号对应的对象。分支（包括子任务上下文继承）保留源会话全部已分配地址及退役水位，附件用原稳定注册表，其余用独立的私有 Context 根和 conversation_handle_catalog 投影冻结；私有根不进入模型窗口，不复制截掉的正文或扩大对象操作权限，提交复核源引用前沿，重放只核已提交事实。旧分支缺失的附件注册地址仅从本分支实际冻结配方与合法原生投影恢复，原编号与目标一一核对，有冲突就拒绝；只恢复编号保留，不把附件加入可见目录，预览只读。普通请求、压缩与当前投影不得从任意用户或工具 JSON 的 attachmentId 自行生成 F 地址，F 只使用注册表给出的冻结引用。原生工具结果沿用有界模型投影与媒体分离规则，交付重放保留冻结字节；组合批次放不下时走已有安全重建边界，不重截断已经冻结的结果。流式终态只接受供应商协议指定位置的证据，不能递归把工具参数或内容字段当作结束标志；带 SSE 事件名的终态同样解析其状态和用量。原生输出以供应商 responseId 与 itemId 共同确定身份，签名与完成字节不跨片段复用；已闭合的文本、思考和调用在物理响应边界前逐项持久化，最终界面聚合不能代替逐项进入 Context 的证据。未闭合的失败输出只更新同一请求的界面 Message，不进入 Context；结果冻结与结果出现事实串行提交，断线收尾不与后台投递重复冻结。

普通请求配方只冻结当时当前目录的不可变 CAS 身份与请求私有增量（附件地址、新分配地址及元数据补充），运行时解析结果放在 FullProviderRequest.resolvedModelHandleCatalog，不改原配方。创建时复核目录 CAS 与作用域；重放只按配方的原生产者作用域读基底，不能以当前指针或分支目标身份代替。已发布内联配方保留原字节。ContentObject 只在显式数据集重置时删除，删除源对话不删除基底；合库与整库复制仍搬运全部登记正文。未来引入可达性回收前必须把 modelHandleCatalogReference.baseContentObjectId 作为配方的强 CAS 引用边。基底缓存按已存 byte_length 有界计费，不逐轮序列化或哈希整个目录。

新建普通与原生压缩请求配方以 toolsReference.contentObjectId 冻结工具定义，指向 application/vnd.limcode.frozen-tool-definitions+json 类型的不可变 CAS。旧内联 tools 配方保留原字节与原读取路径，引用缺失、类型或摘要不符时拒绝，绝不退回当前工具设置。该引用是独立于生产者 Turn/Conversation 的强 CAS 边：分支沿用原配方，删除源对话不删正文，整库复制与合库继续携带全部已登记 ContentObject；未来可达性 GC 必须沿 toolsReference.contentObjectId 保留正文。

模型计量必须按请求冻结的实际执行模式区分普通单次请求和原生链，不能因收到 Responses 的 `response.created` 等生命周期事件就标为原生累计计费；内核会话创建、capability 和 dry-run 复用同一资格判定。纯控制事件只表示流活动，不作为首个模型输出计时。已误标的普通 HTTP 请求只在冻结配方、Authority、单份物理响应的创建/完成回执、用量及终态栅栏严格一致时作只读计量解释；原始行与 CAS 不改写，证据不足仍未知。核验在当前库 reader 的同一快照中执行，分页在核验投影后计算大小；缓存绑定数据库实例与正文读取能力，本地/外部提交均失效。上下文栏、消息计时与压缩校准共用核验语义，终态事实不被残留瞬态用量覆盖。

历史引用证据的缓存必须绑定当前数据库实例、正文存储与根栅栏，只保存已核验的不可变证据；本地相关提交和外部数据库变化使受影响证据失效，导入、删除、分支与在途原生投影不得漏检。缓存容量覆盖提交期间的增长，长会话的累计引用应共享不可变事实，不能因重复保存整个目录而退化为逐轮重读全部历史。已发布生产者留下的原生压缩前置拒绝，只在精确失败证据、来源身份与正文校验均成立且没有输出或应用结果时按未发送尝试处理，不泛化为忽略失败请求。

WebSocket 原生输出的不可变逐项记录使用供应商完成证据中的正文，展示用片段分隔符不能进入该记录；最终聚合仍须逐项严格匹配。事件携带的响应身份必须在解码和终态处理前核对，已知旧响应的迟到数据不归入新响应，未知或互相矛盾的身份拒绝；插话确认仍按自身请求与前驱身份校验。

设置界面的本地草稿与最新保存值分别保存；重复快照、迟到的保存确认和初次加载不得覆盖更晚的本地编辑。保存值变化时保留草稿并给出显式读取入口；切换配置作用域时重新绑定，显式重读也不能覆盖发出重读之后新输入的内容。读取失败必须结束依赖该读取的未提交选择及发送等待，不能误伤已独立提交的新保存；丢弃草稿仍按确切提交身份确认。

## 11. 自动重试与分阶段恢复

供应商请求的未知错误默认进入有界恢复，而不是因未命中消息关键词就直接结束；统一提取受支持错误信封、状态与 cause，明确区分供应商错误、本地准备失败、用户取消、权限/额度/配置问题和内部不变量。新建或缺省配置默认允许 8 次重试，硬上限为 10 次；既有显式次数不被默认值覆盖，设置界面不得宣称运行时不支持的无限重试。服务端 Retry-After 是最早重试时间，不能截短后提前发送；过长等待须明确说明停止原因。

临时数据库/本地提交错误按原请求、检查点和幂等身份继续：模型已完成时只补交已有结果，不重新调用模型或工具。排队准入、执行入口和持久事件处理中的暂时故障不得消费掉唯一唤醒；多层恢复共享耗尽标识，不能让内层与外层各自重置预算。只有进程内保存的恢复次数不得被描述为跨重启持久预算。停止、删除、所有权代数变化以及根/结构/内容身份错误仍由现有权威裁决。

部分文字或尚未执行的完整性错误不等同于外部副作用：可安全替换的输出按新 Attempt 重生成；原生链路已有工具进展则从已提交 Context 重建，不重放工具，也不借新请求重置错误恢复预算。坏参数不能执行；上下文超限须在受限的修复次数内实际缩小上下文后创建新不可变请求，不能原样循环或偷偷提高用户指定的输出上限。界面以持久失败/重试事实解释状态；无输出失败也应有针对确切请求的恢复入口，倒计时不成为第二个运行权威。

原生请求在工具已完成后被供应商拒绝为上下文超限时，只能接受该拒绝请求自身造成的、已完整关闭的不可变追加前沿：原输入必须为精确有序前缀，每个新增调用、结果和模型片段都须有该 ModelRequest 的原生来源与稳定修订身份，不能仅凭同一 Turn 或 Message 链接放行。所有已准入原生调用必须有闭合结果；未完成工具、用户修改/截断/分支/重排或其他输入不借此重放。压缩记录冻结实际通过证明的追加根；重启后按该根及确切的已提交压缩结果重放，不能回退原投影根，也不能让其他新 Head 被旧修复覆盖。根身份计算复用生产者与验证者共同的纯函数，既有身份公式不变。

历史合并的对话归属由 `runtimeMergeConversationOwnership.ts` 对全部领域显式分类与声明路径，机器合同一一覆盖。实际剔除规划复用一次行扫描建立的关系边，不能为每一行重复遍历历史；内容派生身份不强行归入某一个对话。

历史合并的离线收尾基础复用迁移已有的停止和放弃转换，原因参数为 `historical-merge-settled`，最多三轮，返回按对话归属的未完成项；迁移原有原因与五轮行为保留。合并调用方负责在来源维护声明内、已有备份及持久同意之后调用，落盘后再记收尾结果；外来来源不原地收尾。

后台批次逐来源开始前检查发起 Runtime 是否空闲。自动外来来源从申请声明前起有 120 秒取消预算，声明已占用时直接推迟；取消传到私有复制、审计和正文读取，最终释放声明并清理计时器。明确请求不受后台预算限制，超时只推迟、不记为坏库。

未完成工作盘点、剔除播种、收尾同意与实际收尾复用删除跳过和确定不合并的范围，不反向剔除健康父对话，也不收尾已删除闭包的源任务。收尾同意按来源身份持久保存轮次数、排队意图数、待投递数（含进程完成派发与未送达答案）、子 Agent 数、未收到回执的操作数；界面同时说明未知效果可能记为结果未知。只有同一来源身份、各项数量均未超过已同意数量才复用同意；新来源或数量增加重新确认。在线与流式准备复用已有私有快照，在不持维护声明的同意边界暂停；一次确认列出已准备来源的可读名称与数量，同一准入内持久整批同意之后才逐来源继续。取消时拒绝尚未继续的来源并等待各自快照清理，已提交来源不回滚。先持久同意，再在来源维护声明内备份，以 SETTLING_ONLY 打开来源、运行既有三轮停止与放弃转换，durabilityCheckpoint 后关闭，剩余按对话剔除，无法归属的整轮失败推迟。finalizations 同时保留控制面返回的 15 项完整分类计数，轮次与排队意图另按来源实际状态回读统计。


### 单一历史界面（第3期）

历史与存储管理只提供当前历史修复、存储占用、未能合并的旧数据、立即合并全部、迁移、清理备份和归档重置。不再提供选择、切换、保持分开、删除其他库、外来库列表或大库会话界面。没有选择且所有可检查候选均不合格时，在维护离线边界内保留不可用固定根为残留备份，建立固定当前根，旧来源登记待合并或残留；不绕过不可读物理边界。已有选择保持不变。立即合并全部复用正常 Runtime 启动入口，小来源在线合并，大来源直接调用准备与流式合并后端；明确操作从来源处理到结果通知保留明确请求语义与取消信号，复用独占协调、保存输入、取消和重载，不估时、不倒计时、不暂存会话结果。残留和部分合并来源不删除。

旧大库会话适配层与只读估时、倒计时、剩余时间、实测速率账本已删除。流式后端只报告阶段和已处理行数；准备声明、备份、空间检查、单来源事务和取消回滚保持原语义。旧rates文件留在磁盘上不读不写，不新增清理扫描。
