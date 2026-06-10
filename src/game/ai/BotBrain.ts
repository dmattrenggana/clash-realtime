import { BattleRoom } from "../../rooms/BattleRoom.js";
import {
  DeployedUnit,
  Player,
  Tower,
  CARD_COST,
  CARD_HP,
  SPELL_CARDS
} from "../../rooms/schema/BattleState.js";

interface BotAction {
  cardId: string;
  x: number;
  z: number;
  score: number;
}

export class BotBrain {
  private room: BattleRoom;
  private botSessionId: string;
  private cooldownAccumulator: number = 0;
  private thinkingCooldownMs: number = 2000; // Thinks every 2 seconds

  constructor(room: BattleRoom, botSessionId: string) {
    this.room = room;
    this.botSessionId = botSessionId;
    console.log(`[BotBrain] Initialized for sessionId: ${this.botSessionId}`);
  }

  /**
   * Main update loop driven by the server's simulation tick
   * @param dt Elapsed time in milliseconds
   */
  public update(dt: number) {
    if (this.room.state.status !== "playing") return;

    this.cooldownAccumulator += dt;
    if (this.cooldownAccumulator >= this.thinkingCooldownMs) {
      this.cooldownAccumulator = 0;
      this.thinkAndAct();
    }
  }

  /**
   * Scan the battlefield, make decisions, and execute action if utility score is positive.
   */
  private thinkAndAct() {
    const battlefield = this.scanBattlefield();
    if (!battlefield) return;

    const bestAction = this.evaluateDecisions(battlefield);
    if (bestAction && bestAction.score > 0) {
      console.log(
        `[BotBrain] Selected Action: Deploy ${bestAction.cardId} at (${bestAction.x.toFixed(1)}, ${bestAction.z.toFixed(1)}) with utility score: ${bestAction.score.toFixed(2)}`
      );
      this.executeAction("deployCard", {
        cardId: bestAction.cardId,
        x: bestAction.x,
        z: bestAction.z,
      });
    }
  }

  /**
   * OBSERVATION LAYER (Future MCP Resources)
   * Scans and aggregates the current state of the game for the bot and the enemy.
   */
  private scanBattlefield() {
    const state = this.room.state;
    const botPlayer = state.players.get(this.botSessionId);
    if (!botPlayer) return null;

    // Find enemy player (first player who is not the bot)
    let enemyPlayer: Player | null = null;
    state.players.forEach((player, sessionId) => {
      if (sessionId !== this.botSessionId) {
        enemyPlayer = player;
      }
    });

    if (!enemyPlayer) return null;

    const botTeam = botPlayer.team;
    const isBotTeam0 = botTeam === 0;

    // Gather active bot units
    const botUnits: DeployedUnit[] = [];
    botPlayer.units.forEach((unit) => {
      if (unit.hp > 0) botUnits.push(unit);
    });

    // Gather active enemy units
    const enemyUnits: DeployedUnit[] = [];
    (enemyPlayer as Player).units.forEach((unit) => {
      if (unit.hp > 0) enemyUnits.push(unit);
    });

    // Filter enemy units currently on our side of the battlefield
    // Team 0 -> player side: z > 0; Team 1 -> enemy side: z < 0
    const enemyUnitsOnMySide = enemyUnits.filter((unit) => {
      return isBotTeam0 ? unit.z > 0 : unit.z < 0;
    });

    // Identify active bot towers
    const botTowers = botPlayer.towers.filter((t) => t.hp > 0);

    return {
      botPlayer,
      enemyPlayer: enemyPlayer as Player,
      botUnits,
      enemyUnits,
      enemyUnitsOnMySide,
      botTowers,
      isBotTeam0,
      botTeam,
    };
  }

  /**
   * ACTION LAYER (Future MCP Tools)
   * Simulates a client message by invoking the room's registered message input handler.
   */
  private executeAction(actionType: string, data: any) {
    if (actionType === "deployCard") {
      const mockClient = {
        sessionId: this.botSessionId,
        send: (type: string, message: any) => {
          console.warn(`[BotBrain MockClient] Received message ${type}:`, message);
        },
      } as any;

      if (typeof this.room.handleDeployCard === "function") {
        this.room.handleDeployCard(mockClient, data);
      } else {
        console.error(`[BotBrain] handleDeployCard is not a function on BattleRoom.`);
      }
    }
  }

  /**
   * DECISION LOGIC (Utility Scoring)
   * Evaluates all possible card deployments and chooses the one with the highest score.
   */
  private evaluateDecisions(battlefield: any): BotAction | null {
    const { botPlayer } = battlefield;
    const elixir = botPlayer.elixir;

    const availableCards = Object.keys(CARD_COST);
    let bestAction: BotAction | null = null;

    for (const cardId of availableCards) {
      const cost = CARD_COST[cardId];
      if (cost > elixir) continue; // Cannot afford

      const decision = this.scoreCardDeployment(cardId, cost, battlefield);
      if (decision && (!bestAction || decision.score > bestAction.score)) {
        bestAction = decision;
      }
    }

    return bestAction;
  }

