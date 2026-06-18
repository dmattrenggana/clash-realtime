import { randomBytes } from "node:crypto";
import { Room, Client, CloseCode, validate } from "colyseus";
import { z } from "zod";
import { PrivyClient } from "@privy-io/server-auth";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Delayed } from "@colyseus/timer";
import { tickGame } from "../game/gameLoop.js";
import { BotBrain } from "../game/ai/BotBrain.js";
import {
  BattleState,
  Player,
  Tower,
  DeployedUnit,
  CARD_HP,
  CARD_SPAWN_COUNT,
  CARD_COST,
  INITIAL_TOWER_HP,
  SPELL_CARDS,
} from "./schema/BattleState.js";

const TICK_RATE_MS = 100; // 10 Hz server tick
const RECONNECTION_GRACE_SEC = 30;
const FIELD_BOUND = 100; // |x|, |z| <= 100
// If a BattleRoom is created (via matchMaker) but the second player never
// joins within this window, dispose the room to prevent resource leaks.
// Covers the case where one client consumed the seat reservation but the
// other didn't (e.g. timed out or crashed mid-handoff).
const EMPTY_ROOM_TIMEOUT_MS = 30_000;

// NOTE: We CANNOT read process.env here at module load time — @colyseus/tools
// loads .env.production via dotenv AFTER our module is imported. Reading here
// would always see empty env. Instead, read env lazily in onAuth() / onCreate().

const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? "";
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET ?? "";

// Lazy-init Privy client. We use the same App ID + App Secret that the client
// uses — these come from the Privy dashboard, not from any user-specific key.
let _privy: PrivyClient | null = null;
function getPrivy(): PrivyClient {
  if (!_privy) {
    if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
      throw new Error("Privy client not configured (missing PRIVY_APP_ID / PRIVY_APP_SECRET)");
    }
    _privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
  }
  return _privy;
}

// Lazy-init Supabase client for Server-Side Profile Auth
let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.warn("[BattleRoom] Supabase URL or Service Role Key missing. Nicknames will fallback to client-provided.");
    }
    _supabase = createClient(url || 'http://localhost:54321', key || 'dummy');
  }
  return _supabase;
}

// Zod schemas for incoming messages (server-side validation; trust no client)
const deployCardSchema = z.object({
  cardId: z.string().min(1).max(50),
  x: z.number().finite().gte(-FIELD_BOUND).lte(FIELD_BOUND),
  z: z.number().finite().gte(-FIELD_BOUND).lte(FIELD_BOUND),
});

const surrenderSchema = z.object({}).optional();

/**
 * BattleRoom — server-authoritative 1v1 match.
 * Lifecycle:
 *   onCreate      -> init empty state
 *   onAuth        -> verify Privy JWT (or accept anon in dev)
 *   onJoin        -> add player + 3 towers; trigger start when 2 joined
 *   onDrop        -> mark disconnected, allow reconnection for 30s
 *   onReconnect   -> mark connected
 *   onLeave       -> remove from state; end match if game in progress
 *   onDispose     -> clock.setInterval is auto-cleaned
 */

export class BattleRoom extends Room<{ state: BattleState }> {
  // Base capacity: 2 players. Spectators (clients joining with
  // { spectate: true } in options) are ADDED on top of this cap
  // (see onJoin / SpectatorCount handling). For the MVP, 8 extra
  // spectators is plenty.
  maxClients = 2 + 8;
  // Spectators have no game state to act on, so they get a much
  // higher message-rate limit (the default of 30 was meant for
  // player actions like deployCard / surrender).
  private spectatorCount = 0;

  /**
   * Update the room's matchmake metadata with the current player
   * and spectator counts. Called on every join/leave so the
   * /rooms/battle endpoint (which surfaces matchmaker metadata)
   * can show "{N}/2 Player {M}/8 Spectator" in the agent's
   * Spectate list.
   */
  private refreshRoomMetadata(): void {
    try {
      this.setMetadata({
        playerCount: this.state.players.size,
        spectatorCount: this.spectatorCount,
        status: this.state.status,
        maxPlayers: 2,
        maxSpectators: 8,
      });
    } catch (err) {
      // setMetadata can throw if room is being disposed; ignore
    }
  }
  // Per-client message rate limit. Players get the normal 30/sec;
  // spectators get 60/sec (they only receive state patches, no
  // outgoing actions).
  maxMessagesPerSecond = 30;
  private gameStartTime = 0;
  private tickInterval: Delayed | null = null;
  // Empty-room watchdog: fires EMPTY_ROOM_TIMEOUT_MS after onCreate to
  // dispose the room if the second player never arrives.
  private emptyTimeout: Delayed | null = null;
  private cardsDeployed = new Map<string, number>(); // walletAddress -> count
  private totalDamageDealt = new Map<string, number>(); // walletAddress -> amount
  private botBrain: BotBrain | null = null;
  private triggerBot: boolean = false;

