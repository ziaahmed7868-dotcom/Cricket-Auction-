const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const ADMIN_PASSWORD = "valle123";

let players = [];
let teams = [];
let settings = {};
let retentions = {}; 
let approvedRetentions = {}; 

let currentAuctionState = {
    status: 'SETUP',
    currentPlayer: null,
    currentBid: 0,
    leadingTeam: null,
    timer: 20,
    timerInterval: null,
    unsoldPool: [],
    isUnsoldRound: false
};

function loadData() {
    if (fs.existsSync('Teams.csv')) {
        fs.createReadStream('Teams.csv')
            .pipe(csv())
            .on('data', (data) => {
                teams.push({
                    name: data['Team Name'].trim(),
                    logo: data['Team Logo'],
                    primaryColor: data['Primary Color'],
                    secondaryColor: data['Secondry Color'],
                    initialPurse: parseFloat(data['Initial Purse']) || 120,
                    spent: 0,
                    currentPurse: parseFloat(data['Initial Purse']) || 120,
                    playersBought: 0,
                    mab: parseFloat(data['Initial Purse']) || 120,
                    status: data['Status'] || 'Active'
                });
            });
    }

    if (fs.existsSync('Settings.csv')) {
        fs.createReadStream('Settings.csv')
            .pipe(csv())
            .on('data', (data) => {
                const key = data['Rule Name '] ? data['Rule Name '].trim() : data['Rule Name'].trim();
                settings[key] = parseFloat(data['Value']);
            });
    }

    if (fs.existsSync('Player_Master.csv')) {
        fs.createReadStream('Player_Master.csv')
            .pipe(csv())
            .on('data', (data) => {
                players.push({
                    id: parseInt(data['Player ID']),
                    name: data['Player Name'].trim(),
                    role: data['Role'].trim(),
                    basePrice: parseFloat(data['Base Price']) || 0.5,
                    photo: data['Player Photo'],
                    soldPrice: null,
                    winningTeam: null,
                    status: data['Status'] ? data['Status'].trim() : 'Available',
                    previousTeam: data['Previous Team'] ? data['Previous Team'].trim() : null
                });
            });
    }
}

loadData();

function calculateMAB(team) {
    const maxPlayers = settings['Max Total Players'] || 17;
    const minBid = 0.5;
    const remainingNeeded = maxPlayers - team.playersBought - 1;
    if (remainingNeeded <= 0) return team.currentPurse;
    const reservedPurse = remainingNeeded * minBid;
    return Math.max(0, team.currentPurse - reservedPurse);
}

io.on('connection', (socket) => {
    socket.emit('syncState', {
        teams,
        settings,
        currentAuctionState,
        retentions,
        approvedRetentions,
        players
    });

    socket.on('loginAdmin', ({ password }, callback) => {
        if (password === ADMIN_PASSWORD) {
            callback({ success: true });
        } else {
            callback({ success: false, message: "Incorrect Admin Password!" });
        }
    });

    socket.on('requestRetention', ({ teamName, playerId, price }) => {
        const player = players.find(p => p.id === parseInt(playerId));
        if (player) {
            retentions[teamName] = { player, price: parseFloat(price) };
            io.emit('retentionUpdated', { retentions, approvedRetentions });
        }
    });

    socket.on('approveRetention', ({ teamName }) => {
        const retData = retentions[teamName];
        if (retData && !approvedRetentions[teamName]) {
            const team = teams.find(t => t.name === teamName);
            if (team) {
                team.currentPurse -= retData.price;
                team.spent += retData.price;
                team.playersBought += 1;
                team.mab = calculateMAB(team);
                retData.player.status = 'Sold';
                retData.player.winningTeam = teamName;
                retData.player.soldPrice = retData.price;
                approvedRetentions[teamName] = true;
                io.emit('syncState', { teams, settings, currentAuctionState, retentions, approvedRetentions, players });
            }
        }
    });

    socket.on('startAuction', () => {
        currentAuctionState.status = 'LIVE';
        drawNextPlayer();
        io.emit('auctionStarted', currentAuctionState);
    });

    socket.on('placeBid', ({ teamName }) => {
        if (currentAuctionState.status !== 'LIVE') return;
        if (currentAuctionState.leadingTeam === teamName) return;

        const team = teams.find(t => t.name === teamName);
        const maxPlayers = settings['Max Total Players'] || 17;
        
        if (!team || team.playersBought >= maxPlayers) return;

        let increment = 0.1;
        if (currentAuctionState.currentBid >= 5.0) increment = 0.5;
        else if (currentAuctionState.currentBid >= 1.0) increment = 0.2;

        let nextBid = currentAuctionState.currentBid === 0 ? currentAuctionState.currentPlayer.basePrice : currentAuctionState.currentBid + increment;
        nextBid = Math.round(nextBid * 10) / 10;

        if (nextBid <= team.mab) {
            currentAuctionState.currentBid = nextBid;
            currentAuctionState.leadingTeam = teamName;
            currentAuctionState.timer = 20;
            io.emit('bidUpdated', currentAuctionState);
        }
    });

    socket.on('reverseBid', () => {
        currentAuctionState.currentBid = 0;
        currentAuctionState.leadingTeam = null;
        currentAuctionState.timer = 20;
        io.emit('bidUpdated', currentAuctionState);
    });

    socket.on('stopAuction', () => {
        currentAuctionState.status = 'PAUSED';
        clearInterval(currentAuctionState.timerInterval);
        io.emit('auctionPaused', currentAuctionState);
    });

    socket.on('resumeAuction', () => {
        currentAuctionState.status = 'LIVE';
        startTimer();
        io.emit('auctionResumed', currentAuctionState);
    });
});

function drawNextPlayer() {
    let available = players.filter(p => p.status === 'Available');
    if (available.length === 0) {
        currentAuctionState.status = 'FINISHED';
        io.emit('auctionFinished');
        return;
    }
    const randomIndex = Math.floor(Math.random() * available.length);
    currentAuctionState.currentPlayer = available[randomIndex];
    currentAuctionState.currentBid = 0;
    currentAuctionState.leadingTeam = null;
    currentAuctionState.timer = 20;
    startTimer();
}

function startTimer() {
    clearInterval(currentAuctionState.timerInterval);
    currentAuctionState.timerInterval = setInterval(() => {
        if (currentAuctionState.status !== 'LIVE') return;
        currentAuctionState.timer--;
        io.emit('timerTick', currentAuctionState.timer);

        if (currentAuctionState.timer <= 0) {
            clearInterval(currentAuctionState.timerInterval);
            finalizePlayer();
        }
    }, 1000);
}

function finalizePlayer() {
    if (currentAuctionState.leadingTeam) {
        const team = teams.find(t => t.name === currentAuctionState.leadingTeam);
        team.currentPurse -= currentAuctionState.currentBid;
        team.spent += currentAuctionState.currentBid;
        team.playersBought += 1;
        team.mab = calculateMAB(team);
        
        currentAuctionState.currentPlayer.status = 'Sold';
        currentAuctionState.currentPlayer.winningTeam = team.name;
        currentAuctionState.currentPlayer.soldPrice = currentAuctionState.currentBid;

        io.emit('playerSold', { player: currentAuctionState.currentPlayer, team, price: currentAuctionState.currentBid });
    } else {
        currentAuctionState.currentPlayer.status = 'Unsold';
        io.emit('playerUnsold', currentAuctionState.currentPlayer);
    }

    setTimeout(() => {
        drawNextPlayer();
        io.emit('syncState', { teams, settings, currentAuctionState, retentions, approvedRetentions, players });
    }, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
