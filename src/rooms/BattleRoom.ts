import { randomBytes } from "node:crypto";
import { Room, Client, CloseCode, validate } from "colyseus";
import { z } from "zod";
import { PrivyClient } from "@privy-io/server-auth";
import type { Delayed } from "@colyseus/timer";
import {
  BattleState,
  Player,
  Tower,
  DeployedUnit,
  CARD_HP,
  CARD_SPAWN_COUNT,
  CARD_COST,
  CARD_DPS,
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
    t1.type = "princess";
    t1.hp = INITIAL_TOWER_HP.princess;
    t1.maxHp = INITIAL_TOWER_HP.princess;
    const t2 = new Tower();
    t2.type = "king";
    t2.hp = INITIAL_TOWER_HP.king;
    t2.maxHp = INITIAL_TOWER_HP.king;
    const t3 = new Tower();
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
    if (this.state.status !== "playing") return;

    this.state.elapsedSec = Math.floor((Date.now() - this.gameStartTime) / 1000);

    // Regen elixir
    this.state.players.forEach((p: Player) => {
      if (p.elixir < 10) {
        p.elixir = Math.min(10, p.elixir + ELIXIR_REGEN_PER_SEC * (TICK_RATE_MS / 1000));
      }
    });

    this.moveUnits();
    this.applyUnitDamage();
    this.processSpells();
    this.checkWinCondition();
  }

  /**
   * Spell processing (static AoE):
   *  - meteor: detonates after a fixed timer (SPELL_DETONATE_AFTER_MS).
   *  - barrel_bomb: detonates when an enemy enters SPELL_TRIGGER_RADIUS.
   *  On detonation, deal SPELL_DAMAGE to all enemy units + enemy towers
   *  within SPELL_SPLASH_RADIUS, then DELETE the unit from the MapSchema
   *  so the client stops rendering it. Spells never move, never auto-
   *  target, never auto-attack — that logic lives in moveUnits /
   *  applyUnitDamage which explicitly skip SPELL_CARDS.
   */
  private processSpells() {
    const playerList = Array.from(this.state.players.values());
    if (playerList.length === 0) return;

    playerList.forEach((player) => {
      const enemy = playerList.find((p) => p.team !== player.team);
      // We must collect IDs first, then delete after the forEach to
      // avoid mutating the Map while iterating it (Colyseus MapSchema
      // iterators are not safe for in-place deletion).
      const toDetonate: string[] = [];
      const now = Date.now();

      player.units.forEach((unit, id) => {
        if (!SPELL_CARDS.has(unit.cardId)) return;
        if (unit.hp <= 0) return; // already detonated, will be cleaned up below

        const trigger = SPELL_TRIGGER[unit.cardId];
        if (trigger === "timer") {
          // Detonate if `detonateAfterMs` has elapsed since spawn
          const spawnedAt = unit.spawnTime * 1000; // spawnTime is in seconds
          // We use the gameStartTime-based clock for relative timing;
          // simpler: just compare elapsedSec - spawnTime
          const ageSec = this.state.elapsedSec - unit.spawnTime;
          const ageMs = ageSec * 1000;
          if (ageMs >= (SPELL_DETONATE_AFTER_MS[unit.cardId] ?? 800)) {
            toDetonate.push(id);
          }
        } else if (trigger === "proximity") {
          // Detonate if any ENEMY unit is within trigger radius
          if (!enemy) return;
          const triggerR = SPELL_TRIGGER_RADIUS[unit.cardId] ?? 2.0;
          let close = false;
          enemy.units.forEach((eUnit) => {
            if (close) return;
            const d = Math.sqrt(
              Math.pow(eUnit.x - unit.x, 2) + Math.pow(eUnit.z - unit.z, 2)
            );
            if (d <= triggerR) close = true;
          });
          if (close) toDetonate.push(id);
        }
      });

      // Now actually detonate them
      toDetonate.forEach((id) => {
        const unit = player.units.get(id);
        if (!unit) return;
        this.detonateSpell(player, enemy, unit);
        player.units.delete(id); // despawn (drops from client mirror)
      });
    });
  }

  /**
   * Apply AoE damage from a spell to all enemy units + enemy towers
   * within SPELL_SPLASH_RADIUS of the spell's position. Damage is
   * subtracted from each target's HP, floored at 0. Tower HP of 0
   * is recognized by checkWinCondition as "destroyed".
   */
  private detonateSpell(
    _owner: Player,
    enemy: Player | undefined,
    spell: DeployedUnit
  ) {
    if (!enemy) return;
    const radius = SPELL_SPLASH_RADIUS[spell.cardId] ?? 3.0;
    const damage = SPELL_DAMAGE[spell.cardId] ?? 0;
    if (damage <= 0) return;

    // Damage enemy units in radius
    const toKillUnits: string[] = [];
    enemy.units.forEach((eUnit, id) => {
      const d = Math.sqrt(
        Math.pow(eUnit.x - spell.x, 2) + Math.pow(eUnit.z - spell.z, 2)
      );
      if (d <= radius) {
        eUnit.hp = Math.max(0, eUnit.hp - damage);
        if (eUnit.hp <= 0) toKillUnits.push(id);
      }
    });
    toKillUnits.forEach((id) => enemy.units.delete(id));

    // Damage enemy towers in radius
    enemy.towers.forEach((t) => {
      if (t.hp <= 0) return;
      const tx = t.type === "king" ? 0 : (spell.x > 0 ? 6 : -6);
      const tz = enemy.team === 0 ? 14.5 : -14.5;
      const d = Math.sqrt(
        Math.pow(tx - spell.x, 2) + Math.pow(tz - spell.z, 2)
      );
      if (d <= radius) {
        t.hp = Math.max(0, t.hp - damage);
      }
    });
  }

  private moveUnits() {
    const playerList = Array.from(this.state.players.values());

    // 1. First, gather all alive troop units across both teams for collision checking
    const allAliveTroops: { unit: DeployedUnit; isAir: boolean }[] = [];
    playerList.forEach((player) => {
      // Cleanup dead units before moving
      player.units.forEach((unit, id) => {
        if (unit.hp <= 0) {
          player.units.delete(id);
        } else if (!SPELL_CARDS.has(unit.cardId)) {
          allAliveTroops.push({ unit, isAir: AIR_UNITS.has(unit.cardId) });
        }
      });
    });

    // 2. Process movement and collision separation
    playerList.forEach((player) => {
      const enemy = playerList.find((p) => p.team !== player.team);
      if (!enemy) return;

      player.units.forEach((unit) => {
        // Skip spells
        if (SPELL_CARDS.has(unit.cardId)) return;

        const isUnitAir = AIR_UNITS.has(unit.cardId);

        // --- Separation / Collision Avoidance ---
        let pushX = 0;
        let pushZ = 0;
        const pushRadius = 1.2; // The radius within which units push each other

        allAliveTroops.forEach((other) => {
          if (other.unit === unit) return; // Don't push yourself
          if (isUnitAir !== other.isAir) return; // Air and Ground ignore each other

          const dx = unit.x - other.unit.x;
          const dz = unit.z - other.unit.z;
          const distSq = dx * dx + dz * dz;

          if (distSq < pushRadius * pushRadius && distSq > 0.0001) {
            const dist = Math.sqrt(distSq);
            // Stronger push the closer they are
            const pushFactor = (pushRadius - dist) / dist; 
            pushX += dx * pushFactor;
            pushZ += dz * pushFactor;
          } else if (distSq <= 0.0001) {
            // Exactly on top of each other: give a random nudge
            pushX += (Math.random() - 0.5) * 0.1;
            pushZ += (Math.random() - 0.5) * 0.1;
          }
        });

        // Apply separation force (mutate in-place)
        // Weight the push so it doesn't completely override targeting, but smoothly separates
        unit.x += pushX * 0.3;
        unit.z += pushZ * 0.3;

        // --- Target Seeking ---
        let targetX = 0;
        let targetZ = 0;
        let minDist = Infinity;

        // 1. Scan Unit Lawan
        enemy.units.forEach((eUnit) => {
          const d = Math.sqrt(Math.pow(eUnit.x - unit.x, 2) + Math.pow(eUnit.z - unit.z, 2));
          if (d < minDist) {
            minDist = d;
            targetX = eUnit.x;
            targetZ = eUnit.z;
          }
        });

        // 2. Scan Tower Lawan
        enemy.towers.forEach((t: Tower) => {
          if (t.hp <= 0) return;
          // Koordinat tower statis
          const tx = t.type === "king" ? 0 : (unit.x > 0 ? 6 : -6);
          const tz = enemy.team === 0 ? 14.5 : -14.5;
          const d = Math.sqrt(Math.pow(tx - unit.x, 2) + Math.pow(tz - unit.z, 2));
          if (d < minDist) {
            minDist = d;
            targetX = tx;
            targetZ = tz;
          }
        });

        if (minDist === Infinity) return;

        // Insting: Berhenti jika sudah dalam jangkauan serang
        const attackRange = 2.2;

        if (minDist > attackRange) {
          const dx = targetX - unit.x;
          const dz = targetZ - unit.z;
          const speed = 2.5;
          const moveStep = (speed * TICK_RATE_MS) / 1000;
          
          unit.x += (dx / minDist) * moveStep;
          unit.z += (dz / minDist) * moveStep;
        }
      });
    });
  }

  private applyUnitDamage() {
    const playerList = Array.from(this.state.players.values());
    playerList.forEach((attacker) => {
      const enemy = playerList.find((p) => p.team !== attacker.team);
      if (!enemy) return;

      attacker.units.forEach((unit) => {
        // Spells don't auto-attack; their damage is applied in
        // processSpells() / detonateSpell().
        if (SPELL_CARDS.has(unit.cardId)) return;

        let closestTarget: { hp: number } | null = null;
        let minDist = Infinity;

        // Cari target terdekat lagi untuk damage
        enemy.units.forEach((eUnit) => {
          const d = Math.sqrt(Math.pow(eUnit.x - unit.x, 2) + Math.pow(eUnit.z - unit.z, 2));
          if (d < minDist) {
            minDist = d;
            closestTarget = eUnit;
          }
        });

        enemy.towers.forEach((t: Tower) => {
          if (t.hp <= 0) return;
          const tx = t.type === "king" ? 0 : (unit.x > 0 ? 6 : -6);
          const tz = enemy.team === 0 ? 14.5 : -14.5;
          const d = Math.sqrt(Math.pow(tx - unit.x, 2) + Math.pow(tz - unit.z, 2));
          if (d < minDist) {
            minDist = d;
            closestTarget = t;
          }
        });

        // Insting: Hanya beri damage jika target masih hidup dan dalam jangkauan
        if (closestTarget && (closestTarget as any).hp > 0 && minDist <= 2.5) {
          const dps = CARD_DPS[unit.cardId] || 0;
          const damage = Math.floor(dps * (TICK_RATE_MS / 1000));
          closestTarget.hp = Math.max(0, closestTarget.hp - damage);
        }
      });
    });
  }

  private checkWinCondition() {
    const players: Player[] = Array.from(this.state.players.values());
    for (const player of players) {
      const living = player.towers.filter((t: Tower) => t.hp > 0).length;
      if (living === 0) {
        const winner = players.find((p) => p.team !== player.team);
        this.state.winnerTeam = winner ? String(winner.team) : "draw";
        this.endMatch();
        return;
      }
    }
    if (this.state.elapsedSec >= MAX_DURATION) {
      const p0 = players.find((p) => p.team === 0)?.towers.filter((t: Tower) => t.hp > 0).length || 0;
      const p1 = players.find((p) => p.team === 1)?.towers.filter((t: Tower) => t.hp > 0).length || 0;
      this.state.winnerTeam = p0 > p1 ? "0" : p1 > p0 ? "1" : "draw";
      this.endMatch();
    }
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
      const isMySide =
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
