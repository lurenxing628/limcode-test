# LimCode 会话运行时存储拓扑：研究结论与架构意见

研究日期：2026-09-25。先给事实和实验结论，再给建议。**这是一份研究报告，不是已实现的改造，不包含生产数据库迁移工具。**

## 0. 范围、基线与证据等级

- 仓库：`/home/dev/projects/limcode-test`，HEAD `11ce63e195c667c78154e8560e598a1024f69b01`，package 0.0.28；研究前后原工作区均无变更。
- 源码、规则、合同：阅读 AGENTS.md、可靠内核文档和相关机器合同、settings 对接规范。代码证据集中于 [source-evidence.md](evidence/source-evidence.md)。
- 实际安装目录有 0.0.25/0.0.26/0.0.27；0.0.27 build-provenance 的 `worktreeClean=false`。没有把仓库 0.0.28 当成正在运行的扩展版本，也没有证明当前 Host 具体装载了哪一个安装目录。
- 两个真实数据根各用只读源连接和 SQLite Backup API 建立一致性备份。只查询副本，源 CAS 只读统计/校验，未输出对话正文、凭据。备份中含私人数据，不应上传。
- 主要快照时间：`2026-09-25T19:37:26.629060Z`。Linux/ext4；Node 24.19.0；实验使用项目相同的 better-sqlite3 13.0.2 / SQLite **3.53.4**。Python 3.34.1 SQLite 仅用于备份与只读审计。
- 原仓库没有编译或测试。另建完整本地克隆和独立 node_modules，在该快照编译成功。
- 定向真实内核回归 **112 pass / 0 fail / 0 skipped**。全量本地测试到 600 秒硬期限被中断；日志记录 978 条成功标记，随后大量取消，**不能称全量通过**。
- 不使用子 Agent。上游版本固定在 [upstream-baseline.json](evidence/upstream-baseline.json)，14 个关键 issue/PR 的内容和状态保存在 [upstream-issues.json](evidence/upstream-issues.json)。

证据等级：**已核实**＝源码/发布物/实测；**有限证据**＝样本或合成实验，只支持相应范围；**推断/建议**＝架构判断；**未验证**＝本轮环境或材料不足。没有在 Windows、NFS、网络盘、杀毒慢盘或真实 Desktop 上实验，也没有做断电故障注入。

---

# 第一部分：研究结论

## 1. 最重要的结论

1. **提示词的版本时间线有实质错误。** 正式发布的 **0.0.24 已是 epoch 5，并使用固定历史库选择**。不是 0.0.25 才首次切换。已下载官方 linux-x64 VSIX、匹配发布的 SHA256SUMS，包内 provenance 指向 `bdc477a48ab7b4688c0b23791c2bb3ad10500681`；包内代码直接证明 epoch=5 和 `.limcode-runtime-selection.json`。因此“装回 0.0.24 就恢复按工作区分库”的前提错误。
2. **多宿主共享库已经有真实的正确性机制，不等于没有并发保护；但没有应用层 SQLite BUSY 重试，也没有跨宿主精细变更识别。** 所有权、ExecutionLease 和维护互斥不是写入吞吐优化，不能替代锁等待/事务治理。
3. **跨项目快照放大已用真实 Runtime/Feed 重现。** 两个未变化对话监听时，另一个项目的三次提交触发六次新快照；两边 activeConversationWindow 哈希完全不变。这是实现问题，不是共享 SQLite 必然如此。
4. **短事务下没有测出必须分库的容量问题，长事务下确实存在项目间干扰。** 同引擎合成测试中，4 写者共 600 次短事务零 BUSY，成功事务 p99≈2.17ms；强制 6.2 秒持锁时，4 个写者各失败一次。分库将影响限制在对应项目；重试消除本次失败，却把等待延长到约 6.56 秒。
5. **本机体积主要来自 CAS 与累计修订，不是一个 159MiB SQLite 文件本身。** 当前指针以外但仍被 MessageRevision 保留的内容约 196.19MiB；SQL/启发式正文引用审计识别的无引用候选仅约 19.27MiB。GC 必要，但不是本样本最大的节省来源。
6. **“每个流式 delta 都落检查点”不符合当前代码。** 普通 dispatch 路径只持久化首个普通 delta，其后合并并按心跳记录活动；语义 item、native control、tool admission、终态仍持久化。累积全文修订的具体重要来源是 native assistant item 的 `cumulativeContent`，不能混成“每个 token 都写整篇”。
7. **项目分库在原则上可行，但没有被当前样本完整证明。** 107 领域、164 组物理 FK 及可解析软引用审计未发现跨项目非内容连接；但 37 个对话中，36 个在同一项目，另一个项目的对话没有 Turn。还有 542 条没有显式 conversation/turn 的回执，需要通过来源语义处理。不能直接按 project_id 筛行就宣称完整迁移。
8. **现阶段必须处理旧历史可访问性。** 原库文件保留不是用户体验上的“无损可用”。当前 epoch 3/4 历史读取入口确实拒绝直接打开，要求先切换/升级；新共享库本身没有把其他旧库合并进来。

## 2. 版本、存储演进与回滚事实

| 对象 | 复核结果 | 证据 |
|---|---|---|
| 按工作区隔离 | 2026-08-11 提交 `2318ca99` 创建 workspace scopes 和 WorkspaceRuntimeOwnerClaim，原先的单 Host 限制属实 | Git 提交及历史 `vscodeRootAuthority.ts` |
| 对话级多宿主 | `5cf8d921` 引入按对话归属，多工作区分库不再是不同 Host 能运行的必要条件 | 现有 owner/lease/maintenance 代码与跨进程回归 |
| 固定历史库 | 提交 `d3f79edb`（2026-09-22）引入固定选择和管理入口；已进入 **0.0.24** 发布物 | 包内 compiled `vscodeRootAuthority.js`；[release-0.0.24-verified.json](evidence/release-0.0.24-verified.json) |
| 0.0.10–0.0.14 | 核验代表 tag 的 epoch=3 | [project-version-evidence.json](evidence/project-version-evidence.json) |
| 0.0.15–0.0.21 | 核验代表 tag 的 epoch=4；0.0.21 仍按工作区选择 | 同上；`git show v0.0.21:backend/reliableKernel/vscodeRootAuthority.ts:132–165` |
| 0.0.24–当前 | 0.0.24 已是 epoch 5；其 schema 目录和 contracts.ts 与研究 HEAD 无差异 | VSIX 摘要、provenance、`git diff v0.0.24 HEAD -- .../schema .../contracts.ts` |
| 所谓 0.0.9 新可靠库 | **不能按提示词直接接受。** 仓库 v0.0.9 tag 指向 2026-07-26 的旧提交，没有该 contracts.ts；GitHub 同名 release API 404。可能混用了开发期 package 版本与正式 tag | [release-0.0.9.json](evidence/release-0.0.9.json)；版本证据表 |

0.0.24 包 SHA-256：`092162fbbfb053e6dd3ab352fab595031c0f5ede15540c617ef67392cb700f52`，与官方校验文件匹配。未安装或运行此旧扩展。

**回滚结论：**
- 回到 0.0.24 不会自动回到“每工作区一个库”。相同 DDL 不等于所有宿主和内容语义都保证向后可用；0.0.25 的发布提交还包含远程 Host 原生模块启动修复。
- 回到 0.0.21 等真正的旧工作区选择器，可能读取另一份旧 scope、遇到 epoch 不匹配，或建立/显示另一份历史。具体由根布局和 legacy-owner 决定，不能笼统宣称必然丢数据或必然安全。
- 新代码不能强迫已经发布的旧二进制理解新选择指针。可靠保护是原始备份、独立恢复根、明确提示和禁止推荐旧程序直接写唯一现存新库，而不是只写一个旧程序不认识的 marker。

