const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// ==========================================
// CONFIGURATION DES ACTIONS AUTOMATIQUES
// ==========================================
const CONFIG = {
    // Sondages en groupe uniquement
    SONDAGE_MOT_CLE_GROUPE: 'escalade',       // Le mot qui doit être contenu dans le nom du groupe (insensible à la casse)
    SONDAGE_OPTION_CIBLE: 'oui'           // L'option à cocher (insensible à la casse)
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

console.log('--- [ÉTAPE 1] Configuration du Serveur ---');
console.log('[LOG] Serveur Express et Socket.io configurés.');

let lastQRBase64 = null;
let isConnected = false;
let connectedUser = null;
let currentStatus = 'init';

io.on('connection', (socket) => {
    socket.emit('auth_status', {
        status: currentStatus,
        connected: isConnected,
        user: connectedUser,
        qr: isConnected ? null : lastQRBase64
    });
});

console.log('--- [ÉTAPE 2] Préparation du client WhatsApp ---');
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018944888-alpha.html'
    }
});

// ==========================================
// GESTION DE LA CONNEXION
// ==========================================

client.on('loading_screen', (percent, message) => {
    console.log(`[WHATSAPP - CHARGEMENT] Page web en cours... ${percent}% - ${message}`);
});

client.on('qr', async (qrText) => {
    isConnected = false;
    currentStatus = 'qr';
    try {
        lastQRBase64 = await qrcode.toDataURL(qrText);
        io.emit('auth_status', { status: currentStatus, connected: false, user: null, qr: lastQRBase64 });
    } catch (err) {}
});

client.on('authenticated', () => {
    currentStatus = 'authenticated';
    io.emit('auth_status', { status: currentStatus, connected: false, user: null, qr: null });
});

client.on('ready', () => {
    console.log('\n=========================================');
    console.log('[WHATSAPP - PRÊT] Le bot est totalement opérationnel !');
    console.log('=========================================\n');
    isConnected = true;
    currentStatus = 'ready';
    const info = client.info;
    connectedUser = (info && info.pushname) ? info.pushname : (info && info.wid && info.wid.user) ? info.wid.user : 'Compte actif';
    io.emit('auth_status', { status: currentStatus, connected: true, user: connectedUser, qr: null });
});

client.on('disconnected', (reason) => {
    isConnected = false;
    currentStatus = 'init';
    io.emit('auth_status', { status: currentStatus, connected: false, user: null, qr: null });
});

// ==========================================
// ÉCOUTE DES MESSAGES
// ==========================================

client.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        const contact = await msg.getContact();
        
        const isGroup = chat ? chat.isGroup : false;
        const chatName = chat ? chat.name : 'Inconnu';
        let senderName = contact ? (contact.pushname || contact.name || contact.number) : 'Anonyme';
        let content = msg.body || `[Média/Spécial : ${msg.type}]`;
        const isFromMe = msg.fromMe; 

        // Envoi à l'interface graphique pour l'historique
        io.emit('new_message', {
            time: new Date().toLocaleTimeString(),
            isGroup: isGroup,
            chatName: chatName,
            senderName: isFromMe ? 'Moi' : senderName,
            text: content,
            type: msg.type,
            isFromMe: isFromMe
        });

        // ACTION : Réponse auto aux sondages (Groupes uniquement)
        if (isGroup && chatName.toLowerCase().includes(CONFIG.SONDAGE_MOT_CLE_GROUPE.toLowerCase()) && msg.type === 'poll_creation') {
            console.log(`[SONDAGE DÉTECTÉ] Groupe cible "${chatName}". Analyse des options...`);
            io.emit('system_log', `📊 Sondage détecté dans "${chatName}".`);

            const options = msg.pollOptions || [];
            const optionTrouvee = options.find(opt => opt.name && opt.name.toLowerCase() === CONFIG.SONDAGE_OPTION_CIBLE.toLowerCase());

            if (optionTrouvee) {
                const nomOptionExact = optionTrouvee.name;
                const delaiAleatoire = Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000; // Entre 1000ms et 3000ms
                
                console.log(`[ACTION] Option "${nomOptionExact}" trouvée. Vote prévu dans ${delaiAleatoire}ms...`);
                
                setTimeout(async () => {
                    try {
                        await msg.vote([nomOptionExact]);
                        console.log(`[SUCCÈS] Vote effectué pour "${nomOptionExact}".`);
                        io.emit('system_log', `✅ Vote automatique effectué pour : ${nomOptionExact}`);
                    } catch (errVote) {
                        console.error(`[ERREUR] Impossible de voter au sondage :`, errVote.message);
                        io.emit('system_log', `❌ Erreur lors du vote.`);
                    }
                }, delaiAleatoire);
            } else {
                console.log(`[LOG] L'option "${CONFIG.SONDAGE_OPTION_CIBLE}" n'est pas présente dans ce sondage.`);
            }
        }

    } catch (err) {
        console.error('[ERREUR CRITIQUE] Impossible d\'analyser le message :', err.message);
    }
});

server.listen(3000, () => {
    console.log('\n[SERVEUR HTTP] Serveur lancé sur http://localhost:3000');
    client.initialize().catch(err => {
        console.error('\n[CRITIQUE FATALE] Crash au lancement de Chrome !', err);
    });
});