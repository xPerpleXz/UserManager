const express = require('express');
const mariadb = require('mariadb');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

const DATA_DIR = path.join(__dirname, 'data', 'users');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// MariaDB connection details
const pool = mariadb.createPool({
  host: 'localhost',
  user: 'root',
  password: 'Dein Passwort', // Replace with your real root password
  connectionLimit: 5
});

app.use(cors({}));

app.use(bodyParser.json());

// In-memory store for users metadata
let userStore = [];
const USERS_METADATA_PATH = path.join(__dirname, 'data', 'users.json');

if(fs.existsSync(USERS_METADATA_PATH)) {
  try {
    userStore = JSON.parse(fs.readFileSync(USERS_METADATA_PATH, 'utf8'));
  } catch(e) {
    console.error('Error loading users metadata:', e);
  }
}

function persistUserStore() {
  fs.writeFileSync(USERS_METADATA_PATH, JSON.stringify(userStore, null, 2), 'utf8');
}

// In-memory map for temporary download tokens: token => { filePath, expiresAt }
const downloadTokens = new Map();

// Clean expired tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const [token, info] of downloadTokens.entries()) {
    if (info.expiresAt <= now) downloadTokens.delete(token);
  }
}, 60 * 1000);

function sanitizeFilename(username) {
  return username.replace(/[^\w\-]/g, '_');
}

function saveUserToFile(user) {
  const filename = sanitizeFilename(user.discordName) + '.json';
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(user, null, 2), 'utf8');
  return filename;
}

function generatePassword(length = 16) {
  return crypto.randomBytes(length).toString('base64').slice(0, length);
}

async function createMariaDBUser(username, password, dbName) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('CREATE USER IF NOT EXISTS ?@\'%\' IDENTIFIED BY ?', [username, password]);
    await conn.query('GRANT ALL PRIVILEGES ON `' + dbName + '`.* TO ?@\'%\'', [username]);
    await conn.query('FLUSH PRIVILEGES');
  } finally {
    if (conn) await conn.release();
  }
}

// Simulated FTP user creation - replace with real implementation
async function createFtpUser(username, password) {
  return new Promise(resolve => setTimeout(resolve, 200));
}

function generateCertificate(discordName, certType, validDays, keySize) {
  const now = new Date();
  const expiry = new Date(now.getTime() + validDays * 24 * 3600 * 1000);
  const serialNumber = crypto.randomBytes(8).toString('hex').toUpperCase();
  const fingerprint = crypto.randomBytes(16).toString('hex').match(/.{2}/g).join(':').toUpperCase();
  return {
    serialNumber,
    fingerprint,
    subject: `CN=${discordName.split('#')[0]}, O=Discord Users, C=DE`,
    issuer: `CN=User Management CA, O=Your Organization, C=DE`,
    validFrom: now.toISOString(),
    validTo: expiry.toISOString(),
    keySize,
    type: certType,
    privateKey: `-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_KEY_${serialNumber}\n-----END PRIVATE KEY-----`,
    certificate: `-----BEGIN CERTIFICATE-----\nFAKE_CERTIFICATE_${serialNumber}\n-----END CERTIFICATE-----`,
    status: 'Aktiv'
  };
}

