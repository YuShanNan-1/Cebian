import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import '@/assets/tailwind.css';
import { LocaleRoot } from '@/components/common/LocaleRoot';
import { initI18n } from '@/lib/i18n';

// 先装好界面语言字典再渲染，免得首帧按浏览器语言画完再跳变（initI18n 永不 reject）
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleRoot>
        <App />
      </LocaleRoot>
    </React.StrictMode>,
  );
});
