// [現状]
// Client
//  const namespace = '/xterm';
//  const path = '/socket.io';
//  const socket = io(namespace, { path: path });
// Server
//  const socketio = require('socket.io');
//  const path = [context || '', 'socket.io'].join('/');
//  const io = socketio(server, { path });
//  io.of(namespace).on('connect', (socket) => {});

// [使い方]
// Client
//   script(src = './socket.io/socket.io.js') // io
//   const multi = new MultiSokcet(io, NAMESPACE, OPTION);
//   const socket = multi.io(socketName);
// Server
//   const io = require('socket.io');
//   const server = http.createServer(app);
//   const multi = new MultiSokcet(io, NAMESPACE, OPTION, server);
//   multi.io(socketName).on('connection', (socket) => {});

// authFunc: function (token, function (err, result));

// ssh トンネリング で接続断を試す
// ssh -L 5000:localhost:3000 dreamarts@10.1.9.135

// [階層構造]
//   サーバ      : MultiSocket > Line > Connection
//   クライアント : MultiSocket > Connection

(function(root) {

  var CMD_AUTH = 'authentication';
  var CMD_CONNECTION = 'connection';
  var CMD_DISCONNECT = 'disconnect';
  var CMD_RECONNECT = 'reconnect';

  var DISCONNECT_TIMEOUT = 30; // 再接続可能時間 30ｓ

  // 唯一のWebsocket接続を準備する
  var MultiSocket = function(io, namespace, option, server, authFunc) {
    this.server = server;
    var self = this;
    if (server) {
      this.connectionFunc = {}; // 接続時関数
      this.ws = {}; // 物理的接続情報
      this.cn = {}; // 論理的接続情報
      var socket = io(server, option);
      socket.of(namespace).on(CMD_CONNECTION, function(ws) {
        console.log('transport open  : ' + ws.id);

        self.ws[ws.id] = new Line(self.connectionFunc, ws, authFunc);

        ws.on('challenge ' + CMD_RECONNECT, function(id) {
          var line = self.cn[id];
          // 同じならつなぎ替える必要はない
          if (line && (line.ws.id !== ws.id)) {
            var os = line.ws; // old ws;

            console.log([CMD_RECONNECT, id].join(' : '));
            console.log("transport close-timer canceled : " + os.id);
            console.log("transport change : " + os.id + " → " + ws.id);

            clearTimeout(line.disconnectTimer);

            // つなぎ替える
            self.ws[ws.id] = line;
            self.ws[os.id] = undefined;
            line.reconnect(ws); // リスナー登録
          }
        });

        // 認証 : Server側
        ws.on(CMD_AUTH, function(token) {
          var line = self.ws[ws.id];
          line.auth(token);
        });

        // 接続開始
        ws.on(CMD_CONNECTION, function(d) {
          var line = self.ws[ws.id];
          if (line.authenticated) {
            var data = JSON.parse(d);
            line.connect(data.name, data.number);
            // 接続情報
            self.cn[data.id] = line;
            console.log([CMD_CONNECTION, data.id].join(' : '));
          }
        });

        // 接続解除
        ws.on(CMD_DISCONNECT, function(d) {
          var line = self.ws[ws.id];
          if (line) {
            console.log("transport close timer start : " + ws.id);
            line.disconnectTimer = setTimeout(function() {
              console.log(d + " : " + ws.id); // transport close
              line.disconnect();
            }, DISCONNECT_TIMEOUT * 1000); // 60s
          }
        });

      });
    } else {
      var ws = io(namespace, option);
      this.number = 0;
      this.ws = ws;
      this.id = Math.random().toString(36).slice(-8);
      ws.on(CMD_DISCONNECT, function(d) {
        console.log(CMD_DISCONNECT + ' close-timer start');
        self.disconnectTimer = setTimeout(function() {
          console.log(CMD_DISCONNECT + ' ' + d);
          const events = self.connection.events;
          events[CMD_DISCONNECT] && events[CMD_DISCONNECT]();

        }, DISCONNECT_TIMEOUT * 1000);
      });
      ws.on(CMD_RECONNECT, function(d) {
        console.log(CMD_DISCONNECT + ' close-timer canceled');
        clearTimeout(self.disconnectTimer);
        console.log(CMD_RECONNECT + ' ' + d);
        ws.emit('challenge ' + CMD_RECONNECT, self.id);
      });
    }
    return this;
  };

  // 認証 : Client側
  MultiSocket.prototype.authenticate = function(token, callback) {
    this.ws.on(CMD_AUTH, function(data) {
      callback(data);
    });
    this.ws.emit(CMD_AUTH, token);
  };

  // Connection が集まって Line と呼ぶことにする
  var Line = function(connectionFunc, ws, authFunc) {
    this.connectionFunc = connectionFunc;
    this.ws = ws;
    this.authFunc = authFunc;
    this.authenticated = !authFunc;
    this.connections = {};
  };

  Line.prototype.auth = function(token) {
    var self = this;
    if (this.authFunc) {
      this.authFunc(token, function(err, result) {
        if (!err) {
          self.authenticated = true;
        }
        self.ws.emit(CMD_AUTH, result);
      });
    }
  };

  Line.prototype.connect = function(name, number) {
    var conn = new Connection(this, name);
    conn.number = number;
    this.connections[number] = conn;
    this.connectionFunc[name](conn);
  };

  Line.prototype.reconnect = function(ws) {
    this.ws = ws;
    // リスナー登録
    // var self = this;
    var conns = this.connections;
    Object.keys(conns).forEach(function(key) {
      var conn = conns[key];
      var events = conn.events;
      Object.keys(events).forEach(function(key) {
        conn.on(key, events[key]);
      });
    });
  };

  Line.prototype.disconnect = function() {
    // リスナー登録の解除
    var conns = this.connections;
    Object.keys(conns).forEach(function(key) {
      var conn = conns[key];
      var events = conn.events;
      events[CMD_DISCONNECT] && events[CMD_DISCONNECT]();
      Object.keys(events).forEach(function(key) {
        conn.off(key, events[key]);
      });
      delete conns[key];
    });
  };

  var Connection = function(parent, name) {
    this.parent = parent;
    this.name = name;
    this.events = {};
    return this;
  };

  Connection.prototype.eventName = function(key) {
    // name は無くても一意に定まる
    //return [this.name, this.number, key].join('_');
    return [key, this.number].join('_');
  };

  Connection.prototype.emit = function(key, data) {
    this.parent.ws.emit(this.eventName(key), data);
  };

  Connection.prototype.on = function(key, func) {
    if (key === CMD_CONNECTION) {
      this.parent.connectionFunc[this.name] = func;
    } else {
      this.parent.ws.on(this.eventName(key), func);
      this.events[key] = func;
    }
  };

  Connection.prototype.off = function(key, func) {
    if (key === CMD_CONNECTION) {
      delete this.parent.connectionFunc[this.name];
    } else {
      this.parent.ws.removeListener(this.eventName(key), func);
      delete this.events[key];
    }
  };

  MultiSocket.prototype.io = function(name) {
    var conn = new Connection(this, name);
    if (this.server) {
      // Do nothing.
    } else {
      this.connection = conn;

      conn.number = this.number++;

      var data = {
        name: conn.name,
        number: conn.number,
        id: this.id
      };
      this.ws.emit(CMD_CONNECTION, JSON.stringify(data));
    }
    return conn;
  };

  if (typeof module !== 'undefined' && module.exports) { // Node.js の場合
    module.exports = MultiSocket;
  } else {
    root.MultiSocket = MultiSocket;
  }

})(this);
