import { registerHooks } from 'node:module';

const stub = new URL('./herdr-stub.js', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'herdr' ? { url: stub, shortCircuit: true } : next(specifier, context),
});
