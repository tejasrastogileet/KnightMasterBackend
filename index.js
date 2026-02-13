import dotenv from "dotenv";
dotenv.config();

console.log("MONGODB_URI:", process.env.MONGODB_URI);

import express from 'express';
import cors from 'cors';
import { createServer } from "http";
import { Server } from "socket.io";
import { Chess } from 'chess.js';
import connectDB from "./src/database/mongoose.js";
import userRouter from './src/features/users/user.routes.js';
import gameRouter from './src/features/games/game.routes.js';
import Game from "./src/features/games/game.schema.js";
import analyzeMove from './src/helper/analyse.js';
import { getGeminiCommentary, getPromptTemplate } from "./src/features/commentary.js";
import User from "./src/features/users/user.schema.js";
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';


const app = express();
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://chess-frontend-opal.vercel.app',
      'https://chess-frontend-git-main-tejas-rastogis-projects-2b4328f1.vercel.app',
      'https://chess-frontend-5vqklh83i-tejas-rastogis-projects-2b4328f1.vercel.app',
      'http://localhost:5173',
      'http://127.0.0.1:5173'
    ];
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log("Blocked by CORS:", origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get('/api/auth/me', async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    res.json({ user, token });
  } catch (err) {
    res.status(403).json({ message: 'Invalid token' });
  }
});

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeConnections: io.engine.clientsCount
  });
});

// API Routes
app.use('/api/users', userRouter);
app.use('/api/games', gameRouter);

// Diagnostic endpoint - check room state
app.get('/api/debug/rooms', (req, res) => {
  const roomInfo = Object.keys(rooms).map(roomId => ({
    roomId,
    players: rooms[roomId].map(p => ({ socketId: p.socketId, userId: p.userId, color: p.color }))
  }));
  res.json({ totalRooms: Object.keys(rooms).length, rooms: roomInfo, connectedClients: io.engine.clientsCount });
});

