# Claude 渠道并行工具结果配对修复

对应第 15 号合并请求之后的同类问题：第 15 号处理了 Gemini 渠道对特定模型上下文协议工具的兼容，本次处理 Claude 渠道。修复说明随代码和回归测试一起提交。

## 问题与原因

Claude 要求一条助手消息里的每个工具调用块（`tool_use`），都在紧随其后的那一条用户消息里拿到对应的工具结果块（`tool_result`）。

可靠内核把每个工具结果冻结成独立的工具对上下文片段，附件目录之类的片段还会按时间顺序排在它们中间。
固定模型接入库的 Claude 编码器逐条把上下文内容映射成线上消息，不做合并，于是一次并行工具调用的多个结果被编码成多条彼此独立的用户消息，中间还可能夹着一条附件目录文本消息。

结果是除第一个工具调用外，其余工具调用都被判定为没有紧邻的工具结果，请求被拒绝：

```
messages.78: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01KhRwKK3vHDJ3QUXVcFJg1Y, toolu_01YSk1CBHWjmcJv1sdLCYC8t.
```

同一段上下文在 Gemini 渠道不会出错，因为 `toUnifiedRequest` 已经为 Gemini 合并了相邻的纯工具结果轮次；Claude 渠道此前没有对应处理，而且 Claude 的编码器会丢弃与工具结果同处一条内容中的文本，所以不能直接套用 Gemini 的合并方式。

## 修复范围

- `backend/capabilities/llmProvider.ts` 的按渠道编码兼容层新增 Claude 分支，沿用第 15 号请求为 Gemini 引入的 `installProviderSchemaEncoder` 包装位置，只改 Claude 的出站请求体。
- 新增 `restoreClaudeToolResultPairing`：扫描编码后的消息，把同一批工具调用对应的工具结果合并进紧邻助手消息的那一条用户消息，工具结果排在最前，夹在中间的其他内容按原顺序追加在其后。
- 只做重新分组，不伪造占位工具结果。上下文里真的缺少工具结果时，`assertCanonicalProviderToolContext` 仍然照旧在编码前直接失败。
- 已经正确配对的对话不做改动，Gemini 与开放模型接口兼容渠道的编码路径不受影响。
- 后续修复：可靠内核的出站投影不再把附件目录放进同一批工具结果之间。锚定在某个工具对之后的附件目录，推迟到这一批最后一个工具结果之后再发出（所有渠道都如此），所以新请求里这一步只剩把各工具结果合并进同一条用户消息；它仍保留，用于兼容其他来源的错位内容。

## 数据保留

- 不改数据库表、索引、运行数据格式标识或配置格式，不清空、重置、迁移已有数据。
- 只重排出站请求体，不改写已保存的对话、工具对片段与附件目录。
- 工具结果的文本与图片、文档内容保持不变，附件目录文本不丢弃。

## 回归验证

新增三项测试位于 `tests/openAIResponsesWebSocket.test.cjs`，其中前两项在修复前失败：

- 三次并行渲染的工具结果被拆成三条用户消息、并且中间夹着附件目录文本时，编码结果合并为一条用户消息，三个工具结果按调用顺序排在最前，附件目录文本保留在其后，工具结果里的图片块不变。
- 相邻的两批并行工具调用各自与自己的那一批工具结果配对，不会互相并入。
- 已经正确配对的工具轮次与其后的人类发言保持原样，不被合并。

执行命令为 `npm run compile && node --test tests/openAIResponsesWebSocket.test.cjs`。
完整检查命令为 `npm run check:local`；合并前还应执行 `node scripts/reliable-kernel/check-plan.mjs --require-tracked`，并确认合并请求及主分支的远端检查结果。
