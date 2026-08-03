const {
    Client,
    GatewayIntentBits,
    EmbedBuilder
} = require("discord.js");
const fs = require("fs");
const { MongoClient } = require("mongodb");

// ================= CONFIG =================
const TOKEN = process.env.DISCORD_TOKEN || "MTUzMjc3MDY4ODQ1MTIxOTU0Nw.GfRxDD.67k-XKD6WwfNhCmdYUKXdp3tnSSasJlg1qcacA";
const OWNER_ID = "866234808328519730";
const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://zertix1416_db_user:VCe8Ua9hQJm08FGA@cluster0.l3wo0a1.mongodb.net/?appName=Cluster0";

// ================= MONGODB =================
let playersCol = null;
(async () => {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        playersCol = client.db("casino").collection("players");
        console.log("✅ Bot MongoDB connecté");
    } catch(e) {
        console.error("❌ Bot MongoDB erreur:", e.message);
    }
})();

async function getEco(id) {
    if (playersCol) {
        const p = await playersCol.findOne({ _id: id });
        if (p) return p;
    }
    // Fallback economy.json
    const eco = loadJSON("./economy.json");
    return eco[id] || null;
}

async function setEco(id, data) {
    if (playersCol) {
        await playersCol.updateOne({ _id: id }, { $set: data }, { upsert: true });
    }
    // Aussi dans economy.json pour le fallback
    const eco = loadJSON("./economy.json");
    eco[id] = { ...eco[id], ...data };
    saveEconomy();
}

// ================= CLIENT =================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ================= DATABASE =================
let economy = {};
let scammers = {};
let duels = {};
let blackjackTables = {};
let workCooldown = {};

// ================= FILES =================
function loadJSON(file) {
    if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file)); }
        catch { return {}; }
    }
    return {};
}

economy = loadJSON("./economy.json");
scammers = loadJSON("./scammers.json");

// ================= SAVE =================
function saveEconomy() {
    fs.writeFileSync("./economy.json", JSON.stringify(economy, null, 2));
    if (global.io) global.io.emit("economy_update", economy);
    // Sync vers MongoDB
    if (playersCol) {
        Object.entries(economy).forEach(([id, data]) => {
            playersCol.updateOne(
                { _id: id },
                { $set: { ...data, _id: id } },
                { upsert: true }
            ).catch(() => {});
        });
    }
}

function saveScammers() {
    fs.writeFileSync("./scammers.json", JSON.stringify(scammers, null, 2));
}

// Sync depuis MongoDB au démarrage — charge les vraies balances
async function syncFromMongo() {
    if (!playersCol) return;
    try {
        const players = await playersCol.find({}).toArray();
        players.forEach(p => {
            economy[p._id] = {
                money: p.money ?? 1000,
                bank: p.bank ?? 0,
                wins: p.wins ?? 0,
                losses: p.losses ?? 0,
                games: p.games ?? 0,
                winstreak: p.winstreak ?? 0,
                bestWinstreak: p.bestWinstreak ?? 0,
                jackpots: p.jackpots ?? 0
            };
        });
        try { fs.writeFileSync("./economy.json", JSON.stringify(economy, null, 2)); } catch(e) {}
        console.log("✅ " + players.length + " joueurs chargés depuis MongoDB");
    } catch(e) {
        console.error("Erreur sync MongoDB:", e.message);
    }
}

