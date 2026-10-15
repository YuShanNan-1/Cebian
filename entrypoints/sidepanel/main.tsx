import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import App from './App.tsx';
import '@/assets/tailwind.css';
import { LocaleRoot } from '@/components/common/LocaleRoot';
import { initI18n } from '@/lib/i18n';

// Register all interactive tool UI components (side-effect)
import '@/components/chat/ui-registrations';

// 先装好界面语言字典再渲染，免得首帧按浏览器语言画完再跳变（initI18n 永不 reject）。
// LocaleRoot 在 MemoryRouter 内层：切换语言 remount App 时路由位置保留（仍停在设置页）。
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <MemoryRouter initialEntries={['/chat/new']}>
        <LocaleRoot>
          <App />
        </LocaleRoot>
      </MemoryRouter>
    </React.StrictMode>,
  );
});
