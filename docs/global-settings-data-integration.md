# 全局设置与配置项数据对接规范

> 状态：本文为 settings 子系统长期规范，继续有效。

> 在新增任何“设置项 / 配置页 / 可复用配置记录”前，先读本文件，再改协议、存储和前端。

## 1. 先拆两个 scope

新增配置项时不要一上来新建一套独立 BridgeMessageType / Bridge / 顶层存储目录。先判断两个 scope：

### 1.1 配置管理 scope

配置入口属于哪一级设置页：

- `global`：全局设置页，使用 `GLOBAL_SETTINGS_SECTIONS` + `VscodeReliableKernelCommandRouter` + `settings.global.get/update/snapshot`。
- `conversation`：对话设置页，使用 conversation settings 的 section 与 bridge。
- `agent`：Agent 设置页使用独立 Agent 配置与对应 scope links，不把对话数据嵌入 Agent。

如果配置入口在全局设置页，就应优先作为 GlobalSettings 的 section，而不是新增独立消息类型。

### 1.2 配置数据 scope

配置值本身是哪种数据：

- 简单设置：一个 section 文件即可，例如 `settings/llm.json` 保存当前激活配置 id。
- 可复用配置集合：仍属于对应 settings scope，但每条配置独立成 record，并用 index 管理，例如 `settings/llm-provider-configs/index.json` + `records/*.json`。
- 真正脱离设置页、参与 ECS/ClientState 的领域对象：才按 ECS 独立对象建模，放入 ClientState / patch / 独立 storage root，并用 Link 表达关系。

## 2. 全局设置新增 section 的标准做法

新增全局配置时优先复用现有通道：

```ts
GLOBAL_SETTINGS_SECTIONS = ['common', 'llm', 'yourSection'] as const;
BridgeMessageType.GlobalSettingsGet
BridgeMessageType.GlobalSettingsUpdate
BridgeMessageType.GlobalSettingsSnapshot
```

不要为全局设置页里的 CRUD 操作新建：

```text
settings.yourThing.create
settings.yourThing.update
settings.yourThing.delete
YourThingBridge
<dataRoot>/your-thing/
```

除非它已经被确认是独立领域对象，而不只是“全局设置中的可复用配置”。

## 3. 可复用配置集合的存储标准

如果一个全局设置 section 里有多个“配置页”，每个配置页应独立存储为 record：

```text
<dataRoot>/
  settings/
    your-active-section.json
    your-configs/
      index.json
      records/
        {yyyyMMdd-HHmmss-SSS}-{slug}-{hash}.json
```

要求：

1. 每个 record 是一个配置对象。
2. `index.json` 只索引本集合的 record。
3. 当前激活 id 这类“选择关系/状态”不要塞进每个配置 record；单独放在对应 settings section 中。
4. 读写路径必须通过 storage capability 内部 `getPaths()` 获取，业务数据写在 `paths.settingsRootUri` 下。
5. 前端保存仍走 `GlobalSettingsUpdate`，后端在 `saveGlobalSettings(section, settings)` 内分发到对应存储实现。

## 4. LLM 渠道配置示例

当前 LLM 渠道配置采用两个 global settings section：

```text
llm:
  activeProviderConfigId: string

llmProviderConfigs:
  configs: LlmProviderConfigRecord[]
```

文件结构：

```text
<dataRoot>/settings/llm.json
<dataRoot>/settings/llm-provider-configs/index.json
<dataRoot>/settings/llm-provider-configs/records/*.json
```

运行时由 `VscodeConfigurationAuthority` 从当前配置根读取记录，再依据模型配置与 scope links 解析本次执行使用的连接参数。LLM capability 只接收解析后的配置，不直接读取 Webview state 或旧 storage facade。

Agent / Workflow / Conversation 复用模型和渠道时，通过独立模型配置及作用域关系引用配置 id，不把渠道配置对象嵌入主体。

### 4.1 Astra 原生 Responses 配置

