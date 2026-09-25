#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '../..');
const HOST = '127.0.0.1';
const PORT = 31_820;
const WEBVIEW_URL = `http://${HOST}:${PORT}/`;
const FIXTURE_NOW = 1_788_739_200_000;
const CLIENT_ID = 'playwright-compression-settings';
const REQUIRED_SETTINGS_SECTIONS = [
  'common',
  'llm',
  'llmProviderConfigs',
  'llmCompression',
  'llmCompressionConfigs',
  'checkpointMaintenance',
  'appearance',
  'attachments',
  'mcpServers'
];
const VIEWPORTS = [
  { name: 'desktop', width: 1_440, height: 1_000 },
  { name: 'narrow', width: 700, height: 1_000 }
];

const VSCODE_THEME_FIXTURE = `
  :root {
    color-scheme: dark;
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --vscode-editor-font-family: "SFMono-Regular", Consolas, monospace;
    --vscode-editor-background: #181818;
    --vscode-editor-foreground: #d4d4d4;
    --vscode-foreground: #d4d4d4;
    --vscode-descriptionForeground: #a7a7a7;
    --vscode-panel-border: #3b3b3b;
    --vscode-focusBorder: #8b8b8b;
    --vscode-input-background: #242424;
    --vscode-input-foreground: #f0f0f0;
    --vscode-input-border: #484848;
    --vscode-button-foreground: #f0f0f0;
    --vscode-button-background: #454545;
    --vscode-button-hoverBackground: #555555;
    --vscode-button-secondaryForeground: #d4d4d4;
    --vscode-button-secondaryBackground: #2d2d2d;
    --vscode-button-secondaryHoverBackground: #3b3b3b;
    --vscode-list-hoverBackground: #303030;
    --vscode-textCodeBlock-background: #242424;
    --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.35);
    --vscode-scrollbarSlider-hoverBackground: rgba(145, 145, 145, 0.5);
    --vscode-scrollbarSlider-activeBackground: rgba(165, 165, 165, 0.62);
  }
`;

const fixtureProvider = {
  id: 'provider-openai-responses',
  name: 'GPT 372k',
  provider: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.4',
  models: [{ id: 'gpt-5.4', name: 'GPT 5.4' }],
  apiKey: '',
  toolCallFormat: 'function-call',
  openaiResponsesTransport: 'http',
  stream: true,
  retryOnError: true,
  retryMaxAttempts: 4,
  enableMultimodalTools: true,
  contextWindowTokens: 372_000,
  systemPromptPrefix: '',
  promptCache: { enabled: true, mode: 'key', ttl: '30m' },
  headers: {},
  generationConfig: {},
  requestBody: {},
  modelConfigs: [],
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW
};

const fixtureCompressionConfig = {
  id: 'compression-openai-native',
  name: 'Provider 原生压缩',
  kind: 'provider_native',
  trigger: {
    mode: 'token_threshold',
    thresholdUnit: 'tokens',
    thresholdTokens: 330_000,
    thresholdPercent: 88.70967741935483
  },
  providerNative: {
    providerConfigId: fixtureProvider.id,
    model: fixtureProvider.model
  },
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW
};

const SETTINGS_FIXTURES = {
  common: {
    dataFilePath: '/tmp/limcode-playwright-fixture',
    proxy: '',
    activeDataRootPath: '/tmp/limcode-playwright-fixture',
    defaultDataRootPath: '/tmp/limcode-playwright-fixture'
  },
  llm: { activeProviderConfigId: fixtureProvider.id },
  llmProviderConfigs: { configs: [fixtureProvider] },
  llmCompression: {
    defaultConfigId: fixtureCompressionConfig.id,
    providerBindings: [{
      id: 'compression-binding-openai',
      providerConfigId: fixtureProvider.id,
      compressionConfigId: fixtureCompressionConfig.id,
      role: 'default',
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW
    }],
    modelBindings: []
  },
  llmCompressionConfigs: { configs: [fixtureCompressionConfig] },
  checkpointMaintenance: {
    autoCleanupEnabled: true,
    autoCleanupDays: 7,
    autoDismissEnabled: true,
    autoDismissSeconds: 5
  },
  appearance: {
    streamingTextPreparing: '正在整理上下文',
    streamingTextWaiting: '正在等待响应',
    streamingTextThinking: '正在思考',
    streamingTextWriting: '正在编写',
    streamingTextToolExecuting: '正在执行工具'
  },
  attachments: { maxStoredInlineFileMb: 20 },
  mcpServers: { servers: [] }
};

