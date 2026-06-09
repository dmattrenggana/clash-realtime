# Colyseus Reference — Clash-Onchain Realtime

> **Source:** Synthesized from [docs.colyseus.io](https://docs.colyseus.io) (June 2026)
> **Project version:** `colyseus@^0.17.6` + `@colyseus/schema@^4.0.0` + `@colyseus/tools@^0.17.0`
> **Author intent:** Single grounded reference for the project. Maps the entire Colyseus
> API surface against our actual code (`BattleRoom`, `BattleQueueRoom`, `BattleState`,
> `app.config.ts`) — what's used, what isn't, and why.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Room Lifecycle](#2-room-lifecycle)
3. [State Synchronization & Schema](#3-state-synchronization--schema)
4. [Matchmaker API](#4-matchmaker-api)
5. [Messaging](#5-messaging)
6. [Reconnection](#6-reconnection)
7. [Timing Utilities](#7-timing-utilities)
8. [Authentication](#8-authentication)
9. [Testing (`@colyseus/testing`)](#9-testing-colyseustesting)
10. [Built-in `QueueRoom` (vs our `BattleQueueRoom`)](#10-built-in-queueroom-vs-our-battlequeueroom)
11. [0.17 Migration Notes](#11-017-migration-notes)
12. [Best Practices](#12-best-practices)
13. [What We DON'T Use (and Why)](#13-what-we-dont-use-and-why)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                      colyseus/server process                     │
│                                                                  │
│  ┌──────────────────┐           ┌──────────────────┐             │
│  │  BattleQueueRoom │ ────────► │    BattleRoom    │             │
│  │  (matchmaking)   │ reserveSeat│   (1v1 game)     │            │
│  │  maxClients=100  │           │  maxClients=2    │             │
│  └──────────────────┘           └──────────────────┘             │
│           │                              │                        │
│           │ matchMaker.createRoom        │ this.clock.setInterval │
│           │ matchMaker.reserveSeatFor    │  (10Hz tick)           │
│           │                              │                        │
│  ┌────────▼──────────────────────────────▼────────────────────┐  │
│  │            app.config.ts → defineServer()                  │  │
│  │   rooms: { battle_queue, battle } + express() routes       │  │
│  └─────────────────────────────────────────────────────────────┘  │
│           │                                                       │
│  ┌────────▼─────────────┐    ┌─────────────────────────────┐     │
│  │  Schema/State (RPC)  │    │  HTTP routes (Express)      │     │
│  │  BattleState         │    │  /monitor, / (playground)   │     │
│  │  Player, Tower, Unit │    │  @colyseus/tools listen:2567│     │
│  └──────────────────────┘    └─────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
        ▲                                          ▲
        │ WebSocket                                │ WebSocket
        │ (colyseus.js client)                     │
        │                                          │
   ┌────┴────┐                                ┌────┴────┐
   │ Client  │                                │ Client  │
   │ (anon)  │                                │ (anon)  │
   └─────────┘                                └─────────┘
```

**Key facts:**
- The **matchmaker** is a singleton inside the Colyseus process. We never talk to it
  directly from a client — the client SDK does that. We only call `matchMaker.*` from
  inside server-side room code (e.g., `BattleQueueRoom.matchPlayers()`).
- **State sync is automatic** — we mutate `this.state.players` / `this.state.towers` and
  Colyseus encodes + ships a diff to all clients every `patchRate` (default 50ms).
- **Two separate rooms = two separate state trees.** A client in `battle_queue` only sees
  queue state. Once they consume the seat reservation and join `battle`, they see
  `BattleState` — completely different schema.

---

## 2. Room Lifecycle

Full lifecycle hooks Colyseus calls in order:

| Hook | When it fires | Our usage |
|------|---------------|-----------|
| `static onAuth(token, options, context)` | Before `onJoin` — gate connection | `BattleRoom` (Privy JWT verify) |
| `onCreate(options)` | Room first instantiated by matchmaker | Both rooms (init state, arm timers) |
| `onJoin(client, options, auth)` | New client connected | `BattleRoom` (add Player + 3 Towers) / `BattleQueueRoom` (queue) |
| `onMessage(type, handler)` | Registered via `messages = { … }` | `BattleRoom` (deployCard, surrender) |
| `onDrop(client, code)` | Abnormal disconnect (codes 1005/1006/1001/4010) | `BattleRoom` (mark disconnected, `allowReconnection`) |
| `onReconnect(client)` | Client reconnected inside grace window | `BattleRoom` (mark connected) |
| `onLeave(client, code)` | Permanent leave (consent OR reconnection expired) | Both rooms (cleanup, end match) |
| `onDispose()` | Room is being destroyed (empty + `autoDispose`) | Both rooms (clear intervals) |
| `onBeforePatch()` | Just before each state patch ships | (unused) |
| `onUncaughtException(err, methodName)` | Lifecycle hook threw | (unused) |
| `onBeforeShutdown()` | Server graceful shutdown | (unused) |

### When `onDrop` vs `onLeave` fires (close codes)

| Code | Name | Hook |
|------|------|------|
| `1000` | `NORMAL_CLOSURE` | — |
| `1001` | `GOING_AWAY` (tab close) | **`onDrop`** |
| `1005` | `NO_STATUS_RECEIVED` | **`onDrop`** |
| `1006` | `ABNORMAL_CLOSURE` (net drop) | **`onDrop`** |
| `4000` | `CONSENTED` (client called `room.leave()`) | **`onLeave` directly** |
| `4001` | `SERVER_SHUTDOWN` | **`onLeave` directly** |
| `4003` | `FAILED_TO_RECONNECT` (reconnect retries exhausted) | **`onLeave` directly** |
| `4010` | `MAY_TRY_RECONNECT` (devMode server restart) | **`onDrop`** |

> **Gotcha:** If you do cleanup in `onLeave`, you must guard against double-cleanup
> from `onDrop` (mark disconnected) → `onLeave` (delete). Our `BattleRoom.onLeave`
> does `if (this.state.players.has(client.sessionId)) this.state.players.delete(...)`
> — defensive against the race.

### Our pattern: `onDrop` + `allowReconnection` + `onLeave` cleanup

```typescript
// BattleRoom.ts (abbreviated)
async onDrop(client, code) {
  const player = this.state.players.get(client.sessionId);
  if (player) player.connected = false;        // mark, don't delete
  try {
    await this.allowReconnection(client, RECONNECTION_GRACE_SEC);  // 30s
  } catch {
    // grace expired → onLeave will fire next
  }
}

onReconnect(client) {
  const player = this.state.players.get(client.sessionId);
  if (player) player.connected = true;         // restore
}

onLeave(client, code) {
  if (this.state.players.has(client.sessionId)) {
    this.state.players.delete(client.sessionId);  // safe delete
  }
  if (this.state.status === "playing" && this.state.players.size < 2) {
    this.endMatch();                            // forfeit
  }
}
```

### Our pattern: empty-room watchdog in `onCreate`

```typescript
// BattleRoom.ts
private EMPTY_ROOM_TIMEOUT_MS = 30_000;
private emptyTimeout: Delayed | null = null;

onCreate(options) {
  this.state = new BattleState();
  // ...
  this.emptyTimeout = this.clock.setTimeout(
    () => this.checkEmptyTimeout(),
    EMPTY_ROOM_TIMEOUT_MS,
  );
}

onJoin(client, options, auth) {
  // ... add player ...
  if (this.state.players.size === 2) {
    // game started → cancel the watchdog
    this.emptyTimeout.clear();
    this.emptyTimeout = null;
    this.tickInterval = this.clock.setInterval(() => this.tick(), 100);
  }
}
```

**Why this matters:** Matchmaker can create a `BattleRoom` (via `matchMaker.createRoom`)
but the second client may never consume their seat reservation (e.g., WebSocket failure,
user closed tab). Without the watchdog, the room would live forever and waste resources.

---

## 3. State Synchronization & Schema

### What `Schema` is for

> **Schema structures are for state only — not for messages or non-state data.**

Anything you want auto-synced to clients goes in a class extending `Schema`. One-time
events (`matchEnd`, `error`, `roomTimeout`) go through `broadcast()` instead.

### `@type()` decorator — primitive types

| Type | Range / Notes | Use when |
|------|---------------|----------|
| `"string"` | up to 4,294,967,295 bytes | names, wallet addresses |
| `"boolean"` | encoded as 0/1 | flags, connected status |
| `"number"` | variable-length, **+1 byte for type tag** | when range is unknown |
| `"int8"` | -128 to 127 | small deltas |
| `"uint8"` | 0 to 255 | team id, small counters |
| `"int16"` | -32,768 to 32,767 | small signed |
| `"uint16"` | 0 to 65,535 | HP, elapsed seconds |
| `"int32"` | ±2.1B | general signed |
| `"uint32"` | 0 to 4.3B | general unsigned |
| `"int64"` | stored as JS `number`, safe to ±9×10¹⁵ | balances, large counters |
| `"uint64"` | same constraint as int64 | non-negative large counters |
| `"bigInt64"` | stored as `bigint` | when you actually need 64 bits |
| `"bigUint64"` | stored as `bigint` | same |
| `"float32"` | single precision | positions (x, z) — 3D coords |
| `"float64"` | double precision | high-precision positions |

> **Per-type selection in our code:**
> - `Player.team` → `uint8` (only 0/1, but could extend to FFA 0–3)
> - `Tower.hp` / `Tower.maxHp` → `uint16` (max 65535, we use 350/500)
> - `DeployedUnit.x` / `z` → `float32` (sufficient for a 200×200 field)
> - `BattleState.elapsedSec` → `uint16` (max match is 600s, fits in 65535)
> - `BattleState.seed` → `string` (16 hex chars from `randomBytes(8)`)

### `@type()` decorator — collection types

| Pattern | Our usage |
|---------|-----------|
| `@type({ map: Player })` | `BattleState.players` — keyed by `sessionId` |
| `@type([Tower])` | `Player.towers` — fixed list of 3 |
| `@type([DeployedUnit])` | `Player.units` — growing list as cards deployed |

**MapSchema** only supports **string keys** (we use `client.sessionId`).
**ArraySchema** cannot mix types. **`array.move(cb)`** allows reorder without full
re-encode — useful for hot-reordering unit priority lists.

### Max fields per Schema: **64**

Not a concern for us (largest is `BattleState` with 5 fields), but worth knowing for
complex games (MMO inventory, spellbooks, etc.).

### Inheritance works inside collections

```typescript
class Item extends Schema {}
class Weapon extends Item {}
class Shield extends Item {}

class Inventory extends Schema {
  @type({ map: Item }) items = new MapSchema<Item>();
}

inv.items.set("left", new Weapon());
inv.items.set("right", new Shield());  // ✅ same base class
```

### Versioning / backwards compat

```typescript
import { Schema, type, deprecated } from "@colyseus/schema";

class MyState extends Schema {
  @deprecated() @type("string") myField: string;  // old clients still parse
  @type("string") newField: string;              // new field at the end
}
```

Critical for native clients (C#, C++, Haxe, Haxe) where you can't ship a new build
synchronously. Not a concern for our pure-WebSocket JSON clients today, but good
to know.

### Mutation pattern (CRITICAL)

> **The state is mutable. Mutate in place. Don't reassign `this.state`.**

```typescript
// ✅ correct
this.state.players.set(client.sessionId, player);
this.state.players.get(client.sessionId).elixir -= 3;

// ❌ wrong — reassigning breaks the patcher
this.state = new BattleState();
this.state.players = new MapSchema();
```

### Our actual schema (current)

```typescript
// BattleState.ts
export class Tower extends Schema {
  @type("string") type: string = "princess";
  @type("uint16") hp: number = 350;
  @type("uint16") maxHp: number = 350;
}

export class DeployedUnit extends Schema {
  @type("string") cardId: string = "";
  @type("uint8") team: number = 0;
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") spawnTime: number = 0;
}

export class Player extends Schema {
  @type("string") walletAddress: string = "";
  @type("uint8") team: number = 0;
  @type("float32") elixir: number = 5;
  @type("boolean") connected: boolean = true;
  @type([Tower]) towers = new ArraySchema<Tower>();
  @type([DeployedUnit]) units = new ArraySchema<DeployedUnit>();
}

export class BattleState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("uint16") elapsedSec: number = 0;
  @type("string") status: string = "waiting";  // waiting | playing | ended
  @type("string") winnerTeam: string = "";
  @type("string") seed: string = "";
}
```

---

## 4. Matchmaker API

The matchmaker is the **server-side singleton that brokers room creation/joining**.
Clients never see it — the SDK handles it transparently. We only call it from
server-side room code.

### Full API (from docs)

| Method | Signature | Returns |
|--------|-----------|---------|
| `createRoom(name, options?)` | `Promise<{ roomId, processId, name, locked }>` | Bare room creation, no seat reservation |
| `joinOrCreate(name, options?)` | `Promise<{ sessionId, room }>` | Client-side: join existing or create new |
| `create(name, options?)` | `Promise<{ sessionId, room }>` | Client-side: always create new |
| `join(name, options?)` | `Promise<{ sessionId, room }>` | Client-side: fail if none available |
| `joinById(roomId, options?)` | `Promise<{ sessionId, room }>` | Client-side: direct join by ID |
| `reserveSeatFor(room, clientOptions?, authData?)` | `Promise<{ sessionId, room }>` | Server-side: reserve a seat, return reservation to client |
| `query(conditions, sort?)` | `Promise<Array>` | List rooms matching conditions |
| `findOneRoomAvailable(name, options?)` | `Promise<{ … }>` | Internal helper for `join` |
| `getRoomById(roomId)` | `Promise<{ … }>` | Lookup by ID |
| `getLocalRoomById(roomId)` | `Room \| undefined` | Sync lookup (same process only) |
| `remoteRoomCall(roomId, method, args?)` | `Promise<any>` | Cross-process method call (for clustered matchmaker) |
| `matchMaker.stats.fetchAll()` | `Promise<Array<{processId, roomCount, ccu}>>` | Per-process stats |
| `matchMaker.stats.getGlobalCCU()` | `Promise<number>` | Global concurrent users |
| `matchMaker.stats.local.ccu` | `number` | This process's CCU |

### Our actual usage in `BattleQueueRoom.matchPlayers()`

```typescript
// 1. Create the room (no client yet — this is a pre-game staging area)
const battleRoom = await matchMaker.createRoom("battle", {});
//   → returns { roomId: "abc", processId: "self", name: "battle", locked: false }

// 2. Reserve seats for both players (this is the "matchFound" payload)
const resA = await matchMaker.reserveSeatFor(battleRoom, { wallet: a?.wallet });
const resB = await matchMaker.reserveSeatFor(battleRoom, { wallet: b?.wallet });
//   → returns { sessionId: "sess-xxx", room: { roomId, processId, name, locked } }
//   → the client uses this via client.consumeSeatReservation(reservation)

// 3. Send to each client
client.send("matchFound", resA);  // client now has a seat reservation
client.send("matchFound", resB);
```

> **Gotcha:** `createRoom` does NOT join a client. `joinOrCreate` does both. We
> use `createRoom` + `reserveSeatFor` because we want to control the timing of
> the handoff (the `matchAccepted` ack pattern).

### The seat reservation lifecycle

```
matchMaker.createRoom      → room exists, no clients
matchMaker.reserveSeatFor  → room has 1 seat "locked" for ~15s
                            → returns { sessionId, room } to sender
sender forwards reservation to client
client.consumeSeatReservation(reservation) → opens new WebSocket, joins room
                            → seat "unlocked" (if no consumption in 15s, auto-expires)
```

Default `seatReservationTimeout` is 15s. If a client doesn't consume in that window,
the reservation auto-expires and the room goes back to having 0 locked seats.

---

## 5. Messaging

### Three channels

| Channel | API | Use case |
|---------|-----|----------|
| **State** | Mutate `this.state.*` | Persistent data, auto-synced via patches |
| **Broadcast** | `this.broadcast(type, payload)` | One-time events to all clients |
| **Send** | `client.send(type, payload)` | One-time events to one client |

> Schema is for state. Messages are for events. Mixing them is the #1 mistake.

### Our broadcast pattern

```typescript
// BattleRoom.ts

// On match end — sent to all clients
this.broadcast("matchEnd", {
  winnerTeam: this.state.winnerTeam,
  duration: this.state.elapsedSec,
  players: [...this.state.players.values()].map((p) => ({ ... })),
});

// On empty-room timeout — sent to any client that managed to connect
this.broadcast("roomTimeout", {
  reason: "no_second_player",
  timeoutMs: EMPTY_ROOM_TIMEOUT_MS,
});
```

### Our `client.send` pattern (errors)

```typescript
// Inside a messages handler
client.send("error", {
  code: "INSUFFICIENT_ELIXIR",
  message: "Not enough elixir",
});
```

Error codes we emit (per `BattleRoom.ts`):

| Code | Trigger |
|------|---------|
| `NOT_PLAYING` | `deployCard` while `status !== "playing"` |
| `DISCONNECTED` | `deployCard` while player is in drop state |
| `INVALID_CARD` | `cardId` not in `CARD_COST` table |
| `INSUFFICIENT_ELIXIR` | `player.elixir < card cost` |
| `INVALID_ZONE` | `deployCard` outside player's half (`z > 0` for team 0, `z < 0` for team 1) |

### `messages` object + `validate(Zod, handler)`

```typescript
import { z } from "zod";
import { validate } from "colyseus";

const deployCardSchema = z.object({
  cardId: z.string().min(1).max(50),
  x: z.number().finite().gte(-FIELD_BOUND).lte(FIELD_BOUND),
  z: z.number().finite().gte(-FIELD_BOUND).lte(FIELD_BOUND),
});

messages = {
  deployCard: validate(deployCardSchema, (client, payload) => {
    // payload is already typed + validated
    // ... anti-cheat checks (elixir, zone) ...
  }),
  surrender: validate(z.object({}).optional(), (client, _payload) => {
    // ...
  }),
};
```

> **Why `validate` and not manual checks?** Server-side input validation is
> defense-in-depth. Even if the frontend is benign, a hand-crafted WebSocket
> message can bypass client-side checks. Zod rejects bad payloads BEFORE the
> handler runs.

### `broadcast` options

```typescript
this.broadcast("event", payload, {
  except: client,            // exclude this client
  // except: [client1, client2],
  afterNextPatch: true,      // wait for the next state patch before sending
});
```

We don't use these today, but useful for:
- Hiding your own player's actions (e.g., "card deployed" to opponents only)
- Ordering events relative to state (e.g., "damage applied" right after HP changes)

### Message composability (0.17+)

```typescript
// thirdPartyMessages.ts
import { validate, type Messages } from "colyseus";
import { z } from "zod";

type MyRoom = BattleRoom;

export const chatMessages: Messages<MyRoom> = {
  chat: validate(z.object({ text: z.string().max(500) }), function (client, msg) {
    this.broadcast("chat", { sender: client.sessionId, text: msg.text });
  }),
};
```

```typescript
// In BattleRoom.ts
import { chatMessages } from "./thirdPartyMessages";

messages = {
  ...chatMessages,           // ← composable
  deployCard: validate(..., ...),
  surrender: validate(..., ...),
};
```

> **Important (0.17):** Multiple handlers can register for the same message type.
> They all run. Use the returned `unbind()` function to detach. Handlers defined
> later override earlier ones with the **same name**.

### Wildcard handler

```typescript
messages = {
  "*": (client, type, payload) => {
    // catch-all for any unhandled message
    console.warn(`Unknown message "${type}" from ${client.sessionId}`);
  },
  deployCard: ...,
  surrender: ...,
};
```

---

## 6. Reconnection

### The flow

```
Client detects disconnect
  → room.onDrop(code, reason)              (client)
  → onDrop(client, code)                   (server)        ← CALL allowReconnection HERE

Client retries with exponential backoff
  (default: 15 retries, 100ms initial, 5000ms max, 5000ms minUptime)

  ┌─ Reconnect succeeds → onReconnect(client)  (both sides)
  └─ Reconnect fails    → onLeave(code=FAILED_TO_RECONNECT)
                          ↑ (no separate "reconnect failed" hook — onLeave handles it)
```

### `allowReconnection(client, timeout)`

```typescript
// Number overload: 30s grace window
await this.allowReconnection(client, 30);

// "manual" overload: indefinite — you must call reconnection.reject() yourself
const r = this.allowReconnection(client, "manual");
setTimeout(() => r.reject(new Error("Game has ended")), 60_000);
```

Returns a `Deferred<Client>`. Resolves on reconnect, rejects on timeout.

### Our 30s grace + handoff in BattleQueueRoom

> Different pattern — this is for **handoff** between `battle_queue` and `battle`,
> not for accidental disconnects.

```typescript
// BattleQueueRoom.ts
private HANDOFF_TIMEOUT_MS = 5_000;

private async startHandoff(client, reservation, battleRoomId) {
  // 1. Send the seat reservation
  client.send("matchFound", reservation);

  // 2. Wait for ack, with timeout
  const timeout = this.clock.setTimeout(() => {
    // ... force leave client, log warning ...
  }, HANDOFF_TIMEOUT_MS);

  // 3. The onMessage("matchAccepted") handler clears the timeout
  //    and leaves the client from the queue (now in battle room)
}
```

### Client-side reconnection config (future frontend)

```typescript
const room = await client.joinOrCreate("battle");
room.reconnection.maxRetries = 15;          // default 15
room.reconnection.delay = 100;              // initial delay ms
room.reconnection.minDelay = 100;           // floor ms
room.reconnection.maxDelay = 5000;          // ceiling ms
room.reconnection.minUptime = 5000;         // must be connected 5s before reconnect
room.reconnection.maxEnqueuedMessages = 10; // buffer during disconnect
room.reconnection.backoff = (attempt, delay) => {
  return Math.floor(Math.pow(2, attempt) * delay);  // exponential
};
```

### Close codes cheatsheet

```
1000  NORMAL_CLOSURE        — clean
1001  GOING_AWAY            — tab/browser close          → onDrop
1005  NO_STATUS_RECEIVED    — no close frame             → onDrop
1006  ABNORMAL_CLOSURE      — network drop               → onDrop
4000  CONSENTED             — client called room.leave()  → onLeave
4001  SERVER_SHUTDOWN       — server graceful shutdown    → onLeave
4002  WITH_ERROR            — closed due to error         → onLeave
4003  FAILED_TO_RECONNECT   — reconnect retries exhausted → onLeave
4010  MAY_TRY_RECONNECT     — devMode server restart      → onDrop
```

> **Reserved range:** 4000–4010 are now Colyseus-internal. Don't use these for
> custom close codes — use 4001–4999 for custom purposes (per docs).

---

## 7. Timing Utilities

### Three flavors

| API | Use for | Sync with game loop? |
|-----|---------|---------------------|
| `this.setSimulationInterval(cb, timeStep?)` | Main game loop, physics, state mutations | ✅ yes — drives `clock.tick()` |
| `this.clock.setInterval(cb, ms, ...args)` | Independent scheduled events | ❌ no — fires on its own |
| `this.clock.setTimeout(cb, ms, ...args)` | One-shot future event | ❌ no |

### The `Delayed` object

Returned by `setInterval` / `setTimeout`. Methods:

```typescript
delayed.pause();
delayed.resume();
delayed.clear();          // stop + destroy
delayed.reset();          // elapsedTime → 0
delayed.elapsedTime;      // ms since started
delayed.active;           // boolean
delayed.paused;           // boolean
```

**All `Delayed` instances are auto-cleared on `onDispose`** — but we manually `.clear()`
in `onDispose` as defense-in-depth (the `BattleRoom` pattern).

### Why we use `clock.setInterval` and not `setSimulationInterval`

Our `BattleRoom.tick()` fires every 100ms. We could use either:

```typescript
// Option A: clock.setInterval (what we do)
this.tickInterval = this.clock.setInterval(() => this.tick(), 100);

// Option B: setSimulationInterval
this.setSimulationInterval(() => this.tick(), 100);
```

**Why we chose A:** `setSimulationInterval` is the recommended pattern in docs,
but it also **drives `clock.tick()`** — meaning all our other `clock.setTimeout`
(like the empty-room watchdog) tick on the simulation interval. If we ever change
the tick rate to something exotic, the watchdog timing also changes. With `A`,
the game tick and the watchdog are independent, easier to reason about.

In practice either works. Just be aware that mixing them can be subtle.

### Reading time

```typescript
this.clock.elapsedTime;  // ms since clock.start()
this.clock.currentTime;   // current ms (useful for delta-time math)
this.clock.deltaTime;     // ms between last and current tick
```

### Our actual game tick

```typescript
// BattleRoom.ts
const TICK_RATE_MS = 100;  // 10 Hz

private tick() {
  if (this.state.status !== "playing") return;

  this.state.elapsedSec = Math.floor((Date.now() - this.gameStartTime) / 1000);

  // 1. Regen elixir for both players
  this.state.players.forEach((p) => {
    if (p.elixir < 10) {
      p.elixir = Math.min(10, p.elixir + ELIXIR_REGEN_PER_SEC * (TICK_RATE_MS / 1000));
    }
  });

  // 2. Apply unit → tower damage
  this.applyUnitDamage();

  // 3. Check win condition (or time-out)
  this.checkWinCondition();
}
```

---

## 8. Authentication

### Static vs instance `onAuth`

```typescript
// Static (recommended) — runs BEFORE the room instance is created
class MyRoom extends Room {
  static async onAuth(token: string, options: any, context: any) {
    // verify token...
    return { userId: claims.userId, wallet: options.wallet };
  }
}

// Instance — runs after room exists (use only if you need this.state)
class MyRoom extends Room {
  async onAuth(client: Client, options: any, context: any) {
    // ... rare ...
  }
}
```

### Return values

| Return | Effect |
|--------|--------|
| **truthy** | `onJoin(client, options, auth)` is called; `auth` is the returned value (also accessible via `client.auth`) |
| **falsy** | Client is rejected, matchmaking fails |
| **throw `ServerError`** | Rejected with custom error exposed to frontend |

### The `context` object

```typescript
context.token;     // auth token from client
context.headers;   // HTTP headers
context.ip;        // X-Real-IP → X-Forwarded-For → remoteAddress
```

### Our Privy integration

```typescript
// BattleRoom.ts (key bits)
import { PrivyClient } from "@privy-io/server-auth";
import { z } from "zod";

let _privy: PrivyClient | null = null;
function getPrivy(): PrivyClient {
  if (!_privy) {
    if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
      throw new Error("Privy client not configured");
    }
    _privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
  }
  return _privy;
}

static async onAuth(token: string, options: any, context: any) {
  const allowAnon = process.env.ALLOW_ANON_USERS === "true";
  if (allowAnon) {
    return { userId: options.wallet || "anonymous", wallet: options.wallet || "anonymous" };
  }
  if (!token) throw new Error("Missing auth token");
  try {
    const claims = await getPrivy().verifyAuthToken(token);
    return { userId: claims.userId, wallet: options.wallet || "" };
  } catch {
    throw new Error("Invalid auth token");
  }
}
```

> **Gotcha (env load order):** `@colyseus/tools` loads `.env.production` via dotenv
> AFTER our modules are imported. Reading `process.env` at module load time always
> sees empty env. We read env lazily in `onAuth()` and `onCreate()` instead. This
> is documented in the code as a comment.

> **Bypass pattern:** `ALLOW_ANON_USERS=true` is our dev/test escape hatch. In
> production we validate PRIVY_APP_ID + PRIVY_APP_SECRET are set or refuse to start.

---

## 9. Testing (`@colyseus/testing`)

### Setup

```typescript
import { ColyseusTestServer, boot } from "@colyseus/testing";
import appConfig from "../src/app.config";

describe("...", () => {
  let colyseus: ColyseusTestServer;

  before(async () => { colyseus = await boot(appConfig); });
  after(async () => { await colyseus.shutdown(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  // ...
});
```

### Test server utilities

| Method | Returns | Use |
|--------|---------|-----|
| `boot(appConfig)` | `ColyseusTestServer` | Boot server in-memory |
| `colyseus.shutdown()` | `Promise<void>` | Tear down |
| `colyseus.cleanup()` | `Promise<void>` | Dispose all rooms (between tests) |
| `colyseus.createRoom(name, options)` | Backend `Room` | Create a room (no client) |
| `colyseus.connectTo(room)` | Client `Room` (SDK) | Simulated client |
| `colyseus.http.get/post/patch/put/delete(url, opts)` | HTTP response | Test express routes |

### Server-side `room.waitFor*`

```typescript
await room.waitForNextPatch();               // wait for next state sync
await room.waitForNextSimulationTick();      // wait for next game tick
await room.waitForMessage("foo");            // returns [client, message]
await room.waitForNextMessage(delay?);       // any next message
```

### Client-side (on the `Room` returned by `connectTo`)

```typescript
const client = await colyseus.connectTo(room);
client.onMessage("error", (e) => { ... });
client.onMessage("matchEnd", (m) => { ... });
client.send("deployCard", { ... });
client.waitForMessage("matchEnd");           // also available on client
client.waitForNextPatch();
```

### HTTP testing

```typescript
const response = await colyseus.http.get("/");
assert.deepStrictEqual({ success: true }, response.data);
assert.strictEqual("expected", response.headers["x-foo"]);
```

### The (now-deleted) `test/BattleRoom.test.ts` had this pattern

We removed this file per project decision (user wanted to start fresh after
Colyseus doc study). Pattern reference:

```typescript
// 9 tests covering anti-cheat + lifecycle
// - rejects bad coords (Zod)
// - rejects unknown cardId
// - rejects insufficient elixir
// - rejects wrong-side deploy
// - rejects NaN coordinates
// - accepts valid deployCard
// - surrender ends match + broadcasts
// - rejects deploy in non-playing state
// - tracks both players with correct teams
```

---

## 10. Built-in `QueueRoom` (vs our `BattleQueueRoom`)

Colyseus 0.17 ships a built-in `QueueRoom` for matchmaking. We hand-rolled
`BattleQueueRoom` instead. Here's why + the trade-offs.

### Built-in QueueRoom config

```typescript
import { defineServer, defineRoom, QueueRoom } from "colyseus";

const server = defineServer({
  rooms: {
    queue: defineRoom(QueueRoom, {
      matchRoomName: "battle",                  // which room to create on group ready
      maxPlayers: 4,                            // group size
      maxWaitingCycles: 15,                     // cycles before incomplete group ready
      maxWaitingCyclesForPriority: 10,          // cycles before high-priority bypass
      maxTeamSize: 2,                           // team-based grouping
      allowIncompleteGroups: false,             // require full group
      compare: (client, group) => boolean,      // custom compatibility
      onGroupReady: async (group) => { ... },  // custom room creation
    }),
  },
});
```

### Client-side (built-in)

```typescript
const queue = await client.joinOrCreate("queue", { rank: 1200, teamId: "party-42" });

queue.onMessage("clients", (count) => {
  // server periodically notifies client of group size
});

queue.onMessage("seat", async (reservation) => {
  queue.send("confirm");                          // ack
  const match = await client.consumeSeatReservation(reservation);
});
```

### Our hand-rolled `BattleQueueRoom` features

| Feature | Built-in | Ours |
|---------|----------|------|
| Group players | ✅ | ✅ (slice first 2) |
| Custom compatibility (`compare`) | ✅ | ❌ (just FIFO) |
| Team-based grouping | ✅ | ❌ |
| Incomplete groups + bot fill | ✅ | ❌ |
| Per-client handoff timeout | ❌ | ✅ (5s `matchAccepted` ack) |
| Per-client in-flight tracking | ❌ | ✅ (`handoffs` Map) |
| Race-safe atomic pairing | ❌ (relies on built-in cycle) | ⚠️ partial (we slice before async) |
| Direct matchFound payload control | ❌ | ✅ |

### Trade-off summary

- **Built-in is better** for typical matchmaking (rank-based, team parties, bot fallback).
- **Our custom is better** for tight handoff control (the `matchAccepted` ack pattern)
  and explicit race-handling.
- **Migration path:** if we add rank-based matching later, we should consider migrating
  to built-in. For now (2-player 1v1 FIFO), the custom room is fine.

---

## 11. 0.17 Migration Notes

Top changes from 0.16 → 0.17 (per official migration guide):

### 1. New `app.config.ts` structure

```typescript
// 0.16 and earlier
import { Server, RedisPresence } from "colyseus";
const server = new Server({ /* ... */ });

// 0.17+
import { defineServer, defineRoom } from "colyseus";
const server = defineServer({
  rooms: { battle: defineRoom(BattleRoom) },
  express: (app) => { /* routes */ },
});
```

✅ We're on 0.17. `app.config.ts` uses `defineServer` + `defineRoom`.

### 2. `Room` generic shape changed

```typescript
// 0.16 and earlier
class BattleRoom extends Room<MyState> {
  state = new MyState();
}

// 0.17+
class BattleRoom extends Room<{ state: BattleState }> {
  state = new BattleState();
}
```

✅ Our `BattleRoom` is correctly typed.

### 3. `Client` generic shape changed

```typescript
// 0.17+
const client = new Client<{ userData: U, auth: A, messages: M }>("ws://...");
```

Will affect frontend integration when we get there.

### 4. `onMessage` now supports multiple handlers

```typescript
// 0.16: re-registering replaced the old handler
// 0.17: all handlers run; use unbind() to replace
```

### 5. `Protocol.WS_*` → `CloseCode`

```typescript
// 0.16 and earlier
import { Protocol } from "colyseus";
if (code === Protocol.WS_CLOSE_CONSENTED) { ... }

// 0.17+
import { CloseCode } from "colyseus";
if (code === CloseCode.CONSENTED) { ... }
```

✅ Our `BattleRoom.ts` imports `CloseCode` from `"colyseus"`.

> **Reserved close codes:** Colyseus now uses 4000-4010 internally. Avoid using
> those ranges for custom close codes. Use 4001-4999 for custom purposes (per docs).

---

## 12. Best Practices

> Per official Colyseus docs (`/best-practices`).

### Schema
- **Keep Schema structures small** — only field definitions, not heavy methods.
- **Avoid heavy game logic inside Schema** — some self-contained logic is OK
  (mutations of own fields), but no physics, no AI, no DB calls.
- **Use the smallest integer type that fits** — `uint8` for team id, not `uint32`.
- **64-field max per Schema** — partition into nested Schemas if you exceed.

### Room
- **Keep Room classes small** — delegate to composable structures.
- **Forward actions to external structures** — don't put all logic in the room.

### Patterns

#### Command Pattern (`@colyseus/command`)

Decouples message handler from execution. Useful when game logic needs to be
**sequenced, queueable, reversible, or testable in isolation**.

```bash
npm install @colyseus/command
```

```typescript
import { Room } from "colyseus";
import { Dispatcher } from "@colyseus/command";

class BattleRoom extends Room {
  dispatcher = new Dispatcher(this);

  onJoin(client, options) {
    this.dispatcher.dispatch(new OnJoinCommand(), { sessionId: client.sessionId });
  }

  onDispose() {
    this.dispatcher.stop();
  }
}

class OnJoinCommand extends Command<BattleRoom, { sessionId: string }> {
  execute({ sessionId }) {
    this.state.players.set(sessionId, new Player());
  }
}
```

> **Should we use this?** Probably yes, if game logic grows. Right now our
> `BattleRoom` is small enough that direct handlers are fine. **Don't over-engineer.**
> Re-evaluate when adding the third or fourth `messages` handler.

#### Entity-Component System (ECS)

Available via 3rd party packages. Useful for games with many entity types sharing
components. Not needed for our 2-tower + unit-list design.

#### External logic modules

For specialized logic, factor out into plain functions or classes outside the
Room. The room just dispatches calls.

> **General principle:** "Keep your codebase healthy and readable by delegating
> functionality to composable structures rather than concentrating logic in rooms
> or Schema classes." (Colyseus docs)

---

## 13. What We DON'T Use (and Why)

| Feature | What it does | Why we skip |
|---------|--------------|-------------|
| **`LobbyRoom`** | Built-in room that lists all public rooms | We hand-rolled `BattleQueueRoom`; lobby can be added later for room browser |
| **`RelayRoom`** | Built-in room that pipes messages between two specific rooms | Not needed; matchmaking → battle handoff is direct |
| **`@view()` / `StateView`** | Per-client state filtering (private fields, area-based data) | All our state is fully visible to both players (no fog of war yet) |
| **`BroadcastOperator` extras** (`except`, `afterNextPatch`) | Per-client broadcasts, deferred events | All our broadcasts are global; if we add fog of war or per-team events, will use |
| **`@colyseus/command` (Command pattern)** | Decouples message handler from execution | Room is small (3 handlers) — direct handlers are clearer |
| **`uWebSockets.js` transport** | Higher-perf WebSocket | Default `ws` transport is fine for 1v1 at our scale |
| **`WebTransport`** | HTTP/3-based transport | Browser support limited; revisit in 1-2 years |
| **`Bun` transport** | Bun runtime WebSocket | We standardize on Node 26 |
| **Redis presence** | Cross-process state sharing | We're single-process; revisit if we horizontally scale |
| **Custom matchmaker driver** | Postgres, MongoDB driver for matchmaker | Default in-memory matchmaker works for 1 process |
| **HTTP middleware auth (`/auth/http`)** | Token validation on HTTP routes | Our HTTP routes are just `/monitor` and `/` (playground) — no auth needed |
| **Auth module (`@colyseus/auth`)** | Built-in JWT helpers | We use `@privy-io/server-auth` directly for Privy integration |

### What we MAY add later

| Feature | Trigger to add |
|---------|----------------|
| `LobbyRoom` | Public room browser (after launching PvE/co-op modes) |
| `StateView` | Fog of war, hidden opponent HP until revealed |
| `BroadcastOperator.except` | Hide own-card-plays from self (show only opponents') |
| `BroadcastOperator.afterNextPatch` | Strict event-ordering: "card arrived" after "HP updated" |
| Command pattern | When game logic exceeds ~5 message handlers |
| Redis presence | When scaling to >1 process |
| uWebSockets.js | When we hit 100+ concurrent rooms per process |
| Custom matchmaker driver | When we need cross-process matchmaking state |

---

## Quick Reference Card

### Lifecycle (one-liner each)

```
onAuth       — gate connection (verify token)
onCreate     — init state, arm timers
onJoin       — add player to state
onMessage    — handle typed messages (use validate(Zod, ...))
onDrop       — abnormal disconnect → allowReconnection()
onReconnect  — restore player.connected = true
onLeave      — permanent leave → cleanup, end match if needed
onDispose    — clear intervals/timeouts (auto-cleared too, but defensive)
```

### Anti-cheat checklist

- [x] Zod-validate all incoming messages
- [x] Server-authoritative elixir (deduct on server, not trust client)
- [x] Server-authoritative win condition
- [x] Server-authoritative DPS (clients can't lie about damage)
- [ ] Server-authoritative unit position (currently trust `x`/`z` from client)
- [ ] Server-authoritative target selection (currently `Math.random()`)
- [ ] Rate limiting per client (`maxMessagesPerSecond` is 30)

### File map

```
src/
  index.ts                      # @colyseus/tools listen(2567)
  app.config.ts                 # defineServer + room registry
  rooms/
    BattleRoom.ts               # 1v1 authoritative
    BattleQueueRoom.ts          # matchmaking + handoff
    schema/
      BattleState.ts            # BattleState, Player, Tower, DeployedUnit

test/                           # (currently empty — TBD after Colyseus study)

package.json                    # colyseus 0.17.6, @colyseus/schema 4.0.0
```

### Live deployment

- **URL:** `http://34.67.151.45:2567`
- **Process manager:** PM2 (`clash-realtime`)
- **Build:** `npm run build` → `build/index.js`
- **Deploy:** `bash deploy.sh` from Google Cloud Shell
- **Auth mode:** Production = Privy JWT; Dev = `ALLOW_ANON_USERS=true`

---

*End of reference. For questions, additions, or corrections, see the upstream docs at
[docs.colyseus.io](https://docs.colyseus.io).*
