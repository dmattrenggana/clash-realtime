import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

// === Constants (EXACT same as agones-clash-colyseus) ===
export const INITIAL_TOWER_HP = { king: 500, princess: 350 };
export const MAX_DURATION = 600;
export const ELIXIR_REGEN_PER_SEC = 1 / 2.8;

// BUGFIX (2026-06-17): apply client card stats to server.
// The numbers in the constants below used to be a separate balance
// table; the source of truth for unit combat is now the client-side
// `clash-client/src/game/cards.ts:CARDS` table (so designers tune in
// one place). Healer.damage is now 15 — the healer is custom-AI'd
// in `behaviors.ts:processHealerAI` and uses this value as the heal
// amount per tick (heals 15 HP every 1.8s, splash 1.8).
//
// NOTE: CARD_DPS used to live here as round(damage / attack_speed)
// but was never imported anywhere in src/. Removed 2026-06-17 to
// avoid drift / false sense of authority. If you need DPS, compute
// it inline from CARD_ATTACK_DAMAGE / CARD_ATTACK_SPEED.

// --- Discrete Combat Constants ---
// Attack cooldown in seconds. e.g., Archer attacks once every 0.8s
export const CARD_ATTACK_SPEED: Record<string, number> = {
  knight: 1.2, archer: 0.8, giant: 1.5, wyvern: 1.4, wizard: 1.2,
  goblin: 1.0, barbarian: 1.3, healer: 1.8, gunslinger: 1.0,
  barrel_bomb: 0, meteor: 0, incubus: 1.0,
  // 2026-10-15: Robinhood — new archer-tier ranged DPS. Same combat profile
  // as the regular archer but a different character model + a unique
  // walk animation (Walk_Forward_with_Bow_Aimed) and a longer attack
  // animation, hence the slightly longer cooldown.
  //
  // 2026-10-16: 1.0 → 4.0 to match the attack clip's actual duration.
  // The Mixamo attack clip in robinhood.glb is 4.00s long (the draw-and-
  // release plus the follow-through), but at a 1.0s cooldown the server
  // started the next attack while the animation was still 75% through —
  // the release visibly snapped back to idle mid-draw and restarted, so
  // the bow-and-arrow read never completed on screen. Matching the
  // cooldown to the clip means the animation now plays start to finish
  // before the next shot.
  //
  // Balance note: this takes Robinhood from 20 dmg/s to 5 dmg/s, which is
  // a large nerf. If the animation still needs to finish but the DPS
  // should not drop that far, the follow-up lever is to raise
  // CARD_ATTACK_DAMAGE rather than shortening the cooldown back.
  robinhood: 4.0,
};

// Attack damage per hit. Mirrors client CARDS[cardId].damage.
export const CARD_ATTACK_DAMAGE: Record<string, number> = {
  knight: 25, archer: 20, giant: 25, wyvern: 25, wizard: 30,
  goblin: 15, barbarian: 25, healer: 15, gunslinger: 40,
  barrel_bomb: 55, meteor: 70, incubus: 15,
  robinhood: 20,
};

// Attack Range in units. Mirrors client CARDS[cardId].range.
export const CARD_RANGE: Record<string, number> = {
  knight: 1.5, archer: 5.0, giant: 2.0, wyvern: 6.0, wizard: 4.5,
  goblin: 1.5, barbarian: 1.5, healer: 4.5, gunslinger: 5.5,
  barrel_bomb: 1.2, meteor: 1.5, incubus: 2.0,
  robinhood: 12.0,
};

// Projectile speed (units per second). If 0, the attack is melee/instant and spawns no projectile.
export const CARD_PROJECTILE_SPEED: Record<string, number> = {
  knight: 0, archer: 8.0, giant: 0, wyvern: 6.0, wizard: 6.0,
  goblin: 0, barbarian: 0, healer: 6.0, gunslinger: 10.0,
  barrel_bomb: 0, meteor: 0, incubus: 8.0,
  robinhood: 8.0,
};

// Attack Splash Radius (AoE). If > 0, hits all enemies within this radius.
export const CARD_ATTACK_SPLASH: Record<string, number> = {
  knight: 0, archer: 0, giant: 0, wyvern: 2.0, wizard: 2.0,
  goblin: 0, barbarian: 2.5, healer: 1.8, gunslinger: 0,
  barrel_bomb: 0, meteor: 0, incubus: 0,
  // 2026-10-16: Robinhood gains AoE. A lobbed archer shell is a
  // splash-on-impact design — the arc apex is what sells it, and it
  // pairs with the 12-unit range so a bridge hold can punish a tight
  // push rather than needing a clean single-target line. 1.8 matches
  // Healer (the other lobbed unit) and stays below Barbarian's 2.5,
  // so it still feels like a light single hit against a spread deck.
  robinhood: 1.8,
};

