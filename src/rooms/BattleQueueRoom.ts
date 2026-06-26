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
 *
 * Deck pre-validation (2026-06-26): deck size is enforced at 8 cards
 * BEFORE reserving a seat. This saves resources by rejecting invalid
 * decks early. On-chain NFT ownership validation still happens in
 * BattleRoom.onJoin.
 *
 * Agent vs human (2026-06-26): `isAgent` + `agentId` are forwarded from
 * auth options to BattleRoom via reserveSeatFor, so BattleRoom can apply
 * agent-specific hard-fail validation.
 */
import type { Delayed } from "@colyseus/timer";
import { Room, Client, matchMaker } from "colyseus";

const QUEUE_TARGET = 2;       // pair size for 1v1
const HANDOFF_TIMEOUT_MS = 5_000;  // max wait for client matchAccepted after matchFound
const MATCHMAKING_TIMEOUT_MS = process.env.MATCHMAKING_TIMEOUT_MS ? parseInt(process.env.MATCHMAKING_TIMEOUT_MS) : 20_000;
const REQUIRED_DECK_SIZE = 8;

interface PendingPlayer {
  wallet?: string;
  nickname?: string;
  deck?: string[];
  isAgent?: boolean;
  agentId?: string;
}

interface InFlightHandoff {
  battleRoomId: string;
  reservation: unknown;
  timeout: Delayed;
}

export class BattleQueueRoom extends Room {
  maxClients = 100; // many can wait
  private pending = new Map<string, PendingPlayer>();
  // Tracks in-flight handoffs so we can cancel timeouts on matchAccepted / leave / dispose
  private handoffs = new Map<string, InFlightHandoff>();
  // Tracks per-client matchmaking timeouts for AI Bot fallback (20 seconds)
  private matchmakingTimeouts = new Map<string, Delayed>();
  // Tracks per-client retry count for bot fallback (max 3 attempts before
  // giving up and sending matchmakingFailed to the client)
  private botFallbackRetries = new Map<string, number>();
  private static readonly MAX_BOT_FALLBACK_RETRIES = 3;

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

  /**
   * Pre-validate deck size before allowing a player into the queue.
   * Rejects early if deck is not exactly 8 cards, saving BattleRoom
   * seat reservation resources.
   */
  private validateDeckBeforeSeat(client: Client, deck: string[]): boolean {
    if (!Array.isArray(deck) || deck.length !== REQUIRED_DECK_SIZE) {
      console.warn(
        `[BattleQueue] ${client.sessionId} rejected: deck size ${deck?.length ?? 0} (required ${REQUIRED_DECK_SIZE})`,
      );
      client.send("matchmakingFailed", {
        reason: "invalid_deck_size",
        message: `Deck must be exactly ${REQUIRED_DECK_SIZE} cards. Got ${deck?.length ?? 0}.`,
        requiredSize: REQUIRED_DECK_SIZE,
        actualSize: deck?.length ?? 0,
      });
      // Give client a moment to receive the message, then disconnect
      setTimeout(() => { try { void client.leave(4002, "INVALID_DECK_SIZE"); } catch { /* ignore */ } }, 500);
      return false;
    }
    return true;
  }

  onJoin(client: Client, options: any) {
    // Pastikan kita mengambil data dari root options atau nested wallet object
    const data = (options?.wallet && typeof options.wallet === 'object') ? options.wallet : options;
    const wallet = String(data?.wallet || "anonymous");
    const nickname = String(data?.nickname || "Anonymous");
    // 2026-06-24: client's 8-card Battle Deck (from localStorage).
    // BattleRoom.onJoin will validate against on-chain NFT ownership.
    const deck: string[] = Array.isArray(data?.deck) ? data.deck.filter((c: any) => typeof c === 'string') : [];
    // 2026-06-26: Agent identity forwarded from auth (clash_ prefix → verify_api_key RPC)
    const isAgent = Boolean(data?.isAgent);
    const agentId = data?.agentId ? String(data.agentId) : undefined;

    // Pre-validate deck size BEFORE adding to queue — reject early
    if (!this.validateDeckBeforeSeat(client, deck)) {
      return; // Client already notified + scheduled for leave
    }

    console.log(`[BattleQueue] ${client.sessionId} joined (wallet: ${wallet}, nickname: ${nickname}, deck: ${deck.length} cards, agent: ${isAgent})`);
    this.pending.set(client.sessionId, { wallet, nickname, deck, isAgent, agentId });
    client.send("queued", { position: this.pending.size });

    // Arm a matchmaking timeout for this player to fallback to AI Bot
    const timeout = this.clock.setTimeout(() => {
      this.triggerSinglePlayerBotMatch(client.sessionId);
    }, MATCHMAKING_TIMEOUT_MS);
    this.matchmakingTimeouts.set(client.sessionId, timeout);

    if (this.pending.size >= QUEUE_TARGET) {
      // Don't await — fire and continue. matchPlayers handles errors.
      void this.matchPlayers();
    }
  }

