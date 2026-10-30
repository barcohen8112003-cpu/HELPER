// The self-tests simulate the cloud server (Linux). On a Windows PC the PC functions would otherwise act on this
// very computer, so the tests are told they run on the server; on Linux (CI) this changes nothing.
if (process.platform === 'win32') Object.defineProperty(process, 'platform', { value: 'linux' })
