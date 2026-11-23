// Playwright settings for test/regression.spec.js. Run `npm test`, which
// fetches the CDN libraries into vendor/ first (test/vendor.sh).
const { defineConfig } = require('@playwright/test');

// GLASSBODY_TEST_PORT picks another port when 8765 is taken
const PORT = Number(process.env.GLASSBODY_TEST_PORT) || 8765;

module.exports = defineConfig({
  testDir: 'test',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:' + PORT + '/',
    viewport: { width: 1280, height: 860 },
    browserName: 'chromium',
    // no test is answered by a service worker; test/offline.spec.js allows them for itself
    serviceWorkers: 'block',
    // WebGL without a GPU, through SwiftShader
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    }
  },
  webServer: {
    command: 'python3 -m http.server ' + PORT + ' --bind 127.0.0.1',
    url: 'http://127.0.0.1:' + PORT + '/index.local.html',
    // never test against whatever else already holds the port
    reuseExistingServer: false
  }
});
