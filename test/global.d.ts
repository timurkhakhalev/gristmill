// Typing for CJS `require` in .ts test files (they keep require() style for
// loader interception). Node's types expose require only through functions
// declared in CJS modules; tests are ESM-shaped TS, so declare the callable.
declare function require(id: string): any;
