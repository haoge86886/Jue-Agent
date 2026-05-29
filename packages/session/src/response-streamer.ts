/**
 * @file response-streamer.ts
 * @module @jue/session/response-streamer
 *
 * Session layer stream piping. This package stays frontend-agnostic:
 * CLI, Web, SSE, and other frontends provide their own renderers.
 */

import type { SessionResponse, StreamEvent } from "@jue/shared-types";

export interface StreamRenderer {
  /** Handle one stream event. Implementations may be sync or async. */
  handle(event: StreamEvent): void | Promise<void>;
  /** Called after the final SessionResponse is available. */
  finalize?(response: SessionResponse): void | Promise<void>;
}

/**
 * Pipe stream events into a renderer, then return the final response.
 */
export async function pipeStream(
  events: AsyncIterable<StreamEvent>,
  done: Promise<SessionResponse>,
  renderer: StreamRenderer,
): Promise<SessionResponse> {
  for await (const ev of events) {
    await renderer.handle(ev);
  }
  const response = await done;
  if (renderer.finalize) await renderer.finalize(response);
  return response;
}

/** Collects all stream events for tests and non-streaming API adapters. */
export class CollectingStreamRenderer implements StreamRenderer {
  readonly events: StreamEvent[] = [];

  handle(event: StreamEvent): void {
    this.events.push(event);
  }
}
