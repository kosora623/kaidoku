import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * chrome.scripting.executeScript({ files: ['content.js'] }) は classic script として実行されるため、
 * content.ts は外部チャンクへの import を含まない自己完結 IIFE として dist/content.js に出力する。
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: resolve(__dirname, 'src/content.ts'),
      name: 'KaidokuContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
