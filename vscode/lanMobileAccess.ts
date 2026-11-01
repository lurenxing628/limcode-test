import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApplicationFacade } from './ApplicationFacade';
import type { ApplicationStartup } from './ApplicationStartup';
import { MainPanel } from './panels/MainPanel';
import type { DataRootPromptHost } from './dataRootPrompts';
import { EXTENSION_BRAND, EXTENSION_COMMAND_IDS, LAN_MOBILE_ACCESS_STATE_KEY } from '../shared/extensionIdentity';
import {
  BridgeMessageType,
  createMessageId,
  type BridgeClientId,
  type LanMobileAccessStatePayload,
  type WebviewToExtensionMessage
} from '../shared/protocol';
import { isReliableKernelControlMessage } from '../shared/reliableKernelClientFeed';

/**
 * 手机局域网访问：在本机开一个 HTTP 服务，把插件现成的聊天页面原样交给手机浏览器。
 * 手机页面像一个普通面板那样接到同一个 Facade（attachWebview），消息经 SSE 下发、经 POST 上行。
 * 默认关闭，只在用户执行命令后监听；不做鉴权，同一局域网内的设备都能访问。
 */
export const LAN_MOBILE_ACCESS_PORT = 14_319;
const SESSION_LINGER_MS = 15_000;
const SESSION_QUEUE_LIMIT = 500;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// 浏览器里没有 VS Code 注入的主题变量，给一套深色默认值。
const VSCODE_DARK_VARS_CSS = `
:root, html, body {
  color-scheme: dark;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  --vscode-editor-font-family: Consolas, "SFMono-Regular", Menlo, Monaco, monospace;
  --vscode-editor-font-size: 13px;
  --vscode-foreground: #cccccc;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #252526;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-sideBar-border: #333333;
  --vscode-sideBarSectionHeader-border: #333333;
  --vscode-panel-border: #3c3c3c;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-disabledForeground: #6b6b6b;
  --vscode-errorForeground: #f48771;
  --vscode-editorError-foreground: #f14c4c;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-notificationsWarningIcon-foreground: #cca700;
  --vscode-focusBorder: #007fd4;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #474747;
  --vscode-input-placeholderForeground: #8c8c8c;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-border: transparent;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-button-secondaryHoverBackground: #45494e;
  --vscode-editorWidget-background: #252526;
  --vscode-editorHoverWidget-background: #252526;
  --vscode-editorHoverWidget-foreground: #cccccc;
  --vscode-editorHoverWidget-border: #454545;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-inactiveSelectionBackground: #37373d;
  --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
  --vscode-textCodeBlock-background: #181818;
  --vscode-textLink-foreground: #3794ff;
  --vscode-charts-blue: #3794ff;
  --vscode-icon-foreground: #c5c5c5;
  --vscode-gitDecoration-addedResourceForeground: #81b88b;
  --vscode-gitDecoration-deletedResourceForeground: #c74e39;
  --vscode-testing-iconPassed: #73c991;
  --vscode-testing-iconPassedColor: #73c991;
  --vscode-testing-iconFailed: #f14c4c;
  --vscode-testing-iconQueued: #cca700;
  --vscode-tree-indentGuidesStroke: #585858;
  background: #1e1e1e;
  color: #cccccc;
  margin: 0;
  padding: 0;
}
#limcode-mobile-bar {
  position: sticky; top: 0; z-index: 99999;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  background: #181818; border-bottom: 1px solid #333;
  font-size: 12px; font-family: var(--vscode-font-family);
}
#limcode-mobile-bar select {
  flex: 1; min-width: 0;
  background: #2d2d2d; color: #e0e0e0; border: 1px solid #454545; border-radius: 4px;
  padding: 4px 6px; font-size: 12px;
}
#limcode-mobile-bar button {
  background: #3a3d41; color: #fff; border: none; border-radius: 4px;
  padding: 4px 8px; font-size: 12px; white-space: nowrap;
}
`;

export interface LanMobileConversation {
  id: string;
  title: string;
  isOpen: boolean;
}

export interface LanMobileAccessHost {
  application(): Promise<ApplicationFacade | undefined>;
  /** dist/webview 目录。 */
  webviewRoot: string;
  workspaceName(): string;
  /** 桌面上当前激活的对话，手机首次打开时默认进入它。 */
  activeConversationId(): string | undefined;
  openConversations(): string[];
  /** 在桌面打开对话：由本窗口接管执行，与在侧栏点开相同。 */
  openConversation(conversationId: string): Promise<void>;
}

interface MobileSession {
  clientId: BridgeClientId;
  application: ApplicationFacade;
  stream?: http.ServerResponse;
  queue: string[];
}

