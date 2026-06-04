import { Room, Client, CloseCode } from "colyseus";
import {
  BattleState,
  Player,
  Tower,
  DeployedUnit,
  CARD_COST,
  CARD_DPS,
  INITIAL_TOWER_HP,
  ELIXIR_REGEN_PER_SEC,
  MAX_DURATION,
} from "./schema/BattleState.js";

const TICK_RATE_MS = 100; // 10Hz

export class BattleRoom extends Room<BattleState> {
  maxClients = 2;
  private tickInterval: NodeJS.Timeout | null = null;
  private gameStartTime = 0;

  onCreate(options: any) {
    this.state = new BattleState();
    this.state.seed = options.seed || this.randomSeed();
    console.log(`[BattleRoom] Created with seed: ${this.state.seed}`);
  }

  onJoin(client: Client, options: any) {
    console.log(`[BattleRoom] ${client.sessionId} joined (wallet: ${options.wallet})`);

    const team = this.state.players.size;
    const player = new Player();
    player.walletAddress = options.wallet || "anonymous";
    player.team = team;

    // Init 3 towers
    const t1 = new Tower();
    t1.type = "princess"; t1.hp = INITIAL_TOWER_HP.princess; t1.maxHp = INITIAL_TOWER_HP.princess;
    const t2 = new Tower();
    t2.type = "king"; t2.hp = INITIAL_TOWER_HP.king; t2.maxHp = INITIAL_TOWER_HP.king;
    const t3 = new Tower();
    t3.type = "princess"; t3.hp = INITIAL_TOWER_HP.princess; t3.maxHp = INITIAL_TOWER_HP.princess;

    player.towers.push(t1, t2, t3);
    this.state.players.set(client.sessionId, player);

    if (this.state.players.size === 2) {
      this.state.status = "playing";
      this.gameStartTime = Date.now();
      this.tickInterval = setInterval(() => this.tick(), TICK_RATE_MS);
      console.log(`[BattleRoom] Game started!`);
    }
  }

  onLeave(client: Client, code: CloseCode) {
    console.log(`[BattleRoom] ${client.sessionId} left (code: ${code})`);
    this.state.players.delete(client.sessionId);
    if (this.state.status === "playing" && this.state.players.size < 2) {
      this.endMatch();
    }
  }

  onDispose() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    console.log(`[BattleRoom] Disposed`);
  }

  private tick() {
    if (this.state.status !== "playing") return;

    this.state.elapsedSec = Math.floor((Date.now() - this.gameStartTime) / 1000);

    // Regen elixir
    this.state.players.forEach((p: Player) => {
      if (p.elixir < 10) p.elixir = Math.min(10, p.elixir + ELIXIR_REGEN_PER_SEC * (TICK_RATE_MS / 1000));
    });

    // Damage: units attack random enemy tower
    this.applyUnitDamage();

    // Win check
    this.checkWinCondition();
  }

  private applyUnitDamage() {
    const players: Player[] = Array.from(this.state.players.values());
    players.forEach((attacker) => {
      const enemy = players.find((p) => p.team !== attacker.team);
      if (!enemy) return;
      attacker.units.forEach((unit: DeployedUnit) => {
        const living = enemy.towers.filter((t: Tower) => t.hp > 0);
        if (living.length === 0) return;
        const target = living[Math.floor(Math.random() * living.length)];
        const dps = CARD_DPS[unit.cardId] || 0;
        const damage = Math.floor(dps * 5 * (TICK_RATE_MS / 1000));
        target.hp = Math.max(0, target.hp - damage);
      });
    });
  }

  private checkWinCondition() {
    const players: Player[] = Array.from(this.state.players.values());
    for (const player of players) {
      const living = player.towers.filter((t) => t.hp > 0).length;
      if (living === 0) {
        const winner = players.find((p) => p.team !== player.team);
        this.state.winnerTeam = winner ? String(winner.team) : "draw";
        this.endMatch();
        return;
      }
    }
    if (this.state.elapsedSec >= MAX_DURATION) {
      const p0 = players.find((p) => p.team === 0)?.towers.filter((t) => t.hp > 0).length || 0;
      const p1 = players.find((p) => p.team === 1)?.towers.filter((t) => t.hp > 0).length || 0;
      this.state.winnerTeam = p0 > p1 ? "0" : p1 > p0 ? "1" : "draw";
      this.endMatch();
    }
  }

  private endMatch() {
    this.state.status = "ended";
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    console.log(`[BattleRoom] Match ended. Winner: ${this.state.winnerTeam}`);

    this.broadcast("matchEnd", {
      winnerTeam: this.state.winnerTeam,
      duration: this.state.elapsedSec,
      players: Array.from(this.state.players.values()).map((p) => ({
        wallet: p.walletAddress,
        team: p.team,
        towersAlive: p.towers.filter((t: Tower) => t.hp > 0).length,
      })),
    });
  }

  messages = {
    deployCard: (client: Client, payload: { cardId: string; x: number; z: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const cost = CARD_COST[payload.cardId];
      if (cost === undefined) {
        client.send("error", { message: `Unknown card: ${payload.cardId}` });
        return;
      }
      if (player.elixir < cost) {
        client.send("error", { message: `Insufficient elixir` });
        return;
      }
      player.elixir -= cost;
      const unit = new DeployedUnit();
      unit.cardId = payload.cardId;
      unit.team = player.team;
      unit.x = payload.x;
      unit.z = payload.z;
      unit.spawnTime = this.state.elapsedSec;
      player.units.push(unit);
      console.log(`[BattleRoom] Team ${player.team} deployed ${payload.cardId}`);
    },
  };

  private randomSeed(): string {
    return Math.random().toString(36).substring(2, 18);
  }
}
