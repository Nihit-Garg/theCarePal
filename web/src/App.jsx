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
  // A tab opened straight on the caregiver screen must NOT run a (hidden) person
  // simulation — it would raise its own duplicate alarms. Start the person view the
  // first time this tab shows it, then keep it mounted.
  const [personStarted, setPersonStarted] = useState(route !== '#/caregiver');
  useEffect(() => { if (route !== '#/caregiver') setPersonStarted(true); }, [route]);

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
      {/* ONE PersonView instance for every route, so switching views never unmounts it:
          a countdown keeps running (and escalates) and a recording keeps going while you
          look at the caregiver screen — just like the person's real phone would. */}
      <main className={route === '#/split' ? 'split' : 'app'}>
        {personStarted && (
          <section className={`split-col person-col ${route === '#/caregiver' ? 'hidden-view' : ''}`}
            aria-label="Person's phone" aria-hidden={route === '#/caregiver'}>
            <PersonView embedded={route === '#/split'} />
          </section>
        )}
        {route !== '#/' && <section className="split-col" aria-label="Caregiver"><CaregiverView /></section>}
      </main>
    </>
  );
}
