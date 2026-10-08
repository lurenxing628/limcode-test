import { randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';
import * as path from 'node:path';
import { LOADED_RUNTIME_BUILD } from './runtimeBuildIdentity';
import type { RuntimeBuildInfoRecord } from '../../shared/protocol';
import { EXTENSION_PACKAGE_NAME, EXTENSION_VERSION } from '../../shared/extensionIdentity';
import { LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION } from '../capabilities/openAIResponsesWebSocketIdentity';

const activatedAt = Date.now();
const runtimeInstanceId = randomUUID();
const providerVersion = readPackageVersion('unified-llm-provider');
const webSocketVersion = readPackageVersion('ws');
const proxyAgentVersion = readPackageVersion('https-proxy-agent');
const buildModulePaths = runtimeModulePaths();
const activatedBuildFiles = currentBuildFileState();
const activatedBuildFingerprint = LOADED_RUNTIME_BUILD.buildId ?? runtimeInstanceId;
let observedBuildFiles = activatedBuildFiles;
let currentBuildFingerprint = activatedBuildFingerprint;

export const RUNTIME_BUILD_INFO: RuntimeBuildInfoRecord = Object.freeze({
  extensionName: EXTENSION_PACKAGE_NAME,
  extensionVersion: EXTENSION_VERSION,
  providerVersion,
  webSocketVersion,
  proxyAgentVersion,
  wsImplementation: LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION,
  buildFingerprint: activatedBuildFingerprint,
  currentBuildFingerprint: activatedBuildFingerprint,
  reloadRequired: false,
  runtimeInstanceId,
  activatedAt,
  processId: process.pid,
  nodeVersion: process.version
});

/**
 * 编译会替换模块文件；握手只比较文件身份，变化时更新诊断标识，不重新读取和散列正文。
 */
export function getRuntimeBuildInfo(): RuntimeBuildInfoRecord {
  const currentFiles = currentBuildFileState();
  if (currentFiles !== observedBuildFiles) {
    observedBuildFiles = currentFiles;
    currentBuildFingerprint = currentFiles === activatedBuildFiles ? activatedBuildFingerprint : randomUUID();
  }
  const reloadRequired = currentBuildFingerprint !== RUNTIME_BUILD_INFO.buildFingerprint;
  return {
    ...RUNTIME_BUILD_INFO,
    currentBuildFingerprint,
    reloadRequired,
    ...(reloadRequired ? { reloadReason: 'extension_files_changed' as const } : {})
  };
}

function readPackageVersion(packageName: string): string {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const record = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof record.version === 'string' && record.version.trim() ? record.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function currentBuildFileState(): string {
  return JSON.stringify(buildModulePaths.map(modulePath => {
    try {
      const stat = statSync(modulePath, { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    } catch {
      return 'unreadable';
    }
  }));
}

function runtimeModulePaths(): string[] {
  const paths = [__filename, path.join(__dirname, '../../compile-build-id.json')];
  for (const moduleId of [
    '../capabilities/llmProvider',
    '../capabilities/llmStreamEventProjection',
    '../capabilities/geminiProviderAdaptation',
    '../capabilities/unifiedMessageConversion',
    '../capabilities/llmRequestContentPreparation',
    '../capabilities/openAIResponsesWebSocketSession',
    '../capabilities/openAIResponsesWebSocketConnection',
    '../capabilities/openAIResponsesWebSocketMultiplexer',
    '../capabilities/openAIResponsesNativeControl',
    '../../shared/openAIResponsesCapabilities',
    '../reliableKernel/nativeToolFacts',
    '../reliableKernel/nativeSteering',
    '../reliableKernel/nativeRequestSession',
    '../reliableKernel/nativeCompressionGuard',
    '../reliableKernel/conversationForkContext',
    '../capabilities/llmStreamEventBatcher',
    '../reliableKernel/webviewFeedBridge',
    '../../shared/protocol',
    'unified-llm-provider/package.json',
    'ws/package.json',
    'https-proxy-agent/package.json'
  ]) {
    try {
      paths.push(require.resolve(moduleId));
    } catch {
      paths.push(moduleId);
    }
  }
  return paths;
}
