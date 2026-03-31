/**
 * Test utilities barrel export.
 * Import from here for clean paths: `import { createMockConfig } from '../test/index.js'`
 */
export {
  createMockConfig,
  createMockSharedState,
  createMockGameClient,
  createMockRequest,
  type MockGameClient,
  type MockRequest,
} from "./helpers.js";
