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

## Runtime 计量

产品 Runtime 在诊断观察者支持汇总时挂接 `RuntimeDiagnosticMetrics`（`runtimeDiagnosticMetrics.ts`），把 `RuntimePerformanceMetricEvent` 转成上面的汇总；只支持 `observe()` 的观察者（例如测试替身）不会打开计量。记录只在调用线程内更新内存计数，不在写锁内做任何 I/O。

| 汇总事件 | dimensions | 内容 |
|---|---|---|
| `database.request.summary` | requestKind、status | 请求往返耗时；`executeMs`、`queueWaitMs` 合计 |
| `database.queue_wait.summary` | — | worker 排队时间分布 |
| `database.write_lock_wait.summary` | requestKind | `BEGIN IMMEDIATE` 拿写锁的等待时间（含 busy_timeout） |
| `database.write_lock_hold.summary` | requestKind | 拿到写锁到 COMMIT 返回（回滚时到响应）的持锁时间 |
| `database.busy.summary` | requestKind、stage、domain、reasonCode | `SQLITE_BUSY`/`SQLITE_LOCKED`/"database is locked" 次数与等待 |
| `feed.snapshot.summary` | reasonCode | Client Feed 全量快照：次数、读取到发送耗时、`bytes` 合计 |
| `feed.external_change.summary` | — | 其它连接提交被轮询发现的次数，`sessionCount` 为受影响会话数合计 |
| `feed.transient.flushed.summary` / `feed.transient.acked.summary` | conversationId / deliveryKind | 流式批次数、原始/发送事件数；transient ACK 延迟 |
| `cas.prepare.summary` | operation | CAS 准备/发布耗时，publish、fsync 与查找命中数 |
| `database.root_validate`、`database.commit_listeners`、`feed.sync_listener`、`provider.stream_event`、`context.materialize`、`terminal_prefix.scan`、`process.phase` 的 `.summary` | 各自的类别 | 对应热路径耗时 |

快照原因 `reasonCode`：`initial`（连接）、`client_request`（Webview 请求）、`commit_scope`（本 Host 提交超出增量范围）、`task_candidate`（任务卡片需要重算）、`change_batch_limit`/`queue_limit`（增量超过批量或队列上限）、`external_commit`（其它 Host 或连接的提交，当前只能整体失效）。

逐条事件（每类每 5 分钟最多 20 条，汇总仍计入全部样本）：

- `database.busy`：requestKind、stage（`begin`/`body`/`commit`）、domain（事务首个写入领域）、reasonCode、lockWaitMs、elapsedMs；
- `database.write_lock.slow`：等待或持有写锁 ≥250ms 的请求，含 lockWaitMs、holdMs、queueWaitMs。

WAL：每 60 秒从文件系统读取 `-wal` 大小和 `-shm` 中 WAL-index 头（[格式](https://sqlite.org/walformat.html)）的 mxFrame/nBackfill，不打开 SQLite、不做 checkpoint。每 5 分钟写一条 `database.wal`（walBytes、walFrames、checkpointedFrames、pendingFrames）；未 checkpoint 帧 ≥2000（默认自动 checkpoint 阈值的两倍）时立即写 `database.wal.checkpoint_lagging`。其它 Host 的读事务年龄无法从本进程观察；本 Host 读事务都在单个 worker 请求内完成，其最长耗时即 `database.request.summary` 中读请求的 `maxMs`。

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
node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs --json <数据根> | jq '.feedSnapshots, .writeLockWaitMs'
```

输出包括覆盖时长、按原因的快照次数与字节及外部提交占比、各请求类型的写锁等待/持有分布（p50/p95/p99 为桶上界）、BUSY 位置、慢写锁、WAL 积压和 CAS 发布耗时。

Extension Development Host 中运行：

```text
Limcode test: Inspect Reliability State (Development)
```

输出中的 `diagnostics.events` 是原始脱敏事件，`diagnostics.spans` 是上述三类链路的有界聚合；`database.contextCasCache` 同时展示长上下文 CAS LRU 的 entries/bytes/hits/misses/evictions。