// Diagnostic endpoint - check game state
app.get('/api/debug/game/:gameId', async (req, res) => {
  try {
    const game = await Game.findById(req.params.gameId);
    if (!game) return res.status(404).json({ error: "Game not found" });
    res.json(game);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/commentary', async (req, res) => {
  try {
    const { mode, move, fen, lastMoves, isUserMove } = req.body.prompt;
    const prompt = getPromptTemplate(mode, { move, fen, lastMoves, isUserMove });
    const commentary = await getGeminiCommentary(prompt);
    res.status(200).json({ commentary });
  } catch (err) {
    console.error("Error generating commentary:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const http = createServer(app);
const io = new Server(http, {
  cors: {
    origin: [
      'https://chess-frontend-opal.vercel.app',
      'https://chess-frontend-git-main-tejas-rastogis-projects-2b4328f1.vercel.app',
      'https://chess-frontend-5vqklh83i-tejas-rastogis-projects-2b4328f1.vercel.app',
      'http://localhost:5173',
      'http://127.0.0.1:5173'
    ],
    credentials: true,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  secure: true,
  rejectUnauthorized: false,
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 60000,
  upgradeTimeout: 10000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: {
    threshold: 1024 * 64
  }
});


const rooms = {};

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on("joinRoom", async ({ userId, roomId, color }) => {
    try {
      // Validation
      if (!userId || !roomId) {
        console.error("Missing userId or roomId");
        socket.emit("errorMessage", "Invalid request: userId and roomId are required.");
        return;
      }

      if (!rooms[roomId]) {
        console.log(`[JOIN] Creating new room: ${roomId}`);
        rooms[roomId] = [];
      }

      // Check if user is already in the room
      const isAlreadyJoined = rooms[roomId].some(player => player.userId === userId);
      if (isAlreadyJoined) {
        console.log(`[JOIN] User ${userId} already in room ${roomId}`);
        socket.emit("errorMessage", "You are already in this room.");
        return;
      }

      // Get current players (excluding this user if they somehow got in)
      let players = rooms[roomId].filter(p => p.userId !== userId);

      // Check if room is full
      if (players.length >= 2) {
        console.log(`[JOIN] Room ${roomId} is full`);
        socket.emit("errorMessage", "Room is full.");
        return;
      }

      // Assign color
      const takenColors = players.map(p => p.color);
      if (!color || color === "random") {
        color = players.length === 0
          ? (Math.random() < 0.5 ? "white" : "black")
          : (takenColors.includes("white") ? "black" : "white");
      }

      if (takenColors.includes(color)) {
        console.log(`[JOIN] Color ${color} already taken in room ${roomId}`);
        socket.emit("errorMessage", `Color ${color} already taken.`);
        return;
      }

      // Add player to room
      players.push({ socketId: socket.id, userId, color });
      rooms[roomId] = players;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.userId = userId;

      console.log(`[JOIN] User ${userId} (socket ${socket.id}) joined room ${roomId} as ${color}. Room now has ${rooms[roomId].length} players.`);

      socket.emit("assignedColor", color);
      socket.to(roomId).emit("playerJoined", { message: `${userId} joined as ${color}` });

      // If both players are now in the room
      if (rooms[roomId].length === 2) {
        const firstPlayer = rooms[roomId].find(p => p.socketId !== socket.id);
        if (firstPlayer) {
          io.to(firstPlayer.socketId).emit("opponentJoined", {
            message: `${userId} joined as ${color}`,
            opponentSocketId: socket.id,
            opponentUserId: userId,
            opponentColor: color,
            shouldInitiateCall: true
          });
        }

        socket.emit("opponentJoined", {
          message: `${firstPlayer.userId} is already here as ${firstPlayer.color}`,
          opponentSocketId: firstPlayer.socketId,
          opponentUserId: firstPlayer.userId,
          opponentColor: firstPlayer.color,
          shouldInitiateCall: false
        });

        const whitePlayer = rooms[roomId].find(p => p.color === 'white');
        const blackPlayer = rooms[roomId].find(p => p.color === 'black');

        if (!whitePlayer || !blackPlayer) {
          console.error("[JOIN] Error: Could not find both players after room join");
          socket.emit("errorMessage", "Error setting up game.");
          return;
        }

        let game = await Game.findOne({
          $or: [
            { playerWhite: whitePlayer.userId, playerBlack: blackPlayer.userId },
            { playerWhite: blackPlayer.userId, playerBlack: whitePlayer.userId }
          ],
          status: 'onGoing'
        });

        if (!game) {
          game = await Game.create({
            playerWhite: whitePlayer.userId,
            playerBlack: blackPlayer.userId,
            moves: [],
            status: 'onGoing',
            winner: null,
            whiteTimeLeft: 600,
            blackTimeLeft: 600,
            turn: 'white',
            lastMoveTimestamp: Date.now()
          });
          console.log(`[JOIN] Created new game ${game._id} for room ${roomId}`);
        } else {
          console.log(`[JOIN] Resumed existing game ${game._id} for room ${roomId}`);
        }

        const chess = new Chess();
        for (const move of game.moves) chess.move(move);

        rooms[roomId].forEach(player => {
          const opponent = rooms[roomId].find(p => p.socketId !== player.socketId);
          console.log(`[JOIN] Emitting bothPlayersJoined to ${player.socketId}, opponent: ${opponent?.socketId}`);
          io.to(player.socketId).emit("bothPlayersJoined", {
            gameId: game._id.toString(),
            moves: game.moves,
            fen: chess.fen(),
            opponentSocketId: opponent?.socketId || null,
            opponentUserId: opponent?.userId || null,
            opponentColor: opponent?.color || null,
            whiteTimeLeft: game.whiteTimeLeft,
            blackTimeLeft: game.blackTimeLeft
          });
        });
      }
    } catch (error) {
      console.error("[JOIN] Error in joinRoom:", error.message, error.stack);
      socket.emit("errorMessage", "An error occurred while joining the room.");
    }
  });

  socket.on("Draw", ({ roomId }) => {
    try {
      if (!roomId) {
        console.error("Draw event missing roomId");
        return;
      }
      console.log(`[DRAW] Draw offer sent in room ${roomId}`);
      // ✓ FIXED: Broadcast to all in room so both see offer
      io.to(roomId).emit("Opponent Draw");
    } catch (error) {
      console.error("Error in Draw event:", error);
    }
  });

  socket.on("Resign", async ({ roomId, gameId, userId }) => {
    try {
      if (!roomId || !gameId || !userId) {
        console.error("Resign event missing required fields");
        socket.emit("errorMessage", "Invalid resign request.");
        return;
      }

      const game = await Game.findById(gameId);
      if (!game) {
        console.error(`Game ${gameId} not found`);
        socket.emit("errorMessage", "Cannot find the game");
        return;
      }

      game.status = "finished";
      if (game.playerWhite.toString() === userId) {
        game.winner = game.playerBlack;
      } else {
        game.winner = game.playerWhite;
      }

      await game.save();
      console.log(`[RESIGN] User ${userId} resigned in game ${gameId}`);
      
      // ✓ FIXED: Broadcast to ALL in room, not just opponent
      // Both players need to see game over state
      io.to(roomId).emit("gameOver", {
        reason: "resignation",
        winner: game.winner,
        gameId: gameId
      });
    } catch (error) {
      console.error("Error in Resign event:", error);
      socket.emit("errorMessage", "An error occurred while resigning.");
    }
  });

  socket.on("DrawAccepted", async ({ roomId, gameId }) => {
    try {
      if (!roomId || !gameId) {
        console.error("DrawAccepted event missing required fields");
        socket.emit("errorMessage", "Invalid draw accept request.");
        return;
      }

      const game = await Game.findById(gameId);
      if (!game) {
        console.error(`Game ${gameId} not found`);
        socket.emit("errorMessage", "Cannot find the game");
        return;
      }

      game.status = "draw";
      await game.save();
      console.log(`[DRAW] Draw accepted in game ${gameId}`);
      // ✓ FIXED: Broadcast to all in room
      io.to(roomId).emit("DrawAccepted");
    } catch (error) {
      console.error("Error in DrawAccepted event:", error);
      socket.emit("errorMessage", "An error occurred while accepting draw.");
    }
  });

  socket.on("DrawDeclined", ({ roomId }) => {
    try {
      if (!roomId) {
        console.error("DrawDeclined event missing roomId");
        return;
      }
      console.log(`[DRAW] Draw declined in room ${roomId}`);
      // ✓ FIXED: Broadcast to all in room
      io.to(roomId).emit("DrawDeclined");
    } catch (error) {
      console.error("Error in DrawDeclined event:", error);
    }
  });

  socket.on("SendMove", async ({ move, gameId, userId, roomId, timeLeft }) => {
    try {
      if (!roomId || !gameId || !userId) {
        console.error("SendMove missing required fields:", { roomId, gameId, userId });
        socket.emit("moveRejected", { error: "Missing required fields" });
        return;
      }

      const objectId = Types.ObjectId.isValid(gameId) ? new Types.ObjectId(gameId) : gameId;

      const game = await Game.findById(objectId);
      if (!game) {
        console.error(`Game ${gameId} not found`);
        socket.emit("moveRejected", { error: "Game not found" });
        return;
      }

      const now = Date.now();
      const elapsed = Math.floor((now - game.lastMoveTimestamp) / 1000);

      if (game.turn === 'white') {
        game.whiteTimeLeft -= elapsed;
        console.log(`[MOVE] White time left: ${game.whiteTimeLeft}`);
        if (game.whiteTimeLeft <= 0) {
          game.status = 'finished';
          game.winner = game.playerBlack;

          await game.save();

          // ✓ FIXED: Broadcast to room, not userId (which is not a Socket.IO target)
          io.to(roomId).emit("gameOver", {
            reason: "timeout",
            winner: game.playerBlack,
            gameId: gameId
          });

          return;
        }
      } else {
        game.blackTimeLeft -= elapsed;
        if (game.blackTimeLeft <= 0) {
          game.status = 'finished';
          game.winner = game.playerWhite;

          await game.save();

          // ✓ FIXED: Broadcast to room, not userId (which is not a Socket.IO target)
          io.to(roomId).emit("gameOver", {
            reason: "timeout",
            winner: game.playerWhite,
            gameId: gameId
          });

          return;
        }
      }

      game.turn = game.turn === 'white' ? 'black' : 'white';
      game.lastMoveTimestamp = now;

      const chess = new Chess();
      for (const m of game.moves) chess.move(m);

      const isWhitesTurn = chess.turn() === 'w';
      const isUserTurn = (
        (isWhitesTurn && game.playerWhite.toString() === userId) ||
        (!isWhitesTurn && game.playerBlack.toString() === userId)
      );

      if (!isUserTurn) {
        console.error(`[MOVE] Not user's turn. IsWhitesTurn: ${isWhitesTurn}, PlayerWhite: ${game.playerWhite}, PlayerBlack: ${game.playerBlack}, UserId: ${userId}`);
        socket.emit("moveRejected", { error: "Not your turn!" });
        return;
      }

      const result = chess.move(move);
      if (!result) {
        console.error(`[MOVE] Illegal move: ${move}`);
        socket.emit("moveRejected", { error: "Illegal move!" });
        return;
      }

      game.moves.push(result.san);

      const { moveQuality } = await analyzeMove(game, game.moves.slice(0, -1), move);

      if (moveQuality && game[moveQuality]) {
        if (isWhitesTurn) {
          game[moveQuality].playerWhite += 1;
        } else {
          game[moveQuality].playerBlack += 1;
        }
      }

      if (chess.isGameOver()) {
        if (chess.isDraw()) {
          game.status = "draw";
          game.winner = null;
        } else {
          game.status = "finished";
          game.winner = chess.turn() === "w" ? game.playerBlack : game.playerWhite;
        }
      }

      const updatedGame = await game.save();
      const moveUpdate = {
        move: result,
        fen: chess.fen(),
        gameStatus: updatedGame.status,
        winner: updatedGame.winner || null,
        allMoves: updatedGame.moves,
        whiteTimeLeft: game.whiteTimeLeft,
        blackTimeLeft: game.blackTimeLeft
      };

      console.log(`[MOVE] User ${userId} played ${result.san} in room ${roomId}. Broadcasting update.`);
      
      // ✓ FIXED: Use io.to(roomId) to send to ALL players in room, not just opponent
      // Chat works because messages go to opponent; moves MUST sync to both players
      io.to(roomId).emit("receiveMove", moveUpdate);
    } catch (err) {
      console.error("[MOVE] Error:", err.message, err.stack);
      socket.emit("moveRejected", { error: "Server error: " + err.message });
    }
  });

  socket.on("SendMessage", ({ message, roomId }) => {
    try {
      if (!roomId || !message) {
        console.error("SendMessage event missing required fields");
        return;
      }
      const serverMessage = { message, time: new Date().toISOString() };
      socket.to(roomId).emit("ReceiveMessage", serverMessage);
    } catch (error) {
      console.error("Error in SendMessage event:", error);
    }
  });

  socket.on("call-user", ({ targetSocketId, offer }) => {
    try {
      if (!targetSocketId || !offer) {
        console.error("[WEBRTC] call-user missing fields");
        return;
      }
      console.log(`[WEBRTC] ${socket.id} sending offer to ${targetSocketId}`);
      io.to(targetSocketId).emit("incoming-call", { from: socket.id, offer });
    } catch (error) {
      console.error("[WEBRTC] Error in call-user:", error);
    }
  });

  socket.on("answer-call", ({ targetSocketId, answer }) => {
    try {
      if (!targetSocketId || !answer) {
        console.error("[WEBRTC] answer-call missing fields");
        return;
      }
      console.log(`[WEBRTC] ${socket.id} sending answer to ${targetSocketId}`);
      io.to(targetSocketId).emit("call-answered", { from: socket.id, answer });
    } catch (error) {
      console.error("[WEBRTC] Error in answer-call:", error);
    }
  });

  socket.on('reconnect-call', ({ targetSocketId }) => {
    try {
      if (!targetSocketId) {
        console.error("[WEBRTC] reconnect-call missing targetSocketId");
        return;
      }
      console.log(`[WEBRTC] ${socket.id} requesting reconnect to ${targetSocketId}`);
      io.to(targetSocketId).emit('reconnect-call', { from: socket.id });
    } catch (error) {
      console.error("[WEBRTC] Error in reconnect-call:", error);
    }
  });

  socket.on("ice-candidate", ({ targetSocketId, candidate }) => {
    try {
      if (!targetSocketId || !candidate) {
        console.error("[WEBRTC] ice-candidate missing fields");
        return;
      }
      console.log(`[WEBRTC] ${socket.id} sending ICE candidate to ${targetSocketId}`);
      io.to(targetSocketId).emit("ice-candidate", { from: socket.id, candidate });
    } catch (error) {
      console.error("[WEBRTC] Error in ice-candidate:", error);
    }
  });

  socket.on("end-call", ({ targetSocketId }) => {
    try {
      if (!targetSocketId) {
        console.error("[WEBRTC] end-call missing targetSocketId");
        return;
      }
      console.log(`[WEBRTC] ${socket.id} ending call with ${targetSocketId}`);
      io.to(targetSocketId).emit("call-ended", { from: socket.id });
    } catch (error) {
      console.error("[WEBRTC] Error in end-call:", error);
    }
  });


  socket.on("disconnect", () => {
    const roomId = socket.data.roomId; // Get the roomId from socket.data

    if (roomId && rooms[roomId]) {
      // Find the opponent before removing the disconnected player
      const opponent = rooms[roomId].find(player => player.socketId !== socket.id);

      // Remove the disconnected player from the room
      rooms[roomId] = rooms[roomId].filter(player => player.socketId !== socket.id);

      // If an opponent was found, notify them
      if (opponent) {
        console.log(`Notifying ${opponent.socketId} that ${socket.id} has disconnected.`);
        io.to(opponent.socketId).emit("opponent-disconnected", { opponentSocketId: socket.id });
      }

      // Clean up the room if it's now empty
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} is now empty and has been deleted.`);
      }
    }
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || process.env.PORT_NO || 3000;

http.listen(PORT, () => {
  console.log("Server started on port", PORT);
  connectDB();
});
