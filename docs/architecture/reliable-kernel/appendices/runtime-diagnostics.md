# 可靠 Runtime 有界诊断

## 定位

诊断日志是**观察数据**，不是 Runtime 领域 authority，不参与 Turn、Message、Tool、Feed commitSeq 或恢复判定。它位于当前 fenced `RootBinding.paths.dataRootPath/diagnostics/`，每次写入和读取前都由 `RootAuthority.validate(binding)` 重验完整 binding；root 切换后旧 journal fail closed。

## 隐私边界

只允许固定 metadata 字段：Conversation/Turn/ModelRequest/ToolCall/Feed session 身份、序号、阶段、状态、耗时、字节数、记录数和错误类型。

禁止持久化：

- prompt、system prompt、模型正文、thought、tool arguments/result；
- API key、Authorization、headers、代理凭据、密码；
- 文件正文、Diff 正文、路径、URI；
- 任意嵌套对象和未列入 allowlist 的字段；
- 原始错误 message/stack。

字符串 metadata 最长 192 字符；每个事件最多 16 个字段。非法事件直接计入 dropped counter，不能影响 Runtime 控制流。

## 容量与保留

- 内存 pending：最多 512 个事件；
- 单次 flush：最多 128 个事件；
- flush 延迟：750ms；
- 文件：`events.jsonl` + 3 个 rotation；
- 每文件：最多 2MiB；
- 总文件预算：最多 8MiB；
- 保留：7 天；
- 内存汇总：最多 256 个汇总键，窗口 5 分钟；
- inspector：最多返回 200 个事件和 100 个聚合 span。

## 高频事件按窗口汇总

逐条记录会很快挤掉其它事件：旧版在真实重度使用下只保留约 14 分钟，其中 91% 是 `feed.transient.flushed/acked`。现在高频样本调用 `aggregate()`，按 `eventKind + scope + dimensions` 在内存中累计，每 5 分钟（以及 inspect、关闭、汇总键达到 256 个时）为每个键写一条 `<eventKind>.summary`：

- `sampleCount`、`windowMs`；
- 有耗时的样本：`p50Ms`、`p95Ms`（所在直方图桶的上界，不超过实测最大值）、`maxMs`、`totalMs`，以及 `histogramMs`（非零桶，形如 `1:3,50:10,inf:1`，桶上界为 1/2/5/10/25/50/100/250/500/1000/2500/5000/10000/30000ms，`inf` 为更大值），跨窗口合并分布时使用它而不是平均分位数；
- 各计数字段在窗口内求和。

dimensions 与计数字段必须在 metadata allowlist 内，合计不超过 9 个；不合规的样本直接计入 dropped，不会写入。罕见而重要的事件（投递失败、ACK 超时、BUSY、慢写锁等）仍逐条写入。

取舍：窗口只在内存中，进程被强杀或崩溃时会丢失尚未写出的窗口（最多 5 分钟），改动前逐条记录最多丢 750ms。为此不缩短窗口（缩短会成倍增加摘要条数、缩短保留时长），而是在出现 BUSY、慢写锁、WAL 持续增长这类异常时立即写出当前窗口，每分钟最多一次。没有异常时的崩溃仍可能丢最后一个窗口，这部分只影响统计量，不影响异常本身的逐条记录。

几个 Host 会写同一数据根的诊断文件，所以 Runtime 汇总、Feed transient 汇总和 Runtime 异常事件都带 `hostBootId`。

## Runtime 计量

产品 Runtime 在诊断观察者支持汇总（`aggregate` 与 `emitAggregates`）时挂接 `RuntimeDiagnosticMetrics`（`runtimeDiagnosticMetrics.ts`），把 `RuntimePerformanceMetricEvent` 转成上面的汇总；只支持 `observe()` 的观察者（例如测试替身）不会打开计量。记录只在调用线程内更新内存计数，不在写锁内做任何 I/O。worker 侧计量对畸形请求完全防御：出错只丢弃该项计量，请求照常以原错误失败，worker 不会因计量退出。

