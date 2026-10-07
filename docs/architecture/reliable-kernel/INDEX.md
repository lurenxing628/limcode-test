# 可靠运行内核文档索引

> 当前机器合同：`2026-07-31-r4`。`PLAN-CLOSURE-HANDOFF.md` 保留为本轮执行前的证据记录，不代表 r4 当前缺口。


## 先读

1. [项目背景](./BACKGROUND.md)
2. [总计划](./README.md)
3. [计划收口交接（r4 执行前历史核验记录）](./PLAN-CLOSURE-HANDOFF.md)
4. [计划章程](./00-program-charter.md)
5. [不变量与权威](./01-invariants-and-authority.md)
6. [工作流与三个出口](./02-workflow-and-gates.md)
7. [七阶段实施索引](./appendices/implementation-stage-index.md)

## 七个实施阶段

| 阶段 | 文件 |
|---|---|
| A | [背景、行为底线与迁移边界](./phases/phase-a-baseline-and-boundary.md) |
| B | [SQLite 与 CAS 地基](./phases/phase-b-sqlite-cas-foundation.md) |
| C | [Turn 核心控制面](./phases/phase-c-turn-control-plane.md) |
| D | [Effect、工具、文件与进程](./phases/phase-d-effects-tools-files-processes.md) |
| E | [ContextSequence、压缩与 Provider 完整请求](./phases/phase-e-context-provider.md) |
| F | [Subagent、RuntimeDelivery 与有界客户端](./phases/phase-f-subagent-client.md) |
| G | [硬切、清理与真实安装](./phases/phase-g-hard-cut-release.md) |

## 机器合同

- [合同说明](./contracts/README.md)
- [领域权威](./contracts/authority.json)
- [身份、序号与连接边界](./contracts/identity.json)
- [SQLite 迁移](./contracts/migration.json)
- [过渡路径](./contracts/transition-ledger.json)
- [本机目标](./contracts/targets.json)
- [工具与外部作用](./contracts/tool.json)
- [文件能力](./contracts/file.json)
- [上下文与 Provider](./contracts/context.json)
- [子代理与异步交付](./contracts/subagent.json)
- [客户端同步](./contracts/client-feed.json)
- [三个出口](./contracts/gate-registry.json)

## 人读附录

- [模型、工具调度与工具执行性能画像（生产历史 + 当前受控基准，非机器合同）](./TOOL-MODEL-PERFORMANCE-PROFILE.md)
- [工具调度器与执行器性能优化方案（本机源码研究，非机器合同）](./TOOL-SCHEDULER-EXECUTOR-OPTIMIZATION.md)
- [每个数据目录只保留一个历史库（分期方案，非机器合同）](./one-history-library-plan.md)
- [性能与打包边界](./appendices/performance-and-packaging-gates.md)
- [可靠 Runtime 有界诊断](./appendices/runtime-diagnostics.md)
- [术语](./appendices/terminology.md)

## 旧文档去向（legacy docs disposition）

可靠运行内核计划之外，`docs/` 下六份旧文档按以下口径处置，每份文件头部已加对应的降级说明：

| 旧文档 | 处置 | 说明 |
|---|---|---|
| [docs/conversation-turn-control-plane.md](../../conversation-turn-control-plane.md) | superseded-by reliable-kernel | 被本计划取代；阶段 G 完成后转为历史记录 |
| [docs/conversation-storage-authority.md](../../conversation-storage-authority.md) | keep-as-history | 描述当前文件后端实现；对应能力切换后转历史，文首已含过渡句 |
| [docs/model-context-projection.md](../../model-context-projection.md) | keep-as-history | 描述现状上下文投影实现，切换后转历史 |
| [docs/background-process-reliability.md](../../background-process-reliability.md) | keep-as-history | 描述现状后台进程可靠性实现，切换后转历史 |
| [docs/global-settings-data-integration.md](../../global-settings-data-integration.md) | 保留 | settings 子系统长期规范，不属于运行内核替换范围 |
| [docs/ws-streaming-codex-kimi-research.md](../../ws-streaming-codex-kimi-research.md) | keep-as-history | WebSocket 流式研究存档 |

## 出口对抗自查（reviews/）

每个出口完成标准包含一次对抗自查：列出「本期最容易说谎的 5 个状态」和「最可能写出巨型文件的 3 个位置」，结论归档在本目录的 `reviews/` 子目录（按出口命名），作为后续出口的核对输入。

当前计划只保留七个实施阶段、三个正式出口和四组直接校验器。机器合同额外冻结 physical migration manifest、六个 recovery ID、detached process wrapper、无总量截断的keyset输出登记与可续页面、Provider `disabled-full-request`、capability disposition、atomic gate IDs 与 9 个 installed smoke；人读文档只解释边界和实施顺序，不另立权威。