// A complete ClientState, matching shared/clientStateSchema.ts:createEmptyClientState().
// Keep this self-contained: the visual harness must run without compiled extension artifacts.
const EMPTY_CONFIGURATION_STATE = Object.fromEntries([
  'agents',
  'toolDefinitions',
  'mcpToolSources',
  'workflows',
  'planReviewPolicies',
  'planReviewPolicyScopeLinks',
  'planProposals',
  'runPlanProposalLinks',
  'toolPolicies',
  'toolPolicyScopeLinks',
  'builtinToolPolicies',
  'skillDefinitions',
  'skillPolicies',
  'skillPolicyScopeLinks',
  'ruleFiles',
  'systemPrompts',
  'systemPromptScopeLinks',
  'promptPlaceholders',
  'runtimeContexts',
  'runtimeContextScopeLinks',
  'runtimeContextSnapshots',
  'conversationRuntimeContextSnapshotLinks',
  'runRuntimeContextSnapshotLinks',
  'modelProfiles',
  'modelProfileScopeLinks',
  'conversationWorkflowSelections',
  'conversations',
  'conversationReuseLinks',
  'conversationBranchLinks',
  'conversationOriginLinks',
  'agentConversationLinks',
  'conversationAgentSelections',
  'projectContexts',
  'conversationProjectLinks',
  'workEnvironments',
  'workEnvironmentPolicies',
  'workEnvironmentPolicyScopeLinks',
  'conversationWorkEnvironmentLinks',
  'runWorkEnvironmentLinks',
  'checkpointPolicies',
  'checkpointPolicyScopeLinks',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors',
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'modelContextProjections',
  'modelContextProjectionSourceLinks',
  'requestModelContextProjectionLinks',
  'compressionModelContextProjectionLinks',
  'compressionBlocks',
  'compressionBlockSourceLinks',
  'compressionContextVariants',
  'runCompressionBlockLinks',
  'compressionBlockLlmInvocationLinks',
  'llmInvocations',
  'runLlmInvocationLinks',
  'messageLlmInvocationLinks',
  'toolCalls',
  'toolCallPreviews',
  'toolCallPreviewTargetLinks',
  'toolCallEvents',
  'toolResultArtifacts',
  'toolCallResultLinks',
  'interactionRequests',
  'interactionOwnerLinks',
  'interactionResponses',
  'backgroundProcesses',
  'backgroundProcessOriginLinks',
  'turns',
  'turnIntents',
  'turnIntentRevisions',
  'pendingTurnInputs',
  'executionLeases',
  'authoritySnapshots',
  'runtimeDeliveryLinks',
  'agentRuns',
  'runTerminations',
  'agentRunSourceLinks',
  'agentRunTargetLinks',
  'messageTurnLinks',
  'toolCallRunLinks',
  'runConversationPolicies',
  'runContextPolicies',
  'runDeliveryPolicies',
  'runEditPolicies',
  'runWorkflowLinks',
  'runSystemPromptLinks',
  'runModelProfileLinks',
  'runToolPolicyLinks',
  'runConversationPolicyLinks',
  'runContextPolicyLinks',
  'runDeliveryPolicyLinks',
  'runEditPolicyLinks',
  'agentRunInputRevisions',
  'agentAnswers',
  'agentAnswerSubmissionLinks',
  'agentAnswerTargetLinks'
].map((key) => [key, []]));

