# 计划章程

[返回总计划](./README.md)

## 1. 使用场景

这是作者本人使用的本机 VS Code Agent 插件，不是企业服务。首发只覆盖：

- 当前 Linux x64 电脑；
- 本地 Extension Host；
- 手工构建和安装的 VSIX；
- 一个当前 data root；
- 一个 `limcode.sqlite` Runtime 数据库和一个 CAS 内容目录；
- 作者自己的配置、Agent、Workflow、工作环境、rules 与 skills。

不建设远程宿主、多租户权限、跨机器协调、Marketplace 发布、在线数据库搬迁或长期压测平台。

## 2. 改造性质

这不是从零重写聊天插件，也不是单纯替换存储库。当前文件后端已有 Turn、Effect、RuntimeInbox、Interaction、AnswerBridge 与子代理交付语义；本计划要：

1. 保留可验证的运行语义；
2. 用 SQLite 接管事务、锁、WAL 与崩溃恢复；
3. 用 CAS 保存大正文；
4. 让 Turn 成为唯一执行身份；
5. 用独立 Link 表达 fork、ChildExecution lineage、Delivery input 等关系；
6. 让 snapshot、changes、进程输出与 spool 全部有界；
7. 删除自制文件数据库和旧 ECS 生命周期 authority。

## 3. 成功标准

1. 所有 Runtime 事实进入一个 `limcode.sqlite`；
2. 大内容只通过 ContentObject/CAS 引用；
3. 每个独立领域对象和 Link 有独立 table、Repository、Codec、mutation/client mapping 与 delete/reset policy；
4. 配置 authority 继续位于独立 configuration file roots；
5. ECS 是 committed read projection，Webview 是 bounded read model；
6. candidate 在隔离根验证后一次 hard cut；
7. 旧 Runtime 只归档、不导入；
8. physical migration manifest 可逐项执行并保护 Workspace/未知用户文件；
9. 同一个当前 VSIX 完成 provenance、安装、重启和 9 个 smoke；
10. 不存在旧 writer fallback、双写或协议版本协商。

## 4. 首发产品决定

这些决定已冻结，后续实现不得自行条件化：

### interrupt_subtree

首发必选。树遍历依据 `ChildExecutionParentLink`，同时终止活动 Turn 并取消 pending Intent；不得只做逐个 cancel 后仍在 UI 宣称支持子树终止。

### ProviderContinuation

首发为 `disabled-full-request`。不建 ProviderContinuation Runtime 表，不产生/读取 suffix，所有请求使用完整 frozen recipe。未来启用需要新的合同修订，但不得引入运行时 v1/v2 协商、旧格式 fallback 或兼容链。

### 后台进程

采用 packaged detached wrapper、durable append-only spool、stable nonce/process group/start fingerprint 与 atomic exit receipt。输出按keyset分批登记并用handle分页完整读取；无法证明时写 `outcome_unknown`；禁止伪造 exit code 或按裸 PID stop。wrapper 不是 daemon/broker。

### 能力去向

- fork：保留行为和 Reuse/Branch/Origin 三类独立 Link；
- MCP：保留设置，连接重建，调用进入 `mcp_tool_call` Effect；
- CompressionUpdate：删除原地 mutation，改为 immutable replacement；
- attachments：重建 Attachment/AttachmentLink/CAS；
- ask_user：复用通用 Tool/Interaction 领域；
- task list：从工具事实派生；
- skills/rules：原地保留并重扫；
- checkpoint Runtime：首发禁用并归档重置，配置保留；
- agentSystem scope links：无独立 authority，hard cut 时删除。

唯一机器表见 [`authority.json#capabilityDispositions`](./contracts/authority.json)。

## 5. 外部副作用边界

本项目不混淆“模型结果唯一”和“外部世界 exactly-once”：

