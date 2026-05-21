import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import LandingPage from './LandingPage.jsx';

function Root() {
  const [view, setView] = useState('landing');
  if (view === 'dashboard') return <App />;
  return <LandingPage onDashboard={() => setView('dashboard')} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
