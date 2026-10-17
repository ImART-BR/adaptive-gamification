import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../app-web/src/styles.css';
import './sim.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
