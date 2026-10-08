# 每个数据目录只保留一个历史库

本文是分期实施规划，不是机器合同；各期落地时以 AGENTS.md、`01-invariants-and-authority.md` 和合同 JSON 的改写为准。目标与七项决策由维护者于 2026-10-07 确认；第 0 期已实现（提交 13e70257）。第 1—3 期的代码点来自 2026-10-07 对 main 的只读盘点，写的是文件与函数名（行号会漂移），动手前以当时的代码为准。

## 最新实施安排（2026-10-08）

维护者于本日明确要求先完成全部开发、真实安装验收由维护者自行执行。因此第3期开发不再等待真实数据副本或第2期单独发版；这不代表验收已通过。第1、2期与去重修正基线6702646的GitHub CI已16项全绿。第3期逐块编译和定向验证，最终交付真实安装测试要点及未验证项。

## 第1、2期实施记录（2026-10-08）

这是最新远端之上的重新实施，未恢复旧云工作区未发布提交，也未复用其验证结果。第 1、2 期实现已整合并推送 main（60198f7a），本轮受影响专项已完成；真实安装副本验证与最新提交的 GitHub CI 尚未完成，不能将本节视为验收全部通过。推送 main 不等于已发布新的扩展版本。

- 固定当前入口已实现：已有选择拒绝再次发布，旧选择修订继续读取，菜单及 Facade 切换链路已删除；当前库通过独占维护关闭 Runtime 后检查修复并重载。固定选择专项 29/29 通过，当前库离线检查、活跃库拒绝和原修复保护专项 1/1 通过。
- 重置使用独立 reset-backups 目录并登记残留；迁移其它库与 leftBehind 登记无期限 pending；partial 账本、整份失败残留、来源保留及覆盖核验删除准入已整合。残留只读查看限制为被剔除对话，保留外来查看登记。
- 在线与流式使用同一按对话归属剔除闭包，离线收尾接入现有控制面。`dff40549` 汇总在线收尾同意，`62912ab4` 保存 15 项完整分类计数，`c1fa8e97` 汇总大库收尾同意并核对并存快照空间。整批同意持久后才按序继续，保留每来源单独事务和提交记录。
- 后台逐来源检查 Runtime 空闲，自动外来来源有 120 秒取消预算；不再自动独占或倒计时。“立即合并全部”及管理菜单入口已接入直接准备、独占协调、重载恢复。只读历史、旧选择恢复和必要合并后端保留。
- 本轮在线与流式专项以及 1050 个对话的界面端到端路径已验证；证据位于 `runtime-dataset-merge.test.mjs`、流式专项和 `large-historical-merge-e2e.test.mjs` 的对应测试。直接入口、跨窗口重载、准备取消、三来源中途取消和外来目录保留已通过。菜单、SIGKILL 和等待手动路径走到共享旧收尾原因断言后失败，该断言已按控制面终态理由统一修正，并用直接入口复验通过；未重复跑这三条长路径，完整回归交给 GitHub CI。新测试已纳入 CI 清单、跟踪白名单和时间权重；`runtimeMergeSettlementBatch.ts` 是正常生产源码，由 TypeScript 目录规则编译，不另建测试条目。
- 真实安装副本的路径等待用户提供，尚未在真实安装副本上完成收敛验证；不得读取禁止的会话目录或改动用户现用数据来替代。第 3 期尚未开始，仍缺第 2 期发布后的真实安装收敛证据。优先使用隔离副本，改变用户现用配置或数据必须另行说明并获得许可，没有额外等待天数。

## 1. 目标

一个数据目录（配置根）只有一个当前历史库。旧版本按工作区分库留下的库、用户保留的库、“归档并重置”的归档、数据目录迁移挪开的拷来目录，最终都并进当前库；之后删除“切换当前历史库”、用户保留标记、多库管理、外来历史库列表与大库会话界面这一整套多库机制。

原则不变：旧历史尽量可用可读；只存在于某个旧库里的对话不能被自动删除；用户删掉的对话不能被合并插回；删除对话“该停就停，不拒绝”。

完成后的样子：

- 设置页和“历史与存储管理”里不再有“历史库”这个概念，只有“当前历史”和一个“未能合并的旧数据”列表。
- 旧库在后台自动并入；收不进来的部分原样留在原位置，可以只读查看。
- 合并引擎、删除记录和合并账本继续存在，服务于数据目录迁移和以后发现的旧数据。

## 2. 决策

### 2.1 维护者已确认（2026-10-07）

1. 以前选过“保持分开”、或标为用户保留的库，直接合并，只发一次通知。原库作为备份保留，合并进来的对话事后可以删。
2. 收不了尾的未完成工作，经用户一次确认后复用迁移的离线收尾，按“中止”处理；仍收不了的（needs_human、死宿主留下的不受支持效果、仍在运行的进程）只剔除所在对话。
3. 同 id 不同内容的冲突、坏行、缺正文，按对话剔除，其余照常合并；不给冲突对话换新 id。
4. 收不进来的部分原位保留、永不自动删除；“历史与存储管理”里只有一个“未能合并的旧数据”列表，能读的只读查看，读不出的只列位置、大小和原因。
5. “归档并重置”保留为修复入口，但改成纯备份：坏库挪到一边、新开空库，挪走的库进入残留列表，不再成为第二个历史库。
6. 当前库不搬位置：选择文件作为固定指针保留，只去掉切换。
7. 数据目录迁入已有 LimCode 数据的目录时继续合并；合并引擎、删除记录与合并账本长期保留。

### 2.2 本规划补充的取舍（按“都按你的意见来”代定，实施前可推翻）