// Attendre que MongoDB soit connecté avant de sync (max 10 tentatives)
async function waitAndSync() {
    for (let i = 0; i < 10; i++) {
        if (playersCol) {
            await syncFromMongo();
            return;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.warn("⚠️ MongoDB pas dispo, economy reste vide");
}
waitAndSync();

// ================= USER =================
function createUser(id) {
    if (!economy[id]) {
        economy[id] = {
            money: 1000, bank: 0, wins: 0, losses: 0,
            games: 0, winstreak: 0, bestWinstreak: 0, jackpots: 0
        };
        saveEconomy();
        if (playersCol) {
            playersCol.updateOne({ _id: id }, { $setOnInsert: { _id: id, ...economy[id] } }, { upsert: true }).catch(() => {});
        }
    }
}

function addMoney(id, amount) {
    createUser(id);
    economy[id].money += amount;
    saveEconomy();
    if (playersCol) playersCol.updateOne({ _id: id }, { $set: { money: economy[id].money } }).catch(() => {});
}

function removeMoney(id, amount) {
    createUser(id);
    if (economy[id].money < amount) return false;
    economy[id].money -= amount;
    saveEconomy();
    if (playersCol) playersCol.updateOne({ _id: id }, { $set: { money: economy[id].money } }).catch(() => {});
    return true;
}

// ================= STATS =================
function winGame(id) {
    createUser(id);
    economy[id].wins++;
    economy[id].games++;
    economy[id].winstreak++;
    if (economy[id].winstreak > economy[id].bestWinstreak)
        economy[id].bestWinstreak = economy[id].winstreak;
    saveEconomy();
}

function loseGame(id) {
    createUser(id);
    economy[id].losses++;
    economy[id].games++;
    economy[id].winstreak = 0;
    saveEconomy();
}

// ================= EMBEDS =================
function premiumEmbed(title, description, color = "#FFD700") {
    return new EmbedBuilder()
        .setTitle(`👑 𝑪𝑨𝑺𝑰𝑵𝑶 𝑹𝑶𝒀𝑨𝑳𝑬\n${title}`)
        .setDescription(description)
        .setColor(color)
        .setFooter({ text: "🎰 Casino Royale V9 • Premium" })
        .setTimestamp();
}

// ================= CARDS =================
function drawCard() {
    return ["A","2","3","4","5","6","7","8","9","10","J","Q","K"][Math.floor(Math.random() * 13)];
}

function cardValue(card) {
    if (card === "J" || card === "Q" || card === "K") return 10;
    if (card === "A") return 11;
    return Number(card);
}

function handTotal(cards) {
    let total = 0, ace = 0;
    for (let card of cards) { total += cardValue(card); if (card === "A") ace++; }
    while (total > 21 && ace > 0) { total -= 10; ace--; }
    return total;
}

// ================= READY =================
client.once("ready", () => {
    console.log(`\n╔══════════════════════╗\n     🎰 CASINO ROYALE\n        ONLINE\n╚══════════════════════╝\n${client.user.tag}\n`);
    if (global.io) {
        global.io.emit("bot_ready", { tag: client.user.tag, avatar: client.user.displayAvatarURL() });
        global.io.emit("discord_status", { online: true, tag: client.user.tag });
    }
});

// ================= DUEL SYSTEM =================
async function startDuel(duel) {
    let msg = await duel.channel.send({
        embeds: [premiumEmbed("⚔️ DUEL ROYAL", `👑 ${duel.player1.name}\n🂠 🂠 🂠\n\n        VS\n\n👑 ${duel.player2.name}\n🂠 🂠 🂠\n\n⏳ Distribution des cartes...`)]
    });

    for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 2000));
        duel.player1.cards.push(drawCard());
        duel.player2.cards.push(drawCard());

        if (global.io) global.io.emit("duel_update", {
            player1: { name: duel.player1.name, cards: duel.player1.cards, total: handTotal(duel.player1.cards) },
            player2: { name: duel.player2.name, cards: duel.player2.cards, total: handTotal(duel.player2.cards) },
            step: i + 1
        });

        await msg.edit({
            embeds: [premiumEmbed(`⚔️ DUEL ROYAL • ${i+1}/3`,
                `👑 ${duel.player1.name}\n${duel.player1.cards.join(" | ")}\nTotal : **${handTotal(duel.player1.cards)}**\n\n⚔️ VS\n\n👑 ${duel.player2.name}\n${duel.player2.cards.join(" | ")}\nTotal : **${handTotal(duel.player2.cards)}**\n\n⏳ Carte suivante...`)]
        });
    }
    finishDuel(duel);
}

