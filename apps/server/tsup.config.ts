import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // 工作区包（@shanhai/contracts、@shanhai/game-core）只发布 TS 源码，
  // 生产产物必须内联它们，否则 Node 运行时会尝试直接加载 .ts 文件。
  noExternal: [/@shanhai\//],
  external: ['node:sqlite']
});
