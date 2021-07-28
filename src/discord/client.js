const net = require('net');
const EventEmitter = require('events');
const fetch = require('node-fetch');
const { uuid } = require('../utils.js');
const { RPC_OPCODE, RPC_PATH } = require('./constants.js');


/** Attempts to connect to the discord app's IPC pipe
 * @returns {net.Socket}
 */
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

/**Creates an IPC frame
 * @param {any} data
 * @param {number} opcode
 * @returns {Buffer}
 */
const createFrame = (opcode, data) => {

    // no data, produce frame with opcode, length = 0, and no data
    if (data == null) {
        const frame = Buffer.alloc(8);
        frame.writeInt32LE(opcode, 0);
        return frame;
    }

    // convert data to string
    data = JSON.stringify(data);

    // allocate buffer
    const len = Buffer.byteLength(data);
    const frame = Buffer.alloc(8 + len);

    // write opcide, data length and string data to frame
    frame.writeInt32LE(opcode, 0);
    frame.writeInt32LE(len, 4);
    frame.write(data, 8, len);

    // return frame
    return frame;
};

const readNextFrame = self => {

    return new Promise((resolve, reject) => {

        const sock = self._rpcSock;

        const rejectRead = reason => {
            try {
                sock.removeListener('close', closeHandler);
                sock.removeListener('error', closeHandler);
                sock.removeListener('readable', readHandler);
            } catch (err) { }
            reject(reason);
        }

        const closeHandler = data => {
            let error = new Error('RPC_CONNECTION_CLOSED');
            error.data = data;
            rejectRead(error);
        };

        let dataBuffer = self._rpcDataBuffer;
        const readHandler = () => {
            let readBuffer;
            while (!!(readBuffer = self._rpcSock.read())) {
                if (dataBuffer) {
                    dataBuffer = Buffer.concat([dataBuffer, readBuffer]);
                } else {
                    dataBuffer = readBuffer;
                }
            }

            if (!dataBuffer) {
                return;
            }

            const buffLen = dataBuffer.byteLength;
            if (buffLen < 8) {
                return;
            }

            const opcode = dataBuffer.readInt32LE(0);
            const frameLen = dataBuffer.readInt32LE(4);

            if (buffLen < (frameLen + 8)) {
                return;
            }

            let frameRaw, frameJson;
            if (frameLen) {
                frameRaw = dataBuffer.toString('utf8', 8, frameLen + 8);
                frameJson = JSON.parse(frameRaw);
            }

            sock.removeListener('close', closeHandler);
            sock.removeListener('error', closeHandler);
            sock.removeListener('readable', readHandler);
            self._rpcDataBuffer = dataBuffer.slice(frameLen + 8);
            resolve({
                opcode,
                frame: frameJson,
                raw: frameRaw
            });
        }

        sock.on('error', closeHandler);
        sock.on('close', closeHandler);
        sock.on('readable', readHandler);
        readHandler();
    });
}