- **A. 合并目标永远是当前库。** 早先方案写过“超过 2000 万行时以最大的库为目标”，它与决策 6 冲突，作废。超过 2000 万行的来源进入残留列表（原因写“太大，当前版本不能一次合并”），能读的照样只读查看；等可选项“分批、可续地合并”实现后再收进来。
- **B. 大来源不再有大库会话界面。** 在线上限以内的来源在后台在线合并；超过在线上限的来源统一由“立即合并全部”这一个明确命令处理：复用数据目录迁移已有的独占协调与进度通知，执行流式合并引擎。去掉估计范围、倒计时、会话速率与会话结果暂存。
- **C. 外来库（归档、拷来目录）从不原地收尾。** 有未结束任务的对话直接剔除，进入残留列表，说明“外来库里有未结束的任务，不在原位置收尾”。“在私有副本上收尾”放进可选项。
- **D. 账本新增 `partial` 状态，不在 `merged` 上加字段。** 旧版本见到不认识的状态当作更新版本写的、从不覆盖（`runtimeDataSetMergeLedger.ts` 的合法状态集合）；在 `merged` 上加字段会让旧版本把部分合并当成全部合并，备份清理可能因此删掉还有独有对话的来源。
- **E. 新的“归档并重置”备份换一个外来发现不认的名字**：`<scope>/.limcode-runtime-reset-backups/<时间>-<id8>`。它不参与自动收敛，只登记进残留列表；能读的可以只读查看，也可以在列表里明确选择“重新核验并合并”。理由：用户重置往往是因为库里有卡住的状态，自动并回会把问题带回来。已有的旧归档（`.limcode-runtime-backups/` 下）按决策 1 作为旧库自动收敛。
- **F. 没有选择文件、且候选全部不通过时，不再要求用户在多个库之间选择**：新建固定默认根作为当前库，所有候选登记为待合并（暂时性原因留在待合并里，之后自动重试；确定不通过的进入残留列表）。第 3 期据此删除 `SelectionRequiredError` 与选库界面。
- **G. 收敛相关的后端永久保留。** 有用户会从 v0.0.36 直接升到第 3 期之后的版本，所以候选枚举（`inspectVscodeRuntimeDataSets`）、外来库的发现与核验、外来库合并时的声明、已发布 3/4/5 的升级（本地就地升级与第 0 期的私有副本升级）和流式合并引擎都不能随第 3 期删除；第 3 期只删界面与策略。
- **H. 旧版本写的选择文件与保留标记只读容忍。** 同一数据目录可能被未升级的窗口或另一份安装（0.0.24–0.0.36）继续切换、写保留标记。新版本照常读选择文件（选择变化按现有规则处理），保留标记一律当作“待合并”，不假定选择文件的修订号不再增长。
- **I. 第 3 期之后“删除其他历史库”这个入口取消。** 合并完成的来源由“清理备份”按“已合并来源”一类删除；残留列表里的条目只提供“打开所在文件夹”和只读查看，永不由 LimCode 删除。

## 3. 现状（2026-10-07）

### 3.1 规模

多库相关源码约 3.4 万行、测试约 3.6 万行；9 月 20 日以来约 145 个提交在改这一块，AGENTS.md 一半以上篇幅在讲合并、外来库、迁移和清理。主要模块：

| 模块 | 行数 | 去向 |
|---|---|---|
| `backend/reliableKernel/runtimeDataSetMerge.ts` | 4146 | 核心保留；选源/请求/保留/状态等策略删约 320 行；第 2 期新增按对话剔除 |
| `backend/reliableKernel/runtimeDataRootRelocation.ts` | 4220 | 保留；“其它数据集”与挪开拷来目录删约 450 行 |
| `backend/reliableKernel/runtimeBackupCleanup.ts` | 3129 | 保留；外来分组与其它本地库覆盖证明删约 1000 行，新增“已合并来源”约 200 行 |
| `backend/reliableKernel/runtimeDataSetStreamedMerge.ts` | 2511 | 引擎保留；只读估计与会话速率删约 400 行；第 2 期新增剔除 |
| `backend/reliableKernel/runtimeForeignHistory.ts` | 1747 | 发现、核验、私有副本升级保留；列表与提示删约 250 行 |
| `backend/reliableKernel/runtimeDataSetMergeLedger.ts` | 1140 | 保留；requests、prompts、会话速率删；新增 `partial`、待合并、残留 |
| `vscode/commands/runtimeDataSetManagement.ts` | 1060 | 改成“历史与存储管理”的单库版本，删约 580 行 |
| `backend/reliableKernel/vscodeRootAuthority.ts` | 937 | 保留读选择；保留标记、“以前切换过”、选库错误删约 150 行 |
| `backend/application/reliableKernel/relocatedWorkSettlement.ts` | 883 | 保留；第 2 期参数化原因，供“合并前收尾”复用 |
| `vscode/commands/largeHistoricalMerge.ts` | 739 | 第 3 期整删 |
| `backend/reliableKernel/runtimeLargeMergeEngine.ts` | 473 | 第 3 期整删（会话适配层，只有界面在用） |
| `backend/reliableKernel/runtimeLargeMergeSession.ts` | 453 | 第 3 期整删 |
| `vscode/commands/foreignRuntimeHistory.ts` | 335 | 第 3 期整删，换成残留列表 |
| `backend/reliableKernel/runtimeDataSetHistory.ts` | 319 | 保留，供残留只读查看 |
| `backend/reliableKernel/runtimeForeignHistoryViews.ts` | 158 | 保留（查看登记） |

### 3.2 几处关键事实

- 合并引擎核心（行规则、正文传输、删除闭包、提交标记、收尾）不能删：数据目录迁移的整库分批复制（`runtimeDataSetBulkCopy.ts`）与迁入已有目录都依赖它。
- 切换当前历史库：命令 `limcode-test.manageRuntimeDataSets` 的菜单项 `select` → `runtimeDataSetManagement.ts` 的 `switchHistory` → 有 Host 时 `VscodeReliableKernelApplicationFacade.selectRuntimeDataSet`，否则直接 `vscodeRootAuthority.selectVscodeRuntimeDataSet` → 重载窗口。Webview 设置页没有切换入口。
- 选择文件只经 `vscodeRootAuthority.publishSelection` 写入，共 5 处：首次自动选库、切换、`completeVscodeRuntimeDataSetSelection`、启动时让用户选库（`openWithRuntimeDataSetSelection`）、迁移到新根（`runtimeDataRootRelocation.ts` 调 `selectVscodeRuntimeDataSet`）。
- 用户保留标记存在控制根的 `kept-by-user.json`：切换时、迁移的 `migrateOthers`、“保持分开”（`keepRuntimeDataSetsApart`）写入；`isVscodeRuntimeDataSetKept` 读取，用于跳过自动合并、状态显示与收尾原因。
- 归档并重置：命令 `resetDevelopmentData` → Facade → `VscodeReliableKernelCutoverCoordinator.archiveCurrentRuntimeRootForReset`，把控制根改名到 `<scope>/.limcode-runtime-backups/<UTC 时间>-<uuid8>`，再新建空库；外来发现按名字模式把它列为外来历史库。
- 自动合并：升级之后 `mergeHistoricalDataSetsInBackground` → `mergeHistoricalDataSetsOnline` → `pickSources` → `selectSource`。“以前切换过”由 `vscodeRuntimeSwitchedBeforeUpgrade` 判定、记为 `undecided`，由 `offerUndecidedMerge` 询问“全部合并 / 保持分开”；合并请求在 `requests/`，7 天过期。
- 冲突、坏行、缺正文目前都整份拒绝（`recordRefusal` 入账）：冲突在 `planMergeChunk` / `checkPlan`（`runtime-data-set-merge-conflict`，大库在 `scanMergeRows`），坏行在 `sourceRow` 直接抛出（`…-source-row-invalid`），缺正文在 `transferCas`（`…-source-cas-invalid`）；`transferCas` 遍历全部 `content_object`，不看跳过集合。
- 现有删除跳过闭包：种子是 `deletedSinceMerge`（以前合并进来、现在目标里没有的对话；子 Agent 只向下展开），`skippedRows` 按外键加 `SKIPPED_WITH` / `SKIPPED_WITH_MEMBERS` 求不动点，四个内容派生领域永不跳过；大库版本是 `prepareSkippedRows` / `closeOver` / `skipRules`（TEMP 表）。账本只记数 `skippedConversations`。前提是被跳过的对话在目标里**不存在**（`leavesNothingOut`）。
- 未完成工作：`runtimeDataSetMergeProbes.ts` 的 `inspect` 与全库计数的 `REFUSAL_PROBES`（不按对话）；收尾是 `finalizeSource`（先来源备份 `merge-source-backups/`，再记 `finalizations/`，再 `finalizeUnfinishedWork`）；外来库有任何未结束工作就整份 blocked。
- 迁移的离线收尾 `settleRelocatedWork` 需要完整的 ReliableKernelApplication（`relocatedWorkOpening.ts` 的 `SETTLING_ONLY` 离线打开），原因码 `data-root-relocated` 与迁移目录文案写死。needs_human 由 `turnControlPlane.recoveryFacts` 判定；死宿主不受支持的效果由 `phaseDRecovery.deadHostEffectsForTurn` 判定；仍在运行的进程不归它，由合并探针拦下。
- 规模分流常量在 `runtimeDataSetMerge.ts`：在线上限 4000 行 / 12 MiB，6 万行以上等大库会话，2000 万行以上记 `too-large`。

