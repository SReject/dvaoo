const net = require('net');
const EventEmitter = require('events');
const { uuid } = require('../utils.js');
const { IPC_OPCODE, IPC_PATH } = require('./constants.js');

const getIpcSocket = (attempt = 0) => {
    const path = IPC_PATH + attempt;
    return new Promise((resolve, reject) => {
        const onSockError = () => {
            if (attempt >= 10) {
                reject(new Error('IPC:FAILED_TO_CONNECT'));
            } else {
                resolve(getIpcSocket(attempt + 1));
            }
        };

        const sock = net.createConnection(path, () => {
            sock.pause();
            sock.removeListener('error', onSockError);
            resolve(sock);
        });
        sock.once('error', onSockError);
    });
};


class IPCTransport extends EventEmitter {
    constructor() {
        super();
        this._ipcSock = null;
        this._ipcDataBuffer = null;
    }

    async connect() {
        if (this.appinfo.client_id == null) {
            throw new Error('IPC:CLIENT_ID_MISSING');
        }
        if (this._ipcClosing) {
            throw new Error('IPC:CONNECTION_CLOSING');
        }
        if (this._ipcSock) {
            throw new Error('IPC:CONNECTION_IN_USE');
        }

        this._ipcSock = await getIpcSocket();
        console.log('[IPC] connected to discord');

        // Socket closed handling
        const ipcClosed = (...data) => {
            const closing = this._ipcClosing;

            if (this._ipcTimeout) {
                clearTimeout(this._ipcTimeout);
            }

            this._ipcSock.off('close', ipcClosed);
            this._ipcSock.off('error', ipcClosed);
            this._ipcSock.unref();
            this._ipcSock = null;
            this._ipcDataBuffer = null;
            this._ipcTimeout = null;
            this._ipcClosing = null;

            this.emit('IPC:CLOSED', data);
            if (closing) {
                closing.resolve();
            }
        };

        // ipcsock closed
        this._ipcSock.on('close', ipcClosed);
        this._ipcSock.on('error', ipcClosed);

        // read from socket
        this._ipcSock.on('readable', () => {

            // read data in the socket's read buffer
            let data;
            while (!!(data = this._ipcSock.read())) {

                if (this._ipcDataBuffer == null) {
                    this._ipcDataBuffer = data;
                } else {
                    this._ipcDataBuffer = Buffer.concat([this._ipcDataBuffer, data]);
                }
            }

            // process each frame
            while (this._ipcDataBuffer) {
                const buffLen = this._ipcDataBuffer.byteLength;

                // haven't received the frame's full header
                if (buffLen < 8) {
                    return;
                }

                const opcode = this._ipcDataBuffer.readInt32LE(0);
                const frameLen = this._ipcDataBuffer.readInt32LE(4);

                // haven't received the entirety of the frame
                if ((frameLen + 8) > buffLen) {
                    return;
                }

                // convert frame's data to js object
                let msg;
                if (frameLen > 0) {
                    msg = JSON.parse(this._ipcDataBuffer.toString('utf8', 8, frameLen + 8));
                }

                // remove frame from data buffer
                if ((frameLen + 8) < buffLen) {
                    this._ipcDataBuffer = this._ipcDataBuffer.slice(frameLen + 9);
                } else {
                    this._ipcDataBuffer = null;
                }

                // emit generic event
                this.emit('IPC:RECEIVED_FRAME', { opcode, msg });

                // emit frame-specific event
                switch (opcode) {
                    case IPC_OPCODE.MESSAGE:
                        if (msg.cmd === 'DISPATCH' && msg.evt === 'READY' && this._ipcReady) {
                            const resolve = this._ipcReady.resolve;
                            this._ipcReady = null;
                            resolve(msg.data);
                        }
                        this.emit('IPC:RECEIVED_MESSAGE', msg);
                        break;

                    case IPC_OPCODE.CLOSE:
                        if (this._ipcReady) {
                            const reject = this._ipcReady.reject;
                            this._ipcReady = null;
                            reject(msg);
                        }
                        this.emit('IPC:RECEIVED_CLOSE', msg);
                        break;

                    case IPC_OPCODE.PING:
                        this.send(msg, IPC_OPCODE.PONG);
                        this.emit('IPC:RECEIVED_PING', msg);
                        break;

                    case IPC_OPCODE.PONG:
                        this.emit('IPC:RECEIVED_PONG', msg);
                        break;
                }
            }

            // Reset ping timeout
            if (this._ipcTimeout) {
                clearTimeout(this._ipcTimeout);
                this._ipcTimeout = setTimeout(() => {
                    this.send(null, IPC_OPCODE.PING);
                    this._ipcTimeout = setTimeout(() => {
                        this.terminate();
                    })
                }, 60000);
            }
        });

        this.send({v: 1, client_id: this.appinfo.client_id}, IPC_OPCODE.HANDSHAKE);
        this._ipcReady = {};

        this._ipcReady.promise = new Promise((resolve, reject) => {
            this._ipcReady.resolve = resolve;
            this._ipcReady.reject = reject;
        });

        return await this._ipcReady.promise;
    }

