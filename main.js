'use strict';

const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');
const { Bridge } = require('./lib/bridge');
const { PROFILES, profileOf } = require('./lib/profiles');

class Mtec extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mtec' });
        this.bridge = null;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        if (!this.config.host) {
            this.log.error('No MQTT broker configured, please add it in the instance settings.');
            return;
        }
        const profile = profileOf(this.config);
        if (!PROFILES.includes(profile)) {
            this.log.error(`Unknown input profile "${profile}", please choose one in the instance settings.`);
            return;
        }
        if (profile === 'json' && !this.config.topicHeatpump && !this.config.topicButler) {
            this.log.error('No topic configured, please add it in the instance settings.');
            return;
        }
        // Texts such as the battery forecast follow the system language.
        const system = await this.getForeignObjectAsync('system.config').catch(() => null);
        const language = system?.common?.language || 'en';
        this.bridge = new Bridge(this, { ...this.config, language }, mqtt.connect);
        await this.bridge.start();
    }

    async onUnload(callback) {
        try {
            if (this.bridge) {
                await this.bridge.stop();
            }
            await this.setStateAsync('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Mtec(options);
} else {
    new Mtec();
}
