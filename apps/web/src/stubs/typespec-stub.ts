/**
 * Stub for @typespec/compiler and @typespec/json-schema in browser environment
 * TypeSpec compilation requires Node.js and is not available in browser
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const compile = (): Promise<any> => Promise.resolve(null)
export const NodeHost = {}
export const getSourceFileKindFromExt = (): null => null

export default {}