| 汇总事件 | dimensions | 内容 |
|---|---|---|
| `database.request.summary` | requestKind、status | 每类 worker 请求（含读请求）的往返耗时；`executeMs`、`queueWaitMs` 合计 |
| `database.queue_wait.summary` | — | worker 排队时间分布 |
| `database.write_lock_wait.summary` | requestKind | `BEGIN IMMEDIATE` 拿写锁的等待时间（含 busy_timeout） |
| `database.write_lock_hold.summary` | requestKind | 拿到写锁到 COMMIT 返回（回滚时到响应）的持锁时间 |
| `database.busy.summary` | requestKind、stage、domain、reasonCode | `SQLITE_BUSY`/`SQLITE_LOCKED`/"database is locked" 次数与等待 |
| `feed.snapshot.summary` | reasonCode | Client Feed 全量快照：次数、读取到发送耗时、`bytes` 合计 |
| `feed.external_change.summary` | — | 其它连接提交被轮询发现的次数，`sessionCount` 为受影响会话数合计 |
| `feed.transient.flushed.summary` / `feed.transient.acked.summary` | conversationId / deliveryKind | 流式批次数、原始/发送事件数；transient ACK 延迟 |
| `cas.prepare.summary` | operation（`prepare`/`prepare_batch`） | `ContentAddressedStore.prepare/prepareBatch`：元数据查找加所有未命中的持久发布，也就是命令提交前等待 CAS 的时间；`lookupHits`、`lookupMisses`、`publishes`、`tempWrites`、`fileFsyncs`、`directoryFsyncs` 合计 |
| `database.root_validate`、`database.commit_listeners`、`feed.sync_listener`、`provider.stream_event`、`context.materialize`、`process.phase` 的 `.summary` | 各自的类别 | 对应热路径耗时 |

上表所有汇总的 dimensions 都另含 `hostBootId`。

快照原因 `reasonCode`：`initial`（连接）、`client_request`（Webview 请求）、`commit_scope`（本 Host 提交超出增量范围）、`task_candidate`（任务卡片需要重算）、`change_batch_limit`/`queue_limit`（增量超过批量或队列上限）、`external_commit`（其它 Host 或连接的提交，当前只能整体失效）。一次快照读取期间又到来的请求，其原因留给紧接着的下一次快照；读取期间到来的本 Host 提交在快照发出后回放，其中超出增量范围的同样把 `commit_scope` 留给下一次快照。

"外部提交成本"的统计口径：`feed.snapshot.summary` 中 `external_commit` 只覆盖对话面板的 Client Feed。侧栏历史列表的外部刷新走 Facade 的 `ExternalDataVersionWatcher`，运行工作的外部刷新走 ProductRuntime 的同名 watcher，二者都不产生 Feed 快照；它们的成本体现在 `database.request.summary` 的 `conversationHistoryProjection`、`externalDataVersion` 等 requestKind 中，汇总脚本会按 requestKind 列出。

逐条事件（每类每 5 分钟最多 20 条，汇总仍计入全部样本）：

- `database.busy`：requestKind、stage（`begin`/`body`/`commit`）、domain（事务首个写入领域）、reasonCode、lockWaitMs、elapsedMs；
- `database.write_lock.slow`：等待或持有写锁 ≥250ms 的请求，含 lockWaitMs、holdMs、queueWaitMs。

WAL：每 60 秒对 `-wal` 做一次 `stat()` 取大小，每 5 分钟写一条 `database.wal`（hostBootId、walBytes）。WAL 文件在本项目配置下不会被截断，大小是历史最高水位：正常自动 checkpoint（默认 1000 页，约 4MiB）会让日志从头复用；只有 checkpoint 无法重置日志（通常是长时间存活的读事务）时才会继续变大。因此大小 ≥16MiB 且比上次采样更大时立即写 `database.wal.growing`，并提前写出汇总窗口。

**在线备份期间本窗口的数据库请求排队。** `RuntimeDatabase.backupTo`（worker 请求 `backupDatabase`）在 worker 线程上另开一个只读连接，用 SQLite Backup API 复制：第一步不复制页面，第二步用一次同步调用复制整库。这次调用返回之前，本窗口的所有数据库请求（读请求也一样）都在 worker 队列里等待；其它 Host 照常读写，它们的提交也不会让复制从头再来，因为这一步只持有一个读事务。等待时间与库的大小成正比：审查实测 137MB 的库复制约 280ms，期间一次读请求最多等了 278ms（空闲时不到 2ms）；按比例，1GB 约 2 秒。这段等待记入被挡住的请求的 `queueWaitMs`（`database.queue_wait.summary`），复制本身记在 `database.request.summary` 的 `backupDatabase`。执行租约不会因此被其它窗口接管：存活 Host 的租约即使过期也不会被取代。当前的调用方都是维护流程：预复制内容时读取本窗口正在使用的来源库、合并前备份目标库、整库复制后的逐行核验、迁移数据目录前统计行数。

