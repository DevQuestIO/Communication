// server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MongoDB connection
const uri = `mongodb+srv://kalpeshpatil:aAizV2usnKqFAXnY@messaging.qnujm.mongodb.net/?retryWrites=true&w=majority&appName=Messaging`;

mongoose.connect(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB Atlas');
}).catch((err) => {
  console.error('MongoDB Atlas connection error:', err);
});

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to parse JSON bodies
app.use(express.json());

// Define User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  socketId: String,
});
const User = mongoose.model('User', userSchema);

// Define Message Schema
const messageSchema = new mongoose.Schema({
  conversationId: String,
  sender: String,
  receiver: String,
  message: String,
  fileName: String,
  filePath: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model('Message', messageSchema);

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

// Endpoint to handle file uploads
app.post('/upload', upload.single('file'), (req, res) => {
  res.json({
    fileName: req.file.filename,
    filePath: `/uploads/${req.file.filename}`,
  });
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Endpoint to handle reset request
app.post('/reset', async (req, res) => {
  try {
    // Delete all users and messages from the database
    await User.deleteMany({});
    await Message.deleteMany({});

    res.json({ success: true });
  } catch (err) {
    console.error('Error resetting the application:', err);
    res.json({ success: false });
  }
});

// Helper function to generate conversation IDs
function getConversationId(user1, user2) {
  return [user1, user2].sort().join('_');
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Handle user login
  socket.on('login', async (username) => {
    try {
      // Find or create the user
      let user = await User.findOne({ username });
      if (!user) {
        // User does not exist, create a new user
        user = new User({ username, socketId: socket.id });
        await user.save();
      } else {
        // User exists, update the socketId
        user.socketId = socket.id;
        await user.save();
      }

      // Attach username to socket
      socket.username = username;

      console.log(`${username} has logged in.`);

      // Get list of online users excluding the current user
      const users = await User.find({ username: { $ne: username }, socketId: { $ne: null } });
      socket.emit('userList', users.map((user) => ({
        id: user.username,
        username: user.username,
      })));

      // Notify other users that this user is online
      socket.broadcast.emit('userConnected', {
        id: username,
        username: username,
      });

      // Get list of users the logged-in user has had conversations with
      const conversations = await Message.aggregate([
        // Exclude messages where sender and receiver are the same (self-messages)
        { $match: { $and: [
          { $or: [{ sender: username }, { receiver: username }] },
          { sender: { $ne: username } }, // Exclude self-messages
          { receiver: { $ne: username } }
        ]}},
        {
          $group: {
            _id: {
              $cond: [
                { $ne: ["$sender", username] },
                "$sender",
                "$receiver",
              ],
            },
          },
        },
        { $project: { _id: 0, username: "$_id" } },
      ]);

      // Send conversation list to the logged-in client
      socket.emit('conversationList', conversations);
    } catch (err) {
      console.error('Login error:', err);
    }
  });

  // Handle text messages
  socket.on('message', async (data) => {
    try {
      // Prevent sending messages to self
      if (data.sender === data.receiver) {
        console.warn('User attempted to send a message to themselves.');
        return;
      }

      const conversationId = getConversationId(data.sender, data.receiver);
      const message = new Message({
        conversationId,
        sender: data.sender,
        receiver: data.receiver,
        message: data.message,
      });
      await message.save();

      // Send the message to the receiver
      const receiverUser = await User.findOne({ username: data.receiver });
      if (receiverUser && receiverUser.socketId) {
        io.to(receiverUser.socketId).emit('message', data);
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  // Handle media messages
  socket.on('media', async (data) => {
    try {
      // Prevent sending media to self
      if (data.sender === data.receiver) {
        console.warn('User attempted to send media to themselves.');
        return;
      }

      const conversationId = getConversationId(data.sender, data.receiver);
      const mediaMessage = new Message({
        conversationId,
        sender: data.sender,
        receiver: data.receiver,
        fileName: data.fileName,
        filePath: data.filePath,
      });
      await mediaMessage.save();

      // Send the media message to the receiver
      const receiverUser = await User.findOne({ username: data.receiver });
      if (receiverUser && receiverUser.socketId) {
        io.to(receiverUser.socketId).emit('media', data);
      }
    } catch (err) {
      console.error('Media message error:', err);
    }
  });

  // Handle chat history request
  socket.on('getHistory', async (data) => {
    try {
      const { receiver } = data;
      // Prevent fetching history with self
      if (socket.username === receiver) {
        console.warn('User attempted to fetch chat history with themselves.');
        socket.emit('chatHistory', { receiver, history: [] });
        return;
      }

      const conversationId = getConversationId(socket.username, receiver);
      const history = await Message.find({ conversationId }).sort('timestamp').lean();
      socket.emit('chatHistory', { receiver, history });
    } catch (err) {
      console.error('Get history error:', err);
    }
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    try {
      const username = socket.username;
      if (username) {
        // Update user's socketId to null
        await User.findOneAndUpdate({ username }, { socketId: null });
        console.log(`${username} has disconnected.`);

        // Notify other users that this user is offline
        socket.broadcast.emit('userDisconnected', { username });

        // Update online users list for remaining clients
        const users = await User.find({ username: { $ne: username }, socketId: { $ne: null } });
        io.emit('userList', users.map((user) => ({
          id: user.username,
          username: user.username,
        })));
      }
    } catch (err) {
      console.error('Disconnect error:', err);
    }
  });
});

// Start the server
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
