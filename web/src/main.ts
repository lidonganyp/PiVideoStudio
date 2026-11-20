import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { renderWithQiankun, qiankunWindow } from 'vite-plugin-qiankun/es/helper';

let app: ReturnType<typeof createApp> | null = null;

renderWithQiankun({
  mount(props) {
    app = createApp(App);
    app.use(router);
    app.mount(props.container?.querySelector('#app') ?? '#app');
  },
  bootstrap() {},
  unmount() {
    app?.unmount();
    app = null;
  },
});

// 独立运行（非 qiankun 环境直接挂载）
if (!qiankunWindow.__POWERED_BY_QIANKUN__) {
  app = createApp(App);
  app.use(router);
  app.mount('#app');
}