**大库合并的维护事务。** 大库会话（`runtimeDataSetStreamedMerge.ts`）的独占阶段以 `historical-merge-<uuid>` 打开一个私有维护实例，这时没有其它 Host 在线。它的请求 `maintenanceBegin`/`maintenanceAppend`/`maintenanceCommit`/`maintenanceRollback`/`maintenanceCheckpoint` 在 `database.request.summary` 里都记为 `transaction`；一份来源的写事务跨越它的全部 `maintenanceAppend`（每块 250 行来源），整份来源的耗时看会话进度与日志，不看单个请求。提交之前不能 checkpoint，WAL 会长到约来源库的 1–1.5 倍（同一事务里同一页原地复写）；提交之后单独做 `wal_checkpoint(TRUNCATE)` 收回，然后才写“已合并”。收回失败只写日志 `[LimCode] 较大的旧聊天记录已合并，但之后收回预写日志失败。`，有读者挡住时写 `……预写日志还在被读取，没有完全收回。`；合并记录没写成时写 `……合并记录没有写成；下次启动时按实测确认。`，结果仍是已合并。内存不随来源行数增长：维护实例 writer 的 main 与 temp、reader 的页缓存各 4 MiB，来源私有拷贝的连接 main 与 temp 各 2 MiB（SQLite 默认每库 16 MiB）；事务跨块要记住的请求聚合与历史复制的请求在 writer 的 TEMP 表 `runtime_maintenance_scratch` 里，分配记录只计数。实测（`runtime-dataset-merge-streamed-memory.test.mjs`，`LIMCODE_LARGE_MERGE_MEMORY=1`，维护 worker 老生代上限 128 MB，两个线程的新生代封顶在几 MB）5 万行与 40 万行的来源峰值常驻内存约 152 与 157 MB；不封新生代时 V8 在长时间运行里把每个线程的新生代逐步长到上限，两者相差约 35–57 MB，与来源大小无关。账本里与它有关的文件：`preparing/<id>.json`（哪个进程在准备这份来源：token、processId、startedAt、heartbeatAt，10 秒心跳，60 秒没刷新或进程已不在即可接手，批末与会话结束时清理），`commits/<id>.json`（有上限的提交证据）；等待大库会话的来源不写账本，只在批结果里以 `runtime-data-set-merge-awaiting-exclusive` 推迟并带 `size`。

**持有 SQLite 连接的进程不得 open/read/close `limcode.sqlite`、`-wal` 或 `-shm`**（`stat` 不打开描述符，可以使用）。SQLite 的 unix VFS 在主库和 `-shm` 上持有 POSIX fcntl 锁（写锁、读标记、DMS）；按 POSIX 语义，进程关闭该文件的任意一个描述符，就会释放本进程在该文件上的全部锁，另一个 Host 随即可以在本 Host 写事务中途提交并被覆盖。因此不再采集 WAL-index 中的 mxFrame/nBackfill（未 checkpoint 帧数）；需要精确积压时只能在不持有该库连接的独立进程里读取。其它 Host 的读事务年龄同样无法从本进程观察；本 Host 读事务都在单个 worker 请求内完成，其最长耗时即 `database.request.summary` 中读请求的 `maxMs`。

**文件工具已统一拦截。** 扩展宿主进程内所有按路径访问本地文件的入口，都先经过 `backend/capabilities/filesystem/sqliteDatabaseFileGuard.ts`：`read`（文本、图片/PDF、批量）、`write`/`edit`/`delete` 的提案规划和执行对账、`transfer` 的源和目标、本地路径附件（用户拖入、Provider 引用、附件重新加载）以及计划导出。守卫只用 `stat`/`realpath`，按给定路径和真实路径（解析符号链接）各判定一次，文件名不区分大小写。拒绝以下文件：LimCode 自己的库文件，包括任意位置的 `limcode.sqlite`、`limcode.epoch-N.sqlite`、`limcode.sqlite.<pid>.tmp` 及其 `-wal`/`-shm`/`-journal`，覆盖当前数据集、旧工作区 scope、合并备份、迁移备份；合并预复制、迁移计数和复制核验用的私有暂存库 `merge-precopy-*.sqlite`、`relocation-count-*.sqlite`、`copy-verify-*.sqlite` 及其 `-wal`/`-shm`/`-journal`；任何旁边存在同名主库的 `X-wal`/`X-shm`/`X-journal`；任何旁边存在这些伴随文件的主库 `X`。RuntimeDatabase 的 worker 运行期间，还会登记本进程正在使用的库：凡是与它的主库或伴随文件 device+inode 相同的路径都拒绝，硬链接、别名路径和大小写变体都逃不过；递归删除它的任一上级目录也拒绝。拒绝时工具返回明确错误，并提示改在终端子进程里用 `sqlite3 -readonly <库> ".tables"` 或 `".backup '<副本>'"` 访问。子进程有自己的锁，不受影响。VS Code 打开编辑器、终端命令这类在其它进程里执行的访问不在拦截范围内。

