const fetch = require('node-fetch');
const DiscordRpc = require('./rpc.js');

module.exports = class DiscordClient extends DiscordRpc {
    constructor({client_id, client_secret, redirect_uri} = '') {
        super();
        this.appinfo = {
            client_id,
            client_secret,
            redirect_uri
        }
    }
    async connect() {

        let { user } = await super.connect();
        this.user = user;

        let access_token = this.access_token;
        if (!this.access_token) {
            const { code } = await this.invoke('AUTHORIZE', {
                client_id: this.appinfo.client_id,
                scopes: ['rpc'],
                prompt: 'none'
            });

            const exchange = await this.apifetch('POST', '/oauth2/token', {
                data: new URLSearchParams({
                    client_id: this.appinfo.client_id,
                    client_secret: this.appinfo.client_secret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: this.appinfo.redirect_uri
                }).toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            access_token = exchange.access_token;
        }

        try {
            let auth = await this.invoke('AUTHENTICATE', { access_token });
            this.application = auth.application;
            this.user = auth.user;
            this.access_token = access_token;

        } catch (err) {
            this.access_token = null;
            throw error;
        }
    }

    async apifetch(method, path, { query, headers, data }) {

        let options = {
            method,
            headers: headers || {},
            body: data
        };

        if (this.appinfo.access_token) {
            options.headers = {'Authorization': `Bearer ${this.appinfo.access_token}`};
        }

        path = `https://discord.com/api${path}${query ? new URLSearchParams(query) : ''}`;

        const request = await fetch(path, options);
        const body = await request.json();

        if (!request.ok) {
            const err = new Error(request.status);
            err.body = body;
            throw err;
        }

        return body;
    }

    async close() {
        await super.close();
        this.user = null;
    }

    terminate() {
        super.terminate();
        this.user = null;
    }
}