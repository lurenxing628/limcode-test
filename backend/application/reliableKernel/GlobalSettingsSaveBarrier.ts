import { randomUUID } from 'node:crypto';
import { BridgeMessageType, type GlobalSettingsFlushResultPayload } from '../../../shared/protocol';
import { toStructuredClonePlainData } from '../../../shared/plainData';

interface SettingsClient {
  postMessage(message: unknown): PromiseLike<boolean>;
}

interface PendingFlush {
  remaining: Set<string>;
  /** 已分离但尚未确认的页面；其保存状态未知，不再阻塞已提交的操作。 */
  unconfirmedDetached: Set<string>;
  /** 至少有一个存活页面完成了确认，才能把 flush 当成“已确认”。 */
  confirmed: number;
  finish(error?: Error): void;
}

/**
 * 等待所有已就绪页面提交修改；不承载配置内容，也不替代设置文件的修订检查。
 *
 * 页面关闭不等于保存失败：record-store 的写入可能已经完成并返回新 revision，只是确认消息
 * 没能送达。因此 detach 只停止等待该页面，绝不主动拒绝其他仍在进行的待定操作；真正决定
 * 成败的是 record-store 的 CAS 与修订比对。
 */
export class GlobalSettingsSaveBarrier {
  private readonly clients = new Map<string, SettingsClient>();
  private readonly pending = new Map<string, PendingFlush>();

  public constructor(private readonly timeoutMs = 15_000) {}

  public get hasClients(): boolean { return this.clients.size > 0; }

  public attach(clientId: string, client: SettingsClient): void {
    this.clients.set(clientId, client);
  }

  public detach(clientId: string): void {
    this.clients.delete(clientId);
    for (const pending of this.pending.values()) {
      // 只停止等待这个页面，绝不拒绝任何待定操作；盘上可能已经是新内容。
      if (pending.remaining.delete(clientId)) pending.unconfirmedDetached.add(clientId);
      // 仅当已经有页面真正确认过时才放行；全部页面都没确认就交给超时判定。
      if (pending.remaining.size === 0 && pending.confirmed > 0) pending.finish();
    }
  }

  public flush(): Promise<void> {
    if (this.clients.size === 0) return Promise.resolve();
    const clients = [...this.clients];
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        const ambiguous = pending !== undefined && pending.unconfirmedDetached.size > 0;
        finish(new Error(ambiguous
          // 页面已关闭但没收到确认；盘上可能已经是新内容，提示用户核对而不是断言失败。
          ? '部分设置页面在确认前已关闭，保存状态未知；请重新读取设置或重试操作。'
          : '等待设置保存确认超时，请检查设置页后重试。'));
      }, this.timeoutMs);

      const finish = (error?: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      this.pending.set(id, {
        remaining: new Set(clients.map(([clientId]) => clientId)),
        unconfirmedDetached: new Set(),
        confirmed: 0,
        finish
      });
      for (const [, client] of clients) {
        Promise.resolve().then(() => client.postMessage(toStructuredClonePlainData({
          id, type: BridgeMessageType.GlobalSettingsFlush, channel: 'settings'
        }, 'global settings flush message'))).then(
          (delivered) => { if (!delivered) finish(new Error('设置页面未收到保存确认请求，请重新打开该页面后重试。')); },
          () => finish(new Error('无法联系设置页面，请确认设置后重试。'))
        );
      }
    });
  }

  public receive(clientId: string, correlationId: string | undefined, result: GlobalSettingsFlushResultPayload): void {
    const pending = correlationId ? this.pending.get(correlationId) : undefined;
    if (!pending) return;
    // 迟到的确认仍然有效：它把"未知"重新变成"已确认"，因此 detached 集合也要接受回应。
    const tracked = pending.remaining.has(clientId) || pending.unconfirmedDetached.has(clientId);
    if (!tracked) return;
    if (result.status !== 'saved') {
      const message = result.message?.trim();
      pending.finish(new Error(message || '设置尚未保存，已暂停本次操作。'));
      return;
    }
    settle(pending, clientId);
  }
}

function settle(pending: PendingFlush, clientId: string): void {
  pending.remaining.delete(clientId);
  pending.unconfirmedDetached.delete(clientId);
  pending.confirmed += 1;
  if (pending.remaining.size === 0) pending.finish();
}
