const EventEmitter = require('events');

const DiscordCommunicator = require('./communicator');

module.exports = class DiscordVoiceMonitor extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.users = null;
        this.channel = null;
        this.connected = false;
        this.communicator = null;
        this.spool();
    }

    async spool() {
        this.communicator = new DiscordCommunicator(this.config.discordapp);

        // failed to connect - retry in 60 seconds
        // Discord app isn't running?
        try {
            await this.communicator.connect();
        } catch (err) {
            console.log('[DISCORD] - CONNECT ERROR', err);
            setTimeout(() => this.spool(), 60000);
            return;
        }

        try {
            this.channel = await this.communicator.getChannel(this.config.voicechannel);
            await Promise.all([
                this.communicator.subscribe('VOICE_STATE_CREATE', { channel_id: this.config.voicechannel }),
                this.communicator.subscribe('VOICE_STATE_UPDATE', { channel_id: this.config.voicechannel }),
                this.communicator.subscribe('VOICE_STATE_DELETE', { channel_id: this.config.voicechannel }),
                this.communicator.subscribe('SPEAKING_START', { channel_id: this.config.voicechannel }),
                this.communicator.subscribe('SPEAKING_STOP', { channel_id: this.config.voicechannel })
            ]);
        } catch (err) {

            this.users = null;
            this.channel = null;
            this.connected = false;
            this.communicator = null;

            // voice channel doesn't exist?
            if (err.message !== 'RPC:CLOSED') {
                console.log('[DISCORD] - Failed to get voice channel', error);
                throw err;
            }

            // RPC closed - re-spool in 60 seconds
            this.emit('disconnected');
            setTimeout(() => this.spool(), 60000);
        }

        this.users = this.channel.voice_states.reduce((result, entry) => {
            let state = entry.voice_state;
            let user = entry.user;
            if (user.bot) {
                return;
            }
            result[user.id] = {...user, ...state};
            return result;
        }, {});

        this.communicator.on('DISCORD:VOICE_STATE_CREATE', data => {
            if (!data.user.bot) {
                const user = this.users[data.user.id] = { ...(data.user), ...(data.voice_state)};
                this.emit('join', user);
            }
        });

        this.communicator.on('DISCORD:VOICE_STATE_UPDATE', data => {
            if (!data.user.bot) {
                let userData = this.users[data.user.id];

                if (!userData) {
                    this.emit('join', this.users[data.user.id] = { ...(data.user), ...(data.voice_state)});

                } else {
                    const user = { ...(userData), ...(data.user), ...(data.voice_state)};

                    let changed = Object.keys(user).some(key => user[key] !== userData[key]);
                    if (!changed) {
                        return;
                    }
                    this.users[user.id] = user;
                    this.emit('update', user);
                }
            }
        });

        this.communicator.on('DISCORD:VOICE_STATE_DELETE', data => {
            if (!this.users[data.user.id]) {
                return;
            }
            let user = this.users[data.user.id];
            delete this.users[data.user.id];
            this.emit('left', user);
        });

        this.communicator.on('DISCORD:SPEAKING_START', data => {
            let userId = data.user_id;
            if (
                data.channel_id === this.config.voicechannel &&
                this.users[userId] &&
                this.users[userId].speaking !== true
            ) {
                this.users[userId].speaking = true;
                this.emit('speaking', this.users[userId]);
            }
        });

        this.communicator.on('DISCORD:SPEAKING_STOP', data => {
            let userId = data.user_id;
            if (
                data.channel_id === this.config.voicechannel &&
                this.users[userId] &&
                this.users[userId].speaking === true
            ) {
                this.users[userId].speaking = false;
                this.emit('silent', this.users[userId]);
            }
        });

        this.communicator.on('RPC:CLOSED', () => {
            console.log('[DISCORD] - Disconnected');
            this.users = null;
            this.channel = null;
            this.connected = false;
            this.communicator = null;
            setTimeout(() => this.spool(), 60000)
            this.emit('disconnected');
        })

        this.connected = true;
        this.emit('connected');
    }
};