# 固定模型接入库构建

本目录维护 `unified-llm-provider` 的本地补丁及固定安装包。补丁包括观察接口、Astra 原生适配，以及按各家官方接口文档做的协议修复。

- 上游：`https://github.com/Lianues/unified-llm-provider`，许可证 MIT。
- 基础发布：0.1.37，源码提交 `7857da99d5faec0865b8a402eb9c9d828f87b114`（上游 main，已含 schema 属性名误删、tools 非数组两个修复）。
- 本地构建：0.1.37-limcode.3，内容如下。

limcode.2 带来的内容（保持不变）：
- 只读观察接口。
- function 工具声明、function_call 输入与解码 item 上的 `async` 标记原样透传（Astra 异步工具）。
- 可选的原生解码模式：由 provider 内部构造时开启，LimCode WebSocket 会话不开启。开启时，精确匹配的 Astra 模型在 SSE 解码时附加 `nativeEvent`（response.created/completed/incomplete）和终端 `completedContents`。
- Astra 显式缓存断点：把顶层 instructions 转为带 `prompt_cache_breakpoint` 的 developer 输入消息。

limcode.3 新增的协议修复（每项在源码注释和测试里写明了官方依据）：
- OpenAI 兼容格式：
  - 流结束时补发尚未发出的工具调用，参数不完整时报解码错误，不再静默丢弃。
  - 容忍空参数和缺 `index` 的流式增量。
  - `finish_reason:"error"` 按错误上报。
  - 解码并原样回放 OpenRouter 的 `reasoning` 和 `reasoning_details`。
  - `tool` 消息只放文字，图片、文件和旁带文字放到该批 `tool` 消息之后（DeepSeek 除外）。
  - DeepSeek 思考等级按官方取值映射。
  - schema 清洗先展开本地 `$ref`，数字 enum 保留原值。
- Claude：
  - 思考块按原顺序回放。
  - 保留并回放 `redacted_thinking`。
  - 规范化不合规的工具调用 id。
- Responses：
  - 函数工具默认发送 `strict:false`。
  - 显式缓存断点放到最后一个能承载的块上。
  - 保留服务端返回的 assistant `phase`。
  - 服务端 compaction 项只解码一次，并可原样回放。
- Gemini：请求 URL 对模型 id 做百分号编码。

文件与命令：
- `unified-llm-provider.patch`：相对基础提交的完整源码与测试差异，不直接作用于依赖安装目录。
- `provider-debug-provenance.json`：记录基础提交、补丁与安装包的摘要。
- 重建：在项目根目录运行 `node scripts/reliable-kernel/build-provider-debug-fork.mjs`。
- 验证：运行 `node scripts/reliable-kernel/build-provider-debug-fork.mjs --check`，核对已固定的补丁和安装包。

观察接口不开启原库的累计全文调试功能。升级此依赖时必须重新检查补丁并跑补丁自带的测试（在打过补丁的源码目录运行 `npx vitest run`），不允许静默退回没有观察接口或协议修复的版本。