## 4. 第 0 期：已发布格式的外来库在私有副本上升级（已实现，随 epoch 6 发布）

已实现（13e70257）：

- 外来库核验接受指针、epoch 清单与库内绑定一致的已发布 epoch 3/4/5。
- 每次复制私有拷贝之后，在短期 worker 里（`runtimeSnapshotUpgrade.ts` / `runtimeSnapshotUpgradeWorker.ts`）对拷贝执行与本地就地升级同一套 3/4/5→6 数据库升级（`upgradePublishedRuntimeSnapshot`），不写 journal、不做备份；拷贝的绑定按 `migratedBinding` 推导，身份不变。
- 旧正文由主线程经不跟随链接的描述符读取后交给 worker；转换旧 Child continuation 新写的正文只进当前配置根 `.limcode-runtime-merges/foreign-upgrade-cas/<id>/`，之后的查看、合并与内容指纹先读它、再读外来目录。
- 升级核验不通过的记为 `foreign-history-upgrade-failed` 并入缓存；审计缓存与内容指纹的键带上“已升级到 epoch 6”的后缀。

验证：外来库与升级保真的定向测试 172 个通过；新增 `runtime-foreign-history-published-upgrade.test.mjs`（真实第 5 代拷来目录、带旧 Child continuation 的第 3 代归档：核验、只读查看、合并、再合并无冲突、原目录逐字节不变、转换出的正文随合并进当前库）；用本机真实第 5 代升级前备份（约 171 MB）试跑，worker 路径与本地路径各约 1 秒，两份结果 `.dump` 逐字相同。

后续小项（随第 1 期一起做即可）：

- `foreign-history-epoch-newer` 的文案写“更新扩展后可以再看”。开发期 main 上的 epoch 7–10 已压成一次 5→6、永不会再有能读它们的版本，这类库的说明应改成如实写明“这是未发布的开发版本格式”。只影响跑过 10 月 4 日之后 main 构建的机器。
- 新测试的 CI 耗时是估计值，第一次 CI 实测后改写 `ci-test-timings.json`。

## 5. 第 1 期：不再产生新的历史库

目的：从这一期起，不会再有新的“第二个历史库”出现；已有的旧库在第 2 期统一收敛。本期不改合并引擎。

### 5.1 选择文件变成固定指针

改动：

- 删除切换链路：`runtimeDataSetManagement.ts` 的菜单项 `select` 与 `switchHistory`，Facade 的 `selectRuntimeDataSet`，`vscode/ApplicationFacade.ts` 对应的转发。
- `selectVscodeRuntimeDataSet` 收缩为“只在没有选择时首次发布”：已有选择就拒绝，去掉其中写保留标记与修订号递增的逻辑。启动时选库（`openWithRuntimeDataSetSelection`）和迁移到新根改调它；首次自动选库与 `completeVscodeRuntimeDataSetSelection` 不变。
- 保留读选择文件的全部逻辑（`vscodeRuntimeSwitchedBeforeUpgrade` 合并在用，第 2 期删；迁移里读选择的几处）。
- 改掉引导用户“切换过去查看”的文案：`runtimeDataSetMerge.ts` 里收尾受阻、冲突、未完成工作的说明，管理菜单里的说明，改成“这份库暂时不能合并，可以只读查看”。

合同与文档：`authority.json#/rootPolicy/runtimeSelection` 与 `runtimeSelectionPointer` 写明选择是固定指针、只在首次发布；`migration.json#/historicalMerge/selectionPolicy` 写明 never-switch；AGENTS.md 第 19 段（“没有选择文件时…”）中“本版本起用户经‘切换当前历史库’切走”等句子、01-invariants 第 313、315 段对应改写。

测试：`selectVscodeRuntimeDataSet(` 在 15 个测试文件里有 52 处，多数当夹具用来造“当前库”；新增测试辅助 `publishInitialRuntimeSelection` 替换，不改测试语义。`runtime-dataset-commands.test.cjs` 里切换相关用例改为断言菜单里没有切换。新增：已有选择时再次发布被拒；旧版本写入的选择变化仍被正确读取。

风险与应对：

- 去掉切换后，有收不了尾工作的库在第 2 期上线前没有出路（不能切过去处理，也合并不了）。第 1 期与第 2 期的“合并前收尾”（7.5 节）放进同一个发布版本；如果第 1 期要单独发版，就暂时保留“切换”入口、只去掉其它产生新库的路径。
- 当前库的历史修复要求“先切到另一库让本库离线”（AGENTS.md 第 42 段）。改成由修复命令自己在独占维护下让当前库离线（复用迁移的独占协调），否则当前库从此无法修复。这一项随 5.1 一起做。

改动量：源码删约 120 行、改约 40 行；测试改约 300 行。

### 5.2 “归档并重置”改成纯备份

改动：

- `archiveCurrentRuntimeRootForReset` 的目标目录改为 `<scope>/.limcode-runtime-reset-backups/<UTC 时间>-<id8>`（决策 E）。目录常量放在 `vscodeRootAuthority.ts`，确认外来发现的名字模式不匹配它。
- 新增残留登记（7.7 节的 `residual/<id>.json`），由重置在同一准入内写入并落盘后才报告完成。第 1 期先实现登记与列表的最小版本：位置、大小、原因“归档并重置挪走的库”、时间。改名之后、登记之前崩溃，由启动时扫描 `.limcode-runtime-reset-backups/` 补登记（名字本身就说明了来源）。
- 备份清理的保护（不删它）、迁移预检与删除旧目录（它跟着旧目录走，不迁移；删除旧目录时保留或明确列出）、`keepsOnlyArchives`（只剩它的 scope 不算一个库）同步认识新目录。
- 确认框文案（`registerCommands.ts`）改成：“当前历史挪到备份目录，打开一个空的新历史；挪走的历史在‘未能合并的旧数据’里可以只读查看，也可以选择重新合并。”

