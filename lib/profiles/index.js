'use strict';

/**
 * Input profiles: each one turns the data of a source into records with our field names. Telemetry
 * rules, data points and analysis are the same for all of them.
 *
 * Every device has its own data source (`butlerSource`, `heatpumpSource`), `none` = device not present.
 *
 * A source has:
 * - `profile`, `device` ('heatpump' | 'butler')
 * - MQTT sources: `subscriptions` ([{topic, qos}]), `matches(topic)`, `handle(topic, payload, now)` → results
 * - `pending`, `quietMs`, `flush(now)` → results: for sources that collect several messages into
 *   one record; the bridge calls `flush` once the topics have been quiet for `quietMs`
 * - Polled sources: `intervalMs`, `poll(now)` → Promise of results (rejects if the device cannot be
 *   reached), optional `close()`. The next poll starts only after the previous one has finished.
 * - `expire(now)` → results, `isStale(now)`, `lastTs` (time of the last main record)
 *
 * Results:
 * - `{type: 'record', device, ts, main, updates: [{field, val, q}], unknown, rejected, ignored?, extras?, counters?,
 *   restored?}`
 *   `main`: contains the device's main values (sets lastMeasurement and stale, feeds the analysis),
 *   `ignored`: fields whose name cannot become a data point
 * - `{type: 'expired', device, ts, groups, updates}`: values of a slow group are outdated
 * - `{type: 'invalid', reason}`, `{type: 'skipped', reason}`, `{type: 'foreign', reason}`, `{type: 'serial', serial}`
 */

const { DEVICES } = require('../fields');
const { JsonSource } = require('./json');
const { MtecmqttSource } = require('./mtecmqtt');

/** Possible data sources per device. */
const SOURCES = {
    butler: ['json', 'mtecmqtt', 'none'],
    heatpump: ['json', 'none'],
};

/** Data sources that read from the MQTT broker. */
const MQTT_SOURCES = ['json', 'mtecmqtt'];

/**
 * @param {Record<string, any>} config adapter configuration (native)
 * @param {'butler' | 'heatpump'} device
 */
function sourceOf(config, device) {
    return String(config[`${device}Source`] ?? '');
}

/** @param {Record<string, any>} config */
function usesMqtt(config) {
    return /** @type {const} */ (['butler', 'heatpump']).some(device =>
        MQTT_SOURCES.includes(sourceOf(config, device)),
    );
}

/**
 * Settings up to 0.4.x: `profile` (json | mtecmqtt) only concerned the Energy Butler, the heat pump
 * was always read via json, and an empty topic meant "device not present". As long as `profile` is
 * there, it counts, even if an update has already added the new keys with their defaults.
 *
 * @param {Record<string, any>} config adapter configuration (native)
 * @returns {{butlerSource: string, heatpumpSource: string} | null} the new keys, null if nothing is to migrate
 */
function migrateConfig(config) {
    if (config.profile === undefined && config.butlerSource !== undefined && config.heatpumpSource !== undefined) {
        return null;
    }
    const hasTopic = key => String(config[key] || '').trim() !== '';
    return {
        butlerSource: config.profile === 'mtecmqtt' ? 'mtecmqtt' : hasTopic('topicButler') ? 'json' : 'none',
        heatpumpSource: hasTopic('topicHeatpump') ? 'json' : 'none',
    };
}

/**
 * Checks the configuration before the start.
 *
 * @param {Record<string, any>} config adapter configuration (native)
 * @returns {string[]} error messages, empty if everything is fine
 */
function checkConfig(config) {
    const errors = [];
    for (const device of /** @type {const} */ (['butler', 'heatpump'])) {
        const source = sourceOf(config, device);
        const name = DEVICES[device].name.en;
        if (!SOURCES[device].includes(source)) {
            errors.push(`Unknown data source "${source}" for the ${name}, please choose one in the instance settings.`);
        } else if (source === 'json' && !String(config[topicKey(device)] || '').trim()) {
            errors.push(`No topic configured for the ${name}, please add it in the instance settings.`);
        }
    }
    if (!errors.length && sourceOf(config, 'butler') === 'none' && sourceOf(config, 'heatpump') === 'none') {
        errors.push('No device configured, please choose a data source in the instance settings.');
    }
    if (usesMqtt(config) && !String(config.host || '').trim()) {
        errors.push('No MQTT broker configured, please add it in the instance settings.');
    }
    return errors;
}

/** @param {'butler' | 'heatpump'} device */
function topicKey(device) {
    return device === 'butler' ? 'topicButler' : 'topicHeatpump';
}

/**
 * Creates the sources for the adapter configuration.
 *
 * @param {Record<string, any>} config adapter configuration (native)
 * @param {object} [options]
 * @param {number} [options.mtecQuietMs] quiet period for MTECmqtt (tests)
 * @param {number} [options.now] start time (tests)
 */
function createSources(config, options = {}) {
    const staleMs = Math.max(1, Number(config.staleSeconds) || 20) * 1000;
    const sources = [];
    for (const device of /** @type {const} */ (['heatpump', 'butler'])) {
        switch (sourceOf(config, device)) {
            case 'json': {
                const topic = String(config[topicKey(device)] || '').trim();
                if (topic) {
                    sources.push(new JsonSource(device, topic, DEVICES[device].fields, staleMs));
                }
                break;
            }
            case 'mtecmqtt':
                sources.push(
                    new MtecmqttSource({
                        prefix: config.mtecTopicPrefix,
                        serial: config.mtecSerial,
                        staleMs,
                        slowStaleMs: Math.max(1, Number(config.staleSecondsSlow) || 180) * 1000,
                        quietMs: options.mtecQuietMs,
                        now: options.now,
                    }),
                );
                break;
        }
    }
    return sources;
}

module.exports = { SOURCES, MQTT_SOURCES, checkConfig, createSources, migrateConfig, sourceOf, usesMqtt };