function finishDuel(duel) {
    let p1 = handTotal(duel.player1.cards);
    let p2 = handTotal(duel.player2.cards);
    let winner = null;
    if (p1 > p2) winner = duel.player1;
    if (p2 > p1) winner = duel.player2;

    let result = `👑 ${duel.player1.name}\n${duel.player1.cards.join(" | ")}\nTotal : ${p1}\n\n⚔️ ${duel.player2.name}\n${duel.player2.cards.join(" | ")}\nTotal : ${p2}\n\n━━━━━━━━━━━━━━\n`;

    if (!winner) {
        addMoney(duel.player1.id, duel.bet);
        addMoney(duel.player2.id, duel.bet);
        result += "🤝 ÉGALITÉ - Mises rendues";
    } else {
        addMoney(winner.id, duel.bet * 2);
        winGame(winner.id);
        result += `🏆 GAGNANT : ${winner.name}\n💰 Gain : ${duel.bet * 2} crédits\n🔥 Winstreak +1`;
    }

    if (global.io) global.io.emit("game_event", { type: "duel_end", winner: winner?.name || "ÉGALITÉ", bet: duel.bet });

    duel.channel.send({ embeds: [premiumEmbed("🏆 FIN DU DUEL", result, "Green")] });
    delete duels[duel.player2.id];
}

// ================= BLACKJACK =================
function dealerTurn(table) {
    while (handTotal(table.dealer) < 17) table.dealer.push(drawCard());
}

function endBlackjack(table) {
    dealerTurn(table);
    let dealerScore = handTotal(table.dealer);
    let text = `🎩 DEALER\n${table.dealer.join(" | ")}\nTotal : **${dealerScore}**\n\n━━━━━━━━━━━━━━\n`;

    for (let player of table.players) {
        let score = handTotal(player.cards);
        if (score > 21) { loseGame(player.id); text += `👤 ${player.name} 💀 Bust\n`; }
        else if (dealerScore > 21 || score > dealerScore) {
            let gain = player.bet * 2;
            addMoney(player.id, gain);
            winGame(player.id);
            text += `👤 ${player.name} 🏆 Victoire 💎 +${gain}\n`;
        } else if (score === dealerScore) {
            addMoney(player.id, player.bet);
            text += `👤 ${player.name} 🤝 Égalité\n`;
        } else { loseGame(player.id); text += `👤 ${player.name} 💀 Défaite\n`; }
    }

    if (global.io) global.io.emit("game_event", { type: "blackjack_end", dealer: dealerScore });
    if (global.pushLiveFeed) global.pushLiveFeed({
        type: "blackjack",
        dealer: dealerScore,
        players: table.players.map(p => ({ name: p.name, bet: p.bet }))
    });

    table.channel.send({ embeds: [premiumEmbed("🃏 BLACKJACK TERMINÉ", text, "Green")] });
}

// ================= ROULETTE =================
function rouletteGame(message, bet, color) {
    if (!removeMoney(message.author.id, bet)) return message.reply("❌ Solde insuffisant");

    let number = Math.floor(Math.random() * 37);
    let result;
    if (number === 0) result = "vert";
    else if (number % 2 === 0) result = "noir";
    else result = "rouge";

    let win = result === color;

    if (global.io) global.io.emit("game_event", {
        type: "roulette",
        number, result, win, bet,
        player: message.author.username
    });
    if (global.pushLiveFeed) global.pushLiveFeed({
        type: "roulette",
        player: message.author.username,
        number, color: result, win, bet,
        gain: win ? bet * 2 : 0
    });

    if (win) {
        let gain = bet * 2;
        addMoney(message.author.id, gain);
        winGame(message.author.id);
        return message.reply({ embeds: [premiumEmbed("🎰 ROULETTE VIP", `🎲 Numéro : **${number}**\n🎨 Couleur : ${result}\n\n🏆 GAGNÉ\n💎 +${gain} crédits`, "Green")] });
    }
    loseGame(message.author.id);
    message.reply({ embeds: [premiumEmbed("🎰 ROULETTE VIP", `🎲 Numéro : **${number}**\n🎨 Couleur : ${result}\n\n💀 PERDU`, "Red")] });
}

