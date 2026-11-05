const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const csv = require('csv-parser');
const { Readable } = require('stream');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Teeno tabs ke separate CSV URLs
const TEAMS_CSV_URL = 'https://docs.google.com/spreadsheets/d/1_t8ZiQyA5ohoNgC4H6AY4yG1K0OTgEzLZIJNOg8yVMc/export?format=csv&gid=0';
const PLAYERS_CSV_URL = 'https://docs.google.com/spreadsheets/d/1_t8ZiQyA5ohoNgC4H6AY4yG1K0OTgEzLZIJNOg8yVMc/export?format=csv&gid=790908491';
const SETTINGS_CSV_URL = 'https://docs.google.com/spreadsheets/d/1_t8ZiQyA5ohoNgC4H6AY4yG1K0OTgEzLZIJNOg8yVMc/export?format=csv&gid=1259568157';

let teamsData = [];
let playersData = [];
let settingsData = [];

let auctionState = {
    currentPlayer: null,
    currentBid: 0,
    leadingTeam: 'None',
    status: 'idle'
};

// Google Sheet ke sabhi tabs se live data fetch karne ka function
async function fetchSheetData() {
    try {
        // 1. Fetch Teams Tab
        const teamsRes = await axios.get(TEAMS_CSV_URL);
        let tempTeams = [];
        Readable.from(teamsRes.data).pipe(csv())
            .on('data', (row) => tempTeams.push(row))
            .on('end', () => { teamsData = tempTeams; });

        // 2. Fetch Player Master Tab
        const playersRes = await axios.get(PLAYERS_CSV_URL);
        let tempPlayers = [];
        Readable.from(playersRes.data).pipe(csv())
            .on('data', (row) => tempPlayers.push(row))
            .on('end', () => { playersData = tempPlayers; });

        // 3. Fetch Settings Tab
        const settingsRes = await axios.get(SETTINGS_CSV_URL);
        let tempSettings = [];
        Readable.from(settingsRes.data).pipe(csv())
            .on('data', (row) => tempSettings.push(row))
            .on('end', () => { 
                settingsData = tempSettings;
                console.log('All Google Sheet Tabs Synced Successfully!');
            });

    } catch (error) {
        console.error('Error fetching Google Sheet data:', error.message);
    }
}

// Initial Sync
fetchSheetData();
setInterval(fetchSheetData, 120000); // Har 2 minute mein auto-sync

// API: Specific team ke retention players Column J ke mutabiq filter karna
app.get('/api/retention-players', (req, res) => {
    const teamName = req.query.team;
    if (!teamName) return res.json([]);

    const filteredPlayers = playersData.filter(player => {
        const teamInColJ = player['Team'] || player['Team Name'] || player['Column J'] || '';
        return teamInColJ.trim().toLowerCase() === teamName.trim().toLowerCase();
    });

    res.json(filteredPlayers);
});

// Socket.io Events
io.on('connection', (socket) => {
    socket.emit('syncState', { auctionState });

    socket.on('loginAdmin', (data, callback) => {
        if (data.password === 'admin123') {
            callback({ success: true });
        } else {
            callback({ success: false, message: 'Invalid Admin Password!' });
        }
    });

    socket.on('startAuction', () => {
        if (playersData.length > 0 && !auctionState.currentPlayer) {
            auctionState.currentPlayer = playersData[0];
            auctionState.currentBid = parseFloat(playersData[0]['Base Price'] || 0);
            auctionState.status = 'running';
        }
        io.emit('auctionStarted', auctionState);
    });

    socket.on('placeBid', (data) => {
        if (auctionState.status === 'running') {
            auctionState.currentBid += 0.5;
            auctionState.leadingTeam = data.teamName;
            io.emit('bidUpdated', auctionState);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