async function main() {
  const outputDirectory = process.env.LIMCODE_VISUAL_OUTPUT_DIR
    ? path.resolve(process.env.LIMCODE_VISUAL_OUTPUT_DIR)
    : await mkdtemp(path.join(os.tmpdir(), 'limcode-compression-visual-'));
  const { chromium, version: playwrightVersion, source: playwrightSource } = await loadPlaywright();
  const vite = await ensureViteServer();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.LIMCODE_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: path.resolve(process.env.LIMCODE_CHROMIUM_EXECUTABLE_PATH) }
        : {}),
      args: ['--disable-dev-shm-usage']
    });

    const results = [];
    for (const viewport of VIEWPORTS) {
      results.push(await verifyViewport(browser, viewport, outputDirectory));
    }

    const failures = results.flatMap((result) => [
      ...result.pageErrors.map((message) => `${result.viewport}: pageerror: ${message}`),
      ...result.consoleErrors.map((message) => `${result.viewport}: console.error: ${message}`),
      ...result.failedRequests.map((message) => `${result.viewport}: requestfailed: ${message}`)
    ]);
    const report = {
      ok: failures.length === 0,
      url: WEBVIEW_URL,
      outputDirectory,
      playwrightVersion,
      playwrightSource,
      viteStartedByScript: vite.owned,
      results,
      failures
    };
    await writeFile(
      path.join(outputDirectory, 'visual-verification.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );

    if (failures.length > 0) {
      throw new Error(`目视验证捕获到 ${failures.length} 个页面错误：\n${failures.join('\n')}`);
    }

    console.log(`Playwright ${playwrightVersion} 压缩设置目视验证通过。`);
    console.log(`截图与报告：${outputDirectory}`);
    for (const result of results) {
      console.log(`- ${result.viewport}: ${result.screenshot}`);
      if (result.consoleWarnings.length > 0) {
        console.log(`  console.warn: ${result.consoleWarnings.length} 条（已写入报告）`);
      }
    }
  } finally {
    await browser?.close();
    await vite.stop();
  }
}