合同与文档：`authority.json#/rootPolicy/foreignHistory` 的 reset-archives 一段写明新名字不属于外来历史库；`migration.json#/backupCleanup/listedOnly` 增加 reset-backups；AGENTS.md 第 23、25 段相关句子。

测试：8 个外来库测试用 `archiveCurrentRuntimeRootForReset` 造旧归档夹具，改成直接构造旧名字的归档（它们测的是“旧版本留下的归档”，这正是旧名字）。新增：重置后新备份不出现在外来列表、出现在残留列表、清理备份不删它、改名后崩溃能补登记。

改动量：新增 150–200 行、改约 60 行；测试约 250 行。

### 5.3 数据目录迁移不再标“用户保留”

改动：

- 删除 `migrateOthers` 里调用 `markVscodeRuntimeDataSetKept` 的那一行；改为在新配置根写一条无期限的待合并登记 `.limcode-runtime-merges/pending/<id>.json`（格式见 7.1 节），由合并选源当作待合并处理。不借用 `requests/`：它 7 天过期，语义是“用户明确请求”。
- 迁移完成记录里的 `leftBehind`（旧目录里留下的本地库）会被下次迁移覆盖；改为同时写进新配置根的待合并登记，位置用旧目录的 located 路径（与外来库同一格式）。
- 外来发现清理 `previousDataRoots` 时，把“旧目录里还有本地库”算作还有东西，不去掉（现在只看归档和拷来目录）。
- 收尾原因补一个“数据目录迁移带来的库”（`runtimeDataSetMerge.ts` 选收尾原因处与 `runtimeDataSetMergeWork.ts`）。

风险：去掉保留标记后，新目录一打开就会自动合并其它库，可能立刻触发独占协调或大库会话（第 1 期仍是现有机制，行为与“迁入已有数据的目录”一致，可以接受）；迁入已有 LimCode 数据的目录、且那边判定“以前切换过”时会误弹询问——第 1 期在选源里把“由迁移带来的待合并登记”排除在 undecided 之外。

合同与文档：`migration.json#/dataRootRelocation/otherDataSets` 由 `same-id-independent-data-sets-marked-user-kept` 改为 `…-registered-pending-merge`；`contract-model.mjs` 中 `dataRootRelocation` 的逐字期望同一提交改；AGENTS.md 第 25 段。

测试：`runtime-data-root-relocation.test.mjs` 断言其它库为保留的部分改为断言待合并登记；新增旧目录留下的库被登记、`previousDataRoots` 不被误删两例。

改动量：80–150 行。

### 5.4 删除其他历史库之前先合并

改动：

- `runtimeStorageInspection.deleteUnselectedRuntimeDataSet` 在准入内判定这份库已经完整合并进当前库、且之后没有变化（与列表里“已合并”同一口径），否则拒绝（`runtime-data-set-delete-not-merged`）。
- 管理菜单给两条路：“先合并”（复用现有的立即合并）；“确认已被覆盖后删除”（复用备份清理的覆盖证明 `coverageIn`，需要当前运行时已打开）。
- 删除旧目录时（迁移的“删除旧目录”），其中的本地库按同一口径：未合并的不勾选、写明原因。

合同与文档：删除本地库目前没有合同字段，在 `migration.json#/backupCleanup` 旁新增 `localDataSetDeletion`，写明“未合并不删”；`contract-model.mjs` 加对应的逐字期望。

测试：`runtime-dataset-history-storage.test.mjs` 的 4 个“删除其他库”用例改写，新增未合并时被拒、合并后可删、覆盖证明可删三例。

改动量：100–200 行。

### 5.5 第 1 期的提交与验收

建议拆 4 个提交，顺序 5.3 → 5.2 → 5.4 → 5.1（5.3 最独立；5.2 引入残留登记最小版本；5.4 依赖“已合并”口径；5.1 最后，因为它让“合并受阻”失去出路，要和第 2 期的收尾同版本发布）。每个提交自带合同、检查器、文档与测试。

验收：定向测试（选库、迁移、重置、删除、外来库各系列）全过；真实数据副本上试跑一次重置与迁移（只用 `.backup` 只读副本）；新版本里找不到任何会产生第二个当前库的入口（命令、菜单、设置页逐项列出核对）。

第 1 期合计约 6–10 人日。

## 6. 第 2 期前置：对话归属映射

按对话剔除需要知道每一行属于哪些对话。现在只有从对话出发的正向闭包，没有从行出发的反向归属。这是第 2 期的地基，单独做、单独验收。

### 6.1 归属分类

113 个领域逐一归到下面五类之一：

1. **对话自有**：经外键链唯一归属一个对话（Turn、TurnIntent、ModelRequest、ToolCall、MessagePartOfConversation 等）。行 → {一个对话}。
2. **成员共享**：分支共享的行，属于一组对话（分支族）：Message（经 MessagePartOfConversation）、ContextSequenceNode / Segment、CompressionBlockSource、ModelContextProjection。行 → {所有成员对话}；剔除时整族一起剔。
3. **跨对话链接**：同时指向两个或更多对话：CollaborationMessage 及其 Source / Target / Payload / ReplyLink、CollaborationRequest / RequestTurnLink / CollaborationBudget、RuntimeInboxItem、RuntimeDelivery、AnswerBridge / AnswerSubmission、CollaborationSendTimelineLink、RuntimeDeliveryTimelineLink、TimelineImportProvenance、RuntimeDeliveryAnswerPresentation。行 → {它引用的全部对话}（按 `conversation_id` 等软引用解析）；剔除时连带全部。
4. **子 Agent 结构**：ChildExecution（`child_conversation_id`）、ParentLink / TurnLink / IntentLink、ConversationOriginLink。剔除单位是整棵子 Agent 树：先向上找到根对话，再向下展开全部子孙（只剔子、留父会让父对话的子任务投影悬空）。
5. **内容派生**：ContentObject、ProjectContext、Attachment、AttachmentObservationLink。本身不属于对话；冲突（同 id 不同内容）无法按对话剔除，整份拒绝；缺正文时剔除所有引用它的对话（30 个外键列、4 个软引用列，以及配方 JSON 里的 `toolsReference`、`baseContentObjectId`）。

另有全局单例（`root_binding`、`schema_manifest` 等）不参与（合并本来就不复制它们）。

### 6.2 机器合同

