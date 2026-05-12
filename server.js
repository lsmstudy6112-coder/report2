const dgram = require('dgram');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const HTTP_HOST = '127.0.0.1';
const HTTP_PORT = 3000;
const TFTP_HOST = '127.0.0.1';
const TFTP_PORT = 6969; // 실습용. 실제 TFTP 기본 포트는 69지만 관리자 권한이 필요할 수 있음.
const BLOCK_SIZE = 512;
const TIMEOUT_MS = 1200;
const MAX_RETRY = 5;

const app = express();
const upload = multer({ dest: path.join(__dirname, 'tmp') });
const clients = new Set();

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(line);
  for (const res of clients) res.write(`data: ${JSON.stringify(line)}\n\n`);
}

function makeRequest(opcode, filename, mode = 'octet') {
  return Buffer.concat([
    Buffer.from([0, opcode]),
    Buffer.from(filename), Buffer.from([0]),
    Buffer.from(mode), Buffer.from([0])
  ]);
}
function makeData(block, data) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(3, 0);
  header.writeUInt16BE(block, 2);
  return Buffer.concat([header, data]);
}
function makeAck(block) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(4, 0);
  buf.writeUInt16BE(block, 2);
  return buf;
}
function parsePacket(buf) {
  const opcode = buf.readUInt16BE(0);
  if (opcode === 3) return { opcode, block: buf.readUInt16BE(2), data: buf.subarray(4) };
  if (opcode === 4) return { opcode, block: buf.readUInt16BE(2) };
  if (opcode === 5) return { opcode, code: buf.readUInt16BE(2), message: buf.subarray(4, -1).toString() };
  return { opcode };
}

function withTimeout(socket, packet, port, host, actionName) {
  let retry = 0;
  return new Promise((resolve, reject) => {
    const send = () => {
      if (retry > MAX_RETRY) return reject(new Error(`${actionName} timeout`));
      socket.send(packet, port, host);
      retry += 1;
    };
    const timer = setInterval(send, TIMEOUT_MS);
    send();
    resolve(() => clearInterval(timer));
  });
}

async function tftpRead(filename) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const chunks = [];
    let expectedBlock = 1;
    let serverPort = TFTP_PORT;
    let lastPacket = makeRequest(1, filename);
    let retry = 0;
    let timer;

    function resend() {
      if (retry++ >= MAX_RETRY) {
        cleanup();
        return reject(new Error('RRQ timeout: 서버 응답 없음'));
      }
      socket.send(lastPacket, serverPort, TFTP_HOST);
    }
    function resetTimer() {
      clearInterval(timer);
      retry = 0;
      timer = setInterval(resend, TIMEOUT_MS);
    }
    function cleanup() {
      clearInterval(timer);
      socket.close();
    }

    socket.on('message', (msg, rinfo) => {
      serverPort = rinfo.port; // TFTP는 최초 요청 이후 서버 임시 포트와 통신
      const p = parsePacket(msg);
      if (p.opcode === 5) {
        cleanup();
        return reject(new Error(`TFTP ERROR ${p.code}: ${p.message}`));
      }
      if (p.opcode !== 3) return;

      log(`READ DATA block=${p.block}, size=${p.data.length}, from=${rinfo.address}:${rinfo.port}`);
      if (p.block === expectedBlock) {
        chunks.push(p.data);
        lastPacket = makeAck(p.block);
        socket.send(lastPacket, serverPort, TFTP_HOST);
        log(`SEND ACK block=${p.block}`);
        expectedBlock += 1;
        resetTimer();
        if (p.data.length < BLOCK_SIZE) {
          cleanup();
          resolve(Buffer.concat(chunks));
        }
      } else {
        socket.send(makeAck(expectedBlock - 1), serverPort, TFTP_HOST);
      }
    });

    socket.bind(() => {
      log(`SEND RRQ filename=${filename} to ${TFTP_HOST}:${TFTP_PORT}`);
      resend();
      resetTimer();
    });
  });
}

async function tftpWrite(filename, fileBuffer) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let serverPort = TFTP_PORT;
    let block = 0;
    let offset = 0;
    let lastPacket = makeRequest(2, filename);
    let retry = 0;
    let timer;

    function cleanup() {
      clearInterval(timer);
      socket.close();
    }
    function resend() {
      if (retry++ >= MAX_RETRY) {
        cleanup();
        return reject(new Error('WRQ timeout: 서버 응답 없음'));
      }
      socket.send(lastPacket, serverPort, TFTP_HOST);
    }
    function resetTimer() {
      clearInterval(timer);
      retry = 0;
      timer = setInterval(resend, TIMEOUT_MS);
    }
    function sendNextData() {
      block += 1;
      const data = fileBuffer.subarray(offset, offset + BLOCK_SIZE);
      offset += data.length;
      lastPacket = makeData(block, data);
      socket.send(lastPacket, serverPort, TFTP_HOST);
      log(`SEND DATA block=${block}, size=${data.length}`);
      resetTimer();
    }

    socket.on('message', (msg, rinfo) => {
      serverPort = rinfo.port;
      const p = parsePacket(msg);
      if (p.opcode === 5) {
        cleanup();
        return reject(new Error(`TFTP ERROR ${p.code}: ${p.message}`));
      }
      if (p.opcode !== 4) return;

      log(`RECV ACK block=${p.block}, from=${rinfo.address}:${rinfo.port}`);
      resetTimer();
      if (p.block === 0 && block === 0) return sendNextData();
      if (p.block === block) {
        if (offset >= fileBuffer.length) {
          if (fileBuffer.length % BLOCK_SIZE === 0 && lastPacket.length !== 4) {
            block += 1;
            lastPacket = makeData(block, Buffer.alloc(0));
            socket.send(lastPacket, serverPort, TFTP_HOST);
            log(`SEND FINAL EMPTY DATA block=${block}`);
            return;
          }
          cleanup();
          return resolve();
        }
        sendNextData();
      }
    });

    socket.bind(() => {
      log(`SEND WRQ filename=${filename} to ${TFTP_HOST}:${TFTP_PORT}`);
      resend();
      resetTimer();
    });
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const filename = req.body.filename || req.file.originalname;
    const data = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);
    await tftpWrite(filename, data);
    res.json({ ok: true, message: `${filename} 업로드 완료` });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.get('/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const data = await tftpRead(filename);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(data);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(HTTP_PORT, HTTP_HOST, () => {
  log(`Browser UI: http://${HTTP_HOST}:${HTTP_PORT}`);
  log(`TFTP target: ${TFTP_HOST}:${TFTP_PORT}`);
});