async function verifyViewport(browser, viewport, outputDirectory) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  await page.route('**/favicon.ico', (route) => route.fulfill({
    status: 204,
    body: ''
  }));
  const pageErrors = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];

  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    if (message.type() === 'warning') consoleWarnings.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.startsWith('ws://') || url.startsWith('wss://')) return;
    failedRequests.push(`${request.method()} ${url}: ${request.failure()?.errorText ?? 'unknown failure'}`);
  });

  try {
    await page.addInitScript(() => {
      window.__limcodeMockHostPostedMessages = [];
      const originalDebug = console.debug.bind(console);
      console.debug = (...args) => {
        if (args[0] === '[mock host] postMessage:' && args[1] && typeof args[1] === 'object') {
          window.__limcodeMockHostPostedMessages.push(args[1]);
        }
        originalDebug(...args);
      };
    });

    await page.goto(WEBVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.addStyleTag({ content: VSCODE_THEME_FIXTURE });
    await page.locator('#app').waitFor({ state: 'attached' });
    const isMockHost = await page.evaluate(() => typeof window.acquireVsCodeApi !== 'function');
    assert(isMockHost, '页面意外进入了 VS Code Host 路径，未使用 mock host');

    await postHostMessage(page, helloMessage());
    await postHostMessage(page, configurationSnapshotMessage());
    await page.getByText('Limcode test 全局设置', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(
      (sections) => sections.every((section) => window.__limcodeMockHostPostedMessages.some(
        (message) => message?.type === 'settings.global.get' && message?.payload?.section === section
      )),
      REQUIRED_SETTINGS_SECTIONS,
      { timeout: 10_000 }
    );

    for (const section of REQUIRED_SETTINGS_SECTIONS) {
      await postHostMessage(page, settingsSnapshotMessage(section, SETTINGS_FIXTURES[section]));
    }

    const compressionSection = page.locator('section[aria-label="上下文压缩"]').first();
    await compressionSection.waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.channel-content[aria-busy="false"]').waitFor({ state: 'visible', timeout: 10_000 });
    await compressionSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);

    await compressionSection.getByText('当前策略：Provider 原生压缩', { exact: false }).waitFor({ state: 'visible' });
    await compressionSection.getByText('完整输入 Token 触发阈值', { exact: true }).waitFor({ state: 'visible' });
    await compressionSection.getByText('对话主体目标为', { exact: false }).first().waitFor({ state: 'visible' });
    const thresholdInput = compressionSection.locator('input.token-number-input').first();
    assert(await thresholdInput.inputValue() === '330000', '压缩阈值没有显示 mock snapshot 中的 330000 token');
    const thresholdSlider = compressionSection.getByLabel('拖拽调整自动压缩触发阈值');
    await thresholdSlider.waitFor({ state: 'visible' });
    const sliderAttributes = await thresholdSlider.evaluate((element) => ({
      min: element.min,
      max: element.max,
      step: element.step
    }));
    assert(sliderAttributes.min === '0', `滑块没有使用从 0 开始的离散位置：${sliderAttributes.min}`);
    assert(sliderAttributes.step === '1', `滑块没有使用整数位置步长：${sliderAttributes.step}`);
    assert(Number(sliderAttributes.max) < fixtureProvider.contextWindowTokens, '滑块仍直接把大 Token 数交给原生 range');

    const saveStartIndex = await page.evaluate(() => window.__limcodeMockHostPostedMessages.length);
    await thresholdSlider.scrollIntoViewIfNeeded();
    const sliderBox = await thresholdSlider.boundingBox();
    assert(sliderBox, '无法读取压缩阈值滑块的位置');
    await page.mouse.click(
      sliderBox.x + sliderBox.width * 0.6,
      sliderBox.y + sliderBox.height / 2
    );
    await page.waitForFunction(
      () => Number(document.querySelector('input.token-number-input')?.value) > 1_000,
      undefined,
      { timeout: 5_000 }
    );
    const adjustedThreshold = Number(await thresholdInput.inputValue());
    assert(Number.isSafeInteger(adjustedThreshold), `滑块调整后不是安全整数：${adjustedThreshold}`);
    assert(adjustedThreshold >= 1_000, `滑块调整后错误回落到 ${adjustedThreshold} token`);
    assert(adjustedThreshold % 1_000 === 0, `滑块调整后没有保持 1k 对齐：${adjustedThreshold}`);
    const saveRecovery = await verifySaveRecovery(page, saveStartIndex);
    await page.locator('.channel-content[aria-busy="false"]').waitFor({ state: 'visible' });
    assert(Number(await thresholdInput.inputValue()) === adjustedThreshold, '保存恢复覆盖了刚调整的阈值');

    const layout = await compressionSection.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentScrollWidth: document.documentElement.scrollWidth
      };
    });
    assert(layout.left >= -1, `压缩区左侧超出视口：${layout.left}px`);
    assert(layout.right <= layout.viewportWidth + 1, `压缩区右侧超出视口：${layout.right}px > ${layout.viewportWidth}px`);
    assert(layout.documentScrollWidth <= layout.viewportWidth + 1, `页面出现横向溢出：${layout.documentScrollWidth}px > ${layout.viewportWidth}px`);

    const screenshot = path.join(outputDirectory, `compression-settings-${viewport.name}.png`);
    await page.screenshot({ path: screenshot, animations: 'disabled' });

    const featureAssertions = await verifyCapabilityInteractions(page, compressionSection);
    return {
      viewport: viewport.name,
      width: viewport.width,
      height: viewport.height,
      screenshot,
      layout,
      saveRecovery,
      featureAssertions,
      pageErrors,
      consoleErrors,
      consoleWarnings,
      failedRequests,
      mockHostPostedMessageCount: await page.evaluate(() => window.__limcodeMockHostPostedMessages.length)
    };
  } finally {
    await context.close();
  }
}

