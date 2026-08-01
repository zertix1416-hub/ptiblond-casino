const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const fs       = require("fs");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

// ═══════════════════════════════════════
//  GLOBAL IO (used by bot.js)
// ═══════════════════════════════════════
global.io = io;

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
function loadJSON(file) {
    // Sur Render, les fichiers dans /tmp persistent pendant la session
    const renderPath = file.replace('./', '/tmp/');
    const paths = [file, renderPath];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, "utf8")); }
            catch { continue; }
        }
    }
    return {};
}
function saveJSON(file, data) {
    // Sauvegarde dans les deux endroits
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
    try {
        const renderPath = file.replace('./', '/tmp/');
        fs.writeFileSync(renderPath, JSON.stringify(data, null, 2));
    } catch {}
}

// ═══════════════════════════════════════
//  STATIC FILES
// ═══════════════════════════════════════
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ═══════════════════════════════════════
//  SESSION STORE  (web players by socketId / name)
// ═══════════════════════════════════════
const webSessions = {};   // socketId → { name, balance, socketId }
const webJackpot  = { slots: 10000 };

// ═══════════════════════════════════════
//  REST API
// ═══════════════════════════════════════

// --- Economy snapshot (for Discord bot stats) ---
app.get("/api/economy", (_req, res) => {
    res.json(loadJSON("./economy.json"));
});

app.get("/api/stats", (_req, res) => {
    const eco     = loadJSON("./economy.json");
    const players = Object.values(eco);
    res.json({
        totalPlayers : players.length,
        totalGames   : players.reduce((a, p) => a + (p.games   || 0), 0),
        totalWins    : players.reduce((a, p) => a + (p.wins    || 0), 0),
        totalJackpots: players.reduce((a, p) => a + (p.jackpots|| 0), 0),
        richest      : players.reduce((a, p) => Math.max(a, p.money || 0), 0)
    });
});

app.get("/api/leaderboard", (_req, res) => {
    const eco = loadJSON("./economy.json");
    const top = Object.entries(eco)
        .map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => b.money - a.money)
        .slice(0, 10);
    res.json(top);
});

// --- Web leaderboard (web sessions, real names) ---
app.get("/api/web-leaderboard", (_req, res) => {
    const list = Object.values(webSessions)
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10)
        .map(s => ({ name: s.name, balance: s.balance }));
    res.json(list);
});

// --- Jackpot value ---
app.get("/api/jackpot", (_req, res) => res.json(webJackpot));

// --- Discord balance sync : GET /api/discord-balance/:discordId ---
app.get("/api/discord-balance/:id", (req, res) => {
    const eco = loadJSON("./economy.json");
    const user = eco[req.params.id];
    if (!user) return res.json({ found: false, balance: 1000 });
    res.json({ found: true, balance: user.money, wins: user.wins, losses: user.losses,
        games: user.games, winstreak: user.winstreak, jackpots: user.jackpots });
});

// --- Web → Discord balance update : POST /api/sync-balance ---
app.post("/api/sync-balance", (req, res) => {
    const { discordId, balance } = req.body;
    if (!discordId || typeof balance !== "number") return res.status(400).json({ error: "Missing fields" });
    const eco = loadJSON("./economy.json");
    if (!eco[discordId]) return res.status(404).json({ error: "User not found" });
    eco[discordId].money = Math.max(0, Math.floor(balance));
    saveJSON("./economy.json", eco);
    if (global.io) global.io.emit("economy_update", eco);
    res.json({ ok: true, balance: eco[discordId].money });
});

// --- Live Discord activity feed ---
app.get("/api/live-feed", (_req, res) => {
    res.json(global.liveFeed || []);
});

// ═══════════════════════════════════════
//  ADMIN API  (protégé par mot de passe)
// ═══════════════════════════════════════
const ADMIN_PASSWORD = "zizi";
const bannedUsers = loadJSON("./banned.json") || {};

