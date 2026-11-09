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
  // 2026-10-20 (perf/balance): 4.0 → 3.0 → 2.5s together with the Epic
  // stat line (30 damage). The cooldown is a BALANCE value, not the clip
  // length - the Mixamo attack clip in robinhood.glb is still 4.00s long
  // (the draw-and-release plus the follow-through), so at 2.5s the next
  // draw starts before the previous one fully finishes.
  // The Mixamo attack clip in robinhood.glb is 4.00s long (the draw-and-
  // release plus the follow-through), but at a 1.0s cooldown the server
  // started the next attack while the animation was still 75% through —
  // the release visibly snapped back to idle mid-draw and restarted, so
  // the bow-and-arrow read never completed on screen. Matching the
  // cooldown to the clip means the animation now plays start to finish
  // before the next shot.
  //
  // 2026-10-20: 4.0 -> 3.0. The clip is 4.00s but a 3s cooldown is
  // close enough that the release still reads, and it buys back a
  // third of the DPS. Damage was raised alongside (20 -> 25).
  //
  // 2026-10-21: 3.0 -> 2.5, damage 25 -> 30. Playtested against the
  // archer: at a 3.0s cooldown Robinhood sat at 8.3 dps, the lowest
  // non-support troop in the roster, which did not read as "Epic" at
  // all. 2.5s at 30 damage lands on exactly 12.0 dps — a 44% buff and
  // still the longest-attack-cd archer, so the 4.00s clip gets 62% of
  // its runtime before the next draw begins instead of 75%.
  robinhood: 2.5,
  // 2026-11-09: Clanker — Epic melee bruiser (robot with a punch combo).
  // The Punch_Combo_1 clip in clanker.glb runs 2.20s, so the cooldown is
  // kept below that (1.8s = 82% of the clip) so the punch reads before the
  // next one starts. Same reasoning as the Robinhood fix above: the
  // cooldown is a BALANCE value, but it must not exceed the clip length.
  // 2026-11-09: Clanker — attack speed now matches the Giant (1.5s), so
  // his swing reads as a heavy tank blow instead of a fast flurry.
  clanker: 1.5,
  // 2026-11-09: Warlord Jesse — Epic melee swordsman. The
  // Triple_Combo_Attack clip in warlord_jesse.glb runs 4.33s; at a 3.0s
  // cooldown the combo gets 69% of its runtime before the next swing,
  // which is the same ratio Robinhood settled on.
  warlord_jesse: 3.0,
};

// Attack damage per hit. Mirrors client CARDS[cardId].damage.
export const CARD_ATTACK_DAMAGE: Record<string, number> = {
  knight: 25, archer: 20, giant: 25, wyvern: 25, wizard: 30,
  goblin: 15, barbarian: 25, healer: 15, gunslinger: 40,
  barrel_bomb: 55, meteor: 70, incubus: 15,
  // 2026-10-20: 20 -> 25 to go with the Epic stat line.
  // 2026-10-21: 25 -> 30 alongside the 3.0 -> 2.5 cooldown change, so
  // Robinhood lands on 12.0 dps rather than 8.3. Cost, HP, range and
  // splash are unchanged.
  robinhood: 30,
  // 2026-11-09: Clanker — Epic melee bruiser. The attack now matches the
  // Giant exactly: 25 damage on a 1.5s cooldown (16.7 dps, the Giant's
  // rate). The Clanker's identity is its deathrattle — an electric blast
  // and two mini Clankers — not raw dps.
  clanker: 25,
  // 2026-11-09: Warlord Jesse — Epic melee swordsman. 60 damage at a
  // 3.0s cooldown lands on 20.0 dps, but in 60-damage chunks that
  // delete a Giant in 7 hits rather than the Barbarian's 16.
  warlord_jesse: 60,
};

// Attack Range in units. Mirrors client CARDS[cardId].range.
export const CARD_RANGE: Record<string, number> = {
  knight: 1.5, archer: 5.0, giant: 2.0, wyvern: 6.0, wizard: 4.5,
  goblin: 1.5, barbarian: 1.5, healer: 4.5, gunslinger: 5.5,
  barrel_bomb: 1.2, meteor: 1.5, incubus: 2.0,
  robinhood: 12.0,
  // 2026-11-09: both new Epics are melee (no projectile), so their range
  // is the standard melee reach. Clanker is a brawler at the Knight's
  // 1.5; Warlord Jesse swings a sword and reaches slightly further.
  clanker: 1.5,
  warlord_jesse: 1.8,
};

