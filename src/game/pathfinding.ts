import { Tower } from "../rooms/schema/BattleState.js";

/**
 * Maps a tower to its absolute coordinate system used in the 3D battlefield.
 * team 0 -> player side: z > 0; team 1 -> enemy side: z < 0.
 */
export function getTowerCoords(tower: Tower, towerTeam: number, attackerX: number): { x: number; z: number } {
  if (tower.type === "king") {
    return { x: 0, z: towerTeam === 0 ? 13 : -13 };
  } else {
    // Princess tower: determine left or right based on the attacker's X position to target the nearest one
    const tx = attackerX > 0 ? 6 : -6;
    return { x: tx, z: towerTeam === 0 ? 10 : -10 };
  }
}

/**
 * Route a ground unit through bridges if they are targeting something across the river (Z=0).
 * Left bridge: X=-6, Right bridge: X=6.
 */
export function routeThroughBridge(
  unitX: number,
  unitZ: number,
  targetX: number,
  targetZ: number,
  isAir: boolean
): { moveTargetX: number; moveTargetZ: number } {
  if (isAir) {
    return { moveTargetX: targetX, moveTargetZ: targetZ };
  }

  const currentSide = unitZ > 0 ? 1 : -1;
  const targetSide = targetZ > 0 ? 1 : -1;

  // If unit and target are on different sides of the river, and unit hasn't crossed the river centerline (Z=0) yet
  if (currentSide !== targetSide && Math.abs(unitZ) > 0.5) {
    const leftBridgeDist = Math.pow(unitX - (-6), 2) + Math.pow(unitZ, 2);
    const rightBridgeDist = Math.pow(unitX - 6, 2) + Math.pow(unitZ, 2);
    const bridgeX = leftBridgeDist < rightBridgeDist ? -6 : 6;

    return { moveTargetX: bridgeX, moveTargetZ: 0 }; // Route to the river centerline on the bridge
  }

  return { moveTargetX: targetX, moveTargetZ: targetZ };
}
