# AGENTS.md

本文件是 Limcode Test 项目后续开发时 AI Agent / 开发者需要遵守的架构准则。项目由 [lurenxing628](https://github.com/lurenxing628) 独立维护，仓库地址为 <https://github.com/lurenxing628/limcode-test>。重点是：**ECS 数据、协议、effect、存储都要保持领域对象解耦**。当前准则来自 Agent 与 Conversation 解耦改造经验。

当前生产入口是 `vscode/extension.ts → VscodeReliableKernelApplicationFacade → VscodeReliableKernelProductRuntime → ReliableKernelApplication`。Runtime 生命周期与提交权威由可靠内核和 SQLite worker 持有，Client Feed 直接投影已提交事实；`backend/world` 中仍复用部分领域类型、工具声明与 prompt helper，但旧 ECS World/System 循环不是生产执行器。下文 ECS 示例表达领域解耦准则，不得据此恢复旧运行 writer。

提交消息只写简明中文标题，不添加 `feat:`、`fix:` 等类型前缀，不使用晦涩说法，也不写正文。每个提交只表达一个完整改动。

## 1. 总原则

### 1.0 兼容原则

当前项目仍然处于开发模式，因此不要对旧格式有任何兜底，也不需要保留旧功能代码的兼容和体验，也不需要写什么协议v1，v2等之类的运行时内部版本号，全面使用新格式新功能更优秀的代码。

允许机器合同使用日期化`planRevision/contractRevision`、密码学domain separator或单一Runtime schema epoch来标识当前定义；这些标识不得用于运行时版本协商、旧格式fallback或维护未发布格式的通用 migration 链。当前 Runtime epoch 为 5。为保留已发布用户的对话，精确支持版本 0.0.10–0.0.14 的 epoch 3 和 0.0.15–0.0.21 的 epoch 4 离线升级到 epoch 5：数据库打开前核对完整 table/index/trigger/manifest/RootBinding 指纹，要求其它 Host 离线，使用 SQLite Backup API 持久备份，通过 pending pointer、单事务和 durable journal 向前恢复；旧版中断的 3→4 pending/journal 经精确核验后先收敛；原 Conversation、Message、附件与 CAS 保留。epoch 3 的旧 Child Runtime continuation、epoch 4 精确缺少 RuntimeDeliveryIntentLink 的前驱，仅在身份与内容全部严格匹配时转换。不允许由其它缺表、字段或 digest 推导前驱。未知结构漂移和不受支持的旧 epoch 保持原根不变并 fail closed，绝不自动换成空库；用户显式归档重置另走独立入口。当前 epoch 内任何 table/index/trigger/manifest/RootBinding 漂移也 fail closed，不补表、不修 metadata。

已发布 epoch 3/4 的备份升级自动执行，不要求用户点击单独升级命令或确认：当前根仍在 Runtime 打开前升级，其余旧根在当前 Runtime 就绪后逐库处理，查看旧历史时补做。每份目标必须离线并独立核验；其他正常数据集可继续使用。失败逐库报告，禁止隐式切换选择、启动非当前旧任务或把异常来源替换为空库；数据集合并只能按下一段的历史合并合同执行。候选发现可分别返回可用项和错误，任何来源的实际打开/升级仍必须严格通过原有身份与指纹合同。

没有选择文件时（从按工作区分库的版本升级）不要求用户在多个库之间选择，但只在通过只读可升级性预检的候选中自动选：已发布 epoch 3/4/5、表结构与物理指纹精确一致（已发布 3/4 另做 quick_check）、配置根合并账本里没有同一内容状态的失败记录（未完成的归档/根切换恢复窗口交给既有恢复入口判定）；其中固定默认根已初始化（有完整 RootBinding，哪怕还没有对话）则选它，否则选 SQLite 最近修改的旧工作区库，发布选择后照常就地升级。全部不通过、或固定根/scope 容器本身不可读时要求显式选择，列表写明每个库的原因，并用项目文件夹名、对话数和最后活动时间标识各库；已有选择从不被改选。历史合并在当前选中数据集正常打开、本 Host 就绪并完成后台升级之后，在后台逐来源在线进行，不要求确认、不重载窗口：旧版本（没有切换记录）留下的其它数据集（全部工作区 scope 与固定根）自动合并一次；本版本起用户经“切换当前历史库”切走的库在其控制根记为“用户保留”（标记读不出时按保留处理；写不了标记就不切换；切走一个已无法检查的库时记为保留它的任何实例），和已合并过的来源一样只在用户明确请求后合并；明确请求只作用于用户点击触发的那一次合并调用（结果总会提示；确认框写明超过在线上限时会在后台等其它窗口的任务结束、正在使用的窗口被切走，最多约 10 分钟、可取消，然后其它窗口重载一次，以及超过单事务硬上限的不能合并，数字都取自代码常量），记录下来的请求只让该来源在之后的启动里按普通待合并处理，7 天过期（过期时提示一次再删除，不悄悄消失），合并成功、受阻或失败后删除。选源时在 configuration admission 内只读账本、请求和文件状态，内容指纹只用按确切文件状态缓存的值；未命中缓存（例如切过去看过、目录被复制或恢复、库已损坏）而判断又需要它的来源，在锁外逐个计算后再判断。来源必须离线（Host liveness，以及 v0.0.10–v0.0.20 的 `runtime-owner/owner.json` 按进程身份判定）；来源先完成已发布 3/4 的备份与就地升级，再在私有快照上通过当前 epoch 完整指纹与完整性核验（复制前后 SQLite 文件状态不变才算数，否则重新复制，最多 3 次）。快照、worker 核验与内容摘要、冲突与规模判断、正文校验与复制、目标备份都不持锁；只有来源收尾（来源备份 + 终态转换）和最后的“复核 + 事务”持有 configuration admission 与来源 maintenance，锁内复核来源仍离线、身份与指针代数不变、SQLite 文件状态与核验时一致，提交前再重读账本。多个窗口可同时准备，提交串行：后到的窗口在锁内发现同一内容已被合并就直接跳过、不提示（来源文件在此期间变化，例如被先到的窗口收尾，则推迟，下次启动再判断）。来源的未结束工作只在未收尾快照上的拒绝探针、冲突、规模与正文校验全部通过后才收尾，且内核自己的对话忙碌探针先按“收尾之后”的状态判一遍全部对话，仍判忙就在收尾前整份拒绝；收尾只用现有控制面终态转换：先用 SQLite Backup API 备份来源，active Turn 以 cancelled（有中断请求时 interrupted）结束并写原因“旧版本升级时中断，合并前收尾。”，随之释放 lease、取消未开始的模型请求与没有 Operation 的工具调用、取消排队的用户消息；没有现成终态转换的状态（等待回答或批准、运行中的子 Agent 与未送达的答案、待投递消息、运行中进程等）整份不合并，写明原因和出路，不发明收尾语义。写入目标只经当前 RuntimeDatabase 的正常写事务，每个来源一个事务：逐行 codec 解码，再用各领域 Repository 插入步骤写入（ModelRequest/Operation/Attempt/ModelStreamFence/ModelStreamCheckpoint 中已开始或已结束的行以历史复制插入，仍受 worker 不变量约束：历史复制的 ModelRequest 必须已终态，其 Operation 只收 completed/cancelled/failed、Attempt 只收 transient_failed/completed/cancelled/failed，ModelStreamFence/ModelStreamCheckpoint 只能随父 ModelRequest 在同一事务里以历史复制写入），事务末尾断言每个来源 id 都已存在；同 id 同内容复用，只有 ContentObject、ProjectContext、Attachment、AttachmentObservationLink 这类内容派生身份允许合同列出的列不同并保留目标行（事务内仍不存在才插入，否则按同样规则比对），CollaborationMessage.message_seq 由 worker 在合并事务内按来源顺序接在目标当时的最大值之后分配（规划之后其它窗口再写协作消息也不冲突，超限来源等其它窗口让出后不会因此失败），其它任何差异整份拒绝且不改动目标。有行要写入时才在线用 Backup API 备份目标（每批一次，目录按 UTC 毫秒时间与进程内序号命名；本批没有任何事务用上的备份在批末删除，用上时目标控制根 `merge-backups/` 按创建先后保留最新 3 份，另外总保留本批自己的和本批开始前最新的一份），并先发布校验过摘要的 CAS 对象，事务只提交引用；没有要插入的行时只记“已合并”，不备份。来源行数超过单事务硬上限（`RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS`，60000 行）时，在任何规划、协调、备份、收尾之前拒绝，账本记 `too-large`（行数与判定时的上限，不算失败；上限与来源都不变就不再自动重试），“历史与存储管理”显示约多少条记录、当前版本不能安全合并，可切换过去查看。超过在线事务上限（`RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS`，4000 行或 12 MiB；实测最坏约 1.3 秒，远低于 busy_timeout）的来源才走通用独占维护（`migration.json#exclusiveMaintenance`，写在目标控制根 `exclusive-maintenance/`：每个窗口先回答就绪/忙/拒绝，全部就绪才倒计时确认，全部确认才统一重载，在此之前任何窗口都不让出；有忙、拒绝、未参与协作的旧窗口、超时或取消时立即放弃并推迟这份来源；go 之后遇忙本次调用结束，每个窗口每次操作最多重载一次；两个请求方不互等，窗口自己的请求进行期间答忙且不让出，较新的请求让先并写明原因；等待忙窗口只在锁外进行，持有 admission 与 maintenance 的只是有时限的短轮次（准备 8 秒、确认 20 秒、让出 30 秒，再执行操作），发起窗口在 go 之前经 `beforeGo` 冻结并确认空闲；放弃或让出后操作失败都按操作键指数退避，确定性失败转 blocked 只拦自动调用，同一操作协调后冷却，`ignoreBackoff` 须每次调用显式传入，只跳过按键退避与 blocked，冷却只让早于它启动的发起进程越过，刚让出的窗口不能马上反过来要求别人让出；持锁方发布带心跳的维护进行中标记，重载后在 admission 上等待维护结束（超过约 1 秒显示原因与耗时，久等或心跳停止时只提供继续等待或关闭窗口，绝不越过锁）并重读数据根，未发送的输入保存在 Webview 状态中；独占仍只以 Host liveness 证明）：只在冲突、正文、目标备份都已就绪之后、在全部锁之外发起，以来源内容指纹作操作键；全部窗口就绪后才经 `withLocks` 取 admission 与目标 maintenance，锁内只做来源复核与那一个事务；自动合并遇忙立即放弃并推迟，用户明确请求的合并在锁外有上限地等待；协调未完成即推迟。合并账本在配置根 `.limcode-runtime-merges/`（删除目标后仍在）：提交前记录确切插入 id 集合，committing 视为未合并；收敛只以内容派生领域以外的行为证据（内容派生身份可能被其它窗口独立写入）：全部在记为已合并，全部不在撤掉记录重新合并，部分在记为受阻并提示手动处理；committing 记录带着它替换的记录：事务失败后实测确定回滚、或崩溃后下次启动实测全部不在时，原样放回那条记录（连同判定时间，之后的请求据此判断是否重试；上次合并也不丢），结果不明才留给下次启动收敛。收尾之后停止（按推迟处理）或推迟的尝试把收尾的任务数与收尾前备份位置记在账本 `finalizations/`，下次合并成功或被拒时如实说明后删除，被拒文案不再写“两边内容都没有改动”。删除确认对还没有合并到当前库的库都会警告，包括从未入账、只是被推迟过的待合并库。只有来源自身的确定性问题（结构、指纹、完整性、行不符合当前格式、正文缺失或摘要不符、未完成恢复、epoch 不支持、升级的非暂时性失败、与当前库是同一数据集）记为失败；目标关闭、窗口关闭、I/O、空间、权限、worker 或内部异常一律推迟、不入账。合并、受阻、失败、太大都按来源内容记录（全部表全部行的摘要，由 worker 在私有副本上计算，按确切文件状态缓存；WAL 检查点、原样复制或恢复、只打开不写入都不算变化），来源之后有变化时显示“合并后有新变化”并可明确重新合并；之后的明确合并未成功时，记录保留上次成功合并。合并进来的对话在任何窗口都不会被恢复、投递或继续执行；不切换选择。启动提示按原因在每个配置根累积，只有重新评估过的来源才清除旧原因，用户明确请求的结果总是提示；详情保留在日志与“历史与存储管理”。

数据目录迁移（设置页“迁移数据目录…”；命令面板入口只打开设置页；`migration.json#dataRootRelocation`）从不直接改写数据根指针，也不整体复制目录（RootBinding 存绝对路径且逐字段校验）。只有选文件夹用原生对话框，其余确认和提示都是发起它的设置页里的 ConfirmPanel（经 `dataRoot.prompt`，清单完整列出、不截断）；没有运行时（因而没有设置页）的恢复提示除外。先只读预检：绝对路径、目标与其上级可写、不在当前目录内部或上级、云同步目录警告、按盘核对空间（新目录约 2×数据库，跨盘或目标是 FAT/exFAT（没有硬链接）时再加按目标簇大小计算的 CAS 占用；临时目录 1×数据库；旧目录 1×数据库的 Backup API 暂存，同一块盘合计），目标已有 LimCode 数据时当前库要一次合并进它的当前库，当前库行数超过合并引擎的单事务硬上限（`RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS`）时在任何协调和重载之前拒绝、旧目录不受影响；写入新建的根（空目录、拷来的数据挪开之后、其它数据集）不受此上限；目标分类：不存在或空目录（忽略系统杂项和扩展自己的指针文件及其锁）新建根；已有用户文件的文件夹（哪怕与已登记目录同名）只能用其中新建的 `LimCode` 子文件夹；在该路径创建的 LimCode 数据（选择文件、Runtime 目录或 index.json+records/ 记录存储这类结构，不按名字认）合并进它的当前库，它有在线 Host 或有进程仍在的准备记录时拒绝；从别处拷来的 LimCode 数据（RootBinding 记的是别的路径）只有 LimCode 自己的条目且没有在线 Host 时，整体改名为 `<名>.limcode-copied-<时间>-<迁移 id 前 8 位>` 挪到旁边保留（先写进行中记录再改名，崩溃后凭迁移 id 找回）、永不删除也不合并（与当前库同一 dataSetId 时说明它是当前数据的旧拷贝），再按空目录迁入，撤销时改回原名（原位置只剩维护声明时先把它挪到同级的 `<名>.limcode-undone-<时间>`；改不回就不算恢复，并写明拷贝在哪），混有用户文件时只能用新建的 `LimCode` 子文件夹；把其中不同的库登记为可在“历史与存储管理”里手动合并的历史库尚未实现。迁移记录写明它描述的目录，随目录拷来的记录一律忽略。确认后在 globalStatus 比较并写入迁移进行中记录（已有进行中的迁移就拒绝，清除时只清自己的），在线阶段在目标写准备记录与持久日志、初始化全新根，在线把其它数据集整库分批复制进目标下各自的全新根（独占阶段按来源文件状态确认没变才保留，变了就清空重做），再锁外预复制当前库的 CAS（来源经本窗口 RuntimeDatabase 的 Backup API 读取，暂存与快照名带进程号；记下每个已校验对象的 dev/ino/size/mtime/ctime，独占阶段元数据一致就不再重算摘要）；再经通用独占维护（final-countdown：其它窗口倒计时后重载、不能否决；等待忙窗口在锁外进行；发起窗口自己的任务也算忙（提示一次，锁外最多等 10 分钟）；go 之前 beforeGo 冻结本窗口（不再开始新任务）并确认空闲，不空闲就放弃并说明原因；操作内向等待打开的窗口报告阶段；协调键带本次尝试的身份）让旧目录全部窗口重载，本窗口关闭 Runtime，在两边 configuration admission 内：记下来源内容指纹，复制配置（已登记目录和文件、全局规则 AGENTS.md/CLAUDE.md、全局技能 skills/；任意深度的记录存储按 id 合并、同 id 不同内容以当前为准，被替换版本先复制进 `.limcode-relocation-backups/<迁移 id>/configuration/` 再原子替换，逐文件 SHA-256 核对并 fsync；只跳过 LimCode 自己的锁和临时文件的确切名字），已有目标库先离线复制撤销副本并用合并引擎迁移模式一个事务写入当前数据集，全新根则由 `runtimeDataSetBulkCopy.ts` 按同样的来源规则分批写入（每批是完整的跨行闭包：ModelRequest 聚合、协作消息与其 payload 同批，Turn 与 TurnIntent 不同批；写完按有序 id 流式全量核对；目标在两边 admission 内不可见，失败整体撤销）（允许选中来源、不写合并账本、未完成工作原样携带，正在接收回复的模型请求和运行中进程整体拒绝），其它数据集按原 id 各自成为目标下的独立用户保留库（已合并进当前库且之后没改动的不再复制，迁不了或无法读取的写进完成记录，设置页按原因说明怎么处理），写完成记录（每个已迁移库的来源指纹、每个配置项的树摘要、接收库指纹），最后切换指针（同时写数据根身份和本次迁移 id、只清除自己的进行中记录），再在旧目录写“已迁到新目录”标记 `.limcode-data-root-moved.json`（新目录、时间、发起安装）。目标里每一步先写日志再做（合并前记下接收库目录已有的条目，撤销时删掉合并备份）；切换前任何失败都按日志撤销：先把记录持久改为 undoing（之后无条件续撤，不看指纹和日志），放回撤销副本（可重复执行）与被替换的配置、删除本次新建的条目，再删日志目录，最后恢复或删除记录；没撤销完如实报告并保留进行中记录，崩溃留下的由下次启动按进行中记录撤销（迁移进程仍在时，重载后等待的窗口显示“正在迁移数据目录，完成后自动打开”），同一来源完成但没切换指针、接收库也没变的，下次迁移前整体撤销重做；切换生效、在新目录打开后删除日志与数据库撤销副本，被替换的配置版本保留；启动时清理已结束进程留下的私有副本。迁移本身从不修改旧目录的数据。删除旧目录要求指针 lastMigration 里的迁移 id 与当前目录完成记录一致（“回到旧目录”“选择其它目录”“使用默认目录”只切换指针、不写迁移 id，永远不能作删除依据），只删当前目录完成记录证明已迁移、且指纹或摘要表明迁移后没有改动的内容，以及旧目录已没有保留库时 LimCode 自己的记录；归档并重置的归档、合并备份、升级备份默认保留，单独勾选（写明大小）才删；其余一律当用户文件保留；要求旧目录全部 Host 离线，确认之后清单有变就一项都不删。“回到旧目录”只切换指针，并让当前目录的完成记录失效（之后要删除旧目录须再迁移一次），清掉本安装在旧目录留下的“已迁走”标记；其它安装打开带这个标记的目录时给出不阻塞的警告（继续使用会产生分叉），提供“改用新目录”；当前目录不可达时不在它上面协调，仍开着的其它窗口的配置路径固定在它打开时的目录，发现指针变了就拒绝读写配置并提示重载。自定义数据目录用身份文件 `.limcode-data-root-identity.json` 与 globalStatus.dataRootId 比对（没有记录身份时至少要有 LimCode 结构：选择文件、身份文件或 RootBinding 指针，设置记录存储不算；自定义目录第一次正常打开时在 admission 内写身份文件并记下 dataRootId），身份文件暂时读不到时只提示重试，缺失、不一致或只有同名空文件夹都判为不可用：启动拒绝打开，提供“重试 / 回到旧目录 / 选择其它已有目录 / 改用默认目录（二次确认；默认目录已有数据时说明那是旧数据，上次迁移正是从默认目录迁出时引导用“回到旧目录”）”，绝不在其中新建空库；读配置和默认设置都不创建目录。

多窗口执行资格（`docs/architecture/reliable-kernel/01-invariants-and-authority.md` §2.1）：对话的执行（调用模型、执行工具、推进 Turn、准入排队输入、投递续跑）只交给服务它的窗口；控制类操作（停止、删除、改名、记录回答或审批）任何窗口都能做，不合格窗口做完立即交还归属与租约。每个活动 Turn 和排队 TurnIntent 按自己冻结的工作环境定位：冻结的不是项目自身的环境时，只要求该环境在本窗口可用，不要求项目打开；冻结的是项目自身环境时仍要求项目匹配。新输入、压缩与投递续跑按新 Turn 将冻结的环境判断，入口、准入与投递唤醒必须用同一判定，维护 Turn 实际冻结的内容必须与入口批准的一致。只有用户明确停止，并且执行宿主已被进程身份证明死亡时，才把核对不了的已派发效果标为 `outcome_unknown`；自动路径（恢复扫描、子 Agent 调度）从不这样标记。资格只是宿主本地筛选，归属记录、`ExecutionLease` 与栅栏仍是唯一权威。

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
