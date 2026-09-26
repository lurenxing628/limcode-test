# B / D 的收益与业界存储、服务架构对照

来源核对日期：2026-09-26。本文补充本轮业界研究与决策，原始实验见 [研究报告](report.md)，交付顺序见 [实施计划](implementation-plan.md)。

本文使用本轮已阅读的官方文档、公开源码和官方 SDK 发布物；没有重跑各产品的并发实验，也没有验证所有发行版本的实际默认行为。公开分支、预览功能和默认 CLI 分别标明。

证据口径：**官方说明**指文档或作者代码明确表达的事实、用途；**推断**指根据机制判断的收益；**未知**指公开材料没有回答的问题。目录分组、JSONL 文件、数据库分片和执行进程是不同层面。

## 1. B 与 D 分别解决什么

**B 按项目拆分持久运行数据，D 把运行内核放进共享服务。两者可以组合，也都可以与独立配置 roots、CAS 和派生搜索索引并存。**

| 维度 | B：按稳定项目 ID 分库 | D：每数据根一个共享服务 |
|---|---|---|
| 最直接收益 | 一个项目的长事务不会占住其他项目数据库的写锁 | 多个客户端复用运行内核、调度和事件入口 |
| 生命周期 | 可以分别备份、恢复、归档和维护项目 | 任务生命周期可以独立于窗口和终端，前提是能力也能持续提供 |
| 性能潜力 | 不同库可以并行写；减少单次项目查询、维护的数据范围 | 合并轮询、连接和重复初始化，集中排队与推送 |
| 故障范围 | 单库锁等待、部分损坏和维护可限制在对应项目 | 服务故障可能同时影响其管理的所有客户端与项目 |
| 主要代价 | 跨库历史分页、引用闭合、配置关联、多 Runtime 资源与迁移发布 | 服务发现、认证 IPC、升级、重连、能力注册、审批路由和运行恢复 |
| 没有自动解决的事 | 同项目并发、重复内容生成、CAS 保留与 GC、全局资源饱和 | SQLite 单库串行写、内容增长、事务原子性与持久性 |

B 的锁隔离收益有本项目 [长事务分库对照](evidence/concurrency.json) 支持；不能由合成实验直接推出生产扩展的吞吐上限。D 的收益是架构判断，尚无本项目实现或对照测试。

