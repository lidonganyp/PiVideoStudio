import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
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
