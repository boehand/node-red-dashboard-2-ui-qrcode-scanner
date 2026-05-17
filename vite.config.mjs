import { resolve } from 'path'

import vue from '@vitejs/plugin-vue'
import { defineConfig, normalizePath } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// This must match node-red-dashboard-2.widgets.<key>.output (minus the .umd.js suffix)
const LIBRARY_NAME = 'ui-qrcode-scanner'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        vue(),
        cssInjectedByJsPlugin(),
        viteStaticCopy({
            targets: [
                {
                    src: normalizePath(resolve(__dirname, `./ui/dist/${LIBRARY_NAME}.umd.js`)),
                    dest: normalizePath(resolve(__dirname, 'resources'))
                }
            ]
        })
    ],
    build: {
        sourcemap: process.env.NODE_ENV === 'development',
        lib: {
            entry: resolve(__dirname, 'ui/index.js'),
            name: LIBRARY_NAME,
            formats: ['umd'],
            fileName: (format) => `${LIBRARY_NAME}.${format}.js`
        },
        outDir: './ui/dist',
        rollupOptions: {
            // Vue and Vuex are provided by Dashboard 2 at runtime; html5-qrcode is bundled in.
            external: ['vue', 'vuex'],
            output: {
                globals: {
                    vue: 'Vue',
                    vuex: 'vuex'
                }
            }
        }
    }
})
