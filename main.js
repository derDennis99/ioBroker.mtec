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
        if (!config) {
            // js-controller restarts the instance with the stored settings.
            return;
        }
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
     * instance. js-controller then restarts the instance, so this start does nothing more: work begun now
     * would run into the shutdown.
     *
     * @returns {Promise<Record<string, any> | null>} the configuration to work with, null if the instance restarts
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
        if (!obj) {
            return config;
        }
        // Only these keys change, the stored (encrypted) password stays as it is.
        delete obj.native.profile;
        Object.assign(obj.native, update);
        this.log.info(
            `Settings taken over: Energy Butler via ${update.butlerSource}, heat pump via ${update.heatpumpSource}. The instance restarts.`,
        );
        await this.setForeignObjectAsync(id, obj);
        return null;
    }

    async onUnload(callback) {
        try {
            if (this.bridge) {
                await this.bridge.stop();
            }
            await this.setStateAsync('info.connection', false, true);
        } catch {
            // The database may already be closed when the instance is shut down.
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