// Hit-points per card. Mirrors client CARDS[cardId].hp, except
// barrel_bomb which we keep at 1 like meteor — spells are
// invulnerable & untargetable by construction (SPELL_CARDS check
// in combat.ts:22/41/266 and gameLoop.ts:96/169), so their HP
// is purely cosmetic and matched to meteor's 1 for visual
// consistency.
export const CARD_HP: Record<string, number> = {
  knight: 150, archer: 120, giant: 400, wyvern: 120, wizard: 100,
  goblin: 60, barbarian: 180, healer: 110, gunslinger: 110,
  barrel_bomb: 1, meteor: 1, incubus: 60,
  robinhood: 120,
};

export const CARD_COST: Record<string, number> = {
  knight: 3, archer: 2, giant: 5, wyvern: 4, wizard: 4,
  goblin: 2, barbarian: 3, healer: 4, gunslinger: 4,
  barrel_bomb: 2, meteor: 3, incubus: 2,
  robinhood: 2,
};

// BUGFIX (2026-06-17): movement speed per-card (units per second).
// Previously hardcoded to 2.5 for every unit in gameLoop.ts:229,
// which meant a 2000-HP Giant moved at the same pace as a 60-HP
// Goblin. Splitting this per-card lets balance match the
// visual archetype: giants are slow tanks, goblins are fast
// harassers, wyverns are fast air. Spells are 0 (they're already
// filtered out of the movement tick at gameLoop.ts:83, but the
// value documents the intent).
export const CARD_MOVE_SPEED: Record<string, number> = {
  knight: 2.5, archer: 3.0, giant: 1.5, wyvern: 2.5, wizard: 2.5,
  goblin: 3.5, barbarian: 2.5, healer: 2.0, gunslinger: 3.0,
  barrel_bomb: 0, meteor: 0, incubus: 3.5,
  robinhood: 3.0,
};

export const CARD_SPAWN_COUNT: Record<string, number> = {
  knight: 1, archer: 1, giant: 1, wyvern: 1, wizard: 1,
  goblin: 3, barbarian: 1, healer: 1, gunslinger: 1,
  barrel_bomb: 1, meteor: 1, incubus: 3,
  robinhood: 1,
};

/** Set of units that fly. Flying units ignore ground unit collisions. */
export const FLYING_UNITS: Set<string> = new Set(["wyvern", "incubus", "healer"]);

/** Set of units that can attack flying/air targets. Melee ground units cannot hit air. */
export const CAN_ATTACK_AIR: Set<string> = new Set(["archer", "wyvern", "wizard", "gunslinger", "incubus", "robinhood"]);

/**
 * Server-side spell-card metadata (mirror of client's cards.ts).
 * Spells are STATIC AoE effects. They never move, never auto-target,
 * never auto-attack. The server enforces this by:
 *   1. Skipping spell units in the troop movement tick.
 *   2. Skipping spell units in the troop attack tick.
 *   3. Running a separate AoE detonation step for spells (timer for
 *      meteor, proximity trigger for barrel_bomb).
 *   4. Deleting the unit from the MapSchema once it explodes so the
 *      client stops rendering it.
 */
export const SPELL_CARDS: Set<string> = new Set(["meteor", "barrel_bomb"]);

/** AoE explosion radius (units). */
export const SPELL_SPLASH_RADIUS: Record<string, number> = {
  meteor: 3.0,
  barrel_bomb: 3.0,
};

/** Detonation trigger mode. */
export type SpellTrigger = "timer" | "proximity";

export const SPELL_TRIGGER: Record<string, SpellTrigger> = {
  meteor: "timer",
  barrel_bomb: "proximity",
};

/** Time-to-detonate (ms) for 'timer' spells. */
export const SPELL_DETONATE_AFTER_MS: Record<string, number> = {
  meteor: 800,
};

/** Proximity-trigger radius (units) for 'proximity' spells. */
export const SPELL_TRIGGER_RADIUS: Record<string, number> = {
  barrel_bomb: 2.0,
};

/** Spell damage applied once on detonation. */
export const SPELL_DAMAGE: Record<string, number> = {
  meteor: 70,
  barrel_bomb: 55,
};

// === Schemas ===

export class Tower extends Schema {
  @type("string") uid: string = "";
  @type("uint8") team: number = 0;
  @type("string") type: string = "princess";
  @type("uint16") hp: number = 350;
  @type("uint16") maxHp: number = 350;
  @type("float32") lastAttackTime: number = 0;
  @type("string") targetId: string = "";
}

