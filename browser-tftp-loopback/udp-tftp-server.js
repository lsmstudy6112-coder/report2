const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 6969;
const ROOT = path.join(__dirname, 'tftp-root');
const BLOCK_SIZE = 512;
fs.mkdirSync(ROOT, { recursive: true });

function parseZeroStrings(buf, start) {
  const parts = buf.subarray(start).toString().split('\0');
  return { filename: path.basename(parts[0]), mode: parts[1] || 'octet' };
}
function ack(block) {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(4, 0); b.writeUInt16BE(block, 2);
  return b;
}
function data(block, chunk) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(3, 0); h.writeUInt16BE(block, 2);
  return Buffer.concat([h, chunk]);
}
function error(code, message) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(5, 0); h.writeUInt16BE(code, 2);
  return Buffer.concat([h, Buffer.from(message), Buffer.from([0])]);
}

const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  const opcode = msg.readUInt16BE(0);
  const req = parseZeroStrings(msg, 2);
  const filePath = path.join(ROOT, req.filename);

  if (opcode === 1) { // RRQ
    console.log(`RRQ ${req.filename} from ${rinfo.address}:${rinfo.port}`);
    if (!fs.existsSync(filePath)) return server.send(error(1, 'File not found'), rinfo.port, rinfo.address);
    const buf = fs.readFileSync(filePath);
    const session = dgram.createSocket('udp4');
    let block = 1;
    let offset = 0;
    function sendBlock() {
      const chunk = buf.subarray(offset, offset + BLOCK_SIZE);
      session.send(data(block, chunk), rinfo.port, rinfo.address);
    }
    session.on('message', ackMsg => {
      if (ackMsg.readUInt16BE(0) !== 4) return;
      const ackBlock = ackMsg.readUInt16BE(2);
      if (ackBlock === block) {
        offset += BLOCK_SIZE;
        if (buf.subarray(offset - BLOCK_SIZE, offset).length < BLOCK_SIZE) return session.close();
        block += 1;
        sendBlock();
      }
    });
    session.bind(() => sendBlock());
  }

  if (opcode === 2) { // WRQ
    console.log(`WRQ ${req.filename} from ${rinfo.address}:${rinfo.port}`);
    const session = dgram.createSocket('udp4');
    const chunks = [];
    let expected = 1;
    session.on('message', dataMsg => {
      const op = dataMsg.readUInt16BE(0);
      if (op !== 3) return;
      const block = dataMsg.readUInt16BE(2);
      const chunk = dataMsg.subarray(4);
      if (block === expected) {
        chunks.push(chunk);
        session.send(ack(block), rinfo.port, rinfo.address);
        console.log(`DATA ${req.filename} block=${block} size=${chunk.length}`);
        expected += 1;
        if (chunk.length < BLOCK_SIZE) {
          fs.writeFileSync(filePath, Buffer.concat(chunks));
          console.log(`SAVED ${filePath}`);
          session.close();
        }
      }
    });
    session.bind(() => session.send(ack(0), rinfo.port, rinfo.address));
  }
});

server.bind(PORT, HOST, () => console.log(`Sample TFTP server listening on ${HOST}:${PORT}`));
