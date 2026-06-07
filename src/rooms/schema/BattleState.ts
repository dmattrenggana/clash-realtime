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
  knight: 1, archer: 2, giant: 1, wyvern: 1, wizard: 1,
  goblin: 3, barbarian: 2, healer: 1, gunslinger: 1,
  barrel_bomb: 1, meteor: 1, incubus: 3,
};

// === Schemas ===

export class Tower extends Schema {
  @type("string") type: string = "princess";
  @type("uint16") hp: number = 350;
  @type("uint16") maxHp: number = 350;
}

export class DeployedUnit extends Schema {
  @type("string") uid: string = "";
  @type("string") cardId: string = "";
  @type("uint8") team: number = 0;
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") spawnTime: number = 0;
  @type("uint16") hp: number = 100;
  @type("uint16") maxHp: number = 100;
}

export class Player extends Schema {
  @type("string") walletAddress: string = "";
  @type("string") nickname: string = "";
  @type("uint8") team: number = 0;
  @type("float32") elixir: number = 5;
  @type("boolean") connected: boolean = true;
  @type([Tower]) towers = new ArraySchema<Tower>();
  @type([DeployedUnit]) units = new ArraySchema<DeployedUnit>();
}

export class BattleState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("uint16") elapsedSec: number = 0;
  @type("string") status: string = "waiting"; // waiting | playing | ended
  @type("string") winnerTeam: string = "";
  @type("string") seed: string = "";
}