function adminAuth(req, res, next) {
    const pwd = req.headers["x-admin-password"] || req.query.pwd;
    if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: "Non autorisé" });
    next();
}

// Liste tous les joueurs
app.get("/api/admin/users", adminAuth, (_req, res) => {
    const eco = loadJSON("./economy.json");
    const users = Object.entries(eco).map(([id, d]) => ({
        id, ...d,
        banned: !!bannedUsers[id]
    })).sort((a, b) => b.money - a.money);
    res.json(users);
});

// Modifier la balance
app.post("/api/admin/balance", adminAuth, (req, res) => {
    const { userId, amount, action } = req.body;
    const eco = loadJSON("./economy.json");
    if (!eco[userId]) {
        // Créer l'utilisateur s'il n'existe pas
        eco[userId] = { money: 1000, bank: 0, wins: 0, losses: 0, games: 0, winstreak: 0, bestWinstreak: 0, jackpots: 0 };
    }
    if (action === "set")    eco[userId].money = Math.max(0, Number(amount));
    if (action === "add")    eco[userId].money = Math.max(0, eco[userId].money + Number(amount));
    if (action === "remove") eco[userId].money = Math.max(0, eco[userId].money - Number(amount));
    saveJSON("./economy.json", eco);
    const newBalance = eco[userId].money;
    // Notifier tous les clients web connectés avec cet ID
    if (global.io) {
        global.io.emit("economy_update", eco);
        global.io.emit("admin_balance_update", { userId, newBalance });
    }
    res.json({ ok: true, newBalance });
});

// Bannir / débannir
app.post("/api/admin/ban", adminAuth, (req, res) => {
    const { userId, action } = req.body;
    if (action === "ban")   bannedUsers[userId] = { ts: Date.now() };
    if (action === "unban") delete bannedUsers[userId];
    saveJSON("./banned.json", bannedUsers);
    if (global.io) global.io.emit("ban_update", { userId, action });
    res.json({ ok: true });
});

// Reset un joueur
app.post("/api/admin/reset", adminAuth, (req, res) => {
    const { userId } = req.body;
    const eco = loadJSON("./economy.json");
    if (!eco[userId]) return res.status(404).json({ error: "User introuvable" });
    eco[userId] = { money: 1000, bank: 0, wins: 0, losses: 0, games: 0, winstreak: 0, bestWinstreak: 0, jackpots: 0 };
    saveJSON("./economy.json", eco);
    res.json({ ok: true });
});

// NUKE — reset total de tout le monde
app.post("/api/admin/nuke", adminAuth, (req, res) => {
    const { confirm } = req.body;
    if (confirm !== "PTIBLOND_NUKE") return res.status(400).json({ error: "Confirmation requise" });
    saveJSON("./economy.json", {});
    saveJSON("./banned.json", {});
    if (global.io) {
        global.io.emit("nuke", { ts: Date.now() });
        global.io.emit("economy_update", {});
    }
    res.json({ ok: true, message: "NUKE effectué — tout est détruit 💥" });
});

// Stats globales admin
app.get("/api/admin/stats", adminAuth, (_req, res) => {
    const eco = loadJSON("./economy.json");
    const players = Object.values(eco);
    const totalMoney = players.reduce((a, p) => a + (p.money || 0), 0);
    res.json({
        totalPlayers: players.length,
        totalMoney,
        totalGames: players.reduce((a, p) => a + (p.games || 0), 0),
        totalWins: players.reduce((a, p) => a + (p.wins || 0), 0),
        totalJackpots: players.reduce((a, p) => a + (p.jackpots || 0), 0),
        bannedCount: Object.keys(bannedUsers).length,
        richest: players.sort((a, b) => b.money - a.money)[0]?.money || 0
    });
});

global.liveFeed = [];
function pushLiveFeed(event) {
    global.liveFeed.unshift({ ...event, ts: Date.now() });
    if (global.liveFeed.length > 50) global.liveFeed.pop();
    io.emit("live_event", event);
}
global.pushLiveFeed = pushLiveFeed;

