const net = require('net');
const EventEmitter = require('events');
const { uuid } = require('../utils.js');
const { RPC_OPCODE, RPC_PATH } = require('./constants.js');

const getRpcSocket = async () => {
    let attempt = 0;
    while (attempt < 10) {
        try {
            let rpcSock = await new Promise((resolve, reject) => {
                const path = RPC_PATH + attempt;
                let sock = net.createConnection(path, () => {
                    sock.removeListener('error', reject);
                    sock.pause();
                    resolve(sock);
                });
                sock.on('error', reject);
            });

            return rpcSock;
        } catch (err) {
            attempt += 1;
        }
    }
    throw new Error('RPC:FAILED_TO_CONNECT');
};

module.exports = class DiscordRPC extends EventEmitter {
    constructor() {
        super();

        /**@type {?net.Socket} */
        this._rpcSock = null;

        /**@type {?Buffer} */
        this._rpcDataBuffer = null;

        /**@type {Map} */
        this._rpcInvocations = new Map();
    }

    async connect() {
        if (this.appinfo.client_id == null) {
            throw new Error('RPC:CLIENT_ID_MISSING');
        }
        if (this._rpcClosing) {
            throw new Error('RPC:CONNECTION_CLOSING');
        }
        if (this._rpcSock) {
            throw new Error('RPC:CONNECTION_IN_USE');
        }


        this._rpcSock = await getRpcSocket();
        console.log('[RPC] Connected to discord');

        // Socket closed handling
        const rpcClosed = (...data) => {
            const closing = this._rpcClosing;
            const invocations = this._rpcInvocations;

            if (this._rpcTimeout) {
                clearTimeout(this._rpcTimeout);
            }

            this._rpcSock.off('close', rpcClosed);
            this._rpcSock.off('error', rpcClosed);
            this._rpcSock.unref();
            this._rpcSock = null;
            this._rpcDataBuffer = null;
            this._rpcTimeout = null;
            this._rpcInvocations = null;
            this._rpcClosing = null;


            for (const invocation of invocations) {
                invocation.reject('RPC:CLOSED');
            }

            this.emit('RPC:CLOSED', data);
            if (closing) {
                closing.resolve();
            }
        };

        // rpcsock closed
        this._rpcSock.on('close', rpcClosed);
        this._rpcSock.on('error', rpcClosed);

        // read from socket
        this._rpcSock.on('readable', () => {

            // read data in the socket's read buffer
            /** @type {Buffer} */
            let sockdata;
            while (!!(sockdata = this._rpcSock.read())) {

                if (this._rpcDataBuffer == null) {
                    this._rpcDataBuffer = sockdata;
                } else {
                    this._rpcDataBuffer = Buffer.concat([this._rpcDataBuffer, sockdata]);
                }
            }

            // process each frame
            while (this._rpcDataBuffer) {
                const buffLen = this._rpcDataBuffer.byteLength;

                // haven't received the frame's full header
                if (buffLen < 8) {
                    return;
                }

                const opcode = this._rpcDataBuffer.readInt32LE(0);
                const frameLen = this._rpcDataBuffer.readInt32LE(4);

                // haven't received the entirety of the frame
                if ((frameLen + 8) > buffLen) {
                    return;
                }

                /** Represents a received frame
                 * @typedef {Object} FrameData
                 * @property {String} cmd
                 * @property {String} nonce
                 * @property {String} evt
                 * @property {any} data
                */

                // convert frame's data to js object
                /** @type {(FrameData|undefined)} */
                let msg;
                if (frameLen > 0) {
                    msg = JSON.parse(this._rpcDataBuffer.toString('utf8', 8, frameLen + 8));
                }

                // remove frame from data buffer
                if ((frameLen + 8) < buffLen) {
                    this._rpcDataBuffer = this._rpcDataBuffer.slice(frameLen + 9);
                } else {
                    this._rpcDataBuffer = null;
                }

                // emit generic event
                this.emit('RPC:RECEIVED_FRAME:*', { opcode, msg });

                // emit frame-specific event
                switch (opcode) {
                    case RPC_OPCODE.HANDSHAKE:
                        this.emit('RPC:RECEIVED_FRAME:HANDSHAKE', msg);
                        break;

                    case RPC_OPCODE.MESSAGE:
                        this.emit('RPC:RECEIVED_FRAME:MESSAGE', msg);

                        const {cmd, nonce, evt, data} = msg;

                        if (cmd === 'DISPATCH') {
                            this.emit('DISCORD:*', msg);
                            this.emit(`DISCORD:${evt}`, data);

                            if (evt === 'READY' && this._rpcReady) {
                                const resolve = this._rpcReady.resolve;
                                this._rpcReady = null;
                                resolve(data);
                            }
                        }

                        if (nonce && this._rpcInvocations.has(nonce)) {
                            const {resolve, reject} = this._rpcInvocations.get(nonce);
                            this._rpcInvocations.delete(nonce);
                            if (evt === 'ERROR') {
                                const error = new Error(data.message);
                                error.code = data.code;
                                error.data = data;
                                reject(error);
                            } else {
                                resolve(data);
                            }
                        }

                        break;

                    case RPC_OPCODE.CLOSE:
                        if (this._rpcReady) {
                            const reject = this._rpcReady.reject;
                            this._rpcReady = null;
                            reject(msg);
                        }
                        this.emit('RPC:RECEIVED_FRAME:CLOSE', msg);
                        break;

                    case RPC_OPCODE.PING:
                        this.send(msg, RPC_OPCODE.PONG);
                        this.emit('RPC:RECEIVED_FRAME:PING', msg);
                        break;

                    case RPC_OPCODE.PONG:
                        this.emit('RPC:RECEIVED_FRAME:PONG', msg);
                        break;
                }
            }

            // Reset ping timeout
            if (this._rpcTimeout) {
                clearTimeout(this._rpcTimeout);
                this._rpcTimeout = setTimeout(() => {
                    this.send(null, RPC_OPCODE.PING);
                    this._rpcTimeout = setTimeout(() => {
                        this.terminate();
                    })
                }, 60000);
            }
        });

        this.send({v: 1, client_id: this.appinfo.client_id}, RPC_OPCODE.HANDSHAKE);
        this._rpcReady = {};

        this._rpcReady.promise = new Promise((resolve, reject) => {
            this._rpcReady.resolve = resolve;
            this._rpcReady.reject = reject;
        });

        return await this._rpcReady.promise;
    }

    send(data, opcode = RPC_OPCODE.MESSAGE) {
        if (this._rpcClosing) {
            throw new Error('RPC:CONNECTION_CLOSING');
        }
        if (this._rpcSock == null || this._rpcSock.readyState !== 'open') {
            throw new Error('RPC:NOT_CONNECTED');
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

        this._rpcSock.write(buff);
    }

    invoke(cmd, args = {}, evt) {
        const nonce = uuid();
        return new Promise((resolve, reject) => {
            this._rpcInvocations.set(nonce, { resolve, reject });
            this.send({ cmd, args, evt, nonce});
        });
    }

    close() {
        if (this._rpcClosing) {
            return this._rpcClosing.promise;
        }
        if (_rpcSock == null) {
            return;
        }
        this._rpcClosing = {};
        return this._rpcClosing.promise = new Promise((resolve, reject) => {
            this._rpcClosing.resolve = resolve;
            this._rpcSock.end();
        });
    }

    terminate() {
        const { _rpcSock, _rpcClosing, _rpcTimeout } = this;
        this._rpcSock = null;
        this._rpcDataBuffer = null;
        this._rpcTimeout = null;
        this._rpcClosing = null;
        if (_rpcSock != null) {
            _rpcSock.destroy();
            _rpcSock.unref();
        }
        if (_rpcTimeout) {
            clearTimeout(_rpcTimeout);
        }
        if (_rpcClosing) {
            _rpcClosing.resolve();
        }
    }
}