诊断写入失败不会重试外部动作，也不会阻断 Agent loop；失败批次被丢弃，只暴露脱敏错误 code。

## 大库合并会话

大库会话（`vscode/commands/largeHistoricalMerge.ts`，见 `01-invariants-and-authority.md` 的历史合并一段）不写新的诊断事件，排查只看这几处：

- **日志**：会话的准备、协调或独占阶段出错时写 `[LimCode] 合并较大的旧聊天记录……` 的 error；独占阶段结束时每份来源一行 `[LimCode] 合并较大的旧聊天记录：<来源 id> <merged|cancelled|deferred|blocked|failed>`；重载后提示结果时，合并了的来源与在线合并一样各写一行 `已合并旧聊天记录 …`。
- **提示记录**：配置根 `.limcode-runtime-merges/prompts/large-merge-session.json` 写着哪个 VS Code 会话（`sessionId`）、哪个进程（`processId`/`processStartIdentity`）、哪个窗口（`hostBootId`）在准备并提示。它只是提示，不是合并记录；记录的会话与当前相同或记录进程仍存活时，其它窗口启动时不再提示，点“取消”后也不会改动它。
- **维护进行中标记**：独占阶段里持锁方在 admission 与目标 maintenance 的锁目录下的 `activity.json` 带 `stage`（“第 2/4 份，已完成 35%”，按 5% 一档）和 `expectedEndAt`（开始合并时按预计区间上限算出）。等待打开的窗口把 `expectedEndAt` 显示为“预计 HH:MM 前完成”，心跳正常时直到已进行预计时长的 1.5 倍（且不少于 10 分钟）才给久等告警；心跳超过 15 秒没刷新照常立即告警。
- **重载后结果**：发起窗口在重载前把结果写进自己的 workspaceState（`limcode.largeHistoricalMerge.result`），重新打开时读取并清除；打开时间与写入时间相差超过 10 分钟就不再提示，这时以“历史与存储管理”里各库的状态为准。

## 覆盖链路

### Provider 首包到首画

```text
agent.lifecycle(provider_dispatch_started)
→ provider.transient.first_event
→ webview.transient.painted
```

三者按 `modelRequestId` 聚合为 `provider-first-paint` span。Webview paint 使用双 `requestAnimationFrame`，表示状态应用后至少跨过一次浏览器绘制机会。

### Feed post / ACK / paint

```text
feed.data.posted
→ feed.data.acked 或 feed.data.post_failed
→ webview.feed.painted
```

按 `sessionId + messageSeq` 聚合为 `feed-roundtrip` span。空 changes 包不记录，避免诊断自身形成反馈回路。

### 完成态 Diff

```text
diff.open.requested
→ diff.cas.loaded
→ diff.editor.shown 或 diff.open.failed
```

按 `toolCallId` 聚合为 `diff-open` span。只记录成员数量和耗时，不记录文件路径或内容。

## 按类型统计正文占用

“历史与存储管理 → 查看存储占用”对当前库在目录统计之后附上按类型统计的正文（`backend/reliableKernel/runtimeContentUsage.ts`）；开发模式的 Inspect Reliability State 在 JSON 的 `contentUsage` 里给出同一份数据。

