const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// Apna deployed Google Apps Script Web App URL yahan paste karein
const GAS_WEBAPP_URL = "YOUR_GOOGLE_APPS_SCRIPT_WEBAPP_URL_HERE";

let teamsData = [];
let playersData = [];
let availablePlayers = [];
let unsoldPlayers = [];

let auctionState = {
    currentPlayer: null,
    currentBid: 0.5,
    highestBidder: "None",
    status: "idle", // 'idle', 'running', 'paused', 'sold_overlay', 'completed'
    isUnsoldRound: false,
    timer: 23,
    bidHistory: []
};

let timerInterval = null;

// Load Master Data from Google Sheets
async function loadMasterData() {
    try {
        const res = await axios.get(`${GAS_WEBAPP_URL}?action=getInitialData`);
        teamsData = res.data.teams || [];
        playersData = res.data.players || [];
        
        availablePlayers = playersData.filter(p => p.Status === 'Available' || !p.Status || p.Status === '');
        availablePlayers.sort(() => Math.random() - 0.5);
        console.log(`Loaded ${teamsData.length} teams and ${availablePlayers.length} players successfully!`);
    } catch (e) {
        console.error("Error fetching data from Google Sheet:", e.message);
    }
}
loadMasterData();

function calculateNextBid(current) {
    if (current < 1.0) return +(current + 0.1).toFixed(1);
    if (current >= 1.0 && current < 5.0) return +(current + 0.2).toFixed(1);
    return +(current + 0.5).toFixed(1);
}

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timer = 23;
    
    timerInterval = setInterval(() => {
        if (auctionState.status === 'running') {
            auctionState.timer--;
            io.emit('timerTick', { timer: auctionState.timer });
            
            if (auctionState.timer <= 0) {
                clearInterval(timerInterval);
                finalizeCurrentPlayer();
            }
        }
    }, 1000);
}

async function finalizeCurrentPlayer() {
    const player = auctionState.currentPlayer;
    let resultType = "UNSOLD";
    
    if (auctionState.highestBidder !== "None") {
        resultType = "SOLD";
        player.Status = "Sold";
        player.SoldPrice = auctionState.currentBid;
        player.WiningTeam = auctionState.highestBidder;
    } else {
        player.Status = "Unsold";
        unsoldPlayers.push(player);
    }

    auctionState.status = "sold_overlay";
    io.emit('playerFinalized', { 
        resultType, 
        player, 
        price: auctionState.currentBid, 
        team: auctionState.highestBidder 
    });

    // Write back status to Google Sheet via Apps Script
    try {
        await axios.post(GAS_WEBAPP_URL, {
            action: 'updatePlayerStatus',
            playerId: player['Player ID'] || player.ID || player.Id,
            soldPrice: player.SoldPrice || 0,
            winingTeam: player.WiningTeam || 'Unsold',
            status: player.Status
        });
    } catch (err) {
        console.error("Sheet update failed:", err.message);
    }

    // Auto transition after 5 seconds to next random player
    setTimeout(() => {
        drawNextPlayer();
    }, 5000);
}

function drawNextPlayer() {
    if (availablePlayers.length === 0) {
        if (unsoldPlayers.length > 0) {
            availablePlayers = [...unsoldPlayers];
            unsoldPlayers = [];
            auctionState.isUnsoldRound = true;
            availablePlayers.sort(() => Math.random() - 0.5);
        } else {
            auctionState.status = "completed";
            io.emit('auctionEnded');
            return;
        }
    }

    auctionState.currentPlayer = availablePlayers.pop();
    auctionState.currentBid = parseFloat(auctionState.currentPlayer['Base Price'] || 0.5);
    auctionState.highestBidder = "None";
    auctionState.bidHistory = [];
    auctionState.status = "running";
    
    io.emit('newPlayerDrawn', { auctionState });
    startTimer();
}

io.on('connection', (socket) => {
    socket.emit('syncState', { auctionState, teamsData });

    socket.on('startAuction', () => {
        if (auctionState.status === 'idle' || auctionState.status === 'paused') {
            if (!auctionState.currentPlayer) {
                drawNextPlayer();
            } else {
                auctionState.status = 'running';
                startTimer();
            }
        }
    });

    socket.on('placeBid', (data) => {
        if (auctionState.status !== 'running') return;
        if (auctionState.highestBidder === data.teamName) return; // Self-bidding restriction

        const nextBidVal = (auctionState.highestBidder === "None") 
            ? auctionState.currentBid 
            : calculateNextBid(auctionState.currentBid);

        auctionState.currentBid = nextBidVal;
        auctionState.highestBidder = data.teamName;
        auctionState.bidHistory.push({ team: data.teamName, bid: nextBidVal });
        auctionState.timer = 23; // Reset timer to 23s on successful bid

        io.emit('bidUpdated', { auctionState });
    });

    // Admin Control Actions
    socket.on('adminAction', (data) => {
        if (data.action === 'pause') {
            auctionState.status = 'paused';
            io.emit('auctionPaused');
        } else if (data.action === 'resume') {
            auctionState.status = 'running';
            io.emit('auctionResumed');
        } else if (data.action === 'undo') {
            if (auctionState.bidHistory.length > 1) {
                auctionState.bidHistory.pop();
                const last = auctionState.bidHistory[auctionState.bidHistory.length - 1];
                auctionState.highestBidder = last.team;
                auctionState.currentBid = last.bid;
            } else {
                auctionState.bidHistory = [];
                auctionState.highestBidder = "None";
                auctionState.currentBid = parseFloat(auctionState.currentPlayer['Base Price'] || 0.5);
            }
            io.emit('bidUpdated', { auctionState });
        } else if (data.action === 'end') {
            auctionState.status = 'completed';
            io.emit('auctionEnded');
        }
    });

    // Live Voice/Chat Message Broadcasting
    socket.on('sendChatMessage', (msgData) => {
        io.emit('receiveChatMessage', msgData);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