app.post('/api/users', async (req, res) => {
  try {
    const {
      discordName, ftpServer, ftpPort,
      dbServer, dbPort, dbType,
      certType, certValidDays, keySize
    } = req.body;

    if(!discordName) return res.status(400).json({error:'Discord Benutzername erforderlich'});
    if(userStore.find(u => u.discordName === discordName))
      return res.status(400).json({error:'Discord Benutzer existiert bereits.'});

    const baseName = discordName.split('#')[0].toLowerCase().replace(/[^\w]/g,'').slice(0,16);
    const randNum = Math.floor(Math.random() * 1000);
    const ftpUsername = baseName + randNum;
    const ftpPassword = generatePassword(12);
    const dbUsername = baseName + 'db' + randNum;
    const dbPassword = generatePassword(16);

    const appDbName = 'discord_user_management';

    await createMariaDBUser(dbUsername, dbPassword, appDbName);
    await createFtpUser(ftpUsername, ftpPassword);

    const certificate = generateCertificate(discordName, certType, certValidDays, keySize);

    const newUser = {
      id: Date.now(),
      discordName, ftpServer, ftpPort, ftpUsername, ftpPassword,
      dbServer, dbPort, dbType, dbUsername, dbPassword, certificate,
      createdAt: new Date().toLocaleString('de-DE'), status: 'Aktiv'
    };

    userStore.push(newUser);
    persistUserStore();

    const userJsonFile = saveUserToFile(newUser);

    const token = crypto.randomBytes(16).toString('hex');
    downloadTokens.set(token, {
      filePath: path.join(DATA_DIR, userJsonFile),
      expiresAt: Date.now() + 3 * 60 * 1000
    });

    const downloadUrl = `/download/${token}`;

    return res.json({success:true, user: newUser, downloadUrl});
  } catch(err) {
    console.error(err);
    res.status(500).json({error: 'Serverfehler: '+err.message});
  }
});

app.get('/api/get-users', (req, res) => {
  res.json(userStore);
});

app.use('/files', express.static(DATA_DIR));

app.get('/download/:token', (req, res) => {
  const tokenData = downloadTokens.get(req.params.token);
  if(!tokenData) return res.status(404).send('Link abgelaufen oder ungültig');

  if(Date.now() > tokenData.expiresAt) {
    downloadTokens.delete(req.params.token);
    return res.status(410).send('Downloadzeit abgelaufen');
  }

  // Nach dem ersten Download den Token entfernen!
  downloadTokens.delete(req.params.token);

  res.download(tokenData.filePath, path.basename(tokenData.filePath), err => {
    if(err) console.error('Download Fehler:',err);
  });
});

// New endpoint for admin panel credentials downloads
app.get('/api/download-credentials', (req, res) => {
  try {
    const { userId, type } = req.query;
    if (!userId || !type) return res.status(400).send('Parameter userId und type erforderlich');

    const user = userStore.find(u => String(u.id) === String(userId));
    if (!user) return res.status(404).send('Benutzer nicht gefunden');

    let content = '';
    let filename = '';
    let contentType = 'text/plain';

    switch (type) {
      case 'ftp':
        content = `FTP Zugangsdaten für ${user.discordName}\n\nServer: ${user.ftpServer}:${user.ftpPort}\nBenutzername: ${user.ftpUsername}\nPasswort: ${user.ftpPassword}\n`;
        filename = sanitizeFilename(user.discordName) + '_ftp_credentials.txt';
        break;
      case 'db':
        content = `Datenbank Zugangsdaten für ${user.discordName}\n\nServer: ${user.dbServer}:${user.dbPort}\nTyp: ${user.dbType}\nBenutzername: ${user.dbUsername}\nPasswort: ${user.dbPassword}\n`;
        filename = sanitizeFilename(user.discordName) + '_db_credentials.txt';
        break;
      case 'cert':
        const cert = user.certificate || {};
        content = `Zertifikat Details für ${user.discordName}\n\nTyp: ${cert.type || '-'}\nSeriennummer: ${cert.serialNumber || '-'}\nGültig bis: ${cert.validTo ? new Date(cert.validTo).toLocaleDateString('de-DE') : '-'}\nSchlüsselgröße: ${cert.keySize ? cert.keySize + ' Bit' : '-'}\n\nPrivater Schlüssel:\n${cert.privateKey || '-'}\n\nZertifikat:\n${cert.certificate || '-'}\n`;
        filename = sanitizeFilename(user.discordName) + '_certificate.txt';
        break;
      default:
        return res.status(400).send('Ungültiger Typ, erlaubte Werte: ftp, db, cert');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    console.error(error);
    res.status(500).send('Serverfehler beim Herunterladen der Credentials');
  }
});

app.listen(PORT, () => {
  console.log(`Backend läuft auf http://DeineIP.de:${PORT}`);
});