  /**
   * Calculates the utility score and target coordinates for deploying a specific card.
   */
  private scoreCardDeployment(cardId: string, cost: number, battlefield: any): BotAction | null {
    const { botPlayer, enemyUnitsOnMySide, isBotTeam0, botTowers } = battlefield;
    const elixir = botPlayer.elixir;
    const isSpell = SPELL_CARDS.has(cardId);

    let score = 0;
    let spawnX = 0;
    let spawnZ = isBotTeam0 ? 6 : -6; // Default midway on our side

    // SCENARIO 1: DEFENSE
    // High threat: enemy units are on our side. We must defend our towers!
    if (enemyUnitsOnMySide.length > 0) {
      // Find the closest threat to our towers
      let closestThreat: DeployedUnit | null = null;
      let minDistanceToTower = Infinity;

      for (const enemyUnit of enemyUnitsOnMySide) {
        // Find distance to our closest active tower
        for (const tower of botTowers) {
          // Approximate tower coordinates based on index and team (rough lookup)
          const tz = isBotTeam0 ? (tower.type === "king" ? 13 : 10) : (tower.type === "king" ? -13 : -10);
          const tx = tower.type === "king" ? 0 : (tower.hp > 0 ? -6 : 6); // rough mapping
          const dist = Math.pow(enemyUnit.x - tx, 2) + Math.pow(enemyUnit.z - tz, 2);
          if (dist < minDistanceToTower) {
            minDistanceToTower = dist;
            closestThreat = enemyUnit;
          }
        }
      }

      const threat = closestThreat || enemyUnitsOnMySide[0];

      if (isSpell) {
        // Spells can target anywhere! Let's drop them directly on top of the threat.
        score = 6.0; // Moderate base score for defensive spells
        // Add score multiplier based on cluster density
        const nearThreats = enemyUnitsOnMySide.filter(
          (u: DeployedUnit) => Math.pow(u.x - threat.x, 2) + Math.pow(u.z - threat.z, 2) <= 9 // within 3 units radius
        );
        score += nearThreats.length * 1.5; // highly reward hitting multiple targets
        
        spawnX = threat.x;
        spawnZ = threat.z;
      } else {
        // Non-spell troop defense
        // Place defender slightly closer to our towers than the threat to intercept
        const offset = isBotTeam0 ? 2.5 : -2.5; // push defender towards our back side
        spawnX = threat.x;
        spawnZ = threat.z + offset;

        // Score based on card suitability for defense
        if (cardId === "knight" || cardId === "barbarian") {
          score = 9.0; // Excellent melee defenders
        } else if (cardId === "archer" || cardId === "wizard" || cardId === "gunslinger") {
          score = 8.5; // Excellent ranged DPS support from behind
        } else if (cardId === "goblin" || cardId === "incubus") {
          score = 8.0; // Cheap distractors
        } else if (cardId === "giant") {
          score = 2.0; // Giant does not attack troops, poor defender but high HP
        } else {
          score = 5.0; // Other units
        }

        // Boost score if we are sitting on near-max elixir
        if (elixir >= 8) {
          score += 1.5;
        }
      }
    }
    // SCENARIO 2: OFFENSE / PRESSURING
    // No active threats on our side, let's launch an attack or build a push!
    else {
      if (isSpell) {
        // Do not waste spells on empty ground
        score = 0;
      } else if (cardId === "giant") {
        // Giant is our primary tank. Spawn him at the back to build a massive slow push.
        score = elixir >= 7 ? 8.0 : 3.0; // Highly preferred if we have plenty of elixir
        spawnX = 0; // Center lane
        spawnZ = isBotTeam0 ? 11 : -11; // Deep inside our back side
      } else if (cardId === "knight" || cardId === "barbarian" || cardId === "wyvern") {
        // High-quality offensive/pressure troops
        score = elixir >= 6 ? 6.5 : 2.0;
        // Deploy near the bridge for quick pressure or slightly back if low elixir
        spawnX = Math.random() > 0.5 ? 6 : -6; // Pick left or right bridge lanes
        spawnZ = isBotTeam0 ? 3 : -3; // Spawning closer to the river line
      } else if (cardId === "archer" || cardId === "wizard" || cardId === "gunslinger" || cardId === "healer") {
        // Ranged / Support troops
        // Best deployed behind an existing push, or at medium distance
        score = elixir >= 5 ? 5.0 : 1.5;
        spawnX = Math.random() > 0.5 ? 4 : -4;
        spawnZ = isBotTeam0 ? 8 : -8; // Mid back
      } else {
        // Goblins/incubus etc
        score = elixir >= 8 ? 4.0 : 1.0;
        spawnX = Math.random() > 0.5 ? 5 : -5;
        spawnZ = isBotTeam0 ? 5 : -5;
      }
    }

    // Clamp spawn coordinates to match strict zone/field limits
    spawnX = Math.max(-10, Math.min(10, spawnX));
    if (isBotTeam0) {
      spawnZ = Math.max(1, Math.min(12, spawnZ));
    } else {
      spawnZ = Math.max(-12, Math.min(-1, spawnZ));
    }

    // Don't score if we can't afford or if score is negative
    if (score <= 0) return null;

    return {
      cardId,
      x: spawnX,
      z: spawnZ,
      score,
    };
  }
}
