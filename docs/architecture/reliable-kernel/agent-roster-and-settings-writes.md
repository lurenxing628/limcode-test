# 子 Agent 续聊与配置增量发布

## 模型可见的协作边界

`run_agent` 每次调用必须显式给出 `operation`，只接受 `spawn`、`send`、`list`、`read`、`wait`、`interrupt_subtree`。`spawn` 必须有 `taskName` 和 `prompt`；`send` 必须指定已有 `childRef` 和 `prompt`，缺少引用直接拒绝，不能转为新建。工具说明负责静态操作规则：新任务提供简短职责、必要上下文、可写范围及验证要求；相关后续工作复用已有子任务；派发后继续互不重叠的工作，没有可推进工作时等待结果。不要在系统提示、状态卡和工具说明中重复同一套规则。

请求末尾的 runtime status card 提供从已提交 Runtime 事实重建的派发清单，包括稳定 `childRef`、初始任务、当前任务、排队任务、执行状态、是否可续聊，以及答案到达和父执行器已处理的区别。标题只用于识别，不能代替完整派发正文。清单详情最多 32 条，优先展示仍在执行或等待处理的成员，并声明完整计数与省略数量；进程状态仍限当前 Turn。任务和答案按数据编码，不能把子任务中的指令提升为父模型的新指令。

已有 AnswerBridge 是实际续聊标识，A1/A2 是其模型可见别名。普通请求与压缩请求共用持久 recipe 的映射恢复入口；压缩、成员暂时退出清单和 Host 重启都不能把旧编号分配给新人。保留历史别名只保证引用可辨认，不授予操作权限。Fork 的历史请求可能引用源会话的成员，但 Fork 不继承原会话的 ChildExecution 父关系；查询和操作均须按当前会话的真实父链重新验证。Fork 的运行状态卡把这些不属于本会话的继承引用列为 `{"inheritedChildRefs":[…],"operable":false}`，即使本会话还没有自己的子任务；对它们执行读取、等待、续聊或中断时，报错明确说明该子 Agent 属于分支来源对话。

`operation=send` 使用已有 `queue_next_turn` 意图，当前执行自然结束后再接续。`interrupt=true` 用于先中断当前 Turn 再发送后续任务；`operation=interrupt_subtree` 则沿持久父链停止子树。旧 `mode` 不再接受。达到新建子 Agent 的深度上限时，只去掉 `spawn` 操作，查询和已有成员的操作仍可用；执行端仍独立校验新建深度，不能只依赖模型工具列表。

## 派发清单与读取边界

`list` 默认列当前会话的直接子任务，显式 `scope=tree` 才展开后代。计数描述完整作用域，分页结果不得冒充全部成员；被状态卡 32 条上限省略的成员仍能通过分页查询。`read` 根据已知引用读取具体任务和答案，`wait` 根据已知引用等待状态变化；等待支持单个 `childRef` 或 `childRefs` 集合，不能省略目标后自行新建任务。列表和详细读取默认每页 32 条、最多 100 条，等待最多接收 32 个引用。查询和等待不创建子任务、不改交付状态，也不把一次读取标记为父执行器已处理。list/read 另有 2600 token 页预算，实际返回数量可以少于 limit。read 的单份长正文按 textOffset/totalCharacters/textComplete/textSha256/textFormat 分块，nextCursor 继续，rereadCursor 重读本页起点。结构化 MessageContent 使用 message_json 保存附件引用。活动状态变化不使游标失效；作用域、查询条件、来源正文身份发生冲突则明确拒绝。并行工具批次再次裁剪结果时必须保留本页重读游标，不能直接跳到下一页丢掉正文。

`list/read/wait` 可显式读取真实后代树；`send/interrupt_subtree` 只操作当前会话的直接子任务，不能拿可见的孙级引用绕过中间父任务。所有操作先核对调用 ToolCall 属于当前 Turn，再核对当前 Conversation 的父链作用域。

数据来源保持独立：ChildExecution 与 Parent/Turn/Intent/ActiveTurn Links 决定身份、树关系和代际；首轮 MessageRevision、后续 TurnIntentRevision 及其 CAS 正文决定派发内容；AnswerSubmission、RuntimeInboxItem、RuntimeDelivery 和 InputLink 决定结果与处理状态。不增加团队 JSON、任务汇总表或第二份任务 authority。

任务读取按当前类型解码。模型发送的子任务正文、UI 输入 envelope 引用的正文、Plan delegation 生成的执行任务，以及 retry、runtime continuation、maintenance 的来源不同，不能把任意 TurnIntentRevision CAS 当成一段新任务文本。Native steering 的指令与投递收据也独立保存；只有确认生效的修正才能表示为当前任务，未送达或交付未知必须保留相应状态。

