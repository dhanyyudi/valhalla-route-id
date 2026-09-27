import { MapView } from './map/MapView';
import './styles.css';

export default function App() {
  return (
    <main className="relative h-full w-full">
      <MapView />
      <section className="nb-panel absolute left-4 top-4 w-80 p-4">
        <h1 className="nb-title text-lg">Valhalla Route ID</h1>
        <p className="mt-1 text-sm">Inspector rute Indonesia — Valhalla berjalan di browser.</p>
      </section>
    </main>
  );
}
