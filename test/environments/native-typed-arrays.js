// Jest runs each spec in its own V8 context, so a Float32Array made inside the spec is not
// an instance of the Float32Array onnxruntime-node's native side checks against, and the
// real model refuses its own input ("A float32 tensor's data must be type of function
// Float32Array()"). Only the opt-in real-model spec uses this; a Node process outside Jest
// has one context and never meets the problem.
const { TestEnvironment } = require('jest-environment-node');

const SHARED = [
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
];

module.exports = class NativeTypedArraysEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of SHARED) this.global[name] = globalThis[name];
  }
};