- 在 `migration.json#/historicalMerge` 下新增 `conversationOwnership`：领域键 → 类别 + 归属路径（外键链或软引用列）。
- `contract-model.mjs` 检查它与 `RUNTIME_DOMAIN_SCHEMAS` 一一对应：新增领域没有归属就报错，与现有的领域覆盖检查同一做法。
- 归属路径由新模块 `runtimeMergeConversationOwnership.ts` 实现：输入一行（允许是解码失败的原始列），输出对话 id 集合或“无法归属”。

### 6.3 验收

- 每个领域构造一行，断言归属结果（新测试 `runtime-merge-conversation-ownership.test.mjs`）。
- 在真实数据副本上对全部行求归属，统计每类行数与“无法归属”的行数（期望为 0）。
- 与现有正向闭包交叉核对：任一对话的正向闭包里的行，反向归属都包含该对话。

改动量：新模块约 400 行、合同与检查器约 150 行、测试约 400 行；约 5–7 人日。

## 7. 第 2 期：一次性收敛

目的：把已有的全部旧库统一收进当前库；收不进来的部分进残留列表。完成后多库界面只剩“未能合并的旧数据”。

### 7.1 待合并登记与选源

- 新登记 `.limcode-runtime-merges/pending/<id>.json`：来源种类（本地 scope、固定根、迁移带来的、外来归档、外来拷来目录）、位置（located 格式）、身份、登记时间与原因（升级收敛、迁移带来、用户在残留列表里选择重新合并）。无期限；合并完成（`merged`）或确定进残留后删除。
- 升级到第 2 期版本后的第一次启动执行一次“收敛登记”：本地全部非当前库（工作区 scope、固定根、用户保留的、以前切换过的）、外来发现找到的全部归档与拷来目录（`discoverForeignRuntimeHistory`）、迁移完成记录里的 `leftBehind`，全部写成待合并；配置根记一个 `convergence.json` 表示已登记过。之后发现的新来源（例如迁入已有数据的目录）照常追加。
- `pickSources` / `selectSource` 删掉 undecided（以前切换过）、kept（用户保留只按请求）、“合并过一次就不再自动合并”和请求过期这几支，只保留“已合并且之后没变就跳过”和“同一内容状态的拒绝记录复用”。保留标记读到后当作待合并（决策 H）。
- 外来库从“只能经请求进入”改为由待合并登记进入。核验在后台节流：一次一个、在 Runtime 空闲时进行，单个外来库持有声明的时间设上限，超时让出。

合同：`migration.json#/historicalMerge` 的 `sources`、`initialSelection`、`trigger`、`requiresUserConfirmation`、`explicitRequestConfirmation`、`recordPolicy`（去掉 7 天请求、switched-before、user-kept）整体改写；`contract-model.mjs` 中整个 `historicalMerge` 的逐字对象同一提交改。

### 7.2 通知与“立即合并全部”

- 启动时只通知一次（`.limcode-runtime-merges/notices/convergence.json` 记下已通知的来源集合）：“发现 N 份旧数据，正在后台并入当前历史。你在本版本里删掉的对话不会回来；更早版本里删掉、而旧数据里还有的对话会被加回来，合并后可以再删。原库原样保留作为备份，可以在‘清理备份’里删除。”
- 推迟（忙窗口、空间不足等暂时性原因）维持现有行为；状态栏或“历史与存储管理”常驻显示“还有 N 份没合并”。
- 新增命令“立即合并全部”，同时是超过在线上限的来源的唯一入口（决策 B）：走数据目录迁移已有的独占协调（请其它窗口释放、显示进度、完成后重载），执行流式合并引擎，逐个来源进行、每个来源单独提交单独记账；中途取消时已提交的来源保持已合并，其余留在待合并。
- 新增来源时的通知规则不变：同一来源只通知一次。

### 7.3 按对话剔除：小库（在线合并路径）

在 `runtimeDataSetMerge.ts` 中把“发现问题就整份拒绝”改成“收集 → 求剔除闭包 → 重新规划”：

1. **预扫**（只读，在私有快照上）收集问题而不是抛出：
   - 冲突：`planMergeChunk` / `checkPlan` 改为返回冲突行列表；
   - 坏行：`sourceRow` 解码失败时返回原始列，交给归属映射；
   - 缺正文：`transferCas` 先跑一遍“只校验不复制”，返回缺失或不符的 ContentObject 列表；
   - 未完成工作：按对话的清单（7.5 节）；
   - 模型聚合不成立（`invariantRefusal`）的请求按归属定位到对话。
2. **种子与闭包**：种子 = 上述问题行的归属对话 + 现有的 `deletedSinceMerge`；按子 Agent 整树、分支族、跨对话链接连带展开到不动点。任何一步“无法归属”或命中内容派生领域的冲突，整份拒绝并如实写明。
3. **重新规划与复制**：`skippedRows` 接受新的剔除种子，求出的闭包与删除闭包合成一个跳过集合；`transferCas` 按跳过集合过滤，被剔除对话独占的正文不复制。冲突对话在目标里**存在**，所以剔除只过滤来源行、从不碰目标行；`leavesNothingOut` 要区分“删除跳过”（目标里没有）与“剔除”（目标里有不同版本，或没有但被剔除），两者账本口径不同。
4. **提交前复核**：复用现有复核；跳过集合在复核时重新计算并核对一致。

共享正文：一个 ContentObject 同时被剔除对话与保留对话引用时照常复制；只有它缺失或不符时，才剔除所有引用它的对话。

### 7.4 按对话剔除：大库（流式路径）

`runtimeDataSetStreamedMerge.ts` 用 TEMP 表做同样的事：预扫阶段把问题行的对话写进 `excluded_seed` TEMP 表，`closeOver` / `skipRules` 增加剔除规则，`scanMergeRows` 读行时按跳过集合过滤。内存要求与现有大库读取同一口径：TEMP 表在磁盘上、页缓存受限，剔除闭包每轮只取有界批量。

验收：同一个来源走在线路径与流式路径，剔除结果（对话集合与插入行数）完全一致。现有等价性测试 `runtime-dataset-merge-streamed.test.mjs` 增加带冲突、坏行、缺正文的来源。

### 7.5 合并前收尾（复用迁移的离线收尾）