- `LlmProviderConfigRecord.nativeResponses` 与模型专属配置的同名字段只保存 `enabled`、`asyncTools`、`steering`、`reasoningUpdates`、`multiplexing` 布尔选项；仍通过 `llmProviderConfigs` section 保存，不新增 Bridge CRUD 或数据目录。
- 模型专属配置完整替代渠道默认配置，不在读取时偷偷继承原生开关。后端归一化、前端 `normalizeModelConfigForUi`、`toPlainModelConfig` 都必须保留这些字段；创建模型配置时的显式复制与运行时继承不同。
- 能力只对 OpenAI Responses 的精确 Astra 型号及受支持快照开放。官方渠道可按渠道默认启用；第三方中继必须显式确认支持。HTTP/SSE 支持原生工具续接与动态推理；回合内转向和命名通道多路复用只在 WebSocket 模式开放。
- 显式缓存复用 `promptCache`：`enabled`、`mode: 'explicit'`、`ttl: '30m'`。线级使用 `prompt_cache_options` 和符合条件的内容断点，不把旧 `prompt_cache_retention` 当作等价配置。
- 每个工具的异步许可独立保存在 `ToolPolicy.toolConfigs[toolName].nativeAsync`。它不改变执行审批、变更应用、结果回传审批或调度策略；冻结工具定义中的 `metadata.nativeAsync` 经适配器映射为 `ToolSchema.async`，最终才成为线级声明的 `async`。
- 配置编辑只影响后续冻结请求。普通发送与 Enter 读取当前流式 `ModelRequest.stream_stats_json.nativeCapabilities`：支持原生转向时自动介入当前回复，不支持时仍按原有规则发送或排队；不提供独立转向按钮，也不能从尚未生效的可编辑设置推断当前连接能力。提交转向期间禁止重复发送，失败保留草稿与附件，不自动改为排队；编辑消息仍走原编辑流程。
- 保存与重载必须保留模型级原生配置；发送前继续使用专用 plain-data 转换，禁止把 Pinia/Vue Proxy 放进 bridge payload。

### 4.2 自定义 User-Agent

- 主入口位于全局「其他」页的网络配置区域，提供 `默认 User-Agent（UA）`。数据使用 `network` section 的 `NetworkSettingsRecord { userAgent }`，通过现有 `settings.global.get/update/snapshot` 保存到当前 `settingsRootUri/network.json`，不进入 VS Code `globalState` 或 globalStatus。
- 渠道默认配置与 LLM 专属配置不再提供独立 UA 输入框；特殊客户端身份仍通过各自的自定义请求头设置 `User-Agent`。优先级为：当前生效配置中的 `User-Agent` → `network.userAgent` → `EXTENSION_USER_AGENT`。LLM 专属配置继续整体替代渠道配置，不额外引入 UA 继承。
- 全局 UA 随「保存其他设置」保存，清空后使用扩展默认值。自定义请求头编辑器保留正在编辑的尾随空格，避免逐字输入或保存确认把 UA 中的单词粘连；离开输入框后显示归一化结果。
- 请求头覆盖按名称大小写不敏感处理，保留默认头的名称拼写，防止 SDK 补入另一个同名 UA 后被 HTTP 层拼接成多值。保存和重载继续使用现有纯数据转换、修订检查与当前配置根。
- 全局默认 UA 应用于 LLM 的 HTTP 请求、WebSocket 握手及模型列表读取。后续请求重新读取默认值；WS 连接身份包含最终请求头，有效 UA 变化后使用新的握手连接，不复用旧 UA 的连接身份。
- UA 仅改变 LLM 请求头，不模拟 TLS 指纹、浏览器能力、操作系统或网络出口，也不修改 shell、MCP 等其他客户端进程的 UA。

### 4.3 重试间隔

- 渠道默认配置与 LLM 专属配置使用 `retryDelaySeconds`，经现有 `llmProviderConfigs` section、纯数据转换和修订检查保存；不新增 Bridge 消息或存储根。
- 保存值为 `0–600` 整数秒，默认 `0`。`0` 保留自动指数退避与抖动；正数表示每次瞬时失败重试前固定等待，不加抖动。该字段不改变重试开关、次数上限或取消规则。
- 创建 LLM 专属配置时复制渠道当前值；创建后仍为完整配置替代，模型显式 `0` 不继承渠道的正数间隔。
- 请求建立时转换并冻结为 `model.retryPolicy.retryDelayMs`；压缩使用其实际 Provider / 模型的 `compression.provider.retryPolicy.retryDelayMs`。设置修改只影响后续冻结请求，在途请求和重试不改用后来编辑的值。

## 5. 前端对接标准

1. 页面组件不要直接调用 bridge，统一通过对应 Pinia store action。
2. 全局设置页签只处理展示与交互；数据请求/保存收口在 `useGlobalSettingsStore`。
3. 下拉选择控件优先复用 `webview/src/components/settings/global/SettingsDropdown.vue`（基于 `project-dropdown` + `lc-dropdown-panel` + `IconCaretUp`），不要使用浏览器原生 select 造成风格不一致。
4. 下拉内容可能溢出时必须复用 `webview/src/components/navigation/AdvancedScrollbar.vue`；SettingsDropdown 已内置 `variant="minimal"` 基础滑块样式，并支持 `maxHeight` / `height`。
5. 删除/危险确认必须复用 `webview/src/components/ui/ConfirmPanel.vue`。
6. 需要输入名称/重命名时优先复用 `webview/src/components/ui/InputPanel.vue`。
7. 全局设置快照可以广播；对话设置只同步给同一 `conversationId` 的面板。前端作用域由当前导航目标确定，外来或迟到快照不能改写该作用域，保存和各策略编辑器也不能从未校验的 incoming payload 选择目标对话。

## 6. 后端对接检查清单

