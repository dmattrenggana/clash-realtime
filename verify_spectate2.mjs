import { Client } from "colyseus.js";
const client = new Client("wss://ws.clashonchain.xyz");
const roomId = process.argv[2];
console.log(`Joining ${roomId} as spectator...`);
const room = await client.joinById(roomId, { spectate: true });
console.log(`Joined. sessionId=${room.sessionId}`);

let ticks = 0;
let lastElapsed = -1;
room.onStateChange((state) => {
  ticks++;
  if (state.elapsedSec !== lastElapsed) {
    const units = Array.from(state.players?.values?.() || []).map(p => `${p.nickname}=${p.units?.length || 0}`).join(",");
    const towers = Array.from(state.towers?.values?.() || []).map(t => `${t.type[0]}${t.team}_${t.hp}`).join(",");
    console.log(`[T+${state.elapsedSec?.toFixed(0)}s tick#${ticks}] status=${state.status} units=[${units}] towers=[${towers}]`);
    lastElapsed = state.elapsedSec;
  }
});
setTimeout(() => room.leave(), 25000);