// Projectile speed (units per second). If 0, the attack is melee/instant and spawns no projectile.
export const CARD_PROJECTILE_SPEED: Record<string, number> = {
  knight: 0, archer: 8.0, giant: 0, wyvern: 6.0, wizard: 6.0,
  goblin: 0, barbarian: 0, healer: 6.0, gunslinger: 10.0,
  barrel_bomb: 0, meteor: 0, incubus: 8.0,
  robinhood: 8.0,
  // 2026-11-09: both new Epics are melee, so they spawn no projectile
  // (0 = instant hit, same as Knight / Barbarian / Giant).
  clanker: 0,
  warlord_jesse: 0,
};

// Attack Splash Radius (AoE). If > 0, hits all enemies within this radius.
export const CARD_ATTACK_SPLASH: Record<string, number> = {
  knight: 0, archer: 0, giant: 0, wyvern: 2.0, wizard: 2.0,
  goblin: 0, barbarian: 2.5, healer: 1.8, gunslinger: 0,
  barrel_bomb: 0, meteor: 0, incubus: 0,
  // 2026-10-16: Robinhood gains AoE. A lobbed archer shell is a
  // splash-on-impact design — the arc apex is what sells it, and it
  // pairs with the 12-unit range so a bridge hold can punish a tight
  // push rather than needing a clean single-target line.
  // 2026-10-20: 1.8 -> 2.5, matching Barbarian's AoE now that the
  // card moved up to Epic.
  robinhood: 2.5,
  // 2026-11-09: Clanker — the Punch_Combo_1 animation is a wide ground
  // slam, so it hits everything in front of it (2.0 radius, between the
  // Wizard's 2.0 and Barbarian's 2.5).
  //
  // 2026-11-09 (later the same day): "same attack as the Giant" means the
  // Giant's whole attack profile, and the Giant has no splash. The Clanker's
  // identity is now its deathrattle (electric blast + two mini Clankers),
  // not an on-hit AoE, so the melee splash is dropped to 0.
  clanker: 0,
  // 2026-11-09: Warlord Jesse — single-target swordsman, no AoE. His
  // damage comes from the 60-damage chunks, not from hitting wide.
  warlord_jesse: 0,
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
  // 2026-10-20: 120 -> 150 with the Epic stat line.
  robinhood: 150,
  // 2026-11-09: Clanker — the tankiest unit in the roster. HP is 2x the
  // Giant's (400), so it survives eight Giant hits. Its attack matches the
  // Giant exactly: 25 damage on a 1.5s cooldown (16.7 dps) and no splash.
  clanker: 800,
  // 2026-11-09: Warlord Jesse — glass cannon. 220 HP is Barbarian-tier,
  // but he trades 60-damage hits for it.
  warlord_jesse: 220,
};

export const CARD_COST: Record<string, number> = {
  knight: 3, archer: 2, giant: 5, wyvern: 4, wizard: 4,
  goblin: 2, barbarian: 3, healer: 4, gunslinger: 4,
  barrel_bomb: 2, meteor: 3, incubus: 2,
  // 2026-10-20: 2 -> 3 elixir with the Epic stat line.
  robinhood: 3,
  // 2026-11-09: Clanker — 7 elixir, the most expensive card in the roster.
  // He is an 800 HP tank, so he has to be expensive to play.
  clanker: 7,
  // 2026-11-09: Warlord Jesse — 4 elixir.
  warlord_jesse: 4,
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
  // 2026-11-09: Clanker — heavy robot. It now walks at 1.25, which is
  // slower than the Giant's 1.5: the Clanker is the slowest unit in the
  // roster and has to commit to a push.
  clanker: 1.25,
  // 2026-11-09: Warlord Jesse — now walks at the Knight's speed (2.5)
  // instead of 3.0, so the two melee bruisers share one approach pace.
  warlord_jesse: 2.5,
};