async function verifyCapabilityInteractions(page, section) {
  const probeCount = () => page.evaluate(() => window.__limcodeMockHostPostedMessages
    .filter((message) => message?.payload?.probeNative === true).length);
  assert(await probeCount() === 0, '渲染或保存设置意外触发了付费端点探测');
  const writesBefore = await page.evaluate(() => window.__limcodeMockHostPostedMessages
    .filter((message) => message.type === 'settings.global.update').length);
  await section.getByText('高级摘要参数', { exact: true }).click();
  await section.getByLabel('摘要 generationConfig JSON').fill('{"maxOutputTokens":0}');
  await section.getByRole('button', { name: '应用摘要参数', exact: true }).click();
  await section.getByRole('alert').filter({ hasText: '正整数' }).waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  const writesAfter = await page.evaluate(() => window.__limcodeMockHostPostedMessages
    .filter((message) => message.type === 'settings.global.update').length);
  assert(writesAfter === writesBefore, '非法摘要输出预算仍触发了设置保存');
  await section.getByRole('button', { name: '验证原生端点（会调用一次）', exact: true }).click();
  await page.waitForFunction(() => window.__limcodeMockHostPostedMessages.some((message) => message?.payload?.probeNative === true));
  assert(await probeCount() === 1, '一次用户点击没有对应一个显式探测请求');
  const payload = await page.evaluate(() => window.__limcodeMockHostPostedMessages.find((message) => message?.payload?.probeNative === true).payload);
  assert(payload.config && !payload.contents && !payload.messages && !payload.conversationId,
    '探测命令包含实际对话内容或缺少目标渠道');
  return { noAutomaticProbe: true, invalidBudgetNotSaved: true, explicitProbeCount: 1, probeHasNoConversation: true };
}

async function verifySaveRecovery(page, startIndex) {
  const disk = structuredClone(SETTINGS_FIXTURES);
  const revisions = Object.fromEntries(Object.keys(disk).map((section) => [section, `playwright-${section}-revision`]));
  const flushId = 'playwright-save-before-execution';
  await postHostMessage(page, { id: flushId, type: 'settings.global.flush', channel: 'settings', clientId: CLIENT_ID });
  let index = startIndex;
  let writes = 0;
  let droppedConfirmation = false;
  let recoveryRead = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const messages = await page.evaluate((offset) => window.__limcodeMockHostPostedMessages.slice(offset), index);
    index += messages.length;
    for (const message of messages) {
      if (message.type === 'settings.global.update') {
        const section = message.payload.section;
        assert(message.payload.expectedRevision === revisions[section], `保存没有使用当前版本：${section}`);
        disk[section] = message.payload.settings;
        if (section === 'llmCompressionConfigs' || section === 'llmProviderConfigs') {
          disk[section] = { configs: disk[section].configs.map((config) => ({ ...config, updatedAt: Date.now() })) };
        }
        revisions[section] = `playwright-save-${++writes}`;
        if (!droppedConfirmation && section === 'llmCompressionConfigs') {
          droppedConfirmation = true;
          continue;
        }
        await postHostMessage(page, {
          ...settingsSnapshotMessage(section, disk[section]), correlationId: message.id,
          payload: { ...settingsSnapshotMessage(section, disk[section]).payload, revision: revisions[section] }
        });
      } else if (message.type === 'settings.global.get') {
        const section = message.payload.section;
        if (droppedConfirmation && section === 'llmCompressionConfigs') recoveryRead = true;
        await postHostMessage(page, {
          ...settingsSnapshotMessage(section, disk[section]), correlationId: message.id,
          payload: { ...settingsSnapshotMessage(section, disk[section]).payload, revision: revisions[section] }
        });
      } else if (message.type === 'settings.global.flush.result' && message.correlationId === flushId) {
        assert(message.payload.status === 'saved', `保存前置确认失败：${message.payload.message}`);
        assert(droppedConfirmation && recoveryRead, '没有经过保存确认丢失后的磁盘核对');
        await page.waitForTimeout(500);
        const extraWrites = await page.evaluate((offset) => window.__limcodeMockHostPostedMessages.slice(offset)
          .filter((item) => item.type === 'settings.global.update').length, index);
        assert(extraWrites === 0, '保存完成后仍在无修改重复保存');
        return { droppedConfirmation, recoveryRead, writes, completed: true };
      }
    }
    await page.waitForTimeout(25);
  }
  throw new Error('保存确认恢复未在有界时间内完成。');
}

