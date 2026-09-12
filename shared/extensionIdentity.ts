export const EXTENSION_PACKAGE_NAME = 'limcode-test';
export const EXTENSION_VERSION = '0.0.21';
export const EXTENSION_USER_AGENT = `${EXTENSION_PACKAGE_NAME}/${EXTENSION_VERSION}`;
export const EXTENSION_BRAND = 'Limcode test';
export const EXTENSION_AGENT_NAME = `${EXTENSION_BRAND} Agent`;

export const EXTENSION_COMMAND_IDS = {
  openPanel: 'limcode-test.openPanel',
  revealGlobalStorage: 'limcode-test.revealGlobalStorage',
  inspectReliability: 'limcode-test.inspectReliability',
  resetDevelopmentData: 'limcode-test.resetDevelopmentData',
  applyLiveDiffPreview: 'limcode-test.applyLiveDiffPreview'
} as const;

export const MAIN_PANEL_VIEW_TYPE = 'limcode-test.mainPanel';
export const SIDEBAR_CONTAINER_ID = 'limcode-test-sidebar';
export const SIDEBAR_ENTRY_VIEW_ID = 'limcode-test-entry-view';
export const LIVE_DIFF_SCHEME = 'limcode-test-live-diff';
export const RELIABLE_DIFF_SCHEME = 'limcode-test-reliable-diff';
export const SHADOW_DIFF_SCHEME = 'limcode-test-shadow';
export const WEBVIEW_DEV_PORT = 31_820;
