import test from 'node:test';
import part0 from '../ci-parts/openAIResponsesWebSocket.cjs';
import part1 from '../ci-parts/openAIResponsesWebSocketNative.cjs';
import part2 from '../ci-parts/openAIResponsesWebSocketSession.cjs';
import { registerProviderCacheTest } from './fixtures/ci-model-provider-cache.mjs';
part0.registerCases(test);
part1.registerCases(test);
part2.registerCases(test);
registerProviderCacheTest(test);
