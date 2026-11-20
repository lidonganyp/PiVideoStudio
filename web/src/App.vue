<template>
  <div class="app">
    <nav v-if="!isQiankun" class="navbar">
      <router-link to="/" class="nav-link">Projects</router-link>
      <router-link to="/series-workbench" class="nav-link">Series</router-link>
      <router-link to="/review-workbench" class="nav-link">Review</router-link>
      <router-link to="/asset-library" class="nav-link">Assets</router-link>
      <router-link to="/prompt-workbench" class="nav-link">Prompts</router-link>
    </nav>
    <router-view />
  </div>
</template>
<script>
import { qiankunWindow } from 'vite-plugin-qiankun/es/helper';
const isQiankun = !!qiankunWindow.__POWERED_BY_QIANKUN__;
export default { data() { return { isQiankun }; } }
</script>
<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.app { min-height: 100vh; }
.navbar { display: flex; gap: 0; background: #2c3e50; padding: 0 20px; height: 48px; align-items: center; }
.nav-link { color: #ecf0f1; text-decoration: none; padding: 0 16px; height: 48px; display: flex; align-items: center; font-size: 0.9rem; transition: background 0.2s; }
.nav-link:hover { background: #34495e; }
.nav-link.router-link-active { background: #409eff; color: #fff; }
</style>
