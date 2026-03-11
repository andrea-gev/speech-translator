import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  allowUpgrades: true
});

// Translate using OpenAI API directly via fetch (no SDK dependency at startup)
async function translateText(text, fromLang, toLang) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [{
        role: 'system',
        content: `You are a translator. Translate the following text from ${fromLang} to ${toLang}. Output ONLY the translation, nothing else.`
      }, {
        role: 'user',
        content: text
      }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error: ${resp.status}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Room state
const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex');
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id} | transport: ${socket.conn.transport.name} | Active rooms: ${[...rooms.keys()].join(', ') || 'none'}`);

  socket.on('create-room', ({ sourceLang, targetLang }, callback) => {
    const roomId = generateRoomId();
    rooms.set(roomId, {
      speaker: socket.id,
      sourceLang,
      targetLang,
      listenerCount: 0
    });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'speaker';
    callback({ roomId });
    console.log(`Room created: ${roomId} by ${socket.id}`);
  });

  socket.on('join-room', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ error: 'Stanza non trovata' });
      return;
    }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'listener';
    room.listenerCount++;
    callback({ sourceLang: room.sourceLang, targetLang: room.targetLang });
    io.to(room.speaker).emit('listener-count', room.listenerCount);
    console.log(`Listener joined room ${roomId}. Count: ${room.listenerCount}`);
  });

  socket.on('update-languages', ({ sourceLang, targetLang }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.speaker !== socket.id) return;
    room.sourceLang = sourceLang;
    room.targetLang = targetLang;
    socket.to(roomId).emit('languages-updated', { sourceLang, targetLang });
  });

  socket.on('translate', async ({ text }, callback) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.speaker !== socket.id) return;

    try {
      const translated = await translateText(text, room.sourceLang, room.targetLang);
      callback({ translated });
      socket.to(roomId).emit('translation', { original: text, translated });
    } catch (err) {
      console.error('Translation error:', err.message);
      callback({ error: err.message });
    }
  });

  socket.on('interim', (text) => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('interim', text);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;

    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (role === 'speaker') {
        io.to(roomId).emit('speaker-left');
        rooms.delete(roomId);
        console.log(`Room ${roomId} closed (speaker disconnected)`);
      } else if (role === 'listener') {
        room.listenerCount = Math.max(0, room.listenerCount - 1);
        io.to(room.speaker).emit('listener-count', room.listenerCount);
        console.log(`Listener left room ${roomId}. Count: ${room.listenerCount}`);
      }
    }
    console.log(`Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`OPENAI_API_KEY configured: ${!!process.env.OPENAI_API_KEY}`);
});