- 把 `settleRelocatedWork` 的原因参数化：原因码从写死的 `data-root-relocated` 改为参数，新增 `historical-merge-settled`，同步登记到 `deliverySettlementSteps.ts`、`collaborationControlPlane.ts` 与 `subagent.json#/delivery`；文案参数化（迁移目录的文字只在迁移时用）；源键前缀参数化。
- **一次确认**：第一次需要收尾时弹出确认，列出每个来源要中止的工作数量（排队意图、进行中的轮次、待投递消息、子 Agent）。用户同意后写 `.limcode-runtime-merges/settlement-consent.json`（同意时间、来源集合与显示的数量）。已派发效果标为 `outcome_unknown` 只允许由用户停止触发（AGENTS.md 第 27 段），这条同意记录就是依据，所以必须先落盘再收尾。之后新增的来源如果也需要收尾，再问一次。
- **本地来源**：在来源维护声明内、来源备份（`merge-source-backups/`，沿用）之后，以 `SETTLING_ONLY` 离线打开来源执行收尾，`durabilityCheckpoint` 之后在 `finalizations/` 记录完整计数。收尾会带出新工作，最多三轮；仍有剩余的进剔除种子。
- **剔除**：结果里的 unsettled（needs_human、死宿主不受支持的效果）与 live（仍在运行的进程）按对话进剔除种子；整轮失败（无法归属到对话）则整份推迟，原因如实写。
- **拒绝探针按对话**：`REFUSAL_PROBES` 现在是全库计数，改为按对话的版本，供预扫使用；全库版本保留给迁移的 `assertCarriable`。
- **外来来源**：不原地收尾（决策 C），有未结束工作的对话直接进剔除种子。

### 7.6 账本：`partial`

- `runtimeDataSetMergeLedger.ts` 新增 `partial`：字段与 `merged` 相同，另加 `excluded`（对话 id、可读标题、原因码、数量）；`mergedInto` 只记实际插入的对话。
- 合法状态集合、读写校验、状态显示、已合并判定、迁移携带（`planMergeRecordsCarry`）、大库会话结果（第 3 期删除前）同步认识 `partial`。
- 重新合并：`partial` 的来源在内容指纹变化时重新规划，没变化就跳过。冲突对话会一直剔除，直到用户在当前库删掉冲突的那份（之后按删除规则也不会插回），或者等可选项“以只读副本导入”。
- 备份清理：`partial` 不算已合并；它的来源由清理备份保留，删除确认如实写明“还有 N 个对话没有合并进来”。

### 7.7 残留登记与“未能合并的旧数据”列表

- 权威登记 `.limcode-runtime-merges/residual/<id>.json`，每个整份不能合并的来源、每个部分合并的来源、每个重置备份各一条：来源种类、位置（located 格式）、身份（能读出时）、大小（复用外来库的 `cachedTreeSize`）、原因码与可读原因、剔除的对话清单（`partial` 时）、最后核验时间。
- 与现有缓存的关系：外来库 `foreign/<id>.json`、`<id>.size.json` 是按文件状态缓存的结果，可以丢；`residual/` 是权威记录，不能丢。备份清理保护它，迁移携带它。
- 列表（“历史与存储管理 → 未能合并的旧数据”）：每条显示来源、位置、大小、原因、剔除的对话数；提供只读查看（能读的；复用 `openRuntimeDataSetHistory` 与 `runtimeForeignHistoryViews.ts` 的查看登记；部分合并的只显示被剔除的对话）、“打开所在文件夹”、“重新核验并合并”（原因是暂时性的、来源已变化、或是重置备份时提供；重新写待合并登记）。
- 第 1 期的最小版本（5.2 节）在这里补全。

### 7.8 规模

- 在线上限以内：后台在线合并。
- 超过在线上限、在 2000 万行以内：待合并，常驻提示，由“立即合并全部”处理（7.2 节）。
- 超过 2000 万行：进残留列表（决策 A），原因写“太大，当前版本不能一次合并”，能读的只读查看。

### 7.9 迁移与收敛的交互

- 迁移携带 `pending/`、`residual/`、`settlement-consent.json`、`convergence.json`，与现有合并账本、删除记录同一套日志化携带与撤销。
- 迁移预检：有正在进行的收敛（某来源 committing）时拒绝，与现有规则一致。

### 7.10 第 2 期的合同、文档与测试

- 合同：`migration.json#/historicalMerge` 的 `casPolicy`（`missing-irregular-or-mismatched-source-object-fails-source` → 按对话剔除、内容派生冲突整份拒绝）、`rowPolicy`（`any-other-difference-refuses-source-before-any-target-change` → 按对话剔除）、`foreignSourcePolicy`（`any-unfinished-work-blocked…` → 剔除）、`unfinishedWorkPolicy`、`recordPolicy`、`noticePolicy` 按本期语义整体改写；新增 `conversationOwnership`、`pendingRegistry`、`residualRegistry`、`settlementConsent`。`contract-model.mjs` 中整个 `historicalMerge` 的逐字对象，以及外来库永不收尾（`A foreign history root is never finalized.`）、`runtime-data-set-merge-foreign-unfinished-work`、请求读取等逐字源码片段同一提交改。
- 文档：AGENTS.md 第 19、23、25、27、29、38、46、48 段；01-invariants 第 154 段（“SQLite committed reference 不得指向缺失 CAS”——剔除正文时它仍成立，需写明剔除闭包包含引用缺失正文的全部行）与第 315、317、319、323 段。按 AGENTS 的文档冲突经验，这些都是一行一段，改动时按短语三方合并。
- 测试新增：按对话剔除（冲突、坏行、缺正文、未完成工作、子 Agent 树、分支族、跨对话链接、内容派生冲突整份拒绝）、在线与流式剔除等价、收尾同意记录与多轮收尾、`partial` 账本与重新合并、残留登记与列表、收敛登记只做一次、迁移携带新登记。
- 测试改写：`runtime-dataset-merge.test.mjs` 约 25 个多库策略用例（请求 7 天、以前切换过、保持分开、整份冲突拒绝）、`runtime-dataset-merge-state.test.mjs`、`runtime-foreign-history-merge.test.mjs` 的未完成工作用例、`relocated-work-settlement.test.mjs`（原因参数化）、`runtime-dataset-commands.test.cjs` 的询问用例。

### 7.11 第 2 期的提交顺序与验收

提交顺序：

1. 归属映射（第 6 节），单独提交。
2. 待合并登记与收敛登记（仍走现有选源）。
3. 预扫收集与按对话剔除（在线）。
4. 流式剔除与等价性。
5. 收尾参数化与同意记录。
6. `partial` 与残留登记、列表。
7. 选源与通知切换到新语义（删 undecided / kept / 请求过期，外来库自动进入）。
8. “立即合并全部”。

每个提交自带合同、检查器、文档与定向测试。第 7 步才改变用户可见行为，前面各步都是加法。

验收：

- 定向测试：合并、流式合并、外来库、迁移、收尾、清理各系列。
- 真实数据：在本机真实库的只读副本上，额外造三份旧库（一份工作区库带冲突对话、一份带收不了尾工作的库、一份第 5 代外来归档），全量收敛一次，核对：插入的对话数等于来源对话数减剔除数；剔除清单与预期一致；当前库 `quick_check` / `foreign_key_check` 通过；来源目录逐字节不变（外来）或只多了收尾记录（本地，已备份）。
- 全量 `--ci` 回归交给 GitHub CI，在 Windows 与 macOS 上确认路径和文件状态相关的部分。

