# 阶段 E：Context DAG、压缩与 Provider 完整请求

## 目标

消除长对话上下文平方增长，保留精确 replay、compression、fork、stream fence 与有限 Provider retry；首发不实现 ProviderContinuation suffix 优化。

## 主要工作

- ContentObject 只去重正文，ContextSegment 表达 source occurrence；相同正文不同来源不得合并；
- ContextSegmentSource 使用 `(source_kind, source_id, source_revision) UNIQUE`；
- ContextSequenceNode 使用可分支 persistent parent DAG，retry/edit/fork 共享 immutable prefix；
- 非 NULL parent 使用 `(parent_node_id, segment_id) UNIQUE` 保证 append idempotency；NULL parent 使用 `segment_id UNIQUE WHERE parent_node_id IS NULL` 补齐 SQLite NULL 语义，parent 本身不 UNIQUE；
- ContextSequenceRoot 使用 `(conversation_id, root_seq) UNIQUE`，root_node_id 不 UNIQUE；
- ConversationContextHeadLink 在创建 current root 的同一事务更新；
- root/node 与 historical projection 首发保留到 Runtime dataset reset，不做 online GC；
- projection 只保存 root/owner/recipe，不复制完整 history/source links；
- 普通工具 call + model result 保持不可拆的 tool_pair；已证明准入的 Astra 原生调用允许独立的 call/result occurrence，顺序与关闭条件见下文；
- compression source range 登记在 CompressionBlockSource；
- compression root 用 `tail_node_id + tail_segment_count` 精确限定 summary 后的 finite tail；
- compression threshold/estimator 来自本次请求固定的有效配置：基础 AuthoritySnapshot 加独立请求设置；新请求可采用最新压缩配置，恢复与重试只读取原请求引用；
- Message edit/delete 创建新 current root，historical replay 不读取当前 soft-delete；
- Conversation fork 创建目标 root/head，并写独立 Reuse/Branch/Origin Links；
- ModelStreamCheckpoint/ModelStreamFence 保存 stream identity 与 terminal fence；同一 stream identity 只有 kind 与 canonical content 都一致才可幂等重放；
- Provider transient retry 仍最多两次、以已提交 ModelRequest/Attempt 事实可见，并通过 request-level writer cancel-current 命中当时最新 attempt/socket；
- adapter resolve/reject、Completed 与 cancel 的返回分类以 durable first-wins 事实为准，旧 socket 正常返回也标记 superseded；
- Message context role 从 frozen source 指向的 immutable MessageRevision 读取；非精确 UTF-8 模型正文在外调前失败。

## Provider release decision

可靠内核到 Adapter 的逻辑请求边界仍为 `disabled-full-request`：

- authority/runtime domains 不包含 ProviderContinuation；
- 每个 ModelRequest 从 frozen root + immutable recipe 构造完整 request；
- 内核不读取持久化 ProviderContinuation，也不构造 suffix；
- reconnect、compression invalidation 与 new attempt 都从完整 frozen request 重建；
- candidate check 以独立 oracle 逐字段证明该逻辑边界“始终完整请求”；物理 Responses WebSocket 的进程内缓存不等于启用 ProviderContinuation domain；
- future enabled mode 必须先修改机器合同，不得运行时协商或 fallback。

Phase E 的 stable ID 验证可靠内核 control plane 本身；旧应用 LLM/compression 路由的物理不可达与最终 Extension Host 装配由后续 candidate/cutover gate 负责。在该路由完成前，Phase E evidence 不得被表述为生产入口已经切换，也不得用手工 `evaluate/create` 结果冒充 append 后端到端自动压缩。

## Astra 原生 Responses 执行边界

