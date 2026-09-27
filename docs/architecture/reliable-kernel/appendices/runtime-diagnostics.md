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

**持有 SQLite 连接的进程不得 open/read/close `limcode.sqlite`、`-wal` 或 `-shm`**（`stat` 不打开描述符，可以使用）。SQLite 的 unix VFS 在主库和 `-shm` 上持有 POSIX fcntl 锁（写锁、读标记、DMS）；按 POSIX 语义，进程关闭该文件的任意一个描述符，就会释放本进程在该文件上的全部锁，另一个 Host 随即可以在本 Host 写事务中途提交并被覆盖。因此不再采集 WAL-index 中的 mxFrame/nBackfill（未 checkpoint 帧数）；需要精确积压时只能在不持有该库连接的独立进程里读取。其它 Host 的读事务年龄同样无法从本进程观察；本 Host 读事务都在单个 worker 请求内完成，其最长耗时即 `database.request.summary` 中读请求的 `maxMs`。

**文件工具已统一拦截。** 扩展宿主进程内所有按路径访问本地文件的入口，都先经过 `backend/capabilities/filesystem/sqliteDatabaseFileGuard.ts`：`read`（文本、图片/PDF、批量）、`write`/`edit`/`delete` 的提案规划和执行对账、`transfer` 的源和目标、本地路径附件（用户拖入、Provider 引用、附件重新加载）以及计划导出。守卫只用 `stat`/`realpath`，按给定路径和真实路径（解析符号链接）各判定一次，文件名不区分大小写。拒绝以下文件：LimCode 自己的库文件，包括任意位置的 `limcode.sqlite`、`limcode.epoch-N.sqlite`、`limcode.sqlite.<pid>.tmp` 及其 `-wal`/`-shm`/`-journal`，覆盖当前数据集、旧工作区 scope、合并备份、迁移备份；任何旁边存在同名主库的 `X-wal`/`X-shm`/`X-journal`；任何旁边存在这些伴随文件的主库 `X`。RuntimeDatabase 的 worker 运行期间，还会登记本进程正在使用的库：凡是与它的主库或伴随文件 device+inode 相同的路径都拒绝，硬链接、别名路径和大小写变体都逃不过；递归删除它的任一上级目录也拒绝。拒绝时工具返回明确错误，并提示改在终端子进程里用 `sqlite3 -readonly <库> ".tables"` 或 `".backup '<副本>'"` 访问。子进程有自己的锁，不受影响。VS Code 打开编辑器、终端命令这类在其它进程里执行的访问不在拦截范围内。

诊断写入失败不会重试外部动作，也不会阻断 Agent loop；失败批次被丢弃，只暴露脱敏错误 code。

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

## 查看

离线汇总（只读诊断文件，不打开 SQLite）：

```bash
node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs <数据根或其 diagnostics 目录>
node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs --json <数据根> | jq '.feedSnapshots, .writeLockWaitMs, .hosts'
```

输出包括覆盖时长、按原因的快照次数与字节及外部提交占比、各 requestKind 的请求往返分布（含读请求）、写锁等待/持有分布（p50/p95/p99 为桶上界）、BUSY 位置、慢写锁、WAL 大小和 CAS 发布耗时，并在 `hosts` 下按 `hostBootId` 分组。默认只统计保留期（7 天）内的事件，`--all` 统计文件中的全部事件；无法解析或缺字段的行会跳过并计数。

Extension Development Host 中运行：

```text
Limcode test: Inspect Reliability State (Development)
```

输出中的 `diagnostics.events` 是原始脱敏事件，`diagnostics.spans` 是上述三类链路的有界聚合；`database.contextCasCache` 同时展示长上下文 CAS LRU 的 entries/bytes/hits/misses/evictions；`database.statementCache.writer/reader` 展示 SQLite worker 两个连接预编译语句 LRU 的 entries/prepares/hits/misses/evictions/busyBypasses/uncached/invalidations（只有计数，不含 SQL 文本）。