function helloMessage() {
  return {
    id: 'playwright-hello',
    type: 'bridge.hello',
    channel: 'control',
    clientId: CLIENT_ID,
    payload: {
      clientId: CLIENT_ID,
      attachedAt: FIXTURE_NOW,
      meta: {
        kind: 'globalSettings',
        panelId: 'playwright-global-settings',
        title: 'Playwright 压缩设置验证'
      },
      runtime: {
        extensionName: 'limcode-test',
        extensionVersion: 'playwright-fixture',
        providerVersion: 'playwright-fixture',
        webSocketVersion: 'playwright-fixture',
        proxyAgentVersion: 'playwright-fixture',
        wsImplementation: 'playwright-fixture',
        buildFingerprint: 'playwright-fixture',
        currentBuildFingerprint: 'playwright-fixture',
        reloadRequired: false,
        runtimeInstanceId: 'playwright-runtime',
        activatedAt: FIXTURE_NOW,
        processId: process.pid,
        nodeVersion: process.version
      }
    }
  };
}

function settingsSnapshotMessage(section, settings) {
  return {
    id: `playwright-settings-${section}`,
    type: 'settings.global.snapshot',
    channel: 'settings',
    clientId: CLIENT_ID,
    scope: { kind: 'settings', level: 'global', id: section },
    payload: {
      section,
      settings,
      filePath: `/tmp/limcode-playwright-fixture/settings/${section}.json`,
      revision: `playwright-${section}-revision`
    }
  };
}

function configurationSnapshotMessage() {
  return {
    id: 'playwright-configuration-snapshot',
    type: 'configuration.snapshot',
    channel: 'state',
    clientId: CLIENT_ID,
    scope: { kind: 'global' },
    payload: {
      state: EMPTY_CONFIGURATION_STATE,
      loadedAt: FIXTURE_NOW
    }
  };
}

async function postHostMessage(page, message) {
  await page.evaluate((payload) => window.postMessage(payload, '*'), message);
}

async function loadPlaywright() {
  const candidates = [];
  if (process.env.LIMCODE_PLAYWRIGHT_MODULE) {
    candidates.push({
      label: 'LIMCODE_PLAYWRIGHT_MODULE',
      resolve: () => path.resolve(process.env.LIMCODE_PLAYWRIGHT_MODULE)
    });
  }

  const repositoryRequire = createRequire(import.meta.url);
  candidates.push({ label: 'repository dependency', resolve: () => repositoryRequire.resolve('playwright') });

  const visualHarnessRoot = path.join(os.homedir(), '.local', 'share', 'limcode-visual-test');
  const visualHarnessRequire = createRequire(path.join(visualHarnessRoot, 'package.json'));
  candidates.push({ label: visualHarnessRoot, resolve: () => visualHarnessRequire.resolve('playwright') });

  const errors = [];
  for (const candidate of candidates) {
    try {
      const resolved = candidate.resolve();
      const module = await import(pathToFileURL(resolved).href);
      const chromium = module.chromium ?? module.default?.chromium;
      if (!chromium) throw new Error('模块没有导出 chromium');
      const packageRequire = createRequire(resolved);
      const packageJson = packageRequire('playwright/package.json');
      return { chromium, version: packageJson.version, source: candidate.label };
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error([
    '找不到可用的 Playwright。可以在项目中安装 playwright，或设置 LIMCODE_PLAYWRIGHT_MODULE 指向其入口文件。',
    ...errors
  ].join('\n'));
}

async function ensureViteServer() {
  if (await isExpectedWebviewServer()) {
    return { owned: false, stop: async () => {} };
  }

  const viteEntry = path.join(REPOSITORY_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const output = [];
  const child = spawn(process.execPath, [viteEntry, '--host', HOST, '--port', String(PORT), '--strictPort'], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite 提前退出（${child.exitCode}）：\n${output.join('')}`);
    }
    if (await isExpectedWebviewServer()) {
      return {
        owned: true,
        stop: () => stopChild(child)
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  await stopChild(child);
  throw new Error(`等待 Vite 启动超时：\n${output.join('')}`);
}

async function isExpectedWebviewServer() {
  try {
    const response = await fetch(WEBVIEW_URL, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const html = await response.text();
    return html.includes('Limcode test') && html.includes('/src/main.ts');
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    stopped,
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
