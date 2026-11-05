const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = [];
let teams = [];
let settings = {};

let auctionState = {
    isRunning: false,
    currentPlayerIndex: 0,
    currentPlayer: null,
    currentBid: 0,
    leadingTeam: null,
    shuffledPlayers: []
};

// CSV Files Load karna
function loadData() {
    players = [];
    fs.createReadStream('Player_Master.csv')
        .pipe(csv())
        .on('data', (row) => players.push(row))
        .on('end', () => {
            console.log(`Loaded ${players.length} players.`);
            resetAuctionQueue();
        });

    teams = [];
    if (fs.existsSync('Teams.csv')) {
        fs.createReadStream('Teams.csv')
            .pipe(csv())
            .on('data', (row) => teams.push(row))
            .on('end', () => console.log(`Loaded ${teams.length} teams.`));
    }
}

function resetAuctionQueue() {
    // Players ko random shuffle karna (Automatic Random Appearance)
    auctionState.shuffledPlayers = [...players].sort(() => Math.random() - 0.5);
    auctionState.currentPlayerIndex = 0;
}

loadData();

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Current state synchronize karna
    socket.emit('syncState', { auctionState });

    // Admin Login
    socket.emit('loginAdmin', ({ password }, callback) => {
        if (password === 'valle123') {
            callback({ success: true });
        } else {
            callback({ success: false, message: 'Incorrect Password!' });
        }
    });

    // Auction Start Karna (Automatic Random Player Flow)
    socket.on('startAuction', () => {
        auctionState.isRunning = true;
        nextPlayer();
    });

    // Next Player Logic
    function nextPlayer() {
        if (auctionState.currentPlayerIndex < auctionState.shuffledPlayers.length) {
            let p = auctionState.shuffledPlayers[auctionState.currentPlayerIndex];
            auctionState.currentPlayer = {
                id: p['Player ID'] || p['Player ID '],
                name: p['Player Name'],
                role: p['Role'],
                basePrice: parseFloat(p['Base Price']) || 0.5,
                photo: p['Player Photo'] || ''
            };
            auctionState.currentBid = auctionState.currentPlayer.basePrice;
            auctionState.leadingTeam = 'None';
            auctionState.currentPlayerIndex++;

            io.emit('auctionStarted', auctionState);
        } else {
            auctionState.isRunning = false;
            auctionState.currentPlayer = { name: 'Auction Completed!', role: '-', basePrice: 0 };
            io.emit('auctionStarted', auctionState);
        }
    }

    // Place Bid Logic
    socket.on('placeBid', ({ teamName }) => {
        if (!auctionState.isRunning || !auctionState.currentPlayer) return;
        
        let increment = auctionState.currentBid >= 5 ? 0.5 : 0.1;
        auctionState.currentBid = parseFloat((auctionState.currentBid + increment).toFixed(2));
        auctionState.leadingTeam = teamName;

        io.emit('bidUpdated', auctionState);
    });

    socket.on('stopAuction', () => {
        auctionState.isRunning = false;
        io.emit('syncState', { auctionState });
    });

    socket.on('nextPlayer', () => {
        if (auctionState.isRunning) {
            nextPlayer();
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
