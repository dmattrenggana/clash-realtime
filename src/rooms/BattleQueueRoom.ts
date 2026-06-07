/**
 * BattleQueueRoom — pre-game matchmaking queue.
 *
 * Players join this room to be matched. When 2 players are in the queue,
 * the server pairs them: creates a new BattleRoom via matchMaker,
 * reserves seats for both, and sends each client a `matchFound` message
 * with the seat reservation. The client then consumes the reservation
 * to join the actual BattleRoom.
 *
 * This separates MATCHING from PLAYING. The game itself doesn't do
 * matchmaking — players get matched first, then enter the game together.
 *
 * Handoff pattern (P0 fix): after sending `matchFound`, the server waits
 * for the client to confirm it has connected to the BattleRoom
 * (`matchAccepted` message), with a 5-second timeout. This replaces the
 * old 50ms `waitMs` hack which was too short on real networks and caused
 * the client to be kicked from the queue before it could open a new
 * WebSocket to consume the seat reservation.
 */
import type { Delayed } from "@colyseus/timer";
import { Room, Client, matchMaker } from "colyseus";

const QUEUE_TARGET = 2;       // pair size for 1v1
const HANDOFF_TIMEOUT_MS = 5_000;  // max wait for client matchAccepted after matchFound

interface InFlightHandoff {
  battleRoomId: string;
  reservation: unknown;
  timeout: Delayed;
}

export class BattleQueueRoom extends Room {
  maxClients = 100; // many can wait
  private pending = new Map<string, { wallet?: string, nickname?: string }>();
  // Tracks in-flight handoffs so we can cancel timeouts on matchAccepted / leave / dispose
  private handoffs = new Map<string, InFlightHandoff>();

  onCreate(_options: any) {
    console.log(`[BattleQueue] Created`);

    // Persistent listener for the client's "I've connected to the BattleRoom"
    // confirmation. We need this at room-level (not per-handoff) so it survives
    // even if the client sends `matchAccepted` after the per-handoff closure
    // has been torn down.
    this.onMessage("matchAccepted", (client, _msg) => {
      const handoff = this.handoffs.get(client.sessionId);
      if (!handoff) {
        // Either: client never got a matchFound (stale ack), or handoff was
        // already cleaned up. Either way, harmless to ignore.
        console.log(`[BattleQueue] matchAccepted from ${client.sessionId} but no handoff in flight`);
        return;
      }
      console.log(`[BattleQueue] matchAccepted from ${client.sessionId} → room ${handoff.battleRoomId} (handoff complete)`);
      // Client successfully opened a new WebSocket to the BattleRoom.
      // Cancel the timeout and clear the in-flight record.
      handoff.timeout.clear();
      this.handoffs.delete(client.sessionId);
      // Now it's safe to leave this client from the queue — they have
      // a live connection to the BattleRoom.
      void client.leave();
    });
  }

  onJoin(client: Client, options: any) {
    // Robust extraction: handles both raw wallet string or the new joinOptions object
    const data = typeof options.wallet === 'object' ? options.wallet : options;
    const wallet = data.wallet || "anonymous";
    const nickname = data.nickname || "Anonymous";

    console.log(`[BattleQueue] ${client.sessionId} joined (wallet: ${wallet}, nickname: ${nickname})`);
    this.pending.set(client.sessionId, { wallet, nickname });
    client.send("queued", { position: this.pending.size });

    if (this.pending.size >= QUEUE_TARGET) {
      // Don't await — fire and continue. matchPlayers handles errors.
      void this.matchPlayers();
    }
  }

  onLeave(client: Client) {
    if (this.pending.delete(client.sessionId)) {
      console.log(`[BattleQueue] ${client.sessionId} left queue`);
    }
    // If the client was mid-handoff, clean up so the timeout doesn't
    // fire on a session that's already gone.
    const handoff = this.handoffs.get(client.sessionId);
    if (handoff) {
      handoff.timeout.clear();
      this.handoffs.delete(client.sessionId);
    }
  }

