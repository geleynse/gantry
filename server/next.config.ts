import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  distDir: 'dist/public',
  images: { unoptimized: true },
  typescript: {
    tsconfigPath: 'tsconfig.next.json',
  },
};

export default config;
