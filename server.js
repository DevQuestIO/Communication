// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
const server = http.createServer(app);

// MongoDB Connection
mongoose.connect('mongodb+srv://kalpeshpatil:aAizV2usnKqFAXnY@messaging.qnujm.mongodb.net/?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
  friends: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  pendingSentRequests: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  pendingReceivedRequests: [{  // Added this field
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  socketId: String
});

const User = mongoose.model('User', userSchema);
console.log('User', User)

// Message Schema
const messageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  receiver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  content: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const Message = mongoose.model('Message', messageSchema);

// Middleware
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST"],
  credentials: true
}));

app.use(express.json());

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});


  // Socket connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', async (username) => {
    try {
      const user = await User.findOneAndUpdate(
        { username },
        { isActive: true, lastSeen: new Date(), socketId: socket.id },
        { new: true }
      );
      debugger;
      console.log('User',user);
      if (user) {
        socket.join(user._id.toString()); // Join a unique room for this user
        socket.broadcast.emit('newUserLoggedIn', user);
        io.emit('userStatusChanged', { userId: user._id, isActive: true });
      }
    } catch (error) {
      console.error('Join error:', error);
    }
  });
  

  socket.on('sendMessage', async (data) => {
    try {
      const newMessage = new Message({
        sender: data.sender,
        receiver: data.receiver,
        content: data.content,
      });
      await newMessage.save();
      
      console.log('Inside server.js');
      const receiver = await User.findById(data.receiver);
      if (receiver && receiver.socketId) {
        io.to(receiver.socketId).emit('newMessage', newMessage);
        
        // Emit notification for the new message
        io.to(receiver.socketId).emit('notification', {
          type: 'newMessage',
          message: `New message from ${data.senderUsername}`,
        });
      }
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });
  

  socket.on('disconnect', async () => {
    try {
      const user = await User.findOneAndUpdate(
        { socketId: socket.id },
        { isActive: false, lastSeen: new Date() },
        { new: true }
      );
      if (user) {
        io.emit('userStatusChanged', { userId: user._id, isActive: false });
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });


  });  


// API Routes
app.post('/api/users/login', async (req, res) => {
  try {
    const { username } = req.body;
    let user = await User.findOne({ username });

    if (!user) {
      user = new User({ username });
      await user.save();
    }

    user.isActive = true;
    user.lastSeen = new Date();
    await user.save();

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({});
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/messages/:senderId/:receiverId', async (req, res) => {
  try {
    const { senderId, receiverId } = req.params;
    const messages = await Message.find({
      $or: [
        { sender: senderId, receiver: receiverId },
        { sender: receiverId, receiver: senderId }
      ]
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/friend-request', async (req, res) => {
  try {
    const { fromUserId, toUserId } = req.body;
    const [fromUser, toUser] = await Promise.all([
      User.findById(fromUserId),
      User.findById(toUserId),
    ]);

    if (!toUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (
      toUser.pendingReceivedRequests.includes(fromUserId) ||
      fromUser.pendingSentRequests.includes(toUserId)
    ) {
      return res.status(400).json({ error: 'Request already pending' });
    }

    fromUser.pendingSentRequests.push(toUserId);
    toUser.pendingReceivedRequests.push(fromUserId);

    await Promise.all([fromUser.save(), toUser.save()]);

    // Emit event only to receiver
    if (toUser.socketId) {
      io.to(toUser.socketId).emit('friendRequest', {
        fromUserId,
        fromUsername: fromUser.username,
      });
    }

    // Emit notification event
    io.to(toUser.socketId).emit('notification', {
      type: 'friendRequest',
      message: `${fromUser.username} sent you a friend request.`,
    });


    res.json({ message: 'Friend request sent' });
  } catch (error) {
    console.error('Friend request error:', error);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});


app.post('/api/accept-friend', async (req, res) => {
  try {
    const { fromUserId, toUserId } = req.body;
    const [fromUser, toUser] = await Promise.all([
      User.findById(fromUserId),
      User.findById(toUserId)
    ]);

    // Add to friends lists
    fromUser.friends.push(toUserId);
    toUser.friends.push(fromUserId);

    // Remove from pending requests
    fromUser.pendingSentRequests = fromUser.pendingSentRequests.filter(
      id => id.toString() !== toUserId
    );
    toUser.pendingReceivedRequests = toUser.pendingReceivedRequests.filter(
      id => id.toString() !== fromUserId
    );

    await Promise.all([fromUser.save(), toUser.save()]);

    // Notify both users
    io.to(fromUser.socketId).emit('friendRequestAccepted', { userId: toUserId });
    io.to(toUser.socketId).emit('friendRequestAccepted', { userId: fromUserId });

    res.json({ message: 'Friend request accepted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to accept friend request' });
  }
});

app.post('/api/reject-friend', async (req, res) => {
  try {
    const { fromUserId, toUserId } = req.body;
    const toUser = await User.findById(toUserId);
    
    toUser.pendingRequests = toUser.pendingRequests.filter(
      id => id.toString() !== fromUserId
    );
    await toUser.save();
    
    io.to(fromUserId).emit('friendRequestRejected', { userId: toUserId });
    res.json({ message: 'Friend request rejected' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reject friend request' });
  }
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

