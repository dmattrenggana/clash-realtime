import { randomBytes } from "node:crypto";
import { Room, Client, CloseCode, validate } from "colyseus";
import { z } from "zod";
import { PrivyClient } from "@privy-io/server-auth";
import type { Delayed } from "@colyseus/timer";
import { tickGame } from "../game/gameLoop.js";
import {
  BattleState,
  Player,
  Tower,
  DeployedUnit,
  CARD_HP,
  CARD_SPAWN_COUNT,
  CARD_COST,
  CARD_DPS,
  CARD_ATTACK_SPEED,
  CARD_ATTACK_DAMAGE,
  CARD_RANGE,
  CARD_PROJECTILE_SPEED,
  CARD_ATTACK_SPLASH,
  INITIAL_TOWER_HP,
  ELIXIR_REGEN_PER_SEC,
  MAX_DURATION,
  SPELL_CARDS,
  SPELL_SPLASH_RADIUS,
  SPELL_TRIGGER,
  SPELL_DETONATE_AFTER_MS,
  SPELL_TRIGGER_RADIUS,
  SPELL_DAMAGE,
  AIR_UNITS,
  Projectile,
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

// --- Helper for Tower Coordinates ---
// Maps to frontend's INITIAL_TOWERS positions
function getTowerCoords(tower: Tower, towerTeam: number, attackerX: number): { x: number; z: number } {
  if (tower.type === "king") {
    return { x: 0, z: towerTeam === 0 ? 13 : -13 };
  } else {
    // Princess tower: determine left or right based on the attacker's X position to target the nearest one
    const tx = attackerX > 0 ? 6 : -6;
    return { x: tx, z: towerTeam === 0 ? 10 : -10 };
  }
}

export class BattleRoom extends Room<{ state: BattleState }> {
  maxClients = 2;
  maxMessagesPerSecond = 30;
  private gameStartTime = 0;
  private tickInterval: Delayed | null = null;
  // Empty-room watchdog: fires EMPTY_ROOM_TIMEOUT_MS after onCreate to
  // dispose the room if the second player never arrives.
  private emptyTimeout: Delayed | null = null;

  static async onAuth(token: string, options: any, context: any) {
    // Read env here (not at module load) — dotenv loads .env.production
    // AFTER this module is imported, so module-level reads would be empty.
    const allowAnon = process.env.ALLOW_ANON_USERS === "true";
    
    // Robust wallet extraction from options
    const walletFromOptions = (typeof options.wallet === 'object' && options.wallet !== null)
      ? options.wallet.wallet
      : (options.wallet || "anonymous");

    // Dev/anon mode: bypass ALL auth. Any token (or none) is accepted as anonymous.
    if (allowAnon) {
      return { userId: walletFromOptions, wallet: walletFromOptions };
    }
    // Production: require non-empty token
    if (!token) {
      throw new Error("Missing auth token");
    }
    try {
      // verifyAuthToken handles JWKS fetch, signature check, and expiration.
      const claims = await getPrivy().verifyAuthToken(token);
      return { userId: claims.userId, wallet: walletFromOptions };
    } catch (err) {
      throw new Error("Invalid auth token");
    }
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
    // Ambil wallet dari auth (Privy) atau options, pastikan string
    const wallet = String(auth?.wallet || options?.wallet || "anonymous");
    // Ambil nickname dari options
    const nickname = String(options?.nickname || "Anonymous");

    const team = this.state.players.size;
    const player = new Player();
    player.walletAddress = wallet;
    player.nickname = nickname;
    player.team = team;
    player.connected = true;

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
    console.log(`[BattleRoom] ${client.sessionId} joined (wallet: ${wallet}, team: ${team}, nickname: ${nickname})`);

    if (this.state.players.size === 2) {
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
    // If onDrop ran first, the player was already removed by the time we get here.
    // Defensive: only delete if still present.
    if (this.state.players.has(client.sessionId)) {
      this.state.players.delete(client.sessionId);
    }
    if (this.state.status === "playing" && this.state.players.size < 2) {
      this.endMatch();
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

  private tick() {
    tickGame(this.state, this.gameStartTime, TICK_RATE_MS, (winner) => this.endMatch());
  }

  private endMatch() {
    if (this.state.status === "ended") return; // idempotent guard
    this.state.status = "ended";
    if (this.tickInterval !== null) {
      this.tickInterval.clear();
      this.tickInterval = null;
    }
    console.log(`[BattleRoom] Match ended. Winner: ${this.state.winnerTeam}`);

    this.broadcast("matchEnd", {
      winnerTeam: this.state.winnerTeam,
      duration: this.state.elapsedSec,
      players: Array.from(this.state.players.values()).map((p) => ({
        wallet: p.walletAddress,
        team: p.team,
        towersAlive: p.towers.filter((t: Tower) => t.hp > 0).length,
      })),
    });
  }

  messages = {
    deployCard: validate(deployCardSchema, (client, payload) => {
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
        client.send("error", { code: "INVALID_ZONE", message: "Can only deploy on your side" });
        return;
      }

      const spawnCount = CARD_SPAWN_COUNT[payload.cardId] || 1;
      player.elixir -= cost;

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
    }),

    surrender: validate(surrenderSchema, (client, _payload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (this.state.status !== "playing") return;
      const opponent = Array.from(this.state.players.values()).find(
        (p) => p.team !== player.team,
      );
      if (opponent) {
        this.state.winnerTeam = String(opponent.team);
        this.endMatch();
      }
    }),
  };

  private randomSeed(): string {
    // CSPRNG: game-critical randomness must not use Math.random
    // (per COLYSEUS-GUIDE §20.2). 8 bytes = 16 hex chars, plenty of entropy
    // for a server-anti-cheat seed that drives deterministic gameplay.
    return randomBytes(8).toString("hex");
  }
}
