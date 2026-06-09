import { BattleState, Player, DeployedUnit, Tower, SPELL_CARDS, AIR_UNITS, ELIXIR_REGEN_PER_SEC, MAX_DURATION } from "../rooms/schema/BattleState.js";
import { CARD_RANGE } from "../rooms/schema/BattleState.js";
import { getTowerCoords, routeThroughBridge } from "./pathfinding.js";
import { applySeparationForces } from "./physics.js";
import { processHealerAI, processSpells } from "./behaviors.js";
import { applyUnitDamage, updateProjectiles, processTowerAttacks } from "./combat.js";

/**
 * The core simulation tick function of the server-authoritative game engine.
 * Run at 10Hz (every 100ms), mutating the Colyseus schema in-place.
 */
export function tickGame(
  state: BattleState,
  gameStartTime: number,
  tickRateMs: number,
  onMatchEnded: (winnerTeam: string) => void
): void {
  if (state.status !== "playing") return;

  state.elapsedSec = Math.floor((Date.now() - gameStartTime) / 1000);

  // 1. Regen Elixir
  state.players.forEach((p: Player) => {
    if (p.elixir < 10) {
      p.elixir = Math.min(10, p.elixir + ELIXIR_REGEN_PER_SEC * (tickRateMs / 1000));
    }
  });

  // 2. Move Units (with Collision Separation and Pathfinding Bridge Waypoints)
  moveUnits(state, tickRateMs);

  // 3. Process Custom Troop Behaviors (like Healer AI)
  state.players.forEach((player) => {
    player.units.forEach((unit, uid) => {
      processHealerAI(unit, uid, player, state.elapsedSec);
    });
  });

  // 4. Combat: Apply Unit Attacks (spawns projectiles or applies instant melee damage)
  applyUnitDamage(
    state.players,
    state.elapsedSec,
    (pid, p) => state.projectiles.set(pid, p)
  );

  // 5. Combat: Process Automated Tower Attacks (cannonballs)
  processTowerAttacks(
    state.players,
    state.elapsedSec,
    (pid, p) => state.projectiles.set(pid, p)
  );

  // 6. Combat: Update flying projectiles pathing and impact checks
  updateProjectiles(state.players, state.projectiles, tickRateMs);

  // 7. Spells Detonation checking
  processSpells(state.players, state.elapsedSec);

  // 8. Evaluate Win Conditions (Crowns destroyed or Overtime timeout)
  checkWinCondition(state, onMatchEnded);
}

/**
 * Handles per-tick per-unit movement calculations,
 * bridge-crossing routing, and separation-force nudging.
 */
function moveUnits(state: BattleState, tickRateMs: number): void {
  const playerList = Array.from(state.players.values());

  // 1. Gather all alive troop units across both teams for collision checking
  const allAliveTroops: { unit: DeployedUnit; isAir: boolean }[] = [];
  playerList.forEach((player) => {
    // Cleanup dead units after a 1 second delay (for animations)
    player.units.forEach((unit, id) => {
      if (unit.hp <= 0) {
        if (unit.deathTime === 0) {
          unit.deathTime = state.elapsedSec;
        } else if (state.elapsedSec - unit.deathTime > 1.0) {
          player.units.delete(id);
        }
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
      applySeparationForces(unit, isUnitAir, allAliveTroops);

      // --- Target Seeking ---
      let targetX = 0;
      let targetZ = 0;
      let minDist = Infinity;

      // Giant only targets buildings (Towers) and ignore troops
      const targetsBuildingsOnly = unit.cardId === "giant";

      // 1. Scan Unit Lawan (skip if building-only target)
      if (!targetsBuildingsOnly) {
        enemy.units.forEach((eUnit) => {
          const d = Math.sqrt(Math.pow(eUnit.x - unit.x, 2) + Math.pow(eUnit.z - unit.z, 2));
          if (d < minDist) {
            minDist = d;
            targetX = eUnit.x;
            targetZ = eUnit.z;
          }
        });
      }

      // 2. Scan Tower Lawan
      enemy.towers.forEach((t: Tower, idx: number) => {
        if (t.hp <= 0) return;
        const { x: tx, z: tz } = getTowerCoords(t, enemy.team, idx);
        const d = Math.sqrt(Math.pow(tx - unit.x, 2) + Math.pow(tz - unit.z, 2));
        if (d < minDist) {
          minDist = d;
          targetX = tx;
          targetZ = tz;
        }
      });

      if (minDist === Infinity) {
        unit.action = "idle";
        unit.targetId = "";
        return;
      }

      // --- Pathfinding / Waypoint Routing (Bridges) ---
      const { moveTargetX, moveTargetZ } = routeThroughBridge(
        unit.x,
        unit.z,
        targetX,
        targetZ,
        isUnitAir
      );

      // Insting: Berhenti jika sudah dalam jangkauan serang
      const attackRange = CARD_RANGE[unit.cardId] ?? 2.2;

      if (minDist > attackRange) {
        const dx = moveTargetX - unit.x;
        const dz = moveTargetZ - unit.z;
        const distToRoute = Math.sqrt(dx * dx + dz * dz);
        
        if (distToRoute > 0.001) {
          const speed = 2.5;
          const moveStep = (speed * tickRateMs) / 1000;
          const actualStep = Math.min(moveStep, distToRoute);
          
          unit.x += (dx / distToRoute) * actualStep;
          unit.z += (dz / distToRoute) * actualStep;
        }
        unit.action = "walk";
        unit.targetId = "";
      } else {
        // In range -> stop and face target
        unit.action = "attack";
      }
    });
  });
}

/**
 * Evaluates the win/loss status of the game state.
 * Win conditions:
 *   1. Instantly win if the opponent's King Tower is destroyed (HP <= 0).
 *   2. If the overtime timer expires (MAX_DURATION), player with the most remaining towers wins.
 */
function checkWinCondition(state: BattleState, onMatchEnded: (winnerTeam: string) => void): void {
  const players: Player[] = Array.from(state.players.values());
  for (const player of players) {
    const kingTower = player.towers.find((t: Tower) => t.type === "king");
    
    // If a player's King Tower is destroyed, they lose immediately!
    if (kingTower && kingTower.hp <= 0) {
      const winner = players.find((p) => p.team !== player.team);
      state.winnerTeam = winner ? String(winner.team) : "draw";
      onMatchEnded(state.winnerTeam);
      return;
    }
  }

  // Overtime tiebreaker if MAX_DURATION is reached
  if (state.elapsedSec >= MAX_DURATION) {
    const p0 = players.find((p) => p.team === 0)?.towers.filter((t: Tower) => t.hp > 0).length || 0;
    const p1 = players.find((p) => p.team === 1)?.towers.filter((t: Tower) => t.hp > 0).length || 0;
    state.winnerTeam = p0 > p1 ? "0" : p1 > p0 ? "1" : "draw";
    onMatchEnded(state.winnerTeam);
  }
}