第 2 期合计约 28–45 人日，其中按对话剔除（含流式）约 15–25 人日。

## 8. 第 3 期：删除多库机制

原前提由维护者本日指示调整为：第1、2期实现和CI已通过即可继续开发，真实安装收敛由维护者在开发完成后验收。收敛后端按决策 G 永久保留，本期只删界面与策略。

### 8.1 整文件删除

| 文件 | 行数 | 删后要改的引用 |
|---|---|---|
| `vscode/commands/largeHistoricalMerge.ts` | 739 | `runtimeDataSetManagement.ts` 的导入与调用 |
| `vscode/commands/foreignRuntimeHistory.ts` | 335 | `runtimeDataSetManagement.ts`、`extension.ts`（经再导出） |
| `backend/reliableKernel/runtimeLargeMergeSession.ts` | 453 | `runtimeDataSetManagement.ts`；`contract-model.mjs` 的会话检查 |
| `backend/reliableKernel/runtimeLargeMergeEngine.ts` | 473 | `runtimeDataSetManagement.ts`（前提：“立即合并全部”不经它） |

### 8.2 部分删除

- `runtimeDataSetManagement.ts`（删约 580 行）：删选库（`chooseDataSet`、`openWithRuntimeDataSetSelection` 的选择部分）、管理菜单里的切换 / 删除其他库 / 合并 / 保持分开 / 大库会话各项、`deletionNote`、`mergeConfirmationDetail`、`mergeNow`、`offerUndecidedMerge`、大库相关与外来提示；留修复、存储占用、残留列表（新）、启动通知。
- `extension.ts`：删外来提示与大库会话的接线。Facade：删 `selectRuntimeDataSet`。
- `vscodeRootAuthority.ts`（删约 150 行）：删保留标记的读写、“以前切换过”判断、`SelectionRequiredError`（决策 F 落地后）；`selectVscodeRuntimeDataSet` 收缩为迁移专用的内部写入。保留标记文件仍然只读识别（第 2 期之前的安装会有，读到当作待合并），等确认不再需要时在可选项里删掉。
- `runtimeDataSetMerge.ts`（删约 320 行）：7 天期限常量、undecided 类型、状态里的 requested / kept / undecided、`reportExpiredRequest`、请求与状态的一组函数、kept 收尾原因；“随会话一起合并”的分流改为“立即合并全部”。
- `runtimeDataSetMergeLedger.ts`：删 requests、prompts、会话速率（旧记录文件留在磁盘上不读，清理备份也不删：它们很小，没有删的必要）。
- `runtimeDataSetStreamedMerge.ts`：删只读估计与会话速率，保留引擎与剔除。
- `runtimeForeignHistoryMerge.ts`：删请求入口，保留声明与指纹。`runtimeForeignHistory.ts`：删列表与启动提示相关函数，保留发现、核验、私有副本升级与查看。
- `runtimeStorageInspection.ts`：删 `deleteUnselectedRuntimeDataSet`（决策 I）。
- `runtimeBackupCleanup.ts`（删约 1000 行，新增约 200 行）：删外来分组、其它本地库的覆盖证明；新增“已合并来源”一类（账本里 `merged` 且之后没变的来源）；`partial` 与残留永不删。
- `runtimeDataRootRelocation.ts`（删约 450 行）：不再携带“其它数据集”（收敛之后每个配置根只有当前库；迁移前未合并完的来源留在旧目录，由待合并登记跟到新目录）、不再挪开拷来目录；`planMergeRecordsCarry` 去掉请求，改为携带待合并与残留。
- `vscode/commands/dataRootRelocation.ts`、`vscode/commands/backupCleanup.ts`：改文案。`OtherSettingsTab.vue`：删“旧目录里留下的库”一栏，改说明；`shared/protocol.ts` 对应字段；`vscodeConfigurationAuthority.ts` 的 `withRelocationRecord`。
- 独占维护：内核里没有 `historical-merge` 分支，只删调用方与合同里的 `uses`。

### 8.3 package.json 与文案

命令和菜单不删：`manageRuntimeDataSets` 留作“历史与存储管理”，`resetDevelopmentData` 留作修复入口。没有 i18n 文件，文案都在代码里（管理菜单、重置确认、清理备份说明、合并结果说明）。

### 8.4 合同、检查器与文档

- `migration.json`：`boundedEpochUpgrade`（选库相关）、`historicalMerge`（多处，见第 2 期改写后的版本，再删会话与倒计时）、`exclusiveMaintenance` 的 `uses`、`dataRootRelocation`（删 `otherDataSets`，改 `oldDirectory`）、`backupCleanup`（删 `foreignHistory`，加 `mergedSource`，改 `listedOnly`）。
- `authority.json`：`rootPolicy` 的选择、保留、外来库字段。
- `contract-model.mjs`：删会话、估计、速率、外来声明与查看登记的整段检查；改 `historicalMerge`、`dataRootRelocation`、`backupCleanup` 的逐字期望；改外来库源码片段。
- `check-plan.mjs` 的 `TRACKED_VERIFICATION_SOURCE_ALLOWLIST`、`run-local-tests.mjs` 的 `CI_TEST_FILES`、`ci-test-timings.json`：删除被删测试文件的条目。
- AGENTS.md：第 19 段（约 1.4 万字）删切换、保留、请求、独占兜底与会话界面约 6000 字，其余改写成单库收敛；第 21 段删外来与其它本地库约 2400 字，补“已合并来源”；第 23 段整段换成约 600 字的“未能合并的旧数据”；第 25 段删约 1900 字；第 386 行外来历史根改成残留只读的说法。01-invariants 第 313、315（删约 7600 字）、317、319 段对应改写。

### 8.5 测试

整删（约 5000 行）：

| 文件 | 行数 |
|---|---|
| `large-historical-merge.test.mjs` | 1137 |
| `large-historical-merge-e2e.test.mjs` | 723 |
| `large-historical-merge-window.mjs` | 398 |
| `runtime-dataset-merge-estimate.test.mjs` | 786 |
| `foreign-history-commands.test.cjs` | 431 |
| `runtime-backup-cleanup-foreign.test.mjs` | 948 |
| `foreign-archive-only-relocation.test.mjs` | 194 |
| `runtime-dataset-merge-state.test.mjs` | 373（其中 3 个指纹缓存用例先迁到合并主测试） |

改写（估计删约 5300 行）：合并主测试（`runtime-dataset-merge.test.mjs` 约 25 个用例）；选库与管理命令（`runtime-dataset-commands.test.cjs`、`runtime-datasets.test.mjs`、`runtime-dataset-history-storage.test.mjs`）；备份清理系列（`runtime-backup-cleanup*.test.mjs`、`backup-cleanup-commands.test.cjs`）；外来库系列（只保留发现、核验、私有副本升级、合并的后端用例）；迁移系列（`runtime-data-root-relocation*.test.mjs`、`data-root-relocation-commands.test.cjs`）；独占维护系列（`runtime-exclusive-maintenance*.test.mjs`）；流式合并系列（删估计与速率用例）；`runtime-content-usage.test.mjs`（mock）。

