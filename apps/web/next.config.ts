import type { NextConfig } from 'next';

/**
 * `@hatko/shared` publishes raw `.ts` from its workspace folder — one definition of
 * every contract, no build step anywhere in the repo. Next does not transpile
 * node_modules by default, so the workspace link has to be named here.
 */
const config: NextConfig = {
  transpilePackages: ['@hatko/shared'],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
