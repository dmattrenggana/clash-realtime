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
 */
import { Room, Client, matchMaker } from "colyseus";

const QUEUE_TARGET = 2; // pair size for 1v1

export class BattleQueueRoom extends Room {
  maxClients = 100; // many can wait
  private pending = new Map<string, { wallet?: string }>();

  onCreate(_options: any) {
    console.log(`[BattleQueue] Created`);
  }

  onJoin(client: Client, options: any) {
    console.log(`[BattleQueue] ${client.sessionId} joined (wallet: ${options.wallet || "anonymous"})`);
    this.pending.set(client.sessionId, { wallet: options.wallet });
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
  }

  onDispose() {
    console.log(`[BattleQueue] Disposed`);
  }

  /**
   * Pair the first 2 players in the queue:
   *   1. Create a fresh BattleRoom
   *   2. Reserve a seat in that room for each player (with their wallet option)
   *   3. Send `matchFound` to each client with the reservation
   *   4. Force-leave the clients from the queue (consumeSeatReservation opens new WS)
   */
  private async matchPlayers(): Promise<void> {
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
      const resA = await matchMaker.reserveSeatFor(battleRoom, { wallet: a?.wallet });
      const resB = await matchMaker.reserveSeatFor(battleRoom, { wallet: b?.wallet });

      // 3. Send matchFound to each
      const clientA = this.clients.find((c) => c.sessionId === idA);
      const clientB = this.clients.find((c) => c.sessionId === idB);
      if (clientA) {
        clientA.send("matchFound", resA);
        // Wait briefly so the client receives the message before we yank
        // the queue-room WebSocket out from under them.
        await waitMs(50);
        try { await clientA.leave(); } catch { /* ignore */ }
      }
      if (clientB) {
        clientB.send("matchFound", resB);
        await waitMs(50);
        try { await clientB.leave(); } catch { /* ignore */ }
      }
    } catch (err) {
      console.error(`[BattleQueue] matchPlayers failed:`, err);
      // Best-effort: put them back at the front of the queue
      if (a) this.pending.set(idA, a);
      if (b) this.pending.set(idB, b);
    }
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