// ================= SLOTS =================
function slotsGame(message, bet) {
    if (!removeMoney(message.author.id, bet)) return message.reply("❌ Solde insuffisant");

    let icons = ["🍒", "💎", "⭐", "7️⃣", "👑"];
    let result = [
        icons[Math.floor(Math.random() * icons.length)],
        icons[Math.floor(Math.random() * icons.length)],
        icons[Math.floor(Math.random() * icons.length)]
    ];
    let win = result[0] === result[1] && result[1] === result[2];

    if (global.io) global.io.emit("game_event", { type: "slots", result, win, bet, player: message.author.username });
    if (global.pushLiveFeed) global.pushLiveFeed({
        type: win ? "slots_jackpot" : "slots_spin",
        player: message.author.username,
        result, win, bet,
        gain: win ? bet * 10 : 0
    });

    if (win) {
        let gain = bet * 10;
        addMoney(message.author.id, gain);
        winGame(message.author.id);
        economy[message.author.id].jackpots++;
        saveEconomy();
        return message.reply({ embeds: [premiumEmbed("🎰 MACHINE ROYALE", `╔══════════╗\n${result.join(" | ")}\n╚══════════╝\n\n🔥 JACKPOT\n💎 +${gain} crédits`, "Green")] });
    }
    loseGame(message.author.id);
    message.reply({ embeds: [premiumEmbed("🎰 MACHINE ROYALE", `${result.join(" | ")}\n\n💀 Perdu`, "Red")] });
}

