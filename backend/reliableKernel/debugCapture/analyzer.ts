import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DebugCaptureAnalysis, DebugCaptureEvent, DebugCaptureManifest } from '../../../shared/debugCapture';
import { DebugCaptureFiles, sha256 } from './files';

/** 只读保存的有限前缀，不导入模型、工具或任务执行模块。 */
export async function analyzeDebugCapture(files: DebugCaptureFiles, runId: string, source: DebugCaptureManifest['source']): Promise<DebugCaptureAnalysis> {
  return files.withRead(runId, async (root, manifest) => {
    const result: DebugCaptureAnalysis = {
      runId, capturedSource: manifest.source, analyzerSource: source,
      versionMatches: manifest.source.extensionVersion === source.extensionVersion && manifest.source.sourceCommit === source.sourceCommit
        && source.buildId.length > 0 && manifest.source.buildId === source.buildId,
      integrity: [], findings: [], events: 0, tools: [], truncated: false
    };
    const note = (level: DebugCaptureAnalysis['findings'][number]['level'], sequence: number, message: string) => {
      if (result.findings.length < 200) result.findings.push({ level, sequence, message }); else result.truncated = true;
    };
    if (!result.versionMatches) result.integrity.push('分析程序与当时记录的代码不同，本报告不是原程序重放。');
    if (manifest.status !== 'sealed') result.integrity.push('记录未正常封存，可能发生异常退出。');
    if (manifest.hasGaps) result.integrity.push(manifest.gapReason ?? '记录声明存在缺口。');
    const readPrefix = async (name: string, bytes: number) => {
      await files.validate();
      const handle = await fs.open(path.join(root, name), 'r');
      try {
        const stat = await handle.stat();
        if (stat.size !== bytes) result.integrity.push(`${name} 实际 ${stat.size} 字节，可靠截止点为 ${bytes} 字节；截止点外不作为完整证据。`);
        const buffer = Buffer.alloc(Math.min(bytes, stat.size));
        let offset = 0;
        while (offset < buffer.length) {
          await files.validate();
          const read = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        return buffer.subarray(0, offset);
      } finally { await handle.close(); }
    };
    const index = await readPrefix('events.jsonl', manifest.indexBytes);
    if (index.length && index[index.length - 1] !== 10) result.integrity.push('索引末行没有正常结束，最后一条可能被截断。');
    const payload = await readPrefix('payloads.bin', manifest.payloadBytes);
    const events = new Map<number, { event: DebugCaptureEvent; value: unknown }>();
    const tools = new Map<string, { requestKey: string; requestId: string; callId: string; value: string; completed: boolean }>();
    const applied = new Set<string>();
    const uiApplied = new Set<string>();
    const receiveRanges = new Map<string, Array<{ start: number; end: number }>>();
    const previousRaw = new Map<string, { value: string; sequence: number }>();
    const startedRequests = new Set<string>();
    const seenRequests = new Map<string, number>();
    const rawCompletions = new Map<string, { requestKey: string; itemKey: string; sequence: number }>();
    const backendCompleted = new Set<string>();
    const uiCompleted = new Set<string>();
    const feedFrames = new Map<string, number>();
    const uiFrames = new Set<string>();
    const stages = new Set<string>();
    let payloadEnd = 0;
    for (const line of index.toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as DebugCaptureEvent;
        if (event.runId !== runId || event.captureSeq !== result.events + 1 || event.captureSeq > manifest.durableSeq
          || !Array.isArray(event.sources) || typeof event.stage !== 'string' || !event.metadata) throw new Error('事件序号或结构不连续。');
        let value: unknown;
        if (event.payload) {
          const ref = event.payload;
          if (!Number.isSafeInteger(ref.offset) || !Number.isSafeInteger(ref.length) || ref.offset !== payloadEnd || ref.length < 0
            || ref.offset + ref.length > payload.length || !['json', 'bytes'].includes(ref.encoding)) throw new Error('原文位置越界或缺失。');
          const bytes = payload.subarray(ref.offset, ref.offset + ref.length);
          if (sha256(bytes) !== ref.sha256) throw new Error('原文校验不一致。');
          value = ref.encoding === 'json' ? JSON.parse(bytes.toString('utf8')) : bytes;
          payloadEnd += ref.length;
        }
        for (const ref of event.sources) if (ref.runId !== runId || !events.has(ref.captureSeq)) note('unknown', event.captureSeq, '来源记录缺失或不在当前已验证前缀内。');
        events.set(event.captureSeq, { event, value }); result.events += 1;
        stages.add(event.stage);
        const m = event.metadata;
        if (m.sourceUnlinked === true) note('unknown', event.captureSeq, '这条处理记录的来源未关联，不能根据时间或相同内容猜定来源。');
        const context = event.context;
        const requestKey = context ? JSON.stringify([context.modelRequestId, context.attemptSeq, context.socketGeneration]) : '';
        if (context && !seenRequests.has(requestKey)) seenRequests.set(requestKey, event.captureSeq);
        if (event.stage === 'transport.send') startedRequests.add(requestKey);
        const streamKey = `${requestKey}:${m.streamId}`;
        if ((event.stage === 'transport.receive' && m.transport === 'websocket') || event.stage === 'http.decode_input') {
          try {
            const raw = (Buffer.isBuffer(value) ? JSON.parse(value.toString('utf8')) : value) as Record<string, unknown> | undefined;
            const item = raw?.item as Record<string, unknown> | undefined;
            const itemKey = raw?.type === 'response.function_call_arguments.done' ? raw.item_id ?? raw.id ?? raw.call_id
              : raw?.type === 'response.output_item.done' && item?.type === 'function_call' ? item.id ?? item.call_id : undefined;
            if (typeof itemKey === 'string') rawCompletions.set(`${requestKey}:${itemKey}`, { requestKey, itemKey, sequence: event.captureSeq });
          } catch { /* 原文的解析失败单独报告。 */ }
        }
        if (event.stage === 'provider.output' && value && typeof value === 'object') {
          const content = (value as { content?: { type?: string; calls?: Array<{ id?: string }> } }).content;
          if (content?.type === 'tool_calls') for (const call of content.calls ?? []) if (call.id) backendCompleted.add(`${requestKey}:${call.id}`);
        }
        const frameKey = `${requestKey}:${m.sessionId}:${m.streamSeq}:${m.fromStreamSeq}`;
        if (event.stage === 'feed.send' && m.kind === 'batch') feedFrames.set(frameKey, event.captureSeq);
        if (event.stage === 'ui.frame') {
          uiFrames.add(frameKey);
          if (m.decision === 'applied' && m.status === 'completed') uiCompleted.add(requestKey);
        }
        if (event.stage === 'ui.tool_apply' && m.operation === 'complete') uiCompleted.add(`${requestKey}:${m.callId}`);
        if (event.stage === 'transport.receive' && m.transport === 'http' && typeof m.byteStart === 'number' && typeof m.byteEnd === 'number') {
          const ranges = receiveRanges.get(streamKey) ?? [];
          ranges.push({ start: m.byteStart, end: m.byteEnd }); receiveRanges.set(streamKey, ranges);
        }
        if (event.stage === 'http.sse_event') {
          let covered = typeof m.byteStart === 'number' ? m.byteStart : -1;
          for (const range of receiveRanges.get(streamKey) ?? []) if (range.start <= covered && range.end > covered) covered = range.end;
          if (covered < 0 || typeof m.byteEnd !== 'number' || covered < m.byteEnd) note('unknown', event.captureSeq, '此流式事件的入口字节不完整，可能在请求中途开启。');
        }
        if (event.stage === 'transport.receive' && m.transport === 'websocket' && Buffer.isBuffer(value)) {
          try {
            const raw = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
            if (raw.type === 'response.function_call_arguments.delta' && typeof raw.delta === 'string') {
              const key = `${requestKey}:${raw.item_id ?? raw.call_id ?? raw.output_index}`;
              const previous = previousRaw.get(key);
              if (previous?.value === raw.delta) note('evidence', event.captureSeq, `入口已收到两次相同参数片段，前一条为 ${previous.sequence}；仅凭客户端不能区分模型与中转服务。`);
              previousRaw.set(key, { value: raw.delta, sequence: event.captureSeq });
            }
          } catch { note('evidence', event.captureSeq, '入口收到不能解析为消息对象的原文。'); }
        }
        if (['ws.tool_baseline', 'ws.tool_assembly', 'http.tool_baseline', 'http.tool_assembly'].includes(event.stage)) {
          if (typeof m.callId !== 'string') continue;
          const key = `${requestKey}:${m.streamIndex ?? m.callId}`;
          let tool = tools.get(key);
          if (event.stage.endsWith('.tool_baseline')) {
            tools.set(key, { requestKey, requestId: context?.modelRequestId ?? '', callId: m.callId, value: typeof value === 'string' ? value : '', completed: tool?.completed ?? false }); continue;
          }
          if (!tool) {
            tool = { requestKey, requestId: context?.modelRequestId ?? '', callId: m.callId, value: '', completed: false }; tools.set(key, tool);
            note('unknown', event.captureSeq, '缺少工具参数起点，不能核实完整累计值。');
          }
          tool.callId = m.callId;
          if (tool.value.length !== m.beforeChars) note('evidence', event.captureSeq, '实际处理前长度与此前已保存的累计值不一致。');
          if (m.operation === 'append' || m.operation === 'replace') {
            const fragment = typeof value === 'string' ? value : '';
            if (tool.completed && m.operation === 'append' && fragment) note('evidence', event.captureSeq, '同一工具已经完成，之后本地又接受了参数追加。');
            if (m.operation === 'append') tool.value += fragment; else tool.value = fragment;
            for (const ref of event.sources) {
              const use = `${key}:${ref.captureSeq}:${m.operation}`;
              if (applied.has(use) && m.operation === 'append' && fragment) note('evidence', event.captureSeq, '同一条入口来源被再次追加给同一个工具。');
              applied.add(use);
              const raw = events.get(ref.captureSeq)?.value;
              if (Buffer.isBuffer(raw) || (raw && typeof raw === 'object')) {
                try {
                  const decoded = (Buffer.isBuffer(raw) ? JSON.parse(raw.toString('utf8')) : raw) as Record<string, unknown>;
                  if (typeof decoded.delta === 'string' && decoded.delta !== fragment) note('evidence', event.captureSeq, '实际追加内容与对应入口片段不一致。');
                } catch { /* 格式损坏已由入口检查记录。 */ }
              }
            }
          }
          if (m.operation === 'complete') tool.completed = true;
          if (m.operation === 'rejected' && m.selectionReason !== 'already_emitted') note('evidence', event.captureSeq, `工具完成或片段被本地拒绝：${String(m.selectionReason)}。`);
          if (tool.value.length !== m.afterChars) note('evidence', event.captureSeq, '记录的处理后长度与实际保存片段重建结果不一致。');
          if (m.selectionReason === 'single_active_fallback' && typeof m.rawItemId === 'string' && m.rawItemId !== m.streamIndex) note('evidence', event.captureSeq, `入口工具编号 ${m.rawItemId} 不匹配，程序实际使用了唯一活动工具 ${m.callId}。`);
        }
        if (event.stage === 'ui.tool_apply' && m.mode === 'apply') {
          const key = JSON.stringify([requestKey, m.viewId, m.streamSeq, m.callId, m.operation]);
          if (uiApplied.has(key) && m.operation === 'append' && Number(m.afterChars) > Number(m.beforeChars)) note('evidence', event.captureSeq, '同一界面把同一个后端片段再次追加，参数再次增长。');
          uiApplied.add(key);
        }
        if (event.stage === 'scope.exit') note('unknown', event.captureSeq, `任务进入本次取证未覆盖的阶段：${String(m.reason ?? '')}。`);
      } catch (error) {
        result.integrity.push(`在第 ${result.events + 1} 条停止验证：${error instanceof Error ? error.message : String(error)}`); break;
      }
    }
    if (result.events !== manifest.durableSeq || payloadEnd !== manifest.payloadBytes) result.integrity.push('实际可验证前缀未达到清单截止点。');
    if (manifest.lastAcceptedSeq !== manifest.durableSeq) result.integrity.push('部分已接收事件没有到达可靠保存截止点。');
    for (const [request, sequence] of seenRequests) if (!startedRequests.has(request)) note('unknown', sequence, '未记录该次请求的发送，不能还原开启前的历史。');
    for (const [key, complete] of rawCompletions) {
      if (!tools.get(key)?.completed) note('evidence', complete.sequence, `入口收到工具 ${complete.itemKey} 的完成消息，但已保存的本地组装记录没有完成；记录截止之外的行为无法判断。`);
    }
    for (const [frame, sequence] of feedFrames) if (!uiFrames.has(frame)) note('unknown', sequence, '已发送到界面，但未收到相应界面观察记录；可能在停止边界或界面断开时缺失。');
    for (const tool of tools.values()) {
      if (result.tools.length >= 200) { result.truncated = true; break; }
      result.tools.push({ requestId: tool.requestId, callId: tool.callId, characters: tool.value.length, completed: tool.completed });
      if (!tool.completed) note('unknown', 0, `工具 ${tool.callId} 在已保存范围内没有完成；不能据此断言上游永远不会完成。`);
      const requestKey = tool.requestKey;
      if (tool.completed && stages.has('provider.output') && !backendCompleted.has(`${requestKey}:${tool.callId}`)) note('evidence', 0, `工具 ${tool.callId} 在组装层已完成，但已保存的后端统一输出中没有对应完成事件。`);
      if (backendCompleted.has(`${requestKey}:${tool.callId}`) && stages.has('ui.frame')
        && !uiCompleted.has(`${requestKey}:${tool.callId}`) && !uiCompleted.has(requestKey)) note('unknown', 0, `后端已完成工具 ${tool.callId}，但已保存的界面记录未确认完成。`);
    }
    if (!tools.size) note('unknown', 0, '未发现可重建的专用工具组装记录；其他模型格式的入口和解码记录需人工对照。');
    return result;
  });
}
