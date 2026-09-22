# 子 Agent 续聊与配置增量发布

## 模型可见的协作边界

`run_agent` 工具说明负责静态操作规则：新任务提供简短职责、必要上下文、可写范围及验证要求；相关后续工作复用已有 childRef；派发后继续互不重叠的工作，没有可推进工作时等待结果通知。不要在系统提示、状态卡和工具说明中重复同一套规则。

请求末尾的 runtime status card 只提供会话范围的成员事实：childRef、简短任务标题、当前状态、是否可续聊。活跃成员优先，再列最近的可续聊成员，最多 32 条并声明省略数量。标题按 JSON 字符串编码，作为数据呈现，不作为新指令。进程状态仍限当前 Turn。

已有 AnswerBridge 是实际续聊标识，A1/A2 是其模型可见别名。下次请求从本会话最近普通请求的冻结 recipe 延续映射；压缩或成员暂时退出名册不能把旧编号分配给新人。映射只保存小型标识，不复制子会话正文，也不增加一份团队状态数据库。不同会话各自编号；Fork 不继承原会话的副 Agent 所有关系。

普通续聊使用已有 queue_next_turn 意图；当前执行自然结束后再接续。interrupt=true 用于立即改向，mode=interrupt 仍表示停止子树。不能仅修改 send mode 后立即 admit：运行中的子 Agent 必须先完成当前 Turn。

参考源码（2026-09-20 核对，采用设计原则而非整体移植）：

- [Codex 工具定义](https://github.com/openai/codex/blob/5c5308fc9a9ee789049d646ef11e5400384b9c6f/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)：send_input 明确复用既有 Agent，interrupt=false/省略时排队；各操作语义放在工具定义中。
- [Codex 协作提示注入](https://github.com/openai/codex/blob/5c5308fc9a9ee789049d646ef11e5400384b9c6f/codex-rs/core/src/context/multi_agent_usage_hint.rs)：静态协作提示独立呈现，区别于运行状态。
- [OpenCode Task 说明](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/opencode/src/tool/task.txt)：task_id 延续子会话，任务明确研究/编辑职责、验证方式，主线程继续不重复的工作。

## 配置保存

生产配置入口保留现有完整目录提交与 CAS 合同。公共 recordStore 在原有锁内比较规范化内容指纹，只原子写入发生变化或需要修复的 record，保留其他 record 与索引项时间戳。只有索引内容变化才发布索引，删除仍先发布索引再清理文件。真实 I/O 错误仍抛出；显式完整目录保存仍可重建缺失或无效记录。

渠道和压缩配置的归一化不再给所有条目统一刷新 updatedAt；前端已有针对实际编辑条目的更新时间。普通设置文件的内容无变化时不重写，且仍先检查 expectedRevision。MCP、Agent、Workflow、各作用域策略和模型配置复用公共 recordStore，无需每个页面另建增量协议。

这一改动减少写入与文件监听事件；完整目录入口仍需读取和比较记录，未声称所有读取或 Webview 配置快照都已变成增量。没有引入 TTL 缓存、后台写队列或弱化持久化确认。删除了在读取和解析后才缓存三个模型字段的冗余结果缓存，保留并发读合并。

验证包括 874 条合成会话配置的路由保存与发起模型请求、无变化提交、未编辑记录字节保持、删除与损坏文件修复、渠道/压缩/MCP 目录保存、跨轮成员发现与稳定引用、运行中续聊排队，以及 Windows 存储锁和 CAS 回归。模型请求验证使用合成 provider，不消耗用户渠道额度。
