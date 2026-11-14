'use strict';

const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');
const { Bridge } = require('./lib/bridge');
const { checkConfig, migrateConfig } = require('./lib/profiles');

class Mtec extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mtec' });
        this.bridge = null;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const config = await this.migrateSettings();
        const errors = checkConfig(config);
        if (errors.length) {
            errors.forEach(e => this.log.error(e));
            return;
        }
        // Texts such as the battery forecast follow the system language.
        const system = await this.getForeignObjectAsync('system.config').catch(() => null);
        const language = system?.common?.language || 'en';
        this.bridge = new Bridge(this, { ...config, language }, mqtt.connect);
        await this.bridge.start();
    }

    /**
     * Takes over the settings of version 0.4 and older (one input profile) once and stores them in the
     * instance. js-controller then restarts the instance; until then the adapter works with the new keys.
     *
     * @returns {Promise<Record<string, any>>} the configuration to work with
     */
    async migrateSettings() {
        /** @type {Record<string, any>} */
        const config = { ...this.config };
        const update = migrateConfig(config);
        if (!update) {
            return config;
        }
        delete config.profile;
        Object.assign(config, update);
        const id = `system.adapter.${this.namespace}`;
        const obj = await this.getForeignObjectAsync(id);
        if (obj) {
            // Only these keys change, the stored (encrypted) password stays as it is.
            delete obj.native.profile;
            Object.assign(obj.native, update);
            await this.setForeignObjectAsync(id, obj);
        }
        this.log.info(
            `Settings taken over: Energy Butler via ${update.butlerSource}, heat pump via ${update.heatpumpSource}`,
        );
        return config;
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
