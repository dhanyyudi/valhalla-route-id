import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ENTRIES, formatEntry, useProcessLog } from './process-log';

describe('process log', () => {
  beforeEach(() => useProcessLog.setState({ entries: [], run: null }));

  it('records SDK phases once and every tile it reads', () => {
    const log = useProcessLog.getState();
    log.beginRun();
    log.progress({ requestId: 1, phase: 'loading-runtime' });
    log.progress({ requestId: 1, phase: 'initializing-graph' });
    log.progress({ requestId: 1, phase: 'initializing-graph' });
    log.progress({ requestId: 1, phase: 'routing' });
    log.progress({ requestId: 1, phase: 'fetching-tile', tileId: '3868378' });
    log.progress({ requestId: 1, phase: 'fetching-tile', tileId: '241329' });
    const { entries, run } = useProcessLog.getState();
    expect(entries.map(entry => entry.level)).toEqual(['phase', 'phase', 'phase', 'tile', 'tile']);
    expect(entries.at(-1)?.text).toBe('↓ tile 241329 (#2)');
    expect(run).toMatchObject({ tiles: 2, lastTile: '241329', current: 'fetching-tile' });
    expect(Object.keys(run!.phases).sort()).toEqual(['fetching-tile', 'initializing-graph', 'loading-runtime', 'routing']);
    expect(entries.every(entry => entry.sinceRun !== null)).toBe(true);
  });

  it('ignores progress outside a run and stamps no run offset', () => {
    useProcessLog.getState().progress({ requestId: 1, phase: 'routing' });
    useProcessLog.getState().push('info', 'idle');
    const [entry] = useProcessLog.getState().entries;
    expect(useProcessLog.getState().entries).toHaveLength(1);
    expect(entry.sinceRun).toBeNull();
    expect(formatEntry(entry)).toMatch(/\] INFO  idle$/);
  });

  it('keeps only the newest entries', () => {
    for (let index = 0; index < MAX_ENTRIES + 5; index++) useProcessLog.getState().push('tile', `tile ${index}`);
    const { entries } = useProcessLog.getState();
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].text).toBe('tile 5');
  });
});
