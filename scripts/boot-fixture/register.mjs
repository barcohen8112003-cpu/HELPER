// Loaded with --import by src/boot-recovery-selftest.js: swaps src/whatsapp.js for a fake, so src/index.js can boot
// for real (store, outbox, monitoring, notify, timers) with no WhatsApp connection, socket or network.
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
