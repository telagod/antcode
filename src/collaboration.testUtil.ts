/**
 * Test-only helpers for `src/collaboration.ts`.
 *
 * Lives in a `*.testUtil.ts` file (not `*.test.ts`) so it can be imported by
 * tests while keeping test scaffolding off the production module's public
 * surface. The implementation lives in `collaboration.ts`; this module is a
 * thin re-export shim so we have a single canonical definition of
 * `withDiscoveryFileForTest`.
 */
export { withDiscoveryFileForTest } from "./collaboration";
