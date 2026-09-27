import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({
  Map: class { on() {} remove() {} },
}));

import App from './App';

describe('App shell', () => {
  it('renders the inspector title and the map container', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /valhalla route id/i })).toBeDefined();
    expect(screen.getByTestId('map')).toBeDefined();
  });
});
