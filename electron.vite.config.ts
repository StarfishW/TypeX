import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // MathJax reads its version from package.json through eval('require')
    // unless this constant is defined; that path cannot work in a browser.
    define: {
      PACKAGE_VERSION: JSON.stringify('3.2.2')
    },
    build: {
      target: 'chrome140',
      chunkSizeWarningLimit: 4000
    }
  }
})