  onLeave(client: Client) {
    if (this.pending.delete(client.sessionId)) {
      console.log(`[BattleQueue] ${client.sessionId} left queue`);
    }

    const matchmakingTimeout = this.matchmakingTimeouts.get(client.sessionId);
    if (matchmakingTimeout) {
      matchmakingTimeout.clear();
      this.matchmakingTimeouts.delete(client.sessionId);
    }

    // Clean up bot fallback retry counter
    this.botFallbackRetries.delete(client.sessionId);

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

    // Clear matchmaking timeouts of both paired players
    const timeoutA = this.matchmakingTimeouts.get(idA);
    if (timeoutA) {
      timeoutA.clear();
      this.matchmakingTimeouts.delete(idA);
    }
    const timeoutB = this.matchmakingTimeouts.get(idB);
    if (timeoutB) {
      timeoutB.clear();
      this.matchmakingTimeouts.delete(idB);
    }

    try {
      // 1. Create the battle room
      const battleRoom = await matchMaker.createRoom("battle", {});
      console.log(`[BattleQueue] Matched ${idA} vs ${idB} → room ${battleRoom.roomId}`);

      // 2. Reserve seats (creates seat reservations; client uses these to join)
      // Forward isAgent + agentId so BattleRoom can apply agent-specific validation
      const resA = await matchMaker.reserveSeatFor(battleRoom, {
        wallet: a?.wallet,
        nickname: a?.nickname,
        deck: a?.deck ?? [],
        isAgent: a?.isAgent ?? false,
        agentId: a?.agentId,
      });
      const resB = await matchMaker.reserveSeatFor(battleRoom, {
        wallet: b?.wallet,
        nickname: b?.nickname,
        deck: b?.deck ?? [],
        isAgent: b?.isAgent ?? false,
        agentId: b?.agentId,
      });

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

  /**
   * Triggers a single-player match against the AI bot after waiting alone for 20 seconds.
   */
  private async triggerSinglePlayerBotMatch(sessionId: string): Promise<void> {
    const player = this.pending.get(sessionId);
    if (!player) return; // Player already paired or left

    // Atomically extract the player
    this.pending.delete(sessionId);
    this.matchmakingTimeouts.delete(sessionId);

    console.log(`[BattleQueue] Matchmaking timeout reached for ${sessionId} (20s). Launching BattleRoom with AI Bot...`);

    try {
      // 1. Create a BattleRoom with triggerBot: true option
      const battleRoom = await matchMaker.createRoom("battle", { triggerBot: true });
      console.log(`[BattleQueue] Created Bot BattleRoom for ${sessionId} → room ${battleRoom.roomId}`);

      // Reset retry counter on success (bot fallback worked this time)
      this.botFallbackRetries.delete(sessionId);

      // 2. Reserve a seat for this player
      // Forward isAgent + agentId so BattleRoom can apply agent-specific validation
      const reservation = await matchMaker.reserveSeatFor(battleRoom, {
        wallet: player.wallet,
        nickname: player.nickname,
        deck: player.deck ?? [],
        isAgent: player.isAgent ?? false,
        agentId: player.agentId,
      });

      // 3. Start handoff
      const client = this.clients.find((c) => c.sessionId === sessionId);
      if (client) {
        this.startHandoff(client, reservation, battleRoom.roomId);
      }
    } catch (err) {
      console.error(`[BattleQueue] triggerSinglePlayerBotMatch failed:`, err);

      // Increment retry counter. After MAX_BOT_FALLBACK_RETRIES failed
      // attempts, give up gracefully and tell the client — prevents
      // infinite loops if the game server is broken.
      const retries = (this.botFallbackRetries.get(sessionId) ?? 0) + 1;
      this.botFallbackRetries.set(sessionId, retries);

      if (retries > BattleQueueRoom.MAX_BOT_FALLBACK_RETRIES) {
        console.error(
          `[BattleQueue] Bot fallback FAILED ${retries} times for ${sessionId}. ` +
          `Giving up — sending matchmakingFailed to client.`,
        );
        // Tell the client the matchmaking failed so they don't sit in limbo
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client) {
          client.send("matchmakingFailed", {
            reason: "bot_fallback_exhausted",
            message: "Could not start a bot match after multiple attempts. " +
                     "The game server may be overloaded. Please try again later.",
            retries,
          });
          // Give the client a moment to receive the message, then leave
          setTimeout(() => { try { void client.leave(); } catch { /* ignore */ } }, 1000);
        }
        this.pending.delete(sessionId);
        this.matchmakingTimeouts.delete(sessionId);
        this.botFallbackRetries.delete(sessionId);
        return;
      }

      // Best-effort recovery: put player back in queue and re-arm timeout
      this.pending.set(sessionId, player);
      const timeout = this.clock.setTimeout(() => {
        this.triggerSinglePlayerBotMatch(sessionId);
      }, MATCHMAKING_TIMEOUT_MS);
      this.matchmakingTimeouts.set(sessionId, timeout);
    }
  }
}
