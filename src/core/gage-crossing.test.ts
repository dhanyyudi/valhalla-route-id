import { describe, expect, it } from 'vitest';
import artifact from '../data/gage-polygons.json';
import { corridorRings, type CorridorPolygons, type LngLat } from './gage-geometry';
import { describeCrossings, featuresToCrossings, findCorridorCrossings } from './gage-crossing';

const corridors = (artifact as unknown as { corridors: CorridorPolygons[] }).corridors;
const thamrin = corridors.find(corridor => corridor.name === 'Jl. Thamrin')!;

/** A synthetic west-to-east corridor at -6.20 running from 106.80 to 106.82, buffered by 35 m. */
const synthetic: CorridorPolygons = {
  id: 'test_road_01',
  name: 'Jl. Uji',
  bufferMeters: 35,
  centerline: [[106.80, -6.20], [106.82, -6.20]],
  rings: corridorRings([[106.80, -6.20], [106.82, -6.20]], 35),
};

describe('findCorridorCrossings', () => {
  it('reports the corridor a route runs straight through', () => {
    // North to south across the synthetic corridor's midpoint.
    const route: LngLat[] = [[106.81, -6.199], [106.81, -6.201]];
    const report = findCorridorCrossings(route, [synthetic]);
    expect(report.count).toBe(1);
    expect(report.corridors[0]).toMatchObject({ id: 'test_road_01', name: 'Jl. Uji', rings: 1 });
    expect(report.corridors[0].segments).toBeGreaterThan(0);
  });

  it('reports nothing for a route that stops short of the corridor', () => {
    // 200 m north of the buffer edge: 0.002° of latitude is ~222 m, and the buffer is 35 m.
    const route: LngLat[] = [[106.81, -6.196], [106.812, -6.196]];
    expect(findCorridorCrossings(route, [synthetic])).toEqual({ corridors: [], count: 0 });
  });

  it('reports nothing for a route that runs alongside the corridor outside its buffer', () => {
    const route: LngLat[] = [[106.795, -6.1985], [106.825, -6.1985]];
    expect(findCorridorCrossings(route, [synthetic]).count).toBe(0);
  });

  it('catches a route that only clips a corner of the buffer', () => {
    const route: LngLat[] = [[106.8195, -6.1998], [106.8205, -6.2002]];
    expect(findCorridorCrossings(route, [synthetic]).count).toBe(1);
  });

  it('counts each corridor once, however many of its rings are hit', () => {
    // Jl. Sudirman is long enough that the builder split it into two rings; a route along its whole
    // length must still report one corridor.
    const sudirman = corridors.find(corridor => corridor.name === 'Jl. Sudirman')!;
    expect(sudirman.rings.length).toBeGreaterThan(1);
    const route: LngLat[] = sudirman.centerline;
    const report = findCorridorCrossings(route, corridors);
    expect(report.corridors.filter(corridor => corridor.name === 'Jl. Sudirman')).toHaveLength(1);
  });

  it('finds every real corridor a Jakarta route crosses, using the shipped rings', () => {
    // The corridor's own centre-line is inside its own buffer by construction, so a route along it
    // must cross it — and must not be reported as crossing every other corridor in the network.
    const report = findCorridorCrossings(thamrin.centerline, corridors);
    expect(report.count).toBeGreaterThanOrEqual(1);
    expect(report.corridors.map(corridor => corridor.name)).toContain('Jl. Thamrin');
    expect(report.count).toBeLessThan(corridors.length);
  });

  it('reports nothing for an empty or single-point geometry', () => {
    expect(findCorridorCrossings([], corridors)).toEqual({ corridors: [], count: 0 });
    expect(findCorridorCrossings([[106.81, -6.20]], corridors)).toEqual({ corridors: [], count: 0 });
  });
});

describe('featuresToCrossings', () => {
  it('merges repeated hits for one corridor and ignores foreign features', () => {
    const report = featuresToCrossings([
      { id: 'gg_road_01', name: 'Jl. Thamrin' },
      { id: 'gg_road_01', name: 'Jl. Thamrin' },
      { id: 'gg_road_02', name: 'Jl. Sudirman' },
      { id: 42, name: 'not a corridor' },
      { name: 'missing id' },
      { id: 'gg_road_03', name: undefined },
    ]);
    expect(report.count).toBe(2);
    expect(report.corridors[0]).toMatchObject({ id: 'gg_road_01', rings: 2 });
    expect(report.corridors[1]).toMatchObject({ id: 'gg_road_02', rings: 1 });
  });
});

describe('describeCrossings', () => {
  it('says plainly when nothing is crossed, and how many corridors were excluded', () => {
    expect(describeCrossings({ corridors: [], count: 0 }, 3)).toBe('Tidak ada ruas ganjil-genap yang masih dilintasi (3 ruas diminta dihindari).');
    expect(describeCrossings({ corridors: [], count: 0 }, 0)).toBe('Tidak ada ruas ganjil-genap yang dilintasi.');
  });

  it('names the corridors that are still crossed', () => {
    const report = findCorridorCrossings([[106.81, -6.199], [106.81, -6.201]], [synthetic]);
    expect(describeCrossings(report, 1)).toBe('Masih melintasi 1 ruas ganjil-genap: Jl. Uji.');
  });
});