// ═══════════════════════════════════════
//  SOCKET.IO  — Web Client Events
// ═══════════════════════════════════════
io.on("connection", socket => {
    console.log(`🌐 Client connecté : ${socket.id}`);

    // ── Identify (called once when page loads) ──
    socket.on("identify", ({ name, balance }) => {
        webSessions[socket.id] = {
            socketId: socket.id,
            name    : name  || "Invité",
            balance : typeof balance === "number" ? balance : 1000,
            game    : null
        };
        // Send current jackpot
        socket.emit("jackpot_update", webJackpot);
        // Broadcast updated online count
        io.emit("online_count", Object.keys(webSessions).length);
        console.log(`👤 ${name} connecté (${balance} crédits)`);
    });

    // ── Balance sync (client → server) ──
    socket.on("balance_sync", ({ balance }) => {
        if (webSessions[socket.id]) {
            webSessions[socket.id].balance = balance;
            // Live leaderboard push
            io.emit("web_leaderboard", buildWebLeaderboard());
        }
    });

    // ── Game events (client → server → broadcast) ──
    socket.on("game_event", event => {
        const session = webSessions[socket.id];
        if (!session) return;

        const enriched = { ...event, player: session.name, ts: Date.now() };

        // Jackpot contribution for slots
        if (event.type === "slots_spin") {
            const contrib = Math.floor((event.bet || 0) * 0.05);
            webJackpot.slots = Math.max(webJackpot.slots + contrib, 10000);
            io.emit("jackpot_update", webJackpot);
        }

        // Jackpot win resets it
        if (event.type === "slots_jackpot") {
            enriched.jackpotAmount = webJackpot.slots;
            webJackpot.slots = 10000;
            io.emit("jackpot_update", webJackpot);
        }

        // Broadcast to all (for live feed on index.html)
        io.emit("live_event", enriched);
    });

    // ── Blackjack table events (join / deal / hit / stand) ──
    socket.on("bj_join", ({ tableId }) => {
        socket.join("bj_" + tableId);
        if (webSessions[socket.id]) webSessions[socket.id].game = "blackjack";
    });
    socket.on("bj_action", data => {
        // Relay to all players on same BJ table
        socket.to("bj_" + data.tableId).emit("bj_action", {
            ...data, player: webSessions[socket.id]?.name
        });
    });

    // ── Roulette room (shared wheel) ──
    socket.on("roulette_join", () => {
        socket.join("roulette");
        if (webSessions[socket.id]) webSessions[socket.id].game = "roulette";
    });
    socket.on("roulette_spin", data => {
        // Broadcast the same result to everyone in roulette room
        io.to("roulette").emit("roulette_result", data);
    });

    // ── Chat / emote ──
    socket.on("emote", ({ emote }) => {
        const name = webSessions[socket.id]?.name || "?";
        io.emit("emote", { name, emote, ts: Date.now() });
    });

    // ── Disconnect ──
    socket.on("disconnect", () => {
        const session = webSessions[socket.id];
        if (session) {
            console.log(`❌ ${session.name} déconnecté`);
            delete webSessions[socket.id];
            io.emit("online_count", Object.keys(webSessions).length);
            io.emit("web_leaderboard", buildWebLeaderboard());
        }
    });
});

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
function buildWebLeaderboard() {
    return Object.values(webSessions)
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10)
        .map(s => ({ name: s.name, balance: s.balance, game: s.game }));
}

// Jackpot passive growth every 30s
setInterval(() => {
    webJackpot.slots += 50;
    io.emit("jackpot_update", webJackpot);
}, 30_000);

// ═══════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
  🎰  CASINO ROYALE  —  DASHBOARD 3D
  🌐  http://localhost:${PORT}
  📡  Socket.IO actif
╚══════════════════════════════════════╝
`);
});

// ═══════════════════════════════════════
//  LOAD DISCORD BOT
// ═══════════════════════════════════════
require("./bot.js");
