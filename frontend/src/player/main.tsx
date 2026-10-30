import React from 'react';
import ReactDOM from 'react-dom/client';
import { PlayerApp } from './PlayerApp';
import '../index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PlayerApp />
  </React.StrictMode>,
);
