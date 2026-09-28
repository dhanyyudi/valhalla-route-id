import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The shell renders without a browser: MapLibre's map, its marker and the module-scope
// `setWorkerUrl` call all have to exist for the component tree to import and render.
vi.mock('maplibre-gl', () => ({
  Map: class { on() {} remove() {} addControl() {} getCanvasContainer() { return document.createElement('div'); } },
  LngLatBounds: class { extend() { return this; } },
  NavigationControl: class {},
  ScaleControl: class {},
  Popup: class { setLngLat() { return this; } setHTML() { return this; } addTo() { return this; } remove() {} },
  Marker: class { setLngLat() { return this; } addTo() { return this; } remove() {} },
  setWorkerUrl: () => {},
}));

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/maplibre-gl-worker.js' }));

import App from './App';

describe('App shell', () => {
  it('renders the inspector title and the map container', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /valhalla route id/i })).toBeDefined();
    expect(screen.getByTestId('map')).toBeDefined();
  });
});
