const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const fs       = require("fs");
const { MongoClient } = require("mongodb");
const fetch = globalThis.fetch || require("node-fetch");

// ═══════════════════════════════════════
//  MONGODB
// ═══════════════════════════════════════
const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://zertix1416_db_user:VCe8Ua9hQJm08FGA@cluster0.l3wo0a1.mongodb.net/?appName=Cluster0";
let db = null;
let playersCol = null;

async function connectMongo() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db("casino");
        playersCol = db.collection("players");
        console.log("✅ MongoDB connecté");
    } catch(e) {
        console.error("❌ MongoDB erreur:", e.message);
    }
}

async function getPlayer(id) {
    if (!playersCol) return null;
    return await playersCol.findOne({ _id: id });
}

async function savePlayer(id, data) {
    if (!playersCol) return;
    await playersCol.updateOne({ _id: id }, { $set: data }, { upsert: true });
}

async function getAllPlayers() {
    if (!playersCol) return [];
    return await playersCol.find({}).toArray();
}

connectMongo();

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
    const tmpPath = '/tmp/' + path.basename(file);
    for (const p of [tmpPath, file]) {
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, "utf8")); }
            catch { continue; }
        }
    }
    return {};
}
function saveJSON(file, data) {
    const str = JSON.stringify(data, null, 2);
    try { fs.writeFileSync('/tmp/' + path.basename(file), str); } catch {}
    try { fs.writeFileSync(file, str); } catch {}
}

// ═══════════════════════════════════════
//  DISCORD OAUTH
// ═══════════════════════════════════════
const DISCORD_CLIENT_ID     = "1532770688451219547";
const DISCORD_CLIENT_SECRET = "z-AFoDautOT_SWlK8WhR7yBPWalsokhy";
const DISCORD_REDIRECT      = process.env.DISCORD_REDIRECT || "https://ptiblond-casino.onrender.com/auth/callback";
const sessions = {}; // token → { id, username, avatar, discriminator }

// Step 1 — redirige vers Discord
app.get("/auth/discord", (_req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT)}&response_type=code&scope=identify`;
    res.redirect(url);
});

// Step 2 — Discord revient ici avec le code
app.get("/auth/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect("/?error=no_code");
    try {
        // Échange le code contre un token
        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id:     DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type:    "authorization_code",
                code,
                redirect_uri:  DISCORD_REDIRECT
            })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return res.redirect("/?error=token_fail");

        // Récupère l'utilisateur
        const userRes = await fetch("https://discord.com/api/users/@me", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();

        // Crée la session
        const sessionToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessions[sessionToken] = {
            id:            user.id,
            username:      user.username,
            discriminator: user.discriminator || "0",
            avatar:        user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/0.png`
        };

        // Crée le joueur dans MongoDB si pas existant — UNE SEULE FOIS
        const existing = await getPlayer(user.id);
        if (!existing) {
            await savePlayer(user.id, {
                _id: user.id,
                username: user.username,
                money: 1000, bank: 0, wins: 0, losses: 0,
                games: 0, winstreak: 0, bestWinstreak: 0, jackpots: 0
            });
        }
        // Redirige vers l'index avec le token en cookie via URL
        res.redirect(`/?session=${sessionToken}`);
    } catch (e) {
        console.error("OAuth error:", e);
        res.redirect("/?error=oauth_fail");
    }
});

// Récupère l'utilisateur connecté — balance depuis economy partagé avec le bot
app.get("/auth/me", async (req, res) => {
    const token = req.query.token || req.headers["x-session-token"];
    if (!token || !sessions[token]) return res.status(401).json({ error: "Non connecté" });
    const user = sessions[token];
    const eco = getEconomy();
    if (!eco[user.id]) {
        eco[user.id] = { money: 1000, bank: 0, wins: 0, losses: 0, games: 0, winstreak: 0, bestWinstreak: 0, jackpots: 0 };
        saveEconomyShared();
    }
    res.json({ ...user, balance: eco[user.id].money, stats: eco[user.id] });
});