export class LanMobileAccessServer {
  private server: http.Server | undefined;
  private readonly sessions = new Map<string, MobileSession>();

  public constructor(private readonly host: LanMobileAccessHost) {}

  public get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  /** 先用固定端口，被另一个窗口占用时换一个空闲端口。 */
  public async start(port = LAN_MOBILE_ACCESS_PORT, hostname = '0.0.0.0'): Promise<number> {
    if (this.server) return this.port!;
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    const listen = (candidate: number) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(candidate, hostname, () => { server.off('error', reject); resolve(); });
    });
    try {
      await listen(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw error;
      await listen(0);
    }
    this.server = server;
    return this.port!;
  }

  public stop(): void {
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  public get listening(): boolean {
    return this.server !== undefined;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sid') ?? '';
    const conversationId = url.searchParams.get('cid')?.trim() || undefined;
    switch (url.pathname) {
      case '/__limcode_status': return this.sendJson(response, await this.status());
      case '/__limcode_open':
        if (conversationId) await this.host.openConversation(conversationId);
        return this.sendJson(response, { ok: true });
      case '/__limcode_new': {
        const application = await this.host.application();
        if (!application) return this.sendJson(response, { error: '运行时未就绪' }, 503);
        const created = await application.createConversation();
        await this.host.openConversation(created);
        return this.sendJson(response, { conversationId: created });
      }
      case '/__limcode_sse': return this.openStream(request, response, sessionId, conversationId);
      case '/__limcode_msg':
        if (request.method !== 'POST') break;
        return this.receive(response, sessionId, conversationId, JSON.parse((await readBody(request)).toString('utf8')));
      case '/':
      case '/index.html': return this.sendIndex(response);
    }
    this.sendAsset(response, url.pathname);
  }

  private async status(): Promise<{ workspace: string; activeConversationId: string | null; conversations: LanMobileConversation[] }> {
    const application = await this.host.application();
    const open = new Set(this.host.openConversations());
    const conversations: LanMobileConversation[] = [];
    for (const id of open) conversations.push({ id, title: application?.getConversationDisplayTitle(id) ?? id, isOpen: true });
    for (const entry of application?.getConversationHistoryEntries().slice(0, 30) ?? []) {
      if (!open.has(entry.id)) conversations.push({ id: entry.id, title: entry.title || entry.id, isOpen: false });
    }
    return { workspace: this.host.workspaceName(), activeConversationId: this.host.activeConversationId() ?? null, conversations };
  }

  private async session(sessionId: string, conversationId: string | undefined): Promise<MobileSession | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const application = await this.host.application();
    if (!application || !sessionId) return undefined;
    const session: MobileSession = { clientId: '', application, queue: [] };
    // 后端对面板只调用 postMessage，手机会话据此伪装成一个普通聊天面板。
    const webview = {
      postMessage: (message: unknown) => {
        const frame = `data: ${JSON.stringify(message)}\n\n`;
        if (session.stream && !session.stream.writableEnded) session.stream.write(frame);
        else if (session.queue.length < SESSION_QUEUE_LIMIT) session.queue.push(frame);
        return Promise.resolve(true);
      }
    } as unknown as vscode.Webview;
    session.clientId = application.attachWebview(webview, {
      kind: 'mainPanel',
      panelId: `mobile-${sessionId}`,
      title: application.getConversationDisplayTitle(conversationId),
      ...(conversationId ? { conversationId } : {})
    });
    application.setWebviewVisible(session.clientId, true);
    this.sessions.set(sessionId, session);
    return session;
  }

  private closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try { session.application.detachWebview(session.clientId); } catch { /* Runtime 已关闭 */ }
    session.stream?.end();
  }

  private async openStream(request: http.IncomingMessage, response: http.ServerResponse, sessionId: string, conversationId: string | undefined): Promise<void> {
    const session = await this.session(sessionId, conversationId);
    if (!session) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`${EXTENSION_BRAND} 运行时未就绪`);
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    response.write(': connected\n\n');
    session.stream = response;
    for (const frame of session.queue.splice(0)) response.write(frame);
    // 手机切到后台会断开；EventSource 用同一个 sid 重连时接回原会话，久不回来才释放。
    request.on('close', () => setTimeout(() => {
      if (this.sessions.get(sessionId)?.stream === response) this.closeSession(sessionId);
    }, SESSION_LINGER_MS).unref());
  }

  private async receive(response: http.ServerResponse, sessionId: string, conversationId: string | undefined, raw: unknown): Promise<void> {
    const session = await this.session(sessionId, conversationId);
    if (!session) return this.sendJson(response, { error: '运行时未就绪' }, 503);
    const { application, clientId } = session;
    if (isReliableKernelControlMessage(raw)) {
      void Promise.resolve(application.handleReliableKernelControl?.(clientId, raw))
        .catch((error) => console.warn('[LimCode] Mobile client feed control failed.', error));
      return this.sendJson(response, { ok: true });
    }
    const message = raw as WebviewToExtensionMessage;
    // 打开或新建对话在桌面面板上进行，手机随后整页切到那个对话。
    if (message.type === BridgeMessageType.ConversationOpen && message.payload?.conversationId?.trim()) {
      const target = message.payload.conversationId.trim();
      await this.host.openConversation(target);
      return this.sendJson(response, { ok: true, redirectCid: target });
    }
    if (message.type === BridgeMessageType.ConversationCreate) {
      const projectFolderUri = message.payload?.projectFolderUri?.trim();
      const target = await application.createConversation(projectFolderUri ? { projectFolderUri } : {});
      await this.host.openConversation(target);
      return this.sendJson(response, { ok: true, redirectCid: target });
    }
    application.handleWebviewMessage(clientId, message);
    this.sendJson(response, { ok: true });
  }

  private sendIndex(response: http.ServerResponse): void {
    const indexPath = path.join(this.host.webviewRoot, 'index.html');
    if (!fs.existsSync(indexPath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('没有找到 webview 构建产物');
      return;
    }
    const html = fs.readFileSync(indexPath, 'utf8')
      .replace('<head>', `<head><style>${VSCODE_DARK_VARS_CSS}</style><script>${mobileShim(this.host.activeConversationId() ?? '', this.host.workspaceName())}</script>`);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
  }

  private sendAsset(response: http.ServerResponse, pathname: string): void {
    const root = path.resolve(this.host.webviewRoot);
    const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  }

  private sendJson(response: http.ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
  }
}

