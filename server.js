require("dotenv").config();
const express = require("express");
const https = require("https");
const bodyParser = require("body-parser");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const fs = require("fs");
const offset = 1000 * 60 * 60 * 9;
const koreaNow = () => new Date(new Date().getTime() + offset);
const redis = new Redis({
  host: process.env.CHAT_REDIS_HOST,
  password: process.env.CHAT_REDIS_PASSWORD,
  port: process.env.CHAT_REDIS_PORT,
  password: process.env.CHAT_REDIS_PASSWORD,
  enableOfflineQueue: false,
});
const app = express();
let server;
const port = process.env.PORT;
try {
  const options = {
    key: fs.readFileSync("./private.key"),
    cert: fs.readFileSync("./chain.crt"),
  };
  server = https.createServer(options, app);
  server.listen(port, () => {
    console.log("HTTPS server listening on port " + port);
  });
} catch (err) {
  server = app.listen(port, function () {
    console.log("Listening on " + port);
  });
}
// const server = app.listen(port, function () {
//   console.log("Listening on " + port);
// });

// const server = https.createServer(options, app);

// const server = require("http").createServer(app);
const mongoose = require("mongoose");
const { default: axios } = require("axios");
mongoose.connect(process.env.CHAT_MONGO_HOST, {
  // useNewUrlParser: true,
  // useUnifiedTopology: true,
});
const roomSchema = new mongoose.Schema({
  roomId: {
    type: Number,
    required: true,
  },
  memberId1: {
    type: Number,
    require: true,
  },
  memberId2: {
    type: Number,
    require: true,
  },
  messages: [
    {
      messageId: String,
      senderId: Number,
      content: String,
      type: { type: String, default: "TEXT" },
      readFlag: { type: Boolean, default: false },
      timestamp: {
        type: Date,
        default: koreaNow,
      },
    },
  ],
});
const Room = mongoose.model("Room", roomSchema);

const findRoomById = async (roomId) => {
  try {
    const room = await Room.findOne({ roomId });

    if (!room) {
      console.log("Room not found");
      return null;
    }

    return room;
  } catch (error) {
    console.error("Error finding room:", error);
    throw error;
  }
};

// roomId를 사용하여 buyerId와 senderId 조회
const findOpponentMemberIdsByRoomId = async (roomId, memberId) => {
  try {
    const room = await findRoomById(roomId);

    if (!room) {
      return null;
    }
    const { memberId1, memberId2 } = room;
    if (memberId === memberId1) return memberId2;
    else return memberId1;
  } catch (error) {
    console.error("Error finding member ids:", error);
    throw error;
  }
};

const CHAT_EVENT = {
  FIRST_CONNECT: "first connect",
  SEND_MESSAGE: "send message",
  RECEIVED_MESSAGE: "received message",
  MESSAGE_LIST: "message list",
  JOIN_ROOM: "join room",
  LEAVE_ROOM: "leave room",
  IS_WRITING: "is writing",
  EVENT_ALERT: "event alert",
  EVENT_CHAT_LIST_ALERT: "event alert1",
  EVENT_BOTTOM_ALERT: "event alert2",
  NEW_MESSAGE: "new message",
  UPDATE_MESSAGE: "update message",
};
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
    "application/json",
    "text/plain"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});
app.use(bodyParser.json());
// memberId에 해당되는 읽지 않은 모든 메시지의 수
app.get("/unread/count", (req, res) => {
  let count = 0;
  const token = req.headers.authorization;
  let memberId;
  try {
    memberId = validationToken(token.split(" ")[1]);
  } catch (err) {
    console.log(err);
    return;
  }
  (async () => {
    try {
      const keys = await redis.hkeys(memberId);
      for (const roomId of keys) {
        await redis.hget(memberId, roomId).then((result) => {
          if (result) {
            count += JSON.parse(result).length;
          }
        });
      }
    } catch (err) {
      console.log(err);
    }
    res.json({ count });
  })();
});

// memberId에 roomId에 해당되는 읽지 않은 메시지의 수
app.get("/unread/count/:roomId", (req, res) => {
  let count = 0;
  const token = req.headers.authorization;
  let memberId;
  try {
    memberId = validationToken(token.split(" ")[1]);
  } catch (err) {
    console.log(err);
    return;
  }
  const roomId = req.params.roomId;
  (async () => {
    try {
      await redis.hget(memberId, roomId).then((result) => {
        if (result) {
          count += JSON.parse(result).length;
        }
      });
    } catch (err) {
      console.log(err);
    }
    res.json({ count });
  })();
});

// 해당 roomId에 가장 마지막 메시지만 가져오기
app.get("/latestMessage/:roomId", (req, res) => {
  const token = req.headers.authorization;
  let memberId;
  try {
    memberId = validationToken(token.split(" ")[1]);
  } catch (err) {
    console.log(err);
    return;
  }
  const roomId = req.params.roomId;
  (async () => {
    try {
      const latestDocument = await Room.findOne({ roomId })
        .sort({ "messages.timestamp": 1 })
        .select({ messages: { $slice: -1 } });
      console.log(roomId);
      console.log(latestDocument);
      const latestMessage = latestDocument.messages[0];
      res.json({ latestMessage });
    } catch (err) {
      console.log(err);
    }
  })();
});
const validationToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET_KEY)["id"];
};

const io = require("socket.io")(server, {
  pingInterval: 10000, // 10초마다 서버로 ping을 보냄
  pingTimeout: 5000,
  cors: { origin: "*" },
});
let user_list = {};
io.on("connection", (socket) => {
  console.log(`connect : ${socket.id}`);
  socket.on(CHAT_EVENT.FIRST_CONNECT, (data) => {
    console.log("FIRST_CONNECT START");
    // 어떤 사용자가 어떤 소켓 아이디를 가지는 지 확인을 위한 user_list
    if (data.token) {
      try {
        const memberId = validationToken(data.token.split(" ")[1]);
        user_list[`${memberId}`] = socket.id;
        console.log(user_list);
      } catch (err) {
        console.log(err);
      }
    }
    console.log("FIRST_CONNECT END");
  });

  socket.on(CHAT_EVENT.JOIN_ROOM, async ({ roomId, token }) => {
    console.log("JOIN_ROOM START");
    roomId = parseInt(roomId);
    let memberId;
    if (token) {
      try {
        memberId = validationToken(token.split(" ")[1]);
      } catch (err) {
        console.log(err);
        return;
      }
    } else {
      return;
    }
    console.log(`memberId: ${memberId}, room join : ${roomId}`);
    // redis 알림 가져와서 읽음 처리
    await redis.hget(memberId, roomId).then(async (result) => {
      let unread_messages = JSON.parse(result);
      if (unread_messages !== null) {
        for (const message of unread_messages) {
          try {
            // 방 조회 및 메시지 업데이트
            const result = await Room.updateOne(
              { roomId, "messages.messageId": message.messageId },
              { $set: { "messages.$.readFlag": true } }
            );
            if (result.nModified === 0) {
              // 업데이트된 문서가 없을 경우 처리
              console.log("메시지를 업데이트할 수 없습니다.");
            } else {
              console.log("메시지가 업데이트되었습니다.");
            }
          } catch (error) {
            console.error("업데이트 중 에러 발생:", error);
          }
        }
      }
      try {
        // 알림 읽음 처리했으니 제거
        await redis.hdel(memberId, roomId);
      } catch (err) {
        console.log(err);
      }
    });

    // 현재 채팅방에 존재하는 메시지 전달
    const room = await Room.findOne({ roomId });
    await socket.join(roomId);
    if (room) {
      // await io.to(roomId).emit(CHAT_EVENT.MESSAGE_LIST, room.messages);
      await io
        .to(user_list[`${memberId}`])
        .emit(CHAT_EVENT.MESSAGE_LIST, room.messages);
    }
    console.log("JOIN_ROOM END");
  });

  socket.on(CHAT_EVENT.SEND_MESSAGE, async (data) => {
    console.log("SEND MESSAGE START");
    // 해당 room에 누가 접속하고 있는지 소켓 아이디 정보
    console.log("-----------------");
    data.roomId = parseInt(data.roomId);
    console.log(io.sockets.adapter.rooms.get(data.roomId));
    console.log(user_list);
    const clientsInRoom = io.sockets.adapter.rooms.get(data.roomId);
    if (data.roomId == null) {
      console.log("send message roomId 없음");
      return;
    }
    let room = await Room.findOne({ roomId: data.roomId });
    let memberId;
    if (data.token) {
      try {
        memberId = validationToken(data.token.split(" ")[1]);
      } catch (err) {
        console.log(err);
        return;
      }
    } else {
      return null;
    }
    let toId;
    if (data.toId) {
      toId = data.toId;
    } else {
      toId = await findOpponentMemberIdsByRoomId(data.roomId, memberId);
    }
    // 채팅방이 없으면 생성
    if (!room) {
      room = new Room({
        roomId: data.roomId,
        memberId1: memberId,
        memberId2: toId,
        messages: [],
      });
      await socket.join(data.roomId);
      console.log("입장");
    }
    // if(room.memberId1 === )
    // console.log(room);
    const message = {
      messageId: uuidv4(),
      senderId: memberId,
      content: data.message,
      roomId: room.roomId,
      timestamp:
        data.enter_date != null
          ? new Date(new Date(data.enter_date).getTime() + 1000 + offset)
          : koreaNow(),
    };
    if (data.type) {
      message.type = data.type;
    }
    // 상대방의 소켓 아이디가 채팅방에 접속되어있다면 전송할 메시지를 즉시 읽음 처리
    // console.log(clientsInRoom && clientsInRoom.has(user_list[`${toId}`]));
    // console.log(clientsInRoom);
    // console.log(clientsInRoom.has(user_list[`${toId}`]));
    if (clientsInRoom && clientsInRoom.has(user_list[`${toId}`])) {
      message.readFlag = true;
    }
    console.log(message);
    // mongo에 채팅방에 메시지 저장
    room.messages.push(message);
    await room.save();

    if (data.flag !== false && !message.readFlag) {
      // 상대방이 읽지 않았을 때는 채팅방에 접속되어 있지 않다는 의미이니
      // redis에 알림을 추가한다. 이 알림은 읽지 않은 메시지의 수를 계산할 때 쓰일 수 있다.
      // 각 roomId에 알림 수는 채팅방 리스트에서 읽지 않은 메시지 수를 표현할 수 있고,
      // 모든 roomId에 알림 수는 채팅방 아이콘 옆에 모든 읽지 않은 메시지 수를 표현할 수 있다.
      await redis
        .hget(toId, data.roomId)
        .then((result) => {
          let unread_messages = JSON.parse(result);
          if (unread_messages === null) {
            // 알림이 없었다면 리스트 타입으로 메시지를 감싸고 직렬화하여 redis 저장.
            unread_messages = JSON.stringify([
              { ...message, roomId: room.roomId },
            ]);
          } else {
            // 알림이 있다면 리스트에 메시지 정보 push한 뒤 직렬화하여 redis 저장.
            unread_messages.push({ ...message, roomId: room.id });
            unread_messages = JSON.stringify(unread_messages);
          }
          // 직렬화 된 메시지 리스트 redis에 저장
          redis
            .hmset(toId, data.roomId, unread_messages)
            .then(() => {
              console.log(toId, data.roomId, unread_messages);
              console.log("Messages stored successfully");
            })
            .catch((error) => {
              console.error("Error storing messages:", error);
            });
        })
        .catch((error) => {
          console.error("Error fetching messages:", error);
        });
    }

    await io.to(data.roomId).emit(CHAT_EVENT.RECEIVED_MESSAGE, message);
    if (data.flag === false) {
      return;
    }
    await io
      .to(user_list[`${toId}`])
      .emit(CHAT_EVENT.EVENT_CHAT_LIST_ALERT, message);
    await io
      .to(user_list[`${toId}`])
      .emit(CHAT_EVENT.EVENT_BOTTOM_ALERT, message);
    await io.to(user_list[`${toId}`]).emit(CHAT_EVENT.EVENT_ALERT, message);
    // socket.broadcast.emit(CHAT_EVENT.RECEIVED_ALERT);
  });

  // socket.on(CHAT_EVENT.NEW_MESSAGE, async () => {});

  socket.on(CHAT_EVENT.IS_WRITING, async (data) => {
    let memberId;
    if (data.roomId) {
      try {
        memberId = validationToken(data.token.split(" ")[1]);
      } catch (err) {
        console.log(err);
      }
      const toId = await findOpponentMemberIdsByRoomId(data.roomId, memberId);
      const clientsInRoom = io.sockets.adapter.rooms.get(data.roomId);
      if (clientsInRoom && clientsInRoom.has(user_list[`${toId}`])) {
        io.to(user_list[`${toId}`]).emit(
          CHAT_EVENT.IS_WRITING,
          data.flag != null ? data.flag : false
        );
      }
      // io.to(data.roomId).emit(
      //   CHAT_EVENT.IS_WRITING,

      // );
    }
  });

  socket.on(CHAT_EVENT.UPDATE_MESSAGE, async (data) => {
    try {
      const updatedRoom = await Room.findOneAndUpdate(
        { roomId: data.roomId, "messages.messageId": data.messageId },
        { $set: { "messages.$.content": data.content } },
        { new: true }
      ).exec();

      console.log("Content updated successfully:", updatedRoom);
      // Do something with the updated room object
    } catch (error) {
      console.error("Error updating content:", error);
      // Handle error
    }
  });

  socket.on(CHAT_EVENT.LEAVE_ROOM, async (data) => {
    if (data) {
      let memberId;
      try {
        memberId = validationToken(data.token.split(" ")[1]);
      } catch (err) {
        console.log(err);
      }
      const toId = await findOpponentMemberIdsByRoomId(data.roomId, memberId);
      // const toId = await findOpponentMemberIdsByRoomId(data.roomId);
      await io.to(user_list[`${toId}`]).emit(CHAT_EVENT.IS_WRITING, false);
      socket.leave(parseInt(data.roomId));
    }
  });
});
