import {describe, it, expect} from 'vitest';
import {EventHub} from './hub.js';
import type {ServerEvent, Story} from '../../shared/types.js';

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: 's1',
    userId: 'u1',
    projectId: 'p1',
    title: 'A story',
    description: '',
    model: 'sonnet',
    status: 'todo',
    rank: 'a0',
    progressPct: 0,
    progressLabel: '',
    claimedByAgentId: null,
    stopRequested: false,
    playRequestedAt: null,
    createdAt: 0,
    updatedAt: 0,
    blockedBy: [],
    ...overrides,
  };
}

describe('EventHub', () => {
  it('delivers events only to the owning user', () => {
    const hub = new EventHub();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    hub.subscribe('u1', e => a.push(e));
    hub.subscribe('u2', e => b.push(e));
    hub.publish('u1', {type: 'story.deleted', id: 's1'});
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = new EventHub();
    const received: ServerEvent[] = [];
    const unsubscribe = hub.subscribe('u1', e => received.push(e));

    hub.publish('u1', {type: 'story.deleted', id: 's1'});
    unsubscribe();
    hub.publish('u1', {type: 'story.deleted', id: 's2'});

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({type: 'story.deleted', id: 's1'});
  });

  it('survives a throwing subscriber', () => {
    // One bad subscriber and one good subscriber; the good one must still receive
    // the event, and publish() must not throw out of the call itself.
    const hub = new EventHub();
    const received: ServerEvent[] = [];
    hub.subscribe('u1', () => {
      throw new Error('boom');
    });
    hub.subscribe('u1', e => received.push(e));

    expect(() => hub.publish('u1', {type: 'story.deleted', id: 's1'})).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('resolves waitFor when a matching event arrives', async () => {
    const hub = new EventHub();
    const story = makeStory();

    const promise = hub.waitFor('u1', e => e.type === 'story.created', 1000);
    // A non-matching event first — must not resolve the wait.
    hub.publish('u1', {type: 'story.deleted', id: 'ignored'});
    hub.publish('u1', {type: 'story.created', story});

    const event = await promise;
    expect(event).toEqual({type: 'story.created', story});
  });

  it('resolves waitFor to null on timeout', async () => {
    const hub = new EventHub();
    const event = await hub.waitFor('u1', () => true, 20);
    expect(event).toBeNull();
  });

  it('does not leave a stale subscriber behind after waitFor resolves', async () => {
    const hub = new EventHub();
    const story = makeStory();

    const promise = hub.waitFor('u1', e => e.type === 'story.created', 1000);
    hub.publish('u1', {type: 'story.created', story});
    await promise;

    // A further publish must only reach subscribers added afterwards — the waitFor's
    // temporary subscriber must already be gone.
    const received: ServerEvent[] = [];
    hub.subscribe('u1', e => received.push(e));
    hub.publish('u1', {type: 'story.deleted', id: 's2'});

    expect(received).toHaveLength(1);
  });

  it('does not leave a stale subscriber or timer behind after waitFor times out', async () => {
    const hub = new EventHub();
    await hub.waitFor('u1', () => true, 20);

    const received: ServerEvent[] = [];
    hub.subscribe('u1', e => received.push(e));
    hub.publish('u1', {type: 'story.deleted', id: 's2'});

    expect(received).toHaveLength(1);
  });

  it('resolves pending waitFor calls to null when the hub is closed', async () => {
    const hub = new EventHub();
    const promise = hub.waitFor('u1', () => true, 5000);

    hub.close();

    const event = await promise;
    expect(event).toBeNull();
  });
});
