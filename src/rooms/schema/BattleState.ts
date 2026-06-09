import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

// === Constants (EXACT same as agones-clash-colyseus) ===
export const INITIAL_TOWER_HP = { king: 500, princess: 350 };
export const MAX_DURATION = 600;
export const ELIXIR_REGEN_PER_SEC = 1 / 2.8;

export const CARD_DPS: Record<string, number> = {
  knight: 25, archer: 20, giant: 25, wyvern: 25, wizard: 30,
  goblin: 15, barbarian: 25, healer: 0, gunslinger: 40,
  barrel_bomb: 55, meteor: 70, incubus: 15,
};

// --- Discrete Combat Constants ---
// Attack cooldown in seconds. e.g., Archer attacks once every 1.2s
export const CARD_ATTACK_SPEED: Record<string, number> = {
  knight: 1.2, archer: 1.2, giant: 1.5, wyvern: 1.4, wizard: 1.4,
  goblin: 1.1, barbarian: 1.3, healer: 2.0, gunslinger: 1.0,
  barrel_bomb: 0, meteor: 0, incubus: 1.2,
};

// Attack damage per hit. (Calculated roughly as DPS * ATTACK_SPEED for existing balance)
export const CARD_ATTACK_DAMAGE: Record<string, number> = {
  knight: 30, archer: 24, giant: 38, wyvern: 35, wizard: 42,
  goblin: 17, barbarian: 33, healer: 0, gunslinger: 40, // Healer does negative damage (heal) or handles it in custom logic
  barrel_bomb: 55, meteor: 70, incubus: 18,
};

// Attack Range in units
export const CARD_RANGE: Record<string, number> = {
  knight: 1.4, archer: 4.5, giant: 1.5, wyvern: 3.5, wizard: 4.0,
  goblin: 1.3, barbarian: 1.4, healer: 3.5, gunslinger: 5.0,
  barrel_bomb: 0, meteor: 0, incubus: 1.2,
};

// Projectile speed (units per second). If 0, the attack is melee/instant and spawns no projectile.
export const CARD_PROJECTILE_SPEED: Record<string, number> = {
  knight: 0, archer: 8.0, giant: 0, wyvern: 6.0, wizard: 6.0,
  goblin: 0, barbarian: 0, healer: 6.0, gunslinger: 10.0,
  barrel_bomb: 0, meteor: 0, incubus: 8.0,
};

// Attack Splash Radius (AoE). If > 0, hits all enemies within this radius.
export const CARD_ATTACK_SPLASH: Record<string, number> = {
  knight: 0, archer: 0, giant: 0, wyvern: 2.0, wizard: 2.0,
  goblin: 0, barbarian: 2.5, healer: 1.8, gunslinger: 0,
  barrel_bomb: 0, meteor: 0, incubus: 0,
};

export const CARD_HP: Record<string, number> = {
  knight: 600, archer: 250, giant: 2000, wyvern: 500, wizard: 350,
  goblin: 150, barbarian: 500, healer: 400, gunslinger: 350,
  barrel_bomb: 200, meteor: 1, incubus: 400,
};

export const CARD_COST: Record<string, number> = {
  knight: 3, archer: 2, giant: 5, wyvern: 4, wizard: 4,
  goblin: 2, barbarian: 3, healer: 4, gunslinger: 4,
  barrel_bomb: 2, meteor: 3, incubus: 2,
};

export const CARD_SPAWN_COUNT: Record<string, number> = {
  knight: 1, archer: 1, giant: 1, wyvern: 1, wizard: 1,
  goblin: 3, barbarian: 1, healer: 1, gunslinger: 1,
  barrel_bomb: 1, meteor: 1, incubus: 3,
};

/** Set of units that fly. Flying units ignore ground unit collisions. */
export const FLYING_UNITS: Set<string> = new Set(["wyvern", "incubus", "healer"]);

/** Set of units that can attack flying/air targets. Melee ground units cannot hit air. */
export const CAN_ATTACK_AIR: Set<string> = new Set(["archer", "wyvern", "wizard", "gunslinger", "incubus"]);

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

/** Per-tick damage value (CARD_DPS[cardId] is per-second; here we
 *  apply the full cardDPS once on detonation). */
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
  @type("float32") elixir: number = 5;
  @type("boolean") connected: boolean = true;
  @type([Tower]) towers = new ArraySchema<Tower>();
  @type({ map: DeployedUnit }) units = new MapSchema<DeployedUnit>();
}

export class BattleState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Projectile }) projectiles = new MapSchema<Projectile>(); // Track active projectiles
  @type("uint16") elapsedSec: number = 0;
  @type("string") status: string = "waiting"; // waiting | playing | ended
  @type("string") winnerTeam: string = "";
  @type("string") seed: string = "";
}
