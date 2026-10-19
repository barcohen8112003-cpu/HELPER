// Runs on the user's Windows PC. It only dials out to the assistant in the cloud; no port is opened at home.
// Computer actions (src/pc.js) and Webtop reads (the Chrome window from webtop-browser.bat, 127.0.0.1:9223) run here.
//
//   node home-relay/pc-bridge.mjs
//
// pc-bridge.config.json, next to this file: { "url": "ws://YOUR_SERVER:3212/pc", "secret": "same-as-PC_BRIDGE_SECRET" }
// Or set PC_BRIDGE_URL and PC_BRIDGE_SECRET in the environment. Needs Node 18 or newer.
process.env.PC_BRIDGE_EXECUTOR = '1'

const { runHomeBridge } = await import('../src/pc-bridge.js')
await runHomeBridge()