## 3. 提示词关键事实复核表

| 原提示词要点 | 状态与修正 | 主要证据 |
|---|---|---|
| 3.1 一个宿主只装配一个 ProductRuntime | 已核实。当前 Facade 单 placement→单 ProductRuntime；同进程还拒绝同根重复开 worker | `VscodeReliableKernelApplicationFacade.ts:156–195`；实际双实例实验被拒绝，后改为跨进程 |
| 3.2 URI 生成项目身份 | 已核实，但准确说是 trim 后字符串哈希，不是 filesystem canonical identity | `conversationProject.ts:18–20,125–129` |
| 项目关联只创建、不改挂 | 已核实当前合同/调用模型；变更这一语义必须重新设计协作授权的事务检查 | `agent-collaboration.md:131–137` |
| 子对话/fork 继承项目，协作限制同项目 | 已核实相关实现和合成跨项目拒绝测试；这不构成全数据库可分片证明 | `childExecution.ts:463`；`collaborationControlPlane.ts:516–535`；`cross-conversation-tools.test.mjs:513–573` |
| 3.3 WAL/NORMAL/5000ms/BEGIN IMMEDIATE | 已核实 | `databaseSchema.ts:33–44`；`databaseWorker.ts:616–636` |
| 没有应用层 BUSY 重试 | 事务路径直接抛出；源码检索未发现 SQLITE_BUSY 分支。已有 SQLite busy_timeout，不能说“完全不等待” | 同上 |
| 删除整个后代树是一个事务 | 已核实；删除前的快照还读取多个整库领域 | `conversationDeletion.ts:24–29,94–114` |
| owner、lease、维护互斥 | 已核实，定向跨进程回归通过 | `01-invariants-and-authority.md:40–60`；ownership 测试 |
| 3.4 三类 data_version 轮询 | 已核实三条调用链；不是每个空闲窗口始终无条件发出三个查询 | `clientFeed.ts:986`；Facade:131；ProductRuntime:131；ExternalDataVersionWatcher:7 |
| 外部提交令所有面板快照失效 | 已核实且真实跨进程重现 | `clientFeed.ts:1003–1014`；[feed-isolation.json](evidence/feed-isolation.json) |
| 整页 1.8MB / ACK 815ms | **本轮未重现原采样。** 轮转日志现存 2 个 snapshot，中位 289,623 bytes / 377.5ms；284 个 changes 中位 1,463 bytes / 190ms，样本不足以估算真实多窗口 CPU | [feed-diagnostics.json](evidence/feed-diagnostics.json) |
| 3.5 导航前 200 个对话不按项目过滤 | 已核实导航快照查询 | `clientProjection.ts:667–683` |
| COUNT 全表扫描 | 精确说是扫描全会话覆盖索引，逐项执行相关子查询；没有按目标项目先缩小范围。直接关联索引计数可显著改善 | `clientProjection.ts:1647–1649`；EXPLAIN 结果 |
| 每个外部提交重做历史页 | 外部 watcher 刷新历史；游标还绑定全库/local commitSeq:data_version，无关提交也可能使分页游标 reset | `clientProjection.ts:1621–1624`；Facade:131 |
| 3.6 恢复跨项目认领 | 已核实未指定 conversationId 的 active/queued 扫描及 owner 认领；cwd 确由冻结环境解析，但交互归属没有因此解决 | Runner:691–743；ToolHost:302–326 |
| 审批/提问在哪个窗口 | 已核实通知调用本 Host 的 VS Code API；pending 查询没有项目/owner 过滤。启动时其他窗口也可能发现同一问题。diff 在本 Host 打开。**未做两窗口 GUI 自动化** | Facade:111,596–635；interactionAttention:44–78；VscodeReliableFileDiffEditor:77 |
| 3.7 大量修订和无 CAS GC | 已核实；当前指针不引用不等于没有其它有效引用。SQLite 删除能释放内部可复用页，通常不立即缩小文件，CAS 不随会话删除回收 | `turnOutput.ts:180–230`；CAS 统计；不变量文档:152 |
| 检查点持续保留 | 有重要补充：已有普通 delta 合并及终态尾部裁剪，但裁剪 checkpoint 行不回收对应 CAS | `modelProviderControlPlane.ts:1558–1586`；`databaseWorker.ts:1639–1666` |
| 3.8 整库升级/只读历史/统计线性工作 | 已核实操作路径；未实测 GB 级全库升级耗时，不能给精确停机时长 | runtimeEpochMigration / runtimeDataSetHistory:44–80 / runtimeStorageInspection |
| 3.9 配置 roots 独立、两个安装数据根 | 已核实；“每个宿主一份全局库”表述不准，实际是**每个数据根**共享，多个 Host 可以连接同一根 | 本机枚举、getPaths/RootBinding 代码、settings 规范 |

### 新发现的合同限制

`databaseWorker.ts:199` 的 commitSeq 是每个 worker 的内存计数；变更捕获是 TEMP TABLE (`:394`)。它不是跨 Host 持久游标。

`schema/domainManifest.ts:162–173` 明确禁止 `client_change_log`。不能靠重命名绕过这一限制。精细失效元数据若需要持久化，必须作为非正文、非第二套客户端权威的明确合同变更设计，增表/索引/trigger 必须处理 epoch。

## 4. 数据、闭合性与体积

### 4.1 一致性和范围

主备份：109 张表（107 Runtime 领域 + 两张 metadata 表），37 个对话、26 个 ChildExecution、5,528 条 Message、21,090 条 MessageRevision。两个数据根的 quick_check 均为 ok，foreign_key_check 均为零。

对主备份对应的 **77,254 个唯一 CAS 文件**逐个校验长度与 SHA-256，缺失/长度不符/摘要不符均为零。ContentObject 行数是 80,931；不同 content type 可共用同一个物理 sha256 文件，不能按 catalog 行数重复计物理空间。

### 4.2 体积，统一用 MiB

| 项目 | 大小/数量 | 说明 |
|---|---:|---|
| 一致性 SQLite 副本 | 159.34 MiB | 已包含备份时提交的 WAL 事实 |
| 快照 catalog 对应 CAS，唯一逻辑 bytes | 504.06 MiB | 按 storage_key 去重 |
| 同一集合实际分配 blocks | 715.04 MiB | 不含目录等额外 metadata；块开销约 210.98 MiB |
| 稍后遍历整个活跃 CAS | 728.30 MiB / 80,134 文件 | 含不在备份 catalog 的文件，不与 DB 备份构成同一时刻快照 |
| 非当前 MessageRevision 独立内容 | 196.19 MiB | **不是可直接删除量**；可能仍用于 Context/fork/重放 |
| 无 SQL 引用、且未被启发式正文 ContentObject 引用命中的候选 | 19.27 MiB / 8,153 文件 | 仍需 active operations、backup、合法恢复根核验，不是 GC 删除清单 |

ContentObject 语义类型的逻辑 bytes：message+json 210.78 MiB；recipe 93.90 MiB；stream checkpoint 82.45 MiB；context-tool-pair 31.57 MiB；工具纯文本 25.44 MiB；tool-model-result 19.75 MiB。这些是按类型 catalog 的口径，不与物理 CAS 直接相加。