  onDispose() {
    // Clean up all in-flight handoffs (the room is going away)
    for (const handoff of this.handoffs.values()) {
      handoff.timeout.clear();
    }
    this.handoffs.clear();
    console.log(`[BattleQueue] Disposed`);
  }

  /**
   * Pair the first 2 players in the queue:
   *   1. Atomically extract 2 players (avoids double-pairing if matchPlayers
   *      is invoked concurrently — e.g. 3+ clients join in rapid succession)
   *   2. Create a fresh BattleRoom
   *   3. Reserve seats for both clients
   *   4. Send `matchFound` to each client with the reservation
   *   5. Start a per-client handoff timer; wait for `matchAccepted` or timeout
   */
  private async matchPlayers(): Promise<void> {
    // Atomic extract: snapshot + delete in one go
    const ids = Array.from(this.pending.keys()).slice(0, QUEUE_TARGET);
    if (ids.length < QUEUE_TARGET) return;
    const [idA, idB] = ids;
    const a = this.pending.get(idA);
    const b = this.pending.get(idB);
    this.pending.delete(idA);
    this.pending.delete(idB);

    try {
      // 1. Create the battle room
      const battleRoom = await matchMaker.createRoom("battle", {});
      console.log(`[BattleQueue] Matched ${idA} vs ${idB} → room ${battleRoom.roomId}`);

      // 2. Reserve seats (creates seat reservations; client uses these to join)
      const resA = await matchMaker.reserveSeatFor(battleRoom, { wallet: a?.wallet, nickname: a?.nickname });
      const resB = await matchMaker.reserveSeatFor(battleRoom, { wallet: b?.wallet, nickname: b?.nickname });

      // 3. Start handoff for each client
      const clientA = this.clients.find((c) => c.sessionId === idA);
      const clientB = this.clients.find((c) => c.sessionId === idB);
      if (clientA) this.startHandoff(clientA, resA, battleRoom.roomId);
      if (clientB) this.startHandoff(clientB, resB, battleRoom.roomId);
    } catch (err) {
      console.error(`[BattleQueue] matchPlayers failed:`, err);
      // Best-effort: put them back at the front of the queue
      if (a) this.pending.set(idA, a);
      if (b) this.pending.set(idB, b);
    }
  }

  /**
   * Begin the handoff for one matched client:
   *   - Send `matchFound` (with the seat reservation)
   *   - Set a 5-second timeout waiting for `matchAccepted`
   *   - On ack: clear timeout, leave client (handled in onMessage)
   *   - On timeout: log warning, leave client anyway (reservation will
   *     auto-expire after Colyseus's seatReservationTimeout)
   */
  private startHandoff(client: Client, reservation: unknown, battleRoomId: string): void {
    const sessionId = client.sessionId;

    // Defensive: if there's already a handoff in flight for this session,
    // cancel the old one first (shouldn't happen in normal flow).
    const existing = this.handoffs.get(sessionId);
    if (existing) existing.timeout.clear();

    // Send the matchFound with seat reservation
    client.send("matchFound", reservation);

    // Set timeout: if client doesn't ack in 5s, give up
    const timeout = this.clock.setTimeout(() => {
      const handoff = this.handoffs.get(sessionId);
      if (!handoff) return; // already cleaned up (matchAccepted came in late)
      console.warn(
        `[BattleQueue] Handoff timeout for ${sessionId} → room ${battleRoomId}. ` +
        `No matchAccepted in ${HANDOFF_TIMEOUT_MS}ms. Forcing client leave.`,
      );
      this.handoffs.delete(sessionId);
      // Reservation will auto-expire after Colyseus's seatReservationTimeout
      // (default 15s in room config). Force-leave client so they can re-queue
      // or get a meaningful error.
      void client.leave();
    }, HANDOFF_TIMEOUT_MS);

    this.handoffs.set(sessionId, { battleRoomId, reservation, timeout });
    console.log(`[BattleQueue] Sent matchFound to ${sessionId}, waiting for ack (timeout ${HANDOFF_TIMEOUT_MS}ms)`);
  }
}
