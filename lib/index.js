const EventEmitter = require('events');
const {exec} = require('child_process');

const WebSocket = require('ws');
const request = require('request');
const wol = require('wol');

const PING_TIMEOUT = 250;
const WS_PORT = 8002;
const COMMAND_DELAY = 400;
const WS_CHECK_INTERVAL = 1000 * 5;
const WS_CHECK_TIMEOUT = 1000;

module.exports = class TizenRemote extends EventEmitter {
    constructor() {
        super();
        this.config = {
            ip: '',
            pairingName: 'SmartTvService'
        };
        this.resetState();

        this._pingTimeout = () => {
            if (!this._ws) return;

            if (this.config.logger) {
                this.config.logger.warn('Socket ping timeout. Closing socket...');
            }

            this._ws.close();
            this._ws = null;
            clearTimeout(this._pingTimer);
        };
    }

    onTokenUpdate(callback) {
        this.on('tokenUpdate', callback);
    }

    init(config) {
        this.config = Object.assign(this.config, config);
        this.resetState();
    }

    resetState() {
        if (this._ws) {
            this._ws.close();
            clearTimeout(this._pingTimer);
            clearTimeout(this._connectionTimer);
        }
        this._ws = null;
        this._apps = null;
        this._info = null;
    }

    async getAppList() {
        if (!this._apps) {
            await this._requestApps();
        }

        return Object.keys(this._apps).reduce((apps, appId) => {
            apps[this._apps[appId].name.toLocaleLowerCase()] = this._apps[appId];
            return apps;
        }, {});
    }

    getAppInfo(appId) {
        return this.isOn()
            .then(status => {
                if (!status) {
                    throw new Error('Tv is off');
                }
            })
            .then(() => this._request(`http://${this.ip}:8001/api/v2/applications/${appId}`));
    }

    getInfo() {
        if (this._info) {
            return Promise.resolve(this._info);
        }

        return this._request(`http://${this.config.ip}:8001/api/v2/`)
            .then(response => {
                this._info = response;
                return response;
            });
    }

    async openApp(appId, args = null) {
        if (!this._apps) {
            await this._requestApps();
        }

        if (!this._apps[appId]) {
            throw new Error('App is not installed');
        }

        const request = {
            method: 'ms.channel.emit',
            params: {
                to: 'host',
                event: 'ed.apps.launch',
                data: {
                    action_type: this._apps[appId].appType === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH',
                    appId: appId
                }
            }
        };

        if (args) {
            request.params.data.metaTag = args;
        }

        await this._sendWS(request);
    }

    turnOn() {
        return this
            .isOn()
            .then(status => {
                // Is alive TV is OFF but still takes commands?
                if (status) {
                    return this.sendCmd('KEY_POWER');
                }

                if (!this.config.mac) {
                    throw new Error('Can not turn on TV without mac address');
                }

                return new Promise((resolve, reject) => {
                    // TV is OFF and we need to use WOL
                    wol.wake(this.config.mac, (error) => {
                        if (error) {
                            return reject('Failed to power on TV');
                        } else {
                            return resolve();
                        }
                    });
                });
            });
    }

    turnOff() {
        return this.isOn()
            .then(status => {
                if (status) {
                    return this.sendCmd('KEY_POWER');
                }
            });
    }

    setChannel(channel) {
        if (isNaN(parseInt(channel))) {
            return Promise.reject('Invalid channel number');
        }

        const commands = channel.toString().split('').map(num => `KEY_${num}`);
        commands.push('KEY_ENTER');

        return this.sendCmd(commands);
    }

    sendCmd(commands) {
        if (!Array.isArray(commands)) { commands = [commands]; }

        if (!this.commandPromise) {
            this.commandPromise = Promise.resolve();
        }

        commands.forEach(command => {
            this.commandPromise = this.commandPromise
                .then(() => this._sendOneKey(command))
                .then(() => this._delay());
        });

        return this.commandPromise;
    }

    openUrl(url) {
        return this._sendWS({
            method : 'ms.channel.emit',
            params : {
                event: 'ed.apps.launch',
                to: 'host',
                data: {
                    appId: 'org.tizen.browser',
                    action_type:'NATIVE_LAUNCH',
                    metaTag: url
                }
            }
        });
    }

    isOn() {
        return new Promise(resolve => {
            // Check if host is online
            exec(`ping -t 1 -c 1 ${this.config.ip}`, (error) => {
                // Resolve or show error
                resolve(!error);
            });

            // Close fast if no answer
            setTimeout(resolve.bind(null, false), PING_TIMEOUT);
        });
    }

    _ensureConnection() {
        if (this._ws) {
            return Promise.resolve();
        }

        return new Promise(async (resolve, reject) => {
            // Start connection
            const name = Buffer.from(this.config.pairingName).toString('base64');
            let wsEndpoint = `wss://${this.config.ip}:${WS_PORT}/api/v2/channels/samsung.remote.control?name=${name}`;

            if (this.config.authToken) {
                wsEndpoint += `&token=${this.config.authToken}`;
            }

            this._ws = new WebSocket(wsEndpoint, {
                rejectUnauthorized: false
            });

            // When the socket has an error
            this._ws.on('error', (error) => {
                reject(error);
            });

            // When the socket is closed
            this._ws.on('close', () => {
                if (this._ws) {
                    this._ws = null;
                    clearTimeout(this._pingTimer);
                }
            });

            // When the socket is open
            this._ws.on('message', data => {
                // Parse response
                const response = JSON.parse(data);

                // We are connected
                if (response.event === 'ms.channel.connect') {
                    this._clientId = response.data.id;

                    // Save token if updated
                    if (response.data.token) {
                        this.config.authToken = response.data.token;
                        this.emit('tokenUpdate', this.config.authToken);
                    }

                    this._ping();
                    resolve();
                } else if (response.event === 'ed.installedApp.get') {
                    this._apps = response.data.data.reduce((apps, app, num) => {
                        apps[app.appId] = {
                            name: app.name,
                            id: app.appId,
                            appType: app.app_type,
                            isLocked: app.is_lock,
                            orderId: num
                        };

                        return apps;
                    }, {});

                    this.emit('appsUpdate');
                } else if (response.event === '_ping') {
                    if (response.from === this._clientId) {
                        this.emit('pong', response.data);
                    }
                } else {
                    // Other response
                    if (this.config.logger) {
                        this.config.logger.info('Unhandled ws response:\n'+data);
                    }

                    reject();
                }
            });
        });
    }

    _sendWS(data) {
        return this._ensureConnection()
            .then(() => new Promise((resolve, reject) => {
                this._ws.send(JSON.stringify(data), error => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                })
            }));
    }

    _ping() {
        if (!this._ws) return;

        this._sendWS({
            method:'ms.channel.emit',
            params: {
                event: '_ping',
                data: new Date().toISOString(),
                to: this._clientId
            }
        });
        this._connectionTimer = setTimeout(this._pingTimeout, WS_CHECK_TIMEOUT);

        this.once('pong', () => {
            clearTimeout(this._connectionTimer);
            this._pingTimer = setTimeout(() => this._ping(), WS_CHECK_INTERVAL);
        });
    }

    _requestApps() {
        return new Promise((resolve, reject) => {
            this.once('appsUpdate', resolve);

            this._sendWS({
                method: 'ms.channel.emit',
                params: {
                    data: '',
                    to: 'host',
                    event: 'ed.installedApp.get'
                }
            }).catch(reject);
        });
    }

    _request(url) {
        return new Promise((resolve, reject) => {
            request(url, (error, data, body) => {
                if (error) {
                    reject(error);
                    return;
                }

                if (!data) {
                    reject('wrong response from TV');
                    return;
                }

                if (data.statusCode !== 200) {
                    reject('wrong response code from TV: ' + data.statusCode);
                    return;
                }

                try {
                    const response = JSON.parse(body);
                    this._processResponse(response);
                    resolve(response);
                } catch (err) {
                    reject('error while parse response from tv: ' + error);
                }
            });
        });
    }

    _processResponse(response) {
        Object.keys(response).forEach(key => {
            if (typeof response[key] === 'string') {
                try {
                    response[key] = JSON.parse(response[key]);
                } catch (ex) {}
            }

            if (typeof response[key] === 'object') {
                this._processResponse(response[key]);
            }
        });
    }

    _sendOneKey(key) {
        return this._sendWS({
            method : 'ms.remote.control',
            params : {
                Cmd: 'Click',
                DataOfCmd: key,
                Option: false,
                TypeOfRemote: 'SendRemoteKey'
            }
        });
    }

    _delay() {
        return new Promise(resolve => {
            setTimeout(resolve, COMMAND_DELAY);
        })
    }
};