import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Keep the crawl-visible <title> from index.html ("Relay — Intelligent
// Customer Service"); per-route titles are set by the views themselves.
if (!document.title || document.title === 'Vite App') {
  document.title = 'Relay — Intelligent Customer Service';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA: register the offline-capable service worker in production builds only,
// so it never interferes with Vite dev-server HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is a progressive enhancement */
    });
  });
}