子任务切换到新 Turn 时，旧答案的投递记录仍可能等待父执行器处理。因此答案状态按具体 submission 和 delivery/input 事实读取，不能只看 AnswerBridge 的当前指针。`RuntimeDelivery.state=consumed` 表示已注入输入，只有对应 `RuntimeDeliveryInputLink.handled_at` 才证明父执行器已吸收。consumed 但尚未 handled 的投递如果 wake 已 dead_letter，应显示交付失败。前台返回的答案另从 ToolModelResult/ContextSegmentSource 读取已提交结果证据；无 RuntimeDelivery 不等于未返回答案，Context 已提交也不等于业务验收完成。

## 快照、恢复与重复派发

每个新 ModelRequest 在 worker 的同一 SQLite 读事务内取得作用域和相关事实，再以不可变 CAS identity 读取正文并冻结到 recipe。尾部状态卡和模型短引用使用这份快照；同一 ModelRequest 的重试复用其冻结 recipe，后续新请求重新投影，因此压缩后不依赖摘要是否记住派发记录。`snapshotRevision` 是该投影来源事实的内容指纹；`snapshotCommitSeq` 只用于诊断，不能当成跨 Host 全局提交序号。

跨 Host 的清单读取共享 Runtime 数据，不依赖本进程的活动 Promise 集合。观察到另一 Host 正在驱动子任务时，仍应显示真实运行状态；发送、中断和恢复继续遵守现有 Conversation ownership 与 ExecutionLease，不通过清单绕开执行权边界。

同一 source ToolCall 的 spawn 重放继续由稳定身份保证幂等。模型生成新的 ToolCall，即使任务文字相同，也不等于同一派发；本次不做语义自动合并或仅凭文本相等拦截，以免误合并用户要求的并行复核。防重复的基础是可靠清单、明确操作和有效引用校验。压缩摘要保留逐条派发 identity，不能用通用冒号前缀把不同工具调用覆盖成一条。以上变化复用当前 Runtime schema，不引入迁移链。

参考源码（2026-09-22 冻结核对，采用行为模式，不整体移植）：

- [Codex 压缩后 cold child 恢复测试](https://github.com/openai/codex/blob/94174e44cbc54cece45f6052328ca0c2cd7a8a2a/codex-rs/core/tests/suite/multi_agent_resume.rs#L554)：验证模型实际请求中的成员身份；其 list 不提供完整任务正文。
- [oh-my-pi hub list](https://github.com/can1357/oh-my-pi/blob/df624f56b0508c51067a70422606cac898ac2bcb/packages/coding-agent/src/tools/hub/messaging.ts#L133)：磁盘名单恢复与完整计数；本项目另提供正文分页及持久 Runtime authority。
- [OpenCode v2 完成通知](https://github.com/anomalyco/opencode/blob/080b7671dea45a693b537c1e358e89ab14463d0d/packages/core/src/session/subagent-completion.ts#L20)：稳定通知身份与持久接收后确认；本项目复用独立 RuntimeDelivery/InputLink。

原生异步执行在同一 ModelRequest 内新建子任务时，发送前以固定 `ToolCallEvent.native_child_handle_projection` 冻结工具结果的模型投影与累计 child 映射。只把冻结 output 送入 wire，内部映射不出网；随后调用、重启、普通请求与压缩沿用已提交映射。该事件不修改初始 recipe，也不代替 native delivery 的接收确认。原始 Provider 参数和解释后的工具参数分别冻结并核验，短引用转内部 ID 不再触发错误的不等判断。

已经包含错引用的摘要可通过输入区“从原始记录重建摘要”显式修复：只接受未变化的完整 current_head，在不可变 provenance 完整时重建新摘要；来源缺失、循环或超限直接失败，原历史保留。

## 配置保存

生产配置入口保留现有完整目录提交与 CAS 合同。公共 recordStore 在原有锁内比较规范化内容指纹，只原子写入发生变化或需要修复的 record，保留其他 record 与索引项时间戳。只有索引内容变化才发布索引，删除仍先发布索引再清理文件。真实 I/O 错误仍抛出；显式完整目录保存仍可重建缺失或无效记录。

渠道和压缩配置的归一化不再给所有条目统一刷新 updatedAt；前端已有针对实际编辑条目的更新时间。普通设置文件的内容无变化时不重写，且仍先检查 expectedRevision。MCP、Agent、Workflow、各作用域策略和模型配置复用公共 recordStore，无需每个页面另建增量协议。

这一改动减少写入与文件监听事件；完整目录入口仍需读取和比较记录，未声称所有读取或 Webview 配置快照都已变成增量。没有引入 TTL 缓存、后台写队列或弱化持久化确认。删除了在读取和解析后才缓存三个模型字段的冗余结果缓存，保留并发读合并。

验证包括 874 条合成会话配置的路由保存与发起模型请求、无变化提交、未编辑记录字节保持、删除与损坏文件修复、渠道/压缩/MCP 目录保存、跨轮成员发现与稳定引用、运行中续聊排队，以及 Windows 存储锁和 CAS 回归。模型请求验证使用合成 provider，不消耗用户渠道额度。