新增配置项前确认：

```text
1. 这是 global/conversation/agent 哪个配置管理 scope？
2. 它是简单设置，还是同一 scope 下的可复用 record 集合？
3. 如果只是全局设置 section，是否复用了 GlobalSettingsGet/Update/Snapshot？
4. 如果是可复用集合，是否在 settingsRootUri 下用 index + records 存储？
5. 是否避免了为设置页 CRUD 新建 BridgeMessageType / Bridge？
6. 如果未来需要被 Agent/Workflow 等引用，是否计划用 Link 存 id，而不是嵌入配置对象？
7. 是否通过 getPaths() 获取路径？
```

## 7. 压缩保留量与时限设置

- 压缩时限入口位于渠道默认配置和 LLM 专属配置的“上下文压缩”模块末尾，复用 `LlmCompressionSettingsEditor`。
- `LlmCompressionConfigRecord.maxDurationMinutes` 表示一次压缩尝试的总时限，单位为整数分钟，默认 `20`，范围 `1–1440`；空值或非数值使用默认值。
- 该字段属于现有 `llmCompressionConfigs` record，通过原有全局设置更新通道、独立 record 存储及修订检查保存；渠道与模型仍复用现有绑定和写时复制规则。
- 压缩时限在建立请求时通过独立设置引用冻结；修改只影响后续新建请求，不改变在途压缩或其自动重试。
- 此设置只影响压缩请求，不改变普通聊天的 20 分钟总时限，也不改变压缩连续 270 秒无真实文本或思考进度的超时保护。每次自动重试重新计时，重试预算与取消机制保持不变。
- `LlmCompressionConfigRecord.bodyTargetTokens` 是文字压缩后保留的对话主体 Token 目标，默认 `48000`；实际预算仍受 Provider 实测校准与触发阈值以下剩余空间的一半限制。
- 保留量复用同一配置 record 和渠道/模型绑定。前端 `toPlainCompressionConfig` 与后端 `normalizeLlmCompressionConfig` 必须保留该字段，并复用 `normalizeLlmCompressionBodyTargetTokens`；否则保存回包会把用户修改还原为默认值。
- 保留量与压缩时限一样在请求建立时冻结：保存影响同一任务的后续请求，旧请求重放继续采用原值。
- `trigger.thresholdUnit` 为 `percent` 时，`thresholdTokens` 是运行时按上下文窗口推导的值，不作为设置持久化；只有 `tokens` 单位保存该字段。载入多条压缩配置时，归一化回调不能把数组下标当作上下文窗口，避免未编辑的配置被误判为未保存。

## 8. Ask / Plan 无人值守审批

- 设置入口位于“工具”页顶部的“无人值守审批”区块，提供“自动批准 Plan”和“自动回应 Ask”两个独立开关，默认均关闭。
- 复用现有 ToolPolicy record 与配置保存通道，分别存储为 submit_plan 和 ask_user 的 toolConfigs 配置中的 config.autoApprove。全局策略按原有规则被 Agent / 工作流 / 对话继承，局部 false 可以覆盖全局 true。
- 设置随 Turn 的工具权限快照冻结，仅对后续新回合生效；修改开关不会追溯批准已等待的交互，已有等待需手动处理一次。
- Plan 自动批准后在当前会话继续，不创建新的子 Agent；子 Agent 按父任务授权自动批准 Plan 的既有行为不变。
- Ask 自动返回明确标记为系统回复的自主决策指引，不代选第一个选项、不伪造用户具体回答。需要人工提供凭据或关键决策的任务不宜开启。
- 自动响应仍保存 InteractionRequest / InteractionResponse / OperationResolution，保留首响应优先、恢复和取消语义；不绕过工具禁用、命令执行或文件修改审批。

## 9. 保存确认与执行时机

1. 自动保存延迟只合并编辑，不代表保存完成。新输入、重新生成、编辑后执行或手动压缩开始前，宿主通过 `settings.global.flush/result` 等待已就绪页面提交相关设置。该消息只协调保存完成，配置内容仍走既有 get/update/snapshot，不增加配置存储入口。
2. 保存回应必须关联原请求。五秒未确认时读取磁盘核对；再等待五秒仍失败则明确报错并保留表单。不能盲目认定已成功，也不能清空未保存内容。
3. 转换为普通传输数据的函数必须没有副作用，尤其不能把 updatedAt 改成当前时间。前端只在真实编辑时更新修改时间；后台保存产生的记录时间差异不参与设置内容比较或冲突判定。
4. 新压缩请求读取当前模型对应的最新压缩设置，并通过已有单次请求设置引用固定；其重试、恢复和历史重放不读取后来改动的设置。模型身份、权限和历史基础配置不被覆盖。
5. 聊天中的当前配置和最近请求实际采用配置分开显示。外观等即时页面设置与模型请求设置不能混为同一种生效时机。