- `ToolModelResult` 必须唯一；
- 文件通过 base/target/actual digest 核验；
- 进程通过 wrapper fingerprint、spool 与 exit receipt 核验；
- MCP 调用派发后不可查询时为 `outcome_unknown`；
- Provider 临时错误只允许当前活动请求内有限、可见、可取消的 retry；
- 文件、命令、MCP 和子代理 spawn 不得在 Extension Host 重启后自动重做。

## 6. Recovery owner

Stage D 建通用 scanner 框架并拥有：

- `recovery.effect-intent-hanging`；
- `recovery.file-change-unresolved`。

Stage F 拥有：

- `recovery.answer-inbox-invariant`；
- `recovery.delivery-pending`；
- `recovery.foreground-answer-wait-expired`；
- `recovery.interrupted-subtree-incomplete`。

同一 scan 不得由 D/F 重复实现；机器 target/action/owner 只在 `tool.json#recoveryScan` 定义。

## 7. hard cut 边界

切换顺序以 `migration.json#cutoverSequence` 为唯一权威。执行主体明确为：

```text
旧宿主关闭 command admission
→ drain Turn / wrapper process / provider stream / persistence
→ 持久化 cutover request
→ 退出 VS Code，旧 Extension Host 停止
→ 本机安装同一个最终 VSIX
→ 重启，新宿主只进入 cutover-only coordinator
→ 按 physical manifest journaled archive Runtime
→ 过滤并核验配置 index/records/scope links
→ 创建 RootBinding pending、limcode.sqlite、CAS、runtimeKernelEpoch
→ 原子激活 RootBinding
→ 只打开新 Runtime
→ 运行 installed gate
```

激活前失败：active pointer 不变，按 journal 逆序恢复；激活后失败：只修复新内核，不回退旧 writer。

`runtimeKernelEpoch` bump 等于 Runtime 数据归档重置，不建立旧格式 migration chain。当前 epoch 5 新增协作消息与留言板的独立领域；旧 epoch 3、4 等根目录在维护互斥和 Host 离线核验后完整归档，独立配置与 Workspace 保留。当前 epoch schema 只读核对完整物理对象与 manifest，缺表和未知漂移均拒绝，已退休升级器不再参与启动。

## 8. 范围与阶段

- A：合同、release decisions、physical manifest、baseline 与 validator；
- B：SQLite/CAS/RootBinding foundation；
- C：Turn control plane；
- D：Effect、Tool、File、Process wrapper、MCP 与 D recovery；
- E：Context DAG、compression replacement 与 full-request Provider；
- F：ChildExecution、Delivery、F recovery 与 bounded Client feed；
- G：cutover、old source deletion、provenance 与 installed smoke。

D/E 可在 C 稳定后并行；F 依赖 C/D/E 的 frozen interface；G 是唯一日常插件切换点。

本 r4 没有首发可降级项。若未来改变 interrupt_subtree 或 ProviderContinuation 决定，必须先修改机器合同、runtime domain exact set、gate ID 与阶段完成标准，不能在实现里静默降级。

## 9. 测试和交付

- 本地测试、fault fixture、benchmark、大数据样本和原始日志只放 Git 忽略的根目录 `/tests/`；
- Git 跟踪实现、合同、validator 与必要文档；
- VSIX 不包含内部架构文档、测试、数据库、日志、明文密钥或嵌套安装包；
- gate check 使用稳定 ID，handler 使用 `Map<checkId, handler>`；
- 未实现检查输出 `PENDING` 并失败，不得假装通过；
- `foundation`、`candidate`、`installed` 是仅有的三个正式出口。

## 10. 本轮完成定义

计划收口阶段只有以下条件都成立才允许开始 Phase B：

- 11 份合同统一为 `2026-07-31-r4`；
- `npm run check:contracts:plan` 退出 0；
- runtime/configuration domains、migration roots/settings、recovery IDs、gate IDs 与 smoke IDs 均 exact-set；
- r3 Context/Delivery/ChildExecution 已闭合语义没有回退；
- foundation/candidate/package 未实现项目仍为 `PENDING`；
- 没有 Phase B 实现、旧 Runtime 导入、双写、fallback 或 compatibility adapter。
