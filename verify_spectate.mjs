// Connect to a room as spectator and dump state every 2s
import { Client } from "colyseus.js";

const client = new Client("wss://ws.clashonchain.xyz");
const roomId = process.argv[2];
if (!roomId) { console.log("usage: node verify_spectate.mjs ROOMID"); process.exit(1); }

console.log(`Connecting to ${roomId} as spectator...`);
const room = await client.joinById(roomId, { spectate: true });
console.log("Connected. SessionId:", room.sessionId);

let snapshots = 0;
room.onStateChange((state) => {
  snapshots++;
  if (snapshots % 5 === 0) {
    const towers = Array.from((state.towers?.values?.() || [])).map(t => ({t: t.team, type: t.type, hp: t.hp}));
    const playerArr = Array.from((state.players?.values?.() || [])).map(p => ({nick: p.nickname, units: p.units?.length || 0}));
    const player0 = playerArr[0] || {};
    const player1 = playerArr[1] || {};
    console.log(`[${new Date().toISOString().slice(11,19)}] tick#${snapshots} status=${state.status} elapsed=${state.elapsedSec?.toFixed(1)}s units(P0=${player0.units},P1=${player1.units}) towers=${JSON.stringify(towers.map(t => `${t.type[0]}${t.t}_${t.hp}`).join(","))}`);
  }
});

setTimeout(() => {
  console.log("Disconnecting.");
  room.leave();
  process.exit(0);
}, 30000);
