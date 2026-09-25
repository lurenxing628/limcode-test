# 机器合同说明

> 基础合同修订：`2026-07-31-r4`；Client Feed 合同 `client-feed.json`：`2026-09-25-r3`；子 Agent 合同 `subagent.json`：`2026-09-25-r7`。校验器逐文件固定核验，不进行运行时版本协商。

本目录保存可由脚本直接检查的计划底线。Markdown 解释“为什么”，JSON 限制“不能悄悄变成什么”；Runtime 不使用这些 revision 做版本协商、旧格式 fallback 或 migration chain。

## 合同清单

- `authority.json`：Runtime exact domain set、configuration crosswalk、capability disposition；
- `identity.json`：Turn、Effect、Delivery、stream、RootBinding 与 recovery identity；
- `tool.json`：Tool/Effect、六个 recovery ID、detached process wrapper/output bounds、MCP Effect；
- `file.json`：FileChangeSet、approval、actual mutation 与 receipt；
- `context.json`：source-occurrence Context DAG、HeadLink、compression replacement、Provider `disabled-full-request`；
- `subagent.json`：ChildExecution lineage、required interrupt_subtree、Answer/Delivery/InputLink；
- `client-feed.json`：bounded snapshot/changes/queue、commitSeq barrier、pagination；普通记录维持 2 KiB 摘要，ModelRequest 计量单独投影为最多 32 KiB 的结构化事实（原生最多 8 个最近 response），不得按文本截断 usage/timing；
- `migration.json`：71 个 registered roots、files/settings/external inputs 的 physical manifest 与 cutover actor；
- `gate-registry.json`：三个出口、四组 validator、stable atomic check IDs；
- `targets.json`：本机 package/provenance 与 9 个 installed smoke；
- `transition-ledger.json`：old entry 的 replacementStage/deleteStage/disposition/selector。

## r4 不可回退项

- ContextSegment identity 是 source occurrence；
- ContextSequence 是 branchable parent DAG，current root 由 ConversationContextHeadLink 表达；
- root/node 首发保留到 dataset reset；
- RuntimeDelivery 使用 NULL/非 NULL partial UNIQUE、attempt_seq/redelivery 与 RuntimeDeliveryInputLink.handled_at；
- ChildExecution Parent/Turn/Intent/ActiveTurn Links 分离；
- CommandReceipt 使用 `(source_kind, source_key)`；
- interrupt_subtree 首发必选；
- ProviderContinuation 首发禁用且不建表；
- process 使用 detached wrapper，不凭 PID 猜终态；
- MCP call 使用 `mcp_tool_call` Effect；
- Compression summary 修改创建 immutable replacement；
- gate handler 使用 check ID Map，不匹配 description。

## 使用规则

- 修改合同必须同步人读文档和 `scripts/reliable-kernel/lib/contract-model.mjs`；
- authority Runtime/configuration sets、migration roots/settings、recovery IDs、gate IDs 与 smoke IDs 使用 exact-set；
- migration physical entry 必须给出 logical domain、path source、Repository、Codec、disposition、index/records/verification/unknown-file policy；
- 未实现 foundation/candidate/package check 必须 PENDING；
- 合同通过只代表计划结构自洽，不代表 SQLite、fault recovery 或 installed package 已实现；
- `/tests/` 中的 fixture/benchmark/fault data 保持 ignored/untracked；
- 不为“完整”重新引入 generic table、daemon、ClientChangeLog、legacy import、dual write、fallback 或协议版本协商。
