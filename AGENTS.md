# AGENTS.md

本文件是 Limcode Test 项目后续开发时 AI Agent / 开发者需要遵守的架构准则。项目由 [lurenxing628](https://github.com/lurenxing628) 独立维护，仓库地址为 <https://github.com/lurenxing628/limcode-test>。重点是：**ECS 数据、协议、effect、存储都要保持领域对象解耦**。当前准则来自 Agent 与 Conversation 解耦改造经验。

当前生产入口是 `vscode/extension.ts → VscodeReliableKernelApplicationFacade → VscodeReliableKernelProductRuntime → ReliableKernelApplication`。Runtime 生命周期与提交权威由可靠内核和 SQLite worker 持有，Client Feed 直接投影已提交事实；`backend/world` 中仍复用部分领域类型、工具声明与 prompt helper，但旧 ECS World/System 循环不是生产执行器。下文 ECS 示例表达领域解耦准则，不得据此恢复旧运行 writer。

提交消息只写简明中文标题，不添加 `feat:`、`fix:` 等类型前缀，不使用晦涩说法，也不写正文。每个提交只表达一个完整改动。

## 1. 总原则

### 1.0 兼容原则

当前项目仍然处于开发模式，因此不要对旧格式有任何兜底，也不需要保留旧功能代码的兼容和体验，也不需要写什么协议v1，v2等之类的运行时内部版本号，全面使用新格式新功能更优秀的代码。

允许机器合同使用日期化`planRevision/contractRevision`、密码学domain separator或单一Runtime schema epoch来标识当前定义；这些标识不得用于运行时版本协商、旧格式fallback或维护未发布格式的通用 migration 链。当前 Runtime epoch 为 5。为保留已发布用户的对话，精确支持版本 0.0.10–0.0.14 的 epoch 3 和 0.0.15–0.0.21 的 epoch 4 离线升级到 epoch 5：数据库打开前核对完整 table/index/trigger/manifest/RootBinding 指纹，要求其它 Host 离线，使用 SQLite Backup API 持久备份，通过 pending pointer、单事务和 durable journal 向前恢复；旧版中断的 3→4 pending/journal 经精确核验后先收敛；原 Conversation、Message、附件与 CAS 保留。epoch 3 的旧 Child Runtime continuation、epoch 4 精确缺少 RuntimeDeliveryIntentLink 的前驱，仅在身份与内容全部严格匹配时转换。不允许由其它缺表、字段或 digest 推导前驱。未知结构漂移和不受支持的旧 epoch 保持原根不变并 fail closed，绝不自动换成空库；用户显式归档重置另走独立入口。当前 epoch 内任何 table/index/trigger/manifest/RootBinding 漂移也 fail closed，不补表、不修 metadata。

已发布 epoch 3/4 的备份升级自动执行，不要求用户点击单独升级命令或确认：当前根仍在 Runtime 打开前升级，其余旧根在当前 Runtime 就绪后逐库处理，查看旧历史时补做。每份目标必须离线并独立核验；其他正常数据集可继续使用。失败逐库报告，禁止隐式切换选择、启动非当前旧任务或把异常来源替换为空库；数据集合并只能按下一段的历史合并合同执行。候选发现可分别返回可用项和错误，任何来源的实际打开/升级仍必须严格通过原有身份与指纹合同。

没有选择文件时（从按工作区分库的版本升级）不要求用户在多个库之间选择，但只在通过只读可升级性预检的候选中自动选：已发布 epoch 3/4/5、表结构与物理指纹精确一致（已发布 3/4 另做 quick_check）、配置根合并账本里没有同一内容状态的失败记录（未完成的归档/根切换恢复窗口交给既有恢复入口判定）；其中固定默认根已初始化（有完整 RootBinding，哪怕还没有对话）则选它，否则选 SQLite 最近修改的旧工作区库，发布选择后照常就地升级。全部不通过、或固定根/scope 容器本身不可读时要求显式选择，列表写明每个库的原因，并用项目文件夹名、对话数和最后活动时间标识各库；已有选择从不被改选。历史合并在当前选中数据集正常打开、本 Host 就绪并完成后台升级之后，在后台逐来源在线进行，不要求确认、不重载窗口：旧版本（没有切换记录）留下的其它数据集（全部工作区 scope 与固定根）自动合并一次；本版本起用户经“切换当前历史库”切走的库在其控制根记为“用户保留”（标记读不出时按保留处理；写不了标记就不切换；切走一个已无法检查的库时记为保留它的任何实例），和已合并过的来源一样只在用户明确请求后合并；明确请求只作用于用户点击触发的那一次合并调用（结果总会提示，来源已合并且没有新内容时提示“已合并，没有新内容”；确认框写明中断的任务按“中止”收尾、排队未发送的消息会被取消，以前合并进来、之后在当前库删除的对话不会再合并回来，超过在线上限时会在后台等其它窗口的任务结束、正在使用的窗口被切走，最多约 10 分钟、可取消，然后其它窗口重载一次，以及超过单事务硬上限的不能合并，数字都取自代码常量；切换当前历史库的说明对已合并进当前库的库也写明删除过的对话以后不会被插回），记录下来的请求只让该来源在之后的启动里按普通待合并处理，7 天过期（过期时提示一次再删除，不悄悄消失），合并成功、受阻或失败后删除。选源时在 configuration admission 内只读账本、请求和文件状态，内容指纹只用按确切文件状态缓存的值；未命中缓存（例如切过去看过、目录被复制或恢复、库已损坏）而判断又需要它的来源，在锁外逐个计算后再判断。来源必须离线（Host liveness，以及 v0.0.10–v0.0.20 的 `runtime-owner/owner.json` 按进程身份判定）；来源先完成已发布 3/4 的备份与就地升级，再在私有快照上通过当前 epoch 完整指纹与完整性核验（复制前后 SQLite 文件状态不变才算数，否则重新复制，最多 3 次）。快照、worker 核验与内容摘要、冲突与规模判断、正文校验与复制、目标备份都不持锁；只有来源收尾（来源备份 + 终态转换）和最后的“复核 + 事务”持有 configuration admission 与来源 maintenance，锁内复核来源仍离线、身份与指针代数不变、SQLite 文件状态与核验时一致，提交前再重读账本。多个窗口可同时准备，提交串行：后到的窗口在锁内发现同一内容已被合并就直接跳过、不提示；来源文件在此期间变化时先在锁内重读账本，本批选源之后已被合并进同一目标（例如被先到的窗口收尾并合并）同样静默跳过，否则推迟，下次启动再判断（其它原因的推迟之前也重读一次）。来源的未结束工作只在未收尾快照上的拒绝探针、冲突、规模与正文校验全部通过后才收尾，且内核自己的对话忙碌探针先按“收尾之后”的状态判一遍全部对话，仍判忙就在收尾前整份拒绝；收尾只用现有控制面终态转换：先用 SQLite Backup API 备份来源，active Turn 以 cancelled（有中断请求时 interrupted）结束并写原因（旧版本留下的库写“旧版本升级时中断，合并前收尾。”，本版本用户保留的库写“合并前收尾。”），随之释放 lease、取消未开始的模型请求与没有 Operation 的工具调用、取消排队的用户消息；收尾的任务数与消息数按收尾后来源里的实际状态统计（账本记下要收尾的 id，中途出错或崩溃后再收尾不重复计数）；没有现成终态转换的状态（等待回答或批准、运行中的子 Agent 与未送达的答案、待投递消息、运行中进程等）整份不合并，写明原因和出路，不发明收尾语义。写入目标只经当前 RuntimeDatabase 的正常写事务，每个来源一个事务：逐行 codec 解码，再用各领域 Repository 插入步骤写入（ModelRequest/Operation/Attempt/ModelStreamFence/ModelStreamCheckpoint 中已开始或已结束的行以历史复制插入，仍受 worker 不变量约束：历史复制的 ModelRequest 必须已终态，其 Operation 只收 completed/cancelled/failed、Attempt 只收 transient_failed/completed/cancelled/failed，ModelStreamFence/ModelStreamCheckpoint 只能随父 ModelRequest 在同一事务里以历史复制写入），事务末尾断言每个来源 id 都已存在；这个事务以 synchronous=FULL 提交（只对这一个事务，提交或失败后都改回 NORMAL），落盘之后才写“已合并”记录、删提交凭据，断电不会留下账本说已合并、当前库却没有的状态；同 id 同内容复用，只有 ContentObject、ProjectContext、Attachment、AttachmentObservationLink 这类内容派生身份允许合同列出的列不同并保留目标行（事务内仍不存在才插入，否则按同样规则比对），CollaborationMessage.message_seq 由 worker 在合并事务内按来源顺序接在目标当时的最大值之后分配（规划之后其它窗口再写协作消息也不冲突，超限来源等其它窗口让出后不会因此失败），其它任何差异整份拒绝且不改动目标。有行要写入时才在线用 Backup API 备份目标（每批一次，目录按 UTC 毫秒时间与进程内序号命名；本批没有任何事务用上的备份在批末删除，用上时目标控制根 `merge-backups/` 按创建先后保留最新 3 份，另外总保留本批自己的和本批开始前最新的一份；备份前按库文件与 WAL 的大小加 64 MiB 余量核对所在盘的剩余空间，不够就推迟、不去写盘，原因写“磁盘空间不足，需要约 N MB”，同一原因只提示一次；来源收尾前的备份同样核对），并先发布校验过摘要的 CAS 对象，事务只提交引用；没有要插入的行时只记“已合并”，不备份。来源行数超过内存单事务上限（`RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS`，60000 行）时，在任何规划、协调、备份、收尾之前推迟为 `runtime-data-set-merge-awaiting-exclusive`（不写账本，批结果带行数与字节数，“历史与存储管理”按待合并显示），留给大库会话（`runtimeDataSetStreamedMerge.ts`）；自动批次里超过在线上限、本该单独协调的来源在核验之后先放到批末，批里有等待大库会话的来源时它们同样推迟为这个代码、随会话一起合并（一次协调、一次重载），没有就照常逐个协调，用户点的那份照常单独协调。大库会话先在线准备（`prepareLargeMergeSources`，窗口照常可用；同一来源同一时间只有一个窗口准备，账本 `preparing/<id>.json` 每 10 秒心跳，进程已不在或 60 秒没刷新可以接手）：快照与核验、未完成工作探针、流式试算 `scanMergeRows`（每 250 行解码一次、经当前库 reader 按 id 比对，只留计数、最多 20 个冲突样例与耗时，有冲突整份受阻），需要收尾时照常收尾后重新快照、核验、试算，再发布正文并保留校验记录、在线备份目标；再在调用方持有 configuration admission 与目标 maintenance、本进程运行时已关闭时独占执行（`runLargeMergeSession`）：以 `historical-merge-<uuid>` 打开私有维护实例，逐来源取来源 maintenance、复核来源不变、重新复制快照（文件状态与核验时一致才沿用结论）、正文只做 lstat、重读账本、写 committing，然后在一个 worker 维护事务里按 `MERGE_DOMAIN_ORDER` 与 rowid 每 250 行比对一次、追加一次，逐行规则与在线合并同一个 `planMergeChunk`（内容派生身份用 savepoint、协作消息序号在事务内分配、历史复制、以前合并后删除的对话在私有快照的 TEMP 表里求跳过闭包），每块末尾追加本块的存在断言；提交前写全证据，以 synchronous=FULL 提交后 `wal_checkpoint(TRUNCATE)`，之后才写“已合并”；可以取消，只回滚当前来源、已合并的保留；SQLITE_FULL 回滚、收回 WAL、推迟并写明所需空间；独占阶段遇到新冲突整份回滚、记为受阻。用户同意之前只做只读估计 `estimateLargeMergeSources`：不收尾、不备份、不传正文、不写账本、不占准备记录、不就地升级已发布 3/4（改为推迟），来源的确切文件状态命中审计缓存就不再复制，否则复制核验一次；外来历史库只经它的声明读（声明在当前配置根，配置准入之外取、估计完就释放），不碰它的本地路径，正文按全部复制计空间与时长；每份来源给出与准备同义的内容指纹（没变就不变，可作操作键），准备与独占两段时长分开给出，按行数、库大小与正文对象数用保守速率估计（独占阶段按本机上次会话实测的快慢换算，限 0.5–4 倍），范围取 0.4–2.5 倍（准备按实测试算重新估计）。准备有副作用，只在用户同意（倒计时结束没有推迟，或手动确认）之后调用；准备中途取消时不给来源，交还全部准备记录与没用上的目标备份。审计结果（行数、字节数、正文对象数与字节数、未完成工作）按来源确切文件状态与身份缓存在账本 `audits/`（外来历史库的按它的 id 记在当前配置根），不是权威：在线批次判断等待的来源、估计、准备判断不进会话的来源都先用它，真正合并前照常复制核验，并由 `assertUnchanged` 与指纹复核；正文核验过的文件身份记在 `.limcode-runtime-merges/limcode.cas-verified.sqlite`（LimCode 自己的库名，本进程只开一个连接，90 天没有再确认的记录丢弃），身份不变就不再哈希，有任何变化就完整哈希；会话把真正合并了的来源实测的独占耗时与估计模型给的时长记在账本 `rates/`（只作估计，模型不足 1 秒的会话不记）。维护事务只能在持有该根 maintenance、没有在线 Host、没有提交监听者的私有实例上使用：事务期间拒绝其它写，追加失败整笔回滚，请求聚合跨块累积（写在 writer 的 TEMP 表里）到提交时统一断言，其余插入不变量不变，提交不回传 changes、分配记录只给计数；维护实例与来源拷贝的页缓存都封顶，内存不随来源行数增长。超过流式硬上限（`RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS`，2000 万行）的来源才在任何规划、协调、备份、收尾之前拒绝，账本记 `too-large`（行数与判定时的上限，不算失败；上限与来源都不变就不再自动重试，按别的上限记下的——包括以前按 60000 行记下的——重新判定），“历史与存储管理”显示约多少条记录、当前版本不能安全合并，可切换过去查看。超过在线事务上限（`RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS`，4000 行或 12 MiB；实测最坏约 1.3 秒，远低于 busy_timeout）的来源才走通用独占维护（`migration.json#exclusiveMaintenance`，写在目标控制根 `exclusive-maintenance/`：每个窗口先回答就绪/忙/拒绝，全部就绪才倒计时确认（倒计时期间请求撤回就关闭倒计时，本窗口不重载），全部确认才统一重载，在此之前任何窗口都不让出；有忙、拒绝、未参与协作的旧窗口、超时或取消时立即放弃并推迟这份来源（正在关闭或重载的窗口不算旧窗口：它的登记改为“离开中”，运行时关完才删除，请求方按缺席处理并有上限地等它下线）；go 之后遇忙本次调用结束，每个窗口每次操作最多重载一次；两个请求方不互等，窗口自己的请求进行期间答忙且不让出，较新的请求让先并写明原因（同一操作键即同一项工作时较新的一方直接让先，不提示、不记退避，较早的一方不把它的窗口当忙；因自己的其它维护答忙的窗口单独写明“正在进行自己的维护”）；等待忙窗口只在锁外进行，持有 admission 与 maintenance 的只是有时限的短轮次（准备 8 秒、确认 20 秒、让出 30 秒，再执行操作），发起窗口在 go 之前经 `beforeGo` 先确认空闲、再只做不会失败的冻结（钩子抛错按忙）；放弃或让出后操作失败都按操作键指数退避，确定性失败转 blocked 只拦自动调用，同一操作发布 go 后冷却，`ignoreBackoff` 须每次调用显式传入，只跳过按键退避与 blocked；冷却按操作、不论操作键（键里带每次尝试的 id 也绕不开），挡住自动调用和不带发起方 token 的明确调用并写明何时可再试；token 按操作名存在发起窗口的 workspaceState 里直到操作完成，发起窗口失败重载后再试（换目标也可以）凭它越过，被重载过的其它窗口不能马上反过来要求别人让出；持锁方发布带心跳的维护进行中标记（操作可写入预计结束时间），重载后在 admission 上等待维护结束（超过约 1 秒显示原因，耗时只在通知里、按当前持有者计，带预计结束时间时写明预计几点前完成，久等或心跳停止时只提供继续等待或关闭窗口，心跳正常且带预计结束时间的维护要到已进行预计时长的 1.5 倍才算久等，绝不越过锁）并重读数据根，未发送的输入保存在 Webview 状态中（确认开始时与重载前请面板立即写入，pagehide 时也立即写入）；独占仍只以 Host liveness 证明）：只在冲突、正文、目标备份都已就绪之后、在全部锁之外发起，以来源内容指纹作操作键；全部窗口就绪后才经 `withLocks` 取 admission 与目标 maintenance，锁内只做来源复核与那一个事务；自动合并遇忙立即放弃并推迟，用户明确请求的合并在锁外有上限地等待；协调未完成即推迟。由引擎推迟为等待大库会话（`runtime-data-set-merge-awaiting-exclusive`，不入账）的来源进入“大库会话”（`vscode/commands/largeHistoricalMerge.ts`；引擎的估计、准备与合并函数只经 `runtimeLargeMergeEngine.ts` 适配）：有大库会话时，其它超过在线上限的待合并来源不单独协调，随会话一起合并（一次协调、一次重载；用户点击的那一份照常单独协调）；用户同意之前只做只读估计（`threshold:'online'`，中等来源一起估计；在全部锁之外调用，适配层在配置准入内被调用时直接拒绝），准备只在同意之后调用。启动后只有一个窗口提示：提示记录在配置根 `.limcode-runtime-merges/prompts/`，同一 VS Code 会话（`vscode.env.sessionId`）或记录进程仍存活时别的窗口不提示，它只是提示、不是合并记录；估计之前先只读查询协调会不会被冷却挡住（`readExclusiveMaintenanceRefusal`：只有其它窗口在线时才看冷却与退避，不写任何东西），挡住就不估计、不倒计时，写明何时可以再试（同一原因只提示一次）；估计在状态栏进行（只有要复制核验的来源才逐份写明复制、核验；按批次缓存的审计估计时什么都不复制），估计时已有结果的来源按在线批次说明；再按估计给出的空间数字预检（其中含准备要做的目标在线备份与要复制进来的正文；当前库所在盘 `targetBytes`，余量已含在内；临时目录 `temporaryBytes`，临时目录在另一块盘时另加 64 MiB；同一块盘合计），不够就不提示开始，只说明还差多少（同一原因只提示一次）；再用估计给出的各来源指纹（与准备的同义）生成操作键查询一次，会被冷却、按键退避或 blocked 挡住同样不倒计时、写明何时可再试；都没有就以可取消的进度通知倒计时 60 秒（写明份数、约多少条，以及“倒计时结束后先在后台准备约 X（期间照常可用），准备好后所有 LimCode 窗口重载一次，暂停约 Y”：X、Y 是估计给出的准备与独占两段时长，不到 1 分钟时写“不到 1 分钟”；并写明显示进度、完成后自动恢复、未发送的输入会保留），点“取消”只改到下次启动：什么都没准备（不收尾、不备份、不传正文、不占准备记录），不写账本，没有“永不”；倒计时结束才准备（可取消的进度通知，窗口照常可用，逐份写明复制、比较、收尾、复制正文、备份；只准备估计后剩下的来源；中途取消同样改到下次启动），准备时才有结果的来源同样说明；准备好却没有开始合并（取消、准备中途取消、空间不够、协调没有进行）时交还引擎为它保留的东西（来源声明、没用上的目标备份）；准备好后等本窗口和其它窗口的任务结束（沿用最多 10 分钟的锁外等待）再开始，协调的操作键取准备给出的指纹（只有来源收尾之后才与估计时不同）。“历史与存储管理”在有来源等待时列出“合并较大的旧聊天记录（N 份，约 X 条记录，开始前给出预计时长）”，合并列表把这些来源标为“较大，等待合并（约 X 条记录，开始前给出预计时长）”（行数取本进程最近一次批次测得的大小；列出时不估计，不编时长）；手动开始先只读查询冷却（挡住就说明原因、什么都不做），再在可取消的通知里只读估计（取消或出错时什么都没准备），说明估计时已有结果的来源、按估计的空间数字预检（不够就不开始并说明），再用原生模态框确认（写明份数、约多少条，先在后台准备约 X、再等任务结束，然后所有 LimCode 窗口重载一次、暂停约 Y），确认之后才在可取消的通知里准备（中途取消时把已准备好的来源交还引擎，不协调、不合并），明确请求合并这类来源时同样进入这一流程；估计或准备时没有已有结果的来源、仍有来源进入会话时，不对这次点击说“没有合并”（结果在会话之后说明）；这个入口会写库，本窗口冻结期间按写命令拒绝（确认之后才冻结的也拒绝）。两种开始都调用 `runWithExclusiveMaintenance`（`historical-merge`，与中等来源共用冷却；操作键为目标身份加各来源内容指纹的摘要；`whenBusy:'wait'`；自动开始 `final-countdown`、`ignoreBackoff:false`，手动开始其它窗口只提示（`notice`）、`ignoreBackoff:true`；协调中不给取消按钮，go 之后不理会取消；`beforeGo` 照迁移先检查本窗口空闲、再冻结本窗口）；独占阶段在 `withLocks` 内先用 `fs.statfs` 再核一次空间（不够就不关运行时、不重载，说明原因），请面板立即保存未发送的输入，关闭本窗口的运行时，再由引擎逐来源合并：发起窗口的进度通知（“正在合并较大的旧聊天记录 2/4（已处理 12 万 / 38 万条，约还需 3 分钟）”：已处理按引擎比较过的来源行数计，剩余时间用引擎按本次速率算出的值）每 0.5 秒最多更新一次，可以取消，取消只回滚正在合并的那一份，已合并的保留；其它窗口的打开外壳由 `reportStage` 更新，只在换来源或进度每增加 5% 时重画，维护标记带预计结束时间（预计区间的上限）；锁放开后本窗口重载，结果先存在本窗口 workspaceState，重载后（10 分钟内重新打开）按在线合并的同一套通知与去重说明每份合并了多少对话（“查看详情”逐份列出，以候选列表读到的项目名标识，没有时写“旧工作区历史”或“默认历史库”，再附位置与规模）、被拒或推迟的原因；引擎在会话开始时的空间预检不够、什么都没合并时，重载后说明没有进行及原因；协调没有进行（忙窗口等不到、有窗口保留、退避等）时本窗口不重载，说明原因（自动开始按原因只提示一次）。合并账本在配置根 `.limcode-runtime-merges/`（删除目标后仍在）：提交前记录插入行的证据集（`commits/<id>.json`：全部新增对话 id，加上内容派生领域以外每个领域首末各 50 个，对话多时其它领域每端收缩、至少首末各 1 个，总数不超过 2000；事务是原子的，证据与全集等价），committing 视为未合并；收敛只以内容派生领域以外的行为证据（内容派生身份可能被其它窗口独立写入）：全部在记为已合并，全部不在撤掉记录重新合并，部分在记为受阻并提示手动处理（全部在与部分在都证明事务已提交，这批插入的对话照样记入账本）；每条记录按目标累积记下各次合并实际插入的对话 id（`mergedInto`，同一来源之后的记录都携带），再次合并（明确请求、记录下来的请求，以及崩溃后按实测收敛的自动路径）时其中现在目标里已不存在（用户删除）的对话连同它的子 Agent 对话默认跳过：它的消息、Turn、模型请求与其 Operation/Attempt、工具调用、上下文序列、进程、效果与收据、交互请求、看板频道与帖子等按外键和归属整体不插，插入的行不引用被跳过的行，内容派生行照旧仍不存在才插，跨对话的协作历史与删除对话时一样保留；结果、通知与日志报出跳过的数量（按删除的对话计）；committing 记录带着它替换的记录：事务失败后实测确定回滚、或崩溃后下次启动实测全部不在时，原样放回那条记录（连同判定时间，之后的请求据此判断是否重试；上次合并也不丢），结果不明才留给下次启动收敛。收尾时把要收尾的 id、收尾数与收尾前备份位置记在账本 `finalizations/`；这条记录只随一个结果说明一次：合并成功或发现已合并时在 admission 内取走它的那个结果（另一个窗口先报告过的不再重复，别的窗口读到过它也一样），被拒时写在原因里后删除；收尾之后停止（按推迟处理）或推迟的尝试把它留给下次，被拒文案不再写“两边内容都没有改动”。删除确认对还没有合并到当前库的库都会警告，包括从未入账、只是被推迟过的待合并库。只有来源自身的确定性问题（结构、指纹、完整性、行不符合当前格式、正文缺失或摘要不符、未完成恢复、epoch 不支持、升级的非暂时性失败、与当前库是同一数据集）记为失败；目标关闭、窗口关闭、I/O、空间、权限、worker 或内部异常一律推迟、不入账；事务提交之后，写合并记录、释放锁或结束独占维护失败只记日志，结果仍是已合并（没写成的记录留着 committing，下次启动按实测收敛）。合并、受阻、失败、太大都按来源内容记录（全部表全部行的摘要，由 worker 在私有副本上计算，按确切文件状态缓存；WAL 检查点、原样复制或恢复、只打开不写入都不算变化），来源之后有变化时显示“合并后有新变化”并可明确重新合并，内容读不出来（例如临时目录空间不足）时显示“无法读取”，不当成有变化；“历史与存储管理”读取非当前库（合并状态的内容指纹未命中缓存时、对话数与最后活动）都在该库的 admission 与 maintenance 之内复制，不与本进程里打开着它的操作重叠；之后的明确合并未成功时，记录保留上次成功合并。合并进来的对话在任何窗口都不会被恢复、投递或继续执行；不切换选择。启动提示按原因在每个配置根累积，只有重新评估过的来源才清除旧原因，用户明确请求的结果总是提示；合并与收尾的通知和日志写明收尾的中断任务数、“另有 N 条排队未发送的消息已取消”和跳过的对话数；详情保留在日志与“历史与存储管理”。

备份清理（设置页“其他 → 数据目录”的“清理备份…”；“历史与存储管理”和命令面板的同名入口只打开设置页；`runtimeBackupCleanup.ts`，`migration.json#backupCleanup`）只删能证明完整存在于本地库的副本；检查与删除都按写命令经写入闸门（冻结基线把进行中的检查算作写命令），本窗口因数据目录操作冻结期间拒绝（入口说明原因，确认之后才冻结的删除同样被拒绝）。可删的是三种备份——升级前备份（`epoch-migration-backups/`）、合并前备份（`merge-backups/`）与合并来源的收尾前备份（`merge-source-backups/`）——和核验通过的外来历史库（见本段后半）；副本的可读历史都在证明它的本地库里（备份是它所在控制根的库）才算覆盖：全部 `conversation.id`、`message_revision.id`，用户看得到的其它历史记录的 id（`RUNTIME_HISTORY_RECORD_DOMAINS`：轮次与结束记录、工具调用与结果、交给模型的工具结果、工具产物、文件修改及明细与确认、交互请求与你的回答、进程与输出、附件与关联、上下文压缩、子任务、协作消息——都没有 delete 变更，只随对话删除或从不删除，合并按原 id 带过去；控制面、上下文、投递、协作看板等不算），以及它引用的每个正文（那个库有这个 content object，它的 CAS 里 storage key 处是同样大小的普通文件，只 lstat）；还要显示一致：副本里显示的每条消息（`deleted_at IS NULL`，取当前版本）在那个库里也显示、当前版本相同。对话是硬删除，缺对话、消息版本、记录或正文的写明缺什么并按历史保留（“含 N 个当前库没有的对话（可能是你删掉的）”“含当前库没有的记录（工具调用 3 条、… 等）”“当前库里缺 N 个它引用的正文文件”）；只是显示不一致的（那个库里的消息被用户删除、编辑或重试替换：软删行和旧版本还在，能证明是用户操作）可以删，但单列一组“含你后来删除或替换的内容”，写明“其中 N 条消息在当前库里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了”，默认不勾选；全部一致的才写“内容已完整在当前库里”并默认勾选。库的名字与“历史与存储管理”一致（当前库、`历史库“项目名、…”`、没有项目时“旧工作区历史”或“默认历史库”），不写 id；硬链接等提示也只说“另一个历史库”。副本只在 facts worker 里读私有拷贝，id 与显示集合直接从表读（每张表 `NOT INDEXED` 各自读出再连接，不经主键索引），按确切文件状态缓存在 `.limcode-runtime-merges/coverage/`（只是缓存，连同库的项目名）；当前库只经它自己的 worker reader 每次查 250 个 id（显示集合每条消息查 `Message` 与 `MessageCurrentRevisionLink` 两个，一次 125 条），绝不在本进程另开或关闭它的 SQLite 文件——复制任何副本或其它本地库之前先按 dev:ino 比较，与当前库或其它本地库的库文件、`-wal` 是同一个文件（硬链接）的一律不读、按历史保留；其它本地库在其控制根 maintenance 内复制后由 facts worker 读。原因只写中文，技术原因只进日志。另须：升级前备份有 to epoch 5 的完成记录（已发布 0.0.15–0.0.21 同目录的 3→4 备份一律保留）、`nextBinding` 与现存库同一身份且现存库代数不低于它、升级完成满 7 天（取完成记录时间、目录名时间与完成记录文件 mtime/ctime 中最晚的，晚于现在按时间不可信保留）；合并前与收尾前备份的 `root-binding.json` 与现存库同一身份且代数不低于它。一律保留：控制根有进行中的日志（pending 指针、升级、旧版 3→4 升级、cutover）或正在提交的合并，每个控制根最新一份满 1 小时的完整合并前备份和比它新的（不满 1 小时的可能被写它的合并批次在批末删掉，不能顶替它），创建不满 1 小时（名字时间与目录修改时间取较晚的）的合并前备份，被尚未报告的 `finalizations/` 引用的来源备份，以及目录里有它的种类不会写的内容的（按种类逐项核对，都须是普通文件：合并前与收尾前备份只有 `root-binding.json` 与 `limcode.sqlite` 及其 -wal/-shm/-journal，升级前备份只有 `root-binding.epoch-N.json`、`runtime-kernel-epoch.epoch-N.json`、`limcode.epoch-N.sqlite` 及其伴随文件、完成的升级日志与完成记录，另认本清理的已核对标记；有 `.tmp` 普通文件的算没写完，其它任何内容都整份保留）。拷来目录整体（其中的设置、规则、技能）、归档目录里不是归档的条目、控制根旧格式 `backups/` 与 `.limcode-data-backups` 只列出名称、位置、大小和原因。检查显示进度通知；第一个 ConfirmPanel 按种类分组列出名称、大小、创建时间、用途、所属（按上面的名字）和结论，说明如实写上面的覆盖口径；只有可删的项有勾选框（`DataRootPromptOption.checked`）：内容完整的默认勾选，“含你后来删除或替换的内容”一组排在可证明的几种之后、默认不勾选；第二个 danger ConfirmPanel 列出将删除的项、合计大小、其中几项含你后来删除或替换的内容（共几条消息，删除后再也看不到）、核对时间并写明不能撤销；删除在 configuration admission 与该控制根 maintenance 内（两处都发布“清理备份”的维护进行中标记）重新核对文件状态、硬链接、现存库身份与代数、日志、最新一份与覆盖（当前库重查对话与显示一致，被替换的不能超出列出时的——删除对话、删改消息都不取锁；其它记录只随对话删除，正文从不删除；其它库按文件状态），改名为 `<名>.deleting-<id>` 后再同样核一次，不通过就改回原名并保留，通过才在目录里写入已核对标记并落盘（写明新名字、本配置根的路径和它的清理身份：`.limcode-runtime-merges/backup-cleanup-identity.json` 里的随机 token，第一次写标记时建）、再递归删除（标记最后删），标记之后的失败报“没有删完”；崩溃留下的 `.deleting-*` 只有本配置根写的标记（路径与身份都对）才由下次清理在同样的锁内删完，没有标记的、旧版本写的或别处写的（拷来的目录、另一个安装）一律改回原名重新核对；全程不跟随符号链接，预计释放不计入还有其它硬链接的文件。外来历史库（当前与离开过的数据目录（globalStatus `previousDataRoots` 与 `lastMigration.fromPath`，与外来历史库的发现相同）各 scope 的“归档并重置”归档，这些目录旁拷来目录里的默认根、各 scope 与它们的归档；由 `runtimeForeignHistory.ts` 发现与核验）在第一个面板单独成组，写明来源与位置：只处理核验通过的，未通过或暂时无法核验的写明原因只列出；可删须满足其一：与一个非当前本地库身份（dataSetId、rootInstanceId）相同且内容摘要相同，那个库的 id 与摘要读自同一份文件（读完摘要到读 id 之间变了的这次不删，写明暂时无法核对），它的正文也都在那个库的 CAS 里（当前库没有安全的摘要途径——`RuntimeDatabase` 没有摘要接口，复制它的文件会释放本进程的 POSIX 锁——与它身份相同的拷贝只按覆盖核对），或它与它控制根里保留的每份备份按上面的口径被同一配置根下的某一个本地库覆盖（同身份的库、当前库、其余本地库依次核对，取被替换的消息最少的）；显示一致的写明“内容已完整在当前库（或历史库“项目名”）里”，只是显示不一致的同样归入“含你后来删除或替换的内容”，覆盖不了的按最接近的库写明缺什么。删除单位是它的 located 控制根：归档整份删，拷来目录只删其中被证明的库（`.limcode-runtime` 或其中的归档），拷来目录本身和其余内容永不删，删到没有库时结果写明“其余内容（设置、规则、技能）保留，可自行处理”。控制根和数据根里的条目按名字与类型逐项核对：有旧格式 `backups/`、非空的调试取证、非空的进程输出暂存、`diagnostics/` 里诊断日志（`events.jsonl` 与轮换的 `events.1–3.jsonl`，不含对话内容，日志自己 7 天后删除）和空的 `debug-captures` 以外的内容、不认识的条目、类型不对的条目（`.tmp` 只认普通文件，声明目录只认 runtimeHostControl 的确切名字格式且里面只有声明记录、活动标记及其临时文件）、符号链接或特殊文件时整份保留；按覆盖证明时有未结束任务的也保留（覆盖核对不包括它们）；它保留的备份按原规则逐份核对（升级前备份满 7 天、3→4 的一律保留，合并前与收尾前备份要有绑定，目录内容按种类逐项核对），有一份不行就整份保留。外来库的数据库和它保留的备份只经外来库模块的复制函数读私有拷贝（复制前按 dev:ino 排除本进程可能持锁的库文件、前后文件状态一致），小记录一律按普通小文件读，id 按确切文件状态缓存。它的外来声明 `.limcode-runtime-merges/foreign-claims/<id>` 在检查、删除与收尾时都不等待地取（`refuseWhenHeld`）；打开着的只读查看在整个打开期间登记在当前配置根 `.limcode-runtime-merges/foreign-views/<id>/`（`runtimeForeignHistoryViews.ts`，在外来声明内写入、关闭时撤销，记下进程与它的起始身份，从不写外来目录），清理在声明内看到存活的登记（进程已证明结束的登记清掉不算，读不懂的按在用）或声明被核验、合并、另一次清理持有时写明“正在被另一个窗口或操作使用（只读查看、核验、合并或清理备份）”，不删；非当前本地库的摘要与 id 在它自己的 maintenance 内读，从不在外来声明里取别的锁。删除先在 admission 与外来声明内（都发布“清理备份”）确认没有打开着的查看、重新严格定位与核验、比较目录（每个目录按 dev:ino 与名字集合，正文库以外的每个文件按 dev:ino、大小、mtime、ctime、链接数，正文对象只看名字：它们只经 link() 发布一次、从不原地改写，证明也从不依赖这份拷贝的正文——不再遍历整个正文库的每个文件），确认证明它的本地库身份与代数不变并复核覆盖（当前库经 reader 重查对话与显示一致，其它库按文件状态），改名前最后一步再比较一次目录，改名为 `.deleting-<id>`、对新目录再核一次覆盖与目录、写带外来 id 的已核对标记并落盘；然后放开 admission，只在外来声明内递归删除（很大的正文库也不挡别的窗口打开），这时崩溃由下次清理凭标记删完；外来目录里只有被删那一份本身的改名、标记与删除，它的父目录里不新建任何东西；崩溃留下的按发现规则在原处找到，在 admission 与同一个外来声明（本配置根写的标记里的 id，否则按指针算出的 id）内收尾，删除同样在放开 admission 之后。两个安装共用同一个以前的数据目录时互不排斥（各自的声明在各自的配置根里），是已知限制。

外来历史库（“历史与存储管理 → 外来历史库”；`runtimeForeignHistory.ts`，`authority.json#rootPolicy.foreignHistory`）把界面里看不到的旧数据原位登记为只读历史：当前数据目录和历次离开的数据目录（globalStatus `previousDataRoots`：切走时把离开的目录记在最前，当前目录、要忘掉的和 `lastMigration` 清除时它的旧目录都去掉，最多 10 个，格式不对报损坏；列表之外，最近一次迁移离开的目录 `lastMigration.fromPath` 也照旧查看，本版本之前迁移过的安装只有它；迁移只搬历史库，归档留在那里，A→B→C 之后 A 的归档仍能列出）各 scope（包括只剩归档的 scope，按目录列出、不经候选枚举）的归档 `<scope>/.limcode-runtime-backups/<时间>[-epoch-<N>-to-<M>]-<id8>`（带 epoch 段的是已发布 0.0.15–0.0.21 启动时自动归档的名字；数据根是 `<归档>/active`），当前数据目录旁与这些旧目录旁的拷来目录 `<目录名>.limcode-copied-<时间>-<迁移 id 前 8 位>`（迁移完成记录的 `targetState.kind==='copied'` 与 `movedAside` 给出确切名字），以及拷来目录里的默认根、各 scope 和它们的归档。发现只列目录、读小 JSON，启动后在后台做一次，新条目提示一次；发现之后，已经没有归档、旁边也没有拷来目录的旧目录（保守判定：父目录能列出，目录不存在或能读且各 scope 能列出、没有归档也没有读不了的归档目录；读不了、盘没接上的一律保留）从 `previousDataRoots` 去掉（只去掉列表里的）。位置与身份分离（`LocatedRuntimeRoot`）：位置只由 getPaths（旧目录的归档以它的目录名开头命名）加固定目录名和严格匹配的名字推导，所有 fs 与 SQLite 读取只用 located；身份只由指针、epoch 清单与 SQLite `root_binding` 行推导且三者完全一致，recorded 只作身份栅栏（`assertDatabaseBinding`、审计 worker 的 `assertCurrentSchema`）和“原位置”文字，recorded 路径从不交给任何 I/O、从不探测原件。核验与本地候选同样严格，只把“路径相等”换成“recorded 路径自洽且末两级是 `.limcode-runtime/active`”：从容器起逐级 lstat、不跟随链接；指针严格解析，没有 pending 指针、非空 `-journal`、切换/升级/迁移进行中记录或正在提交的合并；epoch 清单 6 个键与 recorded 一致且 epoch 为 5（其它代列为未通过并如实写明原因：已发布 3/4 的归档原来的位置在归档时已交给新建的库、拷来目录不在别处升级，更早的不受支持，更新的要更新扩展，都不承诺“在原位置升级”）；`host-liveness` 里的进程都已证明结束（它不是目录、记录不是普通文件或格式无效时列为未通过，有进程在或无法确认时暂时无法核验）；外来根的每个文件（指针、epoch 清单、迁移记录、合并账本记录、host-liveness 记录、正文）都先 lstat 要求是普通文件并有大小上限，再以 `O_NOFOLLOW|O_NONBLOCK` 打开、按描述符 fstat 核对是同一个普通文件才读，从不跟随链接、不打开 FIFO 或设备；也从不打开与本进程可能持有 SQLite 锁的数据库文件同一 inode 的文件（本进程登记的数据库加当前配置根每个 scope 的数据库及其 -wal/-shm/-journal，只 stat；打开后才发现是这样的文件时描述符保留不关；Windows 没有这种锁，跳过）；合并账本里不是普通文件的条目不算记录；在私有拷贝上由审计 worker 核对 root_binding（含路径）、物理指纹、quick_check、foreign_key_check、内容摘要、行数与摘要信息（复制前后文件状态不变才算，最多 3 次，每次复制前重查上面的持锁文件；只读查看用同一个复制）；审计失败按 SQLite 结果码分类，不看消息文字：IOERR/FULL/NOMEM/BUSY/CANTOPEN 是暂时无法核验，其余（CORRUPT、NOTADB、结构或绑定不符）是未通过。结果按确切文件状态缓存在当前配置根 `.limcode-runtime-merges/foreign/<id>.json`（不是权威，每次使用都重读指针与数据库行；未通过条目的大小按树根与主要文件的状态缓存在 `<id>.size.json`），核验与读取的互斥声明在 `.limcode-runtime-merges/foreign-claims/<id>`，打开着的只读查看在 `.limcode-runtime-merges/foreign-views/<id>/` 登记到关闭为止（清理备份据此不删它）；除清理备份删除经证明的外来库时对被删那一份本身的改名、已核对标记与删除（见上一段）之外，外来目录里从不新建或改动任何文件或目录，SQLite 只开私有拷贝，不产生 -wal/-shm。id 为 `foreign:<archive|copied>:<sha256(容器相对名+数据根相对路径+dataSetId+rootInstanceId) 前 16 位>`（Windows 先转小写，文件名里 `:` 换成 `-`）。核验通过的列为外来历史库并注明来源（归档，或从别处拷来的目录），可只读查看（`openRuntimeDataSetHistory` 接收 LocatedRuntimeRoot）、统计 located 目录树的占用，也可由用户选择“合并进当前库”；语义等同用户保留：不自动合并、不可切换为当前库，不建立 RootAuthority、不打开 RuntimeDatabase、不登记 Host、不收尾不升级。合并（`runtimeForeignHistoryMerge.ts`，`migration.json#historicalMerge.foreignSourcePolicy`）只由用户明确操作触发：先在准入外严格定位并核对列表里所见的身份，再把带位置与名称的请求写进当前配置根的合并账本（`requests/<外来 id>.json`，只有外来 id 的请求带位置，外来来源只由请求挑选），之后与本地来源走同一套在线合并和规模分流（小的在线，中等的按现有独占协调，大的进入大库会话，会话与通知里显示可读名称）；从准备到提交持有它在当前配置根的声明 `foreign-claims/<id>`（与核验、查看和清理备份同一个声明，在配置准入之外取得；清理备份不等待地取它，合并持有期间清理保留这一份，删不到正在合并的来源；清理先持有时合并等它结束，来源已删就说明不在、什么也不写），提交前在声明内重新严格定位，复核指针、`root_binding`、epoch 清单、host-liveness 和各文件自核验以来的确切状态，有变化就推迟、不写 committing；快照与审计只在私有拷贝上，正文经不跟随链接的描述符读取、按摘要核对后复制进当前库（从不硬链接；复制前按缺失对象总量加 64 MiB 余量查空间，不够就推迟），合并从不在外来目录里建声明、写账本、做来源备份、收尾、升级或产生 -wal/-shm；账本记录与指纹缓存都在当前配置根，按外来 id 加来源身份记账，外来 id 的 committing 记录只约束目标、不影响它的核验。有任何未结束任务（可收尾或不可收尾）的记为 blocked 并写明数量与原因、不收尾，仍可只读查看；与本地某库身份相同的旧拷贝拒绝并写明是谁的旧拷贝（由清理备份按覆盖处理）；两份外来库身份相同时先合并的成功，后合并的没分叉就是没有新内容、分叉了按冲突拒绝，同一身份各份拷贝合并进来的对话按并集记账，在当前库删掉的不会被另一份插回。合并后列表显示“已合并（时间）”（之后有变化另外注明），并提示这份归档或拷来的库可以在“清理备份”里按覆盖核对删除。与本地某库身份相同的标为该库的旧拷贝；两份外来库身份相同且内容摘要相同的只显示一份（另一份标为完全相同的拷贝），摘要不同的分别列出；有未结束任务的注明合并前需要收尾、当前版本不在外来目录里收尾所以暂不合并，仍可只读查看。核验不通过的列出名称、位置、大小和原因，只提供“打开所在文件夹”，原样保留、永不自动删除；磁盘满、复制失败（任何原因）、复制期间一直在变化、中途被移走（写明已不在）或有窗口在用时显示“暂时无法核验”，不记为未通过、不入缓存。启动提示按发现的条数计数，只承诺核验通过的可以只读查看、可以由用户选择合并（不会自动合并）。删除本地历史库时保留它 scope 下的归档（确认框写明，之后作为外来历史库出现），枚举本地库时只剩归档的 scope 不算一个库。

数据目录迁移（设置页“迁移数据目录…”；命令面板入口只打开设置页；`migration.json#dataRootRelocation`）从不直接改写数据根指针，也不整体复制目录（RootBinding 存绝对路径且逐字段校验）。只有选文件夹用原生对话框，其余确认和提示都是发起它的设置页里的 ConfirmPanel（经 `dataRoot.prompt`，清单完整列出、不截断）；没有运行时（因而没有设置页）的恢复提示除外。先只读预检：绝对路径、目标与其上级可写、不在当前目录内部或上级、云同步目录警告、先按文件大小按盘核对空间（新目录约 2×数据库，跨盘或目标是 FAT/exFAT（没有硬链接）时再加按目标簇大小计算的 CAS 占用；临时目录 1×数据库；旧目录 1×数据库的 Backup API 暂存，同一块盘合计），不够就直接拒绝、不再统计行数；目标已有 LimCode 数据时当前库要一次合并进它的当前库，只有这时才在本窗口 Runtime 的读连接上统计当前库行数（不复制数据库，也不在旧目录写任何副本），超过合并引擎的单事务硬上限（`RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS`）时在任何协调和重载之前拒绝、旧目录不受影响；写入新建的根（空目录、拷来的数据挪开之后、其它数据集）不受此上限、也不统计行数；旧目录里被在线 Host（任何安装、任何版本）占用的其它库在预检和完成阶段都留在旧目录并说明原因（不用合并引擎“关闭后会自动合并”的说法），独占阶段只要求当前库和确实要迁移的库离线；目标分类：不存在或空目录（忽略系统杂项和扩展自己的指针文件及其锁）新建根；已有用户文件的文件夹（哪怕与已登记目录同名）只能用其中新建的 `LimCode` 子文件夹；在该路径创建的 LimCode 数据（有 Runtime 目录并选定了当前库，不按名字认；只有设置记录存储的文件夹算用户文件）合并进它的当前库，它有在线 Host 或有进程仍在的准备记录时拒绝；从别处拷来的 LimCode 数据（RootBinding 记的是别的路径）只有 LimCode 自己的条目且没有在线 Host 时，整体改名为 `<名>.limcode-copied-<时间>-<迁移 id 前 8 位>` 挪到旁边保留（先写进行中记录再改名，崩溃后凭迁移 id 找回）、永不删除也不合并（与当前库同一 dataSetId 时说明它是当前数据的旧拷贝），再按空目录迁入，撤销时改回原名（原位置只剩维护声明时先把它挪到同级的 `<名>.limcode-undone-<时间>`；改不回就不算恢复，并写明拷贝在哪；撤销删掉记录之后才改回，所以记录不在时 abandon、命令层和下次启动都按迁移 id 找旁边的拷贝，找到就不算撤销完、保留进行中记录；改名后的目录 fsync 失败也会改回），混有用户文件时只能用新建的 `LimCode` 子文件夹；挪开的拷来目录原位登记为外来历史库（见上一段），核验通过的可在“历史与存储管理 → 外来历史库”里只读查看，也可由用户选择合并进当前库。各 scope 的“归档并重置”归档不迁移、留在旧目录：预检写明份数，删除旧目录按目录列出每个 scope 的归档（包括历史库已删、只剩归档的 scope），默认保留；旧目录里还有归档时不忘记旧目录（`lastMigration` 保留，删除结果带 `remainingArchives`），它们经它继续列在外来历史库里。迁移记录写明它描述的目录，随目录拷来的记录一律忽略。确认后在 globalStatus 比较并写入迁移进行中记录（已有进行中的迁移就拒绝，清除时只清自己的），在线阶段在目标写准备记录与持久日志、初始化全新根，在线把其它数据集整库分批复制进目标下各自的全新根（独占阶段按来源文件状态确认没变才保留，变了就清空重做），再锁外预复制当前库的 CAS（来源经本窗口 RuntimeDatabase 的 Backup API 读取，暂存与快照名带进程号；记下每个已校验对象的 dev/ino/size/mtime/ctime，独占阶段元数据一致就不再重算摘要）；再经通用独占维护（final-countdown：其它窗口倒计时后重载、不能否决；等待忙窗口在锁外进行；发起窗口自己的任务也算忙（提示一次，锁外最多等 10 分钟）；go 之前 beforeGo 先确认本窗口空闲再冻结它：从冻结到迁移结束，本窗口在入口（Facade 与命令路由）拒绝一切写入类命令（新消息、重试、编辑后运行、压缩、计划审批执行、改名、删除、设置、清理备份等），提示“正在迁移数据目录，完成后再操作。”（其它数据目录操作换成各自的说明），查看与读取（包括查看存储占用、开发诊断）不受影响、输入框内容保留，冻结期间本窗口的忙只看冻结前已有的工作（冻结时仍在进行的写命令、冻结时持有的对话）；仍不空闲就退回锁外继续等（同样最多 10 分钟）；操作内向等待打开的窗口报告阶段，撤销时报“正在撤销”；协调键带本次尝试的身份，尝试结束即从账本清除；准备阶段的进度通知可以取消，进入协调与独占阶段后换成不能取消的通知，等待其它窗口时的通知同样不能取消，go 发布之后任何操作都不再理会取消）让旧目录全部窗口重载，本窗口关闭 Runtime，在两边 configuration admission 内：记下来源内容指纹，复制配置（已登记目录和文件、全局规则 AGENTS.md/CLAUDE.md、全局技能 skills/，顶层条目是符号链接时与目录内部一样按链接复制，预检与复制用同一判定；任意深度的记录存储按 id 合并、同 id 不同内容以当前为准，被替换版本先复制进 `.limcode-relocation-backups/<迁移 id>/configuration/` 再原子替换，逐文件 SHA-256 核对并 fsync；只跳过 LimCode 自己的锁和临时文件的确切名字），已有目标库先离线复制撤销副本并用合并引擎迁移模式一个事务写入当前数据集，全新根则由 `runtimeDataSetBulkCopy.ts` 按同样的来源规则分批写入（每批是完整的跨行闭包：ModelRequest 聚合、协作消息与其 payload 同批，Turn 与 TurnIntent 不同批；写完按有序 id 流式全量核对；目标在两边 admission 内不可见，失败整体撤销）（允许选中来源、不写合并账本、未完成工作原样携带，正在接收回复的模型请求和运行中进程整体拒绝），各库的调试取证（`<数据根>/diagnostics/debug-captures`）随库复制，其它数据集按原 id 各自成为目标下的独立用户保留库（已合并进当前库且之后没改动的不再复制，迁不了或无法读取的写进完成记录，设置页按原因说明怎么处理），写完成记录（每个已迁移库的来源指纹、每个配置项的树摘要、接收库指纹、发起安装），再在旧目录持久写“已迁到新目录”标记 `.limcode-data-root-moved.json`（新目录、时间、发起安装；每个真正迁走、带着未完成工作的库各一份清单 `carriedWork`，在记来源指纹的同一份私有快照上用 `inventoryRelocatedWork` 算出，不碰本进程可能打开着的源库文件；它是旧目录唯一的闸门，所以在同一准入内、切换指针之前写并 fsync，写不成就按切换前失败撤销整个迁移；旧目录原有别的迁移的标记先存进本次的工作目录，撤销时原样放回），最后切换指针（同时写数据根身份和本次迁移 id、只清除自己的进行中记录），再把记录确认为 published。记录状态：staging → complete（已复制、未切指针）→ published（发起安装切换指针之后；写不成也按成功处理，下次在新目录打开时补写）→ finalized（发起安装在新目录打开后删日志与撤销副本；其它安装打开时一律不收尾）。目标里每一步先写日志再做（合并前记下接收库目录已有的条目，撤销时删掉合并备份；合并提交前记下本次插入的行 `merging`）；进行中记录在第一次改动目标之前记下目标所在位置的身份（上级目录与目标的 dev:ino），找不到迁移记录时据此区分“已撤销或从未写入”和“此刻看不到”（盘没接上、盘符变了）：看不到就保留进行中记录（`unreachable`），一直看不到时可在二次确认后“放弃这次迁移的记录”（旧目录没有改动，目标里可能留有半截数据）；切换之后的任何失败都不撤销已生效的迁移：命令层先重读指针，指明本次迁移就按成功处理、只如实提示“迁移已完成，收尾时出错”，读不出指针就什么都不撤销；complete 记录只有调用方证明指针没有切换才撤销，published/finalized 永不撤销。切换前的失败按日志撤销：先持久改为 undoing（complete 记录必须写成，只有磁盘满时先撤销、每一步之后补记；staging 记录尽力写，写不成也照样撤销，这样别人看到的是“迁移失败、正在撤销”而不是“正在迁移”），undoing 的撤销总会续完（仍受下面的核对保护），接着去掉本次迁移在旧目录写下的“已迁走”标记（只动同一迁移 id 的，原有的放回；读不懂的不动；去不掉就停下、下次再试，续撤同样先做这一步），放回撤销副本（可重复执行）与被替换的配置、删除本次新建的条目，再删日志目录，最后恢复或删除记录；磁盘满时撤销照样先删，写不了的最后一步说明可以手动删除哪些内容；没撤销完如实报告并保留进行中记录（本窗口自己的，同一窗口再点迁移时先把它撤销完）；撤销前先核对接收库：与迁移前（撤销副本旁记下的指纹）、迁移写完时（日志 `received` 记下的指纹）都不一致，且在私有副本上去掉 `merging` 记下的本次插入行之后也不等于迁移前，才说明之后有人写入，就一步不做、把记录标为 `held` 并写明迁移前备份在哪，之后不再自动撤销；此刻读不出接收库就这次不撤销、记录不变，下次再试；还原数据库到一半（文件已放回）时按撤销副本记下的文件戳判断有没有人写过；只有出错后立即在准入内撤销时不必核对，但目标有在线 Host 时这里以及放弃、续撤、打开前撤销都一律不还原数据库；崩溃留下的由下次启动按进行中记录撤销（迁移进程仍在、且新目录里的记录仍是进行中时，重载后等待的窗口显示“正在迁移数据目录，完成后自动打开”，拿到锁后这条提示立即收起；失败后正在撤销或撤销没做完——记录为 undoing/held，或拷来的数据仍在旁边——启动时只警告“另一个 LimCode 窗口迁移数据目录没有成功，它在新目录里的改动正在撤销或还没有撤销完……”并照常打开原来的目录，迁移命令也如实说明而不说“正在迁移”；打开、回到或规划迁移到这样的目录时同样说明“正在撤销”（`relocation-undoing`，只给“重试”）），同一安装同一来源完成但没切换指针、接收库也没变的，下次迁移前整体撤销重做（别的安装的完成记录不当作自己的半成品）；切换生效、发起安装在新目录打开后删除日志与数据库撤销副本，被替换的配置版本保留；启动时清理已结束进程留下的私有副本。迁移本身从不修改旧目录的数据。删除旧目录要求指针 lastMigration 里的迁移 id 与当前目录完成记录一致（“回到旧目录”“选择其它目录”“使用默认目录”只切换指针、不写迁移 id，永远不能作删除依据），只删当前目录完成记录证明已迁移、且指纹或摘要表明迁移后没有改动的内容（库里只删确实迁移过去的部分：数据库、WAL、CAS、已复制过去的调试取证和 LimCode 自己的簿记；其余内容单列为“未迁移、保留”，单独勾选才删），以及旧目录已没有保留库时 LimCode 自己的记录；归档并重置的归档、合并备份、升级备份默认保留，单独勾选（写明大小）才删；其余一律当用户文件保留；要求旧目录全部 Host 离线，确认之后清单有变就一项都不删。打开一个数据目录时先在它的准入内看迁移记录：staging/undoing 且发起进程已证明结束就先撤销完（受上面的核对保护，撤销后再检查一次可用性）再打开，发起进程还在或无法确认、或需要还原数据库而目标有在线窗口时拒绝打开（`relocating`，只给“重试”），接收库此刻读不出来时同样只给“重试”（`unreadable`）；complete（未确认）记录：发起安装且指针指明这次迁移就补写 published 后打开，其它安装在发起进程还在时拒绝（`relocating`），已结束时询问（`unpublished`：“撤销那次未完成的迁移并打开”或“暂不打开”，撤销同样受核对保护，日志已不在时如实说明无法自动撤销）；“回到旧目录”“选择其它目录”也判它不可用；有 `held` 记录时打开后提示一次（可不再提醒）。旧目录里带着迁走的未完成工作的库（“已迁走”标记的 `carriedWork`）不能再执行一次：用户没有同意时拒绝打开、运行时不打开（`moved-work`），三选一“在这里继续（已迁走的任务按中止收尾）”“改用新目录”（只切指针）“暂不打开”，提示如实说明：打开时先把它们全部按中止收尾，收尾完之前这里不执行任何工作，有收尾不了的这次就不打开并逐条说明；发起安装“回到旧目录”的确认即同意（找不到、读不出或读不懂这次迁移的标记，或本安装的标记是别的迁移的，都如实报错、不切换；记同意失败也报错、不切换；别的安装后来的标记不替它同意，由那份标记管着旧目录的打开）。标记读不懂（JSON 坏、结构不符、不认识的状态、某个库或它的收尾结果不合格）一律拒绝打开（`moved-notice-invalid`，按不能访问一类给出路：重试、读得出新目录时“改用迁移后的目录”、回到旧目录、选择其它目录、使用默认目录），从不当作没有标记；标记所指的迁移在目标里还在进行（staging/complete/undoing）且发起进程没有证明已结束时按 `relocating` 拒绝，不拿它问用户、也不收尾。同意之后运行时打开时先扣住运行时收敛（已批准的文件修改不派发）、启动恢复、投递唤醒、进程扫描与对话接管，在任何执行之前收尾（`settleRelocatedWork`）：Turn、排队消息、子 Agent 和待回答的提问与审批走用户停止的现有转换；父 Turn 已完成的后台子 Agent 先按它自己面板的停止停下活动 Turn，排着续跑时再按子树中断取消（不写终止请求、不发布答复）；迁走的结果按原因码 `data-root-relocated` 放弃（`deliverySettlementSteps`，都是现有终态，不重试、不开 Turn）：会开启回合的待投递结果置 failed、它的唤醒置 dead_letter、为它排队的运行时续跑取消（`abandonPending`，目标对话被另一个存活宿主持有的、存活宿主认领且未过期的不动，持有者或认领者已死的照常放弃），还没路由的子 Agent 答复在同一事务里得到一条已失败、没有唤醒的投递（`createAbandoned`），已结束进程的完成派发置 dead_letter（`abandonDispatch`，同样不动另一个存活宿主持有的对话），排队的续写、运行时续跑与重试取消（`cancelQueuedIntent`），界面显示“数据目录已迁移，未送达”；收尾会带出新工作（请求方收到“没人会回答”的回复会开启回合），所以每轮之后先让协作收敛、在运行时里重新盘点整个库（有界重试 3 次），新出现的再收尾，最多 5 轮；全部收尾才记已收尾（只记各类关掉的数目，只认同一次迁移、只记一次）并放行（`openSettlingRelocatedWork`）；有任何剩下的——存活宿主正在执行或占着的（Turn、投递、派发、答复）、出错的（包括重试后仍失败的一轮，以及收尾本身意外出错：记一条“收尾过程出错”）、需要人工处理的、5 轮后仍冒出的——就不记已收尾、保持同意，把这次留下的逐条记进标记（`left`：是什么、哪个对话、为什么），关掉运行时、本次打开失败（`moved-work-unsettled`：模态提示逐条写明是什么、在哪个对话、为什么没收尾、该怎么做，出路是重试和改用新目录；归档并重置要求运行时已打开，不列），下次打开整库再收尾，其间不执行任何工作；收尾中途崩溃时同意保留，下次打开先续完；还有没收尾的库时本安装回到旧目录也不清掉这个标记；从这样的目录再迁移时这些库不能再被迁走（迁走的工作会在两个新目录里各执行一次，新标记也会顶掉拦着它们的旧标记）：规划逐库列出（项目名、对话；标记读不出或读不懂、库读不出来时拒绝迁移），确认框只给“先把这些任务按中止收尾，再迁移”，选了即同意（只限确认框列出的，之后才出现的按“发生了变化”拒绝），迁移在独占阶段、写目标之前按这些库各自打开时的收尾离线收尾（`settleEarlierMovedWorkOffline`：扣住收敛、从不恢复，模型、工具、MCP、编译回合一律拒绝），收尾不了就按切换前失败撤销并逐条说明。删除旧目录时保留“已迁走”标记（只留这个小文件）；打不开的目录带这个标记时，恢复提示另给“改用迁移后的目录”。“回到旧目录”只切换指针，并让当前目录的完成记录失效（之后要删除旧目录须再迁移一次），清掉本安装在旧目录留下的“已迁走”标记；其它安装打开带这个标记的目录时给出不阻塞的警告（继续使用会产生分叉），提供“改用新目录”；当前目录不可达时不在它上面协调，仍开着的其它窗口的配置路径固定在它打开时的目录，发现指针变了就拒绝读写配置并提示重载。自定义数据目录用身份文件 `.limcode-data-root-identity.json` 与 globalStatus.dataRootId 比对（没有记录身份时至少要有 LimCode 结构：选择文件、身份文件或 RootBinding 指针，设置记录存储不算；自定义目录第一次正常打开时在 admission 内写身份文件并记下 dataRootId），读取目录、身份文件、迁移记录或“已迁走”标记（以及判断设置目录是否存在）时只把 ENOENT/ENOTDIR 当作不存在，出错时只有 EIO、ETIMEDOUT、EAGAIN、EBUSY 这类暂时性错误只提示重试（`unreadable`），其它错误（如没有权限、路径成了文件，`inaccessible`）另给“选择其它目录”“使用默认目录”，缺失、不一致或只有同名空文件夹都判为不可用：启动拒绝打开，提供“重试 / 回到旧目录 / 选择其它已有目录 / 改用默认目录（二次确认；默认目录已有数据时说明那是旧数据，上次迁移正是从默认目录迁出时引导用“回到旧目录”）”，绝不在其中新建空库；读配置（文件型设置，以及渠道、压缩方法、MCP 等记录存储）在设置目录不存在时只给内存里的默认值，不创建任何目录或文件；文件或记录存储缺失与“只写了默认内容”视为同一状态，第一次保存不报冲突，别人真改过时仍报冲突。

多窗口执行资格（`docs/architecture/reliable-kernel/01-invariants-and-authority.md` §2.1）：对话的执行（调用模型、执行工具、推进 Turn、准入排队输入、投递续跑）只交给服务它的窗口；控制类操作（停止、删除、改名、记录回答或审批）任何窗口都能做，不合格窗口做完立即交还归属与租约。每个活动 Turn 和排队 TurnIntent 按自己冻结的工作环境定位：冻结的不是项目自身的环境时，只要求该环境在本窗口可用，不要求项目打开；冻结的是项目自身环境时仍要求项目匹配。新输入、压缩与投递续跑按新 Turn 将冻结的环境判断，入口、准入与投递唤醒必须用同一判定，维护 Turn 实际冻结的内容必须与入口批准的一致。不合格窗口交还执行租约按它持有的租约行进行，不看是否过期，交还前先等本窗口这个 Turn 的在途 native 调用写完回执；Phase D 从不把派发宿主仍存活的效果记为结果未知。认领与保留归属都以本窗口能执行它要做或保留的那项工作为准：空闲对话的待处理投递按续跑所继承的源 Turn 冻结环境放置，唤醒因本窗口不能执行而未确认时交还归属，执行租约在另一存活宿主手里的工作不让本窗口保留归属。只有用户明确停止，并且执行宿主已被进程身份证明死亡时，才把核对不了的已派发效果标为 `outcome_unknown`、把已派发的子 Agent 派生记为已派生；自动路径（恢复扫描、子 Agent 调度）从不这样标记。资格只是宿主本地筛选，归属记录、`ExecutionLease` 与栅栏仍是唯一权威。

删除对话（`conversationDeleteCommand.ts`，删除范围是该对话加它的整棵子 Agent 树）先停止、再收尾、再删除，不因还有任务在跑而拒绝。每一轮先取消范围内的排队消息（`cancelGuidanceForDeletion`，按修订号 CAS，不需要对话归属），全部取消落地之前不停任何 Turn，结束的 Turn 因此没有排队消息可准入；再写各活动 Turn 的持久停止请求，然后中断有工作的子 Agent（外层优先、带子树，每次重发用新的来源键），再执行各 Turn 的停止，父 Turn 的停止请求与子树中断在同一轮写入；运行中的后台进程直接写进程的停止请求文件（有 nonce、指纹与 PID 复用防护，不需要对话归属，另一个存活窗口持有对话也能停）。这些都走现有的用户停止路径，原因写“用户删除对话”（被删的是子对话本身时，父对话看到“用户删除子任务对话”）；存活的 owner 自己执行 Turn 的停止，owner 已死时走死宿主与 `outcome_unknown` 路径，不另造路径。删除进行期间，本窗口不在删除范围内开续跑 Turn（内存标记，删除结束即释放），被停掉的后台进程的结束通知因此不会调用模型；持有对话的另一个存活窗口仍可能为它开一次续跑，删除随即停下它。只删子对话、它的答复已投给范围外正在运行的父 Turn 时：父 Turn 正在发模型请求就等这次请求结束、由它接收；父 Turn 在等回答、审批或其它长等待时不等，删除事务把这条答复换成运行时输入“子任务对话已被用户删除，它的答复不会再送达。”交给父 Turn（投递置 consumed，内容只有通知与子任务标题，不含已删子任务的答复）。停止最多等 60 秒，进度通知按原因显示：正在停止、在等另一个窗口（写明进程号）释放对话、在等父对话的模型回复；停不下来就不删，照实说明哪个任务在哪个窗口没停下，并区分“已发出停止请求”“没能发出停止请求”和“对话被另一个窗口占用”，停下或释放后再删一次；侧栏以警告样式显示没删完。删除事务再收尾投递：投给范围内对话的 pending 投递置 failed(target-gone)；只删子对话时，父对话对它的等待以“用户删除子任务对话”取消（父 Turn 在跑就拿这个结果继续），父对话空闲时它还没接收的答复置 failed(source-gone)；相关唤醒和进程完成派发置 dead_letter（这些步骤在 `deliverySettlementSteps`，数据目录迁移后旧目录的收尾复用它们，原因码是 `data-root-relocated`）。删除等待期间的盘点只读删除范围；子调度的答复扫描遇到随对话删除的子 Agent 就跳过它，Runner 丢弃 Turn 已被删除的延迟恢复候选。删除事务本身仍拒绝活动工作（`ConversationDeletionBlockedError`），只作最后防护。

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