- **只读元数据。** 由当前库自己的 RuntimeDatabase worker 在 reader 连接上执行一条固定查询（worker 请求 `contentUsage`，耗时计入 `database.request.summary` 的同名 requestKind）：`SELECT content_type, COUNT(*), SUM(byte_length), MAX(byte_length) FROM content_object GROUP BY content_type`。它只按顺序扫描唯一覆盖索引 `(content_type, sha256, byte_length)`，查询计划为 `SCAN content_object USING COVERING INDEX ux_content_object_01`，没有 `USE TEMP B-TREE FOR GROUP BY`，也不回表；不读 CAS 目录下的任何文件；在 reader 的 WAL 读快照上执行，不拿写锁，不阻塞写入。耗时与记录数成正比：实测 30 万条记录（库约 126 MiB，文件已在系统缓存中）约 50 毫秒；执行期间本窗口的其它数据库请求在 worker 队列里等待。
- **只统计当前库。** 只有所选库正是本窗口已打开的 Runtime（dataSetId、rootInstanceId 和目录都一致）时才统计；当前库的 SQLite 只经它自己的 worker 读取，不另开连接。其它库、外来库和备份不做这项统计，视图写明“只对当前库提供”；本窗口还没有打开当前库时写明暂时无法统计。查询失败只在这一段报告原因，目录统计照常显示。
- **按记录统计。** 每个分类显示记录数、合计大小和最大单个，分类下按大小列出具体类型（中文名加类型；Runtime 自有类型省略 `application/vnd.limcode.` 前缀）。同一正文（同一 sha256）以几种类型各有一条 ContentObject 时，每种类型都计入，所以各类合计可能大于 CAS 目录的实际大小；磁盘实际占用以同一视图上方的目录统计为准。不计算按 sha256 去重的合计，因为它需要临时 B 树。
- **分类。** 源码写入的每个 `application/vnd.limcode.*` 类型都有归类，`effect-<kind>+json` 与 `effect-<kind>-receipt+json` 按 Effect 种类命名（新增 Effect 种类不起名就编译失败）。`text/plain`、`text/markdown`、`application/json` 被多处共用，单列为“通用文本”；`application/octet-stream` 归“进程原始输出”，并注明它也用于写入或删除前的原文件快照和未识别格式的附件；其余媒体类型归“附件”；未知的 vnd.limcode 类型和不合法的值原样列在“其它”。测试扫描源码中的类型字面量，新增类型没有归类时失败。
- **删除对话目前不会释放正文空间。** 视图同样写明这一点。

## 查看

离线汇总（只读诊断文件，不打开 SQLite）：

```bash
node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs <数据目录>
node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs --json <数据目录> | jq '.feedSnapshots, .writeLockWaitMs, .hosts'
```

诊断日志的位置：数据目录（设置页显示的数据目录；没有迁移过时是 VS Code 给扩展的全局存储目录，例如远程 SSH 下的 `~/.vscode-server/data/User/globalStorage/your-publisher.limcode-test`）下，当前默认历史库的诊断日志在 `<数据目录>/.limcode-runtime/active/diagnostics/events.jsonl`（轮转后另有 `events.1.jsonl`～`events.3.jsonl`）。脚本依次认参数本身、`<参数>/diagnostics`、`<参数>/.limcode-runtime/active/diagnostics`，所以传数据目录、运行数据根 `<数据目录>/.limcode-runtime/active` 或诊断目录本身都可以；按工作区分的旧历史库在 `<数据目录>/.limcode-workspace-runtimes/scopes/<key>/.limcode-runtime/active/diagnostics`，需直接传入。一个 events 文件都找不到时，脚本列出找过的路径并以退出码 1 结束，不会输出空报告。

输出包括覆盖时长、按原因的快照次数与字节及外部提交占比、各 requestKind 的请求往返分布（含读请求）、写锁等待/持有分布（p50/p95/p99 为桶上界）、BUSY 位置、慢写锁、WAL 大小和 CAS 发布耗时，并在 `hosts` 下按 `hostBootId` 分组。默认只统计保留期（7 天）内的事件，`--all` 统计文件中的全部事件；无法解析或缺字段的行会跳过并计数。

Extension Development Host 中运行：

```text
Limcode test: Inspect Reliability State (Development)
```

输出中的 `diagnostics.events` 是原始脱敏事件，`diagnostics.spans` 是上述三类链路的有界聚合；`database.contextCasCache` 同时展示长上下文 CAS LRU 的 entries/bytes/hits/misses/evictions；`database.statementCache.writer/reader` 展示 SQLite worker 两个连接预编译语句 LRU 的 entries/prepares/hits/misses/evictions/busyBypasses/uncached/invalidations（只有计数，不含 SQL 文本）；`contentUsage` 是“按类型统计正文占用”一节的数据（只有类型、记录数和字节数）。