- 能力门禁由 `shared/openAIResponsesCapabilities.ts` 统一计算：协议、精确型号、渠道信任/中继确认与传输缺一不可。HTTP/SSE 和 WebSocket 都支持原生工具链及动态推理；转向和多路复用仅用于 WebSocket。其他模型沿用原行为。
- 一个原生 `ModelRequest` 可以包含多个物理 response。持久化 `{attemptSeq, socketGeneration, streamSeq}` 始终存在；物理 `connectionGeneration`、`streamId`、实际发送的 `previousResponseId` 仅在真实存在时记录，HTTP 不伪造这些身份。
- `native_control`、`native_tool_call` 是不可被普通流式容量上限丢弃的 checkpoint。`output_item.done` 的实际 `async:true` 加冻结的逐工具许可才允许早期准入；缺省/false 必须等本 response 的完成边界。原生控制器在同步结果未回传时同样保持存活，不依赖转向或另一个异步调用来解锁。
- `NativeRequestSession` 通过 `ReliableToolDispatcher.scheduleAdmittedCall` 使用既有审批、取消、幂等和分类调度限制，不另建绕过策略的执行队列。调用准入事实与调用一起持久化；terminal checkpoint 收敛后仍由 `ToolCallEvent` 的 CAS 事实恢复。
- 模型输出 item 的 ordinal 是 response 局部身份，不能独自作为跨 response 的 revision/dedupe key。item revision 使用 response 作用域；当前累计/最终 Message revision 只服务展示，不重复进入 Context。
- 工具结果完成后先保存真实 `ToolModelResult`。只有匹配的 `response.created` checkpoint 明确包含 `admittedToolResultCallIds`，才追加结果 Context occurrence 并记录 delivery；socket write 不代表送达。转向自动后继尚未接纳结果时，结果不得排在该后继之前。
- 转向使用独立 `PendingTurnInput(input_kind='native_steer')` 与 `MessageTurnLink(role='native_steer')`。提交时保存不可变用户消息，证明后继接纳后才把原 revision 加入 Context；`prepareMessageAppendMutation(existingRevisionSeq)` 引用已提交 revision，不为应用关系复制一份消息 revision。已发送/已接受不等于生效；未证明应用的逻辑收尾标记 `delivery_unknown`，不自动重发。
- 原生最终输出可以与同一逻辑请求内已交付的工具调用共存。`TurnFinalOutputFence` 仍要求没有待吸收 runtime delivery；原生例外必须在同一事务内固定精确调用集合、terminal 调用、唯一结果、结果 Context occurrence、准入与送达事件。普通请求仍保持无工具 SourceLink 的最终输出规则。
- reasoning 的 base、有效 effort 和更新事实进入 immutable recipe。适配器从冻结配置构造线级参数；同一新增边界上的更新折叠为最后有效值，不产生相邻 `configuration_update`。模型/渠道切换终止旧 reasoning lineage；压缩移除传输更新后显式重建有效档位与缓存。
- WebSocket 在完整逻辑输入与缓存前缀精确一致时可发送物理增量；不一致、重连或重建时发送完整输入。命名通道共享匹配连接，最多 16 个活跃 response、32 个通道；连接建立中的 Promise 也必须共享。已证明的工具输入等待可以释放活跃 response 许可，但不能释放逻辑通道归属。
- 真实通道排队与工具输入等待暂停 idle/semantic watchdog，不暂停总请求时限或取消。异步回调沿用捕获的完整 execution lease fence，不能借用后来的一代租约。
- 压缩、切换模型与 fork 只把“已结算且结果已进入 Context”视为关闭；Turn 已终止本身不是关闭证明。fork 保留 source/Link 与原 provider call id；切点永不延长到其后的历史：保留前缀内的原生调用若在切点之后才结算，其结果作为新的内容寻址节点追加在切点之后，只有分支自身片段内仍未结算的调用才拒绝分支，调用方仍在运行的后续轮次不阻塞分支；不把未应用转向复制为普通用户历史。
- `stream_stats_json` 的 SQL 乐观断言必须使用读到的原始 snapshot JSON。解析后的语义视图可能改变键顺序，不能拿它与 `JSON.stringify` 存储列做字节等值比较；heartbeat 后的同值不同序 JSON 也必须能继续写入 native usage anchor 和终态。

离线入口：`native-provider-capability.test.mjs`、`native-tool-admission.test.mjs`、`native-request-orchestration.test.mjs`、`native-astra-integration.test.mjs` 与 `openAIResponsesWebSocketNative.test.cjs`。真实浏览器验证设置保存/重载、冻结能力门禁、转向回执及后继时间线；这些隔离验证不等同于真实付费模型调用。

## Compression management

- summary/body/source immutable；
- enable/disable/soft delete 只更新 status；
- regenerate 创建新 CompressionBlock/segment/root；
- 用户修改 title/summary 也创建 immutable replacement，并明确处理旧块 status；`previousStatus` disposition 属于持久幂等命令身份；
- 删除旧 `CompressionUpdate` 原地 mutation；
- historical ModelContextProjection 永不被 replacement 重解释。

## 简化边界

- 不做 balanced tree、closure table 或 graph database；
- 不做 root/node online retention/GC；
- 不复制完整 prefix/source links；
- 不把 Provider retry 扩展为通用 external auto-retry；
- 不建 ProviderContinuation table；
- 不让 UI current Message 状态改变 historical replay。

## 完成标准

- 每轮新增存储与 compression node count 满足量化 gate；
- source occurrence identity、branching DAG、current head 与 tail stop 的 schema/index tests 通过；
- retry/edit/fork 可从旧 parent 合法分支；
- historical projection 在后续 edit/delete 后精确 replay；
- compression 不同时物化 summary 与被替换原文；
- immutable replacement 不修改旧 summary/projection；
- ModelStreamCheckpoint 在 terminal 后按受控 retention 收敛，容量/Completed fence/prune 全部由固定 writer operation 在一个事务中决定；
- Provider reconnect/retry 始终使用完整 frozen request，late socket generation 不重复输出；请求级取消即使 adapter 永不 settle 也可持久收口；
- candidate stable IDs `candidate.context-storage-growth`、`candidate.context-compression-node-bound`、`candidate.provider-continuation-disabled-full-request`、`candidate.conversation-fork-links`、`candidate.compression-immutable-replacement` 有真实证据。