/** 页面里替代 acquireVsCodeApi：下行用 EventSource，上行按顺序 POST。 */
function mobileShim(initialConversationId: string, workspaceName: string): string {
  return `(() => {
  // 局域网 http 不是安全上下文，浏览器不提供 randomUUID。
  if (!crypto.randomUUID) crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'
    .replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  const cid = new URLSearchParams(location.search).get('cid') || ${JSON.stringify(initialConversationId)};
  const sid = crypto.randomUUID();
  const query = '?sid=' + encodeURIComponent(sid) + '&cid=' + encodeURIComponent(cid);
  const open = target => { location.href = '/?cid=' + encodeURIComponent(target); };
  new EventSource('/__limcode_sse' + query).onmessage = event => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }));
  };
  let state = { kind: 'mainPanel', conversationId: cid };
  let sending = Promise.resolve();
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      // 逐条发送，保持和面板 postMessage 相同的先后顺序。
      sending = sending.then(() => fetch('/__limcode_msg' + query, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message)
      })).then(response => response.json()).then(result => { if (result && result.redirectCid) open(result.redirectCid); })
        .catch(error => console.error('[LimCode Mobile] postMessage failed', error));
    },
    getState: () => state,
    setState: next => (state = next)
  });
  window.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.id = 'limcode-mobile-bar';
    bar.innerHTML = '<b></b><select><option>正在加载对话…</option></select><button data-new>＋新对话</button><button data-reload>↻</button>';
    bar.querySelector('b').textContent = ${JSON.stringify(workspaceName)};
    document.body.prepend(bar);
    const select = bar.querySelector('select');
    fetch('/__limcode_status').then(response => response.json()).then(data => {
      select.innerHTML = '';
      for (const item of data.conversations) {
        const option = new Option((item.isOpen ? '● ' : '') + item.title, item.id);
        option.selected = item.id === (cid || data.activeConversationId);
        select.add(option);
      }
    });
    select.addEventListener('change', () => {
      if (select.value) fetch('/__limcode_open?cid=' + encodeURIComponent(select.value), { method: 'POST' }).finally(() => open(select.value));
    });
    bar.querySelector('[data-new]').addEventListener('click', () => {
      fetch('/__limcode_new', { method: 'POST' }).then(response => response.json()).then(data => { if (data.conversationId) open(data.conversationId); });
    });
    bar.querySelector('[data-reload]').addEventListener('click', () => location.reload());
  });
})();`;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** 局域网 IPv4 地址；跳过代理软件的 198.18 虚拟网卡和 WSL/Docker 网卡，没有其它地址时才用它们。 */
export function lanAddresses(): string[] {
  const all: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list ?? []) if (item.family === 'IPv4' && !item.internal) all.push({ name, address: item.address });
  }
  const preferred = all.filter(({ name, address }) => !address.startsWith('198.18.') && !/vEthernet|WSL|Docker/i.test(name));
  return (preferred.length > 0 ? preferred : all).map(({ address }) => address);
}