SQLite 页占用前三类包括 ContentObject 主表约 24.38 MiB、其唯一索引约 11.01 MiB、CommandReceipt 主表约 8.67 MiB；这也是大量小内容对象会同时放大数据库 metadata 的证据。[snapshot-audit.json](evidence/snapshot-audit.json)

### 4.3 可以得出的体积结论

- 原提示词 25.5 小时/897MB 是旧样本口径；本轮快照覆盖约 29.16 小时时间范围，不能宣称测到了同一采样。
- 本样本“加 GC 就大幅瘦身”不成立：约 19.27MiB 无引用候选只占 catalog 唯一逻辑 CAS 的约 3.8%。仍有引用的累计修订与 recipe 才是重要优化对象。
- `turnOutput.ts:180–230` 的 native item 同时保存 item-only 和 whole-chain-so-far cumulative 内容；这种持续保存前缀的模式存在随链增长放大的机制，但本轮没有拟合增长阶数，不能把全部消息写入直接判为 O(n²)。
- 对六种大类型各取 150 个确定性散列排序样本，zlib-6 后字节比约 0.23–0.56；recipe 约 0.28、message 约 0.56。**这是压缩潜力，不是生产实现收益**：单文件压缩仍有 4K 块开销，CPU/随机读取/大附件样本偏差未覆盖。
- 纯敏感性估算：把当前约 874.37MiB 的 DB+已登记 CAS 实占、29.16 小时负载原样延长，30 天约 **21.1GiB**；五个项目各自持续同等强度约 **105GiB**。不是正常用户增长预测，真实使用时长、共享资源、累计修订非线性和保留策略都会改变结果。不能把五个项目简单理解成必然五倍负载。

### 4.4 项目闭合性：发现与边界

审计覆盖全部 107 领域，其中 96 个有行；检查 164 组物理 FK 和字段内可解析的精确 ID/软引用，共得到 310,504 条非内容图边，未发现连接多个项目的非内容组件。

但：
- 项目分布为 P1=1 个无 Turn 对话，P2=36 个有实际历史对话，缺少多个真实活跃项目的样本。
- 542 条未显式挂 conversation/turn 的 CommandReceipt 包括 process-exit、process-exit-reconcile 和 recovery 来源；需要按来源 codec 追踪，不应随意复制到每个项目或丢弃。
- 空表（例如部分 board 领域）的没有反例不是闭合证明。
- 配置 Agent/WorkEnvironment 引用仍在 Runtime 外；数据库 FK 完整不代表配置引用完整。
- 冻结 JSON 中实际存在 conversationId、turnId、messageRevisionId、toolCallId、contentObjectId 等 ID 字段。改 ID 会改变 CAS bytes、digest、稳定 key 和相关引用；按 FK 排序导入远远不够。
- 现有跨项目拒绝回归证明了受测 API 的权限边界，不覆盖未来所有合法事务。

**结论：B/C 有可行性基础，但还缺“逐领域归属表 + 逐命令事务写集合闭合证明 + CAS codec 引用清单”。**

## 5. 并发、查询和刷新实验

### 5.1 多进程写入

脚本：[concurrency.cjs](experiments/concurrency.cjs)，结果：[concurrency.json](evidence/concurrency.json)。独立合成库使用 WAL/NORMAL/foreign_keys=ON/busy_timeout=5000/BEGIN IMMEDIATE，4KiB hot 行更新与一条 revision 插入。每个进程串行提交，不是完整 107 表 Runtime 压测；负载是闭环，等待后会降低实际到达率。

| 场景 | 成功/尝试 | 成功事务 p99 | 重要现象 |
|---|---:|---:|---|
| 2 写者，写后间隔 20ms | 300/300 | 1.41ms | 无 BUSY |
| 4 写者，写后间隔 20ms | 600/600 | 2.17ms | 最大 18.59ms，无 BUSY |
| 4 写者，每事务人为持锁 5ms，写后间隔 10ms | 400/400 | 108.93ms | 最大 1,135.07ms；尾延迟显著放大 |
| 额外一个 6.2s 长事务，无应用重试 | 156/160 | 1,430.48ms（仅成功） | 4 次 SQLITE_BUSY，各约 5s；不能把成功 p99 当全部请求延迟 |
| 相同长事务，加有界重试 | 160/160 | 6,462.58ms | 最大 6,562.57ms；消除失败不等于交互可接受 |
| 每写者独立库，只有一个库持同样长事务 | 159/160 | 汇总 2.15ms | 受影响库 1 次失败，其余三库零失败，最大各约 1.58–2.15ms |

由此能证明：短事务共享写并非必然失败；长事务会把项目间延迟关联起来；物理分库具有真实隔离价值。不能据此证明生产共享库在任意机器/规模下足够快，也不能断言真实删除已经会持锁 6.2 秒。

### 5.2 WAL 长读

一个持续打开的读事务期间执行 1,800 次 8KiB 写入，WAL 达 30,599,272 bytes。PASSIVE checkpoint 返回 `busy=0, log=7427, checkpointed=2`；关闭读事务后 TRUNCATE，WAL 归零。

**只看 busy=0 会漏报 checkpoint 推进受阻。** 应监控 log/checkpointed 差值和最老读事务，而不是把 WAL 文件大简单归咎于多写者。

### 5.3 历史查询

脚本：[history-query.cjs](experiments/history-query.cjs)。复制真实三张表及现有索引，90% 对话在 P0，其余在四个小项目；15 次热缓存测量。这里只测查询 seed/COUNT，不包含整页 Turn/Message/CAS 投影成本。

| 会话总量/项目 | 分页中位数 | 原 COUNT | 按现有关联索引 COUNT |
|---|---:|---:|---:|
| 20,000 / 大项目 | 0.09ms | 14.44ms | 1.51ms |
| 20,000 / 小项目 | 1.83ms | 15.32ms | 0.10ms |
| 100,000 / 大项目 | 0.09ms | 83.01ms | 15.06ms |
| 100,000 / 小项目 | 1.89ms | 82.21ms | 0.62ms |

原查询计划为全 conversation 覆盖索引扫描 + correlated subquery；新查询使用 `ux_project_context_01(uri)` 与 `ix_conversation_project_link_02(project_context_id)`。本案例无需增索引/改 schema。大项目 COUNT 仍需遍历本项目成员；可以进一步去掉每页精确 total 的强要求或缓存/按相应失效标记更新。

### 5.4 真实跨进程 Feed

脚本：[feed-isolation.cjs](experiments/feed-isolation.cjs)。使用真正的 RootAuthority、RuntimeDatabase、BoundedClientFeed，独立进程作为第二 Host；合成 A/C 属于 P0，B 属于 P1。

A/C 初始各一个 snapshot；B 三次提交后 A/C 又各收到三个 snapshot（合计六个，16,416 bytes）。两个 activeConversationWindow 的前后哈希均不变，失败数为零。[feed-isolation.json](evidence/feed-isolation.json)

这是空正文夹具，不是真实带宽基准。结合代码可以明确判定失效范围过大；不能直接把 16KB 放大比或现存两次 289KB 日志样本外推到所有用户。

## 6. 上游复核及其能说明什么

