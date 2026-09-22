# Agent 协作

## 用户入口与配置

全局设置一级页签「Agent 协作」集中展示派发深度、团队并发和每轮自动续派预算。Agent、对话和工作流设置提供同一组件的局部覆盖，并明确显示继承来源。数据仍写入对应作用域的 `ToolPolicy.toolConfigs.run_agent.config`，不新增第二份设置 authority。

- `maxChildAgentDepth` 默认 **1**。主对话为 0；默认可以创建子 Agent，但子 Agent 不能再新建下一层。只有用户调整设置才能增加深度。
- `maxConcurrentAgents` 默认 8，限制团队中实际活动的子 Turn，包括已预留但尚未开始采样的启动，不包含根对话或空闲成员。它与一次父 Turn 的并发启动 admission 槽位不同。
- `maxAutomaticFollowups` 默认 32，用于限制 Agent 自动续派；0 禁止自动续派。用户明确发起的新任务与自动协作的预算来源分开。

配置在 Turn authority 中冻结，模型工具参数不包含以上设置。已有成员通信、读取和等待不增加深度。用户定制的工具允许列表继续生效，不为新增功能绕过已禁用的工具。

协作由模型工具发起，输入区不提供手动授权或留言板入口。发送消息和续派任务是两个明确动作；队列与消息状态区分已提交、已注入输入和模型已处理。

对话时间线在消息所属轮次（接收方为投递轮次，发送方为发送轮次）的首条消息处显示「来自对话 X / 发往对话 X」来源卡片，附 320 字符以内的正文摘要；对方对话已删除时显示「已删除的对话」，仍在排队等待的消息显示在时间线末尾。输入区等待队列的协作项同样显示来源对话标题。

## 身份与授权

同根团队从 `ChildExecutionParentLink` 和 Conversation/Turn 关系派生。父子树记录任务来源和生命周期；通信不改变父子树，也不把 Agent 配置作为运行地址。现有 `run_agent.send/interrupt_subtree` 仍只控制直接孩子。

团队之外的对话不可读取、发送或唤醒，也没有逐对话授权表；唯一例外是跟进任务完成后把结果回送给原请求方。跨对话协作将由独立设置开关统一开放，届时也不能借此寻址其他团队的子 Agent。

模型侧使用冻结的短引用目录，内部 Conversation、消息、频道和帖子身份不直接暴露。普通请求、native 同一逻辑请求内的后续调用、压缩和重启共用持久映射；继承历史引用不授予原团队操作权限。

## 工具与投递

- `run_agent` 继续管理创建、排队续聊、读取、等待和停止直接子树。
- `list_agents` 只返回同根团队成员。
- `send_agent_message` 保存同伴消息，普通空闲目标不启动新 Turn。
- `followup_agent_task` 提交明确任务；活动目标在安全边界接收，空闲目标通过原调度器继续执行。
- `read_agent_messages/wait_agent_messages` 有界读取和等待，不改变处理状态，不启动目标。
- 留言板代码保留，但第一期不向模型下发 `agent_board`。

发送可选择排队到目标本轮结束：目标正在运行时，消息锚定当前 Turn 且不注入该 Turn；该 Turn 结束后，followup 由持久唤醒开启恰好一轮新 Turn，message 随目标下一轮带入。完成后自动回送的结果不排队，仍在请求方运行中的 Turn 安全边界注入。

消息正文保存到 CAS；消息、来源、目标、回复关系、任务请求和请求对应 Turn 分别持久化。投递复用 `RuntimeInboxItem`、`RuntimeDelivery`、`RuntimeDeliveryInputLink` 和 `RuntimeDeliveryWake`。一次发送成功只证明消息提交，`handled_at` 才证明目标执行器吸收。重复源命令返回原身份，参数篡改直接拒绝。

协作消息携带明确作者和来源类型，以 provider 的 model/assistant 角色投影，不伪装成 user/system 指令，也不产生新的用户授权。正式子任务答案继续使用自己的 AnswerBridge；跨同伴任务的结果通过独立请求/回复关系返回真正请求者。

生产唤醒统一使用 `createRuntimeDeliveryWakeHandler`：先验证 Conversation owner，子任务进入 Child coordinator，普通对话进入 Conversation runner。恢复根据持久事实收敛，不依赖仍存活的 Promise 或收到回调的 Host。

## 上下文继承

`run_agent.spawn.forkTurns` 接受 `none`、`all` 或正整数文字，默认 `none`。只复制当前上下文可达的已完成轮，压缩后按来源恢复；排除当前未完成轮及旧 system/runtime_context，不继承原 lease、配置 authority 或 ChildExecution 控制关系。继承历史、新任务正文、新子会话和父子关系在同一事务建立。

## 留言板与边界

频道、帖子、作者、回复和订阅各有独立领域表/Link。帖子完整正文保存在 CAS，读取按字符范围分页。通知只包含引用和有界摘要，完整正文通过读取帖子取得。

留言板通知只服务当时正在执行的目标 Turn；空闲目标不启动，也不保留下一轮才出现的通知。帖子本身持续可读，通知失败不能删除帖子或宣称通知成功。

## 存储与验证

新增协作领域使用当前 Runtime epoch 5。旧 epoch 通过已有 archive/reset 流程归档运行数据并建立当前 Runtime，保留配置和 Workspace；不增加任意旧格式的迁移或 fallback。当前 epoch 的缺表、索引、manifest 或 RootBinding 漂移继续 fail closed。

回归覆盖真实 SQLite/CAS、团队作用域与跨团队拒绝、静默消息、唤醒与处理 ACK、重复提交、并发预算、结果回信、分页、压缩/native 短引用、fork 和生产调度链路。界面检查包括继承/恢复设置及窄屏布局。统一入口为 `npm run check:local`。
