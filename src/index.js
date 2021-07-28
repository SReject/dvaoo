const path = require('path');
const EventEmitter = require('events');
const express = require('express');
const expressws = require('express-ws');
const DiscordMonitor = require('./discord/monitor');
const yargs = require('yargs');

// process args
const argv = yargs(process.argv.slice(2)).argv;

// get config path
let configPath = '../config.json';
if (argv.config) {
    configPath = path.resolve(argv.config);
}

// get overlay path
let overlayPath = '../overlay/';
if (argv.overlay === true) {
    overlayPath = process.cwd();
} else if (argv.overlay) {
    overlayPath = path.resolve(argv.overlay);
}

// read config
const config = require(configPath);
const port = argv.port || config.port || 54625;

// boot up discord voice monitor
const monitor = new DiscordMonitor(config);
monitor.on('connected', () => console.log('[VoiceMonitor] connected'));
monitor.on('disconnected', () => console.log('[VoiceMonitor] disconnected'));

monitor.on('join', user => console.log(`[VoiceMonitor] User Join: ${user.username}(${user.id})`));
monitor.on('update', user => console.log(`[VoiceMonitor] User Updated: ${user.username}(${user.id})`));
monitor.on('left', user => console.log(`[VoiceMonitor] User Left: ${user.username}(${user.id})`));

monitor.on('speaking', user => console.log(`[VoiceMonitor] User Speaking: ${user.username}(${user.id})`));
monitor.on('silent', user => console.log(`[VoiceMonitor] User Stopped Speaking: ${user.username}(${user.id})`));


// boot up webserver
const broadcast = new EventEmitter();

const webhost = express();
expressws(webhost);

webhost.ws('/overlay', function (ws) {
    const handleBroadcast = msg => ws.send(msg);
    broadcast.on('message', handleBroadcast);
    ws.on('close', () => broadcast.off('message', handleBroadcast));
    if (monitor.connected) {
        ws.send(JSON.stringify({
            evt: 'init',
            connected: true,
            channel: monitor.channel,
            users: monitor.users
        }));
    } else {
        ws.send(JSON.stringify({
            evt: 'init',
            connected: false,
            channel: {},
            users: []
        }))
    }
});

webhost.use('/', express.static(path.join(__dirname, '../overlay/')));

webhost.listen(port);
console.log(`Listening for connections on https://localhost:${port}`);