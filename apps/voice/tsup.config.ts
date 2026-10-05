import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  external: ['@prisma/client', '.prisma/client', '@node-rs/argon2'],
});
