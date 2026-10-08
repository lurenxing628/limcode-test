import { LOADED_RUNTIME_BUILD } from '../../application/runtimeBuildIdentity';
import { EXTENSION_VERSION } from '../../../shared/extensionIdentity';
import type { DebugCaptureManifest } from '../../../shared/debugCapture';

/** 来源沿用实际装载模块的编译身份；未开启取证时不扫描模块与 webview 正文。 */
export function debugCaptureSource(hostBootId: string): DebugCaptureManifest['source'] {
  return {
    extensionVersion: EXTENSION_VERSION,
    sourceCommit: LOADED_RUNTIME_BUILD.sourceCommit,
    buildId: LOADED_RUNTIME_BUILD.buildId ?? '',
    hostBootId
  };
}