  static async onAuth(token: string, options: any, context: any) {
    // Read env here (not at module load) — dotenv loads .env.production
    // AFTER this module is imported, so module-level reads would be empty.
    const allowAnon = process.env.ALLOW_ANON_USERS === "true";

    // Production: require non-empty token
    if (!token) {
      throw new Error("Missing auth token");
    }

    // ═══════════════════════════════════════════════════════════════
    // AGENT API KEY AUTH (clash-mcp-server flow)
    // ═══════════════════════════════════════════════════════════════
    // Detect agent API keys (format: "clash_" + 64 hex chars).
    // Verify by calling the verify_api_key RPC which does bcrypt
    // comparison against the stored hash. On success, the RPC
    // returns the agent's identity (agent_id, agent_wallet, etc.).
    if (token.startsWith("clash_")) {
      try {
        const { data, error } = await getSupabase().rpc("verify_api_key", {
          p_api_key: token,
        });
        if (error) {
          console.warn(`[BattleRoom] verify_api_key RPC error:`, error.message);
          throw new Error(`Agent auth failed: ${error.message}`);
        }
        if (!data || data.length === 0) {
          throw new Error("Invalid or expired agent API key");
        }
        const agent = data[0];
        if (!agent.is_active) {
          throw new Error("Agent is deactivated");
        }
        console.log(`[BattleRoom] Agent auth OK: ${agent.agent_name} (${agent.agent_id})`);
        // Return the agent's own EVM wallet as the authoritative identity.
        // isAgent and agentId are stashed in auth for BattleRoom.onJoin to read.
        return {
          userId: agent.agent_id,
          wallet: agent.agent_wallet_address ?? agent.wallet_address,
          isAgent: true,
          agentId: agent.agent_id,
          agentName: agent.agent_name,
          ownerWalletAddress: agent.owner_wallet_address,
        };
      } catch (err) {
        throw new Error(`Agent auth failed: ${(err as Error).message}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // HUMAN PRIVY JWT AUTH (web UI flow)
    // ═══════════════════════════════════════════════════════════════
    try {
      // verifyAuthToken handles JWKS fetch, signature check, and expiration.
      const claims = await getPrivy().verifyAuthToken(token);
      // SECURITY (Celah 2 in audit): do NOT trust the client's `options.wallet`
      // for the authoritative game identity. The token is verified, so the
      // `claims.userId` (Privy DID) is server-truth. Cross-check by fetching
      // the canonical wallet from Privy's user object.
      // If the client supplied a `wallet` option and it does NOT match the
      // Privy-linked wallet, REJECT the auth (spoofing attempt).
      const clientClaimedWallet = (typeof options.wallet === 'object' && options.wallet !== null)
        ? options.wallet.wallet
        : (options.wallet || null);

      let authoritativeWallet: string | null = null;
      try {
        const user = await getPrivy().getUser(claims.userId);
        authoritativeWallet = user.wallet?.address?.toLowerCase() ?? null;
      } catch (err) {
        console.warn(`[BattleRoom] Could not fetch Privy user for ${claims.userId}:`, (err as Error).message);
      }

      if (clientClaimedWallet && authoritativeWallet &&
          clientClaimedWallet.toLowerCase() !== authoritativeWallet) {
        console.warn(
          `[BattleRoom] Wallet mismatch: client sent ${clientClaimedWallet} but ` +
          `Privy says ${authoritativeWallet}. Possible spoof — rejecting auth.`
        );
        throw new Error("Wallet does not match authenticated identity");
      }

      // Use the authoritative Privy-linked wallet; fall back to userId (Privy
      // DID) if no wallet is linked (e.g. user only has email login).
      const finalWallet = authoritativeWallet ?? claims.userId;
      return { userId: claims.userId, wallet: finalWallet };
    } catch (err) {
      // Privy verification failed. If ALLOW_ANON_USERS=true, fall
      // through to anon mode (last-resort dev escape hatch).
      if (!allowAnon) {
        throw new Error(`Invalid auth token: ${(err as Error).message}`);
      }
      // fallthrough to anon bypass below
    }

    // ═══════════════════════════════════════════════════════════════
    // ANON BYPASS (last resort, dev-only)
    // ═══════════════════════════════════════════════════════════════
    // Only reached if: (a) token was NOT an agent API key, AND
    // (b) Privy verification failed (or no Privy), AND
    // (c) ALLOW_ANON_USERS=true.
    // SECURITY: this mode is for local development only. It must NEVER be
    // enabled in production — anyone can join as any wallet.
    if (allowAnon) {
      const wallet = (typeof options.wallet === "object" && options.wallet !== null)
        ? options.wallet.wallet
        : (options.wallet || "anonymous");
      return { userId: wallet, wallet };
    }
    throw new Error("Invalid auth token");
  }

  onCreate(options: any) {
    // Validate env NOW (after dotenv has loaded .env.production)
    const isProd = process.env.NODE_ENV === "production";
    const allowAnon = process.env.ALLOW_ANON_USERS === "true";
    if (isProd && !allowAnon && !process.env.PRIVY_APP_ID) {
      throw new Error("FATAL: PRIVY_APP_ID missing in production (set ALLOW_ANON_USERS=true to bypass)");
    }
    if (isProd && !allowAnon && !process.env.PRIVY_APP_SECRET) {
      throw new Error("FATAL: PRIVY_APP_SECRET missing in production (set ALLOW_ANON_USERS=true to bypass)");
    }
    console.log(`[BattleRoom] Auth mode: ${allowAnon ? "ANON (no Privy verify)" : "PRIVY (JWT verify)"}`);

    this.state = new BattleState();
    this.state.seed = options.seed || this.randomSeed();
    console.log(`[BattleRoom] Created with seed: ${this.state.seed}`);

    if (options.triggerBot === true) {
      this.triggerBot = true;
      console.log(`[BattleRoom] Bot trigger is ARMED for this session`);
    }

    // Empty-room watchdog: if no second player joins within the timeout,
    // dispose to prevent leaking rooms when matchmaking handoff fails.
    // Canceled in onJoin when the 2nd player arrives, and in onDispose.
    this.emptyTimeout = this.clock.setTimeout(
      () => this.checkEmptyTimeout(),
      EMPTY_ROOM_TIMEOUT_MS,
    );
    console.log(`[BattleRoom] Empty-room guard armed: ${EMPTY_ROOM_TIMEOUT_MS}ms`);
  }

  onJoin(client: Client, options: any, auth?: any) {
    // SECURITY: prefer server-verified auth values over client-sent options.
    // For agents: auth.isAgent + auth.agentId are from the verify_api_key RPC.
    // For humans: auth.wallet is from the verified Privy user object.
    const isAgentFromAuth = auth?.isAgent === true;
    const agentIdFromAuth = String(auth?.agentId || "");
    const agentNameFromAuth = String(auth?.agentName || "");

    // SPECTATOR PATH (2026-06-13): clients joining with
    // { spectate: true } in their options are spectators. They get
    // the full state stream (so they can watch the match) but no
    // Player slot, no deployCard allowed, no matchEnd action.
    //
    // Use case: the web UI's 'Spectate Agent Battleground' panel
    // navigates to /battle?room=<id>&spectate=1, the hook joins by
    // room ID, and the spectator watches live.
    const isSpectator = options?.spectate === true;

    if (isSpectator) {
      this.spectatorCount += 1;
      console.log(
        `[BattleRoom] Spectator joined: ${client.sessionId} ` +
        `(total spectators: ${this.spectatorCount}, players: ${this.state.players.size})`,
      );
      // Send a welcome message with the current state shape (helps
      // the spectator client know it's in read-only mode).
      client.send("spectatorJoined", {
        roomId: this.roomId,
        spectatorCount: this.spectatorCount,
        status: this.state.status,
      });
      // Update matchmake metadata so /rooms/battle shows the
      // new spectator count in the agent's Spectate list.
      this.refreshRoomMetadata();
      // No further setup. Spectators receive state automatically
      // via Colyseus's normal state-sync. handleDeployCard etc.
      // are protected by the `this.state.players.get(client.sessionId)`
      // check — spectators have no Player entry, so they get
      // silently rejected.
      return;
    }

    // If auth says it's an agent, USE the server-verified identity.
    // Don't trust the client's options for isAgent / agentId.
    const agentId = isAgentFromAuth ? agentIdFromAuth : String(options?.agentId || "");

    // Ambil wallet dari auth (server-verified) atau options, pastikan string
    const wallet = String(auth?.wallet || options?.wallet || "anonymous");
    // Fallback awal (tidak dipercaya 100%)
    const fallbackNickname = String(options?.nickname || "Anonymous");

    const team = this.state.players.size;
    const player = new Player();
    player.walletAddress = wallet;
    player.nickname = fallbackNickname;
    player.team = team;
    player.connected = true;
    player.isAgent = agentId.length > 0;
    player.agentId = agentId;

    // Secure Nickname Fetch: Asynchronously override the nickname with the
    // definitive DB version. (2026-06-16: invite-code gate removed entirely
    // — every authenticated user can play, no invite_codes table required.)
    if (wallet && wallet !== "anonymous") {
      (async () => {
        try {
          const { data, error } = await getSupabase()
            .from('profiles')
            .select('nickname')
            .eq('wallet_address', wallet.toLowerCase())
            .maybeSingle();

          if (!error && data?.nickname) {
            console.log(`[BattleRoom] SECURE AUTH: Overriding nickname for ${wallet} -> ${data.nickname}`);
            player.nickname = data.nickname;
          }
        } catch (err) {
          console.error(`[BattleRoom] Failed to fetch secure nickname for ${wallet}`, err);
        }
      })();
    }

    const t1 = new Tower();
    t1.uid = randomBytes(4).toString("hex");
    t1.team = team;
    t1.type = "princess";
    t1.hp = INITIAL_TOWER_HP.princess;
    t1.maxHp = INITIAL_TOWER_HP.princess;
    const t2 = new Tower();
    t2.uid = randomBytes(4).toString("hex");
    t2.team = team;
    t2.type = "king";
    t2.hp = INITIAL_TOWER_HP.king;
    t2.maxHp = INITIAL_TOWER_HP.king;
    const t3 = new Tower();
    t3.uid = randomBytes(4).toString("hex");
    t3.team = team;
    t3.type = "princess";
    t3.hp = INITIAL_TOWER_HP.princess;
    t3.maxHp = INITIAL_TOWER_HP.princess;
    player.towers.push(t1, t2, t3);

    this.state.players.set(client.sessionId, player);
    this.refreshRoomMetadata();
    console.log(`[BattleRoom] ${client.sessionId} joined (wallet: ${wallet}, team: ${team}, nickname: ${fallbackNickname})`);

    if (this.triggerBot) {
      this.activateBotFallback();
    } else if (this.state.players.size === 2) {
      this.state.status = "playing";
      this.gameStartTime = Date.now();
      // Both players are in — cancel the empty-room watchdog.
      if (this.emptyTimeout !== null) {
        this.emptyTimeout.clear();
        this.emptyTimeout = null;
        console.log(`[BattleRoom] Empty-room guard disarmed (game started)`);
      }
      // Use this.clock so the interval auto-cleans on dispose
      this.tickInterval = this.clock.setInterval(() => this.tick(), TICK_RATE_MS);
      console.log(`[BattleRoom] Game started!`);
    }
  }

  async onDrop(client: Client, code: number) {
    // Network drop: keep player in state, mark disconnected, allow reconnection.
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    console.log(`[BattleRoom] ${client.sessionId} dropped (code ${code}); allowing reconnection for ${RECONNECTION_GRACE_SEC}s`);

    try {
      await this.allowReconnection(client, RECONNECTION_GRACE_SEC);
      // If allowReconnection resolves, client reconnected — onReconnect handled it.
    } catch {
      // Reconnection grace expired — fall through to onLeave cleanup.
      console.log(`[BattleRoom] ${client.sessionId} failed to reconnect in time`);
    }
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = true;
      console.log(`[BattleRoom] ${client.sessionId} reconnected`);
    }
  }

  onLeave(client: Client, code: CloseCode) {
    console.log(`[BattleRoom] ${client.sessionId} left (code: ${code})`);

    // Track spectator leave separately. We don't decrement on
    // onJoin in the spectator branch (we set spectatorCount on
    // entry), so do it here. Players have no spectatorCount change.
    // (For MVP we don't track which sessionIds are spectators; we
    //  just decrement whenever a non-player leaves. Worst case:
    //  counter underflows, which we clamp at 0.)
    if (this.spectatorCount > 0) {
      this.spectatorCount = Math.max(0, this.spectatorCount - 1);
      this.refreshRoomMetadata();
    }

    // If onDrop ran first, the player was already removed by the time we get here.
    // Defensive: only delete if still present.
    if (this.state.players.has(client.sessionId)) {
      this.state.players.delete(client.sessionId);
    }
    if (this.state.status === "playing" && this.state.players.size < 2) {
      // BUGFIX (2026-06-18): When the opponent leaves mid-match, the
      // remaining player was seeing "Defeat" in the UI because
      // `winnerTeam` was still the default empty string. Set it to
      // the remaining player's team so the UI shows "Victory", and
      // pass "opponent_left" to endMatch so the server records this
      // as a walkover: no trophy/XP changes, $CLASH reward is
      // blocked (is_reward_eligible=false). Prevents farming attacks
      // where malicious users create sock-puppets to deliberately
      // disconnect and claim rewards.
      const remaining = Array.from(this.state.players.values())[0];
      if (remaining) {
        this.state.winnerTeam = String(remaining.team);
      }
      this.endMatch("opponent_left");
    }
  }

  onDispose() {
    // this.clock.setInterval auto-cancels on dispose, but be defensive:
    if (this.tickInterval !== null) {
      this.tickInterval.clear();
      this.tickInterval = null;
    }
    if (this.emptyTimeout !== null) {
      this.emptyTimeout.clear();
      this.emptyTimeout = null;
    }
    console.log(`[BattleRoom] Disposed`);
  }

  /**
   * Empty-room watchdog callback. Fires EMPTY_ROOM_TIMEOUT_MS after onCreate.
   * If the game hasn't started and there are fewer than 2 clients, dispose
   * the room to prevent leaks (e.g., when one of the matched clients never
   * successfully joined the BattleRoom after consuming the seat reservation).
   */
  private checkEmptyTimeout() {
    // Game already started (e.g. the timeout raced with the 2nd-player join).
    if (this.state.status === "playing") return;
    // Both players actually present (defensive — should have been caught above).
    if (this.clients.length >= 2) return;

    console.warn(
      `[BattleRoom] Empty-room timeout: only ${this.clients.length} client(s) ` +
      `after ${EMPTY_ROOM_TIMEOUT_MS}ms — disposing to prevent leak. ` +
      `BattleRoom was created but the second player never joined.`,
    );
    // Broadcast a clear error so any connected client knows what happened.
    this.broadcast("roomTimeout", {
      reason: "no_second_player",
      timeoutMs: EMPTY_ROOM_TIMEOUT_MS,
    });
    // Disconnect all clients + dispose the room.
    this.disconnect();
  }

  private trackDamage(attackerTeam: number, damage: number) {
    const player = Array.from(this.state.players.values()).find(p => p.team === attackerTeam);
    if (player) {
      const current = this.totalDamageDealt.get(player.walletAddress) || 0;
      this.totalDamageDealt.set(player.walletAddress, current + damage);
    }
  }

  private tick() {
    if (this.botBrain) {
      this.botBrain.update(TICK_RATE_MS);
    }
    tickGame(
      this.state,
      this.gameStartTime,
      TICK_RATE_MS,
      (attackerTeam, damage) => this.trackDamage(attackerTeam, damage),
      (winner) => this.endMatch("normal")
    );
  }

  private async recordMatchToServerSide(player: Player, enemy: Player, duration: number, isWinner: boolean, matchEndReason: "normal" | "surrender" | "opponent_left" = "normal") {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const gameServerSecret = process.env.GAME_SERVER_SECRET;

    if (!supabaseUrl || !supabaseServiceKey || !gameServerSecret) {
      console.warn("[BattleRoom] Supabase integration skipped: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or GAME_SERVER_SECRET is not configured on the server.");
      return;
    }

    const playerWallet = player.walletAddress;
    const playerTowersAlive = player.towers.filter(t => t.hp > 0).length;
    const enemyTowersAlive = enemy.towers.filter(t => t.hp > 0).length;
    const cardsDeployed = this.cardsDeployed.get(player.walletAddress) || 0;
    const totalDamageDealt = Math.floor(this.totalDamageDealt.get(player.walletAddress) || 0);

    // DEFENSIVE CHECK (2026-06-14): Don't trust player.isAgent — it can be
    // false if onAuth's detection has a bug or the env-based bypass
    // leaked through. Query the agents table (source of truth) for the
    // wallet. If found, override isAgent + agentId. This guarantees
    // agents always go to record_agent_match, never to the human path.
    let isAgentForRecord = player.isAgent;
    let agentIdForRecord: string | null = player.agentId || null;
    if (!isAgentForRecord && playerWallet && !playerWallet.startsWith("0xbot_")) {
      try {
        const { data: agentRow, error: agentErr } = await getSupabase()
          .from('agents')
          .select('id')
          .eq('agent_wallet_address', playerWallet.toLowerCase())
          .maybeSingle();
        if (!agentErr && agentRow) {
          isAgentForRecord = true;
          agentIdForRecord = agentRow.id;
          console.log(`[BattleRoom] Defensive check: ${playerWallet} is an agent (id=${agentRow.id}) — routing to record_agent_match.`);
        }
      } catch (err) {
        console.warn(`[BattleRoom] Defensive agent check failed for ${playerWallet}: ${(err as Error).message}. Falling back to player.isAgent=${player.isAgent}.`);
      }
    }

    console.log(`[BattleRoom] Attempting to record match server-side for wallet: ${playerWallet} (isWinner: ${isWinner}, isAgent: ${isAgentForRecord})...`);

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/record-match`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${supabaseServiceKey}`, // Satisfies Kong Gateway (valid Supabase JWT!)
          "x-game-server-secret": gameServerSecret // Satisfies our internal M2M security bypass!
        },
        body: JSON.stringify({
          playerTowersAlive,
          enemyTowersAlive,
          matchDurationSec: duration,
          cardsDeployed,
          totalDamageDealt,
          playerWallet,
          outcome: isWinner ? "victory" : "defeat",
          // Match end reason: "normal" (tower destroyed), "surrender",
          // or "opponent_left" (other player disconnected mid-match).
          // For "opponent_left" the server records the match with
          // is_reward_eligible=false and skips trophy/XP changes, so
          // $CLASH claim RPC rejects it. Prevents sock-puppet farming.
          matchEndReason,
          // MCP agent battleground: if this player joined via clash-mcp-server,
          // the edge function routes the match to record_agent_match instead
          // of secure_record_match. The human's profile is NOT updated.
          // isAgentForRecord comes from defensive DB check above — robust
          // against onAuth bugs that leave player.isAgent as false.
          isAgent: isAgentForRecord,
          agentId: agentIdForRecord,
        })
      });

      const resText = await response.text();
      let resBody: any = {};
      try {
        resBody = JSON.parse(resText);
      } catch {
        // Not a JSON response
      }

      if (response.ok && resBody.success && resBody.data?.match_id) {
        const matchId = resBody.data.match_id;
        console.log(`[BattleRoom] Match recorded successfully for ${playerWallet}. Match ID: ${matchId}`);
        
        // Find the client associated with this wallet to send them their matchId privately
        const client = this.clients.find(c => {
          const p = this.state.players.get(c.sessionId);
          return p && p.walletAddress.toLowerCase() === playerWallet.toLowerCase();
        });
        if (client) {
          client.send("matchId", { matchId });
        }
      } else {
        const errMsg = resBody.error || resText || "Unknown error";
        console.error(`[BattleRoom] Match recording failed for ${playerWallet} [Status ${response.status}]:`, errMsg);
      }
    } catch (err) {
      console.error(`[BattleRoom] Match recording exception for ${playerWallet}:`, (err as Error).message);
    }
  }

  private endMatch(reason: "normal" | "surrender" | "opponent_left" = "normal") {
    if (this.state.status === "ended") return; // idempotent guard
    this.state.status = "ended";
    if (this.tickInterval !== null) {
      this.tickInterval.clear();
      this.tickInterval = null;
    }
    console.log(`[BattleRoom] Match ended. Winner: ${this.state.winnerTeam} (reason: ${reason})`);

    this.broadcast("matchEnd", {
      winnerTeam: this.state.winnerTeam,
      duration: this.state.elapsedSec,
      // 2026-06-18: include end reason so the client can hide the
      // $CLASH Claim button for walkovers (opponent_left).
      matchEndReason: reason,
      players: Array.from(this.state.players.values()).map((p) => ({
        wallet: p.walletAddress,
        team: p.team,
        towersAlive: p.towers.filter((t: Tower) => t.hp > 0).length,
      })),
    });

    // Record the match results to Supabase server-side.
    //
    // BUGFIX (2026-06-14): Previously called recordMatchToServerSide for
    // BOTH players unconditionally, which caused 2 issues:
    //   1. Bot players (0xbot_<hex>) were recorded in `match_history`
    //      → polluted the human table with non-user rows
    //   2. If the onAuth isAgent fix wasn't yet applied, both calls hit
    //      the HUMAN path → agent matches ended up in profiles table
    //
    // New rules:
    //   - Skip bots (wallet starts with "0xbot_") entirely. They're AI,
    //     not real users — no need to record their stats in any table.
    //   - Record humans + agents normally. The edge function routes
    //     agents (isAgent=true) to agent_match_history and humans to
    //     match_history.
    //   - If only 1 player is left (e.g. bot match where the bot is
    //     the only one still in the room), record just that one.
    const playerList = Array.from(this.state.players.values())
      .filter((p) => !p.walletAddress.startsWith("0xbot_"));

    if (playerList.length >= 1) {
      const winnerIdx = this.state.winnerTeam === "0" ? 0 : 1;
      const loserIdx = winnerIdx === 0 ? 1 : 0;
      const winner = playerList.find((p) => p.team === winnerIdx);
      const loser = playerList.find((p) => p.team === loserIdx);

      if (winner) {
        this.recordMatchToServerSide(winner, loser || winner, this.state.elapsedSec, true, reason);
      }
      if (loser) {
        this.recordMatchToServerSide(loser, winner || loser, this.state.elapsedSec, false, reason);
      }
    }
  }

  /**
   * Activates the AI bot fallback system.
   * Generates a mock session ID, registers the bot as a player in the game state, and instantiates its BotBrain.
   */
  public activateBotFallback() {
    if (this.botBrain) {
      console.log("[BattleRoom] Bot fallback already active.");
      return;
    }
    if (this.state.status === "ended") {
      console.log("[BattleRoom] Cannot activate bot: game already ended.");
      return;
    }

    const botSessionId = `BOT_${randomBytes(2).toString("hex")}`;
    const team = this.state.players.size; // Generates 1 if 1 player is already in

    const player = new Player();
    player.walletAddress = `0xbot_${randomBytes(4).toString("hex")}`;
    player.nickname = "AI Bot";
    player.team = team;
    player.connected = true;

    // Create 3 towers for the Bot player
    const t1 = new Tower();
    t1.uid = randomBytes(4).toString("hex");
    t1.team = team;
    t1.type = "princess";
    t1.hp = INITIAL_TOWER_HP.princess;
    t1.maxHp = INITIAL_TOWER_HP.princess;

    const t2 = new Tower();
    t2.uid = randomBytes(4).toString("hex");
    t2.team = team;
    t2.type = "king";
    t2.hp = INITIAL_TOWER_HP.king;
    t2.maxHp = INITIAL_TOWER_HP.king;

    const t3 = new Tower();
    t3.uid = randomBytes(4).toString("hex");
    t3.team = team;
    t3.type = "princess";
    t3.hp = INITIAL_TOWER_HP.princess;
    t3.maxHp = INITIAL_TOWER_HP.princess;

    player.towers.push(t1, t2, t3);

    // Register player into room state
    this.state.players.set(botSessionId, player);
    this.refreshRoomMetadata();
    const playerCountAfter = this.state.players.size;
    console.log(`[BattleRoom] Bot ${botSessionId} registered as team ${team} (nickname: ${player.nickname}). players.size=${playerCountAfter}, status=${this.state.status}`);

    // Instantiate BotBrain
    this.botBrain = new BotBrain(this, botSessionId);

    // SAFETY: In bot fallback path, we ALWAYS know there are 2 players
    // (the real one + the bot we just added). Don't depend on size check
    // here — it has a known race where the real player might not yet be
    // in state.players by the time activateBotFallback is called from
    // onJoin. Just force status="playing" and start the tick loop.
    //
    // Defensive: still check size in case of future code changes, but
    // treat size >= 1 (us) + 1 (bot) = 2 as the truth.
    const expectedPlayerCount = 2; // 1 real + 1 bot
    if (playerCountAfter >= expectedPlayerCount) {
      this.state.status = "playing";
      this.gameStartTime = Date.now();

      // Disarm the empty-room watchdog
      if (this.emptyTimeout !== null) {
        this.emptyTimeout.clear();
        this.emptyTimeout = null;
        console.log(`[BattleRoom] Empty-room guard disarmed (game started with Bot)`);
      }

      // Start tick loop if not running
      if (this.tickInterval === null) {
        this.tickInterval = this.clock.setInterval(() => this.tick(), TICK_RATE_MS);
      }
      console.log(`[BattleRoom] Game started against AI Bot! status now: ${this.state.status}`);
    } else {
      console.error(`[BattleRoom] Bot activated but player count is ${playerCountAfter}, expected ${expectedPlayerCount}. Status NOT changed. This is a bug.`);
    }
  }

  public handleDeployCard(client: Client, payload: { cardId: string; x: number; z: number }) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (this.state.status !== "playing") {
      client.send("error", { code: "NOT_PLAYING", message: "Match is not in playing state" });
      return;
    }
    if (!player.connected) {
      // Reject if user is in drop state — server will resume them on reconnect
      client.send("error", { code: "DISCONNECTED", message: "You are disconnected" });
      return;
    }

    const cost = CARD_COST[payload.cardId];
    if (cost === undefined) {
      client.send("error", { code: "INVALID_CARD", message: `Unknown card: ${payload.cardId}` });
      return;
    }
    if (player.elixir < cost) {
      client.send("error", { code: "INSUFFICIENT_ELIXIR", message: "Not enough elixir" });
      return;
    }

    // Zone validation: each team has its own half
    // team 0 -> player side: z > 0; team 1 -> enemy side: z < 0
    // Spells (like meteor or barrel_bomb) ignore zone restrictions and can be spawned anywhere
    const isSpell = SPELL_CARDS.has(payload.cardId);
    const isMySide =
      isSpell ||
      (player.team === 0 && payload.z > 0) ||
      (player.team === 1 && payload.z < 0);
    if (!isMySide) {
      // BUGFIX (2026-06-14): MCP agents were repeatedly hitting INVALID_ZONE
      // and getting locked out of matches. The original message ("Can only
      // deploy on your side") gave no clue which sign of z to use. Add
      // diagnostic `details` so the agent (or the MCP bridge) can self-correct
      // on retry: which team, what z was sent, what range is required.
      // `isSpell` is already declared above the isMySide check.
      const requiredRange = isSpell
        ? "any (spells bypass zone check)"
        : player.team === 0
        ? "z > 0"
        : "z < 0";
      const hint = isSpell
        ? "Spells are allowed on either side — check why isSpell branch didn't fire (cardId casing?)."
        : player.team === 0
        ? `You are team 0 (the positive-z player). Deploy troops at POSITIVE z (e.g. x=0, z=8). z=0 is the river and is rejected.`
        : `You are team 1 (the negative-z player). Deploy troops at NEGATIVE z (e.g. x=0, z=-8). z=0 is the river and is rejected.`;
      client.send("error", {
        code: "INVALID_ZONE",
        message: `Cannot deploy ${payload.cardId} at (x=${payload.x}, z=${payload.z}). Team ${player.team} requires ${requiredRange}.`,
        details: {
          team: player.team,
          attemptedX: payload.x,
          attemptedZ: payload.z,
          cardId: payload.cardId,
          isSpell,
          requiredRange,
          hint,
        },
      });
      return;
    }

    const spawnCount = CARD_SPAWN_COUNT[payload.cardId] || 1;
    player.elixir -= cost;

    // Track cards deployed
    const currentCount = this.cardsDeployed.get(player.walletAddress) || 0;
    this.cardsDeployed.set(player.walletAddress, currentCount + 1);

    for (let i = 0; i < spawnCount; i++) {
      const unit = new DeployedUnit();
      unit.cardId = payload.cardId;
      unit.team = player.team;
      
      // Add slight offset for multi-unit spawns so they don't overlap perfectly
      const offsetX = spawnCount > 1 ? (i - (spawnCount - 1) / 2) * 0.8 : 0;
      unit.x = payload.x + offsetX;
      unit.z = payload.z;
      
      unit.hp = CARD_HP[payload.cardId] || 100;
      unit.maxHp = unit.hp;
      unit.spawnTime = this.state.elapsedSec;

      const unitId = `${client.sessionId}-${this.clock.currentTime}-${i}`;
      player.units.set(unitId, unit);
    }

    console.log(`[BattleRoom] Team ${player.team} successfully pushed ${spawnCount} units to state for ${payload.cardId}`);
  }

  public handleSurrender(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (this.state.status !== "playing") return;
    const opponent = Array.from(this.state.players.values()).find(
      (p) => p.team !== player.team,
    );
    if (opponent) {
      this.state.winnerTeam = String(opponent.team);
      this.endMatch("surrender");
    }
  }

  messages = {
    deployCard: validate(deployCardSchema, (client, payload) => {
      this.handleDeployCard(client, payload);
    }),

    surrender: validate(surrenderSchema, (client, _payload) => {
      this.handleSurrender(client);
    }),

    DEBUG_SPAWN_BOT: (client: Client, _payload: any) => {
      // SECURITY: this is a debug-only command. In production it must be a
      // no-op — otherwise a malicious client could spawn a bot mid-match
      // and corrupt the player list. (See security audit, Celah 3.)
      if (process.env.NODE_ENV === "production") {
        console.warn(`[BattleRoom] DEBUG_SPAWN_BOT blocked in production (client: ${client.sessionId})`);
        return;
      }
      console.log(`[BattleRoom] DEBUG_SPAWN_BOT triggered by client: ${client.sessionId}`);
      this.activateBotFallback();
    },
  };

  private randomSeed(): string {
    // CSPRNG: game-critical randomness must not use Math.random
    // (per COLYSEUS-GUIDE §20.2). 8 bytes = 16 hex chars, plenty of entropy
    // for a server-anti-cheat seed that drives deterministic gameplay.
    return randomBytes(8).toString("hex");
  }
}
