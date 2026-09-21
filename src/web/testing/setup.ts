import '@testing-library/jest-dom/vitest';
import {cleanup} from '@testing-library/react';
import {afterEach} from 'vitest';

/*
 * jsdom ships none of the layout APIs that floating overlays and drag sensors call on
 * open. Each is stubbed once here, as a no-op that returns a shape the caller can read,
 * so a component under test exercises its real code path instead of crashing on a
 * missing browser API.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/*
 * `useLiveBoard`'s default socket factory opens a real `WebSocket` at `/ws`. jsdom has no
 * server to open it against, and a real connection attempt's failure mode (and how long it
 * takes) varies by platform — stubbed here to an inert double that never opens, so a
 * component test that renders `BoardScreen` without injecting its own `socketFactory`
 * exercises the "not yet connected" state instantly instead of doing real network I/O.
 * Tests of `useLiveBoard` itself always inject a fake socket, so this never runs for them.
 */
class InertWebSocket {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;

afterEach(() => {
  cleanup();
});
