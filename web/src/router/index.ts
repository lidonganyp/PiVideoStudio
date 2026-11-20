import { createRouter, createMemoryHistory, createWebHistory } from 'vue-router';
import { qiankunWindow } from 'vite-plugin-qiankun/es/helper';

const isQiankun = !!qiankunWindow.__POWERED_BY_QIANKUN__;
const router = createRouter({
  // qiankun 模式用内存路由：子应用内部导航不抢占主应用 URL
  history: isQiankun ? createMemoryHistory() : createWebHistory('/video/'),
  routes: [
    {
      path: '/',
      name: 'projects',
      component: () => import('../views/ProjectList.vue'),
    },
    {
      path: '/projects/:id',
      name: 'project-detail',
      component: () => import('../views/ProjectDetail.vue'),
    },
    {
      path: '/review-workbench',
      name: 'review-workbench',
      component: () => import('../views/ReviewWorkbench.vue'),
    },
    {
      path: '/asset-library',
      name: 'asset-library',
      component: () => import('../views/AssetLibrary.vue'),
    },
    {
      path: '/prompt-workbench',
      name: 'prompt-workbench',
      component: () => import('../views/PromptWorkbench.vue'),
    },
    {
      path: '/series-workbench',
      name: 'series-workbench',
      component: () => import('../views/SeriesWorkbench.vue'),
    },
  ],
});

export default router;