| 上游/固定版本 | 已直接核实 | 不能据此推出 |
|---|---|---|
| Codex `b412ff32`（0.156 系列） | ThreadStore README:22–28 描述 JSONL 历史和 SQLite metadata；`state/src/runtime.rs:104–109` 明确为减少竞争拆出 logs/history 文件；`rollout/src/writer_lock.rs:17,42–70` 使用每 thread OS 锁；PR #21847 已合并取消破坏式版本升级 | 所有 metadata 都可无损重建；LimCode 也应该把事务事实拆到这些文件；一个用户报告即可证明所有共享 SQLite 不可靠 |
| Codex main `a0b85c7a` | 存在独立 app-server-daemon crate、per-home 状态目录 | 所有部署已经统一 daemon，或扩展 Host 能无成本迁过去 |
| Claude Code 历史 npm 包 | 0.2.100–0.2.109 样本含 better-sqlite3，0.2.113/117 样本不含；目录移动 #1516 closed/not_planned；30 天删除 #62476 是公开投诉 | 从依赖列表确定早期每项 schema/迁移算法或弃用动机；“因原生分发困难”仍属推断。当前闭源实现未逐段逆向 |
| pi `d6af72e1` | session-manager.ts:589–593 按路径有损编码目录；harness.md:371 明确 SQLite 后端默认每会话一库，也支持共享容器 | “使用 SQLite 的产品全部是全局一个库”；#9001 是未接 CLI/AgentSession 的集成问题，closed/not_planned，不代表这一后端不存在 |
| Oh My Pi `04f58a91` | session-storage.ts:221 使用 O_APPEND；:366 发布锁等待 500ms；有独立 SQLite 相关实现 | O_APPEND 自动保证整个高层会话不分叉；关系完整性和重写竞争不用处理 |
| OpenCode V2 `6585bb71` | database.ts:38–42 WAL/NORMAL/5s/PASSIVE；CLI server-connection/service-config 使用共享服务发现，仍有 standalone；V1 导入有每会话事务、游标和 INSERT OR IGNORE | daemon 必然唯一进程、每一发行通道必定同一个 DB；实际 database-path 有通道/环境分支；INSERT OR IGNORE 适合 LimCode 的严格冲突语义 |
| OpenCode issues | #46833 的 8.9GB/7.4GB event 报告和 #37495 WAL 10–15GB 报告确实存在；#47567 锁重试 PR、#49225 新 schema 拒绝旧程序 PR 尚未合并 | 报告中的用户归因已经由维护者完整验证，或者本机可以重现相同故障 |
| VS Code `c1c5b32e` | ChatSessionStore:68–84 以 workspaceId 分区且已有 workspace transition 迁移监听；Chronicle sessionStore:121–130 在 remote 分支使用 DELETE/10s，本地 WAL/3s；#334228 全局历史诉求仍开放 | 按窗口在所有业务场景都“被证伪”；remote Host 必然使用网络盘，或把 journal 改为 DELETE 就能安全支持任意网络 FS |
| Cline / Roo / Continue 固定克隆 | Cline SDK SQLite store:45 是 sessions.db；Roo task-history/index.ts:6–7 为 history_item.json + _index.json；Continue history.ts/paths.ts 是 sessions.json | 所有产品共享 LimCode 的运行权威、恢复、配置关系和原子提交需求 |

上游复核材料包括准确 URL/commit、issue 状态与源码摘录：[upstream-baseline.json](evidence/upstream-baseline.json)、[upstream-excerpts.md](evidence/upstream-excerpts.md)、各 search/detail 证据文件。这里不宣称逐一重现了提示词列出的所有用户故障。