新增：残留列表命令测试；“没有任何切换、保留、请求入口”的界面断言。

### 8.6 删除顺序（每一步都要编译通过、定向测试通过）

1. 界面层：`extension.ts` 的接线、`largeHistoricalMerge.ts`、`foreignRuntimeHistory.ts`、`runtimeDataSetManagement.ts`（三者互相 import，同一提交）。
2. `runtimeLargeMergeSession.ts`、`runtimeLargeMergeEngine.ts`、流式合并里的估计与速率。
3. Facade 的 `selectRuntimeDataSet`；`vscodeRootAuthority` 的保留标记写入、“以前切换过”、`SelectionRequiredError`；合并、迁移里的调用方。
4. 合并里的请求与状态逻辑；账本的 requests、prompts、rates；清理、外来合并、迁移携带里的调用方。
5. 清理里的外来部分与其它本地库覆盖证明，新增“已合并来源”；外来库的列表函数。
6. 迁移的“其它数据集”与挪开拷来目录。
7. 合同、`contract-model.mjs`、AGENTS.md、01-invariants、CI 清单与耗时表。按“合同与检查器同一提交”的规则，1—6 步各自带上它们触及的那部分；第 7 步只做收尾的整体核对与文档重写。

### 8.7 量与验收

- 源码：整删约 2000 行、部分删约 3500 行、新增约 200 行，净减约 5300 行。比早先估的 9–10k 少，差额是按决策 G 永久保留的收敛后端（外来发现与核验约 2300 行、流式引擎、独占维护的双请求逻辑）。测试净减约 1 万行。
- 验收：定向测试全过；打包检查；在一份由 v0.0.36 留下多个库、外来归档和拷来目录的真实数据副本上，直接装第 3 期版本，收敛一次，核对结果与第 2 期版本相同；界面上不再出现“历史库”的选择、切换、保留、合并请求、大库会话。

第 3 期合计约 10–15 人日。

## 9. 可选

- 冲突对话按“来源身份 + 旧 id”确定性派生新 id，作为只读副本导入（id 冻结在 CAS 配方与短引用里，需要同时改写配方引用，单独评估）。
- 旧拷贝里当前库没有、又没有删除记录的对话，提供逐条找回（默认不插回）。
- 超过 2000 万行的库分批、可续地合并：以对话为批，每批独立提交并记账，中断后从下一批继续。
- 外来库在私有副本上收尾：在私有拷贝加覆盖目录上执行离线收尾，再从收尾后的拷贝合并，让外来库里有未结束任务的对话也能收进来。
- 确认没有第 2 期之前的安装之后，删掉保留标记的只读识别。

## 10. 跨期约束

- 合同 JSON、`contract-model.mjs` 的逐字期望、AGENTS.md 与 01-invariants 在触及它们的同一提交里改。
- Windows 与 macOS：文件身份比较不能用 lstat 与 fstat 的 `dev` 直接对比（v0.0.33 的教训）；合同里的多行源码片段要经得住 CRLF 检出。Linux 复现不了这两类问题，以 GitHub CI 为准。
- 外来目录永不写入（清理备份删除经证明的那一份本身除外）；读取只经 located 路径与不跟随链接的描述符；真实数据试跑只用 `.backup` 只读副本。
- 旧版本写的选择、保留标记、请求记录、账本状态都要能读；新状态（`partial`、待合并、残留）对旧版本必须是“不认识、不覆盖”。
- 日常只跑受影响的定向测试；完整 `--ci` 回归交给 GitHub CI；发版先推 main、等 CI 全绿，再打 tag 和发布。

## 11. 发布节奏

| 版本 | 内容 |
|---|---|
| 下一版（0.0.37） | epoch 6（5→6 一次升级）+ 第 0 期 |
| 之后一版 | 第 1 期 + 第 2 期的“合并前收尾”（避免 5.1 节的“合并受阻无出路”）；可以连同第 2 期一起 |
| 第 2 期全部 | 用户可见的变化集中在 7.11 的第 7、8 步；发布说明如实写明自动收敛、剔除与残留列表 |
| 第 3 期 | 第 2 期发布、确认收敛正常之后 |

## 12. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 按对话剔除误剔或漏剔 | 漏剔导致整份插入不一致；误剔导致对话没合并进来 | 归属映射机器合同全覆盖；在线与流式等价测试；真实数据试跑核对插入数与剔除清单 |
| 跨对话链接让剔除范围扩大 | 一个冲突带出多个对话 | 剔除清单逐条写原因与连带关系；残留可只读查看，不丢数据 |
| 自动收尾以前用户保留的库 | 来源库的状态被改（中止排队工作） | 一次明确同意、来源先备份、只在本地来源上做；外来库只剔除 |
| 外来库自动核验占用声明与 IO | 启动后变慢 | 后台节流、一次一个、单个声明持有时间设上限 |
| 旧版本把 `partial` 当成别的状态 | 清理备份误删 | 新状态不复用 `merged`；旧版本对未知状态不覆盖；清理只认 `merged` |
| 去掉切换后当前库无法修复 | 当前库出问题时没有出路 | 修复命令自己在独占维护下让当前库离线（5.1 节） |
| 更早版本删过的对话被自动加回 | 用户看到以前删过的对话 | 收敛通知如实写明，合并后可以再删；删除记录只覆盖 0.0.34 起的删除 |
| 未发布的 epoch 7–10 库 | 跑过 10 月 4 日后 main 构建的机器，库被判为“更新的格式” | 只影响维护者的机器；需要时从 epoch 5 升级前备份恢复，再用新版本升级 |

### 第3期请求策略清理进展（2026-10-08）

已移除合并请求文件读写、请求过期、保留分库和一次性询问策略；统一使用无期限 pending 登记与 residual 保留记录。迁移携带登记时核对写入内容，旧请求文件不再参与运行决策。保留来源身份、提交恢复、删除闭包与合并账本。备份清理和多库迁移策略仍在后续清理范围，不能据此视为第3期完成。

### 第3期迁移策略清理进展（2026-10-08）

迁移只复制当前历史库与设置，不为其它来源新建独立运行库；其它来源原位保留，通过 located pending/residual 登记跟随新目录，完成记录不把仅携带引用的来源记成已迁移。连续 A→B→C 保持来源仍指向 A。目标为拷来的数据目录时保留原位、提示使用子目录，不再自动改名挪开；既有中断迁移的恢复入口暂保留以免丢失先前归档。删除记录、身份延续、合并闭包和事务撤销仍保留。