let activeServer: LanMobileAccessServer | undefined;
let statusItem: vscode.StatusBarItem | undefined;
/** Settings pages showing the switch; each gets the new state whenever it changes. */
const watchingClients = new Set<BridgeClientId>();
let lastError: string | undefined;

/**
 * 命令入口。设置页带着 clientId 调用：带 enabled 时开关，否则只读取状态；之后把状态发回设置页。
 * 命令面板和状态栏不带参数：未开启时开启，然后给出地址，可复制或关闭。
 */
export async function lanMobileAccessCommand(context: vscode.ExtensionContext, startup: ApplicationStartup, request?: unknown): Promise<void> {
  const { clientId, enabled } = (request ?? {}) as { clientId?: unknown; enabled?: unknown };
  if (typeof clientId === 'string' && clientId) {
    watchingClients.add(clientId);
    if (typeof enabled === 'boolean') await setLanMobileAccess(context, startup, enabled);
    else postState(startup, [clientId]);
    return;
  }
  if (!activeServer) await setLanMobileAccess(context, startup, true);
  if (!activeServer) {
    await vscode.window.showErrorMessage(`${EXTENSION_BRAND} 远程访问开启失败：${lastError ?? '未知原因'}`);
    return;
  }
  const urls = currentUrls();
  const choice = await vscode.window.showInformationMessage(
    `${EXTENSION_BRAND} 远程访问已开启：${urls[0]}`,
    { detail: `同一局域网内的设备都能打开并操作对话，不用时请关闭。${urls.length > 1 ? `
其它地址：${urls.slice(1).join('  ')}` : ''}` },
    '复制地址', '关闭'
  );
  if (choice === '复制地址') await vscode.env.clipboard.writeText(urls[0]);
  if (choice === '关闭') await setLanMobileAccess(context, startup, false);
}

/** 这个窗口上次开着就在启动时接着开；只监听端口，手机连上来才启动运行时。 */
export async function restoreLanMobileAccess(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  if (!activeServer) await start(context, startup);
}

async function setLanMobileAccess(context: vscode.ExtensionContext, startup: ApplicationStartup, enabled: boolean): Promise<void> {
  await context.workspaceState.update(LAN_MOBILE_ACCESS_STATE_KEY, enabled);
  if (enabled && !activeServer) await start(context, startup);
  if (!enabled) stop();
  postState(startup, [...watchingClients]);
}

async function start(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  const server = new LanMobileAccessServer({
    application: () => startup.wait(),
    webviewRoot: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview').fsPath,
    workspaceName: () => vscode.workspace.name ?? 'VS Code',
    activeConversationId: () => MainPanel.getOpenConversationPanelStates().find((item) => item.active)?.conversationId
      ?? MainPanel.getOpenConversationPanelStates().find((item) => item.visible)?.conversationId,
    openConversations: () => MainPanel.getOpenConversationPanelStates().map((item) => item.conversationId),
    openConversation: async (conversationId) => {
      await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.openPanel, { conversationId, reuse: true });
    }
  });
  try {
    await server.start();
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return;
  }
  lastError = undefined;
  activeServer = server;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
  statusItem.command = EXTENSION_COMMAND_IDS.lanMobileAccess;
  statusItem.text = `$(remote) 远程访问 :${server.port}`;
  statusItem.tooltip = `${EXTENSION_BRAND} 远程访问已开启：${currentUrls().join('  ')}
点击复制地址或关闭`;
  statusItem.show();
  context.subscriptions.push({ dispose: stop });
}

function stop(): void {
  activeServer?.stop();
  activeServer = undefined;
  statusItem?.dispose();
  statusItem = undefined;
}

function currentUrls(): string[] {
  if (!activeServer) return [];
  const urls = lanAddresses().map((address) => `http://${address}:${activeServer!.port}`);
  return urls.length > 0 ? urls : [`http://127.0.0.1:${activeServer.port}`];
}

function postState(startup: ApplicationStartup, clientIds: BridgeClientId[]): void {
  const host = startup.current() as Partial<DataRootPromptHost> | undefined;
  if (typeof host?.postToWebview !== 'function') return;
  const payload: LanMobileAccessStatePayload = { enabled: activeServer !== undefined, urls: currentUrls(), ...(lastError ? { error: lastError } : {}) };
  for (const clientId of clientIds) {
    const posted = host.postToWebview(clientId, { id: createMessageId(), type: BridgeMessageType.LanMobileAccessState, channel: 'settings', payload });
    if (!posted) watchingClients.delete(clientId);
  }
}
