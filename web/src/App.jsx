import { useEffect, useState } from 'react';
import './App.css';
import { unlockAudio } from './engine/alertFx.js';
import CaregiverView from './views/CaregiverView.jsx';
import PersonView from './views/PersonView.jsx';

// Hash routes so it works on any static host (GitHub Pages) without server config.
const ROUTES = {
  '#/': { label: 'Person', title: "The person's phone" },
  '#/caregiver': { label: 'Caregiver', title: 'Nurse / family / operations' },
  '#/split': { label: 'Side by side', title: 'Both screens at once (wide screens)' },
};

function useRoute() {
  const get = () => (ROUTES[window.location.hash] ? window.location.hash : '#/');
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export default function App() {
  const route = useRoute();

  // Browsers only allow sound after a user gesture: unlock on the first tap anywhere.
  useEffect(() => {
    const once = () => unlockAudio();
    window.addEventListener('pointerdown', once, { once: true });
    window.addEventListener('keydown', once, { once: true });
    return () => { window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); };
  }, []);

  return (
    <>
      <nav className="nav" aria-label="Views">
        {Object.entries(ROUTES).map(([hash, r]) => (
          <a key={hash} href={hash} title={r.title} aria-current={route === hash ? 'page' : undefined}
            className={`${route === hash ? 'on' : ''} ${hash === '#/split' ? 'wide-only' : ''}`}>{r.label}</a>
        ))}
        <a className="newtab" href="#/caregiver" target="_blank" rel="noopener" title="Open the caregiver screen in a new tab">
          Caregiver in new tab ↗
        </a>
      </nav>
      {route === '#/' && <main className="app"><PersonView /></main>}
      {route === '#/caregiver' && <main className="app"><CaregiverView /></main>}
      {route === '#/split' && (
        <main className="split">
          <section className="split-col person-col" aria-label="Person's phone"><PersonView embedded /></section>
          <section className="split-col" aria-label="Caregiver"><CaregiverView /></section>
        </main>
      )}
    </>
  );
}