SQLite 官方依据：
- [WAL](https://sqlite.org/wal.html)：同一时刻一个 writer、长读阻碍 checkpoint、跨 ATTACH 数据库不保证整组原子性；WAL 不支持跨主机共享内存的网络文件系统用法。
- [synchronous](https://sqlite.org/pragma.html#pragma_synchronous)：WAL/NORMAL 在正常进程崩溃与整机掉电下的持久性承诺不同；断电可能回滚近期已提交事务。
- [Backup API](https://sqlite.org/backup.html)：一致性备份应使用 SQLite 提供的备份机制，不能把活动 DB/WAL 的普通文件复制当成原子快照。

---

# 第二部分：架构意见与决策建议

以下是基于上述证据的**建议**，不是实验自动给出的唯一答案。

## 7. 推荐：A 为近期主线，旧库只读归档与受控导入先行；D 有条件推进

**不建议现在将所有 Runtime 再拆成按项目库。** 先治理已证实的全库失效、全局计数、运行归属和累计内容问题。保留 B 的进入条件，不能用“行业都合库”排除它。

最关键的理由：
1. 已确认的热点有更直接的修复路径；改写 COUNT 就能使用现有索引，分库不是前置条件。
2. 共享库短事务没有测出必须拆库的门槛，已有正确性保护；现状主要不足是细粒度同步和工作放置，而非缺乏任何并发控制。
3. 体积主要在仍被引用的 CAS 内容，分库不会改变生成这些 bytes 的机制，独立 CAS 甚至可能减少去重。
4. 拆库需要多 Runtime 路由、配置引用、历史聚合、导入和恢复边界的同步改造。有限项目闭合样本不足以证明迁移简单。
5. 旧历史可见性必须先解决，不能再以一次整体搬迁为前置条件。

### 7.1 六方案矩阵

评分为定性 1–5，5 为对当前目标更有利；不是 benchmark 总分，不做没有权重依据的加总。A 是补强后的 A；C 分别标注派生索引与跨权威分片。D 与 A/B/C 正交，不单独承担数据拓扑。

| 维度 | A 共享补强 | B 项目库 | C 全局+分片 | D 共享服务 | E 日志权威 | F 窗口库 |
|---|---|---|---|---|---|---|
| 正确性/单事务 | 5，延续现有边界 | 3，要求事务闭合 | 派生索引4；跨权威1 | 4，不能替代 durable facts | 1，需重建内核 | 3，跨窗口身份不稳 |
| 同项目并发 | 3，仍 SQLite 串行写 | 3，与 A 类似 | 取决于热数据放置 | 4，统一排队但仍串行写 | 2，需会话锁和多对象提交协议 | 2，容易把同项目割裂 |
| 跨项目干扰 | 3，需短事务和公平性 | 5，物理隔离真实有效 | 4，但全局库仍可能热 | 4，可调度，不能增加单库写并行 | 4，会话文件隔离 | 4，窗口间隔离 |
| 刷新/查询 | 4，细粒度失效后 | 4，同项目仍需修 | 4，派生索引有优势 | 5，可精准推送 | 2，需要建索引 | 2，全历史困难 |
| 体积总量 | 3，取决于生成/保留 | 2，不会自动减量 | 3，可隔离冷/热 | 3，与介质无关 | 3，需日志压缩/归档 | 2，不减总量 |
| 独立项目维护 | 2，单库维护仍全根 | 5，是其核心优点 | 4，取决于全局权威 | 3，可协调停机 | 4，文件级隔离较好 | 3，隔离单位不匹配 |
| 身份稳定/重挂 | 4，需 location Link | 4，不能把路径当库 ID | 4，同样需要稳定身份 | 4，独立于存储介质 | 3，需目录与身份解耦 | 1，窗口拓扑变化会切根 |
| 迁移风险/成本 | 4，仍需受控导入 | 2，涉及所有活跃数据 | 2，跨权威更高 | 2，Host 能力拆分工程较大 | 1，基本重建 | 2，恢复旧分法仍要迁移 |
| 全历史/搜索/未绑定 | 5，一个运行事实集合 | 2，需跨库分页/合并 | 5，若全局索引可重建 | 5，统一查询接口 | 3，索引是额外系统 | 1，容易遗漏历史 |
| Desktop/运维 | 4，不要求先拆库 | 3，多根路由要保留 | 4，组件更多 | 5，部署/升级/诊断成本也更高 | 2，偏离现有内核 | 1，不适合作长期边界 |

### 7.2 每个非首选方案的理由与翻转条件

- **B 不作为现在的主线，但不是错误方案。** 项目独立维护是硬要求，或去掉刷新/写入放大后，真实负载仍无法达到锁等待 SLO，且 CPU/I/O 并未饱和、并行分片能实际改善时，重新评估。若是总磁盘 I/O 饱和，分文件不会凭空增加带宽。
- **C 只建议先用于可重建检索/统计。** 运行事实与一次提交必须成立的 Link 留在一个事务介质。全局索引异步更新允许短时过期，但不能决定执行、权限或终态。跨 Runtime 权威的 C 必须引入 outbox/幂等/补偿或分布式事务，已经改变现有可靠内核合同，近期不取。
- **D 不是为了消除一次 BUSY 立即做。** 当多个客户端统一调度、后台继续运行或 Desktop 已成明确产品目标时推进；先证明 capability/交互路由边界。
- **E 不建议。** 追加文件并不自动提供 Turn/Effect/子任务/投递/配置冻结的多对象原子性，恢复与索引回填也是独立系统。JSONL 易追加不是推翻现有内核的充分理由。
- **F 不建议作默认领域存储边界。** 窗口是视图与执行环境组合，不应决定持久项目身份。VS Code 的 transition 迁移说明这种设计可以补救，但仍需不断维护工作区拓扑变化，不适合本项目的长期目标。

## 8. 目标架构与 epoch 影响

### 8.1 保持的存储布局

```text
<dataRoot>/
  settings/ agents/ model-profiles/ work-environments/ ...  独立配置 authority
  .limcode-runtime-selection.json                          当前数据集选择
  <selected Runtime control root>/
    root-binding / pending / durable journals
    active/
      limcode.sqlite                                      Runtime 领域事实与 Link
      cas/sha256/...                                      不可变大内容
      diagnostics/ process spool/control ...
  <existing legacy/workspace data sets>/                   原样保留、只读历史/受控导入来源
```

A 并不要求把每一个旧历史库物理合并才能显示“全部历史”。只读来源可先以 `(sourceDataSetId, conversationId)` 寻址；可重建导航缓存不是另一套会话 authority。不得将 Agent/Workflow/Settings 顺手迁入 Runtime SQLite。

### 8.2 项目身份建议

- ProjectContext/Project 是稳定 ID，不再把当前路径本身当身份；现有哈希 ID 可以作为 opaque ID 保留，不必为了换身份算法重写所有对话。
- 项目位置通过独立 ProjectLocationLink 表达，包含 URI、scheme/remote authority、规范化后的定位键、角色等明确字段；不要统一对所有 URI realpath 或 lowercase。
- 对本地存在路径可记录 realpath 等证据用于发现别名；它不是全平台主键。远程 URI 必须区分 authority。
- 移动/改名：用户确认后修改/新增位置 Link；旧对话仍挂原 projectId。历史重挂不等于修改活动 Turn 冻结的工作环境。
- 同 remote 的多个 clone 默认不自动合并；worktree 保留独立执行位置，可以额外建立仓库分组关系，是否默认共享历史由产品决定。
- 不在活跃协作期间任意改挂 ConversationProjectLink。当前授权依赖它不可变；若开放改挂，需全子树/协作依赖审计、停止执行和事务内断言，不能只换一个 UI 标签。

### 8.3 细粒度失效，而非持久化客户端补丁日志

建议先制定合同：在**同一事实事务**里更新小型、明确的失效 revision；它们只能告诉客户端“需要重查”，不保存可反向恢复领域状态的 ClientState patch。

候选独立事实（最终命名由合同评审决定）：
- ConversationFeedRevision：正文/互动/父子派生变化影响的对话 revision；
- ProjectHistoryRevision：相应历史 scope 的列表变化 revision，含 all/unbound 的明确规则；
- ConversationRuntimeWorkRevision：影响调度/恢复 eligibility 的变化标记，不保存第二套队列。

每个对象必须有独立 schema owner、Repository、codec、mutation/client/delete/reset/index policy。不能改名绕过 `client_change_log` 禁令。

要求：
1. 在 writer transaction 内覆盖修改和删除前的归属、父子派生影响、当前视图所依赖的独立 Link；不是只看 Conversation.updated_at。
2. 删除必须可发现：保留必要的删除标记/失效记录或通过 scope revision 触发对应列表/对话重新确认，不能 FK cascade 后让信号一起消失。
3. 每 Host 合并 data_version 检测与相关 scope revision 读取，避免三条链各自整库收敛。
4. 正文、导航、运行队列分别失效。无关项目提交不重建正文。订阅断开、根切换或无法证明覆盖范围时允许有界重快照，这是当前数据收敛，不是旧协议 fallback。
5. 流式 transient 继续有界合并；durable revision 不能迫使每个 token 都提交。

**epoch：**现有索引上的 COUNT 改写、诊断/轮询整合不需要 schema 变更。上述持久 stamp、ProjectLocationLink、删除 job、import ledger 若落进 Runtime 则需要新的明确 epoch（例如 6）及机器合同更新。当前规则只授权精确已发布 3/4→5；5→6 必须单独拍板、固定来源指纹和夹具，不得发展为开放式版本协商或通用 migration 链。

### 8.4 写入与执行归属

- 建议 BUSY 重试以完整数据库事务为单位，确认 rollback 后再试，重验 RootBinding/owner/fence；仅重放确定性 Repository steps，不重做外部 I/O。
- busy_timeout 与应用重试共用总 deadline。可采用 25/50/100/200ms 上限并加 jitter，正常交互总预算由 SLO 决定；实验里的 10 秒只用于验证恢复，不建议成为默认 UX。
- 对 SQLITE_BUSY_SNAPSHOT 等需新快照/重算断言的错误明确处理；约束错误、schema/binding 漂移、I/O 错误不能归入“再试一下”。
- 不把模型等待、CAS I/O、网络请求放入 SQL 写锁区。合并有界写入，保留公平性，防止一个会话长期占据整个 worker 队列。
- 大删除不能直接分批破坏原子性。若真实删除超过预算，应新增 deletion job/targets：先原子禁止新执行与新引用，再分批清理，再完成删除；读取/恢复/权限均要理解中间态。未设计完成前保留原子删除，必要时放到显式维护模式，不假装“小改循环”就安全。
- 恢复需要 eligibility，不仅是“优先本项目”。建议默认仅自动恢复有明确工作环境能力和交互归属的本项目工作；跨项目后台接管为显式策略。无人合格时标记等待宿主/人工处理，而不是在任意窗口继续。

### 8.5 D 的前提与边界

建议未来是 **per-data-root、同一 OS 实例的服务**，而不是不分根的笼统 per-user。服务负责 SQLite worker、可靠调度和通知；VS Code Host 提供文件/终端/SSH/MCP/diff/审批等 capability adapter。

必须先解决：服务唯一实例和进程指纹、RootBinding fence、认证的本地 IPC、能力注册与断连、审批窗口路由、取消/回执幂等、进程升级、多个扩展版本同时连接、Remote SSH 与 code-server 的根归属、服务崩溃后的 unknown outcome。服务内存不能成为第二套运行 authority；不要移除 effect/lease 防线。

网络边界：SSH Host 的本地 ext4 可用 WAL，并不等于 NFS；如果把同一目录经 NFS 挂到多台机器，既影响 SQLite 也影响 PID/进程指纹的证明。本轮不建议支持这种根布局。不要以换 DELETE 或加 daemon 就宣称任意网络 FS 安全。

### 8.6 若最终选择 B，必须补齐的设计

- 路由键是稳定 projectId，不是 `.code-workspace` 或目录编码；未绑定对话有独立 unbound 数据集。
- 多根窗口通过 Runtime registry 延迟打开各项目数据集；以 `(dataSetId, conversationId)` 寻址命令/Feed，配置主体仍独立。
- 活跃 Turn、未决审批、待回执、待投递及打开面板 pin 对应 Runtime；仅真正空闲后 LRU 关闭。读历史连接有独立有界池。资源上限需测内存/worker/FD 后定，不默认打开所有项目。
- “全部历史”做每库 keyset + k-way merge，游标携带各来源身份/游标与 generation；不能用全局 OFFSET。搜索可做可重建总索引。
- 对话级配置 key 冲突必须按来源 identity 检测，不能因跨库同 id 覆盖。配置仍通过 settings/scope Link 管理，不嵌入项目 DB。
- 每项目维护必须确认共享配置 admission/index 更新不会仍要求全部项目离线；不然承诺的维护隔离只是表面。
- 单个项目多窗口依旧共享其 SQLite，BUSY、Feed、长读、GC 都仍需治理。

## 9. 体积治理、备份和保留

顺序建议：可解释统计 → 写入减量 → 离线保守 GC → 压缩/归档 → 最后考虑在线 GC/pack。

1. **分类统计**：当前对话事实、历史修订、Context/fork 必需内容、恢复/审计、无引用候选、backup pins、spool/诊断、块开销分别显示。已有 runtimeStorageInspection 可扩展，诊断默认不记录正文。
2. **native cumulative 修订**：优先确认哪些只为当前 UI 展示保留。长期以 canonical item 内容生成累计展示，避免每个 item 保存整个前缀；先审计 Context/fork/重放/消息历史引用，不能直接删所有非当前 revision。
3. **recipe**：冻结语义必须保持；静态工具 schema、相同 authority/提示词片段可研究内容寻址复用。不得改为读取“当前设置”而改变历史执行语义。
4. **checkpoint**：保留 tool admission、native control、terminal 等恢复边界；现有首 delta 合并和终态裁剪已存在，继续优化需按语义类型，不能一律关掉持久化。
5. **第一版 GC 离线**：RootAuthority admission + maintenance，证明所有写入/导入/CAS operation 已停止；建立来自活跃 DB、保留备份、历史只读快照和待恢复事实的 mark 集；清单预览；先 quarantine、持久 journal，再最终删除。恢复/取消要可重入。
6. **在线 GC 后续再做**：必须有 pending publish pin、mark generation、写入屏障或安全水位以及 sweep 前重验。单纯“扫 SQL 引用再删”会误删已发布但尚未提交引用的 blob。引用计数也需要处理跨事务失败、旧备份和活跃读者。
7. **按项目删除**：删除的是领域闭合集合，CAS 只能在最后引用/backup pin 消失后回收；不能因某个项目删除就直接删其曾用 hash。
8. **压缩/pack**：hash identity 应仍基于规范的未压缩正文；物理编码/offset/校验映射需正式合同，不能修改当前 sha256 路径的解释却不处理 epoch/RootBinding。先做独立冷归档更可控；若仍一对象一文件，压缩不一定消除块开销。
9. **默认保留**：不默认按 30 天静默删除用户会话/附件。用户明确选择归档/删除；诊断可有界轮转，恢复痕迹按 terminal/backup pins 管理；解释“删除后仍被备份保留”的空间来源。
10. **持久性决策**：若要求断电后保住每个已经确认的事务，应评估 WAL/FULL 的延迟成本，并验证 CAS fsync/目录发布链。NORMAL 对进程崩溃的恢复承诺不能包装成相同的断电保证。本轮未实测 FULL 或断电。

## 10. 旧数据读取、导入/合并、拆分与回滚方案

### 10.1 来源分类

| 来源 | 处理建议 |
|---|---|
| 已知 epoch 3/4，完整已发布指纹 | 保留原根；隔离副本上的精确转换/当前格式只读历史，之后才考虑导入 |
| 已中断 3→4 / 3/4→5 | 先验证原 pointer/pending/journal/备份的完整身份，在隔离副本中模拟/收敛到可认证状态；不能按“缺某张表”猜前驱 |
| 旧 workspace-file/folder/folder-set/empty 库 | scope 名仅是来源标签，不当作目标项目唯一依据；按数据库里的项目 Link、冻结环境与用户确认归位，未知部分留未绑定 |
| 当前/旧选中的 epoch 5 | 精确核验 schema/RootBinding；正常 history snapshot 或受控 terminal 子图导入 |
| 0.0.9 或其它不明格式 | 不因目录名或版本字符串自动迁移；完整识别格式后单独评估只读提取器。当前不扩大生产兼容范围 |
| 自定义数据根 | 通过 getPaths/RootAuthority 登记、验证允许来源；不扫描任意磁盘、不直接改 globalStorage 拼路径 |

### 10.2 优先交付旧库只读可见，而不是直接运行旧 writer

建议引入独立离线转换 actor：输入是严格认证的 source binding/指纹，输出为私有 destination binding 的当前格式只读快照。

步骤：
1. 枚举已知历史来源并固定 source identity，显示版本、大小、状态，不改变当前选择。
2. 在来源许可的 admission/维护边界内用 Backup API 拿一致性 SQLite 副本；校验 source generation 前后未变，处理 pending 状态，不复制活动文件冒充快照。
3. 对受支持前驱复用既有精确 DDL/continuation 转换规则，**不能原样调用会修改源根、pointer 或配置的升级 coordinator**。
4. 需要新 CAS 的转换写入私有目录；旧 CAS 读取要有 source pin，或把该只读快照所需 CAS 完整复制/校验后独立保存。不得转换 SQLite 副本却继续向原 CAS 发布。
5. 当前 schema/fingerprint/quick_check/FK/CAS 校验成功后发布只读句柄；不注册执行 Host，不跑 recoverStartup，不接收变更命令。
6. 失败删除/隔离本次 staging，保留原根与当前活动根；对永久历史缓存的生命周期进行显式管理。

这是一条离线、窄边界的转换工具链，不是在生产 Runtime 同时支持 epoch 4/5 fallback。现有 112 项测试证明当前离线升级和历史防护，不证明这个新 actor 已实现。

用户文案建议：**“将在隔离副本中转换并只读打开此历史库；不会切换当前库，不会修改原文件，也不会继续执行其中的任务。”**

### 10.3 合并的具体算法与安全策略

第一版建议只导入经过验证的已终结闭合子图；有 active Turn、未决外部执行/投递的来源先只读归档。不能把它直接塞进当前库后让启动恢复自动接着执行。

1. **固定来源与目标**：固定 source snapshot hash、schema digest、dataSetId/root identity；目标在受控维护/导入 staging 中，RootAuthority 建立新 binding。配置根操作单独登记，保持不变性和路径权威。
2. **计划完整 closure**：从所选对话集合出发，按每个领域明确的 ownership/reference policy 收集父子、fork、Context DAG、messages/revisions、delivery/inbox、collaboration/board、attachments、effects/process receipts。对软引用和冻结 JSON 使用专用 codec，不按列名猜，也不字符串替换。
3. **特殊无归属事实**：CommandReceipt 等按 source_kind/source_key 的精确映射连接到已知执行事实；无法解释的保留在源只读库并阻止宣称“完整运行导入”，不静默丢弃，也不复制到所有项目。
4. **ID 冲突**：无冲突保持原 ID；相同 ContentObject 以 type/hash/length 严格核验后去重；普通事实同 ID 且规范内容完全一致才可视为已导入。不同内容同 ID，整个闭合批次拒绝并给出冲突清单。**第一版不自动 UUID 重编号、不 INSERT OR IGNORE 掩盖差异。** 若以后支持重编号，必须先完成所有稳定 ID、source key、CAS envelope、配置 scope 引用的 typed remap，再重算内容 hash；否则不可交付。
5. **ProjectContext 合并**：精确相同的现行规范身份可共用；路径相同不证明跨数据集一定是同一项目，尤其目录被复用时，需用户确认 alias 映射；只改展示名称不能偷偷改变身份或执行 cwd。
6. **CAS**：按物理 sha256 文件去重，核验长度与 hash，先 durable publish 再提交引用；不同 content type 的 ContentObject 可共用物理文件，但保留独立元数据身份。不把文件已存在当成内容可信。
7. **插入顺序**：按领域依赖拓扑分层；有环的合法关系按既有受控创建/Link 阶段解决，必要的延迟 FK 只能在明确的导入事务合同内使用。不能在生产 Runtime 提供任意 SQL batch 或永久关闭 FK。schema_manifest/root_binding 由目标 authority 生成，不从来源覆盖。
8. **幂等与断点续跑**：为 import job、source mapping、batch receipt 明确独立领域/metadata 合同；批次 receipt 与领域插入在同一事务提交。恢复先核验同一 source hash，再查 receipt；已提交批次验证内容，未提交批次重做。配置变更如果必须跨文件，使用独立 durable journal，目标尚未激活前完成，避免“DB 完成、配置丢一半”。
9. **批次单位**：只选已证明闭合的组件，不机械按 N 行切。一个大型 Context/协作闭合组件可能很大；可在不可见 staging 中分段加载，但必须完成整个组件校验才对运行端发布。
10. **最终校验和发布**：逐领域行数/规范摘要、FK、软引用、CAS、消息序列/current revision、Context head、子任务/投递关联、项目范围、配置引用、无未认证 runnable work。再用 durable journal 原子切目标 pointer；旧源保留。

测试夹具必须覆盖：重复导入、同 ID 同内容/不同内容、共享 CAS 多类型、source_key/冻结 JSON 引用、源文件变更、磁盘满、每个 journal 边界崩溃、跨项目引用、fork/子树、active/unknown effect、配置 scope 冲突、WAL-only 提交、未知 schema/pending。**本轮没有声称完整合并器或所有这些新夹具已经实现。**

### 10.4 如果拆库

用同一份 closure plan，按 projectId 路由到独立 staging roots；共享内容复制/校验到各自 CAS，或另立全局 CAS authority 和引用合同（二者不能混着用）。全局无归属事实要有明确归位策略。完成各片和总 catalog 对账后才原子发布路由；多目标文件没有天然原子事务，需要 durable publication journal，客户端只接受完整 generation。

失败时原根不动；发布后不自动切回旧 writer，应向前恢复。部分分片完成不能让一半对话已迁、一半仍由旧 writer 执行。

### 10.5 回滚、空间峰值与用户提示

- 不设计运行时降级写入。回滚是使用保留的完整原根/备份在独立恢复位置检查，而不是把新表删掉冒充旧 schema。
- DB 备份、staging DB、活跃 DB 可能同时存在；CAS 复制取决于是否共享不可变源和独立保存。操作前按实际字节预估峰值、留 WAL/临时文件余量，不能只按最终库大小检查磁盘。
- 升级激活前失败可丢弃 staging；激活后按 journal 向前收敛，不自动恢复旧 writer。
- 文案：**“旧库仍保留。当前操作不会合并或删除其他来源；查看历史无需把它设为当前运行库。退回旧版可能选择不同的数据集，请先保留备份，不要让旧版直接写入唯一的新格式数据。”**

## 11. 分阶段路线图、成本与验收

成本是单维护者粗量级，不是工期承诺；可能因历史 fixture、UI 和跨平台验证显著增加。

| 阶段 | 目标与模块 | 主要验收/新增测试 | 量级与独立发布 |
|---|---|---|---|
| P0a 可观测与低风险查询 | clientProjection、ExternalDataVersionWatcher、runtimeStorageInspection、diagnostics；按现有关联索引 COUNT、避免无意义精确 total/重复扫描 | 与旧 SQL 计数一致；all/project/unbound/删除/分页游标；查询计划回归；无正文诊断 | 数日～1周；可独立发布，不改 schema |
| P0b 旧库可读 | runtimeDataSetHistory、runtimeEpochMigration 的纯转换边界、RootAuthority、dataset management UI | epoch3/4 源文件 hash 不变；私有 CAS 写入；当前库不停用；缺失/漂移/pending/WAL/取消均 fail closed | 1～3周；可独立发布，复用前驱合同但需要新增历史工具合同 |
| P0c 写入失败/执行放置 | runtimeDatabase/databaseWorker、Runner、ProductRuntime、interactionAttention/ToolHost | 限定 BUSY 重试、预算/取消、无外部 effect 重放、过期 fence 拒绝；无资格 Host 不接管；审批路由正确 | 1～2周，政策变化需维护者确认 |
| P1 精细失效 | 三类 revision 合同、worker change capture、clientFeed/clientProjection、收敛扫描 | 不相关项目 100 次提交不重发正文；父子/删除/导航仍正确；通知丢失/重连/崩溃后收敛；Root generation 切换 | 2～4周；若增持久结构，作为一次明确 epoch 发布 |
| P2a 体积减量 | turnOutput/nativeRequestSession、modelProviderControlPlane、Context/Message projection、CAS统计 | 不再为仅展示的累计前缀重复长期保存；Context/fork/native恢复/最终输出等价；不同链长度的 bytes/request 曲线 | 2～4周，是否改 schema/codec 取决于设计，不能暗改 |
| P2b 离线 GC/归档 | contentAddressedStore、RootAuthority、runtimeStorageInspection、backup/journal、设置页 | 预览与删除一致；backup/active reader/publish pins 不误删；崩溃/磁盘满可恢复；schema/CAS 校验无损 | 2～4周；明确回收合同后独立发布 |
| P3 受控导入 | 独立 import actor、每领域 mapping、配置 scope mapping、staging/pointer | 上述完整迁移夹具、冲突 fail closed、幂等和断点；不意外执行旧任务 | 3～6周或更长，取决于是否支持冲突重编号 |
| P4 D/B/C 决策 | capability transport、daemon/Runtime registry 或派生搜索索引 | 先用真实多窗口/大对话/慢盘验收判断是否需要；Windows/Remote/升级/能力断连验证 | D 或 B 均通常数周以上，不与前几阶段混成一次发布 |

建议 SLO（**待维护者确认，不是本次已达到的产品指标**）：
- 目标 4 Host 常规混合负载下，数据库交互提交 p95<100ms、p99<300ms，超时有明确可恢复错误；长维护操作单列预算。
- 无关项目变化不产生正文 snapshot；有关变更在轮询/合并预算内可见，候选端到端目标 ≤2.5s。
- snapshot/changes 字节数、worker 排队时间、锁等待、最老读事务、WAL 未 checkpoint 页、CAS publish/fsync、每请求累计 bytes 都可观测。
- 先在本地 Linux/Windows/macOS 复现实验，再对慢盘/杀毒环境验证；网络 FS 不在隐式支持范围。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 版本/安装构建与源码混用 | 固定 commit/VSIX hash/dirty provenance；不按 package 字符串推 schema |
| BUSY 重试掩盖长锁和饥饿 | 总预算、取消、错误分类、锁等待诊断；不重放外部 effect |
| 同步 revision 漏标导致永久旧视图 | 逐领域/派生依赖覆盖、删除失效、断线重查、跨进程随机化测试 |
| 分批删除破坏原子语义 | 显式 job/targets 与禁止新工作阶段，或先保持维护模式下单事务 |
| GC 误删 pending publication/备份内容 | 离线先行；所有 retention roots；quarantine+journal；在线版本另行设计 |
| URI alias 错误合并项目 | 稳定 ID 与位置解耦、保留 remote authority、显式确认 clone/worktree 规则 |
| 导入改 ID 破坏 frozen recipe/source key | 第一版冲突拒绝；后续必须 typed remap 和重新摘要，禁止全局字符串替换 |
| daemon 引入第二套 authority 或审批错窗 | SQLite facts 唯一权威；独立能力注册、明确 UI ownership、认证 IPC |
| 旧二进制忽略新 root selector | 原根隔离、完整备份、恢复到独立位置；不能仅依赖新 marker |
| 实验外推过度 | 合成闭环负载/热缓存/样本偏斜逐项披露，真实 SLO 再验证 |

## 13. 需要维护者拍板的事项

1. 是否把“项目可独立升级/备份/停机，其他项目完全不停”列为硬要求？若是，B/C 权重明显提高。
2. 是否允许 A 窗口自动继续执行 B 项目的任务？审批/提问应由谁承接？缺乏合格 Host 时等待还是提示？
3. 项目移动/clone/worktree 的身份规则，是否允许对话改挂项目，以及相应权限变化。
4. 是否接受一次明确的 epoch 6，用于精细失效/身份等必要结构；支持哪些已发布来源的精确离线转换。
5. 历史保留目标：用户内容是否默认永久；哪些诊断/中间累计投影允许清理；备份默认保留多久。
6. 已确认提交的断电持久性目标：NORMAL 还是评估 FULL。
7. 第一版导入是否接受“冲突拒绝、活动工作只读归档”的安全边界，还是愿意投入完整 typed remap/执行恢复迁移。
8. 是否明确不支持网络文件系统、多机共享同一 Runtime 根。
9. Desktop/后台服务是否已有明确排期，否则 D 不应挤占旧历史与存储治理工作。

## 14. 给反馈用户的短回复（200字以内）

你的担心是合理的。共享库已有对话级并发保护，但跨窗口刷新范围过大、旧库访问不便和空间回收不足确实存在。旧库文件没有被合并或删除，不代表历史已经方便可用。我们会先补齐旧历史读取、精细刷新和体积治理，再依据多窗口实测决定是否分库；任何迁移都会保留原库并严格校验，不再仅靠切换存储位置解决问题。

---

## 15. 最终意见

**现在不做第二次全面拆库迁移。近期采用 A，先把旧历史可访问、查询/刷新范围、执行资格和内容生命周期做正确；D 随明确的多客户端/Desktop 需求推进。**

这不是因为 B 没有效果：实验已经证明它能隔离长事务对其他项目的影响。只是目前证据显示，最急迫的问题多数不是通过改变文件数量解决的；而拆库所需的完整引用/事务边界和迁移工具尚未建立。

如果完成补强后，真实目标负载仍因单库写锁无法达标，或者独立项目维护成为硬要求，就应转向稳定 projectId 下的 B/C，而不是无限叠加重试和轮询。这是本建议明确的翻转条件。

### 可复现实验与未完成项

- 已完成：一致性备份、107 领域关系审计、77,254 CAS 文件完整性校验、真实双进程 Feed、SQLite 写竞争/分库/WAL、2万/10万查询计划、112 项定向回归、关键发布物和上游复核。
- 未完成/不声称完成：全量测试最终通过；Windows/macOS/NFS/杀毒慢盘；断电/fault injection；多真实活跃项目长期容量测试；完整新导入/拆分/GC/daemon 实现；提示词所有上游 issue 的逐个故障重现。
- 本次研究脚本开发中的失败/修正不作为实验结论；上述表格来自成功完整运行的 JSON 结果。所有脚本、日志、版本与摘要均保留在本研究目录，未执行针对原运行 SQLite/CAS 的修改、迁移或清理；正常会话仍会产生自己的运行记录。

## 附录：固定版本上游源码链接

- [codex/repo-156 / codex-rs/state/src/runtime.rs:104](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/state/src/runtime.rs#L104)
- [codex/repo-156 / codex-rs/rollout/src/writer_lock.rs:42](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/rollout/src/writer_lock.rs#L42)
- [pi/upstream / packages/coding-agent/src/core/session-manager.ts:589](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/src/core/session-manager.ts#L589)
- [pi/upstream / packages/agent/docs/harness.md:371](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/agent/docs/harness.md#L371)
- [pi/omp / packages/coding-agent/src/session/session-storage.ts:366](https://github.com/can1357/oh-my-pi/blob/04f58a91d141bb0e7c5f7679c2235945ae813057/packages/coding-agent/src/session/session-storage.ts#L366)
- [opencode/v2 / packages/core/src/database/v1-migration.bun.ts:586](https://github.com/anomalyco/opencode/blob/6585bb710567fd424dcecbf32389c2391f0165fc/packages/core/src/database/v1-migration.bun.ts#L586)
- [opencode/v2 / packages/cli/src/services/server-connection.ts:21](https://github.com/anomalyco/opencode/blob/6585bb710567fd424dcecbf32389c2391f0165fc/packages/cli/src/services/server-connection.ts#L21)
- [opencode/v2 / packages/core/src/database/database.ts:31](https://github.com/anomalyco/opencode/blob/6585bb710567fd424dcecbf32389c2391f0165fc/packages/core/src/database/database.ts#L31)
- [vscode-ext/vscode / src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts:68](https://github.com/microsoft/vscode/blob/c1c5b32e3fd5a2f3922ea20d7d65055b8b4c47e2/src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts#L68)
- [vscode-ext/vscode / extensions/copilot/src/platform/chronicle/node/sessionStore.ts:119](https://github.com/microsoft/vscode/blob/c1c5b32e3fd5a2f3922ea20d7d65055b8b4c47e2/extensions/copilot/src/platform/chronicle/node/sessionStore.ts#L119)
- [vscode-ext/cline / sdk/packages/core/src/services/storage/sqlite-session-store.ts:45](https://github.com/cline/cline/blob/e369614d1a62f4e3d2f9de7de1d6699f9385423b/sdk/packages/core/src/services/storage/sqlite-session-store.ts#L45)
- [vscode-ext/Roo-Code / packages/core/src/task-history/index.ts:6](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/packages/core/src/task-history/index.ts#L6)
- [vscode-ext/continue / core/util/paths.ts:107](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/util/paths.ts#L107)
