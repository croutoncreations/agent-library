// keepNames helper used by the recovered modules (esbuild's __name): sets Function.prototype.name.
export const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });
