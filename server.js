const express = require("express");
const bodyParser = require("body-parser");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const redis = new Redis({
  host: "devcs.co.kr",
  port: 10038,
  password: "",
});
const app = express();
const port = process.env.PORT || 3001;
const mongoose = require("mongoose");
const { default: axios } = require("axios");
const e = require("express");
mongoose.connect("mongodb://devcs.co.kr:10039/chat", {
  // useNewUrlParser: true,
  // useUnifiedTopology: true,
});
const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
  },
  meberId1: {
    type: String,
    require: true,
  },
  memberId2: {
    type: String,
    require: true,
  },
  messages: [
    {
      messageId: String,
      senderId: Number,
      content: String,
      readFlag: { type: Boolean, default: false },
      timestamp: { type: Date, default: Date.now },
    },
  ],
});
const Room = mongoose.model("Room", roomSchema);

const CHAT_EVENT = {
  FIRST_CONNECT: "first connect",
  SEND_MESSAGE: "send message",
  RECEIVED_MESSAGE: "received message",
  MESSAGE_LIST: "message list",
  JOIN_ROOM: "join room",
  LEAVE_ROOM: "leave room",

  EVENT_ALERT: "event alert",
};

app.use(bodyParser.json());
app.get("/test", (req, res) => {
  const { token } = req.body;
  // console.log(req.headers.authorization);
  console.log(token);
  console.log(jwt.decode(token));
  console.log(
    jwt.verify(
      token,
      "kogumakogumasecuritysecuritykogumakogumaserviceservicekogumakoguma"
    )
  );
});
// memberId에 해당되는 읽지 않은 모든 메시지의 수
// jwt 보안 적용 해야함!
app.get("/unread/count", (req, res) => {
  let count = 0;
  (async () => {
    const { memberId } = req.body;
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
// jwt 보안 적용 해야함!
app.get("/unread/count/:roomId", (req, res) => {
  let count = 0;
  const { memberId } = req.body;
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
// jwt 보안 적용 해야함!
app.get("/latestMessage/:roomId", (req, res) => {
  const { memberId } = req.body;
  const roomId = req.params.roomId;
  (async () => {
    try {
      const latestDocument = await Room.findOne({ roomId })
        .sort({ "messages.timestamp": 1 })
        .select({ messages: { $slice: -1 } });
      const latestMessage = latestDocument.messages[0];
      res.json({ latestMessage });
    } catch (err) {
      console.log(err);
    }
  })();
});
const validationToken = (token) => {
  return jwt.verify(
    token,
    "kogumakogumasecuritysecuritykogumakogumaserviceservicekogumakoguma"
  )["id"];
};

const server = app.listen(port, function () {
  console.log("Listening on " + port);
});
const io = require("socket.io")(server, { cors: { origin: "*" } });

let user_list = {};
io.on("connection", (socket) => {
  console.log(`connect : ${socket.id}`);

  socket.on(CHAT_EVENT.FIRST_CONNECT, (data) => {
    console.log(data.token);
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
  });

  socket.on(CHAT_EVENT.JOIN_ROOM, async ({ roomId, token }) => {
    console.log(`room join : ${roomId}`);
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
    socket.join(roomId);
    if (room) {
      io.to(roomId).emit(CHAT_EVENT.MESSAGE_LIST, room.messages);
    }
  });

  socket.on(CHAT_EVENT.SEND_MESSAGE, async (data) => {
    // 해당 room에 누가 접속하고 있는지 소켓 아이디 정보
    const clientsInRoom = io.sockets.adapter.rooms.get(data.roomId);
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
    // 채팅방이 없으면 생성
    if (!room) {
      room = new Room({
        roomId: data.roomId,
        memberId1: memberId,
        memberId2: data.toId,
        messages: [],
      });
    }
    // if(room.memberId1 === )
    console.log(room);
    const message = {
      messageId: uuidv4(),
      senderId: memberId,
      content: data.message,
    };

    // 상대방의 소켓 아이디가 채팅방에 접속되어있다면 전송할 메시지를 즉시 읽음 처리
    if (clientsInRoom.has(user_list[`${data.toId}`])) {
      message.readFlag = true;
    }

    // mongo에 채팅방에 메시지 저장
    room.messages.push(message);
    await room.save();

    if (!message.readFlag) {
      // 상대방이 읽지 않았을 때는 채팅방에 접속되어 있지 않다는 의미이니
      // redis에 알림을 추가한다. 이 알림은 읽지 않은 메시지의 수를 계산할 때 쓰일 수 있다.
      // 각 roomId에 알림 수는 채팅방 리스트에서 읽지 않은 메시지 수를 표현할 수 있고,
      // 모든 roomId에 알림 수는 채팅방 아이콘 옆에 모든 읽지 않은 메시지 수를 표현할 수 있다.
      redis
        .hget(data.toId, data.roomId)
        .then((result) => {
          let unread_messages = JSON.parse(result);
          if (unread_messages === null) {
            // 알림이 없었다면 리스트 타입으로 메시지를 감싸고 직렬화하여 redis 저장.
            unread_messages = JSON.stringify([message]);
          } else {
            // 알림이 있다면 리스트에 메시지 정보 push한 뒤 직렬화하여 redis 저장.
            unread_messages.push(message);
            unread_messages = JSON.stringify(unread_messages);
          }
          // 직렬화 된 메시지 리스트 redis에 저장
          redis
            .hmset(data.toId, data.roomId, unread_messages)
            .then(() => {
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

    io.to(data.roomId).emit(CHAT_EVENT.RECEIVED_MESSAGE, message);
    io.to(user_list[`${data.toId}`]).emit(CHAT_EVENT.EVENT_ALERT, message);
    // socket.broadcast.emit(CHAT_EVENT.RECEIVED_ALERT);
  });

  socket.on(CHAT_EVENT.LEAVE_ROOM, ({ roomId }) => {
    socket.leave(roomId);
  });
});
