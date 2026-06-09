import { Tower } from "../rooms/schema/BattleState.js";

/**
 * Maps a tower to its absolute coordinate system used in the 3D battlefield.
 * team 0 -> player side: z > 0; team 1 -> enemy side: z < 0.
 * Index in player.towers array uniquely determines its left/right side:
 *   - Index 0: Left Princess Tower (X = -6)
 *   - Index 1: King Tower (X = 0)
 *   - Index 2: Right Princess Tower (X = 6)
 */
export function getTowerCoords(tower: Tower, towerTeam: number, idx: number): { x: number; z: number } {
  const tx = idx === 1 ? 0 : (idx === 0 ? -6 : 6);
  const tz = towerTeam === 0 ? (tower.type === "king" ? 13 : 10) : (tower.type === "king" ? -13 : -10);
  return { x: tx, z: tz };
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