// Déconnexion
app.get("/auth/logout", (req, res) => {
    const token = req.query.token;
    if (token) delete sessions[token];
    res.redirect("/");
});

// ═══════════════════════════════════════
//  SHARED ECONOMY depuis bot.js
// ═══════════════════════════════════════
// On importe l'economy du bot — même objet en mémoire
let botModule = null;
function getEconomy() {
    if (!botModule) {
        try { botModule = require("./bot.js"); } catch(e) {}
    }
    return botModule ? botModule.economy : {};
}
function saveEconomyShared() {
    const eco = getEconomy();
    try { require("fs").writeFileSync("./economy.json", JSON.stringify(eco, null, 2)); } catch(e) {}
    if (global.io) global.io.emit("economy_update", eco);
    // Sync MongoDB
    if (playersCol) {
        Object.entries(eco).forEach(([id, data]) => {
            playersCol.updateOne({ _id: id }, { $set: { ...data, _id: id } }, { upsert: true }).catch(() => {});
        });
    }
}
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

// Sauvegarde balance depuis le web — écrit dans economy partagé
app.post("/api/save-balance", (req, res) => {
    const { balance } = req.body;
    const token = req.headers["x-session-token"];
    if (!token || !sessions[token]) return res.status(401).json({ error: "Non connecté" });
    const user = sessions[token];
    if (typeof balance !== "number" || balance < 0) return res.status(400).json({ error: "Balance invalide" });
    const eco = getEconomy();
    if (!eco[user.id]) eco[user.id] = { money: 1000, bank: 0, wins: 0, losses: 0, games: 0, winstreak: 0, bestWinstreak: 0, jackpots: 0 };
    eco[user.id].money = Math.floor(balance);
    saveEconomyShared();
    res.json({ ok: true, balance: eco[user.id].money });
});
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
app.get("/api/admin/users", adminAuth, async (_req, res) => {
    const eco = getEconomy();
    const banned = loadJSON("./banned.json");
    const users = Object.entries(eco).map(([id, d]) => ({
        id, money: d.money||0, wins: d.wins||0, losses: d.losses||0,
        games: d.games||0, winstreak: d.winstreak||0, jackpots: d.jackpots||0,
        banned: !!banned[id]
    })).sort((a, b) => b.money - a.money);
    res.json(users);
});

