import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Pure client-side SPA (ssr disabled) — ship static files, no serverless
    // runtime, so the Vercel Node version is irrelevant.
    adapter: adapter({ fallback: 'index.html' })
  }
};

export default config;
