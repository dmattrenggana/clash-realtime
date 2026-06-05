import {
    defineServer,
    defineRoom,
    monitor,
    playground,
} from "colyseus";

/**
 * Import your Room files
 */
import { BattleRoom } from "./rooms/BattleRoom.js";
import { BattleQueueRoom } from "./rooms/BattleQueueRoom.js";

const server = defineServer({
    /**
     * Define your room handlers:
     *
     * - battle_queue: pre-game matchmaking (pairs players into a fresh battle)
     * - battle:       the actual game room (server-authoritative 1v1)
     */
    rooms: {
        battle_queue: defineRoom(BattleQueueRoom),
        battle: defineRoom(BattleRoom),
    },

    /**
     * Bind your custom express routes here:
     * Read more: https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {
        /**
         * Use @colyseus/monitor
         * It is recommended to protect this route with a password
         * Read more: https://docs.colyseus.io/tools/monitoring/#restrict-access-to-the-panel-using-a-password
         */
        app.use("/monitor", monitor());

        /**
         * Use @colyseus/playground
         * (It is not recommended to expose this route in a production environment)
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;