export class DeployedUnit extends Schema {
  @type("string") cardId: string = "";
  @type("uint8") team: number = 0;
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") spawnTime: number = 0;
  @type("uint16") hp: number = 100;
  @type("uint16") maxHp: number = 100;
  @type("uint8") cardLevel: number = 1; // NFT level of the deployed card (L1..L9). Affects HP/damage scaling.
  
  // Animation and Combat states
  @type("string") action: string = "idle"; // "idle", "walk", "attack"
  @type("float32") lastAttackTime: number = 0; // Timestamp (in seconds from game start) of last attack
  @type("string") targetId: string = ""; // ID of the current target (for animation facing)
  @type("float32") deathTime: number = 0; // Tracks when HP hit 0 to delay cleanup for animations
}

export class Projectile extends Schema {
  @type("string") id: string = "";
  @type("string") sourceCardId: string = ""; // Used for styling the projectile
  @type("uint8") team: number = 0;
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") targetX: number = 0;
  @type("float32") targetZ: number = 0;
  @type("string") targetId: string = ""; // The UID of the target unit/tower
  @type("float32") speed: number = 5.0;
  @type("uint16") damage: number = 0;
  @type("float32") splashRadius: number = 0;
}

export class Player extends Schema {
  @type("string") walletAddress: string = "";
  @type("string") nickname: string = "";
  @type("uint8") team: number = 0;
  // SECURITY (Celah 5 in audit): uint8 is sufficient for elixir (0..10).
  // float32 is a wider type than needed and historically made us vulnerable
  // to floating-point bug regressions in regen/deduct code. Hard cap server-side.
  @type("uint8") elixir: number = 5;
  @type("boolean") connected: boolean = true;
  // MCP agent battleground integration: when this player is an AI agent
  // (joined via clash-mcp-server), isAgent=true and agentId is the row
  // id from the public.agents table. The endMatch flow uses these to
  // route match recording to record_agent_match RPC instead of
  // secure_record_match (which would inflate the human's profile).
  @type("boolean") isAgent: boolean = false;
  @type("string") agentId: string = "";
  // 2026-06-24: Battle Deck (NFT-gated) — 8 selected cardIds.
  // Server validates this against on-chain NFT ownership in onJoin.
  // handleDeployCard rejects any cardId not in this list.
  @type(["string"]) deck = new ArraySchema<string>();
  // Per-card NFT level (L1..L9). Used for HP/damage scaling in combat.
  // Stored as parallel arrays: deck[i] → deckLevels[i].
  @type(["uint8"]) deckLevels = new ArraySchema<number>();
  // 2026-06-26: Clash-Royale-style 4-card HAND + cycle queue. The 8-card `deck`
  // above is the full owned set; at any moment only these 4 cards are playable.
  // handleDeployCard validates against `hand` (NOT `deck`). After a successful
  // deploy the played card rotates to the tail of `nextQueue` and the head of
  // `nextQueue` is drawn into `hand`. This makes spamming the same card
  // impossible: you must cycle the other 3 hand cards before it returns.
  // hand[i] <-> handLevels[i] and nextQueue[i] <-> queueLevels[i] are parallel.
  @type(["string"]) hand = new ArraySchema<string>();
  @type(["uint8"]) handLevels = new ArraySchema<number>();
  @type(["string"]) nextQueue = new ArraySchema<string>();
  @type(["uint8"]) queueLevels = new ArraySchema<number>();
  @type([Tower]) towers = new ArraySchema<Tower>();
  @type({ map: DeployedUnit }) units = new MapSchema<DeployedUnit>();
}

export class BattleState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Projectile }) projectiles = new MapSchema<Projectile>(); // Track active projectiles
  // elapsedSec is the integer-second count, kept for the HUD timer and the
  // MAX_DURATION (600s) win-condition check. UI displays and game logic that
  // want a sub-second resolution read elapsedMs instead.
  @type("uint16") elapsedSec: number = 0;
  // High-resolution timestamp in ms since match start. Set every tick in
  // gameLoop.ts and used as the authoritative time-stamp for snapshot
  // interpolation on the client. uint32 holds ~50 days, more than enough
  // for a single match. The client must NOT use Math.floor on this value —
  // its whole purpose is to be sub-second so two consecutive 50ms samples
  // have distinct timestamps and the linear interpolation between them has
  // a non-zero span. (Previously the client used elapsedSec and the span
  // degenerated to 0 within any one-second window, which made the unit
  // appear to "teleport" each time the buffer evicted its oldest sample.)
  @type("uint32") elapsedMs: number = 0;
  @type("string") status: string = "waiting"; // waiting | playing | ended
  @type("string") winnerTeam: string = "";
  @type("string") seed: string = "";
}