export const CARD_SPAWN_COUNT: Record<string, number> = {
  knight: 1, archer: 1, giant: 1, wyvern: 1, wizard: 1,
  goblin: 3, barbarian: 1, healer: 1, gunslinger: 1,
  barrel_bomb: 1, meteor: 1, incubus: 3,
  robinhood: 1,
  // 2026-11-09: both new Epics deploy as a single unit.
  clanker: 1,
  warlord_jesse: 1,
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

// ─────────────────────────────────────────────────────────────────────────────
// Clanker deathrattle (2026-11-09)
// ─────────────────────────────────────────────────────────────────────────────
// When a Clanker dies it discharges an electric blast and leaves behind two
// half-size mini Clankers. A mini Clanker is a transient combat unit, NOT an
// NFT card type: it has no on-chain identity, so it is kept out of
// CARD_TYPE_IDS and out of every deck / NFT table. It is identified only by
// the `variant` field on DeployedUnit.
//
// The mini's stats are a quarter of the parent's base card values and its
// death blast is half of ITS OWN attack, so the mini Clanker is a scaled-down
// copy of the whole deathrattle loop rather than a one-off.
export const CLANKER_VARIANT_MINI = "mini";

/**
 * Visual scale of a mini Clanker relative to a full Clanker.
 * 2026-11-09: was 0.35, the user asked for 75% bigger -> 0.35 x 1.75.
 */
export const MINI_CLANKER_SCALE = 0.6125;

/** How many mini Clankers a dying Clanker leaves behind. */
export const MINI_CLANKER_COUNT = 2;

/** Radius of the electric blast (units). Same for the Clanker and its minis. */
export const CLANKER_BLAST_RADIUS = 2.5;

/** The blast deals half of the dying unit's attack damage. */
export const CLANKER_BLAST_DAMAGE_DIVISOR = 2;

/** A mini Clanker's HP is a quarter of the parent's base value. */
export const MINI_CLANKER_STAT_DIVISOR = 4;

/**
 * A mini Clanker's attack damage.
 *
 * 2026-11-09: the mini used to take a quarter of the parent's damage
 * (25 / 4 = 6). The user asked for 10 instead, so the mini's attack is
 * now an explicit value and no longer tied to the divisor.
 */
export const MINI_CLANKER_ATTACK_DAMAGE = 10;

/** True when the unit is one of the mini Clankers a dying Clanker spawned. */
export function isMiniClanker(unit: { variant?: string }): boolean {
  return unit.variant === CLANKER_VARIANT_MINI;
}

/**
 * The base attack damage of a unit, before NFT-level scaling, taking the
 * mini variant into account. A mini Clanker deals
 * MINI_CLANKER_ATTACK_DAMAGE (10) per hit.
 */
export function baseAttackDamage(cardId: string, variant: string): number {
  if (variant === CLANKER_VARIANT_MINI) {
    return MINI_CLANKER_ATTACK_DAMAGE;
  }
  return CARD_ATTACK_DAMAGE[cardId] || 0;
}

/**
 * The base HP of a unit, before NFT-level scaling, taking the mini variant
 * into account. A mini Clanker has a quarter of the Clanker's base HP
 * (800 / 4 = 200).
 */
export function baseUnitHp(cardId: string, variant: string): number {
  const base = CARD_HP[cardId] || 100;
  if (variant === CLANKER_VARIANT_MINI) {
    return Math.max(1, Math.round(base / MINI_CLANKER_STAT_DIVISOR));
  }
  return base;
}

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

  // 2026-11-09 — Clanker deathrattle.
  // variant is "" for every normally-deployed card and "mini" for the two
  // half-size Clankers a dying Clanker leaves behind. It is NOT an NFT card
  // type: a mini Clanker is a transient combat unit with no on-chain
  // identity, so it must never reach CARD_TYPE_IDS or the deck tables.
  @type("string") variant: string = "";

  // Set the first time the death effects for this unit are processed, so the
  // electric blast and the mini spawn can never fire twice for one death.
  @type("boolean") deathTriggered: boolean = false;

  // 2026-11-09 — the stat-buff multiplier currently applied to this unit
  // (1 = no buff). It is recomputed every tick from the buff zones that
  // cover the unit's position.
  @type("float32") statBuff: number = 1;

  // 2026-11-09 — the Warlord Jesse's deploy animation. While the server
  // clock is below this timestamp the unit holds still and plays its
  // sword-shout, as if activating its buff. 0 = no deploy animation.
  @type("float32") deployAnimUntilMs: number = 0;
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

/**
 * A stat-buff aura on the arena floor.
 *
 * 2026-11-09 — the Warlord Jesse's buff. While he is alive his aura is
 * "active": +10% to every stat of every unit inside a 5-unit radius. When
 * he dies the aura turns into a "death" burst: +30% for 4 seconds, centred
 * on the spot where he fell.
 *
 * The zone lives in the state (not in a module-level array) because the
 * client renders it — it needs the position, the radius and the phase.
 */
export class BuffZone extends Schema {
  @type("string") uid: string = "";
  @type("uint8") team: number = 0;
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") radius: number = 5;
  /** 1.1 while the owner lives, 1.3 for the 4-second death burst. */
  @type("float32") multiplier: number = 1.1;
  /** "active" (the owner lives) or "death" (the 4-second burst). */
  @type("string") phase: string = "active";
  /** Server timestamp (elapsedMs) when the zone expires; -1 = no expiry. */
  @type("float32") expiresAt: number = -1;
}

export class BattleState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Projectile }) projectiles = new MapSchema<Projectile>(); // Track active projectiles
  // 2026-11-09 — the stat-buff auras (Warlord Jesse). The client renders
  // them, so they travel in the state.
  @type({ map: BuffZone }) buffZones = new MapSchema<BuffZone>();
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