module.exports = class DiscordClient extends EventEmitter {
    constructor({client_id, client_secret, redirect_uri} = '') {
        super();

        this.appinfo = {
            client_id,
            client_secret,
            redirect_uri
        }

        /** Referance to the underlaying IPC socket
         * @type {?net.Socket}
         * @private
         */
        this._rpcSock = null;

        /** Data that has been read from the socket but not processed
         * @type {?Buffer}
         * @private
         */
        this._rpcDataBuffer = null;

        /** Pending invocations
         * @type {Map}
         * @private
         */
        this._rpcInvocations = new Map();
    }

    connect() {
        if (this._connectPromise) {
            return this._connectPromise;
        }
        if (!this.appinfo) {
            throw new Error('RPC:APP_INFO_MISSING');
        }

        this.application = this.user = null;

        this.readyState = 1;

        return this._connectPromise = new Promise(async (resolve, reject) => {
            try {

                /* Step 1 - Create IPC connection
                */
                this._rpcSock = await getRpcSocket();

                /* Step 2 - Handshake
                **   Send hello message and expect a 'ready' event as a response
                */
                this._rpcSock.write(createFrame(
                    RPC_OPCODE.HANDSHAKE,
                    { v: 1, client_id: this.appinfo.client_id }
                ));

                let { opcode, frame } = await readNextFrame(this);
                if (opcode === RPC_OPCODE.CLOSING) {
                    const error = new Error('RPC_CONNECTION_CLOSING');
                    error.data = frame.data;
                    throw error;
                }
                if (opcode !== RPC_OPCODE.MESSAGE) {
                    const error = new Error('RPC_PROTOCOL_ERROR');
                    error.message = `unexpected opcode ${opcode}`;
                    error.opcode = opcode;
                    throw error;
                }
                if (frame.cmd !== 'DISPATCH' || frame.evt !== 'READY') {
                    const error = new Error('RPC_PROTOCOL_ERROR');
                    error.message = `expected ready frame`;
                    error.frame = frame;
                    throw error;
                }

                /* Step 3 - Get access token
                *   Requests authorization and gets oauth code
                *   exchanges code for access token
                */
                let access_token = this.access_token;
                if (!access_token) {

                    // step 3.1 - request authorization
                    this._rpcSock.write(createFrame(
                        RPC_OPCODE.MESSAGE,
                        { cmd: 'AUTHORIZE', args: { client_id: this.appinfo.client_id, scopes: ['rpc'], prompt: 'none' }, nonce: 'login' }
                    ));
                    const {opcode, frame } = await readNextFrame(this);
                    const { cmd, nonce, data } = frame;
                    if (opcode === RPC_OPCODE.CLOSING) {
                        const error = new Error('RPC_CONNECTION_CLOSING');
                        error.data = data;
                        throw error;
                    }
                    if (opcode !== RPC_OPCODE.MESSAGE) {
                        const error = new Error('RPC_PROTOCOL_ERROR');
                        error.message = `unexpected opcode ${opcode}`;
                        error.opcode = opcode;
                        throw error;
                    }
                    if (cmd !== 'AUTHORIZE' || nonce !== 'login' || !data.code) {
                        const error = new Error('RPC_PROTOCOL_ERROR');
                        error.message = `expected authorize frame`;
                        error.frame = frame;
                        throw error;
                    }

                    // step 3.2 - exchange authorization code for access token
                    try {
                        const exchange = await this.fetch({
                            method: 'POST',
                            path: 'oauth2/token',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded'
                            },
                            body: new URLSearchParams({
                                client_id: this.appinfo.client_id,
                                client_secret: this.appinfo.client_secret,
                                grant_type: 'authorization_code',
                                code: data.code,
                                redirect_uri: this.appinfo.redirect_uri
                            }),
                            noAuth: true
                        });
                        access_token = exchange.access_token;
                    } catch (err) {
                        const error = new Error('CODE_EXCHANGE_FAILURE');
                        error.error = err;
                        throw error;
                    }
                }


                /* Step 4 - Authenticate the access token
                *    Requests the IPC validate the access token
                */
                this._rpcSock.write(createFrame(
                    RPC_OPCODE.MESSAGE,
                    {cmd: 'AUTHENTICATE', data: { access_token }, nonce: 'auth' }
                ));

                let nextFrame = await readNextFrame(this);
                opcode = nextFrame.opcode;
                frame = nextFrame.frame;
                const { cmd, nonce, data } = frame;

                if (opcode === RPC_OPCODE.CLOSING) {
                    const error = new Error('RPC_CONNECTION_CLOSING');
                    error.data = data;
                    throw error;
                }

                if (opcode !== RPC_OPCODE.MESSAGE) {
                    const error = new Error('RPC_PROTOCOL_ERROR');
                    error.message = `unexpected opcode ${opcode}`;
                    error.opcode = opcode;
                    throw error;
                }

                if (cmd !== 'AUTHENTICATE' || nonce !== 'auth' || !data.access_token) {
                    const error = new Error('RPC_PROTOCOL_ERROR');
                    error.message = `expected authenticate frame`;
                    error.frame = frame;
                    throw error;
                }

                this._connectPromise = null;
                this.application = data.application;
                this.user = data.user;
                this.access_token = data.access_token;


                const closeHandler = () => {
                    const closingFrame = this._rpcClosingFrame;

                    this.readyState = 0;
                    this.user = null;
                    this.application = null;
                    this._rpcClosingFrame = null;

                    // cleanup socket
                    try {
                        this._rpcSock.off('readable', readHandler);
                        this._rpcSock.off('close', closeHandler);
                        this._rpcSock.off('error', closeHandler);
                        this._rpcSock.unref();
                        this._rpcSock.destroy();
                    } catch (ignore) {}
                    if (this._rpcSockTimeout) {
                        clearTimeout(this._rpcSockTimeout);

                    }
                    this._rpcSockTimeout = null;
                    this._rpcSock = null;
                    this._rpcDataBuffer = null;


                    // cleanup pending invocations
                    for (const [key, invocation] of this._rpcInvocations) {
                        invocation.reject(new Error('RPC_CLOSED'));
                    }
                    this._rpcInvocations = new Map();


                    // emit closed event
                    this.emit('RPC:CLOSED', closingFrame);
                };

                const readHandler = () => {
                    let dataBuffer = this._rpcDataBuffer,
                        readBuffer;

                    while (!!(readBuffer = this._rpcSock.read())) {
                        if (dataBuffer) {
                            dataBuffer = Buffer.concat([dataBuffer, readBuffer]);
                        } else {
                            dataBuffer = readBuffer;
                        }
                    }

                    while (dataBuffer && dataBuffer.length >= 8) {
                        const opcode = dataBuffer.readInt32LE(0);
                        const length = dataBuffer.readInt32LE(4);

                        if (dataBuffer.length < (length + 8)) {
                            break;
                        }

                        let frame;
                        if (length > 0) {
                            frame = JSON.parse(dataBuffer.toString('utf8', 8, length + 8));
                        }

                        // remove frame from data buffer
                        if (dataBuffer.length === (length + 8)) {
                            dataBuffer = null;

                        } else {
                            dataBuffer = dataBuffer.slice(length + 8);
                        }

                        this.emit('RPC:FRAME:*', frame);

                        switch (opcode) {
                            // shouldn't receive this as handshaking is handled above, but just incase
                            case RPC_OPCODE.HANDSHAKE:
                                this.emit('RPC:FRAME:HANDSHAKE', frame);
                                break;

                            case RPC_OPCODE.MESSAGE:
                                this.emit('RPC:FRAME:MESSAGE', frame);

                                const {cmd, nonce, evt, data} = frame;

                                if (this._rpcInvocations.has(nonce)) {
                                    let { resolve, reject } = this._rpcInvocations.get(nonce);
                                    this._rpcInvocations.delete(nonce);
                                    if (evt === 'ERROR') {
                                        const error = new Error(data.message);
                                        error.code = data.code;
                                        error.data = data;
                                        reject(error);
                                    } else {
                                        resolve(data);
                                    }
                                } else if (cmd === 'DISPATCH') {
                                    this.emit('DISCORD:*', {cmd, evt, data});
                                    this.emit(`DISCORD:${evt}`, data);
                                }
                                break;

                            case RPC_OPCODE.CLOSING:
                                this.readyState = 3;
                                this._rpcClosingFrame = frame;
                                this.emit('RPC:FRAME:CLOSING', frame);
                                break;

                            case RPC_OPCODE.PING:
                                this.send(frame, RPC_OPCODE.PONG);
                                this.emit('RPC:FRAME:PING', frame);
                                break;

                            case RPC_OPCODE.PONG:
                                this.emit('RPC:FRAME:PING', frame);
                                break;

                            default:
                                this.emit('RPC:FRAME:UNKNOWN', { opcode, frame });
                                break;
                        }
                    }

                    this._rpcDataBuffer = dataBuffer;
                }

                this._rpcSock.on('readable', readHandler);
                this._rpcSock.on('close', closeHandler);
                this._rpcSock.on('error', closeHandler);

                this.readyState = 2;
                resolve();

            } catch (err) {
                try {
                    this._ipcSock.destroy();
                } catch (ignore) {}

                this._rpcSock = null;
                this._rpcDataBuffer = null;
                this._connectPromise = null;
                this.readyState = 0;
                reject(err);
            }
        });
    }

    async fetch(options) {
        const { method, path, query, headers, body } = options;

        const url = `https://discord.com/api/${path}${query ? new URLSearchParams(query) : ''}`;

        const opts = {
            method: method || 'GET',
            headers: headers || {},
            body
        }
        if (!options.noAuth && this.access_token) {
            opts.headers['Authorization'] = `Bearer ${this.access_token}`;
        }

        const request = await fetch(url, opts);
        const response = await request.json();

        if (!request.ok) {
            const err = new Error('REQUEST_FAILED');
            err.statusCode = request.status;
            err.statusText = request.statusText;
            err.body = response;
            throw err;
        }

        return response;
    }

    send(data, opcode) {
        if (this.readyState !== 2) {
            throw new Error('CONNECTION_NOT_OPEN');
        }
        if (opcode == null) {
            opcode = RPC_OPCODE.MESSAGE;
        }
        this._rpcSock.write(createFrame(opcode, data || ''));
    }

    invoke(cmd, args = {}, evt) {
        if (this.readyState !== 2) {
            throw new Error('CONNECTION_NOT_OPEN');
        }

        const nonce = uuid();
        return new Promise((resolve, reject) => {
            this._rpcInvocations.set(nonce, { resolve, reject });
            this.send({ cmd, args, evt, nonce});
        });
    }

    close() {
        if (this.readyState === 0) {
            return Promise.resolve();
        }

        if (this._closePromise) {
            return this._closePromise;
        }

        return this._closePromise = new Promise(resolve => {
            const closeResolve = () => {
                this._closePromise = null;
                resolve();
            }

            if (this.readyState === 1) {
                this._connectPromise()
                    .then(
                        this._rpcSock.end,
                        closeResolve
                    ).catch(closeResolve);
            } else {
                this.on('RPC:CLOSED', closeResolve);
            }
        });
    }

    subscribe(event, args) {
        return this.invoke('SUBSCRIBE', args, event);
    }

    unsubscribe(event, args) {
        return this.invoke('UNSUBSCRIBE', args, event);
    }

    getGuilds() {
        return this.invoke('GET_GUILDS');
    }

    getGuild(guildId, timeout) {
        return this.invoke('GET_GUILD', { guild_id: guildId, timeout});
    }

    getChannels(guildId) {
        return this.invoke('GET_CHANNELS', { guild_id: guildId });
    }

    getChannel(channelId) {
        return this.invoke('GET_CHANNEL', { channel_id: channelId });
    }

    setUserVoiceSettings(userId, settings) {
        return this.invoke('SET_USER_VOICE_SETTINGS', settings);
    }

    selectVoiceChannel(channelId, timeout, force) {
        return this.invoke('SELECT_VOICE_CHANNEL', { channel_id: channelId, timeout, force});
    }

    getSelectedVoiceChannel() {
        return this.invoke('GET_SELECTED_VOICE_CHANNEL');
    }

    selectTextChannel(channelId, timeout) {
        return this.invoke('SELECT_TEXT_CHANNEL', { channel_id: channelId, timeout });
    }

    getVoiceSettings() {
        return this.invoke('GET_VOICE_SETTINGS');
    }

    setVoiceSettings(settings) {
        return this.invoke('SET_VOICE_SETTINGS', settings);
    }

    setCertifiedDevices(devices) {
        return this.invokde('SET_CERTIFIED_DEVICES', devices);
    }

    setActivity(pid, activity) {
        return this.invoke('SET_ACTIVITY', { pid, activity });
    }

    sendActivityJoinInvite(userId) {
        return this.invoke('SEND_ACTIVITY_JOIN_INVITE', { user_id: userId });
    }

    closeActivityRequest(userId) {
        return this.invoke('CLOSE_ACTIVITY_REQUEST', {user_id: userId});
    }
};