// Modifier la balance
app.post("/api/admin/balance", adminAuth, async (req, res) => {
    const { userId, amount, action } = req.body;
    const eco = getEconomy();
    if (!eco[userId]) eco[userId] = { money: 1000, bank:0, wins:0, losses:0, games:0, winstreak:0, bestWinstreak:0, jackpots:0 };
    if (action === "set")    eco[userId].money = Math.max(0, Number(amount));
    if (action === "add")    eco[userId].money = Math.max(0, eco[userId].money + Number(amount));
    if (action === "remove") eco[userId].money = Math.max(0, eco[userId].money - Number(amount));
    saveEconomyShared();
    if (global.io) global.io.emit("admin_balance_update", { userId, newBalance: eco[userId].money });
    res.json({ ok: true, newBalance: eco[userId].money });
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
app.post("/api/admin/reset", adminAuth, async (req, res) => {
    const { userId } = req.body;
    const eco = getEconomy();
    eco[userId] = { money: 1000, bank:0, wins:0, losses:0, games:0, winstreak:0, bestWinstreak:0, jackpots:0 };
    saveEconomyShared();
    res.json({ ok: true });
});

// NUKE
app.post("/api/admin/nuke", adminAuth, async (req, res) => {
    const { confirm } = req.body;
    if (confirm !== "PTIBLOND_NUKE") return res.status(400).json({ error: "Confirmation requise" });
    const eco = getEconomy();
    Object.keys(eco).forEach(k => delete eco[k]);
    saveEconomyShared();
    saveJSON("./banned.json", {});
    if (global.io) global.io.emit("nuke", { ts: Date.now() });
    res.json({ ok: true, message: "NUKE effectué 💥" });
});

// Stats globales admin
app.get("/api/admin/stats", adminAuth, async (_req, res) => {
    const eco = getEconomy();
    const players = Object.values(eco);
    const banned = loadJSON("./banned.json");
    res.json({
        totalPlayers:  players.length,
        totalMoney:    players.reduce((a,p)=>a+(p.money||0),0),
        totalGames:    players.reduce((a,p)=>a+(p.games||0),0),
        totalWins:     players.reduce((a,p)=>a+(p.wins||0),0),
        totalJackpots: players.reduce((a,p)=>a+(p.jackpots||0),0),
        bannedCount:   Object.keys(banned).length,
        richest:       players.reduce((a,p)=>Math.max(a,p.money||0),0)
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
//  GIVEAWAY API
// ═══════════════════════════════════════
let giveaways = {};

app.post("/api/giveaway/create", adminAuth, (req, res) => {
    const { title, description, prize, duration, maxEntries } = req.body;
    if (!title || !prize) return res.status(400).json({ error: "titre et prix requis" });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    giveaways[id] = {
        id, title, description: description||"", prize,
        endsAt: Date.now() + (parseInt(duration)||3600)*1000,
        maxEntries: parseInt(maxEntries)||0,
        entries: [], winner: null, active: true, createdAt: Date.now()
    };
    if (global.io) global.io.emit("giveaway_new", giveaways[id]);
    res.json({ ok: true, giveaway: giveaways[id] });
});

app.get("/api/giveaway/list", (_req, res) => {
    const list = Object.values(giveaways)
        .sort((a,b) => b.createdAt - a.createdAt)
        .map(g => ({ ...g, entriesCount: g.entries.length,
            timeLeft: Math.max(0, g.endsAt - Date.now()),
            active: g.active && Date.now() < g.endsAt }));
    res.json(list);
});

app.post("/api/giveaway/enter", (req, res) => {
    const { giveawayId } = req.body;
    const token = req.headers["x-session-token"];
    if (!token || !sessions[token]) return res.status(401).json({ error: "Connecte-toi avec Discord" });
    const user = sessions[token];
    const g = giveaways[giveawayId];
    if (!g) return res.status(404).json({ error: "Giveaway introuvable" });
    if (!g.active || Date.now() > g.endsAt) return res.status(400).json({ error: "Giveaway termine" });
    if (g.entries.find(e => e.id === user.id)) return res.status(400).json({ error: "Tu participes deja !" });
    if (g.maxEntries > 0 && g.entries.length >= g.maxEntries) return res.status(400).json({ error: "Complet" });
    g.entries.push({ id: user.id, username: user.username, avatar: user.avatar, enteredAt: Date.now() });
    if (global.io) global.io.emit("giveaway_update", { id: giveawayId, entriesCount: g.entries.length });
    res.json({ ok: true, entriesCount: g.entries.length });
});

app.post("/api/giveaway/draw", adminAuth, (req, res) => {
    const { giveawayId } = req.body;
    const g = giveaways[giveawayId];
    if (!g) return res.status(404).json({ error: "Introuvable" });
    if (!g.entries.length) return res.status(400).json({ error: "Aucun participant" });
    const winner = g.entries[Math.floor(Math.random() * g.entries.length)];
    g.winner = winner; g.active = false;
    const prizeNum = parseInt(g.prize);
    if (!isNaN(prizeNum) && prizeNum > 0) {
        const eco = getEconomy();
        if (!eco[winner.id]) eco[winner.id] = { money:1000, bank:0, wins:0, losses:0, games:0, winstreak:0, bestWinstreak:0, jackpots:0 };
        eco[winner.id].money += prizeNum;
        saveEconomyShared();
    }
    if (global.io) global.io.emit("giveaway_winner", { id: giveawayId, winner });
    res.json({ ok: true, winner });
});

app.delete("/api/giveaway/:id", adminAuth, (_req, res) => {
    delete giveaways[_req.params.id];
    res.json({ ok: true });
});


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
