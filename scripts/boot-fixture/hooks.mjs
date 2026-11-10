// Module resolve hook: any import of src/whatsapp.js gets fake-whatsapp.mjs instead. Nothing else is changed.
const FAKE = new URL('./fake-whatsapp.mjs', import.meta.url).href
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context)
  return r.url.endsWith('/src/whatsapp.js') ? { ...r, url: FAKE, shortCircuit: true } : r
}