// ================= COMMANDES =================
client.on("messageCreate", async message => {
    if (message.author.bot) return;
    const args = message.content.trim().split(/\s+/);
    const cmd = args[0]?.toLowerCase();
    if (!cmd) return;
    createUser(message.author.id);

    // PROFILE
    if (cmd === "!profile" || cmd === "!balance") {
        let u = economy[message.author.id];
        return message.reply({ embeds: [premiumEmbed("👑 PROFIL VIP", `👤 Joueur ${message.author}\n💰 Fortune **${u.money} crédits**\n🏆 Victoires ${u.wins}\n💀 Défaites ${u.losses}\n🔥 Winstreak ${u.winstreak}\n👑 Record ${u.bestWinstreak}\n🎰 Parties ${u.games}`)] });
    }

    // DUEL
    if (cmd === "!duel") {
        let target = message.mentions.users.first();
        let bet = Number(args[2]);
        if (!target || !bet) return message.reply("⚔️ Exemple : !duel @joueur 500");
        if (target.id === message.author.id) return message.reply("❌ Impossible de te défier toi-même");
        if (economy[message.author.id].money < bet) return message.reply("❌ Tu n'as pas assez");

        duels[target.id] = {
            player1: { id: message.author.id, name: message.author.username, cards: [] },
            player2: { id: target.id, name: target.username, cards: [] },
            bet, channel: message.channel
        };
        return message.reply({ embeds: [premiumEmbed("⚔️ DUEL ENVOYÉ", `👑 ${message.author.username} défie ⚔️ ${target.username}\n💰 Mise : ${bet} crédits\n\n➡️ ${target.username} Tape : **!accept**`)] });
    }

    if (cmd === "!accept") {
        let duel = duels[message.author.id];
        if (!duel) return message.reply("❌ Aucun duel trouvé");
        if (economy[duel.player1.id].money < duel.bet || economy[duel.player2.id].money < duel.bet)
            return message.reply("❌ Un joueur n'a pas assez");
        removeMoney(duel.player1.id, duel.bet);
        removeMoney(duel.player2.id, duel.bet);
        startDuel(duel);
    }

    if (cmd === "!deny") {
        delete duels[message.author.id];
        return message.reply("❌ Duel refusé");
    }

    // BLACKJACK
    if (cmd === "!bj") {
        let action = args[1];
        if (action === "create") {
            let bet = Number(args[2]);
            if (!bet) return message.reply("!bj create 500");
            if (!removeMoney(message.author.id, bet)) return message.reply("❌ Solde insuffisant");
            let id = Date.now();
            blackjackTables[id] = {
                players: [{ id: message.author.id, name: message.author.username, cards: [drawCard(), drawCard()], bet }],
                dealer: [drawCard(), drawCard()],
                channel: message.channel, started: false
            };
            return message.reply({ embeds: [premiumEmbed("🃏 TABLE BLACKJACK CRÉÉE", `💰 Mise : ${bet}\n👥 Joueurs : 1/4\n\nCommandes :\n!bj join\n!bj start`)] });
        }
        if (action === "join") {
            let table = Object.values(blackjackTables)[0];
            if (!table) return message.reply("❌ Aucune table");
            if (table.players.length >= 4) return message.reply("❌ Table complète");
            let bet = table.players[0].bet;
            if (!removeMoney(message.author.id, bet)) return message.reply("❌ Pas assez");
            table.players.push({ id: message.author.id, name: message.author.username, cards: [drawCard(), drawCard()], bet });
            return message.reply("🃏 Tu rejoins la table");
        }
        if (action === "start") {
            let table = Object.values(blackjackTables)[0];
            if (!table) return;
            table.started = true;
            return message.channel.send({ embeds: [premiumEmbed("🃏 BLACKJACK VIP", `🎩 Dealer : ${table.dealer[0]} | 🂠\n👥 Joueurs :\n${table.players.map(p => p.name).join("\n")}\n\n➡️ !hit\n➡️ !stand\n➡️ !double`)] });
        }
    }

    if (cmd === "!hit") {
        let table = Object.values(blackjackTables)[0];
        if (!table) return;
        let player = table.players.find(p => p.id === message.author.id);
        if (!player) return;
        player.cards.push(drawCard());
        return message.reply({ embeds: [premiumEmbed("🃏 CARTE TIRÉE", `👤 ${player.name}\n${player.cards.join(" | ")}\nTotal : **${handTotal(player.cards)}**`)] });
    }

    if (cmd === "!stand") {
        let table = Object.values(blackjackTables)[0];
        if (table) endBlackjack(table);
    }

    if (cmd === "!double") {
        let table = Object.values(blackjackTables)[0];
        let player = table?.players.find(p => p.id === message.author.id);
        if (!player) return;
        if (!removeMoney(message.author.id, player.bet)) return message.reply("❌ Pas assez");
        player.bet *= 2;
        player.cards.push(drawCard());
        return message.reply("💎 Mise doublée ! Carte finale tirée.");
    }

    // ROULETTE
    if (cmd === "!roulette") {
        let bet = Number(args[1]);
        let color = args[2]?.toLowerCase();
        if (!bet || !color) return message.reply("!roulette 500 rouge");
        rouletteGame(message, bet, color);
    }

    // SLOTS
    if (cmd === "!slots") {
        let bet = Number(args[1]);
        if (!bet) return message.reply("!slots 500");
        slotsGame(message, bet);
    }

    // ADMIN
    if (["!addbalance", "!removebalance", "!setbalance"].includes(cmd)) {
        if (message.author.id !== OWNER_ID) return message.reply("❌ Permission refusée");
        let user = message.mentions.users.first();
        let amount = Number(args[2]);
        if (!user || !amount) return;
        if (cmd === "!addbalance") addMoney(user.id, amount);
        if (cmd === "!removebalance") removeMoney(user.id, amount);
        if (cmd === "!setbalance") { createUser(user.id); economy[user.id].money = amount; saveEconomy(); }
        return message.reply("👑 Action admin effectuée");
    }

    // LEADERBOARD
    if (cmd === "!rich" || cmd === "!leaderboard" || cmd === "!lb") {
        const medals = ["🥇", "🥈", "🥉"];
        const top = Object.entries(economy)
            .sort((a, b) => b[1].money - a[1].money)
            .slice(0, 10);

        let text = "";
        let i = 0;
        for (const [id, data] of top) {
            const user = await client.users.fetch(id).catch(() => null);
            const name = user?.username || "Inconnu";
            const rank = medals[i] || `**${i + 1}.**`;
            const wr = data.games > 0 ? Math.round((data.wins / data.games) * 100) : 0;
            text += `${rank} **${name}**\n💰 ${data.money.toLocaleString("fr-FR")} cr. · 🏆 ${data.wins}V ${data.losses}D · 📊 ${wr}% WR\n\n`;
            i++;
        }

        return message.reply({
            embeds: [premiumEmbed(
                "🏆 CLASSEMENT PTIBLOND",
                text || "Aucun joueur enregistré.",
                "#FFD700"
            )]
        });
    }

    // WORK
    if (cmd === "!work") {
        const cooldown = 3600000; // 1 heure
        const last = workCooldown[message.author.id] || 0;
        const remaining = cooldown - (Date.now() - last);
        if (remaining > 0) {
            const mins = Math.ceil(remaining / 60000);
            return message.reply({ embeds: [premiumEmbed("⏳ TRAVAIL", `Tu es fatigué ! Reviens dans **${mins} minute${mins > 1 ? "s" : ""}**.`, "Red")] });
        }
        const jobs = [
            { job: "dealer de casino", min: 80, max: 200 },
            { job: "croupier VIP", min: 100, max: 250 },
            { job: "garde du casino", min: 60, max: 150 },
            { job: "comptable des mises", min: 120, max: 300 },
            { job: "serveur au bar", min: 50, max: 120 },
            { job: "videur à l'entrée", min: 70, max: 180 },
            { job: "technicien machines à sous", min: 90, max: 220 }
        ];
        const chosen = jobs[Math.floor(Math.random() * jobs.length)];
        const gain = Math.floor(Math.random() * (chosen.max - chosen.min + 1)) + chosen.min;
        workCooldown[message.author.id] = Date.now();
        addMoney(message.author.id, gain);
        return message.reply({ embeds: [premiumEmbed("💼 TRAVAIL", `Tu as travaillé comme **${chosen.job}** et gagné **${gain} crédits** !\n\n💰 Balance : **${economy[message.author.id].money} crédits**\n\n⏳ Prochain travail dans **1 heure**`, "Green")] });
    }

    // DAILY
    if (cmd === "!daily") {
        const cooldown = 86400000; // 24 heures
        if (!economy[message.author.id]) createUser(message.author.id);
        const last = economy[message.author.id].lastDaily || 0;
        const remaining = cooldown - (Date.now() - last);
        if (remaining > 0) {
            const hrs = Math.floor(remaining / 3600000);
            const mins = Math.ceil((remaining % 3600000) / 60000);
            return message.reply({ embeds: [premiumEmbed("⏳ DAILY", `Tu as déjà réclamé ta récompense !\nReviens dans **${hrs}h ${mins}min**.`, "Red")] });
        }
        const streak = (economy[message.author.id].dailyStreak || 0) + 1;
        const base = 200;
        const bonus = Math.min(streak - 1, 6) * 50; // +50 par jour consécutif, max +300
        const gain = base + bonus;
        economy[message.author.id].lastDaily = Date.now();
        economy[message.author.id].dailyStreak = streak;
        addMoney(message.author.id, gain);
        return message.reply({ embeds: [premiumEmbed("🎁 RÉCOMPENSE QUOTIDIENNE", `Tu as réclamé ta récompense du jour !\n\n💰 Gain : **+${gain} crédits**${bonus > 0 ? ` (dont +${bonus} de streak bonus)` : ""}\n🔥 Streak : **${streak} jour${streak > 1 ? "s" : ""} consécutif${streak > 1 ? "s" : ""}**\n\n💎 Balance : **${economy[message.author.id].money} crédits**\n\n⏳ Prochain daily dans **24 heures**`, "Green")] });
    }

    // HELP
    if (cmd === "!help") {
        return message.reply({ embeds: [premiumEmbed("🎰 CASINO ROYALE V9", `⚔️ DUEL\n!duel @joueur mise | !accept\n\n🃏 BLACKJACK\n!bj create mise | !bj join | !bj start | !hit | !stand | !double\n\n🎰 CASINO\n!roulette mise couleur | !slots mise\n\n💼 GAINS\n!work — Travailler (cooldown 1h)\n!daily — Bonus quotidien (cooldown 24h)\n\n👑 PROFIL\n!profile | !rich\n\n🌐 SITE\n!web\n\n⚙️ ADMIN\n!addbalance | !removebalance | !setbalance`)] });
    }

    // WEB LINK
    if (cmd === "!web") {
        return message.reply({ embeds: [premiumEmbed("🌐 CASINO WEB", `Joue directement depuis le navigateur !\n\n🎮 **https://ptiblond-casino.onrender.com/**\n\n🃏 Blackjack 3D\n🎡 Roulette en direct\n🎰 Machines à sous\n\n💡 Ta balance Discord est synchronisée avec le site !`)] });
    }
});

// ================= LOGIN =================
client.login(TOKEN);

module.exports = { client, economy };