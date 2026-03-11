import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const io = new Server(server);

let openai;
function getOpenAI() {
  if (!openai) {
    console.log('OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY);
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Room state: { roomId: { speaker: socketId, sourceLang, targetLang, listenerCount } }
const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex'); // 6-char hex code
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Speaker creates a room
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

  // Listener joins a room
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

    callback({
      sourceLang: room.sourceLang,
      targetLang: room.targetLang
    });

    // Notify speaker of listener count
    io.to(room.speaker).emit('listener-count', room.listenerCount);
    console.log(`Listener joined room ${roomId}. Count: ${room.listenerCount}`);
  });

  // Speaker updates languages
  socket.on('update-languages', ({ sourceLang, targetLang }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.speaker !== socket.id) return;

    room.sourceLang = sourceLang;
    room.targetLang = targetLang;

    // Notify listeners of language change
    socket.to(roomId).emit('languages-updated', { sourceLang, targetLang });
  });

  // Speaker sends recognized text for translation
  socket.on('translate', async ({ text }, callback) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.speaker !== socket.id) return;

    try {
      const response = await getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [{
          role: 'system',
          content: `You are a translator. Translate the following text from ${room.sourceLang} to ${room.targetLang}. Output ONLY the translation, nothing else.`
        }, {
          role: 'user',
          content: text
        }]
      });

      const translated = response.choices[0].message.content.trim();

      // Send translation to speaker
      callback({ translated });

      // Broadcast to all listeners in the room
      socket.to(roomId).emit('translation', { original: text, translated });

    } catch (err) {
      console.error('Translation error:', err.message);
      callback({ error: err.message });
    }
  });

  // Speaker sends interim text (for live display on listeners)
  socket.on('interim', (text) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit('interim', text);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;

    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);

      if (role === 'speaker') {
        // Notify listeners that the speaker left
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
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