    send(data, opcode = IPC_OPCODE.MESSAGE) {
        if (this._ipcClosing) {
            throw new Error('IPC:CONNECTION_CLOSING');
        }
        if (this._ipcSock == null || this._ipcSock.readyState !== 'open') {
            throw new Error('IPC:NOT_CONNECTED');
        }

        if (data == null) {
            data = '';

        } else {
            data = JSON.stringify(data);
        }
        const len = Buffer.byteLength(data);
        const buff = Buffer.alloc(8 + len);
        buff.writeInt32LE(opcode, 0);
        buff.writeInt32LE(len, 4);
        buff.write(data, 8, len);

        this._ipcSock.write(buff);
    }

    close() {
        if (this._ipcClosing) {
            return this._ipcClosing.promise;
        }
        if (_ipcSock == null) {
            return;
        }
        this._ipcClosing = {};
        return this._ipcClosing.promise = new Promise((resolve, reject) => {
            this._ipcClosing.resolve = resolve;
            this._ipcSock.end();
        });
    }

    terminate() {
        const { _ipcSock, _ipcClosing, _ipcTimeout } = this;
        this._ipcSock = null;
        this._ipcDataBuffer = null;
        this._ipcTimeout = null;
        this._ipcClosing = null;
        if (_ipcSock != null) {
            _ipcSock.destroy();
            _ipcSock.unref();
        }
        if (_ipcTimeout) {
            clearTimeout(_ipcTimeout);
        }
        if (_ipcClosing) {
            _ipcClosing.resolve();
        }
    }
}








function processRPCMessage({cmd, nonce, evt, data}) {
    if (cmd === 'DISPATCH') {
        this.emit(`DISCORD:${evt}`, data);
    } else if (this._pendingInvocations.has(nonce)) {
        const {resolve, reject} = this._pendingInvocations.get(nonce);
        this._pendingInvocations.delete(nonce);
        if (evt === 'ERROR') {
            const error = new Error(data.message);
            error.code = data.code;
            error.data = data;
            reject(error);
        } else {
            resolve(data);
        }
    }
};

module.exports = class DiscordRPC extends IPCTransport {
    constructor(options) {
        super(options);
        this._pendingInvocations = new Map();
        this.on('IPC:CLOSED', () => {
            let pending = this._pendingInvocations;
            this._pendingInvocations = new Map();
            pending.forEach(invocation => {
                invocation.reject(new Error('IPC:CONNECTION_CLOSED'));
            });
        });
        this.on('IPC:RECEIVED_MESSAGE', processRPCMessage.bind(this));
    }

    invoke(cmd, args = {}, evt) {
        const nonce = uuid();
        return new Promise((resolve, reject) => {
            this._pendingInvocations.set(nonce, { resolve, reject});
            this.send({ cmd, args, evt, nonce});
        });
    }
}