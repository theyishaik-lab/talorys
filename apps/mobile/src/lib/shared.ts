/**
 * The runtime half of `@talorys/shared` the app uses. Metro (the app's bundler) cannot follow the
 * workspace symlink to `packages/shared`, and the package's barrel pulls in zod for the schemas — so
 * code in `src/` imports only TYPES from "@talorys/shared" and VALUES from here. These shared
 * files have no runtime imports of their own (metro.config.js watches packages/shared/src for them).
 * tests/shared-runtime.test.ts keeps this list in step with the package and guards `src/`.
 */
export { formatAttempts, modelDisplayName, modelLabel } from "../../../../packages/shared/src/attribution";
export { endpointIdFromName, moveItem, settingsPatchForChain } from "../../../../packages/shared/src/chain";
export { DEVICE_MODELS, deviceModelSpec, fitDevicePrompt, ramVerdict, stripThinking } from "../../../../packages/shared/src/device";

/** Mirrors `MAX_FALLBACK_CHAIN` in packages/shared/src/schemas.ts (that file needs zod); the test checks they match. */
export const MAX_FALLBACK_CHAIN = 48;