SQLite WAL 同时只有一个 writer。D 可以改变调度和等待方式；要让不同项目的数据库写入独立并行，仍需 B 等持久化分区。[SQLite WAL 官方说明](https://sqlite.org/wal.html)

| 组合 | 适合的目标 |
|---|---|
| A + 各 Host 直接运行 | 在现有共享库上尽快修复查询、刷新和执行归属 |
| A + D | 保持单库事务边界，同时提供后台运行和多客户端 |
| B + 各 Host 运行 | 优先获得项目维护与写锁隔离，但仍需跨 Host 协调 |
| B + D | 服务统一管理客户端，各项目独立持久化；工程与运维面也最大 |

B 的维护独立性必须覆盖共享配置和 CAS authority；若任一项目升级仍要求全部配置根停机，实际收益会低于表中目标。D 中的内存状态也不能取代 SQLite 已提交事实。

## 2. 五家产品的可证事实

| 产品与范围 | 会话存储形态 | 执行与服务形态 | 能借鉴的方向 |
|---|---|---|---|
| Codex：本地 thread / App Server 文档 | 每 thread JSONL；另有 SQLite metadata | 统一 App Server 接口；显式 remote-control 可启动本地 daemon | 会话记录与索引职责分开，多个产品复用同一运行内核 |
| Claude Code：CLI 与 Agent View 预览 | CLI 每会话 JSONL，按项目目录组织 | 普通交互 CLI 绑定终端；Agent View supervisor 管理各会话进程 | 会话数据隔离与后台进程管理可以分别演进 |
| Oh My Pi：默认文件后端 | 每会话 JSONL，按 cwd 分桶；共享 blobs；独立 history.db | SDK 嵌入，RPC 通过 stdio 接入 | 追加会话树、回放和独立搜索；不要求默认共享服务 |
| OpenCode：V1 / V2 分别核对 | V2 CLI 默认使用用户数据目录中的共享 SQLite，可按 channel/环境覆盖 | V1 是客户端/服务端；V2 明确默认共享后台服务 | A + D 的直接参考，但不能抹去版本和部署边界 |
| Factory Droid：公开 CLI/SDK 接口 | 官方 SDK 可枚举本地按 cwd 组织的 JSONL；内部完整 schema 未公开 | SDK 子进程或 daemon；长存 RPC；自有机器远程 daemon | 嵌入、后台执行和远程接入可复用同一协议 |

上表依据与限制见以下各节。**没有哪一行能直接证明“这些产品都使用每项目一个 SQLite”，也不能仅凭存在 server 就认定所有 CLI 默认连接共享 daemon。**

## 3. Codex：会话日志与统一运行接口

官方 App Server 文档的 `thread/archive` 描述每 thread JSONL，`thread/metadata/update` 涉及 SQLite metadata；这证明本地会话记录与元数据具有不同存储职责。该证据不证明所有 SQLite 内容都能从 JSONL 无损重建。[App Server 文档](https://learn.chatgpt.com/docs/app-server)

App Server 提供 stdio、WebSocket、Unix socket 等接入方式；相关开发命令和 WebSocket 使用带有实验性标记，不能把接口存在推导成所有产品已经使用相同常驻进程。[App Server 接口与传输](https://learn.chatgpt.com/docs/app-server)

`codex remote-control start` 明确启用本地 App Server daemon。它是可核实的共享服务使用路径，不能据此断言所有普通 CLI 启动都默认进入 daemon。[开发命令：Remote Control](https://learn.chatgpt.com/docs/developer-commands#codex-remote-control)

**官方动机：**让 App、CLI、IDE 和外部产品复用同一套运行内核及其上下文、工具、沙箱与审批能力。[Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)

**对 LimCode 的推断：**D 的主要价值在统一执行生命周期与产品接口；JSONL 的会话分隔另有职责。不能以此跳过 LimCode 的多领域原子事务与 effect 恢复设计。

## 4. Claude Code：本地会话与后台 supervisor 分开看

CLI 官方文档明确 transcript 存放在 `~/.claude/projects/<project>/<session>.jsonl`。这里的项目目录是会话文件的组织方式，不能称作“每项目数据库”。[会话存放位置](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)

**官方用途：**恢复、分支和切换已有任务。按项目定位本地会话与这些操作吻合；但这没有直接证明作者是为避免 SQLite 写竞争才选择 JSONL。[Sessions](https://code.claude.com/docs/en/sessions)

Agent View 的 supervisor 为会话管理独立进程，支持脱离终端的后台运行以及空闲回收、恢复；文档将 Agent View 标为 **research preview**。普通 `claude` 交互会话仍应按其终端生命周期理解。[Agent View：supervisor](https://code.claude.com/docs/en/agent-view#the-supervisor-process)

**对 LimCode 的推断：**运行进程集中管理与会话文件分隔可以组合；后台服务不要求把所有会话内容合成一个文件。该预览也不能作为所有 Claude Code 安装默认行为的证明。

**未知：**闭源部分的完整数据库、跨客户端提交协调和各产品历史同步内部机制。本文的路径结论只覆盖已记录的 CLI transcript，不统一推断 Web、Desktop 或其他产品。

## 5. Oh My Pi：会话树日志、搜索库与嵌入式接口

核对固定提交 `7853b4e499936f9dcc13c9b64adb55f6b342aabf`。默认每会话一个 JSONL，位于 `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`；blob 位于共享 `~/.omp/agent/blobs/<sha256>`。[session.md:35](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/session.md#L35)

**官方设计用途：**条目用 `id/parentId` 表达会话树；导航分支移动 leaf，保留已有条目；上下文沿选中路径重建。这解释了追加记录与分支、回放之间的关系。[会话树说明:7](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/session-tree-plan.md#L7)

`history.db` 使用 FTS5 做 prompt 回忆与搜索，不负责会话回放；约 100ms 批量写入的明确目的是避免 prompt 捕获阻塞 turn。[history.db 职责:549](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/session.md#L549)

SDK 直接嵌入会话；官方建议跨语言或需要进程隔离时使用 RPC。RPC 通过 stdio 工作，Python 客户端默认启动 `omp --mode rpc` 子进程。这是接口复用的证据，不能称默认共享 daemon。[SDK:1](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/sdk.md#L1)、[RPC:967](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/rpc.md#L967)

JSONL 仍需并发保护：源码有跨进程发布锁，避免重写覆盖另一个终端的追加，等待上限 500ms。默认文件后端还明确没有 `fsync`，不能与更强的断电持久性合同等价。[发布锁:342](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/packages/coding-agent/src/session/session-storage.ts#L342)、[持久性边界:482](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/session.md#L482)

**边界：**还存在可选 SQL/Redis 后端，SQL adapter 包含 SQLite/Postgres/MySQL。本文描述的是默认文件路径；没有找到“因全局 SQLite 不可靠而采用 JSONL”的作者声明。[SQL adapter:14](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/packages/coding-agent/src/session/sql-session-storage.ts#L14)

## 6. OpenCode：V2 是共享库与共享服务的参考

V1 官方文档说 TUI 启动时同时启动 server，另运行 `serve` 会启动一个新 server；**官方动机**是支持多客户端与程序化操作。这足以证明客户端/服务端设计，不能证明默认只有一个服务进程。[V1：How it works](https://opencode.ai/docs/server/#how-it-works)

V2 官方文档明确默认发现或启动当前用户共享后台 server，由它管理会话、配置、集成、权限与工具执行；同时提供 `--standalone` 和 `--server`。[V2：Background service](https://opencode.ai/v2/docs/cli#background-service)

固定 `v2` 提交 `39021dfd671e4ed379283202a3fc281dfec76a8a` 的 CLI 路径选择以数据目录、channel、`OPENCODE_DB` 为输入，没有按项目 ID 选库。常用 channel 默认 `opencode.db`，其他 channel 可用独立文件，也可覆盖路径或使用 `:memory:`。[database-path.ts:4](https://github.com/anomalyco/opencode/blob/39021dfd671e4ed379283202a3fc281dfec76a8a/packages/cli/src/database-path.ts#L4)

本地数据库仍使用 WAL/NORMAL/5000ms busy timeout。共享服务没有消除 SQLite 自身的串行写与等待治理；服务注册也有 channel 边界。[database.ts:31](https://github.com/anomalyco/opencode/blob/39021dfd671e4ed379283202a3fc281dfec76a8a/packages/core/src/database/database.ts#L31)、[service-config.ts:29](https://github.com/anomalyco/opencode/blob/39021dfd671e4ed379283202a3fc281dfec76a8a/packages/cli/src/services/service-config.ts#L29)

**对 LimCode 的推断：**A + D 可以统一状态入口、客户端订阅和运行生命周期。V2 文档与分支不代表每一安装版本、发行 channel 或云端部署都已经使用同一个本地库。

## 7. Factory Droid：本地会话、RPC 与远程执行

官方 TypeScript SDK 支持启动子进程或连接 daemon；`list-saved-sessions` 可直接枚举本地保存会话，默认按 cwd，而不调用运行中的 API。[TypeScript SDK](https://docs.factory.ai/sdk/typescript)

本轮核对官方 `@factory/droid-sdk@0.9.1` 发布包，`dist/node.mjs:4228–4253` 扫描 `~/.factory/sessions/<sanitized-cwd>/*.jsonl`。这证明该版本 SDK 支持的本地会话文件布局，不证明 Droid 内部没有其他数据库或全部事实都在 JSONL。[官方 SDK 发布包](https://registry.npmjs.org/@factory/droid-sdk/-/droid-sdk-0.9.1.tgz)

**官方动机：**长期存活的 stdio 双向 JSON-RPC 子进程可供 Web、Desktop、IDE、CI 和自定义编排使用。它体现界面与 agent 的解耦，不能单凭此认定普通 CLI 默认共享同一个 daemon。[Droid Exec：自定义 RPC 流程](https://docs.factory.ai/droid-exec/overview#build-custom-flows-on-raw-json-rpc)

Cloud Session Sync 是把 CLI 会话镜像到 Web 的可配置功能，文档默认值为 true；它不等同于多台机器共同写一个 Runtime 根。[云会话同步](https://docs.factory.ai/droid-cli/settings#cloud-session-sync)

BYOM 的 `droid daemon --remote-access` 通过 relay 接入用户自己的机器；**官方用途**是复用机器上已有环境。远程接入并不能证明执行或所有存储已迁移到云端。[Bring Your Own Machine](https://docs.factory.ai/droid-computers/byom)

**未知：**闭源内部的完整事务模型、落盘 schema 和同步冲突处理。可借鉴接口与生命周期，不能替 Factory 补写未公开的存储设计动机。

## 8. 本项目当前采用的顺序

**本轮最高优先级：恢复已发布 epoch 3/4 旧数据可用性，自动备份并原位升级，无需用户点击升级或确认。** 详细历史证据见 [恢复审计](epoch3-4-recovery-audit.md)；当前实现和最终验收进行中。

1. 复用已有精确 epoch 3/4→5 迁移器，保留 SQLite 备份和原有 CAS。当前选中旧库沿用启动时自动升级；当前 Runtime 正常打开后串行处理其它旧库，查看旧历史时自动补做。隔离单库异常，避免一个坏 scope 阻断全部历史。
2. 历史恢复后补必要性能诊断，并行修复历史计数和重复轮询；继续处理恢复资格、审批/提问/diff 归属与有界等锁。
3. 独立交付跨 Host 精细失效与项目分页稳定性；涉及 schema 的部分按明确 epoch 和发布合同实施，不能把 COUNT 或旧库升级当作刷新问题已解决。
4. 审计并减少累计内容的新增写入，再做有完整引用依据的离线 GC；既有历史修订不能直接当垃圾删除。

自动升级修改旧库格式，保留升级前备份；它不自动合并多个旧库、切换当前库或运行非当前旧任务。多个候选之间仍按既有规则显式选择当前数据集，不自动 fallback。来源字节不变的隔离转换、移动或归档备份的重新绑定恢复属于后续独立工作。

这些工作多数在未来 B 或 D 中仍然需要，因此先做有复用价值的修复；完整导入器、全部 GC/压缩、项目身份重构都不是客户问题修复的总前置关卡。

**A 也不是进入 B / D 前必须全部做完的关卡。** 项目独立维护一旦成为硬要求，或实测及分片对照证明共享写锁是主要限制，立即进入 B 的闭合性与迁移设计；后台运行、Desktop 或多客户端进入明确排期时即可推进 D。

每轮只为待解决问题补必要观测与验收。B / D 的进入条件与当前 A 修复并行评估；选型依据是 LimCode 的可靠性合同、客户需求与实测，不是其他产品采用了某种文件格式。
